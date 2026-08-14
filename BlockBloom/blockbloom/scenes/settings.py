"""Settings: audio, effects, and the two escape hatches (fullscreen, frame counter)."""

from __future__ import annotations

import pygame

from .. import audio, fonts, theme, ui
from ..config import GAME_H, GAME_W
from .common import ChromeScene


class SettingsScene(ChromeScene):
    heading = "SETTINGS"
    subheading = "Saved as you change them"
    show_blocks = False

    def build(self):
        st = self.app.save.settings
        x = (GAME_W - 480) // 2
        w, h, gap = 480, 68, 14
        y = 230

        def toggle(key: str, label: str, colour) -> None:
            nonlocal y
            self.group.add(ui.Toggle(pygame.Rect(x, y, w, h), label,
                                     lambda k=key: bool(st.get(k, True)),
                                     lambda v, k=key: self._set(k, v), color=colour))
            y += h + gap

        self.group.add(ui.Slider(pygame.Rect(x, y, w, h), "VOLUME",
                                 lambda: float(st.get("volume", 0.7)),
                                 self._set_volume, color=theme.ACCENT))
        y += h + gap
        toggle("sfx", "SOUND EFFECTS", theme.ACCENT)
        toggle("music", "MUSIC", theme.ACCENT_2)
        toggle("particles", "PARTICLES", theme.GREEN)
        toggle("shake", "SCREEN SHAKE", theme.GOLD)
        toggle("show_fps", "FRAME COUNTER", theme.TEXT_DIM)

        if not self.app.on_web:
            # Pointless in a browser: the page owns the canvas and the player's own fullscreen key
            # already does the right thing. Wired straight to `toggle_fullscreen`, which owns the
            # setting — writing the setting here as well would flip it twice and leave the window
            # disagreeing with the switch.
            self.group.add(ui.Toggle(pygame.Rect(x, y, w, h), "FULLSCREEN",
                                     lambda: bool(st.get("fullscreen", False)),
                                     lambda v: self.app.toggle_fullscreen(),
                                     color=theme.TEXT_DIM))
            y += h + gap

        self.group.add(ui.Button(pygame.Rect(GAME_W // 2 - 150, GAME_H - 130, 300, 66),
                                 "BACK", self._back, color=theme.TEXT_DIM))

    def _set(self, key: str, value) -> None:
        st = self.app.save.settings
        st[key] = bool(value)
        self.app.save.mark()
        audio.apply_settings(st)
        if key == "music":
            if value:
                audio.start_music()
            else:
                audio.stop_music()

    def _set_volume(self, value: float) -> None:
        st = self.app.save.settings
        st["volume"] = max(0.0, min(1.0, float(value)))
        self.app.save.mark()
        audio.apply_settings(st)

    def _back(self):
        from .menu import MenuScene
        self.app.save.flush()
        self.go(MenuScene)

    def draw_content(self, surf):
        self.draw_header(surf, accent=theme.ACCENT)
        self.draw_group_staggered(surf, delay=0.05, gap=0.04, distance=24)
        if not audio.is_enabled():
            fonts.draw(surf, "NO AUDIO DEVICE — SOUND OPTIONS HAVE NO EFFECT",
                       (GAME_W // 2, 186), 13, theme.DANGER, anchor="center",
                       bold=False, tracking=1.6)

    def footer_hint(self):
        return "ENTER  TOGGLE      LEFT / RIGHT  ADJUST      ESC  BACK"

    def handle(self, event):
        if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
            self._back()
            return
        super().handle(event)
