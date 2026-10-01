// Folds the raw 20-60Hz packet stream into one small player-centric state
// object. Everything the engineer knows comes from here.

import { PacketId } from './constants';
import type {
  CarDamage,
  CarStatus,
  CarTelemetry,
  LapData,
  Participant,
  ParsedPacket,
  SessionData,
} from './parser';

export interface RivalInfo {
  name: string;
  position: number;
  /** Seconds. Positive means they are that far away from us. */
  gapSec: number | null;
  tyreCompound: string | null;
  tyreAgeLaps: number | null;
  pitStops: number | null;
  inPits: boolean;
}

export interface LapRecord {
  lap: number;
  timeMs: number;
  tyreAgeLaps: number;
  compound: string | null;
}

export interface TelemetrySnapshot {
  connected: boolean;
  lastPacketAt: number | null;
  packetsPerSecond: number;
  /** Set when packets arrive but announce a format other than 2025. */
  wrongFormat: boolean;

  session: SessionData | null;
  player: {
    index: number;
    name: string | null;
    telemetry: CarTelemetry | null;
    status: CarStatus | null;
    lap: LapData | null;
    damage: CarDamage | null;
  };
  ahead: RivalInfo | null;
  behind: RivalInfo | null;
  leader: RivalInfo | null;
  recentLaps: LapRecord[];
  recentEvents: { at: number; text: string }[];
}

const MAX_RECENT_LAPS = 5;
const MAX_RECENT_EVENTS = 8;
/** Treat the feed as dead if nothing arrives for this long. */
export const STALE_AFTER_MS = 2000;

import { ACTUAL_COMPOUND, VISUAL_COMPOUND } from './constants';

export function compoundName(status: CarStatus | null | undefined): string | null {
  if (!status) return null;
  const visual = VISUAL_COMPOUND[status.visualTyreCompound];
  const actual = ACTUAL_COMPOUND[status.actualTyreCompound];
  if (visual && actual && visual !== actual) return `${visual} (${actual})`;
  return visual ?? actual ?? null;
}

export class SnapshotBuilder {
  private session: SessionData | null = null;
  private participants: Participant[] = [];
  private telemetry: CarTelemetry[] = [];
  private statuses: CarStatus[] = [];
  private laps: LapData[] = [];
  private damage: CarDamage[] = [];

  private playerIndex = 0;
  private sessionUID: string | null = null;
  private lastPacketAt: number | null = null;
  private wrongFormat = false;

  private packetTimes: number[] = [];
  private recentLaps: LapRecord[] = [];
  private recentEvents: { at: number; text: string }[] = [];
  private lastSeenLapNum = 0;

  /** Called for every datagram, including ones we do not decode. */
  markPacketSeen(now = Date.now()): void {
    this.lastPacketAt = now;
    this.packetTimes.push(now);
    if (this.packetTimes.length > 200) this.packetTimes.shift();
  }

  markWrongFormat(wrong: boolean): void {
    this.wrongFormat = wrong;
  }

  apply(packet: ParsedPacket): void {
    if (!packet) return;

    if (this.sessionUID !== packet.header.sessionUID) {
      this.resetForNewSession(packet.header.sessionUID);
    }
    this.playerIndex = packet.header.playerCarIndex;

    switch (packet.id) {
      case PacketId.Session:
        this.session = packet.session;
        break;
      case PacketId.Participants:
        this.participants = packet.participants;
        break;
      case PacketId.CarTelemetry:
        this.telemetry = packet.cars;
        break;
      case PacketId.CarStatus:
        this.statuses = packet.cars;
        break;
      case PacketId.CarDamage:
        this.damage = packet.cars;
        break;
      case PacketId.LapData:
        this.laps = packet.cars;
        this.trackLapCompletion();
        break;
      case PacketId.Event:
        this.recordEvent(packet.event.code, packet.event.detail);
        break;
    }
  }

  private resetForNewSession(uid: string): void {
    this.sessionUID = uid;
    this.recentLaps = [];
    this.recentEvents = [];
    this.lastSeenLapNum = 0;
  }

  /** Snapshots a lap time the moment the lap counter ticks over. */
  private trackLapCompletion(): void {
    const lap = this.laps[this.playerIndex];
    if (!lap) return;

    if (this.lastSeenLapNum && lap.currentLapNum > this.lastSeenLapNum && lap.lastLapTimeMs > 0) {
      const status = this.statuses[this.playerIndex];
      this.recentLaps.unshift({
        lap: this.lastSeenLapNum,
        timeMs: lap.lastLapTimeMs,
        tyreAgeLaps: status?.tyreAgeLaps ?? 0,
        compound: compoundName(status),
      });
      if (this.recentLaps.length > MAX_RECENT_LAPS) this.recentLaps.pop();
    }
    this.lastSeenLapNum = lap.currentLapNum;
  }

  private pushEvent(text: string): void {
    this.recentEvents.unshift({ at: Date.now(), text });
    if (this.recentEvents.length > MAX_RECENT_EVENTS) this.recentEvents.pop();
  }

  private driverName(idx: number): string {
    const p = this.participants[idx];
    if (p?.name) return p.name;
    return `car ${idx}`;
  }

  private recordEvent(code: string, detail: Buffer): void {
    const safeU8 = (at: number) => (detail.length > at ? detail.readUInt8(at) : 0);
    const safeF32 = (at: number) => (detail.length >= at + 4 ? detail.readFloatLE(at) : 0);

    switch (code) {
      case 'SSTA':
        this.pushEvent('Session started');
        break;
      case 'SEND':
        this.pushEvent('Session ended');
        break;
      case 'FTLP':
        this.pushEvent(
          `Fastest lap: ${this.driverName(safeU8(0))} ${formatLapTime(safeF32(1) * 1000)}`,
        );
        break;
      case 'RTMT':
        this.pushEvent(`${this.driverName(safeU8(0))} retired`);
        break;
      case 'DRSE':
        this.pushEvent('DRS enabled');
        break;
      case 'DRSD':
        this.pushEvent('DRS disabled');
        break;
      case 'TMPT':
        this.pushEvent('Team mate is pitting');
        break;
      case 'CHQF':
        this.pushEvent('Chequered flag');
        break;
      case 'RCWN':
        this.pushEvent(`Race winner: ${this.driverName(safeU8(0))}`);
        break;
      case 'PENA':
        if (safeU8(2) === this.playerIndex) {
          this.pushEvent(`Penalty given to you (${safeU8(4)}s) on lap ${safeU8(5)}`);
        }
        break;
      case 'SPTP':
        if (safeU8(0) === this.playerIndex) {
          this.pushEvent(`Speed trap: ${Math.round(safeF32(1))} kph`);
        }
        break;
      case 'LGOT':
        this.pushEvent('Lights out, race started');
        break;
      case 'RDFL':
        this.pushEvent('Red flag');
        break;
      case 'SCAR': {
        const type = ['no safety car', 'safety car', 'virtual safety car', 'formation lap'][safeU8(0)];
        const phase = ['deployed', 'returning', 'returned', 'race resuming'][safeU8(1)];
        this.pushEvent(`${type} ${phase}`);
        break;
      }
      case 'COLL':
        if (safeU8(0) === this.playerIndex || safeU8(1) === this.playerIndex) {
          const other = safeU8(0) === this.playerIndex ? safeU8(1) : safeU8(0);
          this.pushEvent(`Collision with ${this.driverName(other)}`);
        }
        break;
    }
  }

  private rivalAt(position: number): RivalInfo | null {
    const idx = this.laps.findIndex((l) => l && l.carPosition === position && l.resultStatus !== 0);
    if (idx === -1) return null;

    const lap = this.laps[idx];
    const status = this.statuses[idx];
    return {
      name: this.driverName(idx),
      position,
      gapSec: null,
      tyreCompound: compoundName(status),
      tyreAgeLaps: status?.tyreAgeLaps ?? null,
      pitStops: lap.numPitStops,
      inPits: lap.pitStatus !== 0,
    };
  }

  build(now = Date.now()): TelemetrySnapshot {
    const playerLap = this.laps[this.playerIndex] ?? null;
    const cutoff = now - 1000;
    const packetsPerSecond = this.packetTimes.filter((t) => t > cutoff).length;

    let ahead: RivalInfo | null = null;
    let behind: RivalInfo | null = null;
    let leader: RivalInfo | null = null;

    if (playerLap && playerLap.carPosition > 0) {
      if (playerLap.carPosition > 1) {
        ahead = this.rivalAt(playerLap.carPosition - 1);
        // The player's own packet carries the gap to the car in front.
        if (ahead) ahead.gapSec = playerLap.deltaToCarInFrontMs / 1000;

        leader = this.rivalAt(1);
        if (leader) leader.gapSec = playerLap.deltaToRaceLeaderMs / 1000;
      }

      behind = this.rivalAt(playerLap.carPosition + 1);
      if (behind) {
        // The car behind stores its own gap to us in its delta-to-front field.
        const idx = this.laps.findIndex((l) => l && l.carPosition === playerLap.carPosition + 1);
        if (idx !== -1) behind.gapSec = this.laps[idx].deltaToCarInFrontMs / 1000;
      }
    }

    return {
      connected: this.lastPacketAt !== null && now - this.lastPacketAt < STALE_AFTER_MS,
      lastPacketAt: this.lastPacketAt,
      packetsPerSecond,
      wrongFormat: this.wrongFormat,
      session: this.session,
      player: {
        index: this.playerIndex,
        name: this.participants[this.playerIndex]?.name ?? null,
        telemetry: this.telemetry[this.playerIndex] ?? null,
        status: this.statuses[this.playerIndex] ?? null,
        lap: playerLap,
        damage: this.damage[this.playerIndex] ?? null,
      },
      ahead,
      behind,
      leader,
      recentLaps: this.recentLaps,
      recentEvents: this.recentEvents,
    };
  }
}

export function formatLapTime(ms: number): string {
  if (!ms || ms <= 0) return '--';
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return min > 0 ? `${min}:${sec.toFixed(3).padStart(6, '0')}` : sec.toFixed(3);
}
