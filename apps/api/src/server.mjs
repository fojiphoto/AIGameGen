/**
 * Forge API + web server.
 *
 * One process serves the API, the generated game bundles, and the frontend. For a
 * local-only SaaS demo that is a feature: `node apps/api/src/server.mjs` is the whole
 * run command, with no build step and no second dev server to keep alive.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import * as db from '@forge/db';
import { hasApiKey } from '@forge/ai';
import routes from './routes.mjs';
import adminRoutes from './routes-admin.mjs';
import { identityHook } from './auth.mjs';
import { ARTIFACTS } from './pipeline.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const WEB = join(ROOT, 'apps', 'web');
const PORT = Number(process.env.PORT || 8787);

db.open();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'warn' },
  bodyLimit: 512 * 1024,
  /**
   * OFF by default. With trustProxy on, Fastify derives req.ip from `x-forwarded-for` —
   * and with no real proxy in front, any client can set that header freely and walk
   * straight past every per-IP rate limit. Only enable this when actually deployed
   * behind a proxy that overwrites the header.
   */
  trustProxy: process.env.TRUST_PROXY === 'true',
});

await app.register(cors, { origin: true, credentials: true });
await app.register(cookie, { hook: 'onRequest' });

/**
 * Body-less POSTs (build, logout, checkout) arrive with a content-type Fastify has no
 * parser for, and it answers 415. This catch-all only sees types the built-in JSON
 * parser did not claim.
 */
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
  if (!body || body.length === 0) return done(null, {});
  try {
    done(null, JSON.parse(body.toString('utf8')));
  } catch {
    done(null, {});
  }
});

// identity on every request, before any route or guard runs
app.addHook('onRequest', async (req, reply) => identityHook(req, reply));

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send({ error: status >= 500 ? 'Something went wrong.' : err.message, code: err.code ?? null });
});

// ─── generated game bundles ─────────────────────────────────────────────────

await app.register(fastifyStatic, {
  root: ARTIFACTS,
  prefix: '/play/',
  index: ['index.html'],
  setHeaders(res, path) {
    // the engine bundle is identical across games and never changes; the html embeds
    // the config and must not be cached
    res.setHeader('cache-control', path.endsWith('game.js') ? 'public, max-age=31536000, immutable' : 'no-store');
  },
});

// ─── frontend assets ────────────────────────────────────────────────────────

await app.register(fastifyStatic, {
  root: join(WEB, 'assets'),
  prefix: '/assets/',
  decorateReply: false,
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
});

// ─── api ────────────────────────────────────────────────────────────────────

await app.register(routes);
await app.register(adminRoutes);

// ─── pages ──────────────────────────────────────────────────────────────────

const PAGES = {
  '/': 'landing.html',
  '/studio': 'studio.html',
  '/dashboard': 'dashboard.html',
  '/arcade': 'arcade.html',
  '/billing': 'billing.html',
  '/login': 'auth.html',
  '/signup': 'auth.html',
  '/admin': 'admin.html',
  '/terms': 'legal.html',
  '/privacy': 'legal.html',
};

const pageCache = new Map();
async function servePage(file, reply) {
  const path = join(WEB, file);
  if (!existsSync(path)) return reply.code(404).type('text/plain').send('page not found');
  let html = pageCache.get(file);
  if (!html || process.env.NODE_ENV !== 'production') {
    html = await readFile(path, 'utf8');
    pageCache.set(file, html);
  }
  return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
}

for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, reply) => servePage(file, reply));
}

// detail pages take an id in the path; the page fetches its own data client-side
app.get('/game/:id', (req, reply) => servePage('game.html', reply));
app.get('/export/:id', (req, reply) => servePage('export.html', reply));

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found.' });
  // Status matters: a soft-404 that answers 200 gets junk URLs indexed by crawlers.
  reply.code(404);
  return servePage('404.html', reply);
});

// ─── housekeeping ───────────────────────────────────────────────────────────

// Cheap periodic cleanup. A real deployment would use a cron; for a single local
// process an interval is honest and adequate.
const housekeeping = setInterval(() => {
  try {
    db.purgeExpiredSessions();
    db.purgeRateEvents();
  } catch (err) {
    app.log.warn({ err }, 'housekeeping failed');
  }
}, 60 * 60 * 1000);
housekeeping.unref();

// ─── start ──────────────────────────────────────────────────────────────────

/** Seed a first admin so a fresh install has someone who can reach /admin. */
function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@factorialstudio.com';
  const password = process.env.ADMIN_PASSWORD || 'forge-admin-2026';
  const existing = db.getUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') db.setUserRole(existing.id, 'admin');
    return { email, created: false };
  }
  db.createUser({ email, password, displayName: 'Admin', role: 'admin' });
  return { email, password, created: true };
}

const admin = ensureAdmin();

/**
 * Seed a few public games on an empty install so the landing page always has a live,
 * playable demo. A marketing page whose hero says "playable right now" and then shows
 * an empty state is worse than not making the claim.
 */
async function seedDemos() {
  const { IMPLEMENTED_GENRES } = await import('@forge/schema/genres');
  // One public demo per implemented template, so the arcade and the landing page show the
  // actual breadth of the product instead of three variations of one game.
  const existing = db.listPublicGames({ limit: 200 });
  const have = new Set(existing.map((g) => g.genre));
  const missing = IMPLEMENTED_GENRES.filter((g) => !have.has(g));
  if (!missing.length) return 0;

  const { generateGame } = await import('./pipeline.mjs');
  const themes = [
    'neon cyberpunk city', 'underwater coral reef', 'lava volcano depths',
    'arctic glacier', 'deep space station', 'emerald jungle canopy',
  ];
  let made = 0;
  for (const [i, genre] of missing.entries()) {
    try {
      const { game } = await generateGame({
        prompt: themes[i % themes.length],
        genre,
        user: null,
        anonKey: null,
        deterministic: true,
      });
      db.setVisibility(game.id, 'public');
      made++;
    } catch (err) {
      console.warn(`  seed failed for ${genre}: ${err.message}`);
    }
  }
  return made;
}

const seeded = await seedDemos();

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  const stats = db.platformStats();
  console.log(`\n  \x1b[1mFORGE\x1b[0m  http://localhost:${PORT}`);
  console.log(`  mode      ${hasApiKey() ? 'llm (ANTHROPIC_API_KEY set)' : 'deterministic (no API key — everything still works)'}`);
  console.log(`  db        ${process.env.DB_PATH || 'data/forge.db'}  ·  ${stats.users} users, ${stats.games} games`);
  if (admin.created) {
    console.log(`  admin     ${admin.email} / ${admin.password}   \x1b[2m(change ADMIN_PASSWORD in .env)\x1b[0m`);
  } else {
    console.log(`  admin     ${admin.email}`);
  }
  if (seeded) console.log(`  seeded    ${seeded} public demo games for the landing page`);
  console.log('');
} catch (err) {
  console.error(err);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
