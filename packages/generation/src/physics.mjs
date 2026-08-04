/**
 * Closed-form jump physics, shared by the level builder and the validator.
 *
 * Coordinate convention here: UP is positive, `u` is the jump impulse MAGNITUDE
 * (i.e. u = -config.player.jumpVelocity), `g` is positive downward accel.
 *
 *   y(t) = u·t − ½·g·t²
 *
 * DOUBLE JUMP is modelled as an effective impulse rather than a fudge factor.
 * A second impulse fired at apex (where velocity is 0) adds another full u, so
 * the reachable height doubles:
 *
 *   peak₂ = 2·(u²/2g) = (u√2)² / 2g      ⟹   u_eff = u·√2
 *
 * Substituting u_eff into the single-jump formulas is exact for peak height and
 * conservative for air time (it under-reports by ~17%), which is the direction we
 * want a safety check to err in.
 *
 * The engine runtime uses screen coordinates (down-positive) and converts at the
 * boundary. Keeping the maths in one place is what lets the validator prove
 * things about the game the player actually plays.
 */

/** Logical game viewport the engine renders into (letterboxed to fit any device). */
export const VIEW_WIDTH = 900;
export const VIEW_HEIGHT = 506; // ~16:9

/** Player's fixed horizontal position on screen. */
export const PLAYER_X = 150;

/** Minimum time an obstacle must be visible before it reaches the player. */
export const REACTION_MIN_SECONDS = 0.32;

/** Safety margin (px) required when clearing an obstacle's top edge. */
export const VERTICAL_MARGIN = 12;

/** Safety margin (px) added to widths when checking horizontal clearance. */
export const HORIZONTAL_MARGIN = 10;

/** Raw single-jump impulse magnitude. */
export const impulseOf = (config) => Math.abs(config.player.jumpVelocity);

/** Impulse to use in every reachability calculation, double jump included. */
export function effectiveImpulse(config) {
  return impulseOf(config) * (config.player.doubleJump ? Math.SQRT2 : 1);
}

/** Player's collision height in px. */
export const playerHeight = (config) => config.player.size * config.player.hitboxScale;

// ── primitive closed forms ──────────────────────────────────────────────────

/** Apex height above ground, px. */
export function jumpPeakHeight(u, g) {
  return (u * u) / (2 * g);
}

/** Total time from takeoff back to ground, seconds. */
export function airTime(u, g) {
  return (2 * u) / g;
}

/**
 * Seconds spent strictly above height `h`.
 * Returns 0 when the jump cannot reach `h` at all.
 */
export function timeAboveHeight(u, g, h) {
  const disc = u * u - 2 * g * h;
  if (disc <= 0) return 0;
  return (2 * Math.sqrt(disc)) / g;
}

/** Horizontal px covered while above height `h`, at scroll speed `speed`. */
export function distanceAboveHeight(u, g, h, speed) {
  return timeAboveHeight(u, g, h) * speed;
}

/** Horizontal px covered across a whole jump — the max gap that can be leapt. */
export function jumpRange(u, g, speed) {
  return airTime(u, g) * speed;
}

// ── config-aware helpers (these are what callers should use) ────────────────

/** Maximum reachable height for this config, double jump accounted for. */
export function effectivePeak(config) {
  return jumpPeakHeight(effectiveImpulse(config), config.player.gravity);
}

/** Total airborne seconds for this config. */
export function effectiveAirTime(config) {
  const u = impulseOf(config);
  const g = config.player.gravity;
  // exact for the two-impulse case: rise + rise + fall from double height
  return config.player.doubleJump ? (u * (2 + Math.SQRT2)) / g : airTime(u, g);
}

/** Horizontal px available while above `height`, for this config and speed. */
export function travelAbove(config, height, speed) {
  return distanceAboveHeight(effectiveImpulse(config), config.player.gravity, height, speed);
}

/** The vertical extent an obstacle actually occupies at its worst moment. */
export function obstacleReach(obstacle) {
  return obstacle.yOffset + (obstacle.motionAmp ?? 0) + obstacle.height;
}

/**
 * Can the player clear an obstacle of this height and width at this speed?
 * Accounts for the player's own body: the player square must be fully past the
 * obstacle before descending below its top edge.
 *
 * A moving obstacle is judged at the TOP of its travel — otherwise a saw that
 * happens to be rising is an instant death.
 */
export function canClear(config, obstacle, speed) {
  const requiredHeight = obstacleReach(obstacle) + VERTICAL_MARGIN;
  const peak = effectivePeak(config);

  if (peak <= requiredHeight) {
    return { ok: false, reason: 'jump_too_low', peak, requiredHeight };
  }

  const needed = obstacle.width + playerHeight(config) + HORIZONTAL_MARGIN;
  const available = travelAbove(config, requiredHeight, speed);

  if (available <= needed) {
    return { ok: false, reason: 'too_wide_for_airtime', needed, available, peak, requiredHeight };
  }
  return { ok: true, peak, requiredHeight, needed, available };
}

/**
 * A `low_bar` must be passable by NOT jumping — the player has to physically fit
 * underneath it while grounded.
 */
export function canPassUnder(config, obstacle) {
  const clearance = obstacle.yOffset - playerHeight(config);
  return { ok: clearance >= VERTICAL_MARGIN, clearance };
}

/** A `gap` in the ground must be leapable at this speed. */
export function canLeapGap(config, obstacle, speed) {
  const range = effectiveAirTime(config) * speed;
  const needed = obstacle.width + playerHeight(config) + HORIZONTAL_MARGIN * 2;
  return { ok: range > needed, range, needed };
}

/** Time between an obstacle appearing at the right edge and reaching the player. */
export function reactionSeconds(speed) {
  return (VIEW_WIDTH - PLAYER_X) / speed;
}

/**
 * Minimum safe distance between two obstacles: the player must land from the
 * first jump and be grounded again before needing the next one.
 */
export function minSafeSpacing(config, speed) {
  return effectiveAirTime(config) * speed + playerHeight(config) + HORIZONTAL_MARGIN * 2;
}

/**
 * Largest spacing at which ONE jump still clears both obstacles.
 * Returns 0 when a single jump cannot span the pair at all.
 */
export function singleJumpWindow(config, a, b, speed) {
  const tallest = Math.max(obstacleReach(a), obstacleReach(b)) + VERTICAL_MARGIN;
  const window = travelAbove(config, tallest, speed);
  return Math.max(0, window - b.width - playerHeight(config) - HORIZONTAL_MARGIN);
}

/**
 * Two obstacles may legitimately sit close together IF a single jump clears both.
 * Anything between "clearable in one jump" and "far enough to land and re-jump"
 * is a dead zone — unwinnable, and the classic source of unfair runners.
 */
export function pairIsFair(config, a, b, spacing, speed) {
  const safe = minSafeSpacing(config, speed);
  if (spacing >= safe) return { ok: true, mode: 'land_and_rejump' };

  const window = singleJumpWindow(config, a, b, speed);
  if (spacing <= window) return { ok: true, mode: 'single_jump_clears_both' };

  return { ok: false, mode: 'dead_zone', spacing, safe, window };
}
