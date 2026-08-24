#!/usr/bin/env node
/**
 * Build FEATHER & FETCH.
 *
 *   node FeatherFetch/build.mjs           game + page  ->  build/web/
 *   node FeatherFetch/build.mjs --test    core as ESM  ->  build/test/  (for node --test)
 *
 * Same shape as the last two games', for the same reasons: esbuild for speed, an unminified ESM
 * bundle of the DOM-free half so the suite runs in Node, and a separate `tsc --noEmit` pass
 * because esbuild strips types without ever checking them.
 */

import { build } from 'esbuild';
import { mkdir, rm, stat, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');
const OUT = join(HERE, 'build', 'web');
const TEST_OUT = join(HERE, 'build', 'test');

const common = {
  bundle: true,
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'none',
  logLevel: 'warning',
};

if (process.argv.includes('--test')) {
  await mkdir(TEST_OUT, { recursive: true });
  await build({
    ...common,
    entryPoints: [join(SRC, 'core', 'index.ts')],
    outfile: join(TEST_OUT, 'core.mjs'),
    format: 'esm',
    minify: false,
  });
  console.log('test bundle ->', TEST_OUT);
  process.exit(0);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const app = await build({
  ...common,
  entryPoints: [join(SRC, 'main.ts')],
  outfile: join(OUT, 'game.js'),
  format: 'iife',
  minify: true,
});

await cp(join(SRC, 'shell', 'index.html'), join(OUT, 'index.html'));
await cp(join(SRC, 'shell', 'style.css'), join(OUT, 'style.css'));

const files = ['game.js', 'index.html', 'style.css'];
const sizes = await Promise.all(files.map(async (f) => {
  const { size } = await stat(join(OUT, f));
  return { f, size };
}));

console.log('\nFEATHER & FETCH — web build');
for (const { f, size } of sizes) {
  console.log(`  ${f.padEnd(12)} ${(size / 1024).toFixed(1).padStart(7)} KB`);
}
const total = sizes.reduce((n, s) => n + s.size, 0);
console.log(`  ${'total'.padEnd(12)} ${(total / 1024).toFixed(1).padStart(7)} KB  ->  build/web/`);
if (app.warnings.length) console.log(`\n${app.warnings.length} warning(s)`);
