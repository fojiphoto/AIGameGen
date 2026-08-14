"""
Settings.

Deliberately short. Every row here changes something a player can immediately perceive, and
anything that would need explaining is not in the list. Changes apply the moment they are made —
there is no Apply button, because a settings screen that can be wrong until you confirm it is a
settings screen you have to test twice.
"""

from __future__ import annotations

import pygame

from .. import audio, fonts, theme, ui
from ..config import GAME_H, GAME_W
from .common import ChromeScene, back_button


class SettingsScene(ChromeScene):
    heading = "SETTINGS"
    subheading = "Applied immediately. Saved on the way out."
    demo_alpha = 0.16

    def build(self):
        self.group.clear()
        st = self.app.save.settings
        x = (GAME_W - 620) // 2
        y = 224
        w, h = 620, 58
        gap = 70

        def flag(key):
            def getter():
                return bool(st.get(key, True))

            def setter(v):
                st[key] = bool(v)
                self.app.save.mark()
                self._apply()

            return getter, setter

        g, s = flag("sfx")
        self.group.add(ui.Toggle((x, y, w, h), "SOUND EFFECTS", g, s, color=theme.ACCENT))
        g, s = flag("music")
        self.group.add(ui.Toggle((x, y + gap, w, h), "MUSIC", g, s, color=theme.ACCENT))

        def vol_get():
            return float(st.get("volume", 0.7))

        def vol_set(v):
            st["volume"] = max(0.0, min(1.0, float(v)))
            self.app.save.mark()
            self._apply()

        self.group.add(ui.Slider((x, y + gap * 2, w, h), "VOLUME", vol_get, vol_set,
                                color=theme.GOLD))

        g, s = flag("particles")
        self.group.add(ui.Toggle((x, y + gap * 3, w, h), "PARTICLES", g, s, color=theme.ACCENT_2))
        g, s = flag("shake")
        self.group.add(ui.Toggle((x, y + gap * 4, w, h), "SCREEN SHAKE", g, s, color=theme.ACCENT_2))
        g, s = flag("show_fps")
        self.group.add(ui.Toggle((x, y + gap * 5, w, h), "SHOW FPS", g, s, color=theme.TEXT_DIM))

        self.group.add(ui.Button((x, y + gap * 6 + 6, 296, 54), "FULLSCREEN",
                                self.app.toggle_fullscreen, color=theme.TEXT_DIM, size=20,
                                sub="or press F11 anywhere"))
        self.group.add(ui.Button((x + 324, y + gap * 6 + 6, 296, 54), "RESET PROGRESS",
                                self._confirm_reset, color=theme.DANGER, size=20,
                                sub="high scores and unlocks", danger=True))

        self.group.add(back_button((GAME_W // 2 - 90, y + gap * 7 + 26, 180, 52), self.back))

        self._reset_armed = 0.0

    def _apply(self):
        audio.apply_settings(self.app.save.settings)
        self.particles.enabled = self.app.save.settings.get("particles", True)

    def _confirm_reset(self):
        """Two-step, without a modal.

        The first press arms it and relabels the button; a second press within three seconds
        commits. Destructive and irreversible, so it should not be one stray Enter away — but a
        dialog for this is heavier than it deserves.
        """
        if self._reset_armed > 0.0:
            self._do_reset()
            return
        self._reset_armed = 3.0

    def _do_reset(self):
        from ..save import _defaults
        keep = dict(self.app.save.settings)
        self.app.save.data = _defaults()
        self.app.save.data["settings"] = keep
        self.app.save.mark()
        self.app.save.flush()
        self.demo.set_skin(theme.DEFAULT_SKIN)
        self._reset_armed = 0.0
        self.particles.burst((GAME_W // 2, GAME_H - 150), 26, theme.DANGER,
                             speed=(90, 300), life=(0.4, 0.8))
        self.build()

    def leave(self):
        self.app.save.flush()

    def on_update(self, dt):
        if self._reset_armed > 0.0:
            self._reset_armed = max(0.0, self._reset_armed - dt)
            btn = self.group.widgets[-2]
            btn.label = "CONFIRM RESET"
            btn.sub = f"press again — {self._reset_armed:.0f}s"
        else:
            btn = self.group.widgets[-2]
            btn.label = "RESET PROGRESS"
            btn.sub = "high scores and unlocks"

    def draw_content(self, surf):
        self.draw_header(surf)

        if not audio.is_enabled():
            fonts.draw(surf, "NO AUDIO DEVICE DETECTED — SOUND OPTIONS HAVE NO EFFECT",
                       (GAME_W // 2, 190), 14, theme.DANGER, anchor="center",
                       bold=False, tracking=1.6)

        for i, w in enumerate(self.group.widgets):
            off, alpha = ui.appear_offset(self.t, 0.06 + i * 0.04, 26)
            if abs(off) < 0.4 and alpha >= 255:
                w.draw(surf)
                continue
            ui.slide_in(surf, w.rect, w.draw, dy=off, alpha=alpha)

    def footer_hint(self):
        return "ENTER  TOGGLE      LEFT / RIGHT  ADJUST      ESC  BACK"
