/**
 * rhythm_dash runtime.
 *
 * The defining feel of this genre is the ABSENCE of interface. There is no level select and no
 * death screen: you die, and you are already running again a third of a second later. Every
 * frame spent on a menu is a frame the player did not spend learning the layout, so the only
 * chrome here is an attempt counter, a completion bar and a pause button.
 *
 * ── WHAT IS PROOF-CRITICAL, AND WHAT IS DECORATION ──────────────────────────
 *
 * `stepSim()` is the simulation, and it is verified: the generator's solver integrates the
 * exact same equations at the exact same `level.simDt`, in the same order, against the same
 * collision boxes. Changing gravity handling, the timestep, the collision test or the jump
 * impulse here silently invalidates every "this level is finishable" claim the product makes.
 *
 * Everything else in this file — trail, squash, camera drift, fragments, flash, vignette,
 * speed lines, pulse, and the whole of `drawWorld()` — is presentation. It reads position and
 * never writes it. That split is deliberate: it means the game can be made to feel much better
 * without ever touching what was proven.
 *
 * The one input change that IS in the simulation path is the jump buffer, and it is safe in
 * the only direction that matters: it can make a jump fire on the frame the cube lands, never
 * before it. The solver assumes jumps happen while grounded, so a buffer is strictly more
 * permissive than what was proven.
 *
 * ── THE READABILITY CONTRACT ────────────────────────────────────────────────
 *
 * At 600+ px/s the player has about a fifth of a second to classify a shape, so shape and
 * colour have to mean exactly one thing each. The rules this file holds to:
 *
 *   SAFE      ground colour, topped with a bright `accent` lip. The ground has that lip and so
 *             does every platform, so "accent lip = I can stand on this" is learnable in one
 *             level and never contradicted.
 *   LETHAL    `obstacle` colour, dark outline, and a hazard motif — spikes are triangles,
 *             blocks carry diagonal slashes so they cannot be mistaken for a low platform.
 *   BACKDROP  never touches the ground line, never solid, never triangular. Hollow outlined
 *             squares and diagonal hatching, well under half opacity.
 *
 * That last rule is why the parallax silhouettes are gone. They drew solid triangles and
 * rectangles anchored on `groundTop` — the same silhouette, rising from the same line, as a
 * spike and a block. Colour separated them; shape did not, and shape is what the eye resolves
 * first. Backgrounds here are now hollow and float clear of the floor.
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
/** Outline weight on foreground geometry. The single biggest legibility win in the scene. */
const STROKE = 2.5;
/** Ground tile height. Covers the schema's 150px maximum groundHeight plus bleed, so the
 *  bright lip never repeats partway down the band. */
const GROUND_TEX_H = 224;
/** Ceiling tile height. Same idea for the 90px maximum ceilingHeight. */
const CEIL_TEX_H = 160;

/** Pause button hit box, in screen space (the HUD does not scroll with the camera). */
const PAUSE_BTN = new Phaser.Geom.Rectangle(VIEW_W - 48, 10, 38, 38);
/** Pause-overlay buttons, in screen space. Order matters only for layout. */
const MENU_W = 220;
const MENU_X = (VIEW_W - MENU_W) / 2;
const MENU_BTNS = [
  { id: 'resume', label: 'RESUME', y: 226 },
  { id: 'restart', label: 'RESTART LEVEL', y: 278 },
  { id: 'quit', label: 'QUIT', y: 330 },
].map((b) => ({ ...b, rect: new Phaser.Geom.Rectangle(MENU_X, b.y, MENU_W, 40) }));

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
    /** Near-black pulled from the background, so outlines sit in the theme rather than on top
     *  of it. Every foreground shape is stroked with this. */
    this.ink = shade(pal.bg, -0.6);

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
    this.paused = false;
    this.spin = 0;
    this.spinTarget = 0;
    this.squash = 1;
    this.camY = 0;
    this.trail = [];
    this.beatIndex = -1;
    this.jumpSpan = this.estimateJumpSpan();

    this.cameras.main.setBackgroundColor(pal.bg);
    this.buildBackground();

    /** Safe geometry: gaps, platforms, jump pads. Below the hazards on purpose. */
    this.worldGfx = this.add.graphics().setDepth(8);
    this.trailGfx = this.add.graphics().setDepth(11);
    /** Lethal geometry, drawn separately so it can carry its own glow without lighting up
     *  the things you are allowed to stand on. */
    this.hazardGfx = this.add.graphics().setDepth(12);
    /**
     * Origin is the CENTRE, not the feet.
     *
     * With origin (0.5, 1) — which is the natural choice when you are positioning by `feetY` —
     * Phaser rotates the sprite about the bottom-centre point. That is fine while the cube is
     * upright and catastrophic the moment it is not: at a quarter turn the drawn cube swings
     * 18px sideways and 18px down, so it lands visibly shifted and half-sunk into the floor,
     * 25px from where its hitbox actually is. Since `spinTarget` snaps to a quarter turn on
     * every landing, that is the state the cube spends most of its life in after the first jump.
     *
     * Rotating about the centre costs one line in updateVisuals: the y position has to account
     * for the squash so the feet stay planted. See the comment there.
     */
    this.player = this.add.image(PLAYER_X, this.feetY, 'cube').setOrigin(0.5, 0.5).setDepth(14);

    this.applyGlow();

    this.dust = this.add.particles(0, 0, 'dot', {
      speed: { min: 40, max: 130 }, lifespan: 320, angle: { min: 160, max: 20 },
      scale: { start: 0.8, end: 0 }, alpha: { start: 0.7, end: 0 },
      quantity: 3, emitting: false, tint: asInt(pal.accent),
    }).setDepth(13);

    this.frags = this.add.particles(0, 0, 'frag', {
      speed: { min: 90, max: 340 }, lifespan: 620, gravityY: 700,
      scale: { start: 1, end: 0.2 }, alpha: { start: 1, end: 0 },
      rotate: { min: -240, max: 240 }, quantity: 14, emitting: false,
      tint: [asInt(pal.player), shade(pal.player, 0.3), shade(pal.player, -0.3)],
    }).setDepth(15);

    this.buildOverlays();
    this.buildHud();
    this.buildPauseUi();
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

  /**
   * Bloom on the cube and the hazards, which is most of what separates "flat vector shapes" from
   * the lit, neon read the genre is known for. WebGL only — on the canvas fallback the outlines
   * and inner highlights carry the look on their own, so this is a pure enhancement.
   */
  applyGlow() {
    if (this.sys.game.renderer?.type !== Phaser.WEBGL) return;
    try {
      this.player.postFX.addGlow(asInt(this.pal.player), 1.5, 0, false, 0.1, 8);
      this.hazardGfx.postFX.addGlow(asInt(this.pal.obstacle), 1.1, 0, false, 0.1, 7);
    } catch {
      /* older renderer or FX disabled — the art does not depend on this */
    }
  }

  // ── presentation build ───────────────────────────────────────────────────

  buildBackground() {
    const cfg = this.cfg;
    const pal = this.pal;
    this.layers = [];

    /**
     * The camera lifts on a jump, which drags every scroll-factor-1 layer down with it. Sky
     * layers therefore run from -BLEED to groundTop + BLEED rather than exactly filling the
     * sky: the overhang is hidden behind the ground band at the bottom and off-screen at the
     * top, and no strip of raw background colour can open up mid-jump.
     */
    const BLEED = 60;
    const skyH = this.groundTop + BLEED * 2;

    /**
     * Sky: a saturated wash that brightens toward the horizon.
     *
     * It is built from `bgAccent` lifted well above its palette value rather than from `bg`.
     * The palettes are tuned so `bg` is nearly black — right for the genres that fill the
     * screen with sprites, wrong here, where a near-black field makes the whole frame read as
     * murky and flattens the one thing this genre trades on, which is bold saturated colour.
     * Lifting it in the scene keeps the palettes untouched for everyone else.
     */
    const sky = this.add.graphics().setDepth(0);
    const bands = 64;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      sky.fillStyle(shade(pal.bgAccent, 0.08 + t * t * 0.34), 1);
      sky.fillRect(0, -BLEED + Math.floor((skyH / bands) * i), VIEW_W, Math.ceil(skyH / bands) + 1);
    }

    // Diagonal hatching. Low frequency and low contrast — enough to show the sky is moving,
    // not enough to compete with anything in the foreground.
    if (cfg.world.parallax >= 1) {
      this.layers.push({
        s: this.add.tileSprite(0, -BLEED, VIEW_W, skyH, 'dash_diag')
          .setOrigin(0, 0).setAlpha(0.13).setDepth(1),
        f: 0.18,
      });
    }
    if (cfg.world.parallax >= 2) {
      // One big hollow square per 400px tile, so roughly half a dozen faint outlines drift
      // across the screen. An earlier pass put three per 240px tile and the sky turned into
      // visual noise that the eye kept trying to parse as gameplay.
      this.layers.push({
        s: this.add.tileSprite(0, -BLEED, VIEW_W, Math.max(80, this.groundTop - 30) + BLEED, 'dash_shapes')
          .setOrigin(0, 0).setAlpha(0.13).setDepth(2),
        f: 0.34,
      });
    }
    if (cfg.world.parallax >= 3) {
      this.layers.push({
        s: this.add.tileSprite(0, -BLEED, VIEW_W, skyH, 'dash_diag')
          .setOrigin(0, 0).setAlpha(0.09).setDepth(3).setFlipY(true),
        f: 0.6,
      });
    }

    if (cfg.world.showGrid) {
      this.grid = this.add
        .tileSprite(0, -BLEED, VIEW_W, skyH, 'dash_grid')
        .setOrigin(0, 0).setAlpha(0.18).setDepth(4);
    }

    // Beat flash. Its own layer so pulsing does not disturb the sky gradient underneath.
    this.pulse = this.add.graphics().setDepth(5);
    this.pulse.fillStyle(asInt(pal.accent), 1);
    this.pulse.fillRect(0, -BLEED, VIEW_W, skyH);
    this.pulse.setAlpha(0);

    this.ground = this.add
      .tileSprite(0, this.groundTop, VIEW_W, VIEW_H - this.groundTop + BLEED, 'dash_ground')
      .setOrigin(0, 0).setDepth(7);
    if (this.ceil > 0) {
      // The ceiling's lip has to face down, so it uses a mirrored texture rather than a flipped
      // sprite: flipping a tileSprite shorter than its tile would scroll the lip out of view.
      // tilePositionY parks the band on the bottom rows, where the lip lives.
      this.ceilBand = this.add
        .tileSprite(0, -BLEED, VIEW_W, this.ceil + BLEED, 'dash_ceil')
        .setOrigin(0, 0).setDepth(7);
      this.ceilBand.tilePositionY = CEIL_TEX_H - (this.ceil + BLEED);
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

    const v = this.add.graphics().setDepth(20).setScrollFactor(0);
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

    this.speedGfx = this.add.graphics().setDepth(6);
    this.speedLines = Array.from({ length: 14 }, (_, i) => ({
      y: 40 + ((i * 97) % Math.max(60, this.groundTop - 60)),
      len: 40 + ((i * 53) % 90),
      x: (i * 137) % VIEW_W,
      spd: 1.4 + ((i * 31) % 10) / 10,
    }));
  }

  buildHud() {
    const pal = this.pal;
    // scrollFactor 0 throughout: the camera drifts vertically on a jump, and a HUD that bobs
    // with it looks like a bug. It also means pointer coordinates test directly against the
    // pause button's screen rect with no camera maths.
    this.hudBar = this.add.graphics().setDepth(50).setScrollFactor(0);
    this.hudPct = this.add
      .text(VIEW_W / 2, 22, '0%', { fontFamily: FONT_DISPLAY, fontSize: '19px', color: pal.text })
      .setOrigin(0.5).setDepth(51).setScrollFactor(0);
    this.hudLevel = this.add
      .text(16, 16, `LV ${this.levelIndex}  ${String(this.level.name).toUpperCase()}`, {
        fontFamily: FONT_DISPLAY, fontSize: '12px', color: pal.text,
      }).setAlpha(0.7).setDepth(51).setScrollFactor(0);
    // Sits left of the pause button rather than in the corner, so the two never overlap.
    this.hudAttempt = this.add
      .text(VIEW_W - 58, 16, `ATTEMPT ${this.attempts}`, {
        fontFamily: FONT_BODY, fontSize: '14px', color: pal.accent,
      }).setOrigin(1, 0).setDepth(51).setScrollFactor(0);

    // Pops on a retry so the rising count is felt, not just read.
    if (this.attempts > 1) {
      this.hudAttempt.setScale(1.35);
      this.tweens.add({ targets: this.hudAttempt, scale: 1, duration: 240, ease: 'Back.easeOut' });
    }

    if (this.levelIndex === 1 && this.attempts === 1) {
      this.hint = this.add
        .text(VIEW_W / 2, this.groundTop - 96, 'HOLD TO JUMP', {
          fontFamily: FONT_DISPLAY, fontSize: '16px', color: pal.text,
        }).setOrigin(0.5).setAlpha(0).setDepth(51).setScrollFactor(0);
      this.tweens.add({ targets: this.hint, alpha: 0.75, duration: 500 });
      this.tweens.add({
        targets: this.hint, y: this.groundTop - 104,
        duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    }
  }

  // ── pause ────────────────────────────────────────────────────────────────

  buildPauseUi() {
    const pal = this.pal;

    this.pauseBtn = this.add.graphics().setDepth(52).setScrollFactor(0);
    this.drawPauseBtn(false);

    // Built once and hidden, rather than created and destroyed per pause: nothing here is
    // per-attempt state, and rebuilding text objects on a keypress is a stutter for no reason.
    this.pauseUi = this.add.container(0, 0).setDepth(70).setScrollFactor(0, 0, true).setVisible(false);

    const dim = this.add.graphics();
    dim.fillStyle(asInt(pal.bg), 0.82);
    dim.fillRect(0, 0, VIEW_W, VIEW_H);
    this.pauseUi.add(dim);

    this.pauseUi.add(this.add
      .text(VIEW_W / 2, 158, 'PAUSED', {
        fontFamily: FONT_DISPLAY, fontSize: '46px', color: pal.text,
      }).setOrigin(0.5));
    this.pauseUi.add(this.add
      .text(VIEW_W / 2, 196, `LV ${this.levelIndex}  ·  ${String(this.level.name).toUpperCase()}  ·  ATTEMPT ${this.attempts}`, {
        fontFamily: FONT_BODY, fontSize: '13px', color: pal.accent,
      }).setOrigin(0.5).setAlpha(0.8));

    this.menuGfx = this.add.graphics();
    this.pauseUi.add(this.menuGfx);
    for (const b of MENU_BTNS) {
      this.pauseUi.add(this.add
        .text(VIEW_W / 2, b.y + 20, b.label, {
          fontFamily: FONT_DISPLAY, fontSize: '15px', color: pal.text,
        }).setOrigin(0.5));
    }
    this.drawMenu(null);

    this.pauseUi.add(this.add
      .text(VIEW_W / 2, VIEW_H - 40, 'P OR ESC TO RESUME', {
        fontFamily: FONT_BODY, fontSize: '11px', color: pal.text,
      }).setOrigin(0.5).setAlpha(0.4));
  }

  drawPauseBtn(hot) {
    const g = this.pauseBtn;
    const r = PAUSE_BTN;
    g.clear();
    g.fillStyle(this.ink, hot ? 0.75 : 0.45);
    g.fillRoundedRect(r.x, r.y, r.width, r.height, 9);
    g.lineStyle(2, asInt(this.pal.text), hot ? 0.85 : 0.45);
    g.strokeRoundedRect(r.x, r.y, r.width, r.height, 9);
    g.fillStyle(asInt(this.pal.text), hot ? 1 : 0.8);
    if (this.paused) {
      // A play glyph while paused, so the button always shows what it will do next.
      g.fillTriangle(r.x + 14, r.y + 11, r.x + 27, r.y + 19, r.x + 14, r.y + 27);
    } else {
      g.fillRect(r.x + 13, r.y + 11, 4.5, 16);
      g.fillRect(r.x + 20.5, r.y + 11, 4.5, 16);
    }
  }

  drawMenu(hotId) {
    const g = this.menuGfx;
    g.clear();
    for (const b of MENU_BTNS) {
      const hot = b.id === hotId;
      g.fillStyle(hot ? asInt(this.pal.accent) : this.ink, hot ? 0.22 : 0.6);
      g.fillRoundedRect(b.rect.x, b.rect.y, b.rect.width, b.rect.height, 10);
      g.lineStyle(2, hot ? asInt(this.pal.accent) : asInt(this.pal.text), hot ? 1 : 0.35);
      g.strokeRoundedRect(b.rect.x, b.rect.y, b.rect.width, b.rect.height, 10);
    }
  }

  /** Pausing is only meaningful mid-run; during the death or win sequence it would strand the
   *  scene between states with a timer already scheduled. */
  canPause() {
    return this.running && !this.dead && !this.finished;
  }

  togglePause() {
    if (this.paused) return this.resumeGame();
    if (!this.canPause()) return;
    this.paused = true;
    this.pauseUi.setVisible(true);
    this.drawPauseBtn(false);
    this.drawMenu(null);
    // Freeze the decoration too. update() already stops, but tweens and emitters run off their
    // own clocks and a bobbing hint behind a pause menu looks unfinished.
    this.tweens.pauseAll();
    this.dust.pause();
    this.holding = false;
    // A press remembered across an arbitrarily long pause would fire a jump the player made a
    // minute ago, so the buffer is dropped rather than carried.
    this.bufferedAt = -1;
    unlockAudio();
  }

  resumeGame() {
    if (!this.paused) return;
    this.paused = false;
    this.pauseUi.setVisible(false);
    this.drawPauseBtn(false);
    this.tweens.resumeAll();
    this.dust.resume();
    // Drop whatever wall-clock time the pause consumed instead of feeding it to the simulation.
    this.acc = 0;
  }

  restartLevel() {
    this.paused = false;
    this.tweens.resumeAll();
    this.scene.start('Play', {
      level: this.levelIndex, attempts: this.attempts + 1, bestPct: this.bestPct,
    });
  }

  // ── input ────────────────────────────────────────────────────────────────

  /**
   * One pointer path for the whole scene.
   *
   * Phaser fires the scene-level `pointerdown` for every press regardless of what is under it,
   * and does not guarantee ordering against GameObject handlers — so hit-testing the HUD rects
   * here, before anything else, is what keeps tapping PAUSE from also jumping.
   */
  bindInput() {
    const press = (pointer) => {
      if (pointer && Phaser.Geom.Rectangle.Contains(PAUSE_BTN, pointer.x, pointer.y)) {
        this.togglePause();
        return;
      }
      if (this.paused) {
        if (!pointer) return;
        const hit = MENU_BTNS.find((b) => Phaser.Geom.Rectangle.Contains(b.rect, pointer.x, pointer.y));
        if (hit?.id === 'resume') this.resumeGame();
        else if (hit?.id === 'restart') this.restartLevel();
        else if (hit?.id === 'quit') this.quit();
        return;
      }
      unlockAudio();
      this.holding = true;
      // Remember the press even if we are mid-air. It fires the moment we land.
      this.bufferedAt = this.elapsed;
      this.tryJump();
    };
    const release = () => { this.holding = false; };

    this.input.on('pointerdown', press);
    this.input.on('pointerup', release);
    this.input.on('pointermove', (pointer) => {
      this.drawPauseBtn(Phaser.Geom.Rectangle.Contains(PAUSE_BTN, pointer.x, pointer.y));
      if (this.paused) {
        const hit = MENU_BTNS.find((b) => Phaser.Geom.Rectangle.Contains(b.rect, pointer.x, pointer.y));
        this.drawMenu(hit?.id ?? null);
      }
    });

    for (const k of ['SPACE', 'UP', 'W']) {
      this.input.keyboard?.on(`keydown-${k}`, () => press(null));
      this.input.keyboard?.on(`keyup-${k}`, release);
    }
    // ESC used to quit outright. It now pauses, which is what a player reaching for it during a
    // run actually wants; quitting is one click away on the menu it opens.
    this.input.keyboard?.on('keydown-ESC', () => this.togglePause());
    this.input.keyboard?.on('keydown-P', () => this.togglePause());
  }

  quit() {
    this.paused = false;
    this.tweens.resumeAll();
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

    this.player.setRotation(this.spin);
    this.player.setScale(1 / this.squash, this.squash);
    // Centre origin, so the sprite's own half-height moves as it squashes. Placing the centre
    // half a squashed body above feetY keeps the feet pinned to the surface through the whole
    // squash-and-stretch, which is the only reason the bottom-origin version was tempting.
    this.player.y = this.feetY - (this.cfg.player.size * this.squash) / 2;

    this.trail.unshift({ y: this.feetY, r: this.spin, d: this.dist });
    if (this.trail.length > TRAIL_LEN) this.trail.pop();
    this.drawTrail(false);

    // Background pulse on the jump-rhythm beat.
    if (this.cfg.world.showPulse) {
      const beat = Math.floor(this.dist / this.jumpSpan);
      if (beat !== this.beatIndex) {
        this.beatIndex = beat;
        this.pulse.setAlpha(0.05 + 0.05 * this.intensity);
        this.tweens.add({ targets: this.pulse, alpha: 0, duration: 240 });
        if (this.intensity > 0.45) dashSfx.beat();
      }
    }

    this.drawSpeedLines(dtReal);
  }

  /**
   * Motion ghosts — a shrinking, fading copy of the cube at each of the last few positions.
   *
   * Two things this has to get right, both of which it previously got wrong and which together
   * made the trail read as a detached blob floating off the cube's shoulder rather than as
   * motion:
   *
   *   • Position comes from the world distance the sample was taken at, not from a fixed
   *     per-index pixel offset. The cube is pinned to PLAYER_X while the world scrolls past,
   *     so a ghost belongs wherever the cube actually was — `PLAYER_X - (dist - p.d)`. Fixed
   *     spacing detached the trail from the real path and did not respond to level speed.
   *   • Ghosts carry the rotation of the frame they were recorded in, and shrink about their
   *     own centre. Axis-aligned squares bottom-aligned on feetY drifted away from a spinning
   *     cube and pooled near the floor.
   */
  drawTrail(frozen) {
    const g = this.trailGfx;
    g.clear();
    if (!this.trail.length) return;
    const size = this.cfg.player.size;
    for (let i = this.trail.length - 1; i >= 1; i--) {
      const p = this.trail[i];
      const t = 1 - i / this.trail.length;
      const h = (size * (0.55 + t * 0.35)) / 2;
      const cx = PLAYER_X - (this.dist - p.d);
      const cy = p.y - size / 2;
      const c = Math.cos(p.r);
      const s = Math.sin(p.r);
      g.fillStyle(asInt(this.pal.player), (frozen ? 0.1 : 0.22) * t);
      g.fillPoints([
        { x: cx + h * (-c + s), y: cy + h * (-s - c) },
        { x: cx + h * (c + s), y: cy + h * (s - c) },
        { x: cx + h * (c - s), y: cy + h * (s + c) },
        { x: cx + h * (-c - s), y: cy + h * (-s + c) },
      ], true);
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

  /**
   * Foreground geometry, redrawn each frame.
   *
   * Split across two Graphics objects on purpose: `worldGfx` holds everything the cube may
   * touch safely, `hazardGfx` holds everything that kills it, and only the second one carries
   * the hazard glow. See the readability contract in the file header.
   */
  drawWorld() {
    const safe = this.worldGfx;
    const haz = this.hazardGfx;
    const pal = this.pal;
    const ink = this.ink;
    safe.clear();
    haz.clear();
    const sx = (wx) => PLAYER_X + (wx - this.dist);

    // gaps: cut the ground away and darken the shaft, so a pit reads as depth rather than as a
    // differently-coloured floor tile
    for (const gp of this.level.gaps) {
      const x = sx(gp.x);
      if (x > VIEW_W + 60 || x + gp.w < -60) continue;
      safe.fillStyle(shade(pal.bg, -0.35), 1);
      safe.fillRect(x, this.groundTop, gp.w, VIEW_H - this.groundTop);
      safe.fillStyle(ink, 1);
      safe.fillRect(x - 3, this.groundTop, 3, 14);
      safe.fillRect(x + gp.w, this.groundTop, 3, 14);
    }

    // platforms — ground colour, and wearing the same bright lip as the floor. That lip is the
    // whole "you can stand here" signal, so it is drawn at the same weight as the ground's.
    for (const p of this.level.platforms) {
      const x = sx(p.x);
      if (x > VIEW_W + 80 || x + p.w < -80) continue;
      const y = this.groundTop - p.h;
      safe.fillStyle(shade(pal.ground, -0.55), 1);
      safe.fillRect(x + 4, y + 4, p.w, p.h);
      safe.fillStyle(shade(pal.ground, -0.1), 1);
      safe.fillRect(x, y, p.w, p.h);
      safe.fillStyle(shade(pal.ground, -0.4), 1);
      for (let i = x + 8; i < x + p.w - 4; i += 14) safe.fillRect(i, y + 10, 2, Math.max(0, p.h - 14));
      safe.fillStyle(asInt(pal.accent), 1);
      safe.fillRect(x, y, p.w, 5);
      safe.lineStyle(STROKE, ink, 1);
      safe.strokeRect(x, y, p.w, p.h);
    }

    // jump pads — accent coloured, because they help you
    for (const p of this.level.pads) {
      const x = sx(p.x);
      if (x > VIEW_W + 40 || x + p.w < -40) continue;
      const bob = Math.sin(this.elapsed * 7) * 2;
      const tipY = this.groundTop - 15 + bob;
      safe.fillStyle(shade(pal.accent, -0.45), 1);
      safe.fillTriangle(x, this.groundTop, x + p.w / 2, tipY, x + p.w, this.groundTop);
      safe.fillStyle(asInt(pal.accent), 1);
      safe.fillTriangle(x + 4, this.groundTop, x + p.w / 2, tipY + 5, x + p.w - 4, this.groundTop);
      safe.lineStyle(2, ink, 1);
      safe.strokeTriangle(x, this.groundTop, x + p.w / 2, tipY, x + p.w, this.groundTop);
    }

    // hazards
    for (const o of this.level.obstacles) {
      const x = sx(o.x);
      if (x > VIEW_W + 70 || x + o.w < -70) continue;

      if (o.kind === 'spike') {
        const base = this.groundTop;
        const tip = base - o.h;
        const mid = x + o.w / 2;
        haz.fillStyle(shade(pal.obstacle, -0.35), 1);
        haz.fillTriangle(x, base, mid, tip, x + o.w, base);
        // Inner face offset toward the light, which is what gives a flat triangle a facet.
        haz.fillStyle(asInt(pal.obstacle), 1);
        haz.fillTriangle(x + 5, base - 2, mid, tip + 7, x + o.w - 5, base - 2);
        haz.fillStyle(shade(pal.obstacle, 0.45), 1);
        haz.fillTriangle(mid - 4, base - 4, mid, tip + 5, mid + 1, base - 4);
        haz.lineStyle(STROKE, ink, 1);
        haz.strokeTriangle(x, base, mid, tip, x + o.w, base);
      } else if (o.kind === 'block') {
        const y = this.groundTop - o.h;
        haz.fillStyle(shade(pal.obstacle, -0.4), 1);
        haz.fillRect(x, y, o.w, o.h);
        haz.fillStyle(asInt(pal.obstacle), 1);
        haz.fillRect(x + 5, y + 5, o.w - 10, o.h - 10);
        // Diagonal slashes. A flat-topped rectangle at ground level is the exact silhouette of
        // a low platform, so the block needs a marking that says "not a floor" on its own.
        // Each slash is the 45° line through (ix+d, iy) clipped to the inner face.
        const ix = x + 5;
        const iy = y + 5;
        const iw = o.w - 10;
        const ih = o.h - 10;
        haz.lineStyle(3, shade(pal.obstacle, -0.6), 1);
        for (let d = -ih; d < iw; d += 13) {
          const t0 = Math.max(0, -d);
          const t1 = Math.min(ih, iw - d);
          if (t1 > t0) haz.lineBetween(ix + d + t0, iy + t0, ix + d + t1, iy + t1);
        }
        haz.fillStyle(shade(pal.obstacle, 0.5), 0.9);
        haz.fillRect(x + 5, y + 5, o.w - 10, 2);
        haz.lineStyle(STROKE, ink, 1);
        haz.strokeRect(x, y, o.w, o.h);
      } else if (o.kind === 'ceil') {
        const mid = x + o.w / 2;
        haz.fillStyle(shade(pal.obstacle, -0.35), 1);
        haz.fillTriangle(x, this.ceil, mid, this.ceil + o.h, x + o.w, this.ceil);
        haz.fillStyle(asInt(pal.obstacle), 1);
        haz.fillTriangle(x + 5, this.ceil + 2, mid, this.ceil + o.h - 7, x + o.w - 5, this.ceil + 2);
        haz.lineStyle(STROKE, ink, 1);
        haz.strokeTriangle(x, this.ceil, mid, this.ceil + o.h, x + o.w, this.ceil);
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
      }).setOrigin(0.5).setDepth(60).setScrollFactor(0).setScale(0.7);
    this.tweens.add({ targets: label, scale: 1.1, duration: 200, ease: 'Back.easeOut' });
    this.tweens.add({ targets: label, alpha: 0, duration: RESTART_MS - 120, delay: 120 });

    if (best > pct && best > 0) {
      this.add
        .text(VIEW_W / 2, VIEW_H / 2 + 46, `BEST ${best}%`, {
          fontFamily: FONT_BODY, fontSize: '15px', color: this.pal.text,
        }).setOrigin(0.5).setAlpha(0.6).setDepth(60).setScrollFactor(0);
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
      }).setOrigin(0.5).setDepth(60).setScrollFactor(0).setScale(0.75);
    this.tweens.add({ targets: title, scale: 1, duration: 280, ease: 'Back.easeOut' });

    this.add
      .text(VIEW_W / 2, VIEW_H / 2 + 30, `${this.attempts} ATTEMPT${this.attempts > 1 ? 'S' : ''}  ·  ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`, {
        fontFamily: FONT_BODY, fontSize: '17px', color: this.pal.text,
      }).setOrigin(0.5).setAlpha(0.9).setDepth(60).setScrollFactor(0);

    if (!last) {
      this.add
        .text(VIEW_W / 2, VIEW_H / 2 + 66, `NEXT: ${String(this.cfg.levels[this.levelIndex].name).toUpperCase()}`, {
          fontFamily: FONT_BODY, fontSize: '13px', color: this.pal.accent,
        }).setOrigin(0.5).setAlpha(0.65).setDepth(60).setScrollFactor(0);
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

/**
 * Every sprite in this genre is drawn at boot from the seven palette colours — no image files,
 * so any theme the generator invents renders immediately and the APK stays under half a megabyte.
 *
 * Texture keys are prefixed `dash_` where they would otherwise collide with the runner's and
 * the flyer's: those genres generate their own `ground`, `par_far` and `par_near` under the same
 * names, and only one genre is ever loaded at a time, but relying on that is a trap for whoever
 * next builds a scene that mixes them.
 */
export function buildTextures(scene, cfg) {
  const p = cfg.theme.palette;
  const size = cfg.player.size;
  const ink = shade(p.bg, -0.6);
  const mk = () => scene.make.graphics({ x: 0, y: 0, add: false });

  // ── the cube ──────────────────────────────────────────────────────────────
  // Rounded square, hard dark outline, bright inner face and two eyes. The outline is what
  // keeps it separate from a busy background; the eyes are what make players call it "him".
  let g = mk();
  const pad = 3;
  const r = Math.max(3, Math.round(size * 0.16));
  g.fillStyle(ink, 1);
  g.fillRoundedRect(0, 0, size, size, r);
  g.fillStyle(shade(p.player, -0.35), 1);
  g.fillRoundedRect(pad, pad, size - pad * 2, size - pad * 2, r - 1);
  g.fillStyle(asInt(p.player), 1);
  g.fillRoundedRect(pad, pad, size - pad * 2, size - pad * 2 - 3, r - 1);
  // rim light along the top-left, so rotation is legible frame to frame
  g.fillStyle(shade(p.player, 0.55), 0.9);
  g.fillRect(pad + 3, pad + 2, size - pad * 2 - 6, 2.5);
  g.fillRect(pad + 2, pad + 3, 2.5, size - pad * 2 - 8);
  // eyes
  g.fillStyle(ink, 1);
  g.fillRoundedRect(size * 0.27, size * 0.34, size * 0.15, size * 0.2, 2);
  g.fillRoundedRect(size * 0.58, size * 0.34, size * 0.15, size * 0.2, 2);
  g.fillStyle(shade(p.player, 0.75), 0.85);
  g.fillRect(size * 0.29, size * 0.37, size * 0.05, size * 0.06);
  g.fillRect(size * 0.6, size * 0.37, size * 0.05, size * 0.06);
  g.generateTexture('cube', size, size);
  g.destroy();

  // death fragment
  g = mk();
  const fs = Math.max(4, Math.round(size / 5));
  g.fillStyle(0xffffff, 1);
  g.fillRect(0, 0, fs, fs);
  g.generateTexture('frag', fs, fs);
  g.destroy();

  // ── ground and ceiling ────────────────────────────────────────────────────
  // One bright accent lip on a dark saturated band. That lip is the safety signal every
  // platform repeats, so it is the most contrasted thing on the floor.
  //
  // The ceiling is the same band mirrored, generated as its own texture rather than drawn with
  // setFlipY: a flipped tileSprite shorter than its tile shows the wrong rows and the lip
  // disappears. `dir` is +1 for the floor and -1 for the ceiling.
  const TILE = 96;
  for (const [name, H, dir] of [['dash_ground', GROUND_TEX_H, 1], ['dash_ceil', CEIL_TEX_H, -1]]) {
    g = mk();
    // band() maps "distance from the lip" to a row, so one set of coordinates draws both.
    const band = (d, h) => g.fillRect(0, dir > 0 ? d : H - d - h, TILE, h);
    const box = (d, s, x) => g.strokeRect(x, dir > 0 ? d : H - d - s, s, s);

    // A solid, saturated slab. The floor should look like a surface with mass, not like the
    // bottom of the screen fading out.
    g.fillStyle(shade(p.ground, -0.22), 1);
    g.fillRect(0, 0, TILE, H);
    // Top face, a shade brighter, so the edge you land on catches the light.
    g.fillStyle(shade(p.ground, 0.06), 1);
    band(9, 26);
    // Repeating outlined boxes down the slab — the pattern reads as structure at speed rather
    // than as noise, and it gives the eye something to measure scrolling speed against.
    g.lineStyle(2, shade(p.ground, -0.4), 1);
    for (let d = 44; d < H - 20; d += 44) {
      box(d, 26, 12);
      box(d, 26, 58);
    }
    g.fillStyle(shade(p.ground, -0.38), 1);
    for (let d = 38; d < H; d += 44) band(d, 2);
    // The lip: a dark seam under a bright accent line, with a soft bloom just inside it.
    g.fillStyle(shade(p.accent, -0.35), 0.55);
    band(9, 5);
    g.fillStyle(ink, 1);
    band(5, 4);
    g.fillStyle(asInt(p.accent), 1);
    band(0, 5);
    g.generateTexture(name, TILE, H);
    g.destroy();
  }

  // ── background grid ───────────────────────────────────────────────────────
  g = mk();
  g.lineStyle(1, shade(p.bgAccent, 0.55), 0.5);
  for (let i = 0; i <= 64; i += 32) {
    g.lineBetween(i, 0, i, 64);
    g.lineBetween(0, i, 64, i);
  }
  g.generateTexture('dash_grid', 64, 64);
  g.destroy();

  // ── background hatching ───────────────────────────────────────────────────
  // 45° stripes on a 128px tile with a 64px period. The period divides the tile height, so a
  // stripe leaving the bottom edge lines up with the one entering the top.
  //
  // Drawn as filled quads that overhang the tile on every side, NOT as strokes. A stroked line
  // ends in a square cap that gets antialiased against the transparent tile edge, and two of
  // those meeting across a seam leave a visible hairline — which showed up as a horizontal
  // scar across the sky every 128 pixels. Overhanging fills are clipped by the texture bounds
  // instead of feathered into them, so the seam disappears.
  g = mk();
  const D = 128;
  const W = 32;
  g.fillStyle(shade(p.bgAccent, 0.5), 1);
  for (let x0 = -3 * D; x0 <= 3 * D; x0 += 64) {
    g.fillPoints([
      { x: x0 - D, y: -D }, { x: x0 + W - D, y: -D },
      { x: x0 + W + 2 * D, y: 2 * D }, { x: x0 + 2 * D, y: 2 * D },
    ], true);
  }
  g.generateTexture('dash_diag', D, D);
  g.destroy();

  // ── floating background shapes ────────────────────────────────────────────
  // One hollow square per tile, and the tile is large. Hollow, never triangular, and the layer
  // stops short of the floor. A solid shape sitting on the ground line is indistinguishable
  // from a hazard at speed, which is exactly what the old parallax silhouettes got wrong — and
  // packing too many of them back in just moves the problem from "is that a spike?" to "I
  // cannot read this screen at all".
  g = mk();
  const T = 400;
  g.lineStyle(3, shade(p.bgAccent, 0.65), 1);
  for (const [cx, cy, s, rot] of [[128, 150, 150, 0.28], [312, 330, 82, 0.62]]) {
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const a = rot + (i * Math.PI) / 2 + Math.PI / 4;
      pts.push({ x: cx + Math.cos(a) * s * 0.7, y: cy + Math.sin(a) * s * 0.7 });
    }
    g.strokePoints(pts, true);
  }
  g.generateTexture('dash_shapes', T, T);
  g.destroy();

  g = mk();
  g.fillStyle(asInt(p.accent), 1);
  g.fillCircle(4, 4, 3);
  g.generateTexture('dot', 8, 8);
  g.destroy();
}
