/**
 * EMBERWAKE — the numbers that decide how the game feels.
 *
 * Every tuning value in the movement system lives here, with the reasoning next to it. That is
 * not tidiness for its own sake: a platformer is its jump arc, and a jump arc is four numbers
 * that have to be changed together. Scattering them through the controller means retuning is
 * archaeology, and it means the level solver cannot know what the player can actually reach.
 *
 * Units are pixels and seconds throughout. One tile is 32px, so a value of 96 is "three tiles"
 * and can be read as such — which matters constantly, because level design is done in tiles and
 * physics is done in pixels, and a mismatch between the two is invisible until a jump that
 * should clear a gap does not.
 */

export const TILE = 32;

/** Virtual resolution. The canvas scales to fit; the game always thinks in these units. */
export const VIEW_W = 960;
export const VIEW_H = 540;

/**
 * The simulation runs at a fixed 120 Hz regardless of the display rate.
 *
 * Variable-timestep platforming is subtly wrong in a way players feel but cannot name: jump
 * height changes with frame rate, and a dropped frame can tunnel the player through a floor.
 * Fixed steps with an accumulator make the physics identical on a 60 Hz laptop and a 144 Hz
 * monitor, and make the whole thing reproducible in a test.
 */
export const FIXED_DT = 1 / 120;
/** Never simulate more than this much time in one frame — a tab that was hidden must not
 *  fast-forward the player through a level when it comes back. */
export const MAX_FRAME_TIME = 0.25;

// ── the jump ────────────────────────────────────────────────────────────────
//
// Derived rather than guessed, and then checked against what the levels actually ask for. A
// jump that rises H pixels needs v = sqrt(2·g·H); at gravity 2400, a launch of 800 peaks at
// 133px — four tiles and a little, so a four-tile wall is a commitment and a three-tile one is
// routine.
//
// The first pass used 760 with a run of 265, and the level solver rejected every level in the
// game: that combination clears 4.8 tiles horizontally, and platform spacing that *looks*
// generous on a grid is not. The horizontal reach is the number that governs level design, and
// it is the product of run speed and time of flight — so it moves when either the jump or the
// running changes. That is exactly why both live here and why `MAX_JUMP_RUN` is exported.

export const GRAVITY = 2400;
export const JUMP_VELOCITY = 800;

/**
 * Gravity is not constant, and this is most of what separates a good jump from a stiff one.
 *
 * Rising costs full gravity, falling costs more (so the player comes down decisively rather
 * than floating), and near the top of the arc it costs less — the "apex hang" that gives the
 * player a moment to read where they are going. Real physics has one gravity; a game that uses
 * one feels like a rock on a string.
 */
export const FALL_GRAVITY_MULT = 1.38;
export const APEX_GRAVITY_MULT = 0.55;
/** |vy| under this counts as the apex. */
export const APEX_THRESHOLD = 130;

/**
 * Releasing jump early cuts the rise, giving a continuous range of heights from a tap to a hold.
 *
 * Implemented as a velocity clamp rather than by removing the input: cutting to a fixed upward
 * speed keeps short hops smooth, where zeroing the velocity outright makes a tapped jump stop
 * dead in the air and reads as a bug.
 */
export const JUMP_CUT_VELOCITY = 260;
/** Minimum airtime before a jump can be cut, so a single-frame tap still leaves the ground. */
export const JUMP_CUT_DELAY = 0.045;

/** Downward speed cap. Without one, a long fall becomes untunnelable and unreadable. */
export const MAX_FALL_SPEED = 920;

/**
 * Coyote time: the player may still jump for a moment after walking off an edge.
 *
 * 100 ms. Players run off ledges and press jump a frame or two late constantly; without this the
 * game feels like it is ignoring input, and with too much of it the character appears to jump
 * from thin air. This value is invisible in both directions.
 */
export const COYOTE_TIME = 0.1;

/**
 * Jump buffering: a jump pressed just before landing fires on touchdown.
 *
 * The mirror image of coyote time, and just as important — without it, chaining jumps requires
 * frame-perfect timing that no player should have to learn.
 */
export const JUMP_BUFFER = 0.12;

// ── running ─────────────────────────────────────────────────────────────────

export const RUN_SPEED = 300;
export const SPRINT_SPEED = 420;
export const GROUND_ACCEL = 2000;
export const GROUND_FRICTION = 2600;
/**
 * Air control is deliberately weaker than ground control but far from absent.
 *
 * No air control makes every jump a commitment and every mistake unrecoverable; full air control
 * makes the character a helicopter and removes the point of momentum. Roughly two-thirds is
 * where a jump still feels committed but a mistimed one can be saved.
 */
export const AIR_ACCEL = 1400;
export const AIR_DRAG = 700;
/** Turning on the ground is sharper than accelerating from rest — it makes direction changes
 *  feel deliberate instead of mushy. */
export const TURN_MULT = 2.2;

// ── abilities ───────────────────────────────────────────────────────────────

export const DASH_SPEED = 620;
export const DASH_TIME = 0.16;
export const DASH_COOLDOWN = 0.5;
/** A dash refunds on landing, so chaining dash-jump-dash is a skill rather than a timer. */
export const DOUBLE_JUMP_VELOCITY = 680;

export const WALL_SLIDE_SPEED = 190;
export const WALL_JUMP_X = 320;
export const WALL_JUMP_Y = 700;
/** Horizontal input is ignored briefly after a wall jump, so the player cannot immediately
 *  steer back into the wall and climb it frame by frame. */
export const WALL_JUMP_LOCK = 0.14;

// ── damage ──────────────────────────────────────────────────────────────────

export const MAX_HEALTH = 3;
export const HURT_INVULN = 1.3;
export const HURT_KNOCKBACK_X = 240;
export const HURT_KNOCKBACK_Y = 380;
/** Bouncing off a stomped enemy, and the higher bounce when jump is held. */
export const STOMP_BOUNCE = 480;
export const STOMP_BOUNCE_HELD = 680;

// ── power-ups ───────────────────────────────────────────────────────────────

export const POWERUP_DURATION = 10;
export const MAGNET_RADIUS = 150;
export const SPEED_ORB_MULT = 1.38;
export const JUMP_BOOST_MULT = 1.22;

// ── the player body ─────────────────────────────────────────────────────────
//
// Narrower than a tile so the player fits through one-tile gaps without pixel-perfect aim, and
// shorter than two tiles so a two-tile ceiling is genuinely passable.

export const PLAYER_W = 22;
export const PLAYER_H = 36;

/**
 * Reachability, precomputed for the level solver and for level design.
 *
 * These are what the physics above actually permits, so a level can be checked against the real
 * controller rather than against someone's memory of it. `MAX_JUMP_HEIGHT` is v²/2g; the run of
 * a jump is time-of-flight times run speed, and time-of-flight has to account for gravity being
 * higher on the way down.
 */
export const MAX_JUMP_HEIGHT = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
const RISE_TIME = JUMP_VELOCITY / GRAVITY;
const FALL_TIME = Math.sqrt((2 * MAX_JUMP_HEIGHT) / (GRAVITY * FALL_GRAVITY_MULT));
export const MAX_JUMP_RUN = RUN_SPEED * (RISE_TIME + FALL_TIME);

/** Tiles, rounded down — the number a level designer should actually trust. */
export const SAFE_JUMP_TILES_UP = Math.floor(MAX_JUMP_HEIGHT / TILE);
export const SAFE_JUMP_TILES_ACROSS = Math.floor(MAX_JUMP_RUN / TILE);
