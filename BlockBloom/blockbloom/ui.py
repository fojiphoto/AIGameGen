"""
Interface widgets.

The look is a single idea applied consistently: a rounded panel with a vertical gradient, a
hairline border, and a coloured accent that only the focused element gets. Focus is one state
whether it arrived by mouse or by keyboard, which is what keeps a pad-and-keyboard game and a
mouse game from needing two sets of visuals.

Every widget animates towards its target rather than snapping to it. `_approach` is an
exponential ease evaluated against real elapsed time, so a button feels the same at 30 fps as
at 144 and nothing here has a per-frame constant in it.
"""

from __future__ import annotations

import contextlib
import math
import sys

import pygame

from . import assets, audio, fonts, theme
from .fx import ease_out_back

_ON_WEB = sys.platform == "emscripten"


def approach(current: float, target: float, rate: float, dt: float) -> float:
    """Exponential ease towards a target. Frame-rate independent by construction."""
    return target + (current - target) * math.exp(-rate * dt)


# ── scratch layers ──────────────────────────────────────────────────────────────
#
# A widget that slides and fades has to be composed on its own layer first. It is not enough to
# offset the pieces and set an alpha on each: a widget is a panel plus a glow plus text with its
# own halo, and fading those separately makes the overlaps show. Drawing the widget once and
# fading the result is the only version that looks right.
#
# The layers themselves are pooled, and that is a performance fix rather than tidiness. Every
# screen used to allocate a fresh full-screen SRCALPHA surface per widget per frame and blit the
# whole thing back. Measured on the browser rendering path, that is 0.86 ms to allocate and
# 0.76 ms to blit — 1.60 ms of pure overhead per widget. The skins screen draws eight tiles, so
# it was spending 12.8 of its 18.7 ms per frame on surfaces it immediately threw away, which is
# most of the way through a 16.67 ms frame before anything is drawn. Reusing one layer and
# touching only the region a widget can actually reach costs 0.09 ms instead.
_LAYER_POOL: list[pygame.Surface] = []
_layer_depth = 0


def _acquire_layer(size) -> pygame.Surface:
    """A cleared transparent layer, reused across frames.

    Nesting is why this is a pool and not a single surface: a scene can compose a widget on a
    layer while itself being composed on one. Depth indexes the pool so an inner layer never
    scribbles on the outer one.
    """
    global _layer_depth
    while len(_LAYER_POOL) <= _layer_depth:
        _LAYER_POOL.append(pygame.Surface(size, pygame.SRCALPHA))
    layer = _LAYER_POOL[_layer_depth]
    if layer.get_size() != tuple(size):
        layer = pygame.Surface(size, pygame.SRCALPHA)
        _LAYER_POOL[_layer_depth] = layer
    _layer_depth += 1
    return layer


def _release_layer():
    global _layer_depth
    _layer_depth = max(0, _layer_depth - 1)


_SCRIM_CACHE: dict[tuple, pygame.Surface] = {}


def drop_layers():
    """Discard the pool. Called when the display goes away, since the surfaces go with it."""
    global _layer_depth
    _LAYER_POOL.clear()
    _SCRIM_CACHE.clear()
    _layer_depth = 0


def scrim(surf: pygame.Surface, color, alpha: int):
    """Darken the whole surface with a translucent wash.

    Kept out of the callers because the obvious spelling — allocate an SRCALPHA surface, fill it
    with a colour that has alpha, blit it — costs 1.0 ms a frame for a flat rectangle. An opaque
    surface with per-surface alpha does the same thing, caches, and blits on a faster path.
    """
    if alpha <= 0:
        return
    size = surf.get_size()
    key = (size, tuple(color))
    layer = _SCRIM_CACHE.get(key)
    if layer is None:
        layer = pygame.Surface(size)
        layer.fill(color)
        _SCRIM_CACHE[key] = layer
    layer.set_alpha(min(255, int(alpha)))
    surf.blit(layer, (0, 0))


def reach(rect: pygame.Rect) -> pygame.Rect:
    """How far outside its own rect a widget can draw.

    Widgets bleed, and the amount is not arbitrary: the largest thing any of them draws outside
    its panel is a hover glow, centred on the rect, of radius `0.8 * w` for an IconTab and
    `0.72 * max(w, h)` for a Button. A square of side `1.6 * max(w, h)` about the centre covers
    both, and the margin absorbs text halos and drop shadows.
    """
    span = int(1.6 * max(rect.w, rect.h)) + 24
    reach_rect = pygame.Rect(0, 0, max(span, rect.w + 24), max(span, rect.h + 24))
    reach_rect.center = rect.center
    return reach_rect


@contextlib.contextmanager
def sliding(surf: pygame.Surface, region: pygame.Rect, *, dy: float = 0.0, alpha: int = 255):
    """Yield a scratch layer, then blit `region` of it offset by `dy` and faded to `alpha`.

    `region` is the area the caller may draw in, and it is a promise rather than a clip: pixels
    put outside it are silently dropped, so it has to be generous enough to cover glows and
    shadows. `reach()` computes that for a widget; callers drawing something else pass their own.
    """
    layer = _acquire_layer(surf.get_size())
    try:
        region = region.clip(layer.get_rect())
        if region.w > 0 and region.h > 0:
            layer.fill((0, 0, 0, 0), region)
        yield layer
        # Fully transparent is not a no-op to draw, but it is a no-op to composite, so the blit
        # is what gets skipped. Callers that want to skip the drawing too test alpha themselves.
        if alpha > 0 and region.w > 0 and region.h > 0:
            # 255, never None. `set_alpha(None)` does not mean "fully opaque, use the per-pixel
            # alpha" — it turns alpha blending off for the blit altogether, so a transparent
            # layer copies as opaque black. Since the layers are pooled and reused this has to be
            # set on every pass anyway, so there is nothing to be gained by special-casing it.
            layer.set_alpha(min(255, alpha))
            surf.blit(layer, (region.x, region.y + int(dy)), region)
    finally:
        _release_layer()


@contextlib.contextmanager
def nothing(surf: pygame.Surface):
    """Yield the surface itself — the no-layer case, for callers that sometimes need one.

    Exists so a draw site can choose between compositing and drawing directly without growing a
    second copy of its body. A layer costs a clear and a blit of its whole region, which is worth
    paying while something is sliding and pure waste once it has arrived.
    """
    yield surf


def slide_in(surf: pygame.Surface, rect: pygame.Rect, paint, *,
             dy: float = 0.0, alpha: int = 255, bleed: pygame.Rect | None = None):
    """`sliding` for the common case of one widget: compose `paint(layer)` and blit it."""
    with sliding(surf, bleed or reach(rect), dy=dy, alpha=alpha) as layer:
        paint(layer)


class Widget:
    def __init__(self, rect, *, enabled=True):
        self.rect = pygame.Rect(rect)
        self.enabled = enabled
        self.focused = False
        self.hover = 0.0
        self.press = 0.0
        self._was_down = False

    @property
    def focusable(self) -> bool:
        return self.enabled

    def update(self, dt, mouse_pos, mouse_down):
        want = 1.0 if (self.focused and self.enabled) else 0.0
        self.hover = approach(self.hover, want, 14.0, dt)
        held = bool(mouse_down) and self.enabled and self.rect.collidepoint(mouse_pos)
        self.press = approach(self.press, 1.0 if held else 0.0, 22.0, dt)

    def draw(self, surf):
        raise NotImplementedError

    def activate(self):
        pass


class Button(Widget):
    """A primary action.

    Grows a little on focus and squashes on press. The overshoot on the focus ease is what
    makes it feel like a physical control rather than a rectangle that changed colour.
    """

    def __init__(self, rect, label, on_click=None, *, color=None, sub=None,
                 size=27, icon=None, enabled=True, danger=False):
        super().__init__(rect, enabled=enabled)
        self.label = label
        self.sub = sub
        self.on_click = on_click
        self.color = color or theme.ACCENT
        self.size = size
        self.icon = icon
        self.danger = danger
        self.appear = 0.0

    def activate(self):
        if self.enabled and self.on_click:
            audio.click()
            self.on_click()

    def draw(self, surf):
        h = self.hover
        scale = 1.0 + 0.035 * h - 0.045 * self.press
        w = int(self.rect.w * scale)
        ht = int(self.rect.h * scale)
        r = pygame.Rect(0, 0, w, ht)
        r.center = self.rect.center

        accent = self.color if not self.danger else theme.DANGER
        if not self.enabled:
            accent = theme.TEXT_FAINT

        if h > 0.02 and self.enabled:
            g = assets.glow(int(max(w, ht) * 0.72), accent, falloff=2.6, peak=int(70 * h))
            surf.blit(g, g.get_rect(center=r.center), special_flags=pygame.BLEND_ADD)

        top = theme.lerp_color(theme.PANEL_HI, theme.lerp_color(accent, theme.PANEL_HI, 0.55), h)
        bottom = theme.lerp_color(theme.PANEL, theme.lerp_color(accent, theme.PANEL, 0.7), h)
        border = theme.lerp_color(theme.PANEL_LINE, accent, h)
        panel = assets.rounded_panel(r.w, r.h, 14, top, bottom, border, 2)
        surf.blit(panel, r.topleft)

        # A short accent bar on the left edge, filling in as the button takes focus. Gives the
        # row a reading direction and makes the focused item obvious in a stack.
        if self.enabled:
            bar_h = int(r.h * (0.22 + 0.5 * h))
            bar = assets.rounded_panel(4, max(4, bar_h), 2, accent, accent)
            bar.set_alpha(int(90 + 165 * h))
            surf.blit(bar, (r.x + 9, r.centery - bar_h // 2))

        text_col = theme.TEXT if self.enabled else theme.TEXT_FAINT
        tx = r.centerx + (5 if self.icon is None else 16)
        ty = r.centery - (9 if self.sub else 0)

        if self.icon is not None:
            # `icon` is a callable that draws itself at a size, so the widget layer owes nothing
            # to any particular icon set. It was a lookup into a fixed table of power-up glyphs in
            # the game this module came from, which is exactly the kind of coupling that stops a
            # widget being reusable.
            ic = self.icon(int(r.h * 0.46))
            surf.blit(ic, ic.get_rect(center=(r.x + 36, r.centery)))

        fonts.draw(surf, self.label, (tx, ty), self.size, text_col,
                   anchor="center", tracking=2.0 + 1.0 * h,
                   glow=accent if h > 0.3 else None, glow_alpha=int(60 * h))
        if self.sub:
            fonts.draw(surf, self.sub, (tx, r.centery + 15), 14, theme.TEXT_DIM,
                       anchor="center", bold=False, tracking=0.6, shadow=1)


class IconTab(Widget):
    """A compact square selector — used for skins and modes."""

    def __init__(self, rect, on_click=None, *, selected=False, accent=None, locked=False):
        super().__init__(rect)
        self.on_click = on_click
        self.selected = selected
        self.accent = accent or theme.ACCENT
        self.locked = locked

    def activate(self):
        if self.enabled and self.on_click:
            audio.click()
            self.on_click()

    def draw_frame(self, surf) -> pygame.Rect:
        h = max(self.hover, 0.55 if self.selected else 0.0)
        scale = 1.0 + 0.03 * h - 0.03 * self.press
        r = pygame.Rect(0, 0, int(self.rect.w * scale), int(self.rect.h * scale))
        r.center = self.rect.center

        if h > 0.02:
            g = assets.glow(int(r.w * 0.8), self.accent, falloff=2.8, peak=int(64 * h))
            surf.blit(g, g.get_rect(center=r.center), special_flags=pygame.BLEND_ADD)

        top = theme.lerp_color(theme.PANEL_HI, theme.lerp_color(self.accent, theme.PANEL_HI, 0.6), h)
        bottom = theme.lerp_color(theme.PANEL, theme.PANEL, h)
        border = theme.lerp_color(theme.PANEL_LINE, self.accent, max(h, 0.9 if self.selected else 0.0))
        surf.blit(assets.rounded_panel(r.w, r.h, 16, top, bottom, border,
                                       3 if self.selected else 2), r.topleft)
        return r


class Toggle(Widget):
    """An on/off row with a sliding pill."""

    def __init__(self, rect, label, getter, setter, *, color=None):
        super().__init__(rect)
        self.label = label
        self.getter = getter
        self.setter = setter
        self.color = color or theme.ACCENT
        self.knob = 1.0 if getter() else 0.0

    def activate(self):
        audio.click()
        self.setter(not self.getter())

    def update(self, dt, mouse_pos, mouse_down):
        super().update(dt, mouse_pos, mouse_down)
        self.knob = approach(self.knob, 1.0 if self.getter() else 0.0, 16.0, dt)

    def draw(self, surf):
        h = self.hover
        r = self.rect
        border = theme.lerp_color(theme.PANEL_LINE, self.color, h)
        surf.blit(assets.rounded_panel(r.w, r.h, 13,
                                       theme.lerp_color(theme.PANEL_HI, theme.PANEL_HI, h),
                                       theme.PANEL, border, 2), r.topleft)
        fonts.draw(surf, self.label, (r.x + 24, r.centery), 20, theme.TEXT,
                   anchor="midleft", tracking=1.4)

        track_w, track_h = 62, 28
        tx = r.right - track_w - 24
        ty = r.centery - track_h // 2
        on = self.knob
        track_col = theme.lerp_color(theme.PANEL_LINE, self.color, on)
        surf.blit(assets.rounded_panel(track_w, track_h, track_h // 2,
                                       theme.shade(track_col, -0.35), track_col), (tx, ty))
        knob_x = tx + 4 + int((track_w - track_h) * on)
        knob = assets.disc((track_h - 8) // 2, theme.lerp_color(theme.TEXT_DIM, (255, 255, 255), on),
                           None, highlight=False)
        surf.blit(knob, (knob_x, ty + 4))
        if on > 0.5:
            g = assets.glow(20, self.color, falloff=2.4, peak=int(90 * on))
            surf.blit(g, g.get_rect(center=(knob_x + (track_h - 8) // 2, r.centery)),
                      special_flags=pygame.BLEND_ADD)


class Slider(Widget):
    """A 0..1 value. Adjusted with left/right when focused, or by dragging."""

    def __init__(self, rect, label, getter, setter, *, color=None, step=0.05):
        super().__init__(rect)
        self.label = label
        self.getter = getter
        self.setter = setter
        self.color = color or theme.ACCENT
        self.step = step
        self._dragging = False

    def nudge(self, direction: int):
        audio.move()
        self.setter(max(0.0, min(1.0, self.getter() + direction * self.step)))

    def _track(self) -> pygame.Rect:
        w = 210
        return pygame.Rect(self.rect.right - w - 24, self.rect.centery - 5, w, 10)

    def update(self, dt, mouse_pos, mouse_down):
        super().update(dt, mouse_pos, mouse_down)
        track = self._track()
        grab = track.inflate(24, 30)
        if mouse_down and (self._dragging or grab.collidepoint(mouse_pos)):
            self._dragging = True
            v = (mouse_pos[0] - track.x) / max(1, track.w)
            self.setter(max(0.0, min(1.0, v)))
        elif not mouse_down:
            self._dragging = False

    def draw(self, surf):
        h = self.hover
        r = self.rect
        border = theme.lerp_color(theme.PANEL_LINE, self.color, h)
        surf.blit(assets.rounded_panel(r.w, r.h, 13, theme.PANEL_HI, theme.PANEL, border, 2),
                  r.topleft)
        fonts.draw(surf, self.label, (r.x + 24, r.centery), 20, theme.TEXT,
                   anchor="midleft", tracking=1.4)

        track = self._track()
        surf.blit(assets.rounded_panel(track.w, track.h, 5,
                                       theme.shade(theme.PANEL_LINE, -0.3),
                                       theme.PANEL_LINE), track.topleft)
        v = max(0.0, min(1.0, self.getter()))
        fill_w = max(6, int(track.w * v))
        surf.blit(assets.rounded_panel(fill_w, track.h, 5,
                                       theme.shade(self.color, 0.25), self.color), track.topleft)

        kx = track.x + fill_w
        knob = assets.disc(9, (255, 255, 255), theme.shade(self.color, -0.4), 2)
        surf.blit(knob, knob.get_rect(center=(kx, track.centery)))
        fonts.draw(surf, f"{int(round(v * 100))}", (r.right - 250, r.centery), 18,
                   theme.TEXT_DIM, anchor="midright", bold=False)


class Group:
    """A focus ring over a list of widgets, driven by keyboard or mouse.

    Holds the rule that focus follows the mouse when the mouse moves but is otherwise owned by
    the keyboard — so a player using arrow keys does not lose their place because the cursor
    happens to be resting somewhere.
    """

    def __init__(self, widgets=None):
        self.widgets: list[Widget] = list(widgets or [])
        self.index = 0
        self._last_mouse = None
        self._sync()

    def add(self, w):
        self.widgets.append(w)
        self._sync()
        return w

    def clear(self):
        self.widgets.clear()
        self.index = 0

    def _sync(self):
        for i, w in enumerate(self.widgets):
            w.focused = (i == self.index)

    def _focusables(self):
        return [i for i, w in enumerate(self.widgets) if w.focusable]

    def move(self, delta: int):
        order = self._focusables()
        if not order:
            return
        if self.index in order:
            pos = order.index(self.index)
        else:
            pos = 0
        self.index = order[(pos + delta) % len(order)]
        audio.move()
        self._sync()

    def focus(self, widget):
        if widget in self.widgets:
            i = self.widgets.index(widget)
            if i != self.index and widget.focusable:
                self.index = i
                self._sync()

    @property
    def current(self) -> Widget | None:
        if 0 <= self.index < len(self.widgets):
            return self.widgets[self.index]
        return None

    def handle(self, event) -> bool:
        """Returns True when the event was consumed."""
        if event.type == pygame.KEYDOWN:
            if event.key in (pygame.K_DOWN, pygame.K_s, pygame.K_TAB):
                self.move(1)
                return True
            if event.key in (pygame.K_UP, pygame.K_w):
                self.move(-1)
                return True
            if event.key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_SPACE):
                cur = self.current
                if cur:
                    cur.activate()
                return True
            if event.key in (pygame.K_LEFT, pygame.K_a, pygame.K_RIGHT, pygame.K_d):
                cur = self.current
                if isinstance(cur, Slider):
                    cur.nudge(-1 if event.key in (pygame.K_LEFT, pygame.K_a) else 1)
                    return True
        elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            for w in self.widgets:
                if w.focusable and w.rect.collidepoint(event.pos):
                    self.focus(w)
                    w.activate()
                    return True
        elif event.type == pygame.MOUSEMOTION:
            for w in self.widgets:
                if w.focusable and w.rect.collidepoint(event.pos):
                    self.focus(w)
                    break
        return False

    def update(self, dt, mouse_pos, mouse_down):
        for w in self.widgets:
            w.update(dt, mouse_pos, mouse_down)

    def draw(self, surf):
        for w in self.widgets:
            w.draw(surf)


# ── composed pieces ─────────────────────────────────────────────────────────
def panel(surf, rect, *, radius=20, alpha=246, accent=None):
    """The standard card. Everything that holds content sits on one of these."""
    r = pygame.Rect(rect)
    border = accent or theme.PANEL_LINE
    surf.blit(assets.rounded_panel(r.w, r.h, radius, theme.PANEL_HI,
                                   theme.shade(theme.PANEL, -0.15), border, 2, alpha),
              r.topleft)


def title(surf, text, pos, size=76, *, color=None, accent=None, tracking=8.0, anchor="center"):
    """The logo treatment: a wide additive halo under tightly tracked capitals.

    The wide halo is skipped in the browser. For a 300px wordmark it is a 372x372 additive blit —
    about 138,000 pixels — and the menu draws two of them, every frame, behind text that never
    moves. WebAssembly pygame has no vectorised blitters, so that is several milliseconds of a
    16.7 ms budget spent on a glow. The per-glyph halo below stays, so the wordmark is still lit;
    what goes is the broad wash around it, which is the part nobody would miss in a screenshot.
    """
    color = color or theme.TEXT
    accent = accent or theme.ACCENT
    if not _ON_WEB:
        surf_txt = fonts.render_tracked(text, size, accent, True, tracking)
        rect = surf_txt.get_rect(**{anchor: (int(pos[0]), int(pos[1]))})
        halo = assets.glow(int(rect.w * 0.62), accent, falloff=3.0, peak=58)
        surf.blit(halo, halo.get_rect(center=rect.center), special_flags=pygame.BLEND_ADD)
    return fonts.draw(surf, text, pos, size, color, anchor=anchor, tracking=tracking,
                      glow=accent, glow_alpha=110, shadow=3)


def section_label(surf, text, pos, *, color=None, anchor="midleft"):
    fonts.draw(surf, text, pos, 15, color or theme.TEXT_FAINT,
               anchor=anchor, tracking=3.4, shadow=1)


def pill(surf, rect, text, color, *, size=16, filled=False):
    r = pygame.Rect(rect)
    if filled:
        surf.blit(assets.rounded_panel(r.w, r.h, r.h // 2, theme.shade(color, 0.18), color), r.topleft)
        fonts.draw(surf, text, r.center, size, theme.INK, anchor="center", tracking=1.6, shadow=0)
    else:
        surf.blit(assets.rounded_panel(r.w, r.h, r.h // 2, theme.PANEL, theme.PANEL,
                                       color, 2), r.topleft)
        fonts.draw(surf, text, r.center, size, color, anchor="center", tracking=1.6, shadow=1)


def progress_bar(surf, rect, value, color, *, bg=None, radius=None):
    r = pygame.Rect(rect)
    radius = r.h // 2 if radius is None else radius
    surf.blit(assets.rounded_panel(r.w, r.h, radius,
                                   theme.shade(bg or theme.PANEL, -0.2), bg or theme.PANEL),
              r.topleft)
    v = max(0.0, min(1.0, value))
    if v > 0.001:
        w = max(radius * 2, int(r.w * v))
        surf.blit(assets.rounded_panel(w, r.h, radius, theme.shade(color, 0.3), color), r.topleft)


def appear_offset(t: float, delay: float, distance: float = 34.0) -> tuple[float, int]:
    """Staggered entrance for a stack of widgets.

    Returns (y offset, alpha). Callers drive it from a scene clock and a per-item delay, which
    is how every screen in the game gets an entrance without any of them owning an animation.
    """
    k = max(0.0, min(1.0, (t - delay) / 0.34))
    if k <= 0.0:
        return distance, 0
    return distance * (1.0 - ease_out_back(k, 1.2)), int(255 * min(1.0, k * 1.6))
