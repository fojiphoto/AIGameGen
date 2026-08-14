"""
Power-ups: the drops on the field, and the timers they turn into.

Split in two on purpose. `PowerField` owns things lying on the ground waiting to be run over;
`ActivePowers` owns what is currently affecting the player. Nothing else in the game needs to
know how a power-up got activated, so the play scene asks questions like `powers.magnet` and
never touches a timer.

Stacking rule: collecting a power you already have refreshes its duration rather than adding a
second instance. Additive stacking on Slow-Mo or Boost compounds into something unplayable, and
a player who finds two Shields expects to be protected, not to be protected twice.
"""

from __future__ import annotations

import math
import random

import pygame

from .. import assets, theme
from ..config import POWERUP_LIFETIME, POWERUP_MAX_ON_FIELD, POWERUP_RADIUS, POWERUP_SPAWN_EVERY


class PowerDrop:
    __slots__ = ("key", "x", "y", "radius", "born", "life", "alive", "phase", "scale")

    def __init__(self, key: str, x: float, y: float):
        self.key = key
        self.x, self.y = float(x), float(y)
        self.radius = POWERUP_RADIUS
        self.born = 0.0
        self.life = POWERUP_LIFETIME
        self.alive = True
        self.phase = random.uniform(0, math.tau)
        self.scale = 0.0

    def remaining(self) -> float:
        return max(0.0, 1.0 - self.born / self.life)

    def update(self, dt: float) -> None:
        self.born += dt
        if self.scale < 1.0:
            self.scale = min(1.0, self.scale + dt * 3.6)
        if self.born >= self.life:
            self.alive = False

    def draw(self, surf: pygame.Surface, t: float) -> None:
        p = theme.POWERS[self.key]
        bob = math.sin(t * 2.2 + self.phase) * 4.0
        cx, cy = int(self.x), int(self.y + bob)
        rem = self.remaining()
        alpha = 255 if rem > 0.25 else (255 if int(self.born * 10) % 2 == 0 else 80)

        g = assets.glow(int(self.radius * 3.4 * max(0.4, self.scale)), p.glow, falloff=2.2,
                        peak=int(225 * self.scale * (alpha / 255)))
        surf.blit(g, g.get_rect(center=(cx, cy)), special_flags=pygame.BLEND_ADD)

        badge = assets.power_badge(self.key, int(self.radius * 2))
        if abs(self.scale - 1.0) > 0.02:
            size = max(2, int(badge.get_width() * self.scale))
            badge = pygame.transform.smoothscale(badge, (size, size))
        if alpha < 255:
            badge = badge.copy()
            badge.set_alpha(alpha)
        surf.blit(badge, badge.get_rect(center=(cx, cy)))

        # A slowly rotating dashed halo — makes a power-up unmistakably different from a pickup.
        r = int(self.radius * 1.7)
        for i in range(6):
            ang = t * 1.4 + i * math.tau / 6 + self.phase
            px = cx + math.cos(ang) * r
            py = cy + math.sin(ang) * r
            dot = assets.glow(5, p.glow, falloff=1.5,
                              peak=int(230 * self.scale * (alpha / 255)))
            surf.blit(dot, dot.get_rect(center=(int(px), int(py))),
                      special_flags=pygame.BLEND_ADD)


class PowerField:
    def __init__(self, arena: pygame.Rect, rng: random.Random | None = None):
        self.arena = arena
        self.rng = rng or random.Random()
        self.items: list[PowerDrop] = []
        self.t = 0.0
        self._next = self.rng.uniform(*POWERUP_SPAWN_EVERY) * 0.6

    def _pick_kind(self, active) -> str:
        """Weighted draw, biased away from anything already running.

        Handing a player a second Shield while their first is still up is a wasted drop, and
        wasted drops are how a power-up system stops feeling generous.
        """
        keys = list(theme.POWER_ORDER)
        weights = []
        for k in keys:
            w = theme.POWERS[k].weight
            if active and active.has(k):
                w *= 0.15
            weights.append(w)
        total = sum(weights)
        r = self.rng.uniform(0, total)
        acc = 0.0
        for k, w in zip(keys, weights):
            acc += w
            if r <= acc:
                return k
        return keys[-1]

    def update(self, dt: float, snake, obstacles, field, active=None) -> None:
        self.t += dt
        for p in self.items:
            p.update(dt)
        if any(not p.alive for p in self.items):
            self.items = [p for p in self.items if p.alive]

        self._next -= dt
        if self._next <= 0.0:
            self._next = self.rng.uniform(*POWERUP_SPAWN_EVERY)
            if len(self.items) < POWERUP_MAX_ON_FIELD:
                spot = field.find_spot(POWERUP_RADIUS, snake, obstacles)
                if spot:
                    self.items.append(PowerDrop(self._pick_kind(active), spot[0], spot[1]))

    def take_at(self, x: float, y: float, radius: float) -> list[PowerDrop]:
        taken = []
        for p in self.items:
            if not p.alive:
                continue
            rr = (radius + p.radius) ** 2
            if (p.x - x) ** 2 + (p.y - y) ** 2 <= rr:
                p.alive = False
                taken.append(p)
        if taken:
            self.items = [p for p in self.items if p.alive]
        return taken

    def draw(self, surf: pygame.Surface) -> None:
        for p in self.items:
            p.draw(surf, self.t)

    def clear(self) -> None:
        self.items.clear()


class ActivePowers:
    """Live effect timers and the queries the game asks of them."""

    def __init__(self):
        self.timers: dict[str, float] = {}
        #: Shield is a charge, not a duration — it survives until it is spent or times out.
        self.shield_charge = False

    def activate(self, key: str) -> None:
        p = theme.POWERS[key]
        self.timers[key] = p.duration
        if key == "shield":
            self.shield_charge = True

    def has(self, key: str) -> bool:
        return self.timers.get(key, 0.0) > 0.0

    def remaining(self, key: str) -> float:
        return max(0.0, self.timers.get(key, 0.0))

    def fraction(self, key: str) -> float:
        d = theme.POWERS[key].duration
        return max(0.0, min(1.0, self.remaining(key) / d)) if d else 0.0

    def spend_shield(self) -> bool:
        """Consume the shield if one is up. Returns whether it absorbed the hit."""
        if self.shield_charge and self.has("shield"):
            self.shield_charge = False
            self.timers["shield"] = 0.0
            return True
        return False

    def update(self, dt: float) -> list[str]:
        """Tick every timer. Returns the keys that expired on this call."""
        expired = []
        for key in list(self.timers):
            if self.timers[key] <= 0.0:
                continue
            self.timers[key] -= dt
            if self.timers[key] <= 0.0:
                self.timers[key] = 0.0
                if key == "shield":
                    self.shield_charge = False
                expired.append(key)
        return expired

    def active_keys(self) -> list[str]:
        return [k for k in theme.POWER_ORDER if self.has(k)]

    # ── the queries the play scene actually makes ───────────────────────────
    @property
    def magnet(self) -> bool:
        return self.has("magnet")

    @property
    def shield(self) -> bool:
        return self.shield_charge and self.has("shield")

    @property
    def ghost(self) -> bool:
        return self.has("ghost")

    @property
    def boost(self) -> bool:
        return self.has("boost")

    @property
    def score_multiplier(self) -> int:
        return 2 if self.has("double") else 1

    @property
    def time_scale(self) -> float:
        from ..config import SLOWMO_SCALE
        return SLOWMO_SCALE if self.has("slowmo") else 1.0

    def clear(self) -> None:
        self.timers.clear()
        self.shield_charge = False
