"""
The animated backdrop, shared by every screen.

The brief for this is narrow and it pulls in two directions: the background has to have real
depth and motion, and it must never once make the snake or a pickup harder to see. So the
whole thing is built from layers that are large, slow and low-contrast, and the brightest thing
it ever produces is still darker than the dimmest thing gameplay draws.

Layers, back to front:

1. a vertical wash from near-black to a lifted indigo
2. a soft pool of light in the middle, which gives the arena a centre
3. two parallax grids at different scales, drifting at different speeds
4. large blurred blobs orbiting on long slow paths
5. drifting motes
6. a vignette to close the corners down

Only what is genuinely static is cached: the gradient and the pool of light, flattened into one
opaque surface at construction. Everything that moves is drawn live.

That is worth recording, because the first version cached the moving layers too and refreshed the
composite every fourth frame. It was slower — 8.0 ms per frame against 6.2 ms for drawing the
layers outright — and it hitched, because the refresh frame cost 4.3 ms while its neighbours cost
0.5 ms. Blitting a full-screen cache and then periodically rebuilding it is more work than the
handful of blits it was standing in for.
"""

from __future__ import annotations

import math
import random
import sys

import pygame

from . import assets, theme

#: The browser draws far fewer moving lights than the desktop, and that is not a small tuning
#: knob — it is the difference between 20 fps and 60.
#:
#: Measured from inside Chrome on the sister project: a frame costing 2.9 ms natively cost 50 ms in
#: WebAssembly, a 17x multiplier rather than the 3-6x that interpreter work sees. pygame-ce's wasm
#: build has no vectorised blitters, so every full-screen alpha pass is punishing while ordinary
#: Python is merely slower. This backdrop had four of them a frame — two scrolling grids, a
#: vignette, and the wash — plus fifty additive glows.
#:
#: So on the web: the vignette and the slow blobs are flattened into the one opaque surface the
#: frame already blits, the far grid goes with them, and the near grid keeps scrolling because the
#: parallax is most of what makes this backdrop feel like anything.
_ON_WEB = sys.platform == "emscripten"
MOTE_COUNT = 12 if _ON_WEB else 46


class Backdrop:
    """A living background.

    `intensity` scales the animated layers so the same object can be bright and busy behind a
    menu and pulled right back behind gameplay, without maintaining two of them.
    """

    def __init__(self, size, *, intensity: float = 1.0, seed: int = 7, blobs: int = 5):
        self.w, self.h = int(size[0]), int(size[1])
        self.intensity = intensity
        self.t = 0.0
        rng = random.Random(seed)

        base = assets.vertical_gradient((self.w, self.h), theme.BG_DEEP, theme.BG_MID)
        wash = assets.radial_wash((self.w, self.h), (self.w * 0.5, self.h * 0.46),
                                  self.w * 0.62, theme.BG_RIM, peak=110)
        self.base = base.copy()
        self.base.blit(wash, (0, 0))
        self.vignette = assets.vignette((self.w, self.h), 195)

        self.grid_far = self._grid(96, theme.GRID, 26)
        self.grid_near = self._grid(32, theme.GRID, 15)
        self.blob_count = max(0, int(blobs))

        # Blobs: big, slow, and few. Each has its own orbit so they never form a pattern.
        self.blobs = []
        for i in range(max(0, int(blobs))):
            radius = rng.randint(150, 260)
            self.blobs.append({
                "r": radius,
                "color": rng.choice(
                    (theme.ACCENT, theme.ACCENT_2, (120, 90, 255), (60, 200, 220))),
                "cx": rng.uniform(0.1, 0.9) * self.w,
                "cy": rng.uniform(0.1, 0.9) * self.h,
                "ax": rng.uniform(40, 130),
                "ay": rng.uniform(30, 90),
                "sx": rng.uniform(0.045, 0.13) * (1 if i % 2 else -1),
                "sy": rng.uniform(0.035, 0.11) * (1 if i % 3 else -1),
                "phase": rng.uniform(0, math.tau),
                "alpha": rng.randint(16, 30),
            })

        self.motes = []
        for _ in range(MOTE_COUNT):
            self.motes.append({
                "x": rng.uniform(0, self.w),
                "y": rng.uniform(0, self.h),
                "r": rng.uniform(1.4, 3.4),
                "sp": rng.uniform(5.0, 20.0),
                "drift": rng.uniform(-9.0, 9.0),
                "a": rng.randint(30, 90),
                "c": rng.choice((theme.ACCENT, (170, 180, 255), theme.ACCENT_2)),
            })

        if _ON_WEB:
            self._flatten_for_web()

    def _flatten_for_web(self) -> None:
        """Bake everything that does not need to move into the one opaque blit a frame already has.

        The vignette never changes. The far grid scrolls at 7 px/s, which is slow enough that a
        fixed offset reads the same in motion. The blobs orbit at 0.045-0.13 Hz and are wider than
        their own travel, so freezing them is invisible. What is left moving is the near grid and a
        dozen motes — which is what the parallax was actually made of.
        """
        self.base.blit(self.grid_far, (0, 0))
        # The near grid goes in too. It scrolls at 15 px/s and losing that is a real loss, but it
        # is a 1312x816 alpha blit — larger than the screen — and at wasm blit prices that is most
        # of a frame. The motes and the snake still move, so the menu is not static.
        self.base.blit(self.grid_near, (0, 0))
        for b in self.blobs:
            g = assets.glow(b["r"], b["color"], falloff=2.6, peak=int(b["alpha"] * self.intensity))
            self.base.blit(g, (int(b["cx"] - b["r"]), int(b["cy"] - b["r"])),
                           special_flags=pygame.BLEND_ADD)
        self.base.blit(self.vignette, (0, 0))
        self.blobs = []

    def _grid(self, cell: int, color: tuple, alpha: int) -> pygame.Surface:
        """One tile of grid, sized so it can be scrolled and wrapped cheaply.

        The surface is a full screen plus one cell of overhang in each direction; scrolling
        modulo the cell size then covers the screen at any offset with a single blit.
        """
        surf = pygame.Surface((self.w + cell, self.h + cell), pygame.SRCALPHA)
        c = (*color, alpha)
        for x in range(0, self.w + cell + 1, cell):
            pygame.draw.line(surf, c, (x, 0), (x, self.h + cell))
        for y in range(0, self.h + cell + 1, cell):
            pygame.draw.line(surf, c, (0, y), (self.w + cell, y))
        return surf

    def update(self, dt: float):
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

    def draw(self, surf: pygame.Surface):
        # The static ground: gradient and centre light, pre-flattened into one opaque blit.
        surf.blit(self.base, (0, 0))

        add = pygame.BLEND_ADD
        k = self.intensity

        # Two grids, opposite directions, different speeds — parallax without a camera.
        if not _ON_WEB:
            gx = int((self.t * 7.0) % 96)
            gy = int((self.t * 4.0) % 96)
            surf.blit(self.grid_far, (-gx, -gy))
            gx = int((-self.t * 15.0) % 32)
            gy = int((self.t * 9.0) % 32)
            surf.blit(self.grid_near, (-gx, -gy))

        # Blobs. Brightness baked at generation time; see assets.glow.
        for b in self.blobs:
            x = b["cx"] + math.cos(self.t * b["sx"] * math.tau + b["phase"]) * b["ax"]
            y = b["cy"] + math.sin(self.t * b["sy"] * math.tau + b["phase"]) * b["ay"]
            surf.blit(assets.glow(b["r"], b["color"], falloff=2.6, peak=int(b["alpha"] * k)),
                      (int(x - b["r"]), int(y - b["r"])), special_flags=add)

        for m in self.motes:
            g = assets.glow(int(m["r"] * 2.4), m["c"], falloff=1.5, peak=int(m["a"] * k))
            surf.blit(g, (int(m["x"]), int(m["y"])), special_flags=add)

    def draw_vignette(self, surf: pygame.Surface):
        # Already part of the ground on the web — see `_flatten_for_web`. Callers need not know.
        if _ON_WEB:
            return
        surf.blit(self.vignette, (0, 0))


class ArenaFrame:
    """The playfield border: a glowing inset rounded rectangle.

    Generated once into two surfaces — the fill and the glow — because it is static and redrawing
    a supersampled rounded rect every frame for the sake of a border would be absurd.
    """

    def __init__(self, rect):
        self.rect = pygame.Rect(int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3]))
        pad = 26
        w, h = self.rect.w + pad * 2, self.rect.h + pad * 2
        self.offset = (self.rect.x - pad, self.rect.y - pad)

        SS = assets.SS
        rad = 18

        frame = pygame.Surface((w * SS, h * SS), pygame.SRCALPHA)
        pygame.draw.rect(frame, (*theme.WALL, 235),
                         (pad * SS, pad * SS, self.rect.w * SS, self.rect.h * SS),
                         width=7 * SS, border_radius=rad * SS)
        pygame.draw.rect(frame, (*theme.WALL_GLOW, 160),
                         (pad * SS, pad * SS, self.rect.w * SS, self.rect.h * SS),
                         width=2 * SS, border_radius=rad * SS)
        self.frame = pygame.transform.smoothscale(frame, (w, h))

        # A wide, faint copy of the same shape, blitted additively behind: the bloom.
        halo = pygame.Surface((w * SS, h * SS), pygame.SRCALPHA)
        for i, a in enumerate((26, 20, 13)):
            grow = (i + 1) * 5
            pygame.draw.rect(halo, (*theme.WALL_GLOW, a),
                             ((pad - grow) * SS, (pad - grow) * SS,
                              (self.rect.w + grow * 2) * SS, (self.rect.h + grow * 2) * SS),
                             width=int(4.5 * SS), border_radius=(rad + grow) * SS)
        self.halo = assets.premultiply(pygame.transform.smoothscale(halo, (w, h)))

        # The interior, very slightly lifted, so the playfield separates from the surround.
        inner = pygame.Surface((self.rect.w * SS, self.rect.h * SS), pygame.SRCALPHA)
        pygame.draw.rect(inner, (26, 22, 62, 92), (0, 0, self.rect.w * SS, self.rect.h * SS),
                         border_radius=(rad - 3) * SS)
        self.inner = pygame.transform.smoothscale(inner, (self.rect.w, self.rect.h))

    def draw_under(self, surf: pygame.Surface):
        surf.blit(self.inner, self.rect.topleft)

    def draw_over(self, surf: pygame.Surface, pulse: float = 0.0):
        surf.blit(self.halo, self.offset, special_flags=pygame.BLEND_ADD)
        surf.blit(self.frame, self.offset)
        if pulse > 0.01:
            # Flares when the snake grazes a wall or the level changes. Drawn by repeating the
            # premultiplied halo rather than by fading a copy, since alpha does not scale an
            # additive blit.
            for _ in range(1 + int(2 * min(1.0, pulse))):
                surf.blit(self.halo, self.offset, special_flags=pygame.BLEND_ADD)
