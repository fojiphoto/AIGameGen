/**
 * Hit detection.
 *
 * One function, and it is the most important one in the game. Everything the player believes
 * about whether the game is fair comes from here, so it is deliberately simple, deliberately
 * generous, and property-tested: a shot at a duck's centre must *always* hit, and a shot outside
 * the padded radius must *never* hit, for every duck size and every pad.
 *
 * Two rules beyond the geometry:
 *
 *  1. When several ducks overlap the shot, the nearest to the crosshair is the one that takes
 *     it. Not the first in the array — that makes the outcome depend on spawn order, which is
 *     invisible to the player and reads as the game picking at random.
 *  2. A duck already falling cannot be hit again. Shooting a duck that is on its way down wastes
 *     a shell for nothing, and nobody ever means to do it.
 */

import { DuckState, duckHitRadius } from './ducks.js';

export interface ShotResult {
  /** Index into the array passed in, or -1 for a miss. */
  index: number;
  /** Distance from the crosshair to the duck's centre, for the "great shot" bonus. */
  distance: number;
}

export const MISS: ShotResult = { index: -1, distance: Infinity };

/**
 * Which duck, if any, a shot at (x, y) hits.
 *
 * @param pad extra radius in pixels — larger on touch, where a finger hides the target.
 */
export function resolveShot(
  ducks: DuckState[], x: number, y: number, pad: number
): ShotResult {
  let best = -1;
  let bestDist = Infinity;

  for (let i = 0; i < ducks.length; i++) {
    const duck = ducks[i];
    if (duck.phase !== 'flying') continue;      // falling, hit, gone or escaped: not a target

    const dx = x - duck.x;
    const dy = y - duck.y;
    const dist = Math.hypot(dx, dy);
    if (dist > duckHitRadius(duck, pad)) continue;

    if (dist < bestDist) { bestDist = dist; best = i; }
  }

  return best === -1 ? MISS : { index: best, distance: bestDist };
}

/**
 * How central the shot was, 0..1.
 *
 * Used only for feedback — a dead-centre hit gets a brighter flash and a "PERFECT SHOT" label.
 * It deliberately does not affect the score: rewarding sub-pixel accuracy on a moving target
 * punishes exactly the players who most need encouragement.
 */
export function shotQuality(duck: DuckState, distance: number, pad: number): number {
  const radius = duckHitRadius(duck, pad);
  return radius <= 0 ? 0 : Math.max(0, 1 - distance / radius);
}
