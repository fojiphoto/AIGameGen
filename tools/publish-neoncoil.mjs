#!/usr/bin/env node
/**
 * One command to put NEON COIL on the live site.
 *
 *   npm run publish:neoncoil
 *
 * Three steps that have to happen in this order, which is the only reason this file exists —
 * doing them by hand and forgetting one produces a site that looks updated and is not:
 *
 *   1. Run the game's own test suite. It is fast and it has caught every real defect in this
 *      project, so publishing without it is choosing not to know.
 *   2. Compile the game to WebAssembly with pygbag, which writes a static folder into
 *      NeonCoil/build/web.
 *   3. Rebuild the arcade site, which copies that folder into docs/play/neon-coil/ and rewrites
 *      the index. This step deletes docs/ first, so it must come last.
 *
 * Then commit and push. GitHub Pages serves docs/ on the default branch and updates within a
 * minute or two.
 *
 * A note on what this actually produces, because "WebGL build" is the usual shorthand: the
 * output is WebAssembly. pygbag compiles CPython and pygame to WASM and the game draws through a
 * canvas, which SDL2 backs with WebGL — so it behaves exactly like a WebGL build from a player's
 * side (loads in the page, no install, no plugin) while being a Python program the whole way down.
 */

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GAME = join(ROOT, 'NeonCoil');

const skipTests = process.argv.includes('--skip-tests');

/**
 * Spawn a command and resolve when it exits cleanly.
 *
 * `shell` is needed on Windows to resolve a bare `python` off PATH, and with it the arguments are
 * re-parsed as a command line — so anything containing a space has to be quoted here or it
 * arrives as two arguments. `--title "NEON COIL"` became `--title NEON` plus a stray `COIL`,
 * and pygbag rejected it.
 */
function run(cmd, args, cwd, label) {
  const useShell = process.platform === 'win32';
  const quoted = useShell
    ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : args;

  return new Promise((resolvePromise, reject) => {
    console.log(`\n\x1b[1m${label}\x1b[0m \x1b[2m${cmd} ${quoted.join(' ')}\x1b[0m`);
    const child = spawn(cmd, quoted, { cwd, stdio: 'inherit', shell: useShell });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0
      ? resolvePromise()
      : reject(new Error(`${label} failed with exit code ${code}`))));
  });
}

async function python() {
  // Whatever is on PATH, but check it exists first so the failure is a sentence rather than a
  // spawn error four lines deep.
  for (const candidate of ['python', 'python3', 'py']) {
    try {
      await run(candidate, ['--version'], ROOT, 'python');
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No python on PATH. Install Python 3.10+ and try again.');
}

try {
  await access(join(GAME, 'main.py'));
} catch {
  throw new Error(`No game at ${GAME} — expected NeonCoil/main.py`);
}

const py = await python();

if (skipTests) {
  console.log('\n\x1b[33mskipping the test suite (--skip-tests)\x1b[0m');
} else {
  await run(py, ['-m', 'neoncoil', '--selftest'], GAME, 'self test');
}

await run(py, ['-m', 'pygbag', '--build', '--ume_block', '0', '--title', 'NEON COIL', '.'],
          GAME, 'compile to WebAssembly');

await run(process.execPath, [join(ROOT, 'tools', 'publish-web.mjs')], ROOT, 'rebuild the arcade');

const bundle = join(ROOT, 'docs', 'play', 'neon-coil', 'neoncoil.tar.gz');
const size = (await stat(bundle)).size;

console.log(`\n\x1b[32m\x1b[1mready to publish\x1b[0m`);
console.log(`  game bundle   docs/play/neon-coil/  (${(size / 1024).toFixed(0)} KB)`);
console.log(`\n  commit and push, then it is live:`);
console.log(`    \x1b[2mgit add -A && git commit -m "Update NEON COIL" && git push\x1b[0m`);
console.log(`\n  play          https://fojiphoto.github.io/AIGameGen/play/neon-coil/`);
console.log(`  embed         https://fojiphoto.github.io/AIGameGen/embed/neon-coil.html`);
console.log(`  arcade        https://fojiphoto.github.io/AIGameGen/`);
