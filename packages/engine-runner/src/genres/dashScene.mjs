/**
 * rhythm_dash runtime.
 *
 * The defining feel of this genre is the ABSENCE of interface. There is no level select, no
 * death screen and no confirmation between attempts: you die, and you are already running
 * again a third of a second later. Every frame spent on a menu is a frame the player did not
 * spend learning the layout, so the only chrome here is an attempt counter and a completion
 * bar. Finishing a level drops straight into the next one.
 *
 * Physics is integrated rather than closed-form, because the input is a hold rather than a
 * tap: holding queues the next jump the instant the cube lands, so the trajectory is a chain
 * of arcs whose start times the player controls. The generator's solver models exactly this
 * (jump only while grounded, fixed impulse) so what it proves is what the player experiences.
 */

import Phaser from 'phaser';
import { VIEW_W, VIEW_H, FONT_DISPLAY, FONT_BODY } from '../constants.mjs';
import { asInt, shade } from '../textures.mjs';
import { sfx, unlock as unlockAudio } from '../audio.mjs';
import * as save from '../save.mjs';
import { telemetry } from '../telemetry.mjs';

/** Cube's fixed screen position. Far enough right to read what is coming. */
const PLAYER_X = 150;
/** Pause between dying and running again. Long enough to register, short enough to stay in flow. */
const RESTART_MS = 420;

export default class PlayDash extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init(data) {
    this.cfg = this.registry.get('cfg');
    this.levelIndex = Math.min(this.cfg.levels.length, Math.max(1, data.level ?? 1));
    // Attempts persist across deaths on the same level; that number is the whole scoreboard.
    this.attempts = data.attempts ?? 1;
  }

  create() {
    const cfg = this.cfg;
    const pal = cfg.theme.palette;
    this.level = cfg.levels[this.levelIndex - 1];
    this.pal = pal;

    this.groundTop = this.level.groundTop;
    this.ceil = this.level.ceilingHeight || 0;
    this.bodySize = cfg.player.size * cfg.player.hitboxScale;

    this.dist = 0;
    this.elapsed = 0;
    this.dead = false;
    this.finished = false;
    this.paused = false;
    this.holding = false;
    this.grounded = true;
    this.vy = 0;
    this.feetY = this.groundTop;
    this.spin = 0;

    this.cameras.main.setBackgroundColor(pal.bg);
    this.buildBackground();
    this.gfx = this.add.graphics();
    this.player = this.add.image(PLAYER_X, this.feetY, 'cube').setOrigin(0.5, 1);

    this.dust = this.add.particles(0, 0, 'dot', {
      speed: { min: 30, max: 110 }, lifespan: 300,
      scale: { start: 0.7, end: 0 }, alpha: { start: 0.6, end: 0 },
      quantity: 3, emitting: false, tint: asInt(pal.accent),
    });

    this.buildHud();
    this.bindInput();

    telemetry.levelAttempt(this.levelIndex);
    // No countdown: this genre restarts constantly, and a 3-2-1 before every attempt would
    // be maddening. A short run-in of empty ground does the same job.
    this.running = true;
  }

  // ── presentation ─────────────────────────────────────────────────────────

  buildBackground() {
    const pal = this.pal;
    const cfg = this.cfg;
    this.layers = [];
    if (cfg.world.showGrid) {
      this.grid = this.add.tileSprite(0, 0, VIEW_W, VIEW_H, 'grid').setOrigin(0).setAlpha(0.5);
    }
    if (cfg.world.parallax >= 1) {
      this.layers.push({
        s: this.add.tileSprite(0, this.groundTop, VIEW_W, VIEW_H * 0.4, 'par_far').setOrigin(0, 1).setAlpha(0.45),
        f: 0.2,
      });
    }
    if (cfg.world.parallax >= 2) {
      this.layers.push({
        s: this.add.tileSprite(0, this.groundTop, VIEW_W, VIEW_H * 0.26, 'par_near').setOrigin(0, 1).setAlpha(0.7),
        f: 0.45,
      });
    }
    this.ground = this.add.tileSprite(0, this.groundTop, VIEW_W, VIEW_H - this.groundTop, 'ground').setOrigin(0, 0);
    if (this.ceil > 0) {
      this.ceilBand = this.add.tileSprite(0, 0, VIEW_W, this.ceil, 'ground').setOrigin(0, 0).setFlipY(true);
    }
  }

  buildHud() {
    const pal = this.pal;
    this.hudBar = this.add.graphics().setDepth(50);
    this.hudPct = this.add
      .text(VIEW_W / 2, 26, '0%', { fontFamily: FONT_DISPLAY, fontSize: '17px', color: pal.text })
      .setOrigin(0.5)
      .setDepth(51);
    this.hudLevel = this.add
      .text(16, 16, `LV ${this.levelIndex}  ${String(this.level.name).toUpperCase()}`, {
        fontFamily: FONT_DISPLAY, fontSize: '13px', color: pal.text,
      })
      .setAlpha(0.75)
      .setDepth(51);
    this.hudAttempt = this.add
      .text(VIEW_W - 16, 16, `ATTEMPT ${this.attempts}`, {
        fontFamily: FONT_BODY, fontSize: '14px', color: pal.accent,
      })
      .setOrigin(1, 0)
      .setDepth(51);

    if (this.levelIndex === 1 && this.attempts === 1) {
      this.hint = this.add
        .text(VIEW_W / 2, this.groundTop - 90, 'HOLD TO JUMP', {
          fontFamily: FONT_BODY, fontSize: '15px', color: pal.text,
        })
        .setOrigin(0.5)
        .setAlpha(0.6)
        .setDepth(51);
    }
    // Only offered after real frustration — an always-visible skip cheapens the genre.
    this.bestPct = 0;
  }

  bindInput() {
    const down = () => {
      unlockAudio();
      this.holding = true;
      this.tryJump();
    };
    const up = () => { this.holding = false; };

    this.input.on('pointerdown', down);
    this.input.on('pointerup', up);
    this.input.keyboard?.on('keydown-SPACE', down);
    this.input.keyboard?.on('keyup-SPACE', up);
    this.input.keyboard?.on('keydown-UP', down);
    this.input.keyboard?.on('keyup-UP', up);
    this.input.keyboard?.on('keydown-ESC', () => this.quit());
  }

  quit() {
    // The only way out mid-level. Board-style menus do not belong here.
    this.scene.start('Result', {
      outcome: 'lose', mode: 'level', level: this.levelIndex,
      score: Math.round((this.dist / this.level.lengthPx) * 100), target: 100,
      unit: '%', deaths: this.attempts, cause: 'quit',
    });
  }

  tryJump() {
    if (this.dead || this.finished || !this.grounded) return;
    this.vy = this.cfg.player.jumpVelocity * (this.padUnder() ? 1.5 : 1);
    this.grounded = false;
    sfx.jump();
    this.dust.emitParticleAt(PLAYER_X, this.feetY - 2, 4);
    if (this.hint?.alpha > 0) this.tweens.add({ targets: this.hint, alpha: 0, duration: 350 });
  }

  padUnder() {
    const x = this.dist;
    return this.level.pads.some((p) => x + this.bodySize > p.x && x < p.x + p.w);
  }

  // ── simulation ───────────────────────────────────────────────────────────

  /** Highest standable surface under the cube at world x, or null over a hole. */
  surfaceAt(x) {
    let top = null;
    const overGap = this.level.gaps.some((g) => x + this.bodySize > g.x + 2 && x < g.x + g.w - 2);
    if (!overGap) top = this.groundTop;
    for (const p of this.level.platforms) {
      if (x + this.bodySize > p.x && x < p.x + p.w) {
        const pt = this.groundTop - p.h;
        if (top === null || pt < top) top = pt;
      }
    }
    return top;
  }

  hits(x, feetY) {
    const x1 = x;
    const x2 = x + this.bodySize;
    const top = feetY - this.bodySize;
    for (const o of this.level.obstacles) {
      if (x2 <= o.x || x1 >= o.x + o.w) continue;
      if (o.kind === 'ceil') {
        if (top < this.ceil + o.h) return true;
        continue;
      }
      if (feetY > this.groundTop - o.h + 1) return true;
    }
    return false;
  }

  /**
   * FIXED-TIMESTEP loop.
   *
   * Not a nicety. The generator proves each level solvable by integrating at `level.simDt`,
   * and that proof only describes this game if the game integrates identically — Euler error
   * scales with dt, so stepping at raw frame time makes the trajectories diverge and the
   * proof worthless. It also means a memorised layout behaves the same at 60 Hz and 144 Hz,
   * which this genre requires anyway.
   */
  update(_t, deltaMs) {
    if (this.paused || this.dead || this.finished || !this.running) return;
    const dt = this.level.simDt ?? 1 / 120;
    // Clamp the catch-up so a stall cannot teleport the cube through a spike.
    this.acc = (this.acc ?? 0) + Math.min(deltaMs, 100) / 1000;
    let guard = 0;
    while (this.acc >= dt && !this.dead && !this.finished && guard++ < 12) {
      this.acc -= dt;
      this.stepSim(dt);
    }
    if (this.dead || this.finished) return;
    this.player.y = this.feetY;
    this.player.setRotation(this.spin);
    this.drawWorld();
    this.updateHud();
    if (this.dist >= this.level.lengthPx) this.win();
  }

  stepSim(dt) {
    this.elapsed += dt;
    const speed = this.level.speed;
    const advance = speed * dt;
    this.dist += advance;

    // scroll
    this.ground.tilePositionX += advance;
    if (this.ceilBand) this.ceilBand.tilePositionX += advance;
    if (this.grid) this.grid.tilePositionX += advance * 0.6;
    for (const l of this.layers) l.s.tilePositionX += advance * l.f;

    // vertical
    if (!this.grounded) {
      this.vy += this.cfg.player.gravity * dt;
      this.feetY += this.vy * dt;
      this.spin += (this.cfg.player.rotationPerJump / 100) * dt * 6;

      if (this.ceil > 0 && this.feetY - this.bodySize < this.ceil) {
        this.feetY = this.ceil + this.bodySize;
        this.vy = Math.max(0, this.vy);
      }
      const surface = this.surfaceAt(this.dist);
      if (this.vy > 0 && surface !== null && this.feetY >= surface) {
        this.feetY = surface;
        this.grounded = true;
        this.vy = 0;
        // snap the spin to a quarter turn so the cube always rests square
        this.spin = Math.round(this.spin / (Math.PI / 2)) * (Math.PI / 2);
        sfx.land();
        // Holding through a landing queues the next jump immediately — that chaining is
        // what makes long spike runs feel possible rather than pixel-perfect.
        if (this.holding) this.tryJump();
      }
      if (this.feetY > VIEW_H + 160) return this.die('fell');
    } else {
      const surface = this.surfaceAt(this.dist);
      if (surface === null) {
        this.grounded = false; // walked off into a hole
        this.vy = 0;
      } else {
        this.feetY = surface;
      }
    }

    if (this.hits(this.dist, this.feetY)) return this.die('hit');
    // Rendering and win-checking happen once per frame in update(), not per sub-step.
  }

  drawWorld() {
    const g = this.gfx;
    const pal = this.pal;
    g.clear();
    const sx = (wx) => PLAYER_X + (wx - this.dist);

    // gaps: cut the ground away
    g.fillStyle(asInt(pal.bg), 1);
    for (const gp of this.level.gaps) {
      const x = sx(gp.x);
      if (x > VIEW_W + 60 || x + gp.w < -60) continue;
      g.fillRect(x, this.groundTop, gp.w, VIEW_H - this.groundTop);
    }

    // platforms
    for (const p of this.level.platforms) {
      const x = sx(p.x);
      if (x > VIEW_W + 80 || x + p.w < -80) continue;
      const y = this.groundTop - p.h;
      g.fillStyle(shade(pal.ground, 0.18), 1);
      g.fillRect(x, y, p.w, p.h);
      g.fillStyle(asInt(pal.accent), 1);
      g.fillRect(x, y, p.w, 4);
    }

    // pads
    for (const p of this.level.pads) {
      const x = sx(p.x);
      if (x > VIEW_W + 40 || x + p.w < -40) continue;
      g.fillStyle(asInt(pal.accent), 1);
      g.fillTriangle(x, this.groundTop, x + p.w / 2, this.groundTop - 16, x + p.w, this.groundTop);
    }

    // hazards
    for (const o of this.level.obstacles) {
      const x = sx(o.x);
      if (x > VIEW_W + 70 || x + o.w < -70) continue;
      if (o.kind === 'spike') {
        g.fillStyle(shade(pal.obstacle, -0.35), 1);
        g.fillTriangle(x - 1, this.groundTop, x + o.w / 2, this.groundTop - o.h - 1, x + o.w + 1, this.groundTop);
        g.fillStyle(asInt(pal.obstacle), 1);
        g.fillTriangle(x + 2, this.groundTop, x + o.w / 2, this.groundTop - o.h + 3, x + o.w - 2, this.groundTop);
      } else if (o.kind === 'block') {
        g.fillStyle(shade(pal.obstacle, -0.4), 1);
        g.fillRect(x, this.groundTop - o.h, o.w, o.h);
        g.fillStyle(asInt(pal.obstacle), 1);
        g.fillRect(x + 2, this.groundTop - o.h + 2, o.w - 4, o.h - 4);
      } else if (o.kind === 'ceil') {
        g.fillStyle(shade(pal.obstacle, -0.35), 1);
        g.fillTriangle(x - 1, this.ceil, x + o.w / 2, this.ceil + o.h + 1, x + o.w + 1, this.ceil);
        g.fillStyle(asInt(pal.obstacle), 1);
        g.fillTriangle(x + 2, this.ceil, x + o.w / 2, this.ceil + o.h - 3, x + o.w - 2, this.ceil);
      }
    }
  }

  updateHud() {
    const pct = Math.min(100, Math.round((this.dist / this.level.lengthPx) * 100));
    this.hudPct.setText(`${pct}%`);
    this.hudBar.clear();
    this.hudBar.fillStyle(0x000000, 0.4);
    this.hudBar.fillRect(140, 44, VIEW_W - 280, 8);
    this.hudBar.fillStyle(asInt(this.pal.accent), 1);
    this.hudBar.fillRect(140, 44, (VIEW_W - 280) * (pct / 100), 8);
    // A faint tick at the furthest point reached — the only progress feedback this genre needs.
    if (this.bestPct > 0) {
      this.hudBar.fillStyle(asInt(this.pal.text), 0.55);
      this.hudBar.fillRect(140 + (VIEW_W - 280) * (this.bestPct / 100) - 1, 40, 2, 16);
    }
  }

  // ── outcomes ─────────────────────────────────────────────────────────────

  die(cause) {
    if (this.dead) return;
    this.dead = true;
    const pct = Math.min(100, Math.round((this.dist / this.level.lengthPx) * 100));
    save.recordDeath();
    telemetry.levelDeath(this.levelIndex);
    sfx.crash();
    this.cameras.main.shake(180, 0.014);
    this.player.setTint(0xff3b30);
    this.dust.emitParticleAt(PLAYER_X, this.feetY - this.bodySize / 2, 16);

    const reached = this.add
      .text(VIEW_W / 2, VIEW_H / 2, `${pct}%`, {
        fontFamily: FONT_DISPLAY, fontSize: '64px', color: this.pal.obstacle,
      })
      .setOrigin(0.5)
      .setDepth(60);
    this.tweens.add({ targets: reached, alpha: 0, scale: 1.25, duration: RESTART_MS });

    // Straight back in. No menu, no button, no confirmation.
    this.time.delayedCall(RESTART_MS, () => {
      this.scene.start('Play', { level: this.levelIndex, attempts: this.attempts + 1, bestPct: Math.max(pct, this.bestPct) });
    });
  }

  win() {
    if (this.finished) return;
    this.finished = true;
    sfx.win();
    // Stars reflect how clean the clear was; attempts are the natural measure here.
    const stars = this.attempts <= 1 ? 3 : this.attempts <= 5 ? 2 : 1;
    save.recordWin(this.levelIndex, stars, this.cfg.progression.endlessUnlockAt);
    telemetry.levelClear(this.levelIndex);
    telemetry.sessionEnd({ level: this.levelIndex, score: this.attempts, durationS: Math.round(this.elapsed) });

    const last = this.levelIndex >= this.cfg.levels.length;
    this.add
      .text(VIEW_W / 2, VIEW_H / 2 - 26, last ? 'ALL LEVELS CLEAR' : 'LEVEL COMPLETE', {
        fontFamily: FONT_DISPLAY, fontSize: last ? '40px' : '46px', color: this.pal.accent,
      })
      .setOrigin(0.5)
      .setDepth(60);
    this.add
      .text(VIEW_W / 2, VIEW_H / 2 + 26, `${this.attempts} ATTEMPT${this.attempts > 1 ? 'S' : ''}`, {
        fontFamily: FONT_BODY, fontSize: '17px', color: this.pal.text,
      })
      .setOrigin(0.5)
      .setAlpha(0.85)
      .setDepth(60);

    this.time.delayedCall(1250, () => {
      if (last) {
        this.scene.start('Result', {
          outcome: 'win', mode: 'level', level: this.levelIndex,
          score: this.attempts, target: 0, unit: 'attempts', deaths: this.attempts, stars,
        });
      } else {
        // Straight into the next level. This is the loop that makes the genre addictive.
        this.scene.start('Play', { level: this.levelIndex + 1, attempts: 1 });
      }
    });
  }
}

// ── textures ────────────────────────────────────────────────────────────────

export function buildTextures(scene, cfg) {
  const p = cfg.theme.palette;
  const size = cfg.player.size;
  const mk = () => scene.make.graphics({ x: 0, y: 0, add: false });

  // the cube: flat, geometric, high contrast, with an off-centre eye so rotation reads
  let g = mk();
  g.fillStyle(shade(p.player, -0.5), 1);
  g.fillRect(0, 0, size, size);
  g.fillStyle(asInt(p.player), 1);
  g.fillRect(2, 2, size - 4, size - 4);
  g.fillStyle(shade(p.player, -0.55), 1);
  g.fillRect(size * 0.24, size * 0.3, size * 0.16, size * 0.16);
  g.fillRect(size * 0.6, size * 0.3, size * 0.16, size * 0.16);
  g.fillStyle(shade(p.player, -0.35), 1);
  g.fillRect(size * 0.28, size * 0.62, size * 0.44, size * 0.1);
  g.generateTexture('cube', size, size);
  g.destroy();

  // ground: solid band with a bright lip, so the surface line is unmistakable
  g = mk();
  const H = 64;
  g.fillStyle(shade(p.ground, -0.25), 1);
  g.fillRect(0, 0, 64, H);
  g.fillStyle(asInt(p.accent), 1);
  g.fillRect(0, 0, 64, 3);
  g.fillStyle(shade(p.ground, -0.45), 1);
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 10, 1, H - 10);
  g.generateTexture('ground', 64, H);
  g.destroy();

  // background grid
  g = mk();
  g.lineStyle(1, shade(p.bgAccent, 0.22), 0.55);
  for (let i = 0; i <= 64; i += 32) {
    g.lineBetween(i, 0, i, 64);
    g.lineBetween(0, i, 64, i);
  }
  g.generateTexture('grid', 64, 64);
  g.destroy();

  // parallax silhouettes
  for (const [name, scale, ratio] of [['par_far', 0.4, -0.12], ['par_near', 0.26, 0.08]]) {
    g = mk();
    const h = Math.round(VIEW_H * scale);
    g.fillStyle(shade(p.bgAccent, ratio), 1);
    let x = 0;
    let i = 0;
    while (x < VIEW_W) {
      const w = 46 + ((i * 41) % 84);
      const top = h - (20 + ((i * 59) % Math.max(24, h - 24)));
      g.fillRect(x, top, w, h - top);
      x += w + 10 + ((i * 23) % 30);
      i++;
    }
    g.generateTexture(name, VIEW_W, h);
    g.destroy();
  }

  g = mk();
  g.fillStyle(asInt(p.accent), 1);
  g.fillCircle(4, 4, 3);
  g.generateTexture('dot', 8, 8);
  g.destroy();
}
