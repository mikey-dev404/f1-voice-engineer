// Turns a snapshot into the compact text block handed to the model on every
// radio call. Kept terse on purpose: this is sent once per question and the
// model has to read it fast.

import {
  DRIVER_STATUS,
  ERS_MAX_JOULES,
  ERS_MODE,
  FIA_FLAG,
  FUEL_MIX,
  PIT_STATUS,
  SAFETY_CAR_STATUS,
  SESSION_TYPE,
  TRACKS,
  WEATHER,
} from './constants';
import { compoundName, formatLapTime, type TelemetrySnapshot } from './snapshot';

/** Spec wheel arrays are RL, RR, FL, FR. Drivers think FL, FR, RL, RR. */
const DRIVER_WHEEL_VIEW: { label: string; idx: number }[] = [
  { label: 'FL', idx: 2 },
  { label: 'FR', idx: 3 },
  { label: 'RL', idx: 0 },
  { label: 'RR', idx: 1 },
];

function wheelList(values: number[] | undefined, unit = '', digits = 0): string {
  if (!values || values.length < 4) return 'n/a';
  return DRIVER_WHEEL_VIEW.map(
    ({ label, idx }) => `${label} ${values[idx].toFixed(digits)}${unit}`,
  ).join(', ');
}

function gap(sec: number | null): string {
  if (sec === null || !isFinite(sec)) return 'unknown';
  if (sec <= 0) return 'level';
  return `${sec.toFixed(1)}s`;
}

function clockFromSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function buildEngineerBrief(snap: TelemetrySnapshot): string {
  if (!snap.connected) {
    return 'LIVE TELEMETRY: not connected. No car data is available right now.';
  }

  const lines: string[] = [];
  const { session, player, ahead, behind, leader } = snap;
  const { lap, status, telemetry, damage } = player;

  lines.push(`LIVE TELEMETRY (updated ${new Date().toLocaleTimeString()}):`);

  if (session) {
    const type = SESSION_TYPE[session.sessionType] ?? 'session';
    const track = TRACKS[session.trackId] ?? `track ${session.trackId}`;
    lines.push(
      `Session: ${type} at ${track}. Weather ${WEATHER[session.weather] ?? '?'}, ` +
        `track ${session.trackTempC}C, air ${session.airTempC}C.`,
    );

    if (session.sessionTimeLeftSec > 0) {
      lines.push(`Time left: ${clockFromSeconds(session.sessionTimeLeftSec)}.`);
    }
    if (session.safetyCarStatus !== 0) {
      lines.push(`SAFETY CAR: ${SAFETY_CAR_STATUS[session.safetyCarStatus]}.`);
    }

    // Only the next meaningful rain change is worth the tokens.
    const rain = session.forecast.find((f) => f.timeOffsetMin > 0 && f.rainPercentage >= 20);
    if (rain) {
      lines.push(
        `Forecast: ${rain.rainPercentage}% rain in ${rain.timeOffsetMin} min ` +
          `(${WEATHER[rain.weather] ?? '?'}).`,
      );
    }
  }

  if (lap) {
    const totalLaps = session?.totalLaps ?? 0;
    const lapText = totalLaps > 0 ? `${lap.currentLapNum} of ${totalLaps}` : `${lap.currentLapNum}`;
    const pitNote = lap.pitStatus !== 0 ? `, ${PIT_STATUS[lap.pitStatus]}` : '';
    lines.push(
      `Position: P${lap.carPosition}. Lap ${lapText}. Sector ${lap.sector + 1}. ` +
        `Status ${DRIVER_STATUS[lap.driverStatus] ?? '?'}${pitNote}.`,
    );
    lines.push(
      `Last lap ${formatLapTime(lap.lastLapTimeMs)}, current ${formatLapTime(lap.currentLapTimeMs)}` +
        `${lap.currentLapInvalid ? ' (INVALID)' : ''}. Pit stops so far: ${lap.numPitStops}.`,
    );

    const penalties: string[] = [];
    if (lap.penaltiesSec > 0) penalties.push(`${lap.penaltiesSec}s time penalty`);
    if (lap.numUnservedDriveThroughPens > 0) {
      penalties.push(`${lap.numUnservedDriveThroughPens} drive-through unserved`);
    }
    if (lap.numUnservedStopGoPens > 0) {
      penalties.push(`${lap.numUnservedStopGoPens} stop-go unserved`);
    }
    if (lap.totalWarnings > 0) penalties.push(`${lap.totalWarnings} warnings`);
    if (penalties.length) lines.push(`Penalties: ${penalties.join(', ')}.`);
  }

  if (status) {
    const compound = compoundName(status) ?? 'unknown';
    lines.push(`Tyres: ${compound}, ${status.tyreAgeLaps} laps old.`);

    if (damage) {
      lines.push(`Tyre wear: ${wheelList(damage.tyreWearPct, '%', 1)}.`);
    }
    if (telemetry) {
      lines.push(`Tyre surface temps: ${wheelList(telemetry.tyreSurfaceTempsC, 'C')}.`);
      lines.push(`Brake temps: ${wheelList(telemetry.brakeTempsC, 'C')}.`);
    }

    lines.push(
      `Fuel: ${status.fuelInTank.toFixed(1)}kg, ` +
        `${status.fuelRemainingLaps >= 0 ? '+' : ''}${status.fuelRemainingLaps.toFixed(2)} laps ` +
        `versus race distance. Mix ${FUEL_MIX[status.fuelMix] ?? '?'}.`,
    );

    const ersPct = Math.round((status.ersStoreEnergy / ERS_MAX_JOULES) * 100);
    lines.push(
      `ERS: ${ersPct}% stored, mode ${ERS_MODE[status.ersDeployMode] ?? '?'}, ` +
        `${(status.ersDeployedThisLap / 1_000_000).toFixed(2)}MJ deployed this lap.`,
    );

    const drs = status.drsAllowed
      ? 'available now'
      : status.drsActivationDistanceM > 0
        ? `in ${status.drsActivationDistanceM}m`
        : 'not available';
    lines.push(`DRS: ${drs}. Brake bias ${status.frontBrakeBias}% front.`);

    if (status.fiaFlag > 0) lines.push(`Flag shown to us: ${FIA_FLAG[status.fiaFlag]}.`);
  }

  if (telemetry) {
    lines.push(
      `Car now: ${telemetry.speedKph} kph, gear ${telemetry.gear}, ` +
        `${telemetry.engineRpm} rpm, DRS ${telemetry.drs ? 'open' : 'closed'}.`,
    );
  }

  if (damage) {
    const parts: string[] = [];
    const note = (label: string, pct: number) => {
      if (pct > 0) parts.push(`${label} ${pct}%`);
    };
    note('front-left wing', damage.frontLeftWingPct);
    note('front-right wing', damage.frontRightWingPct);
    note('rear wing', damage.rearWingPct);
    note('floor', damage.floorPct);
    note('diffuser', damage.diffuserPct);
    note('sidepod', damage.sidepodPct);
    note('gearbox', damage.gearboxPct);
    note('engine', damage.enginePct);
    if (damage.drsFault) parts.push('DRS FAULT');
    if (damage.ersFault) parts.push('ERS FAULT');
    lines.push(parts.length ? `Damage: ${parts.join(', ')}.` : 'Damage: none.');
  }

  if (ahead) {
    lines.push(
      `Car ahead: P${ahead.position} ${ahead.name}, ${gap(ahead.gapSec)} up the road, ` +
        `on ${ahead.tyreCompound ?? 'unknown'} (${ahead.tyreAgeLaps ?? '?'} laps), ` +
        `${ahead.pitStops ?? 0} stops${ahead.inPits ? ', IN PITS' : ''}.`,
    );
  }
  if (behind) {
    lines.push(
      `Car behind: P${behind.position} ${behind.name}, ${gap(behind.gapSec)} back, ` +
        `on ${behind.tyreCompound ?? 'unknown'} (${behind.tyreAgeLaps ?? '?'} laps), ` +
        `${behind.pitStops ?? 0} stops${behind.inPits ? ', IN PITS' : ''}.`,
    );
  }
  if (leader && lap && lap.carPosition > 2) {
    lines.push(`Leader: ${leader.name}, ${gap(leader.gapSec)} ahead of us.`);
  }

  if (snap.recentLaps.length) {
    const laps = snap.recentLaps
      .map((l) => `L${l.lap} ${formatLapTime(l.timeMs)}`)
      .join(', ');
    lines.push(`Recent laps: ${laps}.`);
  }

  if (session && session.pitWindowIdealLap > 0) {
    lines.push(
      `Game pit strategy hint: ideal lap ${session.pitWindowIdealLap}, ` +
        `latest lap ${session.pitWindowLatestLap}, would rejoin P${session.pitRejoinPosition}.`,
    );
  }

  if (snap.recentEvents.length) {
    lines.push(`Recent events: ${snap.recentEvents.map((e) => e.text).join('; ')}.`);
  }

  return lines.join('\n');
}

export const ENGINEER_SYSTEM_PROMPT = `You are a Formula 1 race engineer talking to your driver over team radio during a live session of the game F1 25. Your driver is racing right now and can only listen.

HOW TO SPEAK
- Be extremely brief. One or two short sentences. This is a radio call, not a briefing.
- Speak the way a real F1 engineer does: calm, level, matter of fact. No hype, no filler, no "great question".
- Never greet the driver or introduce yourself mid-session.
- Give the answer first. Add a reason only if it fits in a few words.
- Use plain spoken numbers, for example "two point four seconds" or "sixty two percent".
- Never read out a list of every telemetry value. Pick the one or two numbers that matter.
- If the driver asks something open like "how's it looking", give the single most important thing right now.

USING THE DATA
- Before each of the driver's messages you receive a LIVE TELEMETRY block. That is the current state of the car, taken at that moment.
- Always trust that block over anything said earlier in the conversation. The car changes constantly.
- Never invent a number. If something is not in the block, say you do not have it.
- If the block says telemetry is not connected, tell the driver you have lost telemetry and answer from memory of the conversation only.
- Tyre wear percentages count up from zero, so a higher number means a more worn tyre.
- Fuel "laps versus race distance" is a delta: positive means fuel to spare, negative means the driver must save.

JUDGEMENT
- You may give strategy opinions (pit now, stay out, push, save fuel, manage the rears) when asked, based on the data.
- Warn about anything critical even if not asked about it directly, but only inside the answer you were already giving.
- If the driver is clearly mid-corner and asks something complex, still answer short.`;
