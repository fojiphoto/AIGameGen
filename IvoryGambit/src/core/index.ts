/**
 * The rules layer, complete and browser-free.
 *
 * Nothing under `core/` touches the DOM, a canvas, `window` or a timer. That is what lets the
 * whole of it run under `node --test` — and perft, the one test that can genuinely prove a move
 * generator correct, is only practical because of it.
 */

export * from './position.js';
export * from './movegen.js';
export * from './fen.js';
export * from './notation.js';
export * from './status.js';
