/**
 * A level in play.
 *
 * Owns everything that exists only while a level is running — the player, the enemies, the
 * pickups, the moving platforms, the particles and the camera — and nothing that outlives it.
 * Starting a level is constructing one of these; restarting is throwing it away and building
 * another, which is why a death can respawn in a single frame with no loading screen.
 *
 * The update order is deliberate and worth stating, because platformer bugs live in it:
 * platforms move first (so a rider is carried before it is asked whether it is grounded), then
 * the player, then enemies, then collisions, then the camera. Moving the camera before the
 * player produces a view that lags one frame behind on every jump — small enough to pass a code
 * review, large enough to feel wrong.
 */

import {
  TILE, FIXED_DT, MAX_FRAME_TIME, VIEW_W, VIEW_H, MAGNET_RADIUS, POWERUP_DURATION,
  Level, LevelDef, parseLevel, starsFor, Tile,
  Player, InputState, Enemy, Projectile, Platform,
  boxesOverlap, PickupKind, PowerKind,
} from '../core/index.js';
import { Camera, Particles, SpriteCache, Backdrop, drawTerrain } from '../render/renderer.js';
import { Palette, paletteForWorld, HERO_SIZE, HeroPose } from '../render/art.js';
import { AudioManager } from '../shell/audio.js';

interface Pickup {
  kind: PickupKind; x: number; y: number; taken: boolean; secret: boolean; phase: number;
  /** Magnet pull, applied toward the player. */
  vx: number; vy: number;
}
interface PowerPickup { kind: PowerKind; x: number; y: number; taken: boolean }
interface Checkpoint { x: number; y: number; active: boolean }
interface MovingPlatform extends Platform {
  originX: number; originY: number; targetX: number; targetY: number;
  speed: number; t: number; forward: boolean;
  crumble: boolean; crumbleTimer: number; respawn: number;
}

export type SessionState = 'intro' | 'playing' | 'dying' | 'complete';

export interface SessionResult {
  stars: number;
  sparks: number;
  sparkTotal: number;
  embers: boolean;
  secret: boolean;
  timeMs: number;
  deaths: number;
}

export class Session {
  readonly level: Level;
  readonly palette: Palette;
  player: Player;
  state: SessionState = 'intro';

  enemies: Enemy[] = [];
  pickups: Pickup[] = [];
  powers: PowerPickup[] = [];
  checkpoints: Checkpoint[] = [];
  platforms: MovingPlatform[] = [];
  projectiles: Projectile[] = [];

  camera = new Camera();
  particles = new Particles();

  sparks = 0;
  embers = 0;
  secretsFound = 0;
  deaths = 0;
  elapsedMs = 0;

  /** The prompt currently on screen, and the ones already shown. */
  prompt: string | null = null;
  private promptTimer = 0;
  private shownPrompts = new Set<number>();

  /** Hit-stop: the whole simulation pauses for a few frames on a heavy impact. */
  private freeze = 0;
  private introTimer = 1.1;
  private deathTimer = 0;
  private completeTimer = 0;
  private respawn: { x: number; y: number };
  private accumulator = 0;
  private phase = 0;
  private goalLit = 0;

  constructor(def: LevelDef, private audio: AudioManager, abilities: {
    dash: boolean; doubleJump: boolean; wallJump: boolean;
  }) {
    this.level = parseLevel(def);
    this.palette = paletteForWorld(def.world);
    this.player = new Player(
      this.level.spawn.x - 11, this.level.spawn.y - 36);
    this.player.canDash = abilities.dash;
    this.player.canDoubleJump = abilities.doubleJump;
    this.player.canWallJump = abilities.wallJump;
    this.respawn = { x: this.level.spawn.x, y: this.level.spawn.y };

    for (const e of this.level.enemies) this.enemies.push(new Enemy(e.kind, e.x, e.y));
    for (const p of this.level.pickups) {
      this.pickups.push({
        kind: p.kind, x: p.x, y: p.y, taken: false, secret: Boolean(p.secret),
        phase: (p.x * 0.013 + p.y * 0.021) % (Math.PI * 2), vx: 0, vy: 0,
      });
    }
    for (const p of this.level.powers) this.powers.push({ kind: p.kind, x: p.x, y: p.y, taken: false });
    for (const c of this.level.checkpoints) this.checkpoints.push({ x: c.x, y: c.y, active: false });

    for (const def2 of this.level.platforms) {
      this.platforms.push({
        x: def2.x * TILE, y: def2.y * TILE,
        w: def2.tiles * TILE, h: TILE,
        dx: 0, dy: 0, oneWay: def2.oneWay ?? false, active: true,
        originX: def2.x * TILE, originY: def2.y * TILE,
        targetX: (def2.x + def2.dx) * TILE, targetY: (def2.y + def2.dy) * TILE,
        speed: def2.speed, t: 0, forward: true,
        crumble: def2.crumble ?? false, crumbleTimer: 0, respawn: 0,
      });
    }

    this.camera.snapTo(this.player.centerX, this.player.centerY, this.level.width, this.level.height);
  }

  get sparkTotal(): number { return this.level.sparkTotal; }
  get emberTotal(): number { return this.level.emberTotal; }

  result(): SessionResult {
    const timeMs = this.elapsedMs;
    return {
      stars: starsFor(this.level, this.sparks, this.embers, timeMs / 1000),
      sparks: this.sparks,
      sparkTotal: this.level.sparkTotal,
      embers: this.embers > 0,
      secret: this.secretsFound > 0,
      timeMs,
      deaths: this.deaths,
    };
  }

  /**
   * Advance by real elapsed time, in fixed steps.
   *
   * The accumulator is clamped: a tab that was hidden for a minute must not fast-forward the
   * player through the level when it comes back. Anything past the clamp is simply discarded.
   */
  update(dtReal: number, input: InputState): void {
    this.accumulator += Math.min(dtReal, MAX_FRAME_TIME);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 8) {
      this.step(input, FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 8) this.accumulator = 0;   // we are behind; drop the backlog rather than spiral
  }

  private step(input: InputState, dt: number): void {
    this.phase += dt;

    if (this.freeze > 0) { this.freeze -= dt; return; }

    if (this.state === 'intro') {
      this.introTimer -= dt;
      // The intro is a moment of the level on screen before control is handed over, which reads
      // as an establishing shot rather than as a delay.
      if (this.introTimer <= 0) this.state = 'playing';
      this.updatePlatforms(dt);
      this.camera.follow(this.player.centerX, this.player.centerY, 1, 0,
        this.level.width, this.level.height, dt);
      this.particles.update(dt);
      return;
    }

    if (this.state === 'dying') {
      this.deathTimer -= dt;
      this.player.update(input, this.level.map, [], dt);
      this.particles.update(dt);
      if (this.deathTimer <= 0) this.respawnPlayer();
      return;
    }

    if (this.state === 'complete') {
      this.completeTimer += dt;
      this.updatePlatforms(dt);
      this.particles.update(dt);
      this.goalLit = Math.min(1, this.goalLit + dt * 1.5);
      // A steady fountain from the beacon while the results panel comes up.
      if (Math.random() < 0.4) {
        this.particles.emit('spark', this.level.goal.x, this.level.goal.y - 40, 2, {
          color: '#ffe9a8', speed: 130, life: 1.1, size: 3, gravity: -60,
        });
      }
      return;
    }

    this.elapsedMs += dt * 1000;
    this.promptTimer = Math.max(0, this.promptTimer - dt);
    if (this.promptTimer <= 0) this.prompt = null;

    this.updatePlatforms(dt);
    const events = this.player.update(input, this.level.map, this.activePlatforms(), dt);
    this.reactToPlayer(events);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.collectPickups(dt);
    this.checkHazards();
    this.checkCheckpoints();
    this.checkPrompts();
    this.checkGoal();

    this.particles.update(dt);

    const speed = Math.abs(this.player.body.vx);
    this.camera.follow(this.player.centerX, this.player.centerY, this.player.facing, speed,
      this.level.width, this.level.height, dt);

    // Falling out of the world is a death like any other.
    if (this.player.body.y > this.level.height + 80 && this.player.alive) this.killPlayer();
  }

  // ── platforms ─────────────────────────────────────────────────────────────

  private updatePlatforms(dt: number): void {
    for (const p of this.platforms) {
      if (p.respawn > 0) {
        p.respawn -= dt;
        if (p.respawn <= 0) { p.active = true; p.crumbleTimer = 0; }
        p.dx = p.dy = 0;
        continue;
      }
      if (p.crumbleTimer > 0) {
        p.crumbleTimer -= dt;
        if (p.crumbleTimer <= 0) {
          p.active = false;
          p.respawn = 2.4;
          this.particles.emit('shard', p.x + p.w / 2, p.y + p.h / 2, 10, {
            color: this.palette.platform, speed: 120, life: 0.8, size: 4, gravity: 700,
          });
          this.audio.play('break');
          continue;
        }
      }

      const dist = Math.hypot(p.targetX - p.originX, p.targetY - p.originY);
      if (dist < 1) { p.dx = p.dy = 0; continue; }
      p.t += (p.forward ? 1 : -1) * (p.speed / dist) * dt;
      if (p.t >= 1) { p.t = 1; p.forward = false; }
      if (p.t <= 0) { p.t = 0; p.forward = true; }
      const nx = p.originX + (p.targetX - p.originX) * p.t;
      const ny = p.originY + (p.targetY - p.originY) * p.t;
      p.dx = nx - p.x;
      p.dy = ny - p.y;
      p.x = nx;
      p.y = ny;
    }
  }

  private activePlatforms(): Platform[] {
    return this.platforms.filter((p) => p.active);
  }

  // ── player reactions ──────────────────────────────────────────────────────

  private reactToPlayer(events: ReturnType<Player['update']>): void {
    const p = this.player;
    const feetX = p.centerX, feetY = p.body.y + p.body.h;

    if (events.jumped || events.doubleJumped || events.wallJumped) {
      this.audio.play(events.doubleJumped ? 'doubleJump' : 'jump');
      this.particles.emit('dust', feetX, feetY, 6, {
        color: 'rgba(255,255,255,0.55)', speed: 70, life: 0.34, size: 3,
        gravity: 120, dir: -Math.PI / 2, spread: Math.PI * 1.3,
      });
    }
    if (events.landed > 220) {
      this.audio.play('land');
      const force = Math.min(1, events.landed / 900);
      this.particles.emit('dust', feetX, feetY, Math.round(4 + force * 8), {
        color: 'rgba(255,255,255,0.5)', speed: 60 + force * 120, life: 0.4,
        size: 3, gravity: 240, dir: -Math.PI / 2, spread: Math.PI,
      });
      if (force > 0.65) this.camera.shake(3 * force, 0.14);
    }
    if (events.footstep) {
      this.audio.play('step');
      this.particles.emit('dust', feetX - p.facing * 6, feetY, 1, {
        color: 'rgba(255,255,255,0.35)', speed: 34, life: 0.28, size: 2.4, gravity: 90,
      });
    }
    if (events.dashed) {
      this.audio.play('dash');
      this.camera.shake(2.4, 0.12);
      this.particles.emit('trail', p.centerX, p.centerY, 10, {
        color: this.palette.glow, speed: 140, life: 0.32, size: 4, gravity: 0,
        dir: p.facing > 0 ? Math.PI : 0, spread: 0.7,
      });
    }
    // A speed trail while dashing or boosted, which is what sells the extra velocity.
    if (p.state === 'dash' || (p.isActive('speed') && Math.abs(p.body.vx) > 250)) {
      if (Math.random() < 0.6) {
        this.particles.emit('trail', p.centerX, p.centerY, 1, {
          color: this.palette.glow, speed: 12, life: 0.26, size: 5, gravity: 0,
        });
      }
    }
  }

  // ── enemies ───────────────────────────────────────────────────────────────

  private updateEnemies(dt: number): void {
    const p = this.player;
    for (const enemy of this.enemies) {
      // Culled well outside the view: an enemy four screens away does not need to pace.
      if (Math.abs(enemy.centerX - p.centerX) > VIEW_W * 1.4) continue;

      const events = enemy.update(dt, this.level.map, this.activePlatforms(), p.centerX, p.centerY);
      if (events.fired) { this.projectiles.push(events.fired); this.audio.play('shoot'); }

      if (!enemy.alive) continue;
      if (!boxesOverlap(
        p.body.x, p.body.y, p.body.w, p.body.h,
        enemy.body.x, enemy.body.y, enemy.body.w, enemy.body.h)) continue;

      /**
       * Stomp or damage, decided by geometry and by which way the player is moving.
       *
       * Both conditions are needed. Position alone lets a player who jumps up into an enemy's
       * underside count as a stomp; velocity alone lets someone walking into its side at head
       * height count. Requiring the player to be above it *and* descending is what makes the
       * rule feel consistent, which is the thing the brief asks for and the thing players
       * complain about when it is missing.
       */
      const zone = enemy.stompZone();
      const fromAbove = p.body.vy > 0
        && p.body.y + p.body.h <= zone.y + zone.h + 6
        && boxesOverlap(p.body.x, p.body.y, p.body.w, p.body.h, zone.x, zone.y, zone.w, zone.h);

      const invincible = p.isActive('invincible');
      const dashing = p.state === 'dash';

      if (fromAbove || invincible || dashing) {
        const outcome = enemy.hit(p.centerX, fromAbove, enemy.kind === 'boss' ? 1 : 3);
        if (outcome === 'blocked') {
          if (!invincible && !dashing) this.hurtPlayer(enemy.centerX);
          continue;
        }
        if (fromAbove) p.bounce(true);
        if (outcome === 'killed') {
          this.audio.play(enemy.kind === 'boss' ? 'bossHit' : 'stomp');
          this.camera.shake(enemy.kind === 'boss' ? 6 : 3, 0.16);
          this.freeze = 0.055;                    // hit-stop, the cheapest impact there is
          this.particles.emit('burst', enemy.centerX, enemy.centerY, 14, {
            color: this.palette.glow, speed: 190, life: 0.5, size: 4, gravity: 260,
          });
          this.particles.emit('ring', enemy.centerX, enemy.centerY, 1, {
            color: '#ffffff', speed: 0, life: 0.32, size: 10, gravity: 0,
          });
        } else {
          this.audio.play('bossHit');
          this.camera.shake(2.5, 0.1);
        }
        continue;
      }

      this.hurtPlayer(enemy.centerX);
    }

    // Clear away anything that has finished dying and fallen out of sight.
    this.enemies = this.enemies.filter(
      (e) => e.alive || e.body.y < this.level.height + 200);
  }

  private updateProjectiles(dt: number): void {
    const p = this.player;
    for (const shot of this.projectiles) {
      if (!shot.active) continue;
      shot.life -= dt;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      if (shot.life <= 0 || this.level.map.solidAtPoint(shot.x, shot.y)) {
        shot.active = false;
        this.particles.emit('burst', shot.x, shot.y, 5, {
          color: '#ffcf7a', speed: 90, life: 0.3, size: 2.5, gravity: 120,
        });
        continue;
      }
      if (boxesOverlap(p.body.x, p.body.y, p.body.w, p.body.h, shot.x - 6, shot.y - 6, 12, 12)) {
        shot.active = false;
        if (!p.isActive('invincible')) this.hurtPlayer(shot.x);
      }
    }
    if (this.projectiles.length > 24) this.projectiles = this.projectiles.filter((s) => s.active);
  }

  // ── pickups ───────────────────────────────────────────────────────────────

  private collectPickups(dt: number): void {
    const p = this.player;
    const magnet = p.isActive('magnet');

    for (const item of this.pickups) {
      if (item.taken) continue;
      item.phase += dt;

      if (magnet) {
        const dx = p.centerX - item.x, dy = p.centerY - item.y;
        const dist = Math.hypot(dx, dy);
        if (dist < MAGNET_RADIUS && dist > 1) {
          const pull = (1 - dist / MAGNET_RADIUS) * 900;
          item.vx += (dx / dist) * pull * dt;
          item.vy += (dy / dist) * pull * dt;
        }
      }
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      item.vx *= 1 - Math.min(1, 2 * dt);
      item.vy *= 1 - Math.min(1, 2 * dt);

      const size = item.kind === 'emberstone' ? 26 : 18;
      if (!boxesOverlap(p.body.x, p.body.y, p.body.w, p.body.h,
        item.x - size / 2, item.y - size / 2, size, size)) continue;

      item.taken = true;
      if (item.kind === 'spark') {
        this.sparks++;
        if (item.secret) { this.secretsFound++; this.audio.play('secret'); }
        else this.audio.play('coin');
        this.particles.emit('spark', item.x, item.y, item.secret ? 12 : 6, {
          color: this.palette.glow, speed: 120, life: 0.45, size: 3, gravity: -40,
        });
      } else if (item.kind === 'emberstone') {
        this.embers++;
        this.audio.play('gem');
        this.camera.shake(2, 0.2);
        this.particles.emit('burst', item.x, item.y, 20, {
          color: '#ff7ad1', speed: 200, life: 0.7, size: 4, gravity: 120,
        });
        this.particles.emit('ring', item.x, item.y, 1, {
          color: '#ffb0e8', speed: 0, life: 0.5, size: 14, gravity: 0,
        });
      } else {
        p.health = Math.min(3, p.health + 1);
        this.audio.play('power');
        this.particles.emit('burst', item.x, item.y, 10, {
          color: '#ff6a8a', speed: 130, life: 0.5, size: 3.5, gravity: 60,
        });
      }
    }

    for (const power of this.powers) {
      if (power.taken) continue;
      if (!boxesOverlap(p.body.x, p.body.y, p.body.w, p.body.h,
        power.x - 14, power.y - 14, 28, 28)) continue;
      power.taken = true;
      p.grantPower(power.kind, POWERUP_DURATION);
      this.audio.play('power');
      this.camera.shake(2.5, 0.2);
      this.particles.emit('burst', power.x, power.y, 18, {
        color: this.palette.glow, speed: 180, life: 0.6, size: 4, gravity: 40,
      });
      this.particles.emit('ring', power.x, power.y, 1, {
        color: '#ffffff', speed: 0, life: 0.4, size: 12, gravity: 0,
      });
    }
  }

  // ── hazards, checkpoints, goal ────────────────────────────────────────────

  private checkHazards(): void {
    const p = this.player;
    if (!p.alive || p.invulnerable) return;
    // Inset the probe box, so brushing the very corner of a spike is not a hit. Forgiveness at
    // the pixel level is invisible and is the difference between "unfair" and "my fault".
    const touched = this.level.map.tilesIn(
      p.body.x + 4, p.body.y + 4, p.body.w - 8, p.body.h - 6);
    if (touched.includes(Tile.Spike)) this.hurtPlayer(p.centerX, true);
    else if (touched.includes(Tile.Liquid)) this.killPlayer();
  }

  private checkCheckpoints(): void {
    const p = this.player;
    for (const c of this.checkpoints) {
      if (c.active) continue;
      if (Math.abs(c.x - p.centerX) > 26 || Math.abs(c.y - (p.body.y + p.body.h)) > 40) continue;
      c.active = true;
      this.respawn = { x: c.x, y: c.y };
      this.audio.play('checkpoint');
      this.particles.emit('spark', c.x, c.y - 30, 14, {
        color: '#ffe9a8', speed: 130, life: 0.7, size: 3, gravity: -90,
      });
    }
  }

  private checkPrompts(): void {
    const prompts = this.level.def.prompts;
    if (!prompts) return;
    for (const [i, prompt] of prompts.entries()) {
      if (this.shownPrompts.has(i)) continue;
      if (this.player.centerX < prompt.x) continue;
      this.shownPrompts.add(i);
      this.prompt = prompt.text;
      this.promptTimer = 2.6;
    }
  }

  private checkGoal(): void {
    const p = this.player;
    const dx = Math.abs(p.centerX - this.level.goal.x);
    const dy = Math.abs((p.body.y + p.body.h) - this.level.goal.y);
    // The beacon brightens as the player approaches, well before they arrive.
    this.goalLit = Math.max(this.goalLit, Math.max(0, 1 - dx / (TILE * 8)) * 0.7);
    if (dx > 26 || dy > 48) return;

    this.state = 'complete';
    this.completeTimer = 0;
    this.audio.play('complete');
    this.camera.shake(4, 0.4);
    this.particles.emit('burst', this.level.goal.x, this.level.goal.y - 40, 40, {
      color: '#ffe9a8', speed: 260, life: 1.2, size: 4, gravity: 90,
    });
  }

  private hurtPlayer(fromX: number, fromHazard = false): void {
    const p = this.player;
    const before = p.health;
    if (!p.takeHit(fromX)) {
      // Absorbed by a shield: still worth a sound and a flash, or the player will not know.
      this.audio.play('power');
      this.particles.emit('ring', p.centerX, p.centerY, 1, {
        color: '#5ad6ff', speed: 0, life: 0.4, size: 14, gravity: 0,
      });
      return;
    }
    this.audio.play(p.alive ? 'hurt' : 'die');
    this.camera.shake(5, 0.26);
    this.freeze = 0.07;
    this.particles.emit('burst', p.centerX, p.centerY, 12, {
      color: '#ff6a5a', speed: 160, life: 0.5, size: 3.5, gravity: 200,
    });
    if (!p.alive) this.beginDeath();
    void before; void fromHazard;
  }

  private killPlayer(): void {
    if (!this.player.alive) return;
    this.player.health = 0;
    this.player.kill();
    this.audio.play('die');
    this.camera.shake(5, 0.3);
    this.beginDeath();
  }

  private beginDeath(): void {
    this.state = 'dying';
    this.deathTimer = 0.95;
    this.deaths++;
    this.particles.emit('burst', this.player.centerX, this.player.centerY, 22, {
      color: this.palette.glow, speed: 200, life: 0.8, size: 4, gravity: 320,
    });
  }

  /**
   * Respawn at the last checkpoint.
   *
   * Fast and total: the player is restored, the enemies near the checkpoint are put back, and
   * play resumes. Nothing fades, nothing loads, and no menu appears — a platformer's retry loop
   * has to be short enough that dying is information rather than punishment.
   */
  private respawnPlayer(): void {
    this.player.reset(this.respawn.x - 11, this.respawn.y - 36);
    this.player.canDash = this.player.canDash;
    for (const enemy of this.enemies) enemy.reset();
    this.projectiles = [];
    this.state = 'playing';
    this.camera.snapTo(this.player.centerX, this.player.centerY,
      this.level.width, this.level.height);
    this.particles.emit('spark', this.player.centerX, this.player.centerY, 12, {
      color: this.palette.glow, speed: 130, life: 0.5, size: 3, gravity: -50,
    });
  }

  /** Restart the level from the beginning, keeping nothing. */
  restartFromStart(): void {
    this.respawn = { x: this.level.spawn.x, y: this.level.spawn.y };
    for (const c of this.checkpoints) c.active = false;
    for (const item of this.pickups) item.taken = false;
    for (const power of this.powers) power.taken = false;
    this.sparks = this.embers = this.secretsFound = 0;
    this.elapsedMs = 0;
    this.goalLit = 0;
    this.particles.clear();
    this.respawnPlayer();
    this.state = 'intro';
    this.introTimer = 0.6;
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  /**
   * Draw a frame.
   *
   * Everything is offset by the camera and culled to the view. The order is backdrop, terrain,
   * entities, player, particles, foreground tint — with the player drawn *after* the enemies so
   * they can never hide behind one at the moment it matters.
   */
  draw(
    ctx: CanvasRenderingContext2D, cache: SpriteCache, backdrop: Backdrop, quality: 'low' | 'high'
  ): void {
    const camX = Math.round(this.camera.x + this.camera.offsetX);
    const camY = Math.round(this.camera.y + this.camera.offsetY);

    backdrop.draw(ctx, camX, camY, this.palette);
    drawTerrain(ctx, this.level.map, cache, this.palette, camX, camY);

    // Moving platforms.
    for (const p of this.platforms) {
      if (!p.active) continue;
      const x = Math.round(p.x - camX), y = Math.round(p.y - camY);
      if (x < -160 || x > VIEW_W + 160) continue;
      const shaking = p.crumbleTimer > 0 ? (Math.random() - 0.5) * 2.5 : 0;
      const grad = ctx.createLinearGradient(0, y, 0, y + p.h);
      grad.addColorStop(0, this.palette.platformEdge);
      grad.addColorStop(1, this.palette.platform);
      ctx.fillStyle = grad;
      ctx.fillRect(x + shaking, y, p.w, p.h);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x + shaking, y + p.h - 3, p.w, 3);
      // Rivets, so a lift reads as built rather than as a coloured rectangle.
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      for (let i = 0; i < p.w; i += TILE) ctx.fillRect(x + i + 6 + shaking, y + 4, 3, 3);
    }

    // Checkpoints, then goal.
    for (const c of this.checkpoints) {
      const x = Math.round(c.x - camX), y = Math.round(c.y - camY);
      if (x < -80 || x > VIEW_W + 80) continue;
      const sprite = cache.checkpoint(24, 56, this.palette,
        Math.floor(this.phase * 6) % 8, c.active);
      ctx.drawImage(sprite, x - 12, y - 56, 24, 56);
    }
    {
      const x = Math.round(this.level.goal.x - camX), y = Math.round(this.level.goal.y - camY);
      if (x > -140 && x < VIEW_W + 140) {
        const sprite = cache.beacon(40, 96, this.palette,
          Math.floor(this.phase * 6) % 8, Math.round(this.goalLit * 4));
        ctx.drawImage(sprite, x - 40, y - 96, 80, 96);
      }
    }

    // Pickups.
    for (const item of this.pickups) {
      if (item.taken) continue;
      const x = Math.round(item.x - camX), y = Math.round(item.y - camY);
      if (x < -40 || x > VIEW_W + 40 || y < -40 || y > VIEW_H + 40) continue;
      const step = Math.floor(item.phase * 6) % 8;
      if (item.kind === 'emberstone') {
        ctx.drawImage(cache.ember(30, step), x - 15, y - 15, 30, 30);
      } else if (item.kind === 'heart') {
        ctx.drawImage(cache.power('shield', 24, step), x - 12, y - 12, 24, 24);
      } else {
        const bob = Math.sin(item.phase * 2.4) * 2;
        ctx.drawImage(cache.spark(20, step, this.palette.glow), x - 10, y - 10 + bob, 20, 20);
      }
    }
    for (const power of this.powers) {
      if (power.taken) continue;
      const x = Math.round(power.x - camX), y = Math.round(power.y - camY);
      if (x < -40 || x > VIEW_W + 40) continue;
      ctx.drawImage(cache.power(power.kind, 30, Math.floor(this.phase * 6) % 8),
        x - 15, y - 15, 30, 30);
    }

    // Projectiles.
    for (const shot of this.projectiles) {
      if (!shot.active) continue;
      const x = Math.round(shot.x - camX), y = Math.round(shot.y - camY);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(x, y, 0, x, y, 11);
      g.addColorStop(0, '#fff0c0');
      g.addColorStop(1, 'rgba(255,150,60,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 12, y - 12, 24, 24);
      ctx.restore();
      ctx.fillStyle = '#ffcf7a';
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Enemies.
    for (const enemy of this.enemies) {
      const x = Math.round(enemy.body.x - camX), y = Math.round(enemy.body.y - camY);
      if (x < -120 || x > VIEW_W + 120) continue;
      const alert = enemy.state === 'alert' || enemy.state === 'charge' || enemy.hitFlash > 0;
      const sprite = cache.enemy(enemy.kind, enemy.body.w, enemy.body.h, this.palette,
        Math.floor(enemy.phase * 8) % 8, alert);
      ctx.save();
      if (!enemy.alive) {
        ctx.globalAlpha = Math.max(0, enemy.dying / 0.8);
        ctx.translate(x + enemy.body.w / 2, y + enemy.body.h / 2);
        ctx.rotate((0.8 - enemy.dying) * 3);
        ctx.translate(-enemy.body.w / 2, -enemy.body.h / 2);
        ctx.drawImage(sprite, 0, 0);
      } else {
        // Enemies face the way they move: mirrored around their own centre.
        if (enemy.dir > 0) {
          ctx.translate(x + enemy.body.w, y);
          ctx.scale(-1, 1);
          ctx.drawImage(sprite, 0, 0);
        } else {
          ctx.drawImage(sprite, x, y);
        }
      }
      ctx.restore();
    }

    this.drawPlayer(ctx, cache, camX, camY);
    this.particles.draw(ctx, camX, camY);

    if (quality === 'high') this.drawAtmosphere(ctx, camX, camY);
  }

  private drawPlayer(
    ctx: CanvasRenderingContext2D, cache: SpriteCache, camX: number, camY: number
  ): void {
    const p = this.player;
    // Blink while invulnerable — but never fully invisible, or the player loses track of
    // themselves at exactly the moment they need to recover.
    if (p.invulnerable && !p.isActive('invincible') && Math.floor(this.phase * 22) % 2 === 0) {
      ctx.globalAlpha = 0.45;
    }

    const pose = this.posefor(p.state);
    const sprite = cache.hero(pose, this.palette, Math.floor(this.phase * 7) % 8);
    const x = Math.round(p.centerX - camX);
    const y = Math.round(p.body.y + p.body.h - camY);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(p.facing * p.squashX, p.squashY);
    // An invincible player is outlined in light rather than tinted, which keeps them readable.
    if (p.isActive('invincible')) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 + Math.sin(this.phase * 14) * 0.2;
      ctx.drawImage(sprite, -HERO_SIZE.w / 2 - 2, -HERO_SIZE.h - 2, HERO_SIZE.w + 4, HERO_SIZE.h + 4);
      ctx.restore();
    }
    ctx.drawImage(sprite, -HERO_SIZE.w / 2, -HERO_SIZE.h);
    ctx.restore();
    ctx.globalAlpha = 1;

    // A shield reads as a bubble around the character rather than as an icon on the HUD.
    if (p.isActive('shield')) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(120, 214, 255, 0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y - HERO_SIZE.h / 2, 26 + Math.sin(this.phase * 4) * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private posefor(state: string): HeroPose {
    switch (state) {
      case 'run': {
        const frame = Math.floor(this.phase * 13) % 4;
        return (['run1', 'run2', 'run3', 'run4'] as HeroPose[])[frame];
      }
      case 'jump': return 'jump';
      case 'fall': return 'fall';
      case 'land': return 'land';
      case 'turn': return 'turn';
      case 'dash': return 'dash';
      case 'hurt': case 'dead': return 'hurt';
      case 'wallSlide': return 'wallSlide';
      default: return this.state === 'complete' ? 'victory' : 'idle';
    }
  }

  /** Drifting motes and a vignette — cheap, and what stops the air looking empty. */
  private drawAtmosphere(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    ctx.save();
    ctx.fillStyle = this.palette.mote;
    for (let i = 0; i < 26; i++) {
      const seed = i * 9301;
      const speed = 0.15 + (i % 5) * 0.05;
      const x = ((seed % VIEW_W) + this.phase * 14 * speed - camX * speed * 0.5) % VIEW_W;
      const y = (((seed * 7) % VIEW_H) + Math.sin(this.phase * 0.6 + i) * 22 - camY * speed * 0.3)
        % VIEW_H;
      ctx.globalAlpha = 0.14 + (i % 3) * 0.06;
      ctx.beginPath();
      ctx.arc(x < 0 ? x + VIEW_W : x, y < 0 ? y + VIEW_H : y, 1.4 + (i % 3) * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const vignette = ctx.createRadialGradient(
      VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.4, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.95);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.34)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  /** Fade applied over the whole frame during the intro and death beats. */
  get overlayAlpha(): number {
    if (this.state === 'intro') return Math.max(0, this.introTimer / 1.1) * 0.8;
    if (this.state === 'dying') return Math.max(0, 1 - this.deathTimer / 0.95) * 0.55;
    return 0;
  }

  get completeElapsed(): number { return this.completeTimer; }
  get goalLitAmount(): number { return this.goalLit; }
}
