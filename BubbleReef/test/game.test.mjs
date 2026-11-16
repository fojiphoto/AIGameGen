import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLS, Game, LEVELS, LIMIT, RADIUS, WIDE, connected, coords, neighbors, rowsize, slot } from '../build/test/core.mjs';
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
  game.swap(1);
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

test('all 100 wide variants can be cleared against their actual side walls', () => {
  for (const level of LEVELS) {
    const win = solve(level.number - 1, 6, WIDE);
    assert.equal(win?.status, 'won', `Wide level ${level.number}`);
    assert.equal(win.left, 0, `Wide level ${level.number}`);
  }
});

test('a wide Endless row preserves column alignment and moves the wall used for bank shots', () => {
  const game = new Game(0, 'endless', 17, WIDE);
  const path = game.trace(1.12);
  assert.ok(path.bounces > 0);
  assert.equal(path.points[1].x, WIDE.width - 17);
  const edge = WIDE.slot(0, WIDE.columns - 1);
  const original = game.board[edge];
  const initial = game.left;
  assert.ok(original > 0);
  assert.ok(game.advance(game.untilRow));
  assert.equal(game.board[edge], 0);
  assert.equal(game.board[edge + WIDE.columns], original);
  assert.equal(game.left, initial + WIDE.columns - 1);
  assert.equal(game.left, game.board.filter(Boolean).length);
});

test('the three-slot triangle can load either reserve or cycle through all colors', () => {
  const game = new Game(0);
  const original = [game.current, game.next, game.reserve];
  assert.equal(new Set(original).size, 3);
  game.swap(2);
  assert.deepEqual([game.current, game.next, game.reserve], [original[2], original[1], original[0]]);
  game.swap(2);
  game.swap();
  assert.deepEqual([game.current, game.next, game.reserve], [original[1], original[2], original[0]]);
  game.swap(); game.swap();
  assert.deepEqual([game.current, game.next, game.reserve], original);
});

test('Endless inserts a staggered row on time and waits for a shot already in flight', () => {
  const game = new Game(0, 'endless');
  const top = [...game.board.slice(0, COLS)];
  assert.equal(game.advance(7.99), false);
  assert.equal(game.advance(.02, false), false);
  assert.equal(game.advance(0), true);
  assert.equal(game.waves, 1);
  assert.equal(game.stagger, 1);
  assert.ok(game.rowInterval < 8);
  assert.deepEqual([...game.board.slice(COLS, 2 * COLS)], top);
  assert.equal(coords(4).x, coords(COLS + 4, 0, game.stagger).x);
  assert.equal(game.board.slice(0, COLS).filter(Boolean).length, rowsize(0, 1));
  assert.equal(game.left, game.board.filter(Boolean).length);
  const hit = game.trace(0).slot;
  assert.ok(hit >= 0 && hit % COLS < rowsize(Math.floor(hit / COLS), game.stagger));
});

test('Endless keeps running after a clean board and ends when an incoming row pushes a bubble to the line', () => {
  const game = new Game(0, 'endless');
  game.board.fill(0);
  game.board[4] = game.board[5] = game.current = 1;
  game.left = 2;
  game.resolve({ points: [], slot: slot(1, 4), bounces: 0 });
  assert.equal(game.status, 'playing');
  assert.equal(game.left, 0);
  let previousBottom = 0;
  for (let i = 0; i < 30 && game.status === 'playing'; i++) {
    previousBottom = coords(slot(game.deepest, 0)).y + RADIUS;
    assert.equal(game.advance(game.untilRow), true);
  }
  assert.equal(game.status, 'lost');
  assert.ok(previousBottom < LIMIT);
  assert.ok(coords(slot(game.deepest, 0)).y + RADIUS >= LIMIT);
  assert.equal(game.advance(10), false);
});
