/**
 * Gameplay telemetry (§F4).
 *
 * Feeds the difficulty-tuning loop: if level 12 clears at 4% across every generated
 * game, the curve in packages/generation/curve.mjs is wrong, and this is the data that
 * proves it.
 *
 * The game id is read from the URL (`/play/<id>/bundle/`) rather than baked into the
 * bundle. That is deliberate: inside the APK the page is loaded from `file://`, there is
 * no id to find, and the app has no INTERNET permission anyway — so telemetry disables
 * itself in exactly the place where it must not run. Nothing to configure, nothing to
 * accidentally ship.
 */

const gameId = (() => {
  try {
    const m = String(location.pathname).match(/\/play\/([A-Za-z0-9_-]+)\//);
    return m ? m[1] : null;
  } catch {
    return null;
  }
})();

/**
 * Also off when the page says so.
 *
 * A statically-exported build (GitHub Pages, a CDN, an iframe on someone's marketing site)
 * matches the `/play/<id>/` path but has no API behind it, so every event would 404. Harmless
 * functionally — it is all wrapped in catch — but a console full of failed requests is the
 * last thing you want a client looking at. `tools/publish-web.mjs` sets this flag.
 */
const optedOut = (() => {
  try {
    return window.__FORGE_NO_TELEMETRY__ === true;
  } catch {
    return false;
  }
})();

export const enabled = Boolean(gameId) && !optedOut && location.protocol.startsWith('http');

function post(body) {
  if (!enabled) return;
  try {
    const payload = JSON.stringify({ gameId, ...body });
    // sendBeacon survives the page being closed mid-run, which is exactly when a
    // session_end event matters most.
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/telemetry', new Blob([payload], { type: 'application/json' }));
      return;
    }
    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* telemetry must never break gameplay */
  }
}

export const telemetry = {
  playStart: () => post({ event: 'play_start' }),
  levelAttempt: (level) => post({ event: 'level_attempt', level }),
  levelClear: (level) => post({ event: 'level_clear', level }),
  levelDeath: (level) => post({ event: 'level_death', level }),
  sessionEnd: ({ level, score, durationS }) =>
    post({ event: 'session_end', level, score, durationS, device: navigator.userAgent?.slice(0, 60) }),
};
