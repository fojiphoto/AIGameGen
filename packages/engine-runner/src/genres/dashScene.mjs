/**
 * rhythm_dash runtime.
 *
 * The defining feel of this genre is the ABSENCE of interface. There is no level select, no
 * death screen and no confirmation between attempts: you die, and you are already running
 * again a third of a second later. Every frame spent on a menu is a frame the player did not
 * spend learning the layout, so the only chrome here is an attempt counter and a completion
 * bar. Finishing a level drops straight into the next one.
 *
 * ── WHAT IS PROOF-CRITICAL, AND WHAT IS DECORATION ──────────────────────────
 *
 * `stepSim()` is the simulation, and it is verified: the generator's solver integrates the
 * exact same equations at the exact same `level.simDt`, in the same order, against the same
 * collision boxes. Changing gravity handling, the timestep, the collision test or the jump
 * impulse here silently invalidates every "this level is finishable" claim the product makes.
 *
 * Everything else in this file — trail, squash, camera drift, fragments, flash, vignette,
 * speed lines, pulse — is presentation. It reads position and never writes it. That split is
 * deliberate: it means the game can be made to feel much better without ever touching what
 * was proven.
 *
 * The one input change that IS in the simulation path is the jump buffer, and it is safe in
 * the only direction that matters: it can make a jump fire on the frame the cube lands, never
 * before it. The solver assumes jumps happen while grounded, so a buffer is strictly more
 * permissive than what was proven.
 */

import Phaser from 'phaser';
import { VIEW_W, VIEW_H, FONT_DISPLAY, FONT_BODY } from '../constants.mjs';
import { asInt, shade } from '../textures.mjs';
import { dashSfx, unlock as unlockAudio } from '../audio.mjs';
import * as save from '../save.mjs';
import { telemetry } from '../telemetry.mjs';

/** Cube's fixed screen position. Far enough right to read what is coming. */
const PLAYER_X = 150;
/** Pause between dying and running again. Long enough to register, short enough to stay in flow. */
const RESTART_MS = 460;
/** How long a jump press is remembered while airborne. One-sixth of a second feels generous
 *  without ever firing a jump the player did not ask for. */
const JUMP_BUFFER_MS = 160;
/** Trail sample count. Short — a long trail reads as motion blur and hides the cube. */
const TRAIL_LEN = 9;

export default class PlayDash extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init(data) {
    this.cfg = this.registry.get('cfg');
    this.levelIndex = Math.min(this.cfg.levels.length, Math.max(1, data.level ?? 1));
    // Attempts persist across deaths on the same level; that number is the whole scoreboard.
    this.attempts = data.attempts ?? 1;
    // Carried through restarts so the furthest-reached marker actually persists. It did not,
    // originally — create() reset it every attempt and the marker never appeared.
    this.bestPct = data.bestPct ?? 0;
  }

  create() {
    const cfg = this.cfg;
    const pal = cfg.theme.palette;
    this.level = cfg.levels[this.levelIndex - 1];
    this.pal = pal;

    this.groundTop = this.level.groundTop;
    this.ceil = this.level.ceilingHeight || 0;
    this.bodySize = cfg.player.size * cfg.player.hitboxScale;

    // ── simulation state (proof-critical) ─────────────────────────────────
    this.dist = 0;
    this.vy = 0;
    this.feetY = this.groundTop;
    this.grounded = true;
    this.acc = 0;
    this.elapsed = 0;
    this.dead = false;
    this.finished = false;
    this.holding = false;
    this.bufferedAt = -1;

    // ── presentation state ────────────────────────────────────────────────
    this.spin = 0;
    this.spinTarget = 0;
    this.squash = 1;
    this.camY = 0;
    this.trail = [];
    this.beatIndex = -1;
    this.jumpSpan = this.estimateJumpSpan();

    this.cameras.main.setBackgroundColor(pal.bg);
    this.buildBackground();

    this.worldGfx = this.add.graphics().setDepth(10);
    this.trailGfx = this.add.graphics().setDepth(11);
    this.player = this.add.image(PLAYER_X, this.feetY, 'cube').setOrigin(0.5, 1).setDepth(12);

    this.dust = this.add.particles(0, 0, 'dot', {
      speed: { min: 40, max: 130 }, lifespan: 320, angle: { min: 160, max: 20 },
      scale: { start: 0.8, end: 0 }, alpha: { start: 0.7, end: 0 },
      quantity: 3, emitting: false, tint: asInt(pal.accent),
    }).setDepth(11);

    this.frags = this.add.particles(0, 0, 'frag', {
      speed: { min: 90, max: 340 }, lifespan: 620, gravityY: 700,
      scale: { start: 1, end: 0.2 }, alpha: { start: 1, end: 0 },
      rotate: { min: -240, max: 240 }, quantity: 14, emitting: false,
      tint: [asInt(pal.player), shade(pal.player, 0.3), shade(pal.player, -0.3)],
    }).setDepth(14);

    this.buildOverlays();
    this.buildHud();
    this.bindInput();

    telemetry.levelAttempt(this.levelIndex);
    // No countdown: this genre restarts constantly, and a 3-2-1 before every attempt would be
    // maddening. A short run-in of empty ground does the same job.
    this.running = true;

    // A quick wipe-in so a restart reads as a new attempt rather than a stutter.
    this.cameras.main.fadeIn(160, 0, 0, 0);
  }

  /** Horizontal span of one jump — used only to pace the background beat. */
  estimateJumpSpan() {
    const air = (2 * Math.abs(this.cfg.player.jumpVelocity)) / this.cfg.player.gravity;
    return Math.max(1, air * this.level.speed);
  }

  // ── presentation build ───────────────────────────────────────────────────

  buildBackground() {
    const cfg = this.cfg;
    this.layers = [];
    if (cfg.world.showGrid) {
      this.grid = this.add.tileSprite(0, 0, VIEW_W, VIEW_H, 'grid').setOrigin(0).setAlpha(0.4).setDepth(1);
    }
    // A wash behind the parallax so the silhouettes have something to sit against.
    this.glow = this.add.graphics().setDepth(0);
    // shade() already returns a packed int; asInt() takes a "#rrggbb" string. Wrapping one
    // in the other throws inside Phaser's fillStyle, which is how this first showed up.
    this.glow.fillStyle(shade(this.pal.bgAccent, -0.15), 0.5);
    this.glow.fillRect(0, 0, VIEW_W, this.groundTop);

    if (cfg.world.parallax >= 1) {
      this.layers.push({
        s: this.add.tileSprite(0, this.groundTop, VIEW_W, VIEW_H * 0.4, 'par_far')
          .setOrigin(0, 1).setAlpha(0.4).setDepth(2),
        f: 0.2,
      });
    }
    if (cfg.world.parallax >= 2) {
      this.layers.push({
        s: this.add.tileSprite(0, this.groundTop, VIEW_W, VIEW_H * 0.26, 'par_near')
          .setOrigin(0, 1).setAlpha(0.65).setDepth(3),
        f: 0.45,
      });
    }
    this.ground = this.add
      .tileSprite(0, this.groundTop, VIEW_W, VIEW_H - this.groundTop, 'ground')
      .setOrigin(0, 0).setDepth(4);
    if (this.ceil > 0) {
      this.ceilBand = this.add
        .tileSprite(0, 0, VIEW_W, this.ceil, 'ground')
        .setOrigin(0, 0).setFlipY(true).setDepth(4);
    }
  }

  /**
   * Vignette and speed lines. Both scale with how fast this level runs, so level 20 feels
   * physically faster than level 1 beyond just moving quicker.
   */
  buildOverlays() {
    const d = this.cfg.difficulty;
    this.intensity = Phaser.Math.Clamp(
      (this.level.speed - d.speedStart) / Math.max(1, d.speedEnd - d.speedStart), 0, 1
    );

    const v = this.add.graphics().setDepth(20);
    const edge = 120 + this.intensity * 70;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * (0.16 + this.intensity * 0.2);
      const w = (edge / 26) * (i + 1);
      v.fillStyle(0x000000, a / 26);
      v.fillRect(0, 0, w, VIEW_H);
      v.fillRect(VIEW_W - w, 0, w, VIEW_H);
      v.fillRect(0, 0, VIEW_W, w * 0.5);
      v.fillRect(0, VIEW_H - w * 0.5, VIEW_W, w * 0.5);
    }
    this.vignette = v;

    this.speedGfx = this.add.graphics().setDepth(9);
    this.speedLines = Array.from({ length: 14 }, (_, i) => ({
      y: 40 + ((i * 97) % (this.groundTop - 60)),
      len: 40 + ((i * 53) % 90),
      x: (i * 137) % VIEW_W,
      spd: 1.4 + ((i * 31) % 10) / 10,
    }));
  }

  buildHud() {
    const pal = this.pal;
    this.hudBar = this.add.graphics().setDepth(50);
    this.hudPct = this.add
      .text(VIEW_W / 2, 22, '0%', { fontFamily: FONT_DISPLAY, fontSize: '19px', color: pal.text })
      .setOrigin(0.5).setDepth(51);
    this.hudLevel = this.add
      .text(16, 16, `LV ${this.levelIndex}  ${String(this.level.name).toUpperCase()}`, {
        fontFamily: FONT_DISPLAY, fontSize: '12px', color: pal.text,
      }).setAlpha(0.7).setDepth(51);
    this.hudAttempt = this.add
      .text(VIEW_W - 16, 16, `ATTEMPT ${this.attempts}`, {
        fontFamily: FONT_BODY, fontSize: '14px', color: pal.accent,
      }).setOrigin(1, 0).setDepth(51);

    // Pops on a retry so the rising count is felt, not just read.
    if (this.attempts > 1) {
      this.hudAttempt.setScale(1.35);
      this.tweens.add({ targets: this.hudAttempt, scale: 1, duration: 240, ease: 'Back.easeOut' });
    }

    if (this.levelIndex === 1 && this.attempts === 1) {
      this.hint = this.add
        .text(VIEW_W / 2, this.groundTop - 96, 'HOLD TO JUMP', {
          fontFamily: FONT_DISPLAY, fontSize: '16px', color: pal.text,
        }).setOrigin(0.5).setAlpha(0).setDepth(51);
      this.tweens.add({ targets: this.hint, alpha: 0.75, duration: 500 });
      this.tweens.add({
        targets: this.hint, y: this.groundTop - 104,
        duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    }
  }

  bindInput() {
    const down = () => {
      unlockAudio();
      this.holding = true;
      // Remember the press even if we are mid-air. It fires the moment we land.
      this.bufferedAt = this.elapsed;
      this.tryJump();
    };
    const up = () => { this.holding = false; };

    this.input.on('pointerdown', down);
    this.input.on('pointerup', up);
    for (const k of ['SPACE', 'UP', 'W']) {
      this.input.keyboard?.on(`keydown-${k}`, down);
      this.input.keyboard?.on(`keyup-${k}`, up);
    }
    this.input.keyboard?.on('keydown-ESC', () => this.quit());
  }

  quit() {
    this.scene.start('Result', {
      outcome: 'lose', mode: 'level', level: this.levelIndex,
      score: this.pct(), target: 100, unit: '%', deaths: this.attempts, cause: 'quit',
    });
  }

  pct() {
    return Math.min(100, Math.round((this.dist / this.level.lengthPx) * 100));
  }

  // ── simulation (proof-critical — see file header) ────────────────────────

  tryJump() {
    if (this.dead || this.finished || !this.grounded) return;
    const boosted = this.padUnder();
    this.vy = this.cfg.player.jumpVelocity * (boosted ? 1.5 : 1);
    this.grounded = false;
    this.bufferedAt = -1;
    // presentation only
    this.spinTarget += Math.PI / 2 * (boosted ? 2 : 1);
    this.squash = 0.78;
    boosted ? dashSfx.pad() : dashSfx.jump();
    this.dust.emitParticleAt(PLAYER_X, this.feetY - 2, boosted ? 8 : 4);
    if (this.hint) {
      this.tweens.killTweensOf(this.hint);
      this.tweens.add({ targets: this.hint, alpha: 0, duration: 260 });
      this.hint = null;
    }
  }

  padUnder() {
    const x = this.dist;
    return this.level.pads.some((p) => x + this.bodySize > p.x && x < p.x + p.w);
  }

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

  update(_t, deltaMs) {
    if (this.paused) return;
    if (this.dead || this.finished) {
      this.drawTrail(true);
      return;
    }
    if (!this.running) return;

    const dt = this.level.simDt ?? 1 / 120;
    // Clamp the catch-up so a stall cannot teleport the cube through a spike.
    this.acc += Math.min(deltaMs, 100) / 1000;
    let guard = 0;
    while (this.acc >= dt && !this.dead && !this.finished && guard++ < 12) {
      this.acc -= dt;
      this.stepSim(dt);
    }
    if (this.dead || this.finished) return;

    this.updateVisuals(deltaMs / 1000);
    this.drawWorld();
    this.updateHud();
    if (this.dist >= this.level.lengthPx) this.win();
  }

  stepSim(dt) {
    this.elapsed += dt;
    const advance = this.level.speed * dt;
    this.dist += advance;
    this.scrollAmount = (this.scrollAmount ?? 0) + advance;

    if (!this.grounded) {
      this.vy += this.cfg.player.gravity * dt;
      this.feetY += this.vy * dt;

      if (this.ceil > 0 && this.feetY - this.bodySize < this.ceil) {
        this.feetY = this.ceil + this.bodySize;
        this.vy = Math.max(0, this.vy);
      }
      const surface = this.surfaceAt(this.dist);
      if (this.vy > 0 && surface !== null && this.feetY >= surface) {
        this.feetY = surface;
        this.grounded = true;
        this.vy = 0;
        this.onLand();
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
  }

  onLand() {
    // Rest square: snap the visual rotation to the nearest quarter turn.
    this.spinTarget = Math.round(this.spinTarget / (Math.PI / 2)) * (Math.PI / 2);
    this.squash = 1.26;
    dashSfx.land();
    this.dust.emitParticleAt(PLAYER_X, this.feetY - 2, 3);

    // Holding through a landing chains the next jump immediately — that chaining is what
    // makes long spike runs feel possible rather than pixel-perfect.
    if (this.holding) return this.tryJump();
    // Otherwise honour a press made just before touchdown.
    if (this.bufferedAt >= 0 && this.elapsed - this.bufferedAt <= JUMP_BUFFER_MS / 1000) {
      this.tryJump();
    }
  }

  // ── presentation (never writes simulation state) ─────────────────────────

  updateVisuals(dtReal) {
    const advance = this.scrollAmount ?? 0;
    this.scrollAmount = 0;

    this.ground.tilePositionX += advance;
    if (this.ceilBand) this.ceilBand.tilePositionX += advance;
    if (this.grid) this.grid.tilePositionX += advance * 0.6;
    for (const l of this.layers) l.s.tilePositionX += advance * l.f;

    // eased rotation — a linear spin looks mechanical, easing reads as weight
    this.spin += (this.spinTarget - this.spin) * Math.min(1, dtReal * 14);
    // squash settles back to 1
    this.squash += (1 - this.squash) * Math.min(1, dtReal * 12);

    // Camera drifts a fraction of the cube's height so a tall jump feels airy without
    // the horizon lurching.
    const lift = Phaser.Math.Clamp((this.groundTop - this.feetY) * 0.16, 0, 46);
    this.camY += (lift - this.camY) * Math.min(1, dtReal * 7);
    this.cameras.main.setScroll(0, -this.camY * 0.5);

    this.player.y = this.feetY;
    this.player.setRotation(this.spin);
    this.player.setScale(1 / this.squash, this.squash);

    this.trail.unshift({ y: this.feetY, r: this.spin });
    if (this.trail.length > TRAIL_LEN) this.trail.pop();
    this.drawTrail(false);

    // Background pulse on the jump-rhythm beat.
    if (this.cfg.world.showPulse) {
      const beat = Math.floor(this.dist / this.jumpSpan);
      if (beat !== this.beatIndex) {
        this.beatIndex = beat;
        const a = 0.5 + 0.14 * (0.5 + this.intensity);
        this.glow.setAlpha(a);
        this.tweens.add({ targets: this.glow, alpha: 0.5, duration: 220 });
        if (this.intensity > 0.45) dashSfx.beat();
      }
    }

    this.drawSpeedLines(dtReal);
  }

  drawTrail(frozen) {
    const g = this.trailGfx;
    g.clear();
    if (!this.trail.length) return;
    const size = this.cfg.player.size;
    for (let i = this.trail.length - 1; i >= 1; i--) {
      const p = this.trail[i];
      const t = 1 - i / this.trail.length;
      g.fillStyle(asInt(this.pal.player), (frozen ? 0.1 : 0.22) * t);
      const s = size * (0.55 + t * 0.35);
      g.fillRect(PLAYER_X - s / 2 - i * 3.2, p.y - s, s, s);
    }
  }

  drawSpeedLines(dtReal) {
    const g = this.speedGfx;
    g.clear();
    if (this.intensity < 0.3) return;
    g.fillStyle(asInt(this.pal.text), 0.05 + this.intensity * 0.07);
    for (const l of this.speedLines) {
      l.x -= this.level.speed * l.spd * dtReal;
      if (l.x + l.len < 0) l.x = VIEW_W + Math.random() * 120;
      g.fillRect(l.x, l.y, l.len * (0.4 + this.intensity), 2);
    }
  }

  drawWorld() {
    const g = this.worldGfx;
    const pal = this.pal;
    g.clear();
    const sx = (wx) => PLAYER_X + (wx - this.dist);

    // gaps: cut the ground away
    g.fillStyle(asInt(pal.bg), 1);
    for (const gp of this.level.gaps) {
      const x = sx(gp.x);
      if (x > VIEW_W + 60 || x + gp.w < -60) continue;
      g.fillRect(x, this.groundTop, gp.w, VIEW_H - this.groundTop);
      g.fillStyle(shade(pal.ground, -0.55), 1);
      g.fillRect(x - 4, this.groundTop, 4, 12);
      g.fillRect(x + gp.w, this.groundTop, 4, 12);
      g.fillStyle(asInt(pal.bg), 1);
    }

    // platforms
    for (const p of this.level.platforms) {
      const x = sx(p.x);
      if (x > VIEW_W + 80 || x + p.w < -80) continue;
      const y = this.groundTop - p.h;
      g.fillStyle(shade(pal.ground, -0.3), 1);
      g.fillRect(x + 3, y + 3, p.w, p.h);
      g.fillStyle(shade(pal.ground, 0.2), 1);
      g.fillRect(x, y, p.w, p.h);
      g.fillStyle(asInt(pal.accent), 1);
      g.fillRect(x, y, p.w, 4);
    }

    // pads
    for (const p of this.level.pads) {
      const x = sx(p.x);
      if (x > VIEW_W + 40 || x + p.w < -40) continue;
      const bob = Math.sin(this.elapsed * 7) * 2;
      g.fillStyle(shade(pal.accent, -0.4), 1);
      g.fillTriangle(x, this.groundTop, x + p.w / 2, this.groundTop - 14 + bob, x + p.w, this.groundTop);
      g.fillStyle(asInt(pal.accent), 1);
      g.fillTriangle(x + 3, this.groundTop, x + p.w / 2, this.groundTop - 10 + bob, x + p.w - 3, this.groundTop);
    }

    // hazards
    for (const o of this.level.obstacles) {
      const x = sx(o.x);
      if (x > VIEW_W + 70 || x + o.w < -70) continue;
      if (o.kind === 'spike') {
        g.fillStyle(shade(pal.obstacle, -0.55), 1);
        g.fillTriangle(x + 2, this.groundTop, x + o.w / 2 + 2, this.groundTop - o.h + 2, x + o.w + 2, this.groundTop);
        g.fillStyle(shade(pal.obstacle, -0.28), 1);
        g.fillTriangle(x - 1, this.groundTop, x + o.w / 2, this.groundTop - o.h - 1, x + o.w + 1, this.groundTop);
        g.fillStyle(asInt(pal.obstacle), 1);
        g.fillTriangle(x + 3, this.groundTop, x + o.w / 2, this.groundTop - o.h + 4, x + o.w - 3, this.groundTop);
        // highlight edge so the tip reads at speed
        g.fillStyle(asInt(pal.text), 0.5);
        g.fillTriangle(x + o.w / 2 - 2, this.groundTop - o.h + 5, x + o.w / 2, this.groundTop - o.h, x + o.w / 2 + 1, this.groundTop - o.h + 6);
      } else if (o.kind === 'block') {
        g.fillStyle(shade(pal.obstacle, -0.55), 1);
        g.fillRect(x + 3, this.groundTop - o.h + 3, o.w, o.h);
        g.fillStyle(shade(pal.obstacle, -0.3), 1);
        g.fillRect(x, this.groundTop - o.h, o.w, o.h);
        g.fillStyle(asInt(pal.obstacle), 1);
        g.fillRect(x + 3, this.groundTop - o.h + 3, o.w - 6, o.h - 6);
        g.fillStyle(asInt(pal.text), 0.35);
        g.fillRect(x + 3, this.groundTop - o.h + 3, o.w - 6, 2);
      } else if (o.kind === 'ceil') {
        g.fillStyle(shade(pal.obstacle, -0.3), 1);
        g.fillTriangle(x - 1, this.ceil, x + o.w / 2, this.ceil + o.h + 1, x + o.w + 1, this.ceil);
        g.fillStyle(asInt(pal.obstacle), 1);
        g.fillTriangle(x + 3, this.ceil, x + o.w / 2, this.ceil + o.h - 4, x + o.w - 3, this.ceil);
      }
    }
  }

  updateHud() {
    const pct = this.pct();
    this.hudPct.setText(`${pct}%`);
    const barX = 150;
    const barW = VIEW_W - 300;
    this.hudBar.clear();
    this.hudBar.fillStyle(0x000000, 0.42);
    this.hudBar.fillRoundedRect(barX, 40, barW, 9, 4);
    this.hudBar.fillStyle(asInt(this.pal.accent), 1);
    this.hudBar.fillRoundedRect(barX, 40, Math.max(4, barW * (pct / 100)), 9, 4);
    // leading highlight
    this.hudBar.fillStyle(asInt(this.pal.text), 0.7);
    this.hudBar.fillRect(barX + barW * (pct / 100) - 2, 38, 2, 13);
    // furthest reached on a previous attempt
    if (this.bestPct > pct) {
      this.hudBar.fillStyle(asInt(this.pal.text), 0.5);
      this.hudBar.fillRect(barX + barW * (this.bestPct / 100) - 1, 36, 2, 17);
    }
  }

  // ── outcomes ─────────────────────────────────────────────────────────────

  die() {
    if (this.dead) return;
    this.dead = true;
    const pct = this.pct();
    const best = Math.max(pct, this.bestPct);
    save.recordDeath();
    telemetry.levelDeath(this.levelIndex);
    dashSfx.death();

    this.cameras.main.shake(200, 0.016);
    this.cameras.main.flash(90, 255, 255, 255, false);
    this.player.setVisible(false);
    this.frags.emitParticleAt(PLAYER_X, this.feetY - this.bodySize / 2, 16);
    this.dust.emitParticleAt(PLAYER_X, this.feetY - 4, 10);

    const label = this.add
      .text(VIEW_W / 2, VIEW_H / 2 - 6, `${pct}%`, {
        fontFamily: FONT_DISPLAY, fontSize: '72px', color: this.pal.obstacle,
      }).setOrigin(0.5).setDepth(60).setScale(0.7);
    this.tweens.add({ targets: label, scale: 1.1, duration: 200, ease: 'Back.easeOut' });
    this.tweens.add({ targets: label, alpha: 0, duration: RESTART_MS - 120, delay: 120 });

    if (best > pct && best > 0) {
      this.add
        .text(VIEW_W / 2, VIEW_H / 2 + 46, `BEST ${best}%`, {
          fontFamily: FONT_BODY, fontSize: '15px', color: this.pal.text,
        }).setOrigin(0.5).setAlpha(0.6).setDepth(60);
    }

    this.cameras.main.fadeOut(RESTART_MS - 140, 0, 0, 0);
    // Straight back in. No menu, no button, no confirmation.
    this.time.delayedCall(RESTART_MS, () => {
      this.scene.start('Play', { level: this.levelIndex, attempts: this.attempts + 1, bestPct: best });
    });
  }

  win() {
    if (this.finished) return;
    this.finished = true;
    dashSfx.complete();
    // Stars reflect how clean the clear was; attempts are the natural measure here.
    const stars = this.attempts <= 1 ? 3 : this.attempts <= 5 ? 2 : 1;
    save.recordWin(this.levelIndex, stars, this.cfg.progression.endlessUnlockAt);
    telemetry.levelClear(this.levelIndex);
    telemetry.sessionEnd({ level: this.levelIndex, score: this.attempts, durationS: Math.round(this.elapsed) });

    this.cameras.main.flash(160, 255, 255, 255, false);
    this.frags.emitParticleAt(PLAYER_X, this.feetY - this.bodySize / 2, 22);

    const last = this.levelIndex >= this.cfg.levels.length;
    const title = this.add
      .text(VIEW_W / 2, VIEW_H / 2 - 24, last ? 'ALL LEVELS CLEAR' : 'LEVEL COMPLETE', {
        fontFamily: FONT_DISPLAY, fontSize: last ? '38px' : '44px', color: this.pal.accent,
      }).setOrigin(0.5).setDepth(60).setScale(0.75);
    this.tweens.add({ targets: title, scale: 1, duration: 280, ease: 'Back.easeOut' });

    this.add
      .text(VIEW_W / 2, VIEW_H / 2 + 30, `${this.attempts} ATTEMPT${this.attempts > 1 ? 'S' : ''}  ·  ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`, {
        fontFamily: FONT_BODY, fontSize: '17px', color: this.pal.text,
      }).setOrigin(0.5).setAlpha(0.9).setDepth(60);

    if (!last) {
      this.add
        .text(VIEW_W / 2, VIEW_H / 2 + 66, `NEXT: ${String(this.cfg.levels[this.levelIndex].name).toUpperCase()}`, {
          fontFamily: FONT_BODY, fontSize: '13px', color: this.pal.accent,
        }).setOrigin(0.5).setAlpha(0.65).setDepth(60);
    }

    this.time.delayedCall(1100, () => this.cameras.main.fadeOut(280, 0, 0, 0));
    this.time.delayedCall(1420, () => {
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

  // The cube: flat and geometric, with an inner bevel so rotation is legible and a bright
  // inset so it never disappears against a busy background.
  let g = mk();
  g.fillStyle(shade(p.player, -0.6), 1);
  g.fillRect(0, 0, size, size);
  g.fillStyle(asInt(p.player), 1);
  g.fillRect(2, 2, size - 4, size - 4);
  g.fillStyle(shade(p.player, 0.35), 1);
  g.fillRect(2, 2, size - 4, 3);
  g.fillRect(2, 2, 3, size - 4);
  g.fillStyle(shade(p.player, -0.4), 1);
  g.fillRect(2, size - 5, size - 4, 3);
  // face
  g.fillStyle(shade(p.player, -0.65), 1);
  g.fillRect(size * 0.26, size * 0.32, size * 0.14, size * 0.16);
  g.fillRect(size * 0.6, size * 0.32, size * 0.14, size * 0.16);
  g.fillStyle(shade(p.player, -0.45), 1);
  g.fillRect(size * 0.3, size * 0.62, size * 0.4, size * 0.08);
  g.generateTexture('cube', size, size);
  g.destroy();

  // death fragment
  g = mk();
  g.fillStyle(0xffffff, 1);
  g.fillRect(0, 0, Math.max(4, Math.round(size / 5)), Math.max(4, Math.round(size / 5)));
  g.generateTexture('frag', Math.max(4, Math.round(size / 5)), Math.max(4, Math.round(size / 5)));
  g.destroy();

  // ground: solid band with a bright lip, so the surface line is unmistakable
  g = mk();
  const H = 72;
  g.fillStyle(shade(p.ground, -0.32), 1);
  g.fillRect(0, 0, 64, H);
  g.fillStyle(shade(p.ground, -0.18), 1);
  g.fillRect(0, 6, 64, 10);
  g.fillStyle(asInt(p.accent), 1);
  g.fillRect(0, 0, 64, 4);
  g.fillStyle(shade(p.ground, -0.5), 1);
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 16, 2, H - 16);
  g.fillStyle(shade(p.ground, -0.42), 1);
  for (let y = 24; y < H; y += 16) g.fillRect(0, y, 64, 1);
  g.generateTexture('ground', 64, H);
  g.destroy();

  // background grid
  g = mk();
  g.lineStyle(1, shade(p.bgAccent, 0.3), 0.6);
  for (let i = 0; i <= 64; i += 32) {
    g.lineBetween(i, 0, i, 64);
    g.lineBetween(0, i, 64, i);
  }
  g.generateTexture('grid', 64, 64);
  g.destroy();

  // parallax silhouettes — angular, to match the geometric read
  for (const [name, scale, ratio] of [['par_far', 0.42, -0.14], ['par_near', 0.27, 0.1]]) {
    g = mk();
    const h = Math.round(VIEW_H * scale);
    g.fillStyle(shade(p.bgAccent, ratio), 1);
    let x = 0;
    let i = 0;
    while (x < VIEW_W) {
      const w = 44 + ((i * 41) % 90);
      const top = h - (22 + ((i * 59) % Math.max(26, h - 26)));
      if (i % 3 === 0) g.fillTriangle(x, h, x + w / 2, top, x + w, h);
      else g.fillRect(x, top, w, h - top);
      x += w + 12 + ((i * 23) % 26);
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
