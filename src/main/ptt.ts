// Push-to-talk driven straight off the wheel's HID reports.
//
// This deliberately does not use Electron's globalShortcut or the renderer's
// Gamepad API: F1 25 takes the keyboard while it has focus, and Chromium stops
// polling gamepads in unfocused windows. Reading HID in the main process keeps
// working no matter what has focus.

import { EventEmitter } from 'node:events';
import type { HidDeviceInfo, PttBinding, PttStatus } from '../shared/types';

interface HidDeviceRaw {
  path?: string;
  vendorId: number;
  productId: number;
  product?: string;
  manufacturer?: string;
  usagePage?: number;
  usage?: number;
  interface?: number;
}

interface HidHandle {
  on(event: 'data', cb: (data: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  close(): void;
  removeAllListeners(): void;
}

interface NodeHid {
  devices(): HidDeviceRaw[];
  HID: new (path: string) => HidHandle;
}

/** Generic Desktop usage page; joystick, gamepad and multi-axis controllers. */
const CONTROLLER_USAGE_PAGE = 0x01;
const CONTROLLER_USAGES = new Set([0x04, 0x05, 0x08]);

/** Sim racing hardware whose button interfaces are worth listing regardless of usage page. */
const WHEEL_NAME_HINT = /moza|fanatec|simucube|thrustmaster|logitech|simagic|asetek|cammus/i;

function looksLikeWheel(device: HidDeviceRaw): boolean {
  return WHEEL_NAME_HINT.test(`${device.manufacturer ?? ''} ${device.product ?? ''}`);
}

const RECONNECT_INTERVAL_MS = 2000;
/** How long we watch the idle device before asking for a button press. */
const LEARN_BASELINE_MS = 1200;
/** Consecutive reports a candidate bit must hold before we accept it. */
const LEARN_CONFIRM_REPORTS = 4;

function loadHid(): { hid: NodeHid | null; error: string | null } {
  try {
    // Required lazily so a missing native build degrades instead of crashing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node-hid') as NodeHid;
    return { hid: mod, error: null };
  } catch (err) {
    return {
      hid: null,
      error:
        `node-hid could not be loaded (${(err as Error).message}). ` +
        'Run "npm run rebuild" to build it for this Electron version.',
    };
  }
}

export class PttController extends EventEmitter {
  private hid: NodeHid | null;
  private loadError: string | null;

  private binding: PttBinding | null = null;
  private device: HidHandle | null = null;
  private deviceName: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private pressed = false;
  private learning: LearnSession | null = null;

  constructor() {
    super();
    const { hid, error } = loadHid();
    this.hid = hid;
    this.loadError = error;
  }

  getStatus(): PttStatus {
    return {
      available: this.hid !== null,
      bound: this.binding !== null,
      deviceConnected: this.device !== null,
      deviceName: this.deviceName,
      error: this.loadError,
    };
  }

  /**
   * Wheel bases often expose several HID interfaces and the buttons do not
   * always live on the one tagged as a joystick, so `includeAll` is offered as
   * an escape hatch when the expected device is missing from the short list.
   */
  listDevices(includeAll = false): HidDeviceInfo[] {
    if (!this.hid) return [];

    return this.hid
      .devices()
      .filter((d) => {
        if (!d.path) return false;
        if (includeAll) return true;
        // Devices that report no usage info at all are kept: that is common on
        // Linux and with some Windows drivers.
        if (d.usagePage === undefined || d.usage === undefined) return true;
        if (d.usagePage === CONTROLLER_USAGE_PAGE && CONTROLLER_USAGES.has(d.usage)) return true;
        return looksLikeWheel(d);
      })
      .map((d) => ({
        path: d.path as string,
        vendorId: d.vendorId,
        productId: d.productId,
        product: d.product ?? `Device ${d.vendorId.toString(16)}:${d.productId.toString(16)}`,
        manufacturer: d.manufacturer ?? '',
      }));
  }

  setBinding(binding: PttBinding | null): void {
    this.binding = binding;
    this.reconnect();
  }

  start(binding: PttBinding | null): void {
    this.binding = binding;
    this.reconnect();

    if (!this.reconnectTimer) {
      this.reconnectTimer = setInterval(() => {
        if (!this.device && this.binding && !this.learning) this.openBoundDevice();
      }, RECONNECT_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeDevice();
  }

  private reconnect(): void {
    this.closeDevice();
    if (this.binding) this.openBoundDevice();
    this.emit('status', this.getStatus());
  }

  private closeDevice(): void {
    if (this.device) {
      try {
        this.device.removeAllListeners();
        this.device.close();
      } catch {
        // Device may already be gone.
      }
    }
    this.device = null;
    this.deviceName = null;
    if (this.pressed) {
      this.pressed = false;
      this.emit('release');
    }
  }

  /**
   * HID paths are not stable across replugs on Windows, so fall back to
   * matching the same vendor/product pair.
   */
  private resolveBoundPath(binding: PttBinding): string | null {
    if (!this.hid) return null;
    const devices = this.hid.devices().filter((d) => !!d.path);

    const exact = devices.find((d) => d.path === binding.path);
    if (exact) return exact.path as string;

    const sameModel = devices.filter(
      (d) => d.vendorId === binding.vendorId && d.productId === binding.productId,
    );
    return sameModel.length > 0 ? (sameModel[0].path as string) : null;
  }

  private openBoundDevice(): void {
    if (!this.hid || !this.binding) return;

    const path = this.resolveBoundPath(this.binding);
    if (!path) return;

    try {
      const device = new this.hid.HID(path);
      this.device = device;
      this.deviceName = this.binding.product;

      device.on('data', (data: Buffer) => this.handleReport(data));
      device.on('error', () => this.closeDevice());

      this.emit('status', this.getStatus());
    } catch {
      this.device = null;
    }
  }

  private handleReport(data: Buffer): void {
    const binding = this.binding;
    if (!binding || data.length <= binding.byteIndex) return;

    const high = (data[binding.byteIndex] & binding.bitMask) !== 0;
    const isPressed = high !== binding.restingHigh;

    if (isPressed === this.pressed) return;
    this.pressed = isPressed;
    this.emit(isPressed ? 'press' : 'release');
  }

  /**
   * Watches a device while the user holds the button they want, and works out
   * which bit in the report it maps to. Report layouts differ per wheel, so we
   * diff against a captured idle baseline rather than parsing descriptors.
   */
  learn(devicePath: string, onProgress: (phase: 'baseline' | 'waiting') => void): Promise<PttBinding> {
    if (!this.hid) return Promise.reject(new Error(this.loadError ?? 'node-hid unavailable'));

    this.cancelLearn();
    this.closeDevice();

    const info = this.hid.devices().find((d) => d.path === devicePath);
    if (!info) return Promise.reject(new Error('That device is no longer connected.'));

    return new Promise<PttBinding>((resolve, reject) => {
      const session = new LearnSession(
        this.hid as NodeHid,
        devicePath,
        info,
        onProgress,
        (binding) => {
          this.learning = null;
          this.binding = binding;
          this.reconnect();
          resolve(binding);
        },
        (err) => {
          this.learning = null;
          this.reconnect();
          reject(err);
        },
      );
      this.learning = session;
      session.begin();
    });
  }

  cancelLearn(): void {
    if (this.learning) {
      this.learning.abort();
      this.learning = null;
    }
  }
}

class LearnSession {
  private device: HidHandle | null = null;
  private phase: 'baseline' | 'waiting' = 'baseline';
  /** Distinct values seen per byte while idle. More than one means it is an axis. */
  private baselineValues: Set<number>[] = [];
  private candidate: { byteIndex: number; bitMask: number; restingHigh: boolean } | null = null;
  private candidateHits = 0;
  private baselineTimer: NodeJS.Timeout | null = null;
  private finished = false;

  constructor(
    private hid: NodeHid,
    private path: string,
    private info: HidDeviceRaw,
    private onProgress: (phase: 'baseline' | 'waiting') => void,
    private onDone: (binding: PttBinding) => void,
    private onError: (err: Error) => void,
  ) {}

  begin(): void {
    try {
      this.device = new this.hid.HID(this.path);
    } catch (err) {
      this.onError(
        new Error(
          `Could not open that device (${(err as Error).message}). ` +
            'Close other apps using the wheel and try again.',
        ),
      );
      return;
    }

    this.device.on('data', (data: Buffer) => this.handle(data));
    this.device.on('error', (err: Error) => this.fail(err));

    this.onProgress('baseline');
    this.baselineTimer = setTimeout(() => {
      this.phase = 'waiting';
      this.onProgress('waiting');
    }, LEARN_BASELINE_MS);
  }

  private handle(data: Buffer): void {
    if (this.finished) return;

    if (this.phase === 'baseline') {
      for (let i = 0; i < data.length; i++) {
        if (!this.baselineValues[i]) this.baselineValues[i] = new Set();
        // Cap the set so a noisy axis cannot grow it without bound.
        if (this.baselineValues[i].size < 8) this.baselineValues[i].add(data[i]);
      }
      return;
    }

    const found = this.findChangedBit(data);
    if (!found) {
      this.candidate = null;
      this.candidateHits = 0;
      return;
    }

    const same =
      this.candidate &&
      this.candidate.byteIndex === found.byteIndex &&
      this.candidate.bitMask === found.bitMask;

    if (same) {
      this.candidateHits++;
    } else {
      this.candidate = found;
      this.candidateHits = 1;
    }

    if (this.candidateHits >= LEARN_CONFIRM_REPORTS) this.succeed(found);
  }

  /** Looks for one bit that flipped in a byte that stayed still while idle. */
  private findChangedBit(data: Buffer): { byteIndex: number; bitMask: number; restingHigh: boolean } | null {
    for (let i = 0; i < data.length; i++) {
      const seen = this.baselineValues[i];
      if (!seen || seen.size !== 1) continue;

      const resting = seen.values().next().value as number;
      const diff = resting ^ data[i];
      if (diff === 0) continue;

      // A button press flips exactly one bit; anything else is an axis moving.
      if ((diff & (diff - 1)) !== 0) continue;

      return { byteIndex: i, bitMask: diff, restingHigh: (resting & diff) !== 0 };
    }
    return null;
  }

  private succeed(found: { byteIndex: number; bitMask: number; restingHigh: boolean }): void {
    this.cleanup();
    this.onDone({
      vendorId: this.info.vendorId,
      productId: this.info.productId,
      path: this.path,
      product: this.info.product ?? 'Wheel',
      byteIndex: found.byteIndex,
      bitMask: found.bitMask,
      restingHigh: found.restingHigh,
    });
  }

  private fail(err: Error): void {
    this.cleanup();
    this.onError(err);
  }

  abort(): void {
    this.cleanup();
  }

  private cleanup(): void {
    this.finished = true;
    if (this.baselineTimer) clearTimeout(this.baselineTimer);
    if (this.device) {
      try {
        this.device.removeAllListeners();
        this.device.close();
      } catch {
        // Nothing useful to do.
      }
      this.device = null;
    }
  }
}
