/**
 * The simulation, complete and browser-free.
 *
 * Nothing under `core/` touches a canvas, the DOM or a timer. That is what lets the level solver
 * run the *real* controller in Node and prove every level completable — the single most valuable
 * test this game has, and one that would be impossible if the physics needed a browser.
 */

export * from './constants.js';
export * from './world.js';
export * from './player.js';
export * from './level.js';
export * from './levels.js';
export * from './enemies.js';
export * from './solver.js';
export * from './progress.js';
