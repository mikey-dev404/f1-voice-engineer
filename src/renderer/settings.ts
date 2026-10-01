import type { EngineerApi } from '../preload/index';
import type { AppSettings, HidDeviceInfo, PttStatus, TelemetryStatus } from '../shared/types';

declare global {
  interface Window {
    engineer: EngineerApi;
  }
}

const api = window.engineer;

const el = {
  apiKey: document.getElementById('apiKey') as HTMLInputElement,
  studioLink: document.getElementById('studioLink') as HTMLAnchorElement,
  model: document.getElementById('model') as HTMLSelectElement,
  voice: document.getElementById('voice') as HTMLSelectElement,
  engineerName: document.getElementById('engineerName') as HTMLInputElement,
  device: document.getElementById('device') as HTMLSelectElement,
  refreshDevices: document.getElementById('refreshDevices') as HTMLButtonElement,
  showAllDevices: document.getElementById('showAllDevices') as HTMLInputElement,
  bindStatus: document.getElementById('bindStatus') as HTMLElement,
  learn: document.getElementById('learn') as HTMLButtonElement,
  clearBind: document.getElementById('clearBind') as HTMLButtonElement,
  keyboardFallback: document.getElementById('keyboardFallback') as HTMLInputElement,
  keyboardAccel: document.getElementById('keyboardAccel') as HTMLInputElement,
  udpPort: document.getElementById('udpPort') as HTMLInputElement,
  udpStatus: document.getElementById('udpStatus') as HTMLElement,
  saved: document.getElementById('saved') as HTMLElement,
  close: document.getElementById('close') as HTMLButtonElement,
};

let settings: AppSettings | null = null;
let learning = false;
let savedTimer = 0;

function fillSelect(select: HTMLSelectElement, values: string[], selected: string): void {
  select.innerHTML = '';
  const options = values.includes(selected) ? values : [selected, ...values];

  for (const value of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  select.value = selected;
}

function flashSaved(): void {
  el.saved.textContent = 'Saved';
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (el.saved.textContent = ''), 1400);
}

async function save(patch: Partial<AppSettings>): Promise<void> {
  settings = await api.setSettings(patch);
  flashSaved();
}

function setBindStatus(text: string, cls: 'ok' | 'bad' | 'active' | '' = ''): void {
  el.bindStatus.textContent = text;
  el.bindStatus.classList.remove('ok', 'bad', 'active');
  if (cls) el.bindStatus.classList.add(cls);
}

function renderBinding(): void {
  const ptt = settings?.ptt;
  if (!ptt) {
    setBindStatus('No button bound yet.');
    return;
  }
  setBindStatus(`Bound to ${ptt.product} (byte ${ptt.byteIndex}, bit 0x${ptt.bitMask.toString(16)}).`, 'ok');
}

function renderPttStatus(status: PttStatus): void {
  if (!status.available) {
    el.learn.disabled = true;
    setBindStatus(status.error ?? 'HID access unavailable.', 'bad');
    return;
  }
  el.learn.disabled = learning;
  if (!learning) renderBinding();
}

function renderTelemetryStatus(status: TelemetryStatus): void {
  el.udpStatus.classList.remove('ok', 'bad');

  if (status.error) {
    el.udpStatus.textContent = status.error;
    el.udpStatus.classList.add('bad');
    return;
  }
  if (status.listening) {
    el.udpStatus.textContent = `Listening on ${status.port}. Waiting for the game to send packets.`;
    el.udpStatus.classList.add('ok');
    return;
  }
  el.udpStatus.textContent = 'Not listening.';
}

async function loadDevices(): Promise<void> {
  const devices = await api.listPttDevices(el.showAllDevices.checked);
  el.device.innerHTML = '';

  if (devices.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No controllers found - is the wheel on?';
    option.value = '';
    el.device.appendChild(option);
    return;
  }

  // Show the wheel most likely to be the Moza base first.
  const sorted = [...devices].sort((a, b) => score(b) - score(a));
  for (const device of sorted) {
    const option = document.createElement('option');
    option.value = device.path;
    const maker = device.manufacturer ? `${device.manufacturer} ` : '';
    option.textContent = `${maker}${device.product}`;
    el.device.appendChild(option);
  }

  const boundPath = settings?.ptt?.path;
  if (boundPath && sorted.some((d) => d.path === boundPath)) el.device.value = boundPath;
}

function score(device: HidDeviceInfo): number {
  const text = `${device.manufacturer} ${device.product}`.toLowerCase();
  if (text.includes('moza')) return 3;
  if (/wheel|racing|base|r5|r9|r12|r16/.test(text)) return 2;
  return 0;
}

async function startLearn(): Promise<void> {
  const path = el.device.value;
  if (!path) {
    setBindStatus('Pick a controller first.', 'bad');
    return;
  }

  learning = true;
  el.learn.disabled = true;
  setBindStatus('Hold still, reading the wheel at rest…', 'active');

  const result = await api.learnPtt(path);
  learning = false;
  el.learn.disabled = false;

  if (result.ok) {
    settings = (await api.getSettings()).settings;
    renderBinding();
  } else {
    setBindStatus(result.error, 'bad');
  }
}

function wireInputs(): void {
  el.apiKey.addEventListener('change', () => void save({ geminiApiKey: el.apiKey.value.trim() }));
  el.model.addEventListener('change', () => void save({ geminiModel: el.model.value }));
  el.voice.addEventListener('change', () => void save({ voiceName: el.voice.value }));
  el.engineerName.addEventListener('change', () =>
    void save({ engineerName: el.engineerName.value.trim() || 'Bono' }),
  );

  el.udpPort.addEventListener('change', () => {
    const port = Number(el.udpPort.value);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) void save({ udpPort: port });
  });

  el.keyboardFallback.addEventListener('change', () =>
    void save({ keyboardFallbackEnabled: el.keyboardFallback.checked }),
  );
  el.keyboardAccel.addEventListener('change', () =>
    void save({ keyboardFallbackAccelerator: el.keyboardAccel.value.trim() || 'F8' }),
  );

  el.refreshDevices.addEventListener('click', () => void loadDevices());
  el.showAllDevices.addEventListener('change', () => void loadDevices());
  el.learn.addEventListener('click', () => void startLearn());
  el.clearBind.addEventListener('click', async () => {
    settings = await api.clearPtt();
    renderBinding();
  });

  el.studioLink.addEventListener('click', (event) => {
    event.preventDefault();
    void api.openExternal('https://aistudio.google.com/apikey');
  });

  el.close.addEventListener('click', () => void api.closeSettings());

  api.onLearnPhase((phase) => {
    setBindStatus(
      phase === 'baseline'
        ? 'Hold still, reading the wheel at rest…'
        : 'Now hold the button you want to use as the radio.',
      'active',
    );
  });

  api.onPttStatus(renderPttStatus);
  api.onTelemetryStatus(renderTelemetryStatus);
}

async function init(): Promise<void> {
  const bundle = await api.getSettings();
  settings = bundle.settings;

  el.apiKey.value = settings.geminiApiKey;
  fillSelect(el.model, bundle.models, settings.geminiModel);
  fillSelect(el.voice, bundle.voices, settings.voiceName);
  el.engineerName.value = settings.engineerName;
  el.udpPort.value = String(settings.udpPort);
  el.keyboardFallback.checked = settings.keyboardFallbackEnabled;
  el.keyboardAccel.value = settings.keyboardFallbackAccelerator;

  wireInputs();
  await loadDevices();
  renderPttStatus(await api.getPttStatus());
  renderTelemetryStatus(await api.getTelemetryStatus());
}

void init();
