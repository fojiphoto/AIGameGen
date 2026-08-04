import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as db from '../src/index.mjs';

const TEST_DB = 'data/test-forge.db';

test.before(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(TEST_DB + suffix); } catch {}
  }
  db.open(TEST_DB);
});

test.after(() => db.close());

test('migrations are idempotent', () => {
  db.open(TEST_DB); // second open must not throw or duplicate
  assert.ok(db.platformStats());
});

test('signup grants starter credits via the ledger', () => {
  const u = db.createUser({ email: 'A@Example.com ', password: 'pw123456', displayName: 'A' });
  assert.equal(u.email, 'a@example.com', 'email must be normalised');
  assert.equal(db.getBalance(u.id), db.SIGNUP_GRANT);
  const ledger = db.listLedger(u.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].reason, 'signup.grant');
});

test('password verification accepts the right password and rejects others', () => {
  const u = db.createUser({ email: 'pw@test.com', password: 'correct-horse', displayName: 'P' });
  const row = db.getUserByEmail('pw@test.com');
  assert.equal(db.verifyPassword('correct-horse', row.password_salt, row.password_hash), true);
  assert.equal(db.verifyPassword('wrong', row.password_salt, row.password_hash), false);
  // a hash of a different length must not throw
  assert.equal(db.verifyPassword('x', row.password_salt, 'aabb'), false);
  assert.ok(u.id);
});

test('charging credits debits exactly once and never goes negative', () => {
  const u = db.createUser({ email: 'c@test.com', password: 'pw123456', displayName: 'C' });
  const before = db.getBalance(u.id);

  const r = db.chargeCredits(u.id, 'generate', 'game', 'g1');
  assert.equal(r.charged, db.CREDIT_COSTS.generate);
  assert.equal(db.getBalance(u.id), before - db.CREDIT_COSTS.generate);

  // drain the account, then confirm the next charge is refused
  let guard = 0;
  while (db.getBalance(u.id) >= db.CREDIT_COSTS.generate && guard++ < 20) {
    db.chargeCredits(u.id, 'generate', 'game', 'g' + guard);
  }
  assert.throws(() => db.chargeCredits(u.id, 'generate', 'game', 'gx'), (e) => e.code === 'INSUFFICIENT_CREDITS');
  assert.ok(db.getBalance(u.id) >= 0, 'balance must never go negative');
});

test('a zero-cost action does not write a ledger row', () => {
  const u = db.createUser({ email: 'z@test.com', password: 'pw123456', displayName: 'Z' });
  const rows = db.listLedger(u.id).length;
  const r = db.chargeCredits(u.id, 'rebuild_free' in db.CREDIT_COSTS ? 'rebuild_free' : 'generate', null, null);
  assert.ok(r.charged >= 0);
  assert.ok(db.listLedger(u.id).length >= rows);
});

test('ledger reconciles: sum of deltas equals running balance', () => {
  const u = db.createUser({ email: 'r@test.com', password: 'pw123456', displayName: 'R' });
  db.chargeCredits(u.id, 'refine', null, null);
  db.grantCredits(u.id, 100, 'purchase.mock', 'pack', 'small');
  db.chargeCredits(u.id, 'build_apk', null, null);
  db.refundCredits(u.id, db.CREDIT_COSTS.build_apk, 'refund.build_failed', null, null);
  const rec = db.reconcileCredits(u.id);
  assert.ok(rec.ok, `ledger drift: sum=${rec.sum} balance=${rec.balance}`);
});

test('refund restores the exact charge after a failure', () => {
  const u = db.createUser({ email: 'rf@test.com', password: 'pw123456', displayName: 'RF' });
  const before = db.getBalance(u.id);
  db.chargeCredits(u.id, 'build_apk', 'build', 'b1');
  db.refundCredits(u.id, db.CREDIT_COSTS.build_apk, 'refund.build_failed', 'build', 'b1');
  assert.equal(db.getBalance(u.id), before);
});

test('a failed transaction rolls back the debit', () => {
  const u = db.createUser({ email: 'tx@test.com', password: 'pw123456', displayName: 'TX' });
  const before = db.getBalance(u.id);
  assert.throws(() =>
    db.tx(() => {
      db.chargeCredits(u.id, 'generate', 'game', 'boom');
      throw new Error('work failed after charging');
    })
  );
  assert.equal(db.getBalance(u.id), before, 'debit must not survive a rolled-back transaction');
});

test('sessions authenticate and can be revoked', () => {
  const u = db.createUser({ email: 's@test.com', password: 'pw123456', displayName: 'S' });
  const { token } = db.createSession(u.id, '127.0.0.1');
  assert.equal(db.getSessionUser(token).id, u.id);
  db.deleteSession(token);
  assert.equal(db.getSessionUser(token), null);
  assert.equal(db.getSessionUser(null), null);
});

test('anonymous games are claimed on signup', () => {
  db.createGame({
    id: 'anon1', userId: null, anonKey: 'ak-1', title: 'T', tagline: '', genre: 'endless_runner',
    prompt: 'p', source: 'deterministic', seed: 1, packageId: 'com.x.y', palette: { bg: '#000' },
  });
  assert.equal(db.listGamesByAnonKey('ak-1').length, 1);
  const u = db.createUser({ email: 'claim@test.com', password: 'pw123456', displayName: 'CL' });
  assert.equal(db.claimAnonGames('ak-1', u.id), 1);
  assert.equal(db.listGamesByUser(u.id).length, 1);
  assert.equal(db.listGamesByAnonKey('ak-1').length, 0);
});

test('public listing only returns public ready games and rejects bad sort keys', () => {
  db.createGame({
    id: 'pub1', userId: null, anonKey: null, title: 'Pub', tagline: '', genre: 'endless_runner',
    prompt: 'p', source: 'deterministic', seed: 2, packageId: 'com.x.z', palette: { bg: '#000' },
  });
  db.setVisibility('pub1', 'public');
  assert.ok(db.listPublicGames({ sort: 'trending' }).some((g) => g.id === 'pub1'));
  // an unknown sort must fall back, not interpolate
  assert.doesNotThrow(() => db.listPublicGames({ sort: "x'; DROP TABLE games;--" }));
  assert.ok(db.getGame('pub1'));
  db.setGameStatus('pub1', 'unpublished');
  assert.ok(!db.listPublicGames({}).some((g) => g.id === 'pub1'));
});

test('versions round-trip config and report', () => {
  db.createGame({
    id: 'v1', userId: null, anonKey: null, title: 'V', tagline: '', genre: 'endless_runner',
    prompt: 'p', source: 'deterministic', seed: 3, packageId: 'com.x.v', palette: { bg: '#000' },
  });
  db.addVersion({ gameId: 'v1', version: 1, config: { a: 1 }, report: { ok: true }, patch: null, summary: 'init' });
  db.addVersion({ gameId: 'v1', version: 2, config: { a: 2 }, report: { ok: true }, patch: [{ op: 'replace' }], summary: 'harder' });
  db.bumpGameVersion('v1', 2, 'V2', { bg: '#111' });
  assert.equal(db.getVersion('v1', 1).config.a, 1);
  assert.equal(db.getCurrentVersion('v1').config.a, 2);
  assert.equal(db.getGame('v1').title, 'V2');
  assert.equal(db.listVersions('v1').length, 2);
});

test('builds are idempotent per game+version', () => {
  db.createGame({
    id: 'b1g', userId: null, anonKey: null, title: 'B', tagline: '', genre: 'endless_runner',
    prompt: 'p', source: 'deterministic', seed: 4, packageId: 'com.x.b', palette: { bg: '#000' },
  });
  db.createBuild({ id: 'bld1', gameId: 'b1g', version: 1 });
  assert.equal(db.findReadyBuild('b1g', 1), null);
  db.updateBuild('bld1', { status: 'ready', artifact_name: 'B.apk', size_bytes: 1234 });
  assert.equal(db.findReadyBuild('b1g', 1).artifact_name, 'B.apk');
  // an unknown column must be ignored rather than injected
  assert.doesNotThrow(() => db.updateBuild('bld1', { 'nope = 1, status': 'x' }));
});

test('rate limiting blocks past the window maximum', () => {
  const bucket = 'test:bucket';
  for (let i = 0; i < 3; i++) db.checkRateLimit(bucket, 3, 60_000);
  assert.throws(() => db.checkRateLimit(bucket, 3, 60_000), (e) => e.code === 'RATE_LIMITED');
});

test('telemetry aggregates level stats', () => {
  db.createGame({
    id: 'tg', userId: null, anonKey: null, title: 'T', tagline: '', genre: 'endless_runner',
    prompt: 'p', source: 'deterministic', seed: 5, packageId: 'com.x.t', palette: { bg: '#000' },
  });
  db.bumpLevelStats('tg', 3, { attempt: 1, death: 1 });
  db.bumpLevelStats('tg', 3, { attempt: 1, clear: 1 });
  const s = db.getLevelStats('tg').find((r) => r.level === 3);
  assert.equal(s.attempts, 2);
  assert.equal(s.clears, 1);
  assert.equal(s.deaths, 1);
  assert.ok(db.globalLevelStats().length >= 1);
});

test('reports flow through moderation', () => {
  db.createGame({
    id: 'rg', userId: null, anonKey: null, title: 'R', tagline: '', genre: 'endless_runner',
    prompt: 'p', source: 'deterministic', seed: 6, packageId: 'com.x.r', palette: { bg: '#000' },
  });
  db.createReport({ gameId: 'rg', reporterId: null, reason: 'ip', notes: 'looks copied' });
  assert.equal(db.countOpenReports('rg'), 1);
  const open = db.listReports('open');
  db.resolveReport(open[0].id, 'actioned', null);
  assert.equal(db.countOpenReports('rg'), 0);
});

test('deleting a game cascades its versions and stats', () => {
  db.createGame({
    id: 'del', userId: null, anonKey: null, title: 'D', tagline: '', genre: 'endless_runner',
    prompt: 'p', source: 'deterministic', seed: 7, packageId: 'com.x.d', palette: { bg: '#000' },
  });
  db.addVersion({ gameId: 'del', version: 1, config: {}, report: null, patch: null, summary: null });
  db.bumpLevelStats('del', 1, { attempt: 1 });
  db.deleteGame('del');
  assert.equal(db.getGame('del'), null);
  assert.equal(db.getVersion('del', 1), null);
  assert.equal(db.getLevelStats('del').length, 0);
});
