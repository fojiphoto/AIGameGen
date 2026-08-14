"""
Obstacles: the thing that actually makes a long snake dangerous.

Speed alone is a poor difficulty knob — past a certain point it just makes the game feel
slippery. Blocks in the arena are better, because they turn the player's own length into the
threat: every block is a corner you have to commit to, and a long snake has fewer ways out of a
committed corner.

Two rules keep them fair:

* They never appear on top of the player. A block that materialises around the head is an
  unavoidable death, so placement rejects anywhere near the snake and its path ahead, and new
  blocks fade in over half a second with no hitbox until they are solid.
* They never seal the arena. Placement keeps a corridor's worth of clearance from the walls and
  from each other, so there is always a way through.
"""

from __future__ import annotations

import math
import random

import pygame

from .. import assets, theme
from ..config import MAX_OBSTACLES, OBSTACLE_EVERY_N_LEVELS, OBSTACLES_FROM_LEVEL

#: Clearance kept between blocks, and between a block and a wall. Comfortably wider than the
#: snake so no gap is a trap.
CORRIDOR = 78


class Obstacle:
    __slots__ = ("rect", "spawn", "alive", "phase")

    def __init__(self, rect: pygame.Rect):
        self.rect = rect
        #: 0 while materialising, 1 once solid. Collision is disabled below 1.
        self.spawn = 0.0
        self.alive = True
        self.phase = random.uniform(0, math.tau)

    @property
    def solid(self) -> bool:
        return self.spawn >= 1.0

    def update(self, dt: float) -> None:
        if self.spawn < 1.0:
            self.spawn = min(1.0, self.spawn + dt * 2.0)

    def draw(self, surf: pygame.Surface, t: float) -> None:
        img = assets.obstacle(self.rect.w, self.rect.h)
        k = self.spawn

        if k < 1.0:
            # Scale and fade in, so it reads as arriving rather than as a pop-in.
            w = max(2, int(self.rect.w * (0.55 + 0.45 * k)))
            h = max(2, int(self.rect.h * (0.55 + 0.45 * k)))
            img = pygame.transform.smoothscale(img, (w, h))
            img = img.copy()
            img.set_alpha(int(255 * k))
            surf.blit(img, img.get_rect(center=self.rect.center))
            halo = assets.glow(int(max(w, h) * 0.9), theme.DANGER, falloff=2.4,
                               peak=int(120 * (1.0 - k)))
            surf.blit(halo, halo.get_rect(center=self.rect.center),
                      special_flags=pygame.BLEND_ADD)
            return

        # A slow breath on the rim keeps a static block from looking like part of the backdrop.
        pulse = 0.5 + 0.5 * math.sin(t * 1.7 + self.phase)
        g = assets.glow(int(max(self.rect.w, self.rect.h) * 0.72), theme.WALL_GLOW,
                        falloff=3.0, peak=int(26 + 20 * pulse))
        surf.blit(g, g.get_rect(center=self.rect.center), special_flags=pygame.BLEND_ADD)
        surf.blit(img, self.rect.topleft)


class ObstacleField:
    def __init__(self, arena: pygame.Rect, rng: random.Random | None = None):
        self.arena = arena
        self.rng = rng or random.Random()
        self.items: list[Obstacle] = []
        self.t = 0.0

    @staticmethod
    def target_count(level: int) -> int:
        """How many blocks a given level should have. Steps up, never down."""
        if level < OBSTACLES_FROM_LEVEL:
            return 0
        steps = (level - OBSTACLES_FROM_LEVEL) // OBSTACLE_EVERY_N_LEVELS + 1
        return min(MAX_OBSTACLES, steps)

    def _candidate(self):
        # A mix of orientations so the arena does not read as a grid of identical boxes.
        style = self.rng.random()
        if style < 0.34:
            w, h = self.rng.randint(96, 190), self.rng.randint(22, 32)
        elif style < 0.68:
            w, h = self.rng.randint(22, 32), self.rng.randint(96, 190)
        else:
            s = self.rng.randint(40, 66)
            w, h = s, s
        pad = CORRIDOR
        left = self.arena.left + pad
        top = self.arena.top + pad
        right = self.arena.right - pad - w
        bottom = self.arena.bottom - pad - h
        if right <= left or bottom <= top:
            return None
        return pygame.Rect(self.rng.randint(left, right), self.rng.randint(top, bottom), w, h)

    def try_add(self, snake, field=None, *, tries: int = 120) -> Obstacle | None:
        for _ in range(tries):
            rect = self._candidate()
            if rect is None:
                return None

            # Never in the player's lap, and never in the corridor they are already committed to.
            if snake:
                grown = rect.inflate(150, 150)
                if grown.collidepoint(snake.x, snake.y):
                    continue
                ahead = (snake.x + math.cos(snake.heading) * 210.0,
                         snake.y + math.sin(snake.heading) * 210.0)
                if rect.inflate(120, 120).collidepoint(*ahead):
                    continue
                if any(rect.inflate(58, 58).collidepoint(*snake.body[i])
                       for i in range(0, len(snake.body), 2)):
                    continue

            if any(rect.inflate(CORRIDOR, CORRIDOR).colliderect(o.rect) for o in self.items):
                continue

            if field and any(rect.inflate(56, 56).collidepoint(p.x, p.y) for p in field.items):
                continue

            ob = Obstacle(rect)
            self.items.append(ob)
            return ob
        return None

    def sync_to_level(self, level: int, snake, field=None) -> list[Obstacle]:
        """Add blocks until the level's quota is met. Returns what was added."""
        want = self.target_count(level)
        added = []
        guard = 0
        while len(self.items) < want and guard < 6:
            guard += 1
            ob = self.try_add(snake, field)
            if ob is None:
                break
            added.append(ob)
        return added

    def update(self, dt: float) -> None:
        self.t += dt
        for o in self.items:
            o.update(dt)

    def solid_rects(self) -> list[pygame.Rect]:
        return [o.rect for o in self.items if o.solid]

    def draw(self, surf: pygame.Surface) -> None:
        for o in self.items:
            o.draw(surf, self.t)

    def clear(self) -> None:
        self.items.clear()
