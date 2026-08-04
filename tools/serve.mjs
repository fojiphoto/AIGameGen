#!/usr/bin/env node
/**
 * Minimal static server for previewing generated bundles.
 *   node tools/serve.mjs artifacts/954ush/bundle 5180
 *
 * Dev-only: no directory listing, no range requests, path-traversal guarded.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, extname, normalize } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 5180);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const target = join(root, normalize(rel).replace(/^(\.\.[\\/])+/, ''));
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const s = await stat(target);
    const file = s.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(port, () => {
  console.log(`serving ${root}`);
  console.log(`  http://localhost:${port}/`);
});
