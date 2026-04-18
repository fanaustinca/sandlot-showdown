import {
  Bases,
  GameState,
  HitQuality,
  MAX_INNINGS,
  PITCH_CONTACT_MS,
  PitchType,
  PlayerId,
  RUNS_TO_END_HALF,
  STRIKEOUTS_PER_HALF,
  STRIKES_PER_OUT,
  SwingOutcome,
  newHalfInning,
} from './models';

export function qualityFromOffset(offsetMs: number, pitch: PitchType): HitQuality {
  const abs = Math.abs(offsetMs);
  const base = pitch === 'flyball' ? 1.15 : pitch === 'straight' ? 0.9 : 1.0;
  const scaled = abs / base;
  if (scaled < 30) return 'home_run';
  if (scaled < 75) return 'triple';
  if (scaled < 140) return 'double';
  if (scaled < 210) return 'single';
  return 'strike';
}

export function basesForQuality(q: HitQuality): number {
  switch (q) {
    case 'home_run': return 4;
    case 'triple': return 3;
    case 'double': return 2;
    case 'single': return 1;
    default: return 0;
  }
}

export function resolveSwing(
  offsetMs: number,
  pitch: PitchType,
  bases: Bases,
): { outcome: SwingOutcome; nextBases: Bases } {
  const quality = qualityFromOffset(offsetMs, pitch);
  const advance = basesForQuality(quality);

  if (quality === 'strike') {
    return {
      outcome: { quality, basesAdvanced: 0, runsScored: 0, offsetMs },
      nextBases: bases,
    };
  }

  const runners = [bases.third, bases.second, bases.first];
  const positions = [3, 2, 1];
  let runs = 0;
  const next: Bases = { first: false, second: false, third: false };

  for (let i = 0; i < runners.length; i++) {
    if (!runners[i]) continue;
    const newPos = positions[i] + advance;
    if (newPos >= 4) runs++;
    else if (newPos === 3) next.third = true;
    else if (newPos === 2) next.second = true;
    else if (newPos === 1) next.first = true;
  }

  if (advance >= 4) runs++;
  else if (advance === 3) next.third = true;
  else if (advance === 2) next.second = true;
  else if (advance === 1) next.first = true;

  return {
    outcome: { quality, basesAdvanced: advance, runsScored: runs, offsetMs },
    nextBases: next,
  };
}

export function applySwing(state: GameState, offsetMs: number, pitch: PitchType): {
  state: GameState;
  outcome: SwingOutcome;
  halfEnded: boolean;
  atBatEnded: boolean;
} {
  if (state.gameOver) {
    return { state, outcome: { quality: 'strike', basesAdvanced: 0, runsScored: 0, offsetMs }, halfEnded: false, atBatEnded: false };
  }
  const half = { ...state.half, bases: { ...state.half.bases } };
  const { outcome, nextBases } = resolveSwing(offsetMs, pitch, half.bases);

  let atBatEnded = false;
  if (outcome.quality === 'strike') {
    half.strikes++;
    if (half.strikes >= STRIKES_PER_OUT) {
      half.strikeouts++;
      half.strikes = 0;
      atBatEnded = true;
    }
  } else {
    half.bases = nextBases;
    half.runs += outcome.runsScored;
    half.strikes = 0;
    atBatEnded = true;
  }

  const halfEnded =
    half.strikeouts >= STRIKEOUTS_PER_HALF ||
    half.runs >= RUNS_TO_END_HALF;

  const next: GameState = { ...state, half };

  if (halfEnded) {
    return { state: endHalfInning(next), outcome, halfEnded, atBatEnded: true };
  }

  return { state: next, outcome, halfEnded, atBatEnded };
}

export function endHalfInning(state: GameState): GameState {
  const batter = state.half.batter;
  const runs = state.half.runs;
  const innings = {
    p1: [...state.innings.p1],
    p2: [...state.innings.p2],
  };
  if (batter === 'p1') {
    innings.p1.push(runs);
  } else {
    innings.p2.push(runs);
  }
  const p1Score = innings.p1.reduce((a, b) => a + b, 0);
  const p2Score = innings.p2.reduce((a, b) => a + b, 0);

  let inning = state.inning;
  let top = state.top;
  let gameOver = false;
  let winner: PlayerId | 'tie' | null = null;
  let nextBatter: PlayerId;

  if (top) {
    top = false;
    nextBatter = 'p2';
  } else {
    top = true;
    inning++;
    nextBatter = 'p1';
  }

  if (inning > MAX_INNINGS) {
    gameOver = true;
    winner = p1Score === p2Score ? 'tie' : p1Score > p2Score ? 'p1' : 'p2';
  }

  return {
    ...state,
    inning,
    top,
    p1Score,
    p2Score,
    innings,
    half: newHalfInning(nextBatter),
    gameOver,
    winner,
  };
}

export function currentPitcher(state: GameState): PlayerId {
  return state.half.batter === 'p1' ? 'p2' : 'p1';
}
