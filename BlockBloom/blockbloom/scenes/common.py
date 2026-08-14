"""
The shared furniture every non-gameplay screen sits on.

`ChromeScene` owns the backdrop, the drifting decorative blocks, a header, a focus group and the
staggered entrance. A screen that subclasses it writes `draw_content` and a list of widgets, and
gets a consistent frame for free — which is what stops five screens each inventing their own
margins and their own idea of where a title goes.
"""

from __future__ import annotations

import math
import random

import pygame

from .. import assets, audio, fonts, theme, tiles, ui
from ..app import Scene
from ..background import Backdrop
from ..config import GAME_H, GAME_W
from ..fx import Floaters, Particles


class DriftingBlocks:
    """Slowly tumbling tiles behind the interface.

    Decoration, but specific decoration: the menu of a block puzzle should have blocks in it. They
    are large, slow, and dimmed hard, so they read as depth rather than as content — a bright tile
    drifting behind a button looks like a bug in the layout.

    Rotation is what makes them feel alive, and it is also the cost: `rotozoom` allocates. So each
    block holds its rotated sprite and only regenerates it when its angle has moved a whole step,
    which turns a per-frame allocation into one every twenty-odd frames.
    """

    ANGLE_STEP = 6.0

    def __init__(self, count: int = 7, seed: int = 3):
        rng = random.Random(seed)
        self.items = []
        for i in range(count):
            self.items.append({
                "x": rng.uniform(-40, GAME_W + 40),
                "y": rng.uniform(-40, GAME_H + 40),
                "size": rng.randint(52, 104),
                "ci": rng.randrange(7),
                "angle": rng.uniform(0, 360),
                "spin": rng.uniform(-9.0, 9.0),
                "vy": rng.uniform(-15.0, -5.0),
                "vx": rng.uniform(-6.0, 6.0),
                "alpha": rng.randint(40, 70),
                "cached_at": None,
                "sprite": None,
            })
        self._theme_key = theme.current.key

    def update(self, dt: float) -> None:
        for b in self.items:
            b["angle"] = (b["angle"] + b["spin"] * dt) % 360.0
            b["y"] += b["vy"] * dt
            b["x"] += b["vx"] * dt
            if b["y"] < -140:
                b["y"] = GAME_H + 120
                b["x"] = random.uniform(-40, GAME_W + 40)
            if b["x"] < -140:
                b["x"] = GAME_W + 120
            elif b["x"] > GAME_W + 140:
                b["x"] = -120

    def draw(self, surf: pygame.Surface) -> None:
        if self._theme_key != theme.current.key:
            # The tiles are theme-coloured, so a theme change invalidates every cached rotation.
            self._theme_key = theme.current.key
            for b in self.items:
                b["sprite"] = None
                b["cached_at"] = None

        for b in self.items:
            step = round(b["angle"] / self.ANGLE_STEP)
            if b["sprite"] is None or b["cached_at"] != step:
                base = tiles.tile(b["size"], theme.block_color(b["ci"]),
                                  shadow=False)
                spr = pygame.transform.rotozoom(base, step * self.ANGLE_STEP, 1.0)
                spr.set_alpha(b["alpha"])
                b["sprite"] = spr
                b["cached_at"] = step
            spr = b["sprite"]
            surf.blit(spr, spr.get_rect(center=(int(b["x"]), int(b["y"]))))


class ChromeScene(Scene):
    """Base for every screen that is not the board."""

    heading: str | None = None
    subheading: str | None = None
    show_blocks = True
    #: Screens that own the whole width (the menu) hide the back button; the rest show one.
    show_back = True

    def __init__(self, app):
        super().__init__(app)
        self.backdrop = Backdrop((GAME_W, GAME_H), intensity=1.0, seed=11, blobs=5)
        self.blocks = DriftingBlocks()
        self.particles = Particles(240)
        self.floaters = Floaters()
        self.group = ui.Group()
        self.build()

    # ── subclass hooks ──────────────────────────────────────────────────────────
    def build(self) -> None:
        """Create widgets. Called once, from __init__."""

    def draw_content(self, surf: pygame.Surface) -> None:
        """Draw everything above the backdrop and below the footer."""

    def footer_hint(self) -> str | None:
        return None

    # ── plumbing ────────────────────────────────────────────────────────────────
    def enter(self, **kwargs):
        self.t = 0.0
        self.group.focus(None)

    def leave(self):
        self.app.save.flush()

    def handle(self, event):
        self.group.handle(event)

    def update(self, dt: float):
        self.t += dt
        self.backdrop.update(dt)
        if self.show_blocks:
            self.blocks.update(dt)
        self.particles.update(dt)
        self.floaters.update(dt)
        self.group.update(dt, self.app.mouse, self.app.mouse_down)

    def draw(self, surf: pygame.Surface):
        self.backdrop.draw(surf)
        if self.show_blocks:
            self.blocks.draw(surf)
        self.backdrop.draw_vignette(surf)
        self.draw_content(surf)
        self.particles.draw(surf)
        self.floaters.draw(surf, fonts)
        hint = self.footer_hint()
        if hint:
            fonts.draw(surf, hint, (GAME_W // 2, GAME_H - 26), 13, theme.TEXT_FAINT,
                       anchor="center", bold=False, tracking=2.2, shadow=1)

    # ── shared drawing ──────────────────────────────────────────────────────────
    def draw_header(self, surf: pygame.Surface, *, accent=None) -> None:
        if not self.heading:
            return
        accent = accent or theme.ACCENT
        dy, alpha = ui.appear_offset(self.t, 0.02, 22)
        fonts.draw(surf, self.heading, (GAME_W // 2, 96 + dy), 44, theme.TEXT,
                   anchor="center", tracking=6.0, glow=accent, glow_alpha=70, alpha=alpha)
        if self.subheading:
            fonts.draw(surf, self.subheading, (GAME_W // 2, 136 + dy), 16, theme.TEXT_DIM,
                       anchor="center", bold=False, tracking=1.8, alpha=alpha)

    def draw_group_staggered(self, surf: pygame.Surface, *, delay=0.10, gap=0.055,
                             distance=30) -> None:
        """Draw widgets with a per-item entrance without moving their real hitboxes.

        The rects stay put so the mouse always hits what it looks like it should — only the
        rendered position is offset, and only for the third of a second the entrance lasts.
        """
        for i, w in enumerate(self.group.widgets):
            off, a = ui.appear_offset(self.t, delay + i * gap, distance)
            if abs(off) < 0.4 and a >= 255:
                w.draw(surf)
                continue
            ui.slide_in(surf, w.rect, w.draw, dy=off, alpha=a)

    def coin_readout(self, surf: pygame.Surface, pos=(GAME_W - 30, 44)) -> None:
        """Coins, top right. Present on every screen where they can be spent or earned."""
        coins = self.app.save.coins
        text = f"{coins:,}"
        w, _ = fonts.measure(text, 20, True, 1.4)
        icon = tiles.coin(26)
        right = pos[0]
        fonts.draw(surf, text, (right, pos[1]), 20, theme.GOLD, anchor="midright", tracking=1.4)
        surf.blit(icon, icon.get_rect(midright=(right - w - 10, pos[1])))

    def go(self, scene_factory, **kwargs) -> None:
        """Switch screens behind the wipe, building the target lazily.

        Lazily because constructing a scene generates its backdrop, and doing that at the moment a
        button is *created* rather than when it is pressed would build every screen at startup.
        """
        audio.click()
        self.app.switch(scene_factory(self.app), **kwargs)
