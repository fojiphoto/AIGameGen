/**
 * Auth, identity and rate limiting (§2 of the implementation plan).
 *
 * Design notes worth keeping:
 *   • Opaque session tokens in a table, not JWTs. Logout must actually revoke, and a
 *     stateless token cannot be revoked without building the very table a JWT avoids.
 *   • Cookies are httpOnly + sameSite=lax so page JS cannot read the session and a
 *     cross-site form post cannot silently use it.
 *   • Anonymous users get a signed-free `anon` cookie so a game generated before signup
 *     can be claimed afterwards. This is what makes try-before-signup possible, which is
 *     the single highest-leverage conversion decision in the product (§E2).
 *   • Authorization is ALWAYS server-side. The frontend hiding a button is decoration.
 */

import { randomUUID } from 'node:crypto';
import * as db from '@forge/db';

const SESSION_COOKIE = 'forge_session';
const ANON_COOKIE = 'forge_anon';
const isProd = process.env.NODE_ENV === 'production';

const cookieOpts = (maxAgeSeconds) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: isProd, // localhost is http, so this must not be forced on in dev
  maxAge: maxAgeSeconds,
});

export const RATE_LIMITS = {
  /**
   * Anonymous generation, per IP. A 15-minute window rather than an hour: in
   * deterministic mode a generation costs nothing, so the limit exists to stop
   * hammering, not to meter usage — and locking the owner out of their own demo for a
   * full hour is a much worse failure than a few extra free games.
   */
  anonGenerate: { max: 10, windowMs: 15 * 60 * 1000 },
  userGenerate: { max: 60, windowMs: 24 * 60 * 60 * 1000 },
  userBuild: { max: 30, windowMs: 24 * 60 * 60 * 1000 },
  signup: { max: 5, windowMs: 60 * 60 * 1000 },
  login: { max: 20, windowMs: 15 * 60 * 1000 },
  // Reports are free (no credit charge) and unauthenticated, which makes them a cheap
  // griefing vector otherwise: 3 requests auto-unpublishes any public game (§G2). The
  // cap is per IP, so it is set loose enough that a shared NAT with several genuine
  // reporters does not get throttled — de-duplication in createReport() is what
  // actually stops one visitor from repeating themselves.
  report: { max: 20, windowMs: 60 * 60 * 1000 },
};

/**
 * Populates req.user (or null) and req.anonKey on every request.
 * Registered as an onRequest hook so every route sees the same identity.
 */
export function identityHook(req, reply) {
  const token = req.cookies?.[SESSION_COOKIE];
  const user = token ? db.getSessionUser(token) : null;

  if (user && user.status === 'suspended') {
    db.deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    req.user = null;
  } else {
    req.user = user;
  }

  if (req.user) {
    db.touchUser(req.user.id);
    req.anonKey = null;
    return;
  }

  let anon = req.cookies?.[ANON_COOKIE];
  if (!anon || !/^[a-f0-9-]{36}$/i.test(anon)) {
    anon = randomUUID();
    reply.setCookie(ANON_COOKIE, anon, cookieOpts(90 * 24 * 3600));
  }
  req.anonKey = anon;
}

export function setSessionCookie(reply, token, expiresAt) {
  const maxAge = Math.max(60, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
  reply.setCookie(SESSION_COOKIE, token, cookieOpts(maxAge));
}

export function clearSessionCookie(reply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const ANON_COOKIE_NAME = ANON_COOKIE;

// ─── guards ─────────────────────────────────────────────────────────────────

export function requireUser(req, reply, done) {
  if (!req.user) {
    reply.code(401).send({ error: 'Sign in to do that.', code: 'AUTH_REQUIRED' });
    return;
  }
  done();
}

export function requireAdmin(req, reply, done) {
  // Checked here, on the server, against the DB row — never inferred from the client.
  if (!req.user || req.user.role !== 'admin') {
    reply.code(req.user ? 403 : 401).send({ error: 'Admins only.', code: 'ADMIN_REQUIRED' });
    return;
  }
  done();
}

/** Ownership check for a game. Admins may act on anything. */
export function assertCanEdit(req, game) {
  if (!game) {
    const e = new Error('Game not found.');
    e.statusCode = 404;
    throw e;
  }
  if (req.user?.role === 'admin') return;
  const ownedByUser = game.user_id && req.user && game.user_id === req.user.id;
  const ownedByAnon = !game.user_id && game.anon_key && game.anon_key === req.anonKey;
  if (!ownedByUser && !ownedByAnon) {
    const e = new Error("That's not your game.");
    e.statusCode = 403;
    e.code = 'NOT_OWNER';
    throw e;
  }
}

/** Read access: public games are readable by anyone, private only by owner/admin. */
export function assertCanView(req, game) {
  if (!game) {
    const e = new Error('Game not found.');
    e.statusCode = 404;
    throw e;
  }
  if (game.visibility === 'public' && game.status === 'ready') return;
  assertCanEdit(req, game);
}

// ─── rate limiting ──────────────────────────────────────────────────────────

/**
 * Always `req.ip`, never the raw header. Fastify already honours `x-forwarded-for` when
 * (and only when) trustProxy is enabled; reading the header directly would let any caller
 * spoof their address and bypass every per-IP limit.
 */
const clientIp = (req) => String(req.ip || 'unknown');

export function limit(req, kind) {
  const cfg = RATE_LIMITS[kind];
  if (!cfg) return;
  const bucket = req.user ? `${kind}:user:${req.user.id}` : `${kind}:ip:${clientIp(req)}`;
  db.checkRateLimit(bucket, cfg.max, cfg.windowMs);
}

export { clientIp };

// ─── validation helpers ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateCredentials({ email, password, displayName }) {
  const errors = [];
  const e = String(email ?? '').trim().toLowerCase();
  const pw = String(password ?? '');
  if (!EMAIL_RE.test(e) || e.length > 200) errors.push('Enter a valid email address.');
  if (pw.length < 8) errors.push('Password must be at least 8 characters.');
  if (pw.length > 200) errors.push('Password is too long.');
  const name = String(displayName ?? '').trim().slice(0, 40);
  return { email: e, password: pw, displayName: name, errors };
}
