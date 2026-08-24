/**
 * Rounds, waves, and the shape of the difficulty curve.
 *
 * A round is a fixed number of ducks released in waves of one to three. Everything about how
 * hard it is comes from one number — `difficultyFor(round)` — which rises smoothly and
 * saturates. That means there is exactly one place to make the game harder or easier, and the
 * fairness suite can sweep it from 0 to 1 and check every duck stays hittable the whole way.
 *
 * Generation is seeded and deterministic. A round is a pure function of its number and a seed,
 * which makes a bad round reproducible instead of a story about something that happened once.
 */

import {
  WAVE_MIN, WAVE_MAX, ROUND_DUCKS_BASE, ROUND_DUCKS_STEP, ROUND_DUCKS_MAX,
  ROUNDS_PER_ENVIRONMENT, difficultyFor, escapeSeconds,
} from './config.js';
import { DuckType, PatternName, pickDuckType } from './ducks.js';

export interface SpawnPlan {
  type: DuckType;
  pattern: PatternName;
  /** Seconds after the wave begins. Small stagger so a pair does not overlap exactly. */
  delay: number;
}

export interface Wave {
  ducks: SpawnPlan[];
}

export interface RoundPlan {
  round: number;
  difficulty: number;
  /** Total ducks released this round. */
  duckCount: number;
  waves: Wave[];
  /** Seconds a duck stays before it flees. */
  escapeAfter: number;
  environment: number;
}

/** Deterministic RNG, so a seed replays a round exactly. */
export function makeRandom(seed: number): () => number {
  let s = (seed | 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export const ducksInRound = (round: number): number =>
  Math.min(ROUND_DUCKS_MAX, ROUND_DUCKS_BASE + (round - 1) * ROUND_DUCKS_STEP);

export const environmentFor = (round: number): number =>
  Math.floor((round - 1) / ROUNDS_PER_ENVIRONMENT) % 5;

/**
 * Wave size for a round.
 *
 * Grows with difficulty but is capped at three: past that the screen stops being readable and
 * the game becomes a lottery rather than a test of aim. A wave is also never larger than the
 * shells available, so "hit everything in the wave" is always physically possible.
 */
export function waveSize(difficulty: number, remaining: number, random: () => number): number {
  const ceiling = Math.min(WAVE_MAX, remaining);
  const bias = WAVE_MIN + Math.floor(difficulty * (WAVE_MAX - WAVE_MIN) + random() * 0.9);
  return Math.max(WAVE_MIN, Math.min(ceiling, bias));
}

/**
 * Build a whole round.
 *
 * Patterns are chosen from what the duck type allows, and gated by difficulty so early rounds
 * see straight and wave flight before anything reverses direction. The first round is special-
 * cased to the gentlest of everything — a player's first thirty seconds decide whether they
 * play a second time.
 */
export function planRound(round: number, seed: number): RoundPlan {
  const random = makeRandom(seed + round * 7919);
  const difficulty = difficultyFor(round);
  const duckCount = ducksInRound(round);

  const waves: Wave[] = [];
  let remaining = duckCount;

  while (remaining > 0) {
    const size = round === 1 ? 1 : waveSize(difficulty, remaining, random);
    const ducks: SpawnPlan[] = [];
    for (let i = 0; i < size; i++) {
      const type = round === 1
        ? pickDuckType(0, random() * 0.5)          // first round: the gentle end of the roster
        : pickDuckType(difficulty, random());
      const allowed = allowedPatterns(type.patterns, difficulty, round);
      const pattern = allowed[Math.floor(random() * allowed.length)] ?? type.patterns[0];
      ducks.push({ type, pattern, delay: i * (0.28 + random() * 0.3) });
    }
    waves.push({ ducks });
    remaining -= size;
  }

  return {
    round,
    difficulty,
    duckCount,
    waves,
    escapeAfter: escapeSeconds(difficulty),
    environment: environmentFor(round),
  };
}

/**
 * Which patterns are unlocked yet.
 *
 * The tricky ones are held back so the player meets them one at a time. A duck type that only
 * knows hard patterns still gets its easiest one until then, so the gate can never leave a type
 * with nothing to fly.
 */
const PATTERN_GATES: Record<PatternName, number> = {
  straight: 0, wave: 0, drift: 0,
  swoop: 0.12,
  zigzag: 0.22,
  climb: 0.3,
  dive: 0.38,
  escapeBurst: 0.46,
  fakeTurn: 0.56,
};

export function allowedPatterns(
  patterns: PatternName[], difficulty: number, round: number
): PatternName[] {
  /**
   * When nothing this type knows is unlocked yet, fall back to its *easiest* pattern.
   *
   * Not the first one in its list, which is what the first version did — and the Gilded Duck's
   * list happens to start with `escapeBurst`, so the rarest, fastest duck in the game was
   * introduced with its hardest flight path on round two. The order of a data table should never
   * decide difficulty.
   */
  const easiest = [...patterns].sort((a, b) => PATTERN_GATES[a] - PATTERN_GATES[b])[0];

  if (round === 1) {
    const gentle = patterns.filter((p) => PATTERN_GATES[p] === 0);
    return gentle.length ? gentle : [easiest];
  }
  const open = patterns.filter((p) => difficulty >= PATTERN_GATES[p]);
  return open.length ? open : [easiest];
}

/** Rounds are grouped into environments; this is the label the round card shows. */
export const ENVIRONMENT_NAMES = [
  'Sunny Meadow',
  'Forest Lake',
  'Autumn Woods',
  'Sunset Marsh',
  'Snowy Valley',
];

export const ENVIRONMENT_BLURBS = [
  'Long grass and a wide blue sky.',
  'Still water, and something moving in the reeds.',
  'Low sun through orange leaves.',
  'The last light over the water.',
  'Cold air, and wings you hear before you see.',
];
