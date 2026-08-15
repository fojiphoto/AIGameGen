#!/usr/bin/env node
/**
 * Serve `docs/` at the same path GitHub Pages will.
 *
 *   node tools/serve-docs.mjs [port]
 *
 * This exists because of a bug that only appeared in production. GitHub Pages serves a project
 * site under the repository name, so a game page lives at `/AIGameGen/play/<slug>/`, while a
 * plain `python -m http.server` in `docs/` puts it at `/play/<slug>/`. Everything that resolves
 * relative to the page behaves identically under both — and everything that resolves against a
 * *root-absolute* path does not. The runtime base is root-absolute for good reasons (see
 * `brand-loader`), so testing it anywhere but the real base tests the wrong URLs.
 *
 * It also refuses to serve outside `docs/`, and does not change its own working directory — a
 * server whose cwd is inside `docs/` locks that directory on Windows, which then makes publishing
 * fail with EBUSY when it tries to delete it.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { SITE_BASE } from './brand-loader.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');
const PORT = Number(process.argv[2]) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.apk': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.data': 'application/octet-stream',
  '.whl': 'application/octet-stream',
  '.py': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  if (path === '/') {
    res.writeHead(302, { Location: SITE_BASE });
    res.end();
    return;
  }
  if (!path.startsWith(SITE_BASE)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found. This server mounts docs/ at ${SITE_BASE}, matching GitHub Pages.\n`);
    return;
  }

  let rel = path.slice(SITE_BASE.length) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  // Contain the served tree: a normalised path must still sit inside docs/.
  const file = normalize(join(DOCS, rel));
  if (!file.startsWith(DOCS + sep) && file !== DOCS) {
    res.writeHead(403).end('Forbidden\n');
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: path.endsWith('/') ? path + 'index.html' : path + '/' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      // Local testing wants to see the build that was just made, not the one before it.
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${rel}\n`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n\x1b[1mserving docs/ as GitHub Pages does\x1b[0m`);
  console.log(`  arcade      http://127.0.0.1:${PORT}${SITE_BASE}`);
  console.log(`  block bloom http://127.0.0.1:${PORT}${SITE_BASE}play/block-bloom/`);
  console.log(`  neon coil   http://127.0.0.1:${PORT}${SITE_BASE}play/neon-coil/\n`);
});
