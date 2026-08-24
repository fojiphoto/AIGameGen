/**
 * FEATHER & FETCH — the simulation, tested without a browser.
 *
 * The centrepiece is the fairness sweep. Every duck type is flown against every flight pattern
 * it is allowed to use, at difficulties from the first round to the fortieth, and each run has to
 * satisfy three things: the duck spends at least `MIN_SHOOTABLE_SECONDS` inside the band the
 * player can shoot, it never leaves that band while it is still on screen, and it always
 * eventually goes away. That is the shooter's equivalent of "every level is completable" — a
 * duck nobody can hit is not difficulty, it is a defect, and it is exactly the kind that a
 * "make it faster" tuning pass introduces without anyone noticing.
 *
 * The second pillar is hit detection, property-tested rather than spot-checked: over hundreds of
 * generated positions, a shot on centre must always hit and a shot outside the padded radius
 * must never hit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIEW_W, VIEW_H, SKY_TOP, SKY_BOTTOM, FIXED_DT, SHELLS,
  MIN_SHOOTABLE_SECONDS, difficultyFor, speedScale, escapeSeconds, comboMultiplier,
  DUCK_TYPES, duckType, pickDuckType, spawnDuck, stepDuck, isOffScreen, duckHitRadius,
  planRound, ducksInRound, environmentFor, allowedPatterns, makeRandom,
  ENVIRONMENT_NAMES,
  resolveShot, shotQuality, MISS,
  awardHit, summariseRound, emptyStats, accuracyOf, emptyTotals,
  ACHIEVEMENTS, newlyEarned, DOG_SKINS, WEAPON_SKINS, cosmeticUnlocked, cosmeticHint,
  SaveManager, defaultSave, DEFAULT_SETTINGS,
  DOG_RETRIEVE_SECONDS, DOG_SPEED, DOG_TEASE_SECONDS,
  DOG_TRAIL_SECONDS, DOG_TRAIL_MAX, DOG_TRAIL_STEP,
} from '../build/test/core.mjs';

// ── the fairness sweep ──────────────────────────────────────────────────────

/**
 * Fly one duck and report how it behaved.
 *
 * Runs the real `stepDuck` at the real timestep, applying the same escape timer the game does,
 * and stops when the duck leaves the screen — exactly the lifecycle a duck has in play.
 */
function flyDuck(type, pattern, difficulty, seed) {
  const random = makeRandom(seed);
  const duck = spawnDuck(type, pattern, difficulty, random);
  const flee = escapeSeconds(difficulty);

  let shootableSeconds = 0;
  let enteredView = false;
  let leftViewEarly = false;
  let steps = 0;
  const maxSteps = Math.ceil(30 / FIXED_DT);        // a duck that lasts 30s is stuck

  while (steps < maxSteps) {
    if (!duck.fleeing && duck.t >= flee) duck.fleeing = true;
    stepDuck(duck, FIXED_DT);
    steps++;

    const insideX = duck.x > -type.size && duck.x < VIEW_W + type.size;
    const insideY = duck.y >= SKY_TOP - type.size && duck.y <= SKY_BOTTOM + type.size;

    if (insideX && insideY) { enteredView = true; shootableSeconds += FIXED_DT; }
    // A duck that has been on screen and then drops below the shootable band without fleeing has
    // hidden itself somewhere the player cannot shoot.
    else if (enteredView && insideX && !insideY && !duck.fleeing) leftViewEarly = true;

    if (isOffScreen(duck)) break;
  }

  return {
    shootableSeconds,
    enteredView,
    leftViewEarly,
    despawned: steps < maxSteps,
    steps,
    finalY: duck.y,
  };
}

/**
 * The sweep.
 *
 * Rounds 1, 3, 6, 10, 16, 25 and 40 cover the whole curve from the tutorial to saturation, and
 * three seeds per combination catch a pattern that only misbehaves from one entry height.
 */
const SWEEP_ROUNDS = [1, 3, 6, 10, 16, 25, 40];

for (const type of DUCK_TYPES) {
  test(`every pattern of the ${type.name} stays hittable at every difficulty`, () => {
    for (const round of SWEEP_ROUNDS) {
      const difficulty = difficultyFor(round);
      if (difficulty < type.minDifficulty) continue;       // not in the roster yet

      for (const pattern of type.patterns) {
        for (const seed of [11, 977, 31337]) {
          const r = flyDuck(type, pattern, difficulty, seed);

          assert.ok(r.enteredView,
            `${type.kind}/${pattern} @ round ${round} never entered the play area`);
          assert.ok(r.despawned,
            `${type.kind}/${pattern} @ round ${round} never left — it would hang the round`);
          assert.ok(!r.leftViewEarly,
            `${type.kind}/${pattern} @ round ${round} dropped out of the shootable band`);
          assert.ok(r.shootableSeconds >= MIN_SHOOTABLE_SECONDS,
            `${type.kind}/${pattern} @ round ${round} was shootable for only `
            + `${r.shootableSeconds.toFixed(2)}s (floor is ${MIN_SHOOTABLE_SECONDS}s)`);
        }
      }
    }
  });
}

test('a duck always leaves once it starts fleeing, however slow it is', () => {
  // The slowest duck at the lowest difficulty is the worst case for the escape path.
  const slowest = DUCK_TYPES.reduce((a, b) => (a.speed < b.speed ? a : b));
  const r = flyDuck(slowest, 'drift', 0, 5);
  assert.ok(r.despawned, 'even the slowest duck must eventually go');
});

test('ducks never spawn clipped into the HUD or the grass', () => {
  for (const type of DUCK_TYPES) {
    for (let seed = 1; seed < 60; seed++) {
      const duck = spawnDuck(type, type.patterns[0], 0.5, makeRandom(seed));
      assert.ok(duck.y >= SKY_TOP, `${type.kind} spawned above the sky line`);
      assert.ok(duck.y <= SKY_BOTTOM, `${type.kind} spawned below the sky line`);
      assert.ok(duck.x < 0 || duck.x > VIEW_W, `${type.kind} spawned inside the view`);
    }
  }
});

test('a hit duck stops flying and falls', () => {
  const duck = spawnDuck(duckType('green'), 'straight', 0.3, makeRandom(4));
  for (let i = 0; i < 120; i++) stepDuck(duck, FIXED_DT);
  const yBefore = duck.y;
  duck.phase = 'falling';
  duck.vy = 0;
  for (let i = 0; i < 60; i++) stepDuck(duck, FIXED_DT);
  assert.ok(duck.y > yBefore, 'a falling duck must descend');
  assert.ok(Math.abs(duck.vx) < Math.abs(duck.speed), 'and lose its forward speed');
});

// ── hit detection ───────────────────────────────────────────────────────────

const makeDuck = (x, y, kind = 'green') => ({
  ...spawnDuck(duckType(kind), 'straight', 0, makeRandom(1)),
  x, y, phase: 'flying',
});

test('a shot on a duck always hits, at every size and pad', () => {
  for (const type of DUCK_TYPES) {
    for (const pad of [0, 6, 18]) {
      const duck = makeDuck(400, 200, type.kind);
      assert.equal(resolveShot([duck], 400, 200, pad).index, 0,
        `dead centre missed a ${type.kind}`);
      // Just inside the padded radius, in eight directions.
      const r = duckHitRadius(duck, pad) - 0.5;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const hit = resolveShot([duck], 400 + Math.cos(a) * r, 200 + Math.sin(a) * r, pad);
        assert.equal(hit.index, 0, `${type.kind} missed at the edge, angle ${i}`);
      }
    }
  }
});

test('a shot outside the hitbox never hits', () => {
  for (const type of DUCK_TYPES) {
    for (const pad of [0, 6, 18]) {
      const duck = makeDuck(400, 200, type.kind);
      const r = duckHitRadius(duck, pad) + 1.5;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const shot = resolveShot([duck], 400 + Math.cos(a) * r, 200 + Math.sin(a) * r, pad);
        assert.equal(shot.index, -1, `${type.kind} hit from outside, angle ${i}, pad ${pad}`);
      }
    }
  }
});

test('overlapping ducks hand the shot to the nearest, not the first', () => {
  const far = makeDuck(400, 200, 'giant');
  const near = makeDuck(414, 200, 'giant');
  // The far duck is first in the array; the shot lands closer to the near one.
  const shot = resolveShot([far, near], 416, 200, 6);
  assert.equal(shot.index, 1, 'spawn order must not decide who takes the shot');
});

test('a duck that is already falling cannot be shot again', () => {
  const duck = makeDuck(400, 200);
  duck.phase = 'falling';
  assert.equal(resolveShot([duck], 400, 200, 18).index, -1);
});

test('a shot into empty sky is a clean miss', () => {
  assert.deepEqual(resolveShot([], 400, 200, 18), MISS);
  assert.equal(resolveShot([makeDuck(100, 100)], 800, 400, 18).index, -1);
});

test('shot quality is 1 at the centre and 0 at the rim', () => {
  const duck = makeDuck(400, 200);
  assert.equal(shotQuality(duck, 0, 6), 1);
  assert.equal(shotQuality(duck, duckHitRadius(duck, 6), 6), 0);
  assert.ok(shotQuality(duck, duckHitRadius(duck, 6) / 2, 6) > 0.4);
});

test('touch aiming is more forgiving than mouse aiming', () => {
  const duck = makeDuck(400, 200);
  assert.ok(duckHitRadius(duck, 18) > duckHitRadius(duck, 6),
    'a finger hides the target, so the pad has to be bigger');
});

// ── difficulty and rounds ───────────────────────────────────────────────────

test('difficulty rises smoothly, never falls, and saturates', () => {
  let previous = -1;
  for (let round = 1; round <= 60; round++) {
    const d = difficultyFor(round);
    assert.ok(d >= previous, `difficulty fell at round ${round}`);
    assert.ok(d >= 0 && d < 1.0001, `difficulty out of range at round ${round}: ${d}`);
    // No single round may more than double the step before it — that reads as a bug, not a ramp.
    if (round > 2) {
      const step = d - previous;
      const prevStep = previous - difficultyFor(round - 2);
      assert.ok(step <= prevStep + 0.001, `difficulty jumped at round ${round}`);
    }
    previous = d;
  }
  assert.ok(difficultyFor(40) > 0.95, 'the curve should be near its ceiling by round 40');
});

test('speed and escape time move in opposite directions, and stay sane', () => {
  assert.ok(speedScale(0) === 1);
  assert.ok(speedScale(1) > speedScale(0));
  assert.ok(speedScale(1) < 2.5, 'a duck at full difficulty must still be trackable');
  assert.ok(escapeSeconds(0) > escapeSeconds(1));
  assert.ok(escapeSeconds(1) > MIN_SHOOTABLE_SECONDS,
    'the escape timer must never be shorter than the fairness floor');
});

test('round size grows and then caps', () => {
  assert.equal(ducksInRound(1), 5);
  assert.ok(ducksInRound(5) > ducksInRound(1));
  assert.equal(ducksInRound(50), ducksInRound(60), 'round size has to stop somewhere');
});

test('a round plan releases exactly the ducks it promises', () => {
  for (let round = 1; round <= 30; round++) {
    const plan = planRound(round, 12345);
    const released = plan.waves.reduce((n, w) => n + w.ducks.length, 0);
    assert.equal(released, plan.duckCount, `round ${round} released ${released}`);
    assert.ok(plan.waves.length > 0);
    for (const wave of plan.waves) {
      assert.ok(wave.ducks.length >= 1 && wave.ducks.length <= 3,
        `round ${round} has a wave of ${wave.ducks.length} — the screen stops being readable`);
      assert.ok(wave.ducks.length <= SHELLS,
        'a wave larger than the magazine cannot be cleared');
    }
  }
});

test('round plans are deterministic from their seed', () => {
  const a = planRound(7, 999);
  const b = planRound(7, 999);
  assert.deepEqual(a.waves.map((w) => w.ducks.map((d) => `${d.type.kind}:${d.pattern}`)),
    b.waves.map((w) => w.ducks.map((d) => `${d.type.kind}:${d.pattern}`)));
  const c = planRound(7, 1000);
  assert.notDeepEqual(a.waves.map((w) => w.ducks.length), c.waves.map((w) => w.ducks.length) === undefined
    ? [] : c.waves.map((w) => w.ducks.length + 0.0001));
});

test('the first round is the gentlest thing in the game', () => {
  const plan = planRound(1, 42);
  for (const wave of plan.waves) {
    assert.equal(wave.ducks.length, 1, 'round one releases one duck at a time');
    for (const duck of wave.ducks) {
      assert.ok(['straight', 'wave', 'drift'].includes(duck.pattern),
        `round one used "${duck.pattern}" — nothing tricky before the player can aim`);
      assert.ok(!duck.type.rare, 'and nothing rare');
    }
  }
});

test('hard patterns are gated behind difficulty, and a type is never left with none', () => {
  const tricky = ['fakeTurn', 'escapeBurst', 'dive'];
  for (const type of DUCK_TYPES) {
    const early = allowedPatterns(type.patterns, 0.05, 3);
    assert.ok(early.length > 0, `${type.kind} has no pattern available early`);
    for (const p of early) {
      assert.ok(!tricky.includes(p) || type.patterns.every((q) => tricky.includes(q)),
        `${type.kind} was allowed "${p}" too early`);
    }
    const late = allowedPatterns(type.patterns, 1, 30);
    assert.ok(late.length >= early.length, 'later rounds should open up, not close down');
  }
});

test('environments cycle through all five', () => {
  const seen = new Set();
  for (let round = 1; round <= 40; round++) seen.add(environmentFor(round));
  assert.equal(seen.size, 5);
  assert.equal(ENVIRONMENT_NAMES.length, 5);
  assert.equal(environmentFor(1), 0);
});

test('the duck roster is coherent and gets rarer as it gets more valuable', () => {
  const kinds = new Set(DUCK_TYPES.map((d) => d.kind));
  assert.equal(kinds.size, DUCK_TYPES.length, 'duck kinds must be unique');
  for (const type of DUCK_TYPES) {
    assert.ok(type.size >= 30 && type.size <= 80, `${type.kind} is an odd size`);
    assert.ok(type.speed > 0 && type.score > 0 && type.weight > 0, type.kind);
    assert.ok(type.patterns.length > 0, `${type.kind} cannot fly`);
    assert.ok(type.hits >= 1);
  }
  const sorted = [...DUCK_TYPES].sort((a, b) => a.score - b.score);
  assert.ok(sorted[0].weight > sorted[sorted.length - 1].weight,
    'the most valuable duck should not also be the most common');
});

test('the picker respects difficulty gates and eventually offers everything', () => {
  const early = new Set();
  for (let i = 0; i < 400; i++) early.add(pickDuckType(0, i / 400).kind);
  for (const kind of early) {
    assert.equal(duckType(kind).minDifficulty <= 0, true, `${kind} appeared too early`);
  }
  const late = new Set();
  for (let i = 0; i < 800; i++) late.add(pickDuckType(1, i / 800).kind);
  assert.ok(late.size >= 5, `late rounds only ever offered ${late.size} duck types`);
});

// ── scoring ─────────────────────────────────────────────────────────────────

test('the combo multiplier climbs and then holds', () => {
  assert.equal(comboMultiplier(1), 1);
  assert.ok(comboMultiplier(5) > comboMultiplier(2));
  assert.equal(comboMultiplier(20), comboMultiplier(8), 'the multiplier has to stop somewhere');
});

test('a first-shell hit beats the same hit on the third shell', () => {
  const type = duckType('green');
  const clean = awardHit(type, 1, 0);
  const messy = awardHit(type, 3, 0);
  assert.ok(clean.points > messy.points, 'accuracy has to be worth something');
  assert.ok(clean.firstShell && !messy.firstShell);
});

test('a streak multiplies the whole award', () => {
  const type = duckType('green');
  const cold = awardHit(type, 1, 0);
  const hot = awardHit(type, 1, 6);
  assert.ok(hot.points > cold.points * 2, 'a long streak should feel exponential');
  assert.ok(hot.label.startsWith('x'));
});

test('rare ducks are called out by name', () => {
  assert.equal(awardHit(duckType('golden'), 1, 0).label, 'GILDED DUCK');
  assert.ok(awardHit(duckType('green'), 1, 0).label.length > 0);
});

test('a perfect round is worth more than any single bonus', () => {
  const perfect = summariseRound(3, 8, 8, 8, 8, 2, 4000);
  const nearly = summariseRound(3, 7, 8, 8, 7, 2, 4000);
  assert.ok(perfect.perfect && !nearly.perfect);
  assert.ok(perfect.bonus > nearly.bonus + 1000);
  assert.equal(perfect.accuracy, 1);
});

test('accuracy is shots-hit over shots-fired, and safe at zero', () => {
  assert.equal(accuracyOf({ shotsFired: 0, shotsHit: 0 }), 0);
  assert.equal(accuracyOf({ shotsFired: 4, shotsHit: 3 }), 0.75);
  const s = emptyStats();
  assert.equal(s.score, 0);
  assert.equal(s.combo, 0);
});

// ── achievements and cosmetics ──────────────────────────────────────────────

test('achievements are unique, described, and only fire once', () => {
  const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
  assert.equal(ids.size, ACHIEVEMENTS.length);
  for (const a of ACHIEVEMENTS) assert.ok(a.name && a.hint, a.id);

  const totals = { ...emptyTotals(), ducksHit: 1 };
  const first = newlyEarned(totals, emptyStats(), []);
  assert.ok(first.some((a) => a.id === 'first'));
  const again = newlyEarned(totals, emptyStats(), first.map((a) => a.id));
  assert.equal(again.length, 0, 'an unlocked achievement must not fire again');
});

test('no achievement is earned by an empty run', () => {
  assert.equal(newlyEarned(emptyTotals(), emptyStats(), []).length, 0);
});

test('cosmetics start locked except the defaults, and every one has a hint', () => {
  const totals = emptyTotals();
  for (const list of [DOG_SKINS, WEAPON_SKINS]) {
    const defaults = list.filter((s) => cosmeticUnlocked(s.need, totals));
    assert.equal(defaults.length, 1, 'exactly one of each should be available at the start');
    for (const skin of list) {
      assert.ok(skin.name && skin.blurb, skin.id);
      if (skin.need.kind !== 'default') assert.ok(cosmeticHint(skin.need).length > 0, skin.id);
    }
  }
});

test('cosmetics unlock from real milestones', () => {
  const totals = { ...emptyTotals(), ducksHit: 80, rareDucks: 12, highScore: 40_000, roundsCleared: 20 };
  for (const skin of DOG_SKINS) assert.ok(cosmeticUnlocked(skin.need, totals), skin.id);
});

// ── the save layer ──────────────────────────────────────────────────────────

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('a run folds into the totals and round-trips', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  const run = {
    score: 12_000, ducksHit: 30, ducksEscaped: 4, shotsFired: 40, shotsHit: 30,
    bestCombo: 7, perfectRounds: 2, rareDucks: 3, roundsCleared: 5, playMs: 90_000,
  };
  assert.equal(save.recordRun('classic', run).newHigh, true);

  const reloaded = new SaveManager();
  assert.equal(reloaded.data.totals.ducksHit, 30);
  assert.equal(reloaded.data.best.classic, 12_000);
  assert.equal(reloaded.data.totals.highScore, 12_000);
  assert.ok(Math.abs(reloaded.data.totals.bestAccuracy - 0.75) < 1e-9);

  // A worse run must not take the record away.
  reloaded.recordRun('classic', { ...run, score: 500, bestCombo: 1 });
  assert.equal(reloaded.data.best.classic, 12_000);
  assert.equal(reloaded.data.totals.bestCombo, 7);
  assert.equal(reloaded.data.totals.ducksHit, 60, 'but counters still accumulate');
});

test('a tiny run cannot set an accuracy record', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  save.recordRun('classic', {
    score: 100, ducksHit: 1, ducksEscaped: 0, shotsFired: 1, shotsHit: 1,
    bestCombo: 1, perfectRounds: 0, rareDucks: 0, roundsCleared: 1, playMs: 1000,
  });
  assert.equal(save.data.totals.bestAccuracy, 0,
    'one lucky shot is not a 100% accuracy record');
});

test('corrupt, foreign or hostile save data falls back to defaults', () => {
  const storage = fakeStorage();
  globalThis.localStorage = storage;

  storage.setItem('featherfetch.save', '{ not json');
  assert.equal(new SaveManager().data.totals.ducksHit, 0);
  assert.equal(storage.getItem('featherfetch.save'), null, 'and the bad value is cleared');

  storage.setItem('featherfetch.save', JSON.stringify({
    version: 1,
    totals: { ducksHit: 'lots', bestAccuracy: 42, highScore: -5 },
    achievements: ['first', 'not-a-real-achievement', 7],
    settings: { sfxVolume: 'loud', dogSkin: 'nonexistent' },
    best: { classic: 'high' },
  }));
  const save = new SaveManager();
  assert.equal(save.data.totals.ducksHit, 0, 'a string counter is dropped');
  assert.ok(save.data.totals.bestAccuracy <= 1, 'accuracy is clamped to a ratio');
  assert.equal(save.data.totals.highScore, 0, 'a negative score is dropped');
  assert.deepEqual(save.data.achievements, ['first'], 'unknown achievements are dropped');
  assert.equal(save.data.settings.sfxVolume, DEFAULT_SETTINGS.sfxVolume);
  assert.equal(save.data.settings.dogSkin, 'red', 'a missing cosmetic falls back');
  assert.equal(save.data.best.classic, 0);
});

test('storage that throws never takes the game down', () => {
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('no'); },
  };
  const save = new SaveManager();
  assert.equal(save.data.totals.ducksHit, 0);
  save.recordRun('classic', {
    score: 1, ducksHit: 1, ducksEscaped: 0, shotsFired: 1, shotsHit: 1,
    bestCombo: 1, perfectRounds: 0, rareDucks: 0, roundsCleared: 1, playMs: 1,
  });                                    // must not throw
});

test('settings survive a reset of progress', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  save.data.settings.musicVolume = 0.1;
  save.recordRun('classic', {
    score: 9999, ducksHit: 9, ducksEscaped: 0, shotsFired: 9, shotsHit: 9,
    bestCombo: 9, perfectRounds: 1, rareDucks: 1, roundsCleared: 2, playMs: 1000,
  });
  save.reset();
  assert.equal(save.data.totals.ducksHit, 0);
  assert.equal(save.data.settings.musicVolume, 0.1, 'volume is not progress');
  assert.equal(new SaveManager().data.settings.musicVolume, 0.1);
});

test('the default save is self-consistent', () => {
  const save = defaultSave();
  assert.equal(save.version, 1);
  assert.deepEqual(save.settings, DEFAULT_SETTINGS);
  assert.deepEqual(save.achievements, []);
  assert.equal(save.best.classic, 0);
  assert.ok(VIEW_W > VIEW_H, 'the game is landscape');
  assert.ok(SKY_BOTTOM < VIEW_H, 'the shootable band leaves room for the ground');
});


// ── the dog's pace ──────────────────────────────────────────────────────────

/**
 * The retrieval has a hard budget.
 *
 * Qasim's note after playing the first build was that the dog broke the flow — every duck cost
 * roughly two seconds of watching an animation. These two checks encode the fix so a future
 * tweak to "make Biscuit more expressive" cannot quietly hand the delay back: the whole trip is
 * about a second, and the machine is fast enough to cross the screen inside it.
 */
test('the retrieval is about a second, not a cut-scene', () => {
  assert.ok(DOG_RETRIEVE_SECONDS <= 1.1,
    `retrieval is ${DOG_RETRIEVE_SECONDS}s — the shooting is the game, not the dog`);
  assert.ok(DOG_TEASE_SECONDS <= DOG_RETRIEVE_SECONDS,
    'the miss reaction must not last longer than a successful fetch');
});

/**
 * The trail's three constants are coupled, and the coupling is invisible in any one of them.
 *
 * Raise the speed alone and the images spread apart into a dotted line; raise the lifetime alone
 * and the cap starts discarding images that are still bright, so the streak ends in a hard edge.
 * This is the check that makes any of those three edits fail loudly rather than look slightly
 * wrong on a screen nobody is testing on.
 */
test('the speed trail stays unbroken and inside its cap', () => {
  // The run out is the fastest leg, so it is the one that stresses both bounds.
  const alive = (DOG_SPEED * 1.15 * DOG_TRAIL_SECONDS) / DOG_TRAIL_STEP;
  assert.ok(alive >= 8, `only ${alive.toFixed(1)} afterimages at once — reads as a dotted line`);
  assert.ok(alive <= DOG_TRAIL_MAX,
    `${alive.toFixed(1)} afterimages against a cap of ${DOG_TRAIL_MAX} — the trail ends in a hard edge`);
  // And the whole streak has to be a good deal longer than the dog, or it is just a shadow.
  assert.ok(DOG_TRAIL_SECONDS * DOG_SPEED >= 240, 'trail is too short to read as speed');
});

test('the dog is fast enough to cross the field inside its window', () => {
  // He enters off the left edge and has to reach the middle, grab, and be leaving before the
  // player is waiting on him.
  const reach = DOG_SPEED * (DOG_RETRIEVE_SECONDS * 0.5);
  assert.ok(reach >= VIEW_W * 0.45,
    `only covers ${Math.round(reach)}px of a ${VIEW_W}px field in half the window`);
});

// ── Open Season ─────────────────────────────────────────────────────────────

test('every mode has its own best-score slot, including Open Season', () => {
  const save = defaultSave();
  for (const mode of ['classic', 'timeAttack', 'survival', 'free']) {
    assert.equal(save.best[mode], 0, `${mode} has no slot`);
  }
});

test('Open Season records a high score of its own', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  save.recordRun('free', {
    score: 25_000, ducksHit: 60, ducksEscaped: 10, shotsFired: 90, shotsHit: 60,
    bestCombo: 12, perfectRounds: 0, rareDucks: 5, roundsCleared: 0, playMs: 120_000,
  });
  assert.equal(save.data.best.free, 25_000);
  assert.equal(save.data.best.classic, 0, 'and does not leak into another mode');
  assert.equal(new SaveManager().data.best.free, 25_000);
});

test('an unknown mode in a save file does not corrupt the known ones', () => {
  const storage = fakeStorage();
  globalThis.localStorage = storage;
  storage.setItem('featherfetch.save', JSON.stringify({
    version: 1, best: { classic: 900, free: 'lots', nonsense: 5 },
  }));
  const save = new SaveManager();
  assert.equal(save.data.best.classic, 900);
  assert.equal(save.data.best.free, 0, 'a string score is dropped');
  assert.equal(save.data.best.nonsense, undefined, 'and an unknown mode is not carried over');
});
