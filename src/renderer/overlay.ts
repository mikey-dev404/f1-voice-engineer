import type { EngineerApi } from '../preload/index';
import type { AppSettings, EngineerState, PttStatus, TelemetrySnapshot, TelemetryStatus } from '../shared/types';
import { VISUAL_COMPOUND } from '../telemetry/constants';
import { AudioPlayer, MicCapture } from './audio';
import { GeminiLiveClient } from './gemini-live';

declare global {
  interface Window {
    engineer: EngineerApi;
  }
}

const api = window.engineer;

const el = {
  panel: document.getElementById('panel') as HTMLElement,
  udpPill: document.getElementById('pill-udp') as HTMLElement,
  udpDetail: document.getElementById('udp-detail') as HTMLElement,
  aiPill: document.getElementById('pill-ai') as HTMLElement,
  aiDetail: document.getElementById('ai-detail') as HTMLElement,
  pttPill: document.getElementById('pill-ptt') as HTMLElement,
  pttDetail: document.getElementById('ptt-detail') as HTMLElement,
  micLevel: document.getElementById('mic-level') as HTMLElement,
  stateLabel: document.getElementById('state-label') as HTMLElement,
  caption: document.getElementById('caption') as HTMLElement,
  pos: document.getElementById('s-pos') as HTMLElement,
  lap: document.getElementById('s-lap') as HTMLElement,
  tyre: document.getElementById('s-tyre') as HTMLElement,
  wear: document.getElementById('s-wear') as HTMLElement,
  fuel: document.getElementById('s-fuel') as HTMLElement,
  ers: document.getElementById('s-ers') as HTMLElement,
  gap: document.getElementById('s-gap') as HTMLElement,
};

const mic = new MicCapture();
const player = new AudioPlayer();

let settings: AppSettings | null = null;
let systemPrompt = '';
let state: EngineerState = 'idle';
let turnActive = false;
let engineerLine = '';
let awaitingReply = false;
let levelRaf = 0;
/** Set when a turn was abandoned, so the reply still on its way is dropped. */
let discardReply = false;

function setState(next: EngineerState): void {
  if (state === next) return;
  state = next;
  el.panel.dataset.state = next;
  void api.reportState(next);

  const labels: Record<EngineerState, string> = {
    idle: 'Hold your radio button to talk',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Engineer',
    error: 'Problem',
  };
  el.stateLabel.textContent = labels[next];

  if (next === 'listening') startLevelMeter();
  else stopLevelMeter();
}

function startLevelMeter(): void {
  const tick = () => {
    const level = Math.min(1, mic.readLevel() * 2.5);
    el.micLevel.style.transform = `scale(${0.5 + level * 0.5})`;
    levelRaf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(levelRaf);
  levelRaf = requestAnimationFrame(tick);
}

function stopLevelMeter(): void {
  cancelAnimationFrame(levelRaf);
  levelRaf = 0;
  el.micLevel.style.transform = 'scale(0.45)';
}

function setCaption(text: string, kind: 'engineer' | 'driver'): void {
  el.caption.textContent = text;
  el.caption.classList.toggle('driver', kind === 'driver');
}

function setPill(pill: HTMLElement, detail: HTMLElement, cls: 'ok' | 'warn' | 'bad' | '', text: string): void {
  pill.classList.remove('ok', 'warn', 'bad');
  if (cls) pill.classList.add(cls);
  detail.textContent = text;
}

const live = new GeminiLiveClient({
  onOpen: () => {
    setPill(el.aiPill, el.aiDetail, 'ok', settings?.engineerName?.toLowerCase() || 'ready');
    if (state === 'error') setState('idle');
  },
  onClose: () => {
    setPill(el.aiPill, el.aiDetail, 'warn', 'reconnecting');
  },
  onError: (message) => {
    setPill(el.aiPill, el.aiDetail, 'bad', 'error');
    setCaption(message, 'engineer');
    setState('error');
  },
  onAudio: (pcm) => {
    if (discardReply) return;
    if (state !== 'speaking') setState('speaking');
    awaitingReply = false;
    player.enqueue(pcm);
  },
  onDriverTranscript: (text) => {
    if (state === 'listening') setCaption(text, 'driver');
  },
  onEngineerTranscript: (text) => {
    if (discardReply) return;
    engineerLine += text;
    setCaption(engineerLine, 'engineer');
  },
  onTurnComplete: () => {
    awaitingReply = false;
    discardReply = false;
    // Playback usually lags the final packet, so idle is set once it drains.
    if (!player.isPlaying) setState('idle');
  },
  onInterrupted: () => {
    player.stop();
    setState('idle');
  },
});

player.onDrained(() => {
  if (!awaitingReply && state === 'speaking') setState('idle');
});

async function beginTalking(brief: string): Promise<void> {
  if (turnActive) return;

  if (!settings?.geminiApiKey) {
    setCaption('No Gemini API key yet. Hold the radio button for 1.5s to open settings.', 'engineer');
    setState('error');
    return;
  }

  try {
    await mic.init();
    await mic.resume();
    await player.resume();
  } catch (err) {
    setCaption(`No microphone access: ${(err as Error).message}`, 'engineer');
    setState('error');
    return;
  }

  // Cut off any reply still playing so the driver can talk over the engineer.
  player.stop();

  if (!live.beginTurn(brief)) {
    setCaption('Engineer is not connected yet. Reconnecting.', 'engineer');
    setState('error');
    return;
  }

  turnActive = true;
  discardReply = false;
  engineerLine = '';
  setCaption('', 'driver');
  setState('listening');
  mic.startStreaming((pcm) => live.sendAudio(pcm));
}

function endTalking(): void {
  if (!turnActive) return;
  turnActive = false;
  mic.stopStreaming();
  live.endTurn();
  awaitingReply = true;
  setState('thinking');
}

function cancelTalking(): void {
  if (!turnActive) return;
  turnActive = false;
  mic.stopStreaming();
  // The activity still has to be closed, but the driver did not ask for an
  // answer, so whatever comes back is thrown away.
  live.endTurn();
  discardReply = true;
  awaitingReply = false;
  player.stop();
  setCaption('', 'engineer');
  setState('idle');
}

function renderTelemetryStatus(status: TelemetryStatus): void {
  if (status.error) {
    setPill(el.udpPill, el.udpDetail, 'bad', status.portInUse ? 'port busy' : 'error');
    setCaption(status.error, 'engineer');
    return;
  }
  setPill(
    el.udpPill,
    el.udpDetail,
    status.listening ? 'warn' : '',
    status.listening ? `${status.port} waiting` : 'off',
  );
}

function renderPttStatus(status: PttStatus): void {
  if (!status.available) {
    setPill(el.pttPill, el.pttDetail, 'bad', 'unavailable');
    return;
  }
  if (!status.bound) {
    setPill(el.pttPill, el.pttDetail, 'warn', 'not bound');
    return;
  }
  setPill(
    el.pttPill,
    el.pttDetail,
    status.deviceConnected ? 'ok' : 'warn',
    status.deviceConnected ? (status.deviceName ?? 'wheel') : 'wheel offline',
  );
}

function setStat(node: HTMLElement, text: string, level: '' | 'alert' | 'critical' = ''): void {
  node.textContent = text;
  node.classList.remove('alert', 'critical');
  if (level) node.classList.add(level);
}

function renderSnapshot(snap: TelemetrySnapshot): void {
  if (snap.wrongFormat) {
    setPill(el.udpPill, el.udpDetail, 'bad', 'wrong format');
  } else if (snap.connected) {
    setPill(el.udpPill, el.udpDetail, 'ok', `${snap.packetsPerSecond}/s`);
  }

  const { lap, status, damage } = snap.player;

  setStat(el.pos, lap?.carPosition ? `P${lap.carPosition}` : '--');

  const total = snap.session?.totalLaps ?? 0;
  setStat(el.lap, lap ? (total > 0 ? `${lap.currentLapNum}/${total}` : `${lap.currentLapNum}`) : '--');

  if (status) {
    const compound = VISUAL_COMPOUND[status.visualTyreCompound] ?? '?';
    setStat(el.tyre, `${compound.slice(0, 4).toUpperCase()} ${status.tyreAgeLaps}L`);
  } else {
    setStat(el.tyre, '--');
  }

  if (damage) {
    const worst = Math.max(...damage.tyreWearPct);
    setStat(el.wear, `${worst.toFixed(0)}%`, worst > 70 ? 'critical' : worst > 45 ? 'alert' : '');
  } else {
    setStat(el.wear, '--');
  }

  if (status) {
    const laps = status.fuelRemainingLaps;
    setStat(
      el.fuel,
      `${laps >= 0 ? '+' : ''}${laps.toFixed(1)}`,
      laps < -0.5 ? 'critical' : laps < 0 ? 'alert' : '',
    );
    const ers = Math.round((status.ersStoreEnergy / 4_000_000) * 100);
    setStat(el.ers, `${ers}%`, ers < 15 ? 'alert' : '');
  } else {
    setStat(el.fuel, '--');
    setStat(el.ers, '--');
  }

  const gapAhead = snap.ahead?.gapSec;
  setStat(el.gap, gapAhead !== null && gapAhead !== undefined ? `${gapAhead.toFixed(1)}s` : '--');
}

function applyAppearance(next: AppSettings): void {
  el.panel.style.setProperty('--active-opacity', String(next.overlayOpacity));
  el.caption.style.display = next.showCaptions ? '' : 'none';
}

async function connectEngineer(): Promise<void> {
  if (!settings?.geminiApiKey) {
    setPill(el.aiPill, el.aiDetail, 'warn', 'no api key');
    return;
  }
  setPill(el.aiPill, el.aiDetail, 'warn', 'connecting');
  await live.connect({
    apiKey: settings.geminiApiKey,
    model: settings.geminiModel,
    voiceName: settings.voiceName,
    systemInstruction: `${systemPrompt}\n\nThe driver calls you ${settings.engineerName}.`,
  });
}

async function init(): Promise<void> {
  const bundle = await api.getSettings();
  settings = bundle.settings;
  systemPrompt = bundle.systemPrompt;

  applyAppearance(settings);

  renderTelemetryStatus(await api.getTelemetryStatus());
  renderPttStatus(await api.getPttStatus());

  api.onTelemetryStatus(renderTelemetryStatus);
  api.onPttStatus(renderPttStatus);
  api.onSnapshot(renderSnapshot);

  api.onPttDown(({ brief }) => void beginTalking(brief));
  api.onPttUp(() => endTalking());
  api.onPttCancel(() => cancelTalking());

  api.onSettingsChanged(async (next) => {
    const needsReconnect =
      next.geminiApiKey !== settings?.geminiApiKey ||
      next.geminiModel !== settings?.geminiModel ||
      next.voiceName !== settings?.voiceName ||
      next.engineerName !== settings?.engineerName;

    settings = next;
    applyAppearance(next);
    if (needsReconnect) {
      live.reset();
      await connectEngineer();
    }
  });

  await connectEngineer();

  // Warm the mic up front so the first radio call is not delayed by setup.
  try {
    await mic.init();
  } catch {
    setPill(el.aiPill, el.aiDetail, 'warn', 'no mic yet');
  }
}

void init();
