"""
The main menu.

Its whole job is to look like a finished game in the first half second, so it leads with the
wordmark and the player's own numbers rather than with a list of options. The demo snake drifting
behind it is the real snake with the real skin the player has selected, which doubles as a
preview and means the menu is never the same twice.
"""

from __future__ import annotations

import math

import pygame

from .. import assets, fonts, theme, ui
from ..config import GAME_H, GAME_W
from .common import ChromeScene, stat_tile


class MenuScene(ChromeScene):
    heading = None
    demo_alpha = 0.40

    def build(self):
        self.group.clear()
        x, y = 96, 306
        w, h = 330, 62
        gap = 74

        # Labelled, because the mode and the skin can both legitimately be called "CLASSIC" and
        # "CLASSIC · CLASSIC" tells the player nothing about which is which.
        self.group.add(ui.Button((x, y, w, h), "PLAY", self._play,
                                color=theme.ACCENT, size=30,
                                sub=f"{theme.mode(self._last_mode()).name} MODE"
                                    f"  ·  {theme.skin(self._skin()).name} SKIN"))
        self.group.add(ui.Button((x, y + gap, w, h), "MODES", self._modes,
                                color=theme.GOLD, size=24))
        self.group.add(ui.Button((x, y + gap * 2, w, h), "SKINS", self._skins,
                                color=theme.ACCENT_2, size=24))
        self.group.add(ui.Button((x, y + gap * 3, w, h), "SETTINGS", self._settings,
                                color=theme.TEXT_DIM, size=24))
        self.group.add(ui.Button((x, y + gap * 4, w, h), "QUIT", self.app.quit,
                                color=theme.TEXT_FAINT, size=20))

    # ── data ────────────────────────────────────────────────────────────────
    def _skin(self):
        return self.app.save.data.get("skin", theme.DEFAULT_SKIN)

    def _last_mode(self):
        return self.app.save.data.get("last_mode", theme.DEFAULT_MODE)

    # ── actions ─────────────────────────────────────────────────────────────
    def _play(self):
        from .play import PlayScene
        self.app.switch(PlayScene(self.app), mode_key=self._last_mode())

    def _modes(self):
        from .modes import ModesScene
        self.go(ModesScene)

    def _skins(self):
        from .skins import SkinsScene
        self.go(SkinsScene)

    def _settings(self):
        from .settings import SettingsScene
        self.go(SettingsScene)

    def on_escape(self):
        self.app.quit()

    # ── drawing ─────────────────────────────────────────────────────────────
    def draw_content(self, surf):
        save = self.app.save

        # Wordmark. Sits high and left so the drifting snake has the right side of the frame.
        dy, alpha = ui.appear_offset(self.t, 0.0, 40)
        pulse = 0.5 + 0.5 * math.sin(self.t * 1.2)
        logo_rect = fonts.render_tracked("NEON COIL", 92, theme.TEXT, True, 9.0).get_rect(
            topleft=(92, 132 + dy))
        halo = assets.glow(int(logo_rect.w * 0.56), theme.ACCENT, falloff=3.2,
                           peak=int((44 + 18 * pulse) * alpha / 255))
        surf.blit(halo, halo.get_rect(center=logo_rect.center), special_flags=pygame.BLEND_ADD)
        fonts.draw(surf, "NEON COIL", (92, 132 + dy), 92, theme.TEXT, anchor="topleft",
                   tracking=9.0, glow=theme.ACCENT, glow_alpha=int(120 * alpha / 255),
                   alpha=alpha, shadow=4)

        # Clear of the wordmark's descenders: at 92px the logo occupies about 122 vertical
        # pixels, so a strapline at 232 sat inside it.
        dy2, alpha2 = ui.appear_offset(self.t, 0.08, 26)
        fonts.draw(surf, "STEER  ·  COLLECT  ·  DO NOT TOUCH ANYTHING",
                   (96, 258 + dy2), 17, theme.ACCENT, anchor="topleft",
                   bold=False, tracking=4.4, alpha=alpha2)

        self._draw_group_staggered(surf)

        # Right-hand column: the player's record.
        self._draw_records(surf)

    def _draw_group_staggered(self, surf):
        """Draw buttons with a per-item entrance without moving their real hitboxes.

        The rects stay put so the mouse always hits what it looks like it should — only the
        rendered position is offset, and only for the third of a second the entrance lasts.
        """
        for i, w in enumerate(self.group.widgets):
            off, a = ui.appear_offset(self.t, 0.14 + i * 0.055, 34)
            if abs(off) < 0.4 and a >= 255:
                w.draw(surf)
                continue
            ui.slide_in(surf, w.rect, w.draw, dy=off, alpha=a)

    def _draw_records(self, surf):
        save = self.app.save
        dy, alpha = ui.appear_offset(self.t, 0.30, 34)
        if alpha <= 2:
            return

        # Laid out from a running cursor and sized to the result, rather than from a guessed
        # height. The first version was a fixed 320px and its content needed 374, so the stat
        # tiles and the unlock bar spilled through the bottom of the card and over each other.
        PAD = 26
        ROW_H = 36
        TILE_H = 62
        TILE_GAP = 12

        inner_w = 334 - PAD * 2
        content_h = (
            22                                  # section label
            + ROW_H * len(theme.MODES)          # per-mode bests
            + 18                                # divider
            + TILE_H * 2 + TILE_GAP             # two rows of tiles
            + 42                                # unlock bar and its caption
        )
        panel_rect = pygame.Rect(GAME_W - 430, 290, 334, content_h + PAD * 2)

        # The panel is composed on a scratch layer so the whole card slides and fades as one
        # image. Only the card's own area is touched; 80px of margin covers the text glows.
        with ui.sliding(surf, panel_rect.inflate(80, 80), dy=dy, alpha=alpha) as layer:
            ui.panel(layer, panel_rect, radius=20, accent=theme.PANEL_LINE)

            y = panel_rect.y + PAD
            ui.section_label(layer, "YOUR RECORD", (panel_rect.x + PAD, y + 6))
            y += 22

            for m in theme.MODES:
                best = save.high_score(m.key)
                fonts.draw(layer, m.name, (panel_rect.x + PAD, y + ROW_H // 2), 17, theme.TEXT_DIM,
                           anchor="midleft", bold=False, tracking=1.4)
                fonts.draw(layer, f"{best:,}", (panel_rect.right - PAD, y + ROW_H // 2), 22, m.color,
                           anchor="midright", tracking=0.8,
                           glow=m.color if best else None, glow_alpha=40)
                y += ROW_H

            line = pygame.Surface((inner_w, 1), pygame.SRCALPHA)
            line.fill((*theme.PANEL_LINE, 170))
            layer.blit(line, (panel_rect.x + PAD, y + 8))
            y += 18

            tw = (inner_w - TILE_GAP) // 2
            tiles = (
                ("LONGEST", save.data.get("best_length", 0), theme.GREEN),
                ("BEST COMBO", f"x{save.data.get('best_combo', 0)}", theme.ACCENT_2),
                ("RUNS", save.data.get("games_played", 0), theme.TEXT_DIM),
                ("ORBS", save.data.get("total_food", 0), theme.PICKUPS["food"].color),
            )
            for i, (label, value, color) in enumerate(tiles):
                tx = panel_rect.x + PAD + (i % 2) * (tw + TILE_GAP)
                ty = y + (i // 2) * (TILE_H + TILE_GAP)
                stat_tile(layer, (tx, ty, tw, TILE_H), label, value, color)
            y += TILE_H * 2 + TILE_GAP + 16

            unlocked = len(save.data.get("unlocked_skins", []))
            total = len(theme.SKINS)
            fonts.draw(layer, f"{unlocked} / {total} SKINS", (panel_rect.x + PAD, y), 12,
                       theme.TEXT_FAINT, anchor="topleft", tracking=2.0, shadow=1)
            ui.progress_bar(layer, pygame.Rect(panel_rect.x + PAD, y + 18, inner_w, 8),
                            unlocked / total, theme.GOLD)


    def footer_hint(self):
        return "ARROWS / WASD  MOVE      ENTER  SELECT      F11  FULLSCREEN      ESC  QUIT"
