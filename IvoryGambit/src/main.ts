/**
 * Entry point.
 *
 * Three jobs, in this order: find the mount point, start the app, and take down the boot screen.
 *
 * The boot screen comes down only once the first real frame is on the page, not when the script
 * finishes parsing. Removing it a moment early shows a flash of empty background between the
 * loader and the menu, which reads as a stutter on exactly the first impression the game gets to
 * make.
 *
 * If anything here throws, the failure is put on screen rather than left as a blank page with a
 * console message nobody will open. A game that says what went wrong can be reported; a black
 * rectangle cannot.
 */

import { App } from './ui/app.js';
import { afterPaint } from './ui/dom.js';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('the page is missing its #app element');

  /**
   * The worker URL, resolved against this script rather than against the page.
   *
   * The game is published under a directory on a project site and is also meant to be embedded
   * in an iframe from a host portal, so neither a root-absolute path nor a page-relative one is
   * safe. `import.meta.url` is not available in the IIFE bundle format this ships as, so the
   * script's own `src` is used — it is the one thing that is always correct wherever the folder
   * is dropped.
   */
  const script = document.querySelector<HTMLScriptElement>('script[src$="app.js"]');
  const workerUrl = new URL('engine.js', script?.src ?? location.href).toString();

  const app = new App(root, workerUrl);
  app.start();

  afterPaint(() => {
    const bootScreen = document.getElementById('boot');
    if (!bootScreen) return;
    bootScreen.classList.add('gone');
    // Removed rather than left hidden: it sits above everything at z-index 100, and a hidden
    // overlay that still exists is exactly how a page ends up ignoring every click.
    window.setTimeout(() => bootScreen.remove(), 500);
  });
}

try {
  boot();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('IVORY GAMBIT failed to start:', error);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = `
      <div class="boot-inner">
        <h1 class="boot-title">IVORY GAMBIT</h1>
        <p class="boot-sub" style="color:#e0a44a;max-width:32ch;margin:14px auto 0;letter-spacing:.04em">
          Could not start: ${message.replace(/[<&]/g, '')}
        </p>
      </div>`;
  }
}
