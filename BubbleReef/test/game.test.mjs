import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLS, Game, LEVELS, connected, coords, neighbors, slot } from '../build/test/core.mjs';
import { solve } from './campaign.mjs';

test('100 unique layouts are anchored, with increasing depth, color count and ceiling pressure across chapters', () => {
  assert.equal(LEVELS.length, 100);
  assert.equal(new Set(LEVELS.map(level => level.board.join(''))).size, 100);
  for (const [i, level] of LEVELS.entries()) {
    assert.equal(level.number, i + 1);
    const supported = connected(level.board);
    assert.ok(level.board.every((color, cell) => !color || supported[cell]));
    assert.ok(level.board.every((color, cell) => !color || Math.floor(cell / COLS) % 2 === 0 || cell % COLS !== COLS - 1));
    if (i > 0 && level.chapter !== LEVELS[i - 1].chapter) {
      const previous = LEVELS[i - 10];
      assert.ok(level.colors >= previous.colors && level.depth >= previous.depth && level.tension <= previous.tension);
    }
  }
});

test('a reflected shot attaches to an empty neighboring cell', () => {
  const game = new Game(0);
  const path = game.trace(1.12);
  assert.ok(path.bounces > 0);
  assert.equal(path.points[1].x, 357);
  assert.equal(game.board[path.slot], 0);
  assert.ok(neighbors[path.slot].some(cell => game.board[cell] > 0));
  game.resolve(path);
  assert.equal(game.shots, 1);
});

test('matching three removes the cluster, drops unsupported colors and awards a win', () => {
  const game = new Game(0);
  game.board.fill(0);
  game.board[slot(0, 5)] = 1;
  game.board[slot(1, 4)] = 1;
  game.board[slot(2, 4)] = 2;
  game.left = 3;
  game.current = 1;
  const result = game.resolve({ points: [], slot: slot(1, 5), bounces: 0 });
  assert.equal(result.removed.filter(bubble => bubble.falling).length, 1);
  assert.equal(result.removed.filter(bubble => !bubble.falling).length, 3);
  assert.equal(game.status, 'won');
  assert.equal(game.left, 0);
  assert.equal(game.stars, 3);
});

test('a failed match at the pressure threshold lowers the board and can trigger overflow', () => {
  const game = new Game(99);
  game.board.fill(0);
  game.board[slot(0, 5)] = 1;
  game.board[slot(15, 5)] = 2;
  game.left = 2;
  game.current = 3;
  game.pressure = game.level.tension - 1;
  const result = game.resolve({ points: [], slot: slot(16, 5), bounces: 0 });
  assert.ok(result.newDrop > result.oldDrop);
  assert.ok(coords(result.hit, result.newDrop).y > coords(result.hit, result.oldDrop).y);
  assert.equal(game.chances, game.level.tension);
  assert.equal(game.status, 'lost');
});

test('swap preserves the queue and the shooter replaces colors removed from play', () => {
  const game = new Game(0);
  const [current, next] = [game.current, game.next];
  game.swap();
  assert.deepEqual([game.current, game.next], [next, current]);
  game.board.fill(0);
  game.board[slot(0, 4)] = game.board[slot(0, 5)] = 1;
  game.board[slot(0, 8)] = 2;
  game.left = 3;
  game.current = game.next = 1;
  game.resolve({ points: [], slot: slot(1, 4), bounces: 0 });
  assert.equal(game.left, 1);
  assert.deepEqual([game.current, game.next], [2, 2]);
});

test('every level can be cleared with real aim angles, visible colors and swaps', () => {
  for (const level of LEVELS) {
    const win = solve(level.number - 1);
    assert.equal(win?.status, 'won', `Level ${level.number}`);
    assert.equal(win.left, 0, `Level ${level.number}`);
  }
});
