/**
 * Enemies.
 *
 * Seven kinds, each defined by one idea the player has to read from its silhouette and its
 * movement before it reaches them. That constraint is what stops an enemy roster becoming a
 * list of hit-point values: a walker paces, a charger commits, a shielded one has a side you
 * cannot touch, a heavy cannot be stomped at all. If two enemies would be dealt with the same
 * way, one of them should not exist.
 *
 * They share the player's physics, so an enemy can never stand somewhere the player could not,
 * and none of them can walk through a wall. They also share its update shape — no DOM, no
 * rendering — so a level full of enemies can be simulated in a test.
 */

import { GRAVITY, MAX_FALL_SPEED, TILE } from './constants.js';
import { Body, TileMap, Platform, makeBody, moveBody } from './world.js';
import { EnemyKind } from './level.js';

export interface Projectile {
  x: number; y: number; vx: number; vy: number;
  life: number;
  active: boolean;
}

export interface EnemyEvents {
  fired: Projectile | null;
  turned: boolean;
  jumped: boolean;
  charging: boolean;
}

interface Spec {
  w: number;
  h: number;
  speed: number;
  /** Can it be defeated by landing on it? */
  stompable: boolean;
  /** Hits it takes. Most things die at once; the heavy does not. */
  hp: number;
  /** Score awarded, and how much the player is pushed on a successful stomp. */
  score: number;
  gravity: boolean;
}

/**
 * Per-kind numbers, in one table.
 *
 * A shielded enemy is stompable — its shield is on the *front*, which the contact code checks —
 * while a heavy is not stompable at all and has to be dealt with another way. Encoding that as
 * two different flags rather than one "invincible" flag is what keeps the rules readable.
 */
const SPECS: Record<EnemyKind, Spec> = {
  walker: { w: 26, h: 26, speed: 52, stompable: true, hp: 1, score: 100, gravity: true },
  jumper: { w: 26, h: 24, speed: 40, stompable: true, hp: 1, score: 150, gravity: true },
  flyer: { w: 28, h: 22, speed: 66, stompable: true, hp: 1, score: 150, gravity: false },
  charger: { w: 30, h: 26, speed: 46, stompable: true, hp: 1, score: 200, gravity: true },
  shielded: { w: 28, h: 30, speed: 44, stompable: true, hp: 1, score: 250, gravity: true },
  turret: { w: 30, h: 30, speed: 0, stompable: true, hp: 1, score: 200, gravity: true },
  heavy: { w: 36, h: 34, speed: 34, stompable: false, hp: 3, score: 350, gravity: true },
  boss: { w: 72, h: 68, speed: 78, stompable: false, hp: 6, score: 2000, gravity: true },
};

export class Enemy {
  kind: EnemyKind;
  body: Body;
  spec: Spec;
  dir: 1 | -1 = -1;
  alive = true;
  hp: number;
  /** Counts down while dying, so the death animation can play before removal. */
  dying = 0;
  /** Flashes on a hit that did not kill. */
  hitFlash = 0;
  /** Cosmetic, read by the renderer: a walk cycle phase, wing beat, or charge wind-up. */
  phase = 0;
  state: 'patrol' | 'alert' | 'charge' | 'recover' | 'attack' = 'patrol';

  private timer = 0;
  private stateTimer = 0;
  private homeX: number;
  private homeY: number;
  /** Boss only: which of three phases it is in. */
  bossPhase = 0;

  events: EnemyEvents = { fired: null, turned: false, jumped: false, charging: false };

  constructor(kind: EnemyKind, x: number, y: number) {
    this.kind = kind;
    this.spec = SPECS[kind];
    this.hp = this.spec.hp;
    this.body = makeBody(x - this.spec.w / 2, y - this.spec.h, this.spec.w, this.spec.h);
    this.homeX = this.body.x;
    this.homeY = this.body.y;
  }

  get centerX(): number { return this.body.x + this.body.w / 2; }
  get centerY(): number { return this.body.y + this.body.h / 2; }
  get stompable(): boolean { return this.spec.stompable; }
  get score(): number { return this.spec.score; }

  update(
    dt: number, map: TileMap, platforms: Platform[], playerX: number, playerY: number
  ): EnemyEvents {
    this.events = { fired: null, turned: false, jumped: false, charging: false };
    this.phase += dt;
    this.timer -= dt;
    this.stateTimer -= dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);

    if (!this.alive) {
      this.dying = Math.max(0, this.dying - dt);
      // Defeated enemies fall out of the world rather than vanishing — a body that drops is a
      // clearer confirmation of a hit than a sprite that disappears between frames.
      this.body.vy = Math.min(this.body.vy + GRAVITY * dt, MAX_FALL_SPEED);
      this.body.y += this.body.vy * dt;
      this.body.x += this.body.vx * dt;
      return this.events;
    }

    switch (this.kind) {
      case 'walker': this.updateWalker(map); break;
      case 'jumper': this.updateJumper(dt, map); break;
      case 'flyer': this.updateFlyer(dt); break;
      case 'charger': this.updateCharger(dt, map, playerX, playerY); break;
      case 'shielded': this.updateWalker(map); break;
      case 'turret': this.updateTurret(dt, playerX, playerY); break;
      case 'heavy': this.updateWalker(map); break;
      case 'boss': this.updateBoss(dt, map, playerX); break;
    }

    if (this.spec.gravity) {
      this.body.vy = Math.min(this.body.vy + GRAVITY * dt, MAX_FALL_SPEED);
      moveBody(this.body, map, dt, platforms);
      if (this.body.onWall !== 0) this.turn();
    } else {
      this.body.x += this.body.vx * dt;
      this.body.y += this.body.vy * dt;
      if (map.boxBlocked(this.body.x, this.body.y, this.body.w, this.body.h)) {
        this.body.x -= this.body.vx * dt;
        this.turn();
      }
    }
    return this.events;
  }

  /**
   * Walk, and turn at a wall or a ledge.
   *
   * The ledge probe is what separates an enemy that patrols a platform from one that marches off
   * it two seconds into the level. It looks one body-width ahead and one tile down; no ground
   * there means turn around.
   */
  private updateWalker(map: TileMap): void {
    this.body.vx = this.dir * this.spec.speed;
    const aheadX = this.dir > 0 ? this.body.x + this.body.w + 2 : this.body.x - 2;
    const footY = this.body.y + this.body.h + 4;
    if (!map.solidAtPoint(aheadX, footY) && this.body.onGround) this.turn();
  }

  private updateJumper(dt: number, map: TileMap): void {
    this.updateWalker(map);
    // Hops on a rhythm rather than reacting to the player: a predictable enemy can be timed,
    // and timing is the skill this one is here to teach.
    if (this.body.onGround && this.timer <= 0) {
      this.body.vy = -520;
      this.timer = 1.4;
      this.events.jumped = true;
    }
    void dt;
  }

  private updateFlyer(dt: number): void {
    // A slow sine through the air, anchored to where it started, so its path is legible from
    // across the screen.
    this.body.vx = this.dir * this.spec.speed;
    this.body.vy = Math.sin(this.phase * 2.1) * 90;
    if (Math.abs(this.body.x - this.homeX) > TILE * 4) this.turn();
    void dt;
  }

  /**
   * The charger: paces, notices, winds up visibly, then commits.
   *
   * The wind-up is the whole design. An enemy that accelerates the instant it sees you is
   * unfair; one that stops, leans back for a third of a second and then runs is a threat the
   * player can answer. It also overshoots and has to recover, which is the window to punish it.
   */
  private updateCharger(dt: number, map: TileMap, playerX: number, playerY: number): void {
    const dx = playerX - this.centerX;
    const sameLevel = Math.abs(playerY - this.centerY) < TILE * 2;
    const inRange = Math.abs(dx) < TILE * 7 && sameLevel;

    if (this.state === 'patrol') {
      this.updateWalker(map);
      if (inRange) {
        this.dir = (dx > 0 ? 1 : -1) as 1 | -1;
        this.state = 'alert';
        this.stateTimer = 0.36;
      }
    } else if (this.state === 'alert') {
      this.body.vx = 0;
      this.events.charging = true;
      if (this.stateTimer <= 0) { this.state = 'charge'; this.stateTimer = 1.1; }
    } else if (this.state === 'charge') {
      this.body.vx = this.dir * this.spec.speed * 4.2;
      const aheadX = this.dir > 0 ? this.body.x + this.body.w + 2 : this.body.x - 2;
      if (!map.solidAtPoint(aheadX, this.body.y + this.body.h + 4) || this.stateTimer <= 0) {
        this.state = 'recover';
        this.stateTimer = 0.7;
      }
    } else {
      this.body.vx = 0;
      if (this.stateTimer <= 0) this.state = 'patrol';
    }
    void dt;
  }

  private updateTurret(dt: number, playerX: number, playerY: number): void {
    this.body.vx = 0;
    this.dir = (playerX > this.centerX ? 1 : -1) as 1 | -1;
    const inRange = Math.abs(playerX - this.centerX) < TILE * 12
      && Math.abs(playerY - this.centerY) < TILE * 4;
    if (!inRange || this.timer > 0) return;
    this.timer = 1.9;
    // Slow and low: a projectile the player can see coming, jump over, and use as a platform of
    // sorts by timing their run around it.
    this.events.fired = {
      x: this.centerX + this.dir * 18,
      y: this.centerY - 4,
      vx: this.dir * 190,
      vy: 0,
      life: 4,
      active: true,
    };
    void dt;
  }

  /**
   * The boss: three phases, each a variation on platforming rather than a new game.
   *
   * It paces and slams (shockwave, jump over it), then paces faster and leaps (get out from
   * under it), then does both with less recovery. Its weak point is the moment after a slam,
   * when it is low enough to reach — which is a platforming problem, not a shooting one.
   */
  private updateBoss(dt: number, map: TileMap, playerX: number): void {
    this.bossPhase = this.hp > 4 ? 0 : this.hp > 2 ? 1 : 2;
    const speedMult = 1 + this.bossPhase * 0.35;

    if (this.state === 'patrol') {
      this.body.vx = this.dir * this.spec.speed * speedMult;
      const aheadX = this.dir > 0 ? this.body.x + this.body.w + 2 : this.body.x - 2;
      if (!map.solidAtPoint(aheadX, this.body.y + this.body.h + 4) && this.body.onGround) this.turn();
      if (this.timer <= 0) {
        this.dir = (playerX > this.centerX ? 1 : -1) as 1 | -1;
        this.state = 'attack';
        this.stateTimer = 0.5;
        this.timer = 3.2 - this.bossPhase * 0.6;
      }
    } else if (this.state === 'attack') {
      this.body.vx = 0;
      this.events.charging = true;
      if (this.stateTimer <= 0) {
        this.body.vy = -640;
        this.state = 'recover';
        this.stateTimer = 1.4;
        this.events.jumped = true;
      }
    } else {
      this.body.vx = this.dir * this.spec.speed * 0.5;
      if (this.body.onGround && this.stateTimer <= 0) this.state = 'patrol';
    }
    void dt;
  }

  private turn(): void {
    this.dir = (this.dir === 1 ? -1 : 1) as 1 | -1;
    this.body.vx = this.dir * this.spec.speed;
    this.events.turned = true;
  }

  /**
   * Take a hit from a direction.
   *
   * Returns 'killed', 'hurt' or 'blocked'. A shielded enemy blocks anything arriving at its
   * front; the answer is to get behind it or come down on top of it, both of which the level
   * geometry around one is always built to allow.
   */
  hit(fromX: number, fromAbove: boolean, damage = 1): 'killed' | 'hurt' | 'blocked' {
    if (!this.alive) return 'blocked';

    if (this.kind === 'shielded' && !fromAbove) {
      const front = this.centerX + this.dir * this.body.w;
      if (Math.abs(fromX - front) < Math.abs(fromX - (this.centerX - this.dir * this.body.w))) {
        return 'blocked';
      }
    }
    if (!this.spec.stompable && fromAbove && this.kind !== 'boss') return 'blocked';

    this.hp -= damage;
    if (this.hp > 0) {
      this.hitFlash = 0.2;
      // Knocked back but not killed, so a multi-hit enemy reads as taking damage.
      this.body.vx = (fromX < this.centerX ? 1 : -1) * 140;
      return 'hurt';
    }

    this.alive = false;
    this.dying = 0.8;
    this.body.vy = -260;
    this.body.vx = (fromX < this.centerX ? 1 : -1) * 90;
    return 'killed';
  }

  /** The band at the top of an enemy that counts as a stomp rather than a collision. */
  stompZone(): { x: number; y: number; w: number; h: number } {
    return { x: this.body.x, y: this.body.y - 4, w: this.body.w, h: 14 };
  }

  reset(): void {
    this.body.x = this.homeX;
    this.body.y = this.homeY;
    this.body.vx = this.body.vy = 0;
    this.alive = true;
    this.hp = this.spec.hp;
    this.dying = 0;
    this.hitFlash = 0;
    this.state = 'patrol';
    this.dir = -1;
    this.timer = this.stateTimer = 0;
  }
}

export const enemySpec = (kind: EnemyKind): Spec => SPECS[kind];
