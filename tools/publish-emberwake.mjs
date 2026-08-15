#!/usr/bin/env node
/**
 * Publish EMBERWAKE.
 *
 *   npm run publish:emberwake
 *
 * Type-check, test, build, then rebuild the arcade site — in that order. The site rebuild
 * deletes `docs/` first so it has to come last, and a build that ships without its tests having
 * run is how a level that cannot be finished reaches a live page.
 *
 * Flags:  --skip-tests   build without the suite (the solver pass takes a few seconds)
 *         --skip-site    build the game only, leaving docs/ alone
 */

import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const skipTests = process.argv.includes('--skip-tests');
const skipSite = process.argv.includes('--skip-site');
const node = process.execPath;

const step = (label) => console.log(`\n\x1b[1m${label}\x1b[0m`);

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`\n\x1b[31m✗ ${label} failed\x1b[0m — nothing was published.`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n\x1b[1mEMBERWAKE — publish\x1b[0m');

step('1/4  type check');
try {
  await access(join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'));
  run(node, [join('node_modules', 'typescript', 'lib', 'tsc.js'), '-p', join('Emberwake', 'tsconfig.json')],
    'type check');
  console.log('  \x1b[32mok\x1b[0m   no type errors');
} catch {
  console.log('  \x1b[33mskip\x1b[0m TypeScript is not installed — run: npm i -D typescript');
}

step('2/4  tests');
if (skipTests) {
  console.log('  \x1b[33mskip\x1b[0m --skip-tests');
} else {
  run(node, [join('Emberwake', 'build.mjs'), '--test'], 'test bundle');
  run(node, ['--test', 'Emberwake/test/*.test.mjs'], 'tests');
}

step('3/4  build');
run(node, [join('Emberwake', 'build.mjs')], 'build');

step('4/4  site');
if (skipSite) {
  console.log('  \x1b[33mskip\x1b[0m --skip-site');
} else {
  run(node, [join('packages', 'engine-runner', 'build.mjs')], 'engine bundle');
  run(node, [join('tools', 'publish-web.mjs')], 'site');
}

console.log('\n\x1b[32m✓ EMBERWAKE published\x1b[0m');
console.log('  live  https://fojiphoto.github.io/AIGameGen/play/emberwake/\n');
