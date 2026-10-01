import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppSettings,
  EngineerState,
  HidDeviceInfo,
  PttBinding,
  PttStatus,
  TelemetrySnapshot,
  TelemetryStatus,
} from '../shared/types';

export interface SettingsBundle {
  settings: AppSettings;
  models: string[];
  voices: string[];
  systemPrompt: string;
}

export type LearnResult = { ok: true; binding: PttBinding } | { ok: false; error: string };

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  getSettings: (): Promise<SettingsBundle> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  openSettings: (): Promise<void> => ipcRenderer.invoke('settings:open'),
  closeSettings: (): Promise<void> => ipcRenderer.invoke('settings:close'),

  getTelemetryStatus: (): Promise<TelemetryStatus> => ipcRenderer.invoke('telemetry:status'),
  getSnapshot: (): Promise<TelemetrySnapshot> => ipcRenderer.invoke('telemetry:snapshot'),
  getBrief: (): Promise<string> => ipcRenderer.invoke('telemetry:brief'),

  getPttStatus: (): Promise<PttStatus> => ipcRenderer.invoke('ptt:status'),
  listPttDevices: (includeAll = false): Promise<HidDeviceInfo[]> =>
    ipcRenderer.invoke('ptt:devices', includeAll),
  learnPtt: (devicePath: string): Promise<LearnResult> => ipcRenderer.invoke('ptt:learn', devicePath),
  cancelLearnPtt: (): Promise<void> => ipcRenderer.invoke('ptt:cancelLearn'),
  clearPtt: (): Promise<AppSettings> => ipcRenderer.invoke('ptt:clear'),

  reportState: (state: EngineerState): Promise<void> => ipcRenderer.invoke('engineer:state', state),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  onSnapshot: (cb: (s: TelemetrySnapshot) => void) => subscribe('telemetry:snapshot', cb),
  onTelemetryStatus: (cb: (s: TelemetryStatus) => void) => subscribe('telemetry:status', cb),
  onPttStatus: (cb: (s: PttStatus) => void) => subscribe('ptt:status', cb),
  onPttDown: (cb: (p: { source: string; brief: string }) => void) => subscribe('ptt:down', cb),
  onPttUp: (cb: () => void) => subscribe('ptt:up', cb),
  onPttCancel: (cb: () => void) => subscribe('ptt:cancel', cb),
  onLearnPhase: (cb: (phase: 'baseline' | 'waiting') => void) => subscribe('ptt:learnPhase', cb),
  onSettingsChanged: (cb: (s: AppSettings) => void) => subscribe('settings:changed', cb),
};

export type EngineerApi = typeof api;

contextBridge.exposeInMainWorld('engineer', api);
