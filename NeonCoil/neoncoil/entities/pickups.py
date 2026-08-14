"""
Collectibles: orbs, sparks and prisms, plus the spawner that decides where they go.

Three kinds, deliberately differentiated on every axis a player can perceive — colour, shape,
sound, score, growth, and whether they expire — because "a rare bonus item" that looks like the
common one is not a rare bonus item.

  ORB    common, permanent, always three on the field. The bread and butter.
  SPARK  uncommon, expires, worth more, grows less. A detour worth taking.
  PRISM  rare, expires faster, worth a lot, and audibly special.

Placement is the part that quietly decides whether the game is fair. A pickup that spawns
inside the snake, under an obstacle, or in the corner the player is already committed to
leaving is a pickup that feels arbitrary, so `find_spot` rejects all three.
"""

from __future__ import annotations

import math
import random

import pygame

from .. import assets, theme
from ..config import (
    COIN_LIFETIME, COIN_RADIUS, COIN_SPAWN_EVERY, FOOD_ON_FIELD, FOOD_RADIUS,
    GEM_LIFETIME, GEM_RADIUS, GEM_SPAWN_EVERY,
)


class Pickup:
    __slots__ = ("kind", "x", "y", "radius", "born", "life", "alive", "phase",
                 "scale", "collected", "vx", "vy")

    def __init__(self, kind: str, x: float, y: float, radius: float, life: float | None):
        self.kind = kind
        self.x, self.y = float(x), float(y)
        self.radius = radius
        self.life = life
        self.born = 0.0
        self.alive = True
        self.phase = random.uniform(0, math.tau)
        self.scale = 0.0
        self.collected = False
        self.vx = self.vy = 0.0

    @property
    def expiring(self) -> bool:
        return self.life is not None

    def remaining(self) -> float:
        if self.life is None:
            return 1.0
        return max(0.0, 1.0 - self.born / self.life)

    def update(self, dt: float) -> None:
        self.born += dt
        # Pop in with an overshoot rather than appearing at full size.
        if self.scale < 1.0:
            self.scale = min(1.0, self.scale + dt * 4.0)
        if self.life is not None and self.born >= self.life:
            self.alive = False
        if self.vx or self.vy:
            self.x += self.vx * dt
            self.y += self.vy * dt
            damp = math.exp(-6.0 * dt)
            self.vx *= damp
            self.vy *= damp

    def attract(self, tx: float, ty: float, pull: float, dt: float) -> None:
        dx, dy = tx - self.x, ty - self.y
        d = math.hypot(dx, dy) or 1.0
        # Pull harder the closer it gets, so magnetised pickups snap in rather than drifting.
        strength = pull * (1.0 + 1.6 * (1.0 - min(1.0, d / 240.0)))
        self.vx += (dx / d) * strength * dt
        self.vy += (dy / d) * strength * dt

    def draw(self, surf: pygame.Surface, t: float) -> None:
        kind = theme.PICKUPS[self.kind]
        bob = math.sin(t * 2.4 + self.phase) * 3.0
        breathe = 1.0 + 0.09 * math.sin(t * 3.6 + self.phase)
        scale = self.scale * breathe

        alpha = 255
        rem = self.remaining()
        if self.expiring and rem < 0.28:
            # Blink out, faster as it goes, so a expiring pickup is impossible to miss.
            alpha = 255 if int(self.born * (6 + (1 - rem) * 14)) % 2 == 0 else 70

        cx, cy = int(self.x), int(self.y + bob)

        g = assets.glow(int(self.radius * 3.0 * max(0.4, scale)), kind.glow, falloff=2.3,
                        peak=int(205 * min(1.0, scale) * (alpha / 255)))
        surf.blit(g, g.get_rect(center=(cx, cy)), special_flags=pygame.BLEND_ADD)

        spr = assets.pickup_sprite(self.kind, int(self.radius))
        if abs(scale - 1.0) > 0.02:
            size = max(2, int(spr.get_width() * scale))
            spr = pygame.transform.smoothscale(spr, (size, size))
        if alpha < 255:
            spr = spr.copy()
            spr.set_alpha(alpha)
        surf.blit(spr, spr.get_rect(center=(cx, cy)))

        # Rare pickups wear a countdown ring, so "hurry" is information and not a guess.
        if self.expiring and self.kind == "gem" and rem > 0.0:
            r = int(self.radius * 1.85)
            ringimg = assets.ring(r, 3, assets.dim(kind.glow, rem * 0.6))
            surf.blit(ringimg, ringimg.get_rect(center=(cx, cy)),
                      special_flags=pygame.BLEND_ADD)


class PickupField:
    """Owns every collectible on the arena and decides when new ones arrive."""

    def __init__(self, arena: pygame.Rect, rng: random.Random | None = None):
        self.arena = arena
        self.rng = rng or random.Random()
        self.items: list[Pickup] = []
        self.t = 0.0
        #: Switch off to hold the field exactly as it is. Used by the harness to isolate a
        #: single pickup, and available for any set-piece that wants to control the arena.
        self.auto_spawn = True
        self._next_coin = self.rng.uniform(*COIN_SPAWN_EVERY)
        self._next_gem = self.rng.uniform(*GEM_SPAWN_EVERY)

    # ── placement ───────────────────────────────────────────────────────────
    def find_spot(self, radius: float, snake, obstacles, *, tries: int = 90):
        """A free position, or None.

        Rejects anywhere too close to the snake's body, inside an obstacle, hard against a
        wall, or right on top of another pickup. Also refuses to spawn directly in front of
        the head: appearing in the player's face reads as the game cheating, whether it helped
        them or not.
        """
        pad = radius + 18
        left, right = self.arena.left + pad, self.arena.right - pad
        top, bottom = self.arena.top + pad, self.arena.bottom - pad
        if right <= left or bottom <= top:
            return None

        head = (snake.x, snake.y) if snake else None
        ahead = None
        if snake:
            ahead = (snake.x + math.cos(snake.heading) * 130.0,
                     snake.y + math.sin(snake.heading) * 130.0)

        for attempt in range(tries):
            x = self.rng.uniform(left, right)
            y = self.rng.uniform(top, bottom)

            if head and (x - head[0]) ** 2 + (y - head[1]) ** 2 < 110.0 ** 2:
                continue
            if ahead and (x - ahead[0]) ** 2 + (y - ahead[1]) ** 2 < 90.0 ** 2:
                continue

            bad = False
            for ob in obstacles or ():
                if ob.rect.inflate(radius * 2 + 22, radius * 2 + 22).collidepoint(x, y):
                    bad = True
                    break
            if bad:
                continue

            if snake:
                # Sampling every third segment is plenty at this radius and keeps the check
                # cheap even with a two-hundred-segment snake.
                for i in range(0, len(snake.body), 3):
                    bx, by = snake.body[i]
                    if (x - bx) ** 2 + (y - by) ** 2 < (radius + 26) ** 2:
                        bad = True
                        break
            if bad:
                continue

            for it in self.items:
                if (x - it.x) ** 2 + (y - it.y) ** 2 < (radius + it.radius + 34) ** 2:
                    bad = True
                    break
            if bad:
                continue

            return (x, y)

        # Late in a long run the arena genuinely can be crowded. Relaxing to "not inside an
        # obstacle" beats refusing to spawn food and stalling the game.
        for _ in range(40):
            x = self.rng.uniform(left, right)
            y = self.rng.uniform(top, bottom)
            if not any(ob.rect.collidepoint(x, y) for ob in (obstacles or ())):
                return (x, y)
        return None

    # ── spawning ────────────────────────────────────────────────────────────
    def _add(self, kind: str, snake, obstacles) -> Pickup | None:
        radius = {"food": FOOD_RADIUS, "coin": COIN_RADIUS, "gem": GEM_RADIUS}[kind]
        life = {"food": None, "coin": COIN_LIFETIME, "gem": GEM_LIFETIME}[kind]
        spot = self.find_spot(radius, snake, obstacles)
        if spot is None:
            return None
        p = Pickup(kind, spot[0], spot[1], radius, life)
        self.items.append(p)
        return p

    def count(self, kind: str) -> int:
        return sum(1 for p in self.items if p.kind == kind and p.alive)

    def ensure_food(self, snake, obstacles) -> None:
        if not self.auto_spawn:
            return
        guard = 0
        while self.count("food") < FOOD_ON_FIELD and guard < FOOD_ON_FIELD * 2:
            guard += 1
            if self._add("food", snake, obstacles) is None:
                break

    def update(self, dt: float, snake, obstacles, *, magnet: bool = False,
               magnet_radius: float = 0.0, magnet_pull: float = 0.0) -> None:
        self.t += dt
        for p in self.items:
            p.update(dt)
            if magnet and snake:
                d2 = (p.x - snake.x) ** 2 + (p.y - snake.y) ** 2
                if d2 < magnet_radius * magnet_radius:
                    p.attract(snake.x, snake.y, magnet_pull, dt)
        if any(not p.alive for p in self.items):
            self.items = [p for p in self.items if p.alive]

        if not self.auto_spawn:
            return

        self._next_coin -= dt
        if self._next_coin <= 0.0:
            self._next_coin = self.rng.uniform(*COIN_SPAWN_EVERY)
            if self.count("coin") < 2:
                self._add("coin", snake, obstacles)

        self._next_gem -= dt
        if self._next_gem <= 0.0:
            self._next_gem = self.rng.uniform(*GEM_SPAWN_EVERY)
            if self.count("gem") < 1:
                self._add("gem", snake, obstacles)

        self.ensure_food(snake, obstacles)

    def take_at(self, x: float, y: float, radius: float) -> list[Pickup]:
        """Collect everything overlapping a circle. Returns what was taken."""
        taken = []
        for p in self.items:
            if not p.alive:
                continue
            rr = (radius + p.radius * 0.92) ** 2
            if (p.x - x) ** 2 + (p.y - y) ** 2 <= rr:
                p.alive = False
                p.collected = True
                taken.append(p)
        if taken:
            self.items = [p for p in self.items if p.alive]
        return taken

    def nearest(self, x: float, y: float):
        best, bd = None, float("inf")
        for p in self.items:
            d = (p.x - x) ** 2 + (p.y - y) ** 2
            if d < bd:
                best, bd = p, d
        return best

    def draw(self, surf: pygame.Surface) -> None:
        for p in self.items:
            p.draw(surf, self.t)

    def clear(self) -> None:
        self.items.clear()
