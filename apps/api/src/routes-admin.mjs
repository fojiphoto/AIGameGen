/**
 * Admin routes. Every route here is behind `requireAdmin`, which reads the role from
 * the users table on the server. There is no client-side gate anywhere in this file —
 * the competitor audit that kicked off this project found exactly that mistake, and the
 * whole point of putting the check in a preHandler is that a route cannot forget it.
 */

import * as db from '@forge/db';
import { requireAdmin } from './auth.mjs';
import { publicGame } from './pipeline.mjs';

export default async function adminRoutes(app) {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/overview', async () => ({
    stats: db.platformStats(),
    ai: db.aiSpendSummary(),
    builds: db.listBuilds(10),
    openReports: db.listReports('open').length,
    levelStats: db.globalLevelStats(),
  }));

  app.get('/api/admin/users', async () => ({
    users: db.listUsers(200).map((u) => ({
      id: u.id, email: u.email, displayName: u.display_name, role: u.role,
      status: u.status, credits: u.credits ?? 0, games: u.game_count,
      createdAt: u.created_at, lastSeenAt: u.last_seen_at,
    })),
  }));

  app.post('/api/admin/users/:id/role', async (req, reply) => {
    const target = db.getUserById(req.params.id);
    if (!target) return reply.code(404).send({ error: 'User not found.' });
    // Guard against an admin removing the last admin and locking everyone out.
    if (target.role === 'admin' && req.body?.role !== 'admin') {
      const admins = db.listUsers(500).filter((u) => u.role === 'admin').length;
      if (admins <= 1) return reply.code(409).send({ error: 'Cannot demote the last admin.' });
    }
    db.setUserRole(target.id, req.body?.role);
    return { ok: true, user: { id: target.id, role: db.getUserById(target.id).role } };
  });

  app.post('/api/admin/users/:id/status', async (req, reply) => {
    const target = db.getUserById(req.params.id);
    if (!target) return reply.code(404).send({ error: 'User not found.' });
    if (target.id === req.user.id) return reply.code(409).send({ error: 'You cannot suspend yourself.' });
    db.setUserStatus(target.id, req.body?.status);
    return { ok: true, status: db.getUserById(target.id).status };
  });

  app.post('/api/admin/users/:id/credits', async (req, reply) => {
    const target = db.getUserById(req.params.id);
    if (!target) return reply.code(404).send({ error: 'User not found.' });
    const amount = Math.min(10000, Math.max(1, Number(req.body?.amount) || 0));
    const balance = db.grantCredits(target.id, amount, 'grant.admin', 'user', req.user.id);
    return { ok: true, balance };
  });

  app.get('/api/admin/reports', async (req) => ({
    reports: db.listReports(String(req.query.status ?? 'open')),
  }));

  app.post('/api/admin/reports/:id/resolve', async (req, reply) => {
    const action = req.body?.action === 'actioned' ? 'actioned' : 'dismissed';
    const gameId = req.body?.gameId;
    if (action === 'actioned' && gameId) {
      db.setGameStatus(gameId, 'unpublished');
      db.setVisibility(gameId, 'private');
    } else if (action === 'dismissed' && gameId) {
      // a dismissed report means the auto-unpublish threshold was wrong; restore it
      db.setGameStatus(gameId, 'ready');
    }
    db.resolveReport(Number(req.params.id), action, req.user.id);
    return reply.send({ ok: true, action });
  });

  app.get('/api/admin/builds', async () => ({ builds: db.listBuilds(80) }));

  /**
   * Clear rate-limit counters. Needed operationally (unblocking a user who hit a limit)
   * and by the end-to-end suite, which trips the limiter on purpose and would otherwise
   * fail every run after the first.
   */
  app.post('/api/admin/rate-limits/reset', async (req) => {
    const prefix = req.body?.prefix ? String(req.body.prefix).slice(0, 40) : null;
    const cleared = db.clearRateLimits(prefix);
    return { ok: true, cleared, prefix };
  });

  app.get('/api/admin/ai', async () => ({
    summary: db.aiSpendSummary(),
    failures: db.recentFailures(40),
  }));

  /**
   * Clear rate per level across every game. If level 12 sits at 4% while its neighbours
   * are at 40%, the curve in packages/generation/curve.mjs needs work — this is the
   * feedback loop the design doc calls a long-term moat (§F4).
   */
  app.get('/api/admin/level-stats', async () => {
    const rows = db.globalLevelStats();
    const outliers = rows.filter((r) => r.attempts >= 5 && r.clear_rate !== null && r.clear_rate < 0.15);
    return { levels: rows, outliers };
  });

  app.get('/api/admin/games', async () => ({
    games: db.listPublicGames({ sort: 'new', limit: 120 }).map((g) => publicGame(g)),
  }));
}
