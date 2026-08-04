/**
 * §C6 Bundler — turns (config + levels) into a self-contained static bundle.
 *
 * HARD REQUIREMENT: zero network calls at runtime. No CDN, no Google Fonts, no
 * analytics beacon. That is precisely what makes the APK work in airplane mode,
 * and `assertSelfContained()` below enforces it rather than trusting us to
 * remember.
 */

import { readFile, writeFile, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAnyRuntimePayload } from '@forge/generation/genres';

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(here, '..', '..', 'engine-runner');
const SHELL = join(ENGINE_DIR, 'src', 'shell.html');
const ENGINE_JS = join(ENGINE_DIR, 'dist', 'game.js');

/** Hosts and schemes that must never appear in a shipped bundle. */
const FORBIDDEN = [
  'http://', 'https://',
  'fonts.googleapis.com', 'fonts.gstatic.com',
  'googletagmanager.com', 'google-analytics.com',
  'clarity.ms', 'connect.facebook.net',
];

/**
 * U+2028 / U+2029 - legal in JSON, illegal in pre-ES2019 JS string literals.
 * Built from char codes, never written literally: a raw separator in source IS
 * a line break, which silently breaks the regex literal containing it.
 */
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), 'g');
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), 'g');

/**
 * Escape a JSON string for safe injection into a <script> element body.
 *   • `</` could otherwise terminate the script element early
 *   • the separators above still break old Android WebView parsers
 */
export function escapeForScript(json) {
  return json
    .replace(/<\//g, '<\\/')
    .replace(LINE_SEP, '\\u2028')
    .replace(PARA_SEP, '\\u2029');
}

/**
 * @param {{config:object, levels:Array, outDir:string}} args
 * @returns {Promise<{outDir:string, files:Array, totalBytes:number, payloadBytes:number}>}
 */
export async function bundleGame({ config, levels, outDir }) {
  try {
    await stat(ENGINE_JS);
  } catch {
    throw new Error(`engine bundle missing at ${ENGINE_JS} — run "npm run build:engine" first`);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const payload = buildAnyRuntimePayload(config, levels);
  const payloadJson = JSON.stringify(payload);

  const shell = await readFile(SHELL, 'utf8');
  const html = shell
    .replaceAll('__TITLE__', escapeHtml(config.meta.title))
    .replaceAll('__BG__', config.theme.palette.bg)
    .replaceAll('__TEXT__', config.theme.palette.text)
    .replace('__PAYLOAD__', escapeForScript(payloadJson));

  await writeFile(join(outDir, 'index.html'), html, 'utf8');
  await copyFile(ENGINE_JS, join(outDir, 'game.js'));
  // keep the runtime payload beside the bundle for debugging & reproducible rebuilds
  await writeFile(join(outDir, 'game.json'), JSON.stringify(payload, null, 2), 'utf8');

  await assertSelfContained(join(outDir, 'index.html'));

  const files = [];
  let totalBytes = 0;
  for (const f of ['index.html', 'game.js']) {
    const s = await stat(join(outDir, f));
    files.push({ name: f, bytes: s.size });
    totalBytes += s.size;
  }

  return { outDir, files, totalBytes, payloadBytes: Buffer.byteLength(payloadJson) };
}

/**
 * Fails the build if the bundle references anything external.
 * A silent regression here would produce an APK that looks fine on wifi and
 * breaks in airplane mode — the worst possible failure mode for this product.
 */
export async function assertSelfContained(htmlPath) {
  const html = await readFile(htmlPath, 'utf8');
  // the inlined payload legitimately contains arbitrary strings; scan the shell only
  const stripped = html.replace(/window\.__GAME__\s*=[\s\S]*?<\/script>/, '');
  const found = FORBIDDEN.filter((needle) => stripped.includes(needle));
  if (found.length) {
    throw new Error(
      `bundle is not self-contained — found external reference(s): ${found.join(', ')}. ` +
        `Offline APKs must have zero network dependencies.`
    );
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
