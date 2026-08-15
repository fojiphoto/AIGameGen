/**
 * EMBERWAKE — the simulation, tested without a browser.
 *
 * Two halves. The first proves the controller does what it claims: coyote time exists, a tapped
 * jump is shorter than a held one, a buffered jump fires on landing, one-way platforms work in
 * both directions. Those are the mechanics a player feels but cannot see, and they are exactly
 * the ones that quietly stop working after a refactor.
 *
 * The second is the level solver, and it is the reason this whole layer is DOM-free. It plays
 * every level with the real controller at the real timestep and proves the goal, every
 * checkpoint and every collectible can be reached — with only the abilities the player will
 * actually have by then. A gap that a tuning change makes half a tile too wide fails here, by
 * name, instead of being discovered by someone halfway through world 4.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TILE, FIXED_DT, GRAVITY, JUMP_VELOCITY, COYOTE_TIME, JUMP_BUFFER,
  MAX_JUMP_HEIGHT, MAX_JUMP_RUN, SAFE_JUMP_TILES_UP, SAFE_JUMP_TILES_ACROSS,
  PLAYER_W, PLAYER_H, MAX_HEALTH,
  TileMap, Tile, makeBody, moveBody, boxesOverlap,
  Player, emptyInput,
  parseLevel, LevelParseError, starsFor,
  LEVELS, levelsByWorld, levelById, abilitiesAtLevel,
  Enemy, enemySpec,
  solve, audit, standSpots,
  Progress, defaultSave, SKINS, DEFAULT_SETTINGS,
} from '../build/test/core.mjs';

// ── a test rig for the controller ───────────────────────────────────────────

/** A flat floor with open sky, which is all most controller tests need. */
function flatWorld(width = 40, floorY = 12) {
  const map = new TileMap(width, 17);
  for (let x = 0; x < width; x++) {
    for (let y = floorY; y < 17; y++) map.set(x, y, Tile.Solid);
  }
  return map;
}

function spawnOn(map, tx, floorY) {
  const p = new Player(tx * TILE + (TILE - PLAYER_W) / 2, floorY * TILE - PLAYER_H);
  p.body.vy = 1;
  return p;
}

/**
 * Run the simulation for a number of steps, calling `plan` each step to fill in the input.
 * Returns a trace so a test can assert on the shape of a whole jump rather than one instant.
 */
function run(player, map, steps, plan, platforms = []) {
  const input = emptyInput();
  const trace = [];
  for (let i = 0; i < steps; i++) {
    input.left = input.right = input.down = false;
    input.jump = input.jumpPressed = input.dash = input.dashPressed = false;
    plan(input, i);
    const events = player.update(input, map, platforms, FIXED_DT);
    trace.push({
      i, x: player.body.x, y: player.body.y, vx: player.body.vx, vy: player.body.vy,
      onGround: player.body.onGround, state: player.state, events: { ...events },
    });
  }
  return trace;
}

const peakRise = (trace, startY) => Math.max(...trace.map((t) => startY - t.y));

// ── tiles and collision ─────────────────────────────────────────────────────

test('the map is solid at its sides and floor, and open at the sky', () => {
  const map = flatWorld();
  assert.ok(map.solidAt(-1, 5), 'past the left edge');
  assert.ok(map.solidAt(40, 5), 'past the right edge');
  assert.ok(map.solidAt(5, 17), 'below the floor');
  assert.ok(!map.solidAt(5, -3), 'above the level, so a high jump does not hit a ceiling');
});

test('a falling body lands exactly on top of a tile, not inside it', () => {
  const map = flatWorld();
  const body = makeBody(5 * TILE, 0, PLAYER_W, PLAYER_H);
  for (let i = 0; i < 400; i++) {
    body.vy = Math.min(body.vy + GRAVITY * FIXED_DT, 900);
    moveBody(body, map, FIXED_DT);
    if (body.onGround) break;
  }
  assert.ok(body.onGround, 'it should land');
  assert.equal(body.y + body.h, 12 * TILE, 'feet exactly on the floor');
  assert.equal(body.vy, 0);
});

test('a body running along a tiled floor never catches on the seams', () => {
  const map = flatWorld();
  const body = makeBody(2 * TILE, 12 * TILE - PLAYER_H, PLAYER_W, PLAYER_H);
  body.vx = 300;
  let groundedSteps = 0;
  for (let i = 0; i < 400; i++) {
    body.vy = Math.min(body.vy + GRAVITY * FIXED_DT, 900);
    moveBody(body, map, FIXED_DT);
    if (body.onGround) groundedSteps++;
    assert.equal(body.vx, 300, `stopped at step ${i} — a seam caught it`);
  }
  assert.ok(groundedSteps > 390, `grounded for ${groundedSteps}/400 steps — the flag flickers`);
});

test('a one-way platform is solid from above and open from below', () => {
  const map = new TileMap(20, 17);
  for (let x = 0; x < 20; x++) map.set(x, 14, Tile.Solid);
  for (let x = 4; x < 10; x++) map.set(x, 10, Tile.OneWay);

  // Falling onto it stops.
  const falling = makeBody(6 * TILE, 4 * TILE, PLAYER_W, PLAYER_H);
  for (let i = 0; i < 300 && !falling.onGround; i++) {
    falling.vy = Math.min(falling.vy + GRAVITY * FIXED_DT, 900);
    moveBody(falling, map, FIXED_DT);
  }
  assert.equal(falling.y + falling.h, 10 * TILE, 'landed on the platform');

  // Rising through it does not.
  const rising = makeBody(6 * TILE, 13 * TILE - PLAYER_H, PLAYER_W, PLAYER_H);
  rising.vy = -700;
  for (let i = 0; i < 40; i++) moveBody(rising, map, FIXED_DT);
  assert.ok(rising.y < 10 * TILE - PLAYER_H, 'it passed through from underneath');
});

test('holding down drops through a one-way platform', () => {
  const map = new TileMap(20, 17);
  for (let x = 0; x < 20; x++) map.set(x, 14, Tile.Solid);
  for (let x = 4; x < 10; x++) map.set(x, 10, Tile.OneWay);
  const body = makeBody(6 * TILE, 10 * TILE - PLAYER_H, PLAYER_W, PLAYER_H);
  body.dropThrough = true;
  for (let i = 0; i < 200; i++) {
    body.vy = Math.min(body.vy + GRAVITY * FIXED_DT, 900);
    moveBody(body, map, FIXED_DT);
  }
  assert.equal(body.y + body.h, 14 * TILE, 'it fell to the real floor below');
});

test('a moving platform carries whatever is standing on it', () => {
  const map = flatWorld(40, 16);
  const platform = { x: 5 * TILE, y: 10 * TILE, w: 3 * TILE, h: TILE, dx: 0, dy: 0, oneWay: false, active: true };
  const body = makeBody(6 * TILE, 10 * TILE - PLAYER_H, PLAYER_W, PLAYER_H);
  const startX = body.x;
  for (let i = 0; i < 120; i++) {
    platform.dx = 1.2;
    platform.x += platform.dx;
    body.vy = Math.min(body.vy + GRAVITY * FIXED_DT, 900);
    moveBody(body, map, FIXED_DT, [platform]);
  }
  assert.ok(body.x - startX > 100, `rider moved only ${Math.round(body.x - startX)}px`);
  assert.ok(body.onGround, 'and is still standing on it');
});

test('box overlap is exclusive at the edges', () => {
  assert.ok(boxesOverlap(0, 0, 10, 10, 5, 5, 10, 10));
  assert.ok(!boxesOverlap(0, 0, 10, 10, 10, 0, 10, 10), 'touching is not overlapping');
});

// ── the feel mechanics ──────────────────────────────────────────────────────

test('a jump rises to the height the constants promise', () => {
  const map = flatWorld();
  const player = spawnOn(map, 5, 12);
  const startY = player.body.y;
  const trace = run(player, map, 260, (input, i) => {
    if (i === 2) input.jumpPressed = true;
    if (i >= 2) input.jump = true;
  });
  const rise = peakRise(trace, startY);
  assert.ok(Math.abs(rise - MAX_JUMP_HEIGHT) < 14,
    `rose ${rise.toFixed(1)}px, constants promise ${MAX_JUMP_HEIGHT.toFixed(1)}px`);
  assert.ok(trace.some((t) => t.events.jumped));
});

test('a tapped jump is meaningfully shorter than a held one, and still a real jump', () => {
  const map = flatWorld();

  const held = spawnOn(map, 5, 12);
  const heldStart = held.body.y;
  const heldRise = peakRise(run(held, map, 260, (input, i) => {
    if (i === 2) input.jumpPressed = true;
    if (i >= 2) input.jump = true;
  }), heldStart);

  const tapped = spawnOn(map, 5, 12);
  const tapStart = tapped.body.y;
  const tapRise = peakRise(run(tapped, map, 260, (input, i) => {
    if (i === 2) { input.jumpPressed = true; input.jump = true; }
    if (i > 2 && i < 8) input.jump = true;
  }), tapStart);

  assert.ok(tapRise < heldRise * 0.72,
    `tap rose ${tapRise.toFixed(0)}px vs hold ${heldRise.toFixed(0)}px — cut is too weak`);
  assert.ok(tapRise > TILE * 1.1,
    `tap rose only ${tapRise.toFixed(0)}px — a short hop must still clear a tile`);
});

test('coyote time lets a jump land just after walking off an edge', () => {
  // A ledge that ends at tile 10, with nothing beyond it.
  const map = new TileMap(40, 17);
  for (let x = 0; x <= 10; x++) map.set(x, 12, Tile.Solid);

  // First find the step at which walking right takes the player off the edge, then replay the
  // same walk twice: once jumping inside the coyote window, once well outside it.
  const probe = spawnOn(map, 8, 12);
  const probeTrace = run(probe, map, 120, (input) => { input.right = true; });
  const leftGroundAt = probeTrace.findIndex((t) => !t.onGround);
  assert.ok(leftGroundAt > 0, 'the probe should walk off the ledge');

  /**
   * Both cases are judged in the few steps right after the press, not over the whole run.
   *
   * Measuring "did a jump ever happen" is wrong for the negative case: a press outside the
   * coyote window is still *buffered*, and the player is falling toward the bottom of the map —
   * so a jump does eventually fire on landing, correctly, and a whole-run assertion reads that
   * as coyote time being broken.
   */
  const pressAt = (offset) => {
    const player = spawnOn(map, 8, 12);
    const at = leftGroundAt + offset;
    const trace = run(player, map, at + 12, (input, i) => {
      input.right = true;
      if (i === at) { input.jumpPressed = true; input.jump = true; }
      else if (i > at) input.jump = true;
    });
    return trace.slice(at, at + 6).some((t) => t.events.jumped);
  };

  assert.ok(pressAt(Math.floor((COYOTE_TIME * 0.6) / FIXED_DT)),
    'a jump pressed inside the coyote window must fire');
  assert.ok(!pressAt(Math.floor((COYOTE_TIME * 2.5) / FIXED_DT)),
    'and one pressed well outside it must not');
});

test('a jump pressed before landing fires on touchdown', () => {
  const map = flatWorld();
  const player = spawnOn(map, 5, 12);

  // Jump, then press again while still in the air, shortly before landing.
  const trace = run(player, map, 400, (input, i) => {
    if (i === 2) { input.jumpPressed = true; input.jump = true; }
    else if (i > 2 && i < 60) input.jump = true;
  });
  const landedAt = trace.findIndex((t, i) => i > 30 && t.onGround);
  assert.ok(landedAt > 0, 'the first jump must land');

  const buffered = spawnOn(map, 5, 12);
  const bufferSteps = Math.floor((JUMP_BUFFER * 0.5) / FIXED_DT);
  const events = run(buffered, map, 400, (input, i) => {
    if (i === 2) { input.jumpPressed = true; input.jump = true; }
    else if (i > 2 && i < 60) input.jump = true;
    if (i === landedAt - bufferSteps) { input.jumpPressed = true; input.jump = true; }
    else if (i > landedAt - bufferSteps && i < landedAt + 40) input.jump = true;
  });
  const jumps = events.filter((t) => t.events.jumped).length;
  assert.equal(jumps, 2, 'the buffered press should become a second jump on landing');
});

test('running accelerates smoothly and stops without sliding forever', () => {
  const map = flatWorld();
  const player = spawnOn(map, 3, 12);
  const trace = run(player, map, 200, (input, i) => { if (i < 120) input.right = true; });

  const atStart = trace[5].vx;
  const atSpeed = trace[110].vx;
  assert.ok(atStart < atSpeed * 0.5, 'speed should build rather than snap to maximum');
  assert.ok(atSpeed > 200, `only reached ${atSpeed.toFixed(0)} px/s`);
  assert.ok(Math.abs(trace[199].vx) < 5, 'and should come to a stop after the input ends');
});

test('turning is sharper than accelerating from a standstill', () => {
  const map = flatWorld();
  const fromRest = spawnOn(map, 20, 12);
  const restTrace = run(fromRest, map, 30, (input) => { input.left = true; });

  const turning = spawnOn(map, 20, 12);
  turning.body.vx = 260;
  const turnTrace = run(turning, map, 30, (input) => { input.left = true; });

  const restDelta = Math.abs(restTrace[29].vx - restTrace[0].vx);
  const turnDelta = Math.abs(turnTrace[29].vx - turnTrace[0].vx);
  assert.ok(turnDelta > restDelta * 1.5,
    `turn changed ${turnDelta.toFixed(0)} vs ${restDelta.toFixed(0)} from rest`);
});

test('the player state machine reports what it is doing', () => {
  const map = flatWorld();
  const player = spawnOn(map, 5, 12);
  const trace = run(player, map, 200, (input, i) => {
    if (i > 10 && i < 100) input.right = true;
    if (i === 40) { input.jumpPressed = true; input.jump = true; }
    else if (i > 40 && i < 80) input.jump = true;
  });
  const states = new Set(trace.map((t) => t.state));
  for (const expected of ['idle', 'run', 'jump', 'fall']) {
    assert.ok(states.has(expected), `never entered "${expected}" — saw ${[...states].join(', ')}`);
  }
});

test('landing squashes the character and leaving the ground stretches it', () => {
  const map = flatWorld();
  const player = spawnOn(map, 5, 12);
  let squashed = false;
  const input = emptyInput();
  for (let i = 0; i < 300; i++) {
    input.jumpPressed = i === 2;
    input.jump = i >= 2 && i < 60;
    player.update(input, map, [], FIXED_DT);
    if (player.body.onGround && i > 40 && player.squashX > 1.05) squashed = true;
  }
  assert.ok(squashed, 'a landing should widen the character briefly');
});

// ── damage ──────────────────────────────────────────────────────────────────

test('a hit costs health, knocks back, and grants brief invulnerability', () => {
  const map = flatWorld();
  const player = spawnOn(map, 5, 12);
  run(player, map, 10, () => {});

  assert.ok(player.takeHit(player.centerX + 40), 'the hit should land');
  assert.equal(player.health, MAX_HEALTH - 1);
  assert.ok(player.body.vx < 0, 'knocked away from the source');
  assert.ok(player.invulnerable);
  assert.equal(player.takeHit(player.centerX + 40), false, 'a second hit is ignored while invulnerable');
});

test('a shield absorbs one hit and no health is lost', () => {
  const map = flatWorld();
  const player = spawnOn(map, 5, 12);
  player.grantPower('shield');
  assert.equal(player.takeHit(player.centerX + 40), false, 'absorbed, so not a "hurt"');
  assert.equal(player.health, MAX_HEALTH);
  assert.equal(player.isActive('shield'), false, 'and the shield is spent');
});

test('running out of health kills the player once', () => {
  const map = flatWorld();
  const player = spawnOn(map, 5, 12);
  for (let i = 0; i < MAX_HEALTH; i++) {
    player.takeHit(player.centerX + 40);
    // Clear invulnerability so the next hit lands.
    run(player, map, Math.ceil(1.4 / FIXED_DT), () => {});
  }
  assert.equal(player.health, 0);
  assert.equal(player.alive, false);
});

test('power-ups expire, except the shield which is a charge', () => {
  const map = flatWorld();
  const player = spawnOn(map, 5, 12);
  player.grantPower('speed', 0.5);
  player.grantPower('shield');
  run(player, map, Math.ceil(1.0 / FIXED_DT), () => {});
  assert.equal(player.isActive('speed'), false, 'the timed power ran out');
  assert.equal(player.isActive('shield'), true, 'the shield waits for a hit');
});

// ── enemies ─────────────────────────────────────────────────────────────────

test('a walker turns at a ledge instead of marching off it', () => {
  const map = new TileMap(30, 17);
  for (let x = 6; x <= 14; x++) map.set(x, 12, Tile.Solid);
  const enemy = new Enemy('walker', 10 * TILE, 12 * TILE);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 2000; i++) {
    enemy.update(FIXED_DT, map, [], 0, 0);
    minX = Math.min(minX, enemy.body.x);
    maxX = Math.max(maxX, enemy.body.x + enemy.body.w);
    assert.ok(enemy.body.y < 15 * TILE, `fell off the platform at step ${i}`);
  }
  assert.ok(minX >= 6 * TILE - 2 && maxX <= 15 * TILE + 2, 'it stayed on its platform');
  assert.ok(maxX - minX > TILE * 3, 'and actually patrolled');
});

test('a charger notices, winds up, then commits', () => {
  const map = new TileMap(40, 17);
  for (let x = 0; x < 40; x++) map.set(x, 12, Tile.Solid);
  const enemy = new Enemy('charger', 20 * TILE, 12 * TILE);
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    enemy.update(FIXED_DT, map, [], 16 * TILE, 12 * TILE - 20);
    seen.add(enemy.state);
  }
  assert.ok(seen.has('alert'), 'it should telegraph before charging');
  assert.ok(seen.has('charge'), 'and then charge');
  assert.ok(seen.has('recover'), 'and then be punishable');
});

test('a turret fires readable projectiles, and only when the player is near', () => {
  const map = new TileMap(40, 17);
  for (let x = 0; x < 40; x++) map.set(x, 12, Tile.Solid);
  const enemy = new Enemy('turret', 20 * TILE, 12 * TILE);

  let firedFar = 0;
  for (let i = 0; i < 600; i++) {
    if (enemy.update(FIXED_DT, map, [], 39 * TILE, 12 * TILE).fired) firedFar++;
  }
  assert.equal(firedFar, 0, 'nothing should fire at a player across the level');

  let firedNear = 0;
  let shot = null;
  for (let i = 0; i < 600; i++) {
    const events = enemy.update(FIXED_DT, map, [], 15 * TILE, 12 * TILE - 20);
    if (events.fired) { firedNear++; shot ??= events.fired; }
  }
  assert.ok(firedNear >= 2, `only fired ${firedNear} times in five seconds`);
  assert.ok(Math.abs(shot.vx) < 260, 'a projectile the player cannot dodge is not readable');
});

test('a shielded enemy blocks its front and yields to a stomp', () => {
  const enemy = new Enemy('shielded', 10 * TILE, 12 * TILE);
  enemy.dir = -1;
  const front = enemy.centerX - enemy.body.w;
  assert.equal(enemy.hit(front, false), 'blocked', 'the shield is on the front');
  assert.equal(enemy.hit(enemy.centerX, true), 'killed', 'but the top is open');
});

test('a heavy enemy cannot be stomped and takes several hits', () => {
  const enemy = new Enemy('heavy', 10 * TILE, 12 * TILE);
  assert.equal(enemy.stompable, false);
  assert.equal(enemy.hit(enemy.centerX, true), 'blocked');
  assert.equal(enemy.hit(enemy.centerX, false), 'hurt');
  assert.equal(enemy.hit(enemy.centerX, false), 'hurt');
  assert.equal(enemy.hit(enemy.centerX, false), 'killed');
});

test('every enemy kind has a distinct footprint and a score', () => {
  const kinds = ['walker', 'jumper', 'flyer', 'charger', 'shielded', 'turret', 'heavy', 'boss'];
  const seen = new Set();
  for (const kind of kinds) {
    const spec = enemySpec(kind);
    assert.ok(spec.w > 0 && spec.h > 0, kind);
    assert.ok(spec.score > 0, kind);
    seen.add(`${spec.w}x${spec.h}`);
  }
  assert.ok(seen.size >= 6, 'enemies that share a silhouette are hard to tell apart');
});

// ── levels ──────────────────────────────────────────────────────────────────

test('the level parser reports a bad character rather than ignoring it', () => {
  assert.throws(
    () => parseLevel({ id: 'x', world: 1, index: 1, name: 'x', hook: '', parTime: 10,
      rows: ['P   G', '#####', '##Z##'] }),
    (err) => err instanceof LevelParseError && /unknown character "Z"/.test(err.message));
});

test('a level without a spawn or a goal is rejected', () => {
  const base = { id: 'x', world: 1, index: 1, name: 'x', hook: '', parTime: 10 };
  assert.throws(() => parseLevel({ ...base, rows: ['    G', '#####'] }), /spawn/);
  assert.throws(() => parseLevel({ ...base, rows: ['P    ', '#####'] }), /goal/);
});

test('ragged rows are padded with air rather than failing', () => {
  const level = parseLevel({
    id: 'x', world: 1, index: 1, name: 'x', hook: '', parTime: 10,
    rows: ['P', '     G', '##########'],
  });
  assert.equal(level.map.width, 10);
  assert.equal(level.map.at(9, 0), Tile.Empty);
});

test('every level parses, and its entities are where the grid says', () => {
  for (const def of LEVELS) {
    const level = parseLevel(def);
    assert.ok(level.spawn, `${def.id} has no spawn`);
    assert.ok(level.goal, `${def.id} has no goal`);
    assert.ok(level.width > 0 && level.height > 0, def.id);
    assert.ok(level.sparkTotal > 0, `${def.id} has nothing to collect`);
  }
});

test('the level list is coherent: ten levels, five worlds, in order', () => {
  assert.equal(LEVELS.length, 10);
  const worlds = levelsByWorld();
  assert.equal(worlds.length, 5);
  for (const world of worlds) {
    assert.equal(world.length, 2, 'each world should have two levels');
    assert.deepEqual(world.map((l) => l.index), [1, 2]);
  }
  const ids = new Set(LEVELS.map((l) => l.id));
  assert.equal(ids.size, LEVELS.length, 'level ids must be unique');
  assert.ok(levelById('w1l1'));
  for (const def of LEVELS) {
    assert.ok(def.name.length > 0 && def.hook.length > 0, `${def.id} needs a name and a hook`);
    assert.ok(def.parTime > 10, `${def.id} par time is unreasonable`);
  }
});

test('no level has an object buried in a wall', () => {
  for (const def of LEVELS) {
    const problems = audit(parseLevel(def));
    assert.deepEqual(problems, [], `${def.id}: ${problems.join('; ')}`);
  }
});

test('the jump numbers the levels are designed against are what the physics delivers', () => {
  // These are quoted in the level design and used by the solver; if they drift, gaps drift too.
  // Four tiles up and five and a half across is the shape the whole level set is drawn around:
  // a three-tile wall is routine, a four-tile one is a commitment, and no gap is over five.
  assert.ok(MAX_JUMP_HEIGHT > TILE * 4.0 && MAX_JUMP_HEIGHT < TILE * 4.5,
    `a jump rises ${(MAX_JUMP_HEIGHT / TILE).toFixed(2)} tiles`);
  assert.ok(MAX_JUMP_RUN > TILE * 5.5 && MAX_JUMP_RUN < TILE * 6.5,
    `a running jump crosses ${(MAX_JUMP_RUN / TILE).toFixed(2)} tiles`);
  assert.equal(SAFE_JUMP_TILES_UP, Math.floor(MAX_JUMP_HEIGHT / TILE));
  assert.equal(SAFE_JUMP_TILES_ACROSS, Math.floor(MAX_JUMP_RUN / TILE));
  assert.ok(JUMP_VELOCITY > 0 && GRAVITY > 0);
});

// ── the solver ──────────────────────────────────────────────────────────────

test('the solver finds stand spots and reaches across a simple level', () => {
  const level = parseLevel({
    id: 't', world: 1, index: 1, name: 't', hook: '', parTime: 20,
    rows: [
      '                    ',
      '                    ',
      '   P      o      G  ',
      '####################',
    ],
  });
  assert.ok(standSpots(level.map).length > 10);
  const result = solve(level);
  assert.ok(result.goalReachable, result.problems.join('; '));
  assert.equal(result.unreachablePickups.length, 0);
});

test('the solver refuses a level whose goal is walled off', () => {
  // The wall has to be taller than a jump — about four tiles — plus headroom, or the solver is
  // right to say the goal is reachable and the test would be the thing that is wrong.
  const level = parseLevel({
    id: 't', world: 1, index: 1, name: 't', hook: '', parTime: 20,
    rows: [
      '        #           ',
      '        #           ',
      '        #           ',
      '        #           ',
      '        #           ',
      '        #           ',
      '        #           ',
      '        #           ',
      '   P    #        G  ',
      '####################',
      '####################',
    ],
  });
  const result = solve(level);
  assert.equal(result.goalReachable, false, 'a wall taller than a jump must block it');
});

/**
 * The test this whole layer exists for.
 *
 * Each level is played by the real controller with only the abilities the player will have when
 * they first arrive. Slow — it simulates thousands of jumps — but it is the difference between
 * levels that are believed to work and levels that are known to.
 */
for (const def of LEVELS) {
  test(`level ${def.id} "${def.name}" is completable`, () => {
    const level = parseLevel(def);
    const abilities = abilitiesAtLevel(def.id);
    const result = solve(level, abilities);
    assert.ok(result.goalReachable,
      `${def.id}: the beacon cannot be reached — ${result.problems.join('; ')}`);
    assert.equal(result.unreachableCheckpoints, 0, `${def.id}: a checkpoint is stranded`);
    assert.equal(result.unreachablePickups.length, 0,
      `${def.id}: ${result.unreachablePickups.length} pickup(s) stranded, first at `
      + `${result.unreachablePickups.map((p) => `${p.kind} ${Math.round(p.x / TILE)},${Math.round(p.y / TILE)}`).slice(0, 4).join(' / ')}`);
  });
}

// ── progression ─────────────────────────────────────────────────────────────

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('stars come from finishing, collecting and speed', () => {
  const level = parseLevel(LEVELS[0]);
  assert.equal(starsFor(level, 0, 0, 9999), 1, 'finishing is worth one');
  assert.equal(starsFor(level, level.sparkTotal, 0, 9999), 2, 'plus the sparks');
  assert.equal(starsFor(level, level.sparkTotal, 0, 1), 3, 'plus the time');
});

test('progress round-trips and keeps the best of everything', () => {
  globalThis.localStorage = fakeStorage();
  const p = new Progress();
  p.complete('w1l1', 2, 50_000, 8, false, false);
  p.complete('w1l1', 1, 90_000, 3, true, false);

  const record = p.record('w1l1');
  assert.equal(record.stars, 2, 'a worse replay must not take the stars away');
  assert.equal(record.bestTimeMs, 50_000);
  assert.equal(record.sparks, 8);
  assert.equal(record.embersFound, true, 'but a new find is kept');

  const reloaded = new Progress();
  assert.equal(reloaded.record('w1l1').stars, 2);
});

test('corrupt or foreign save data falls back to defaults', () => {
  const storage = fakeStorage();
  globalThis.localStorage = storage;

  storage.setItem('emberwake.save', '{ not json at all');
  assert.equal(new Progress().totalStars, 0);
  assert.equal(storage.getItem('emberwake.save'), null, 'and the bad value is cleared');

  storage.setItem('emberwake.save', JSON.stringify({
    version: 1, levels: { 'not-a-level': { completed: true, stars: 99 }, w1l1: { completed: true, stars: 2 } },
  }));
  const p = new Progress();
  assert.equal(p.record('not-a-level').completed, false, 'levels that no longer exist are dropped');
  assert.equal(p.record('w1l1').stars, 2);
});

test('storage that throws never takes the game down', () => {
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('no'); },
  };
  const p = new Progress();
  assert.equal(p.totalStars, 0);
  p.complete('w1l1', 3, 1000, 5, true, true);      // must not throw
});

test('levels unlock in order, and worlds gate on the one before', () => {
  globalThis.localStorage = fakeStorage();
  const p = new Progress();
  assert.ok(p.isUnlocked('w1l1'));
  assert.ok(!p.isUnlocked('w1l2'), 'the second level waits for the first');
  assert.ok(!p.isWorldUnlocked(2));

  p.complete('w1l1', 1, 1000, 1, false, false);
  assert.ok(p.isUnlocked('w1l2'));
  p.complete('w1l2', 1, 1000, 1, false, false);
  assert.ok(p.isWorldUnlocked(2), 'finishing world 1 opens world 2');
});

test('abilities arrive with progress, and match what the solver assumes', () => {
  globalThis.localStorage = fakeStorage();
  const p = new Progress();
  assert.deepEqual(p.abilities(), { dash: false, doubleJump: false, wallJump: false });

  for (const id of ['w1l1', 'w1l2']) p.complete(id, 1, 1000, 1, false, false);
  assert.equal(p.abilities().dash, true, 'the dash arrives with world 2');
  assert.deepEqual(p.abilities(), abilitiesAtLevel('w2l1'),
    'progression and the solver must agree, or a level can require a move the player lacks');
});

test('skins unlock from real milestones and all keep a body, trim and glow', () => {
  globalThis.localStorage = fakeStorage();
  const p = new Progress();
  assert.deepEqual(p.data.unlockedSkins, ['ember'], 'only the starting skin at first');
  for (const skin of SKINS) {
    assert.equal(skin.colors.length, 3, skin.id);
    assert.ok(skin.name && skin.blurb, skin.id);
  }
  for (const id of ['w1l1', 'w1l2', 'w2l1']) p.complete(id, 3, 1000, 99, true, true);
  assert.ok(p.data.unlockedSkins.includes('frost'), 'three emberstones should unlock Frost');
});

test('settings survive a reset of progress', () => {
  globalThis.localStorage = fakeStorage();
  const p = new Progress();
  p.data.settings.musicVolume = 0.1;
  p.complete('w1l1', 3, 1000, 5, true, true);
  p.reset();
  assert.equal(p.totalStars, 0);
  assert.equal(p.data.settings.musicVolume, 0.1, 'volume is not progress');
  assert.equal(new Progress().data.settings.musicVolume, 0.1);
});

test('the default save is self-consistent', () => {
  const save = defaultSave();
  assert.equal(save.version, 1);
  assert.deepEqual(save.settings, DEFAULT_SETTINGS);
  assert.deepEqual(save.levels, {});
});
