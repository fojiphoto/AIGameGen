/**
 * tap_to_fly runtime.
 *
 * Unlike the runner, this cannot use a closed-form arc: the player can flap at any moment,
 * so the trajectory is not a single parabola. It integrates velocity instead, with a
 * terminal-velocity clamp — and the generator's reachability proof deliberately assumes
 * only 60% of the theoretical climb, which covers the gap between "flap every frame" and
 * what integration actually delivers.
 */

import Phaser from 'phaser';
import { VIEW_W, VIEW_H, PLAYER_X, FONT_DISPLAY, FONT_BODY } from '../constants.mjs';
import { asInt, shade } from '../textures.mjs';
import { sfx, unlock as unlockAudio } from '../audio.mjs';
import * as save from '../save.mjs';
import { telemetry } from '../telemetry.mjs';
import { hudBar, pauseOverlay, countdown } from './shared.mjs';

export default class PlayFly extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init(data) {
    this.cfg = this.registry.get('cfg');
    this.levelIndex = data.level ?? 1;
    this.deaths = data.deaths ?? 0;
  }

  create() {
    const cfg = this.cfg;
    const pal = cfg.theme.palette;
    this.level = cfg.levels[this.levelIndex - 1];
    this.groundY = VIEW_H - cfg.world.groundHeight;

    this.dist = 0;
    this.elapsed = 0;
    this.passed = 0;
    this.dead = false;
    this.finished = false;
    this.paused = false;
    this.running = false;

    this.cameras.main.setBackgroundColor(pal.bg);
    this.parallax = [];
    if (cfg.world.parallax >= 1) {
      this.parallax.push({
        s: this.add.tileSprite(0, this.groundY, VIEW_W, VIEW_H * 0.42, 'par_far').setOrigin(0, 1).setAlpha(0.55),
        f: 0.18,
      });
    }
    if (cfg.world.parallax >= 2) {
      this.parallax.push({
        s: this.add.tileSprite(0, this.groundY, VIEW_W, VIEW_H * 0.28, 'par_near').setOrigin(0, 1).setAlpha(0.8),
        f: 0.42,
      });
    }
    this.ground = this.add.tileSprite(0, this.groundY, VIEW_W, cfg.world.groundHeight, 'ground').setOrigin(0, 0);

    this.pipeGfx = this.add.graphics();
    this.pipeInt = asInt(pal.obstacle);
    this.pipeLip = shade(pal.obstacle, -0.35);
    this.accentInt = asInt(pal.accent);

    this.player = this.add.image(PLAYER_X, this.level.pattern[0]?.y ?? VIEW_H / 2, 'player').setOrigin(0.5);
    this.py = this.player.y;
    this.vy = 0;
    this.body = cfg.player.size * cfg.player.hitboxScale;

    this.hud = hudBar(this, this.level.name, pal);
    this.hint = this.add
      .text(VIEW_W / 2, this.groundY - 70, cfg.copy.tutorial.toUpperCase(), {
        fontFamily: FONT_BODY, fontSize: '15px', color: pal.text,
      })
      .setOrigin(0.5)
      .setAlpha(this.levelIndex === 1 ? 0.65 : 0);

    this.input.on('pointerdown', () => this.flap());
    this.input.keyboard?.on('keydown-SPACE', () => this.flap());
    this.input.keyboard?.on('keydown-UP', () => this.flap());
    this.input.keyboard?.on('keydown-ESC', () => this.togglePause());

    telemetry.levelAttempt(this.levelIndex);
    countdown(this, pal, () => (this.running = true));
  }

  flap() {
    unlockAudio();
    if (this.paused || this.dead || this.finished || !this.running) return;
    this.vy = -this.cfg.player.flapImpulse;
    this.player.setAngle(-18);
    sfx.jump();
    if (this.hint.alpha > 0) this.tweens.add({ targets: this.hint, alpha: 0, duration: 400 });
  }

  togglePause() {
    if (this.dead || this.finished) return;
    this.paused = !this.paused;
    if (this.paused) this.overlay = pauseOverlay(this, this.cfg.theme.palette, () => this.togglePause());
    else { this.overlay?.destroy(true); this.overlay = null; }
  }

  update(_t, deltaMs) {
    if (this.paused || this.dead || this.finished) return;
    const dt = Math.min(deltaMs, 50) / 1000;
    this.elapsed += dt;
    if (!this.running) return;

    const speed = this.level.speed;
    const advance = speed * dt;
    this.dist += advance;

    this.ground.tilePositionX += advance;
    for (const p of this.parallax) p.s.tilePositionX += advance * p.f;

    // integrate, with a fall-speed cap so a long dive stays recoverable
    this.vy = Math.min(this.cfg.player.terminalVelocity, this.vy + this.cfg.player.gravity * dt);
    this.py += this.vy * dt;
    this.player.y = this.py;
    this.player.setAngle(Phaser.Math.Clamp(this.vy * 0.06, -22, 70));

    if (this.py + this.body / 2 >= this.groundY) return this.die('ground');
    if (this.py - this.body / 2 <= 0) {
      if (this.cfg.world.ceilingKills) return this.die('ceiling');
      this.py = this.body / 2;
      this.vy = 0;
    }

    this.drawPipes();
    this.checkCollisions();
    this.updateHud();

    if (this.passed >= this.level.targetPipes) this.win();
  }

  /** Screen-space gap centre for a pipe, including its oscillation. */
  gapCentre(pipe) {
    return pipe.amp > 0
      ? pipe.y + Math.sin(this.elapsed * 1.6 + pipe.phase) * pipe.amp
      : pipe.y;
  }

  drawPipes() {
    const g = this.pipeGfx;
    const w = this.cfg.world.pipeWidth;
    g.clear();
    for (const pipe of this.level.pattern) {
      const sx = PLAYER_X + (pipe.x - this.dist);
      if (sx > VIEW_W + 80 || sx + w < -80) continue;
      const cy = this.gapCentre(pipe);
      const top = cy - pipe.gap / 2;
      const bottom = cy + pipe.gap / 2;

      g.fillStyle(this.pipeInt, 1);
      g.fillRect(sx, 0, w, top);
      g.fillRect(sx, bottom, w, this.groundY - bottom);
      // lips read the gap edge instantly at speed
      g.fillStyle(this.pipeLip, 1);
      g.fillRect(sx - 4, top - 14, w + 8, 14);
      g.fillRect(sx - 4, bottom, w + 8, 14);
      g.fillStyle(this.accentInt, 1);
      g.fillRect(sx - 4, top - 3, w + 8, 3);
      g.fillRect(sx - 4, bottom + 11, w + 8, 3);
    }
  }

  checkCollisions() {
    const w = this.cfg.world.pipeWidth;
    const px1 = PLAYER_X - this.body / 2;
    const px2 = PLAYER_X + this.body / 2;
    const py1 = this.py - this.body / 2;
    const py2 = this.py + this.body / 2;

    for (const pipe of this.level.pattern) {
      const sx = PLAYER_X + (pipe.x - this.dist);
      if (sx + w < px1) {
        if (!pipe._scored) { pipe._scored = true; this.passed++; sfx.milestone(); }
        continue;
      }
      if (sx > px2) continue;
      const cy = this.gapCentre(pipe);
      if (py1 < cy - pipe.gap / 2 || py2 > cy + pipe.gap / 2) return this.die('pipe');
    }
  }

  updateHud() {
    this.hud.setProgress(this.passed / this.level.targetPipes);
    this.hud.setRight(`${this.passed} / ${this.level.targetPipes} PIPES`);
  }

  die(cause) {
    if (this.dead) return;
    this.dead = true;
    this.deaths++;
    save.recordDeath();
    sfx.crash();
    this.cameras.main.shake(220, 0.012);
    this.player.setTint(0xff3b30);
    telemetry.levelDeath(this.levelIndex);
    telemetry.sessionEnd({ level: this.levelIndex, score: this.passed, durationS: Math.round(this.elapsed) });
    this.time.delayedCall(620, () =>
      this.scene.start('Result', {
        outcome: 'lose', mode: 'level', level: this.levelIndex,
        score: this.passed, target: this.level.targetPipes,
        unit: 'pipes', deaths: this.deaths, cause,
      })
    );
  }

  win() {
    if (this.finished) return;
    this.finished = true;
    sfx.win();
    const stars = save.starsFor(this.deaths);
    const res = save.recordWin(this.levelIndex, stars, this.cfg.progression.endlessUnlockAt);
    telemetry.levelClear(this.levelIndex);
    telemetry.sessionEnd({ level: this.levelIndex, score: this.passed, durationS: Math.round(this.elapsed) });
    this.time.delayedCall(420, () =>
      this.scene.start('Result', {
        outcome: 'win', mode: 'level', level: this.levelIndex,
        score: this.passed, target: this.level.targetPipes,
        unit: 'pipes', deaths: this.deaths, stars, unlockedEndless: res.unlockedEndless,
      })
    );
  }
}

/** Textures this genre needs beyond the shared set. */
export function buildTextures(scene, cfg) {
  const p = cfg.theme.palette;
  const size = cfg.player.size;
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const r = Math.max(4, Math.round(size * 0.3));
  g.fillStyle(shade(p.player, -0.45), 1);
  g.fillRoundedRect(2, 2, size, size, r);
  g.fillStyle(asInt(p.player), 1);
  g.fillRoundedRect(0, 0, size, size, r);
  // a wing and an eye, so rotation reads as banking
  g.fillStyle(shade(p.player, -0.5), 1);
  g.fillEllipse(size * 0.35, size * 0.62, size * 0.5, size * 0.28);
  g.fillStyle(asInt(p.accent), 1);
  g.fillCircle(size * 0.72, size * 0.36, Math.max(2, size * 0.1));
  g.fillStyle(shade(p.obstacle, 0.1), 1);
  g.fillTriangle(size * 0.86, size * 0.44, size * 1.02, size * 0.5, size * 0.86, size * 0.58);
  g.generateTexture('player', size + 3, size + 3);
  g.destroy();
}
