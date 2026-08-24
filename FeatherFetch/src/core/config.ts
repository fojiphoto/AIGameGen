/**
 * FEATHER & FETCH — the numbers the whole game is balanced against.
 *
 * Every tuning value lives here with the reasoning beside it, for the same reason the platformer
 * put its jump constants in one file: a shooter's difficulty is a handful of numbers that have
 * to move together, and scattering them through the spawner means retuning is archaeology.
 *
 * The one that matters most is `MIN_SHOOTABLE_SECONDS`. A duck the player cannot realistically
 * hit is not "hard", it is broken — so the test suite simulates every duck type against every
 * flight pattern and refuses any combination that does not stay inside the play area for at
 * least this long. That single constant is what stops "make it faster" from quietly becoming
 * "make it impossible".
 */

/** Virtual resolution. The canvas scales to fit; the game always thinks in these units. */
export const VIEW_W = 960;
export const VIEW_H = 540;

/**
 * The band a duck can be shot in.
 *
 * Not the whole screen: the top strip is behind the HUD and the bottom is grass and the fence,
 * where a duck would be hidden. Ducks fly and are targetable only between these lines, which is
 * also the region the fairness test measures.
 */
export const SKY_TOP = 44;
export const SKY_BOTTOM = 390;

/**
 * Where the grass line sits — ducks fall behind it and the dog runs along it.
 *
 * Kept low. The first pass put it at 400 of 540 and a quarter of the screen was flat green with
 * nothing in it; the sky is where the game happens, so the ground gets only as much room as the
 * dog needs to run across.
 */
export const GROUND_Y = 424;

/**
 * Fixed simulation step.
 *
 * A shooter is judged on whether a shot registers where the player aimed, and that means the
 * duck's position at the instant of the click has to be the position that was drawn. Fixed steps
 * with an accumulator make that reproducible, and make the fairness suite meaningful — a duck
 * simulated in Node follows exactly the path it follows on screen.
 */
export const FIXED_DT = 1 / 120;
export const MAX_FRAME_TIME = 0.25;

// ── shooting ────────────────────────────────────────────────────────────────

/** Shells per wave. Three is the classic count and it is the right one: enough to recover from
 *  one miss, few enough that the third shot is tense. */
export const SHELLS = 3;
export const RELOAD_SECONDS = 0.55;

/**
 * Hit tolerance added to a duck's hitbox, in pixels.
 *
 * Deliberately generous, and more so on touch. A finger covers roughly 40px of screen and hides
 * what it is pointing at, so a hitbox tuned for a mouse feels broken on a phone. Being slightly
 * too forgiving is invisible; being slightly too strict is the single most common complaint
 * about browser shooters.
 */
export const HIT_PAD_MOUSE = 6;
export const HIT_PAD_TOUCH = 18;

/** Frames of frozen time on a hit. The cheapest impact effect there is. */
export const HIT_STOP = 0.06;
export const HIT_STOP_RARE = 0.11;

// ── rounds ──────────────────────────────────────────────────────────────────

/** Ducks released at once, and how that grows. Wave size is capped so the screen stays readable. */
export const WAVE_MIN = 1;
export const WAVE_MAX = 3;
/** Ducks per round, and the growth per round. */
export const ROUND_DUCKS_BASE = 5;
export const ROUND_DUCKS_STEP = 1;
export const ROUND_DUCKS_MAX = 12;
/** Rounds before the environment changes. */
export const ROUNDS_PER_ENVIRONMENT = 4;

/**
 * Difficulty, expressed as one number that everything else reads.
 *
 * Rises smoothly with the round rather than stepping, because a shooter that suddenly doubles
 * in speed reads as a bug. It saturates, so round 40 is hard but not absurd.
 */
export const difficultyFor = (round: number): number =>
  1 - Math.exp(-(Math.max(1, round) - 1) / 7);

/** Speed multiplier applied to every duck, from the difficulty. */
export const speedScale = (difficulty: number): number => 1 + difficulty * 1.15;

/** Escape timer: how long a duck stays before it leaves, shrinking with difficulty. */
export const escapeSeconds = (difficulty: number): number => 5.2 - difficulty * 2.0;

/**
 * The floor under everything.
 *
 * No duck may be shootable for less than this. Enforced by the test suite across every type,
 * pattern and difficulty — if a tuning change makes a duck cross the screen too fast to hit,
 * the suite says so by name instead of a player discovering it.
 */
export const MIN_SHOOTABLE_SECONDS = 1.15;

// ── scoring ─────────────────────────────────────────────────────────────────

export const COMBO_STEPS = [1, 1, 1.25, 1.5, 2, 2.5, 3, 4];
/** Combo multiplier for a run of `n` consecutive hits. */
export const comboMultiplier = (streak: number): number =>
  COMBO_STEPS[Math.min(streak, COMBO_STEPS.length - 1)];

export const PERFECT_ROUND_BONUS = 1500;
export const FIRST_SHELL_BONUS = 50;
export const UNUSED_SHELL_BONUS = 75;

// ── the dog ─────────────────────────────────────────────────────────────────

/**
 * How long the retrieval takes.
 *
 * Half a second — and the next wave does not wait for even that.
 *
 * The first version ran 1.85s and *blocked* the round until Biscuit was off the screen, which
 * meant every duck cost the player two seconds of watching a dog. That is the wrong trade: the
 * dog is the charm of the game but the shooting is the game, and charm that interrupts the loop
 * stops being charm by the third round.
 *
 * So he stopped being a dog that runs and became a dog that *blurs* — in, grab, gone, with a
 * light trail where he was. Speed this far past plausible is the joke rather than a compromise,
 * and it is the only version where the fetch never costs the player a beat.
 */
export const DOG_RETRIEVE_SECONDS = 0.55;
/**
 * How long he stands there laughing at a miss.
 *
 * Shorter than the fetch, which is the rule: being mocked has to cost less than being served.
 */
export const DOG_TEASE_SECONDS = 0.5;

/**
 * Pixels per second. He crosses the whole screen in under half a second.
 *
 * At this speed a normal sprite reads as a teleport rather than as a run, which is why the trail
 * below is not decoration — the afterimages are what make the motion legible at all.
 */
export const DOG_SPEED = 2450;

/**
 * The trail, in three numbers that have to agree with each other.
 *
 * Spacing is by distance travelled, not by time, so the trail stays evenly spaced whatever the
 * frame rate. That makes the count of afterimages alive at once a fixed quantity —
 * `speed * seconds / step` — and the cap has to sit *above* it, or the oldest images get thrown
 * away while still visible and the trail ends in a hard edge instead of fading out.
 */
export const DOG_TRAIL_SECONDS = 0.16;
export const DOG_TRAIL_MAX = 12;
export const DOG_TRAIL_STEP = 42;

export const MAX_MISSES = 3;
