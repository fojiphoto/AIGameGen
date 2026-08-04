/**
 * Generation Core orchestrator (§C).
 *
 * buildGame(config) is the single entry point:
 *   config → 20 validated levels + a report
 *
 * Guarantee: every level in the returned array has PASSED validation. If a level
 * cannot be made valid by re-seeding, the builder relaxes that level's tuning
 * (a bounded, deterministic step-down) and tries again. Only if that also fails
 * does it report a fatal config problem — which is the AI's fault, not the
 * player's, and is surfaced to the repair loop in §B3.
 */

import { buildLevel } from './levelBuilder.mjs';
import { validateLevel, validateGame } from './validator.mjs';
import { difficultyLadder, levelParams } from './curve.mjs';
import { hashSeed } from './prng.mjs';

export { makeRng, hashSeed, subSeed } from './prng.mjs';
export { levelParams, difficultyLadder, endlessParams, applyCurve, PIXELS_PER_METRE } from './curve.mjs';
export { validateLevel, validateGame } from './validator.mjs';
export { buildLevel } from './levelBuilder.mjs';
export * as physics from './physics.mjs';

/** Re-seed attempts before we start relaxing tuning. */
export const MAX_SEED_ATTEMPTS = 8;
/** Bounded relaxation steps after re-seeding is exhausted. */
export const MAX_RELAX_STEPS = 3;

/**
 * Deterministic, bounded step-down applied to a single problem level.
 * Slows it and widens spacing — never touches other levels.
 */
function relaxConfig(config, step) {
  const factor = 1 - 0.12 * step; // 0.88, 0.76, 0.64
  const next = structuredClone(config);
  next.difficulty.maxSpeed = Math.max(
    next.difficulty.startSpeed + 60,
    next.difficulty.maxSpeed * factor
  );
  next.difficulty.spawnGapEnd = Math.min(
    next.difficulty.spawnGapStart - 60,
    next.difficulty.spawnGapEnd / factor
  );
  return next;
}

/**
 * @param {object} config validated GameConfig
 * @returns {{levels:Array, validation:object, ladder:Array, report:object}}
 */
export function buildGame(config) {
  // This builder is endless_runner only. Handing it another genre's config used to throw
  // deep inside levelParams on a missing `obstacles` array; failing here says what is
  // actually wrong. Use buildAnyGame from ./genres for genre dispatch.
  if (config.genre !== 'endless_runner') {
    throw new Error(
      `buildGame() only handles endless_runner, got "${config.genre}" — use buildAnyGame() from @forge/generation/genres`
    );
  }
  const baseSeed = config.meta.seed >>> 0;
  const levels = [];
  const attempts = [];
  const fatals = [];

  for (let i = 1; i <= config.progression.levels; i++) {
    let placed = null;
    let usedAttempt = 0;
    let usedRelax = 0;

    // pass 1 — re-seed
    for (let a = 0; a < MAX_SEED_ATTEMPTS; a++) {
      const built = buildLevel(config, i, baseSeed, a);
      if (built.fatal) break; // re-seeding cannot fix a roster problem
      const v = validateLevel(built.level, config);
      if (v.ok) {
        placed = built.level;
        usedAttempt = a;
        break;
      }
    }

    // pass 2 — bounded relaxation
    if (!placed) {
      for (let step = 1; step <= MAX_RELAX_STEPS && !placed; step++) {
        const relaxed = relaxConfig(config, step);
        for (let a = 0; a < MAX_SEED_ATTEMPTS; a++) {
          const built = buildLevel(relaxed, i, baseSeed, 100 * step + a);
          if (built.fatal) break;
          const v = validateLevel(built.level, relaxed);
          if (v.ok) {
            placed = { ...built.level, relaxed: step };
            usedAttempt = a;
            usedRelax = step;
            break;
          }
        }
      }
    }

    if (!placed) {
      const diag = buildLevel(config, i, baseSeed, 0);
      const reason = diag.fatal ?? validateLevel(diag.level, config).reasons.join('; ');
      fatals.push(`level ${i}: ${reason}`);
      continue;
    }

    levels.push(placed);
    attempts.push({ level: i, seedAttempts: usedAttempt + 1, relaxSteps: usedRelax });
  }

  const validation = validateGame(levels, config);
  const ladder = difficultyLadder(config);

  return {
    levels,
    validation,
    ladder,
    report: {
      ok: fatals.length === 0 && validation.ok,
      fatals,
      levelsBuilt: levels.length,
      levelsRequested: config.progression.levels,
      totalObstacles: levels.reduce((s, l) => s + l.pattern.length, 0),
      levelsNeedingRetry: attempts.filter((a) => a.seedAttempts > 1).map((a) => a.level),
      levelsRelaxed: attempts.filter((a) => a.relaxSteps > 0).map((a) => a.level),
      difficultyScores: validation.difficultyScores,
      estTotalMinutes:
        Math.round((levels.reduce((s, l) => s + l.estSeconds, 0) / 60) * 10) / 10,
    },
  };
}

/**
 * The runtime payload written into the bundle as `game.json`.
 * Deliberately flat and small — the engine should do zero derivation at boot.
 */
export function buildRuntimePayload(config, levels) {
  return {
    schemaVersion: config.schemaVersion,
    genre: config.genre,
    meta: config.meta,
    theme: config.theme,
    player: config.player,
    world: config.world,
    difficulty: config.difficulty,
    progression: config.progression,
    copy: config.copy,
    obstacles: config.obstacles,
    levels: levels.map((l) => ({
      index: l.index,
      name: l.name,
      speed: l.speed,
      targetPx: l.targetPx,
      targetMetres: l.targetMetres,
      pattern: l.pattern,
      newObstacleIds: l.newObstacleIds,
      isRelief: l.isRelief,
    })),
    buildId: hashSeed(`${config.meta.seed}:${config.meta.title}:${levels.length}`).toString(36),
  };
}
