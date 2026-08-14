"""
The application shell: window, timing, scene stack, transitions.

Three decisions here shape everything above it.

**A fixed virtual resolution.** The game always draws into a 1280x720 surface which is then
scaled to fit the window, letterboxed to preserve aspect. Layout code can therefore use literal
coordinates and never think about resolution, resizing can never move a hitbox relative to the
art, and fullscreen is a one-line change instead of a re-layout. The cost is one scaled blit per
frame, which is nothing next to what it buys. Mouse positions are converted back into virtual
space before any scene sees them, so scenes never learn the window exists.

**A fixed simulation timestep.** Rendering runs as fast as the display allows; the simulation
advances in slices of `FIXED_DT` from an accumulator. At 430 px/s a single dropped frame under a
variable timestep would move the head far enough to pass through a wall between two collision
checks, and a game that kills you for a hitch is worse than one that runs at 55 fps.

**Scenes are a stack, not a list.** Pause and game-over are pushed on top of the play scene
rather than replacing it, so the arena keeps drawing behind them and there is no state to
serialise and restore. The scene underneath is drawn but not updated.
"""

from __future__ import annotations

import sys

import pygame

from . import assets, audio, fonts, theme
from .config import (
    FIXED_DT, GAME_H, GAME_W, MAX_FRAME_DT, TARGET_FPS, TITLE, TRANSITION_TIME,
)
from .fx import ease_in_out
from .save import SaveData


class Scene:
    """Base scene.

    `update` receives the already-fixed `dt`, may be called several times per frame, and must be
    safe to call zero times. `draw` is called exactly once per frame.
    """

    #: When True, the scene below this one keeps drawing (used by pause and game over).
    transparent = False
    #: When True, the scene below keeps updating too. Nothing needs this yet, but overlays that
    #: want the arena to stay alive behind them would.
    updates_below = False

    def __init__(self, app: "App"):
        self.app = app
        self.t = 0.0

    def enter(self, **kwargs):
        pass

    def leave(self):
        pass

    def handle(self, event):
        pass

    def update(self, dt: float):
        self.t += dt

    def draw(self, surf: pygame.Surface):
        pass


class App:
    def __init__(self, *, headless: bool = False, window_scale: float = 1.0):
        self.headless = headless
        pygame.init()

        self.save = SaveData()
        # Before anything is generated: every cached sprite bakes in theme colours, so applying
        # the saved palette after the first asset is built would leave the previous theme's tiles
        # in the cache.
        self.save.apply_theme()
        audio.init(self.save.settings)
        audio.apply_settings(self.save.settings)

        # In the browser the canvas is a fixed size the page owns, and neither RESIZABLE nor
        # FULLSCREEN means anything there — the browser's own fullscreen is what a player uses.
        self.on_web = sys.platform == "emscripten"

        if self.on_web:
            self.window = pygame.display.set_mode((GAME_W, GAME_H))
        else:
            flags = pygame.RESIZABLE | pygame.DOUBLEBUF
            size = (int(GAME_W * window_scale), int(GAME_H * window_scale))
            if window_scale >= 1.0 and not headless:
                # A 720x1280 window is taller than a 1080p desktop, so opening at 1:1 would put
                # the tray off the bottom of the screen — on the most common display there is.
                # Fit to the usable height instead, leaving room for the title bar and taskbar.
                size = (int(GAME_W * self._fit_scale()), int(GAME_H * self._fit_scale()))
            if self.save.settings.get("fullscreen") and not headless:
                flags |= pygame.FULLSCREEN
                size = (0, 0)
            self.window = pygame.display.set_mode(size, flags)
        pygame.display.set_caption(TITLE)
        self._set_icon()

        #: Everything is drawn here. The window only ever receives a scaled copy of it.
        self.screen = pygame.Surface((GAME_W, GAME_H)).convert()

        self.clock = pygame.time.Clock()
        self.running = True
        self.accumulator = 0.0
        self.frame = 0
        self.fps = 0.0

        self.stack: list[Scene] = []
        self._pending: tuple | None = None
        self._transition = 0.0
        self._transition_dir = 0
        self.mouse = (0, 0)
        self.mouse_down = False
        self._audio_kicked = False

        self._layout_window()

    # ── window plumbing ─────────────────────────────────────────────────────
    @staticmethod
    def _fit_scale() -> float:
        """Largest whole-tenth scale whose window fits the desktop, capped at 1.

        Whole tenths rather than an exact fit so the window has a predictable size, and capped at
        1 because upscaling a 720-wide surface past its native size only softens it.
        """
        try:
            sizes = pygame.display.get_desktop_sizes()
            dw, dh = sizes[0] if sizes else (1920, 1080)
        except (pygame.error, AttributeError, IndexError):
            dw, dh = 1920, 1080
        usable = min(dw / GAME_W, (dh - 120) / GAME_H)
        return max(0.4, min(1.0, int(usable * 10) / 10.0))

    def _set_icon(self):
        """A generated app icon — four tiles in a 2x2, on a dark rounded panel.

        Drawn from the same tile generator the board uses, so the icon is literally a picture of
        the game rather than an approximation of it that can drift out of date.
        """
        try:
            from . import tiles

            icon = pygame.Surface((64, 64), pygame.SRCALPHA)
            icon.blit(assets.rounded_panel(64, 64, 16, theme.BG_MID, theme.BG_DEEP,
                                           theme.ACCENT, 3), (0, 0))
            size, gap = 22, 3
            origin = (64 - (size * 2 + gap)) // 2
            for i, ci in enumerate((0, 5, 2, 3)):
                x = origin + (i % 2) * (size + gap)
                y = origin + (i // 2) * (size + gap)
                tiles.blit_tile(icon, size, theme.block_color(ci), (x, y), shadow=False)
            pygame.display.set_icon(icon)
        except pygame.error:
            pass

    def _layout_window(self):
        """Work out the letterboxed destination rect for the virtual surface."""
        ww, wh = self.window.get_size()
        scale = min(ww / GAME_W, wh / GAME_H)
        vw, vh = max(1, int(GAME_W * scale)), max(1, int(GAME_H * scale))
        self.view = pygame.Rect((ww - vw) // 2, (wh - vh) // 2, vw, vh)
        self.view_scale = scale if scale > 0 else 1.0

    def to_virtual(self, pos) -> tuple[int, int]:
        """Window coordinates to virtual coordinates."""
        x = (pos[0] - self.view.x) / max(0.0001, self.view_scale)
        y = (pos[1] - self.view.y) / max(0.0001, self.view_scale)
        return (int(x), int(y))

    def toggle_fullscreen(self):
        # A no-op in the browser: the page owns the canvas, and the player's own F11 already does
        # the right thing. Calling set_mode with FULLSCREEN there breaks the canvas instead.
        if self.on_web:
            return
        want = not self.save.settings.get("fullscreen", False)
        self.save.settings["fullscreen"] = want
        self.save.mark()
        self.save.flush()
        try:
            if want:
                self.window = pygame.display.set_mode((0, 0),
                                                      pygame.FULLSCREEN | pygame.DOUBLEBUF)
            else:
                self.window = pygame.display.set_mode((GAME_W, GAME_H),
                                                      pygame.RESIZABLE | pygame.DOUBLEBUF)
        except pygame.error:
            # Some display drivers refuse a mode change. Keep the old surface and the old flag.
            self.save.settings["fullscreen"] = not want
        self._layout_window()

    # ── scenes ──────────────────────────────────────────────────────────────
    @property
    def scene(self) -> Scene | None:
        return self.stack[-1] if self.stack else None

    def push(self, scene: Scene, **kwargs):
        scene.enter(**kwargs)
        self.stack.append(scene)

    def pop(self):
        if self.stack:
            self.stack.pop().leave()

    def switch(self, scene: Scene, **kwargs):
        """Replace the whole stack, behind a wipe."""
        self._pending = (scene, kwargs)
        self._transition = 0.0
        self._transition_dir = 1

    def switch_now(self, scene: Scene, **kwargs):
        while self.stack:
            self.pop()
        self.push(scene, **kwargs)

    def quit(self):
        self.running = False

    # ── the loop ────────────────────────────────────────────────────────────
    def _pump(self):
        for event in pygame.event.get():
            # Browsers refuse to start audio until the page has been interacted with, so the
            # first real input is the earliest moment music can begin. Cheap to retry: start_music
            # returns immediately once a channel is already playing.
            if self.on_web and not self._audio_kicked and event.type in (
                    pygame.KEYDOWN, pygame.MOUSEBUTTONDOWN):
                self._audio_kicked = True
                audio.apply_settings(self.save.settings)
                audio.start_music()
            if event.type == pygame.QUIT:
                self.running = False
                return
            if event.type == pygame.VIDEORESIZE:
                self._layout_window()
                continue
            if event.type == pygame.KEYDOWN and event.key == pygame.K_F11:
                self.toggle_fullscreen()
                continue
            if event.type == pygame.KEYDOWN and event.key == pygame.K_F1:
                st = self.save.settings
                st["show_fps"] = not st.get("show_fps", False)
                self.save.mark()
                continue

            if event.type == pygame.MOUSEMOTION:
                self.mouse = self.to_virtual(event.pos)
                event = pygame.event.Event(event.type, {**event.dict, "pos": self.mouse})
            elif event.type in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP):
                self.mouse = self.to_virtual(event.pos)
                if event.button == 1:
                    self.mouse_down = (event.type == pygame.MOUSEBUTTONDOWN)
                event = pygame.event.Event(event.type, {**event.dict, "pos": self.mouse})

            # A scene mid-transition should not receive input meant for the next one.
            if self._transition_dir == 0 and self.scene:
                self.scene.handle(event)

    def _advance_transition(self, dt: float):
        """Close the wipe, swap the scene, open the wipe.

        Written as two plainly separate directions after the first version never finished. It
        advanced the clock once at the top and then, on the way out, subtracted twice as much
        further down — so on the opening half the value went up by a step before going down by
        two, and the "are we done" test was evaluated in between. Sitting at zero, the test saw
        one step ABOVE zero every single frame and never fired. `_transition_dir` stayed at -1
        forever.

        That mattered far more than a stuck animation, because `_pump` refuses to deliver input
        during a transition — deliberately, so a click meant for one screen cannot land on the
        next. With the direction stuck, nothing was ever delivered again: the mouse position and
        the press states kept updating, so buttons still lit up and depressed under the cursor,
        and not one of them did anything. The first navigation worked and the game was inert
        from then on.
        """
        if self._transition_dir == 0:
            return
        step = dt / (TRANSITION_TIME * 0.5)

        if self._transition_dir == 1:
            self._transition += step
            if self._transition >= 1.0:
                # Fully covered: swap underneath the wipe, then open it again.
                scene, kwargs = self._pending or (None, {})
                self._pending = None
                if scene is not None:
                    self.switch_now(scene, **kwargs)
                self._transition = 1.0
                self._transition_dir = -1
        else:
            self._transition -= step
            if self._transition <= 0.0:
                self._transition = 0.0
                self._transition_dir = 0

    def _draw_transition(self, surf: pygame.Surface):
        if self._transition <= 0.001:
            return
        k = ease_in_out(min(1.0, self._transition))
        # Two blades closing from the edges. Reads as deliberate; a plain fade to black reads
        # as a loading screen.
        h = int(GAME_H * 0.5 * k)
        blade = pygame.Surface((GAME_W, max(1, h)), pygame.SRCALPHA)
        blade.fill((*theme.BG_DEEP, 255))
        surf.blit(blade, (0, 0))
        surf.blit(blade, (0, GAME_H - h))
        if k > 0.55:
            line = pygame.Surface((GAME_W, 3), pygame.SRCALPHA)
            line.fill((*theme.ACCENT, int(200 * (k - 0.55) / 0.45)))
            surf.blit(line, (0, h - 2))
            surf.blit(line, (0, GAME_H - h))

    def step(self, *, max_frames: int | None = None) -> bool:
        """Advance and draw exactly one frame. Returns whether the game should keep running.

        Factored out of the loop so the same frame can be driven from two places: a plain
        `while` on the desktop, and the browser's own event loop in the web build, where a
        blocking loop would freeze the page. Nothing about a frame depends on which driver is
        calling it.
        """
        # The browser paces frames itself: the loop is resumed from requestAnimationFrame, which
        # already fires at the display's refresh rate. Asking Clock to enforce a cap on top of
        # that is worse than redundant — the cap is enforced by sleeping, and a single-threaded
        # WebAssembly build cannot sleep without blocking the very event loop that has to present
        # the canvas. On a 120 or 144 Hz display it would block for ~10 ms of every frame to hold
        # a rate the page was never exceeding. So on the web, Clock only measures.
        raw = (self.clock.tick() if self.on_web else self.clock.tick(TARGET_FPS)) / 1000.0
        dt = min(raw, MAX_FRAME_DT)
        self.fps = self.clock.get_fps()

        self._pump()
        if not self.running:
            return False

        self._advance_transition(dt)

        # Fixed-step simulation from an accumulator. The stack is walked so a transparent
        # overlay can opt the scene beneath it back into updating.
        self.accumulator += dt
        steps = 0
        while self.accumulator >= FIXED_DT and steps < 8:
            self.accumulator -= FIXED_DT
            steps += 1
            self._update_stack(FIXED_DT)
        if steps == 8:
            # Badly behind; drop the backlog rather than compounding it next frame.
            self.accumulator = 0.0

        self._draw_stack()
        self.frame += 1
        if max_frames is not None and self.frame >= max_frames:
            self.running = False
        return self.running

    def shutdown(self):
        self.save.flush()
        pygame.quit()

    def run(self, first_scene: Scene, *, max_frames: int | None = None,
            first_kwargs: dict | None = None):
        """Desktop driver."""
        self.push(first_scene, **(first_kwargs or {}))
        while self.running:
            self.step(max_frames=max_frames)
        self.shutdown()

    async def run_async(self, first_scene: Scene, *, max_frames: int | None = None,
                        first_kwargs: dict | None = None):
        """Browser driver.

        Identical to `run` apart from yielding to the event loop once per frame, which is what
        lets the page stay responsive and lets the browser present the canvas. pygbag requires
        the entry point to be a coroutine for exactly this reason.
        """
        import asyncio

        self.push(first_scene, **(first_kwargs or {}))
        while self.running:
            self.step(max_frames=max_frames)
            await asyncio.sleep(0)
        self.shutdown()

    def _update_stack(self, dt: float):
        if not self.stack:
            return
        top = self.stack[-1]
        if top.updates_below and len(self.stack) > 1:
            self.stack[-2].update(dt)
        top.update(dt)

    def _draw_stack(self):
        if not self.stack:
            self.screen.fill(theme.BG_DEEP)
        else:
            # Find the deepest scene that has to be drawn: walk down through transparent ones.
            start = len(self.stack) - 1
            while start > 0 and self.stack[start].transparent:
                start -= 1
            for i in range(start, len(self.stack)):
                self.stack[i].draw(self.screen)

        self._draw_transition(self.screen)

        if self.save.settings.get("show_fps"):
            fonts.draw(self.screen, f"{self.fps:5.1f} fps", (GAME_W - 12, GAME_H - 10), 15,
                       theme.TEXT_FAINT, anchor="bottomright", bold=False, shadow=1)

        self.present()

    def present(self):
        """Scale the virtual surface into the window."""
        if self.view.size == (GAME_W, GAME_H):
            self.window.blit(self.screen, self.view.topleft)
        elif self.view_scale >= 1.0:
            # Plain scale for any upscale. This used to be smoothscale at non-integer ratios, on
            # the grounds that it avoids shimmer on scrolling hairlines, and it does — but it is
            # the single most expensive thing in the frame at the resolution most players use.
            # Measured, 1280x720 to the window:
            #
            #     1600x900   smoothscale 3.53 ms   scale 0.87 ms
            #     1920x1080  smoothscale 4.41 ms   scale 1.20 ms
            #     2560x1440  smoothscale 6.53 ms   scale 2.20 ms
            #     3840x2160  smoothscale 11.23 ms  scale 4.82 ms
            #
            # 4.41 ms is a quarter of a 60 fps frame spent presenting one already-finished image,
            # and at 4K smoothscale alone very nearly exhausts the budget. What it buys is a
            # softer picture: the shimmer it prevents is on the backdrop grid, which is drawn at
            # alpha 15-26 out of 255, while the blur it adds is on every glow and every letter.
            # Sharper and four times cheaper is the better trade in both directions.
            pygame.transform.scale(self.screen, self.view.size, self.window.subsurface(self.view))
        else:
            # Downscaling is different: nearest-neighbour drops whole rows and columns, so thin
            # geometry disappears rather than softening. Windows smaller than 1280x720 are also
            # cheap to resample, so the quality is worth having here.
            pygame.transform.smoothscale(self.screen, self.view.size,
                                         self.window.subsurface(self.view))
        if self.view.size != self.window.get_size():
            # Letterbox bars. Filled every frame because a mode change can leave artefacts.
            ww, wh = self.window.get_size()
            for bar in (pygame.Rect(0, 0, ww, self.view.top),
                        pygame.Rect(0, self.view.bottom, ww, wh - self.view.bottom),
                        pygame.Rect(0, 0, self.view.left, wh),
                        pygame.Rect(self.view.right, 0, ww - self.view.right, wh)):
                if bar.w > 0 and bar.h > 0:
                    self.window.fill((0, 0, 0), bar)
        pygame.display.flip()
