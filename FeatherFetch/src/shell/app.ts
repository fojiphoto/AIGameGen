/**
 * The application: screens, HUD, input and the main loop.
 *
 * The game is a canvas; everything around it — menus, results, settings, cosmetics — is real
 * DOM. Text laid out by the browser is sharper, scrolls properly and costs nothing during play
 * because it simply is not there. The crosshair and the weapon are the exception: they are drawn
 * on the canvas so they scale with the game and can never lag a frame behind the aim.
 *
 * Aiming is deliberately raw. The pointer position is read from the event and converted straight
 * into game coordinates with no smoothing and no easing — every millisecond of filtering here is
 * a millisecond of input lag, and a shooter is judged on exactly that.
 */

import {
  VIEW_W, VIEW_H, GROUND_Y, SHELLS,
  SaveManager, GameMode, ENVIRONMENT_NAMES,
  ACHIEVEMENTS, newlyEarned, DOG_SKINS, WEAPON_SKINS, cosmeticUnlocked, cosmeticHint,
  accuracyOf, RoundSummary,
} from '../core/index.js';
import { SpriteCache, Backdrop, DOG_W, DOG_H } from '../render/scene.js';
import {
  envFor, drawCrosshair, drawWeapon, drawMuzzleFlash, drawDog, ENVIRONMENTS,
} from '../render/art.js';
import { Session } from '../game/session.js';
import { AudioManager } from './audio.js';

type Screen = 'menu' | 'modes' | 'dog' | 'weapons' | 'achievements' | 'settings' | 'game';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

export class App {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ui: HTMLElement;
  private hud: HTMLElement;

  private save = new SaveManager();
  private audio = new AudioManager();
  private cache: SpriteCache;
  private backdrop = new Backdrop();

  private session: Session | null = null;
  private screen: Screen = 'menu';
  private mode: GameMode = 'classic';
  private paused = false;

  private raf = 0;
  private lastTime = 0;
  private dpr = 1;
  private scale = 1;
  private menuPhase = 0;
  private tutorialStep = 0;
  private tutorialTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.canvas = el('canvas', 'stage');
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.ui = el('div', 'ui');
    this.hud = el('div', 'hud');
    root.append(this.canvas, this.hud, this.ui);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cache = new SpriteCache(this.dpr);
  }

  start(): void {
    this.applySettings();
    this.resize();
    this.bindPointer();
    this.bindGlobal();
    this.showMenu();
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private bindGlobal(): void {
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'KeyP') {
        if (this.screen === 'game') { e.preventDefault(); this.togglePause(); }
      }
      if (e.code === 'KeyR' && this.screen === 'game' && this.session && !this.paused) {
        e.preventDefault();
        this.session.shoot(-999, -999, false);   // a dry click reloads if the barrel is empty
      }
    });

    /**
     * Losing focus pauses.
     *
     * Not optional: ducks keep flying and the escape timer keeps running, so a tab switch
     * mid-round otherwise costs the player a wave they never saw. It also silences audio and
     * stops asking for frames, which is what a background tab should do.
     */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.suspend();
        if (this.screen === 'game' && !this.paused) this.togglePause(true);
      } else {
        this.audio.resume();
        this.lastTime = performance.now();
        this.resize();
      }
    });
    window.addEventListener('blur', () => {
      if (this.screen === 'game' && !this.paused) this.togglePause(true);
    });
  }

  /** Pointer position in game coordinates. No smoothing — see the file header. */
  private toGame(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / (rect.width / VIEW_W),
      y: (e.clientY - rect.top) / (rect.height / VIEW_H),
    };
  }

  private bindPointer(): void {
    const isTouch = (e: PointerEvent) => e.pointerType !== 'mouse';

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.session || this.paused) return;
      const p = this.toGame(e);
      this.session.aimAt(p.x, p.y, isTouch(e));
    });

    /**
     * Fire on pointer *down*, not on click.
     *
     * `click` fires after the button is released, which adds however long the player holds it to
     * the perceived latency. On a phone it is worse: a tap's click event can arrive 100 ms late.
     * Firing on down is the single biggest thing that makes the shooting feel immediate.
     */
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.audio.unlock();
      if (!this.session || this.paused || this.screen !== 'game') return;
      e.preventDefault();
      const p = this.toGame(e);
      // On touch the finger *is* the aim, so the shot lands where it was tapped.
      this.session.shoot(p.x, p.y, isTouch(e));
      this.advanceTutorial();
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * Fit the canvas without ever distorting it.
   *
   * The backing store is the virtual resolution times the pixel ratio; CSS then scales the
   * element to the largest box of the right aspect that fits. Width and height are never
   * computed independently, which is the only way the aspect survives every phone and rotation.
   */
  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.cache.setDpr(dpr);
      this.backdrop.build(this.session?.env ?? envFor(0), 0, dpr);
    }
    this.canvas.width = Math.round(VIEW_W * dpr);
    this.canvas.height = Math.round(VIEW_H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const availW = this.root.clientWidth || window.innerWidth;
    const availH = this.root.clientHeight || window.innerHeight;
    this.scale = Math.min(availW / VIEW_W, availH / VIEW_H);
    const w = Math.floor(VIEW_W * this.scale);
    const h = Math.floor(VIEW_H * this.scale);
    for (const node of [this.canvas, this.hud]) {
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
    }

    // Portrait on a phone gets a rotate hint — a side-scrolling sky in portrait leaves almost no
    // room to see a duck coming.
    const portrait = availH > availW * 1.1 && availW < 820;
    document.documentElement.dataset.portrait = portrait ? '1' : '0';
  }

  private applySettings(): void {
    const s = this.save.data.settings;
    this.audio.sfxEnabled = s.sfx;
    this.audio.musicEnabled = s.music;
    this.audio.sfxVolume = s.sfxVolume;
    this.audio.musicVolume = s.musicVolume;
    this.audio.applyVolumes();
    if (this.session) {
      this.session.shakeEnabled = s.screenShake;
      this.session.particles.quality = s.particles;
      this.session.quickRetrieve = s.quickRetrieve;
      this.session.bandana = DOG_SKINS.find((d) => d.id === s.dogSkin)?.color ?? '#e2503f';
    }
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  private frame = (now: number): void => {
    const dt = Math.min(0.25, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.menuPhase += dt;

    if (this.screen === 'game' && this.session) {
      if (!this.paused) {
        this.session.update(dt);
        this.updateHud();
        if (this.tutorialTimer > 0) this.tutorialTimer -= dt;
      }
      this.session.draw(this.ctx, this.cache, this.backdrop, this.save.data.settings.particles);
      this.drawAim();
    } else {
      this.drawMenuScene(dt);
    }

    this.raf = requestAnimationFrame(this.frame);
  };

  /** Weapon, muzzle flash and crosshair — always last, always over everything. */
  private drawAim(): void {
    const s = this.session!;
    const aim = s.aimState;
    const weapon = WEAPON_SKINS.find((w) => w.id === this.save.data.settings.weaponSkin)
      ?? WEAPON_SKINS[0];

    const gunX = VIEW_W * 0.5;
    const gunY = VIEW_H + 26;
    drawWeapon(this.ctx, gunX, gunY, aim.x, aim.y, s.muzzleAmount, weapon.barrel, weapon.stock);

    if (s.muzzleAmount > 0) {
      const angle = Math.atan2(aim.y - gunY, aim.x - gunX);
      drawMuzzleFlash(this.ctx, gunX + Math.cos(angle) * 92, gunY + Math.sin(angle) * 92,
        angle, 1 - s.muzzleAmount);
    }

    drawCrosshair(this.ctx, aim.x, aim.y, aim.spread, aim.flash, aim.empty);
  }

  /**
   * The menu scene: Biscuit sitting in the meadow while ducks pass behind.
   *
   * Drawn with the same renderer the game uses, so the menu is a promise the game keeps. The
   * dog dozes off if left alone, and wakes when a button is pressed — which is most of the
   * character's charm and costs almost nothing.
   */
  private drawMenuScene(dt: number): void {
    const env = envFor(Math.floor(this.menuPhase / 9) % ENVIRONMENTS.length);
    this.backdrop.build(env, Math.floor(this.menuPhase / 9) % ENVIRONMENTS.length, this.dpr);
    this.backdrop.draw(this.ctx, this.menuPhase, env);

    // Ducks drifting past, purely decorative.
    for (let i = 0; i < 3; i++) {
      const speed = 42 + i * 18;
      const x = ((this.menuPhase * speed + i * 420) % (VIEW_W + 200)) - 100;
      const y = 90 + i * 52 + Math.sin(this.menuPhase * 1.2 + i) * 18;
      const colors = ENVIRONMENTS[i % 5] ? (['#5fa845', '#3d7a2c', '#ffd44a'] as [string, string, string]) : (['#4a86d8', '#2c5a9c', '#ffd44a'] as [string, string, string]);
      const frame = Math.floor(this.menuPhase * 7 + i) % 4;
      const pose = (['up', 'mid', 'down', 'mid'] as const)[frame];
      const sprite = this.cache.duck(`menu${i}`, pose, 40,
        i === 1 ? ['#4a86d8', '#2c5a9c', '#ffd44a'] : colors, false);
      this.ctx.drawImage(sprite, x, y, 40, 31);
    }

    this.backdrop.drawGround(this.ctx);

    // Biscuit, on the right so the panel never covers him.
    const idleFor = this.menuPhase % 26;
    const pose = idleFor > 20 ? 'sleep' : idleFor > 17 ? 'sniff' : 'idle';
    const bandana = DOG_SKINS.find((d) => d.id === this.save.data.settings.dogSkin)?.color ?? '#e2503f';
    this.ctx.save();
    this.ctx.translate(VIEW_W * 0.79, GROUND_Y + 6);
    this.ctx.scale(1.5, 1.5);
    drawDog(this.ctx, pose, this.menuPhase, bandana);
    this.ctx.restore();

    const vignette = this.ctx.createRadialGradient(
      VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.34, VIEW_W / 2, VIEW_H / 2, VIEW_H);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(20,14,8,0.5)');
    this.ctx.fillStyle = vignette;
    this.ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    void dt;
  }

  // ── screens ───────────────────────────────────────────────────────────────

  private setScreen(name: Screen, build: () => HTMLElement | null): void {
    this.screen = name;
    this.ui.replaceChildren();
    this.hud.replaceChildren();
    this.hud.style.display = name === 'game' ? '' : 'none';
    this.canvas.style.cursor = name === 'game' ? 'none' : 'default';
    const node = build();
    if (node) this.ui.append(node);
    this.ui.style.pointerEvents = node ? 'auto' : 'none';
  }

  private button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
    const b = el('button', cls, label);
    b.addEventListener('click', () => { this.audio.unlock(); this.audio.play('button'); onClick(); });
    return b;
  }

  private header(title: string, back: () => void): HTMLElement {
    const head = el('div', 'panel-head');
    head.append(this.button('←', back, 'back'), el('h2', undefined, title));
    return head;
  }

  private showMenu(): void {
    this.session = null;
    this.setScreen('menu', () => {
      const t = this.save.data.totals;
      const wrap = el('div', 'panel menu');
      const title = el('h1', 'title');
      title.innerHTML = 'FEATHER <span>&amp;</span> FETCH';
      wrap.append(title, el('p', 'tagline', 'Take the shot. Biscuit does the rest.'));

      const stack = el('div', 'stack');
      stack.append(
        this.button('PLAY', () => this.startGame('classic'), 'btn primary'),
        this.button('GAME MODES', () => this.showModes()),
        this.button('BISCUIT', () => this.showDog()),
        this.button('WEAPONS', () => this.showWeapons()),
        this.button('ACHIEVEMENTS', () => this.showAchievements()),
        this.button('SETTINGS', () => this.showSettings()),
      );
      wrap.append(stack);

      const foot = el('div', 'foot');
      foot.innerHTML =
        `<span><b>${this.save.data.best.classic.toLocaleString()}</b> best</span>`
        + `<span><b>${t.ducksHit}</b> ducks</span>`
        + `<span><b>${t.bestAccuracy > 0 ? pct(t.bestAccuracy) : '—'}</b> accuracy</span>`;
      wrap.append(foot);
      return wrap;
    });
  }

  private showModes(): void {
    this.setScreen('modes', () => {
      const wrap = el('div', 'panel wide');
      wrap.append(this.header('Game modes', () => this.showMenu()));
      const grid = el('div', 'mode-grid');
      const modes: [GameMode, string, string][] = [
        ['classic', 'Classic Hunt', 'Round after round. Three shells a wave, ducks get faster.'],
        ['timeAttack', 'Time Attack', 'Sixty seconds. Hit as many as you can.'],
        ['survival', 'Survival', 'Three escapes and the hunt is over.'],
      ];
      for (const [id, name, blurb] of modes) {
        const card = el('button', 'mode-card');
        card.innerHTML = `<b>${name}</b><small>${blurb}</small>`
          + `<span class="best">best ${this.save.data.best[id].toLocaleString()}</span>`;
        card.addEventListener('click', () => { this.audio.play('button'); this.startGame(id); });
        grid.append(card);
      }
      wrap.append(grid);
      return wrap;
    });
  }

  /** Cosmetics — a shared screen for the dog and the weapon, with a real drawn preview. */
  private showCosmetics(
    screen: Screen, title: string, list: readonly { id: string; name: string; blurb: string;
      need: Parameters<typeof cosmeticUnlocked>[0] }[],
    current: () => string, choose: (id: string) => void,
    preview: (ctx: CanvasRenderingContext2D, id: string) => void
  ): void {
    this.setScreen(screen, () => {
      const wrap = el('div', 'panel wide');
      wrap.append(this.header(title, () => this.showMenu()));
      const grid = el('div', 'skin-grid');
      for (const item of list) {
        const unlocked = cosmeticUnlocked(item.need, this.save.data.totals);
        const active = current() === item.id;
        const card = el('button', `skin-card${unlocked ? '' : ' locked'}${active ? ' active' : ''}`);
        const canvas = document.createElement('canvas');
        canvas.width = 132; canvas.height = 96;
        canvas.className = 'skin-preview';
        const pctx = canvas.getContext('2d')!;
        preview(pctx, item.id);
        if (!unlocked) {
          pctx.globalCompositeOperation = 'source-atop';
          pctx.fillStyle = 'rgba(16,12,8,0.8)';
          pctx.fillRect(0, 0, 132, 96);
        }
        const label = el('div', 'skin-label');
        label.innerHTML = `<b>${item.name}</b>`
          + `<small>${unlocked ? item.blurb : cosmeticHint(item.need)}</small>`;
        card.append(canvas, label);
        if (unlocked) {
          card.addEventListener('click', () => {
            choose(item.id);
            this.save.save();
            this.applySettings();
            this.audio.play('unlock');
            this.showCosmetics(screen, title, list, current, choose, preview);
          });
        }
        grid.append(card);
      }
      wrap.append(grid);
      return wrap;
    });
  }

  private showDog(): void {
    this.showCosmetics('dog', 'Biscuit', DOG_SKINS,
      () => this.save.data.settings.dogSkin,
      (id) => { this.save.data.settings.dogSkin = id; },
      (ctx, id) => {
        const color = DOG_SKINS.find((d) => d.id === id)?.color ?? '#e2503f';
        ctx.translate(66 - DOG_W / 2, 96 - DOG_H - 4);
        drawDog(ctx, 'idle', 1.2, color);
      });
  }

  private showWeapons(): void {
    this.showCosmetics('weapons', 'Weapons', WEAPON_SKINS,
      () => this.save.data.settings.weaponSkin,
      (id) => { this.save.data.settings.weaponSkin = id; },
      (ctx, id) => {
        const skin = WEAPON_SKINS.find((w) => w.id === id) ?? WEAPON_SKINS[0];
        ctx.save();
        ctx.translate(66, 96);
        ctx.scale(0.85, 0.85);
        ctx.rotate(-0.35);
        drawWeapon(ctx, 0, 0, 0, -200, 0, skin.barrel, skin.stock);
        ctx.restore();
      });
  }

  private showAchievements(): void {
    this.setScreen('achievements', () => {
      const wrap = el('div', 'panel wide');
      wrap.append(this.header('Achievements', () => this.showMenu()));
      const t = this.save.data.totals;
      const earned = new Set(this.save.data.achievements);

      const grid = el('div', 'ach-grid');
      for (const a of ACHIEVEMENTS) {
        const got = earned.has(a.id);
        const card = el('div', `ach${got ? ' earned' : ''}`);
        card.innerHTML = `<span class="tick">${got ? '✦' : '·'}</span>`
          + `<div><b>${a.name}</b><small>${a.hint}</small></div>`;
        grid.append(card);
      }
      wrap.append(grid);

      const stats = el('div', 'stat-row');
      stats.innerHTML =
        `<div><b>${t.ducksHit}</b><small>hit</small></div>`
        + `<div><b>${t.ducksEscaped}</b><small>escaped</small></div>`
        + `<div><b>${t.shotsFired}</b><small>shots</small></div>`
        + `<div><b>${t.bestAccuracy > 0 ? pct(t.bestAccuracy) : '—'}</b><small>accuracy</small></div>`
        + `<div><b>${t.bestCombo}</b><small>best streak</small></div>`
        + `<div><b>${t.perfectRounds}</b><small>perfect</small></div>`
        + `<div><b>${t.rareDucks}</b><small>rare</small></div>`
        + `<div><b>${Math.round(t.playMs / 60000)}m</b><small>played</small></div>`;
      wrap.append(stats);
      return wrap;
    });
  }

  private showSettings(): void {
    let confirmReset = false;
    this.setScreen('settings', () => {
      const s = this.save.data.settings;
      const wrap = el('div', 'panel');
      wrap.append(this.header('Settings', () => this.showMenu()));
      const rows = el('div', 'rows');

      const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
        const row = el('div', 'row');
        const btn = el('button', 'toggle');
        const sync = () => btn.setAttribute('aria-pressed', String(get()));
        btn.addEventListener('click', () => {
          set(!get()); sync(); this.save.save(); this.applySettings(); this.audio.play('button');
        });
        sync();
        row.append(el('span', undefined, label), btn);
        return row;
      };
      const slider = (label: string, get: () => number, set: (v: number) => void) => {
        const row = el('div', 'row');
        const range = el('input', 'range');
        range.type = 'range'; range.min = '0'; range.max = '100';
        range.value = String(Math.round(get() * 100));
        range.addEventListener('input', () => {
          set(Number(range.value) / 100); this.save.save(); this.applySettings();
        });
        row.append(el('span', undefined, label), range);
        return row;
      };
      const choice = <T extends string>(
        label: string, values: readonly T[], get: () => T, set: (v: T) => void
      ) => {
        const row = el('div', 'row');
        const group = el('div', 'choices');
        for (const value of values) {
          const b = el('button', 'chip', value[0].toUpperCase() + value.slice(1));
          b.setAttribute('aria-pressed', String(get() === value));
          b.addEventListener('click', () => {
            set(value); this.save.save(); this.applySettings();
            for (const other of Array.from(group.children)) {
              other.setAttribute('aria-pressed', String(other === b));
            }
            this.audio.play('button');
          });
          group.append(b);
        }
        row.append(el('span', undefined, label), group);
        return row;
      };

      rows.append(
        toggle('Sound effects', () => s.sfx, (v) => { s.sfx = v; }),
        slider('Effects volume', () => s.sfxVolume, (v) => { s.sfxVolume = v; }),
        toggle('Music', () => s.music, (v) => { s.music = v; this.audio.setMusic(v); }),
        slider('Music volume', () => s.musicVolume, (v) => { s.musicVolume = v; }),
        toggle('Screen shake', () => s.screenShake, (v) => { s.screenShake = v; }),
        toggle('Quick retrieve', () => s.quickRetrieve, (v) => { s.quickRetrieve = v; }),
        choice('Particles', ['low', 'high'] as const, () => s.particles, (v) => { s.particles = v; }),
      );
      wrap.append(rows);

      const reset = this.button('RESET PROGRESS', () => {
        if (confirmReset) { this.save.reset(); this.showMenu(); return; }
        confirmReset = true;
        reset.textContent = 'TAP AGAIN TO ERASE EVERYTHING';
        reset.classList.add('danger');
      }, 'btn ghost');
      wrap.append(reset);
      wrap.append(el('p', 'hint',
        'Mouse or finger to aim · click or tap to shoot · R reloads · Esc pauses'));
      return wrap;
    });
  }

  // ── playing ───────────────────────────────────────────────────────────────

  private startGame(mode: GameMode): void {
    this.mode = mode;
    this.audio.unlock();
    const seed = (Math.random() * 0xffffffff) | 0;
    this.session = new Session(mode, seed, this.audio);
    this.applySettings();
    this.backdrop.build(this.session.env, this.session.plan.environment, this.dpr);
    this.audio.setEnvironment(this.session.plan.environment);

    this.session.onRoundComplete = (summary) => this.showRoundResults(summary);
    this.session.onGameOver = () => this.showGameOver();

    this.paused = false;
    this.tutorialStep = this.save.data.settings.showTutorial ? 1 : 0;
    this.tutorialTimer = 0;
    this.setScreen('game', () => null);
    this.buildHud();
    this.audio.play('roundStart');
  }

  private buildHud(): void {
    this.hud.replaceChildren();
    const bar = el('div', 'hud-bar');
    bar.innerHTML =
      '<div class="left"><div class="score"><b>0</b><small>SCORE</small></div>'
      + '<div class="combo"></div></div>'
      + '<div class="mid"><span class="round"></span></div>'
      + '<div class="right"><span class="ducks"></span><span class="shells"></span></div>';
    const pause = this.button('❚❚', () => this.togglePause(), 'hud-pause');
    bar.querySelector('.right')!.append(pause);
    this.hud.append(bar);
    this.hud.append(el('div', 'banner'));
    this.hud.append(el('div', 'tutorial'));
  }

  private updateHud(): void {
    const s = this.session;
    if (!s) return;

    const score = this.hud.querySelector('.score b');
    if (score) score.textContent = s.stats.score.toLocaleString();

    const combo = this.hud.querySelector('.combo');
    if (combo) {
      const on = s.stats.combo >= 2;
      combo.textContent = on ? `STREAK ×${s.stats.combo}` : '';
      combo.classList.toggle('on', on);
      combo.classList.toggle('hot', s.stats.combo >= 5);
    }

    const round = this.hud.querySelector('.round');
    if (round) {
      round.textContent = this.mode === 'timeAttack'
        ? `${Math.ceil(s.timeLeft)}s`
        : this.mode === 'survival'
          ? `${'●'.repeat(Math.max(0, 3 - s.misses))}${'○'.repeat(Math.min(3, s.misses))}`
          : `ROUND ${s.round}`;
    }

    const ducks = this.hud.querySelector('.ducks');
    if (ducks) ducks.textContent = `${s.plan.duckCount - s.released + s.aliveCount} left`;

    // Shells as icons, not a number — it reads at a glance in peripheral vision, which is where
    // it is actually being read from.
    const shells = this.hud.querySelector('.shells');
    if (shells) {
      shells.innerHTML = Array.from({ length: SHELLS }, (_, i) =>
        `<i class="shell${i < s.shells ? ' on' : ''}${s.reloading ? ' reloading' : ''}"></i>`).join('');
    }

    const banner = this.hud.querySelector('.banner');
    if (banner) {
      let text = '';
      if (s.phase === 'roundCard') text = this.mode === 'classic' ? `ROUND ${s.round}` : 'READY';
      else if (s.phase === 'ready') text = 'READY?';
      banner.textContent = text;
      banner.classList.toggle('on', text.length > 0);
    }

    const tutorial = this.hud.querySelector('.tutorial');
    if (tutorial) {
      const steps = ['', 'Move to aim', 'Click or tap to shoot', 'Hit the duck!'];
      const text = this.tutorialStep > 0 && this.tutorialStep < steps.length
        ? steps[this.tutorialStep] : '';
      tutorial.textContent = text;
      tutorial.classList.toggle('on', text.length > 0);
    }
  }

  /**
   * The tutorial: three prompts, dismissed by doing the thing.
   *
   * It advances on the player's first shot and then on their first hit, and marks itself done in
   * the save. Three seconds total, no modal, no "OK" button — a tutorial that has to be
   * acknowledged is longer than the thing it is teaching.
   */
  private advanceTutorial(): void {
    if (this.tutorialStep === 0) return;
    this.tutorialStep++;
    if (this.tutorialStep > 3) {
      this.tutorialStep = 0;
      this.save.data.settings.showTutorial = false;
      this.save.save();
    }
  }

  private togglePause(force?: boolean): void {
    if (!this.session) return;
    const next = force ?? !this.paused;
    if (next === this.paused) return;
    this.paused = next;

    if (!this.paused) {
      this.ui.replaceChildren();
      this.ui.style.pointerEvents = 'none';
      this.lastTime = performance.now();
      return;
    }

    const wrap = el('div', 'panel overlay');
    wrap.append(el('h2', undefined, 'Paused'));
    const stack = el('div', 'stack');
    stack.append(
      this.button('RESUME', () => this.togglePause(false), 'btn primary'),
      this.button('RESTART', () => this.startGame(this.mode)),
      this.button('SETTINGS', () => this.showSettings()),
      this.button('MAIN MENU', () => this.showMenu()),
    );
    wrap.append(stack);
    this.ui.replaceChildren(wrap);
    this.ui.style.pointerEvents = 'auto';
  }

  private showRoundResults(summary: RoundSummary): void {
    const s = this.session;
    if (!s) return;

    const wrap = el('div', 'panel overlay results');
    wrap.innerHTML =
      `<h2>${summary.perfect ? 'PERFECT ROUND' : 'ROUND CLEAR'}</h2>`
      + `<p class="sub">${ENVIRONMENT_NAMES[s.plan.environment]} · Round ${summary.round}</p>`
      + `<div class="result-grid">`
      + `<div><b>${summary.ducksHit}/${summary.ducksTotal}</b><small>ducks</small></div>`
      + `<div><b>${summary.shotsFired}</b><small>shots</small></div>`
      + `<div><b>${pct(Math.min(1, summary.accuracy))}</b><small>accuracy</small></div>`
      + `<div><b>×${summary.bestCombo}</b><small>best streak</small></div>`
      + `</div>`
      + `<p class="bonus">+${summary.bonus.toLocaleString()} bonus</p>`
      + `<p class="total">${s.stats.score.toLocaleString()}</p>`;

    const stack = el('div', 'stack');
    stack.append(this.button('NEXT ROUND', () => {
      s.nextRound();
      this.backdrop.build(s.env, s.plan.environment, this.dpr);
      this.audio.setEnvironment(s.plan.environment);
      this.audio.play('roundStart');
      this.ui.replaceChildren();
      this.ui.style.pointerEvents = 'none';
      this.lastTime = performance.now();
    }, 'btn primary'));
    stack.append(this.button('END HUNT', () => this.showGameOver()));
    wrap.append(stack);
    this.ui.replaceChildren(wrap);
    this.ui.style.pointerEvents = 'auto';
  }

  private showGameOver(): void {
    const s = this.session;
    if (!s || this.ui.querySelector('.gameover')) return;

    const run = {
      score: s.stats.score,
      ducksHit: s.stats.ducksHit,
      ducksEscaped: s.stats.ducksEscaped,
      shotsFired: s.stats.shotsFired,
      shotsHit: s.stats.shotsHit,
      bestCombo: s.stats.bestCombo,
      perfectRounds: s.stats.perfectRounds,
      rareDucks: s.stats.rareDucks,
      roundsCleared: Math.max(0, s.round - 1),
      playMs: s.elapsedSeconds * 1000,
    };
    const { newHigh } = this.save.recordRun(this.mode, run);
    const earned = newlyEarned(this.save.data.totals, s.stats, this.save.data.achievements);
    if (earned.length) {
      this.save.unlockAchievements(earned.map((a) => a.id));
      this.audio.play('unlock');
    }

    const wrap = el('div', 'panel overlay gameover');
    wrap.innerHTML =
      `<h2>HUNT COMPLETE</h2>`
      + `<p class="total big">${run.score.toLocaleString()}</p>`
      + (newHigh ? '<p class="new">New personal best</p>' : '')
      + `<div class="result-grid">`
      + `<div><b>${run.ducksHit}</b><small>ducks hit</small></div>`
      + `<div><b>${pct(accuracyOf(run))}</b><small>accuracy</small></div>`
      + `<div><b>×${run.bestCombo}</b><small>best streak</small></div>`
      + `<div><b>${run.rareDucks}</b><small>rare ducks</small></div>`
      + `<div><b>${run.perfectRounds}</b><small>perfect rounds</small></div>`
      + `<div><b>${this.save.data.best[this.mode].toLocaleString()}</b><small>best</small></div>`
      + `</div>`
      + (earned.length
        ? `<p class="unlocked">Unlocked: ${earned.map((a) => a.name).join(', ')}</p>` : '');

    const stack = el('div', 'stack');
    stack.append(
      this.button('HUNT AGAIN', () => this.startGame(this.mode), 'btn primary'),
      this.button('MAIN MENU', () => this.showMenu()),
    );
    wrap.append(stack);
    this.ui.replaceChildren(wrap);
    this.ui.style.pointerEvents = 'auto';
  }

  dispose(): void { cancelAnimationFrame(this.raf); }
}
