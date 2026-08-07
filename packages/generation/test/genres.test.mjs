/**
 * The product guarantee, extended to every genre.
 *
 * Same rule as the runner: if this goes red the platform is shipping levels a player
 * cannot finish. Each genre's proof is different (physics, arithmetic, construction, a
 * board-capacity ceiling) but the contract is identical — a full ladder, all of it finishable,
 * difficulty curve that actually rises.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnyGame, buildAnyRuntimePayload, GENERATION_REGISTRY } from '../src/genres/index.mjs';
import { GENRE_REGISTRY, IMPLEMENTED_GENRES, safeParseAnyConfig } from '@forge/schema/genres';
import { planDeterministic } from '../../ai/src/planner.mjs';
import { BREATHER_FROM, BREATHER_TO } from '../src/genres/rhythmDash.mjs';

const NEW_GENRES = ['tap_to_fly', 'memory_match', 'sliding_puzzle', 'merge_2048', 'snake', 'rhythm_dash'];

const PROMPTS = [
  'neon cyberpunk city',
  'underwater coral reef',
  'lava volcano, make it hard',
  'arctic glacier, easy',
  'retro 8bit arcade',
  'deep space station',
  'toxic sewer',
  'sweet pastel candy-free dessert',
  'minimal monochrome ink',
  'stormy cloudbase',
];

/** Build a valid config for `genre` from a themed prompt. */
function configFor(genre, prompt) {
  const out = planDeterministic(prompt, { genre });
  assert.equal(out.config.genre, genre, `planner returned ${out.config.genre} for requested ${genre}`);
  return out.config;
}

test('every implemented genre is wired into the schema registry', () => {
  for (const id of IMPLEMENTED_GENRES) {
    const entry = GENRE_REGISTRY[id];
    assert.ok(entry, `${id} missing from GENRE_REGISTRY`);
    assert.ok(entry.configSchema, `${id} has no configSchema`);
    assert.ok(entry.toolFields, `${id} has no AI tool fields`);
    assert.equal(typeof entry.clamp, 'function', `${id} has no clamp`);
    assert.equal(typeof entry.safeParse, 'function', `${id} has no safeParse`);
  }
});

test('every new genre has a generator, validator and runtime serialiser', () => {
  for (const id of NEW_GENRES) {
    const g = GENERATION_REGISTRY[id];
    assert.ok(g, `${id} missing from GENERATION_REGISTRY`);
    for (const fn of ['build', 'validate', 'runtime']) {
      assert.equal(typeof g[fn], 'function', `${id}.${fn} is not a function`);
    }
  }
});

test('the deterministic planner produces a schema-valid config for every genre', () => {
  for (const genre of NEW_GENRES) {
    for (const prompt of PROMPTS.slice(0, 4)) {
      const cfg = configFor(genre, prompt);
      const parsed = safeParseAnyConfig(cfg);
      assert.ok(parsed.ok, `${genre} / "${prompt}": ${parsed.errors?.join('; ')}`);
    }
  }
});

test('every level of every generated game is finishable', () => {
  const failures = [];
  for (const genre of NEW_GENRES) {
    for (const prompt of PROMPTS) {
      const cfg = configFor(genre, prompt);
      const { levels, validation, report } = buildAnyGame(cfg);

      // Ladder length is a property of the genre now, not a constant. rhythm_dash runs ten.
      const want = cfg.progression.levels;
      if (levels.length !== want) {
        failures.push(`${genre} / "${prompt}": built ${levels.length}/${want} — ${report.fatals.join('; ')}`);
        continue;
      }
      if (!validation.ok) {
        const detail = validation.perLevel
          .filter((r) => !r.ok)
          .map((r) => `L${r.level}: ${r.reasons.join(' | ')}`)
          .join('\n      ');
        failures.push(
          `${genre} / "${prompt}" (${cfg.meta.title}):\n      ${detail}` +
            (validation.curveIssues.length ? `\n      curve: ${validation.curveIssues.join('; ')}` : '')
        );
      }
    }
  }
  assert.equal(failures.length, 0, `\n${failures.length} game(s) produced unfinishable levels:\n\n${failures.join('\n\n')}\n`);
});

test('difficulty rises across the ladder in every genre', () => {
  for (const genre of NEW_GENRES) {
    for (const prompt of PROMPTS.slice(0, 5)) {
      const cfg = configFor(genre, prompt);
      const { validation } = buildAnyGame(cfg);
      const s = validation.difficultyScores;
      assert.equal(s.length, cfg.progression.levels, `${genre} / "${prompt}": ${s.length} scores`);
      assert.ok(
        s.at(-1) > s[0] + 8,
        `${genre} / "${prompt}": the last level (${s.at(-1)}) must be clearly harder than level 1 (${s[0]})`
      );
      assert.equal(validation.curveIssues.length, 0, `${genre} / "${prompt}": ${validation.curveIssues.join('; ')}`);
    }
  }
});

test('generation is deterministic for every genre', () => {
  for (const genre of NEW_GENRES) {
    const cfg = configFor(genre, 'neon cyberpunk city');
    const a = buildAnyGame(cfg);
    const b = buildAnyGame(cfg);
    assert.equal(
      JSON.stringify(buildAnyRuntimePayload(cfg, a.levels)),
      JSON.stringify(buildAnyRuntimePayload(cfg, b.levels)),
      `${genre}: identical inputs must yield identical output`
    );
  }
});

test('the runtime payload carries everything a scene needs', () => {
  for (const genre of NEW_GENRES) {
    const cfg = configFor(genre, 'deep space station');
    const { levels } = buildAnyGame(cfg);
    const payload = buildAnyRuntimePayload(cfg, levels);
    assert.equal(payload.genre, genre);
    assert.equal(payload.levels.length, cfg.progression.levels);
    assert.ok(payload.theme?.palette?.bg, `${genre}: payload lost the palette`);
    assert.ok(payload.copy?.levelNames?.length >= cfg.progression.levels, `${genre}: payload lost level names`);
    assert.ok(payload.buildId, `${genre}: payload has no buildId`);
    for (const l of payload.levels) {
      assert.ok(l.index >= 1 && l.index <= cfg.progression.levels, `${genre}: bad level index ${l.index}`);
      assert.ok(l.name, `${genre}: level ${l.index} has no name`);
    }
  }
});

// ─── per-genre invariants ───────────────────────────────────────────────────

test('tap_to_fly never places an unreachable gap', () => {
  for (const prompt of PROMPTS) {
    const cfg = configFor('tap_to_fly', prompt);
    const { levels } = buildAnyGame(cfg);
    for (const l of levels) {
      const flight = l.spacing / l.speed;
      const climb = cfg.player.flapImpulse * flight * 0.6;
      const fall = Math.min(0.5 * cfg.player.gravity * flight * flight, cfg.player.terminalVelocity * flight) * 0.75;
      for (let i = 0; i < l.pattern.length - 1; i++) {
        const dy = l.pattern[i + 1].y - l.pattern[i].y;
        assert.ok(dy >= -climb - 1, `"${prompt}" L${l.index} pipe ${i}→${i + 1}: needs ${Math.round(-dy)}px climb, only ${Math.round(climb)}px available`);
        assert.ok(dy <= fall + 1, `"${prompt}" L${l.index} pipe ${i}→${i + 1}: needs ${Math.round(dy)}px drop, only ${Math.round(fall)}px available`);
      }
    }
  }
});

test('memory_match always deals an even grid with exact pairs', () => {
  for (const prompt of PROMPTS) {
    const cfg = configFor('memory_match', prompt);
    for (const l of buildAnyGame(cfg).levels) {
      assert.equal((l.cols * l.rows) % 2, 0, `"${prompt}" L${l.index}: ${l.cols}x${l.rows} is odd`);
      assert.equal(l.deal.length, l.cols * l.rows);
      const counts = new Map();
      for (const f of l.deal) counts.set(f, (counts.get(f) ?? 0) + 1);
      for (const [face, n] of counts) assert.equal(n, 2, `"${prompt}" L${l.index}: face ${face} appears ${n} times`);
    }
  }
});

test('sliding_puzzle boards are scrambled, solvable and within the move budget', () => {
  for (const prompt of PROMPTS) {
    const cfg = configFor('sliding_puzzle', prompt);
    for (const l of buildAnyGame(cfg).levels) {
      const n = l.size * l.size;
      assert.equal(new Set(l.tiles).size, n, `"${prompt}" L${l.index}: tiles are not a permutation`);
      assert.equal(l.tiles[l.blank], 0, `"${prompt}" L${l.index}: blank index is wrong`);
      const solved = l.tiles.every((v, i) => v === (i === n - 1 ? 0 : i + 1));
      assert.ok(!solved, `"${prompt}" L${l.index}: board starts solved`);
      // built by walking `scramble` legal moves from solved, so that many moves suffice
      assert.ok(l.moveLimit >= l.scramble, `"${prompt}" L${l.index}: ${l.moveLimit} moves for a ${l.scramble}-move scramble`);
    }
  }
});

test('merge_2048 targets are powers of two and reachable on the board', () => {
  for (const prompt of PROMPTS) {
    const cfg = configFor('merge_2048', prompt);
    for (const l of buildAnyGame(cfg).levels) {
      assert.equal(l.target & (l.target - 1), 0, `"${prompt}" L${l.index}: target ${l.target} is not a power of two`);
      const cap = 2 ** Math.max(2, Math.min(17, l.size * l.size - 3));
      assert.ok(l.target <= cap, `"${prompt}" L${l.index}: target ${l.target} exceeds the ${l.size}x${l.size} ceiling of ${cap}`);
      assert.equal(l.cells.filter((v) => v > 0).length, 2, `"${prompt}" L${l.index}: opening board should have 2 tiles`);
    }
  }
});

test('snake levels leave room for a fully grown snake', () => {
  for (const prompt of PROMPTS) {
    const cfg = configFor('snake', prompt);
    for (const l of buildAnyGame(cfg).levels) {
      const cells = l.cols * l.rows;
      const finalLength = 3 + l.foodTarget * l.growPerFood;
      assert.ok(
        finalLength + l.walls.length <= cells * 0.75,
        `"${prompt}" L${l.index}: grown snake (${finalLength}) + ${l.walls.length} walls > 75% of ${cells} cells`
      );
      assert.ok(l.stepMs >= 60, `"${prompt}" L${l.index}: ${l.stepMs}ms/step is below reaction time`);
      const startIdx = l.start.r * l.cols + l.start.c;
      assert.ok(!l.walls.includes(startIdx), `"${prompt}" L${l.index}: snake spawns in a wall`);
    }
  }
});

test('a deliberately impossible config is caught rather than shipped', () => {
  // a snake board that a grown snake cannot possibly fit in
  const cfg = configFor('snake', 'neon cyberpunk city');
  const broken = structuredClone(cfg);
  broken.board.cols = 10;
  broken.board.rows = 8;
  broken.difficulty.foodStart = 20;
  broken.difficulty.growth = 1.3;
  broken.difficulty.growPerFood = 4;
  broken.difficulty.wallsEnd = 60;
  const { report } = buildAnyGame(broken);
  assert.equal(report.ok, false, 'an unfinishable snake config must not produce a shippable game');
  assert.ok(report.fatals.length > 0, 'the failure must be reported with a reason');
});

test('an unknown genre is reported, not silently empty', () => {
  const { report } = buildAnyGame({
    genre: 'does_not_exist',
    meta: { seed: 1, title: 'X' },
    progression: { levels: 20, reliefLevels: [] },
    difficulty: { curve: 'linear' },
    copy: { levelNames: [] },
  });
  assert.equal(report.ok, false);
  assert.match(report.fatals[0], /no generator/);
});

// ── rhythm_dash: the shape of the ladder, and the shape inside each level ────
//
// These exist because the ladder looked correct from the outside and was not. Twenty levels
// were generated, every one validated, every one carried a distinct name — and levels 1 to 8
// were the same level: ten seconds long, four hazards, no platforms, no gaps, no pads, and a
// speed spread of nine percent. Every assertion the suite had was green. What was missing was
// any test that the progression is FELT, so that is what these check.

const dashConfig = (prompt) => planDeterministic(prompt, { genre: 'rhythm_dash' }).config;

test('rhythm_dash runs a ten-level ladder and the other genres still run twenty', () => {
  for (const prompt of PROMPTS.slice(0, 4)) {
    const cfg = dashConfig(prompt);
    assert.equal(cfg.progression.levels, 10, `"${prompt}": rhythm_dash ladder length`);
    assert.equal(cfg.copy.levelNames.length, 10, `"${prompt}": one name per level`);
    assert.ok(
      cfg.progression.reliefLevels.every((l) => l <= 10),
      `"${prompt}": relief valley past the end of the ladder`
    );
    // A breather level that also introduces a new hazard is not a breather. This is not
    // hypothetical: gaps unlocked on level 4, which is a relief level, and level 4 came out
    // busier than level 3 as a direct result.
    const onValley = [
      ['platforms', cfg.features.platformsFromLevel],
      ['gaps', cfg.features.gapsFromLevel],
      ['jump pads', cfg.features.jumpPadsFromLevel],
      ['ceiling spikes', cfg.features.ceilingSpikesFromLevel],
    ].filter(([, from]) => from && cfg.progression.reliefLevels.includes(from));
    assert.equal(
      onValley.length, 0,
      `"${prompt}": ${onValley.map(([n, l]) => `${n} unlocks on relief level ${l}`).join(', ')}`
    );
  }
  for (const genre of NEW_GENRES.filter((g) => g !== 'rhythm_dash')) {
    assert.equal(configFor(genre, 'neon cyberpunk city').progression.levels, 20, `${genre} should be unchanged`);
  }
});

test('every rhythm_dash level is measurably busier and faster than the one before', () => {
  for (const prompt of PROMPTS.slice(0, 5)) {
    const cfg = dashConfig(prompt);
    const relief = new Set(cfg.progression.reliefLevels);
    const levels = buildAnyGame(cfg).levels;

    for (let i = 1; i < levels.length; i++) {
      const a = levels[i - 1];
      const b = levels[i];
      // Speed rises every single step, relief valleys included: a valley is a drop in density
      // and complexity, not a drop in pace.
      assert.ok(b.speed > a.speed, `"${prompt}": level ${i + 1} (${b.speed}) is not faster than ${i} (${a.speed})`);
      // Adjacent levels must differ by enough to notice. Eight percent per step was the
      // failure mode: real on paper, invisible in the hand.
      assert.ok(
        b.speed >= a.speed * 1.03,
        `"${prompt}": level ${i + 1} is only ${(((b.speed / a.speed) - 1) * 100).toFixed(1)}% faster than ${i}`
      );
    }

    const haz = levels.map((l) => l.obstacles.length + l.gaps.length);
    assert.ok(haz.at(-1) >= haz[0] * 1.8, `"${prompt}": last level has ${haz.at(-1)} hazards vs ${haz[0]} in the first`);

    // Relief valleys must actually dip, and non-valleys must not.
    for (let i = 1; i < levels.length; i++) {
      if (relief.has(i + 1)) {
        assert.ok(haz[i] < haz[i - 1], `"${prompt}": relief level ${i + 1} is not easier than ${i}`);
      }
    }
    // No level is an endurance test, and none is over before it starts.
    for (const [i, l] of levels.entries()) {
      const secs = l.lengthPx / l.speed;
      assert.ok(secs >= 18 && secs <= 55, `"${prompt}": level ${i + 1} runs ${secs.toFixed(1)}s`);
    }
  }
});

test('a rhythm_dash feature appears on the level that unlocks it', () => {
  for (const prompt of PROMPTS.slice(0, 5)) {
    const cfg = dashConfig(prompt);
    const levels = buildAnyGame(cfg).levels;
    const checks = [
      ['platforms', cfg.features.platformsFromLevel, (l) => l.platforms.length],
      ['gaps', cfg.features.gapsFromLevel, (l) => l.gaps.length],
      ['jump pads', cfg.features.jumpPadsFromLevel, (l) => l.pads.length],
    ];
    for (const [name, from, count] of checks) {
      if (!from || from > levels.length) continue;
      // The unlock level itself, and every level after it, has to contain the thing. This is
      // the test that would have caught platformsFromLevel saying 3 while platforms first
      // turned up at level 16 — the tier gate was silently overruling the feature schedule.
      for (let lv = from; lv <= levels.length; lv++) {
        assert.ok(
          count(levels[lv - 1]) > 0,
          `"${prompt}": ${name} unlock at ${from} but level ${lv} has none`
        );
      }
      if (from > 1) {
        assert.equal(count(levels[from - 2]), 0, `"${prompt}": ${name} appeared before its unlock at ${from}`);
      }
    }
  }
});

test('each rhythm_dash level has a quiet stretch and a peak, not one flat texture', () => {
  const BINS = 12;
  for (const prompt of PROMPTS.slice(0, 5)) {
    const cfg = dashConfig(prompt);
    for (const [i, l] of buildAnyGame(cfg).levels.entries()) {
      const bins = Array(BINS).fill(0);
      for (const o of [...l.obstacles, ...l.gaps]) {
        bins[Math.floor(Math.min(0.999, Math.max(0, o.x / l.lengthPx)) * BINS)]++;
      }
      const peak = Math.max(...bins);
      // The middle of the level has to breathe. Measured as density inside the breather window
      // against the level's own average density — not as a bin count, which depends on how the
      // window happens to line up with the bin edges, and not as an absolute, which would mean
      // different things for a sparse level 1 and a dense level 10.
      const all = [...l.obstacles, ...l.gaps];
      // Slide a breather-width window across the middle of the level and take the quietest
      // position it finds. The design claim is "there is a real lull in the middle", not "the
      // lull sits at exactly this coordinate": chunk widths vary, so the dip lands within a
      // few percent of where the phase table puts it rather than precisely on it, and a fixed
      // window straddles into the busier neighbours either side.
      const W = BREATHER_TO - BREATHER_FROM;
      let quietest = Infinity;
      for (let start = 0.30; start <= 0.62 - W + 1e-9; start += 0.01) {
        const n = all.filter((o) => {
          const u = o.x / l.lengthPx;
          return u >= start && u < start + W;
        }).length;
        quietest = Math.min(quietest, n);
      }
      // Compared against the window's proportional share of the level, so this means the same
      // thing for a nine-hazard level 1 and a thirty-four-hazard level 10.
      const share = all.length * W;
      assert.ok(
        quietest <= Math.max(1, share * 0.6),
        `"${prompt}" L${i + 1}: no breather — quietest middle window holds ${quietest} ` +
          `against a proportional share of ${share.toFixed(1)}`
      );
      // And it has to build to something. A level whose busiest stretch is the same as its
      // quietest is the flat wall this whole envelope exists to prevent.
      assert.ok(peak >= Math.min(...bins) + 2, `"${prompt}" L${i + 1}: flat — bins ${bins.join(',')}`);
    }
  }
});
