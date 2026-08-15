#!/usr/bin/env node
/**
 * Serve any directory over HTTP, for local testing.
 *
 *   node tools/serve-static.mjs <dir> [port]
 *
 * Small on purpose. `tools/serve-docs.mjs` exists to reproduce GitHub Pages' project-site path
 * exactly, which is the right tool for testing a deploy; this one is for pointing a browser at a
 * build directory while it is still being written, where the path prefix is irrelevant and
 * waiting for a publish is not.
 *
 * `no-store` on everything, because the whole point is to see the build that was just made.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const PORT = Number(process.argv[3]) || 8850;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (path.endsWith('/')) path += 'index.html';

  const file = normalize(join(ROOT, path));
  // Contain the served tree: a normalised path must still sit inside the root.
  if (!file.startsWith(ROOT + sep) && file !== ROOT) {
    res.writeHead(403).end('Forbidden\n');
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: path + '/' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${path}\n`);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nserving ${ROOT}`);
  console.log(`  http://127.0.0.1:${PORT}/\n`);
});
