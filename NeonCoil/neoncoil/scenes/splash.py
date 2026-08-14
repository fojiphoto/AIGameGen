"""
The splash screen.

Short — a little under three seconds — and skippable with any key, because a splash a player
cannot dismiss is a splash they resent by the third launch. It exists to do two useful things:
show the logo assembling itself, and cover the one-off cost of generating the sound bank and the
first batch of sprites so the main menu appears instantly.
"""

from __future__ import annotations

import math

import pygame

from .. import assets, audio, fonts, theme
from ..app import Scene
from ..background import Backdrop
from ..config import GAME_H, GAME_W
from ..fx import Particles, ease_out_back, ease_out_cubic

DURATION = 2.7


class SplashScene(Scene):
    def __init__(self, app):
        super().__init__(app)
        self.backdrop = Backdrop((GAME_W, GAME_H), intensity=0.8, seed=3)
        self.particles = Particles(200)
        self._done = False
        self._burst = False

    def enter(self, **kwargs):
        self.t = 0.0
        self.particles.enabled = self.app.save.settings.get("particles", True)
        audio.start_music()

    def _finish(self):
        if self._done:
            return
        self._done = True
        from .menu import MenuScene
        self.app.switch(MenuScene(self.app))

    def handle(self, event):
        if event.type in (pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN):
            self._finish()

    def update(self, dt):
        self.t += dt
        self.backdrop.update(dt)
        self.particles.update(dt)
        if not self._burst and self.t >= 0.75:
            self._burst = True
            self.particles.ring((GAME_W // 2, GAME_H // 2 - 10), 30, theme.ACCENT,
                                radius_speed=(240, 420), size=(4, 9), life=(0.5, 0.9))
            audio.click()
        if self.t >= DURATION:
            self._finish()

    def draw(self, surf):
        self.backdrop.draw(surf)

        cx, cy = GAME_W // 2, GAME_H // 2 - 10

        # A ring closing in, then the wordmark punching out of it.
        ring_k = ease_out_cubic(min(1.0, self.t / 0.75))
        radius = int(300 - 210 * ring_k)
        if radius > 6 and self.t < 1.15:
            bright = (min(1.0, self.t / 0.2) if self.t < 0.9
                      else max(0.0, 1.0 - (self.t - 0.9) / 0.25))
            img = assets.ring(radius, max(2, int(9 * (1.0 - ring_k * 0.6))),
                              assets.dim(theme.ACCENT, bright * 0.86))
            surf.blit(img, img.get_rect(center=(cx, cy)), special_flags=pygame.BLEND_ADD)

        self.particles.draw(surf)

        if self.t >= 0.62:
            k = min(1.0, (self.t - 0.62) / 0.5)
            scale = 0.7 + 0.3 * ease_out_back(k, 2.1)
            alpha = int(255 * min(1.0, k * 2.0))
            size = int(88 * scale)
            tracking = 10.0 + 26.0 * (1.0 - k)
            logo = fonts.render_tracked("NEON COIL", size, theme.TEXT, True, tracking)
            rect = logo.get_rect(center=(cx, cy))
            halo = assets.glow(int(rect.w * 0.6), theme.ACCENT, falloff=3.0, peak=int(72 * k))
            surf.blit(halo, halo.get_rect(center=rect.center), special_flags=pygame.BLEND_ADD)
            fonts.draw(surf, "NEON COIL", (cx, cy), size, theme.TEXT, anchor="center",
                       tracking=tracking, glow=theme.ACCENT, glow_alpha=int(130 * k),
                       alpha=alpha, shadow=3)

        if self.t >= 1.35:
            k = min(1.0, (self.t - 1.35) / 0.45)
            fonts.draw(surf, "A GLOWING ARCADE SERPENT", (cx, cy + 74), 17, theme.TEXT_DIM,
                       anchor="center", bold=False, tracking=6.0, alpha=int(210 * k))

        if self.t >= 1.9:
            pulse = 0.5 + 0.5 * math.sin(self.t * 3.4)
            fonts.draw(surf, "PRESS ANY KEY", (cx, GAME_H - 92), 15,
                       theme.TEXT_FAINT, anchor="center", bold=False, tracking=3.2,
                       alpha=int(120 + 90 * pulse))

        if not audio.is_enabled() and self.t > 1.6:
            fonts.draw(surf, "NO AUDIO DEVICE — PLAYING SILENT", (GAME_W // 2, GAME_H - 34),
                       12, theme.TEXT_FAINT, anchor="center", bold=False, tracking=1.6)

        self.backdrop.draw_vignette(surf)
