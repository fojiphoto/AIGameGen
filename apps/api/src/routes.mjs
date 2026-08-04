/**
 * Public API routes. Admin routes live in routes-admin.mjs behind requireAdmin.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as db from '@forge/db';
import { PALETTES, REFINE_EXAMPLES, hasApiKey, checkBlocked } from '@forge/ai';
import { genreCatalogue, isImplemented, IMPLEMENTED_GENRES } from '@forge/schema/genres';

/** Reject an unknown genre loudly rather than silently generating the default one. */
function normaliseGenre(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = String(value);
  if (!isImplemented(id)) {
    const e = new Error(`"${id}" is not an available template yet.`);
    e.code = 'GENRE_NOT_IMPLEMENTED';
    e.statusCode = 422;
    throw e;
  }
  return id;
}
import {
  generateGame, refineGame, remixGame, publicGame, gameDir, ensureAffordable,
} from './pipeline.mjs';
import { buildQueue } from './queue.mjs';
import {
  requireUser, assertCanEdit, assertCanView, limit, clientIp,
  setSessionCookie, clearSessionCookie, validateCredentials,
} from './auth.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

function sse(reply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  return {
    send: (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => reply.raw.end(),
  };
}

const errorPayload = (err) => ({
  error: err.message,
  code: err.code ?? null,
  ...(err.details ? { details: err.details } : {}),
  ...(err.required ? { required: err.required, balance: err.balance } : {}),
  ...(err.examples ? { examples: err.examples } : {}),
});

const send = (reply, err) => reply.code(err.statusCode ?? 500).send(errorPayload(err));

export default async function routes(app) {
  // ─── meta ────────────────────────────────────────────────────────────────

  app.get('/health', async () => ({
    ok: true,
    mode: hasApiKey() ? 'llm' : 'deterministic',
    liveGenres: IMPLEMENTED_GENRES,
    buildConcurrency: buildQueue.concurrency,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/api/meta', async (req) => ({
    mode: hasApiKey() ? 'llm' : 'deterministic',
    liveGenres: IMPLEMENTED_GENRES,
    refineExamples: REFINE_EXAMPLES,
    genres: genreCatalogue(),
    creditCosts: db.CREDIT_COSTS,
    packs: db.CREDIT_PACKS,
    stats: db.platformStats(),
    user: req.user ? sessionUser(req.user) : null,
  }));

  app.get('/api/palettes', async () => ({
    palettes: PALETTES.map((p) => ({ id: p.id, mood: p.mood, styleTags: p.styleTags, palette: p.palette })),
  }));

  // ─── auth ────────────────────────────────────────────────────────────────

  const sessionUser = (u) => ({
    id: u.id, email: u.email, displayName: u.display_name, role: u.role,
    credits: db.getBalance(u.id), createdAt: u.created_at,
  });

  app.post('/api/auth/signup', async (req, reply) => {
    try {
      limit(req, 'signup');
      const { email, password, displayName, errors } = validateCredentials(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors[0], errors });
      if (db.getUserByEmail(email)) {
        return reply.code(409).send({ error: 'That email is already registered.', code: 'EMAIL_TAKEN' });
      }
      const user = db.createUser({ email, password, displayName });
      // claim anything generated before signing up
      const claimed = req.anonKey ? db.claimAnonGames(req.anonKey, user.id) : 0;
      const { token, expiresAt } = db.createSession(user.id, clientIp(req));
      setSessionCookie(reply, token, expiresAt);
      return { user: sessionUser(user), claimedGames: claimed };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    try {
      limit(req, 'login');
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      const row = db.getUserByEmail(email);
      // Same message and roughly the same work either way, so the response does not
      // reveal whether an account exists.
      const ok = row && db.verifyPassword(password, row.password_salt, row.password_hash);
      if (!ok) return reply.code(401).send({ error: 'Email or password is incorrect.', code: 'BAD_CREDENTIALS' });
      if (row.status === 'suspended') return reply.code(403).send({ error: 'This account is suspended.' });

      const claimed = req.anonKey ? db.claimAnonGames(req.anonKey, row.id) : 0;
      const { token, expiresAt } = db.createSession(row.id, clientIp(req));
      setSessionCookie(reply, token, expiresAt);
      return { user: sessionUser(row), claimedGames: claimed };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.forge_session;
    if (token) db.deleteSession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user ? sessionUser(req.user) : null }));

  // ─── generate ────────────────────────────────────────────────────────────

  function validatePrompt(body) {
    const prompt = String(body?.prompt ?? '').trim();
    if (prompt.length < 3) {
      const e = new Error('Describe your game in a few words.');
      e.statusCode = 400;
      throw e;
    }
    if (prompt.length > 600) {
      const e = new Error('That prompt is too long (600 characters max).');
      e.statusCode = 400;
      throw e;
    }
    // Checked BEFORE the rate limiter on purpose. A blocked prompt costs us nothing —
    // a plain string scan — so burning the caller's hourly quota for it just punishes
    // someone who typed "mario" once. Cheap enough that it is not a DoS vector.
    const block = checkBlocked(prompt);
    if (block.blocked) {
      const e = new Error(block.reason);
      e.code = 'PROMPT_BLOCKED';
      e.statusCode = 422;
      throw e;
    }
    return prompt;
  }

  app.post('/api/generate', async (req, reply) => {
    try {
      const prompt = validatePrompt(req.body);
      limit(req, req.user ? 'userGenerate' : 'anonGenerate');
      const out = await generateGame({
        prompt, user: req.user, anonKey: req.anonKey,
        deterministic: Boolean(req.body?.deterministic),
        genre: normaliseGenre(req.body?.genre),
      });
      return { game: publicGame(out.game), source: out.source, notes: out.notes };
    } catch (err) {
      return send(reply, err);
    }
  });

  /**
   * Streaming generate.
   *
   * The stream is opened BEFORE validation, rate limiting or the balance check, and every
   * failure is delivered as an SSE `error` event rather than an HTTP status. That looks
   * backwards, but EventSource cannot read the body of a non-200 response — answering 429
   * or 402 here leaves the browser with an untyped `error` event and the user with
   * "something went wrong" instead of "rate limit reached" or "not enough credits".
   * Opening the stream first is the only way the client can show the real reason.
   */
  app.get('/api/generate/stream', async (req, reply) => {
    const s = sse(reply);
    try {
      const prompt = validatePrompt({ prompt: req.query.prompt });
      limit(req, req.user ? 'userGenerate' : 'anonGenerate');
      ensureAffordable(req.user, 'generate');
      const out = await generateGame({
        prompt, user: req.user, anonKey: req.anonKey,
        deterministic: req.query.deterministic === 'true',
        genre: normaliseGenre(req.query.genre),
        onStage: (stage, detail) => s.send('stage', { stage, detail }),
      });
      s.send('done', { game: publicGame(out.game), source: out.source, notes: out.notes });
    } catch (err) {
      if ((err.statusCode ?? 500) >= 500) req.log.error(err);
      s.send('error', errorPayload(err));
    }
    s.end();
  });

  // ─── games ───────────────────────────────────────────────────────────────

  app.get('/api/games', async (req) => {
    const games = req.user ? db.listGamesByUser(req.user.id) : db.listGamesByAnonKey(req.anonKey);
    return { games: games.map((g) => publicGame(g)) };
  });

  app.get('/api/games/:id', async (req, reply) => {
    try {
      const game = db.getGame(req.params.id);
      assertCanView(req, game);
      return { game: publicGame(game, { includeConfig: true }), versions: db.listVersions(game.id) };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post('/api/games/:id/refine', async (req, reply) => {
    try {
      const game = db.getGame(req.params.id);
      assertCanEdit(req, game);
      const instruction = String(req.body?.instruction ?? '').trim();
      if (instruction.length < 2) return reply.code(400).send({ error: 'Describe the change you want.' });
      const out = await refineGame({
        gameId: game.id, instruction, user: req.user,
        deterministic: Boolean(req.body?.deterministic),
      });
      return { game: publicGame(out.game), summary: out.summary, patch: out.patch, source: out.source };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post('/api/games/:id/visibility', async (req, reply) => {
    try {
      const game = db.getGame(req.params.id);
      assertCanEdit(req, game);
      if (!game.user_id) {
        return reply.code(401).send({ error: 'Sign in to publish a game.', code: 'AUTH_REQUIRED' });
      }
      const visibility = req.body?.visibility === 'public' ? 'public' : 'private';
      db.setVisibility(game.id, visibility);
      return { game: publicGame(db.getGame(game.id)) };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post('/api/games/:id/remix', async (req, reply) => {
    try {
      const src = db.getGame(req.params.id);
      assertCanView(req, src);
      limit(req, req.user ? 'userGenerate' : 'anonGenerate');
      const game = await remixGame({ sourceGameId: src.id, user: req.user, anonKey: req.anonKey });
      return { game: publicGame(game) };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.delete('/api/games/:id', async (req, reply) => {
    try {
      const game = db.getGame(req.params.id);
      assertCanEdit(req, game);
      db.deleteGame(game.id);
      return reply.code(204).send();
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post('/api/games/:id/report', async (req, reply) => {
    try {
      limit(req, 'report');
      const game = db.getGame(req.params.id);
      if (!game) return reply.code(404).send({ error: 'Game not found.' });
      const reason = String(req.body?.reason ?? 'other').slice(0, 40);
      // De-duplicated by reporter (user id, or anon key when signed out) so one visitor
      // cannot force the auto-unpublish threshold below by reporting the same game
      // repeatedly — createReport() is a no-op if this reporter already reported it.
      db.createReport({
        gameId: game.id, reporterId: req.user?.id ?? null, reporterKey: req.user?.id ?? req.anonKey ?? null,
        reason, notes: String(req.body?.notes ?? '').slice(0, 500),
      });
      // Auto-unpublish once a game accumulates reports, pending review (§G2).
      if (db.countOpenReports(game.id) >= 3 && game.visibility === 'public') {
        db.setGameStatus(game.id, 'unpublished');
      }
      return { ok: true };
    } catch (err) {
      return send(reply, err);
    }
  });

  // ─── APK builds ──────────────────────────────────────────────────────────

  app.post('/api/games/:id/build', async (req, reply) => {
    try {
      const game = db.getGame(req.params.id);
      assertCanEdit(req, game);
      if (!existsSync(join(gameDir(game.id), 'bundle', 'index.html'))) {
        return reply.code(409).send({ error: 'No bundle for this game — regenerate it first.' });
      }

      // Idempotent: an existing APK for this exact version is free and instant.
      const done = db.findReadyBuild(game.id, game.current_version);
      if (done) {
        return { buildId: done.id, status: 'ready', cached: true, statusUrl: `/api/builds/${done.id}` };
      }

      // Detect an in-flight build for this exact version BEFORE charging. Without this,
      // a double-click (or any second request before the first build finishes) charges
      // 15 credits for a build whose worker never runs — buildQueue.enqueue() silently
      // dedupes by key and the second request's row is stuck at 'queued' forever.
      const active = db.findActiveBuild(game.id, game.current_version);
      if (active) {
        return reply.code(202).send({
          buildId: active.id, status: active.status, deduped: true, statusUrl: `/api/builds/${active.id}`,
        });
      }

      limit(req, 'userBuild');
      ensureAffordable(req.user, 'build_apk');

      const buildId = randomUUID();
      db.createBuild({ id: buildId, gameId: game.id, version: game.current_version });

      // Charged up front because the build runs in a child process outside any
      // transaction; a failure refunds in full below.
      if (req.user) db.chargeCredits(req.user.id, 'build_apk', 'build', buildId);

      buildQueue.enqueue(
        `${game.id}:v${game.current_version}:android`,
        { buildId, gameId: game.id, userId: req.user?.id ?? null },
        async (job, setStage) => {
          const started = Date.now();
          try {
            db.updateBuild(buildId, { status: 'running', stage: 'preparing' });
            await runApkBuild(game.id, (stage) => {
              setStage(stage);
              db.updateBuild(buildId, { stage });
            });
            const apk = findApkOnDisk(game.id);
            if (!apk) throw new Error('build reported success but produced no APK');
            db.updateBuild(buildId, {
              status: 'ready', stage: 'ready',
              artifact_path: apk.path, artifact_name: apk.name, size_bytes: apk.bytes,
              package_id: game.package_id, duration_ms: Date.now() - started,
              finished_at: new Date().toISOString(),
            });
            return { name: apk.name, bytes: apk.bytes, downloadUrl: `/api/games/${game.id}/apk` };
          } catch (err) {
            db.updateBuild(buildId, {
              status: 'failed', stage: 'failed', error: String(err.message).slice(0, 2000),
              duration_ms: Date.now() - started, finished_at: new Date().toISOString(),
            });
            if (req.user) {
              db.refundCredits(req.user.id, db.CREDIT_COSTS.build_apk, 'refund.build_failed', 'build', buildId);
            }
            throw err;
          }
        }
      );

      return reply.code(202).send({ buildId, status: 'queued', statusUrl: `/api/builds/${buildId}` });
    } catch (err) {
      return send(reply, err);
    }
  });

  app.get('/api/builds/:id', async (req, reply) => {
    const row = db.getBuild(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Build not found.' });
    return buildView(row);
  });

  app.get('/api/builds/:id/stream', async (req, reply) => {
    const row = db.getBuild(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Build not found.' });
    const s = sse(reply);
    s.send('update', buildView(row));
    if (row.status === 'ready' || row.status === 'failed') return s.end();

    const tick = setInterval(() => {
      const fresh = db.getBuild(req.params.id);
      if (!fresh) return;
      s.send('update', buildView(fresh));
      if (fresh.status === 'ready' || fresh.status === 'failed') {
        clearInterval(tick);
        s.end();
      }
    }, 700);
    // The queue emits in-process, but polling the row keeps this correct even if the
    // build is later moved to a separate worker.
    req.raw.on('close', () => clearInterval(tick));
  });

  const buildView = (b) => ({
    id: b.id, gameId: b.game_id, version: b.version, status: b.status, stage: b.stage,
    error: b.error, durationMs: b.duration_ms, createdAt: b.created_at, finishedAt: b.finished_at,
    result: b.status === 'ready'
      ? { name: b.artifact_name, bytes: b.size_bytes, downloadUrl: `/api/games/${b.game_id}/apk` }
      : null,
  });

  app.get('/api/games/:id/apk', async (req, reply) => {
    try {
      const game = db.getGame(req.params.id);
      assertCanView(req, game);
      const apk = findApkOnDisk(game.id);
      if (!apk) return reply.code(404).send({ error: 'No APK has been built for this game yet.' });
      db.incrementDownload(game.id);
      reply
        .header('content-type', 'application/vnd.android.package-archive')
        .header('content-disposition', `attachment; filename="${apk.name}"`)
        .header('content-length', apk.bytes);
      return reply.send(createReadStream(apk.path));
    } catch (err) {
      return send(reply, err);
    }
  });

  // ─── arcade ──────────────────────────────────────────────────────────────

  app.get('/api/arcade', async (req) => {
    const games = db.listPublicGames({
      sort: String(req.query.sort ?? 'trending'),
      genre: req.query.genre ? String(req.query.genre) : null,
      limit: Math.min(120, Number(req.query.limit) || 60),
    });
    return { games: games.map((g) => publicGame(g)) };
  });

  // ─── billing (mock) ──────────────────────────────────────────────────────

  app.get('/api/billing', { preHandler: requireUser }, async (req) => ({
    balance: db.getBalance(req.user.id),
    ledger: db.listLedger(req.user.id, 60),
    packs: db.CREDIT_PACKS,
    costs: db.CREDIT_COSTS,
  }));

  app.post('/api/billing/checkout', { preHandler: requireUser }, async (req, reply) => {
    const pack = db.CREDIT_PACKS.find((p) => p.id === req.body?.packId);
    if (!pack) return reply.code(400).send({ error: 'Unknown credit pack.' });
    // Mock. A real Stripe webhook writes this same ledger row, so the swap is one handler.
    const balance = db.grantCredits(req.user.id, pack.credits, 'purchase.mock', 'pack', pack.id);
    return { ok: true, mock: true, pack, balance };
  });

  // ─── telemetry ───────────────────────────────────────────────────────────

  app.post('/api/telemetry', async (req, reply) => {
    const { gameId, event, level, score, durationS, device } = req.body ?? {};
    const game = gameId ? db.getGame(gameId) : null;
    if (!game) return reply.code(204).send();

    const lvl = Number.isInteger(level) ? Math.min(99, Math.max(1, level)) : null;
    switch (event) {
      case 'level_attempt':
        if (lvl) db.bumpLevelStats(game.id, lvl, { attempt: 1 });
        break;
      case 'level_clear':
        if (lvl) db.bumpLevelStats(game.id, lvl, { clear: 1 });
        break;
      case 'level_death':
        if (lvl) db.bumpLevelStats(game.id, lvl, { death: 1 });
        break;
      case 'session_end':
        db.recordPlay({
          gameId: game.id, userId: req.user?.id ?? null, maxLevel: lvl,
          bestScore: Number(score) || null, durationS: Number(durationS) || null,
          device: String(device ?? '').slice(0, 60),
        });
        break;
      case 'play_start':
        db.incrementPlay(game.id);
        break;
      default:
        break;
    }
    return reply.code(204).send();
  });

  app.get('/api/games/:id/stats', async (req, reply) => {
    const game = db.getGame(req.params.id);
    if (!game) return reply.code(404).send({ error: 'Game not found.' });
    return { levelStats: db.getLevelStats(game.id) };
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function findApkOnDisk(gameId) {
  const dir = gameDir(gameId);
  if (!existsSync(dir)) return null;
  // base.apk / aligned.apk are build intermediates that live in android-build/, but
  // filter them defensively in case a build is interrupted mid-write.
  const files = readdirSync(dir).filter((f) => f.endsWith('.apk') && f !== 'base.apk' && f !== 'aligned.apk');
  if (!files.length) return null;
  const path = join(dir, files[0]);
  return { path, name: files[0], bytes: statSync(path).size };
}

/**
 * Shell out to the same CLI a CI worker runs. One code path for local builds and for
 * whatever runs them in production later.
 */
function runApkBuild(gameId, setStage) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, 'tools', 'build-apk.mjs'), gameDir(gameId)], {
      cwd: ROOT, env: process.env, windowsHide: true,
    });
    let out = '';
    const onData = (b) => {
      const text = b.toString();
      out += text;
      if (/javac|d8 \(dex\)/.test(text)) setStage('compiling');
      else if (/aapt2|add dex|zipalign/.test(text)) setStage('packaging');
      else if (/apksigner sign/.test(text)) setStage('signing');
      else if (/verify/.test(text)) setStage('verifying');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res(out) : rej(new Error(`APK build exited ${code}\n${out.slice(-2000)}`))
    );
  });
}
