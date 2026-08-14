"""
The animated backdrop, shared by every screen.

The brief pulls in two directions: the background has to have real depth and motion, and it must
never once make a tile harder to read. So every layer here is large, slow and low-contrast, and
the brightest thing it can produce is still darker than the dimmest tile the board draws.

Layers, back to front:

1. a vertical wash from the theme's deep colour to its mid colour
2. a soft pool of light behind where the board sits, which gives the layout a centre
3. large blurred blobs orbiting on long slow paths
4. drifting motes
5. a vignette to close the corners down

Only what is genuinely static is cached — the gradient and the pool of light, flattened into one
opaque surface. Everything that moves is drawn live, and that is the faster arrangement rather
than a compromise: caching the moving layers and refreshing the composite periodically was tried
in the game this came from and measured *slower* (8.0 ms against 6.2), because blitting a
full-screen cache and occasionally rebuilding it is more work than the handful of blits it stands
in for. It also hitched, since the rebuild frame cost eight times its neighbours.

There is no grid layer. In a game whose board is an 8x8 grid, a second grid in the background is
visual noise competing with the thing the player is reading.
"""

from __future__ import annotations

import math
import random

import pygame

from . import assets, theme


class Backdrop:
    """A living background, rebuilt when the theme changes.

    `intensity` scales the animated layers so the same object can be busy behind a menu and pulled
    right back behind the board, without maintaining two of them.
    """

    def __init__(self, size, *, intensity: float = 1.0, seed: int = 7, blobs: int = 5):
        self.w, self.h = int(size[0]), int(size[1])
        self.intensity = intensity
        self.t = 0.0
        self.seed = seed
        self.blob_count = max(0, int(blobs))
        self._theme_key = None
        self._build()

    # ── construction ────────────────────────────────────────────────────────────
    def _build(self) -> None:
        """Generate the static ground and the moving layers' parameters for the current theme."""
        self._theme_key = theme.current.key
        rng = random.Random(self.seed)

        base = assets.vertical_gradient((self.w, self.h), theme.BG_DEEP, theme.BG_MID)
        # The pool of light sits where the board does — a little above centre in portrait — so the
        # eye is drawn there before anything is even drawn on top.
        wash = assets.radial_wash((self.w, self.h), (self.w * 0.5, self.h * 0.42),
                                  self.w * 0.95, theme.BG_RIM, peak=118)
        self.base = base.copy()
        self.base.blit(wash, (0, 0))
        self.vignette = assets.vignette((self.w, self.h), theme.VIGNETTE_STRENGTH)

        # Blobs: big, slow, and few. Each has its own orbit so they never form a pattern.
        self.blobs = []
        for i in range(self.blob_count):
            radius = rng.randint(150, 280)
            self.blobs.append({
                "r": radius,
                "color": rng.choice((theme.GLOW, theme.ACCENT, theme.ACCENT_2)),
                "cx": rng.uniform(0.08, 0.92) * self.w,
                "cy": rng.uniform(0.06, 0.94) * self.h,
                "ax": rng.uniform(30, 110),
                "ay": rng.uniform(40, 130),
                "sx": rng.uniform(0.035, 0.11) * (1 if i % 2 else -1),
                "sy": rng.uniform(0.030, 0.095) * (1 if i % 3 else -1),
                "phase": rng.uniform(0, math.tau),
                "alpha": rng.randint(14, 27),
            })

        self.motes = []
        for _ in range(34):
            self.motes.append({
                "x": rng.uniform(0, self.w),
                "y": rng.uniform(0, self.h),
                "r": rng.uniform(1.5, 3.6),
                "sp": rng.uniform(6.0, 22.0),
                "drift": rng.uniform(-8.0, 8.0),
                "a": rng.randint(26, 80),
                "c": rng.choice((theme.ACCENT, theme.ACCENT_2, (220, 226, 255))),
            })

    def retheme(self) -> None:
        """Rebuild if the theme has changed since this backdrop was made.

        Called from draw rather than pushed by the theme screen, so no screen has to know which
        backdrops exist. Comparing the key makes it free on every frame that has not changed.
        """
        if self._theme_key != theme.current.key:
            self._build()

    # ── frame ───────────────────────────────────────────────────────────────────
    def update(self, dt: float) -> None:
        self.t += dt
        for m in self.motes:
            m["y"] -= m["sp"] * dt
            m["x"] += m["drift"] * dt
            if m["y"] < -6:
                m["y"] = self.h + 6
                m["x"] = random.uniform(0, self.w)
            if m["x"] < -6:
                m["x"] = self.w + 6
            elif m["x"] > self.w + 6:
                m["x"] = -6

    def draw(self, surf: pygame.Surface) -> None:
        self.retheme()
        surf.blit(self.base, (0, 0))

        add = pygame.BLEND_ADD
        k = self.intensity

        # Brightness is baked into the sprite at generation time rather than applied with
        # set_alpha, because an additive blit ignores alpha entirely. `glow` quantises the peak so
        # a slowly changing brightness reuses a small ramp of cached sprites.
        for b in self.blobs:
            x = b["cx"] + math.cos(self.t * b["sx"] * math.tau + b["phase"]) * b["ax"]
            y = b["cy"] + math.sin(self.t * b["sy"] * math.tau + b["phase"]) * b["ay"]
            g = assets.glow(b["r"], b["color"], falloff=2.6, peak=int(b["alpha"] * k))
            surf.blit(g, (int(x - b["r"]), int(y - b["r"])), special_flags=add)

        for m in self.motes:
            g = assets.glow(int(m["r"] * 2.4), m["c"], falloff=1.5, peak=int(m["a"] * k))
            surf.blit(g, (int(m["x"]), int(m["y"])), special_flags=add)

    def draw_vignette(self, surf: pygame.Surface) -> None:
        surf.blit(self.vignette, (0, 0))
