/**
 * tap_to_fly — level builder + validator.
 *
 * ONE constraint dominates this genre: consecutive gaps must be reachable from each
 * other. Given a flap impulse, gravity, a terminal fall speed and the time between two
 * pipes, there is a hard band of vertical positions the player can actually get to. Place
 * a gap outside that band and the level is unwinnable no matter how well it is played —
 * the classic unfair bug in every game of this shape.
 *
 * The builder only ever samples inside that band, so it is correct by construction, and
 * the validator re-derives the band independently as a proof.
 */

import { makeRng, subSeed } from '../prng.mjs';
import { applyCurve } from '../curve.mjs';
import { VIEW_WIDTH, VIEW_HEIGHT, PLAYER_X, REACTION_MIN_SECONDS } from '../physics.mjs';

/** Room the player needs above and below the gap edges to steer rather than scrape. */
const STEER_MARGIN = 22;

/**
 * Vertical distance the player travels on a single flap — flapImpulse² / 2·gravity.
 *
 * This matters more than it looks. Holding a steady altitude in this genre is impossible:
 * the only control is an upward kick, so the player permanently oscillates by this amount
 * just to stay level. A gap must therefore fit the body PLUS a full bounce, not merely the
 * body plus a nominal margin — otherwise the level is unwinnable in a way that looks like
 * bad play. Found by the runtime playtest bot dying at pipe 0 on levels 15 and 20.
 */
export function flapBounce(config) {
  const { flapImpulse, gravity } = config.player;
  return (flapImpulse * flapImpulse) / (2 * gravity);
}

/** The minimum usable opening for this config to be flyable at all. */
export function requiredOpening(config) {
  return bodyHeight(config) + flapBounce(config) + STEER_MARGIN;
}
/** Flapping cannot be frame-perfect, so only this fraction of the theoretical climb counts. */
const CLIMB_EFFICIENCY = 0.6;
/** Diving is easier than climbing, but leave headroom for reaction time. */
const DESCENT_EFFICIENCY = 0.75;
const RELIEF_FACTOR = 0.85;

const lerp = (a, b, t) => a + (b - a) * t;

/** Vertical travel the player can achieve upward / downward in `t` seconds. */
export function reach(config, t) {
  const { flapImpulse, gravity, terminalVelocity } = config.player;
  const climb = flapImpulse * t * CLIMB_EFFICIENCY;
  const freeFall = 0.5 * gravity * t * t;
  const capped = terminalVelocity * t;
  return { climb, descent: Math.min(freeFall, capped) * DESCENT_EFFICIENCY };
}

export function levelParams(level, config) {
  const d = config.difficulty;
  const p = config.progression;
  const total = p.levels;
  const t = total > 1 ? (level - 1) / (total - 1) : 0;
  let eased = applyCurve(t, d.curve);
  const isRelief = p.reliefLevels.includes(level);
  if (isRelief) eased *= RELIEF_FACTOR;

  const speed = lerp(d.startSpeed, d.maxSpeed, eased);
  const gapHeight = lerp(d.gapHeightStart, d.gapHeightEnd, eased);
  const spacing = lerp(d.spacingStart, d.spacingEnd, eased);
  const drift = lerp(d.driftStart, d.driftEnd, eased);
  let pipes = Math.round(d.basePipes * d.growth ** (level - 1));
  if (isRelief) pipes = Math.max(3, Math.round(pipes * 0.9));

  const movingGaps = d.movingGapsFromLevel > 0 && level >= d.movingGapsFromLevel;
  // Oscillation eats into the usable opening, and the player also needs a full flap bounce
  // in there. Only the room left over after both may be spent on movement — kept
  // deliberately conservative, because a moving gap the player cannot track is the most
  // unfair thing this genre can do.
  const spare = gapHeight - requiredOpening(config);
  const motionAmp = movingGaps ? Math.max(0, Math.min(16, Math.round(spare * 0.18))) : 0;

  return {
    level,
    eased,
    isRelief,
    speed: Math.round(speed * 100) / 100,
    gapHeight: Math.round(gapHeight),
    spacing: Math.round(spacing),
    drift: Math.round(drift * 1000) / 1000,
    pipes,
    motionAmp: Math.max(0, motionAmp),
    estSeconds: Math.round(((pipes * spacing) / speed) * 10) / 10,
  };
}

export const bodyHeight = (config) => config.player.size * config.player.hitboxScale;

/** The vertical range a gap centre may occupy without leaving the playable area. */
export function centreBand(config, gapHeight, motionAmp) {
  const groundY = VIEW_HEIGHT - config.world.groundHeight;
  const half = gapHeight / 2;
  return {
    min: half + motionAmp + STEER_MARGIN,
    max: groundY - half - motionAmp - STEER_MARGIN,
  };
}

export function buildLevel(config, level, baseSeed, attempt = 0) {
  const params = levelParams(level, config);
  const rng = makeRng(subSeed(baseSeed, `F${level}#${attempt}`));

  const band = centreBand(config, params.gapHeight, params.motionAmp);
  if (band.max <= band.min) {
    return { level: null, fatal: `gap of ${params.gapHeight}px does not fit the playable area at level ${level}` };
  }

  const startX = Math.max(VIEW_WIDTH + 90, params.speed * 1.7);
  const flightTime = params.spacing / params.speed;
  const { climb, descent } = reach(config, flightTime);

  const pipes = [];
  let prevY = (band.min + band.max) / 2;
  for (let i = 0; i < params.pipes; i++) {
    // Sample only inside the reachable band, then inside the playable band.
    const lo = Math.max(band.min, prevY - climb);
    const hi = Math.min(band.max, prevY + descent);
    // `drift` scales how far from the previous centre we are willing to wander.
    const span = (hi - lo) * params.drift;
    const mid = (lo + hi) / 2;
    const y = i === 0 ? prevY : clamp(rng.float(mid - span / 2, mid + span / 2), lo, hi);
    pipes.push({
      x: Math.round(startX + i * params.spacing),
      y: Math.round(y),
      gap: params.gapHeight,
      amp: params.motionAmp,
      phase: Math.round(rng.float(0, Math.PI * 2) * 100) / 100,
    });
    prevY = y;
  }

  return {
    level: {
      index: level,
      name: config.copy.levelNames[level - 1] ?? `Level ${level}`,
      speed: params.speed,
      gapHeight: params.gapHeight,
      spacing: params.spacing,
      motionAmp: params.motionAmp,
      targetPipes: params.pipes,
      estSeconds: params.estSeconds,
      isRelief: params.isRelief,
      /** Total scroll distance to clear, so the runtime knows when the level ends. */
      targetPx: Math.round(startX + params.pipes * params.spacing + VIEW_WIDTH * 0.5),
      pattern: pipes,
      attempt,
      notes: [],
    },
    fatal: null,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function validateLevel(level, config) {
  const reasons = [];
  const warnings = [];
  const body = bodyHeight(config);
  const speed = level.speed;

  // 1 — the opening must fit the body AND a full flap bounce, even at the top of the swing
  const usable = level.gapHeight - level.motionAmp * 2;
  const needed = requiredOpening(config);
  if (usable < needed) {
    reasons.push(
      `gap of ${level.gapHeight}px (${Math.round(usable)}px usable after ${level.motionAmp}px oscillation) ` +
        `cannot fit a ${Math.round(body)}px body plus the ${Math.round(flapBounce(config))}px flap bounce ` +
        `the player cannot avoid — needs ${Math.round(needed)}px`
    );
  }

  // 2 — reaction time
  const react = (VIEW_WIDTH - PLAYER_X) / speed;
  if (react < REACTION_MIN_SECONDS) {
    reasons.push(`speed ${Math.round(speed)}px/s leaves only ${react.toFixed(2)}s to read a pipe (min ${REACTION_MIN_SECONDS}s)`);
  }
  if (level.pattern.length) {
    const runway = (level.pattern[0].x - PLAYER_X) / speed;
    if (runway < REACTION_MIN_SECONDS * 2.5) {
      reasons.push(`first pipe arrives after only ${runway.toFixed(2)}s — needs ${(REACTION_MIN_SECONDS * 2.5).toFixed(2)}s of runway`);
    }
  }

  // 3 — every gap inside the playable area
  const band = centreBand(config, level.gapHeight, level.motionAmp);
  for (const [i, pipe] of level.pattern.entries()) {
    if (pipe.y < band.min - 0.5 || pipe.y > band.max + 0.5) {
      reasons.push(`pipe ${i} centre ${pipe.y} is outside the playable band ${Math.round(band.min)}–${Math.round(band.max)}`);
      break;
    }
  }

  // 4 — THE important one: consecutive gaps must be reachable
  const flightTime = level.spacing / speed;
  const { climb, descent } = reach(config, flightTime);
  for (let i = 0; i < level.pattern.length - 1; i++) {
    const dy = level.pattern[i + 1].y - level.pattern[i].y;
    if (dy < -climb - 0.5) {
      reasons.push(
        `pipe ${i}→${i + 1} demands a ${Math.round(-dy)}px climb in ${flightTime.toFixed(2)}s but only ` +
          `${Math.round(climb)}px is achievable — unreachable gap`
      );
      break;
    }
    if (dy > descent + 0.5) {
      reasons.push(
        `pipe ${i}→${i + 1} demands a ${Math.round(dy)}px drop in ${flightTime.toFixed(2)}s but only ` +
          `${Math.round(descent)}px is achievable`
      );
      break;
    }
  }

  // 5 — density sanity
  const perSecond = speed / level.spacing;
  if (perSecond > 2.2) reasons.push(`pipes arrive ${perSecond.toFixed(2)}/s — unreadable`);
  if (perSecond < 0.25) warnings.push(`sparse: ${perSecond.toFixed(2)} pipes/s`);

  const metrics = {
    obstacleCount: level.pattern.length,
    seconds: level.estSeconds,
    density: Math.round(perSecond * 100) / 100,
    reactionSeconds: Math.round(react * 100) / 100,
    usableGap: Math.round(usable),
    climbBudget: Math.round(climb),
    estimatedDifficulty: difficultyScore(level, config, perSecond),
  };

  return { ok: reasons.length === 0, reasons, warnings, metrics };
}

function difficultyScore(level, config, perSecond) {
  const d = config.difficulty;
  const speedTerm = (level.speed - d.startSpeed) / Math.max(1, d.maxSpeed - d.startSpeed);
  const gapTerm = 1 - (level.gapHeight - d.gapHeightEnd) / Math.max(1, d.gapHeightStart - d.gapHeightEnd);
  const rateTerm = Math.min(1, perSecond / 2.2);
  const motionTerm = level.motionAmp > 0 ? 0.12 : 0;
  const score = 100 * (0.34 * speedTerm + 0.36 * gapTerm + 0.18 * rateTerm + motionTerm);
  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Payload the Phaser scene consumes. Flat on purpose — no derivation at boot. */
export function runtimeLevel(l) {
  return {
    index: l.index, name: l.name, speed: l.speed, gapHeight: l.gapHeight,
    spacing: l.spacing, motionAmp: l.motionAmp, targetPipes: l.targetPipes,
    targetPx: l.targetPx, pattern: l.pattern, isRelief: l.isRelief,
  };
}

export const GENRE_ID = 'tap_to_fly';
