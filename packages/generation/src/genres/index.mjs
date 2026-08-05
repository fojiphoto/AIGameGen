/**
 * Generation registry — dispatches level building and validation by genre.
 *
 * `endless_runner` deliberately keeps its ORIGINAL code path (`buildGame` in
 * ../index.mjs), byte for byte. It is the shipped, tested, APK-verified genre and adding
 * templates around it must not be able to change its output. Everything else goes through
 * the generic loop below.
 */

import { buildGame as buildRunnerGame, buildRuntimePayload as runnerPayload } from '../index.mjs';
import * as tapToFly from './tapToFly.mjs';
import * as rhythmDash from './rhythmDash.mjs';
import { memoryMatch, slidingPuzzle, merge2048, snake } from './boardGames.mjs';

/** Re-seed attempts before declaring a level unbuildable. */
export const MAX_SEED_ATTEMPTS = 10;

const adapt = (mod) => ({
  id: mod.id ?? mod.GENRE_ID,
  build: mod.build ?? mod.buildLevel,
  validate: mod.validate ?? mod.validateLevel,
  runtime: mod.runtime ?? mod.runtimeLevel,
});

export const GENERATION_REGISTRY = {
  tap_to_fly: adapt({
    id: 'tap_to_fly',
    build: (config, level, seed, attempt) => tapToFly.buildLevel(config, level, seed, attempt),
    validate: tapToFly.validateLevel,
    runtime: tapToFly.runtimeLevel,
  }),
  rhythm_dash: adapt({
    id: 'rhythm_dash',
    build: (config, level, seed, attempt) => rhythmDash.buildLevel(config, level, seed, attempt),
    validate: rhythmDash.validateLevel,
    runtime: rhythmDash.runtimeLevel,
  }),
  memory_match: adapt(memoryMatch),
  sliding_puzzle: adapt(slidingPuzzle),
  merge_2048: adapt(merge2048),
  snake: adapt(snake),
};

/**
 * Generic build-and-prove loop for registry genres.
 *
 * There is no difficulty-relaxation pass here, unlike the runner. It is not needed: each
 * genre's schema `repair()` already forces structurally impossible configs into range
 * before generation starts (odd card grids, unreachable 2048 targets, snake boards that a
 * grown snake cannot fit in). If a level still fails after re-seeding, the config is at
 * fault and saying so beats silently shipping a weaker game.
 */
export function buildGenreGame(config) {
  const entry = GENERATION_REGISTRY[config.genre];
  if (!entry) {
    return {
      levels: [], ladder: [],
      validation: { ok: false, levelsChecked: 0, failedLevels: [], curveIssues: [], perLevel: [], difficultyScores: [] },
      report: { ok: false, fatals: [`genre "${config.genre}" has no generator`], levelsBuilt: 0, levelsRequested: 0, totalObstacles: 0, levelsNeedingRetry: [], levelsRelaxed: [], difficultyScores: [], estTotalMinutes: 0 },
    };
  }

  const baseSeed = config.meta.seed >>> 0;
  const total = config.progression.levels;
  const levels = [];
  const perLevel = [];
  const fatals = [];
  const retried = [];

  for (let i = 1; i <= total; i++) {
    let placed = null;
    let used = 0;
    let lastReasons = [];
    for (let a = 0; a < MAX_SEED_ATTEMPTS; a++) {
      const built = entry.build(config, i, baseSeed, a);
      if (built.fatal) {
        lastReasons = [built.fatal];
        break; // re-seeding cannot fix a structural problem
      }
      const v = entry.validate(built.level, config);
      if (v.ok) {
        placed = built.level;
        perLevel.push({ level: i, ...v });
        used = a;
        break;
      }
      lastReasons = v.reasons;
    }
    if (!placed) {
      fatals.push(`level ${i}: ${lastReasons.join('; ')}`);
      continue;
    }
    if (used > 0) retried.push(i);
    levels.push(placed);
  }

  const difficultyScores = perLevel.map((r) => r.metrics.estimatedDifficulty);

  // The curve must actually rise. A config that plateaus or dips outside a relief level is
  // a design bug the AI can introduce without producing a single invalid level.
  const curveIssues = [];
  for (let i = 1; i < difficultyScores.length; i++) {
    const isRelief = config.progression.reliefLevels.includes(i + 1);
    if (!isRelief && difficultyScores[i] < difficultyScores[i - 1] - 4) {
      curveIssues.push(`level ${i + 1} (${difficultyScores[i]}) is easier than level ${i} (${difficultyScores[i - 1]}) and is not a relief level`);
    }
  }

  const ladder = levels.map((l, idx) => ({
    level: l.index,
    label: ladderLabel(config.genre, l),
    estSeconds: l.estSeconds,
    difficulty: difficultyScores[idx] ?? 0,
    isRelief: Boolean(l.isRelief),
    // kept for the shared ladder table in the UI
    speed: l.speed ?? difficultyScores[idx] ?? 0,
    targetMetres: l.targetPipes ?? l.pairs ?? l.scramble ?? l.foodTarget ?? l.target ?? 0,
    newObstacles: [],
  }));

  return {
    levels,
    ladder,
    validation: {
      ok: fatals.length === 0 && curveIssues.length === 0,
      levelsChecked: levels.length,
      failedLevels: [],
      curveIssues,
      perLevel,
      difficultyScores,
    },
    report: {
      ok: fatals.length === 0 && curveIssues.length === 0,
      fatals,
      levelsBuilt: levels.length,
      levelsRequested: total,
      totalObstacles: perLevel.reduce((s, r) => s + (r.metrics.obstacleCount ?? 0), 0),
      levelsNeedingRetry: retried,
      levelsRelaxed: [],
      difficultyScores,
      estTotalMinutes: Math.round((levels.reduce((s, l) => s + l.estSeconds, 0) / 60) * 10) / 10,
    },
  };
}

/** Human-readable "what this level asks of you", per genre. */
function ladderLabel(genre, l) {
  switch (genre) {
    case 'tap_to_fly': return `${l.targetPipes} pipes · ${l.gapHeight}px gap`;
    case 'memory_match': return `${l.pairs} pairs · ${l.timeLimit}s`;
    case 'sliding_puzzle': return `${l.size}x${l.size} · ${l.scramble} scramble · ${l.moveLimit} moves`;
    case 'merge_2048': return `reach ${l.target}`;
    case 'snake': return `${l.foodTarget} food · ${l.stepMs}ms · ${l.walls.length} walls`;
    default: return `level ${l.index}`;
  }
}

/**
 * Build any genre. Routes endless_runner to its original implementation so that path
 * stays untouched.
 */
export function buildAnyGame(config) {
  return config.genre === 'endless_runner' ? buildRunnerGame(config) : buildGenreGame(config);
}

/** Runtime payload for any genre, in the shape the engine expects. */
export function buildAnyRuntimePayload(config, levels) {
  if (config.genre === 'endless_runner') return runnerPayload(config, levels);

  const entry = GENERATION_REGISTRY[config.genre];
  const base = {
    schemaVersion: config.schemaVersion,
    genre: config.genre,
    meta: config.meta,
    theme: config.theme,
    progression: config.progression,
    copy: config.copy,
    levels: levels.map((l) => entry.runtime(l)),
  };
  // Pass through whichever genre-specific sections this config actually has.
  for (const key of ['player', 'world', 'board', 'rules', 'difficulty']) {
    if (config[key] !== undefined) base[key] = config[key];
  }
  base.buildId = hashPayload(config, levels);
  return base;
}

function hashPayload(config, levels) {
  let h = 2166136261 >>> 0;
  const s = `${config.meta.seed}:${config.meta.title}:${config.genre}:${levels.length}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(36);
}
