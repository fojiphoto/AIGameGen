"""
Palettes, and the live colour names the whole game draws with.

The important idea here is that switching a theme must restyle *everything* — background, board,
blocks, particles, UI accents — without any screen knowing that themes exist. So the colours are
module-level names that `apply()` rewrites, and every drawing site reads them as `theme.TEXT`
rather than importing the value. An `from .theme import TEXT` anywhere would capture the colour
at import time and quietly stop following the theme; that is the one rule this file depends on.

All five themes are dark. That is not a lack of variety, it is what keeps one set of text
colours legible across all of them, and it is what lets bright blocks read as lit rather than
printed. The variety lives in the hue of the ground and in the block palettes, which is where a
player actually looks.
"""

from __future__ import annotations

from dataclasses import dataclass, field


def lerp_color(a, b, t: float) -> tuple:
    t = max(0.0, min(1.0, t))
    return (
        int(a[0] + (b[0] - a[0]) * t),
        int(a[1] + (b[1] - a[1]) * t),
        int(a[2] + (b[2] - a[2]) * t),
    )


def shade(c, amount: float) -> tuple:
    """Lighten (positive) or darken (negative) towards white or black."""
    if amount >= 0:
        return lerp_color(c, (255, 255, 255), amount)
    return lerp_color(c, (0, 0, 0), -amount)


def with_alpha(c, a: int) -> tuple:
    return (c[0], c[1], c[2], a)


@dataclass(frozen=True)
class Palette:
    key: str
    name: str
    blurb: str
    #: Coins to unlock. The first theme is free; the rest are the reward loop.
    cost: int

    bg_deep: tuple
    bg_mid: tuple
    bg_rim: tuple
    #: Colours for the drifting background blobs.
    glow: tuple

    panel: tuple
    panel_hi: tuple
    panel_line: tuple

    board: tuple            # the board panel face
    board_edge: tuple       # its border
    well: tuple             # an empty cell
    well_line: tuple

    accent: tuple
    accent_2: tuple

    #: Seven block colours. Seven because that is as many as stay distinguishable at 76px with
    #: gradients on them; an eighth always ends up reading as a shade of one of the others.
    blocks: tuple

    #: Multiplies every block colour. Neon wants blocks brighter than their ground; Candy wants
    #: them glossy but not glaring.
    block_shine: float = 0.30
    block_glow: int = 0     # additive halo behind a placed tile, 0 for none
    vignette: int = 170


PALETTES = (
    Palette(
        key="classic",
        name="CLASSIC",
        blurb="Clean and colourful",
        cost=0,
        bg_deep=(18, 22, 44), bg_mid=(30, 37, 70), bg_rim=(46, 56, 104),
        glow=(88, 120, 220),
        panel=(31, 38, 72), panel_hi=(44, 53, 96), panel_line=(78, 92, 152),
        board=(25, 31, 60), board_edge=(62, 74, 126),
        well=(35, 43, 80), well_line=(50, 60, 106),
        accent=(90, 170, 255), accent_2=(255, 190, 80),
        blocks=(
            (86, 152, 255),     # blue
            (168, 118, 255),    # purple
            (255, 148, 72),     # orange
            (76, 210, 132),     # green
            (255, 116, 168),    # pink
            (78, 214, 226),     # cyan
            (255, 206, 86),     # yellow
        ),
        block_shine=0.30,
    ),
    Palette(
        key="neon",
        name="NEON",
        blurb="Dark room, lit tiles",
        cost=400,
        bg_deep=(6, 7, 18), bg_mid=(13, 14, 34), bg_rim=(26, 22, 60),
        glow=(150, 70, 255),
        panel=(16, 16, 40), panel_hi=(26, 26, 62), panel_line=(74, 60, 156),
        board=(11, 12, 30), board_edge=(84, 62, 190),
        well=(27, 28, 62), well_line=(48, 44, 104),
        accent=(0, 236, 255), accent_2=(255, 62, 165),
        blocks=(
            (0, 214, 255),
            (176, 84, 255),
            (255, 132, 40),
            (56, 245, 148),
            (255, 60, 158),
            (64, 255, 232),
            (255, 226, 64),
        ),
        block_shine=0.42, block_glow=120, vignette=200,
    ),
    Palette(
        key="candy",
        name="CANDY",
        blurb="Glossy and sweet",
        cost=700,
        bg_deep=(40, 18, 46), bg_mid=(66, 28, 72), bg_rim=(98, 44, 100),
        glow=(255, 130, 200),
        panel=(62, 28, 68), panel_hi=(84, 40, 90), panel_line=(150, 84, 148),
        board=(52, 24, 58), board_edge=(140, 78, 138),
        well=(70, 33, 76), well_line=(96, 48, 100),
        accent=(255, 156, 214), accent_2=(255, 226, 122),
        blocks=(
            (120, 176, 255),
            (198, 140, 255),
            (255, 166, 108),
            (128, 226, 158),
            (255, 148, 190),
            (128, 232, 238),
            (255, 224, 128),
        ),
        block_shine=0.52, vignette=150,
    ),
    Palette(
        key="ocean",
        name="OCEAN",
        blurb="Deep water calm",
        cost=1000,
        bg_deep=(6, 26, 42), bg_mid=(10, 44, 68), bg_rim=(16, 68, 98),
        glow=(60, 190, 220),
        panel=(11, 42, 64), panel_hi=(18, 58, 84), panel_line=(46, 108, 142),
        board=(8, 34, 54), board_edge=(40, 100, 134),
        well=(13, 46, 70), well_line=(28, 74, 104),
        accent=(72, 220, 226), accent_2=(255, 212, 120),
        blocks=(
            (74, 162, 255),
            (140, 148, 255),
            (255, 176, 96),
            (72, 216, 176),
            (255, 138, 170),
            (86, 230, 232),
            (246, 224, 128),
        ),
        block_shine=0.34, vignette=180,
    ),
    Palette(
        key="galaxy",
        name="GALAXY",
        blurb="Far from anywhere",
        cost=1400,
        bg_deep=(14, 10, 34), bg_mid=(28, 18, 62), bg_rim=(48, 28, 96),
        glow=(140, 90, 255),
        panel=(26, 18, 58), panel_hi=(38, 27, 80), panel_line=(84, 62, 160),
        board=(20, 14, 48), board_edge=(78, 58, 156),
        well=(37, 27, 80), well_line=(56, 42, 116),
        accent=(178, 140, 255), accent_2=(120, 232, 255),
        blocks=(
            (108, 140, 255),
            (186, 124, 255),
            (255, 158, 96),
            (96, 224, 168),
            (255, 128, 196),
            (104, 226, 252),
            (255, 216, 112),
        ),
        block_shine=0.38, block_glow=84, vignette=196,
    ),
)

PALETTES_BY_KEY = {p.key: p for p in PALETTES}
DEFAULT_THEME = PALETTES[0].key


# ── the live names everything draws with ────────────────────────────────────────
#
# Declared here so tooling and readers can see them; `apply()` is what gives them their values.
# They are deliberately module globals rather than an object, because that is what makes
# `theme.PANEL` at a draw site follow a theme change with no plumbing.

current: Palette = PALETTES[0]

BG_DEEP = BG_MID = BG_RIM = GLOW = (0, 0, 0)
PANEL = PANEL_HI = PANEL_LINE = (0, 0, 0)
BOARD = BOARD_EDGE = WELL = WELL_LINE = (0, 0, 0)
ACCENT = ACCENT_2 = (0, 0, 0)
BLOCKS: tuple = ()
BLOCK_SHINE = 0.3
BLOCK_GLOW = 0
VIGNETTE_STRENGTH = 170

#: Text and status colours do not vary by theme. Every palette is dark, so one set stays legible
#: across all of them — and a score readout that changes colour with the wallpaper is a
#: readability bug dressed up as a feature.
TEXT = (245, 247, 255)
TEXT_DIM = (172, 178, 208)
TEXT_FAINT = (112, 118, 148)
INK = (8, 8, 20)
GOLD = (255, 206, 86)
GREEN = (86, 226, 148)
DANGER = (255, 96, 108)
VIGNETTE = (3, 3, 10)


def apply(key: str) -> Palette:
    """Point the live colour names at a palette. Returns the palette actually applied."""
    global current
    global BG_DEEP, BG_MID, BG_RIM, GLOW
    global PANEL, PANEL_HI, PANEL_LINE
    global BOARD, BOARD_EDGE, WELL, WELL_LINE
    global ACCENT, ACCENT_2, BLOCKS, BLOCK_SHINE, BLOCK_GLOW, VIGNETTE_STRENGTH

    p = PALETTES_BY_KEY.get(key) or PALETTES_BY_KEY[DEFAULT_THEME]
    current = p
    BG_DEEP, BG_MID, BG_RIM, GLOW = p.bg_deep, p.bg_mid, p.bg_rim, p.glow
    PANEL, PANEL_HI, PANEL_LINE = p.panel, p.panel_hi, p.panel_line
    BOARD, BOARD_EDGE, WELL, WELL_LINE = p.board, p.board_edge, p.well, p.well_line
    ACCENT, ACCENT_2 = p.accent, p.accent_2
    BLOCKS = p.blocks
    BLOCK_SHINE = p.block_shine
    BLOCK_GLOW = p.block_glow
    VIGNETTE_STRENGTH = p.vignette
    return p


def block_color(index: int) -> tuple:
    """Block colours are indexed, not stored — so a saved board restyles with the theme."""
    return BLOCKS[index % len(BLOCKS)]


apply(DEFAULT_THEME)


# ── challenge objectives ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Objective:
    key: str
    label: str
    target: int
    reward: int


#: A ladder, in order. Each is checked against one run; the player advances one rung at a time,
#: which is what makes the mode feel like progress rather than a list of chores.
CHALLENGES = (
    Objective("lines_5", "Clear 5 lines", 5, 40),
    Objective("score_1500", "Reach 1,500 points", 1500, 60),
    Objective("double", "Clear two lines at once", 1, 80),
    Objective("moves_25", "Place 25 pieces in one run", 25, 100),
    Objective("lines_15", "Clear 15 lines", 15, 130),
    Objective("combo_3", "Reach combo x3", 3, 160),
    Objective("score_6000", "Reach 6,000 points", 6000, 220),
    Objective("triple", "Clear three lines at once", 1, 280),
    Objective("combo_5", "Reach combo x5", 5, 340),
    Objective("score_15000", "Reach 15,000 points", 15000, 500),
)

CHALLENGES_BY_KEY = {c.key: c for c in CHALLENGES}


@dataclass(frozen=True)
class Mode:
    key: str
    name: str
    blurb: str


MODES = (
    Mode("endless", "ENDLESS", "Play until nothing fits"),
    Mode("challenge", "CHALLENGE", "Clear objectives in order"),
)

MODES_BY_KEY = {m.key: m for m in MODES}
DEFAULT_MODE = MODES[0].key


def mode(key: str) -> Mode:
    return MODES_BY_KEY.get(key) or MODES_BY_KEY[DEFAULT_MODE]
