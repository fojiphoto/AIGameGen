/**
 * The parts of the interface that hold decisions rather than pixels.
 *
 * Everything re-exported here runs in Node: layout maths, the clock, the match state machine,
 * the save layer, the puzzle set and the theme table. None of it touches the DOM at module
 * scope, which is precisely what makes it testable — `board.ts` and `app.ts` are deliberately
 * absent, because they build a canvas and a document tree the moment they are loaded.
 */

export * from './layout.js';
export * from './clock.js';
export * from './match.js';
export * from './save.js';
export * from './puzzles.js';
export * from './theme.js';
export { PIECE_SETS, IVORY_SET } from './pieces.js';
