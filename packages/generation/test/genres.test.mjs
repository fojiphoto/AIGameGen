/**
 * The product guarantee, extended to every genre.
 *
 * Same rule as the runner: if this goes red the platform is shipping levels a player
 * cannot finish. Each genre's proof is different (physics, arithmetic, construction, a
 * board-capacity ceiling) but the contract is identical — 20 levels, all finishable, and a
 * difficulty curve that actually rises.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnyGame, buildAnyRuntimePayload, GENERATION_REGISTRY } from '../src/genres/index.mjs';
import { GENRE_REGISTRY, IMPLEMENTED_GENRES, safeParseAnyConfig } from '@forge/schema/genres';
import { planDeterministic } from '../../ai/src/planner.mjs';

const NEW_GENRES = ['tap_to_fly', 'memory_match', 'sliding_puzzle', 'merge_2048', 'snake'];

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

      if (levels.length !== 20) {
        failures.push(`${genre} / "${prompt}": built ${levels.length}/20 — ${report.fatals.join('; ')}`);
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

test('difficulty rises across the 20 levels in every genre', () => {
  for (const genre of NEW_GENRES) {
    for (const prompt of PROMPTS.slice(0, 5)) {
      const cfg = configFor(genre, prompt);
      const { validation } = buildAnyGame(cfg);
      const s = validation.difficultyScores;
      assert.equal(s.length, 20, `${genre} / "${prompt}": ${s.length} scores`);
      assert.ok(
        s.at(-1) > s[0] + 8,
        `${genre} / "${prompt}": level 20 (${s.at(-1)}) must be clearly harder than level 1 (${s[0]})`
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
    assert.equal(payload.levels.length, 20);
    assert.ok(payload.theme?.palette?.bg, `${genre}: payload lost the palette`);
    assert.ok(payload.copy?.levelNames?.length === 20, `${genre}: payload lost level names`);
    assert.ok(payload.buildId, `${genre}: payload has no buildId`);
    for (const l of payload.levels) {
      assert.ok(l.index >= 1 && l.index <= 20, `${genre}: bad level index ${l.index}`);
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
