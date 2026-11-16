import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, MASCOTS, STAGES, WALL, loadSave, saveStats, skinUnlocked } from '../build/test/core.mjs';

function steer(match, legs) {
  for (const [direction, steps] of legs) {
    match.steer(direction);
    for (let i = 0; i < steps; i++) match.tick();
  }
}

function verifyOwnership(match) {
  for (const rider of match.riders) {
    assert.equal(rider.area, match.land.filter(owner => owner === rider.id).length);
    assert.equal(rider.path.length, match.trail.filter(owner => owner === rider.id).length);
    if (!rider.alive) assert.equal(rider.area + rider.path.length, 0);
    else assert.notEqual(match.land[match.at(rider.x, rider.y)], WALL);
  }
}

test('a returning ribbon fills the enclosed cells and leaves the outside neutral', () => {
  const game = new Match('campaign');
  steer(game, [[3, 6], [0, 9], [1, 6]]);
  assert.equal(game.player.area, 25);
  assert.ok(game.player.path.length > 0);
  steer(game, [[2, 7]]);
  assert.equal(game.player.path.length, 0);
  assert.equal(game.land[game.at(15, 17)], game.player.id);
  assert.equal(game.land[game.at(22, 15)], 0);
  assert.ok(game.player.area > 50);
  verifyOwnership(game);
});

test('a successful campaign route reaches the territory goal against live rivals', () => {
  const game = new Match('campaign');
  steer(game, [[3, 10], [0, 16], [1, 17], [2, 16], [3, 5]]);
  assert.equal(game.outcome, 'cleared');
  assert.ok(game.share() >= game.stage.goal);
  assert.ok(game.riders.slice(1).some(rider => rider.area > 25));
  verifyOwnership(game);
});

test('crossing your own ribbon or the edge ends the run and removes owned land', () => {
  const game = new Match('endless');
  steer(game, [[0, 8], [1, 6], [2, 3], [3, 6]]);
  assert.equal(game.outcome, 'lost');
  assert.match(game.reason, /own ribbon/);
  verifyOwnership(game);
  const edge = new Match('campaign');
  steer(edge, [[2, 10]]);
  assert.equal(edge.outcome, 'lost');
  assert.match(edge.reason, /edge/);
});

test('a rival ribbon is cut, its land is freed, and Endless respawns the rival', () => {
  const game = new Match('endless');
  const rival = game.riders[1];
  const tile = game.at(game.player.x + 1, game.player.y);
  rival.path.push(tile);
  game.trail[tile] = rival.id;
  game.tick();
  assert.equal(game.cuts, 1);
  assert.equal(rival.alive, false);
  assert.equal(rival.area, 0);
  let returned = false;
  for (let i = 0; i < 65 && !returned; i++) {
    steer(game, [[i % 4 < 2 ? 2 : 0, 1]]);
    returned ||= rival.alive;
  }
  assert.equal(returned, true);
  verifyOwnership(game);
});

test('late Endless arena awards the island only after the final free cell is captured', () => {
  const game = new Match('endless', 0, 0, 6);
  const empty = game.at(game.player.x + 1, game.player.y);
  for (const rival of game.riders.slice(1)) { rival.alive = false; rival.respawn = Infinity; rival.area = 0; }
  let area = 0;
  for (let i = 0; i < game.size; i++) if (game.land[i] !== WALL && i !== empty) { game.land[i] = 1; area++; }
  game.land[empty] = 0;
  game.player.area = area;
  game.tick();
  assert.equal(game.outcome, 'playing');
  game.tick();
  assert.equal(game.outcome, 'island');
  assert.equal(game.share(), 100);
  verifyOwnership(game);
});

test('all 15 arenas open with valid, nonoverlapping territories, and become harder', () => {
  assert.equal(STAGES.length, 15);
  for (const [i, stage] of STAGES.entries()) {
    const game = new Match('campaign', i);
    verifyOwnership(game);
    assert.equal(game.riders.length, stage.rivals + 1);
    assert.ok(game.riders.every(rider => rider.area === 25));
    if (i > 0) {
      assert.ok(stage.goal > STAGES[i - 1].goal);
      assert.ok(stage.pace > STAGES[i - 1].pace);
      assert.ok(stage.rivals >= STAGES[i - 1].rivals);
    }
  }
});

test('rivals claim land and keep ownership counts consistent across a range of matches', () => {
  for (const level of [0, 4, 7, 11, 14]) for (const seed of [19, 130]) {
    const game = new Match('campaign', level, 0, 0, seed);
    let rivalClaims = 0;
    for (let i = 0; i < 420 && game.outcome === 'playing'; i++) {
      game.steer(i % 4 < 2 ? 0 : 2);
      game.tick();
      rivalClaims += game.effects.splice(0).filter(e => e.type === 'claim' && e.skin !== 0).length;
      verifyOwnership(game);
    }
    assert.ok(rivalClaims > 0, `Stage ${level + 1}, seed ${seed}`);
  }
});

test('campaign progress, Endless records, and unlocked mascot preferences restore', () => {
  const progress = { unlocked: 4, cleared: 4, peak: 27, skin: 3, islands: 0, muted: true };
  let data;
  saveStats(progress, { setItem: (_key, value) => { data = value; } });
  assert.deepEqual(loadSave({ getItem: () => data }), progress);
  assert.ok(skinUnlocked(MASCOTS[progress.skin].unlock, progress));
  assert.ok(!skinUnlocked(MASCOTS.at(-1).unlock, progress));
  assert.equal(loadSave({ getItem: () => '{bad' }).cleared, 0);
});
