export type PitchType = 'straight' | 'curl' | 'zigzag' | 'flyball';

export type HitQuality = 'home_run' | 'triple' | 'double' | 'single' | 'strike';

export type PlayerId = 'p1' | 'p2';

export type Mode = 'single' | 'multi';

export interface Bases {
  first: boolean;
  second: boolean;
  third: boolean;
}

export interface HalfInningState {
  batter: PlayerId;
  strikes: number;
  strikeouts: number;
  runs: number;
  bases: Bases;
}

export interface GameState {
  inning: number;
  top: boolean;
  p1Score: number;
  p2Score: number;
  innings: { p1: number[]; p2: number[] };
  half: HalfInningState;
  gameOver: boolean;
  winner: PlayerId | 'tie' | null;
}

export interface SwingOutcome {
  quality: HitQuality;
  basesAdvanced: number;
  runsScored: number;
  offsetMs: number;
}

export interface PitchEvent {
  type: PitchType;
  seed: number;
  serverT0: number;
}

export const MAX_INNINGS = 6;
export const STRIKEOUTS_PER_HALF = 3;
export const STRIKES_PER_OUT = 3;
export const RUNS_TO_END_HALF = 5;
export const SWING_COOLDOWN_MS = 500;

export const PITCH_CONTACT_MS: Record<PitchType, number> = {
  straight: 1200,
  curl: 1500,
  zigzag: 1500,
  flyball: 1800,
};

export const PITCH_FLIGHT_MS: Record<PitchType, number> = {
  straight: 1400,
  curl: 1700,
  zigzag: 1700,
  flyball: 2100,
};

export function newBases(): Bases {
  return { first: false, second: false, third: false };
}

export function newHalfInning(batter: PlayerId): HalfInningState {
  return { batter, strikes: 0, strikeouts: 0, runs: 0, bases: newBases() };
}

export function newGameState(): GameState {
  return {
    inning: 1,
    top: true,
    p1Score: 0,
    p2Score: 0,
    innings: { p1: [], p2: [] },
    half: newHalfInning('p1'),
    gameOver: false,
    winner: null,
  };
}
