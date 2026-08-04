/**
 * Engine entry point.
 *
 * The game config arrives as `window.__GAME__`, INLINED into index.html by the bundler.
 * It is deliberately not fetched: `file://` XHR/fetch is blocked in Android WebView, so an
 * inlined payload is what makes the same bundle work unchanged in the browser and inside
 * the offline APK.
 *
 * All genre scenes ship in one bundle. Phaser is ~1.2 MB and the scenes are a few KB each,
 * so shipping them together keeps `game.js` byte-identical across every generated game —
 * which means one immutable, infinitely cacheable file on the CDN instead of one per genre.
 */

import Phaser from 'phaser';
import Boot from './scenes/Boot.mjs';
import Menu from './scenes/Menu.mjs';
import Result from './scenes/Result.mjs';
import { engineGenre } from './genres/index.mjs';
import { VIEW_W, VIEW_H } from './constants.mjs';

function fail(message) {
  const el = document.getElementById('game') || document.body;
  el.innerHTML =
    `<div style="font:14px system-ui;color:#eaf5ee;background:#06281c;padding:24px;height:100%">` +
    `<b>Game failed to start</b><br><br>${message}</div>`;
}

const cfg = window.__GAME__;
const genre = cfg ? engineGenre(cfg.genre) : null;

if (!cfg) {
  fail('No game payload found (window.__GAME__).');
} else if (!genre) {
  fail(`This build has no engine for the genre "${cfg.genre}".`);
} else {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: VIEW_W,
    height: VIEW_H,
    backgroundColor: cfg.theme.palette.bg,
    // FIT letterboxes to any aspect ratio — one build covers phone portrait,
    // phone landscape, tablet and desktop without layout branches.
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      pixelArt: false,
      antialias: true,
      powerPreference: 'high-performance',
    },
    audio: { disableWebAudio: false, noAudio: true }, // SFX use our own AudioContext
    scene: [Boot, Menu, genre.Scene, Result],
    banner: false,
  });

  game.registry.set('cfg', cfg);

  // Pause when the app is backgrounded so a phone doesn't burn battery.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) game.loop.sleep();
    else game.loop.wake();
  });

  window.__FORGE_GAME__ = game; // handy for debugging / automated smoke tests
}
