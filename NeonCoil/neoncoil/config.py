"""
Tuning constants for NEON COIL.

Everything a designer would want to reach for lives here rather than being buried in the
systems that read it, so the feel of the game can be changed without touching logic.

Two conventions hold throughout the project:

* All positions, sizes and speeds are in VIRTUAL pixels — the game always renders into a
  fixed 1280x720 surface which is then scaled to whatever the window happens to be. That means
  layout code never has to think about resolution, and resizing can never break a hitbox.
* All rates are per SECOND, never per frame, and every update takes a `dt`. The simulation is
  additionally run on a fixed timestep (see `FIXED_DT`), so a slow frame cannot let the head
  tunnel through a wall.
"""

# ── window ──────────────────────────────────────────────────────────────────
GAME_W = 1280
GAME_H = 720
TITLE = "NEON COIL"
TARGET_FPS = 60

#: The simulation always advances in slices of this size. Render interpolation is not needed
#: at 120 Hz sub-stepping, but collision correctness is: at 700 px/s a single 100 ms hitch
#: would move the head 70 px, which is most of the way through an obstacle.
FIXED_DT = 1.0 / 120.0
#: Never simulate more than this much wall-clock in one frame. A debugger pause or a window
#: drag would otherwise produce a spiral of death.
MAX_FRAME_DT = 0.25

# ── arena ───────────────────────────────────────────────────────────────────
HUD_H = 74
ARENA_MARGIN = 26
ARENA = (
    ARENA_MARGIN,
    HUD_H + ARENA_MARGIN * 0.5,
    GAME_W - ARENA_MARGIN * 2,
    GAME_H - HUD_H - ARENA_MARGIN * 1.5,
)
WALL_THICKNESS = 7

# ── snake ───────────────────────────────────────────────────────────────────
SNAKE_START_SPEED = 250.0
SNAKE_MAX_SPEED = 430.0
#: Speed added per level. Deliberately small — the difficulty a player actually feels comes
#: from their own length and the obstacle count, and raw speed on top of those compounds fast.
SNAKE_SPEED_PER_LEVEL = 15.0

#: Steering is specified as a minimum TURN RADIUS, not as a turn rate, and this is the single
#: most important number in the game's feel.
#:
#: A rate was the obvious first choice and it was wrong twice over. At 620 deg/s and 250 px/s
#: the radius works out at 23 px — tighter than the snake is wide — so holding one direction
#: curled the head straight into its own neck and killed the player for steering. And because
#: radius is speed over rate, a fixed rate means the turn tightens as the game slows and opens
#: out as it speeds up, so the handling changed under the player between levels.
#:
#: Deriving the rate from a fixed radius fixes both: the geometry of a turn is identical at
#: every speed, and the radius can be chosen against the thing that actually matters, which is
#: the length at which a full circle closes on itself. At 58 px the circle is 364 px around,
#: or about 33 segments — so a snake shorter than that physically cannot loop into itself, and
#: past it, doing so is a visible, avoidable mistake rather than a surprise.
SNAKE_TURN_RADIUS = 58.0
#: Boosting widens the arc, so speed costs manoeuvrability.
SNAKE_TURN_RADIUS_BOOST = 78.0
#: Ceiling on the derived rate, so the very fastest levels stay readable.
SNAKE_TURN_RATE_MAX = 560.0
#: Floor on the speed used to derive the rate, so a stopped snake can still be aimed.
SNAKE_TURN_MIN_SPEED = 150.0

HEAD_RADIUS = 15.0
TAIL_RADIUS = 6.0
#: Distance along the path between body segments. Smaller looks smoother and costs more.
SEGMENT_SPACING = 11.0
START_SEGMENTS = 9
SEGMENTS_PER_FOOD = 3
MAX_SEGMENTS = 260

#: Body segments this close to the head are ignored by self-collision. Without it the neck
#: clips the head during a hard turn and the player dies for steering.
SELF_COLLISION_SKIP = 7
#: Path points are recorded no closer together than this. The body samples the path by arc
#: length, so this only sets how faithfully a tight curve is reproduced.
PATH_SAMPLE_STEP = 3.5

# ── pickups ─────────────────────────────────────────────────────────────────
FOOD_RADIUS = 13.0
GEM_RADIUS = 15.0
COIN_RADIUS = 12.0

FOOD_SCORE = 10
COIN_SCORE = 25
GEM_SCORE = 75

FOOD_ON_FIELD = 3
#: Seconds a rare pickup stays on the field before fading out.
GEM_LIFETIME = 9.0
COIN_LIFETIME = 12.0
GEM_SPAWN_EVERY = (13.0, 21.0)
COIN_SPAWN_EVERY = (6.0, 11.0)

# ── combo ───────────────────────────────────────────────────────────────────
#: Seconds after a pickup during which the next one keeps the chain alive.
COMBO_WINDOW = 3.4
COMBO_MAX = 8
#: The window shrinks as the multiplier climbs, so a long chain is genuinely a skill run.
COMBO_WINDOW_DECAY = 0.12

# ── power-ups ───────────────────────────────────────────────────────────────
POWERUP_RADIUS = 17.0
POWERUP_LIFETIME = 11.0
POWERUP_SPAWN_EVERY = (11.0, 18.0)
POWERUP_MAX_ON_FIELD = 2

MAGNET_RADIUS = 210.0
MAGNET_PULL = 430.0
BOOST_MULTIPLIER = 1.65
SLOWMO_SCALE = 0.55

# ── progression ─────────────────────────────────────────────────────────────
FOOD_PER_LEVEL = 6
MAX_LEVEL = 20
OBSTACLES_FROM_LEVEL = 3
OBSTACLE_EVERY_N_LEVELS = 2
MAX_OBSTACLES = 11

# ── modes ───────────────────────────────────────────────────────────────────
TIME_ATTACK_SECONDS = 75.0
TIME_ATTACK_BONUS_FOOD = 1.1
TIME_ATTACK_BONUS_GEM = 4.0

# ── feel ────────────────────────────────────────────────────────────────────
SHAKE_DECAY = 7.0
DEATH_FREEZE = 0.28
RESPAWN_INVULN = 1.2
TRANSITION_TIME = 0.42

#: Particle budget. Emitters ask for what they want and the pool refuses politely once full,
#: which keeps a chain of pickups from turning into a frame-rate cliff.
MAX_PARTICLES = 900
