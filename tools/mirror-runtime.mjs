#!/usr/bin/env node
/**
 * Mirror pygbag's WebAssembly runtime into this repository.
 *
 *   node tools/mirror-runtime.mjs
 *
 * Why: the generated page fetches its runtime — CPython, the standard library, and pygame,
 * compiled to WebAssembly — from `pygame-web.github.io`. That is a free GitHub Pages site like
 * ours, but it is not ours, and when it fails the games do not start. It failed while this was
 * being written: `NO DATA RECEIVED`, and both games stalled on a loading screen.
 *
 * Mirroring it costs nothing. GitHub Pages already serves `docs/`, the whole runtime is 21.9 MB
 * on disk and about 10.5 MB over the wire once gzipped, and the limits are 1 GB of site and
 * 100 GB of bandwidth a month. There is no service to buy and no account to open.
 *
 * What it does *not* do is make the download smaller. Both hosts are the same infrastructure, and
 * the 21.9 MB is CPython plus its standard library plus pygame; that is the price of running
 * Python in a browser, not a fault to be optimised away. What mirroring buys is that the games no
 * longer depend on someone else's repository staying up, and that everything comes from one
 * origin — which is also what makes the preload hints in `brand-loader` work.
 *
 * The mirror lives outside `docs/` because publishing deletes `docs/` first; the site build copies
 * it in. Files already present are left alone, so re-running this is cheap.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const OK = '\x1b[32m';
const WARN = '\x1b[33m';
const RESET = '\x1b[0m';

const ROOT = resolve(import.meta.dirname, '..');
export const MIRROR_DIR = join(ROOT, 'vendor', 'pygbag-runtime');

//: The pygbag release the games are built against. Mirroring is pinned to it on purpose: an
//: upgrade should be a deliberate act with a re-test, not something that happens because an
//: upstream site changed under us.
export const PYGBAG_VERSION = '0.9.3';
export const CDN_BASE = `https://pygame-web.github.io/cdn/`;

/**
 * Paths relative to the CDN root. The layout is preserved exactly, because the loader builds some
 * URLs by walking up from the version directory (`0.9.3/../vt/`), so a flattened mirror would
 * break in ways that only show at runtime.
 */
export const FILES = [
  `${PYGBAG_VERSION}/pythons.js`,
  `${PYGBAG_VERSION}/cpythonrc.py`,
  `${PYGBAG_VERSION}/empty.html`,
  `${PYGBAG_VERSION}/cpython312/main.js`,
  `${PYGBAG_VERSION}/cpython312/main.data`,
  `${PYGBAG_VERSION}/cpython312/main.wasm`,
  `index-${PYGBAG_VERSION}-cp312.json`,
  'cp312/pygame_ce-2.5.7-cp312-cp312-wasm32_bi_emscripten.whl',
  // The terminal layer. `pythons.js` imports these dynamically, so nothing fails until the page
  // is actually opened — which is how the first mirror shipped without them and died on
  // "Failed to fetch dynamically imported module: .../vtx.js" after loading everything else.
  'vt.js',
  'vtx.js',
  'vt/xterm.js',
  'vt/xterm.css',
  'vt/xterm-addon-image.js',
  // Not listed: xtermjsixel/xterm-addon-image-worker.js. The terminal asks for it and it 404s on
  // the upstream CDN too, so it is optional there as well — sixel image support degrades and
  // nothing else notices. Discovery will find it, fail to fetch it, and say so.
];

/**
 * Files a mirrored script asks for that were not in the list above.
 *
 * A hand-written list of a third party's internals is a list that is wrong the moment they change
 * anything, and the failure mode is the worst kind: everything loads, then one dynamic import
 * 404s and the page dies with no game. So after fetching, each JavaScript file is scanned for
 * relative paths and anything new is fetched too, repeatedly, until nothing new appears.
 */
function referencesIn(text, fromDir) {
  const out = new Set();
  // Only things that are actually loaded as modules or assets: a dynamic `import(...)`, a
  // `<script src=...>`, or a stylesheet href. Matching every quoted string that happens to end in
  // `.py` or `.js` was the first version and it produced 359 phantom paths — Python filenames the
  // runtime writes at run time, fragments of template strings — each costing a request per run.
  const patterns = [
    /import\(\s*["'`]([^"'`]+)["'`]/g,
    /<script[^>]*\ssrc=["']([^"']+)["']/g,
    /\shref=["']([^"']+\.css)["']/g,
  ];
  const raws = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) raws.push(m[1]);
  }
  for (const raw of raws) {
    if (raw.startsWith('http') || raw.startsWith('//') || raw.startsWith('/tmp')) continue;
    // Resolve against the directory the referring file lives in.
    const parts = (fromDir ? fromDir.split('/') : []).filter(Boolean);
    for (const seg of raw.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const resolved = parts.join('/');
    if (resolved && !resolved.includes('${')) out.add(resolved);
  }
  return out;
}

/** The big ones, worth telling the browser about before it has parsed anything. */
export const PRELOAD = [
  `${PYGBAG_VERSION}/cpython312/main.wasm`,
  `${PYGBAG_VERSION}/cpython312/main.data`,
  `${PYGBAG_VERSION}/cpython312/main.js`,
  'cp312/pygame_ce-2.5.7-cp312-cp312-wasm32_bi_emscripten.whl',
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function mirrorRuntime({ force = false } = {}) {
  console.log(`\n${BOLD}mirror the pygbag runtime${RESET} ${DIM}${CDN_BASE}${RESET}`);
  let fetched = 0;
  let skipped = 0;
  let bytes = 0;

  const queue = [...FILES];
  const seen = new Set(queue);
  const missing = [];

  while (queue.length) {
    const rel = queue.shift();
    const dest = join(MIRROR_DIR, rel);
    let buf;

    if (!force && (await exists(dest))) {
      skipped += 1;
      buf = await readFile(dest);
    } else {
      const res = await fetch(CDN_BASE + rel);
      if (!res.ok) {
        // Only the explicitly listed files are required. A discovered reference that 404s is
        // usually a path built at runtime from a template string, or an optional feature — worth
        // reporting, not worth failing the mirror over.
        if (FILES.includes(rel)) throw new Error(`${CDN_BASE}${rel} -> HTTP ${res.status}`);
        missing.push(rel);
        continue;
      }
      buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      fetched += 1;
      bytes += buf.length;
      console.log(`  ${OK}got${RESET}  ${(buf.length / 1024).toFixed(0).padStart(6)}K  ${rel}`);
    }

    if (rel.endsWith('.js')) {
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      for (const ref of referencesIn(buf.toString('utf8'), dir)) {
        if (!seen.has(ref)) {
          seen.add(ref);
          queue.push(ref);
        }
      }
    }
  }

  if (skipped) console.log(`  ${DIM}${skipped} already mirrored${RESET}`);
  if (fetched) console.log(`  ${DIM}${(bytes / 1024 / 1024).toFixed(1)} MB fetched${RESET}`);
  if (missing.length) {
    console.log(`  ${DIM}${missing.length} discovered path(s) not on the CDN, skipped: `
                + `${missing.slice(0, 4).join(', ')}${RESET}`);
  }
  return { fetched, skipped, missing };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
    || process.argv[1]?.endsWith('mirror-runtime.mjs')) {
  try {
    await mirrorRuntime({ force: process.argv.includes('--force') });
    console.log(`\n${OK}${BOLD}runtime mirrored${RESET} ${DIM}${MIRROR_DIR}${RESET}`);
  } catch (err) {
    console.error(`\n${WARN}mirror failed: ${err.message}${RESET}`);
    process.exitCode = 1;
  }
}
