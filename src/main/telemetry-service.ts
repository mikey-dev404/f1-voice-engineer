import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { parsePacket } from '../telemetry/parser';
import { SnapshotBuilder, type TelemetrySnapshot } from '../telemetry/snapshot';
import type { TelemetryStatus } from '../shared/types';

/** How often the HUD is refreshed. The parser still consumes every packet. */
const SNAPSHOT_INTERVAL_MS = 100;

export class TelemetryService extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private builder = new SnapshotBuilder();
  private timer: NodeJS.Timeout | null = null;
  private status: TelemetryStatus = { listening: false, port: 0, error: null, portInUse: false };
  private sawForeignFormat = false;

  start(port: number): void {
    this.stop();

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    this.status = { listening: false, port, error: null, portInUse: false };

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const portInUse = err.code === 'EADDRINUSE';
      this.status = {
        listening: false,
        port,
        portInUse,
        error: portInUse
          ? `Port ${port} is already taken. Close SimHub, CrewChief or any other telemetry app, or change the port here and in the game.`
          : err.message,
      };
      this.emit('status', this.status);
      socket.close();
      this.socket = null;
    });

    socket.on('listening', () => {
      this.status = { listening: true, port, error: null, portInUse: false };
      this.emit('status', this.status);
    });

    socket.on('message', (msg) => {
      this.builder.markPacketSeen();

      const parsed = parsePacket(msg);
      if (parsed) {
        this.sawForeignFormat = false;
        this.builder.apply(parsed);
      } else if (msg.length >= 2 && msg.readUInt16LE(0) !== 2025) {
        // The game is emitting a legacy layout; nothing we decode will be right.
        this.sawForeignFormat = true;
      }
      this.builder.markWrongFormat(this.sawForeignFormat);
    });

    socket.bind(port, '0.0.0.0');

    this.timer = setInterval(() => {
      this.emit('snapshot', this.builder.build());
    }, SNAPSHOT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed.
      }
      this.socket = null;
    }
    this.status = { ...this.status, listening: false };
  }

  getStatus(): TelemetryStatus {
    return this.status;
  }

  getSnapshot(): TelemetrySnapshot {
    return this.builder.build();
  }
}
