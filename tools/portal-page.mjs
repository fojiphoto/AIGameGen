/**
 * The play page: a game inside a web-game-portal frame.
 *
 *   docs/play/<slug>/index.html   this page — the URL every card and every shared link opens
 *   docs/game/<slug>/             the game itself, untouched, loaded here in an iframe
 *
 * WHY THE GAME LIVES IN AN IFRAME RATHER THAN ON THIS PAGE
 * Every game was built to own its whole window: its own resize logic, its own key handlers on
 * `window`, its own full-page styles. Putting ad slots and a game list *around* it on the same
 * page would mean editing fourteen games, two of which are Python compiled to WebAssembly. An
 * iframe gives each game exactly the window it was built for, at whatever size this page decides,
 * and leaves the game's own files byte-identical — which is also what the APK builder and the
 * embed pages need, since neither should ever ship a page with ads on it.
 *
 * WHY THE ADS ARE PLACEHOLDERS UNTIL CONFIGURED
 * AdSense needs a publisher id and one slot id per unit, and an `<ins class="adsbygoogle">` without
 * them throws on every page load. Until `ADSENSE.client` is set the slots render as clearly
 * labelled empty boxes of the exact sizes the real units will take, so the layout is final now and
 * switching ads on later moves nothing.
 *
 * Sizes are the standard IAB units AdSense fills most readily: a 160×600 skyscraper on the left, a
 * 300×250 rectangle at the top of the right rail, and a 728×90 leaderboard under the game (320×100
 * on a phone). None of them touches the game frame — an ad that a player can hit while aiming or
 * steering is both an accidental click and an AdSense policy violation.
 */

/**
 * Fill these in once AdSense approves the site, then republish.
 *
 *   client   'ca-pub-0000000000000000'
 *   slots    one ad-unit id per position, from AdSense → Ads → By ad unit
 *
 * Leave `client` empty and every slot stays a placeholder.
 */
export const ADSENSE = {
  client: '',
  slots: { left: '', right: '', bottom: '' },
};

/** Where the game files are published, relative to docs/. */
export const GAME_DIR = 'game';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** `16/9` → 1.7778. Defaults to landscape, which is what every generated template is. */
const ratio = (aspect) => {
  const [w, h] = String(aspect || '16/9').split('/').map(Number);
  return w > 0 && h > 0 ? +(w / h).toFixed(4) : 16 / 9;
};

const UNITS = {
  left: { w: 160, h: 600, label: '160 × 600' },
  right: { w: 300, h: 250, label: '300 × 250' },
  bottom: { w: 728, h: 90, label: '728 × 90', small: '320 × 100' },
};

function adSlot(pos) {
  const u = UNITS[pos];
  const live = ADSENSE.client && ADSENSE.slots[pos];
  if (live) {
    // The leaderboard is the one unit that has to change shape on a phone, so it is the one left
    // responsive. The side units are fixed sizes because their columns are.
    const style = pos === 'bottom'
      ? 'display:block;width:100%;height:90px'
      : `display:inline-block;width:${u.w}px;height:${u.h}px`;
    const fmt = pos === 'bottom' ? ' data-ad-format="horizontal" data-full-width-responsive="true"' : '';
    return `<div class="ad ad-${pos}">
        <span class="ad-tag">Advertisement</span>
        <ins class="adsbygoogle" style="${style}" data-ad-client="${esc(ADSENSE.client)}" data-ad-slot="${esc(ADSENSE.slots[pos])}"${fmt}></ins>
        <script>(window.adsbygoogle = window.adsbygoogle || []).push({});</script>
      </div>`;
  }
  return `<div class="ad ad-${pos} empty" aria-hidden="true">
        <span class="ad-tag">Ad space · <span class="lg">${u.label}</span>${u.small ? `<span class="sm">${u.small}</span>` : ''}</span>
      </div>`;
}

/**
 * @param {object}   game       the game being played: slug, title, family, blurb, aspect, palette
 * @param {object[]} catalog    every published game, in arcade order, same shape
 * @param {object}   assets     { covers: Set<slug>, apks: Map<slug, bytes>, fileSize(bytes) }
 */
export function portalPage(game, catalog, { covers, apks, fileSize }) {
  const others = catalog.filter((g) => g.slug !== game.slug);
  /**
   * Two shapes, because a game's page is not always the same shape on a desktop as on a phone.
   *
   * `aspect` is the game's own shape — it also decides the APK's orientation. `frame`, when a
   * game sets it, is the shape of the box on a desktop play page. PAC MAZE is the case that needs
   * it: at 9:16 on a desktop its page drops into its phone layout and scrolls inside the frame, at
   * 4:3 it uses its desktop layout and fits with nothing to spare.
   *
   * On a phone a portrait game gets the whole screen under the bar instead of a box of a fixed
   * shape, which is what game portals do there: the game first, the ad a scroll below it.
   */
  const ar = ratio(game.frame || game.aspect);
  const tallOnPhone = ratio(game.aspect) < 1;
  const apkSize = apks.get(game.slug);

  // Only what the list needs, inlined: one page, no extra request, works from a file host.
  const list = catalog.map((g) => ({
    slug: g.slug, title: g.title, family: g.family, cover: covers.has(g.slug),
    bg: g.palette?.bg || '#111', accent: g.palette?.accent || '#888',
  }));

  const item = (g) => `
        <a class="item" href="../${g.slug}/" data-slug="${g.slug}">
          ${covers.has(g.slug)
            ? `<img src="../../thumb/small/${g.slug}.jpg" alt="" width="96" height="54" loading="lazy" decoding="async" />`
            : `<span class="swatch" style="background:linear-gradient(135deg,${esc(g.palette?.bg)},${esc(g.palette?.accent)})"></span>`}
          <span class="meta"><b>${esc(g.title)}</b><i>${esc(g.family)}</i></span>
        </a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(game.title)} — play free online | Forge Arcade</title>
<meta name="description" content="${esc(game.blurb)}" />
<meta property="og:title" content="${esc(game.title)} — Forge Arcade" />
<meta property="og:description" content="${esc(game.blurb)}" />
${covers.has(game.slug) ? `<meta property="og:image" content="../../thumb/${game.slug}.png" />
<meta name="twitter:card" content="summary_large_image" />
` : ''}<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Bungee&family=Fredoka:wght@400;500;600;700&display=swap" rel="stylesheet" />
${ADSENSE.client ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(ADSENSE.client)}" crossorigin="anonymous"></script>
` : ''}<style>
  :root{--ink:#06281c;--panel:rgba(0,0,0,.24);--gold:#fbbf24;--leaf2:#a3d977;--text:#eaf5ee;--muted:#a9c6b5;
    --line:rgba(255,255,255,.08);--f-disp:'Bungee',cursive;--f-body:'Fredoka',sans-serif;
    /* Everything on screen that is not the game, top to bottom: bar, gaps, leaderboard. The stage
       is sized from what is left, so the leaderboard is always visible without scrolling. */
    --chrome:214px}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:var(--ink)}
  body{font-family:var(--f-body);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh;
    background-image:radial-gradient(1100px 520px at 78% -12%,rgba(124,179,66,.14),transparent 60%);background-attachment:fixed}
  a{color:inherit}

  .bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;height:56px;padding:0 18px;
    background:rgba(4,30,21,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .back{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px 0 10px;border-radius:999px;
    border:1px solid var(--line);background:rgba(255,255,255,.06);font-weight:600;font-size:14px;text-decoration:none}
  .back:hover{background:rgba(255,255,255,.12)}
  .back svg{width:18px;height:18px}
  .logo{font-family:var(--f-disp);font-size:16px;text-decoration:none;white-space:nowrap}
  .logo span{color:var(--leaf2)}
  .now{flex:1;min-width:0;font-weight:600;font-size:14px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .now b{color:var(--text)}
  .fs{height:36px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.06);
    color:var(--text);font:600 13px var(--f-body);cursor:pointer}
  .fs:hover{background:rgba(255,255,255,.12)}

  .portal{display:grid;grid-template-columns:160px minmax(0,1fr) 300px;gap:18px;align-items:start;
    max-width:1520px;margin:0 auto;padding:14px 18px 48px}
  .rail{display:flex;flex-direction:column;gap:16px}
  .rail.left{position:sticky;top:70px}
  .center{min-width:0;display:flex;flex-direction:column;gap:14px}

  .stage{--ar:${ar};position:relative;margin:0 auto;aspect-ratio:var(--ar);
    width:min(100%, calc((100vh - var(--chrome)) * var(--ar)));
    width:min(100%, calc((100dvh - var(--chrome)) * var(--ar)));
    border-radius:16px;overflow:hidden;background:#000;box-shadow:0 18px 50px rgba(0,0,0,.5),0 0 0 1px var(--line)}
  .stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}

  .ad{position:relative;display:flex;align-items:center;justify-content:center;margin:0 auto;max-width:100%}
  .ad-tag{position:absolute;top:-1px;left:50%;transform:translateY(-100%) translateX(-50%);font-size:10px;letter-spacing:.6px;
    text-transform:uppercase;color:var(--muted);opacity:.6;white-space:nowrap;padding-bottom:2px}
  .ad.empty .ad-tag{position:static;transform:none;opacity:.55}
  .ad.empty{border:1px dashed rgba(255,255,255,.16);border-radius:12px;background:rgba(255,255,255,.025)}
  .ad-left{width:160px;height:600px}
  .ad-right{width:300px;height:250px}
  .ad-bottom{width:min(100%,728px);height:90px}
  .ad:not(.empty){margin-top:14px}
  .sm{display:none}

  .info{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;padding:16px 18px;border-radius:18px;
    background:var(--panel);border:1px solid var(--line)}
  .info h1{font-family:var(--f-disp);font-size:20px;line-height:1.1}
  .info .fam{font-size:11px;color:var(--leaf2);text-transform:uppercase;letter-spacing:.5px}
  .info .blurb{flex-basis:100%;font-size:14px;color:var(--muted);max-width:80ch}
  .info .title{flex:1;min-width:200px}
  .btn{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:13px;padding:10px 18px;border-radius:999px;
    text-decoration:none;border:1px solid rgba(251,191,36,.5);color:var(--gold)}
  .btn:hover{background:rgba(251,191,36,.08)}
  .btn span{opacity:.6;font-weight:400}

  .list{padding:14px;border-radius:18px;background:var(--panel);border:1px solid var(--line)}
  .list h2{font-family:var(--f-disp);font-size:12px;letter-spacing:.6px;color:var(--muted);margin:4px 2px 10px}
  .list h2 + .items{margin-bottom:14px}
  .items{display:flex;flex-direction:column;gap:6px}
  .item{display:flex;align-items:center;gap:11px;padding:6px;border-radius:12px;text-decoration:none}
  .item:hover{background:rgba(255,255,255,.07)}
  .item img,.item .swatch{flex:none;width:96px;height:54px;border-radius:9px;object-fit:cover;background:#000;display:block}
  .meta{min-width:0;display:flex;flex-direction:column}
  .meta b{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta i{font-style:normal;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hint{font-size:12.5px;color:var(--muted);opacity:.8;padding:2px 4px 14px}
  [hidden]{display:none !important}

  /* No room for the skyscraper: drop it, keep the right rail. */
  @media (max-width:1200px){
    .portal{grid-template-columns:minmax(0,1fr) 300px}
    .rail.left{display:none}
  }
  /* Tablet: one column — game, leaderboard, info, then the rail underneath. Two columns at this
     width left the game 655×368, short enough to cut the bottom off a game's own menu; one column
     gives it the full width instead. The list goes into a grid so it does not become one long
     strip. */
  @media (max-width:1080px){
    .portal{grid-template-columns:minmax(0,1fr)}
    .items{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
    .ad-right{order:2}
  }
  /* Phone. */
  @media (max-width:880px){
    :root{--chrome:196px}
    .portal{padding:12px 12px 40px}
    .ad-bottom{width:min(100%,320px);height:100px}
    .lg{display:none}.sm{display:inline}
    .logo{display:none}${tallOnPhone ? `
    .stage{width:100%;aspect-ratio:auto;height:calc(100vh - 92px);height:calc(100dvh - 92px)}` : ''}
  }
  @media (max-width:420px){ .back span{display:none} .back{padding:0 10px} }
</style>
</head>
<body>
<header class="bar">
  <a class="back" href="../../" aria-label="Back to all games">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg><span>All games</span>
  </a>
  <a class="logo" href="../../">FORGE<span>ARCADE</span></a>
  <div class="now">Now playing · <b>${esc(game.title)}</b></div>
  <button class="fs" id="fs" type="button" hidden>Fullscreen</button>
</header>

<div class="portal">
  <aside class="rail left">
      ${adSlot('left')}
  </aside>

  <main class="center">
    <div class="stage">
      <iframe id="game" title="${esc(game.title)}"
              allow="autoplay; fullscreen; gamepad; cross-origin-isolated" allowfullscreen></iframe>
    </div>
      ${adSlot('bottom')}
    <section class="info">
      <div class="title"><h1>${esc(game.title)}</h1><p class="fam">${esc(game.family)}</p></div>
      ${apkSize ? `<a class="btn" href="../../apk/${game.slug}.apk" download>Get the Android app <span>${fileSize(apkSize)}</span></a>` : ''}
      <p class="blurb">${esc(game.blurb)}</p>
    </section>
  </main>

  <aside class="rail right">
      ${adSlot('right')}
    <section class="list" aria-label="More games">
      <h2>RECENTLY PLAYED</h2>
      <div class="items" id="recent"></div>
      <p class="hint" id="recent-hint">Games you play will show up here.</p>
      <h2>MORE GAMES</h2>
      <div class="items" id="more">${others.map(item).join('')}
      </div>
    </section>
  </aside>
</div>

<script>
(function () {
  var SLUG = ${JSON.stringify(game.slug)};
  var GAMES = ${JSON.stringify(list)};
  var KEY = 'forge.arcade.recent.v1';
  var frame = document.getElementById('game');

  // The game URL is set here rather than in the markup so a query string on this page — a debug
  // flag, a seed — reaches the game, and the frame still loads exactly once.
  frame.src = '../../${GAME_DIR}/' + SLUG + '/' + location.search + location.hash;

  // ── recently played ──────────────────────────────────────────────────────
  // Browser storage, per visitor: it is a convenience, so a private window or blocked storage
  // just shows the hint instead.
  var recent = [];
  try { recent = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
  if (!Array.isArray(recent)) recent = [];
  var known = {};
  GAMES.forEach(function (g) { known[g.slug] = true; });
  recent = recent.filter(function (s) { return typeof s === 'string' && known[s] && s !== SLUG; });

  var recentBox = document.getElementById('recent');
  var more = document.getElementById('more');
  recent.slice(0, 6).forEach(function (s) {
    var el = more.querySelector('[data-slug="' + s + '"]');
    if (el) recentBox.appendChild(el);      // moved, not copied: a game is listed once
  });
  document.getElementById('recent-hint').hidden = recentBox.children.length > 0;

  try { localStorage.setItem(KEY, JSON.stringify([SLUG].concat(recent).slice(0, 12))); } catch (e) {}

  // ── keyboard focus ───────────────────────────────────────────────────────
  // The games listen for keys on their own window, which only hears them while the frame has
  // focus. Give it focus on load, and if a key meant for the game lands on this page instead,
  // stop it scrolling the page and hand focus back.
  function focusGame() { try { frame.contentWindow.focus(); } catch (e) {} try { frame.focus(); } catch (e) {} }
  frame.addEventListener('load', focusGame);
  var GAME_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, ' ': 1, Spacebar: 1 };
  document.addEventListener('keydown', function (e) {
    if (GAME_KEYS[e.key] && document.activeElement !== frame) { e.preventDefault(); focusGame(); }
  });

  // ── fullscreen ───────────────────────────────────────────────────────────
  // Hidden where element fullscreen does not exist (iPhone Safari), rather than shown and broken.
  var fs = document.getElementById('fs');
  var request = frame.requestFullscreen || frame.webkitRequestFullscreen;
  if (request) {
    fs.hidden = false;
    fs.addEventListener('click', function () {
      try { var p = request.call(frame); if (p && p.then) p.then(focusGame, function () {}); else focusGame(); } catch (e) {}
    });
  }
})();
</script>
</body>
</html>
`;
}
