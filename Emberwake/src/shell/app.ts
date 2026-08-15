/**
 * The application: screens, the HUD, the main loop and everything around a level.
 *
 * The game itself is a canvas; everything else — menus, the world map, results, settings — is
 * real DOM. That split is deliberate. Text laid out by the browser is sharper, scrolls properly,
 * respects the system font and is reachable by a screen reader, and none of it costs a frame
 * while the game is running because it is simply not there. The HUD is the one exception worth
 * noting: it is DOM too, positioned over the canvas, so a health readout never costs a redraw of
 * the playfield.
 *
 * The canvas is fixed at 960x540 and scaled to fit with `object-fit`-style maths, so the game's
 * aspect ratio can never be distorted — the brief's one hard rule about presentation.
 */

import {
  VIEW_W, VIEW_H, LEVELS, LevelDef, levelsByWorld, WORLD_NAMES, WORLD_HOOKS,
  Progress, SKINS, Skin, abilitiesAtLevel,
} from '../core/index.js';
import { SpriteCache, Backdrop } from '../render/renderer.js';
import { paletteForWorld, drawHero, WORLD_PALETTES } from '../render/art.js';
import { Session } from '../game/session.js';
import { AudioManager } from './audio.js';
import { InputManager, TouchButton } from './input.js';

type Screen = 'menu' | 'worlds' | 'levels' | 'game' | 'skins' | 'settings' | 'stats';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const fmtTime = (ms: number): string => {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = (total % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
};

export class App {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ui: HTMLElement;
  private hud: HTMLElement;

  private progress = new Progress();
  private audio = new AudioManager();
  private input = new InputManager();
  private cache: SpriteCache;
  private backdrop = new Backdrop();

  private session: Session | null = null;
  private currentLevel: LevelDef | null = null;
  private screen: Screen = 'menu';
  private paused = false;
  private worldPage = 1;

  private raf = 0;
  private lastTime = 0;
  private dpr = 1;
  private scale = { sx: 1, sy: 1, ox: 0, oy: 0 };
  private menuPhase = 0;

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
    this.input.attach(this.canvas, () => this.scale);
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

    /**
     * Losing focus pauses the game.
     *
     * Not optional for a platformer: a tab switch mid-jump otherwise returns to a character who
     * has fallen into a pit while nobody was looking. It also silences audio and stops asking
     * for frames, which is the polite thing for a background tab to do.
     */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.suspend();
        this.input.clear();
        if (this.screen === 'game' && !this.paused) this.togglePause(true);
      } else {
        this.audio.resume();
        this.lastTime = performance.now();
        this.resize();
      }
    });
    window.addEventListener('blur', () => {
      this.input.clear();
      if (this.screen === 'game' && !this.paused) this.togglePause(true);
    });
  }

  /**
   * Fit the canvas to the window without ever distorting it.
   *
   * The backing store is the virtual resolution times the device pixel ratio; CSS then scales
   * the element to the largest box of the right aspect that fits. Width and height are never
   * computed independently, which is the only way to guarantee the aspect survives every phone,
   * every rotation and every browser chrome that appears and disappears.
   */
  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (dpr !== this.dpr) { this.dpr = dpr; this.cache.setDpr(dpr); this.backdrop.build(
      paletteForWorld(this.currentLevel?.world ?? 1), this.currentLevel?.world ?? 1, dpr); }

    this.canvas.width = Math.round(VIEW_W * dpr);
    this.canvas.height = Math.round(VIEW_H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;

    const availW = this.root.clientWidth || window.innerWidth;
    const availH = this.root.clientHeight || window.innerHeight;
    const scale = Math.min(availW / VIEW_W, availH / VIEW_H);
    const w = Math.floor(VIEW_W * scale);
    const h = Math.floor(VIEW_H * scale);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.hud.style.width = `${w}px`;
    this.hud.style.height = `${h}px`;
    this.scale = { sx: scale, sy: scale, ox: 0, oy: 0 };

    // Portrait on a phone gets a rotate hint rather than a squeezed game — a side-scroller in
    // portrait has almost no room to see what is coming.
    const portrait = availH > availW * 1.15 && availW < 820;
    document.documentElement.dataset.portrait = portrait ? '1' : '0';

    this.layoutTouchButtons();
  }

  /**
   * Touch controls, laid out from the virtual resolution.
   *
   * Left and right are one wide strip split in two rather than two small pads, because a thumb
   * that slides between them should keep working. Jump is on the right, large, and sits low
   * enough to reach without shifting grip.
   */
  private layoutTouchButtons(): void {
    const pad = 18;
    const size = 84;
    const bottom = VIEW_H - size - pad;
    const buttons: TouchButton[] = [
      { id: 'left', x: pad, y: bottom, w: size, h: size, pad: 14, label: '◀' },
      { id: 'right', x: pad + size + 10, y: bottom, w: size, h: size, pad: 14, label: '▶' },
      { id: 'jump', x: VIEW_W - pad - size, y: bottom, w: size, h: size, pad: 18, label: '▲' },
      { id: 'dash', x: VIEW_W - pad - size * 2 - 12, y: bottom + 18, w: size - 14, h: size - 14,
        pad: 12, label: '»' },
      { id: 'pause', x: VIEW_W - 54, y: 14, w: 40, h: 40, pad: 8, label: '❚❚' },
    ];
    this.input.setTouchButtons(buttons);
  }

  private applySettings(): void {
    const s = this.progress.data.settings;
    this.audio.sfxEnabled = s.sfx;
    this.audio.musicEnabled = s.music;
    this.audio.sfxVolume = s.sfxVolume;
    this.audio.musicVolume = s.musicVolume;
    this.audio.applyVolumes();
    if (this.session) {
      this.session.camera.shakeEnabled = s.screenShake;
      this.session.particles.quality = s.particles;
    }
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  private frame = (now: number): void => {
    const dt = Math.min(0.25, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.menuPhase += dt;

    const input = this.input.poll();
    if (this.input.pausePressed && this.screen === 'game') this.togglePause();

    if (this.screen === 'game' && this.session) {
      if (!this.paused) {
        this.session.update(dt, input);
        this.updateHud();
        if (this.session.state === 'complete' && this.session.completeElapsed > 0.9) {
          this.finishLevel();
        }
      }
      this.session.draw(this.ctx, this.cache, this.backdrop, this.progress.data.settings.particles);
      const fade = this.session.overlayAlpha;
      if (fade > 0) {
        this.ctx.fillStyle = `rgba(6, 4, 10, ${fade})`;
        this.ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      }
      if (this.shouldShowTouch()) this.drawTouchOverlay();
    } else {
      this.drawMenuScene(dt);
    }

    this.raf = requestAnimationFrame(this.frame);
  };

  private shouldShowTouch(): boolean {
    const mode = this.progress.data.settings.touchControls;
    if (mode === 'off') return false;
    if (mode === 'on') return true;
    return this.input.method === 'touch';
  }

  /** The touch pads, drawn on the canvas so they scale with the game rather than the page. */
  private drawTouchOverlay(): void {
    const ctx = this.ctx;
    ctx.save();
    for (const b of this.input.buttons) {
      if (b.id === 'dash' && !(this.session?.player.canDash)) continue;
      const held = this.input.isTouched(b.id);
      ctx.globalAlpha = held ? 0.42 : 0.2;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      const r = Math.min(b.w, b.h) / 2;
      ctx.arc(b.x + b.w / 2, b.y + b.h / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = held ? 0.95 : 0.6;
      ctx.fillStyle = '#1a1020';
      ctx.font = `600 ${Math.round(r * 0.9)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    }
    ctx.restore();
  }

  /**
   * The menu backdrop: a real parallax scene with Nim idling in it.
   *
   * Drawn with the same renderer the game uses, so the menu is a promise the game keeps rather
   * than a separate piece of art. The world it shows cycles slowly, which quietly advertises
   * what is further in.
   */
  private drawMenuScene(dt: number): void {
    const world = 1 + (Math.floor(this.menuPhase / 7) % WORLD_PALETTES.length);
    const palette = paletteForWorld(world);
    this.backdrop.build(palette, world, this.dpr);
    this.cache.setPalette(`menu${world}`);
    this.backdrop.draw(this.ctx, this.menuPhase * 26, 0, palette);

    // A ground line and Nim standing on it.
    const groundY = VIEW_H * 0.78;
    this.ctx.fillStyle = palette.groundFace;
    this.ctx.fillRect(0, groundY, VIEW_W, VIEW_H - groundY);
    this.ctx.fillStyle = palette.groundTop;
    this.ctx.fillRect(0, groundY, VIEW_W, 9);

    // Off to the right, clear of the menu panel — a character hidden behind the buttons is a
    // scene nobody sees.
    this.ctx.save();
    this.ctx.translate(VIEW_W * 0.8, groundY);
    this.ctx.scale(2.6, 2.6);
    this.ctx.translate(-20, -44);
    drawHero(this.ctx, 'idle', palette, this.menuPhase);
    this.ctx.restore();

    const vignette = this.ctx.createRadialGradient(
      VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.3, VIEW_W / 2, VIEW_H / 2, VIEW_H);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
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
    const node = build();
    if (node) this.ui.append(node);
    this.ui.style.pointerEvents = node ? 'auto' : 'none';
  }

  private button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
    const b = el('button', cls, label);
    b.addEventListener('click', () => { this.audio.unlock(); this.audio.play('button'); onClick(); });
    return b;
  }

  private showMenu(): void {
    this.session = null;
    this.setScreen('menu', () => {
      const wrap = el('div', 'panel menu');
      const title = el('h1', 'title');
      title.innerHTML = '<span>EMBER</span>WAKE';
      wrap.append(title, el('p', 'tagline', 'Carry the light back'));

      const stars = this.progress.totalStars;
      const buttons = el('div', 'stack');
      buttons.append(
        this.button(stars === 0 ? 'PLAY' : 'CONTINUE', () => this.playNext(), 'btn primary'),
        this.button('LEVELS', () => this.showWorlds()),
        this.button('SKINS', () => this.showSkins()),
        this.button('ACHIEVEMENTS', () => this.showStats()),
        this.button('SETTINGS', () => this.showSettings()),
      );
      wrap.append(buttons);

      const foot = el('div', 'foot');
      foot.innerHTML =
        `<span><b>${stars}</b>/${LEVELS.length * 3} stars</span>`
        + `<span><b>${this.progress.data.totalEmbers}</b>/${LEVELS.length} emberstones</span>`
        + `<span><b>${this.progress.data.totalSparks}</b> sparks</span>`;
      wrap.append(foot);
      return wrap;
    });
  }

  private playNext(): void {
    // The first level that is unlocked and unfinished, or the last one if everything is done.
    const next = LEVELS.find((l) => this.progress.isUnlocked(l.id) && !this.progress.record(l.id).completed)
      ?? LEVELS[LEVELS.length - 1];
    this.startLevel(next);
  }

  private showWorlds(): void {
    this.setScreen('worlds', () => {
      const wrap = el('div', 'panel wide');
      wrap.append(this.header('Worlds', () => this.showMenu()));
      const grid = el('div', 'world-grid');
      for (const [i, world] of levelsByWorld().entries()) {
        const number = i + 1;
        const unlocked = this.progress.isWorldUnlocked(number);
        const card = el('button', `world-card${unlocked ? '' : ' locked'}`);
        const earned = world.reduce((n, l) => n + this.progress.record(l.id).stars, 0);
        const palette = WORLD_PALETTES[i];
        card.style.setProperty('--w1', palette.sky[0]);
        card.style.setProperty('--w2', palette.mid);
        card.innerHTML =
          `<span class="wn">WORLD ${number}</span>`
          + `<b>${WORLD_NAMES[i]}</b>`
          + `<small>${unlocked ? WORLD_HOOKS[i] : 'Finish the world before this one'}</small>`
          + `<span class="ws">${unlocked ? `★ ${earned}/${world.length * 3}` : '🔒'}</span>`;
        if (unlocked) {
          card.addEventListener('click', () => {
            this.audio.play('button');
            this.worldPage = number;
            this.showLevels();
          });
        }
        grid.append(card);
      }
      wrap.append(grid);
      return wrap;
    });
  }

  private showLevels(): void {
    this.setScreen('levels', () => {
      const wrap = el('div', 'panel wide');
      wrap.append(this.header(WORLD_NAMES[this.worldPage - 1], () => this.showWorlds()));
      const grid = el('div', 'level-grid');
      for (const def of LEVELS.filter((l) => l.world === this.worldPage)) {
        const record = this.progress.record(def.id);
        const unlocked = this.progress.isUnlocked(def.id);
        const card = el('button', `level-card${unlocked ? '' : ' locked'}`);
        const starRow = '★★★'.slice(0, record.stars).padEnd(3, '☆');
        card.innerHTML =
          `<span class="ln">${def.world}-${def.index}</span>`
          + `<b>${unlocked ? def.name : 'Locked'}</b>`
          + `<small>${unlocked ? def.hook : 'Finish the previous level'}</small>`
          + `<span class="stars">${unlocked ? starRow : ''}</span>`
          + (record.bestTimeMs ? `<span class="best">best ${fmtTime(record.bestTimeMs)}</span>` : '')
          + (record.embersFound ? '<span class="ember">◆ emberstone found</span>' : '');
        if (unlocked) card.addEventListener('click', () => { this.audio.play('button'); this.startLevel(def); });
        grid.append(card);
      }
      wrap.append(grid);
      return wrap;
    });
  }

  private showSkins(): void {
    this.setScreen('skins', () => {
      const wrap = el('div', 'panel wide');
      wrap.append(this.header('Skins', () => this.showMenu()));
      const grid = el('div', 'skin-grid');
      for (const skin of SKINS) {
        const unlocked = this.progress.skinUnlocked(skin);
        const active = this.progress.data.settings.skin === skin.id;
        const card = el('button', `skin-card${unlocked ? '' : ' locked'}${active ? ' active' : ''}`);

        // A real preview: the actual character art, in the actual colours.
        const preview = document.createElement('canvas');
        preview.width = 40 * 2; preview.height = 44 * 2;
        preview.className = 'skin-preview';
        const pctx = preview.getContext('2d')!;
        pctx.scale(2, 2);
        const palette = { ...paletteForWorld(1) };
        palette.body = skin.colors[0]; palette.trim = skin.colors[1]; palette.glow = skin.colors[2];
        drawHero(pctx, 'idle', palette, 0.5);
        if (!unlocked) { pctx.globalCompositeOperation = 'source-atop'; pctx.fillStyle = 'rgba(10,8,14,0.82)'; pctx.fillRect(0, 0, 40, 44); }

        const label = el('div', 'skin-label');
        label.innerHTML = `<b>${skin.name}</b><small>${unlocked ? skin.blurb : this.skinHint(skin)}</small>`;
        card.append(preview, label);
        if (unlocked) {
          card.addEventListener('click', () => {
            this.progress.data.settings.skin = skin.id;
            this.progress.save();
            this.audio.play('power');
            this.showSkins();
          });
        }
        grid.append(card);
      }
      wrap.append(grid);
      return wrap;
    });
  }

  private skinHint(skin: Skin): string {
    switch (skin.requirement.kind) {
      case 'embers': return `Find ${skin.requirement.count} emberstones`;
      case 'stars': return `Earn ${skin.requirement.count} stars`;
      case 'world': return `Reach world ${skin.requirement.world}`;
      default: return '';
    }
  }

  private showStats(): void {
    this.setScreen('stats', () => {
      const wrap = el('div', 'panel wide');
      wrap.append(this.header('Achievements', () => this.showMenu()));
      const d = this.progress.data;
      const done = Object.values(d.levels).filter((r) => r.completed).length;

      const list: [string, string, boolean][] = [
        ['First Light', 'Finish your first level', done >= 1],
        ['Pathfinder', 'Finish every level in a world', this.progress.isWorldUnlocked(2)],
        ['Collector', 'Find 3 emberstones', d.totalEmbers >= 3],
        ['Completionist', 'Find every emberstone', d.totalEmbers >= LEVELS.length],
        ['Star Bearer', 'Earn 15 stars', this.progress.totalStars >= 15],
        ['Perfect Run', 'Three-star any level', Object.values(d.levels).some((r) => r.stars === 3)],
        ['Beacon Keeper', 'Finish every level', done >= LEVELS.length],
        ['Persistent', 'Keep going after 20 falls', d.deaths >= 20],
      ];

      const grid = el('div', 'ach-grid');
      for (const [name, hint, earned] of list) {
        const card = el('div', `ach${earned ? ' earned' : ''}`);
        card.innerHTML = `<span class="tick">${earned ? '✦' : '·'}</span>`
          + `<div><b>${name}</b><small>${hint}</small></div>`;
        grid.append(card);
      }
      wrap.append(grid);

      const stats = el('div', 'stat-row');
      stats.innerHTML =
        `<div><b>${done}</b><small>levels</small></div>`
        + `<div><b>${this.progress.totalStars}</b><small>stars</small></div>`
        + `<div><b>${d.totalSparks}</b><small>sparks</small></div>`
        + `<div><b>${d.totalEmbers}</b><small>emberstones</small></div>`
        + `<div><b>${d.deaths}</b><small>falls</small></div>`;
      wrap.append(stats);
      return wrap;
    });
  }

  private showSettings(): void {
    this.setScreen('settings', () => {
      const s = this.progress.data.settings;
      const wrap = el('div', 'panel');
      wrap.append(this.header('Settings', () => this.showMenu()));
      const rows = el('div', 'rows');

      const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
        const row = el('div', 'row');
        const btn = el('button', 'toggle');
        const sync = () => btn.setAttribute('aria-pressed', String(get()));
        btn.addEventListener('click', () => {
          set(!get());
          sync();
          this.progress.save();
          this.applySettings();
          this.audio.play('button');
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
          set(Number(range.value) / 100);
          this.progress.save();
          this.applySettings();
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
          const sync = () => b.setAttribute('aria-pressed', String(get() === value));
          b.addEventListener('click', () => {
            set(value);
            this.progress.save();
            this.applySettings();
            for (const other of Array.from(group.children)) {
              other.setAttribute('aria-pressed', String(other === b));
            }
            this.audio.play('button');
          });
          sync();
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
        toggle('Show timer', () => s.showTimer, (v) => { s.showTimer = v; }),
        choice('Particles', ['low', 'high'] as const, () => s.particles, (v) => { s.particles = v; }),
        choice('Touch controls', ['auto', 'on', 'off'] as const,
          () => s.touchControls, (v) => { s.touchControls = v; }),
      );
      wrap.append(rows);

      const reset = this.button('RESET PROGRESS', () => {
        if (this.confirmReset) { this.progress.reset(); this.showMenu(); return; }
        this.confirmReset = true;
        reset.textContent = 'TAP AGAIN TO ERASE EVERYTHING';
        reset.classList.add('danger');
      }, 'btn ghost');
      wrap.append(reset);
      wrap.append(el('p', 'hint',
        'Keyboard: arrows or A/D to move · Space to jump · Shift to dash · Esc to pause'));
      return wrap;
    });
    this.confirmReset = false;
  }

  private confirmReset = false;

  private header(title: string, back: () => void): HTMLElement {
    const head = el('div', 'panel-head');
    head.append(this.button('←', back, 'back'), el('h2', undefined, title));
    return head;
  }

  // ── playing ───────────────────────────────────────────────────────────────

  private startLevel(def: LevelDef): void {
    this.currentLevel = def;
    this.audio.unlock();
    this.audio.setWorld(def.world);
    const palette = paletteForWorld(def.world);
    this.cache.setPalette(`w${def.world}:${this.progress.data.settings.skin}`);
    this.backdrop.build(palette, def.world, this.dpr);

    this.session = new Session(def, this.audio, abilitiesAtLevel(def.id));
    // The chosen skin recolours the character everywhere by overriding three palette entries on
    // this session's own copy — the world's palette is never touched.
    const skin = SKINS.find((s) => s.id === this.progress.data.settings.skin) ?? SKINS[0];
    Object.assign(this.session.palette, {
      body: skin.colors[0], trim: skin.colors[1], glow: skin.colors[2],
    });
    this.session.camera.shakeEnabled = this.progress.data.settings.screenShake;
    this.session.particles.quality = this.progress.data.settings.particles;

    this.paused = false;
    this.setScreen('game', () => null);
    this.buildHud();
  }

  private buildHud(): void {
    this.hud.replaceChildren();
    const bar = el('div', 'hud-bar');
    bar.innerHTML =
      '<div class="hearts"></div>'
      + '<div class="counts"><span class="spark">✦ <b>0</b></span>'
      + '<span class="ember">◆ <b>0</b></span></div>'
      + '<div class="right"><span class="timer"></span></div>';
    const pause = this.button('❚❚', () => this.togglePause(), 'hud-pause');
    bar.querySelector('.right')!.append(pause);
    this.hud.append(bar);
    this.hud.append(el('div', 'prompt'));
    this.hud.append(el('div', 'powers'));
  }

  private updateHud(): void {
    const s = this.session;
    if (!s) return;
    const hearts = this.hud.querySelector('.hearts');
    if (hearts) {
      hearts.innerHTML = Array.from({ length: 3 }, (_, i) =>
        `<span class="heart${i < s.player.health ? '' : ' gone'}">♥</span>`).join('');
    }
    const spark = this.hud.querySelector('.spark b');
    if (spark) spark.textContent = `${s.sparks}/${s.sparkTotal}`;
    const ember = this.hud.querySelector('.ember b');
    if (ember) ember.textContent = `${s.embers}/${Math.max(1, s.emberTotal)}`;
    const timer = this.hud.querySelector('.timer');
    if (timer) {
      timer.textContent = this.progress.data.settings.showTimer ? fmtTime(s.elapsedMs) : '';
    }

    const prompt = this.hud.querySelector('.prompt');
    if (prompt) {
      prompt.textContent = s.prompt ?? '';
      prompt.classList.toggle('on', Boolean(s.prompt));
    }

    // Active power-ups, with a countdown bar each.
    const powers = this.hud.querySelector('.powers');
    if (powers) {
      const active = (['shield', 'speed', 'jump', 'magnet', 'invincible', 'doubleJump'] as const)
        .filter((k) => s.player.isActive(k));
      powers.innerHTML = active.map((k) => {
        const left = s.player.powerRemaining(k);
        const pct = Number.isFinite(left) ? Math.max(0, Math.min(1, left / 10)) : 1;
        return `<span class="pw pw-${k}"><i style="width:${pct * 100}%"></i>${k}</span>`;
      }).join('');
    }
  }

  private togglePause(force?: boolean): void {
    if (!this.session) return;
    const next = force ?? !this.paused;
    if (next === this.paused) return;
    this.paused = next;
    this.input.clear();

    if (!this.paused) { this.ui.replaceChildren(); this.ui.style.pointerEvents = 'none'; return; }

    const wrap = el('div', 'panel overlay');
    wrap.append(el('h2', undefined, 'Paused'));
    const stack = el('div', 'stack');
    stack.append(
      this.button('RESUME', () => this.togglePause(false), 'btn primary'),
      this.button('RESTART', () => { this.session?.restartFromStart(); this.togglePause(false); }),
      this.button('LEVELS', () => { this.showWorlds(); }),
      this.button('MAIN MENU', () => this.showMenu()),
    );
    wrap.append(stack);
    this.ui.replaceChildren(wrap);
    this.ui.style.pointerEvents = 'auto';
  }

  /** The results panel, shown a beat after the beacon lights. */
  private finishLevel(): void {
    const s = this.session;
    const def = this.currentLevel;
    if (!s || !def || this.screen !== 'game') return;
    if (this.ui.querySelector('.results')) return;         // already shown

    const result = s.result();
    const { newStars } = this.progress.complete(
      def.id, result.stars, result.timeMs, result.sparks, result.embers, result.secret);
    this.progress.data.deaths += result.deaths;
    this.progress.save();

    const wrap = el('div', 'panel overlay results');
    const starRow = Array.from({ length: 3 }, (_, i) =>
      `<span class="star${i < result.stars ? ' on' : ''}">★</span>`).join('');
    wrap.innerHTML =
      `<h2>Beacon Lit</h2><p class="sub">${def.name}</p>`
      + `<div class="stars-big">${starRow}</div>`
      + `<div class="result-grid">`
      + `<div><b>${result.sparks}/${result.sparkTotal}</b><small>sparks</small></div>`
      + `<div><b>${fmtTime(result.timeMs)}</b><small>time · par ${def.parTime}s</small></div>`
      + `<div><b>${result.embers ? 'Found' : '—'}</b><small>emberstone</small></div>`
      + `<div><b>${result.deaths}</b><small>falls</small></div>`
      + `</div>`
      + (newStars > 0 ? '<p class="new">New best!</p>' : '');

    const stack = el('div', 'stack');
    const nextId = this.progress.nextLevelId(def.id);
    const nextDef = nextId ? LEVELS.find((l) => l.id === nextId) : undefined;
    if (nextDef) stack.append(this.button('NEXT LEVEL', () => this.startLevel(nextDef), 'btn primary'));
    stack.append(
      this.button('REPLAY', () => this.startLevel(def)),
      this.button('LEVEL SELECT', () => { this.worldPage = def.world; this.showLevels(); }),
      this.button('MAIN MENU', () => this.showMenu()),
    );
    wrap.append(stack);
    this.ui.replaceChildren(wrap);
    this.ui.style.pointerEvents = 'auto';
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.input.detach();
  }
}
