"""
Visual identity: palette, snake skins, pickup and power-up definitions, game modes.

The whole game reads its colour from here. Nothing else in the project contains a literal
colour value, which is what makes eight skins cost eight table entries rather than eight
rendering paths.

Colours are plain RGB tuples. Anything that needs alpha carries it at the call site, because
the same colour is used at different opacities in different places (a skin's glow is the same
hue as its body, just thinner).
"""

from dataclasses import dataclass

# ── core palette ────────────────────────────────────────────────────────────
# A deep indigo room lit by neon. Backgrounds stay in the blue-violet family so that every
# gameplay colour — which is always warm or cyan — reads as "lit" against them.

BG_DEEP = (9, 8, 26)
BG_MID = (19, 17, 48)
BG_RIM = (33, 26, 78)
GRID = (58, 48, 122)
VIGNETTE = (4, 3, 14)

WALL = (86, 70, 176)
WALL_GLOW = (140, 110, 255)

INK = (7, 6, 20)
TEXT = (238, 240, 255)
TEXT_DIM = (150, 152, 190)
TEXT_FAINT = (96, 98, 132)

ACCENT = (0, 232, 255)
ACCENT_2 = (255, 62, 165)
GOLD = (255, 202, 64)
GREEN = (86, 240, 152)
DANGER = (255, 74, 92)

PANEL = (23, 21, 56)
PANEL_HI = (36, 33, 84)
PANEL_LINE = (72, 64, 148)


# ── snake skins ─────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Skin:
    """One snake style.

    `body_a`/`body_b` are blended along the length of the snake, which is what makes a skin
    read as a gradient rather than as a single flat colour. `unlock_score` of 0 means the skin
    is available from the first launch; everything else is earned against the all-time best.
    """

    key: str
    name: str
    body_a: tuple
    body_b: tuple
    head: tuple
    outline: tuple
    glow: tuple
    particle: tuple
    unlock_score: int = 0
    #: Extra hue cycling per second. Only Rainbow uses it, but it costs nothing to carry.
    hue_cycle: float = 0.0


SKINS = (
    Skin("classic", "CLASSIC", (66, 214, 120), (34, 158, 96), (128, 248, 168),
         (10, 48, 32), (86, 240, 152), (150, 255, 190), 0),
    Skin("neon", "NEON", (0, 214, 255), (78, 96, 255), (150, 244, 255),
         (6, 24, 62), (0, 232, 255), (170, 245, 255), 0),
    Skin("ember", "EMBER", (255, 156, 46), (232, 58, 62), (255, 214, 130),
         (58, 14, 8), (255, 122, 48), (255, 198, 120), 1500),
    Skin("gold", "GOLDEN", (255, 214, 92), (206, 142, 26), (255, 244, 190),
         (58, 38, 4), (255, 202, 64), (255, 236, 156), 4000),
    Skin("toxic", "TOXIC", (186, 255, 62), (96, 186, 30), (226, 255, 150),
         (26, 44, 6), (166, 255, 60), (214, 255, 130), 8000),
    Skin("frost", "GLACIER", (168, 236, 255), (96, 150, 246), (226, 250, 255),
         (12, 36, 72), (150, 220, 255), (220, 246, 255), 14000),
    Skin("cyber", "CYBER", (255, 62, 165), (128, 60, 255), (255, 168, 224),
         (44, 8, 52), (255, 62, 200), (255, 180, 235), 22000),
    Skin("prism", "PRISM", (255, 92, 132), (92, 168, 255), (255, 236, 255),
         (28, 12, 52), (200, 140, 255), (255, 220, 255), 32000, hue_cycle=0.11),
)

SKINS_BY_KEY = {s.key: s for s in SKINS}
DEFAULT_SKIN = SKINS[0].key


def skin(key):
    return SKINS_BY_KEY.get(key) or SKINS_BY_KEY[DEFAULT_SKIN]


# ── pickups ─────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class PickupKind:
    key: str
    label: str
    color: tuple
    glow: tuple
    score: int
    growth: int


PICKUPS = {
    "food": PickupKind("food", "ORB", (255, 86, 116), (255, 140, 170), 10, 3),
    "coin": PickupKind("coin", "SPARK", (255, 202, 64), (255, 232, 150), 25, 2),
    "gem": PickupKind("gem", "PRISM", (120, 240, 255), (190, 250, 255), 75, 5),
}


# ── power-ups ───────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class PowerKind:
    key: str
    label: str
    blurb: str
    color: tuple
    glow: tuple
    duration: float
    #: Weight in the spawn draw. Shield is the most useful, so it is not the most common.
    weight: float = 1.0


POWERS = {
    "magnet": PowerKind("magnet", "MAGNET", "pulls pickups in", (255, 122, 48), (255, 186, 120), 8.0, 1.2),
    "shield": PowerKind("shield", "SHIELD", "survives one hit", (110, 230, 255), (190, 245, 255), 14.0, 0.9),
    "slowmo": PowerKind("slowmo", "SLOW-MO", "everything eases off", (150, 170, 255), (205, 215, 255), 7.0, 1.0),
    "double": PowerKind("double", "DOUBLE", "score x2", (255, 202, 64), (255, 236, 160), 10.0, 1.1),
    "boost": PowerKind("boost", "BOOST", "surge forward", (255, 62, 165), (255, 170, 220), 6.0, 1.0),
    "ghost": PowerKind("ghost", "GHOST", "pass through walls", (186, 255, 62), (222, 255, 160), 7.0, 0.8),
}

POWER_ORDER = ("magnet", "shield", "slowmo", "double", "boost", "ghost")


# ── game modes ──────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Mode:
    key: str
    name: str
    blurb: str
    color: tuple


MODES = (
    Mode("classic", "CLASSIC", "No timer, no mercy. Survive and grow.", ACCENT),
    Mode("time", "TIME ATTACK", "75 seconds. Every pickup buys you more.", GOLD),
    Mode("challenge", "CHALLENGE", "Six objectives, one run, no restarts.", ACCENT_2),
)

MODES_BY_KEY = {m.key: m for m in MODES}
DEFAULT_MODE = MODES[0].key


def mode(key):
    return MODES_BY_KEY.get(key) or MODES_BY_KEY[DEFAULT_MODE]


# ── challenge objectives ────────────────────────────────────────────────────
# Read in order; each completes and hands over to the next. Kept declarative so the scene has
# no per-objective branching — it just asks whether `stat >= target`.
@dataclass(frozen=True)
class Objective:
    stat: str
    target: int
    text: str


CHALLENGES = (
    Objective("food", 8, "Collect {target} orbs"),
    Objective("length", 32, "Grow to {target} segments"),
    Objective("coins", 6, "Collect {target} sparks"),
    Objective("combo_best", 5, "Reach a x{target} combo"),
    Objective("gems", 3, "Collect {target} prisms"),
    Objective("score", 3000, "Score {target} points"),
)


# ── helpers ─────────────────────────────────────────────────────────────────
def lerp_color(a, b, t):
    t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
    return (
        int(a[0] + (b[0] - a[0]) * t),
        int(a[1] + (b[1] - a[1]) * t),
        int(a[2] + (b[2] - a[2]) * t),
    )


def shade(c, amount):
    """Lighten (amount > 0) or darken (amount < 0) an RGB tuple by a ratio."""
    if amount >= 0:
        return lerp_color(c, (255, 255, 255), amount)
    return lerp_color(c, (0, 0, 0), -amount)


def with_alpha(c, a):
    return (c[0], c[1], c[2], max(0, min(255, int(a))))
