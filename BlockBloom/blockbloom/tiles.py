"""
The block tile, and the board furniture around it.

Split out from `assets` because the tile is the game — everything else on screen is furniture
around it — and it earns the space.

A flat rounded rectangle in a solid colour is the single thing that makes a puzzle game look like
a programming exercise. The fix is not "add a gradient": it is to build the tile the way a
physical object catches light. Six layers, drawn outward in:

1. a soft drop shadow, offset down, so the tile sits *on* the board rather than in it
2. the body, a vertical gradient from a lifted top to a deepened bottom
3. a bevel — a bright inner stroke where the light comes from, a dark one opposite
4. a broad specular sheen across the upper half, clipped to the tile's own rounded shape
5. a small hard glint near the top-left corner

Lit themes add a sixth layer, an additive halo, but it is drawn as a separate pass by the caller
rather than into the sprite — see `halo` for why it cannot be baked in.

Layer 4 does the most work and is the easiest to get wrong. Drawn as a lighter rectangle it
leaves a visible horizontal seam across every tile on the board. Drawn as an ellipse wider than
the tile and clipped to the rounded mask, it reads as a curved surface instead. That is the whole
difference between a premium casual tile and a rectangle.

Masking rather than redrawing is the technique that holds it together: each layer is drawn as a
simple ellipse or polygon and then multiplied by a rounded-rectangle mask, so every layer
respects the corner radius exactly without any of them having to know it.
"""

from __future__ import annotations

import pygame

from . import theme
from .assets import SS, _cache, _down, _q, _ss_surface, glow, premultiply
from .theme import shade


def _lerp(a, b, t: float) -> tuple:
    """Colour interpolation, called once per supersampled scanline. Kept local and cheap."""
    return (int(a[0] + (b[0] - a[0]) * t),
            int(a[1] + (b[1] - a[1]) * t),
            int(a[2] + (b[2] - a[2]) * t))


def _rounded_mask(size: int, radius: int) -> pygame.Surface:
    """An opaque white rounded square at supersampled size, used to clip the layers."""
    key = ("mask", size, radius)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    m = _ss_surface(size, size)
    pygame.draw.rect(m, (255, 255, 255, 255), (0, 0, size * SS, size * SS),
                     border_radius=int(radius * SS))
    _cache[key] = m
    return m


def _border_mask(size: int, radius: int, width: int) -> pygame.Surface:
    """Only the border ring of a rounded square. Confines the dark half of the bevel."""
    key = ("bmask", size, radius, width)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    m = _ss_surface(size, size)
    pygame.draw.rect(m, (255, 255, 255, 255), (0, 0, size * SS, size * SS),
                     width=width, border_radius=int(radius * SS))
    _cache[key] = m
    return m


def _masked(layer: pygame.Surface, mask: pygame.Surface) -> pygame.Surface:
    """Keep only the parts of `layer` inside `mask`.

    BLEND_RGBA_MULT against a mask that is opaque white inside and transparent outside leaves the
    interior untouched and zeroes everything else.
    """
    out = layer.copy()
    out.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MULT)
    return out


#: How far the halo spills past the tile's edge, as a fraction of the tile. Stated as *reach*
#: rather than as a glow radius, because the two differ by the tile's own half-width and confusing
#: them is exactly how the first version came to generate a halo nobody could see: a glow of
#: radius 0.6*size around a tile of half-width 0.5*size reaches eight pixels, which the shadow
#: then sat on top of.
#:
#: The reach and the falloff are chosen together, and they have to be, because the tile sits on top
#: of the brightest part of its own glow. Measured against a 76px tile on the Neon board, the
#: brightness a halo adds *at the tile's edge* is:
#:
#:     reach   falloff 2.4   falloff 1.5   falloff 1.0
#:     0.22      +2            +14           +27
#:     0.34      +8            +22           +38
#:
#: A steep falloff has spent almost all of its light before it clears the tile, which is why the
#: first attempt at this was invisible even with the padding fixed. So: a wide-ish reach and a
#: nearly linear ramp. Not wider — 64 overlapping haloes would smear the grid, and the sprite grows
#: quadratically with the reach.
GLOW_REACH = 0.34
GLOW_FALLOFF = 1.2


def glow_radius(size: int) -> int:
    return int(size * (0.5 + GLOW_REACH))


def pad_for(size: int, glowing: bool = False) -> int:
    """Margin around a tile for its shadow and halo. Derived so it scales with the tile."""
    if glowing:
        return max(4, int(size * GLOW_REACH) + 2)
    return max(3, int(size * 0.15))


def radius_for(size: int) -> int:
    """Corner radius as a fixed fraction of the tile, so tiles look identical at every scale."""
    return max(3, int(size * 0.19))


def halo(size: int, color: tuple, peak: int | None = None) -> pygame.Surface:
    """The additive glow that sits under a tile on a lit theme.

    Deliberately *not* baked into the tile sprite, and the reason is worth recording because it
    cost an hour. `BLEND_ADD` adds the colour channels and leaves the destination alpha alone — so
    compositing a glow into the tile's own transparent scratch surface produces the right colour at
    alpha zero, which is to say nothing at all. Additive light has to land on the opaque surface it
    is lighting. Hence a separate pass: `blit_halo` for every filled cell, then the tiles.
    """
    if peak is None:
        peak = theme.BLOCK_GLOW
    return glow(glow_radius(size), color, falloff=GLOW_FALLOFF, peak=peak)


def blit_halo(dest: pygame.Surface, size: int, color: tuple, pos) -> None:
    """Add a tile's glow to an opaque destination, centred where the tile will be."""
    g = halo(size, color)
    dest.blit(g, g.get_rect(center=(int(pos[0]) + size // 2, int(pos[1]) + size // 2)),
              special_flags=pygame.BLEND_ADD)


def tile(size: int, color: tuple, *, shine: float | None = None,
         shadow: bool | None = None) -> pygame.Surface:
    """One block tile, drawn as a lit object.

    The surface returned is larger than `size` when it carries a shadow. Blit it through
    `blit_tile` so the tile's own top-left still lands where you asked.

    `shadow=None` means "decide from the theme": a tile that glows should not also cast a hard
    shadow, because that reads as two contradictory light sources.
    """
    size = max(6, int(size))
    radius = radius_for(size)
    if shine is None:
        shine = theme.BLOCK_SHINE
    if shadow is None:
        shadow = not theme.BLOCK_GLOW
    pad = pad_for(size) if shadow else 0

    key = ("tile", size, _q(color, 6), round(shine, 2), shadow)
    hit = _cache.get(key)
    if hit is not None:
        return hit

    full = size + pad * 2
    out = pygame.Surface((full, full), pygame.SRCALPHA)
    n = size * SS
    rr = int(radius * SS)

    # Drop shadow: the same silhouette, dark and translucent, pushed down.
    if shadow:
        sh = _ss_surface(size, size)
        pygame.draw.rect(sh, (0, 0, 0, 100), (0, 0, n, n), border_radius=rr)
        out.blit(_down(sh, size, size), (pad, pad + max(2, size // 15)))

    mask = _rounded_mask(size, radius)

    # 1. Body gradient — one material, lifted at the top and deepened at the bottom.
    body = _ss_surface(size, size)
    top = shade(color, 0.18 + 0.18 * shine)
    bottom = shade(color, -0.26)
    for y in range(n):
        pygame.draw.line(body, _lerp(top, bottom, y / max(1, n - 1)), (0, y), (n, y))
    body = _masked(body, mask)

    # 2. Bevel. Light stroke all round, then the lower-right half overpainted dark along the
    #    diagonal, which is how a real bevel transitions.
    lw = max(SS, int(n * 0.055))
    bev = _ss_surface(size, size)
    pygame.draw.rect(bev, (*shade(color, 0.58), int(120 + 90 * shine)), (0, 0, n, n),
                     width=lw, border_radius=rr)
    dark = _ss_surface(size, size)
    pygame.draw.polygon(dark, (*shade(color, -0.52), 175), [(n, 0), (n, n), (0, n)])
    bev.blit(_masked(dark, _border_mask(size, radius, lw)), (0, 0))
    body.blit(_masked(bev, mask), (0, 0))

    # 3. Specular sheen — wide, soft, clipped to the corners.
    sheen = _ss_surface(size, size)
    ew, eh = int(n * 1.5), int(n * 0.80)
    pygame.draw.ellipse(sheen, (255, 255, 255, int(26 + 60 * shine)),
                        ((n - ew) // 2, int(-eh * 0.54), ew, eh))
    body.blit(_masked(sheen, mask), (0, 0))

    # 4. Glint. Small, bright, high and left. What sells a glossy material.
    if size >= 18:
        gl = _ss_surface(size, size)
        pygame.draw.ellipse(gl, (255, 255, 255, int(80 + 95 * shine)),
                            (int(n * 0.17), int(n * 0.14), int(n * 0.26), int(n * 0.17)))
        body.blit(_masked(gl, mask), (0, 0))

    out.blit(_down(body, size, size), (pad, pad))
    _cache[key] = out
    return out


def blit_tile(dest: pygame.Surface, size: int, color: tuple, pos, **kw) -> None:
    """Draw a tile so its own top-left corner lands on `pos`, shadow and halo notwithstanding."""
    surf = tile(size, color, **kw)
    pad = (surf.get_width() - size) // 2
    dest.blit(surf, (int(pos[0]) - pad, int(pos[1]) - pad))


def flat(size: int, color: tuple, alpha: int = 255) -> pygame.Surface:
    """A flat rounded tile: no shadow, no sheen, no bevel.

    For the tray and the ghost preview, where a shadow would collide with the neighbouring cell
    and where the point is to read as *not yet real*.
    """
    size = max(4, int(size))
    radius = radius_for(size)
    key = ("flat", size, _q(color, 6), alpha)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    s = _ss_surface(size, size)
    pygame.draw.rect(s, (*color, alpha), (0, 0, size * SS, size * SS),
                     border_radius=int(radius * SS))
    out = _down(s, size, size)
    _cache[key] = out
    return out


def outline(size: int, color: tuple, width: int = 3, alpha: int = 220) -> pygame.Surface:
    """A hollow rounded tile — the placement preview's edge."""
    size = max(4, int(size))
    radius = radius_for(size)
    key = ("outline", size, _q(color, 6), width, alpha)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    s = _ss_surface(size, size)
    pygame.draw.rect(s, (*color, alpha), (0, 0, size * SS, size * SS),
                     width=int(width * SS), border_radius=int(radius * SS))
    out = _down(s, size, size)
    _cache[key] = out
    return out


def well(size: int) -> pygame.Surface:
    """An empty board cell, as a recess.

    Depth from two strokes: dark along the top and left where a real recess would be shadowed,
    faintly lit along the bottom and right. Deliberately subtle — an empty cell must stay clearly
    visible without ever competing with a filled one.
    """
    size = max(4, int(size))
    radius = max(2, int(size * 0.17))
    key = ("well", size, _q(theme.WELL, 4), _q(theme.WELL_LINE, 4))
    hit = _cache.get(key)
    if hit is not None:
        return hit

    n = size * SS
    s = _ss_surface(size, size)
    pygame.draw.rect(s, (*theme.WELL, 255), (0, 0, n, n), border_radius=int(radius * SS))

    lw = max(SS, int(n * 0.05))
    inner = _ss_surface(size, size)
    pygame.draw.rect(inner, (*shade(theme.WELL, -0.45), 185), (0, 0, n, n),
                     width=lw, border_radius=int(radius * SS))
    lit = _ss_surface(size, size)
    pygame.draw.polygon(lit, (*shade(theme.WELL, 0.32), 140), [(n, 0), (n, n), (0, n)])
    inner.blit(_masked(lit, _border_mask(size, radius, lw)), (0, 0))
    s.blit(_masked(inner, _rounded_mask(size, radius)), (0, 0))

    out = _down(s, size, size)
    _cache[key] = out
    return out


def line_flash(w: int, h: int, color: tuple, intensity: int) -> pygame.Surface:
    """A rounded band that *brightens* what it covers, for the would-complete-a-line highlight.

    Additive and premultiplied rather than a translucent overlay, and the difference is not
    cosmetic. An alpha wash averages itself with the tiles underneath, so laying one over a row of
    saturated blocks desaturates them — the highlight made the row look greyed out and disabled,
    which is the opposite of the message. Adding light instead lifts the filled tiles and the empty
    wells together and leaves every colour recognisable.
    """
    key = ("lineflash", w, h, _q(color, 8), intensity)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    k = max(0, min(255, intensity)) / 255.0
    s = _ss_surface(w, h)
    pygame.draw.rect(s, (int(color[0] * k), int(color[1] * k), int(color[2] * k), 255),
                     (0, 0, w * SS, h * SS), border_radius=int(min(w, h) * 0.22 * SS))
    out = _down(s, w, h)
    _cache[key] = out
    return out


def board_panel(w: int, h: int, radius: int) -> pygame.Surface:
    """The board's tray: a face, a rim, and an inner shadow so it reads as having walls."""
    key = ("board_panel", w, h, radius, _q(theme.BOARD, 4), _q(theme.BOARD_EDGE, 4))
    hit = _cache.get(key)
    if hit is not None:
        return hit
    s = _ss_surface(w, h)
    W, H, r = w * SS, h * SS, int(radius * SS)
    pygame.draw.rect(s, (*theme.BOARD, 255), (0, 0, W, H), border_radius=r)
    pygame.draw.rect(s, (*shade(theme.BOARD, -0.55), 135), (0, 0, W, H),
                     width=int(6 * SS), border_radius=r)
    pygame.draw.rect(s, (*theme.BOARD_EDGE, 205), (0, 0, W, H),
                     width=int(2 * SS), border_radius=r)
    out = _down(s, w, h)
    _cache[key] = out
    return out


def sparkle(size: int, color: tuple) -> pygame.Surface:
    """A four-point star flare, premultiplied for additive use in clear bursts."""
    size = max(4, int(size))
    key = ("sparkle", size, _q(color, 8))
    hit = _cache.get(key)
    if hit is not None:
        return hit
    n = size * SS
    s = _ss_surface(size, size)
    c = n // 2
    thin = max(SS, int(n * 0.05))
    for dx, dy in ((1, 0), (0, 1)):
        pygame.draw.polygon(s, (*color, 255), [
            (c + dx * c, c + dy * c),
            (c + dy * thin, c + dx * thin),
            (c - dx * c, c - dy * c),
            (c - dy * thin, c - dx * thin),
        ])
    pygame.draw.circle(s, (*color, 255), (c, c), int(n * 0.10))
    out = premultiply(_down(s, size, size))
    _cache[key] = out
    return out


def coin(size: int) -> pygame.Surface:
    """The currency mark: a gold disc with a rim and an inner ring."""
    size = max(8, int(size))
    key = ("coin", size)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    n = size * SS
    s = _ss_surface(size, size)
    c = n // 2
    outer = c - SS
    pygame.draw.circle(s, (*shade(theme.GOLD, -0.45), 255), (c, c), outer)
    pygame.draw.circle(s, (*theme.GOLD, 255), (c, c), int(outer * 0.86))
    pygame.draw.circle(s, (*shade(theme.GOLD, 0.32), 255), (c, c), int(outer * 0.56))
    pygame.draw.circle(s, (*shade(theme.GOLD, -0.25), 255), (c, c), int(outer * 0.56),
                       width=max(SS, int(n * 0.035)))
    out = _down(s, size, size)
    _cache[key] = out
    return out
