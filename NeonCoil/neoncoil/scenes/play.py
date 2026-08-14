"""
Gameplay, and the two overlays that sit on top of it.

`PlayScene` owns the run. `PauseScene` and `GameOverScene` are pushed onto the stack rather than
replacing it, so the arena keeps drawing and breathing behind them and there is no run state to
save and restore — the game is simply not being updated.

The one structural rule in here: the simulation is a block near the top of `update`, and
everything after it is presentation. Effects read positions and never write them. That is what
makes it safe for the settings screen to switch particles off, and what keeps a death animation
from being able to move the snake.
"""

from __future__ import annotations

import math
import random

import pygame

from .. import assets, audio, fonts, theme, ui
from ..app import Scene
from ..background import ArenaFrame, Backdrop
from ..config import (
    ARENA, COMBO_MAX, COMBO_WINDOW, COMBO_WINDOW_DECAY, DEATH_FREEZE, FOOD_PER_LEVEL,
    GAME_H, GAME_W, HEAD_RADIUS, HUD_H, MAGNET_PULL, MAGNET_RADIUS, MAX_LEVEL,
    RESPAWN_INVULN, TIME_ATTACK_BONUS_FOOD, TIME_ATTACK_BONUS_GEM, TIME_ATTACK_SECONDS,
)
from ..entities import ActivePowers, ObstacleField, PickupField, PowerField, Snake
from ..fx import Floaters, Particles, Ripples, Screen, ease_out_back, ease_out_cubic

ARENA_RECT = pygame.Rect(int(ARENA[0]), int(ARENA[1]), int(ARENA[2]), int(ARENA[3]))

INTRO_TIME = 1.15


class PlayScene(Scene):
    def __init__(self, app):
        super().__init__(app)
        # Gameplay wants the backdrop present but quiet: fewer blobs and a lower intensity, so
        # the arena is the thing the eye reads.
        self.backdrop = Backdrop((GAME_W, GAME_H), intensity=0.55, seed=23, blobs=3)
        self.frame = ArenaFrame(ARENA_RECT)
        self.particles = Particles()
        self.floaters = Floaters()
        self.ripples = Ripples()
        self.screen_fx = Screen()
        self.rng = random.Random()

        self.mode_key = theme.DEFAULT_MODE
        self.snake: Snake | None = None
        self.field: PickupField | None = None
        self.powers: PowerField | None = None
        self.active = ActivePowers()
        self.obstacles: ObstacleField | None = None

    # ── setup ───────────────────────────────────────────────────────────────
    def enter(self, mode_key: str | None = None, **kwargs):
        self.mode_key = mode_key or self.app.save.data.get("last_mode", theme.DEFAULT_MODE)
        self.mode = theme.mode(self.mode_key)
        self.app.save.data["last_mode"] = self.mode_key
        self.app.save.mark()
        audio.duck_music(False)
        self.reset()

    def reset(self):
        st = self.app.save.settings
        self.particles.enabled = st.get("particles", True)
        self.screen_fx.enabled = st.get("shake", True)

        skin_key = self.app.save.data.get("skin", theme.DEFAULT_SKIN)
        self.snake = Snake(ARENA_RECT.centerx - 120, ARENA_RECT.centery, 0.0, skin_key)
        self.snake.invuln = INTRO_TIME + 0.35

        self.field = PickupField(ARENA_RECT, self.rng)
        self.powers = PowerField(ARENA_RECT, self.rng)
        self.obstacles = ObstacleField(ARENA_RECT, self.rng)
        self.active = ActivePowers()
        self.field.ensure_food(self.snake, self.obstacles.items)

        self.particles.clear()
        self.floaters.clear()
        self.ripples.clear()
        self.screen_fx.clear()

        self.score = 0
        self.level = 1
        self.food_total = 0
        self.food_toward_level = 0
        self.coins = 0
        self.gems = 0
        self.combo = 0
        self.combo_timer = 0.0
        self.combo_best = 0
        self.powers_taken = 0

        self.time_left = TIME_ATTACK_SECONDS
        self.challenge_index = 0
        self.challenge_flash = 0.0

        self.state = "intro"
        self.state_t = 0.0
        self.death_cause = ""
        self.level_flash = 0.0
        self.wall_pulse = 0.0
        self.trail_timer = 0.0
        self.t = 0.0
        self._score_shown = 0.0
        self._result = None

    # ── mode helpers ────────────────────────────────────────────────────────
    @property
    def objective(self):
        if self.mode_key != "challenge" or self.challenge_index >= len(theme.CHALLENGES):
            return None
        return theme.CHALLENGES[self.challenge_index]

    def _stat(self, name: str) -> int:
        return {
            "food": self.food_total,
            "coins": self.coins,
            "gems": self.gems,
            "score": self.score,
            "length": self.snake.length if self.snake else 0,
            "combo_best": self.combo_best,
        }.get(name, 0)

    # ── input ───────────────────────────────────────────────────────────────
    def handle(self, event):
        if event.type == pygame.KEYDOWN:
            if event.key in (pygame.K_ESCAPE, pygame.K_p):
                if self.state in ("intro", "playing"):
                    self.app.push(PauseScene(self.app), play=self)
                return
            if event.key == pygame.K_r and self.state in ("playing", "intro"):
                self.reset()
                return

    def _read_steering(self):
        """Eight-way from the held keys.

        Read as state rather than as events so that holding two keys gives a diagonal and
        releasing one returns cleanly to a cardinal, which key-down handling cannot do.
        """
        keys = pygame.key.get_pressed()
        dx = dy = 0
        if keys[pygame.K_LEFT] or keys[pygame.K_a]:
            dx -= 1
        if keys[pygame.K_RIGHT] or keys[pygame.K_d]:
            dx += 1
        if keys[pygame.K_UP] or keys[pygame.K_w]:
            dy -= 1
        if keys[pygame.K_DOWN] or keys[pygame.K_s]:
            dy += 1
        return dx, dy

    # ── loop ────────────────────────────────────────────────────────────────
    def update(self, dt: float):
        self.t += dt
        self.state_t += dt
        self.backdrop.update(dt)
        self.screen_fx.update(dt)

        # Score readout eases towards the real value, so a big pickup rolls up.
        self._score_shown += (self.score - self._score_shown) * min(1.0, dt * 9.0)
        self.level_flash = max(0.0, self.level_flash - dt * 1.8)
        self.wall_pulse = max(0.0, self.wall_pulse - dt * 2.6)
        self.challenge_flash = max(0.0, self.challenge_flash - dt * 1.2)

        if self.state == "intro" and self.state_t >= INTRO_TIME:
            self.state = "playing"
            self.state_t = 0.0

        if self.state in ("intro", "playing") and self.screen_fx.freeze <= 0.0:
            self._simulate(dt)

        # Presentation runs even while frozen, so a hit-stop still shows its particles.
        self.particles.update(dt)
        self.floaters.update(dt)
        self.ripples.update(dt)
        if self.obstacles:
            self.obstacles.update(dt)

        if self.state == "dying":
            if self.state_t >= 0.95:
                self._finish_death()

    def _simulate(self, dt: float):
        snake = self.snake
        scale = self.active.time_scale

        dx, dy = self._read_steering()
        if dx or dy:
            snake.steer_to(dx, dy)

        snake.boost = self.active.boost
        snake.shield = self.active.shield
        snake.ghost = 0.25 if self.active.ghost else 0.0
        snake.update(dt, scale)

        expired = self.active.update(dt)
        for key in expired:
            self.floaters.add(snake.x, snake.y - 46, f"{theme.POWERS[key].label} OVER",
                              theme.TEXT_DIM, size=17, life=0.8)

        self.field.update(dt, snake, self.obstacles.items,
                          magnet=self.active.magnet,
                          magnet_radius=MAGNET_RADIUS, magnet_pull=MAGNET_PULL)
        self.powers.update(dt, snake, self.obstacles.items, self.field, self.active)

        # Trail. Denser when boosting, which is most of how boost reads as fast.
        self.trail_timer -= dt
        if self.trail_timer <= 0.0:
            self.trail_timer = 0.028 if snake.boost else 0.055
            sk = theme.skin(snake.skin_key)
            self.particles.trail((snake.x, snake.y), sk.particle,
                                 size=5.0 if snake.boost else 3.6, life=0.34)

        snake.look_at(self._look_target())

        self._collect(dt)
        self._tick_combo(dt)
        self._tick_mode(dt)
        if self.state == "playing":
            self._check_death()

    def _look_target(self):
        near = self.field.nearest(self.snake.x, self.snake.y) if self.field else None
        if near is None:
            return None
        return (near.x, near.y)

    # ── pickups ─────────────────────────────────────────────────────────────
    def _collect(self, dt: float):
        snake = self.snake
        hr = HEAD_RADIUS * 0.95

        for p in self.field.take_at(snake.x, snake.y, hr):
            kind = theme.PICKUPS[p.kind]
            self.combo = min(COMBO_MAX, self.combo + 1) if self.combo_timer > 0.0 else 1
            self.combo_best = max(self.combo_best, self.combo)
            self.combo_timer = max(1.0, COMBO_WINDOW - COMBO_WINDOW_DECAY * self.combo)

            gained = kind.score * self.combo * self.active.score_multiplier
            self.score += gained
            snake.grow(kind.growth)

            if p.kind == "food":
                self.food_total += 1
                self.food_toward_level += 1
                audio.eat(min(11, self.combo - 1))
            elif p.kind == "coin":
                self.coins += 1
                audio.coin()
            else:
                self.gems += 1
                audio.gem()

            if self.combo >= 2:
                audio.combo()

            self._pickup_fx(p, kind, gained)

            if self.mode_key == "time":
                bonus = TIME_ATTACK_BONUS_GEM if p.kind == "gem" else TIME_ATTACK_BONUS_FOOD
                self.time_left = min(TIME_ATTACK_SECONDS * 1.5, self.time_left + bonus)
                self.floaters.add(p.x, p.y + 26, f"+{bonus:.0f}s", theme.GOLD,
                                  size=17, life=0.8)

            if self.food_toward_level >= FOOD_PER_LEVEL:
                self.food_toward_level = 0
                self._level_up()

        for d in self.powers.take_at(snake.x, snake.y, hr):
            self.active.activate(d.key)
            self.powers_taken += 1
            p = theme.POWERS[d.key]
            audio.power()
            self.floaters.add(d.x, d.y - 20, p.label, p.color, size=27, life=1.1, vy=-70)
            self.floaters.add(d.x, d.y + 12, p.blurb.upper(), theme.TEXT_DIM, size=14, life=1.1)
            self.particles.ring((d.x, d.y), 26, p.glow, radius_speed=(200, 340),
                                size=(4, 9), life=(0.4, 0.75))
            self.ripples.add(d.x, d.y, 14, 130, p.glow, life=0.6, width=5)
            self.screen_fx.kick(5.0)
            self.screen_fx.do_flash(p.color, 0.22)

    def _pickup_fx(self, p, kind, gained: int):
        n = 14 + self.combo * 2
        self.particles.ring((p.x, p.y), min(26, n), kind.glow,
                            radius_speed=(140, 240), size=(3, 7), life=(0.3, 0.55))
        self.particles.burst((p.x, p.y), min(18, 8 + self.combo), kind.color,
                             speed=(60, 200), size=(3, 6), life=(0.25, 0.5))
        self.ripples.add(p.x, p.y, 8, 74 + self.combo * 6, kind.glow, life=0.42, width=4)

        col = theme.GOLD if self.combo >= 4 else kind.glow
        self.floaters.add(p.x, p.y - 18, f"+{gained}", col,
                          size=22 + min(14, self.combo * 2), life=0.85)
        if self.combo >= 2:
            self.floaters.add(p.x + 4, p.y - 46, f"x{self.combo}",
                              theme.ACCENT_2 if self.combo < 5 else theme.GOLD,
                              size=20 + min(16, self.combo * 2), life=0.95, vy=-72)

        # Shake only for genuinely notable pickups; shaking on every orb is exhausting.
        if p.kind == "gem":
            self.screen_fx.kick(7.0)
            self.screen_fx.do_flash(kind.glow, 0.28)
        elif self.combo >= 5:
            self.screen_fx.kick(4.0)

    # ── progression ─────────────────────────────────────────────────────────
    def _level_up(self):
        if self.level >= MAX_LEVEL:
            return
        self.level += 1
        self.snake.set_level_speed(self.level)
        self.level_flash = 1.0
        self.wall_pulse = 1.0
        audio.level_up()
        self.floaters.add(GAME_W // 2, ARENA_RECT.top + 96, f"LEVEL {self.level}",
                          theme.ACCENT, size=40, life=1.4, vy=-24)
        self.screen_fx.kick(6.0)
        self.screen_fx.do_flash(theme.ACCENT, 0.2)
        self.ripples.add(self.snake.x, self.snake.y, 20, 320, theme.ACCENT, life=0.8, width=6)

        added = self.obstacles.sync_to_level(self.level, self.snake, self.field)
        for ob in added:
            self.ripples.add(ob.rect.centerx, ob.rect.centery, 10,
                             max(ob.rect.w, ob.rect.h) * 1.6, theme.DANGER, life=0.6, width=4)

    def _tick_combo(self, dt: float):
        if self.combo_timer > 0.0:
            self.combo_timer = max(0.0, self.combo_timer - dt)
            if self.combo_timer == 0.0 and self.combo >= 3:
                self.floaters.add(self.snake.x, self.snake.y - 40, "COMBO LOST",
                                  theme.TEXT_DIM, size=16, life=0.7)
            if self.combo_timer == 0.0:
                self.combo = 0

    def _tick_mode(self, dt: float):
        if self.mode_key == "time" and self.state == "playing":
            self.time_left -= dt
            if self.time_left <= 0.0:
                self.time_left = 0.0
                self._die("time")
                return

        if self.mode_key == "challenge":
            obj = self.objective
            if obj and self._stat(obj.stat) >= obj.target:
                self.challenge_index += 1
                self.challenge_flash = 1.0
                audio.level_up()
                self.score += 250
                self.floaters.add(GAME_W // 2, ARENA_RECT.top + 140, "OBJECTIVE COMPLETE",
                                  theme.ACCENT_2, size=30, life=1.5, vy=-20)
                self.floaters.add(GAME_W // 2, ARENA_RECT.top + 180, "+250", theme.GOLD,
                                  size=22, life=1.3, vy=-18)
                self.screen_fx.kick(7.0)
                self.screen_fx.do_flash(theme.ACCENT_2, 0.3)
                self.particles.ring((GAME_W // 2, ARENA_RECT.top + 150), 30, theme.ACCENT_2,
                                    radius_speed=(220, 400), life=(0.5, 0.9))
                if self.challenge_index >= len(theme.CHALLENGES):
                    self._die("complete")

    # ── death ───────────────────────────────────────────────────────────────
    def _check_death(self):
        snake = self.snake
        if snake.invuln > 0.0:
            return

        if self.active.ghost:
            # Ghost passes through obstacles but is still bounded by the arena, so it cannot be
            # used to park outside the playfield.
            if snake.outside(ARENA_RECT):
                snake.clamp_into(ARENA_RECT)
                self.wall_pulse = max(self.wall_pulse, 0.5)
            return

        if snake.outside(ARENA_RECT):
            if self._absorb("wall"):
                return
            self._die("wall")
            return

        for rect in self.obstacles.solid_rects():
            if snake.hits_rect(rect, inset=2.0):
                if self._absorb("obstacle"):
                    return
                self._die("obstacle")
                return

        if snake.hits_self():
            if self._absorb("self"):
                return
            self._die("self")

    def _hazard_normal(self, cause: str) -> tuple[float, float]:
        """Outward normal of whatever the snake just hit, for the shield bounce."""
        snake = self.snake
        if cause == "wall":
            # Whichever edge is closest wins; on a corner the two combine into a diagonal.
            nx = ny = 0.0
            if snake.x - ARENA_RECT.left < HEAD_RADIUS * 1.5:
                nx = 1.0
            elif ARENA_RECT.right - snake.x < HEAD_RADIUS * 1.5:
                nx = -1.0
            if snake.y - ARENA_RECT.top < HEAD_RADIUS * 1.5:
                ny = 1.0
            elif ARENA_RECT.bottom - snake.y < HEAD_RADIUS * 1.5:
                ny = -1.0
            if nx or ny:
                return (nx, ny)
        elif cause == "obstacle":
            for rect in self.obstacles.solid_rects():
                if snake.hits_rect(rect, inset=2.0):
                    dx = snake.x - rect.centerx
                    dy = snake.y - rect.centery
                    # Compare penetration on each axis so the bounce leaves by the near face.
                    if abs(dx) / max(1.0, rect.w) > abs(dy) / max(1.0, rect.h):
                        return (1.0 if dx >= 0 else -1.0, 0.0)
                    return (0.0, 1.0 if dy >= 0 else -1.0)
        # Self-collision, or anything unclassified: peel off perpendicular to the current
        # heading, which is always clear because the body is behind the head.
        return (-math.sin(snake.heading), math.cos(snake.heading))

    def _absorb(self, cause: str) -> bool:
        """Spend the shield, if there is one. Returns True when the hit was survived."""
        if not self.active.spend_shield():
            return False
        snake = self.snake
        audio.shield()
        self.screen_fx.kick(11.0)
        self.screen_fx.do_flash(theme.POWERS["shield"].color, 0.4)
        self.screen_fx.hit_stop(0.09)
        self.particles.ring((snake.x, snake.y), 30, theme.POWERS["shield"].color,
                            radius_speed=(240, 420), size=(4, 9), life=(0.4, 0.8))
        self.ripples.add(snake.x, snake.y, 16, 200, theme.POWERS["shield"].color,
                         life=0.7, width=6)
        self.floaters.add(snake.x, snake.y - 48, "SHIELD BROKE",
                          theme.POWERS["shield"].color, size=24, life=1.1)

        # Bounce off the surface and step clear of it, so the shield does not simply buy a
        # tenth of a second before the same collision fires again.
        nx, ny = self._hazard_normal(cause)
        snake.deflect(nx, ny, push=HEAD_RADIUS * 1.4)
        snake.clamp_into(ARENA_RECT.inflate(-HEAD_RADIUS * 2, -HEAD_RADIUS * 2))
        snake.invuln = RESPAWN_INVULN
        return True

    def _die(self, cause: str):
        if self.state in ("dying", "dead"):
            return
        self.state = "dying"
        self.state_t = 0.0
        self.death_cause = cause
        self.snake.alive = False

        won = cause == "complete"
        if won:
            audio.level_up()
            self.screen_fx.do_flash(theme.ACCENT_2, 0.5)
        else:
            audio.death()
            self.screen_fx.do_flash(theme.DANGER if cause != "time" else theme.GOLD, 0.45)
        self.screen_fx.kick(16.0)
        self.screen_fx.hit_stop(DEATH_FREEZE)

        sk = theme.skin(self.snake.skin_key)
        # Blow the body apart along its own length, so the death traces the snake.
        for i in range(0, len(self.snake.body), 2):
            bx, by = self.snake.body[i]
            self.particles.burst((bx, by), 3, sk.particle, speed=(50, 240),
                                 size=(3, 7), life=(0.4, 0.9), grav=140.0)
        self.particles.burst((self.snake.x, self.snake.y), 34, sk.glow,
                             speed=(120, 460), size=(4, 10), life=(0.5, 1.0), grav=90.0)
        self.particles.sparks((self.snake.x, self.snake.y), 18, theme.TEXT,
                              speed=(260, 560), spread=math.tau)
        self.ripples.add(self.snake.x, self.snake.y, 20, 420,
                         theme.ACCENT_2 if won else theme.DANGER, life=0.9, width=8)

    def _finish_death(self):
        if self.state == "dead":
            return
        self.state = "dead"
        self._result = self.app.save.record_run(
            self.mode_key, self.score, self.snake.length, self.combo_best,
            self.food_total, self.challenge_index)
        audio.duck_music(True)
        self.app.push(GameOverScene(self.app), play=self)

    # ── drawing ─────────────────────────────────────────────────────────────
    def draw(self, surf: pygame.Surface):
        ox, oy = self.screen_fx.offset()

        world = surf
        if ox or oy:
            # Shake by drawing the world into a scratch layer and offsetting it, so the HUD can
            # stay rock-steady on top. A shaking score readout is nauseating.
            world = pygame.Surface((GAME_W, GAME_H))
            world.fill(theme.BG_DEEP)

        self.backdrop.draw(world)
        self.frame.draw_under(world)

        clip = world.get_clip()
        world.set_clip(ARENA_RECT)
        self.obstacles.draw(world)
        self.field.draw(world)
        self.powers.draw(world)
        self.particles.draw(world)
        if self.snake and (self.state != "dying" or self.state_t < 0.12):
            self.snake.draw(world)
        self.ripples.draw(world)
        world.set_clip(clip)

        self.frame.draw_over(world, self.wall_pulse)

        if world is not surf:
            surf.blit(world, (ox, oy))

        self.floaters.draw(surf, fonts)
        self.backdrop.draw_vignette(surf)
        self._draw_hud(surf)
        self._draw_banners(surf)
        self.screen_fx.draw_flash(surf)

    # ── HUD ─────────────────────────────────────────────────────────────────
    def _draw_hud(self, surf):
        # Panel runs to y=86, not to HUD_H. Its lowest content — the best-score line and the
        # objective counter — sits a few pixels past 74, and was being cut off by the edge of its
        # own background. The arena starts at 87, so this fits between them.
        surf.blit(assets.rounded_panel(GAME_W + 40, HUD_H + 30, 18,
                                      theme.shade(theme.PANEL_HI, -0.1),
                                      theme.shade(theme.PANEL, -0.25),
                                      theme.PANEL_LINE, 2, 240), (-20, -18))

        # Score, left. The largest number on screen, because it is the point.
        fonts.draw(surf, "SCORE", (30, 16), 12, theme.TEXT_FAINT, anchor="topleft", tracking=2.6)
        shown = int(round(self._score_shown))
        fonts.draw(surf, f"{shown:,}", (30, 30), 34, theme.TEXT, anchor="topleft",
                   tracking=1.0, glow=theme.ACCENT, glow_alpha=44)

        best = max(self.app.save.high_score(self.mode_key), self.score)
        fonts.draw(surf, f"BEST  {best:,}", (32, 66), 13, theme.GOLD, anchor="topleft",
                   bold=False, tracking=1.4)

        # Mode-specific block, centre.
        self._draw_mode_block(surf)

        # Level, length and combo, right.
        self._hud_stat(surf, GAME_W - 30, "LENGTH",
                       str(self.snake.length if self.snake else 0), theme.GREEN)
        self._hud_stat(surf, GAME_W - 130, "LEVEL", f"{self.level}", theme.ACCENT)

        # Under the level figure only. Spanning the full width ran it beneath the length
        # readout, which read as one broken element rather than two working ones.
        ui.progress_bar(surf, pygame.Rect(GAME_W - 206, 60, 76, 5),
                        self.food_toward_level / FOOD_PER_LEVEL, theme.ACCENT)

        self._draw_combo(surf)
        self._draw_power_strip(surf)

    def _hud_stat(self, surf, right_x, label, value, color):
        fonts.draw(surf, label, (right_x, 16), 12, theme.TEXT_FAINT,
                   anchor="topright", tracking=2.4)
        fonts.draw(surf, value, (right_x, 28), 26, color, anchor="topright",
                   tracking=0.8, glow=color, glow_alpha=40)

    def _draw_mode_block(self, surf):
        cx = GAME_W // 2
        if self.mode_key == "time":
            frac = self.time_left / TIME_ATTACK_SECONDS
            low = self.time_left <= 10.0
            col = theme.DANGER if low else theme.GOLD
            pulse = 1.0 + (0.09 * math.sin(self.t * 9.0) if low else 0.0)
            fonts.draw(surf, "TIME", (cx, 12), 12, theme.TEXT_FAINT, anchor="midtop",
                       tracking=2.6)
            fonts.draw(surf, f"{self.time_left:0.1f}", (cx, 26), int(32 * pulse), col,
                       anchor="midtop", tracking=1.0, glow=col, glow_alpha=60)
            ui.progress_bar(surf, (cx - 90, 64, 180, 6), min(1.0, frac), col)
        elif self.mode_key == "challenge":
            obj = self.objective
            done = self.challenge_index
            total = len(theme.CHALLENGES)
            fonts.draw(surf, f"OBJECTIVE {min(done + 1, total)} / {total}", (cx, 12), 12,
                       theme.TEXT_FAINT, anchor="midtop", tracking=2.6)
            if obj:
                have = self._stat(obj.stat)
                text = obj.text.format(target=obj.target)
                flash = self.challenge_flash
                col = theme.lerp_color(theme.TEXT, theme.ACCENT_2, min(1.0, flash))
                fonts.draw(surf, text.upper(), (cx, 28), 21, col, anchor="midtop",
                           tracking=1.6, glow=theme.ACCENT_2 if flash > 0.1 else None,
                           glow_alpha=int(80 * flash))
                ui.progress_bar(surf, (cx - 104, 58, 200, 7),
                                have / max(1, obj.target), theme.ACCENT_2)
                # Beside the bar rather than under it: under it, the count fell past the bottom
                # of the HUD panel and read as a clipped artefact.
                fonts.draw(surf, f"{min(have, obj.target)} / {obj.target}", (cx + 104, 62), 13,
                           theme.TEXT_DIM, anchor="midleft", bold=False, tracking=0.8)
            else:
                fonts.draw(surf, "ALL OBJECTIVES CLEAR", (cx, 30), 22, theme.ACCENT_2,
                           anchor="midtop", tracking=2.0, glow=theme.ACCENT_2, glow_alpha=70)
        else:
            fonts.draw(surf, self.mode.name, (cx, 14), 12, theme.TEXT_FAINT,
                       anchor="midtop", tracking=3.4)
            fonts.draw(surf, f"{self.food_total} ORBS", (cx, 30), 24, theme.PICKUPS["food"].color,
                       anchor="midtop", tracking=1.4)

    def _draw_combo(self, surf):
        if self.combo < 2:
            return
        frac = self.combo_timer / max(0.01, COMBO_WINDOW - COMBO_WINDOW_DECAY * self.combo)
        big = self.combo >= 5
        col = theme.GOLD if big else theme.ACCENT_2
        cx, cy = GAME_W // 2, HUD_H + 54

        pop = 1.0 + 0.16 * max(0.0, 1.0 - (COMBO_WINDOW - self.combo_timer) * 4.0)
        size = int((34 + min(20, self.combo * 3)) * pop)

        g = assets.glow(int(size * 1.5), col, falloff=2.6, peak=int(70 + 50 * frac))
        surf.blit(g, g.get_rect(center=(cx, cy)), special_flags=pygame.BLEND_ADD)
        fonts.draw(surf, f"x{self.combo}", (cx, cy), size, col, anchor="center",
                   tracking=1.0, glow=col, glow_alpha=110)

        # A draining ring around the multiplier: the combo timer, without a second HUD element.
        r = int(size * 0.86)
        img = assets.ring(r, 4, assets.dim(col, (90 + 120 * frac) / 255.0))
        surf.blit(img, img.get_rect(center=(cx, cy)), special_flags=pygame.BLEND_ADD)

    def _draw_power_strip(self, surf):
        keys = self.active.active_keys()
        if not keys:
            return
        size = 46
        gap = 10
        total = len(keys) * size + (len(keys) - 1) * gap
        x = (GAME_W - total) // 2
        y = GAME_H - size - 22

        for key in keys:
            p = theme.POWERS[key]
            frac = self.active.fraction(key)
            centre = (x + size // 2, y + size // 2)

            g = assets.glow(int(size * 0.95), p.glow, falloff=2.6, peak=int(60 + 60 * frac))
            surf.blit(g, g.get_rect(center=centre), special_flags=pygame.BLEND_ADD)

            surf.blit(assets.rounded_panel(size, size, 14, theme.PANEL_HI, theme.PANEL,
                                           p.color, 2), (x, y))
            icon = assets.power_icon(key, int(size * 0.56))
            tinted = icon.copy()
            tinted.fill((*p.color, 255), special_flags=pygame.BLEND_RGBA_MULT)
            surf.blit(tinted, tinted.get_rect(center=(centre[0], centre[1] - 3)))

            # Duration as a draining bar under the icon, plus a flashing frame when nearly out.
            ui.progress_bar(surf, (x + 7, y + size - 11, size - 14, 4), frac, p.color)
            if frac < 0.25 and int(self.t * 8) % 2 == 0:
                pygame.draw.rect(surf, p.color, (x, y, size, size), width=2, border_radius=14)
            x += size + gap

    def _draw_banners(self, surf):
        # Intro: mode name, then GO.
        if self.state == "intro":
            k = min(1.0, self.state_t / 0.4)
            fade = 1.0 if self.state_t < INTRO_TIME - 0.3 else \
                max(0.0, 1.0 - (self.state_t - (INTRO_TIME - 0.3)) / 0.3)
            cx, cy = GAME_W // 2, ARENA_RECT.centery - 40
            scale = 0.72 + 0.28 * ease_out_back(k, 2.0)
            fonts.draw(surf, self.mode.name, (cx, cy), int(58 * scale), theme.TEXT,
                       anchor="center", tracking=7.0, glow=self.mode.color,
                       glow_alpha=int(120 * fade), alpha=int(255 * fade))
            fonts.draw(surf, self.mode.blurb.upper(), (cx, cy + 52), 17, theme.TEXT_DIM,
                       anchor="center", bold=False, tracking=3.0, alpha=int(220 * fade))
            if self.state_t > INTRO_TIME * 0.55:
                gk = min(1.0, (self.state_t - INTRO_TIME * 0.55) / 0.25)
                fonts.draw(surf, "GO", (cx, cy + 118), int(34 * (0.7 + 0.3 * ease_out_back(gk))),
                           self.mode.color, anchor="center", tracking=6.0,
                           glow=self.mode.color, glow_alpha=int(130 * fade),
                           alpha=int(255 * fade))

        if self.level_flash > 0.02:
            k = self.level_flash
            fonts.draw(surf, f"LEVEL {self.level}", (GAME_W // 2, ARENA_RECT.top + 54),
                       int(30 + 14 * k), theme.ACCENT, anchor="center", tracking=5.0,
                       glow=theme.ACCENT, glow_alpha=int(120 * k), alpha=int(255 * min(1.0, k * 2)))

        if self.state == "dying":
            k = min(1.0, self.state_t / 0.5)
            won = self.death_cause == "complete"
            text = "RUN COMPLETE" if won else ("TIME UP" if self.death_cause == "time" else "CRASHED")
            col = theme.ACCENT_2 if won else (theme.GOLD if self.death_cause == "time" else theme.DANGER)
            fonts.draw(surf, text, (GAME_W // 2, ARENA_RECT.centery),
                       int(52 * (0.6 + 0.4 * ease_out_back(k, 2.4))), col,
                       anchor="center", tracking=7.0, glow=col, glow_alpha=int(140 * k),
                       alpha=int(255 * min(1.0, k * 2.4)))


# ── overlays ────────────────────────────────────────────────────────────────
class PauseScene(Scene):
    """Pause. Drawn over the frozen arena, which keeps the player oriented."""

    transparent = True

    def __init__(self, app):
        super().__init__(app)
        self.group = ui.Group()
        self.play: PlayScene | None = None

    def enter(self, play=None, **kwargs):
        self.play = play
        self.t = 0.0
        audio.duck_music(True)
        self.group.clear()
        x = (GAME_W - 340) // 2
        y = 300
        self.group.add(ui.Button((x, y, 340, 60), "RESUME", self._resume,
                                color=theme.ACCENT, size=26))
        self.group.add(ui.Button((x, y + 72, 340, 56), "RESTART", self._restart,
                                color=theme.GOLD, size=21))
        self.group.add(ui.Button((x, y + 144, 340, 56), "MAIN MENU", self._menu,
                                color=theme.TEXT_DIM, size=21))

    def _resume(self):
        audio.duck_music(False)
        self.app.pop()

    def _restart(self):
        if self.play:
            self.play.reset()
        audio.duck_music(False)
        self.app.pop()

    def _menu(self):
        from .menu import MenuScene
        self.app.save.flush()
        self.app.switch(MenuScene(self.app))

    def handle(self, event):
        if event.type == pygame.KEYDOWN and event.key in (pygame.K_ESCAPE, pygame.K_p):
            self._resume()
            return
        if event.type == pygame.KEYDOWN and event.key == pygame.K_r:
            self._restart()
            return
        self.group.handle(event)

    def update(self, dt):
        self.t += dt
        self.group.update(dt, self.app.mouse, self.app.mouse_down)

    def draw(self, surf):
        scrim = pygame.Surface((GAME_W, GAME_H), pygame.SRCALPHA)
        scrim.fill((*theme.BG_DEEP, int(214 * min(1.0, self.t * 6))))
        surf.blit(scrim, (0, 0))

        k = min(1.0, self.t / 0.3)
        dy = int(26 * (1.0 - ease_out_cubic(k)))

        fonts.draw(surf, "PAUSED", (GAME_W // 2, 196 + dy), 66, theme.TEXT,
                   anchor="center", tracking=9.0, glow=theme.ACCENT, glow_alpha=110,
                   alpha=int(255 * k))
        if self.play:
            fonts.draw(surf, f"{self.play.mode.name}   ·   SCORE {self.play.score:,}"
                             f"   ·   LEVEL {self.play.level}",
                       (GAME_W // 2, 250 + dy), 17, theme.TEXT_DIM, anchor="center",
                       bold=False, tracking=2.4, alpha=int(230 * k))

        for w in self.group.widgets:
            w.draw(surf)

        fonts.draw(surf, "ESC / P  RESUME      R  RESTART", (GAME_W // 2, GAME_H - 42), 14,
                   theme.TEXT_FAINT, anchor="center", bold=False, tracking=2.2)


class GameOverScene(Scene):
    """The end-of-run summary, and the fastest possible route back into another run."""

    transparent = True

    def __init__(self, app):
        super().__init__(app)
        self.group = ui.Group()
        self.play: PlayScene | None = None
        self.particles = Particles(300)

    def enter(self, play=None, **kwargs):
        self.play = play
        self.t = 0.0
        self.particles.enabled = self.app.save.settings.get("particles", True)
        self.result = getattr(play, "_result", None) or {}
        self._celebrated = False

        self.group.clear()
        x = (GAME_W - 330) // 2
        y = GAME_H - 208
        self.group.add(ui.Button((x, y, 330, 60), "PLAY AGAIN", self._again,
                                color=theme.ACCENT, size=26))
        self.group.add(ui.Button((x - 178, y + 4, 168, 52), "MODES", self._modes,
                                color=theme.GOLD, size=18))
        self.group.add(ui.Button((x + 340, y + 4, 168, 52), "MENU", self._menu,
                                color=theme.TEXT_DIM, size=18))

    def _again(self):
        play = self.play
        self.app.pop()
        if play:
            play.reset()
            audio.duck_music(False)

    def _modes(self):
        from .modes import ModesScene
        self.app.switch(ModesScene(self.app))

    def _menu(self):
        from .menu import MenuScene
        self.app.switch(MenuScene(self.app))

    def handle(self, event):
        if event.type == pygame.KEYDOWN:
            if event.key in (pygame.K_RETURN, pygame.K_KP_ENTER, pygame.K_r, pygame.K_SPACE):
                self._again()
                return
            if event.key == pygame.K_ESCAPE:
                self._menu()
                return
        self.group.handle(event)

    def update(self, dt):
        self.t += dt
        self.particles.update(dt)
        self.group.update(dt, self.app.mouse, self.app.mouse_down)

        if not self._celebrated and self.t > 0.45:
            self._celebrated = True
            if self.result.get("new_high"):
                for i in range(3):
                    self.particles.ring((GAME_W // 2, 250), 22, theme.GOLD,
                                        radius_speed=(180 + i * 90, 320 + i * 90),
                                        size=(4, 9), life=(0.6, 1.1))
                audio.level_up()

    def draw(self, surf):
        scrim = pygame.Surface((GAME_W, GAME_H), pygame.SRCALPHA)
        scrim.fill((*theme.BG_DEEP, int(226 * min(1.0, self.t * 5))))
        surf.blit(scrim, (0, 0))
        self.particles.draw(surf)

        p = self.play
        if p is None:
            return

        k = min(1.0, self.t / 0.34)
        dy = int(30 * (1.0 - ease_out_cubic(k)))
        won = p.death_cause == "complete"

        title = "RUN COMPLETE" if won else ("TIME UP" if p.death_cause == "time" else "GAME OVER")
        col = theme.ACCENT_2 if won else (theme.GOLD if p.death_cause == "time" else theme.DANGER)
        fonts.draw(surf, title, (GAME_W // 2, 118 + dy), 60, theme.TEXT, anchor="center",
                   tracking=8.0, glow=col, glow_alpha=int(120 * k), alpha=int(255 * k))

        cause = {
            "wall": "You hit the wall.",
            "self": "You ran into yourself.",
            "obstacle": "You hit an obstacle.",
            "time": "The clock beat you.",
            "complete": "Every objective cleared.",
        }.get(p.death_cause, "")
        fonts.draw(surf, cause.upper(), (GAME_W // 2, 162 + dy), 15, theme.TEXT_DIM,
                   anchor="center", bold=False, tracking=2.6, alpha=int(220 * k))

        # Score, big, with a record badge when it earned one.
        k2 = min(1.0, max(0.0, (self.t - 0.12) / 0.4))
        scale = 0.7 + 0.3 * ease_out_back(k2, 2.2)
        fonts.draw(surf, f"{p.score:,}", (GAME_W // 2, 236), int(76 * scale), theme.TEXT,
                   anchor="center", tracking=2.0, glow=theme.ACCENT,
                   glow_alpha=int(110 * k2), alpha=int(255 * min(1.0, k2 * 2)))
        fonts.draw(surf, "FINAL SCORE", (GAME_W // 2, 194), 12, theme.TEXT_FAINT,
                   anchor="center", tracking=3.4, alpha=int(255 * k2))

        if self.result.get("new_high"):
            pulse = 0.5 + 0.5 * math.sin(self.t * 6.0)
            ui.pill(surf, (GAME_W // 2 - 88, 278, 176, 28), "NEW PERSONAL BEST",
                    theme.GOLD, size=13, filled=True)
            g = assets.glow(120, theme.GOLD, falloff=3.0, peak=int(40 + 30 * pulse))
            surf.blit(g, g.get_rect(center=(GAME_W // 2, 292)), special_flags=pygame.BLEND_ADD)
        else:
            best = self.app.save.high_score(p.mode_key)
            fonts.draw(surf, f"BEST  {best:,}", (GAME_W // 2, 288), 17, theme.GOLD,
                       anchor="center", bold=False, tracking=2.0)

        self._draw_stats(surf)
        self._draw_unlocks(surf)

        for w in self.group.widgets:
            w.draw(surf)

        fonts.draw(surf, "ENTER / R  PLAY AGAIN      ESC  MENU", (GAME_W // 2, GAME_H - 32),
                   14, theme.TEXT_FAINT, anchor="center", bold=False, tracking=2.2)

    def _draw_stats(self, surf):
        from .common import stat_tile
        p = self.play
        k = min(1.0, max(0.0, (self.t - 0.24) / 0.4))
        if k <= 0.01:
            return

        tiles = [
            ("LENGTH", p.snake.length if p.snake else 0, theme.GREEN),
            ("BEST COMBO", f"x{p.combo_best}", theme.ACCENT_2),
            ("ORBS", p.food_total, theme.PICKUPS["food"].color),
            ("SPARKS", p.coins, theme.PICKUPS["coin"].color),
            ("PRISMS", p.gems, theme.PICKUPS["gem"].color),
            ("LEVEL", p.level, theme.ACCENT),
        ]
        if p.mode_key == "challenge":
            tiles[5] = ("OBJECTIVES", f"{p.challenge_index}/{len(theme.CHALLENGES)}", theme.ACCENT_2)

        tw, th, gap = 148, 70, 14
        total = len(tiles) * tw + (len(tiles) - 1) * gap
        x0 = (GAME_W - total) // 2
        y = 336
        layer = pygame.Surface((GAME_W, GAME_H), pygame.SRCALPHA)
        for i, (label, value, color) in enumerate(tiles):
            stat_tile(layer, (x0 + i * (tw + gap), y, tw, th), label, value, color)
        layer.set_alpha(int(255 * k))
        surf.blit(layer, (0, int(20 * (1.0 - ease_out_cubic(k)))))

    def _draw_unlocks(self, surf):
        unlocked = self.result.get("unlocked") or []
        if not unlocked:
            return
        k = min(1.0, max(0.0, (self.t - 0.6) / 0.5))
        y = 438
        fonts.draw(surf, "SKIN UNLOCKED", (GAME_W // 2, y), 13, theme.GOLD,
                   anchor="center", tracking=3.4, alpha=int(255 * k))
        names = "   ·   ".join(s.name for s in unlocked)
        fonts.draw(surf, names, (GAME_W // 2, y + 26), 26,
                   unlocked[0].glow, anchor="center", tracking=3.0,
                   glow=unlocked[0].glow, glow_alpha=int(90 * k), alpha=int(255 * k))
