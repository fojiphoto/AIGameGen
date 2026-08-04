/**
 * Runtimes for the board / grid genres: memory_match, sliding_puzzle, merge_2048, snake.
 *
 * They live together because they share the same skeleton — a centred grid, tap or swipe
 * input, a HUD with one budget (time or moves), and a win condition checked after each
 * player action. Only the rules differ.
 *
 * Every one of these renders from the palette alone: no sprite sheets, so a generated
 * theme applies instantly and the APK stays under half a megabyte.
 */

import Phaser from 'phaser';
import { VIEW_W, VIEW_H, FONT_DISPLAY, FONT_BODY } from '../constants.mjs';
import { asInt, shade } from '../textures.mjs';
import { sfx, unlock as unlockAudio } from '../audio.mjs';
import * as save from '../save.mjs';
import { telemetry } from '../telemetry.mjs';
import { hudBar, pauseOverlay, boardLayout, mkButton } from './shared.mjs';

/** Common lifecycle: HUD, pause, win/lose transitions, telemetry. */
class BoardBase extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init(data) {
    this.cfg = this.registry.get('cfg');
    this.levelIndex = data.level ?? 1;
    this.deaths = data.deaths ?? 0;
    this.level = this.cfg.levels[this.levelIndex - 1];
    this.pal = this.cfg.theme.palette;
    this.done = false;
    this.paused = false;
    this.elapsed = 0;
  }

  baseCreate() {
    this.cameras.main.setBackgroundColor(this.pal.bg);
    // a soft top band so the HUD always has contrast to sit on
    const g = this.add.graphics();
    g.fillStyle(asInt(this.pal.bgAccent), 0.5);
    g.fillRect(0, 0, VIEW_W, 64);
    this.hud = hudBar(this, this.level.name, this.pal);
    this.hint = this.add
      .text(VIEW_W / 2, VIEW_H - 18, this.cfg.copy.tutorial.toUpperCase(), {
        fontFamily: FONT_BODY, fontSize: '13px', color: this.pal.text,
      })
      .setOrigin(0.5, 1)
      .setAlpha(this.levelIndex === 1 ? 0.6 : 0);
    this.input.keyboard?.on('keydown-ESC', () => this.togglePause());
    telemetry.levelAttempt(this.levelIndex);
  }

  togglePause() {
    if (this.done) return;
    this.paused = !this.paused;
    if (this.paused) this.overlay = pauseOverlay(this, this.pal, () => this.togglePause());
    else { this.overlay?.destroy(true); this.overlay = null; }
  }

  fadeHint() {
    if (this.hint?.alpha > 0) this.tweens.add({ targets: this.hint, alpha: 0, duration: 400 });
  }

  finish(win, { score = 0, target = 0, unit = '', cause = '' } = {}) {
    if (this.done) return;
    this.done = true;
    if (win) {
      sfx.win();
      const stars = save.starsFor(this.deaths);
      const res = save.recordWin(this.levelIndex, stars, this.cfg.progression.endlessUnlockAt);
      telemetry.levelClear(this.levelIndex);
      telemetry.sessionEnd({ level: this.levelIndex, score, durationS: Math.round(this.elapsed) });
      this.time.delayedCall(420, () =>
        this.scene.start('Result', {
          outcome: 'win', mode: 'level', level: this.levelIndex,
          score, target, unit, deaths: this.deaths, stars, unlockedEndless: res.unlockedEndless,
        })
      );
    } else {
      this.deaths++;
      save.recordDeath();
      sfx.crash();
      this.cameras.main.shake(200, 0.01);
      telemetry.levelDeath(this.levelIndex);
      telemetry.sessionEnd({ level: this.levelIndex, score, durationS: Math.round(this.elapsed) });
      this.time.delayedCall(560, () =>
        this.scene.start('Result', {
          outcome: 'lose', mode: 'level', level: this.levelIndex,
          score, target, unit, deaths: this.deaths, cause,
        })
      );
    }
  }
}

// ─── memory_match ───────────────────────────────────────────────────────────

const FACE_GLYPHS = '★●▲■◆✚♥♠♣♦☀☾✦⬟⬢▼◐✜⧫⬤✧❖✵⚑'.split('');

export class PlayMemory extends BoardBase {
  create() {
    this.baseCreate();
    const l = this.level;
    this.layout = boardLayout(l.cols, l.rows, { maxCell: 84 });
    this.matched = 0;
    this.flipped = [];
    this.busy = true; // during the peek
    this.remaining = l.timeLimit;

    this.cards = l.deal.map((face, i) => this.makeCard(i, face));
    this.hud.setProgress(0);
    this.hud.setRight(`0 / ${l.pairs} PAIRS · ${this.remaining}s`);

    // free look, then hide — the peek is what makes early levels approachable
    const peek = (this.cfg.rules.peekSeconds ?? 0) * 1000;
    if (peek > 0) {
      for (const c of this.cards) this.showCard(c, true);
      this.time.delayedCall(peek, () => this.startRound());
    } else {
      this.startRound();
    }
  }

  startRound() {
    for (const c of this.cards) if (!c.matched) this.showCard(c, false);
    this.busy = false;
    this.timer = this.time.addEvent({
      delay: 1000, loop: true,
      callback: () => {
        if (this.paused || this.done) return;
        this.remaining--;
        this.refreshHud();
        if (this.remaining <= 0) this.finish(false, { score: this.matched, target: this.level.pairs, unit: 'pairs', cause: 'time' });
      },
    });
  }

  makeCard(i, face) {
    const l = this.level;
    const c = i % l.cols;
    const r = Math.floor(i / l.cols);
    const { cell, cx, cy } = this.layout;
    const x = cx(c) + cell / 2;
    const y = cy(r) + cell / 2;

    const back = this.add.image(x, y, 'card_back').setDisplaySize(cell, cell).setInteractive({ useHandCursor: true });
    const front = this.add.image(x, y, 'card_front').setDisplaySize(cell, cell).setVisible(false);
    const glyph = this.add
      .text(x, y, FACE_GLYPHS[face % FACE_GLYPHS.length], {
        fontFamily: FONT_DISPLAY, fontSize: `${Math.round(cell * 0.46)}px`, color: this.pal.bg,
      })
      .setOrigin(0.5)
      .setVisible(false);

    const card = { i, face, back, front, glyph, revealed: false, matched: false };
    back.on('pointerdown', () => this.tap(card));
    return card;
  }

  showCard(card, on) {
    card.revealed = on;
    card.back.setVisible(!on);
    card.front.setVisible(on);
    card.glyph.setVisible(on);
  }

  tap(card) {
    unlockAudio();
    if (this.busy || this.paused || this.done || card.revealed || card.matched) return;
    this.fadeHint();
    sfx.select();
    this.showCard(card, true);
    this.flipped.push(card);
    if (this.flipped.length < 2) return;

    const [a, b] = this.flipped;
    this.flipped = [];
    if (a.face === b.face) {
      a.matched = b.matched = true;
      a.back.disableInteractive();
      b.back.disableInteractive();
      this.matched++;
      sfx.milestone();
      this.tweens.add({ targets: [a.front, a.glyph, b.front, b.glyph], alpha: 0.55, duration: 200 });
      this.refreshHud();
      if (this.matched >= this.level.pairs) {
        this.timer?.remove();
        this.finish(true, { score: this.matched, target: this.level.pairs, unit: 'pairs' });
      }
      return;
    }

    this.busy = true;
    const penalty = this.cfg.rules.mismatchPenalty ?? 0;
    if (penalty > 0) {
      this.remaining = Math.max(0, this.remaining - Math.round(penalty));
      this.refreshHud();
    }
    this.time.delayedCall(this.cfg.rules.flipBackMs, () => {
      this.showCard(a, false);
      this.showCard(b, false);
      this.busy = false;
      if (this.remaining <= 0) this.finish(false, { score: this.matched, target: this.level.pairs, unit: 'pairs', cause: 'time' });
    });
  }

  refreshHud() {
    this.hud.setProgress(this.matched / this.level.pairs);
    this.hud.setRight(`${this.matched} / ${this.level.pairs} PAIRS · ${Math.max(0, this.remaining)}s`);
  }

  update(_t, dMs) {
    if (!this.paused && !this.done) this.elapsed += dMs / 1000;
  }
}

// ─── sliding_puzzle ─────────────────────────────────────────────────────────

export class PlaySliding extends BoardBase {
  create() {
    this.baseCreate();
    const l = this.level;
    this.size = l.size;
    this.tiles = [...l.tiles];
    this.blank = l.blank;
    this.moves = 0;
    this.layout = boardLayout(l.size, l.size, { maxCell: 88 });
    this.sprites = new Map();
    this.render();
    this.refreshHud();
    this.input.keyboard?.on('keydown', (e) => {
      const d = { ArrowUp: -this.size, ArrowDown: this.size, ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (d === undefined) return;
      // arrow moves the tile INTO the blank from the opposite side
      const from = this.blank - d;
      if (this.isAdjacent(from, this.blank)) this.slide(from);
    });
  }

  isAdjacent(a, b) {
    if (a < 0 || a >= this.size * this.size) return false;
    const ra = Math.floor(a / this.size), ca = a % this.size;
    const rb = Math.floor(b / this.size), cb = b % this.size;
    return Math.abs(ra - rb) + Math.abs(ca - cb) === 1;
  }

  render() {
    const { cell, cx, cy } = this.layout;
    for (const s of this.sprites.values()) s.destroy();
    this.sprites.clear();
    for (let i = 0; i < this.tiles.length; i++) {
      const v = this.tiles[i];
      if (v === 0) continue;
      const c = i % this.size;
      const r = Math.floor(i / this.size);
      const x = cx(c) + cell / 2;
      const y = cy(r) + cell / 2;
      const container = this.add.container(x, y);
      const box = this.add.image(0, 0, 'tile_face').setDisplaySize(cell, cell);
      container.add(box);
      if (this.level.faceStyle === 'numbers') {
        container.add(
          this.add.text(0, 0, String(v), {
            fontFamily: FONT_DISPLAY, fontSize: `${Math.round(cell * 0.36)}px`, color: this.pal.bg,
          }).setOrigin(0.5)
        );
      } else {
        // slice a palette gradient so the solved state forms a picture
        const t = (v - 1) / (this.size * this.size - 1);
        const patch = this.add.graphics();
        patch.fillStyle(shade(this.pal.player, -0.35 + t * 0.7), 1);
        patch.fillRoundedRect(-cell * 0.36, -cell * 0.36, cell * 0.72, cell * 0.72, 6);
        container.add(patch);
      }
      const zone = this.add.zone(x, y, cell, cell).setInteractive({ useHandCursor: true });
      zone.on('pointerdown', () => this.slide(i));
      this.sprites.set(i, container);
      this.sprites.set(`z${i}`, zone);
    }
  }

  slide(from) {
    unlockAudio();
    if (this.paused || this.done) return;
    if (!this.isAdjacent(from, this.blank)) return;
    this.fadeHint();
    this.tiles[this.blank] = this.tiles[from];
    this.tiles[from] = 0;
    this.blank = from;
    this.moves++;
    sfx.select();
    this.render();
    this.refreshHud();

    if (this.isSolved()) {
      this.finish(true, { score: this.moves, target: this.level.moveLimit, unit: 'moves' });
    } else if (this.moves >= this.level.moveLimit) {
      this.finish(false, { score: this.moves, target: this.level.moveLimit, unit: 'moves', cause: 'moves' });
    }
  }

  isSolved() {
    const n = this.size * this.size;
    return this.tiles.every((v, i) => v === (i === n - 1 ? 0 : i + 1));
  }

  refreshHud() {
    this.hud.setProgress(this.moves / this.level.moveLimit);
    const placed = this.tiles.filter((v, i) => v !== 0 && v === i + 1).length;
    this.hud.setRight(`${placed}/${this.size * this.size - 1} PLACED · ${this.level.moveLimit - this.moves} MOVES`);
  }

  update(_t, dMs) {
    if (!this.paused && !this.done) this.elapsed += dMs / 1000;
  }
}

// ─── merge_2048 ─────────────────────────────────────────────────────────────

export class PlayMerge extends BoardBase {
  create() {
    this.baseCreate();
    const l = this.level;
    this.size = l.size;
    this.cells = [...l.cells];
    this.moves = 0;
    this.best = 0;
    this.layout = boardLayout(l.size, l.size, { maxCell: 86 });
    this.rng = mulberry((this.cfg.meta.seed + this.levelIndex * 7919) >>> 0);
    this.sprites = [];
    this.render();
    this.refreshHud();

    this.input.keyboard?.on('keydown', (e) => {
      const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        w: 'up', s: 'down', a: 'left', d: 'right' }[e.key];
      if (dir) this.move(dir);
    });
    // swipe
    let start = null;
    this.input.on('pointerdown', (p) => (start = { x: p.x, y: p.y }));
    this.input.on('pointerup', (p) => {
      if (!start) return;
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      start = null;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
      this.move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
    });
  }

  render() {
    for (const s of this.sprites) s.destroy();
    this.sprites = [];
    const { cell, cx, cy, x, y, w, h, gap } = this.layout;
    const frame = this.add.graphics();
    frame.fillStyle(shade(this.pal.bg, 0.08), 1);
    frame.fillRoundedRect(x - gap, y - gap, w + gap * 2, h + gap * 2, 10);
    for (let i = 0; i < this.size * this.size; i++) {
      frame.fillStyle(shade(this.pal.bgAccent, -0.25), 1);
      frame.fillRoundedRect(cx(i % this.size), cy(Math.floor(i / this.size)), cell, cell, 8);
    }
    this.sprites.push(frame);

    for (let i = 0; i < this.cells.length; i++) {
      const v = this.cells[i];
      if (!v) continue;
      const c = i % this.size;
      const r = Math.floor(i / this.size);
      const g = this.add.graphics();
      // brightness ramps with the exponent so progress is readable at a glance
      const step = Math.min(1, (Math.log2(v) - 1) / 10);
      g.fillStyle(shade(this.pal.player, -0.5 + step * 0.9), 1);
      g.fillRoundedRect(cx(c), cy(r), cell, cell, 8);
      this.sprites.push(g);
      this.sprites.push(
        this.add.text(cx(c) + cell / 2, cy(r) + cell / 2, String(v), {
          fontFamily: FONT_DISPLAY,
          fontSize: `${Math.round(cell * (v >= 1024 ? 0.24 : v >= 128 ? 0.3 : 0.36))}px`,
          color: step > 0.45 ? this.pal.bg : this.pal.text,
        }).setOrigin(0.5)
      );
    }
  }

  /** Collapse one line toward index 0. Returns [newLine, gained, merged]. */
  static collapse(line) {
    const vals = line.filter((v) => v > 0);
    const out = [];
    let gained = 0;
    let merged = false;
    for (let i = 0; i < vals.length; i++) {
      if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
        out.push(vals[i] * 2);
        gained += vals[i] * 2;
        merged = true;
        i++;
      } else {
        out.push(vals[i]);
      }
    }
    while (out.length < line.length) out.push(0);
    return [out, gained, merged];
  }

  lines(dir) {
    const n = this.size;
    const out = [];
    for (let k = 0; k < n; k++) {
      const idx = [];
      for (let j = 0; j < n; j++) {
        if (dir === 'left') idx.push(k * n + j);
        else if (dir === 'right') idx.push(k * n + (n - 1 - j));
        else if (dir === 'up') idx.push(j * n + k);
        else idx.push((n - 1 - j) * n + k);
      }
      out.push(idx);
    }
    return out;
  }

  move(dir) {
    unlockAudio();
    if (this.paused || this.done) return;
    let changed = false;
    let mergedAny = false;
    for (const idx of this.lines(dir)) {
      const before = idx.map((i) => this.cells[i]);
      const [after, , merged] = PlayMerge.collapse(before);
      if (after.some((v, j) => v !== before[j])) changed = true;
      if (merged) mergedAny = true;
      idx.forEach((i, j) => (this.cells[i] = after[j]));
    }
    if (!changed) return;

    this.fadeHint();
    this.moves++;
    mergedAny ? sfx.milestone() : sfx.select();
    this.spawn();
    this.render();
    this.refreshHud();

    this.best = Math.max(...this.cells);
    if (this.best >= this.level.target) {
      return this.finish(true, { score: this.best, target: this.level.target, unit: '' });
    }
    if (this.level.moveLimit > 0 && this.moves >= this.level.moveLimit) {
      return this.finish(false, { score: this.best, target: this.level.target, unit: '', cause: 'moves' });
    }
    if (!this.hasMove()) {
      this.finish(false, { score: this.best, target: this.level.target, unit: '', cause: 'stuck' });
    }
  }

  spawn() {
    const free = this.cells.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
    if (!free.length) return;
    const i = free[Math.floor(this.rng() * free.length)];
    this.cells[i] = this.rng() < this.level.spawnFourChance ? 4 : 2;
  }

  hasMove() {
    if (this.cells.some((v) => v === 0)) return true;
    const n = this.size;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const v = this.cells[r * n + c];
        if (c + 1 < n && this.cells[r * n + c + 1] === v) return true;
        if (r + 1 < n && this.cells[(r + 1) * n + c] === v) return true;
      }
    }
    return false;
  }

  refreshHud() {
    const best = Math.max(...this.cells, 0);
    this.hud.setProgress(Math.log2(Math.max(2, best)) / Math.log2(this.level.target));
    this.hud.setRight(`${best} / ${this.level.target}${this.level.moveLimit > 0 ? ` · ${this.level.moveLimit - this.moves} MOVES` : ''}`);
  }

  update(_t, dMs) {
    if (!this.paused && !this.done) this.elapsed += dMs / 1000;
  }
}

// ─── snake ──────────────────────────────────────────────────────────────────

export class PlaySnake extends BoardBase {
  create() {
    this.baseCreate();
    const l = this.level;
    this.cols = l.cols;
    this.rows = l.rows;
    this.layout = boardLayout(l.cols, l.rows, { gap: 1, maxCell: 30 });
    this.walls = new Set(l.walls);
    this.rng = mulberry((this.cfg.meta.seed + this.levelIndex * 104729) >>> 0);

    this.snake = [{ r: l.start.r, c: l.start.c }];
    for (let i = 1; i < 3; i++) this.snake.push({ r: l.start.r, c: Math.max(0, l.start.c - i) });
    this.dir = { r: 0, c: 1 };
    this.nextDir = this.dir;
    this.pendingGrow = 0;
    this.eaten = 0;
    this.acc = 0;
    this.food = this.placeFood();

    this.gfx = this.add.graphics();
    this.draw();
    this.refreshHud();

    const set = (r, c) => {
      // no instant reversal — it would be an accidental self-collision every time
      if (this.dir.r === -r && this.dir.c === -c) return;
      this.nextDir = { r, c };
      this.fadeHint();
    };
    this.input.keyboard?.on('keydown', (e) => {
      const m = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
        w: [-1, 0], s: [1, 0], a: [0, -1], d: [0, 1] }[e.key];
      if (m) set(m[0], m[1]);
    });
    let start = null;
    this.input.on('pointerdown', (p) => (start = { x: p.x, y: p.y }));
    this.input.on('pointerup', (p) => {
      if (!start) return;
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      start = null;
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
      if (Math.abs(dx) > Math.abs(dy)) set(0, dx > 0 ? 1 : -1);
      else set(dy > 0 ? 1 : -1, 0);
    });
  }

  idx(r, c) { return r * this.cols + c; }

  placeFood() {
    const occupied = new Set([...this.walls, ...this.snake.map((s) => this.idx(s.r, s.c))]);
    const free = [];
    for (let i = 0; i < this.cols * this.rows; i++) if (!occupied.has(i)) free.push(i);
    if (!free.length) return null;
    const i = free[Math.floor(this.rng() * free.length)];
    return { r: Math.floor(i / this.cols), c: i % this.cols };
  }

  update(_t, dMs) {
    if (this.paused || this.done) return;
    this.elapsed += dMs / 1000;
    this.acc += dMs;
    while (this.acc >= this.level.stepMs) {
      this.acc -= this.level.stepMs;
      this.step();
      if (this.done) return;
    }
  }

  step() {
    this.dir = this.nextDir;
    const head = this.snake[0];
    let r = head.r + this.dir.r;
    let c = head.c + this.dir.c;

    if (this.level.wrapEdges) {
      r = (r + this.rows) % this.rows;
      c = (c + this.cols) % this.cols;
    } else if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) {
      return this.finish(false, { score: this.eaten, target: this.level.foodTarget, unit: 'food', cause: 'wall' });
    }
    if (this.walls.has(this.idx(r, c))) {
      return this.finish(false, { score: this.eaten, target: this.level.foodTarget, unit: 'food', cause: 'wall' });
    }
    // the tail tip moves out of the way this step unless we are growing
    const body = this.pendingGrow > 0 ? this.snake : this.snake.slice(0, -1);
    if (body.some((s) => s.r === r && s.c === c)) {
      return this.finish(false, { score: this.eaten, target: this.level.foodTarget, unit: 'food', cause: 'self' });
    }

    this.snake.unshift({ r, c });
    if (this.pendingGrow > 0) this.pendingGrow--;
    else this.snake.pop();

    if (this.food && this.food.r === r && this.food.c === c) {
      this.eaten++;
      this.pendingGrow += this.level.growPerFood;
      sfx.milestone();
      this.refreshHud();
      if (this.eaten >= this.level.foodTarget) {
        this.draw();
        return this.finish(true, { score: this.eaten, target: this.level.foodTarget, unit: 'food' });
      }
      this.food = this.placeFood();
    }
    this.draw();
  }

  draw() {
    const { cell, gap, cx, cy, x, y, w, h } = this.layout;
    const g = this.gfx;
    g.clear();
    g.fillStyle(shade(this.pal.bg, 0.07), 1);
    g.fillRoundedRect(x - 6, y - 6, w + 12, h + 12, 8);

    g.fillStyle(shade(this.pal.ground, -0.2), 1);
    for (const i of this.walls) {
      g.fillRect(cx(i % this.cols), cy(Math.floor(i / this.cols)), cell, cell);
    }
    if (this.food) {
      g.fillStyle(asInt(this.pal.accent), 1);
      g.fillCircle(cx(this.food.c) + cell / 2, cy(this.food.r) + cell / 2, cell * 0.36);
    }
    this.snake.forEach((s, i) => {
      // head brightest, tail dimmest, so direction is obvious at a glance
      g.fillStyle(i === 0 ? asInt(this.pal.player) : shade(this.pal.player, -0.15 - Math.min(0.5, i * 0.03)), 1);
      g.fillRoundedRect(cx(s.c) + 1, cy(s.r) + 1, cell - 2, cell - 2, i === 0 ? 5 : 3);
    });
  }

  refreshHud() {
    this.hud.setProgress(this.eaten / this.level.foodTarget);
    this.hud.setRight(`${this.eaten} / ${this.level.foodTarget} FOOD`);
  }
}

// ─── textures ───────────────────────────────────────────────────────────────

export function buildTextures(scene, cfg) {
  const p = cfg.theme.palette;
  const mk = () => scene.make.graphics({ x: 0, y: 0, add: false });

  // card back: palette-coloured with a subtle emblem
  let g = mk();
  g.fillStyle(shade(p.player, -0.55), 1);
  g.fillRoundedRect(0, 0, 100, 100, 12);
  g.fillStyle(shade(p.player, -0.3), 1);
  g.fillRoundedRect(4, 4, 92, 92, 10);
  g.fillStyle(asInt(p.accent), 0.85);
  g.fillCircle(50, 50, 16);
  g.generateTexture('card_back', 100, 100);
  g.destroy();

  g = mk();
  g.fillStyle(shade(p.player, 0.35), 1);
  g.fillRoundedRect(0, 0, 100, 100, 12);
  g.fillStyle(asInt(p.player), 1);
  g.fillRoundedRect(4, 4, 92, 92, 10);
  g.generateTexture('card_front', 100, 100);
  g.destroy();

  g = mk();
  g.fillStyle(shade(p.player, -0.2), 1);
  g.fillRoundedRect(0, 0, 100, 100, 12);
  g.fillStyle(asInt(p.player), 1);
  g.fillRoundedRect(3, 3, 94, 94, 10);
  g.fillStyle(shade(p.player, 0.3), 1);
  g.fillRoundedRect(3, 3, 94, 8, 4);
  g.generateTexture('tile_face', 100, 100);
  g.destroy();

  g = mk();
  g.fillStyle(asInt(p.text), 0.9);
  g.fillCircle(4, 4, 3);
  g.generateTexture('dot', 8, 8);
  g.destroy();
}

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
