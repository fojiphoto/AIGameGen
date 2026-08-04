import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGame, buildRuntimePayload, makeRng, hashSeed, subSeed } from '../src/index.mjs';
import { planDeterministic } from '../../ai/src/planner.mjs';

test('mulberry32 is stable for a given seed', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const seqA = Array.from({ length: 50 }, () => a.next());
  const seqB = Array.from({ length: 50 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('different seeds diverge', () => {
  const a = Array.from({ length: 20 }, (_, i) => makeRng(1).next());
  const b = Array.from({ length: 20 }, (_, i) => makeRng(2).next());
  assert.notDeepEqual(a, b);
});

test('hashSeed is stable and 32-bit unsigned', () => {
  assert.equal(hashSeed('neon runner'), hashSeed('neon runner'));
  const h = hashSeed('anything');
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
});

test('subSeed isolates levels — re-rolling one cannot disturb another', () => {
  assert.notEqual(subSeed(99, 'L7#0'), subSeed(99, 'L8#0'));
  assert.equal(subSeed(99, 'L7#0'), subSeed(99, 'L7#0'));
});

test('same config + seed produces a byte-identical game', () => {
  const { config } = planDeterministic('neon cyberpunk runner with a robot');
  const a = buildGame(config);
  const b = buildGame(config);
  assert.equal(
    JSON.stringify(buildRuntimePayload(config, a.levels)),
    JSON.stringify(buildRuntimePayload(config, b.levels)),
    'identical inputs must yield identical output'
  );
});

test('same prompt produces the same config across runs', () => {
  const a = planDeterministic('underwater bubble adventure');
  const b = planDeterministic('underwater bubble adventure');
  assert.deepEqual(a.config, b.config);
});

test('different prompts produce different games', () => {
  const a = planDeterministic('lava volcano escape, hard');
  const b = planDeterministic('calm minimal mono runner');
  assert.notEqual(a.config.meta.title, b.config.meta.title);
  assert.notEqual(a.config.theme.palette.bg, b.config.theme.palette.bg);
});

test('generation packages contain no Math.random()', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.mjs')) continue;
    const raw = await readFile(join(dir, f), 'utf8');
    // strip comments first — the ban is documented in prose in several files
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(
      !/Math\.random\s*\(/.test(code),
      `${f} must not call Math.random() — determinism is a hard requirement`
    );
  }
});
