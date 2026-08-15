#!/usr/bin/env python3
"""
Compose arcade cover images from real gameplay screenshots.

    python tools/make-thumbs.py

The arcade cards used to show a flat gradient with four colour dots — the same shape for every
game, telling a visitor nothing about what they were about to play. A card for a game should show
the game.

Every cover is built the same way so nine of them sit together without looking assembled by nine
different people: a gradient ground taken from the game's own palette, the screenshot inset with a
soft shadow and a hairline edge, and a vignette to stop the corners competing with the title
underneath. Portrait games end up as a tall panel with the ground either side, which is exactly how
a phone game looks in a store listing, and landscape ones nearly fill the frame.

16:9 at 800x450. Large enough to stay sharp on a retina card at ~380px wide, small enough that
nine of them are a few hundred kilobytes in total.

Sources live in `assets/thumb-src/<slug>.png` — screenshots captured from the real games. They are
committed rather than treated as build output, because recapturing one means driving a browser. The
two Python games can regenerate theirs headlessly (`python -m <game> --shots`); the Phaser ones are
captured from a browser, since they only exist as a running canvas.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import pygame

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "thumb-src"
OUT = ROOT / "assets" / "thumbs"

W, H = 800, 450
#: Inset of the screenshot panel from the cover's edges. Generous, so the ground reads as a
#: deliberate frame rather than as a gap the image failed to fill.
PAD_Y = 26


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, top, bottom, diagonal=True):
    """A ground for the cover. Diagonal, because a purely vertical one reads as a UI panel."""
    w, h = size
    surf = pygame.Surface(size).convert()
    steps = w + h
    for i in range(steps):
        col = lerp(top, bottom, i / max(1, steps - 1))
        if diagonal:
            pygame.draw.line(surf, col, (i, 0), (0, i))
        else:
            pygame.draw.line(surf, col, (0, i), (w, i))
    return surf


def rounded(surf, radius):
    """Round a surface's corners by punching a rounded-rect mask through its alpha."""
    w, h = surf.get_size()
    out = surf.convert_alpha()
    mask = pygame.Surface((w, h), pygame.SRCALPHA)
    pygame.draw.rect(mask, (255, 255, 255, 255), (0, 0, w, h), border_radius=radius)
    out.blit(mask, (0, 0), special_flags=pygame.BLEND_RGBA_MULT)
    return out


def vignette(size, strength=120):
    """Darken the corners so the cover sits down under the card's title.

    Filled ellipses drawn outside-in, never outlines. pygame's draw *writes* colour rather than
    blending it, so each smaller ellipse overwrites the middle of the last and what survives is a
    ramp: opaque at the corners, clear in the centre. The first version drew rings with `width=`,
    which left a bright ellipse floating behind the screenshot — an artefact that read as a bug in
    the art rather than in the vignette.
    """
    w, h = size
    v = pygame.Surface(size, pygame.SRCALPHA)
    v.fill((0, 0, 0, strength))
    steps = 48
    for i in range(steps + 1):
        t = i / steps                     # 0 at the rim, 1 at the centre
        a = int(strength * (1.0 - t) ** 1.6)
        rw = int(w * 1.42 * (1.0 - t))
        rh = int(h * 1.42 * (1.0 - t))
        if rw < 2 or rh < 2:
            continue
        pygame.draw.ellipse(v, (0, 0, 0, a),
                            (w // 2 - rw // 2, h // 2 - rh // 2, rw, rh))
    return v


def compose(shot_path: Path, top: tuple, bottom: tuple) -> pygame.Surface:
    cover = gradient((W, H), top, bottom)

    shot = pygame.image.load(str(shot_path)).convert_alpha()
    sw, sh = shot.get_size()
    target_h = H - PAD_Y * 2
    scale = target_h / sh
    panel = pygame.transform.smoothscale(shot, (max(1, int(sw * scale)), target_h))
    # A very wide screenshot would run past the frame; clamp on width too.
    if panel.get_width() > W - 40:
        scale = (W - 40) / sw
        panel = pygame.transform.smoothscale(shot, (W - 40, max(1, int(sh * scale))))
    panel = rounded(panel, 12)
    rect = panel.get_rect(center=(W // 2, H // 2))

    # Drop shadow: the same silhouette, black, offset and drawn a few times at low alpha so the
    # edge is soft without needing a blur.
    for i, a in enumerate((26, 20, 14)):
        sh_surf = pygame.Surface(panel.get_size(), pygame.SRCALPHA)
        pygame.draw.rect(sh_surf, (0, 0, 0, a), sh_surf.get_rect(), border_radius=12)
        cover.blit(sh_surf, (rect.x - (i + 1) * 2, rect.y + (i + 1) * 3))

    cover.blit(panel, rect)
    pygame.draw.rect(cover, (255, 255, 255, 30), rect, width=1, border_radius=12)
    cover.blit(vignette((W, H)), (0, 0))
    return cover


def main() -> int:
    pygame.init()
    pygame.display.set_mode((64, 64))

    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)

    made, missing = 0, []
    for entry in manifest:
        slug = entry["slug"]
        shot = SRC / f"{slug}.png"
        if not shot.is_file():
            missing.append(slug)
            continue
        cover = compose(shot, tuple(entry["top"]), tuple(entry["bottom"]))
        pygame.image.save(cover, str(OUT / f"{slug}.png"))
        made += 1
        print(f"  made  {slug}.png")

    if missing:
        print(f"\n  no source screenshot for: {', '.join(missing)}")
        print(f"  drop one at {SRC}/<slug>.png and run again")
    print(f"\n{made} cover(s) in {OUT}")
    return 0 if made else 1


if __name__ == "__main__":
    sys.exit(main())
