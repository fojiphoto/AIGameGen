"""
Every tuning constant in the game, with the reasoning next to it.

Nothing here is chosen by feel alone — the layout numbers are derived so the grid lands on
whole pixels, and the scoring numbers are derived from what they are meant to reward. Keeping
them together means the game can be retuned without reading the systems that consume them.
"""

from __future__ import annotations

# ── surface ─────────────────────────────────────────────────────────────────────
#
# Portrait, because that is the shape this genre is played in and a landscape board with two
# empty thirds looks like a port. 720x1280 is exactly 9:16 — the layout was designed against
# 1080x1920 and divided by 1.5, which keeps every derived number below an integer.
#
# It is a *virtual* surface: everything draws here and the result is scaled to the window, so
# layout code uses literal coordinates and never thinks about resolution.
GAME_W = 720
GAME_H = 1280
TITLE = "BLOCK BLOOM"

TARGET_FPS = 60
FIXED_DT = 1.0 / 120.0
#: Clamp on a single frame's delta. A window dragged across a monitor can produce a delta of
#: several seconds, and animations that integrate it would jump rather than resume.
MAX_FRAME_DT = 0.25
TRANSITION_TIME = 0.40

# ── board ───────────────────────────────────────────────────────────────────────
#
# 8x8, not 10x10. With three pieces dealt at a time and shapes up to five cells long, a ten-wide
# row needs too many pieces to complete: clears become rare, the board silts up, and the game
# reads as unfair rather than hard. At eight, a row is two or three well-chosen pieces, which is
# the loop this genre lives on.
GRID = 8

CELL = 76           # 8 * 76 = 608
CELL_GAP = 5        # 7 gaps = 35, so the grid is 643 wide
BOARD_PAD = 8       # panel inset around the grid
BOARD_W = GRID * CELL + (GRID - 1) * CELL_GAP + BOARD_PAD * 2   # 659
BOARD_X = (GAME_W - BOARD_W) // 2                               # 30
BOARD_Y = 268
BOARD_RADIUS = 26
CELL_RADIUS = 14

#: Corner radius of the little well drawn for an empty cell. Slightly tighter than a filled
#: tile so the tile reads as sitting *inside* the well rather than replacing it.
WELL_RADIUS = 12

# ── tray ────────────────────────────────────────────────────────────────────────
TRAY_SLOTS = 3
TRAY_Y = 1010
TRAY_H = 210
#: Tray tiles are drawn smaller than board tiles so a five-long piece fits a slot with room to
#: breathe, and so picking one up can scale it *up* to full size — the lift reads as the piece
#: becoming real.
TRAY_CELL = 40
TRAY_GAP = 3
TRAY_SLOT_W = GAME_W // TRAY_SLOTS

# ── HUD ─────────────────────────────────────────────────────────────────────────
HUD_TOP = 30
HUD_H = 200

# ── drag and drop ───────────────────────────────────────────────────────────────
#
# The grab point is lifted above the cursor. On a touchscreen the finger covers the piece, and
# even with a mouse the cursor sitting in the middle of the shape hides the cell it is about to
# fill; raising it means the preview is always visible.
DRAG_LIFT_Y = 86
DRAG_SCALE_TIME = 0.12
#: A piece is placed if its snapped position is legal. The snap searches from the cell nearest
#: the piece's own top-left, which is far more forgiving than requiring the cursor to be inside
#: the target cell.
SNAP_TOLERANCE_CELLS = 1
RETURN_TIME = 0.22          # spring-back when dropped somewhere illegal
PLACE_BOUNCE_TIME = 0.26

# ── clearing ────────────────────────────────────────────────────────────────────
#
# Cells do not all vanish at once: they go in a wave along the line. The stagger is small
# enough to read as one event and large enough to feel like a sweep.
CLEAR_STAGGER = 0.022
CLEAR_CELL_TIME = 0.30
CLEAR_HOLD = 0.10           # the highlight before anything moves
BOARD_PULSE_TIME = 0.42

# ── scoring ─────────────────────────────────────────────────────────────────────
#
# Derived from what each thing is worth relative to a placement, not picked at random:
# a placement is small change, a single line is worth about ten placements, and every
# additional line in the same move is worth more than the one before it.
POINTS_PER_CELL = 2
LINE_BASE = 100
#: Multi-clear multipliers, indexed by (lines - 1). Clearing four lines at once is worth 8x a
#: single, not 4x — simultaneity is the skill the scoring is meant to teach.
MULTI_CLEAR = (1.0, 2.5, 4.5, 8.0, 12.0, 17.0, 23.0, 30.0)
PERFECT_CLEAR_BONUS = 2000  # emptying the board entirely

COMBO_MAX = 8
#: Combo adds a fraction per step rather than multiplying outright: x8 would make late scores
#: meaningless next to early ones.
COMBO_STEP = 0.25

COIN_PER_SCORE = 1200       # one coin per this much score, awarded at the end of a run
COIN_PER_LINE = 1
COIN_COMBO_BONUS = 5        # for reaching combo x5 in a run

# ── generation ──────────────────────────────────────────────────────────────────
#
# Difficulty is expressed as the *size* of the shapes offered, not as cruelty. Early deals lean
# on small shapes that fit anywhere; later deals include the awkward five-cell pieces. What
# never changes is the guarantee below.
DIFFICULTY_MOVES = 60       # moves to reach full difficulty
#: At least this many of the three dealt pieces must be placeable on the current board. One is
#: the honest minimum — a deal where nothing fits would end the run for reasons the player could
#: not have influenced, which is the one thing this genre must never do.
MIN_PLACEABLE = 1
#: How hard the generator tries for a deal that also *completes a line*. Not a guarantee: an
#: always-solvable board would remove the strategy. It weights towards possibility.
GEN_ATTEMPTS = 24

# ── feel ────────────────────────────────────────────────────────────────────────
SHAKE_DECAY = 8.0
MAX_PARTICLES = 700
SCORE_LERP_RATE = 9.0       # how fast the displayed score chases the real one

# ── modes ───────────────────────────────────────────────────────────────────────
TUTORIAL_STEPS = 2
