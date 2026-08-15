/**
 * The engine, minus its worker shell.
 *
 * Kept importable on its own so the test suite can search real positions in Node — an engine
 * that can only be exercised through `postMessage` cannot be tested at all.
 */

export * from './eval.js';
export * from './search.js';
export * from './book.js';
