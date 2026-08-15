#!/usr/bin/env node
/**
 * Build IVORY GAMBIT.
 *
 *   node IvoryGambit/build.mjs           app + worker + page  ->  build/web/
 *   node IvoryGambit/build.mjs --test    rules + engine       ->  build/test/  (ESM, for node --test)
 *
 * Three outputs, because they have three different jobs:
 *
 *   app.js       the interface. IIFE, minified, loaded by the page.
 *   engine.js    the search, as a classic Web Worker. Separate on purpose — the whole point is
 *                that it runs off the main thread, and a bundler that inlined it back into the
 *                app would quietly undo that.
 *   test/*.mjs   the same source as ESM with no minification, so a stack trace from a failing
 *                perft points at a real line.
 *
 * target es2020 — every browser that supports Web Workers and `OffscreenCanvas`-free canvas
 * rendering at the level this uses has had optional chaining for years, and downlevelling
 * further only makes the bundle bigger.
 */

import { build } from 'esbuild';
import { mkdir, writeFile, readFile, rm, stat, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');
const OUT = join(HERE, 'build', 'web');
const TEST_OUT = join(HERE, 'build', 'test');

const testOnly = process.argv.includes('--test');

const common = {
  bundle: true,
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'none',
  logLevel: 'warning',
};

if (testOnly) {
  await mkdir(TEST_OUT, { recursive: true });
  await build({
    ...common,
    entryPoints: [join(SRC, 'core', 'index.ts')],
    outfile: join(TEST_OUT, 'core.mjs'),
    format: 'esm',
    minify: false,
    sourcemap: 'inline',
  });
  await build({
    ...common,
    entryPoints: [join(SRC, 'engine', 'index.ts')],
    outfile: join(TEST_OUT, 'engine.mjs'),
    format: 'esm',
    minify: false,
    sourcemap: 'inline',
  });
  // The DOM-free half of the interface: layout, clock, match, saves, puzzles, themes.
  await build({
    ...common,
    entryPoints: [join(SRC, 'ui', 'index.ts')],
    outfile: join(TEST_OUT, 'ui.mjs'),
    format: 'esm',
    minify: false,
    sourcemap: 'inline',
  });
  console.log('test bundles ->', TEST_OUT);
  process.exit(0);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const app = await build({
  ...common,
  entryPoints: [join(SRC, 'main.ts')],
  outfile: join(OUT, 'app.js'),
  format: 'iife',
  minify: true,
});

const worker = await build({
  ...common,
  entryPoints: [join(SRC, 'engine', 'worker.ts')],
  outfile: join(OUT, 'engine.js'),
  format: 'iife',
  minify: true,
});

// The page and its styles are authored as real files rather than emitted from a template
// string: they are edited far more often than the build script, and a stylesheet inside a
// JavaScript literal loses every editor affordance that makes CSS bearable.
await cp(join(SRC, 'shell', 'index.html'), join(OUT, 'index.html'));
await cp(join(SRC, 'shell', 'style.css'), join(OUT, 'style.css'));

const sizes = await Promise.all(
  ['app.js', 'engine.js', 'index.html', 'style.css'].map(async (f) => {
    const { size } = await stat(join(OUT, f));
    return `${f.padEnd(12)} ${(size / 1024).toFixed(1).padStart(7)} KB`;
  })
);
const total = (await Promise.all(
  ['app.js', 'engine.js', 'index.html', 'style.css'].map((f) => stat(join(OUT, f)))
)).reduce((n, s) => n + s.size, 0);

console.log('\nIVORY GAMBIT — web build');
for (const line of sizes) console.log('  ' + line);
console.log(`  ${'total'.padEnd(12)} ${(total / 1024).toFixed(1).padStart(7)} KB  ->  build/web/`);

const warnings = [...app.warnings, ...worker.warnings];
if (warnings.length) console.log(`\n${warnings.length} warning(s)`);
