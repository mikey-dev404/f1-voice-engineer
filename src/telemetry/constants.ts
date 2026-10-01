// Lookup tables from the F1 25 UDP specification appendices.

export const PACKET_FORMAT_F1_25 = 2025;

export enum PacketId {
  Motion = 0,
  Session = 1,
  LapData = 2,
  Event = 3,
  Participants = 4,
  CarSetups = 5,
  CarTelemetry = 6,
  CarStatus = 7,
  FinalClassification = 8,
  LobbyInfo = 9,
  CarDamage = 10,
  SessionHistory = 11,
  TyreSets = 12,
  MotionEx = 13,
  TimeTrial = 14,
  LapPositions = 15,
}

export const HEADER_SIZE = 29;

/** All four-element wheel arrays in the spec are ordered rear-left, rear-right, front-left, front-right. */
export const WHEEL_ORDER = ['RL', 'RR', 'FL', 'FR'] as const;
export type WheelLabel = (typeof WHEEL_ORDER)[number];

export const WEATHER: Record<number, string> = {
  0: 'clear',
  1: 'light cloud',
  2: 'overcast',
  3: 'light rain',
  4: 'heavy rain',
  5: 'storm',
};

export const SESSION_TYPE: Record<number, string> = {
  0: 'unknown',
  1: 'Practice 1',
  2: 'Practice 2',
  3: 'Practice 3',
  4: 'Short Practice',
  5: 'Qualifying 1',
  6: 'Qualifying 2',
  7: 'Qualifying 3',
  8: 'Short Qualifying',
  9: 'One-Shot Qualifying',
  10: 'Sprint Shootout 1',
  11: 'Sprint Shootout 2',
  12: 'Sprint Shootout 3',
  13: 'Short Sprint Shootout',
  14: 'One-Shot Sprint Shootout',
  15: 'Race',
  16: 'Race 2',
  17: 'Race 3',
  18: 'Time Trial',
};

export const TRACKS: Record<number, string> = {
  0: 'Melbourne',
  1: 'Paul Ricard',
  2: 'Shanghai',
  3: 'Sakhir (Bahrain)',
  4: 'Catalunya',
  5: 'Monaco',
  6: 'Montreal',
  7: 'Silverstone',
  8: 'Hockenheim',
  9: 'Hungaroring',
  10: 'Spa',
  11: 'Monza',
  12: 'Singapore',
  13: 'Suzuka',
  14: 'Abu Dhabi',
  15: 'Texas (COTA)',
  16: 'Brazil (Interlagos)',
  17: 'Austria',
  18: 'Sochi',
  19: 'Mexico',
  20: 'Baku',
  21: 'Sakhir Short',
  22: 'Silverstone Short',
  23: 'Texas Short',
  24: 'Suzuka Short',
  25: 'Hanoi',
  26: 'Zandvoort',
  27: 'Imola',
  28: 'Portimao',
  29: 'Jeddah',
  30: 'Miami',
  31: 'Las Vegas',
  32: 'Losail (Qatar)',
  39: 'Silverstone Reverse',
  40: 'Austria Reverse',
  41: 'Zandvoort Reverse',
};

/** Actual compound ids. F1 Modern uses the C0-C6 range; 7/8 are the wet compounds. */
export const ACTUAL_COMPOUND: Record<number, string> = {
  7: 'intermediate',
  8: 'wet',
  9: 'dry (classic)',
  10: 'wet (classic)',
  11: 'F2 super soft',
  12: 'F2 soft',
  13: 'F2 medium',
  14: 'F2 hard',
  15: 'F2 wet',
  16: 'C5',
  17: 'C4',
  18: 'C3',
  19: 'C2',
  20: 'C1',
  21: 'C0',
  22: 'C6',
};

/** What the driver actually sees on the HUD - soft/medium/hard rather than the C-number. */
export const VISUAL_COMPOUND: Record<number, string> = {
  7: 'intermediate',
  8: 'wet',
  16: 'soft',
  17: 'medium',
  18: 'hard',
  19: 'F2 super soft',
  20: 'F2 soft',
  21: 'F2 medium',
  22: 'F2 hard',
  15: 'F2 wet',
};

export const ERS_MODE: Record<number, string> = {
  0: 'none',
  1: 'medium',
  2: 'hotlap',
  3: 'overtake',
};

export const FUEL_MIX: Record<number, string> = {
  0: 'lean',
  1: 'standard',
  2: 'rich',
  3: 'max',
};

export const SAFETY_CAR_STATUS: Record<number, string> = {
  0: 'none',
  1: 'safety car',
  2: 'virtual safety car',
  3: 'formation lap',
};

export const FIA_FLAG: Record<number, string> = {
  [-1]: 'unknown',
  0: 'none',
  1: 'green',
  2: 'blue',
  3: 'yellow',
};

export const DRIVER_STATUS: Record<number, string> = {
  0: 'in garage',
  1: 'flying lap',
  2: 'in lap',
  3: 'out lap',
  4: 'on track',
};

export const PIT_STATUS: Record<number, string> = {
  0: 'on track',
  1: 'pitting',
  2: 'in pit box',
};

/** ERS store capacity per lap in joules, used to express the store as a percentage. */
export const ERS_MAX_JOULES = 4_000_000;
