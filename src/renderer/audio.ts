// Microphone capture and reply playback.
//
// Gemini Live wants 16 kHz signed 16-bit mono in, and streams 24 kHz signed
// 16-bit mono back.

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

/**
 * With manual push-to-talk there is no server-side look-back buffer, so the
 * syllable you start before the button fully registers would be lost. We keep
 * a short rolling window of mic audio and flush it when the button goes down.
 */
const PRE_BUFFER_MS = 300;
const CAPTURE_CHUNK_SAMPLES = 1024;

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${CAPTURE_CHUNK_SAMPLES});
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.buffer.length) {
        const pcm = new Int16Array(this.buffer.length);
        for (let j = 0; j < this.buffer.length; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm, [pcm.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  private preBuffer: Int16Array[] = [];
  private preBufferChunks = Math.ceil(
    (PRE_BUFFER_MS / 1000) * (INPUT_SAMPLE_RATE / CAPTURE_CHUNK_SAMPLES),
  );

  private streaming = false;
  private onChunk: ((pcm: Int16Array) => void) | null = null;
  /** Peak amplitude since the last read, used to drive the level meter. */
  private peak = 0;

  async init(deviceId?: string): Promise<void> {
    if (this.context) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    });

    this.context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });

    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'capture-processor');
    this.node.port.onmessage = (event) => this.handleChunk(event.data as Int16Array);
    source.connect(this.node);

    // The worklet produces no output, but Chromium only pulls from a graph that
    // reaches the destination, so route it through a silent gain node.
    const silence = this.context.createGain();
    silence.gain.value = 0;
    this.node.connect(silence);
    silence.connect(this.context.destination);
  }

  private handleChunk(pcm: Int16Array): void {
    let localPeak = 0;
    for (let i = 0; i < pcm.length; i += 8) {
      const v = Math.abs(pcm[i]);
      if (v > localPeak) localPeak = v;
    }
    this.peak = Math.max(this.peak, localPeak / 32768);

    if (this.streaming) {
      this.onChunk?.(pcm);
      return;
    }

    this.preBuffer.push(pcm);
    if (this.preBuffer.length > this.preBufferChunks) this.preBuffer.shift();
  }

  /** Returns peak level in 0..1 and resets the running peak. */
  readLevel(): number {
    const value = this.peak;
    this.peak = 0;
    return value;
  }

  async resume(): Promise<void> {
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  /** Starts streaming, replaying the pre-buffer first. */
  startStreaming(onChunk: (pcm: Int16Array) => void): void {
    this.onChunk = onChunk;
    for (const chunk of this.preBuffer) onChunk(chunk);
    this.preBuffer = [];
    this.streaming = true;
  }

  stopStreaming(): void {
    this.streaming = false;
    this.onChunk = null;
  }

  get ready(): boolean {
    return this.context !== null;
  }
}

export class AudioPlayer {
  private context: AudioContext | null = null;
  private playHead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private onEndedCb: (() => void) | null = null;

  private ensure(): AudioContext {
    if (!this.context) this.context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    return this.context;
  }

  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  onDrained(cb: () => void): void {
    this.onEndedCb = cb;
  }

  enqueue(pcm: Int16Array): void {
    const ctx = this.ensure();

    const buffer = ctx.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Never schedule in the past, or chunks overlap and the voice doubles up.
    const startAt = Math.max(ctx.currentTime, this.playHead);
    source.start(startAt);
    this.playHead = startAt + buffer.duration;

    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onEndedCb?.();
    };
  }

  /** Cuts playback immediately, for barge-in or a cancelled call. */
  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    this.sources.clear();
    this.playHead = 0;
  }

  get isPlaying(): boolean {
    return this.sources.size > 0;
  }
}

export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
