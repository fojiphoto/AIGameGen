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

/** Relief valleys pull the curve back, which shortens the level and lowers its tier ceiling. */
const RELIEF_FACTOR = 0.85;
/** And this cuts the hazard budget outright, so the valley is felt and not merely calculated. */
const RELIEF_HAZARD_FACTOR = 0.78;
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

// ── intensity envelope inside one level ─────────────────────────────────────

/**
 * How hard the level should be at each point along its own length, 0 to 1.
 *
 * The across-levels curve says how hard level 7 is compared to level 6. This says how hard
 * the middle of level 7 is compared to its opening — and without it, chunks were drawn from
 * one uniform distribution end to end, so a level was a flat wall of the same texture from
 * the first second to the last. Twenty of those in a row is why the ladder read as one level
 * repeating: adjacent levels differed only in a speed number, and nothing inside any of them
 * ever changed.
 *
 * The shape is the one this genre is built on: a quiet opening long enough to read the level,
 * a wave, a build, a real drop where the player gets to breathe, a second wave, the hardest
 * run of the level, and a short calm outro so the finish is a landing rather than an ambush.
 * Piecewise linear between the marks — smooth enough, and legible enough to reason about.
 */
export const PHASES = [
  { at: 0.00, i: 0.06 }, // intro     — read the level
  { at: 0.09, i: 0.12 },
  { at: 0.21, i: 0.50 }, // wave one
  { at: 0.34, i: 0.82 }, // build
  { at: 0.40, i: 0.15 }, // drop
  { at: 0.55, i: 0.15 }, // breather  — a plateau, not a notch. See below.
  { at: 0.64, i: 0.72 }, // wave two
  { at: 0.86, i: 1.00 }, // climax
  { at: 1.00, i: 0.25 }, // outro     — land the finish
];

/** The breather window, as a fraction of the level. Matches the plateau in PHASES. */
export const BREATHER_FROM = 0.40;
export const BREATHER_TO = 0.55;

/** Envelope value at fraction `u` through a level. Clamped, so overruns sit in the outro. */
export function phaseIntensity(u) {
  const x = Math.max(0, Math.min(1, u));
  for (let k = 1; k < PHASES.length; k++) {
    const a = PHASES[k - 1];
    const b = PHASES[k];
    if (x <= b.at) {
      const t = b.at === a.at ? 1 : (x - a.at) / (b.at - a.at);
      return a.i + (b.i - a.i) * t;
    }
  }
  return PHASES[PHASES.length - 1].i;
}

// ── per-level parameters ────────────────────────────────────────────────────

export function levelParams(level, config) {
  const d = config.difficulty;
  const p = config.progression;
  const t = p.levels > 1 ? (level - 1) / (p.levels - 1) : 0;
  const raw = applyCurve(t, d.curve);
  const isRelief = p.reliefLevels.includes(level);

  /**
   * Speed comes off the UNRELIEVED curve, so the game never slows down.
   *
   * Relief used to scale `eased` before anything read it, which pulled speed down with
   * everything else — level 15 came out at 413 px/s after level 14 at 415. Going backwards on
   * the one number the player can feel continuously reads as the game losing its nerve. A
   * valley is a drop in density, complexity and tier; the pace keeps climbing through it, and
   * that contrast is what makes a breather feel like relief rather than like a downgrade.
   */
  const speed = Math.round(lerp(d.speedStart, d.speedEnd, raw));
  const eased = isRelief ? raw * RELIEF_FACTOR : raw;
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

  /**
   * The pool is gated by feature unlock only. The TIER gate moved to per-slot, driven by
   * where in the level we are — see the envelope below. Applying one tier ceiling to a whole
   * level is what made every level a flat wall of the same thing.
   */
  const pool = CHUNKS.filter((c) => !c.needs || P.unlocked.has(c.needs));
  const rests = pool.filter((c) => c.items.length === 0);
  const active = pool.filter((c) => c.items.length > 0 && c.tier <= P.maxTier);
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

  const hazCount = (c) =>
    c.items.filter((it) => it.t === 'spike' || it.t === 'block' || it.t === 'gap' || it.t === 'ceil').length;
  const mean = (arr, f) => arr.reduce((s, c) => s + f(c), 0) / Math.max(1, arr.length);
  const meanW = mean(pool, (c) => c.w);
  const meanActiveW = mean(active, (c) => c.w);
  const meanHaz = mean(active, hazCount);

  /**
   * A level is a WIDTH budget, not a chunk-count budget, and the envelope is indexed against
   * that width.
   *
   * Two reasons, both found by measuring rather than by reasoning:
   *
   * Chunks run from 1.0 to 4.2 jump-spans wide, and the narrow ones are exactly the rests a
   * breather is made of — so counting chunks compressed the quiet stretches and stretched the
   * busy ones, and the dip landed around two thirds of the way in instead of at the 0.43 the
   * phase table asks for. The player experiences metres.
   *
   * And when the loop ran until the hazard budget was met, every rest the envelope spent
   * pushed the finish line further out: level 10 came out at 59 seconds, which on one life is
   * an endurance test rather than a level. Fixing the width means rests DISPLACE hazards
   * instead of postponing them, so a level's duration is a property of its position on the
   * ladder and nothing else.
   */
  const targetW = Math.max(1, P.chunks * meanW);

  /**
   * Hazard count is driven by the curve, not left to chunk luck — random selection let the
   * count swing 50% between adjacent levels, which once made level 19 easier than level 18.
   *
   * It is expressed as a fraction of what the width could hold if every slot were a hazard
   * chunk. Expressing it as a multiple of the chunk count instead is what produced the guard
   * bug below: the target could exceed what the level had room for, and the only way to
   * satisfy it was to refuse every rest.
   */
  const maxHaz = (targetW / Math.max(0.1, meanActiveW)) * meanHaz;
  /**
   * The top of the range is 0.75, not 1.0, and the slack is the point: it is the room the
   * breather lives in. A budget that consumes the whole width leaves nowhere to be quiet, and
   * the envelope has nothing to work with.
   */
  let targetHazards = Math.max(3, Math.round(maxHaz * lerp(0.55, 0.75, P.eased)));
  /**
   * A relief level takes a direct cut to its hazard budget, on top of the shorter length and
   * lower tier it already gets from the reduced `eased`.
   *
   * Those indirect effects came to about fifteen percent, which sounds like a dip and measured
   * as one or two hazards — inside the rounding, and invisible next to the run-to-run variation
   * in where chunks land. Relief levels were coming out as hard as the level before them and
   * sometimes harder. If a valley is going to be in the design it has to be big enough to feel,
   * so this is explicit and it is large.
   */
  if (P.isRelief) targetHazards = Math.max(3, Math.round(targetHazards * RELIEF_HAZARD_FACTOR));

  // Always open with a rest so the player sees the cube before anything happens.
  const sequence = [rests[0] ?? active[0]];
  let placed = 0;
  let accW = sequence[0].w;
  let breatherPlaced = false;

  for (let guard = 0; accW < targetW && guard < P.chunks * 5; guard++) {
    // Where we are inside this level, and how hard it should be right here.
    const u = accW / targetW;
    const local = phaseIntensity(u);

    /**
     * The level's own hardest chunks are reserved for the level's own hardest moment. A
     * single ceiling applied uniformly meant a level was the same texture end to end; the
     * envelope means the intro uses tier 1, the climax uses everything, and the breather
     * drops back to tier 1 again — which is the shape the genre is built on.
     */
    const tierCap = Math.max(1, Math.min(P.maxTier, Math.round(lerp(1, P.maxTier, local))));

    /**
     * Rest or hazard, decided from the density still owed rather than from a fixed chance.
     *
     * Earlier versions asked "can I afford a rest?" and then rolled a separate envelope-shaped
     * probability. Two things went wrong with that. The affordability guard was written in
     * slots (`shortfall < P.chunks - sequence.length`), which on the harder half of the ladder
     * is false on the first iteration and stays false — it read as "never rest" and silently
     * disabled the envelope, so levels 9 and 10 had no quiet stretch at all. And once the
     * budget WAS met nothing stopped the dice from placing more hazards, so the actual count
     * overshot the target by a random margin — which swamped the 15% relief dip and made
     * relief levels come out as hard as, or harder than, the level before.
     *
     * `hazardShare` is the fraction of the remaining width that has to be hazard chunks to
     * land on the budget. Resting is what happens with the width that is left over, and the
     * envelope only decides WHERE that spare width gets spent — heavily in the breather,
     * barely at all in the climax. Because the share is recomputed every slot, the level
     * self-corrects and finishes on its target instead of near it.
     */
    const inBreather = u >= BREATHER_FROM && u <= BREATHER_TO;
    const widthLeft = Math.max(0.1, targetW - accW);
    const hazardShare = Math.min(
      1,
      (((targetHazards - placed) / Math.max(0.1, meanHaz)) * meanActiveW) / widthLeft,
    );
    // Spend the spare width unevenly: the breather gets much more than its share, the climax
    // almost none. Averaged over the level this still lands on hazardShare.
    /**
     * The breather is PLACED, not rolled for.
     *
     * Three attempts at making it probabilistic all left levels where it simply did not
     * happen — a multiplier on the spare hazard share, then a floor under that, then a
     * stronger bias — because on a dense level there are only about four chunk slots inside
     * the window, and even a 90% rest chance misses often enough to matter. One level in fifty
     * coming out with no lull is one level in fifty that reads as a flat wall, and the whole
     * point of the envelope is that it is a design element rather than a tendency.
     *
     * So: on first entering the window, lay down a run of the longest rest available, wide
     * enough to fill it. The displaced hazards are not lost — `hazardShare` is recomputed from
     * the width that remains, so they come back in the waves either side, which is where they
     * belong. Total level width is unchanged, because the loop still terminates on `targetW`.
     */
    if (inBreather && !breatherPlaced) {
      breatherPlaced = true;
      const longRest = rests.reduce((a, b) => (b.w > a.w ? b : a), rests[0]);
      if (longRest) {
        const want = (BREATHER_TO - BREATHER_FROM) * targetW;
        for (let spent = 0; spent < want && accW < targetW; spent += longRest.w) {
          sequence.push(longRest);
          accW += longRest.w;
        }
        continue;
      }
    }

    /**
     * Everywhere else, resting is the default and the hazard budget is what buys it back; the
     * envelope decides how eagerly each part of the level spends.
     *
     * Written the other way round — rest chance as a multiple of the SPARE share — once the
     * budget was met the climax bias still pulled rest chance down to a quarter, so three
     * quarters of the remaining slots kept placing hazards and the level overshot its target
     * by a wide random margin. That overshoot is what swallowed the relief dip and let level 4
     * come out no easier than level 3.
     */
    const hazBias = lerp(0.55, 1.6, local);
    const restChance = Math.max(0, Math.min(0.92, 1 - hazardShare * hazBias));
    if (rests.length && rng.chance(restChance)) {
      // Through the breather take the longest rest available, so it reads as a stretch of
      // empty ground rather than a one-beat gap between hazards.
      const rest = inBreather ? rests.reduce((a, b) => (b.w > a.w ? b : a)) : rng.pick(rests);
      sequence.push(rest);
      accW += rest.w;
      continue;
    }

    const atTier = active.filter((c) => c.tier <= tierCap);
    const usable = atTier.length ? atTier : active;
    const chunk = rng.weighted(usable.map((c) => ({ ...c, weight: 6 - Math.abs(c.tier - tierCap) })));
    sequence.push(chunk);
    accW += chunk.w;
    placed += hazCount(chunk);
  }

  /**
   * A feature that is unlocked but never appears is a promise the level does not keep.
   *
   * `platformsFromLevel` said 3, and platforms first showed up at level 16. The tier gate was
   * quietly overruling the feature schedule: the cheapest platform chunk is tier 3, and the
   * tier ceiling does not reach 3 until much later, so the unlock fired and nothing changed.
   * Same for jump pads (cheapest chunk tier 4) and ceiling spikes (tier 5).
   *
   * So every unlocked feature is guaranteed at least one appearance, and the tier cap is
   * deliberately bypassed to do it. The chosen chunk is always the LOWEST-tier one for that
   * feature — introducing a mechanic with its gentlest form is what a designer would do, and
   * picking at random could open with `gap_to_plat` at level 3. The solver still has to sign
   * off on the result, and buildLevel retries with a fresh seed if it does not.
   */
  for (const feature of P.unlocked) {
    if (sequence.some((c) => c.needs === feature)) continue;
    const forFeature = CHUNKS.filter((c) => c.needs === feature);
    if (!forFeature.length) continue;
    const lowest = Math.min(...forFeature.map((c) => c.tier));
    const chunk = rng.pick(forFeature.filter((c) => c.tier === lowest));
    // Drop it into the second wave: warmed up, but short of the climax.
    sequence.splice(Math.max(1, Math.round(sequence.length * 0.62)), 0, chunk);
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
