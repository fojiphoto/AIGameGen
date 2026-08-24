/**
 * Ducks: what they are, and how they fly.
 *
 * Both halves are data. A duck type is a row in a table — colours, size, speed, score, how often
 * it appears — and a flight pattern is a pure function of elapsed time that returns a velocity.
 * Neither knows about a canvas, which is what lets the fairness suite fly every combination of
 * the two thousands of times in Node and prove each one is actually hittable.
 *
 * The patterns are written as *velocity* rather than as position because a duck also has to
 * turn, dive and flee, and steering something that is being teleported along a path looks wrong
 * the moment anything interrupts it.
 */

import { VIEW_W, SKY_TOP, SKY_BOTTOM, speedScale } from './config.js';

export type DuckKind = 'green' | 'blue' | 'red' | 'golden' | 'giant' | 'swift' | 'armored';

export type PatternName =
  | 'straight' | 'wave' | 'zigzag' | 'dive' | 'climb'
  | 'fakeTurn' | 'escapeBurst' | 'swoop' | 'drift';

export interface DuckType {
  kind: DuckKind;
  name: string;
  /** Body, wing, accent. */
  colors: [string, string, string];
  /** Sprite size in pixels; the hitbox is derived from it. */
  size: number;
  /** Base speed in px/s before difficulty scaling. */
  speed: number;
  score: number;
  /** Relative chance of being chosen, before difficulty weighting. */
  weight: number;
  /** Shots needed. Only the armored duck takes more than one. */
  hits: number;
  /** Patterns this type is allowed to use. */
  patterns: PatternName[];
  /** Shown on the score pop-up when it is worth calling out. */
  rare: boolean;
  /** Extra difficulty before this type appears at all. */
  minDifficulty: number;
}

/**
 * The roster.
 *
 * Seven types, each distinguishable at a glance by colour *and* silhouette size, because a
 * player deciding whether to spend a shell has about a third of a second to tell them apart.
 * Score tracks difficulty honestly: the golden duck is worth ten times a green one because it
 * is genuinely about ten times harder to catch.
 */
export const DUCK_TYPES: DuckType[] = [
  {
    kind: 'green', name: 'Meadow Duck',
    colors: ['#5fa845', '#3d7a2c', '#ffd44a'],
    size: 46, speed: 132, score: 100, weight: 34, hits: 1, rare: false, minDifficulty: 0,
    patterns: ['straight', 'wave', 'drift'],
  },
  {
    kind: 'blue', name: 'River Duck',
    colors: ['#4a86d8', '#2c5a9c', '#ffd44a'],
    size: 44, speed: 158, score: 150, weight: 26, hits: 1, rare: false, minDifficulty: 0.06,
    patterns: ['wave', 'zigzag', 'swoop'],
  },
  {
    kind: 'red', name: 'Crested Duck',
    colors: ['#d8574a', '#9c332c', '#ffe08a'],
    size: 42, speed: 182, score: 200, weight: 18, hits: 1, rare: false, minDifficulty: 0.2,
    patterns: ['zigzag', 'dive', 'fakeTurn'],
  },
  {
    kind: 'giant', name: 'Broadwing',
    colors: ['#8a6fc4', '#5a4590', '#ffd44a'],
    size: 66, speed: 104, score: 250, weight: 9, hits: 1, rare: false, minDifficulty: 0.28,
    patterns: ['straight', 'drift', 'wave'],
  },
  {
    kind: 'swift', name: 'Swift',
    colors: ['#3ec7c0', '#1f8b86', '#fff2b0'],
    size: 36, speed: 246, score: 400, weight: 8, hits: 1, rare: true, minDifficulty: 0.4,
    patterns: ['straight', 'escapeBurst', 'climb'],
  },
  {
    kind: 'armored', name: 'Ironback',
    colors: ['#8d97a8', '#5a6270', '#ffb04a'],
    size: 54, speed: 122, score: 500, weight: 6, hits: 2, rare: true, minDifficulty: 0.5,
    patterns: ['straight', 'wave', 'drift'],
  },
  {
    kind: 'golden', name: 'Gilded Duck',
    colors: ['#ffcf4a', '#d99a1f', '#fff6d0'],
    size: 40, speed: 230, score: 1000, weight: 3, hits: 1, rare: true, minDifficulty: 0.15,
    patterns: ['escapeBurst', 'swoop', 'fakeTurn'],
  },
];

export const duckType = (kind: DuckKind): DuckType =>
  DUCK_TYPES.find((d) => d.kind === kind) ?? DUCK_TYPES[0];

/**
 * Pick a duck type for the current difficulty.
 *
 * Weights shift as difficulty rises — the green duck fades out, the rare ones fade in — but
 * nothing is ever removed entirely, so a late round still occasionally throws an easy target and
 * the player gets a breath.
 *
 * @param random 0..1, supplied by the caller so spawning stays reproducible in tests.
 */
export function pickDuckType(difficulty: number, random: number): DuckType {
  const available = DUCK_TYPES.filter((d) => difficulty >= d.minDifficulty);
  const pool = available.length ? available : [DUCK_TYPES[0]];
  const weights = pool.map((d) => {
    // Common ducks lose weight with difficulty; rare ones gain it. The exponent is gentle so
    // the mix drifts rather than flipping.
    const bias = d.rare ? 1 + difficulty * 1.6 : 1 - difficulty * 0.45;
    return Math.max(0.4, d.weight * bias);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random * total;
  for (let i = 0; i < pool.length; i++) {
    if (r < weights[i]) return pool[i];
    r -= weights[i];
  }
  return pool[pool.length - 1];
}

// ── flight ──────────────────────────────────────────────────────────────────

export interface DuckState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds since the duck entered. */
  t: number;
  /** 1 flying right, -1 flying left. */
  dir: 1 | -1;
  pattern: PatternName;
  type: DuckType;
  /** Speed after difficulty scaling. */
  speed: number;
  /** Hits taken. */
  damage: number;
  phase: 'flying' | 'fleeing' | 'hit' | 'falling' | 'gone' | 'escaped';
  /** Seeded per duck, so a pattern's wobble is stable rather than jittering every frame. */
  seed: number;
  /** Set when the escape timer fires and the duck climbs away. */
  fleeing: boolean;
}

/**
 * Where a duck enters.
 *
 * Always from a side, always inside the shootable band, and never within a body-width of the
 * top or bottom of it — a duck that clips the HUD on entry is a duck the player cannot see
 * coming.
 */
export function spawnDuck(
  type: DuckType, pattern: PatternName, difficulty: number, random: () => number
): DuckState {
  const dir: 1 | -1 = random() < 0.5 ? 1 : -1;
  const margin = type.size;
  const y = SKY_TOP + margin + random() * (SKY_BOTTOM - SKY_TOP - margin * 2);
  const speed = type.speed * speedScale(difficulty);
  return {
    x: dir > 0 ? -type.size : VIEW_W + type.size,
    y,
    vx: dir * speed,
    vy: 0,
    t: 0,
    dir,
    pattern,
    type,
    speed,
    damage: 0,
    phase: 'flying',
    seed: random() * 1000,
    fleeing: false,
  };
}

/**
 * One step of flight.
 *
 * Each pattern writes `vx`/`vy` and the integrator moves the duck, so a duck that is knocked off
 * course by fleeing or by the edge of the sky still behaves like a bird rather than snapping
 * back onto a path.
 */
export function stepDuck(duck: DuckState, dt: number): void {
  if (duck.phase === 'gone' || duck.phase === 'escaped') return;

  duck.t += dt;

  if (duck.phase === 'falling') {
    // Falling is not a pattern; it is gravity plus a little sideways drift.
    duck.vy += 900 * dt;
    duck.vx *= 1 - Math.min(1, 2.2 * dt);
    duck.x += duck.vx * dt;
    duck.y += duck.vy * dt;
    return;
  }

  if (duck.phase === 'hit') {
    // A beat of stunned hang before the fall starts, which is what makes the hit read.
    duck.vx *= 1 - Math.min(1, 6 * dt);
    duck.vy = Math.min(duck.vy + 240 * dt, 90);
    duck.x += duck.vx * dt;
    duck.y += duck.vy * dt;
    return;
  }

  if (duck.fleeing) {
    // Fleeing overrides the pattern entirely: straight up and away, fast, so the player gets a
    // clear last chance rather than a duck that vanishes mid-wiggle.
    duck.vx = duck.dir * duck.speed * 1.5;
    duck.vy = -duck.speed * 1.15;
    duck.x += duck.vx * dt;
    duck.y += duck.vy * dt;
    return;
  }

  applyPattern(duck, dt);

  duck.x += duck.vx * dt;
  duck.y += duck.vy * dt;

  /**
   * Keep the duck inside the shootable band.
   *
   * Reflecting rather than clamping: a duck that slides along an invisible ceiling looks broken,
   * one that bounces off it looks like it changed its mind. The bounce also stops a `climb` or
   * `dive` pattern from parking a duck permanently out of reach.
   */
  const top = SKY_TOP + duck.type.size * 0.4;
  const bottom = SKY_BOTTOM - duck.type.size * 0.4;
  if (duck.y < top) { duck.y = top; duck.vy = Math.abs(duck.vy) * 0.7 + 20; }
  if (duck.y > bottom) { duck.y = bottom; duck.vy = -Math.abs(duck.vy) * 0.7 - 20; }
}

function applyPattern(duck: DuckState, dt: number): void {
  const s = duck.speed;
  const t = duck.t + duck.seed;
  const d = duck.dir;

  switch (duck.pattern) {
    case 'straight':
      duck.vx = d * s;
      duck.vy = Math.sin(t * 1.4) * s * 0.08;
      break;

    case 'wave':
      duck.vx = d * s * 0.92;
      duck.vy = Math.cos(t * 2.1) * s * 0.55;
      break;

    case 'drift':
      // Slow, lazy, and the easiest thing in the game to lead — the pattern that teaches aiming.
      duck.vx = d * s * 0.8;
      duck.vy = Math.sin(t * 0.9) * s * 0.3;
      break;

    case 'zigzag': {
      // Hard direction changes on a fixed beat, so it is unpredictable but never unfair: the
      // rhythm is learnable even though the moment is not.
      const beat = Math.floor(t * 1.9);
      const sign = beat % 2 === 0 ? 1 : -1;
      duck.vx = d * s * 0.88;
      duck.vy = sign * s * 0.72;
      break;
    }

    case 'dive': {
      // Cruises, then commits to a dive, then pulls out.
      const cycle = (t * 0.55) % 2;
      if (cycle < 1.15) { duck.vx = d * s * 0.95; duck.vy = Math.sin(t * 1.6) * s * 0.15; }
      else { duck.vx = d * s * 0.7; duck.vy = s * 1.05; }
      break;
    }

    case 'climb': {
      const cycle = (t * 0.6) % 2;
      if (cycle < 1.2) { duck.vx = d * s * 0.9; duck.vy = -s * 0.75; }
      else { duck.vx = d * s * 1.05; duck.vy = s * 0.25; }
      break;
    }

    case 'fakeTurn': {
      /**
       * The pattern with the most character: it commits to a direction, then reverses.
       *
       * The reversal is telegraphed by a slow-down first — without that it reads as the duck
       * teleporting, and a player who was leading the shot feels cheated rather than outplayed.
       *
       * The cycle runs off `duck.t`, deliberately *not* the seeded time every other pattern
       * uses. The seed exists to stop a flock wobbling in unison, but this is the one pattern
       * where phase decides *direction* — and a duck that spawns at the left edge already half a
       * cycle in flies straight back out of the screen before the player ever sees it. The
       * fairness sweep caught exactly that, on two different duck types.
       */
      const cycle = (duck.t * 0.42) % 2;
      const turning = cycle > 0.78 && cycle < 1.0;
      if (turning) { duck.vx *= 1 - Math.min(1, 5 * dt); duck.vy = Math.sin(t * 6) * s * 0.2; }
      else {
        const facing = cycle < 1 ? d : -d as 1 | -1;
        duck.vx = facing * s * 1.05;
        duck.vy = Math.sin(t * 2.2) * s * 0.3;
      }
      break;
    }

    case 'escapeBurst': {
      // Ambles in, then bolts. The burst is late enough that the player has time to react, and
      // fast enough that hesitating costs the shot.
      const burst = duck.t > 1.5;
      duck.vx = d * s * (burst ? 1.7 : 0.72);
      duck.vy = Math.sin(t * 2.6) * s * (burst ? 0.2 : 0.4);
      break;
    }

    case 'swoop': {
      // A long arc down and back up, which crosses more of the screen than anything else and is
      // the most satisfying thing in the game to lead.
      duck.vx = d * s;
      duck.vy = Math.sin(t * 1.05) * s * 0.9;
      break;
    }
  }
}

/** True once the duck is far enough outside the view that it can be recycled. */
export function isOffScreen(duck: DuckState): boolean {
  const pad = duck.type.size * 2.5;
  return duck.x < -pad || duck.x > VIEW_W + pad || duck.y < SKY_TOP - pad * 2;
}

/**
 * The duck's hitbox, as a circle.
 *
 * A circle rather than a rectangle because a duck is drawn wider than it is tall and a
 * rectangle's corners are exactly where a player *thinks* they missed. The radius is the mean of
 * the two, which is generous horizontally and slightly forgiving vertically — the direction
 * players actually mis-aim.
 */
export function duckHitRadius(duck: DuckState, pad: number): number {
  return duck.type.size * 0.42 + pad;
}
