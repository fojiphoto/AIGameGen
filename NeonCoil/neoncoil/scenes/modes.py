"""
Mode selection.

Three cards. Each shows what the mode asks of you, the personal best for it, and — for Challenge
— how far through the objective list the player has ever got, because a mode with hidden goals
needs to show progress or it reads as a dead end.
"""

from __future__ import annotations

import pygame

from .. import assets, fonts, theme, ui
from ..config import GAME_H, GAME_W
from .common import ChromeScene, back_button


class ModesScene(ChromeScene):
    heading = "GAME MODES"
    subheading = "Pick how you want to be measured."
    demo_alpha = 0.20

    def build(self):
        self.group.clear()
        card_w, card_h = 336, 340
        gap = 30
        total = card_w * 3 + gap * 2
        x0 = (GAME_W - total) // 2
        y = 216

        self.cards = []
        for i, m in enumerate(theme.MODES):
            rect = pygame.Rect(x0 + i * (card_w + gap), y, card_w, card_h)
            tab = ui.IconTab(rect, lambda k=m.key: self._choose(k),
                             selected=(m.key == self._current()), accent=m.color)
            self.group.add(tab)
            self.cards.append((tab, m))

        self.group.add(back_button((GAME_W // 2 - 90, y + card_h + 42, 180, 52), self.back))

    def _current(self):
        return self.app.save.data.get("last_mode", theme.DEFAULT_MODE)

    def _choose(self, key):
        self.app.save.data["last_mode"] = key
        self.app.save.mark()
        self.app.save.flush()
        from .play import PlayScene
        self.app.switch(PlayScene(self.app), mode_key=key)

    def draw_content(self, surf):
        self.draw_header(surf, accent=theme.GOLD)

        for i, (tab, m) in enumerate(self.cards):
            off, alpha = ui.appear_offset(self.t, 0.10 + i * 0.07, 40)
            with ui.sliding(surf, ui.reach(tab.rect), dy=off, alpha=alpha) as layer:
                r = tab.draw_frame(layer)
                self._draw_card_body(layer, r, m)

        # The back button is a normal widget and does not need the entrance treatment.
        self.group.widgets[-1].draw(surf)

    def _draw_card_body(self, surf, r: pygame.Rect, m: theme.Mode):
        save = self.app.save

        # A big glyph per mode, built from primitives so each card has its own silhouette.
        icon_c = (r.centerx, r.y + 92)
        halo = assets.glow(74, m.color, falloff=2.8, peak=70)
        surf.blit(halo, halo.get_rect(center=icon_c), special_flags=pygame.BLEND_ADD)

        if m.key == "classic":
            surf.blit(assets.ring(38, 6, m.color), assets.ring(38, 6, m.color)
                      .get_rect(center=icon_c))
            head = assets.head(save.data.get("skin", theme.DEFAULT_SKIN), 17)
            surf.blit(head, head.get_rect(center=icon_c))
        elif m.key == "time":
            surf.blit(assets.ring(38, 5, m.color), assets.ring(38, 5, m.color)
                      .get_rect(center=icon_c))
            pygame.draw.line(surf, m.color, icon_c, (icon_c[0], icon_c[1] - 26), 5)
            pygame.draw.line(surf, m.color, icon_c, (icon_c[0] + 20, icon_c[1] + 6), 5)
        else:
            star = assets.star(40, 5, 0.46, m.color, theme.shade(m.color, -0.55))
            surf.blit(star, star.get_rect(center=icon_c))

        fonts.draw(surf, m.name, (r.centerx, r.y + 172), 30, theme.TEXT,
                   anchor="center", tracking=3.4, glow=m.color, glow_alpha=70)

        # Blurb, wrapped by hand to two lines so it never collides with the stats below.
        words = m.blurb.split()
        lines, cur = [], ""
        for w in words:
            trial = (cur + " " + w).strip()
            if fonts.measure(trial, 16, False)[0] > r.w - 56:
                lines.append(cur)
                cur = w
            else:
                cur = trial
        if cur:
            lines.append(cur)
        for j, ln in enumerate(lines[:3]):
            fonts.draw(surf, ln, (r.centerx, r.y + 206 + j * 22), 16, theme.TEXT_DIM,
                       anchor="center", bold=False, tracking=0.4)

        # The best-score block sits high enough that the Challenge card's extra objective row
        # fits underneath it. At the original spacing the caption ran into the score's descenders.
        best = save.high_score(m.key)
        ui.section_label(surf, "PERSONAL BEST", (r.centerx, r.bottom - 86), anchor="center")
        fonts.draw(surf, f"{best:,}", (r.centerx, r.bottom - 58), 30, m.color,
                   anchor="center", tracking=1.0, glow=m.color if best else None, glow_alpha=54)

        if m.key == "challenge":
            done = int(save.data.get("challenge_best", 0))
            fonts.draw(surf, f"{done} / {len(theme.CHALLENGES)} OBJECTIVES CLEARED",
                       (r.centerx, r.bottom - 32), 11, theme.TEXT_FAINT,
                       anchor="center", tracking=1.8, shadow=1)
            ui.progress_bar(surf, pygame.Rect(r.x + 28, r.bottom - 20, r.w - 56, 7),
                            done / len(theme.CHALLENGES), m.color)

    def footer_hint(self):
        return "ENTER  START MODE      ESC  BACK"
