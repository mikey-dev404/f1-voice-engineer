import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings } from '../shared/types';

const DEFAULTS: AppSettings = {
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash-native-audio-preview-09-2025',
  voiceName: 'Charon',
  engineerName: 'Bono',
  udpPort: 20777,
  ptt: null,
  keyboardFallbackAccelerator: 'F8',
  keyboardFallbackEnabled: true,
  overlayOpacity: 0.95,
  showCaptions: true,
};

let cached: AppSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readEnvKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;

  // Also accept a .env sitting next to the project during development.
  try {
    const envFile = path.join(app.getAppPath(), '.env');
    const text = fs.readFileSync(envFile, 'utf8');
    const match = text.match(/^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // No .env is the normal case once the key is saved in settings.
  }
  return '';
}

export function loadSettings(): AppSettings {
  if (cached) return cached;

  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    // First run.
  }

  cached = { ...DEFAULTS, ...stored };
  if (!cached.geminiApiKey) cached.geminiApiKey = readEnvKey();
  return cached;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch };
  cached = next;

  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not persist settings:', err);
  }
  return next;
}

export const GEMINI_MODEL_CHOICES = [
  'gemini-2.5-flash-native-audio-preview-09-2025',
  'gemini-2.5-flash-live-preview',
  'gemini-3.1-flash-live-preview',
  'gemini-live-2.5-flash-preview',
];

/** Prebuilt Gemini voices. Charon and Fenrir read closest to a pit wall engineer. */
export const VOICE_CHOICES = [
  'Charon',
  'Fenrir',
  'Puck',
  'Kore',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr',
];
