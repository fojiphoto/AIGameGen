"""
Typography.

pygame's bundled default font is the single loudest "this is a programming exercise" signal a
game can send, so it is only ever reached as a last resort. Instead a prioritised stack of
faces that ship with each platform is probed once at startup and the first hit wins.

Two things here that pygame does not give you and that a designed interface needs:

* letter tracking — `render_tracked` lays out glyph by glyph, because uppercase display text
  set solid looks cramped and every real title treatment opens it up;
* text that sits on a lit background — `draw` composites a soft drop shadow and an optional
  outer glow, so a label stays readable over a bright particle burst without a solid plate
  behind it.

Rendered strings are cached. The HUD redraws the same score every frame at 60 Hz and
re-rasterising it each time is pure waste.
"""

from __future__ import annotations

import pygame

# Ordered by preference, not by likelihood. Anything geometric and humanist reads as "game
# UI"; anything with visible serifs or a typewriter feel does not.
_STACK = (
    "Segoe UI",         # Windows
    "SF Pro Display",   # macOS 11+
    "Helvetica Neue",
    "Inter",
    "Roboto",
    "Ubuntu",
    "DejaVu Sans",      # near-universal on Linux
    "Verdana",
    "Tahoma",
    "Arial",
)

_family_cache: dict[bool, str | None] = {}
_font_cache: dict[tuple, pygame.font.Font] = {}
_text_cache: dict[tuple, pygame.Surface] = {}


def _ensure() -> None:
    """Bring the font subsystem up if nobody has yet.

    Self-initialising so that assets and text can be generated before — or entirely without —
    an application object, which is what lets the headless harness exercise them directly.
    """
    if not pygame.font.get_init():
        pygame.font.init()


def _family(bold: bool) -> str | None:
    """First installed family from the stack, or None to fall back to pygame's own font."""
    if bold in _family_cache:
        return _family_cache[bold]
    _ensure()
    installed = set(pygame.font.get_fonts())
    chosen = None
    for name in _STACK:
        # get_fonts() reports normalised names: lowercase, no spaces or punctuation.
        if name.lower().replace(" ", "").replace("-", "") in installed:
            chosen = name
            break
    _family_cache[bold] = chosen
    return chosen


def get(size: int, bold: bool = False) -> pygame.font.Font:
    key = (size, bold)
    f = _font_cache.get(key)
    if f is None:
        _ensure()
        fam = _family(bold)
        if fam:
            f = pygame.font.SysFont(fam, size, bold=bold)
        else:
            f = pygame.font.Font(None, int(size * 1.28))
            f.set_bold(bold)
        _font_cache[key] = f
    return f


def _render(text: str, size: int, bold: bool, color: tuple) -> pygame.Surface:
    key = (text, size, bold, color)
    surf = _text_cache.get(key)
    if surf is None:
        surf = get(size, bold).render(text, True, color)
        # Unbounded growth is not a real risk — the game draws from a small vocabulary of
        # strings — but a score counter alone would add one entry per point without a cap.
        if len(_text_cache) > 1400:
            _text_cache.clear()
        _text_cache[key] = surf
    return surf


def render_tracked(text: str, size: int, color: tuple, bold: bool = True,
                   tracking: float = 0.0) -> pygame.Surface:
    """Render with extra space between glyphs.

    Used for titles and small uppercase labels, where set-solid capitals look cramped. Falls
    back to a plain render when tracking is zero so the common path stays cached.
    """
    if tracking <= 0.01:
        return _render(text, size, bold, color)

    key = ("~tracked", text, size, bold, color, round(tracking, 2))
    cached = _text_cache.get(key)
    if cached is not None:
        return cached

    font = get(size, bold)
    glyphs = [(ch, font.render(ch, True, color)) for ch in text]
    width = sum(g.get_width() for _, g in glyphs) + int(tracking * max(0, len(glyphs) - 1))
    height = font.get_height()
    surf = pygame.Surface((max(1, width), height), pygame.SRCALPHA)
    x = 0
    for _, g in glyphs:
        surf.blit(g, (x, 0))
        x += g.get_width() + tracking
    if len(_text_cache) > 1400:
        _text_cache.clear()
    _text_cache[key] = surf
    return surf


def _halo(text: str, size: int, bold: bool, tracking: float,
          color: tuple, strength: int) -> pygame.Surface:
    """A premultiplied, pre-dimmed copy of a string, for additive blitting.

    Two things make this necessary rather than a `set_alpha` away. SDL_ttf leaves the requested
    colour in the RGB channels of *fully transparent* pixels, and pygame's additive blend reads
    only RGB — so blitting a text surface additively paints a solid rectangle the size of the
    text, which is exactly what every glowing label in the game used to be sitting on. And
    because alpha is ignored, the halo's strength has to be baked into the colour too.

    Cached on the dimmed colour, so the small set of glow strengths the interface actually uses
    resolves to a small set of surfaces.
    """
    from . import assets

    lit = (int(color[0] * strength / 255), int(color[1] * strength / 255),
           int(color[2] * strength / 255))
    key = ("~halo", text, size, bold, round(tracking, 2), lit)
    cached = _text_cache.get(key)
    if cached is not None:
        return cached
    surf = assets.premultiply(render_tracked(text, size, lit, bold, tracking).copy())
    if len(_text_cache) > 1400:
        _text_cache.clear()
    _text_cache[key] = surf
    return surf


def measure(text: str, size: int, bold: bool = True, tracking: float = 0.0) -> tuple[int, int]:
    s = render_tracked(text, size, (255, 255, 255), bold, tracking)
    return s.get_size()


def draw(dest: pygame.Surface, text: str, pos, size: int, color: tuple, *,
         bold: bool = True, anchor: str = "topleft", tracking: float = 0.0,
         shadow: int = 2, glow: tuple | None = None, glow_alpha: int = 70,
         alpha: int = 255) -> pygame.Rect:
    """Draw a string and return the rect it occupied.

    `anchor` accepts any pygame.Rect attribute name ("center", "midtop", "topright", ...),
    which means callers position text by intent rather than by arithmetic.
    """
    surf = render_tracked(text, size, color, bold, tracking)
    rect = surf.get_rect(**{anchor: (int(pos[0]), int(pos[1]))})

    if glow is not None:
        # Four offset copies read as a soft halo far more cheaply than a real blur, and at the
        # sizes used here the difference is not visible.
        halo = _halo(text, size, bold, tracking, glow, glow_alpha)
        for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2)):
            dest.blit(halo, (rect.x + dx, rect.y + dy), special_flags=pygame.BLEND_ADD)

    if shadow:
        sh = render_tracked(text, size, (0, 0, 0), bold, tracking)
        sh.set_alpha(120 if alpha >= 255 else int(120 * alpha / 255))
        dest.blit(sh, (rect.x + shadow, rect.y + shadow))

    if alpha < 255:
        surf = surf.copy()
        surf.set_alpha(alpha)
    dest.blit(surf, rect)
    return rect


def clear_cache() -> None:
    _text_cache.clear()
    _font_cache.clear()
    _family_cache.clear()
