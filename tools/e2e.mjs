#!/usr/bin/env node
/**
 * End-to-end integration test against a running server.
 *
 *   node apps/api/src/server.mjs      # in one terminal
 *   node tools/e2e.mjs                # in another
 *
 * Walks the whole product the way a real visitor would, including the paths that are
 * easy to break and hard to notice: anonymous-then-signup claiming, credit refunds on
 * failure, authorization boundaries, and the offline guarantee inside the built APK.
 *
 * Exits non-zero on the first hard failure so it is usable as a release gate.
 */

const BASE = process.env.BASE || 'http://localhost:8787';

let pass = 0;
let fail = 0;
const failures = [];

const c = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

function ok(name, extra = '') {
  pass++;
  console.log(`  ${c.g}✓${c.x} ${name}${extra ? ` ${c.d}${extra}${c.x}` : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name} — ${detail}`);
  console.log(`  ${c.r}✗ ${name}${c.x}\n      ${c.r}${detail}${c.x}`);
}
function section(title) {
  console.log(`\n${c.b}${title}${c.x}`);
}

/** A cookie jar, because half of what we are testing is session behaviour. */
class Client {
  constructor(label) {
    this.label = label;
    this.jar = new Map();
  }
  get cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async req(path, { method = 'GET', body, expect } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.jar.size ? { cookie: this.cookieHeader } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    this.absorb(res);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
    if (expect && res.status !== expect) {
      const detail = typeof data === 'string' ? data.slice(0, 160) : JSON.stringify(data).slice(0, 260);
      throw new Error(`${method} ${path} → ${res.status} (expected ${expect}): ${detail}`);
    }
    return { status: res.status, data, headers: res.headers };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 9);

// ────────────────────────────────────────────────────────────────────────────

console.log(`\n${c.b}FORGE — end-to-end${c.x}  ${c.d}${BASE}${c.x}`);
const t0 = Date.now();

/**
 * Clear rate-limit counters before starting.
 *
 * This suite trips the limiter on purpose (that is one of the things being tested), and the
 * counters live in the database — so without this, every run after the first fails on
 * unrelated 429s and the gate becomes useless. Uses the admin ops endpoint rather than
 * touching the DB, so it works against a remote server too.
 */
{
  const admin = new Client('bootstrap-admin');
  try {
    await admin.req('/api/auth/login', {
      method: 'POST',
      body: {
        email: process.env.ADMIN_EMAIL || 'admin@factorialstudio.com',
        password: process.env.ADMIN_PASSWORD || 'forge-admin-2026',
      },
      expect: 200,
    });
    const r = await admin.req('/api/admin/rate-limits/reset', { method: 'POST', expect: 200 });
    console.log(`  ${c.d}reset ${r.data.cleared} rate-limit counters so this run starts clean${c.x}`);
    await admin.req('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    console.log(`  ${c.y}! could not reset rate limits (${e.message}) — later sections may 429${c.x}`);
  }
}

// ─── public surface ─────────────────────────────────────────────────────────
section('Public pages');
try {
  const health = await new Client('anon').req('/health', { expect: 200 });
  ok('/health', `mode=${health.data.mode}`);

  for (const [path, needle] of [
    ['/', 'ONE COMMAND'],
    ['/arcade', 'ARCADE'],
    ['/studio', 'PICK A TEMPLATE'],
    ['/login', 'SIGN IN'],
    ['/signup', 'nameField'],
    ['/terms', 'legal'],
    ['/privacy', 'legal'],
    ['/billing', 'CREDITS'],
    ['/dashboard', 'MY GAMES'],
    ['/admin', 'Admin'],
  ]) {
    const r = await new Client('anon').req(path, { expect: 200 });
    if (String(r.data).includes(needle)) ok(`GET ${path}`);
    else bad(`GET ${path}`, `expected page to contain "${needle}"`);
  }

  const nf = await new Client('anon').req('/definitely-not-a-page');
  if (nf.status === 404) ok('unknown page returns 404', 'not a soft-200');
  else bad('unknown page returns 404', `got ${nf.status}`);

  const apiNf = await new Client('anon').req('/api/nope');
  if (apiNf.status === 404 && typeof apiNf.data === 'object') ok('unknown API route returns JSON 404');
  else bad('unknown API route returns JSON 404', `got ${apiNf.status}`);

  const assets = await new Client('anon').req('/assets/app.css', { expect: 200 });
  if (String(assets.data).includes('--ink')) ok('design tokens served');
  else bad('design tokens served', 'app.css missing tokens');
} catch (e) {
  bad('public pages', e.message);
}

// ─── seeded arcade ──────────────────────────────────────────────────────────
section('Arcade');
let demoGame = null;
try {
  const { data } = await new Client('anon').req('/api/arcade', { expect: 200 });
  if (data.games.length >= 1) {
    demoGame = data.games[0];
    ok('arcade has public games', `${data.games.length} listed`);
  } else bad('arcade has public games', 'none seeded');

  if (demoGame) {
    const play = await new Client('anon').req(demoGame.playUrl, { expect: 200 });
    if (String(play.data).includes('window.__GAME__')) ok('bundle serves with inlined config');
    else bad('bundle serves with inlined config', 'payload missing');

    const sortRes = await new Client('anon').req(`/api/arcade?sort=${encodeURIComponent("x'; DROP TABLE games;--")}`);
    if (sortRes.status === 200) ok('malicious sort key is ignored', 'no SQL injection');
    else bad('malicious sort key is ignored', `status ${sortRes.status}`);
  }
} catch (e) {
  bad('arcade', e.message);
}

// ─── anonymous generate, then claim on signup ───────────────────────────────
section('Anonymous → signup claiming');
const anon = new Client('anon');
let anonGameId = null;
try {
  const gen = await anon.req('/api/generate', {
    method: 'POST',
    body: { prompt: 'arctic glacier slide easy ' + rand() },
    expect: 200,
  });
  anonGameId = gen.data.game.id;
  ok('anonymous user can generate', `${gen.data.game.title}, ${gen.data.game.report.totalObstacles} obstacles`);

  if (gen.data.game.report.levelsBuilt === 20) ok('20/20 levels built and validated');
  else bad('20/20 levels built', `got ${gen.data.game.report.levelsBuilt}`);

  const mine = await anon.req('/api/games', { expect: 200 });
  if (mine.data.games.some((g) => g.id === anonGameId)) ok('anonymous game visible to its creator');
  else bad('anonymous game visible to its creator', 'not listed');

  const email = `e2e-${rand()}@test.local`;
  const signup = await anon.req('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'test-password-123', displayName: 'E2E' },
    expect: 200,
  });
  if (signup.data.claimedGames >= 1) ok('signup claims the pre-signup game', `${signup.data.claimedGames} claimed`);
  else bad('signup claims the pre-signup game', `claimedGames=${signup.data.claimedGames}`);

  if (signup.data.user.credits === 30) ok('signup grants 30 credits');
  else bad('signup grants 30 credits', `got ${signup.data.user.credits}`);
} catch (e) {
  bad('anonymous → signup', e.message);
}

// ─── authenticated lifecycle ────────────────────────────────────────────────
section('Authenticated lifecycle');
const user = new Client('user');
let gameId = null;
let userEmail = `e2e-${rand()}@test.local`;
// Declared here (not just inside their own sections) so later regression sections can
// reuse an already-authenticated account instead of registering a new one — the signup
// rate limit is intentionally tight (5/hour/IP) and this suite already uses most of it.
let other = null;
let remixer = null;
try {
  await user.req('/api/auth/signup', {
    method: 'POST',
    body: { email: userEmail, password: 'test-password-123', displayName: 'Main' },
    expect: 200,
  });

  const me = await user.req('/api/auth/me', { expect: 200 });
  if (me.data.user?.email === userEmail) ok('session authenticates');
  else bad('session authenticates', 'no user on /me');

  const before = me.data.user.credits;
  const gen = await user.req('/api/generate', {
    method: 'POST', body: { prompt: 'toxic sewer mutant escape hard ' + rand() }, expect: 200,
  });
  gameId = gen.data.game.id;
  const after = (await user.req('/api/auth/me')).data.user.credits;
  if (after === before - 10) ok('generate charges exactly 10 credits', `${before} → ${after}`);
  else bad('generate charges exactly 10 credits', `${before} → ${after}`);

  // refine (deterministic path — no API key needed)
  const ref = await user.req(`/api/games/${gameId}/refine`, {
    method: 'POST', body: { instruction: 'make it harder and change to space theme' }, expect: 200,
  });
  if (ref.data.game.version === 2 && ref.data.patch?.length) {
    ok('refine applies a patch and bumps the version', `v2 · ${ref.data.patch.length} ops · ${ref.data.source}`);
  } else bad('refine applies a patch', JSON.stringify(ref.data).slice(0, 160));

  const detail = await user.req(`/api/games/${gameId}`, { expect: 200 });
  if (detail.data.game.report?.levelsBuilt === 20) ok('refined game still has 20 valid levels');
  else bad('refined game still valid', 'report missing or short');
  if (detail.data.versions.length === 2) ok('version history recorded');
  else bad('version history recorded', `${detail.data.versions.length} versions`);

  const badRef = await user.req(`/api/games/${gameId}/refine`, {
    method: 'POST', body: { instruction: 'make it smell like bananas' },
  });
  if (badRef.status === 400 && badRef.data.code === 'REFINE_NOT_UNDERSTOOD') {
    ok('unrecognised refinement is rejected with examples');
  } else bad('unrecognised refinement rejected', `status ${badRef.status}`);

  // publish
  await user.req(`/api/games/${gameId}/visibility`, { method: 'POST', body: { visibility: 'public' }, expect: 200 });
  const pub = await new Client('anon').req('/api/arcade', { expect: 200 });
  if (pub.data.games.some((g) => g.id === gameId)) ok('published game appears in the arcade');
  else bad('published game appears in the arcade', 'not listed');
} catch (e) {
  bad('authenticated lifecycle', e.message);
}

// ─── authorization ──────────────────────────────────────────────────────────
section('Authorization');
try {
  other = new Client('other');
  await other.req('/api/auth/signup', {
    method: 'POST', body: { email: `e2e-${rand()}@test.local`, password: 'test-password-123' }, expect: 200,
  });

  const edit = await other.req(`/api/games/${gameId}/refine`, {
    method: 'POST', body: { instruction: 'make it harder' },
  });
  if (edit.status === 403) ok("another user cannot edit someone else's game");
  else bad("another user cannot edit someone else's game", `status ${edit.status}`);

  const del = await other.req(`/api/games/${gameId}`, { method: 'DELETE' });
  if (del.status === 403) ok("another user cannot delete someone else's game");
  else bad("another user cannot delete someone else's game", `status ${del.status}`);

  const admin = await other.req('/api/admin/overview');
  if (admin.status === 403) ok('non-admin is refused admin data', 'server-side check');
  else bad('non-admin is refused admin data', `status ${admin.status}`);

  const anonAdmin = await new Client('anon').req('/api/admin/users');
  if (anonAdmin.status === 401) ok('anonymous is refused admin data');
  else bad('anonymous is refused admin data', `status ${anonAdmin.status}`);
} catch (e) {
  bad('authorization', e.message);
}

// ─── regression: cross-tenant id collision ──────────────────────────────────
// A game's id used to be hashSeed(prompt) with no owner scoping, so two different
// accounts submitting the exact same prompt text collided on the same id — the second
// submitter's "new game" silently became a version bump of the first submitter's game,
// while the second submitter was still charged as if a game had been created for them.
// Reuses the already-authenticated `user` and `other` accounts rather than signing up
// two new ones — the signup rate limit (5/hour/IP) is tight and this suite needs the
// headroom elsewhere; any two distinct accounts are enough to prove no id collision.
section('Cross-tenant id collision (same prompt, different owners)');
try {
  const sharedPrompt = 'orbital dust racer collision regression test ' + rand();
  const owner1 = user;
  const owner2 = other;

  const gen1 = await owner1.req('/api/generate', { method: 'POST', body: { prompt: sharedPrompt }, expect: 200 });
  const gen2 = await owner2.req('/api/generate', { method: 'POST', body: { prompt: sharedPrompt }, expect: 200 });

  if (gen1.data.game.id !== gen2.data.game.id) {
    ok('two accounts with the identical prompt get different game ids', `${gen1.data.game.id} vs ${gen2.data.game.id}`);
  } else {
    bad('two accounts with the identical prompt get different game ids', `both got ${gen1.data.game.id}`);
  }

  if (gen1.data.game.version === 1 && gen2.data.game.version === 1) {
    ok('neither game was silently bumped to a new version of the other');
  } else {
    bad('neither game was silently bumped', `v1=${gen1.data.game.version} v2=${gen2.data.game.version}`);
  }

  // owner1's game must still exist, unaltered, and still belong to owner1
  const stillOwner1 = await owner1.req(`/api/games/${gen1.data.game.id}`, { expect: 200 });
  if (stillOwner1.data.game.id === gen1.data.game.id && stillOwner1.data.versions.length === 1) {
    ok("owner1's game was not overwritten by owner2's generation");
  } else {
    bad("owner1's game was not overwritten", JSON.stringify(stillOwner1.data).slice(0, 160));
  }

  const owner2CannotEditOwner1 = await owner2.req(`/api/games/${gen1.data.game.id}/refine`, {
    method: 'POST', body: { instruction: 'make it harder' },
  });
  if (owner2CannotEditOwner1.status === 403) ok("owner2 has no access to owner1's distinct game");
  else bad("owner2 has no access to owner1's distinct game", `status ${owner2CannotEditOwner1.status}`);
} catch (e) {
  bad('cross-tenant id collision', e.message);
}

// ─── content policy ─────────────────────────────────────────────────────────
section('Content policy');
try {
  for (const prompt of ['make a mario style runner', 'flappy bird clone', 'candy crush game']) {
    const r = await new Client('anon').req('/api/generate', { method: 'POST', body: { prompt } });
    if (r.status === 422 && r.data.code === 'PROMPT_BLOCKED') ok(`blocked: "${prompt}"`);
    else bad(`blocked: "${prompt}"`, `status ${r.status} code ${r.data?.code}`);
  }
  const short = await new Client('anon').req('/api/generate', { method: 'POST', body: { prompt: 'x' } });
  if (short.status === 400) ok('too-short prompt rejected');
  else bad('too-short prompt rejected', `status ${short.status}`);

  const long = await new Client('anon').req('/api/generate', { method: 'POST', body: { prompt: 'a'.repeat(700) } });
  if (long.status === 400) ok('over-long prompt rejected');
  else bad('over-long prompt rejected', `status ${long.status}`);
} catch (e) {
  bad('content policy', e.message);
}

// ─── credits ────────────────────────────────────────────────────────────────
section('Credits and billing');
try {
  const b = await user.req('/api/billing', { expect: 200 });
  const sum = b.data.ledger.reduce((s, r) => s + r.delta, 0);
  if (sum === b.data.balance) ok('ledger reconciles', `sum=${sum} balance=${b.data.balance}`);
  else bad('ledger reconciles', `sum=${sum} balance=${b.data.balance}`);

  const buy = await user.req('/api/billing/checkout', { method: 'POST', body: { packId: 'small' }, expect: 200 });
  if (buy.data.balance === b.data.balance + 100) ok('mock checkout grants credits', `+100 → ${buy.data.balance}`);
  else bad('mock checkout grants credits', `balance ${buy.data.balance}`);

  const badPack = await user.req('/api/billing/checkout', { method: 'POST', body: { packId: 'nope' } });
  if (badPack.status === 400) ok('unknown credit pack rejected');
  else bad('unknown credit pack rejected', `status ${badPack.status}`);

  const anonBilling = await new Client('anon').req('/api/billing');
  if (anonBilling.status === 401) ok('billing requires auth');
  else bad('billing requires auth', `status ${anonBilling.status}`);
} catch (e) {
  bad('credits', e.message);
}

// ─── APK build ──────────────────────────────────────────────────────────────
section('APK build and download');
try {
  const before = (await user.req('/api/auth/me')).data.user.credits;
  const start = Date.now();
  const q = await user.req(`/api/games/${gameId}/build`, { method: 'POST' });
  if (q.status !== 202 && q.status !== 200) throw new Error(`build queue returned ${q.status}: ${JSON.stringify(q.data)}`);
  const buildId = q.data.buildId;
  ok('build queued', buildId.slice(0, 8));

  let state = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    state = (await user.req(`/api/builds/${buildId}`)).data;
    if (state.status === 'ready' || state.status === 'failed') break;
  }

  if (state?.status === 'ready') {
    ok('APK built', `${(state.durationMs / 1000).toFixed(1)}s · ${(state.result.bytes / 1048576).toFixed(2)} MB`);

    const after = (await user.req('/api/auth/me')).data.user.credits;
    if (after === before - 15) ok('build charged 15 credits', `${before} → ${after}`);
    else bad('build charged 15 credits', `${before} → ${after}`);

    const dl = await fetch(`${BASE}/api/games/${gameId}/apk`, { headers: { cookie: user.cookieHeader } });
    const buf = Buffer.from(await dl.arrayBuffer());
    if (dl.ok && buf.length > 100_000 && buf[0] === 0x50 && buf[1] === 0x4b) {
      ok('APK downloads and is a valid zip', `${(buf.length / 1048576).toFixed(2)} MB`);
    } else bad('APK downloads', `status ${dl.status}, ${buf.length} bytes`);

    if (dl.headers.get('content-type')?.includes('android.package-archive')) ok('APK content-type correct');
    else bad('APK content-type', dl.headers.get('content-type'));

    // rebuilding the same version must be free and instant
    const again = await user.req(`/api/games/${gameId}/build`, { method: 'POST' });
    if (again.data.cached === true) ok('rebuild of the same version is cached and free');
    else bad('rebuild is cached', JSON.stringify(again.data).slice(0, 120));

    const creditsAfterRebuild = (await user.req('/api/auth/me')).data.user.credits;
    if (creditsAfterRebuild === after) ok('cached rebuild charges nothing');
    else bad('cached rebuild charges nothing', `${after} → ${creditsAfterRebuild}`);

    console.log(`  ${c.d}(build wall clock ${((Date.now() - start) / 1000).toFixed(1)}s)${c.x}`);
  } else {
    bad('APK built', `status=${state?.status} error=${state?.error}`);
  }
} catch (e) {
  bad('APK build', e.message);
}

// ─── regression: build charge lost on queue dedup ───────────────────────────
// buildQueue.enqueue() reuses an in-flight job for the same game:version key without
// running the second caller's worker. The route used to charge credits and create a
// `builds` row BEFORE checking that, so a rapid duplicate request (a double-click, or
// just a second request before the first build finishes) got charged 15 credits for a
// build whose row then sat at 'queued' forever.
section('Build charge is not lost on a duplicate/rapid request');
try {
  // Reuses the already-authenticated `user` account (it has plenty of credits after the
  // mock billing top-up above) rather than signing up a new one — see note above.
  const builder = user;
  const gen = await builder.req('/api/generate', {
    method: 'POST', body: { prompt: 'build dedup regression test ' + rand() }, expect: 200,
  });
  const dedupGameId = gen.data.game.id;
  const before = (await builder.req('/api/auth/me')).data.user.credits;

  // Fire two build requests concurrently — the second must NOT be charged.
  const [b1, b2] = await Promise.all([
    builder.req(`/api/games/${dedupGameId}/build`, { method: 'POST' }),
    builder.req(`/api/games/${dedupGameId}/build`, { method: 'POST' }),
  ]);

  if (b1.data.buildId && b1.data.buildId === b2.data.buildId) {
    ok('duplicate build requests resolve to the same buildId', b1.data.buildId.slice(0, 8));
  } else {
    bad('duplicate build requests resolve to the same buildId', `${b1.data.buildId} vs ${b2.data.buildId}`);
  }

  const afterQueued = (await builder.req('/api/auth/me')).data.user.credits;
  if (afterQueued === before - 15) {
    ok('exactly one 15-credit charge for the duplicate pair', `${before} → ${afterQueued}`);
  } else {
    bad('exactly one 15-credit charge for the duplicate pair', `${before} → ${afterQueued}`);
  }

  // Let it finish so it does not race the rest of the suite or leave a build stuck.
  let dedupState = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    dedupState = (await builder.req(`/api/builds/${b1.data.buildId}`)).data;
    if (dedupState.status === 'ready' || dedupState.status === 'failed') break;
  }
  if (dedupState?.status === 'ready') ok('the deduped build still completes and reaches ready');
  else bad('the deduped build still completes', `status=${dedupState?.status}`);
} catch (e) {
  bad('build dedup charge', e.message);
}

// ─── remix ──────────────────────────────────────────────────────────────────
section('Remix');
try {
  remixer = new Client('remixer');
  await remixer.req('/api/auth/signup', {
    method: 'POST', body: { email: `e2e-${rand()}@test.local`, password: 'test-password-123' }, expect: 200,
  });
  const before = (await remixer.req('/api/auth/me')).data.user.credits;
  const r = await remixer.req(`/api/games/${gameId}/remix`, { method: 'POST', expect: 200 });
  const after = (await remixer.req('/api/auth/me')).data.user.credits;

  if (r.data.game.id !== gameId) ok('remix creates a new game', r.data.game.title);
  else bad('remix creates a new game', 'same id as source');
  if (r.data.game.parentGameId === gameId) ok('remix records its parent');
  else bad('remix records its parent', `parent=${r.data.game.parentGameId}`);
  if (after === before - 5) ok('remix charged 5 credits', `${before} → ${after}`);
  else bad('remix charged 5 credits', `${before} → ${after}`);

  const play = await remixer.req(r.data.game.playUrl);
  if (play.status === 200) ok('remixed game has its own playable bundle');
  else bad('remixed game bundle', `status ${play.status}`);

  const src = await new Client('anon').req(`/api/games/${gameId}`, { expect: 200 });
  if (src.data.game.remixCount >= 1) ok('source game remix count incremented');
  else bad('source remix count', `${src.data.game.remixCount}`);
} catch (e) {
  bad('remix', e.message);
}

// ─── regression: anonymous report griefing ──────────────────────────────────
// /api/games/:id/report had no auth, no rate limit and no per-reporter de-duplication,
// and auto-unpublished a game once it hit 3 open reports — so 3 anonymous POSTs from the
// same person took down any public game. Reports must now be deduplicated per reporter
// (user id, or anon cookie key) so repeats from one visitor cannot force the threshold,
// while genuinely distinct reporters must still be able to trigger it.
section('Anonymous report griefing is blocked by de-duplication');
try {
  // Reuses the already-authenticated `remixer` account rather than signing up a new
  // one — see note near the top of the file about the tight signup rate limit.
  const reportOwner = remixer;
  const gen = await reportOwner.req('/api/generate', {
    method: 'POST', body: { prompt: 'report griefing regression test ' + rand() }, expect: 200,
  });
  const reportGameId = gen.data.game.id;
  await reportOwner.req(`/api/games/${reportGameId}/visibility`, {
    method: 'POST', body: { visibility: 'public' }, expect: 200,
  });

  // The SAME anonymous reporter (cookie jar reused) reports repeatedly — must count once.
  const griefer = new Client('griefer');
  for (let i = 0; i < 5; i++) {
    await griefer.req(`/api/games/${reportGameId}/report`, { method: 'POST', body: { reason: 'spam' }, expect: 200 });
  }
  const afterRepeat = await reportOwner.req(`/api/games/${reportGameId}`, { expect: 200 });
  if (afterRepeat.data.game.status === 'ready') {
    ok('5 reports from one reporter do not unpublish the game');
  } else {
    bad('5 reports from one reporter do not unpublish', `status=${afterRepeat.data.game.status}`);
  }

  // 3 genuinely DISTINCT anonymous reporters must still trip the auto-unpublish threshold.
  for (let i = 0; i < 3; i++) {
    await new Client(`distinctReporter${i}`).req(`/api/games/${reportGameId}/report`, {
      method: 'POST', body: { reason: 'spam' }, expect: 200,
    });
  }
  const afterDistinct = await reportOwner.req(`/api/games/${reportGameId}`, { expect: 200 });
  if (afterDistinct.data.game.status === 'unpublished') {
    ok('3 distinct reporters still trigger auto-unpublish', 'threshold counts distinct reporters, not raw reports');
  } else {
    bad('3 distinct reporters still trigger auto-unpublish', `status=${afterDistinct.data.game.status}`);
  }
} catch (e) {
  bad('report griefing', e.message);
}

// ─── telemetry ──────────────────────────────────────────────────────────────
section('Telemetry');
try {
  for (const ev of ['play_start', 'level_attempt', 'level_death', 'level_clear']) {
    await new Client('anon').req('/api/telemetry', {
      method: 'POST', body: { gameId, event: ev, level: 3 }, expect: 204,
    });
  }
  const stats = await new Client('anon').req(`/api/games/${gameId}/stats`, { expect: 200 });
  const l3 = stats.data.levelStats.find((s) => s.level === 3);
  if (l3 && l3.attempts >= 1 && l3.deaths >= 1 && l3.clears >= 1) {
    ok('telemetry aggregates per level', `L3 attempts=${l3.attempts} clears=${l3.clears} deaths=${l3.deaths}`);
  } else bad('telemetry aggregates', JSON.stringify(stats.data.levelStats).slice(0, 160));

  const junk = await new Client('anon').req('/api/telemetry', { method: 'POST', body: { gameId: 'nope', event: 'x' } });
  if (junk.status === 204) ok('telemetry ignores unknown games without erroring');
  else bad('telemetry ignores junk', `status ${junk.status}`);
} catch (e) {
  bad('telemetry', e.message);
}

// ─── admin ──────────────────────────────────────────────────────────────────
section('Admin');
try {
  const admin = new Client('admin');
  await admin.req('/api/auth/login', {
    method: 'POST',
    body: {
      email: process.env.ADMIN_EMAIL || 'admin@factorialstudio.com',
      password: process.env.ADMIN_PASSWORD || 'forge-admin-2026',
    },
    expect: 200,
  });
  ok('admin can sign in');

  const ov = await admin.req('/api/admin/overview', { expect: 200 });
  ok('admin overview', `${ov.data.stats.users} users, ${ov.data.stats.games} games`);

  const users = await admin.req('/api/admin/users', { expect: 200 });
  if (users.data.users.length >= 2) ok('admin sees users', `${users.data.users.length}`);
  else bad('admin sees users', `${users.data.users.length}`);

  // moderation: report a game, confirm it queues, then dismiss it
  await new Client('anon').req(`/api/games/${gameId}/report`, {
    method: 'POST', body: { reason: 'copyright', notes: 'e2e test' }, expect: 200,
  });
  const reports = await admin.req('/api/admin/reports', { expect: 200 });
  const mine = reports.data.reports.find((r) => r.game_id === gameId);
  if (mine) {
    ok('report reaches the moderation queue');
    await admin.req(`/api/admin/reports/${mine.id}/resolve`, {
      method: 'POST', body: { action: 'dismissed', gameId }, expect: 200,
    });
    const after = await admin.req('/api/admin/reports');
    if (!after.data.reports.some((r) => r.id === mine.id)) ok('report can be resolved');
    else bad('report can be resolved', 'still open');
  } else bad('report reaches the moderation queue', 'not found');

  const spend = await admin.req('/api/admin/ai', { expect: 200 });
  ok('AI spend dashboard', `${spend.data.summary.calls} calls, $${Number(spend.data.summary.cost_usd).toFixed(4)}`);

  const lvl = await admin.req('/api/admin/level-stats', { expect: 200 });
  ok('level-stats tuning feed', `${lvl.data.levels.length} levels tracked`);

  const builds = await admin.req('/api/admin/builds', { expect: 200 });
  if (builds.data.builds.length >= 1) ok('build monitor', `${builds.data.builds.length} builds`);
  else bad('build monitor', 'no builds listed');
} catch (e) {
  bad('admin', e.message);
}

// ─── rate limiting ──────────────────────────────────────────────────────────
section('Rate limiting');
try {
  const spammer = new Client('spammer');
  let limited = false;
  let attempts = 0;
  for (let i = 0; i < 16; i++) {
    attempts++;
    const r = await spammer.req('/api/generate', { method: 'POST', body: { prompt: `spam test ${i} ${rand()}` } });
    if (r.status === 429) { limited = true; break; }
  }
  if (limited) ok('anonymous generation is rate limited', `after ${attempts} requests`);
  else bad('anonymous generation is rate limited', `never hit 429 in ${attempts} requests`);

  // The SSE endpoint must deliver the reason IN the stream — EventSource cannot read
  // the body of a non-200 response, so an HTTP 429 here would surface to the user as
  // an unexplained failure.
  const res = await fetch(`${BASE}/api/generate/stream?prompt=${encodeURIComponent('rate limited probe ' + rand())}`, {
    headers: { cookie: spammer.cookieHeader },
  });
  const text = await res.text();
  if (res.status === 200 && text.includes('event: error') && text.includes('RATE_LIMITED')) {
    ok('SSE reports rate limiting inside the stream', 'client can show the real reason');
  } else {
    bad('SSE reports rate limiting inside the stream', `status ${res.status}, body ${text.slice(0, 120)}`);
  }
} catch (e) {
  bad('rate limiting', e.message);
}

// ─── logout ─────────────────────────────────────────────────────────────────
section('Session revocation');
try {
  await user.req('/api/auth/logout', { method: 'POST', expect: 200 });
  const me = await user.req('/api/auth/me', { expect: 200 });
  if (!me.data.user) ok('logout revokes the session');
  else bad('logout revokes the session', 'still authenticated');

  const wrong = await new Client('x').req('/api/auth/login', {
    method: 'POST', body: { email: userEmail, password: 'wrong-password' },
  });
  if (wrong.status === 401) ok('wrong password refused');
  else bad('wrong password refused', `status ${wrong.status}`);
} catch (e) {
  bad('session revocation', e.message);
}

// ─── summary ────────────────────────────────────────────────────────────────
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${c.b}${pass} passed, ${fail} failed${c.x}  ${c.d}in ${secs}s${c.x}`);
if (fail) {
  console.log(`\n${c.r}Failures:${c.x}`);
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail ? 1 : 0);
