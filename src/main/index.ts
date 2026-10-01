import { app, BrowserWindow, globalShortcut, ipcMain, Menu, shell, Tray } from 'electron';
import { buildEngineerBrief, ENGINEER_SYSTEM_PROMPT } from '../telemetry/brief';
import type { AppSettings, EngineerState, PttBinding, PttSource } from '../shared/types';
import { PttController } from './ptt';
import { GEMINI_MODEL_CHOICES, loadSettings, saveSettings, VOICE_CHOICES } from './settings';
import { TelemetryService } from './telemetry-service';
import { createOverlayWindow, createSettingsWindow, createTrayIcon, TRAY_COLORS } from './windows';

/** Holding the wheel button this long opens settings instead of talking. */
const LONG_PRESS_MS = 1500;
const SETTINGS_ACCELERATOR = 'CommandOrControl+Shift+F1';

let overlay: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const telemetry = new TelemetryService();
const ptt = new PttController();

let engineerState: EngineerState = 'idle';
let pressTimer: NodeJS.Timeout | null = null;
let longPressFired = false;

function sendToOverlay(channel: string, payload: unknown): void {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

function sendToSettings(channel: string, payload: unknown): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

function trayColorForState(): { r: number; g: number; b: number } {
  switch (engineerState) {
    case 'listening':
      return TRAY_COLORS.listening;
    case 'speaking':
    case 'thinking':
      return TRAY_COLORS.speaking;
    case 'error':
      return TRAY_COLORS.error;
    default:
      return telemetry.getStatus().listening ? TRAY_COLORS.ready : TRAY_COLORS.idle;
  }
}

function refreshTray(): void {
  if (!tray) return;
  tray.setImage(createTrayIcon(trayColorForState()));

  const status = telemetry.getStatus();
  const pttStatus = ptt.getStatus();
  tray.setToolTip(
    [
      `Race Engineer: ${engineerState}`,
      status.listening ? `UDP listening on ${status.port}` : 'UDP not listening',
      pttStatus.bound ? `PTT: ${pttStatus.deviceName ?? 'wheel'}` : 'PTT not bound',
    ].join('\n'),
  );
}

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = createSettingsWindow(overlay);
  settingsWindow.on('closed', () => {
    ptt.cancelLearn();
    settingsWindow = null;
  });
}

function handlePttDown(source: PttSource): void {
  longPressFired = false;

  if (source === 'wheel') {
    pressTimer = setTimeout(() => {
      longPressFired = true;
      // Cancel the radio call that was in progress and show settings instead.
      sendToOverlay('ptt:cancel', null);
      openSettings();
    }, LONG_PRESS_MS);
  }

  sendToOverlay('ptt:down', { source, brief: buildEngineerBrief(telemetry.getSnapshot()) });
}

function handlePttUp(): void {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  sendToOverlay('ptt:up', null);
}

function registerShortcuts(settings: AppSettings): void {
  globalShortcut.unregisterAll();
  globalShortcut.register(SETTINGS_ACCELERATOR, openSettings);

  // Only a convenience for testing at the desk; F1 25 swallows keys in game.
  if (settings.keyboardFallbackEnabled && settings.keyboardFallbackAccelerator) {
    const accelerator = settings.keyboardFallbackAccelerator;
    globalShortcut.register(accelerator, () => {
      // globalShortcut has no key-up event, so the keyboard path toggles.
      if (engineerState === 'listening') handlePttUp();
      else handlePttDown('keyboard');
    });
  }
}

function applySettings(settings: AppSettings, restartTelemetry: boolean): void {
  if (restartTelemetry) telemetry.start(settings.udpPort);
  ptt.setBinding(settings.ptt);
  registerShortcuts(settings);
  sendToOverlay('settings:changed', settings);
  sendToSettings('settings:changed', settings);
  refreshTray();
}

function wireIpc(): void {
  ipcMain.handle('settings:get', () => ({
    settings: loadSettings(),
    models: GEMINI_MODEL_CHOICES,
    voices: VOICE_CHOICES,
    systemPrompt: ENGINEER_SYSTEM_PROMPT,
  }));

  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const before = loadSettings();
    const next = saveSettings(patch);
    applySettings(next, next.udpPort !== before.udpPort);
    return next;
  });

  ipcMain.handle('settings:open', () => openSettings());
  ipcMain.handle('settings:close', () => settingsWindow?.close());

  ipcMain.handle('telemetry:status', () => telemetry.getStatus());
  ipcMain.handle('telemetry:snapshot', () => telemetry.getSnapshot());
  ipcMain.handle('telemetry:brief', () => buildEngineerBrief(telemetry.getSnapshot()));

  ipcMain.handle('ptt:status', () => ptt.getStatus());
  ipcMain.handle('ptt:devices', (_e, includeAll: boolean) => ptt.listDevices(includeAll));

  ipcMain.handle('ptt:learn', async (_e, devicePath: string) => {
    try {
      const binding = await ptt.learn(devicePath, (phase) => sendToSettings('ptt:learnPhase', phase));
      const next = saveSettings({ ptt: binding });
      applySettings(next, false);
      return { ok: true as const, binding };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  ipcMain.handle('ptt:cancelLearn', () => ptt.cancelLearn());

  ipcMain.handle('ptt:clear', () => {
    const next = saveSettings({ ptt: null as PttBinding | null });
    applySettings(next, false);
    return next;
  });

  ipcMain.handle('engineer:state', (_e, state: EngineerState) => {
    engineerState = state;
    refreshTray();
  });

  ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url));
  ipcMain.handle('app:quit', () => app.quit());
}

function wireServices(): void {
  telemetry.on('snapshot', (snapshot) => sendToOverlay('telemetry:snapshot', snapshot));
  telemetry.on('status', (status) => {
    sendToOverlay('telemetry:status', status);
    sendToSettings('telemetry:status', status);
    refreshTray();
  });

  ptt.on('press', () => handlePttDown('wheel'));
  ptt.on('release', () => handlePttUp());
  ptt.on('status', (status) => {
    sendToOverlay('ptt:status', status);
    sendToSettings('ptt:status', status);
    refreshTray();
  });
}

function createTray(): void {
  tray = new Tray(createTrayIcon(TRAY_COLORS.idle));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Settings', click: openSettings },
      {
        label: 'Reload overlay',
        click: () => overlay?.reload(),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', openSettings);
  refreshTray();
}

// A second copy would fight for the UDP port and the HID handle.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openSettings);

  app.whenReady().then(() => {
    const settings = loadSettings();

    overlay = createOverlayWindow();
    overlay.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });

    wireIpc();
    wireServices();
    createTray();

    telemetry.start(settings.udpPort);
    ptt.start(settings.ptt);
    registerShortcuts(settings);

    const needsSetup = !settings.geminiApiKey || !settings.ptt;
    if (needsSetup) openSettings();
  });

  // Registering this at all suppresses Electron's default quit-on-last-window,
  // which matters because the overlay is the app and settings comes and goes.
  app.on('window-all-closed', () => {});

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    telemetry.stop();
    ptt.stop();
  });
}
