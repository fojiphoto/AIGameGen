/**
 * Give a pygbag build a loading screen worth looking at.
 *
 * What pygbag ships is a powder-blue page with a green button reading "Loading, please wait ...".
 * For a game that takes tens of seconds to start on a first visit, that is the worst possible
 * first impression: it looks broken, it says nothing about what is happening, and it looks nothing
 * like the game behind it.
 *
 * This patches the built `index.html` rather than replacing pygbag's template. A forked template
 * would have to be re-synced against pygbag on every upgrade, and almost all of that file is
 * machinery — the canvas ids, the script tags, the emscripten status hooks — that we have no
 * opinion about. Everything original is left in place and simply covered; the only elements this
 * needs to survive are `#progress`, `#status` and `#canvas`, and it degrades to a plain branded
 * screen if any of them are missing.
 *
 * On honesty: the stage captions describe what genuinely happens, in order. The runtime really is
 * fetched and unpacked, and these games really do generate every sprite and every sound at startup
 * rather than loading asset files — so "generating textures" is a description, not a decoration.
 * The bar is driven by pygbag's own progress where that exists, and between real updates it eases
 * towards the next stage without ever reaching 100% until the game's canvas is actually up.
 */

//: Everything this injects lives between these two markers, so a second run replaces the first
//: rather than stacking on it. That is not hypothetical tidiness: pygbag does not always
//: regenerate index.html between builds, so a publisher run twice was producing a page with two
//: loading screens — including one built from a stale, half-edited config.
const OPEN = '<!-- forge-loader:begin -->';
const CLOSE = '<!-- forge-loader:end -->';
const PRELOAD_OPEN = '<!-- forge-preload:begin -->';
const PRELOAD_CLOSE = '<!-- forge-preload:end -->';

/**
 * Where the published site lives, as a root-absolute path.
 *
 * GitHub Pages serves a project site under the repository name, so pages sit at
 * `/AIGameGen/play/<slug>/` rather than at the domain root. The runtime base has to include that
 * segment — see `useLocalRuntime` for why it cannot be page-relative — and it is set here rather
 * than guessed, with an override for anyone serving the same build somewhere else.
 *
 * `tools/serve-docs.mjs` mounts docs/ under the same path so local testing exercises exactly the
 * URLs production will.
 */
export const SITE_BASE = process.env.FORGE_SITE_BASE || '/AIGameGen/';
export const RUNTIME_BASE = `${SITE_BASE}engine-runtime/`;

/** Cut every span between two markers, swallowing one trailing newline so it is idempotent. */
function stripBetween(html, open, close) {
  let out = html;
  for (;;) {
    const start = out.indexOf(open);
    if (start === -1) break;
    const end = out.indexOf(close, start);
    if (end === -1) break;
    let after = end + close.length;
    if (out[after] === '\n') after += 1;
    out = out.slice(0, start) + out.slice(after);
  }
  return out;
}

/**
 * Force the aspect ratio pygbag writes into its own page.
 *
 * `--width`/`--height` set the canvas element and the framebuffer size, but `fb_ar` is a literal
 * in the template and stays at 1.77 whatever size you ask for. The loader uses it to fit the
 * canvas to the window, so a portrait game left at 1.77 is scaled as though it were landscape.
 *
 * This sets it rather than patching it conditionally, because "patch only if wrong" leaves a
 * landscape game carrying a portrait ratio if a previous run wrote one — which is exactly what
 * happened.
 *
 * @returns {{html: string, applied: boolean, value: string}}
 */
export function setAspect(html, w, h) {
  const value = (w / h).toFixed(4);
  const out = html.replace(/fb_ar\s*:\s*[\d.]+/, `fb_ar   :  ${value}`);
  return { html: out, applied: out !== html, value };
}

/**
 * Remove any loading screen this module has previously injected.
 *
 * Necessary because pygbag does not reliably rewrite `index.html` between builds, so a publisher
 * run twice was stacking a second loader on the first — including, once, one built from a stale
 * config. Deleting the page first was the obvious alternative and a worse one: it turns a
 * transient CDN outage into a build with no page at all.
 *
 * Handles the marked form and the earlier unmarked one, so a page produced before the markers
 * existed still cleans up.
 */
export function stripLoader(html) {
  let out = stripBetween(html, OPEN, CLOSE);
  // The unmarked form, from before the markers existed. It is always one contiguous span — a style
  // block, the overlay div, then the script that drives them — so it is cut as one span, from the
  // style tag to the `</script>` that closes the driver.
  //
  // Deliberately not "find the div, cut to its `</div>`": the overlay has nested divs, and that
  // version cut at the first inner one and left the rest of the block behind.
  for (;;) {
    const start = out.indexOf('<style id="forge-loader-style">');
    if (start === -1) break;
    const driver = out.indexOf("document.getElementById('forge-loader')", start);
    const end = driver === -1 ? -1 : out.indexOf('</script>', driver);
    if (end === -1) break;
    out = out.slice(0, start) + out.slice(end + '</script>'.length);
  }
  return out;
}

/**
 * Point the page at our own copy of the runtime, and start the big files immediately.
 *
 * Two separate wins, both real.
 *
 * **Self-hosting.** The generated page fetches CPython, the standard library and pygame from
 * `pygame-web.github.io`. That is a free GitHub Pages site like ours, but it is not ours, and the
 * day it returned `NO DATA RECEIVED` both games stopped starting. `rel` is the path from a game
 * page to our mirror. The layout is preserved exactly, because the loader builds some URLs by
 * walking up from the version directory.
 *
 * **Preloading.** This is the part that actually shortens a first visit. Left alone the fetches
 * are a chain — HTML, then `pythons.js`, then `main.js`, then the 13 MB `main.wasm` and the 6.5 MB
 * `main.data`, then the pygame wheel — and each link costs a round trip before its download can
 * even begin. A `preload` hint in the head starts all of them while the HTML is still being
 * parsed, so the transfers overlap instead of queueing.
 *
 * `as="fetch"` is the correct type: these are read with `fetch`/XHR by emscripten, not as scripts.
 * Declaring them as scripts would make the browser fetch them twice.
 *
 * And **no `crossorigin` attribute**, which is the trap here. On a cross-origin preload it is
 * required; on a same-origin one it turns the request into a CORS request, and the ordinary
 * same-origin fetch emscripten makes afterwards does not match that cache entry — so the browser
 * downloads all 20 MB a second time and the "optimisation" doubles the load. Now that the runtime
 * is served from our own origin, the attribute has to go.
 *
 * **The base has to be root-absolute, not page-relative.** This is the part that took a live
 * failure to learn. `pythons.js` publishes the base as `Module.config.cdn`, and other modules
 * build on it — `vtx.js` does `config.cdn + "../vt/"` and then dynamically imports that. A dynamic
 * import resolves against *the importing module's* URL, not the page's, and `vtx.js` sits one
 * directory shallower than the page. So a page-relative base walked up one level too many and
 * asked for `fojiphoto.github.io/engine-runtime/vt/xterm.js` — the repository segment gone, a 404,
 * and a page that had already downloaded 21 MB before failing.
 *
 * An absolute path resolves identically no matter which module joins onto it, which is the only
 * property that makes this safe. Hence `base` includes the site's root path.
 *
 * @param {string} html
 * @param {string} base    root-absolute path to the mirror, e.g. '/AIGameGen/engine-runtime/'
 * @param {string[]} preload  paths under the mirror worth starting early
 */
export function useLocalRuntime(html, base, preload = []) {
  const before = html;
  const rel = base;

  // Rewrite the upstream URL *and* any base a previous run wrote, because pygbag does not reliably
  // regenerate index.html — so on a rebuild there is no upstream URL left to find, and a stale
  // relative base would survive untouched. That is exactly how the page kept shipping
  // `../../engine-runtime/` after this function had been changed to emit an absolute path.
  const PRIOR = new RegExp(
    'https://pygame-web\\.github\\.io/cdn/'      // upstream
    + '|(?:\\.\\./)+engine-runtime/'             // an earlier page-relative base
    + '|/[\\w.-]+/engine-runtime/'               // an earlier absolute base, possibly a different site
    + '|(?<![\\w./-])engine-runtime/',           // a bare one
    'g');
  let out = html.replace(PRIOR, rel);

  // Delimited and stripped before re-inserting, for the same reason the loader is: pygbag does not
  // reliably rewrite index.html, so without this a rebuild leaves the previous hints in place —
  // which is how a set of `crossorigin` preloads survived the commit that removed them.
  out = stripBetween(out, PRELOAD_OPEN, PRELOAD_CLOSE);
  out = stripBetween(out, '<!-- forge-preload -->', '<!-- /forge-preload -->');

  const hints = preload
    .map((p) => `  <link rel="preload" href="${rel}${p}" as="fetch">`)
    .join('\n');
  if (hints && out.includes('</head>')) {
    out = out.replace('</head>', `${PRELOAD_OPEN}\n${hints}\n${PRELOAD_CLOSE}\n</head>`);
  }
  return { html: out, applied: out !== before };
}

/**
 * @param {string} html      the built index.html
 * @param {object} brand     { title, tagline, deep, mid, accent, accent2, blocks: [colours] }
 * @returns {string}
 */
export function brandLoader(html, brand) {
  const b = {
    title: 'LOADING',
    tagline: '',
    deep: '#0b0d1c',
    mid: '#171a35',
    accent: '#5aaaff',
    accent2: '#ffce56',
    blocks: ['#5aaaff', '#a876ff', '#ff9448', '#4cd284', '#ff74a8', '#4ed6e2', '#ffce56'],
    ...brand,
  };

  const overlay = `
<style id="forge-loader-style">
  /* pygbag's own chrome. Kept in the document because the loader writes to it, and — for the
     start button — kept exactly where it is and merely made invisible. Moving it off-screen was
     the first version and it broke starting the game: browsers will not begin audio without a
     real click, and pygbag's own button is what receives it. Invisible and in place still gets
     clicked; parked at -10000px never does. */
  #infobox { opacity: 0 !important; }
  #transfer { position: fixed !important; left: -10000px !important; top: -10000px !important; }
  body { background: ${b.deep} !important; }

  #forge-loader {
    position: fixed; inset: 0; z-index: 1000000;
    /* Decoration only — every click has to reach the page underneath, including the one that
       starts the runtime. */
    pointer-events: none;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 26px;
    background:
      radial-gradient(120% 90% at 50% 38%, ${b.mid} 0%, ${b.deep} 70%);
    color: #f2f4ff;
    font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: opacity .45s ease;
  }
  #forge-loader.done { opacity: 0; pointer-events: none; }

  #forge-loader .mark {
    font-size: clamp(28px, 6.2vw, 52px); font-weight: 800;
    letter-spacing: .22em; text-indent: .22em;
    text-align: center; line-height: 1.15;
    text-shadow: 0 0 26px ${b.accent}66, 0 2px 0 #0006;
  }
  #forge-loader .tag {
    font-size: 12px; letter-spacing: .42em; text-indent: .42em;
    color: #f2f4ff88; text-align: center; margin-top: -14px;
  }

  /* The wave of blocks. The games are made of these, so the loader is too. */
  #forge-loader .blocks { display: flex; gap: 10px; }
  #forge-loader .blocks i {
    display: block; width: 26px; height: 26px; border-radius: 7px;
    animation: forge-bob 1.15s ease-in-out infinite;
    box-shadow: inset 0 2px 0 #ffffff55, inset 0 -3px 0 #00000033, 0 4px 10px #0005;
  }
  @keyframes forge-bob {
    0%, 100% { transform: translateY(0) scale(1); opacity: .55; }
    40%      { transform: translateY(-13px) scale(1.06); opacity: 1; }
  }

  #forge-loader .barwrap {
    width: min(74vw, 340px); height: 8px; border-radius: 99px;
    background: #ffffff1a; overflow: hidden;
  }
  #forge-loader .bar {
    height: 100%; width: 0%; border-radius: 99px;
    background: linear-gradient(90deg, ${b.accent}, ${b.accent2});
    transition: width .35s cubic-bezier(.25,.8,.3,1);
  }

  #forge-loader .stage {
    font-size: 13px; letter-spacing: .16em; text-transform: uppercase;
    color: #f2f4ffcc; min-height: 1.2em; text-align: center;
  }
  #forge-loader .note {
    position: absolute; bottom: 22px; left: 0; right: 0;
    font-size: 11px; letter-spacing: .06em; color: #f2f4ff66; text-align: center;
    padding: 0 18px; line-height: 1.5;
  }
  #forge-loader .engine {
    position: absolute; top: 20px; left: 0; right: 0; text-align: center;
    font-size: 10px; letter-spacing: .5em; text-indent: .5em; color: #f2f4ff55;
  }
</style>

<div id="forge-loader">
  <div class="engine">FORGE ENGINE</div>
  <div class="mark">${escapeHtml(b.title)}</div>
  ${b.tagline ? `<div class="tag">${escapeHtml(b.tagline)}</div>` : ''}
  <div class="blocks">${b.blocks
    .map((c, i) => `<i style="background:${c};animation-delay:${(i * 0.09).toFixed(2)}s"></i>`)
    .join('')}</div>
  <div class="barwrap"><div class="bar" id="forge-bar"></div></div>
  <div class="stage" id="forge-stage">Starting the engine</div>
  <div class="note" id="forge-note">
    First visit downloads the engine runtime (~10 MB). Your browser caches it, so every visit
    after this one starts quickly.
  </div>
</div>

<script>
(function () {
  var loader = document.getElementById('forge-loader');
  var bar = document.getElementById('forge-bar');
  var stageEl = document.getElementById('forge-stage');
  if (!loader) return;

  // Ordered to match what actually happens, with the share of the bar each stage covers. The
  // last one is deliberately open-ended: it ends when the canvas appears, not on a timer.
  var STAGES = [
    [0.06, 'Starting the engine'],
    [0.16, 'Fetching the Python runtime'],
    [0.52, 'Compiling to WebAssembly'],
    [0.70, 'Unpacking the game'],
    [0.82, 'Generating textures and tiles'],
    [0.92, 'Synthesising the sound bank'],
    [0.99, 'Almost there']
  ];

  var note = document.getElementById('forge-note');
  var shown = 0;      // what the bar is displaying, 0..1
  var floorHit = 0;   // highest real signal seen
  var waited = 0;     // ticks, for deciding when a hint is worth showing

  function realProgress() {
    // pygbag writes to a <progress> and to a status line; use whichever is further along. Neither
    // is guaranteed to exist, hence the guards.
    var best = 0;
    var p = document.getElementById('progress');
    if (p && p.max > 0 && p.value > 0) best = Math.max(best, p.value / p.max);
    var s = document.getElementById('status');
    if (s) {
      var m = /\\((\\d+(?:\\.\\d+)?)\\/(\\d+(?:\\.\\d+)?)\\)/.exec(s.textContent || '');
      if (m && +m[2] > 0) best = Math.max(best, +m[1] / +m[2]);
    }
    return best;
  }

  function ready() {
    var c = document.getElementById('canvas');
    return !!(c && c.width > 100 && c.height > 100);
  }

  var tick = setInterval(function () {
    if (ready()) {
      shown = 1;
      bar.style.width = '100%';
      stageEl.textContent = 'Ready';
      clearInterval(tick);
      setTimeout(function () {
        loader.classList.add('done');
        setTimeout(function () { loader.remove(); }, 500);
      }, 220);
      return;
    }

    // Browsers refuse to start audio without a real click, and pygbag's own button is what takes
    // it — but only some loads need one, so this is offered rather than demanded, and only once
    // the wait has gone on long enough to be worth explaining.
    waited += 1;
    if (waited > 90 && note) {
      note.textContent = 'Taking a while? Click anywhere on the page to start it.';
    }

    floorHit = Math.max(floorHit, realProgress());
    // Ease towards the real figure when there is one; otherwise creep, slower the further along,
    // and never past the last stage boundary. A bar that sits at 100% while nothing happens is
    // worse than one that is honestly slow.
    var target = Math.max(floorHit, shown + (1 - shown) * 0.012);
    shown = Math.min(target, 0.985);
    bar.style.width = (shown * 100).toFixed(1) + '%';

    for (var i = STAGES.length - 1; i >= 0; i--) {
      if (shown >= STAGES[i][0] || i === 0) { stageEl.textContent = STAGES[i][1]; break; }
    }
  }, 140);
})();
</script>
`;

  html = stripLoader(html);

  // Injected just before </body> so every element it refers to already exists in the document.
  if (!html.includes('</body>')) return html;
  return html.replace('</body>', `${OPEN}\n${overlay}\n${CLOSE}\n</body>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
