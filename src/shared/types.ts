import type { TelemetrySnapshot } from '../telemetry/snapshot';

export type { TelemetrySnapshot };

export interface PttBinding {
  vendorId: number;
  productId: number;
  /** Stable-ish OS path for the exact HID interface the button lives on. */
  path: string;
  product: string;
  /** Byte offset inside the HID input report that carries the button bit. */
  byteIndex: number;
  /** Single-bit mask within that byte. */
  bitMask: number;
  /** Value of the bit when the button is at rest, so inverted buttons work too. */
  restingHigh: boolean;
}

export interface AppSettings {
  geminiApiKey: string;
  geminiModel: string;
  voiceName: string;
  engineerName: string;
  udpPort: number;
  ptt: PttBinding | null;
  /** Fallback for testing away from the wheel; unreliable while F1 has focus. */
  keyboardFallbackAccelerator: string;
  keyboardFallbackEnabled: boolean;
  overlayOpacity: number;
  showCaptions: boolean;
}

export interface HidDeviceInfo {
  path: string;
  vendorId: number;
  productId: number;
  product: string;
  manufacturer: string;
}

export type PttSource = 'wheel' | 'keyboard';

export interface PttStatus {
  available: boolean;
  bound: boolean;
  deviceConnected: boolean;
  deviceName: string | null;
  /** Populated when node-hid could not be loaded at all. */
  error: string | null;
}

export interface TelemetryStatus {
  listening: boolean;
  port: number;
  error: string | null;
  portInUse: boolean;
}

export type EngineerState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
