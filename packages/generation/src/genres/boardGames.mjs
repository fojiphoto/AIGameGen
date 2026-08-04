/**
 * Level builders + validators for the board/puzzle genres:
 * memory_match, sliding_puzzle, merge_2048, snake.
 *
 * They live together because their structure is identical — apply the difficulty curve to
 * get per-level parameters, then prove the level is FINISHABLE. Only the proof differs:
 *
 *   memory_match   arithmetic — the time budget must beat perfect play
 *   sliding_puzzle construction — scrambled by N legal moves, so the solution is that
 *                 walk reversed; parity can never be wrong
 *   merge_2048    a ceiling — a small board physically cannot build past a certain tile
 *   snake         an endgame check — a fully grown snake plus walls must still fit
 *
 * Nothing here is physics, but each one is a real proof rather than a vibe.
 */

import { makeRng, subSeed } from '../prng.mjs';
import { applyCurve } from '../curve.mjs';

const lerp = (a, b, t) => a + (b - a) * t;
const RELIEF_FACTOR = 0.85;

function curveAt(level, config) {
  const p = config.progression;
  const total = p.levels;
  const t = total > 1 ? (level - 1) / (total - 1) : 0;
  let eased = applyCurve(t, config.difficulty.curve);
  const isRelief = p.reliefLevels.includes(level);
  if (isRelief) eased *= RELIEF_FACTOR;
  return { eased, isRelief };
}

const named = (config, level) => config.copy.levelNames[level - 1] ?? `Level ${level}`;

// ─── memory_match ───────────────────────────────────────────────────────────

/** Seconds a player with perfect recall needs: every pair costs one look plus one match. */
function perfectPlaySeconds(pairs, flipBackMs) {
  const flipPair = 0.55 + flipBackMs / 1000; // reveal, read, flip back
  return pairs * flipPair + pairs * 0.9;     // discovery pass + matching pass
}

export const memoryMatch = {
  id: 'memory_match',

  params(level, config) {
    const { eased, isRelief } = curveAt(level, config);
    const b = config.board;
    // Grow cards, then force an even count — an odd grid has an unpartnered card.
    let cols = Math.round(lerp(b.colsStart, b.colsEnd, eased));
    let rows = Math.round(lerp(b.rowsStart, b.rowsEnd, eased));
    if ((cols * rows) % 2 !== 0) {
      if (cols < b.colsEnd) cols += 1;
      else rows = Math.max(2, rows - 1);
    }
    const pairs = (cols * rows) / 2;
    const slack = lerp(config.difficulty.timeSlackStart, config.difficulty.timeSlackEnd, eased);
    const floor = perfectPlaySeconds(pairs, config.rules.flipBackMs);
    return {
      cols, rows, pairs, isRelief,
      timeLimit: Math.ceil(floor * slack),
      perfectSeconds: Math.round(floor * 10) / 10,
      slack: Math.round(slack * 100) / 100,
      estSeconds: Math.ceil(floor * Math.min(slack, 2.2)),
    };
  },

  build(config, level, baseSeed, attempt = 0) {
    const p = memoryMatch.params(level, config);
    const rng = makeRng(subSeed(baseSeed, `M${level}#${attempt}`));
    if ((p.cols * p.rows) % 2 !== 0) {
      return { level: null, fatal: `level ${level} grid ${p.cols}x${p.rows} is odd` };
    }
    if (p.pairs > config.board.faceCount) {
      return { level: null, fatal: `level ${level} needs ${p.pairs} pairs but only ${config.board.faceCount} faces exist` };
    }
    // Deal each face twice, then shuffle — a valid deal by construction.
    const faces = [];
    for (let i = 0; i < p.pairs; i++) faces.push(i, i);
    const deal = rng.shuffle(faces);
    return {
      level: {
        index: level, name: named(config, level),
        cols: p.cols, rows: p.rows, pairs: p.pairs,
        timeLimit: p.timeLimit, perfectSeconds: p.perfectSeconds, slack: p.slack,
        deal, estSeconds: p.estSeconds, isRelief: p.isRelief, attempt, notes: [],
      },
      fatal: null,
    };
  },

  validate(level, config) {
    const reasons = [];
    const warnings = [];
    if ((level.cols * level.rows) % 2 !== 0) reasons.push(`grid ${level.cols}x${level.rows} is odd — a card has no partner`);
    if (level.deal.length !== level.cols * level.rows) reasons.push(`deal has ${level.deal.length} cards for ${level.cols * level.rows} slots`);

    const counts = new Map();
    for (const f of level.deal) counts.set(f, (counts.get(f) ?? 0) + 1);
    const bad = [...counts.entries()].filter(([, n]) => n !== 2);
    if (bad.length) reasons.push(`${bad.length} face(s) do not appear exactly twice`);

    const floor = perfectPlaySeconds(level.pairs, config.rules.flipBackMs);
    if (level.timeLimit < floor) {
      reasons.push(`time limit ${level.timeLimit}s is below the ${floor.toFixed(1)}s a perfect player needs — unwinnable`);
    } else if (level.timeLimit < floor * 1.15) {
      warnings.push(`tight: ${level.timeLimit}s vs ${floor.toFixed(1)}s perfect play`);
    }
    if (level.cols > 8 || level.rows > 6) reasons.push(`grid ${level.cols}x${level.rows} will not fit the viewport`);

    return {
      ok: reasons.length === 0,
      reasons, warnings,
      metrics: {
        obstacleCount: level.pairs,
        seconds: level.estSeconds,
        density: Math.round((level.pairs / Math.max(1, level.estSeconds)) * 100) / 100,
        estimatedDifficulty: score01((level.pairs - 3) / 12 * 0.6 + (1 - Math.min(1, (level.slack - 1.15) / 2.3)) * 0.4),
      },
    };
  },

  runtime: (l) => ({
    index: l.index, name: l.name, cols: l.cols, rows: l.rows, pairs: l.pairs,
    timeLimit: l.timeLimit, deal: l.deal, isRelief: l.isRelief,
  }),
};

// ─── sliding_puzzle ─────────────────────────────────────────────────────────

const NEIGHBOURS = (i, size) => {
  const r = Math.floor(i / size);
  const c = i % size;
  const out = [];
  if (r > 0) out.push(i - size);
  if (r < size - 1) out.push(i + size);
  if (c > 0) out.push(i - 1);
  if (c < size - 1) out.push(i + 1);
  return out;
};

export const slidingPuzzle = {
  id: 'sliding_puzzle',

  params(level, config) {
    const { eased, isRelief } = curveAt(level, config);
    const b = config.board;
    const d = config.difficulty;
    const size = Math.round(lerp(b.sizeStart, b.sizeEnd, eased));
    const scramble = Math.max(2, Math.round(lerp(d.scrambleStart, d.scrambleEnd, eased)));
    const slack = lerp(d.moveSlackStart, d.moveSlackEnd, eased);
    return {
      size, scramble, isRelief,
      moveLimit: Math.ceil(scramble * slack),
      slack: Math.round(slack * 100) / 100,
      estSeconds: Math.min(180, Math.ceil(scramble * 1.6)),
    };
  },

  build(config, level, baseSeed, attempt = 0) {
    const p = slidingPuzzle.params(level, config);
    const rng = makeRng(subSeed(baseSeed, `S${level}#${attempt}`));
    const n = p.size * p.size;

    // Solved state, then walk backwards by legal moves. The reverse of that walk IS a
    // solution, so solvability is guaranteed without any parity reasoning.
    const tiles = Array.from({ length: n }, (_, i) => (i === n - 1 ? 0 : i + 1));
    let blank = n - 1;
    let lastBlank = -1;
    let applied = 0;
    for (let m = 0; m < p.scramble; m++) {
      const options = NEIGHBOURS(blank, p.size).filter((i) => i !== lastBlank);
      const pick = options.length ? rng.pick(options) : rng.pick(NEIGHBOURS(blank, p.size));
      tiles[blank] = tiles[pick];
      tiles[pick] = 0;
      lastBlank = blank;
      blank = pick;
      applied++;
    }
    if (tiles.every((v, i) => v === (i === n - 1 ? 0 : i + 1))) {
      return { level: null, fatal: `level ${level} scrambled back to the solved state` };
    }

    return {
      level: {
        index: level, name: named(config, level),
        size: p.size, tiles, blank, scramble: applied,
        moveLimit: p.moveLimit, slack: p.slack, faceStyle: config.board.faceStyle,
        estSeconds: p.estSeconds, isRelief: p.isRelief, attempt, notes: [],
      },
      fatal: null,
    };
  },

  validate(level, config) {
    const reasons = [];
    const warnings = [];
    const n = level.size * level.size;

    if (level.tiles.length !== n) reasons.push(`tile array has ${level.tiles.length} entries for a ${level.size}x${level.size} board`);
    const seen = new Set(level.tiles);
    if (seen.size !== n) reasons.push('tiles are not a permutation — duplicate or missing values');
    if (!seen.has(0)) reasons.push('no blank tile');
    if (level.tiles[level.blank] !== 0) reasons.push('blank index does not point at the blank tile');

    const solved = level.tiles.every((v, i) => v === (i === n - 1 ? 0 : i + 1));
    if (solved) reasons.push('board is already solved');

    // Built by walking N legal moves from solved, so the optimal solution is at most N.
    if (level.moveLimit < level.scramble) {
      reasons.push(`move limit ${level.moveLimit} is below the ${level.scramble}-move scramble — solvable but unwinnable`);
    } else if (level.moveLimit < level.scramble * 1.2) {
      warnings.push(`tight budget: ${level.moveLimit} moves for a ${level.scramble}-move scramble`);
    }

    return {
      ok: reasons.length === 0,
      reasons, warnings,
      metrics: {
        obstacleCount: level.scramble,
        seconds: level.estSeconds,
        density: 0,
        estimatedDifficulty: score01(
          ((level.size - 3) / 2) * 0.4 + Math.min(1, level.scramble / 120) * 0.45 +
            (1 - Math.min(1, (level.slack - 1.15) / 2.5)) * 0.15
        ),
      },
    };
  },

  runtime: (l) => ({
    index: l.index, name: l.name, size: l.size, tiles: l.tiles, blank: l.blank,
    scramble: l.scramble, moveLimit: l.moveLimit, faceStyle: l.faceStyle, isRelief: l.isRelief,
  }),
};

// ─── merge_2048 ─────────────────────────────────────────────────────────────

export const merge2048 = {
  id: 'merge_2048',

  params(level, config) {
    const { eased, isRelief } = curveAt(level, config);
    const d = config.difficulty;
    // Targets are powers of two, so interpolate in log space and snap.
    const lo = Math.log2(d.targetStart);
    const hi = Math.log2(d.targetEnd);
    const exp = Math.round(lerp(lo, hi, eased));
    const target = 2 ** exp;
    const slack = lerp(d.moveSlackStart, d.moveSlackEnd, eased);
    // Rough lower bound: reaching 2^n needs about 2^(n-1) spawns of a 2.
    const minMoves = Math.max(8, 2 ** (exp - 1));
    return {
      target, exp, isRelief,
      moveLimit: slack > 0 ? Math.ceil(minMoves * slack) : 0,
      minMoves,
      estSeconds: Math.min(240, Math.ceil(minMoves * 1.1)),
    };
  },

  build(config, level, baseSeed, attempt = 0) {
    const p = merge2048.params(level, config);
    const rng = makeRng(subSeed(baseSeed, `T${level}#${attempt}`));
    const size = config.board.size;
    // Two opening tiles, exactly like the original.
    const cells = new Array(size * size).fill(0);
    const first = rng.int(0, size * size - 1);
    let second = rng.int(0, size * size - 1);
    while (second === first) second = rng.int(0, size * size - 1);
    cells[first] = rng.chance(config.board.spawnFourChance) ? 4 : 2;
    cells[second] = rng.chance(config.board.spawnFourChance) ? 4 : 2;

    return {
      level: {
        index: level, name: named(config, level),
        size, cells, target: p.target, moveLimit: p.moveLimit, minMoves: p.minMoves,
        spawnFourChance: config.board.spawnFourChance,
        estSeconds: p.estSeconds, isRelief: p.isRelief, attempt, notes: [],
      },
      fatal: null,
    };
  },

  validate(level, config) {
    const reasons = [];
    const warnings = [];
    const cells = level.size * level.size;
    const cap = 2 ** Math.max(2, Math.min(17, cells - 3));

    if ((level.target & (level.target - 1)) !== 0) reasons.push(`target ${level.target} is not a power of two`);
    if (level.target > cap) reasons.push(`target ${level.target} is unreachable on a ${level.size}x${level.size} board (max ${cap})`);
    if (level.cells.length !== cells) reasons.push(`board has ${level.cells.length} cells, expected ${cells}`);
    const filled = level.cells.filter((v) => v > 0).length;
    if (filled !== 2) reasons.push(`opening board has ${filled} tiles, expected 2`);
    if (level.cells.some((v) => v !== 0 && (v & (v - 1)) !== 0)) reasons.push('a starting tile is not a power of two');
    if (level.moveLimit > 0 && level.moveLimit < level.minMoves) {
      reasons.push(`move limit ${level.moveLimit} is below the ~${level.minMoves} moves needed to reach ${level.target}`);
    }
    if (level.moveLimit > 0) warnings.push('move limits make this genre frustrating; 0 (unlimited) plays better');

    return {
      ok: reasons.length === 0,
      reasons, warnings,
      metrics: {
        obstacleCount: Math.log2(level.target),
        seconds: level.estSeconds,
        density: 0,
        estimatedDifficulty: score01(Math.min(1, (Math.log2(level.target) - 3) / 10)),
      },
    };
  },

  runtime: (l) => ({
    index: l.index, name: l.name, size: l.size, cells: l.cells, target: l.target,
    moveLimit: l.moveLimit, spawnFourChance: l.spawnFourChance, isRelief: l.isRelief,
  }),
};

// ─── snake ──────────────────────────────────────────────────────────────────

export const snake = {
  id: 'snake',

  params(level, config) {
    const { eased, isRelief } = curveAt(level, config);
    const d = config.difficulty;
    const stepMs = Math.round(lerp(d.stepMsStart, d.stepMsEnd, eased));
    let food = Math.round(d.foodStart * d.growth ** (level - 1));
    if (isRelief) food = Math.max(3, Math.round(food * 0.9));
    const walls = Math.round(lerp(d.wallsStart, d.wallsEnd, eased));
    return {
      stepMs, food, walls, isRelief,
      estSeconds: Math.min(200, Math.ceil((food * 6 * stepMs) / 1000)),
    };
  },

  build(config, level, baseSeed, attempt = 0) {
    const p = snake.params(level, config);
    const rng = makeRng(subSeed(baseSeed, `N${level}#${attempt}`));
    const { cols, rows } = config.board;
    const startR = Math.floor(rows / 2);
    const startC = Math.floor(cols / 4);

    // Keep a clear corridor around the spawn so the snake is never walled in at t=0.
    const forbidden = new Set();
    for (let c = startC - 2; c <= startC + 6; c++) {
      for (let r = startR - 1; r <= startR + 1; r++) {
        if (c >= 0 && c < cols && r >= 0 && r < rows) forbidden.add(r * cols + c);
      }
    }

    const walls = [];
    let guard = 0;
    while (walls.length < p.walls && guard++ < p.walls * 40) {
      const i = rng.int(0, cols * rows - 1);
      if (forbidden.has(i)) continue;
      // No 2x2 wall blobs — they create dead pockets that feel unfair.
      const r = Math.floor(i / cols);
      const c = i % cols;
      const near = walls.filter((w) => Math.abs(Math.floor(w / cols) - r) <= 1 && Math.abs((w % cols) - c) <= 1).length;
      if (near >= 2) continue;
      walls.push(i);
      forbidden.add(i);
    }

    return {
      level: {
        index: level, name: named(config, level),
        cols, rows, stepMs: p.stepMs, foodTarget: p.food, walls,
        growPerFood: config.difficulty.growPerFood, wrapEdges: config.board.wrapEdges,
        start: { r: startR, c: startC },
        estSeconds: p.estSeconds, isRelief: p.isRelief, attempt, notes: [],
      },
      fatal: null,
    };
  },

  validate(level, config) {
    const reasons = [];
    const warnings = [];
    const cells = level.cols * level.rows;

    if (level.stepMs < 60) reasons.push(`${level.stepMs}ms per step is below human reaction time`);

    // The endgame check: a fully grown snake plus walls must still leave room to move.
    const finalLength = 3 + level.foodTarget * level.growPerFood;
    const occupied = finalLength + level.walls.length;
    if (occupied > cells * 0.75) {
      reasons.push(
        `a fully grown snake (${finalLength}) plus ${level.walls.length} walls fills ${occupied}/${cells} cells — ` +
          `no room to finish the level`
      );
    } else if (occupied > cells * 0.6) {
      warnings.push(`crowded endgame: ${occupied}/${cells} cells`);
    }

    // Spawn must have somewhere to go.
    const wallSet = new Set(level.walls);
    const startIdx = level.start.r * level.cols + level.start.c;
    if (wallSet.has(startIdx)) reasons.push('the snake spawns inside a wall');
    const exits = NEIGHBOURS(startIdx, level.cols).filter((i) => !wallSet.has(i)).length;
    if (exits === 0) reasons.push('the snake spawns fully enclosed by walls');

    if (level.foodTarget < 1) reasons.push('food target must be at least 1');

    return {
      ok: reasons.length === 0,
      reasons, warnings,
      metrics: {
        obstacleCount: level.walls.length,
        seconds: level.estSeconds,
        density: Math.round((level.walls.length / cells) * 1000) / 1000,
        estimatedDifficulty: score01(
          (1 - (level.stepMs - 60) / 260) * 0.5 +
            Math.min(1, level.foodTarget / 40) * 0.3 +
            Math.min(1, level.walls.length / 40) * 0.2
        ),
      },
    };
  },

  runtime: (l) => ({
    index: l.index, name: l.name, cols: l.cols, rows: l.rows, stepMs: l.stepMs,
    foodTarget: l.foodTarget, walls: l.walls, growPerFood: l.growPerFood,
    wrapEdges: l.wrapEdges, start: l.start, isRelief: l.isRelief,
  }),
};

const score01 = (x) => Math.round(Math.max(0, Math.min(1, x)) * 100);
