/**
 * The runner itself. Handles both level mode (1-20) and endless mode.
 *
 * PHYSICS NOTE — this is the important part.
 * The jump arc is evaluated in CLOSED FORM from the elapsed jump time:
 *
 *     feetY(t) = feetY0 − (v0·t − ½·g·t²)
 *
 * It is deliberately NOT step-integrated. Two reasons:
 *   1. It is exactly the model `packages/generation/physics.mjs` proves against,
 *      so "the validator says this level is beatable" is a statement about the
 *      game the player actually plays, not an approximation of it.
 *   2. It is frame-rate independent. On a cheap Android WebView dropping to 30fps
 *      an Euler-integrated jump changes height; this does not.
 */

import Phaser from 'phaser';
import { PIXELS_PER_METRE } from '../constants.mjs';
import { sfx, unlock as unlockAudio } from '../audio.mjs';
import { shade, asInt } from '../textures.mjs';
import * as save from '../save.mjs';
import { telemetry } from '../telemetry.mjs';

const VIEW_W = 900;
const VIEW_H = 506;
const PLAYER_X = 150;

/** Screen-space vertical extent an obstacle occupies right now. */
function obstacleBox(ob, groundTop, timeSec) {
  let lift = ob.yOffset;
  if (ob.kind === 'moving_saw' && ob.motionAmp > 0) {
    lift += ob.motionAmp * (0.5 + 0.5 * Math.sin(timeSec * (ob.motionSpeed || 2)));
  }
  const bottom = groundTop - lift;
  return { top: bottom - ob.height, bottom, lift };
}

export default class Play extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init(data) {
    this.cfg = this.registry.get('cfg');
    this.mode = data.mode ?? 'level';
    this.levelIndex = data.level ?? 1;
    this.deaths = data.deaths ?? 0;
  }

  create() {
    const cfg = this.cfg;
    const pal = cfg.theme.palette;
    this.groundTop = VIEW_H - cfg.world.groundHeight;
    this.gravity = cfg.player.gravity;
    this.impulse = Math.abs(cfg.player.jumpVelocity);
    this.playerBox = cfg.player.size * cfg.player.hitboxScale;

    this.level = this.mode === 'level' ? cfg.levels[this.levelIndex - 1] : null;
    this.speed = this.mode === 'level' ? this.level.speed : cfg.difficulty.maxSpeed * 0.8;
    this.targetPx = this.mode === 'level' ? this.level.targetPx : Infinity;

    this.dist = 0;
    this.elapsed = 0;
    this.finished = false;
    this.dead = false;
    this.paused = false;
    this.milestone = 0;

    // ── background ────────────────────────────────────────────────────────
    this.cameras.main.setBackgroundColor(pal.bg);
    if (cfg.world.showStars) this.createStars(pal);

    this.parallax = [];
    if (cfg.world.parallax >= 1) {
      const far = this.add.tileSprite(0, this.groundTop, VIEW_W, VIEW_H * 0.42, 'par_far').setOrigin(0, 1).setAlpha(0.55);
      this.parallax.push({ s: far, factor: 0.18 });
    }
    if (cfg.world.parallax >= 2) {
      const near = this.add.tileSprite(0, this.groundTop, VIEW_W, VIEW_H * 0.28, 'par_near').setOrigin(0, 1).setAlpha(0.8);
      this.parallax.push({ s: near, factor: 0.42 });
    }

    // ── ground + gap overlay ──────────────────────────────────────────────
    this.ground = this.add
      .tileSprite(0, this.groundTop, VIEW_W, cfg.world.groundHeight, 'ground')
      .setOrigin(0, 0);
    this.gapGfx = this.add.graphics();
    this.bgInt = asInt(pal.bg);
    this.groundLipInt = shade(pal.ground, -0.55);

    // ── obstacles ─────────────────────────────────────────────────────────
    this.obById = new Map(cfg.obstacles.map((o) => [o.id, o]));
    this.spawned = [];
    if (this.mode === 'level') {
      for (const p of this.level.pattern) this.addObstacle(p.obstacleId, p.x);
    } else {
      this.endlessCursor = VIEW_W + 260;
      this.endlessRng = mulberry(Date.now() & 0xffffffff);
    }

    // ── player ────────────────────────────────────────────────────────────
    this.player = this.add.image(PLAYER_X, this.groundTop, 'player').setOrigin(0.5, 1);
    this.feetY = this.groundTop;
    this.grounded = true;
    this.jumpsUsed = 0;
    this.jumpT = 0;
    this.jumpFeetY0 = this.groundTop;
    this.jumpV0 = 0;
    this.fallingInGap = false;

    this.dust = this.add.particles(0, 0, 'dot', {
      speed: { min: 20, max: 70 },
      lifespan: 340,
      scale: { start: 0.7, end: 0 },
      alpha: { start: 0.5, end: 0 },
      quantity: 2,
      emitting: false,
      tint: asInt(pal.text),
    });

    this.buildHud(pal);
    this.bindInput();
    if (this.mode === 'level') telemetry.levelAttempt(this.levelIndex);

    // brief "GO" beat so the player is oriented before movement starts
    this.running = false;
    this.showCountdown(pal);
  }

  // ────────────────────────────────────────────────────────────────────────

  createStars(pal) {
    this.stars = [];
    const rng = mulberry(0xc0ffee);
    for (let i = 0; i < 46; i++) {
      const s = this.add
        .image(rng() * VIEW_W, rng() * (this.groundTop - 40), 'dot')
        .setScale(rng() * 0.6 + 0.25)
        .setAlpha(rng() * 0.5 + 0.15)
        .setTint(asInt(pal.text));
      this.stars.push({ s, factor: 0.04 + rng() * 0.05 });
    }
  }

  addObstacle(id, worldX) {
    const ob = this.obById.get(id);
    if (!ob) return;
    const spr =
      ob.kind === 'gap'
        ? null
        : this.add.image(-999, 0, `ob_${ob.id}`).setOrigin(0, 0).setVisible(false);
    this.spawned.push({ ob, worldX, spr, cleared: false });
  }

  buildHud(pal) {
    const disp = '"Arial Black", "Arial Bold", Impact, sans-serif';
    const body = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

    this.hudBar = this.add.graphics().setDepth(50);

    this.hudTitle = this.add
      .text(18, 14, this.mode === 'level' ? this.level.name.toUpperCase() : 'ENDLESS MODE', {
        fontFamily: disp,
        fontSize: '19px',
        color: pal.text,
      })
      .setDepth(51);

    this.hudDist = this.add
      .text(VIEW_W - 18, 14, '', { fontFamily: body, fontSize: '17px', color: pal.accent })
      .setOrigin(1, 0)
      .setDepth(51);

    this.hudHint = this.add
      .text(VIEW_W / 2, this.groundTop - 54, this.cfg.copy.tutorial.toUpperCase(), {
        fontFamily: body,
        fontSize: '15px',
        color: pal.text,
      })
      .setOrigin(0.5)
      .setAlpha(0.65)
      .setDepth(51);
    if (this.levelIndex > 1 || this.mode === 'endless') this.hudHint.setAlpha(0);

    this.pauseBtn = this.add
      .text(VIEW_W - 18, VIEW_H - 16, 'II', {
        fontFamily: disp,
        fontSize: '20px',
        color: pal.text,
        backgroundColor: 'rgba(0,0,0,0.28)',
        padding: { x: 10, y: 4 },
      })
      .setOrigin(1, 1)
      .setDepth(51)
      .setInteractive({ useHandCursor: true });
    this.pauseBtn.on('pointerdown', (p, x, y, e) => {
      e?.stopPropagation?.();
      this.togglePause();
    });
  }

  bindInput() {
    this.input.on('pointerdown', () => this.onTap());
    this.input.keyboard?.on('keydown-SPACE', () => this.onTap());
    this.input.keyboard?.on('keydown-UP', () => this.onTap());
    this.input.keyboard?.on('keydown-ESC', () => this.togglePause());
    this.input.keyboard?.on('keydown-P', () => this.togglePause());
  }

  showCountdown(pal) {
    const t = this.add
      .text(VIEW_W / 2, VIEW_H / 2 - 30, '3', {
        fontFamily: '"Arial Black", Impact, sans-serif',
        fontSize: '72px',
        color: pal.accent,
      })
      .setOrigin(0.5)
      .setDepth(60);

    const steps = ['3', '2', '1', 'GO'];
    let i = 0;
    this.time.addEvent({
      delay: 420,
      repeat: 3,
      callback: () => {
        i++;
        if (i < steps.length) {
          t.setText(steps[i]);
          t.setScale(1.3);
          this.tweens.add({ targets: t, scale: 1, duration: 200 });
          sfx.select();
        }
        if (i === steps.length - 1) {
          this.running = true;
          this.time.delayedCall(300, () => t.destroy());
        }
      },
    });
  }

  onTap() {
    unlockAudio();
    if (this.paused || this.dead || this.finished || !this.running) return;
    const maxJumps = this.cfg.player.doubleJump ? 2 : 1;
    if (this.fallingInGap) return;
    if (this.jumpsUsed >= maxJumps) return;

    this.jumpFeetY0 = this.feetY;
    this.jumpV0 = this.impulse;
    this.jumpT = 0;
    this.grounded = false;
    this.jumpsUsed++;
    this.jumpsUsed === 1 ? sfx.jump() : sfx.doubleJump();
    if (this.hudHint.alpha > 0) this.tweens.add({ targets: this.hudHint, alpha: 0, duration: 400 });
  }

  togglePause() {
    if (this.dead || this.finished) return;
    this.paused = !this.paused;
    if (this.paused) {
      this.pauseOverlay = this.add.container(0, 0).setDepth(70);
      const pal = this.cfg.theme.palette;
      const bg = this.add.graphics();
      bg.fillStyle(0x000000, 0.72);
      bg.fillRect(0, 0, VIEW_W, VIEW_H);
      const label = this.add
        .text(VIEW_W / 2, VIEW_H / 2 - 40, 'PAUSED', {
          fontFamily: '"Arial Black", Impact, sans-serif',
          fontSize: '44px',
          color: pal.text,
        })
        .setOrigin(0.5);
      const resume = this.mkButton(VIEW_W / 2, VIEW_H / 2 + 30, 'RESUME', pal, () => this.togglePause());
      const quit = this.mkButton(VIEW_W / 2, VIEW_H / 2 + 92, 'QUIT TO MENU', pal, () => {
        this.scene.start('Menu');
      });
      this.pauseOverlay.add([bg, label, resume, quit]);
    } else {
      this.pauseOverlay?.destroy(true);
      this.pauseOverlay = null;
    }
  }

  mkButton(x, y, label, pal, onClick) {
    const t = this.add
      .text(x, y, label, {
        fontFamily: 'system-ui, Roboto, sans-serif',
        fontSize: '19px',
        color: pal.bg,
        backgroundColor: pal.accent,
        padding: { x: 22, y: 11 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    t.on('pointerdown', (p, lx, ly, e) => {
      e?.stopPropagation?.();
      sfx.select();
      onClick();
    });
    return t;
  }

  // ────────────────────────────────────────────────────────────────────────

  update(_time, deltaMs) {
    if (this.paused || this.dead || this.finished) return;
    const dt = Math.min(deltaMs, 50) / 1000; // clamp so a stall can't teleport the player
    this.elapsed += dt;
    if (!this.running) return;

    if (this.mode === 'endless') this.rampEndless();

    const advance = this.speed * dt;
    this.dist += advance;

    this.scrollVisuals(advance);
    this.stepPlayer(dt);
    this.syncObstacles();
    if (this.mode === 'endless') this.topUpEndless();
    this.checkCollisions();
    this.updateHud();

    if (this.mode === 'level' && this.dist >= this.targetPx) this.win();
  }

  rampEndless() {
    const d = this.cfg.difficulty;
    const rampSeconds = 150;
    const t = 1 - Math.exp(-this.elapsed / rampSeconds);
    this.speed = d.maxSpeed * 0.8 + (d.maxSpeed * 1.35 - d.maxSpeed * 0.8) * t;
  }

  scrollVisuals(advance) {
    this.ground.tilePositionX += advance;
    for (const p of this.parallax) p.s.tilePositionX += advance * p.factor;
    if (this.stars) {
      for (const st of this.stars) {
        st.s.x -= advance * st.factor;
        if (st.s.x < -4) st.s.x += VIEW_W + 8;
      }
    }
  }

  stepPlayer(dt) {
    if (this.grounded && !this.fallingInGap) {
      // gap check: if the ground under the player is missing, start falling
      if (this.overGap()) {
        this.fallingInGap = true;
        this.jumpFeetY0 = this.feetY;
        this.jumpV0 = 0;
        this.jumpT = 0;
        this.grounded = false;
      } else {
        this.feetY = this.groundTop;
        this.player.y = this.feetY;
        return;
      }
    }

    this.jumpT += dt;
    const t = this.jumpT;
    // closed form — see file header
    const rise = this.jumpV0 * t - 0.5 * this.gravity * t * t;
    this.feetY = this.jumpFeetY0 - rise;

    if (this.fallingInGap) {
      this.player.y = this.feetY;
      this.player.setRotation(Math.min(1.2, t * 2.4));
      if (this.feetY > VIEW_H + 80) this.die('fell');
      return;
    }

    if (this.feetY >= this.groundTop && this.jumpV0 > 0 && t > 0) {
      // landed — unless we landed straight into a gap
      if (this.overGap()) {
        this.fallingInGap = true;
        this.jumpFeetY0 = this.groundTop;
        this.jumpV0 = 0;
        this.jumpT = 0;
      } else {
        this.feetY = this.groundTop;
        this.grounded = true;
        this.jumpsUsed = 0;
        sfx.land();
        this.dust.emitParticleAt(PLAYER_X, this.groundTop - 2, 3);
      }
    }
    this.player.y = this.feetY;
  }

  /** Is the player's footprint over a `gap` obstacle right now? */
  overGap() {
    const px1 = PLAYER_X - this.playerBox / 2;
    const px2 = PLAYER_X + this.playerBox / 2;
    for (const s of this.spawned) {
      if (s.ob.kind !== 'gap') continue;
      const x1 = PLAYER_X + (s.worldX - this.dist);
      const x2 = x1 + s.ob.width;
      // require the player to be meaningfully over the hole, not just touching a lip
      if (px2 > x1 + 4 && px1 < x2 - 4) return true;
    }
    return false;
  }

  syncObstacles() {
    this.gapGfx.clear();
    for (const s of this.spawned) {
      const sx = PLAYER_X + (s.worldX - this.dist);
      if (sx > VIEW_W + 140 || sx + s.ob.width < -140) {
        if (s.spr) s.spr.setVisible(false);
        continue;
      }
      if (s.ob.kind === 'gap') {
        // carve a hole: background fill plus two darker lips
        this.gapGfx.fillStyle(this.bgInt, 1);
        this.gapGfx.fillRect(sx, this.groundTop, s.ob.width, this.cfg.world.groundHeight);
        this.gapGfx.fillStyle(this.groundLipInt, 1);
        this.gapGfx.fillRect(sx - 5, this.groundTop, 5, 14);
        this.gapGfx.fillRect(sx + s.ob.width, this.groundTop, 5, 14);
        continue;
      }
      const box = obstacleBox(s.ob, this.groundTop, this.elapsed);
      s.spr.setVisible(true).setPosition(sx, box.top);
      if (s.ob.kind === 'moving_saw') s.spr.setRotation(this.elapsed * 6);
    }
  }

  topUpEndless() {
    const roster = this.cfg.obstacles.filter((o) => o.introAtLevel <= 20);
    const ahead = this.dist + VIEW_W + 400;
    let guard = 0;
    while (this.endlessCursor < ahead && guard++ < 24) {
      const ob = weightedPick(roster, this.endlessRng);
      // reuse the level-mode safety rule: never tighter than land-and-rejump
      const airTime = this.cfg.player.doubleJump
        ? (this.impulse * (2 + Math.SQRT2)) / this.gravity
        : (2 * this.impulse) / this.gravity;
      const safe = airTime * this.speed + this.playerBox + 20;
      const gap = Math.max(safe * 1.1, this.speed * (this.cfg.difficulty.spawnGapEnd / 1000));
      this.addObstacle(ob.id, this.endlessCursor);
      this.endlessCursor += ob.width + gap * (0.9 + this.endlessRng() * 0.35);
    }
    // drop anything far behind so the array cannot grow without bound
    if (this.spawned.length > 90) {
      const cut = this.spawned.filter((s) => PLAYER_X + (s.worldX - this.dist) + s.ob.width < -200);
      for (const s of cut) s.spr?.destroy();
      this.spawned = this.spawned.filter((s) => !cut.includes(s));
    }
  }

  checkCollisions() {
    const px1 = PLAYER_X - this.playerBox / 2;
    const px2 = PLAYER_X + this.playerBox / 2;
    const py2 = this.feetY;
    const py1 = this.feetY - this.playerBox;

    for (const s of this.spawned) {
      if (s.ob.kind === 'gap') continue;
      const x1 = PLAYER_X + (s.worldX - this.dist);
      const x2 = x1 + s.ob.width;
      if (x2 < px1 || x1 > px2) continue;
      const box = obstacleBox(s.ob, this.groundTop, this.elapsed);
      if (py2 > box.top && py1 < box.bottom) {
        this.die('hit');
        return;
      }
    }
  }

  updateHud() {
    const metres = Math.floor(this.dist / PIXELS_PER_METRE);
    if (this.mode === 'level') {
      const targetM = this.level.targetMetres;
      this.hudDist.setText(`${metres} / ${targetM} m`);
      const pct = Math.min(1, this.dist / this.targetPx);
      const pal = this.cfg.theme.palette;
      this.hudBar.clear();
      this.hudBar.fillStyle(0x000000, 0.35);
      this.hudBar.fillRect(18, 44, VIEW_W - 36, 7);
      this.hudBar.fillStyle(asInt(pal.accent), 1);
      this.hudBar.fillRect(18, 44, (VIEW_W - 36) * pct, 7);
    } else {
      this.hudDist.setText(`${metres} m   BEST ${save.getSave().endlessBest} m`);
      if (metres >= this.milestone + 250) {
        this.milestone = metres - (metres % 250);
        sfx.milestone();
      }
    }
  }

  die(cause) {
    if (this.dead) return;
    this.dead = true;
    this.deaths++;
    save.recordDeath();
    sfx.crash();
    this.cameras.main.shake(220, 0.012);
    this.player.setTint(0xff3b30);

    const metres = Math.floor(this.dist / PIXELS_PER_METRE);
    if (this.mode === 'endless') save.recordEndless(metres);
    if (this.mode === 'level') telemetry.levelDeath(this.levelIndex);
    telemetry.sessionEnd({ level: this.levelIndex, score: metres, durationS: Math.round(this.elapsed) });

    this.time.delayedCall(620, () => {
      this.scene.start('Result', {
        outcome: 'lose',
        mode: this.mode,
        level: this.levelIndex,
        metres,
        deaths: this.deaths,
        cause,
      });
    });
  }

  win() {
    if (this.finished) return;
    this.finished = true;
    sfx.win();
    const stars = save.starsFor(this.deaths);
    const res = save.recordWin(this.levelIndex, stars, this.cfg.progression.endlessUnlockAt);
    telemetry.levelClear(this.levelIndex);
    telemetry.sessionEnd({
      level: this.levelIndex,
      score: this.level.targetMetres,
      durationS: Math.round(this.elapsed),
    });
    this.time.delayedCall(420, () => {
      this.scene.start('Result', {
        outcome: 'win',
        mode: this.mode,
        level: this.levelIndex,
        metres: this.level.targetMetres,
        deaths: this.deaths,
        stars,
        unlockedEndless: res.unlockedEndless,
      });
    });
  }
}

// small local PRNG so endless mode and star fields don't need the node package
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick(items, rnd) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rnd() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return items.at(-1);
}
