"""
Shared furniture for the non-gameplay screens.

Every menu in the game is the same object with a different middle: an animated backdrop, a
drifting decorative snake behind everything, a header, and a focus group. `ChromeScene` holds
all of that so each screen only has to describe its own content and its own layout.

`DemoSnake` is the reason the menu does not look static. It is the real `Snake` class steered by
a small autonomous pilot, so the movement on the title screen is literally the movement in the
game — which is both cheaper than a bespoke animation and more honest as a preview.
"""

from __future__ import annotations

import math
import random

import pygame

from .. import assets, audio, fonts, theme, ui
from ..app import Scene
from ..background import Backdrop
from ..config import GAME_H, GAME_W
from ..entities import Snake
from ..fx import Particles


class DemoSnake:
    """An autonomous snake for menu backdrops.

    Wanders towards a slowly moving point of interest, re-picking whenever it arrives or gets
    close to an edge. Uses the game's own steering, so it curves exactly the way the player's
    snake does.
    """

    def __init__(self, skin_key: str, bounds: pygame.Rect, *, length: int = 30, seed: int = 3):
        self.rng = random.Random(seed)
        self.bounds = bounds
        self.snake = Snake(bounds.centerx, bounds.centery,
                           self.rng.uniform(0, math.tau), skin_key)
        self.snake.target_segments = self.snake.segments = float(length)
        self.snake.base_speed = 168.0
        self._target = self._pick()
        self._retarget = 0.0

    def _pick(self):
        pad = 120
        return (self.rng.uniform(self.bounds.left + pad, self.bounds.right - pad),
                self.rng.uniform(self.bounds.top + pad, self.bounds.bottom - pad))

    def set_skin(self, key: str):
        self.snake.skin_key = key

    def update(self, dt: float):
        s = self.snake
        self._retarget -= dt
        dx, dy = self._target[0] - s.x, self._target[1] - s.y
        if dx * dx + dy * dy < 130 ** 2 or self._retarget <= 0.0:
            self._target = self._pick()
            self._retarget = self.rng.uniform(2.4, 4.8)

        # Steer for the target, but bend away from whichever wall is closest. Without this it
        # spends most of its time grinding along an edge.
        ax, ay = dx, dy
        margin = 150.0
        if s.x - self.bounds.left < margin:
            ax += (margin - (s.x - self.bounds.left)) * 2.2
        if self.bounds.right - s.x < margin:
            ax -= (margin - (self.bounds.right - s.x)) * 2.2
        if s.y - self.bounds.top < margin:
            ay += (margin - (s.y - self.bounds.top)) * 2.2
        if self.bounds.bottom - s.y < margin:
            ay -= (margin - (self.bounds.bottom - s.y)) * 2.2

        s.steer_to(ax, ay)
        s.update(dt)
        s.look_at(self._target)
        s.clamp_into(self.bounds)

    def draw(self, surf: pygame.Surface, alpha: float = 0.42):
        """Drawn onto its own layer and faded, so it sits clearly behind the interface.

        This one really does cover the screen — the snake drifts anywhere in it — so unlike the
        widget layers there is no smaller region to restrict it to. It still goes through the
        pool, which saves the 0.86 ms an allocation costs.
        """
        full = surf.get_rect()
        ui.slide_in(surf, full, self.snake.draw, alpha=int(255 * alpha), bleed=full)


class ChromeScene(Scene):
    """Base for menus: backdrop, decorative snake, header, focus group, entrance animation."""

    #: Shown top-left under the title. None hides the header entirely.
    heading: str | None = None
    subheading: str | None = None
    show_demo_snake = True
    demo_alpha = 0.34

    def __init__(self, app):
        super().__init__(app)
        self.backdrop = Backdrop((GAME_W, GAME_H), intensity=1.0, seed=11)
        self.particles = Particles(240)
        self.group = ui.Group()
        self.demo = DemoSnake(app.save.data.get("skin", theme.DEFAULT_SKIN),
                              pygame.Rect(0, 0, GAME_W, GAME_H), length=34, seed=5)
        self._mote_timer = 0.0

    # ── lifecycle ───────────────────────────────────────────────────────────
    def enter(self, **kwargs):
        self.t = 0.0
        self.particles.enabled = self.app.save.settings.get("particles", True)
        self.demo.set_skin(self.app.save.data.get("skin", theme.DEFAULT_SKIN))
        audio.duck_music(True)
        self.build()

    def build(self):
        """Subclasses create their widgets here. Called on every enter."""
        self.group.clear()

    def go(self, scene_cls, **kwargs):
        self.app.switch(scene_cls(self.app), **kwargs)

    def back(self):
        from .menu import MenuScene
        self.go(MenuScene)

    # ── loop ────────────────────────────────────────────────────────────────
    def handle(self, event):
        if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
            audio.click()
            self.on_escape()
            return
        if self.group.handle(event):
            return
        self.on_event(event)

    def on_escape(self):
        self.back()

    def on_event(self, event):
        pass

    def update(self, dt: float):
        self.t += dt
        self.backdrop.update(dt)
        if self.show_demo_snake:
            self.demo.update(dt)
        self.particles.update(dt)
        self._mote_timer -= dt
        if self._mote_timer <= 0.0:
            self._mote_timer = 0.22
            self.particles.motes((0, GAME_H * 0.55, GAME_W, GAME_H * 0.5), 2,
                                 random.choice((theme.ACCENT, theme.ACCENT_2)))
        self.group.update(dt, self.app.mouse, self.app.mouse_down)
        self.on_update(dt)

    def on_update(self, dt):
        pass

    def draw(self, surf: pygame.Surface):
        self.backdrop.draw(surf)
        if self.show_demo_snake:
            self.demo.draw(surf, self.demo_alpha)
        self.particles.draw(surf)
        self.draw_content(surf)
        self.backdrop.draw_vignette(surf)
        self.draw_footer(surf)

    def draw_content(self, surf):
        pass

    def draw_header(self, surf, *, accent=None):
        if not self.heading:
            return
        dy, alpha = ui.appear_offset(self.t, 0.0, 26)
        ui.section_label(surf, "NEON COIL", (58, 52 + dy))
        fonts.draw(surf, self.heading, (56, 78 + dy), 46, theme.TEXT,
                   anchor="topleft", tracking=5.0, glow=accent or theme.ACCENT,
                   glow_alpha=int(80 * alpha / 255), alpha=alpha)
        if self.subheading:
            fonts.draw(surf, self.subheading, (58, 132 + dy), 17, theme.TEXT_DIM,
                       anchor="topleft", bold=False, tracking=0.8, alpha=alpha)

    def draw_footer(self, surf, hint: str | None = None):
        text = hint or self.footer_hint()
        if not text:
            return
        fonts.draw(surf, text, (GAME_W // 2, GAME_H - 26), 14, theme.TEXT_FAINT,
                   anchor="center", bold=False, tracking=2.0, shadow=1)

    def footer_hint(self) -> str | None:
        return "ARROWS / WASD  MOVE      ENTER  SELECT      ESC  BACK"


def back_button(rect, on_click) -> ui.Button:
    return ui.Button(rect, "BACK", on_click, color=theme.TEXT_DIM, size=20)


def stat_tile(surf, rect, label, value, color):
    """A small labelled figure. Used on the menu and the game-over screen."""
    r = pygame.Rect(rect)
    surf.blit(assets.rounded_panel(r.w, r.h, 14, theme.PANEL_HI,
                                   theme.shade(theme.PANEL, -0.1), theme.PANEL_LINE, 2, 232),
              r.topleft)
    fonts.draw(surf, str(value), (r.centerx, r.centery - 7), 30, color,
               anchor="center", tracking=1.0, glow=color, glow_alpha=52)
    fonts.draw(surf, label, (r.centerx, r.bottom - 17), 12, theme.TEXT_FAINT,
               anchor="center", tracking=2.2, shadow=1)
