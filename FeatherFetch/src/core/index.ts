/**
 * The simulation, complete and browser-free.
 *
 * Nothing here touches a canvas, the DOM or a timer. That is what lets the fairness suite fly
 * every duck type against every flight pattern at every difficulty in Node and prove each one is
 * actually hittable — the single most valuable test this game has.
 */

export * from './config.js';
export * from './ducks.js';
export * from './rounds.js';
export * from './scoring.js';
export * from './save.js';
export * from './hit.js';
