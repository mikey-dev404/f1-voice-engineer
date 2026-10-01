// Gemini Live session wrapper.
//
// Automatic voice activity detection is switched off: the wheel button decides
// when a turn starts and ends, so we send activityStart/activityEnd ourselves.

import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import { base64ToInt16, int16ToBase64, INPUT_SAMPLE_RATE } from './audio';

export interface LiveHandlers {
  onOpen: () => void;
  onClose: (reason: string) => void;
  onError: (message: string) => void;
  onAudio: (pcm: Int16Array) => void;
  onDriverTranscript: (text: string) => void;
  onEngineerTranscript: (text: string) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
}

export interface LiveOptions {
  apiKey: string;
  model: string;
  voiceName: string;
  systemInstruction: string;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export class GeminiLiveClient {
  private ai: GoogleGenAI | null = null;
  private session: Session | null = null;
  private options: LiveOptions | null = null;
  private handlers: LiveHandlers;

  private connecting = false;
  private closedByUs = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  /** Lets a dropped session pick the conversation back up mid-race. */
  private resumptionHandle: string | null = null;

  constructor(handlers: LiveHandlers) {
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.session !== null;
  }

  async connect(options: LiveOptions): Promise<void> {
    this.options = options;
    this.closedByUs = false;
    await this.openSession();
  }

  private async openSession(): Promise<void> {
    const options = this.options;
    if (!options || this.connecting || this.session) return;

    if (!options.apiKey) {
      this.handlers.onError('No Gemini API key set. Open settings and paste your free key.');
      return;
    }

    this.connecting = true;
    try {
      this.ai = new GoogleGenAI({
        apiKey: options.apiKey,
        // Native-audio Live models live behind the beta surface.
        httpOptions: { apiVersion: 'v1beta' },
      });

      this.session = await this.ai.live.connect({
        model: options.model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: options.systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } },
          },
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: true },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // A race is far longer than the default session budget.
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
        },
        callbacks: {
          onopen: () => {
            this.reconnectAttempt = 0;
            this.handlers.onOpen();
          },
          onmessage: (message: LiveServerMessage) => this.handleMessage(message),
          onerror: (event: ErrorEvent) => {
            this.handlers.onError(event.message || 'Live session error');
          },
          onclose: (event: CloseEvent) => {
            this.session = null;
            this.handlers.onClose(event.reason || 'connection closed');
            if (!this.closedByUs) this.scheduleReconnect();
          },
        },
      });
    } catch (err) {
      this.session = null;
      this.handlers.onError(describeError(err, this.options?.model));
      if (!this.closedByUs) this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSession();
    }, delay);
  }

  private handleMessage(message: LiveServerMessage): void {
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
    }

    // The server warns before dropping a long session; get ahead of it.
    if (message.goAway) this.scheduleReconnect();

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) this.handlers.onInterrupted();

    if (content.inputTranscription?.text) {
      this.handlers.onDriverTranscript(content.inputTranscription.text);
    }
    if (content.outputTranscription?.text) {
      this.handlers.onEngineerTranscript(content.outputTranscription.text);
    }

    // Gemini 3.x can pack several parts into one event, so walk them all.
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.handlers.onAudio(base64ToInt16(part.inlineData.data));
      }
    }

    if (content.turnComplete) this.handlers.onTurnComplete();
  }

  beginTurn(telemetryBrief: string): boolean {
    if (!this.session) return false;

    this.session.sendRealtimeInput({ activityStart: {} });
    // The brief rides inside the same activity, so the model reads the current
    // car state as part of this question rather than as a separate turn.
    this.session.sendRealtimeInput({ text: telemetryBrief });
    return true;
  }

  sendAudio(pcm: Int16Array): void {
    if (!this.session) return;
    this.session.sendRealtimeInput({
      audio: {
        data: int16ToBase64(pcm),
        mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
      },
    });
  }

  endTurn(): void {
    if (!this.session) return;
    this.session.sendRealtimeInput({ activityEnd: {} });
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.session?.close();
    } catch {
      // Nothing to do.
    }
    this.session = null;
  }

  /** Drops the current session so the next connect picks up new settings. */
  reset(): void {
    this.close();
    this.resumptionHandle = null;
    this.reconnectAttempt = 0;
  }
}

function describeError(err: unknown, model?: string): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/API key|API_KEY|401|403|PERMISSION_DENIED|UNAUTHENTICATED/i.test(raw)) {
    return 'Gemini rejected the API key. Check it in settings.';
  }
  if (/not found|NOT_FOUND|404|is not supported/i.test(raw)) {
    return `Model "${model ?? 'unknown'}" is not available on your key. Pick another model in settings.`;
  }
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(raw)) {
    return 'Gemini free tier rate limit hit. Wait a moment and try again.';
  }
  if (/ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(raw)) {
    return 'No connection to Gemini. Check your internet.';
  }
  return raw;
}
