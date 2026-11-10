/**
 * The play page: a game inside a web-game-portal frame.
 *
 *   docs/play/<slug>/index.html   this page — the URL every card and every shared link opens
 *   docs/game/<slug>/             the game itself, untouched, loaded here in an iframe
 *
 * LAYOUT
 *
 *   ┌────────────────────────── bar: back · logo · now playing · fullscreen ──────────────────────┐
 *   │ ad 160×600 │                         game frame                              │ ad 160×600 │
 *   │  (sticky)  │   description · Android app                                     │  (sticky)  │
 *   │            │   recently played  ▸ ▸ ▸ ▸ ▸   (one horizontal row)             │            │
 *   │            │   more games       ▸ ▸ ▸ ▸ ▸                                     │            │
 *
 * The page runs edge to edge. The side columns hold an ad and nothing else, and everything that is
 * not the game sits *below* it, so the game frame gets the whole width between the two ads and the
 * whole height under the bar. An earlier version capped the page at 1520 px and kept a 728×90
 * leaderboard on screen under the game; on a 1903×920 window that left 190 px of empty margin on
 * each side and cost the game a quarter of its height.
 *
 * WHY THE GAME LIVES IN AN IFRAME RATHER THAN ON THIS PAGE
 * Every game was built to own its whole window: its own resize logic, its own key handlers on
 * `window`, its own full-page styles. An iframe gives each one exactly the window it was built for,
 * at whatever size this page decides, and leaves the game's own files byte-identical — which is
 * also what the APK builder and the embed pages need, since neither should ship a page with ads.
 *
 * THE FRAME SIZE
 * On anything wider than a phone the frame takes all of it: the full width between the ads and the
 * full height under the bar, whatever the game's shape. Every game here was built for a browser
 * window of any shape and letterboxes itself against its own background, so a frame that does not
 * match the game's ratio costs nothing — while a frame held to the ratio wastes height. It did: on
 * a 1366×768 laptop a 16:9 box stopped at 553 px with 688 available, and SHADOW DASH's control
 * strip fell off the bottom of its menu.
 *
 * On a phone the same rule applies with less chrome: a slimmer bar and no margin, so the game has
 * the screen. A 16:9 box was tried there first and measured worse for every landscape game — at
 * 355×200 their menus and canvases ran off the frame, because each was built for a whole phone
 * screen, not for a strip a fifth of one.
 *
 * WHY THE ADS ARE PLACEHOLDERS UNTIL CONFIGURED
 * AdSense needs a publisher id and one slot id per unit, and an `<ins class="adsbygoogle">` without
 * them throws on every page load. Until `ADSENSE.client` is set the slots render as clearly
 * labelled empty boxes of the exact sizes the real units will take, so the layout is final now and
 * switching ads on later moves nothing.
 */

/**
 * Fill these in once AdSense approves the site, then republish.
 *
 *   client   'ca-pub-0000000000000000'
 *   slots    one ad-unit id per position, from AdSense → Ads → By ad unit
 *            left, right  the two 160×600 skyscrapers beside the game
 *            inline       shown only where the screen is too narrow for side columns (tablets,
 *                         phones): a 728×90 / 320×100 under the game description, so those
 *                         visitors are not the one audience with no ad at all
 *
 * Leave `client` empty and every slot stays a placeholder.
 */
export const ADSENSE = {
  client: '',
  slots: { left: '', right: '', inline: '' },
};

/** Where the game files are published, relative to docs/. */
export const GAME_DIR = 'game';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const UNITS = {
  left: { w: 160, h: 600, label: '160 × 600' },
  right: { w: 160, h: 600, label: '160 × 600' },
  inline: { w: 728, h: 90, label: '728 × 90', small: '320 × 100' },
};

function adSlot(pos) {
  const u = UNITS[pos];
  const live = ADSENSE.client && ADSENSE.slots[pos];
  if (live) {
    // The inline unit is the one that has to change shape between a tablet and a phone, so it is
    // the one left responsive. The skyscrapers are fixed sizes because their columns are.
    const style = pos === 'inline'
      ? 'display:block;width:100%;height:90px'
      : `display:inline-block;width:${u.w}px;height:${u.h}px`;
    const fmt = pos === 'inline' ? ' data-ad-format="horizontal" data-full-width-responsive="true"' : '';
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
  const apkSize = apks.get(game.slug);

  const card = (g) => `
          <a class="card" href="../${g.slug}/" data-slug="${g.slug}">
            ${covers.has(g.slug)
              ? `<img src="../../thumb/small/${g.slug}.jpg" alt="" width="384" height="216" loading="lazy" decoding="async" />`
              : `<span class="swatch" style="background:linear-gradient(135deg,${esc(g.palette?.bg)},${esc(g.palette?.accent)})"></span>`}
            <b>${esc(g.title)}</b><i>${esc(g.family)}</i>
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
    /* Everything above and below the frame that must stay on screen: the bar and the page's own
       top and bottom padding. The frame takes the rest of the height. */
    --bar:56px;--pad:12px;--chrome:calc(var(--bar) + var(--pad) * 2)}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:var(--ink)}
  body{font-family:var(--f-body);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh;
    background-image:radial-gradient(1100px 520px at 78% -12%,rgba(124,179,66,.14),transparent 60%);background-attachment:fixed}
  a{color:inherit}

  .bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;height:var(--bar);padding:0 var(--pad);
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

  /* Edge to edge: the two ad columns sit against the sides of the window, the game takes the rest. */
  .portal{display:grid;grid-template-columns:160px minmax(0,1fr) 160px;gap:var(--pad);align-items:start;padding:var(--pad)}
  .rail{position:sticky;top:calc(var(--bar) + var(--pad))}
  .center{min-width:0;display:flex;flex-direction:column;gap:14px}

  /* All the space there is: full width between the ads, full height under the bar. */
  .stage{position:relative;width:100%;height:calc(100vh - var(--chrome));height:calc(100dvh - var(--chrome));
    border-radius:14px;overflow:hidden;background:#000;box-shadow:0 18px 50px rgba(0,0,0,.5),0 0 0 1px var(--line)}
  .stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}

  .ad{position:relative;display:flex;align-items:center;justify-content:center;margin:0 auto;max-width:100%}
  .ad-tag{position:absolute;top:-1px;left:50%;transform:translateY(-100%) translateX(-50%);font-size:10px;letter-spacing:.6px;
    text-transform:uppercase;color:var(--muted);opacity:.6;white-space:nowrap;padding-bottom:2px}
  .ad.empty .ad-tag{position:static;transform:none;opacity:.55;writing-mode:horizontal-tb}
  .ad.empty{border:1px dashed rgba(255,255,255,.16);border-radius:12px;background:rgba(255,255,255,.025)}
  .ad-left,.ad-right{width:160px;height:600px;max-height:calc(100vh - var(--chrome))}
  .ad-inline{display:none;width:min(100%,728px);height:90px}
  .ad:not(.empty){margin-top:14px}
  .sm{display:none}

  .info{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;padding:16px 18px;border-radius:18px;
    background:var(--panel);border:1px solid var(--line)}
  .info h1{font-family:var(--f-disp);font-size:20px;line-height:1.1}
  .info .fam{font-size:11px;color:var(--leaf2);text-transform:uppercase;letter-spacing:.5px}
  .info .blurb{flex-basis:100%;font-size:14px;color:var(--muted);max-width:90ch}
  .info .title{flex:1;min-width:200px}
  .btn{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:13px;padding:10px 18px;border-radius:999px;
    text-decoration:none;border:1px solid rgba(251,191,36,.5);color:var(--gold)}
  .btn:hover{background:rgba(251,191,36,.08)}
  .btn span{opacity:.6;font-weight:400}

  /* Game rows: one horizontal line each, scrolling sideways when there are more than fit. */
  .shelf h2{font-family:var(--f-disp);font-size:12px;letter-spacing:.6px;color:var(--muted);margin:2px 2px 10px}
  .row{display:grid;grid-auto-flow:column;grid-auto-columns:200px;gap:12px;overflow-x:auto;overscroll-behavior-x:contain;
    padding:2px 2px 10px;scroll-snap-type:x proximity;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
  .card{display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:14px;text-decoration:none;scroll-snap-align:start;
    background:var(--panel);border:1px solid var(--line);min-width:0}
  .card:hover{background:rgba(255,255,255,.07)}
  .card img,.card .swatch{display:block;width:100%;aspect-ratio:16/9;height:auto;border-radius:9px;object-fit:cover;background:#000;margin-bottom:6px}
  .card b{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px}
  .card i{font-style:normal;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px 2px}
  .hint{font-size:12.5px;color:var(--muted);opacity:.8;padding:0 2px 6px}
  [hidden]{display:none !important}

  /* Too narrow for two 160 px columns beside a game worth playing: drop them, and put the one
     inline unit under the description instead. */
  @media (max-width:1100px){
    .portal{grid-template-columns:minmax(0,1fr)}
    .rail{display:none}
    .ad-inline{display:flex}
  }
  /* Phone: the game gets the screen. A slimmer bar, no margin round the frame, no rounding. */
  @media (max-width:880px){
    :root{--bar:46px;--pad:0px}
    .bar{padding:0 8px;gap:8px}
    .back,.fs{height:32px}
    .portal{padding:0}
    .center{gap:12px}
    .stage{border-radius:0;box-shadow:none}
    .info,.shelf{margin:0 10px}
    .ad-inline{width:min(100%,320px);height:100px}
    .lg{display:none}.sm{display:inline}
    .logo{display:none}
    .row{grid-auto-columns:160px}
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

    <section class="info">
      <div class="title"><h1>${esc(game.title)}</h1><p class="fam">${esc(game.family)}</p></div>
      ${apkSize ? `<a class="btn" href="../../apk/${game.slug}.apk" download>Get the Android app <span>${fileSize(apkSize)}</span></a>` : ''}
      <p class="blurb">${esc(game.blurb)}</p>
    </section>

      ${adSlot('inline')}

    <section class="shelf" aria-label="Recently played">
      <h2>RECENTLY PLAYED</h2>
      <div class="row" id="recent"></div>
      <p class="hint" id="recent-hint">Games you play will show up here.</p>
    </section>

    <section class="shelf" aria-label="More games">
      <h2>MORE GAMES</h2>
      <div class="row" id="more">${others.map(card).join('')}
      </div>
    </section>
  </main>

  <aside class="rail right">
      ${adSlot('right')}
  </aside>
</div>

<script>
(function () {
  var SLUG = ${JSON.stringify(game.slug)};
  var KNOWN = ${JSON.stringify(catalog.map((g) => g.slug))};
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
  recent = recent.filter(function (s) { return typeof s === 'string' && KNOWN.indexOf(s) >= 0 && s !== SLUG; });

  var recentRow = document.getElementById('recent');
  var more = document.getElementById('more');
  recent.slice(0, 10).forEach(function (s) {
    var el = more.querySelector('[data-slug="' + s + '"]');
    if (el) recentRow.appendChild(el);      // moved, not copied: a game is listed once
  });
  var any = recentRow.children.length > 0;
  recentRow.hidden = !any;
  document.getElementById('recent-hint').hidden = any;
  if (!more.children.length) more.parentNode.hidden = true;

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
