#!/usr/bin/env node
/**
 * Publish IVORY GAMBIT.
 *
 *   npm run publish:chess
 *
 * Type-check, test, build, then rebuild the arcade site — in that order, and the order is the
 * point. The site rebuild deletes `docs/` first, so it must come last; and a build that ships
 * without its tests having run is exactly how a rules bug reaches a live board.
 *
 * Unlike the two Python games, there is nothing to compile to WebAssembly here — the game is
 * TypeScript bundled to about 150 KB of JavaScript, so "build" is one esbuild pass and the whole
 * publish takes seconds rather than minutes.
 *
 * Flags:
 *   --skip-tests   build and publish without running the suite (for a fast local look)
 *   --skip-site    build the game only, leaving docs/ alone
 */

import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GAME = join(ROOT, 'IvoryGambit');

const skipTests = process.argv.includes('--skip-tests');
const skipSite = process.argv.includes('--skip-site');

const step = (label) => console.log(`\n\x1b[1m${label}\x1b[0m`);

/** Run a command, and stop the publish on the first failure. */
function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`\n\x1b[31m✗ ${label} failed\x1b[0m — nothing was published.`);
    process.exit(result.status ?? 1);
  }
}

const node = process.execPath;

console.log('\n\x1b[1mIVORY GAMBIT — publish\x1b[0m');

step('1/4  type check');
// esbuild strips types without checking them, so this pass is the only thing standing between a
// genuine type error and a runtime crash on a live board.
try {
  await access(join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'));
  run(node, [join('node_modules', 'typescript', 'lib', 'tsc.js'), '-p', join('IvoryGambit', 'tsconfig.json')],
    'type check');
  console.log('  \x1b[32mok\x1b[0m   no type errors');
} catch {
  console.log('  \x1b[33mskip\x1b[0m TypeScript is not installed — run: npm i -D typescript');
}

step('2/4  tests');
if (skipTests) {
  console.log('  \x1b[33mskip\x1b[0m --skip-tests');
} else {
  run(node, [join('IvoryGambit', 'build.mjs'), '--test'], 'test bundle');
  run(node, ['--test', 'IvoryGambit/test/*.test.mjs'], 'tests');
}

step('3/4  build');
run(node, [join('IvoryGambit', 'build.mjs')], 'build');

step('4/4  site');
if (skipSite) {
  console.log('  \x1b[33mskip\x1b[0m --skip-site');
} else {
  run(node, [join('packages', 'engine-runner', 'build.mjs')], 'engine bundle');
  run(node, [join('tools', 'publish-web.mjs')], 'site');
}

console.log('\n\x1b[32m✓ IVORY GAMBIT published\x1b[0m');
console.log('  local   http://127.0.0.1:8000/AIGameGen/play/ivory-gambit/  (node tools/serve-docs.mjs)');
console.log('  live    https://fojiphoto.github.io/AIGameGen/play/ivory-gambit/\n');
