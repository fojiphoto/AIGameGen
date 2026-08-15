"""The main menu: the logo, four ways in, and the player's record."""

from __future__ import annotations

import math

import pygame

from .. import audio, fonts, theme, tiles, ui
from ..config import GAME_H, GAME_W
from .common import ChromeScene


class MenuScene(ChromeScene):
    show_back = False

    def build(self):
        cx = GAME_W // 2
        self.group.add(ui.Button(pygame.Rect(cx - 170, 620, 340, 84), "PLAY",
                                 self._play, color=theme.GREEN, size=32))
        self.group.add(ui.Button(pygame.Rect(cx - 170, 716, 340, 68), "CHALLENGE",
                                 self._challenge, color=theme.ACCENT_2, sub=None))
        self.group.add(ui.Button(pygame.Rect(cx - 170, 796, 340, 68), "THEMES",
                                 self._themes, color=theme.ACCENT))
        self.group.add(ui.Button(pygame.Rect(cx - 170, 876, 340, 68), "SETTINGS",
                                 self._settings, color=theme.TEXT_DIM))

    def _play(self):
        from .play import PlayScene
        self.go(PlayScene, mode_key="endless")

    def _challenge(self):
        from .play import PlayScene
        self.go(PlayScene, mode_key="challenge")

    def _themes(self):
        from .themes import ThemesScene
        self.go(ThemesScene)

    def _settings(self):
        from .settings import SettingsScene
        self.go(SettingsScene)

    def draw_content(self, surf):
        dy, alpha = ui.appear_offset(self.t, 0.0, 26)

        # The logo, as two words on two lines: BLOCK BLOOM at one size across 720px would either be
        # small or touch both edges, and stacking gives the title more presence than either.
        ui.title(surf, "BLOCK", (GAME_W // 2, 300 + dy), size=82, accent=theme.ACCENT)
        ui.title(surf, "BLOOM", (GAME_W // 2, 382 + dy), size=82, accent=theme.ACCENT_2)
        fonts.draw(surf, "FIT  ·  FILL  ·  CLEAR", (GAME_W // 2, 442 + dy), 15, theme.TEXT_DIM,
                   anchor="center", bold=False, tracking=6.0, alpha=alpha)

        # A live strip of tiles under the wordmark: an advert for the tile art, and the quickest
        # possible answer to "what is this game".
        self._draw_strip(surf, 500 + dy, alpha)

        self.draw_group_staggered(surf, delay=0.12, gap=0.05)
        self._draw_record(surf)
        self.coin_readout(surf)

    def _draw_strip(self, surf, y: int, alpha: int) -> None:
        size, gap = 46, 8
        n = 7
        total = n * size + (n - 1) * gap
        x0 = (GAME_W - total) // 2
        for i in range(n):
            # A shallow travelling wave, so the strip reads as alive without drawing the eye off
            # the buttons below it.
            lift = math.sin(self.t * 2.4 - i * 0.55) * 5.0
            x = x0 + i * (size + gap)
            spr = tiles.tile(size, theme.block_color(i), shadow=False)
            if alpha < 255:
                spr = spr.copy()
                spr.set_alpha(alpha)
            surf.blit(spr, (x, int(y + lift)))

    def _draw_record(self, surf) -> None:
        save = self.app.save
        dy, alpha = ui.appear_offset(self.t, 0.34, 26)
        if alpha <= 2:
            return
        # 112, not 96: at 96 the objectives line sat directly against the descenders of the score
        # above it. Three stacked labels need room for three, not two and a squeeze.
        card = pygame.Rect(0, 0, 340, 112)
        card.center = (GAME_W // 2, 998)
        # Once the entrance has settled there is nothing to slide and nothing to fade, so the
        # scratch layer is pure overhead — a clear and a blit of 410x182 pixels, every frame,
        # forever. The buttons already skipped it; this did not.
        settled = abs(dy) < 0.4 and alpha >= 255
        with ui.nothing(surf) if settled else ui.sliding(
                surf, card.inflate(70, 70), dy=dy, alpha=alpha) as layer:
            ui.panel(layer, card, radius=20)
            best = save.best_overall()
            fonts.draw(layer, "YOUR BEST", (card.centerx, card.y + 26), 12, theme.TEXT_FAINT,
                       anchor="center", tracking=3.4, shadow=1)
            fonts.draw(layer, f"{best:,}", (card.centerx, card.y + 60), 34, theme.GOLD,
                       anchor="center", tracking=1.6)
            done = save.challenge_index
            fonts.draw(layer, f"{done}/{len(theme.CHALLENGES)} OBJECTIVES",
                       (card.centerx, card.bottom - 20), 12, theme.TEXT_DIM,
                       anchor="center", bold=False, tracking=2.4, shadow=1)

    def footer_hint(self):
        return "DRAG BLOCKS ONTO THE BOARD      ESC  QUIT"

    def handle(self, event):
        if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
            self.app.quit()
            return
        super().handle(event)
