/**
 * Data access layer. Every SQL statement in the product lives here.
 *
 * Rules enforced by this module rather than by convention:
 *   • all SQL is parameterised — no string concatenation, ever
 *   • credit_ledger is append-only; balances are derived, never edited
 *   • credit charges happen inside a transaction with the work they pay for
 *
 * node:sqlite accepts only null | number | string | bigint | Uint8Array as bound
 * values. `undefined` and booleans throw, which is an easy way to ship a crash, so
 * every write goes through `p()` below.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MIGRATIONS, CREDIT_COSTS, SIGNUP_GRANT, CREDIT_PACKS } from './schema.mjs';

export { CREDIT_COSTS, SIGNUP_GRANT, CREDIT_PACKS } from './schema.mjs';

let db = null;

/** Coerce a JS value into something node:sqlite will bind. */
const p = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
};
const now = () => new Date().toISOString();

export function open(file = process.env.DB_PATH || 'data/forge.db') {
  if (db) return db;
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate();
  return db;
}

export function close() {
  if (db) {
    db.close();
    db = null;
  }
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  const applied = new Set(db.prepare('SELECT version FROM _migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
}

/** Run fn inside a transaction. Nested calls reuse the outer transaction. */
let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

// ─── users ──────────────────────────────────────────────────────────────────

const KEYLEN = 64;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, KEYLEN).toString('hex') };
}

export function verifyPassword(password, salt, expectedHex) {
  const actual = scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(expectedHex, 'hex');
  // length check first: timingSafeEqual throws on mismatched lengths
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function createUser({ email, password, displayName, role = 'user' }) {
  const normalised = String(email).trim().toLowerCase();
  const { salt, hash } = hashPassword(password);
  const id = randomUUID();
  return tx(() => {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, display_name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, normalised, hash, salt, p(displayName || normalised.split('@')[0]), role, now());
    grantCredits(id, SIGNUP_GRANT, 'signup.grant', null, null);
    return getUserById(id);
  });
}

export const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(p(id)) ?? null;
export const getUserByEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()) ?? null;

export const touchUser = (id) => db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), p(id));

export const listUsers = (limit = 200) =>
  db
    .prepare(
      `SELECT u.*,
              (SELECT balance_after FROM credit_ledger WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS credits,
              (SELECT COUNT(*) FROM games WHERE user_id = u.id) AS game_count
       FROM users u ORDER BY u.created_at DESC LIMIT ?`
    )
    .all(p(limit));

export const setUserRole = (id, role) =>
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'user', p(id));
export const setUserStatus = (id, status) =>
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status === 'suspended' ? 'suspended' : 'active', p(id));

// ─── sessions ───────────────────────────────────────────────────────────────

const SESSION_DAYS = 30;

export function createSession(userId, ip) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)').run(
    token,
    p(userId),
    now(),
    expires,
    p(ip)
  );
  return { token, expiresAt: expires };
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(p(token), now());
  return row ?? null;
}

export const deleteSession = (token) => db.prepare('DELETE FROM sessions WHERE token = ?').run(p(token));
export const purgeExpiredSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());

// ─── credits ────────────────────────────────────────────────────────────────

export function getBalance(userId) {
  const row = db
    .prepare('SELECT balance_after FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(p(userId));
  return row ? row.balance_after : 0;
}

function writeLedger(userId, delta, reason, refType, refId) {
  const balance = getBalance(userId) + delta;
  db.prepare(
    `INSERT INTO credit_ledger (user_id, delta, reason, ref_type, ref_id, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(p(userId), delta, reason, p(refType), p(refId), balance, now());
  return balance;
}

export const grantCredits = (userId, amount, reason, refType, refId) =>
  tx(() => writeLedger(userId, Math.abs(amount), reason, refType, refId));

/**
 * Charge credits, throwing INSUFFICIENT_CREDITS rather than going negative.
 * Callers must run this inside the same transaction as the work being paid for so a
 * failure cannot leave a debit with nothing to show for it.
 */
export function chargeCredits(userId, action, refType, refId) {
  const cost = CREDIT_COSTS[action];
  if (cost === undefined) throw new Error(`unknown credit action: ${action}`);
  if (cost === 0) return { charged: 0, balance: getBalance(userId) };
  const balance = getBalance(userId);
  if (balance < cost) {
    const err = new Error(`This costs ${cost} credits and you have ${balance}.`);
    err.code = 'INSUFFICIENT_CREDITS';
    err.statusCode = 402;
    err.required = cost;
    err.balance = balance;
    throw err;
  }
  return { charged: cost, balance: writeLedger(userId, -cost, `spend.${action}`, refType, refId) };
}

export const refundCredits = (userId, amount, reason, refType, refId) =>
  tx(() => writeLedger(userId, Math.abs(amount), reason || 'refund', refType, refId));

export const listLedger = (userId, limit = 100) =>
  db.prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(p(userId), p(limit));

/** Integrity check: the running balance must equal the sum of all deltas. */
export function reconcileCredits(userId) {
  const sum = db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger WHERE user_id = ?').get(p(userId)).s;
  const balance = getBalance(userId);
  return { ok: sum === balance, sum, balance };
}

// ─── games ──────────────────────────────────────────────────────────────────

export function createGame({
  id, userId, anonKey, title, tagline, genre, prompt, source, seed, packageId, palette, parentGameId,
}) {
  const t = now();
  db.prepare(
    `INSERT INTO games (id, user_id, anon_key, title, tagline, genre, prompt, source, seed,
                        package_id, palette_json, current_version, parent_game_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    p(id), p(userId), p(anonKey), p(title), p(tagline), p(genre), p(prompt), p(source),
    p(seed), p(packageId), JSON.stringify(palette), p(parentGameId), t, t
  );
  if (parentGameId) db.prepare('UPDATE games SET remix_count = remix_count + 1 WHERE id = ?').run(p(parentGameId));
  return getGame(id);
}

export function getGame(id) {
  const row = db.prepare('SELECT * FROM games WHERE id = ?').get(p(id));
  return row ? hydrateGame(row) : null;
}

function hydrateGame(row) {
  return { ...row, palette: JSON.parse(row.palette_json), isPublic: row.visibility === 'public' };
}

export const listGamesByUser = (userId, limit = 100) =>
  db
    .prepare('SELECT * FROM games WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(p(userId), p(limit))
    .map(hydrateGame);

export const listGamesByAnonKey = (anonKey) =>
  db.prepare('SELECT * FROM games WHERE anon_key = ? AND user_id IS NULL').all(p(anonKey)).map(hydrateGame);

/** Sort is whitelisted, never interpolated from user input. */
export function listPublicGames({ sort = 'trending', genre = null, limit = 60 } = {}) {
  const order = {
    trending: 'g.play_count DESC, g.updated_at DESC',
    new: 'g.created_at DESC',
    played: 'g.play_count DESC',
    remixed: 'g.remix_count DESC',
  }[sort] ?? 'g.play_count DESC';

  const clauses = [`g.visibility = 'public'`, `g.status = 'ready'`];
  const params = [];
  if (genre) {
    clauses.push('g.genre = ?');
    params.push(genre);
  }
  params.push(p(limit));

  return db
    .prepare(
      `SELECT g.*, u.display_name AS author
       FROM games g LEFT JOIN users u ON u.id = g.user_id
       WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ?`
    )
    .all(...params)
    .map(hydrateGame);
}

/** Attach games created before signup to the new account. */
export const claimAnonGames = (anonKey, userId) =>
  db.prepare('UPDATE games SET anon_key = NULL, user_id = ?, updated_at = ? WHERE anon_key = ? AND user_id IS NULL')
    .run(p(userId), now(), p(anonKey)).changes;

export function bumpGameVersion(gameId, version, title, palette) {
  db.prepare('UPDATE games SET current_version = ?, title = ?, palette_json = ?, updated_at = ? WHERE id = ?').run(
    p(version), p(title), JSON.stringify(palette), now(), p(gameId)
  );
}

export const setVisibility = (gameId, visibility) =>
  db.prepare('UPDATE games SET visibility = ?, updated_at = ? WHERE id = ?')
    .run(visibility === 'public' ? 'public' : 'private', now(), p(gameId));

export const setGameStatus = (gameId, status) =>
  db.prepare('UPDATE games SET status = ?, updated_at = ? WHERE id = ?').run(p(status), now(), p(gameId));

export const incrementPlay = (gameId) =>
  db.prepare('UPDATE games SET play_count = play_count + 1 WHERE id = ?').run(p(gameId));
export const incrementDownload = (gameId) =>
  db.prepare('UPDATE games SET download_count = download_count + 1 WHERE id = ?').run(p(gameId));

export const deleteGame = (gameId) => db.prepare('DELETE FROM games WHERE id = ?').run(p(gameId));

// ─── versions ───────────────────────────────────────────────────────────────

export function addVersion({ gameId, version, config, report, patch, summary }) {
  db.prepare(
    `INSERT INTO game_versions (game_id, version, config_json, report_json, patch_json, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p(gameId), p(version), JSON.stringify(config),
    report ? JSON.stringify(report) : null,
    patch ? JSON.stringify(patch) : null,
    p(summary), now()
  );
}

export function getVersion(gameId, version) {
  const row = db.prepare('SELECT * FROM game_versions WHERE game_id = ? AND version = ?').get(p(gameId), p(version));
  if (!row) return null;
  return {
    ...row,
    config: JSON.parse(row.config_json),
    report: row.report_json ? JSON.parse(row.report_json) : null,
    patch: row.patch_json ? JSON.parse(row.patch_json) : null,
  };
}

export function getCurrentVersion(gameId) {
  const g = getGame(gameId);
  return g ? getVersion(gameId, g.current_version) : null;
}

export const listVersions = (gameId) =>
  db
    .prepare('SELECT version, summary, created_at FROM game_versions WHERE game_id = ? ORDER BY version DESC')
    .all(p(gameId));

// ─── builds ─────────────────────────────────────────────────────────────────

export function createBuild({ id, gameId, version, platform = 'android' }) {
  db.prepare(
    `INSERT INTO builds (id, game_id, version, platform, status, stage, created_at)
     VALUES (?, ?, ?, ?, 'queued', 'queued', ?)`
  ).run(p(id), p(gameId), p(version), p(platform), now());
  return getBuild(id);
}

export function updateBuild(id, fields) {
  const allowed = ['status', 'stage', 'artifact_path', 'artifact_name', 'size_bytes', 'package_id', 'error', 'duration_ms', 'finished_at'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  // column names come from the whitelist above, values are always bound
  db.prepare(`UPDATE builds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => p(fields[k])), p(id));
}

export const getBuild = (id) => db.prepare('SELECT * FROM builds WHERE id = ?').get(p(id)) ?? null;

export const findReadyBuild = (gameId, version) =>
  db.prepare(`SELECT * FROM builds WHERE game_id = ? AND version = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1`)
    .get(p(gameId), p(version)) ?? null;

/** A build already queued or running for this game+version — used to avoid charging twice
 * for what is really one build (e.g. a double-click before the first request finishes). */
export const findActiveBuild = (gameId, version) =>
  db.prepare(
    `SELECT * FROM builds WHERE game_id = ? AND version = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`
  ).get(p(gameId), p(version)) ?? null;

export const listBuilds = (limit = 50) =>
  db
    .prepare(
      `SELECT b.*, g.title FROM builds b LEFT JOIN games g ON g.id = b.game_id
       ORDER BY b.created_at DESC LIMIT ?`
    )
    .all(p(limit));

export const listBuildsForGame = (gameId) =>
  db.prepare('SELECT * FROM builds WHERE game_id = ? ORDER BY created_at DESC').all(p(gameId));

// ─── telemetry ──────────────────────────────────────────────────────────────

export function recordPlay({ gameId, userId, maxLevel, bestScore, durationS, device }) {
  db.prepare(
    `INSERT INTO plays (game_id, user_id, max_level, best_score, duration_s, device, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(p(gameId), p(userId), p(maxLevel), p(bestScore), p(durationS), p(device), now());
}

export function bumpLevelStats(gameId, level, { attempt = 0, clear = 0, death = 0 }) {
  db.prepare(
    `INSERT INTO level_stats (game_id, level, attempts, clears, deaths) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(game_id, level) DO UPDATE SET
       attempts = attempts + excluded.attempts,
       clears   = clears   + excluded.clears,
       deaths   = deaths   + excluded.deaths`
  ).run(p(gameId), p(level), attempt, clear, death);
}

export const getLevelStats = (gameId) =>
  db.prepare('SELECT * FROM level_stats WHERE game_id = ? ORDER BY level').all(p(gameId));

/**
 * Clear rate per level across every game. This is the signal that tells us whether the
 * difficulty curve in packages/generation/curve.mjs is actually tuned correctly.
 */
export const globalLevelStats = () =>
  db
    .prepare(
      `SELECT level, SUM(attempts) AS attempts, SUM(clears) AS clears, SUM(deaths) AS deaths,
              CASE WHEN SUM(attempts) > 0 THEN ROUND(1.0 * SUM(clears) / SUM(attempts), 3) ELSE NULL END AS clear_rate
       FROM level_stats GROUP BY level ORDER BY level`
    )
    .all();

// ─── reports / moderation ───────────────────────────────────────────────────

/**
 * `reporterKey` identifies the reporter even when anonymous (user id, or anon cookie
 * key) so one visitor cannot file the same game repeatedly to force the auto-unpublish
 * threshold. Callers that do not pass one (e.g. admin tooling, existing tests) get the
 * old un-deduplicated behaviour — there is nothing to de-duplicate against.
 */
export function createReport({ gameId, reporterId, reporterKey, reason, notes }) {
  const key = reporterKey ?? null;
  if (key) {
    const dup = db.prepare('SELECT * FROM reports WHERE game_id = ? AND reporter_key = ?').get(p(gameId), p(key));
    if (dup) return dup;
  }
  const info = db.prepare(
    'INSERT INTO reports (game_id, reporter_id, reporter_key, reason, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(p(gameId), p(reporterId), p(key), p(reason), p(notes), now());
  return { id: Number(info.lastInsertRowid), game_id: gameId, reporter_id: reporterId, reporter_key: key, status: 'open' };
}

export const listReports = (status = 'open') =>
  db
    .prepare(
      `SELECT r.*, g.title, g.visibility FROM reports r LEFT JOIN games g ON g.id = r.game_id
       WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`
    )
    .all(p(status));

export const resolveReport = (id, status, adminId) =>
  db.prepare('UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
    .run(status === 'actioned' ? 'actioned' : 'dismissed', now(), p(adminId), p(id));

export const countOpenReports = (gameId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE game_id = ? AND status = 'open'`).get(p(gameId)).n;

// ─── AI audit ───────────────────────────────────────────────────────────────

export function logGeneration({ userId, gameId, stage, model, prompt, inTokens, outTokens, costUsd, status, latencyMs }) {
  db.prepare(
    `INSERT INTO generations (user_id, game_id, stage, model, prompt, in_tokens, out_tokens, cost_usd, status, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p(userId), p(gameId), p(stage), p(model), p(prompt ? String(prompt).slice(0, 500) : null),
    inTokens ?? 0, outTokens ?? 0, costUsd ?? 0, p(status), p(latencyMs), now()
  );
}

export const aiSpendSummary = () =>
  db
    .prepare(
      // Every aggregate is COALESCEd: over zero rows SUM() returns NULL, which would
      // render as "null failures" in the admin dashboard rather than "0".
      `SELECT COUNT(*) AS calls, COALESCE(SUM(in_tokens),0) AS in_tokens,
              COALESCE(SUM(out_tokens),0) AS out_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd,
              COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS failures
       FROM generations`
    )
    .get();

export const recentFailures = (limit = 50) =>
  db.prepare(`SELECT * FROM generations WHERE status != 'ok' ORDER BY created_at DESC LIMIT ?`).all(p(limit));

// ─── rate limiting ──────────────────────────────────────────────────────────

/**
 * Fixed-window counter. Adequate here: the limits exist to stop cost blowouts and
 * casual abuse, not to defeat a determined attacker.
 */
export function checkRateLimit(bucket, max, windowMs) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const n = db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND created_at > ?')
    .get(p(bucket), since).n;
  if (n >= max) {
    const err = new Error(`Rate limit reached. Try again later.`);
    err.code = 'RATE_LIMITED';
    err.statusCode = 429;
    err.limit = max;
    throw err;
  }
  db.prepare('INSERT INTO rate_events (bucket, created_at) VALUES (?, ?)').run(p(bucket), now());
  return { count: n + 1, max };
}

export const purgeRateEvents = () =>
  db.prepare('DELETE FROM rate_events WHERE created_at < ?').run(new Date(Date.now() - 864e5).toISOString());

/**
 * Wipe rate-limit counters. Real operational need — it is how you unblock a user who got
 * stuck behind a limit — and it is also what makes the end-to-end suite repeatable, since
 * that suite deliberately trips the limiter and would otherwise poison the next run.
 * Admin-only; see routes-admin.mjs.
 */
export const clearRateLimits = (prefix = null) =>
  prefix
    ? db.prepare('DELETE FROM rate_events WHERE bucket LIKE ?').run(`${prefix}%`).changes
    : db.prepare('DELETE FROM rate_events').run().changes;

// ─── stats for admin/landing ────────────────────────────────────────────────

export const platformStats = () =>
  db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM games) AS games,
         (SELECT COUNT(*) FROM games WHERE visibility = 'public') AS public_games,
         (SELECT COUNT(*) FROM builds WHERE status = 'ready') AS builds_ready,
         (SELECT COUNT(*) FROM builds WHERE status = 'failed') AS builds_failed,
         (SELECT COALESCE(SUM(play_count),0) FROM games) AS plays,
         (SELECT COALESCE(SUM(download_count),0) FROM games) AS downloads,
         (SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports`
    )
    .get();
