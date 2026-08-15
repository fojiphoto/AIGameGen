#!/usr/bin/env node
/**
 * One command to put BLOCK BLOOM on the live site.
 *
 *   npm run publish:blockbloom
 *
 * Four steps that have to happen in this order, which is the only reason this file exists —
 * doing them by hand and forgetting one produces a site that looks updated and is not:
 *
 *   1. Run the game's own test suite. It is fast and it has caught every real defect in this
 *      project, so publishing without it is choosing not to know.
 *   2. Compile the game to WebAssembly with pygbag, which writes a static folder into
 *      BlockBloom/build/web.
 *   3. Dress the page pygbag generated — fix its aspect ratio, replace its loading screen.
 *   4. Rebuild the arcade site, which copies that folder into docs/play/block-bloom/ and rewrites
 *      the index. This step deletes docs/ first, so it must come last.
 *
 * Then commit and push. GitHub Pages serves docs/ on the default branch and updates within a
 * minute or two.
 *
 * A note on what this produces, because "WebGL build" is the usual shorthand: the output is
 * WebAssembly. pygbag compiles CPython and pygame to WASM and the game draws through a canvas,
 * which SDL2 backs with WebGL — so it behaves exactly like a WebGL build from a player's side
 * (loads in the page, no install, no plugin) while being a Python program the whole way down.
 */

import { spawn } from 'node:child_process';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { brandLoader, setAspect } from './brand-loader.mjs';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const WARN = '\x1b[33m';
const OK = '\x1b[32m';
const RESET = '\x1b[0m';

const ROOT = resolve(import.meta.dirname, '..');
const GAME = join(ROOT, 'BlockBloom');

const skipTests = process.argv.includes('--skip-tests');
// pygbag fetches its page template and icon from a CDN on every build, so a
// network blip fails the whole thing. When the archive is already current and
// only the page or the site needs refreshing, skip straight to those.
const skipBuild = process.argv.includes('--skip-build');

/**
 * Spawn a command and resolve when it exits cleanly.
 *
 * `shell` is needed on Windows to resolve a bare `python` off PATH, and with it the arguments are
 * re-parsed as a command line — so anything containing a space has to be quoted here or it
 * arrives as two arguments. `--title "BLOCK BLOOM"` became `--title BLOCK` plus a stray `BLOOM`
 * the first time, and pygbag rejected it.
 */
function run(cmd, args, cwd, label) {
  const useShell = process.platform === 'win32';
  const quoted = useShell
    ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : args;

  return new Promise((resolvePromise, reject) => {
    console.log(`\n${BOLD}${label}${RESET} ${DIM}${cmd} ${quoted.join(' ')}${RESET}`);
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

/**
 * Fix up the page pygbag generates: its aspect ratio, and its loading screen.
 *
 * `--width`/`--height` set the canvas element and the framebuffer size, but `fb_ar` is a literal
 * in the template — it stays at 1.77 whatever size you ask for. The loader uses it to fit the
 * canvas to the window, so a portrait game left at 1.77 is scaled as though it were landscape.
 *
 * The loading screen is replaced because a powder-blue page with a green "Loading, please wait ..."
 * button is the first thing every player sees, it looks like a fault, and on a first visit they
 * look at it for a long time.
 *
 * Both are patched rather than forked. A custom pygbag template would have to be re-synced on
 * every upgrade, and nearly all of that file is machinery — canvas ids, script tags, emscripten
 * status hooks — that we have no opinion about.
 */
async function dressPage() {
  const page = join(GAME, 'build', 'web', 'index.html');
  let src = await readFile(page, 'utf8');

  const aspect = setAspect(src, 720, 1280);
  if (!aspect.applied) {
    console.log(`\n${WARN}fb_ar not found in the generated page — pygbag's template may have `
                + `changed; check the canvas is not stretched${RESET}`);
  } else {
    console.log(`\n${BOLD}set the canvas aspect${RESET} `
                + `${DIM}fb_ar = ${aspect.value} (portrait)${RESET}`);
    src = aspect.html;
  }

  src = brandLoader(src, {
    title: 'BLOCK BLOOM',
    tagline: 'FIT · FILL · CLEAR',
    deep: '#0d1020',
    mid: '#1e2546',
    accent: '#5aaaff',
    accent2: '#ffce56',
    blocks: ['#5698ff', '#a876ff', '#ff9448', '#4cd284', '#ff74a8', '#4ed6e2', '#ffce56'],
  });
  await writeFile(page, src, 'utf8');
  console.log(`${BOLD}brand the loading screen${RESET} `
              + `${DIM}FORGE ENGINE, progress bar, staged captions${RESET}`);
}

try {
  await access(join(GAME, 'main.py'));
} catch {
  throw new Error(`No game at ${GAME} — expected BlockBloom/main.py`);
}

const py = await python();

if (skipTests) {
  console.log(`\n${WARN}skipping the test suite (--skip-tests)${RESET}`);
} else {
  await run(py, ['-m', 'blockbloom', '--selftest'], GAME, 'self test');
}


// `--width`/`--height` are not cosmetic for a portrait game. pygbag's template defaults to a
// 1280x720 canvas, so without these the game draws its 720x1280 surface into a landscape frame and
// the player gets a narrow strip between two black bars.
if (!skipBuild) {
  await run(py, ['-m', 'pygbag', '--build', '--ume_block', '0',
               '--width', '720', '--height', '1280',
               '--title', 'BLOCK BLOOM', '.'],
            GAME, 'compile to WebAssembly');
} else {
  console.log(`
${WARN}skipping the WebAssembly build (--skip-build)${RESET}`);
}

await dressPage();

await run(process.execPath, [join(ROOT, 'tools', 'publish-web.mjs')], ROOT, 'rebuild the arcade');

const bundle = join(ROOT, 'docs', 'play', 'block-bloom', 'blockbloom.tar.gz');
const size = (await stat(bundle)).size;

console.log(`\n${OK}${BOLD}ready to publish${RESET}`);
console.log(`  game bundle   docs/play/block-bloom/  (${(size / 1024).toFixed(0)} KB)`);
console.log(`\n  commit and push, then it is live:`);
console.log(`    ${DIM}git add -A && git commit -m "Update BLOCK BLOOM" && git push${RESET}`);
console.log(`\n  play          https://fojiphoto.github.io/AIGameGen/play/block-bloom/`);
console.log(`  embed         https://fojiphoto.github.io/AIGameGen/embed/block-bloom.html`);
console.log(`  arcade        https://fojiphoto.github.io/AIGameGen/`);
