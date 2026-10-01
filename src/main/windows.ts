import { BrowserWindow, screen, nativeImage, type NativeImage } from 'electron';
import path from 'node:path';

const OVERLAY_WIDTH = 760;
const OVERLAY_HEIGHT = 210;
/** Gap below the top edge of the screen, roughly under the game's own HUD. */
const OVERLAY_TOP_MARGIN = 24;

function preloadPath(): string {
  return path.join(__dirname, '../preload/index.js');
}

function rendererFile(name: string): string {
  return path.join(__dirname, '../renderer', name);
}

export function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;

  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: Math.round(x + (width - OVERLAY_WIDTH) / 2),
    y: Math.round(y + OVERLAY_TOP_MARGIN),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    // Chromium throttles background windows, which would stall audio playback
    // and the HUD while the game holds focus.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' is the highest level that still sits under system UI, and is
  // what keeps the overlay drawn on top of a borderless-windowed game.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(rendererFile('overlay.html'));
  win.once('ready-to-show', () => win.showInactive());

  return win;
}

export function createSettingsWindow(parentOverlay: BrowserWindow | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 620,
    height: 780,
    title: 'Race Engineer Settings',
    show: false,
    backgroundColor: '#12151b',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(rendererFile('settings.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // Keep the overlay above the game even while settings is open.
  parentOverlay?.setAlwaysOnTop(true, 'screen-saver');

  return win;
}

/**
 * Draws the tray icon in code so the repo carries no binary assets. A filled
 * disc reads clearly at tray size and the colour doubles as a state light.
 */
export function createTrayIcon(color: { r: number; g: number; b: number }): NativeImage {
  const size = 32;
  const radius = size / 2 - 2;
  const centre = size / 2;
  const buffer = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - centre;
      const dy = y + 0.5 - centre;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Feather the last pixel of the edge so the disc is not jagged.
      const alpha = Math.max(0, Math.min(1, radius - dist)) * 255;
      const offset = (y * size + x) * 4;
      buffer[offset] = color.b;
      buffer[offset + 1] = color.g;
      buffer[offset + 2] = color.r;
      buffer[offset + 3] = Math.round(alpha);
    }
  }

  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

export const TRAY_COLORS = {
  idle: { r: 130, g: 138, b: 150 },
  ready: { r: 80, g: 200, b: 120 },
  listening: { r: 235, g: 60, b: 60 },
  speaking: { r: 70, g: 150, b: 255 },
  error: { r: 235, g: 160, b: 40 },
};
