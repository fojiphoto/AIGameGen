import test from 'node:test';
import assert from 'node:assert/strict';
import { planDeterministic } from '../src/planner.mjs';
import { refineDeterministic } from '../src/index.mjs';
import { buildGame } from '@forge/generation';

const base = () => planDeterministic('neon cyberpunk runner with a robot').config;

/** Every refinement must still produce 20 beatable levels. */
function assertStillPlayable(config, label) {
  const { report, validation, levels } = buildGame(config);
  assert.equal(levels.length, 20, `${label}: expected 20 levels, got ${levels.length}`);
  assert.ok(
    report.ok && validation.ok,
    `${label}: refinement broke validation — ${[...report.fatals, ...validation.curveIssues].join('; ')}`
  );
}

test('"make it harder" raises speed and tightens spacing', () => {
  const cfg = base();
  const out = refineDeterministic(cfg, 'make it harder');
  assert.ok(out.config.difficulty.maxSpeed > cfg.difficulty.maxSpeed);
  assert.ok(out.config.difficulty.spawnGapEnd < cfg.difficulty.spawnGapEnd);
  assert.equal(out.source, 'deterministic');
  assertStillPlayable(out.config, 'harder');
});

test('"make it easier" lowers speed and widens spacing', () => {
  const cfg = base();
  const out = refineDeterministic(cfg, 'make it easier please');
  assert.ok(out.config.difficulty.maxSpeed < cfg.difficulty.maxSpeed);
  assert.ok(out.config.difficulty.spawnGapEnd > cfg.difficulty.spawnGapEnd);
  assertStillPlayable(out.config, 'easier');
});

test('Roman Urdu instructions are understood', () => {
  const cfg = base();
  const harder = refineDeterministic(cfg, 'isko mushkil banao');
  assert.ok(harder.config.difficulty.maxSpeed > cfg.difficulty.maxSpeed);
  const easier = refineDeterministic(cfg, 'asaan kar do');
  assert.ok(easier.config.difficulty.maxSpeed < cfg.difficulty.maxSpeed);
  assertStillPlayable(harder.config, 'mushkil');
  assertStillPlayable(easier.config, 'asaan');
});

test('theme change repaints the palette', () => {
  const cfg = base();
  const out = refineDeterministic(cfg, 'change to space theme');
  assert.notEqual(out.config.theme.palette.bg, cfg.theme.palette.bg);
  assertStillPlayable(out.config, 'space theme');
});

test('a difficulty-only instruction never silently repaints the game', () => {
  const cfg = base();
  const out = refineDeterministic(cfg, 'make it harder');
  assert.equal(out.config.theme.palette.bg, cfg.theme.palette.bg, 'palette must be untouched');
});

test('double jump can be added and removed', () => {
  const cfg = base();
  cfg.player.doubleJump = false;
  const on = refineDeterministic(cfg, 'add double jump');
  assert.equal(on.config.player.doubleJump, true);
  const off = refineDeterministic(on.config, 'remove double jump');
  assert.equal(off.config.player.doubleJump, false);
  assertStillPlayable(on.config, 'double jump on');
  assertStillPlayable(off.config, 'double jump off');
});

test('obstacle kinds can be removed, and the roster stays valid', () => {
  const cfg = base();
  const out = refineDeterministic(cfg, 'no gaps and no flying enemies');
  const kinds = out.config.obstacles.map((o) => o.kind);
  assert.ok(!kinds.includes('gap'));
  assert.ok(!kinds.includes('flying_drone'));
  assert.ok(out.config.obstacles.length >= 2);
  assert.ok(out.config.obstacles.some((o) => o.introAtLevel === 1), 'something must exist at level 1');
  assertStillPlayable(out.config, 'no gaps/flying');
});

test('removing everything is refused rather than producing an invalid roster', () => {
  const cfg = base();
  // ask to strip every removable kind at once
  const out = refineDeterministic(cfg, 'remove gaps, remove flying, remove saws, remove bars, make it harder');
  assert.ok(out.config.obstacles.length >= 2);
  assertStillPlayable(out.config, 'over-removal');
});

test('multiple intents compose in one instruction', () => {
  const cfg = base();
  const out = refineDeterministic(cfg, 'make it harder, change to lava theme and add double jump');
  assert.ok(out.config.difficulty.maxSpeed > cfg.difficulty.maxSpeed);
  assert.notEqual(out.config.theme.palette.bg, cfg.theme.palette.bg);
  assert.equal(out.config.player.doubleJump, true);
  assertStillPlayable(out.config, 'composed');
});

test('rename works', () => {
  const out = refineDeterministic(base(), 'call it VOID RUNNER');
  assert.equal(out.config.meta.title, 'VOID RUNNER');
});

test('an unrecognised instruction throws with examples instead of silently doing nothing', () => {
  assert.throws(
    () => refineDeterministic(base(), 'make it smell like bananas'),
    (e) => e.code === 'REFINE_NOT_UNDERSTOOD' && Array.isArray(e.examples)
  );
});

test('repeated hardening saturates at the schema ceiling and stays playable', () => {
  let cfg = base();
  for (let i = 0; i < 8; i++) cfg = refineDeterministic(cfg, 'make it harder').config;
  assert.ok(cfg.difficulty.maxSpeed <= 1150, 'must not exceed the schema max');
  assert.ok(cfg.difficulty.spawnGapEnd >= 420, 'must not drop below the schema min');
  assertStillPlayable(cfg, 'saturated');
});

test('repeated easing saturates at the floor and stays playable', () => {
  let cfg = base();
  for (let i = 0; i < 8; i++) cfg = refineDeterministic(cfg, 'make it easier').config;
  assert.ok(cfg.difficulty.maxSpeed >= 430);
  assert.ok(cfg.difficulty.startSpeed >= 140);
  assertStillPlayable(cfg, 'saturated easy');
});

test('jump feel changes keep every level clearable', () => {
  const cfg = base();
  assertStillPlayable(refineDeterministic(cfg, 'higher jump').config, 'higher jump');
  assertStillPlayable(refineDeterministic(cfg, 'snappier jump').config, 'snappier jump');
});

test('density and length changes keep every level clearable', () => {
  const cfg = base();
  for (const instr of ['more obstacles', 'fewer obstacles', 'longer levels', 'shorter levels']) {
    assertStillPlayable(refineDeterministic(cfg, instr).config, instr);
  }
});
