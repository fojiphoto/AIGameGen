"""
The themes screen: five palettes, bought with coins and worn immediately.

Each card previews its own palette rather than describing it, which means the card has to draw
tiles in colours that are *not* the active theme. That is the only place in the game where a colour
comes from a palette other than the live one, and it is why `Palette` carries its colours as data
instead of the screen reading `theme.BLOCKS`.
"""

from __future__ import annotations

import pygame

from .. import assets, audio, fonts, theme, tiles, ui
from ..config import GAME_H, GAME_W
from .common import ChromeScene

CARD_W = 624
CARD_H = 132
CARD_X = (GAME_W - CARD_W) // 2
FIRST_Y = 200
CARD_GAP = 16


class ThemesScene(ChromeScene):
    heading = "THEMES"
    subheading = "Earn coins by clearing lines"
    show_blocks = False        # the cards are busy enough

    def build(self):
        self.cards = []
        for i, pal in enumerate(theme.PALETTES):
            r = pygame.Rect(CARD_X, FIRST_Y + i * (CARD_H + CARD_GAP), CARD_W, CARD_H)
            tab = ui.IconTab(r, on_click=lambda p=pal: self._pick(p), accent=pal.accent)
            self.cards.append((tab, pal))
            self.group.add(tab)
        self.group.add(ui.Button(pygame.Rect(GAME_W // 2 - 150, GAME_H - 130, 300, 66),
                                 "BACK", self._back, color=theme.TEXT_DIM))
        self._flash = None

    def _back(self):
        from .menu import MenuScene
        self.go(MenuScene)

    def _pick(self, pal) -> None:
        save = self.app.save
        if save.theme_unlocked(pal.key):
            if save.data.get("theme") != pal.key:
                save.select_theme(pal.key)
                audio.click()
                # The backdrop and every cached sprite belong to the old palette.
                assets.clear_cache()
                self.backdrop.retheme()
            return
        if save.buy_theme(pal.key):
            save.select_theme(pal.key)
            assets.clear_cache()
            self.backdrop.retheme()
            audio.reward()
            self._flash = [pal.key, 0.0]
            self.particles.ring((GAME_W // 2, GAME_H // 2), 30, pal.accent,
                                radius_speed=(220, 420), size=(4, 9), life=(0.6, 1.1))
            self.floaters.add(GAME_W // 2, GAME_H // 2 - 40, "UNLOCKED", theme.GOLD,
                              size=32, life=1.3, vy=-60.0)
        else:
            audio.invalid()
            self._flash = [pal.key, 0.0]

    def update(self, dt):
        super().update(dt)
        for tab, pal in self.cards:
            tab.selected = self.app.save.data.get("theme") == pal.key
        if self._flash is not None:
            self._flash[1] += dt
            if self._flash[1] > 0.5:
                self._flash = None

    def draw_content(self, surf):
        self.draw_header(surf, accent=theme.ACCENT)
        self.coin_readout(surf, pos=(GAME_W - 30, 46))

        save = self.app.save
        for i, (tab, pal) in enumerate(self.cards):
            off, alpha = ui.appear_offset(self.t, 0.06 + i * 0.045, 26)
            with ui.sliding(surf, ui.reach(tab.rect), dy=off, alpha=alpha) as layer:
                r = tab.draw_frame(layer)
                self._draw_card(layer, r, pal, save)

        self.group.widgets[-1].draw(surf)

    def _draw_card(self, surf, r: pygame.Rect, pal, save) -> None:
        unlocked = save.theme_unlocked(pal.key)
        worn = save.data.get("theme") == pal.key

        # A swatch of the palette's own ground, so the card shows the background too and not only
        # the blocks. Themes change more than the tiles.
        sw = pygame.Rect(r.x + 18, r.y + 18, 150, r.h - 36)
        surf.blit(assets.vertical_gradient((sw.w, sw.h), pal.bg_deep, pal.bg_mid), sw.topleft)
        pygame.draw.rect(surf, pal.board_edge, sw, width=2, border_radius=10)
        # Four of its tiles, drawn flat because a preview at 30px cannot show a bevel anyway.
        for j in range(4):
            tx = sw.x + 14 + (j % 2) * 40
            ty = sw.y + 16 + (j // 2) * 40
            surf.blit(tiles.flat(32, pal.blocks[j * 2 % len(pal.blocks)]), (tx, ty))

        fonts.draw(surf, pal.name, (sw.right + 24, r.y + 40), 26, theme.TEXT,
                   anchor="midleft", tracking=3.0,
                   glow=pal.accent if worn else None, glow_alpha=70)
        fonts.draw(surf, pal.blurb, (sw.right + 24, r.y + 68), 14, theme.TEXT_DIM,
                   anchor="midleft", bold=False, tracking=1.2)

        badge = pygame.Rect(0, 0, 128, 34)
        badge.midright = (r.right - 20, r.centery)
        if worn:
            ui.pill(surf, badge, "ACTIVE", theme.GREEN, size=15, filled=True)
        elif unlocked:
            ui.pill(surf, badge, "SELECT", pal.accent, size=15)
        else:
            afford = save.coins >= pal.cost
            shake = 0
            if self._flash and self._flash[0] == pal.key and not afford:
                # A short shudder on a purchase that cannot be afforded — clearer than a message
                # and gone before it becomes annoying.
                import math
                shake = int(math.sin(self._flash[1] * 60.0) * 5.0 * max(0.0, 1 - self._flash[1] * 2))
            badge.x += shake
            colour = theme.GOLD if afford else theme.TEXT_FAINT
            icon = tiles.coin(20)
            surf.blit(assets.rounded_panel(badge.w, badge.h, badge.h // 2, theme.PANEL,
                                           theme.PANEL, colour, 2), badge.topleft)
            surf.blit(icon, icon.get_rect(midleft=(badge.x + 12, badge.centery)))
            fonts.draw(surf, f"{pal.cost:,}", (badge.x + 38, badge.centery), 15, colour,
                       anchor="midleft", tracking=1.2, shadow=1)

    def footer_hint(self):
        return "TAP A THEME TO WEAR IT      ESC  BACK"

    def handle(self, event):
        if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
            self._back()
            return
        super().handle(event)
