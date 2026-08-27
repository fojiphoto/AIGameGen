#!/usr/bin/env node
/**
 * Build an installable Android APK for every game on the site.
 *
 *   node tools/build-apks.mjs              every game in docs/games.json
 *   node tools/build-apks.mjs neon-coil    just these slugs
 *
 * WHY THIS EXISTS
 * The arcade is a static site, so there is no server to build an APK on demand. The honest
 * static answer is to build them all ahead of time and host the files, which is what this does:
 * one signed APK per game in `assets/apk/`, which `tools/publish-web.mjs` then copies into
 * `docs/apk/` and links from each card.
 *
 * WHY IT BUILDS FROM docs/ RATHER THAN FROM SOURCE
 * `docs/play/<slug>/` is the exact bytes the website serves. Building the APK from anywhere else
 * would mean the app and the site could drift — someone plays the web version, downloads the
 * APK, and gets a different game. Reading the published folder makes that impossible by
 * construction, and it means this tool knows nothing about how any individual game is built.
 *
 * THE ONE THING THAT HAS TO BE UNDONE
 * Generated games share a single 1.2 MB engine at `docs/engine/game.js`, referenced as
 * `../../engine/game.js`. That is right for a website — one download cached across seven games —
 * and wrong for an APK, where there is no shared anything and a relative path two levels above
 * the asset root does not resolve. So the engine is copied in beside the page and the script tag
 * is pointed back at it. `tools/build-apk.mjs` verifies afterwards that every script the page
 * asks for is actually in the APK, which is what makes this safe to do automatically.
 *
 * Run order for a full rebuild, which is the same shape as the cover-art flow:
 *
 *   node tools/publish-web.mjs     -> docs/, including games.json
 *   node tools/build-apks.mjs      -> assets/apk/*.apk
 *   node tools/publish-web.mjs     -> docs/apk/ and the download buttons
 */

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rm, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');
const OUT = join(ROOT, 'assets', 'apk');
const WORK = join(ROOT, 'build', 'apk');

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/**
 * The path prefix the site is served under on GitHub Pages.
 *
 * Absolute URLs baked into a page carry it; inside an APK the asset root *is* the site root, so
 * the prefix has to come off. If the repository is ever renamed this is the one line to change,
 * and the structural verification in `build-apk.mjs` will fail loudly if it is forgotten.
 */
const SITE_BASE = '/AIGameGen/';

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
};

function die(msg) {
  console.error(c.err(`✖ ${msg}`));
  process.exit(1);
}

// ── inputs ──────────────────────────────────────────────────────────────────

const manifestPath = join(DOCS, 'games.json');
if (!existsSync(manifestPath)) {
  die('docs/games.json not found — run `node tools/publish-web.mjs` first');
}
const allGames = JSON.parse(await readFile(manifestPath, 'utf8'));
const games = only.length ? allGames.filter((g) => only.includes(g.slug)) : allGames;

if (!games.length) {
  die(only.length ? `no game matches ${only.join(', ')}` : 'docs/games.json is empty');
}

console.log(`\n${c.b('FORGE — build APKs')}`);
console.log(c.dim(`  ${games.length} game${games.length === 1 ? '' : 's'} from docs/\n`));

await mkdir(OUT, { recursive: true });

// ── staging ─────────────────────────────────────────────────────────────────

/**
 * Copy a published game into a bundle an APK can be built from.
 *
 * Returns the number of files staged, or throws with a reason a human can act on. Everything
 * game-specific in this whole tool is in this function.
 */
async function stageBundle(game, bundleDir) {
  const src = join(DOCS, 'play', game.slug);
  if (!existsSync(src)) throw new Error(`not published: docs/play/${game.slug}/`);

  await cp(src, bundleDir, { recursive: true });

  const pagePath = join(bundleDir, 'index.html');
  let html = await readFile(pagePath, 'utf8');

  // The shared engine, brought in-house. See the header.
  if (html.includes('../../engine/game.js')) {
    const engine = join(DOCS, 'engine', 'game.js');
    if (!existsSync(engine)) throw new Error('docs/engine/game.js is missing');
    await cp(engine, join(bundleDir, 'game.js'));
    html = html.replaceAll('../../engine/game.js', 'game.js');
  }

  /**
   * The WebAssembly games load a Python runtime from a directory shared by the whole site. It
   * has to travel with the app, because the app has no internet permission and would otherwise
   * open to a loading bar that never finishes.
   *
   * These pages reference it by *absolute site path* — `/AIGameGen/engine-runtime/...` — rather
   * than relatively, because the loader builds those URLs at runtime from a base it is given.
   * Inside the APK the asset root is the site root, so re-pointing the whole prefix at `/` is
   * both the smallest change and the one that keeps working when the loader concatenates a path
   * this rewrite never sees.
   */
  if (html.includes(`${SITE_BASE}engine-runtime/`)) {
    const runtime = join(DOCS, 'engine-runtime');
    if (!existsSync(runtime)) throw new Error('docs/engine-runtime/ is missing');
    await cp(runtime, join(bundleDir, 'engine-runtime'), { recursive: true });
  }
  html = html.replaceAll(SITE_BASE, '/').replaceAll('../../engine-runtime/', '/engine-runtime/');

  /**
   * The loading screen tells the player their browser is about to download a 10 MB runtime and
   * will cache it for next time. Inside the app that is simply untrue — the runtime is already
   * on the phone, which is most of why the file is 10 MB — and a loading screen that describes
   * something that is not happening is the kind of detail that makes an app feel unfinished.
   */
  html = html.replace(
    /First visit downloads the engine runtime[\s\S]*?starts quickly\./,
    'Unpacking the engine. This happens once each time you open the game, and needs no internet.'
  );

  // A page that still reaches outside its own folder would build fine and then show nothing.
  if (html.includes('../../')) {
    throw new Error('index.html still points outside its own folder after staging');
  }

  await writeFile(pagePath, html, 'utf8');

  /**
   * The site's favicon is dead weight in an app that has no browser chrome, and a previously
   * built APK sitting in the folder would be shipped inside the new one.
   *
   * The `.tar.gz` beside them is NOT junk, however much it looks like a build leftover: for the
   * WebAssembly games it is the game itself, fetched by the Python loader at startup. Deleting
   * it produced an app that loaded its entire interpreter and then had nothing to run.
   */
  for (const junk of ['favicon.png', `${game.slug.replace(/-/g, '')}.apk`]) {
    await rm(join(bundleDir, junk), { force: true });
  }

  return (await countFiles(bundleDir));
}

async function countFiles(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

// ── build ───────────────────────────────────────────────────────────────────

const results = [];

for (const game of games) {
  const label = game.title.padEnd(18);
  const dir = join(WORK, game.slug);
  process.stdout.write(`  ${label}`);

  try {
    await rm(dir, { recursive: true, force: true });
    const bundleDir = join(dir, 'bundle');
    await mkdir(bundleDir, { recursive: true });

    const fileCount = await stageBundle(game, bundleDir);

    await writeFile(join(dir, 'config.json'), JSON.stringify({
      meta: {
        packageId: game.packageId,
        title: game.title,
        orientation: game.orientation,
      },
      theme: { palette: game.palette },
    }, null, 2), 'utf8');

    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'build-apk.mjs'), dir], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });

    if (r.status !== 0) {
      // The failing stage is the useful line; the rest is a toolchain trace nobody reads.
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const why = out.split(/\r?\n/).filter((l) => /FAILED|Error|✖|missing|problem|- /.test(l));
      throw new Error(why.slice(0, 6).join('\n      ').trim() || `build-apk exited ${r.status}`);
    }

    const built = (await readdir(dir)).find((f) => f.endsWith('.apk'));
    if (!built) throw new Error('build reported success but produced no .apk');

    const dest = join(OUT, `${game.slug}.apk`);
    await cp(join(dir, built), dest);
    const { size } = await stat(dest);

    // Keep the workspace only when something failed — these are hundreds of MB across twelve
    // games, and every byte of it is reproducible from docs/.
    await rm(dir, { recursive: true, force: true });

    results.push({ game, size, files: fileCount });
    console.log(`${c.ok('ok')}   ${(size / 1024 / 1024).toFixed(2).padStart(6)} MB  ${c.dim(`${fileCount} files`)}`);
  } catch (err) {
    results.push({ game, error: err.message });
    console.log(c.err('FAILED'));
    console.log(c.dim(`      ${err.message.replace(/\n/g, '\n      ')}`));
  }
}

// ── report ──────────────────────────────────────────────────────────────────

const built = results.filter((r) => !r.error);
const failed = results.filter((r) => r.error);
const total = built.reduce((n, r) => n + r.size, 0);

console.log('');
if (built.length) {
  console.log(c.ok(`✓ ${built.length} APK${built.length === 1 ? '' : 's'} built`));
  console.log(`  output   assets/apk/   ${(total / 1024 / 1024).toFixed(1)} MB total`);
}
if (failed.length) {
  console.log(c.warn(`⚠ ${failed.length} could not be built:`));
  for (const f of failed) console.log(`    ${f.game.slug}`);
}
console.log(c.dim('\n  publish them with:  node tools/publish-web.mjs\n'));

process.exit(failed.length && !built.length ? 1 : 0);
