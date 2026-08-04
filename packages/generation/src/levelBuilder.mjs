/**
 * §C3 Procedural Level Builder.
 *
 * Two ideas do the heavy lifting:
 *
 *  1. CORRECT BY CONSTRUCTION — the builder consults the same physics the
 *     validator uses, so it refuses to place something unclearable in the first
 *     place. The validator is then a *proof*, not a filter.
 *
 *  2. CHUNK GRAMMAR — obstacles are emitted as small hand-designed patterns
 *     (single / cluster / burst / breather) rather than a flat random stream.
 *     A human designed every chunk, so procedural output still feels authored.
 */

import { makeRng, subSeed } from './prng.mjs';
import { levelParams } from './curve.mjs';
import {
  canClear,
  canPassUnder,
  canLeapGap,
  minSafeSpacing,
  singleJumpWindow,
  playerHeight,
  VIEW_WIDTH,
} from './physics.mjs';

const UNDER_KINDS = new Set(['low_bar']);
const GAP_KINDS = new Set(['gap']);

/** Keep the roster to what is physically survivable at this speed. */
function feasibleRoster(config, activeObstacles, speed) {
  const kept = [];
  const dropped = [];
  for (const ob of activeObstacles) {
    let ok;
    if (GAP_KINDS.has(ob.kind)) ok = canLeapGap(config, ob, speed).ok;
    else if (UNDER_KINDS.has(ob.kind)) ok = canPassUnder(config, ob).ok;
    else ok = canClear(config, ob, speed).ok;
    (ok ? kept : dropped).push(ob);
  }
  return { kept, dropped };
}

/** Chunk mix shifts with difficulty: calm early, busier later. */
function chunkTable(eased, isRelief) {
  if (isRelief) {
    return [
      { type: 'single', weight: 70 },
      { type: 'breather', weight: 25 },
      { type: 'cluster', weight: 5 },
    ];
  }
  const t = Math.max(0, Math.min(1, eased));
  return [
    { type: 'single', weight: Math.round(70 - 30 * t) },
    { type: 'breather', weight: Math.round(20 - 14 * t) },
    { type: 'cluster', weight: Math.round(6 + 24 * t) },
    { type: 'burst', weight: Math.round(4 + 20 * t) },
  ].filter((c) => c.weight > 0);
}

/** Build one level deterministically. */
export function buildLevel(config, level, baseSeed, attempt = 0) {
  const params = levelParams(level, config);
  const rng = makeRng(subSeed(baseSeed, `L${level}#${attempt}`));

  const { kept: roster, dropped } = feasibleRoster(config, params.activeObstacles, params.speed);
  const notes = [];
  if (dropped.length) {
    notes.push(
      `excluded at ${Math.round(params.speed)}px/s: ${dropped.map((o) => o.id).join(', ')}`
    );
  }
  if (!roster.length) {
    return {
      level: null,
      fatal: `no obstacle in the roster is survivable at level ${level} (${Math.round(params.speed)}px/s)`,
    };
  }

  const safeSpacing = minSafeSpacing(config, params.speed);
  const desiredSpacing = params.speed * (params.spawnGap / 1000);

  // Generous runway so the player can read the level before it starts.
  let x = Math.max(VIEW_WIDTH + 80, params.speed * 1.4);
  const endBuffer = params.speed * 1.6;
  const limit = params.targetPx - endBuffer;

  const pattern = [];
  const jumpables = roster.filter((o) => !UNDER_KINDS.has(o.kind) && !GAP_KINDS.has(o.kind));
  const table = chunkTable(params.eased, params.isRelief);

  let guard = 0;
  while (x < limit && guard++ < 4000) {
    const chunk = rng.weighted(table).type;

    if (chunk === 'cluster' && jumpables.length >= 2) {
      const a = rng.weighted(jumpables);
      const b = rng.weighted(jumpables);
      const window = singleJumpWindow(config, a, b, params.speed);
      // Sit comfortably inside the window so runtime float drift stays safe.
      const gap = window * 0.55;
      if (gap >= 24) {
        pattern.push({ x: Math.round(x), obstacleId: a.id });
        x += a.width + gap;
        if (x < limit) {
          pattern.push({ x: Math.round(x), obstacleId: b.id });
          x += b.width + spacingWithJitter(rng, desiredSpacing, safeSpacing) ;
        }
        continue;
      }
      // window too tight — fall through to a plain single
    }

    if (chunk === 'burst' && roster.length) {
      const count = rng.int(2, 3);
      for (let i = 0; i < count && x < limit; i++) {
        const ob = rng.weighted(roster);
        pattern.push({ x: Math.round(x), obstacleId: ob.id });
        // tighter than normal, but never below the land-and-rejump threshold
        x += ob.width + Math.max(safeSpacing * 1.05, desiredSpacing * 0.75);
      }
      continue;
    }

    if (chunk === 'breather') {
      const ob = rng.weighted(roster);
      pattern.push({ x: Math.round(x), obstacleId: ob.id });
      x += ob.width + Math.max(safeSpacing * 1.3, desiredSpacing * rng.float(1.6, 2.2));
      continue;
    }

    // single
    const ob = rng.weighted(roster);
    pattern.push({ x: Math.round(x), obstacleId: ob.id });
    x += ob.width + spacingWithJitter(rng, desiredSpacing, safeSpacing);
  }

  return {
    level: {
      index: level,
      name: config.copy.levelNames[level - 1] ?? `Level ${level}`,
      speed: params.speed,
      spawnGap: params.spawnGap,
      targetPx: params.targetPx,
      targetMetres: params.targetMetres,
      estSeconds: params.estSeconds,
      isRelief: params.isRelief,
      newObstacleIds: params.newObstacleIds,
      rosterIds: roster.map((o) => o.id),
      pattern,
      attempt,
      notes,
    },
    fatal: null,
  };
}

function spacingWithJitter(rng, desired, safe) {
  const jittered = desired * rng.float(0.88, 1.18);
  return Math.max(safe * 1.08, jittered);
}
