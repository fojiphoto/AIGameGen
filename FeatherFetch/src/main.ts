/**
 * Entry point.
 *
 * The loading screen comes down after a paint, with a timer fallback: a hidden tab delivers no
 * animation frames, so a page opened in the background would otherwise sit on its splash forever
 * with an overlay swallowing every click. That is a lesson already paid for twice in this
 * repository and it is cheaper to apply than to rediscover.
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
    (window as unknown as { __FETCH__: App }).__FETCH__ = app;
  }

  afterPaint(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('gone');
    setTimeout(() => boot.remove(), 460);
  });
}

try {
  boot();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('FEATHER & FETCH failed to start:', error);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = '<div class="boot-inner"><h1>FEATHER &amp; FETCH</h1>'
      + `<p class="boot-err">Could not start: ${message.replace(/[<&]/g, '')}</p></div>`;
  }
}
