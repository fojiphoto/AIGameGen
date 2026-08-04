/**
 * Builds the engine ONCE into dist/game.js.
 *
 * Every generated game reuses this exact file — only the inlined config differs.
 * That means the expensive part of "generating a game" is a file copy, and the
 * engine bundle stays cacheable across every game on the CDN.
 *
 * target: es2019 — Android WebView on Android 8/9 devices is still out there and
 * chokes on newer syntax (optional chaining in particular). esbuild downlevels.
 */

import { build } from 'esbuild';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, 'dist', 'game.js');

await mkdir(join(here, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [join(here, 'src', 'main.mjs')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2019'],
  platform: 'browser',
  outfile,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    // Phaser gates dev-only and optional subsystems behind these globals.
    // esbuild's `define` only accepts identifiers (not `typeof X`), but defining
    // the identifier is enough — Phaser's `typeof CANVAS_RENDERER` folds to
    // `typeof true` and evaluates correctly.
    CANVAS_RENDERER: 'true',
    WEBGL_RENDERER: 'true',
    WEBGL_DEBUG: 'false',
    EXPERIMENTAL: 'false',
    PLUGIN_3D: 'false',
    PLUGIN_CAMERA3D: 'false',
    PLUGIN_FBINSTANT: 'false',
    FEATURE_SOUND: 'false',
  },
});

const { size } = await stat(outfile);
console.log(`engine bundle: ${(size / 1024).toFixed(0)} KB  →  ${outfile}`);
if (result.warnings.length) console.log(`${result.warnings.length} warning(s)`);
