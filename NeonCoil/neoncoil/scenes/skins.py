"""
Skin selection.

A grid of tiles, each showing a real coiled preview of that skin drawn with the game's own
sprites rather than a swatch — the point of a skin is what it looks like in motion, and a
rectangle of colour undersells every one of them.

Locked skins are shown, not hidden. Seeing what you are playing towards is the entire reason an
unlock ladder works; a grid of question marks is just a shorter grid.
"""

from __future__ import annotations

import math

import pygame

from .. import assets, fonts, theme, ui
from ..config import GAME_H, GAME_W
from .common import ChromeScene, back_button


class SkinsScene(ChromeScene):
    heading = "SNAKE SKINS"
    show_demo_snake = True
    demo_alpha = 0.16

    def build(self):
        self.group.clear()
        cols, rows = 4, 2
        tile = 176
        gap = 22
        total_w = cols * tile + (cols - 1) * gap
        x0 = (GAME_W - total_w) // 2
        y0 = 232

        self.tiles = []
        for i, sk in enumerate(theme.SKINS):
            cx = x0 + (i % cols) * (tile + gap)
            cy = y0 + (i // cols) * (tile + gap)
            unlocked = self.app.save.skin_unlocked(sk.key)
            tab = ui.IconTab((cx, cy, tile, tile),
                             lambda k=sk.key: self._choose(k),
                             selected=(sk.key == self._current()),
                             accent=sk.glow, locked=not unlocked)
            self.group.add(tab)
            self.tiles.append((tab, sk, unlocked))

        self.group.add(back_button((GAME_W // 2 - 90, y0 + rows * tile + (rows - 1) * gap + 34,
                                    180, 52), self.back))

    def _current(self):
        return self.app.save.data.get("skin", theme.DEFAULT_SKIN)

    def _choose(self, key):
        if not self.app.save.skin_unlocked(key):
            # Refuse, and say why, rather than silently doing nothing.
            sk = theme.skin(key)
            self.particles.burst((GAME_W // 2, GAME_H - 108), 12, theme.DANGER,
                                 speed=(60, 170), life=(0.3, 0.6))
            self._deny = (self.t, sk.unlock_score)
            return
        self.app.save.select_skin(key)
        self.app.save.flush()
        self.demo.set_skin(key)
        for tab, sk, _ in self.tiles:
            tab.selected = (sk.key == key)
        sel = theme.skin(key)
        self.particles.ring((GAME_W // 2, GAME_H - 118), 22, sel.glow,
                            radius_speed=(150, 260), life=(0.4, 0.7))

    _deny: tuple | None = None

    def draw_content(self, surf):
        self.draw_header(surf, accent=theme.ACCENT_2)
        best = self.app.save.best_overall()
        fonts.draw(surf, f"BEST SCORE  {best:,}", (GAME_W - 58, 96), 18, theme.GOLD,
                   anchor="topright", tracking=2.0, glow=theme.GOLD, glow_alpha=44)

        for i, (tab, sk, unlocked) in enumerate(self.tiles):
            off, alpha = ui.appear_offset(self.t, 0.08 + i * 0.035, 30)
            layer = pygame.Surface((GAME_W, GAME_H), pygame.SRCALPHA)
            r = tab.draw_frame(layer)
            self._draw_tile(layer, r, sk, unlocked, best)
            layer.set_alpha(alpha)
            surf.blit(layer, (0, int(off)))

        self.group.widgets[-1].draw(surf)
        self._draw_selection_bar(surf)

    def _draw_tile(self, surf, r: pygame.Rect, sk: theme.Skin, unlocked: bool, best: int):
        cx, cy = r.centerx, r.centery - 12

        # A short arc of body segments: an actual look at the skin, curled.
        n = 9
        for j in range(n - 1, -1, -1):
            t = j / (n - 1)
            ang = -0.6 + t * 3.2
            rad = 30 + 5 * math.sin(self.t * 1.6 + t * 3.0)
            px = cx + math.cos(ang) * rad
            py = cy + math.sin(ang) * rad * 0.72
            radius = int(13 - 6 * t)
            if unlocked:
                g = assets.glow(int(radius * 2.4), sk.glow, falloff=2.4, peak=64)
                surf.blit(g, g.get_rect(center=(int(px), int(py))),
                          special_flags=pygame.BLEND_ADD)
            spr = assets.segment(sk.key, t, radius)
            if not unlocked:
                spr = spr.copy()
                spr.set_alpha(60)
            surf.blit(spr, spr.get_rect(center=(int(px), int(py))))

        head_img = assets.head(sk.key, 15)
        head_img = pygame.transform.rotate(head_img, 34)
        if not unlocked:
            head_img = head_img.copy()
            head_img.set_alpha(70)
        surf.blit(head_img, head_img.get_rect(center=(int(cx + math.cos(-0.6) * 30),
                                                     int(cy + math.sin(-0.6) * 30 * 0.72))))

        name_col = theme.TEXT if unlocked else theme.TEXT_FAINT
        fonts.draw(surf, sk.name, (r.centerx, r.bottom - 36), 18, name_col,
                   anchor="center", tracking=2.4,
                   glow=sk.glow if unlocked else None, glow_alpha=54)

        if unlocked:
            if sk.key == self._current():
                ui.pill(surf, (r.centerx - 44, r.bottom - 24, 88, 18), "SELECTED",
                        sk.glow, size=11, filled=True)
        else:
            need = sk.unlock_score
            ui.pill(surf, (r.centerx - 58, r.bottom - 24, 116, 18),
                    f"{need:,} PTS", theme.TEXT_FAINT, size=11)
            # A padlock, drawn rather than typed, plus the progress towards it.
            lock_c = (r.centerx, r.y + 30)
            pygame.draw.rect(surf, theme.TEXT_FAINT,
                             (lock_c[0] - 8, lock_c[1] - 2, 16, 13), border_radius=3)
            pygame.draw.arc(surf, theme.TEXT_FAINT,
                            (lock_c[0] - 7, lock_c[1] - 12, 14, 16), 0.1, math.pi - 0.1, 2)
            bar = pygame.Rect(r.x + 26, r.bottom - 52, r.w - 52, 5)
            ui.progress_bar(surf, bar, best / max(1, need), theme.GOLD)

    def _draw_selection_bar(self, surf):
        """Current skin, in the header. It used to live above the BACK button and overlap it."""
        sk = theme.skin(self._current())
        fonts.draw(surf, "WEARING", (GAME_W - 58, 132), 12, theme.TEXT_FAINT,
                   anchor="topright", tracking=3.0, shadow=1)
        fonts.draw(surf, sk.name, (GAME_W - 58, 148), 26, sk.glow,
                   anchor="topright", tracking=3.0, glow=sk.glow, glow_alpha=70)

        if self._deny and self.t - self._deny[0] < 2.0:
            k = 1.0 - (self.t - self._deny[0]) / 2.0
            fonts.draw(surf, f"LOCKED — SCORE {self._deny[1]:,} TO UNLOCK",
                       (GAME_W // 2, GAME_H - 58), 15, theme.DANGER, anchor="center",
                       tracking=2.0, alpha=int(255 * min(1.0, k * 3)))

    def footer_hint(self):
        return "ENTER  SELECT      ESC  BACK"
