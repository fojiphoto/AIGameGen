"""
Every pixel in the game, generated at runtime.

There are no image files in this project and there is no build step that makes any. Sprites,
glows, gradients, icons, panels and particles are all drawn here into cached pygame surfaces
the first time something asks for them.

Three techniques do most of the work:

* **Supersampling.** pygame's drawing primitives are not antialiased (`border_radius` least of
  all), and hard-edged circles are the thing that makes procedural art look procedural. So
  shapes are drawn at `SS` times the final size and `smoothscale`d down, which gives clean
  edges everywhere for one extra allocation at generation time and nothing per frame.
* **numpy for fields, where it exists.** Anything defined per pixel rather than per shape —
  radial glows, the background wash, the vignette — is built as an array and written straight
  into the surface. A Python loop over a 1280x720 alpha channel takes the better part of a
  second; the array form is milliseconds.

  Every one of those has a pygame-only fallback, and it is not hypothetical insurance. The
  WebAssembly build ships no numpy: pygbag lists a wheel for it but only publishes one built
  against CPython 3.11, while its current runtime is 3.12, so the install 404s and the page dies
  with an unhandled rejection before the game is ever reached. The fallbacks draw the same
  fields as nested shapes instead — pygame's draw primitives WRITE colour rather than blending
  it, so filling outside-in leaves each pixel showing the innermost shape that covered it,
  which is exactly a radial ramp. Slightly banded, generated once, and it means the browser
  build depends on nothing but pygame.
* **Cache everything, key by intent.** Nothing here is called in a draw loop without a cache
  behind it. Colours are quantised before they reach a cache key so that a gradient sweeping
  through the body of the snake reuses a small ramp of sprites instead of allocating one per
  segment per frame.
"""

from __future__ import annotations

import math

import pygame

try:
    import numpy as np
    HAVE_NUMPY = True
except ImportError:  # pragma: no cover - exercised only where no wheel exists
    np = None
    HAVE_NUMPY = False

from . import theme
from .theme import shade

#: Supersample factor for shape drawing. 4 is past the point of visible improvement at these
#: sizes; 3 is not quite enough on the thin outlines.
SS = 4

_cache: dict = {}


def clear_cache() -> None:
    _cache.clear()


def _q(c, step: int = 10) -> tuple:
    """Quantise a colour so near-identical shades share a cache entry."""
    return (int(c[0]) // step * step, int(c[1]) // step * step, int(c[2]) // step * step)


def dim(color, scale: float) -> tuple:
    """Scale a colour's brightness.

    The way to fade an ADDITIVE sprite. `Surface.set_alpha` cannot do it: pygame's additive
    blend reads only the RGB channels and ignores alpha entirely, per-surface and per-pixel
    alike — so a glow faded with set_alpha arrives at full strength. Quantised to sixteen steps
    so a fading particle reuses a small ramp of cached sprites instead of allocating one per
    frame.
    """
    s = max(0.0, min(1.0, scale))
    step = round(s * 15) / 15.0
    return (int(color[0] * step), int(color[1] * step), int(color[2] * step))


def premultiply(surf: pygame.Surface) -> pygame.Surface:
    """Multiply RGB by alpha in place, so the surface is correct for additive blitting.

    Needed for anything drawn with per-pixel alpha that will be blended additively — most
    importantly text, because SDL_ttf leaves the requested colour in the RGB channels of fully
    transparent pixels. Blitted additively that paints a solid rectangle the size of the text.

    Returns an OPAQUE surface. Every caller blits the result additively, and additive blending
    reads only RGB — so the alpha channel is not merely unnecessary here, dropping it is what
    makes the no-numpy path a single blit: compositing onto opaque black gives
    `src*a + 0*(1-a)`, which is the definition of premultiplied. Verified identical to the
    array version channel for channel.
    """
    if not HAVE_NUMPY:
        out = pygame.Surface(surf.get_size())
        out.fill((0, 0, 0))
        out.blit(surf, (0, 0))
        return out

    surf = surf.copy()
    rgb = pygame.surfarray.pixels3d(surf)
    alpha = pygame.surfarray.pixels_alpha(surf)
    f = alpha.astype(np.float32) / 255.0
    for i in range(3):
        rgb[:, :, i] = (rgb[:, :, i] * f).astype(np.uint8)
    del rgb, alpha
    return surf


# ── fields (numpy) ──────────────────────────────────────────────────────────
def glow(radius: int, color: tuple, falloff: float = 2.2, peak: int = 255) -> pygame.Surface:
    """A soft radial light, PREMULTIPLIED for additive blitting.

    The falloff `(1 - r/R) ** falloff` is baked into the RGB channels, not just into alpha,
    because additive blending ignores alpha — a glow whose RGB was a constant colour arrived as
    a solid square of that colour at full strength. The alpha channel is still written, so the
    same sprite also composites correctly on the rare occasion it is blitted normally.

    `peak` is the brightness, and it is part of the cache key: fading an additive sprite means
    regenerating it dimmer, so brightness has to be baked at generation time.
    """
    radius = max(2, int(radius))
    peak = max(0, min(255, int(peak)))
    key = ("glow", radius, _q(color, 16), round(falloff, 2), peak)
    if key in _cache:
        return _cache[key]

    size = radius * 2
    surf = pygame.Surface((size, size), pygame.SRCALPHA)

    if HAVE_NUMPY:
        yy, xx = np.mgrid[0:size, 0:size]
        d = np.sqrt((xx - radius + 0.5) ** 2 + (yy - radius + 0.5) ** 2) / radius
        prof = (np.clip(1.0 - d, 0.0, 1.0) ** falloff * (peak / 255.0)).T
        rgb = pygame.surfarray.pixels3d(surf)
        alpha = pygame.surfarray.pixels_alpha(surf)
        for i in range(3):
            rgb[:, :, i] = (prof * color[i]).astype(np.uint8)
        alpha[:, :] = (prof * 255.0).astype(np.uint8)
        del rgb, alpha
    else:
        # Nested circles, largest first. Draw writes rather than blends, so each pixel ends up
        # showing the innermost circle that reached it — a radial ramp in O(steps) draw calls.
        #
        # The brightness of the circle of radius r is the profile AT r, which is
        # `(1 - r/radius) ** falloff`: nearly nothing at the rim, full at the core. Getting that
        # the wrong way round makes the largest circle the brightest, and every glow in the game
        # comes out as a hard-edged disc — which is exactly what the first version did.
        steps = max(8, min(radius, 64))
        for i in range(steps):
            t = (i + 1) / steps                # ->0 at the rim, 1 at the core
            r = int(radius * (1.0 - t)) + 1
            v = (t ** falloff) * (peak / 255.0)
            pygame.draw.circle(surf, (int(color[0] * v), int(color[1] * v),
                                      int(color[2] * v), int(v * 255)),
                               (radius, radius), max(1, r))

    _cache[key] = surf
    return surf


def vertical_gradient(size, top: tuple, bottom: tuple) -> pygame.Surface:
    w, h = int(size[0]), int(size[1])
    key = ("vgrad", w, h, top, bottom)
    if key in _cache:
        return _cache[key]

    surf = pygame.Surface((w, h))
    if HAVE_NUMPY:
        t = np.linspace(0.0, 1.0, h, dtype=np.float32)[None, :]
        rgb = pygame.surfarray.pixels3d(surf)
        for i in range(3):
            rgb[:, :, i] = (top[i] + (bottom[i] - top[i]) * t).astype(np.uint8)
        del rgb
    else:
        # One filled row per scanline. At 720 rows this is not worth optimising.
        for y in range(h):
            t = y / max(1, h - 1)
            surf.fill((int(top[0] + (bottom[0] - top[0]) * t),
                       int(top[1] + (bottom[1] - top[1]) * t),
                       int(top[2] + (bottom[2] - top[2]) * t)), (0, y, w, 1))

    _cache[key] = surf
    return surf


def radial_wash(size, center, radius: float, color: tuple, peak: int = 90) -> pygame.Surface:
    """A large, very soft pool of light. Used to lift the middle of the arena off the walls."""
    w, h = int(size[0]), int(size[1])
    key = ("wash", w, h, (int(center[0]), int(center[1])), int(radius), _q(color, 16), peak)
    if key in _cache:
        return _cache[key]

    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    if HAVE_NUMPY:
        yy, xx = np.mgrid[0:h, 0:w]
        d = np.sqrt((xx - center[0]) ** 2 + (yy - center[1]) ** 2) / max(1.0, radius)
        a = np.clip(1.0 - d, 0.0, 1.0) ** 2.0 * peak
        rgb = pygame.surfarray.pixels3d(surf)
        alpha = pygame.surfarray.pixels_alpha(surf)
        rgb[:, :, 0] = color[0]
        rgb[:, :, 1] = color[1]
        rgb[:, :, 2] = color[2]
        alpha[:, :] = a.T.astype(np.uint8)
        del rgb, alpha
    else:
        # Same ordering as `glow`: the ring at radius r carries the profile at r, so the outer
        # rings are the faint ones.
        steps = 64
        cx, cy = int(center[0]), int(center[1])
        for i in range(steps):
            t = (i + 1) / steps
            r = int(radius * (1.0 - t)) + 1
            pygame.draw.circle(surf, (*color, int((t ** 2.0) * peak)), (cx, cy), max(1, r))

    _cache[key] = surf
    return surf


def vignette(size, strength: int = 190) -> pygame.Surface:
    """Darkened corners. Squared distance from centre, normalised on the long axis."""
    w, h = int(size[0]), int(size[1])
    key = ("vig", w, h, strength)
    if key in _cache:
        return _cache[key]

    surf = pygame.Surface((w, h), pygame.SRCALPHA)
    if HAVE_NUMPY:
        yy, xx = np.mgrid[0:h, 0:w]
        nx = (xx - w * 0.5) / (w * 0.5)
        ny = (yy - h * 0.5) / (h * 0.5)
        d = np.sqrt(nx * nx + ny * ny) / 1.4142
        a = np.clip((d - 0.42) / 0.58, 0.0, 1.0) ** 1.9 * strength

        rgb = pygame.surfarray.pixels3d(surf)
        alpha = pygame.surfarray.pixels_alpha(surf)
        rgb[:, :, 0] = theme.VIGNETTE[0]
        rgb[:, :, 1] = theme.VIGNETTE[1]
        rgb[:, :, 2] = theme.VIGNETTE[2]
        alpha[:, :] = a.T.astype(np.uint8)
        del rgb, alpha
    else:
        # Nested ellipses, outside in. The corners sit beyond the largest inscribed ellipse, so
        # the surface starts at full strength and each ellipse overwrites a lighter ring inside
        # the last — ending at fully transparent in the middle.
        surf.fill((*theme.VIGNETTE, strength))
        steps = 56
        for i in range(steps + 1):
            t = i / steps                      # 0 at the rim, 1 at the centre
            d = 1.4142 * (1.0 - t)
            a = max(0.0, min(1.0, (d - 0.42) / 0.58)) ** 1.9 * strength
            rw = int(w * 0.5 * (1.0 - t) * 1.4142)
            rh = int(h * 0.5 * (1.0 - t) * 1.4142)
            if rw < 2 or rh < 2:
                continue
            pygame.draw.ellipse(surf, (*theme.VIGNETTE, int(a)),
                                (w // 2 - rw, h // 2 - rh, rw * 2, rh * 2))

    _cache[key] = surf
    return surf


# ── shapes (supersampled) ───────────────────────────────────────────────────
def _ss_surface(w: int, h: int) -> pygame.Surface:
    return pygame.Surface((int(w) * SS, int(h) * SS), pygame.SRCALPHA)


def _down(surf: pygame.Surface, w: int, h: int) -> pygame.Surface:
    return pygame.transform.smoothscale(surf, (int(w), int(h)))


def disc(radius: int, fill: tuple, outline: tuple | None = None,
         outline_w: int = 2, highlight: bool = True) -> pygame.Surface:
    """A body-segment style disc: fill, dark rim, and a light catch on the upper left."""
    radius = max(2, int(radius))
    key = ("disc", radius, _q(fill), _q(outline) if outline else None, outline_w, highlight)
    if key in _cache:
        return _cache[key]

    size = radius * 2 + 2
    s = _ss_surface(size, size)
    c = (size * SS) // 2
    r = radius * SS

    if outline:
        pygame.draw.circle(s, outline, (c, c), r)
        pygame.draw.circle(s, fill, (c, c), max(1, r - outline_w * SS))
    else:
        pygame.draw.circle(s, fill, (c, c), r)

    if highlight and radius >= 4:
        hi = shade(fill, 0.34)
        hr = max(1, int(r * 0.44))
        pygame.draw.circle(s, hi, (int(c - r * 0.26), int(c - r * 0.3)), hr)

    out = _down(s, size, size)
    _cache[key] = out
    return out


def rounded_panel(w: int, h: int, radius: int, top: tuple, bottom: tuple,
                  border: tuple | None = None, border_w: int = 2,
                  alpha: int = 255) -> pygame.Surface:
    """A UI panel: vertical gradient fill, rounded corners, optional hairline border.

    Built by drawing the rounded shape as a mask and multiplying a gradient through it, which
    keeps the corners as clean as the supersample allows while still giving a real gradient
    rather than a flat fill.
    """
    w, h, radius = int(w), int(h), int(radius)
    key = ("panel", w, h, radius, top, bottom, border, border_w, alpha)
    if key in _cache:
        return _cache[key]

    mask = _ss_surface(w, h)
    pygame.draw.rect(mask, (255, 255, 255, 255), (0, 0, w * SS, h * SS), border_radius=radius * SS)
    mask = _down(mask, w, h)

    # Composited into a fresh SRCALPHA surface rather than via convert_alpha(), which raises
    # unless a display has been opened. Asset generation has to work before — and without — a
    # window, so that the test harness can exercise it headless.
    grad = pygame.Surface((w, h), pygame.SRCALPHA)
    grad.blit(vertical_gradient((w, h), top, bottom), (0, 0))
    grad.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MULT)

    if border:
        bs = _ss_surface(w, h)
        pygame.draw.rect(bs, border, (0, 0, w * SS, h * SS),
                         width=border_w * SS, border_radius=radius * SS)
        grad.blit(_down(bs, w, h), (0, 0))

    if alpha < 255:
        grad.set_alpha(alpha)

    _cache[key] = grad
    return grad


def ring(radius: int, thickness: int, color: tuple) -> pygame.Surface:
    radius, thickness = max(3, int(radius)), max(1, int(thickness))
    key = ("ring", radius, thickness, _q(color))
    if key in _cache:
        return _cache[key]
    size = radius * 2 + 2
    s = _ss_surface(size, size)
    c = (size * SS) // 2
    pygame.draw.circle(s, color, (c, c), radius * SS, width=thickness * SS)
    out = _down(s, size, size)
    _cache[key] = out
    return out


def star(radius: int, points: int, inner: float, color: tuple,
         outline: tuple | None = None) -> pygame.Surface:
    radius = max(4, int(radius))
    key = ("star", radius, points, round(inner, 2), _q(color), _q(outline) if outline else None)
    if key in _cache:
        return _cache[key]

    size = radius * 2 + 2
    s = _ss_surface(size, size)
    c = (size * SS) / 2
    r = radius * SS
    verts = []
    for i in range(points * 2):
        ang = -math.pi / 2 + i * math.pi / points
        rad = r if i % 2 == 0 else r * inner
        verts.append((c + math.cos(ang) * rad, c + math.sin(ang) * rad))
    if outline:
        pygame.draw.polygon(s, outline, verts)
        inner_verts = [(c + (x - c) * 0.82, c + (y - c) * 0.82) for x, y in verts]
        pygame.draw.polygon(s, color, inner_verts)
    else:
        pygame.draw.polygon(s, color, verts)

    out = _down(s, size, size)
    _cache[key] = out
    return out


def gem(radius: int, color: tuple, outline: tuple) -> pygame.Surface:
    """A faceted hexagonal crystal — two tones so it reads as three-dimensional."""
    radius = max(4, int(radius))
    key = ("gem", radius, _q(color), _q(outline))
    if key in _cache:
        return _cache[key]

    size = radius * 2 + 2
    s = _ss_surface(size, size)
    c = (size * SS) / 2
    r = radius * SS
    hexa = [(c + math.cos(-math.pi / 2 + i * math.pi / 3) * r,
             c + math.sin(-math.pi / 2 + i * math.pi / 3) * r) for i in range(6)]
    pygame.draw.polygon(s, outline, hexa)
    inner = [(c + (x - c) * 0.84, c + (y - c) * 0.84) for x, y in hexa]
    pygame.draw.polygon(s, color, inner)
    # Left half darkened, top facet lifted: a cheap two-plane shading that reads at 15px.
    pygame.draw.polygon(s, shade(color, -0.25), [inner[3], inner[4], inner[5], inner[0]])
    pygame.draw.polygon(s, shade(color, 0.42), [inner[5], inner[0], (c, c)])

    out = _down(s, size, size)
    _cache[key] = out
    return out


# ── snake ───────────────────────────────────────────────────────────────────
def segment(skin_key: str, t: float, radius: int) -> pygame.Surface:
    """One body segment.

    `t` is the position along the body, 0 at the neck and 1 at the tail tip, and is quantised
    to sixteen steps. That is what keeps a smoothly graded two-hundred-segment snake down to a
    handful of cached sprites instead of one allocation per segment per frame.
    """
    sk = theme.skin(skin_key)
    step = round(max(0.0, min(1.0, t)) * 15) / 15.0
    radius = max(2, int(radius))
    key = ("seg", skin_key, step, radius)
    if key in _cache:
        return _cache[key]

    fill = theme.lerp_color(sk.body_a, sk.body_b, step)
    out = disc(radius, fill, sk.outline, outline_w=2 if radius > 6 else 1)
    _cache[key] = out
    return out


def head(skin_key: str, radius: int) -> pygame.Surface:
    """The head, drawn facing +x so it can simply be rotated to the heading.

    Eye whites are baked in; pupils are drawn live by the snake so they can track whatever the
    player is about to eat. A head whose eyes never move is the single clearest tell that a
    character is a shape rather than a creature.
    """
    sk = theme.skin(skin_key)
    radius = max(6, int(radius))
    key = ("head", skin_key, radius)
    if key in _cache:
        return _cache[key]

    size = radius * 2 + 6
    s = _ss_surface(size, size)
    c = (size * SS) / 2
    r = radius * SS

    pygame.draw.circle(s, sk.outline, (c, c), r + 2 * SS)
    pygame.draw.circle(s, sk.head, (c, c), r)
    pygame.draw.circle(s, shade(sk.head, 0.3), (c - r * 0.2, c - r * 0.28), r * 0.5)
    # A brow ridge on the leading edge gives the head a direction even when it is not moving.
    pygame.draw.circle(s, shade(sk.head, -0.18), (c + r * 0.42, c), r * 0.44)

    for sy in (-1, 1):
        ex, ey = c + r * 0.30, c + sy * r * 0.44
        pygame.draw.circle(s, sk.outline, (ex, ey), r * 0.32)
        pygame.draw.circle(s, (250, 252, 255), (ex, ey), r * 0.25)

    out = _down(s, size, size)
    _cache[key] = out
    return out


def eye_offsets(radius: float) -> tuple:
    """Head-local eye centres, matching where `head()` baked the whites."""
    return ((radius * 0.30, -radius * 0.44), (radius * 0.30, radius * 0.44))


# ── pickups ─────────────────────────────────────────────────────────────────
def pickup_sprite(kind_key: str, radius: int) -> pygame.Surface:
    kind = theme.PICKUPS[kind_key]
    radius = max(4, int(radius))
    key = ("pickup", kind_key, radius)
    if key in _cache:
        return _cache[key]

    if kind_key == "gem":
        out = gem(radius, kind.color, shade(kind.color, -0.55))
    elif kind_key == "coin":
        out = star(radius, 4, 0.42, kind.color, shade(kind.color, -0.5))
    else:
        size = radius * 2 + 2
        s = _ss_surface(size, size)
        c = (size * SS) / 2
        r = radius * SS
        pygame.draw.circle(s, shade(kind.color, -0.55), (c, c), r)
        pygame.draw.circle(s, kind.color, (c, c), r - 2 * SS)
        pygame.draw.circle(s, shade(kind.color, 0.45), (c - r * 0.28, c - r * 0.3), r * 0.34)
        # A short stem, so the orb reads as fruit rather than as a bullet.
        pygame.draw.line(s, shade(theme.GREEN, -0.2), (c, c - r * 0.9),
                         (c + r * 0.42, c - r * 1.32), int(2.4 * SS))
        out = _down(s, size, size)

    _cache[key] = out
    return out


# ── power-up icons ──────────────────────────────────────────────────────────
def power_icon(power_key: str, size: int) -> pygame.Surface:
    """A distinct pictogram per power-up, drawn as vector shapes.

    Distinguishable at 22 px in the HUD and at 34 px on the field, which is the only real
    constraint — six coloured circles would satisfy the letter of "unique icon" and tell the
    player nothing at speed.
    """
    size = max(10, int(size))
    key = ("pwr", power_key, size)
    if key in _cache:
        return _cache[key]

    p = theme.POWERS[power_key]
    s = _ss_surface(size, size)
    S = size * SS
    c = S / 2
    col = (255, 255, 255)
    lw = max(2, int(size * 0.13)) * SS

    if power_key == "magnet":
        # Horseshoe with two pole tips.
        rect = pygame.Rect(int(S * 0.20), int(S * 0.18), int(S * 0.60), int(S * 0.60))
        pygame.draw.arc(s, col, rect, math.pi * 0.08, math.pi * 0.92, lw)
        pygame.draw.rect(s, col, (int(S * 0.20), int(S * 0.46), lw, int(S * 0.26)))
        pygame.draw.rect(s, col, (int(S * 0.80) - lw, int(S * 0.46), lw, int(S * 0.26)))
        pygame.draw.rect(s, (255, 120, 120), (int(S * 0.20), int(S * 0.62), lw, int(S * 0.12)))
        pygame.draw.rect(s, (150, 180, 255), (int(S * 0.80) - lw, int(S * 0.62), lw, int(S * 0.12)))
    elif power_key == "shield":
        pts = [(c, S * 0.14), (S * 0.82, S * 0.30), (S * 0.82, S * 0.58),
               (c, S * 0.88), (S * 0.18, S * 0.58), (S * 0.18, S * 0.30)]
        pygame.draw.polygon(s, col, pts, lw)
        pygame.draw.line(s, col, (S * 0.36, S * 0.50), (S * 0.47, S * 0.63), lw)
        pygame.draw.line(s, col, (S * 0.47, S * 0.63), (S * 0.68, S * 0.36), lw)
    elif power_key == "slowmo":
        pygame.draw.circle(s, col, (c, c), S * 0.34, lw)
        pygame.draw.line(s, col, (c, c), (c, S * 0.28), lw)
        pygame.draw.line(s, col, (c, c), (S * 0.68, c), lw)
    elif power_key == "double":
        # A literal "x2" is the least ambiguous thing this could possibly be.
        pygame.draw.line(s, col, (S * 0.18, S * 0.30), (S * 0.44, S * 0.62), lw)
        pygame.draw.line(s, col, (S * 0.44, S * 0.30), (S * 0.18, S * 0.62), lw)
        pygame.draw.arc(s, col, pygame.Rect(int(S * 0.52), int(S * 0.24),
                                            int(S * 0.30), int(S * 0.26)),
                        math.pi * 0.9, math.pi * 2.2, lw)
        pygame.draw.line(s, col, (S * 0.80, S * 0.44), (S * 0.54, S * 0.72), lw)
        pygame.draw.line(s, col, (S * 0.54, S * 0.72), (S * 0.82, S * 0.72), lw)
    elif power_key == "boost":
        pygame.draw.polygon(s, col, [(S * 0.54, S * 0.10), (S * 0.24, S * 0.55),
                                     (S * 0.46, S * 0.55), (S * 0.40, S * 0.92),
                                     (S * 0.74, S * 0.44), (S * 0.52, S * 0.44)])
    elif power_key == "ghost":
        pygame.draw.circle(s, col, (c, S * 0.42), S * 0.30)
        pygame.draw.rect(s, col, (int(c - S * 0.30), int(S * 0.42), int(S * 0.60), int(S * 0.32)))
        # Scalloped hem.
        for i in range(3):
            pygame.draw.circle(s, (0, 0, 0, 0), (c - S * 0.20 + i * S * 0.20, S * 0.74), S * 0.10)
        pygame.draw.circle(s, p.color, (c - S * 0.11, S * 0.38), S * 0.07)
        pygame.draw.circle(s, p.color, (c + S * 0.11, S * 0.38), S * 0.07)

    out = _down(s, size, size)
    _cache[key] = out
    return out


def power_badge(power_key: str, size: int) -> pygame.Surface:
    """Icon on a coloured coin — how a power-up appears lying on the field."""
    size = max(16, int(size))
    key = ("pbadge", power_key, size)
    if key in _cache:
        return _cache[key]

    p = theme.POWERS[power_key]
    s = _ss_surface(size, size)
    c = (size * SS) / 2
    r = (size * SS) / 2 - SS
    pygame.draw.circle(s, shade(p.color, -0.6), (c, c), r)
    pygame.draw.circle(s, p.color, (c, c), r - 2 * SS)
    pygame.draw.circle(s, shade(p.color, 0.4), (c, c), r - 2 * SS, width=int(1.5 * SS))
    out = _down(s, size, size)

    icon = power_icon(power_key, int(size * 0.62))
    out.blit(icon, icon.get_rect(center=(size // 2, size // 2)))

    _cache[key] = out
    return out


# ── obstacles ───────────────────────────────────────────────────────────────
def obstacle(w: int, h: int) -> pygame.Surface:
    """A hazard block: dark slab, hot rim, hazard stripes.

    Deliberately reads as machinery rather than as scenery — it has to be obviously lethal at a
    glance, and the arena background is already full of soft violet shapes.
    """
    w, h = int(w), int(h)
    key = ("obst", w, h)
    if key in _cache:
        return _cache[key]

    rad = min(9, min(w, h) // 3)
    s = _ss_surface(w, h)
    pygame.draw.rect(s, (16, 12, 40), (0, 0, w * SS, h * SS), border_radius=rad * SS)
    pygame.draw.rect(s, (44, 34, 96), (int(2.5 * SS), int(2.5 * SS),
                                       int((w - 5) * SS), int((h - 5) * SS)),
                     border_radius=max(1, (rad - 2)) * SS)

    stripes = pygame.Surface((w * SS, h * SS), pygame.SRCALPHA)
    for x in range(-h * SS, w * SS, 22 * SS):
        pygame.draw.polygon(stripes, (255, 74, 92, 46), [
            (x, h * SS), (x + 9 * SS, h * SS), (x + 9 * SS + h * SS, 0), (x + h * SS, 0)])
    mask = pygame.Surface((w * SS, h * SS), pygame.SRCALPHA)
    pygame.draw.rect(mask, (255, 255, 255, 255), (0, 0, w * SS, h * SS), border_radius=rad * SS)
    stripes.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MULT)
    s.blit(stripes, (0, 0))

    pygame.draw.rect(s, (150, 110, 255), (0, 0, w * SS, h * SS),
                     width=int(2 * SS), border_radius=rad * SS)

    out = _down(s, w, h)
    _cache[key] = out
    return out


# ── particles ───────────────────────────────────────────────────────────────
def particle_dot(radius: int, color: tuple) -> pygame.Surface:
    """Particles are additive glows, not flat dots — they have to survive being drawn over."""
    return glow(max(2, int(radius)), color, falloff=1.5)


def spark(length: int, thickness: int, color: tuple) -> pygame.Surface:
    length, thickness = max(3, int(length)), max(1, int(thickness))
    key = ("spark", length, thickness, _q(color))
    if key in _cache:
        return _cache[key]
    s = _ss_surface(length, thickness)
    pygame.draw.rect(s, color, (0, 0, length * SS, thickness * SS),
                     border_radius=(thickness * SS) // 2)
    out = _down(s, length, thickness)
    _cache[key] = out
    return out
