import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cell, DIRECTIONS, distances, DOOR, FRUIT, Game, HEIGHT, HOME, LEVELS, loadSave, neighbor, START, storeSave, TUNNEL, walkable, WIDTH, xOf, yOf } from '../build/test/core.mjs';

const STEP = 1 / 120;
function run(game, seconds) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) game.update(STEP);
}
function quiet(game) { game.ghosts.forEach(ghost => { ghost.state = 'house'; ghost.release = Infinity; }); }
function place(actor, tile, dir = 1) { Object.assign(actor, { tile, dir, progress: 0, next: -1 }); }

test('40 authored layouts are distinct, connected, and preserve every power pellet and tunnel', () => {
  assert.equal(LEVELS.length, 40);
  assert.equal(new Set(LEVELS.map(level => level.tiles)).size, 40);
  for (const level of LEVELS) {
    assert.equal(level.tiles.length, WIDTH * HEIGHT);
    const reachable = distances(level.tiles, START);
    assert.equal(level.tiles.split('o').length - 1, 4);
    assert.equal(reachable[HOME], -1);
    assert.ok(distances(level.tiles, HOME, true)[DOOR] >= 0);
    assert.ok(reachable[FRUIT] >= 0);
    assert.equal(neighbor(level.tiles, cell(0, TUNNEL), 1), cell(WIDTH - 1, TUNNEL));
    for (let tile = 0; tile < level.tiles.length; tile++) {
      if (!walkable(level.tiles[tile])) continue;
      assert.ok(reachable[tile] >= 0, `board ${level.number} has an island at ${xOf(tile)},${yOf(tile)}`);
      assert.ok(DIRECTIONS.filter(dir => neighbor(level.tiles, tile, dir) >= 0).length >= 2, `board ${level.number} has a dead end at ${tile}`);
    }
  }
});

test('every board tightens the ghost speed ratio, power duration, and scatter window', () => {
  for (let i = 1; i < LEVELS.length; i++) {
    const a = LEVELS[i - 1], b = LEVELS[i];
    assert.ok(b.ghostSpeed / b.playerSpeed > a.ghostSpeed / a.playerSpeed);
    assert.ok(b.frightened < a.frightened);
    assert.ok(b.scatter < a.scatter && b.chase > a.chase);
    assert.ok(b.release.every((time, id) => time <= a.release[id]));
  }
});

test('board one retains the arcade 240 regular dots and four energizers', () => {
  const game = new Game();
  assert.equal(game.dots.size, 240);
  assert.equal(game.powers.size, 4);
});

test('a queued turn waits for a junction and the player can reverse during a segment', () => {
  const game = new Game(); quiet(game);
  run(game, 1.72);
  assert.ok(game.player.progress > 0);
  game.wanted = 3;
  run(game, .01);
  assert.equal(game.player.dir, 3);
  game.wanted = 0;
  run(game, .12);
  assert.equal(game.player.dir, 3);
  place(game.player, cell(7, 5));
  game.wanted = 1;
  run(game, .12);
  game.wanted = 0;
  run(game, .16);
  assert.equal(game.player.dir, 0);
});

test('lives and eaten dots survive a respawn, and the final collision ends the run', () => {
  const game = new Game(0, 0, 2);
  quiet(game); run(game, 2.2);
  const remaining = game.remaining;
  const ghost = game.ghosts[0];
  place(game.player, game.player.tile);
  place(ghost, game.player.tile); ghost.state = 'roam';
  game.update(STEP);
  assert.equal(game.phase, 'caught');
  assert.equal(game.lives, 1);
  run(game, 1.4);
  assert.equal(game.phase, 'ready');
  assert.equal(game.remaining, remaining);
  while (game.phase === 'ready') game.update(STEP);
  place(game.ghosts[0], game.player.tile);
  game.update(STEP);
  run(game, 1.4);
  assert.equal(game.phase, 'over');
});

test('power pellets reverse ghosts, award combo points, and eaten eyes return through the gate', () => {
  const game = new Game(0, 9_760);
  quiet(game); run(game, 1.66);
  place(game.player, cell(1, 4), 0); game.wanted = 0;
  run(game, .15);
  assert.ok(game.power > 0);
  assert.equal(game.score, 9_810);
  for (const ghost of game.ghosts.slice(0, 2)) {
    place(ghost, game.player.tile, 0); ghost.state = 'roam';
    game.update(STEP);
    assert.equal(ghost.state, 'eyes');
  }
  assert.equal(game.score, 10_410);
  assert.equal(game.lives, 4);
  place(game.ghosts[0], DOOR, 2);
  run(game, 1);
  assert.equal(game.ghosts[0].state, 'roam');
});

test('fruit appears twice at the correct dot milestones and can be collected', () => {
  const game = new Game(); quiet(game);
  run(game, 1.66);
  for (const threshold of [.29, .70]) {
    while (game.initialDots - game.remaining < Math.round(game.initialDots * threshold)) game.dots.delete(game.dots.values().next().value);
    place(game.player, cell(12, 17), 3); game.wanted = 3;
    const score = game.score;
    run(game, .14);
    assert.equal(game.score - score, 100);
    assert.equal(game.fruit, 0);
  }
  assert.equal(game.fruitWave, 2);
});

test('four distinct chase targets, scatter switching, and house release', () => {
  const game = new Game(); run(game, 12);
  assert.equal(game.phase, 'play');
  assert.equal(game.mode, 'chase');
  assert.ok(game.ghosts.every(ghost => ghost.state === 'roam'));
  place(game.player, cell(14, 23), 3);
  place(game.ghosts[0], cell(8, 23));
  place(game.ghosts[3], cell(12, 23));
  assert.deepEqual(game.ghosts.map(ghost => game.target(ghost)), [[14, 23], [18, 23], [24, 23], [0, 32]]);
});

test('tile movement collects every pellet through all 40 boards and triggers victory with ghosts held in the house', () => {
  const game = new Game();
  for (const level of LEVELS) {
    assert.equal(game.level, level);
    quiet(game);
    while (game.phase === 'ready') game.update(STEP);
    let moves = 0;
    while (game.phase === 'play' && moves++ < 2000) {
      const tile = game.player.tile;
      const seen = new Map([[tile, null]]);
      const queue = [tile];
      for (let i = 0; i < queue.length; i++) {
        const at = queue[i];
        if (game.dots.has(at) || game.powers.has(at)) { game.wanted = seen.get(at); break; }
        for (const dir of DIRECTIONS) {
          const next = neighbor(level.tiles, at, dir);
          if (next < 0 || seen.has(next)) continue;
          seen.set(next, seen.get(at) ?? dir);
          queue.push(next);
        }
      }
      for (let i = 0; i < 40 && game.player.tile === tile && game.phase === 'play'; i++) {
        const speed = level.playerSpeed + (game.power > STEP ? .25 : 0);
        game.update(Math.min(STEP, (1 - game.player.progress) / speed));
      }
    }
    assert.equal(game.phase, 'clear', `board ${level.number}`);
    run(game, 1.46);
  }
  assert.equal(game.phase, 'win');
});

test('save restores a valid checkpoint and tolerates corrupt data or disabled storage', () => {
  const good = { best: 1500, cleared: 3, muted: true, checkpoint: { index: 3, score: 1200, lives: 2 } };
  let data;
  storeSave(good, { setItem: (_, value) => { data = value; } });
  assert.deepEqual(loadSave({ getItem: () => data }), good);
  assert.equal(loadSave({ getItem: () => '{bad' }).checkpoint, null);
  assert.equal(loadSave({ getItem: () => JSON.stringify({ ...good, checkpoint: { index: 49, score: 1200, lives: 2 } }) }).checkpoint, null);
  assert.doesNotThrow(() => storeSave(good, { setItem: () => { throw Error(); } }));
});
