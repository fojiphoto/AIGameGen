/**
 * Shared frontend runtime: API client, nav, auth state, toasts, game cards.
 *
 * Deliberately no framework. The whole product runs from `node apps/api/src/server.mjs`
 * with no build step, which matters more for a local demo than component ergonomics.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${Math.round(b / 1024)} KB`);
export const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');

// ── api ─────────────────────────────────────────────────────────────────────

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    Object.assign(err, data, { status: res.status });
    throw err;
  }
  return data;
}

// ── toast ───────────────────────────────────────────────────────────────────

let toastEl = null;
let toastTimer = null;
export function toast(message, kind = '') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.className = `on ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = kind), 3600);
}

/** Turn an API error into a toast, with a sensible action for the common cases. */
export function toastError(err) {
  if (err.code === 'AUTH_REQUIRED') {
    toast('Sign in to do that.', 'err');
    setTimeout(() => (location.href = `/login?next=${encodeURIComponent(location.pathname)}`), 900);
    return;
  }
  if (err.code === 'INSUFFICIENT_CREDITS') {
    toast(`${err.error} Top up to continue.`, 'err');
    setTimeout(() => (location.href = '/billing'), 1200);
    return;
  }
  toast(err.error || err.message || 'Something went wrong.', 'err');
}

// ── session ─────────────────────────────────────────────────────────────────

let META = null;
export async function meta(force = false) {
  if (META && !force) return META;
  META = await api('/api/meta').catch(() => ({ mode: 'unknown', user: null, stats: {} }));
  return META;
}

/**
 * Re-read the balance and update the nav pill in place.
 * Call after anything that spends credits — a counter that only updates on a full page
 * reload reads as a broken product, which is the last impression a billing UI should give.
 */
export async function refreshCredits() {
  const m = await meta(true);
  const pill = document.querySelector('[data-credits]');
  if (pill && m.user) pill.textContent = `${m.user.credits} CREDITS`;
  return m;
}

// ── chrome ──────────────────────────────────────────────────────────────────

const NAV = [
  ['/studio', 'Studio'],
  ['/dashboard', 'My Games'],
  ['/arcade', 'Arcade'],
  ['/billing', 'Credits'],
];

export async function mountChrome({ active = '' } = {}) {
  const m = await meta();
  const nav = document.createElement('nav');
  nav.className = 'top';

  const links = NAV.map(([href, label]) =>
    `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`
  ).join('');

  const modePill =
    m.mode === 'llm'
      ? '<span class="pill live" title="Claude is generating configs">AI MODE</span>'
      : '<span class="pill warn" title="No ANTHROPIC_API_KEY — the rule-based planner is running. Everything works.">DETERMINISTIC</span>';

  const right = m.user
    ? `<span class="pill live" data-credits title="Credit balance">${m.user.credits} CREDITS</span>
       ${m.user.role === 'admin' ? '<a class="pill" href="/admin">ADMIN</a>' : ''}
       <span class="pill">${esc(m.user.displayName || m.user.email)}</span>
       <button class="ghost sm" id="logoutBtn">SIGN OUT</button>`
    : `<a class="btn ghost sm" href="/login">SIGN IN</a>
       <a class="btn sm" href="/signup">GET STARTED</a>`;

  nav.innerHTML = `
    <a class="logo" href="/">FACTORIAL<span>STUDIO</span></a>
    <div class="links">${links}</div>
    <span class="grow"></span>
    ${modePill}
    ${right}`;

  const host = $('#chrome') || document.body;
  host.prepend(nav);

  $('#logoutBtn')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });

  mountFooter();
  mountConsent();
  return m;
}

function mountFooter() {
  if ($('footer.site')) return;
  const f = document.createElement('footer');
  f.className = 'site wrap';
  f.innerHTML = `
    <span>© 2026 Factorial Studio Private Limited.</span>
    <span class="grow"></span>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="/arcade">Arcade</a>`;
  document.body.append(f);
}

/**
 * Consent gate. Nothing analytics-flavoured loads before a choice is made, and
 * "essential only" is the primary button rather than a buried link.
 */
function mountConsent() {
  if (localStorage.getItem('forge.consent')) return;
  const el = document.createElement('div');
  el.id = 'consent';
  el.className = 'on';
  el.innerHTML = `
    <b>Cookies</b><br />
    <span class="small">We use one essential cookie to keep you signed in. Nothing else is set unless you opt in.</span>
    <div class="row">
      <button class="leaf sm" data-c="essential">ACCEPT ESSENTIAL ONLY</button>
      <button class="ghost sm" data-c="all">ALLOW ANALYTICS TOO</button>
    </div>`;
  document.body.append(el);
  el.addEventListener('click', (e) => {
    const c = e.target.dataset?.c;
    if (!c) return;
    localStorage.setItem('forge.consent', c);
    el.className = '';
  });
}

// ── game cards ──────────────────────────────────────────────────────────────

export function gameCard(g, { showAuthor = false, actions = ['play', 'open', 'apk'] } = {}) {
  const p = g.palette || {};
  const el = document.createElement('div');
  el.className = 'game';

  const btn = {
    play: `<button class="leaf sm" data-a="play">PLAY</button>`,
    open: `<a class="btn ghost sm" href="/game/${g.id}">OPEN</a>`,
    apk: g.apk
      ? `<a class="btn sm" href="/api/games/${g.id}/apk">APK ${fmtBytes(g.apk.bytes)}</a>`
      : `<a class="btn sm" href="/export/${g.id}">BUILD APK</a>`,
    remix: `<button class="sm" data-a="remix">REMIX</button>`,
    report: `<button class="ghost sm" data-a="report" title="Report this game">⚑</button>`,
  };

  el.innerHTML = `
    <div class="swatch" style="background:linear-gradient(160deg,${p.bgAccent || '#0a5a42'},${p.bg || '#06281c'})">
      <i style="background:${p.ground || '#11704f'}"></i>
      <i style="background:${p.player || '#a3d977'}"></i>
      <i style="background:${p.obstacle || '#ff7043'}"></i>
      <i style="background:${p.accent || '#fbbf24'}"></i>
    </div>
    <div class="body">
      <h3>${esc(g.title)}</h3>
      <div class="meta">
        ${showAuthor ? `by ${esc(g.author || 'anonymous')} · ` : ''}${esc(g.tagline || '')}<br />
        v${g.version} · ${g.source} · ${g.playCount || 0} plays${g.remixCount ? ` · ${g.remixCount} remixes` : ''}
        ${g.isPublic ? ' · <span style="color:var(--leaf2)">public</span>' : ''}
      </div>
      <div class="acts">${actions.map((a) => btn[a] || '').join('')}</div>
    </div>`;

  el.querySelector('[data-a=play]')?.addEventListener('click', () => playModal(g));
  el.querySelector('[data-a=remix]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'REMIXING…';
    try {
      const out = await api(`/api/games/${g.id}/remix`, { method: 'POST' });
      toast('Remixed — opening your copy.');
      location.href = `/game/${out.game.id}`;
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'REMIX';
      toastError(err);
    }
  });
  el.querySelector('[data-a=report]')?.addEventListener('click', async () => {
    const reason = prompt('Why are you reporting this game? (copyright, offensive, broken, other)');
    if (!reason) return;
    try {
      await api(`/api/games/${g.id}/report`, { method: 'POST', body: { reason: reason.slice(0, 40) } });
      toast('Reported. Thanks — a moderator will review it.');
    } catch (err) {
      toastError(err);
    }
  });

  return el;
}

// ── play modal ──────────────────────────────────────────────────────────────

let dlg = null;
export function playModal(game) {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.innerHTML = `
      <div class="dlgHead">
        <h3 id="pmTitle"></h3>
        <a class="btn ghost sm" id="pmOpen" href="#">DETAILS</a>
        <button class="ghost sm" id="pmClose">CLOSE</button>
      </div>
      <iframe class="game" id="pmFrame" title="game"></iframe>`;
    document.body.append(dlg);
    dlg.querySelector('#pmClose').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => (dlg.querySelector('#pmFrame').src = 'about:blank'));
  }
  dlg.querySelector('#pmTitle').textContent = game.title;
  dlg.querySelector('#pmOpen').href = `/game/${game.id}`;
  dlg.querySelector('#pmFrame').src = game.playUrl;
  dlg.showModal();
  api('/api/telemetry', { method: 'POST', body: { gameId: game.id, event: 'play_start' } }).catch(() => {});
}

// ── generation stream ───────────────────────────────────────────────────────

const STAGE_LABELS = {
  classifying: 'Understanding your idea',
  designing: 'Designing game rules',
  building_levels: 'Building 20 levels',
  validating: 'Checking every level is beatable',
  bundling: 'Packaging your game',
  ready: 'Done',
};

/**
 * Subscribe to the real pipeline stages. Not a fake timer — "Checking every level is
 * beatable" is an actual step and the strongest claim the product has.
 */
export function streamGenerate(prompt, { box, onDone, onError, deterministic = false }) {
  box.className = 'stages on';
  box.innerHTML = '';
  let last = null;

  const url = `/api/generate/stream?prompt=${encodeURIComponent(prompt)}${deterministic ? '&deterministic=true' : ''}`;
  const es = new EventSource(url);

  es.addEventListener('stage', (ev) => {
    const { stage, detail } = JSON.parse(ev.data);
    if (last) last.className = 'stage done';
    const row = document.createElement('div');
    row.className = 'stage';
    row.innerHTML = `<b>▸</b><span>${STAGE_LABELS[stage] || stage}${detail ? ` <span class="d">— ${esc(detail)}</span>` : ''}</span>`;
    box.append(row);
    last = row;
  });

  es.addEventListener('done', (ev) => {
    if (last) last.className = 'stage done';
    es.close();
    onDone(JSON.parse(ev.data));
  });

  es.addEventListener('error', (ev) => {
    es.close();
    let payload = { error: 'Generation failed. Is the server still running?' };
    try { if (ev.data) payload = JSON.parse(ev.data); } catch {}
    onError(payload);
  });

  return () => es.close();
}
