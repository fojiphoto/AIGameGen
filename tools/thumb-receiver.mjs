#!/usr/bin/env node
/**
 * Receive canvas captures from a running game and write them to disk.
 *
 *   node tools/thumb-receiver.mjs [port]
 *
 * The seven generated games only exist as a running canvas, so their cover art has to come from a
 * real browser. Getting the pixels *out* of that browser is the awkward part: the automation's own
 * screenshot lands somewhere unreachable, and a data URL is far too large to pass back through a
 * tool result. So the page posts it here instead — one call per game, no size limit, and the image
 * is the canvas itself rather than a photograph of the browser window with its chrome in shot.
 *
 * Cross-origin on purpose: the games are served from another port, so the browser needs the
 * permissive header below. It listens on loopback only and writes one fixed directory, which is as
 * much containment as a build-time tool needs.
 *
 * Capturing a Phaser game, in the page console, has three parts that are all non-obvious:
 *
 *   1. `canvas.toDataURL()` returns solid black. WebGL discards the drawing buffer after each
 *      present unless `preserveDrawingBuffer` is set, which it is not. Use Phaser's own
 *      `game.renderer.snapshot(cb)` instead — it reads the buffer at the right moment in the frame,
 *      and only fires once another render happens.
 *   2. A background tab fires no requestAnimationFrame, so the game does not advance and the
 *      snapshot never resolves. Drive it by hand: `game.loop.step(t)` with `t` stepped by 1000/60.
 *   3. Every game opens on a menu, so stepping frames captures the menu. Enter play by emitting
 *      pointer events on the scene's own interactive objects —
 *      `scene.children.list.filter(o => o.input?.enabled)` then `o.emit('pointerdown', {}, o)` —
 *      rather than dispatching DOM events, which Phaser's input manager ignores while the pointer
 *      is not really over the canvas. From there, play the game through its own state: `flap()` on
 *      the fly scene, `nextDir` on snake. A frame of a game being *played* is the whole point.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'assets', 'thumb-src');
const PORT = Number(process.argv[2]) || 8841;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, CORS).end('POST a data URL to /thumb?slug=<slug>\n');
    return;
  }

  const slug = new URL(req.url, 'http://localhost').searchParams.get('slug');
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    res.writeHead(400, CORS).end('bad or missing slug\n');
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const comma = body.indexOf(',');
  if (!body.startsWith('data:image/') || comma === -1) {
    res.writeHead(400, CORS).end('expected an image data URL\n');
    return;
  }

  const png = Buffer.from(body.slice(comma + 1), 'base64');
  await mkdir(OUT, { recursive: true });
  const dest = join(OUT, `${slug}.png`);
  await writeFile(dest, png);
  console.log(`  got  ${(png.length / 1024).toFixed(0).padStart(5)}K  ${slug}.png`);
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' }).end(`saved ${png.length}\n`);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nthumb receiver on http://127.0.0.1:${PORT}/thumb?slug=<slug>`);
  console.log(`writing to ${OUT}\n`);
});
