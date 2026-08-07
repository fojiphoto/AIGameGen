/**
 * rhythm_dash — chunk library, level builder, and a real solver.
 *
 * THE VALIDATOR HERE IS A SOLVER, NOT A HEURISTIC.
 *
 * In this genre the player has exactly one input, usable only while grounded. That makes the
 * reachable state space small enough to search exhaustively: from any grounded x the player
 * either keeps running or jumps, a jump is a deterministic arc, and every landing puts them
 * back on a surface. So `solve()` runs a breadth-first search over grounded positions and
 * either returns a winning sequence of jump points or proves none exists.
 *
 * That matters more here than in any other genre in this repo. A single touch restarts the
 * level from zero, so one impossible spike does not cost the player a few seconds — it makes
 * the level permanently unwinnable, and they will keep retrying it believing they are bad at
 * it. Nothing ships without a proof.
 *
 * Chunks are authored in J units, where J is the horizontal distance of one full jump. J is
 * derived from the level's own speed, so a chunk written once is correct at every speed.
 */

import { makeRng, subSeed } from '../prng.mjs';
import { applyCurve } from '../curve.mjs';
import { VIEW_WIDTH, VIEW_HEIGHT } from '../physics.mjs';

export const GENRE_ID = 'rhythm_dash';

const RELIEF_FACTOR = 0.85;
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Fixed physics timestep, shared by the solver and the runtime.
 *
 * This is not a tuning knob — it is a contract. Euler integration error scales with dt, so if
 * the solver integrates at one step size and the game at another, their trajectories diverge
 * and the solver's proof stops describing the game. That is exactly what happened first time
 * round: the solver used dt = 5px/speed (which shrinks as levels get faster) while the scene
 * used raw frame time, and replaying the solver's own winning jump sequence died on level 3.
 *
 * It ships inside each level payload rather than being duplicated as a constant in the engine,
 * so the two cannot drift apart again.
 */
export const SIM_DT = 1 / 120;

// ── physics helpers ─────────────────────────────────────────────────────────

export const body = (cfg) => cfg.player.size * cfg.player.hitboxScale;
export const airTime = (cfg) => (2 * Math.abs(cfg.player.jumpVelocity)) / cfg.player.gravity;
export const jumpPeak = (cfg) => (cfg.player.jumpVelocity ** 2) / (2 * cfg.player.gravity);
/** J — horizontal distance covered by one complete jump at this level's speed. */
export const jumpSpan = (cfg, speed) => airTime(cfg) * speed;

// ── chunk library ───────────────────────────────────────────────────────────
//
// Every position and size is in J units (x) or body units (h). `tier` is 1 (trivial) to 5
// (tight). `needs` gates a chunk behind a feature unlock so mechanics arrive gradually.

/**
 * Spike footprint: narrow and roughly as tall as the cube.
 *
 * These were 0.16 J wide by 0.62 body tall, which at a typical jump span works out around
 * 47px by 18px — a squat wedge that read as a bump in the floor rather than as something
 * lethal, and looked nothing like the genre it is selling. A spike wants to be about as tall
 * as it is wide and about as tall as the player.
 *
 * Both moves are in the safe direction for the proof. Narrower means less horizontal span to
 * clear in one arc. Taller matters only against the jump peak, and the schema already refuses
 * any config whose peak is under 1.9 bodies, so a 0.95-body spike has better than two bodies
 * of headroom at the worst legal tuning. The solver re-runs on every build regardless, and
 * `every level of every generated game is finishable` would fail if either assumption were wrong.
 */
const SPIKE_W = 0.1;
const SPIKE_H = 0.95;

export const CHUNKS = [
  // ── tier 1: read the shape, take one jump ────────────────────────────────
  { id: 'rest', tier: 1, w: 1.0, needs: null, items: [] },
  { id: 'rest_long', tier: 1, w: 1.8, needs: null, items: [] },
  {
    id: 'spike', tier: 1, w: 2.0, needs: null,
    items: [{ t: 'spike', x: 0.75, w: SPIKE_W, h: SPIKE_H }],
  },
  {
    id: 'block', tier: 1, w: 2.2, needs: null,
    items: [{ t: 'block', x: 0.8, w: 0.3, h: 0.85 }],
  },

  // ── tier 2: two beats, or a first hole ───────────────────────────────────
  {
    id: 'spike_pair', tier: 2, w: 3.0, needs: null,
    items: [
      { t: 'spike', x: 0.7, w: SPIKE_W, h: SPIKE_H },
      { t: 'spike', x: 1.85, w: SPIKE_W, h: SPIKE_H },
    ],
  },
  {
    id: 'spike_block', tier: 2, w: 3.0, needs: null,
    items: [
      { t: 'spike', x: 0.7, w: SPIKE_W, h: SPIKE_H },
      { t: 'block', x: 1.9, w: 0.3, h: 0.85 },
    ],
  },
  {
    id: 'gap_small', tier: 2, w: 2.4, needs: 'gaps',
    items: [{ t: 'gap', x: 0.72, w: 0.34 }],
  },

  // ── tier 3: one jump clears two, or land on something ────────────────────
  {
    // Both spikes sit inside a single arc, so this is one jump rather than two.
    id: 'spike_double', tier: 3, w: 2.4, needs: null,
    items: [
      { t: 'spike', x: 0.66, w: SPIKE_W, h: SPIKE_H },
      { t: 'spike', x: 0.9, w: SPIKE_W, h: SPIKE_H },
    ],
  },
  {
    id: 'platform_step', tier: 3, w: 3.0, needs: 'platforms',
    items: [{ t: 'plat', x: 0.7, w: 0.9, h: 1.0 }],
  },
  {
    id: 'spike_run', tier: 3, w: 4.2, needs: null,
    items: [
      { t: 'spike', x: 0.7, w: SPIKE_W, h: SPIKE_H },
      { t: 'spike', x: 1.8, w: SPIKE_W, h: SPIKE_H },
      { t: 'spike', x: 2.9, w: SPIKE_W, h: SPIKE_H },
    ],
  },

  // ── tier 4: combinations ─────────────────────────────────────────────────
  {
    id: 'gap_wide', tier: 4, w: 2.8, needs: 'gaps',
    items: [{ t: 'gap', x: 0.7, w: 0.52 }],
  },
  {
    id: 'plat_over_spike', tier: 4, w: 3.6, needs: 'platforms',
    items: [
      { t: 'spike', x: 0.72, w: SPIKE_W, h: SPIKE_H },
      { t: 'plat', x: 1.5, w: 0.9, h: 1.15 },
    ],
  },
  {
    id: 'pad_launch', tier: 4, w: 3.4, needs: 'pads',
    items: [
      { t: 'pad', x: 0.6, w: 0.3, boost: 1.5 },
      { t: 'block', x: 1.5, w: 0.4, h: 1.7 },
    ],
  },

  // ── tier 5: tight timing ─────────────────────────────────────────────────
  {
    id: 'spike_triple_tight', tier: 5, w: 3.2, needs: null,
    items: [
      { t: 'spike', x: 0.62, w: SPIKE_W, h: SPIKE_H },
      { t: 'spike', x: 0.86, w: SPIKE_W, h: SPIKE_H },
      { t: 'spike', x: 2.0, w: SPIKE_W, h: SPIKE_H },
    ],
  },
  {
    id: 'gap_to_plat', tier: 5, w: 3.8, needs: 'platforms',
    items: [
      { t: 'gap', x: 0.7, w: 0.44 },
      { t: 'plat', x: 1.6, w: 1.0, h: 1.1 },
    ],
  },
  {
    id: 'ceiling_squeeze', tier: 5, w: 3.4, needs: 'ceiling',
    items: [
      { t: 'ceil', x: 0.9, w: 0.5, h: 0.7 },
      { t: 'spike', x: 2.2, w: SPIKE_W, h: SPIKE_H },
    ],
  },
];

const FEATURE_KEY = {
  platforms: 'platformsFromLevel',
  gaps: 'gapsFromLevel',
  pads: 'jumpPadsFromLevel',
  ceiling: 'ceilingSpikesFromLevel',
};

// ── per-level parameters ────────────────────────────────────────────────────

export function levelParams(level, config) {
  const d = config.difficulty;
  const p = config.progression;
  const t = p.levels > 1 ? (level - 1) / (p.levels - 1) : 0;
  let eased = applyCurve(t, d.curve);
  const isRelief = p.reliefLevels.includes(level);
  if (isRelief) eased *= RELIEF_FACTOR;

  const speed = Math.round(lerp(d.speedStart, d.speedEnd, eased));
  let chunks = Math.round(lerp(d.chunksStart, d.chunksEnd, eased));
  if (isRelief) chunks = Math.max(4, Math.round(chunks * 0.85));
  const maxTier = Math.max(1, Math.round(lerp(d.tierStart, d.tierEnd, eased)));
  const breather = lerp(d.breatherRatioStart, d.breatherRatioEnd, eased);

  const unlocked = new Set();
  for (const [key, field] of Object.entries(FEATURE_KEY)) {
    const from = config.features[field];
    if (from > 0 && level >= from) unlocked.add(key);
  }
  const newFeatures = Object.entries(FEATURE_KEY)
    .filter(([, field]) => config.features[field] === level)
    .map(([key]) => key);

  const gravityFlip = config.features.gravityFlipFromLevel > 0 && level >= config.features.gravityFlipFromLevel;

  return { level, eased, isRelief, speed, chunks, maxTier, breather, unlocked, newFeatures, gravityFlip };
}

// ── level builder ───────────────────────────────────────────────────────────

export function buildLevel(config, level, baseSeed, attempt = 0) {
  const P = levelParams(level, config);
  const rng = makeRng(subSeed(baseSeed, `D${level}#${attempt}`));

  const J = jumpSpan(config, P.speed);
  const B = body(config);
  const groundTop = VIEW_HEIGHT - config.world.groundHeight;

  const pool = CHUNKS.filter((c) => c.tier <= P.maxTier && (!c.needs || P.unlocked.has(c.needs)));
  const rests = pool.filter((c) => c.items.length === 0);
  const active = pool.filter((c) => c.items.length > 0);
  if (!active.length) {
    return { level: null, fatal: `no usable chunk at level ${level} (tier<=${P.maxTier})` };
  }

  // A generous run-in so the first obstacle is never a surprise.
  let x = Math.max(VIEW_WIDTH * 0.9, P.speed * 1.5);
  const obstacles = [];
  const gaps = [];
  const pads = [];
  const platforms = [];
  const used = [];

  /**
   * Hazard count is driven by the curve, not left to chunk luck.
   *
   * Selecting chunks purely at random let the hazard count swing by 50% between adjacent
   * levels, which showed up as a real regression: level 19 came out measurably easier than
   * level 18. Targeting a hazard budget makes the ramp monotonic by construction instead of
   * hoping the dice cooperate.
   */
  const targetHazards = Math.max(2, Math.round(P.chunks * lerp(0.45, 1.15, P.eased)));

  // Always open with a rest so the player sees the cube before anything happens.
  const sequence = [rests[0] ?? active[0]];
  let placed = 0;
  const weighted = active.map((c) => ({ ...c, weight: 6 - Math.abs(c.tier - P.maxTier) }));

  for (let i = 1; i < P.chunks * 2 && sequence.length < P.chunks * 1.6; i++) {
    const shortfall = targetHazards - placed;
    const remaining = Math.max(1, P.chunks - sequence.length);
    // Take a breather only when the hazard budget is comfortably on track.
    const canRest = rests.length && shortfall < remaining && rng.chance(P.breather);
    if (canRest) {
      sequence.push(rng.pick(rests));
      continue;
    }
    const chunk = rng.weighted(weighted);
    sequence.push(chunk);
    placed += chunk.items.filter((it) => it.t === 'spike' || it.t === 'block' || it.t === 'gap' || it.t === 'ceil').length;
    if (placed >= targetHazards && sequence.length >= P.chunks) break;
  }

  for (const chunk of sequence) {
    used.push(chunk.id);
    for (const it of chunk.items) {
      const ix = x + it.x * J;
      switch (it.t) {
        case 'spike':
          obstacles.push({ kind: 'spike', x: Math.round(ix), w: Math.round(it.w * J), h: Math.round(it.h * B), y: 0 });
          break;
        case 'block':
          obstacles.push({ kind: 'block', x: Math.round(ix), w: Math.round(it.w * J), h: Math.round(it.h * B), y: 0 });
          break;
        case 'plat':
          platforms.push({ x: Math.round(ix), w: Math.round(it.w * J), h: Math.round(it.h * B) });
          break;
        case 'gap':
          gaps.push({ x: Math.round(ix), w: Math.round(it.w * J) });
          break;
        case 'pad':
          pads.push({ x: Math.round(ix), w: Math.round(it.w * J), boost: it.boost ?? 1.5 });
          break;
        case 'ceil':
          obstacles.push({
            kind: 'ceil', x: Math.round(ix), w: Math.round(it.w * J),
            h: Math.round(it.h * B), y: 0,
          });
          break;
        default:
          break;
      }
    }
    x += chunk.w * J;
  }

  // Clean finish: a full jump of empty runway after the last obstacle.
  const lengthPx = Math.round(x + J * 1.2);

  const built = {
    index: level,
    name: config.copy.levelNames[level - 1] ?? `Level ${level}`,
    speed: P.speed,
    lengthPx,
    groundTop,
    ceilingHeight: config.world.ceilingHeight,
    obstacles,
    platforms,
    gaps,
    pads,
    gravityFlip: P.gravityFlip,
    chunksUsed: used,
    newFeatures: P.newFeatures,
    isRelief: P.isRelief,
    estSeconds: Math.round((lengthPx / P.speed) * 10) / 10,
    attempt,
    notes: [],
  };

  // Prove it before returning it.
  const proof = solve(built, config);
  built.solution = proof.ok ? proof.jumps : null;
  built.solverStates = proof.states;
  if (!proof.ok) {
    return { level: built, fatal: null, unsolved: proof.reason };
  }
  return { level: built, fatal: null };
}

// ── the solver ──────────────────────────────────────────────────────────────

/** Highest standable surface at x, or null when x is over a hole. */
function surfaceAt(level, x, w) {
  let top = null;
  const overGap = level.gaps.some((g) => x + w > g.x + 2 && x < g.x + g.w - 2);
  if (!overGap) top = level.groundTop;
  for (const p of level.platforms) {
    if (x + w > p.x && x < p.x + p.w) {
      const pt = level.groundTop - p.h;
      if (top === null || pt < top) top = pt;
    }
  }
  return top;
}

/**
 * Safety margin the SOLVER adds to every hazard — it is deliberately stricter than the game.
 *
 * A solution that clears a spike by a fraction of a pixel is a proof of nothing useful. The
 * first version of this solver produced exactly that: a planned jump fired two pixels late
 * (one 60 Hz input frame) missed by 0.3 px and died, on a level the solver called solvable.
 * Inflating hazards here means every route it returns clears with real room, so ordinary human
 * input precision is enough. Erring in this direction can only ever reject a level that was
 * technically passable — never accept one that is not.
 */
const SOLVER_PAD_Y = 10;
const SOLVER_PAD_X = 6;

/** Does the cube's box intersect anything deadly at this position? Solver-side, padded. */
function deadly(level, x, feetY, size) {
  const x1 = x - SOLVER_PAD_X;
  const x2 = x + size + SOLVER_PAD_X;
  const top = feetY - size;
  for (const o of level.obstacles) {
    if (x2 <= o.x || x1 >= o.x + o.w) continue;
    if (o.kind === 'ceil') {
      const bottom = (level.ceilingHeight || 0) + o.h + SOLVER_PAD_Y;
      if (top < bottom) return true;
      continue;
    }
    // Spikes and blocks are lethal from the side and from below their top edge. Landing
    // cleanly on a block's top surface is handled by surfaceAt via platforms, so anything
    // that reaches into the obstacle's body here is a hit.
    const oTop = level.groundTop - o.h - SOLVER_PAD_Y;
    if (feetY > oTop + 1) return true;
  }
  return false;
}

/**
 * Exhaustive search over grounded positions, minimising the number of jumps.
 *
 * From a grounded state the player may keep running or jump. Running is a single step;
 * jumping follows a fixed arc that ends on a surface, in an obstacle, or off the bottom of
 * the level. A grounded state is fully described by (x, surface), so the visited set stays
 * small and the search is exhaustive rather than sampled.
 *
 * It is a 0-1 BFS (deque), not a plain queue: running costs 0 and is pushed to the front,
 * jumping costs 1 and is pushed to the back. Plain BFS minimises state *transitions*, and
 * since a jump covers far more ground than a step it happily returns a route that jumps
 * eighteen times through four obstacles — technically a proof, but useless as a difficulty
 * signal and nothing like how a person would play it. Minimising jumps yields the intended
 * line, which is what `jumpsNeeded` and the death-hint both want.
 *
 * @returns {{ok:boolean, jumps:number[]|null, states:number, reason:string|null}}
 */
export function solve(level, config) {
  const size = body(config);
  const g = config.player.gravity;
  const v0 = config.player.jumpVelocity;
  const speed = level.speed;
  // STEP is the search grid (where the player may choose to jump); SIM_DT is the physics
  // step. They are deliberately independent — coupling them is what broke this before.
  const STEP = 5;
  const MAX_STATES = 240_000;

  const startSurface = surfaceAt(level, 0, size);
  if (startSurface === null) return { ok: false, jumps: null, states: 0, reason: 'the level starts over a hole' };

  const key = (x, y) => `${Math.round(x / STEP)}:${Math.round(y / 4)}`;
  const startKey = key(0, startSurface);
  // Cheapest known jump-count to reach each state. Relaxed on POP, not on push: marking a
  // state visited when it is first *queued* lets a costly route claim it before a cheaper
  // one is examined, which silently breaks the "fewest jumps" guarantee.
  const dist = new Map([[startKey, 0]]);
  const dq = [{ x: 0, y: startSurface, cost: 0, jumps: [] }];
  let states = 0;
  let best = null;

  while (dq.length) {
    const s = dq.shift();
    const k = key(s.x, s.y);
    if (s.cost > (dist.get(k) ?? Infinity)) continue; // stale entry, a cheaper one won
    if (++states > MAX_STATES) {
      return { ok: false, jumps: null, states, reason: 'search space exhausted before finding a route' };
    }
    if (s.x >= level.lengthPx) {
      best = s.jumps;
      break; // first pop past the finish line is the cheapest route to it
    }

    const relax = (nx, ny, cost, jumps, front) => {
      const nk = key(nx, ny);
      if (cost >= (dist.get(nk) ?? Infinity)) return;
      dist.set(nk, cost);
      const node = { x: nx, y: ny, cost, jumps };
      if (front) dq.unshift(node);
      else dq.push(node);
    };

    // ── option A: keep running (cost 0) ─────────────────────────────────
    const nx = s.x + STEP;
    const nSurface = surfaceAt(level, nx, size);
    const sameLevel = nSurface !== null && Math.abs(nSurface - s.y) < 2;
    // Stepping off a platform edge onto lower ground is a fall, not a death.
    const steppedDown = nSurface !== null && nSurface > s.y + 1;
    if ((sameLevel || steppedDown) && !deadly(level, nx, nSurface, size)) {
      relax(nx, nSurface, s.cost, s.jumps, true);
    }

    // ── option B: jump from here (cost 1) ───────────────────────────────
    // A pad under the cube multiplies the impulse; that is not optional, so it is folded
    // into the arc rather than treated as a separate choice.
    const pad = level.pads.find((p) => s.x + size > p.x && s.x < p.x + p.w);
    const impulse = v0 * (pad ? pad.boost : 1);
    const land = arc(level, s.x, s.y, impulse, g, speed, size);
    if (land) {
      relax(land.x, land.y, s.cost + 1, [...s.jumps, Math.round(s.x)], false);
    }
  }

  if (best) return { ok: true, jumps: best, states, reason: null };
  return { ok: false, jumps: null, states, reason: 'no sequence of jumps reaches the end' };
}

/**
 * Integrate one jump at SIM_DT — the same step the runtime uses, in the same order
 * (velocity, then position). Returns the landing state, or null if it kills the player.
 */
function arc(level, x0, y0, v0, g, speed, size) {
  const dt = SIM_DT;
  let x = x0;
  let y = y0;
  let vy = v0;
  for (let i = 0; i < 8000; i++) {
    vy += g * dt;
    y += vy * dt;
    x += speed * dt;

    if (x >= level.lengthPx) return { x, y, finished: true };
    if (y - size < (level.ceilingHeight || 0) - 1 && level.ceilingHeight) {
      // bumped the ceiling: stop rising rather than pass through it
      y = (level.ceilingHeight || 0) + size;
      vy = Math.max(0, vy);
    }
    if (deadly(level, x, y, size)) return null;

    const surface = surfaceAt(level, x, size);
    if (vy > 0 && surface !== null && y >= surface) {
      return { x, y: surface, finished: false };
    }
    if (y > VIEW_HEIGHT + 200) return null; // fell out of the level
  }
  return null;
}

// ── validator ───────────────────────────────────────────────────────────────

export function validateLevel(level, config) {
  const reasons = [];
  const warnings = [];
  const size = body(config);
  const J = jumpSpan(config, level.speed);

  // 1 — the level must be provably completable
  if (!level.solution) {
    const proof = solve(level, config);
    if (!proof.ok) {
      reasons.push(`no route to the end: ${proof.reason} (searched ${proof.states} states)`);
    } else {
      level.solution = proof.jumps;
    }
  }

  // 2 — every obstacle must be individually clearable by a jump
  const peak = jumpPeak(config);
  for (const o of level.obstacles) {
    if (o.kind === 'ceil') continue;
    if (o.h + 6 > peak) {
      reasons.push(`${o.kind} at ${o.x}px is ${o.h}px tall but the jump only peaks at ${Math.round(peak)}px`);
      break;
    }
  }

  // 3 — no gap wider than a jump can cross
  for (const gp of level.gaps) {
    if (gp.w + size > J * 0.86) {
      reasons.push(`gap at ${gp.x}px is ${gp.w}px wide; a jump covers ${Math.round(J)}px and must also carry the cube`);
      break;
    }
  }

  // 4 — reaction time on the opening obstacle
  const first = Math.min(
    ...[...level.obstacles.map((o) => o.x), ...level.gaps.map((g) => g.x), Infinity]
  );
  if (Number.isFinite(first)) {
    const runwaySeconds = (first - VIEW_WIDTH * 0.16) / level.speed;
    if (runwaySeconds < 0.75) {
      reasons.push(`first hazard arrives after ${runwaySeconds.toFixed(2)}s — needs 0.75s of run-in`);
    }
  }

  // 5 — density band. Too sparse is boring, too dense is unreadable even when solvable.
  const hazards = level.obstacles.length + level.gaps.length;
  const perSecond = hazards / Math.max(1, level.estSeconds);
  if (perSecond > 3.4) reasons.push(`${perSecond.toFixed(2)} hazards/s is unreadable`);
  if (perSecond < 0.3) warnings.push(`sparse: ${perSecond.toFixed(2)} hazards/s`);

  // 6 — level length. A restart-from-zero genre punishes long levels hard.
  if (level.estSeconds > 95) reasons.push(`${level.estSeconds}s is too long for a genre that restarts on every death`);

  const jumpsNeeded = level.solution ? level.solution.length : 0;
  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    metrics: {
      obstacleCount: hazards,
      seconds: level.estSeconds,
      density: Math.round(perSecond * 100) / 100,
      jumpsNeeded,
      solverStates: level.solverStates ?? 0,
      estimatedDifficulty: score(level, config, perSecond, jumpsNeeded),
    },
  };
}

function score(level, config, perSecond, jumps) {
  const d = config.difficulty;
  const speedTerm = (level.speed - d.speedStart) / Math.max(1, d.speedEnd - d.speedStart);
  const densityTerm = Math.min(1, perSecond / 3.4);
  const lengthTerm = Math.min(1, level.estSeconds / 90);
  const jumpTerm = Math.min(1, jumps / 40);
  const v = 0.34 * speedTerm + 0.3 * densityTerm + 0.18 * lengthTerm + 0.18 * jumpTerm;
  return Math.round(Math.max(0, Math.min(100, v * 100)));
}

/** Flat payload for the Phaser scene. The solution ships too — it powers a hint after repeated deaths. */
export function runtimeLevel(l) {
  return {
    index: l.index, name: l.name, speed: l.speed, lengthPx: l.lengthPx,
    // Shipped so the scene integrates at exactly the step the solver proved against.
    simDt: SIM_DT,
    groundTop: l.groundTop, ceilingHeight: l.ceilingHeight,
    obstacles: l.obstacles, platforms: l.platforms, gaps: l.gaps, pads: l.pads,
    gravityFlip: l.gravityFlip, newFeatures: l.newFeatures, isRelief: l.isRelief,
    jumpsNeeded: l.solution ? l.solution.length : 0,
  };
}
