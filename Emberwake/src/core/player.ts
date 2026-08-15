/**
 * Nim — the character controller.
 *
 * This is the most important file in the game. A platformer is judged in the first ten seconds,
 * before a player has seen a level or an enemy, entirely on how it feels to run and jump. So
 * the controller is a proper state machine over a fixed timestep, it is completely free of the
 * DOM, and it is driven by an input struct rather than by a keyboard — which means the whole of
 * it can be exercised in Node, and every forgiveness mechanic below has a test that proves it
 * is actually there.
 *
 * The forgiveness mechanics are the point. Coyote time, jump buffering, variable jump height,
 * apex hang, sticky turn acceleration — none of them are physical, all of them are what the
 * player *meant*. A controller that simulates a body correctly and ignores intent feels wrong
 * to everyone and no one can say why.
 */

import {
  GRAVITY, FALL_GRAVITY_MULT, APEX_GRAVITY_MULT, APEX_THRESHOLD,
  JUMP_VELOCITY, JUMP_CUT_VELOCITY, JUMP_CUT_DELAY, MAX_FALL_SPEED,
  COYOTE_TIME, JUMP_BUFFER,
  RUN_SPEED, SPRINT_SPEED, GROUND_ACCEL, GROUND_FRICTION, AIR_ACCEL, AIR_DRAG, TURN_MULT,
  DASH_SPEED, DASH_TIME, DASH_COOLDOWN, DOUBLE_JUMP_VELOCITY,
  WALL_SLIDE_SPEED, WALL_JUMP_X, WALL_JUMP_Y, WALL_JUMP_LOCK,
  MAX_HEALTH, HURT_INVULN, HURT_KNOCKBACK_X, HURT_KNOCKBACK_Y,
  STOMP_BOUNCE, STOMP_BOUNCE_HELD,
  SPEED_ORB_MULT, JUMP_BOOST_MULT, POWERUP_DURATION,
  PLAYER_W, PLAYER_H, TILE,
} from './constants.js';
import { Body, TileMap, Platform, makeBody, moveBody, Tile } from './world.js';

export interface InputState {
  left: boolean;
  right: boolean;
  down: boolean;
  jump: boolean;
  /** True only on the frame the button went down. */
  jumpPressed: boolean;
  dash: boolean;
  dashPressed: boolean;
}

export const emptyInput = (): InputState => ({
  left: false, right: false, down: false,
  jump: false, jumpPressed: false, dash: false, dashPressed: false,
});

export type PlayerState =
  | 'idle' | 'run' | 'jump' | 'fall' | 'land' | 'turn'
  | 'dash' | 'wallSlide' | 'hurt' | 'dead' | 'victory';

export type PowerUpKind = 'shield' | 'speed' | 'jump' | 'magnet' | 'invincible' | 'doubleJump';

export interface PlayerEvents {
  jumped: boolean;
  doubleJumped: boolean;
  wallJumped: boolean;
  landed: number;      // impact speed, 0 for no landing this step
  dashed: boolean;
  hurt: boolean;
  died: boolean;
  turned: boolean;
  footstep: boolean;
}

const noEvents = (): PlayerEvents => ({
  jumped: false, doubleJumped: false, wallJumped: false, landed: 0,
  dashed: false, hurt: false, died: false, turned: false, footstep: false,
});

export class Player {
  body: Body;
  state: PlayerState = 'idle';
  facing: 1 | -1 = 1;

  health = MAX_HEALTH;
  alive = true;

  /** Seconds remaining, keyed by power-up. Absent or <= 0 means inactive. */
  powers: Partial<Record<PowerUpKind, number>> = {};

  /** Abilities the player has permanently unlocked through progression. */
  canDoubleJump = false;
  canDash = false;
  canWallJump = false;

  // timers
  private coyote = 0;
  private buffer = 0;
  private airTime = 0;
  private jumpHeld = false;
  private dashTimer = 0;
  private dashCooldown = 0;
  private dashUsed = false;
  private doubleJumpUsed = false;
  private wallLock = 0;
  private invuln = 0;
  private hurtTimer = 0;
  private landTimer = 0;
  private turnTimer = 0;
  private footstepTimer = 0;

  /** Purely cosmetic, but read by the renderer every frame: squash on land, stretch in air. */
  squashX = 1;
  squashY = 1;

  events: PlayerEvents = noEvents();

  constructor(x: number, y: number) {
    this.body = makeBody(x, y, PLAYER_W, PLAYER_H);
  }

  get invulnerable(): boolean { return this.invuln > 0 || this.isActive('invincible'); }
  isActive(kind: PowerUpKind): boolean { return (this.powers[kind] ?? 0) > 0; }
  powerRemaining(kind: PowerUpKind): number { return this.powers[kind] ?? 0; }

  reset(x: number, y: number): void {
    this.body = makeBody(x, y, PLAYER_W, PLAYER_H);
    this.state = 'idle';
    this.alive = true;
    this.health = MAX_HEALTH;
    this.powers = {};
    this.coyote = this.buffer = this.airTime = 0;
    this.dashTimer = this.dashCooldown = this.wallLock = 0;
    this.invuln = this.hurtTimer = this.landTimer = this.turnTimer = 0;
    this.dashUsed = this.doubleJumpUsed = false;
    this.squashX = this.squashY = 1;
  }

  grantPower(kind: PowerUpKind, seconds = POWERUP_DURATION): void {
    // Shields are a charge, not a timer — one hit, however long it takes to arrive.
    this.powers[kind] = kind === 'shield' ? Number.POSITIVE_INFINITY : seconds;
  }

  /**
   * One fixed simulation step.
   *
   * Order matters: timers, then intent, then velocity, then the move, then reaction to what the
   * move hit. Reading collision flags before moving is the classic source of a controller that
   * responds one frame late — small enough to pass a code review and large enough to feel bad.
   */
  update(input: InputState, map: TileMap, platforms: Platform[], dt: number): PlayerEvents {
    this.events = noEvents();

    if (!this.alive) {
      // Death still simulates: the body arcs up and falls off the screen, which reads as a
      // consequence rather than as the game freezing.
      this.body.vy = Math.min(this.body.vy + GRAVITY * dt, MAX_FALL_SPEED);
      this.body.y += this.body.vy * dt;
      this.state = 'dead';
      return this.events;
    }

    this.tickTimers(dt);

    const frozen = this.hurtTimer > 0;
    const left = frozen ? false : input.left;
    const right = frozen ? false : input.right;

    // ── dash ────────────────────────────────────────────────────────────────
    if (this.dashTimer > 0) {
      this.body.vx = this.facing * DASH_SPEED;
      // A dash is horizontal and weightless: cancelling gravity for its duration is what makes
      // it feel like a burst rather than a jump with extra speed.
      this.body.vy = 0;
      this.state = 'dash';
    } else {
      if (this.canDash && input.dashPressed && this.dashCooldown <= 0 && !this.dashUsed && !frozen) {
        this.dashTimer = DASH_TIME;
        this.dashCooldown = DASH_COOLDOWN;
        this.dashUsed = !this.body.onGround;
        this.events.dashed = true;
      }
      this.applyHorizontal(left, right, input, dt);
      this.applyGravity(input, dt);
    }

    // ── jumping ─────────────────────────────────────────────────────────────
    if (input.jumpPressed) this.buffer = JUMP_BUFFER;
    if (!frozen) this.tryJump(input, map);
    this.applyJumpCut(input);

    this.body.dropThrough = input.down && !this.body.onGround ? true : input.down;

    // ── move ────────────────────────────────────────────────────────────────
    const wasAir = !this.body.onGround;
    const impact = this.body.vy;
    moveBody(this.body, map, dt, platforms);

    if (this.body.onGround) {
      if (wasAir) this.onLand(impact);
      this.coyote = COYOTE_TIME;
      this.airTime = 0;
      this.dashUsed = false;
      this.doubleJumpUsed = false;
    } else {
      this.airTime += dt;
    }

    this.updateWallSlide(input, dt);
    this.updateFacingAndState(left, right, dt);
    this.updateSquash(dt);
    return this.events;
  }

  private tickTimers(dt: number): void {
    const dec = (v: number) => Math.max(0, v - dt);
    this.coyote = dec(this.coyote);
    this.buffer = dec(this.buffer);
    this.dashTimer = dec(this.dashTimer);
    this.dashCooldown = dec(this.dashCooldown);
    this.wallLock = dec(this.wallLock);
    this.invuln = dec(this.invuln);
    this.hurtTimer = dec(this.hurtTimer);
    this.landTimer = dec(this.landTimer);
    this.turnTimer = dec(this.turnTimer);
    for (const key of Object.keys(this.powers) as PowerUpKind[]) {
      const left = this.powers[key];
      if (left === undefined || left === Number.POSITIVE_INFINITY) continue;
      const next = left - dt;
      if (next <= 0) delete this.powers[key];
      else this.powers[key] = next;
    }
  }

  private applyHorizontal(left: boolean, right: boolean, input: InputState, dt: number): void {
    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    // A wall jump briefly ignores steering, so the player cannot hold into the wall and ratchet
    // up it one jump at a time.
    const steer = this.wallLock > 0 ? 0 : dir;

    const sprinting = input.dash && this.canDash && this.dashTimer <= 0;
    let top = sprinting ? SPRINT_SPEED : RUN_SPEED;
    if (this.isActive('speed')) top *= SPEED_ORB_MULT;

    const grounded = this.body.onGround;
    const accel = grounded ? GROUND_ACCEL : AIR_ACCEL;

    if (steer !== 0) {
      // Turning is sharper than accelerating from a standstill: pushing against your own
      // momentum should bite immediately, or direction changes feel like steering a boat.
      const turning = Math.sign(this.body.vx) !== 0 && Math.sign(this.body.vx) !== steer;
      const rate = accel * (turning ? TURN_MULT : 1);
      this.body.vx += steer * rate * dt;
      if (Math.abs(this.body.vx) > top) {
        // Decay toward the cap rather than clamping to it, so a dash or a bounce can leave the
        // player briefly faster than they can run and bleed it off naturally.
        const over = Math.abs(this.body.vx) - top;
        this.body.vx -= Math.sign(this.body.vx) * Math.min(over, GROUND_FRICTION * dt);
      }
    } else {
      const drag = grounded ? GROUND_FRICTION : AIR_DRAG;
      const speed = Math.abs(this.body.vx);
      const next = Math.max(0, speed - drag * dt);
      this.body.vx = Math.sign(this.body.vx) * next;
    }
  }

  /**
   * Gravity, in three regimes.
   *
   * Rising with jump held is lightest, the apex is lighter still, and falling is heaviest. The
   * asymmetry is invisible to a player and unmistakable to their hands.
   */
  private applyGravity(input: InputState, dt: number): void {
    let g = GRAVITY;
    if (this.body.vy > 0) g *= FALL_GRAVITY_MULT;
    if (Math.abs(this.body.vy) < APEX_THRESHOLD && !this.body.onGround) g *= APEX_GRAVITY_MULT;
    void input;
    this.body.vy = Math.min(this.body.vy + g * dt, MAX_FALL_SPEED);
  }

  private tryJump(input: InputState, map: TileMap): void {
    if (this.buffer <= 0) return;

    const boost = this.isActive('jump') ? JUMP_BOOST_MULT : 1;

    // Ground or coyote.
    if (this.body.onGround || this.coyote > 0) {
      this.body.vy = -JUMP_VELOCITY * boost;
      this.consumeJump();
      this.events.jumped = true;
      return;
    }

    // Wall jump, which also needs the wall to still be there.
    if (this.canWallJump && this.body.onWall !== 0 && this.wallAdjacent(map)) {
      const away = -this.body.onWall;
      this.body.vx = away * WALL_JUMP_X;
      this.body.vy = -WALL_JUMP_Y * boost;
      this.facing = away as 1 | -1;
      this.wallLock = WALL_JUMP_LOCK;
      this.consumeJump();
      this.events.wallJumped = true;
      return;
    }

    // Double jump, from the ability or from a temporary rune.
    const hasDouble = this.canDoubleJump || this.isActive('doubleJump');
    if (hasDouble && !this.doubleJumpUsed) {
      this.body.vy = -DOUBLE_JUMP_VELOCITY * boost;
      this.doubleJumpUsed = true;
      this.consumeJump();
      this.events.doubleJumped = true;
    }
    void input;
  }

  private consumeJump(): void {
    this.buffer = 0;
    this.coyote = 0;
    this.airTime = 0;
    this.jumpHeld = true;
    this.body.onGround = false;
    this.squashX = 0.82;
    this.squashY = 1.22;
  }

  /**
   * Variable jump height.
   *
   * Releasing the button clamps the remaining rise instead of zeroing it, and only after a few
   * milliseconds of airtime so a one-frame tap still becomes a real hop. Both details exist
   * because the naive version — set vy to 0 on release — makes a short jump stop dead mid-air.
   */
  private applyJumpCut(input: InputState): void {
    if (!input.jump) this.jumpHeld = false;
    if (this.jumpHeld || this.body.vy >= -JUMP_CUT_VELOCITY) return;
    if (this.airTime < JUMP_CUT_DELAY) return;
    this.body.vy = -JUMP_CUT_VELOCITY;
  }

  private wallAdjacent(map: TileMap): boolean {
    const dir = this.body.onWall;
    if (dir === 0) return false;
    const probeX = dir > 0 ? this.body.x + this.body.w + 2 : this.body.x - 2;
    const tx = Math.floor(probeX / TILE);
    const y0 = Math.floor((this.body.y + 4) / TILE);
    const y1 = Math.floor((this.body.y + this.body.h - 4) / TILE);
    for (let ty = y0; ty <= y1; ty++) if (map.at(tx, ty) === Tile.Solid) return true;
    return false;
  }

  private updateWallSlide(input: InputState, dt: number): void {
    if (!this.canWallJump || this.body.onGround || this.dashTimer > 0) return;
    const pressing = (this.body.onWall === -1 && input.left) || (this.body.onWall === 1 && input.right);
    if (!pressing || this.body.vy <= 0) return;
    this.body.vy = Math.min(this.body.vy, WALL_SLIDE_SPEED);
    this.state = 'wallSlide';
    void dt;
  }

  private onLand(impactSpeed: number): void {
    this.events.landed = impactSpeed;
    this.landTimer = 0.12;
    // Squash scales with how hard the landing was, and is clamped so a fall from the top of the
    // level does not flatten the character into a disc.
    const force = Math.min(1, impactSpeed / MAX_FALL_SPEED);
    this.squashX = 1 + 0.32 * force;
    this.squashY = 1 - 0.30 * force;
  }

  private updateFacingAndState(left: boolean, right: boolean, dt: number): void {
    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    if (dir !== 0 && this.wallLock <= 0) {
      if (dir !== this.facing) {
        this.facing = dir as 1 | -1;
        if (this.body.onGround && Math.abs(this.body.vx) > RUN_SPEED * 0.4) {
          this.turnTimer = 0.14;
          this.events.turned = true;
        }
      }
    }

    if (this.hurtTimer > 0) { this.state = 'hurt'; return; }
    if (this.dashTimer > 0) { this.state = 'dash'; return; }
    if (this.state === 'wallSlide' && !this.body.onGround) return;

    if (!this.body.onGround) {
      this.state = this.body.vy < 0 ? 'jump' : 'fall';
      return;
    }
    if (this.landTimer > 0) { this.state = 'land'; return; }
    if (this.turnTimer > 0) { this.state = 'turn'; return; }

    const speed = Math.abs(this.body.vx);
    if (speed > 12) {
      this.state = 'run';
      // Footsteps are paced by speed, not by the animation, so a slow walk does not sound like
      // a sprint played back slowly.
      this.footstepTimer -= dt * (speed / RUN_SPEED);
      if (this.footstepTimer <= 0) {
        this.footstepTimer = 0.26;
        this.events.footstep = true;
      }
    } else {
      this.state = 'idle';
      this.footstepTimer = 0;
    }
  }

  /** Squash and stretch relax back to 1 over a few frames, which is the whole effect. */
  private updateSquash(dt: number): void {
    const rate = 9 * dt;
    this.squashX += (1 - this.squashX) * Math.min(1, rate);
    this.squashY += (1 - this.squashY) * Math.min(1, rate);
    if (!this.body.onGround && this.dashTimer <= 0) {
      // Stretch slightly in the direction of travel while airborne.
      const stretch = Math.min(0.16, Math.abs(this.body.vy) / MAX_FALL_SPEED * 0.16);
      this.squashY = Math.max(this.squashY, 1 + stretch);
      this.squashX = Math.min(this.squashX, 1 - stretch * 0.7);
    }
  }

  // ── damage ────────────────────────────────────────────────────────────────

  /**
   * Take a hit from a direction.
   *
   * Returns false when the hit was absorbed, so the caller knows whether to play the shield
   * sound or the hurt one. A shield eats the hit entirely and does not even cost invulnerability
   * — being told "your shield worked" and then immediately dying to the same enemy is the worst
   * version of this mechanic.
   */
  takeHit(fromX: number, damage = 1): boolean {
    if (!this.alive || this.invulnerable) return false;
    if (this.isActive('shield')) {
      delete this.powers.shield;
      this.invuln = HURT_INVULN * 0.6;
      return false;
    }

    this.health -= damage;
    this.invuln = HURT_INVULN;
    this.hurtTimer = 0.28;
    const away = this.body.x + this.body.w / 2 < fromX ? -1 : 1;
    this.body.vx = away * HURT_KNOCKBACK_X;
    this.body.vy = -HURT_KNOCKBACK_Y;
    this.body.onGround = false;
    this.events.hurt = true;

    if (this.health <= 0) {
      this.health = 0;
      this.kill();
    }
    return true;
  }

  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'dead';
    this.body.vy = -420;
    this.body.vx = 0;
    this.events.died = true;
  }

  /** Bounce off a stomped enemy. Holding jump bounces higher, which rewards intent. */
  bounce(held: boolean): void {
    this.body.vy = -(held ? STOMP_BOUNCE_HELD : STOMP_BOUNCE);
    this.doubleJumpUsed = false;
    this.dashUsed = false;
    this.squashX = 0.86;
    this.squashY = 1.18;
  }

  get centerX(): number { return this.body.x + this.body.w / 2; }
  get centerY(): number { return this.body.y + this.body.h / 2; }
}
