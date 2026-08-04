import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jumpPeakHeight,
  airTime,
  timeAboveHeight,
  canClear,
  canPassUnder,
  canLeapGap,
  pairIsFair,
  minSafeSpacing,
  impulseOf,
} from '../src/physics.mjs';
import { planDeterministic } from '../../ai/src/planner.mjs';

const { config } = planDeterministic('neon runner');
const u = impulseOf(config);
const g = config.player.gravity;

test('jump peak matches the closed form u²/2g', () => {
  assert.ok(Math.abs(jumpPeakHeight(600, 1800) - 100) < 0.001);
});

test('air time matches 2u/g', () => {
  assert.ok(Math.abs(airTime(600, 1800) - 0.6667) < 0.001);
});

test('timeAboveHeight is zero when the jump cannot reach that height', () => {
  assert.equal(timeAboveHeight(600, 1800, 500), 0);
});

test('timeAboveHeight shrinks as the target height rises', () => {
  const low = timeAboveHeight(u, g, 20);
  const high = timeAboveHeight(u, g, 90);
  assert.ok(low > high && high > 0);
});

test('an impossibly tall obstacle is rejected', () => {
  const res = canClear(config, { kind: 'tall_block', width: 30, height: 400, yOffset: 0, motionAmp: 0 }, 400);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'jump_too_low');
});

test('an extremely wide obstacle is rejected at low speed', () => {
  const res = canClear(config, { kind: 'tall_block', width: 90, height: 60, yOffset: 0, motionAmp: 0 }, 145);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'too_wide_for_airtime');
});

test('a moving obstacle is judged at the TOP of its travel', () => {
  const base = { kind: 'moving_saw', width: 30, height: 30, yOffset: 30 };
  const still = canClear(config, { ...base, motionAmp: 0 }, 400);
  const moving = canClear(config, { ...base, motionAmp: 60 }, 400);
  assert.equal(still.ok, true, 'stationary saw at yOffset 30 should be clearable');
  assert.equal(moving.ok, false, 'the same saw rising 60px must NOT be considered clearable');
  assert.equal(moving.reason, 'jump_too_low');
});

test('a low bar below player height is unpassable', () => {
  const tooLow = canPassUnder(config, { yOffset: 20, height: 20 });
  const fine = canPassUnder(config, { yOffset: 70, height: 20 });
  assert.equal(tooLow.ok, false);
  assert.equal(fine.ok, true);
});

test('gaps get easier at higher speed, not harder', () => {
  const ob = { width: 60 };
  const slow = canLeapGap(config, ob, 200);
  const fast = canLeapGap(config, ob, 800);
  assert.ok(fast.range > slow.range);
  assert.equal(fast.ok, true);
});

test('the dead zone between "one jump" and "land and re-jump" is detected', () => {
  const a = { id: 'a', kind: 'ground_spike', width: 28, height: 34, yOffset: 0 };
  const b = { id: 'b', kind: 'ground_spike', width: 28, height: 34, yOffset: 0 };
  const speed = 500;
  const safe = minSafeSpacing(config, speed);

  // comfortably far apart → fair
  assert.equal(pairIsFair(config, a, b, safe * 1.2, speed).ok, true);

  // find a spacing inside the dead zone and confirm it is rejected
  let foundDeadZone = false;
  for (let s = 20; s < safe; s += 10) {
    const r = pairIsFair(config, a, b, s, speed);
    if (!r.ok) {
      foundDeadZone = true;
      assert.equal(r.mode, 'dead_zone');
      break;
    }
  }
  assert.ok(foundDeadZone, 'a dead zone must exist and be reported');
});

test('double jump increases effective reach', () => {
  const single = planDeterministic('normal runner').config;
  single.player.doubleJump = false;
  const dbl = structuredClone(single);
  dbl.player.doubleJump = true;

  const tall = { kind: 'tall_block', width: 30, height: 150, yOffset: 0, motionAmp: 0 };
  assert.equal(canClear(single, tall, 400).ok, false);
  assert.equal(canClear(dbl, tall, 400).ok, true);
});
