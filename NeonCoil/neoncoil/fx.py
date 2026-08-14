"""
The juice layer: particles, floating text, screen shake, flashes, ripples, trails.

None of this affects gameplay. That separation is deliberate and worth stating, because it is
what makes the effects safe to tune aggressively: nothing in here reads or writes simulation
state, so turning particles off in the settings changes how the game looks and not how it plays.

Performance shape:

* Particles are pooled. Objects are recycled rather than allocated, because a chained combo
  can ask for two hundred particles inside a single frame and Python object churn at that rate
  is measurable.
* The pool has a hard ceiling. Emitters ask, and are refused once it is full. A dropped
  particle is invisible; a frame-rate cliff is not.
* Particles blit cached additive glow sprites instead of calling a draw primitive, so the cost
  per particle is one scaled blit.
"""

from __future__ import annotations

import math
import random

import pygame

from . import assets
from .config import MAX_PARTICLES, SHAKE_DECAY


class Particle:
    __slots__ = ("x", "y", "vx", "vy", "life", "max_life", "size", "color",
                 "drag", "grav", "spin", "angle", "kind", "alive", "fade_pow")

    def __init__(self):
        self.alive = False

    def reset(self, x, y, vx, vy, life, size, color, *, drag=2.2, grav=0.0,
              kind="dot", spin=0.0, fade_pow=1.0):
        self.x, self.y = x, y
        self.vx, self.vy = vx, vy
        self.life = self.max_life = life
        self.size = size
        self.color = color
        self.drag = drag
        self.grav = grav
        self.kind = kind
        self.spin = spin
        self.angle = random.uniform(0, 360)
        self.fade_pow = fade_pow
        self.alive = True


class Particles:
    """A fixed pool of additive particles."""

    def __init__(self, capacity: int = MAX_PARTICLES):
        self._pool = [Particle() for _ in range(capacity)]
        self._cursor = 0
        self.enabled = True
        self.live = 0

    def _take(self) -> Particle | None:
        """Next free slot, scanning forward from where we stopped last time.

        The scan is bounded by the pool size, so a full pool costs one pass and then declines
        rather than blocking or growing.
        """
        n = len(self._pool)
        for _ in range(n):
            p = self._pool[self._cursor]
            self._cursor = (self._cursor + 1) % n
            if not p.alive:
                return p
        return None

    # ── emitters ────────────────────────────────────────────────────────────
    def burst(self, pos, count, color, *, speed=(70, 260), size=(3, 8),
              life=(0.30, 0.70), drag=2.6, grav=0.0, spread=math.tau, direction=0.0):
        if not self.enabled:
            return
        for _ in range(count):
            p = self._take()
            if p is None:
                return
            ang = direction + random.uniform(-spread / 2, spread / 2)
            spd = random.uniform(*speed)
            p.reset(pos[0], pos[1], math.cos(ang) * spd, math.sin(ang) * spd,
                    random.uniform(*life), random.uniform(*size), color,
                    drag=drag, grav=grav)

    def sparks(self, pos, count, color, *, speed=(180, 480), direction=0.0, spread=1.2):
        """Streaks rather than dots — reads as impact instead of as smoke."""
        if not self.enabled:
            return
        for _ in range(count):
            p = self._take()
            if p is None:
                return
            ang = direction + random.uniform(-spread / 2, spread / 2)
            spd = random.uniform(*speed)
            p.reset(pos[0], pos[1], math.cos(ang) * spd, math.sin(ang) * spd,
                    random.uniform(0.18, 0.42), random.uniform(6, 13), color,
                    drag=4.5, kind="spark")

    def ring(self, pos, count, color, *, radius_speed=(150, 190), size=(3, 6), life=(0.28, 0.42)):
        """An even shell. Used for pickups, where a random burst looks accidental."""
        if not self.enabled:
            return
        base = random.uniform(0, math.tau)
        for i in range(count):
            p = self._take()
            if p is None:
                return
            ang = base + math.tau * i / count
            spd = random.uniform(*radius_speed)
            p.reset(pos[0], pos[1], math.cos(ang) * spd, math.sin(ang) * spd,
                    random.uniform(*life), random.uniform(*size), color, drag=3.4)

    def trail(self, pos, color, size=4.0, life=0.30):
        if not self.enabled:
            return
        p = self._take()
        if p is None:
            return
        p.reset(pos[0] + random.uniform(-2, 2), pos[1] + random.uniform(-2, 2),
                random.uniform(-16, 16), random.uniform(-16, 16),
                life, size, color, drag=1.4, fade_pow=1.7)

    def motes(self, rect, count, color):
        """Slow ambient drift, for menus. Long-lived and nearly still."""
        if not self.enabled:
            return
        for _ in range(count):
            p = self._take()
            if p is None:
                return
            p.reset(random.uniform(rect[0], rect[0] + rect[2]),
                    random.uniform(rect[1], rect[1] + rect[3]),
                    random.uniform(-14, 14), random.uniform(-26, -8),
                    random.uniform(1.6, 3.4), random.uniform(2, 5), color,
                    drag=0.15, fade_pow=2.0)

    # ── loop ────────────────────────────────────────────────────────────────
    def update(self, dt: float):
        live = 0
        for p in self._pool:
            if not p.alive:
                continue
            p.life -= dt
            if p.life <= 0.0:
                p.alive = False
                continue
            # Exponential drag, evaluated exactly rather than as a per-frame multiply, so the
            # motion is identical whatever the frame rate happens to be.
            damp = math.exp(-p.drag * dt)
            p.vx *= damp
            p.vy = p.vy * damp + p.grav * dt
            p.x += p.vx * dt
            p.y += p.vy * dt
            p.angle += p.spin * dt
            live += 1
        self.live = live

    def draw(self, surf: pygame.Surface):
        add = pygame.BLEND_ADD
        for p in self._pool:
            if not p.alive:
                continue
            k = p.life / p.max_life
            fade = k ** p.fade_pow
            # Fading is baked into the colour, not applied with set_alpha: an additive blit
            # ignores alpha, so a particle faded that way stays at full brightness for its whole
            # life and then vanishes. assets.dim quantises, so the whole pool shares a small
            # ramp of cached sprites.
            if p.kind == "spark":
                length = max(3, int(p.size * (0.5 + k)))
                sp = assets.spark(length, max(1, int(p.size * 0.3)),
                                  assets.dim(p.color, fade))
                ang = math.degrees(math.atan2(-p.vy, p.vx))
                rot = pygame.transform.rotate(sp, ang)
                surf.blit(rot, rot.get_rect(center=(int(p.x), int(p.y))), special_flags=add)
            else:
                r = max(2, int(p.size * (0.45 + 0.75 * k)))
                g = assets.glow(r, p.color, falloff=1.5, peak=int(245 * fade))
                surf.blit(g, (int(p.x - r), int(p.y - r)), special_flags=add)

    def clear(self):
        for p in self._pool:
            p.alive = False
        self.live = 0


class Floater:
    """A number or word that rises, scales in, and fades. `+120`, `x4`, `SHIELD`."""

    __slots__ = ("x", "y", "vy", "life", "max_life", "text", "color", "size", "alive", "bold")

    def __init__(self, x, y, text, color, size=26, life=0.95, vy=-58.0, bold=True):
        self.x, self.y = x, y
        self.vy = vy
        self.life = self.max_life = life
        self.text = text
        self.color = color
        self.size = size
        self.bold = bold
        self.alive = True

    def update(self, dt):
        self.life -= dt
        if self.life <= 0:
            self.alive = False
            return
        self.y += self.vy * dt
        self.vy *= math.exp(-1.6 * dt)


class Floaters:
    def __init__(self):
        self.items: list[Floater] = []

    def add(self, x, y, text, color, size=26, life=0.95, vy=-58.0):
        # Cap rather than let a pathological combo chain grow this unbounded.
        if len(self.items) > 40:
            del self.items[0]
        self.items.append(Floater(x, y, text, color, size, life, vy))

    def update(self, dt):
        if not self.items:
            return
        for f in self.items:
            f.update(dt)
        self.items = [f for f in self.items if f.alive]

    def draw(self, surf, fonts_mod):
        for f in self.items:
            k = f.life / f.max_life
            # Pop in over the first fifth of the life, then hold and fade.
            grow = 1.0 - k
            scale = 1.0 + 0.5 * max(0.0, 1.0 - grow / 0.2) if grow < 0.2 else 1.0
            alpha = int(255 * min(1.0, k * 2.4))
            fonts_mod.draw(surf, f.text, (f.x, f.y), int(f.size * scale), f.color,
                           anchor="center", glow=f.color, glow_alpha=int(90 * k),
                           alpha=alpha, shadow=2)

    def clear(self):
        self.items.clear()


class Ripple:
    """An expanding ring. Marks a spot without adding to the particle budget."""

    __slots__ = ("x", "y", "life", "max_life", "r0", "r1", "color", "width", "alive")

    def __init__(self, x, y, r0, r1, color, life=0.5, width=4):
        self.x, self.y = x, y
        self.r0, self.r1 = r0, r1
        self.color = color
        self.life = self.max_life = life
        self.width = width
        self.alive = True


class Ripples:
    def __init__(self):
        self.items: list[Ripple] = []

    def add(self, x, y, r0, r1, color, life=0.5, width=4):
        if len(self.items) > 24:
            del self.items[0]
        self.items.append(Ripple(x, y, r0, r1, color, life, width))

    def update(self, dt):
        for r in self.items:
            r.life -= dt
            if r.life <= 0:
                r.alive = False
        if self.items:
            self.items = [r for r in self.items if r.alive]

    def draw(self, surf):
        for rp in self.items:
            k = 1.0 - rp.life / rp.max_life
            # Ease out, so the ring leaps away and then settles.
            e = 1.0 - (1.0 - k) ** 2
            radius = int(rp.r0 + (rp.r1 - rp.r0) * e)
            if radius < 2:
                continue
            w = max(1, int(rp.width * (1.0 - k * 0.7)))
            img = assets.ring(radius, w, assets.dim(rp.color, (1.0 - k) ** 1.4))
            surf.blit(img, img.get_rect(center=(int(rp.x), int(rp.y))),
                      special_flags=pygame.BLEND_ADD)

    def clear(self):
        self.items.clear()


class Screen:
    """Full-frame feedback: shake, colour flash, and a hit-stop freeze."""

    def __init__(self):
        self.shake = 0.0
        self.enabled = True
        self.flash_color = (255, 255, 255)
        self.flash = 0.0
        self.flash_max = 1.0
        self.freeze = 0.0

    def kick(self, amount: float):
        if self.enabled:
            self.shake = max(self.shake, amount)

    def do_flash(self, color, amount=0.35):
        self.flash_color = color
        self.flash = self.flash_max = amount

    def hit_stop(self, seconds: float):
        """Briefly stop the simulation. A few frames of stillness sells an impact."""
        self.freeze = max(self.freeze, seconds)

    def update(self, dt: float):
        if self.freeze > 0.0:
            self.freeze = max(0.0, self.freeze - dt)
        if self.shake > 0.0:
            self.shake = max(0.0, self.shake * math.exp(-SHAKE_DECAY * dt) - 0.35 * dt)
        if self.flash > 0.0:
            self.flash = max(0.0, self.flash - dt * 2.6)

    def offset(self) -> tuple[int, int]:
        if self.shake <= 0.1:
            return (0, 0)
        a = self.shake
        return (int(random.uniform(-a, a)), int(random.uniform(-a, a)))

    def draw_flash(self, surf: pygame.Surface):
        if self.flash <= 0.001:
            return
        k = self.flash / max(0.0001, self.flash_max)
        # Premultiplied fill: the strength has to be in the RGB values, because an additive
        # blit would discard it from alpha and every flash would be a full white-out.
        c = self.flash_color
        strength = 0.59 * k
        overlay = pygame.Surface(surf.get_size())
        overlay.fill((int(c[0] * strength), int(c[1] * strength), int(c[2] * strength)))
        surf.blit(overlay, (0, 0), special_flags=pygame.BLEND_ADD)

    def clear(self):
        self.shake = 0.0
        self.flash = 0.0
        self.freeze = 0.0


def ease_out_back(t: float, overshoot: float = 1.7) -> float:
    t = max(0.0, min(1.0, t))
    c = overshoot + 1.0
    return 1.0 + c * (t - 1.0) ** 3 + overshoot * (t - 1.0) ** 2


def ease_out_cubic(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1.0 - (1.0 - t) ** 3


def ease_in_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 2 * t * t if t < 0.5 else 1.0 - (-2 * t + 2) ** 2 / 2
