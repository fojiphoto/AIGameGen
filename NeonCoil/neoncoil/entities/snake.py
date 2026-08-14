"""
The snake.

This is the part that has to feel good, so it is worth being explicit about the model.

**Not a grid.** Classic Snake moves one cell per tick, which makes the body trivial (shift the
list) and the movement stiff. Here the head is a free body: it has a position, a heading and a
speed, and steering rotates the heading at a bounded rate. Nothing snaps to anything.

**The body follows a path, not the head.** Every segment is a sample of where the head has
already been, taken at a fixed arc length behind it. That single decision produces almost all
of the feel: the body traces smooth curves through turns, spacing stays even at every speed,
growth extends the tail rather than teleporting a segment into existence, and the tail keeps
moving for a moment after the head stops.

**Turning is specified as a radius, not a rate.** A key press sets a target heading and the head
swings towards it, taking the short way round, at a rate derived from `speed / SNAKE_TURN_RADIUS`.
Deriving it that way is what keeps the shape of a turn identical whether the game is slowed by
Slow-Mo, sped up by Boost, or ten levels faster than it started — and it lets the radius be
chosen against the length at which a full circle closes on itself. See the note in `config`.

**Self-collision skips the neck.** The segments nearest the head overlap it during any hard
turn — that is what a curve is. Without the skip the snake dies for steering, which players
correctly read as a bug.

**Moving the snake means rebuilding its path.** `respawn` and `deflect` exist because writing to
`x`/`y` alone leaves the body where it was, joined to the head by one enormous path gap, and the
snake then drives straight down its own neck.
"""

from __future__ import annotations

import math

import pygame

from .. import assets, theme
from ..config import (
    HEAD_RADIUS, MAX_SEGMENTS, PATH_SAMPLE_STEP, SEGMENTS_PER_FOOD, SEGMENT_SPACING,
    SELF_COLLISION_SKIP, SNAKE_MAX_SPEED, SNAKE_SPEED_PER_LEVEL, SNAKE_START_SPEED,
    SNAKE_TURN_MIN_SPEED, SNAKE_TURN_RADIUS, SNAKE_TURN_RADIUS_BOOST, SNAKE_TURN_RATE_MAX,
    START_SEGMENTS, TAIL_RADIUS,
)

TAU = math.tau


def _wrap_angle(a: float) -> float:
    """Fold an angle into (-pi, pi]. Used so turning always takes the short arc."""
    return (a + math.pi) % TAU - math.pi


class Snake:
    def __init__(self, x: float, y: float, heading: float, skin_key: str):
        self.skin_key = skin_key
        self.x = float(x)
        self.y = float(y)
        self.heading = float(heading)
        self.target_heading = float(heading)
        self.base_speed = SNAKE_START_SPEED
        self.speed = SNAKE_START_SPEED

        #: Path points, newest first. Body segments are sampled from this by arc length.
        self.path: list[tuple[float, float]] = [(self.x, self.y)]
        #: Distance from each path point to the one before it. Parallel to `path[1:]`.
        self.gaps: list[float] = []

        self.segments = float(START_SEGMENTS)
        self.target_segments = float(START_SEGMENTS)
        #: Cached segment positions, recomputed once per frame in `_resample`.
        self.body: list[tuple[float, float]] = []

        self.alive = True
        self.boost = False
        self.ghost = 0.0
        self.shield = False
        self.invuln = 0.0
        self.pulse = 0.0
        self.hue_t = 0.0
        self.look = (1.0, 0.0)
        self.distance = 0.0

        # Lay down enough history that the snake starts at its full length, pointing the way
        # it is about to travel. Spawning with an empty path makes it grow out of a dot.
        self._lay_path(self.heading)

    # ── geometry ────────────────────────────────────────────────────────────
    @property
    def head(self) -> tuple[float, float]:
        return (self.x, self.y)

    @property
    def head_radius(self) -> float:
        return HEAD_RADIUS * (1.0 + 0.16 * self.pulse)

    @property
    def length(self) -> int:
        return int(self.segments)

    def segment_radius(self, i: int, n: int) -> float:
        """Taper from just under the head down to the tail tip.

        The exponent keeps the snake thick through most of its length and does the narrowing
        late, which reads as a tail rather than as a cone.
        """
        t = i / max(1, n - 1)
        return HEAD_RADIUS * 0.9 + (TAIL_RADIUS - HEAD_RADIUS * 0.9) * (t ** 0.75)

    def _lay_path(self, heading: float) -> None:
        """Rebuild the path as a straight line trailing behind the head."""
        back = (-math.cos(heading), -math.sin(heading))
        self.path = [(self.x, self.y)]
        self.gaps = []
        total = max(self.segments, 4.0) * SEGMENT_SPACING + 40
        for i in range(1, int(total / PATH_SAMPLE_STEP) + 1):
            self.path.append((self.x + back[0] * PATH_SAMPLE_STEP * i,
                              self.y + back[1] * PATH_SAMPLE_STEP * i))
            self.gaps.append(PATH_SAMPLE_STEP)
        self._resample()

    def respawn(self, x: float, y: float, heading: float | None = None) -> None:
        """Move the snake somewhere else and rebuild its history behind it.

        The path MUST be rebuilt, not carried over. Moving the head while leaving the recorded
        path in place leaves the body sitting wherever it used to be, with a single enormous
        gap joining the two — so the segments string themselves along that jump and the snake
        is left driving straight down its own neck. It kills itself within a few frames, which
        is exactly the bug the shield knock-back used to have.
        """
        self.x, self.y = float(x), float(y)
        if heading is not None:
            self.heading = self.target_heading = float(heading)
        self.alive = True
        self.pulse = 0.0
        self._lay_path(self.heading)

    def deflect(self, nx: float, ny: float, *, push: float = 0.0) -> None:
        """Bounce the heading off a surface whose outward normal is (nx, ny).

        Reflection rather than "turn towards the middle of the arena": the middle can easily be
        on the far side of the snake's own body, so aiming at it after a save is how a rescued
        player dies half a second later. A reflection always sends the head away from the
        surface it just hit, and the body is behind the head by construction.
        """
        n = math.hypot(nx, ny)
        if n < 1e-6:
            return
        nx, ny = nx / n, ny / n
        dx, dy = math.cos(self.heading), math.sin(self.heading)
        dot = dx * nx + dy * ny
        if dot < 0.0:
            dx -= 2.0 * dot * nx
            dy -= 2.0 * dot * ny
        self.heading = self.target_heading = math.atan2(dy, dx)
        if push:
            self.x += nx * push
            self.y += ny * push

    # ── control ─────────────────────────────────────────────────────────────
    def steer_to(self, dx: float, dy: float) -> None:
        """Point at a direction vector. Ignores the zero vector rather than snapping east."""
        if dx == 0.0 and dy == 0.0:
            return
        self.target_heading = math.atan2(dy, dx)

    def steer_towards(self, point) -> None:
        self.steer_to(point[0] - self.x, point[1] - self.y)

    def set_level_speed(self, level: int) -> None:
        self.base_speed = min(SNAKE_MAX_SPEED,
                              SNAKE_START_SPEED + SNAKE_SPEED_PER_LEVEL * max(0, level - 1))

    def grow(self, amount: int = SEGMENTS_PER_FOOD) -> None:
        self.target_segments = min(float(MAX_SEGMENTS), self.target_segments + amount)
        self.pulse = 1.0

    # ── simulation ──────────────────────────────────────────────────────────
    def update(self, dt: float, time_scale: float = 1.0) -> None:
        if not self.alive:
            return

        self.speed = self.base_speed * (1.65 if self.boost else 1.0) * time_scale

        # Rate derived from the target radius: omega = v / r. Doing it in this order — speed
        # first, then rate — is what keeps the radius invariant across levels, boost and slow-mo,
        # so a turn always covers the same ground however fast the game is running.
        radius = SNAKE_TURN_RADIUS_BOOST if self.boost else SNAKE_TURN_RADIUS
        turn_rate = min(math.radians(SNAKE_TURN_RATE_MAX),
                        max(SNAKE_TURN_MIN_SPEED, self.speed) / radius)
        delta = _wrap_angle(self.target_heading - self.heading)
        step = turn_rate * dt
        self.heading += max(-step, min(step, delta))
        self.heading = _wrap_angle(self.heading)

        move = self.speed * dt
        self.x += math.cos(self.heading) * move
        self.y += math.sin(self.heading) * move
        self.distance += move

        self._record()
        # Growth is eased rather than instant, so eating visibly extends the tail.
        if self.segments < self.target_segments:
            self.segments = min(self.target_segments, self.segments + 14.0 * dt)
        elif self.segments > self.target_segments:
            self.segments = max(self.target_segments, self.segments - 14.0 * dt)
        self._resample()

        self.pulse = max(0.0, self.pulse - dt * 3.4)
        self.hue_t += dt
        if self.invuln > 0.0:
            self.invuln = max(0.0, self.invuln - dt)
        if self.ghost > 0.0:
            self.ghost = max(0.0, self.ghost - dt)

    def _record(self) -> None:
        """Append to the path when the head has travelled far enough to matter.

        Recording every frame would make the path density depend on frame rate; recording by
        distance makes the body identical at any refresh rate, and keeps the list short.
        """
        hx, hy = self.path[0]
        d = math.hypot(self.x - hx, self.y - hy)
        if d >= PATH_SAMPLE_STEP:
            self.path.insert(0, (self.x, self.y))
            self.gaps.insert(0, d)
            # Keep a little more history than the body needs, so a growth spurt has something
            # to extend into instead of stretching the last segment.
            needed = self.segments * SEGMENT_SPACING + SEGMENT_SPACING * 4
            total = 0.0
            cut = None
            for i, g in enumerate(self.gaps):
                total += g
                if total > needed:
                    cut = i + 2
                    break
            if cut is not None and cut < len(self.path):
                del self.path[cut:]
                del self.gaps[cut - 1:]

    def _resample(self) -> None:
        """Place body segments at fixed arc lengths along the recorded path.

        One forward walk. The targets are strictly increasing, so the path cursor never has to
        go backwards and the whole thing is linear in (path points + segments).
        """
        n = max(2, int(self.segments))
        out: list[tuple[float, float]] = []
        # Start one spacing behind the head: segment 0 is the neck, not a copy of the head.
        target = SEGMENT_SPACING
        travelled = 0.0
        idx = 0
        px, py = self.path[0]

        for _ in range(n):
            while idx < len(self.gaps) and travelled + self.gaps[idx] < target:
                travelled += self.gaps[idx]
                idx += 1
                px, py = self.path[idx]
            if idx >= len(self.gaps):
                # Ran out of history — stack the remainder on the last known point. Only
                # happens for a frame or two after a growth spurt.
                out.append((px, py))
            else:
                seg = self.gaps[idx]
                t = (target - travelled) / seg if seg > 0.0001 else 0.0
                ax, ay = self.path[idx]
                bx, by = self.path[idx + 1]
                out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
            target += SEGMENT_SPACING

        self.body = out

    # ── collisions ──────────────────────────────────────────────────────────
    def hits_self(self) -> bool:
        if self.invuln > 0.0 or self.ghost > 0.0:
            return False
        hr = HEAD_RADIUS * 0.72
        n = len(self.body)
        for i in range(SELF_COLLISION_SKIP, n):
            bx, by = self.body[i]
            r = self.segment_radius(i, n) * 0.78 + hr
            if (bx - self.x) ** 2 + (by - self.y) ** 2 < r * r:
                return True
        return False

    def hits_rect(self, rect: pygame.Rect, inset: float = 0.0) -> bool:
        """Circle-vs-rect against the head. `inset` shrinks the rect for a fairer hitbox."""
        r = HEAD_RADIUS * 0.78
        left = rect.left + inset
        right = rect.right - inset
        top = rect.top + inset
        bottom = rect.bottom - inset
        cx = max(left, min(self.x, right))
        cy = max(top, min(self.y, bottom))
        return (cx - self.x) ** 2 + (cy - self.y) ** 2 < r * r

    def outside(self, arena: pygame.Rect) -> bool:
        r = HEAD_RADIUS * 0.7
        return (self.x - r < arena.left or self.x + r > arena.right
                or self.y - r < arena.top or self.y + r > arena.bottom)

    def clamp_into(self, arena: pygame.Rect) -> None:
        """Used by Ghost mode: keep the head in play instead of letting it leave the screen."""
        r = HEAD_RADIUS * 0.7
        self.x = max(arena.left + r, min(arena.right - r, self.x))
        self.y = max(arena.top + r, min(arena.bottom - r, self.y))

    # ── presentation ────────────────────────────────────────────────────────
    def look_at(self, point) -> None:
        """Aim the pupils. Blends towards the target so the eyes track rather than snap."""
        if point is None:
            tx, ty = math.cos(self.heading), math.sin(self.heading)
        else:
            dx, dy = point[0] - self.x, point[1] - self.y
            d = math.hypot(dx, dy) or 1.0
            tx, ty = dx / d, dy / d
        lx, ly = self.look
        self.look = (lx + (tx - lx) * 0.16, ly + (ty - ly) * 0.16)

    def draw(self, surf: pygame.Surface, *, particles=None) -> None:
        sk = theme.skin(self.skin_key)
        n = len(self.body)
        if n == 0:
            return

        ghosting = self.ghost > 0.0
        blink = self.invuln > 0.0 and int(self.invuln * 12) % 2 == 0
        body_alpha = 255
        if ghosting:
            body_alpha = 120
        if blink:
            body_alpha = min(body_alpha, 90)

        add = pygame.BLEND_ADD

        # Glow pass. Sampled rather than per-segment, and stopped part-way down the body: the
        # bloom overlaps heavily so every fourth segment still reads as a continuous tube of
        # light, and the far tail contributes almost nothing to a lit shape that is already
        # thinning out. This is the single most expensive thing the snake does — each blit is a
        # large additive blend — and on a two-hundred-segment snake the sampling is the
        # difference between fitting the frame budget and not.
        # Peaks are high because a premultiplied glow's brightness lives in its RGB. These are
        # roughly double the values that looked right while alpha was (incorrectly) doing the
        # work, and the neon read of the whole game depends on them.
        glow_alpha = 165 if not ghosting else 70
        # Tapered along the whole length rather than cut off part-way down — stopping the pass at
        # a fixed fraction made the snake look like it faded out mid-body. Both the stride and
        # the radius open up towards the tail, which is where the taper hides it: the front of
        # the snake gets a dense bright bloom and the tail a sparse soft one, for about a third
        # of the blits a uniform pass would need. Cost scales with the square of the radius, so
        # the smaller tail sprite matters more than the wider stride.
        inv_n = 1.0 / max(1, n - 1)
        i = n - 1
        while i >= 0:
            t = i * inv_n
            far = t > 0.5
            peak = int(glow_alpha * (1.0 - 0.58 * t) / 12) * 12
            if peak >= 12:
                bx, by = self.body[i]
                r = int(self.segment_radius(i, n) * (1.85 if far else 2.35))
                g = assets.glow(r, sk.glow, falloff=2.4, peak=peak)
                surf.blit(g, (int(bx - r), int(by - r)), special_flags=add)
            i -= 8 if far else 4

        # Body, tail first so each segment overlaps the one behind it.
        cycle = (self.hue_t * sk.hue_cycle) % 1.0 if sk.hue_cycle else 0.0
        for i in range(n - 1, -1, -1):
            bx, by = self.body[i]
            t = i / max(1, n - 1)
            if cycle:
                t = (t + cycle) % 1.0
            r = self.segment_radius(i, n)
            spr = assets.segment(self.skin_key, t, int(r))
            if body_alpha < 255:
                spr = spr.copy()
                spr.set_alpha(body_alpha)
            surf.blit(spr, spr.get_rect(center=(int(bx), int(by))))

        # Head.
        hr = self.head_radius
        head_glow = assets.glow(int(hr * 3.0), sk.glow, falloff=2.2,
                                peak=215 if not ghosting else 105)
        surf.blit(head_glow, head_glow.get_rect(center=(int(self.x), int(self.y))),
                  special_flags=add)

        head_img = assets.head(self.skin_key, int(hr))
        if abs(self.pulse) > 0.01:
            grow = 1.0 + 0.18 * self.pulse
            head_img = pygame.transform.rotozoom(head_img, -math.degrees(self.heading), grow)
        else:
            head_img = pygame.transform.rotate(head_img, -math.degrees(self.heading))
        if body_alpha < 255:
            head_img = head_img.copy()
            head_img.set_alpha(body_alpha)
        surf.blit(head_img, head_img.get_rect(center=(int(self.x), int(self.y))))

        self._draw_pupils(surf, hr, body_alpha)

        if self.shield:
            self._draw_shield(surf, hr)

    def _draw_pupils(self, surf: pygame.Surface, hr: float, alpha: int) -> None:
        """Pupils, offset inside the baked eye whites towards whatever the snake is watching."""
        cos_h, sin_h = math.cos(self.heading), math.sin(self.heading)
        lx, ly = self.look
        # Convert the world-space look direction into head-local space.
        local_x = lx * cos_h + ly * sin_h
        local_y = -lx * sin_h + ly * cos_h
        shift = hr * 0.09

        for ex, ey in assets.eye_offsets(hr):
            px = ex + local_x * shift
            py = ey + local_y * shift
            wx = self.x + px * cos_h - py * sin_h
            wy = self.y + px * sin_h + py * cos_h
            pr = max(2, int(hr * 0.13))
            pupil = assets.disc(pr, (18, 16, 44), None, highlight=False)
            if alpha < 255:
                pupil = pupil.copy()
                pupil.set_alpha(alpha)
            surf.blit(pupil, pupil.get_rect(center=(int(wx), int(wy))))

    def _draw_shield(self, surf: pygame.Surface, hr: float) -> None:
        r = int(hr * 2.1)
        pulse = 0.5 + 0.5 * math.sin(self.hue_t * 5.0)
        col = theme.POWERS["shield"].color
        img = assets.ring(r, 3, assets.dim(col, (150 + 70 * pulse) / 255.0))
        surf.blit(img, img.get_rect(center=(int(self.x), int(self.y))),
                  special_flags=pygame.BLEND_ADD)
        g = assets.glow(int(r * 1.4), col, falloff=3.2, peak=int(50 + 30 * pulse))
        surf.blit(g, g.get_rect(center=(int(self.x), int(self.y))),
                  special_flags=pygame.BLEND_ADD)
