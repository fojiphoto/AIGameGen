/**
 * §C4 Level Validator — the module that separates a toy from a product.
 *
 * Runs headless (no rendering) over every generated level and PROVES it is
 * beatable using the same closed-form physics the runtime uses. A level that
 * fails here never reaches a player.
 *
 * Checks performed per level:
 *   1. every obstacle is individually clearable at that level's speed
 *   2. low/flying obstacles leave enough clearance to run underneath
 *   3. ground gaps are leapable at that level's speed
 *   4. no consecutive pair falls in the "dead zone" (too close to land, too far
 *      to clear in one jump) — the classic unfair-runner bug
 *   5. the first obstacle allows human reaction time
 *   6. obstacle density stays inside a sane band (not empty, not a wall)
 */

import {
  canClear,
  canPassUnder,
  canLeapGap,
  pairIsFair,
  reactionSeconds,
  minSafeSpacing,
  REACTION_MIN_SECONDS,
  VIEW_WIDTH,
  PLAYER_X,
} from './physics.mjs';

/** Obstacles the player is meant to duck under rather than jump. */
const UNDER_KINDS = new Set(['low_bar']);
const GAP_KINDS = new Set(['gap']);

export const DENSITY_MIN = 0.35; // obstacles per second — below this feels empty
export const DENSITY_MAX = 2.6;  // above this is unreadable

/**
 * @returns {{ok:boolean, reasons:string[], warnings:string[], metrics:object}}
 */
export function validateLevel(level, config) {
  const reasons = [];
  const warnings = [];
  const speed = level.speed;
  const byId = new Map(config.obstacles.map((o) => [o.id, o]));

  // ── 1-3: per-obstacle feasibility ────────────────────────────────────────
  for (const placement of level.pattern) {
    const ob = byId.get(placement.obstacleId);
    if (!ob) {
      reasons.push(`unknown obstacle id "${placement.obstacleId}"`);
      continue;
    }

    if (GAP_KINDS.has(ob.kind)) {
      const leap = canLeapGap(config, ob, speed);
      if (!leap.ok) {
        reasons.push(
          `gap "${ob.id}" at ${Math.round(placement.x)}px needs ${Math.round(leap.needed)}px ` +
            `of jump range but only ${Math.round(leap.range)}px available at ${Math.round(speed)}px/s`
        );
      }
      continue;
    }

    if (UNDER_KINDS.has(ob.kind)) {
      const under = canPassUnder(config, ob);
      if (!under.ok) {
        reasons.push(
          `low_bar "${ob.id}" leaves only ${Math.round(under.clearance)}px clearance — ` +
            `player cannot pass under and cannot jump over`
        );
      }
      continue;
    }

    const clear = canClear(config, ob, speed);
    if (!clear.ok) {
      if (clear.reason === 'jump_too_low') {
        reasons.push(
          `obstacle "${ob.id}" needs ${Math.round(clear.requiredHeight)}px of height but the ` +
            `jump peaks at ${Math.round(clear.peak)}px`
        );
      } else {
        reasons.push(
          `obstacle "${ob.id}" is ${ob.width}px wide — needs ${Math.round(clear.needed)}px of ` +
            `airborne travel, only ${Math.round(clear.available)}px available at ${Math.round(speed)}px/s`
        );
      }
    }
  }

  // ── 4: consecutive pair fairness ────────────────────────────────────────
  const safeSpacing = minSafeSpacing(config, speed);
  for (let i = 0; i < level.pattern.length - 1; i++) {
    const a = byId.get(level.pattern[i].obstacleId);
    const b = byId.get(level.pattern[i + 1].obstacleId);
    if (!a || !b) continue;

    const spacing = level.pattern[i + 1].x - level.pattern[i].x - a.width;
    const aUnder = UNDER_KINDS.has(a.kind);
    const bUnder = UNDER_KINDS.has(b.kind);

    if (bUnder && !aUnder) {
      // The player is airborne after clearing `a`. A low bar sits at head height,
      // so they MUST be back on the ground before it arrives — otherwise the only
      // way past `a` is the thing that kills them. Found by the runtime playtest
      // bot; the analytic pass used to skip this pair entirely.
      if (spacing < safeSpacing) {
        reasons.push(
          `pair ${i}→${i + 1} ("${a.id}"→low_bar "${b.id}") is unwinnable: only ` +
            `${Math.round(spacing)}px to land after jumping "${a.id}", needs ${Math.round(safeSpacing)}px — ` +
            `the player is still airborne when the bar arrives`
        );
      }
      continue;
    }

    if (aUnder && !bUnder) {
      // Grounded while passing under `a`, so only reaction room matters.
      const needed = speed * REACTION_MIN_SECONDS;
      if (spacing < needed) {
        reasons.push(
          `pair ${i}→${i + 1} (low_bar "${a.id}"→"${b.id}") leaves only ` +
            `${Math.round(spacing)}px (${(spacing / speed).toFixed(2)}s) to react, needs ${Math.round(needed)}px`
        );
      }
      continue;
    }

    if (aUnder && bUnder) continue; // both ducked under, no arc interaction

    const fair = pairIsFair(config, a, b, spacing, speed);
    if (!fair.ok) {
      reasons.push(
        `pair ${i}→${i + 1} ("${a.id}"→"${b.id}") sits in the dead zone: ${Math.round(spacing)}px apart, ` +
          `needs either <${Math.round(fair.window)}px (one jump) or >${Math.round(fair.safe)}px (land & re-jump)`
      );
    }
  }

  // ── 5: reaction time on the opening obstacle ────────────────────────────
  const react = reactionSeconds(speed);
  if (react < REACTION_MIN_SECONDS) {
    reasons.push(
      `speed ${Math.round(speed)}px/s leaves only ${react.toFixed(2)}s of reaction time ` +
        `(minimum ${REACTION_MIN_SECONDS}s)`
    );
  }
  if (level.pattern.length) {
    const runwaySeconds = (level.pattern[0].x - PLAYER_X) / speed;
    if (runwaySeconds < REACTION_MIN_SECONDS * 2) {
      reasons.push(
        `first obstacle arrives after only ${runwaySeconds.toFixed(2)}s — needs ` +
          `${(REACTION_MIN_SECONDS * 2).toFixed(2)}s of runway`
      );
    }
  }

  // ── 6: density band ─────────────────────────────────────────────────────
  const seconds = level.targetPx / speed;
  const density = level.pattern.length / Math.max(1, seconds);
  if (density < DENSITY_MIN) {
    warnings.push(`sparse: ${density.toFixed(2)} obstacles/s (target ≥ ${DENSITY_MIN})`);
  }
  if (density > DENSITY_MAX) {
    reasons.push(`overcrowded: ${density.toFixed(2)} obstacles/s (max ${DENSITY_MAX})`);
  }

  // ── metrics ─────────────────────────────────────────────────────────────
  const metrics = {
    obstacleCount: level.pattern.length,
    seconds: Math.round(seconds * 10) / 10,
    density: Math.round(density * 100) / 100,
    reactionSeconds: Math.round(react * 100) / 100,
    minSafeSpacing: Math.round(minSafeSpacing(config, speed)),
    estimatedDifficulty: estimateDifficulty(level, config, density),
  };

  return { ok: reasons.length === 0, reasons, warnings, metrics };
}

/**
 * Heuristic 0-100 difficulty score. Not a solver — a comparable signal used by
 * the level inspector UI and by the telemetry tuning loop (§F4) to confirm the
 * curve actually rises monotonically.
 */
function estimateDifficulty(level, config, density) {
  const d = config.difficulty;
  const speedTerm = (level.speed - d.startSpeed) / Math.max(1, d.maxSpeed - d.startSpeed);
  const densityTerm = Math.min(1, density / DENSITY_MAX);
  const reactTerm = 1 - Math.min(1, reactionSeconds(level.speed) / 1.4);
  const score = 100 * (0.45 * speedTerm + 0.35 * densityTerm + 0.2 * reactTerm);
  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Validate a whole game. Also asserts the curve is monotonic across levels
 * (ignoring intentional relief valleys) — a config that gets *easier* at level
 * 14 is a design bug the AI can silently introduce.
 */
export function validateGame(levels, config) {
  const perLevel = levels.map((lv) => ({ level: lv.index, ...validateLevel(lv, config) }));
  const failed = perLevel.filter((r) => !r.ok);

  const curveIssues = [];
  const scores = perLevel.map((r) => r.metrics.estimatedDifficulty);
  for (let i = 1; i < scores.length; i++) {
    const isRelief = config.progression.reliefLevels.includes(i + 1);
    if (!isRelief && scores[i] < scores[i - 1] - 4) {
      curveIssues.push(
        `level ${i + 1} (${scores[i]}) is easier than level ${i} (${scores[i - 1]}) and is not a relief level`
      );
    }
  }

  return {
    ok: failed.length === 0 && curveIssues.length === 0,
    levelsChecked: levels.length,
    failedLevels: failed.map((f) => f.level),
    curveIssues,
    perLevel,
    difficultyScores: scores,
  };
}
