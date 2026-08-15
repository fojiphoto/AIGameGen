/**
 * Entry point.
 *
 * Finds the mount, starts the app, takes down the loading screen — and puts any failure on
 * screen rather than leaving a black rectangle and a console message nobody will open.
 *
 * The loading screen comes down after a paint, with a timer fallback: a hidden tab delivers no
 * animation frames at all, so a page opened in the background would otherwise sit on its splash
 * forever with an overlay swallowing every click. That is a lesson from the last game in this
 * repository, and it is cheaper to apply than to rediscover.
 */

import { App } from './shell/app.js';

function afterPaint(fn: () => void): void {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 80);
}

function boot(): void {
  const root = document.getElementById('game');
  if (!root) throw new Error('the page is missing its #game element');

  const app = new App(root);
  app.start();

  if (location.search.includes('debug')) {
    (window as unknown as { __EMBERWAKE__: App }).__EMBERWAKE__ = app;
  }

  afterPaint(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('gone');
    // Removed rather than hidden: an overlay that still exists at z-index 100 is exactly how a
    // page ends up ignoring every click.
    setTimeout(() => boot.remove(), 480);
  });
}

try {
  boot();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('EMBERWAKE failed to start:', error);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = `<div class="boot-inner"><h1>EMBERWAKE</h1>`
      + `<p class="boot-err">Could not start: ${message.replace(/[<&]/g, '')}</p></div>`;
  }
}
