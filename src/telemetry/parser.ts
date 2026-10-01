// Parser for the F1 25 native UDP format (packet format 2025).
//
// Every struct in the spec is packed little-endian with no padding, which the
// documented packet sizes confirm (e.g. car telemetry = 29 + 22*60 + 3 = 1352).
// Offsets below are therefore plain byte arithmetic against the struct layout.

import { HEADER_SIZE, PacketId } from './constants';

export const MAX_CARS = 22;

export interface PacketHeader {
  packetFormat: number;
  gameYear: number;
  packetVersion: number;
  packetId: PacketId;
  sessionUID: string;
  sessionTime: number;
  frameIdentifier: number;
  playerCarIndex: number;
}

export interface CarTelemetry {
  speedKph: number;
  throttle: number;
  steer: number;
  brake: number;
  gear: number;
  engineRpm: number;
  drs: boolean;
  brakeTempsC: number[];
  tyreSurfaceTempsC: number[];
  tyreInnerTempsC: number[];
  engineTempC: number;
  tyrePressuresPsi: number[];
}

export interface CarStatus {
  fuelMix: number;
  frontBrakeBias: number;
  pitLimiterOn: boolean;
  fuelInTank: number;
  fuelCapacity: number;
  fuelRemainingLaps: number;
  maxRpm: number;
  drsAllowed: boolean;
  drsActivationDistanceM: number;
  actualTyreCompound: number;
  visualTyreCompound: number;
  tyreAgeLaps: number;
  fiaFlag: number;
  ersStoreEnergy: number;
  ersDeployMode: number;
  ersHarvestedThisLap: number;
  ersDeployedThisLap: number;
}

export interface LapData {
  lastLapTimeMs: number;
  currentLapTimeMs: number;
  sector1Ms: number;
  sector2Ms: number;
  deltaToCarInFrontMs: number;
  deltaToRaceLeaderMs: number;
  lapDistanceM: number;
  carPosition: number;
  currentLapNum: number;
  pitStatus: number;
  numPitStops: number;
  sector: number;
  currentLapInvalid: boolean;
  penaltiesSec: number;
  totalWarnings: number;
  numUnservedDriveThroughPens: number;
  numUnservedStopGoPens: number;
  gridPosition: number;
  driverStatus: number;
  resultStatus: number;
  speedTrapFastestKph: number;
}

export interface CarDamage {
  tyreWearPct: number[];
  tyreDamagePct: number[];
  brakeDamagePct: number[];
  frontLeftWingPct: number;
  frontRightWingPct: number;
  rearWingPct: number;
  floorPct: number;
  diffuserPct: number;
  sidepodPct: number;
  drsFault: boolean;
  ersFault: boolean;
  gearboxPct: number;
  enginePct: number;
}

export interface WeatherForecast {
  timeOffsetMin: number;
  weather: number;
  trackTempC: number;
  airTempC: number;
  rainPercentage: number;
}

export interface SessionData {
  weather: number;
  trackTempC: number;
  airTempC: number;
  totalLaps: number;
  trackLengthM: number;
  sessionType: number;
  trackId: number;
  sessionTimeLeftSec: number;
  sessionDurationSec: number;
  pitSpeedLimitKph: number;
  safetyCarStatus: number;
  forecast: WeatherForecast[];
  pitWindowIdealLap: number;
  pitWindowLatestLap: number;
  pitRejoinPosition: number;
}

export interface Participant {
  aiControlled: boolean;
  teamId: number;
  raceNumber: number;
  name: string;
}

export interface EventData {
  code: string;
  /** Raw detail bytes; interpretation depends on the event code. */
  detail: Buffer;
}

export type ParsedPacket =
  | { id: PacketId.CarTelemetry; header: PacketHeader; cars: CarTelemetry[] }
  | { id: PacketId.CarStatus; header: PacketHeader; cars: CarStatus[] }
  | { id: PacketId.LapData; header: PacketHeader; cars: LapData[] }
  | { id: PacketId.CarDamage; header: PacketHeader; cars: CarDamage[] }
  | { id: PacketId.Session; header: PacketHeader; session: SessionData }
  | { id: PacketId.Participants; header: PacketHeader; participants: Participant[] }
  | { id: PacketId.Event; header: PacketHeader; event: EventData }
  | null;

function readHeader(buf: Buffer): PacketHeader {
  return {
    packetFormat: buf.readUInt16LE(0),
    gameYear: buf.readUInt8(2),
    packetVersion: buf.readUInt8(5),
    packetId: buf.readUInt8(6) as PacketId,
    sessionUID: buf.readBigUInt64LE(7).toString(),
    sessionTime: buf.readFloatLE(15),
    frameIdentifier: buf.readUInt32LE(19),
    playerCarIndex: buf.readUInt8(27),
  };
}

/** The spec splits several times into a whole-minutes part and a milliseconds part. */
function joinMinutesAndMs(minutes: number, ms: number): number {
  return minutes * 60_000 + ms;
}

const TELEMETRY_STRIDE = 60;

function readCarTelemetry(buf: Buffer, at: number): CarTelemetry {
  return {
    speedKph: buf.readUInt16LE(at),
    throttle: buf.readFloatLE(at + 2),
    steer: buf.readFloatLE(at + 6),
    brake: buf.readFloatLE(at + 10),
    gear: buf.readInt8(at + 15),
    engineRpm: buf.readUInt16LE(at + 16),
    drs: buf.readUInt8(at + 18) === 1,
    brakeTempsC: [0, 1, 2, 3].map((i) => buf.readUInt16LE(at + 22 + i * 2)),
    tyreSurfaceTempsC: [0, 1, 2, 3].map((i) => buf.readUInt8(at + 30 + i)),
    tyreInnerTempsC: [0, 1, 2, 3].map((i) => buf.readUInt8(at + 34 + i)),
    engineTempC: buf.readUInt16LE(at + 38),
    tyrePressuresPsi: [0, 1, 2, 3].map((i) => buf.readFloatLE(at + 40 + i * 4)),
  };
}

const STATUS_STRIDE = 55;

function readCarStatus(buf: Buffer, at: number): CarStatus {
  return {
    fuelMix: buf.readUInt8(at + 2),
    frontBrakeBias: buf.readUInt8(at + 3),
    pitLimiterOn: buf.readUInt8(at + 4) === 1,
    fuelInTank: buf.readFloatLE(at + 5),
    fuelCapacity: buf.readFloatLE(at + 9),
    fuelRemainingLaps: buf.readFloatLE(at + 13),
    maxRpm: buf.readUInt16LE(at + 17),
    drsAllowed: buf.readUInt8(at + 22) === 1,
    drsActivationDistanceM: buf.readUInt16LE(at + 23),
    actualTyreCompound: buf.readUInt8(at + 25),
    visualTyreCompound: buf.readUInt8(at + 26),
    tyreAgeLaps: buf.readUInt8(at + 27),
    fiaFlag: buf.readInt8(at + 28),
    ersStoreEnergy: buf.readFloatLE(at + 37),
    ersDeployMode: buf.readUInt8(at + 41),
    ersHarvestedThisLap: buf.readFloatLE(at + 42) + buf.readFloatLE(at + 46),
    ersDeployedThisLap: buf.readFloatLE(at + 50),
  };
}

const LAP_STRIDE = 57;

function readLapData(buf: Buffer, at: number): LapData {
  return {
    lastLapTimeMs: buf.readUInt32LE(at),
    currentLapTimeMs: buf.readUInt32LE(at + 4),
    sector1Ms: joinMinutesAndMs(buf.readUInt8(at + 10), buf.readUInt16LE(at + 8)),
    sector2Ms: joinMinutesAndMs(buf.readUInt8(at + 13), buf.readUInt16LE(at + 11)),
    deltaToCarInFrontMs: joinMinutesAndMs(buf.readUInt8(at + 16), buf.readUInt16LE(at + 14)),
    deltaToRaceLeaderMs: joinMinutesAndMs(buf.readUInt8(at + 19), buf.readUInt16LE(at + 17)),
    lapDistanceM: buf.readFloatLE(at + 20),
    carPosition: buf.readUInt8(at + 32),
    currentLapNum: buf.readUInt8(at + 33),
    pitStatus: buf.readUInt8(at + 34),
    numPitStops: buf.readUInt8(at + 35),
    sector: buf.readUInt8(at + 36),
    currentLapInvalid: buf.readUInt8(at + 37) === 1,
    penaltiesSec: buf.readUInt8(at + 38),
    totalWarnings: buf.readUInt8(at + 39),
    numUnservedDriveThroughPens: buf.readUInt8(at + 41),
    numUnservedStopGoPens: buf.readUInt8(at + 42),
    gridPosition: buf.readUInt8(at + 43),
    driverStatus: buf.readUInt8(at + 44),
    resultStatus: buf.readUInt8(at + 45),
    speedTrapFastestKph: buf.readFloatLE(at + 52),
  };
}

const DAMAGE_STRIDE = 46;

function readCarDamage(buf: Buffer, at: number): CarDamage {
  return {
    tyreWearPct: [0, 1, 2, 3].map((i) => buf.readFloatLE(at + i * 4)),
    tyreDamagePct: [0, 1, 2, 3].map((i) => buf.readUInt8(at + 16 + i)),
    brakeDamagePct: [0, 1, 2, 3].map((i) => buf.readUInt8(at + 20 + i)),
    frontLeftWingPct: buf.readUInt8(at + 28),
    frontRightWingPct: buf.readUInt8(at + 29),
    rearWingPct: buf.readUInt8(at + 30),
    floorPct: buf.readUInt8(at + 31),
    diffuserPct: buf.readUInt8(at + 32),
    sidepodPct: buf.readUInt8(at + 33),
    drsFault: buf.readUInt8(at + 34) === 1,
    ersFault: buf.readUInt8(at + 35) === 1,
    gearboxPct: buf.readUInt8(at + 36),
    enginePct: buf.readUInt8(at + 37),
  };
}

const MARSHAL_ZONES_BYTES = 21 * 5;
const FORECAST_SAMPLE_BYTES = 8;
const MAX_FORECAST_SAMPLES = 64;

function readSession(buf: Buffer): SessionData {
  const b = HEADER_SIZE;
  const forecastCount = Math.min(buf.readUInt8(b + 126), MAX_FORECAST_SAMPLES);
  const forecastStart = b + 127;

  const forecast: WeatherForecast[] = [];
  for (let i = 0; i < forecastCount; i++) {
    const at = forecastStart + i * FORECAST_SAMPLE_BYTES;
    forecast.push({
      timeOffsetMin: buf.readUInt8(at + 1),
      weather: buf.readUInt8(at + 2),
      trackTempC: buf.readInt8(at + 3),
      airTempC: buf.readInt8(at + 5),
      rainPercentage: buf.readUInt8(at + 7),
    });
  }

  return {
    weather: buf.readUInt8(b),
    trackTempC: buf.readInt8(b + 1),
    airTempC: buf.readInt8(b + 2),
    totalLaps: buf.readUInt8(b + 3),
    trackLengthM: buf.readUInt16LE(b + 4),
    sessionType: buf.readUInt8(b + 6),
    trackId: buf.readInt8(b + 7),
    sessionTimeLeftSec: buf.readUInt16LE(b + 9),
    sessionDurationSec: buf.readUInt16LE(b + 11),
    pitSpeedLimitKph: buf.readUInt8(b + 13),
    safetyCarStatus: buf.readUInt8(b + 19 + MARSHAL_ZONES_BYTES),
    forecast,
    pitWindowIdealLap: buf.readUInt8(b + 653),
    pitWindowLatestLap: buf.readUInt8(b + 654),
    pitRejoinPosition: buf.readUInt8(b + 655),
  };
}

const PARTICIPANT_STRIDE = 57;
const NAME_BYTES = 32;

function readParticipants(buf: Buffer): Participant[] {
  const start = HEADER_SIZE + 1;
  const participants: Participant[] = [];

  for (let i = 0; i < MAX_CARS; i++) {
    const at = start + i * PARTICIPANT_STRIDE;
    const raw = buf.subarray(at + 7, at + 7 + NAME_BYTES);
    const nul = raw.indexOf(0);
    participants.push({
      aiControlled: buf.readUInt8(at) === 1,
      teamId: buf.readUInt8(at + 3),
      raceNumber: buf.readUInt8(at + 5),
      name: raw.subarray(0, nul === -1 ? NAME_BYTES : nul).toString('utf8'),
    });
  }

  return participants;
}

function readAllCars<T>(buf: Buffer, stride: number, read: (b: Buffer, at: number) => T): T[] {
  const cars: T[] = [];
  for (let i = 0; i < MAX_CARS; i++) cars.push(read(buf, HEADER_SIZE + i * stride));
  return cars;
}

/**
 * Parses one UDP datagram. Returns null for packets we do not consume, for
 * short/corrupt datagrams, and for non-2025 formats (the game can be set to
 * emit the 2023/2024 layouts, which would decode to nonsense here).
 */
export function parsePacket(buf: Buffer): ParsedPacket {
  if (buf.length < HEADER_SIZE) return null;

  const header = readHeader(buf);
  if (header.packetFormat !== 2025) return null;

  const needs = (bytes: number) => buf.length >= bytes;

  switch (header.packetId) {
    case PacketId.CarTelemetry:
      if (!needs(HEADER_SIZE + MAX_CARS * TELEMETRY_STRIDE)) return null;
      return {
        id: PacketId.CarTelemetry,
        header,
        cars: readAllCars(buf, TELEMETRY_STRIDE, readCarTelemetry),
      };

    case PacketId.CarStatus:
      if (!needs(HEADER_SIZE + MAX_CARS * STATUS_STRIDE)) return null;
      return { id: PacketId.CarStatus, header, cars: readAllCars(buf, STATUS_STRIDE, readCarStatus) };

    case PacketId.LapData:
      if (!needs(HEADER_SIZE + MAX_CARS * LAP_STRIDE)) return null;
      return { id: PacketId.LapData, header, cars: readAllCars(buf, LAP_STRIDE, readLapData) };

    case PacketId.CarDamage:
      if (!needs(HEADER_SIZE + MAX_CARS * DAMAGE_STRIDE)) return null;
      return { id: PacketId.CarDamage, header, cars: readAllCars(buf, DAMAGE_STRIDE, readCarDamage) };

    case PacketId.Session:
      if (!needs(HEADER_SIZE + 656)) return null;
      return { id: PacketId.Session, header, session: readSession(buf) };

    case PacketId.Participants:
      if (!needs(HEADER_SIZE + 1 + MAX_CARS * PARTICIPANT_STRIDE)) return null;
      return { id: PacketId.Participants, header, participants: readParticipants(buf) };

    case PacketId.Event: {
      if (!needs(HEADER_SIZE + 4)) return null;
      const code = buf.subarray(HEADER_SIZE, HEADER_SIZE + 4).toString('ascii');
      return {
        id: PacketId.Event,
        header,
        event: { code, detail: buf.subarray(HEADER_SIZE + 4) },
      };
    }

    default:
      return null;
  }
}
