/**
 * The board renderer.
 *
 * One canvas, drawn only when something changed. A chess board is static between moves, so a
 * permanent 60 fps render loop would burn a phone battery to redraw an identical image — the
 * renderer instead marks itself dirty on any state change and animates only while a piece is
 * actually travelling. In a quiet position the page uses no CPU at all.
 *
 * Two more decisions worth naming:
 *
 * The empty board — squares, frame, coordinates — is baked into its own offscreen canvas and
 * blitted as a single image. It only changes on a resize or a theme switch, and drawing 64
 * rounded rectangles plus 16 text labels every frame is otherwise the most expensive thing here
 * by a wide margin.
 *
 * Everything is laid out from one number, `squareSize`. Ranks, files, pieces, highlights and
 * animation distances are all derived from it, which is what guarantees the board stays exactly
 * square at every window size — the failure mode the brief calls out, and one that is only
 * avoidable by never letting width and height be computed separately.
 */

import {
  Position, Move, Color, WHITE, BLACK, square, fileOf, rankOf, pieceType, pieceColor,
  moveFrom, moveTo, isCapture, isEnPassant, onBoard, PAWN, KING,
} from '../core/index.js';
import { PieceAtlas } from './pieces.js';
import { Theme } from './theme.js';

export interface BoardCallbacks {
  onSquareDown(sq: number, x: number, y: number): void;
  onSquareUp(sq: number, x: number, y: number): void;
  onDragMove(x: number, y: number): void;
  onHover(sq: number): void;
}

interface MovingPiece {
  type: number;
  color: Color;
  from: number;
  to: number;
  /** 0..1 */
  t: number;
  duration: number;
  startedAt: number;
}

interface FadingPiece {
  type: number;
  color: Color;
  sq: number;
  t: number;
  duration: number;
  startedAt: number;
}

/** Fraction of the board taken by the coordinate frame on each side. */
const FRAME_RATIO = 0.052;

export class BoardView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private backdrop: HTMLCanvasElement;
  private backdropCtx: CanvasRenderingContext2D;

  private atlas = new PieceAtlas();
  private theme!: Theme;

  /** CSS pixels. */
  private size = 0;
  private squareSize = 0;
  private frame = 0;
  private dpr = 1;
  private backdropKey = '';

  /** Board state to draw. */
  private position: Position | null = null;
  flipped = false;

  /** Feedback. */
  selected = -1;
  legalTargets: Move[] = [];
  lastMove: Move | null = null;
  checkSquare = -1;
  hintMove: Move | null = null;
  premoveHint = -1;
  hovered = -1;

  /** Settings. */
  showCoordinates = true;
  showLegalMoves = true;
  animationScale = 1;

  /** Drag. */
  private dragging: { type: number; color: Color; from: number } | null = null;
  private dragX = 0;
  private dragY = 0;

  private moving: MovingPiece[] = [];
  private fading: FadingPiece[] = [];
  private checkPulse = 0;
  private dirty = true;
  private rafId = 0;
  private running = false;

  constructor(private callbacks: BoardCallbacks) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board-canvas';
    // The board handles its own gestures; without this a drag on a phone scrolls the page
    // instead of moving the piece, which makes touch play impossible.
    this.canvas.style.touchAction = 'none';
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.backdrop = document.createElement('canvas');
    this.backdropCtx = this.backdrop.getContext('2d')!;
    this.bindInput();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.atlas.useSet(theme.pieces);
    this.backdropKey = '';
    this.markDirty();
  }

  setPieceSet(key: string): void {
    this.atlas.useSet(key);
    this.markDirty();
  }

  setPosition(pos: Position | null): void {
    this.position = pos;
    this.markDirty();
  }

  /**
   * Resize to a CSS-pixel square.
   *
   * The caller passes one number, never a width and a height. That is the entire defence against
   * the board turning into a rectangle: there is no code path in which the two can disagree.
   */
  resize(cssSize: number, dpr: number): void {
    const size = Math.max(160, Math.floor(cssSize));
    if (size === this.size && dpr === this.dpr) return;
    this.size = size;
    this.dpr = dpr;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.frame = this.showCoordinates ? Math.round(size * FRAME_RATIO) : Math.round(size * 0.012);
    this.squareSize = (size - this.frame * 2) / 8;
    this.backdropKey = '';
    this.markDirty();
  }

  markDirty(): void {
    this.dirty = true;
    this.ensureRunning();
  }

  private ensureRunning(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.frameLoop);
  }

  /**
   * Called when the tab is hidden, so a backgrounded game stops asking for frames.
   *
   * Any animation in flight is snapped to its end state rather than frozen. A hidden tab gets no
   * animation frames, so a half-finished slide would still be half-finished when the player
   * returns — with the moving piece drawn between two squares and its destination square blank.
   */
  suspend(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.moving.length = 0;
    this.fading.length = 0;
    this.dirty = true;
  }

  resume(): void {
    this.markDirty();
  }

  private frameLoop = (now: number): void => {
    let animating = false;

    for (let i = this.moving.length - 1; i >= 0; i--) {
      const m = this.moving[i];
      m.t = Math.min(1, (now - m.startedAt) / m.duration);
      if (m.t >= 1) this.moving.splice(i, 1);
      animating = true;
    }
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      f.t = Math.min(1, (now - f.startedAt) / f.duration);
      if (f.t >= 1) this.fading.splice(i, 1);
      animating = true;
    }
    if (this.checkSquare >= 0) {
      this.checkPulse = now / 1000;
      animating = true;
    }
    if (this.dragging) animating = true;

    if (this.dirty || animating) {
      this.dirty = false;
      this.render();
    }

    if (animating || this.dirty) {
      this.rafId = requestAnimationFrame(this.frameLoop);
    } else {
      // Nothing is moving. Stop asking for frames entirely rather than spinning on a static
      // image — this is the difference between a chess board and a screensaver on a battery.
      this.running = false;
      this.rafId = 0;
    }
  };

  // ── geometry ──────────────────────────────────────────────────────────────

  /** Top-left corner of a square, in CSS pixels relative to the canvas. */
  squareXY(sq: number): { x: number; y: number } {
    let f = fileOf(sq), r = rankOf(sq);
    if (this.flipped) { f = 7 - f; r = 7 - r; }
    return {
      x: this.frame + f * this.squareSize,
      y: this.frame + (7 - r) * this.squareSize,
    };
  }

  /** Square under a point, or -1 outside the playing area. */
  squareAt(x: number, y: number): number {
    const f0 = Math.floor((x - this.frame) / this.squareSize);
    const r0 = Math.floor((y - this.frame) / this.squareSize);
    if (f0 < 0 || f0 > 7 || r0 < 0 || r0 > 7) return -1;
    const f = this.flipped ? 7 - f0 : f0;
    const r = this.flipped ? r0 : 7 - r0;
    return square(f, r);
  }

  get squarePx(): number { return this.squareSize; }

  // ── animation entry points ────────────────────────────────────────────────

  /**
   * Slide a piece from one square to another.
   *
   * @param duration base milliseconds, scaled by the animation-speed setting. The scale can be
   *   0, which is the "Off" setting — the piece appears at its destination immediately, which
   *   serious players asked for and which also makes the whole game usable on a slow device.
   */
  animateMove(type: number, color: Color, from: number, to: number, duration = 180): void {
    const scaled = duration * this.animationScale;
    if (scaled < 16) { this.markDirty(); return; }
    this.moving.push({
      type, color, from, to, t: 0, duration: scaled, startedAt: performance.now(),
    });
    this.ensureRunning();
  }

  animateCapture(type: number, color: Color, sq: number, duration = 200): void {
    const scaled = duration * this.animationScale;
    if (scaled < 16) { this.markDirty(); return; }
    this.fading.push({ type, color, sq, t: 0, duration: scaled, startedAt: performance.now() });
    this.ensureRunning();
  }

  /** True while any piece is still travelling — the game loop waits on this before continuing. */
  get animating(): boolean { return this.moving.length > 0 || this.fading.length > 0; }

  // ── input ─────────────────────────────────────────────────────────────────

  private bindInput(): void {
    const local = (e: PointerEvent | MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      // Scale from displayed size back to layout size: a CSS transform on an ancestor (the
      // menu-to-game transition uses one) makes the rect larger than the canvas, and without
      // this correction every click lands on the wrong square mid-animation.
      const sx = rect.width / this.size;
      const sy = rect.height / this.size;
      return { x: (e.clientX - rect.left) / sx, y: (e.clientY - rect.top) / sy };
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      // Only the primary button; a right-click is for the context menu, not for a move.
      if (e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      const { x, y } = local(e);
      this.dragX = x; this.dragY = y;
      this.callbacks.onSquareDown(this.squareAt(x, y), x, y);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const { x, y } = local(e);
      this.dragX = x; this.dragY = y;
      if (this.dragging) {
        this.callbacks.onDragMove(x, y);
        this.markDirty();
        return;
      }
      const sq = this.squareAt(x, y);
      if (sq !== this.hovered) {
        this.hovered = sq;
        this.callbacks.onHover(sq);
        this.markDirty();
      }
    });

    const up = (e: PointerEvent) => {
      const { x, y } = local(e);
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      this.callbacks.onSquareUp(this.squareAt(x, y), x, y);
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);

    this.canvas.addEventListener('pointerleave', () => {
      if (this.hovered !== -1) { this.hovered = -1; this.markDirty(); }
    });

    // A long-press on mobile otherwise pops the OS text-selection menu mid-drag.
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  startDrag(type: number, color: Color, from: number): void {
    this.dragging = { type, color, from };
    this.markDirty();
  }

  endDrag(): void {
    this.dragging = null;
    this.markDirty();
  }

  get isDragging(): boolean { return this.dragging !== null; }

  // ── drawing ───────────────────────────────────────────────────────────────

  private render(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);

    this.drawBackdrop(ctx);
    this.drawHighlights(ctx);
    this.drawPieces(ctx);
    this.drawLegalMarkers(ctx);
    this.drawDragged(ctx);
  }

  /**
   * The empty board, cached.
   *
   * Rebuilt only when the size, theme, orientation or coordinate setting changes — which is
   * roughly never during play, and every frame if this were inlined into `render`.
   */
  private drawBackdrop(ctx: CanvasRenderingContext2D): void {
    const key = `${this.size}:${this.dpr}:${this.theme.key}:${this.flipped}:${this.showCoordinates}`;
    if (key !== this.backdropKey) {
      this.backdropKey = key;
      this.backdrop.width = Math.round(this.size * this.dpr);
      this.backdrop.height = Math.round(this.size * this.dpr);
      const b = this.backdropCtx;
      b.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      b.clearRect(0, 0, this.size, this.size);
      this.paintBoard(b);
    }
    ctx.drawImage(this.backdrop, 0, 0, this.size, this.size);
  }

  private paintBoard(ctx: CanvasRenderingContext2D): void {
    const t = this.theme;
    const s = this.size;
    const radius = Math.round(s * 0.022);

    // Frame, with a soft outer shadow so the board sits above the page rather than being pasted
    // onto it.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.round(s * 0.05);
    ctx.shadowOffsetY = Math.round(s * 0.014);
    ctx.fillStyle = t.frame;
    roundRect(ctx, 0, 0, s, s, radius);
    ctx.fill();
    ctx.restore();

    // A bevel on the frame: light along the top, dark along the bottom.
    const bevel = ctx.createLinearGradient(0, 0, 0, s);
    bevel.addColorStop(0, 'rgba(255,255,255,0.16)');
    bevel.addColorStop(0.5, 'rgba(255,255,255,0)');
    bevel.addColorStop(1, 'rgba(0,0,0,0.30)');
    ctx.fillStyle = bevel;
    roundRect(ctx, 0, 0, s, s, radius);
    ctx.fill();

    ctx.strokeStyle = t.frameEdge;
    ctx.lineWidth = Math.max(1, s * 0.003);
    roundRect(ctx, 0.5, 0.5, s - 1, s - 1, radius);
    ctx.stroke();

    // Playing area.
    const inner = this.frame;
    const boardPx = this.squareSize * 8;
    ctx.save();
    ctx.beginPath();
    ctx.rect(inner, inner, boardPx, boardPx);
    ctx.clip();

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = square(f, r);
        const { x, y } = this.squareXY(sq);
        const isLight = (f + r) % 2 === 1;
        ctx.fillStyle = isLight ? t.light : t.dark;
        // +1 on the size closes the hairline seams that sub-pixel square sizes leave between
        // neighbours, which show up as a faint grid over the whole board.
        ctx.fillRect(x, y, this.squareSize + 1, this.squareSize + 1);
      }
    }

    // A very slight vertical wash across the whole playing area: real boards are not evenly lit,
    // and a perfectly flat one looks like a spreadsheet.
    const wash = ctx.createLinearGradient(0, inner, 0, inner + boardPx);
    wash.addColorStop(0, 'rgba(255,255,255,0.05)');
    wash.addColorStop(0.55, 'rgba(0,0,0,0)');
    wash.addColorStop(1, 'rgba(0,0,0,0.10)');
    ctx.fillStyle = wash;
    ctx.fillRect(inner, inner, boardPx, boardPx);
    ctx.restore();

    // Inner shadow where the frame meets the squares.
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.42)';
    ctx.lineWidth = Math.max(1.5, s * 0.006);
    ctx.strokeRect(inner - ctx.lineWidth / 2, inner - ctx.lineWidth / 2,
      boardPx + ctx.lineWidth, boardPx + ctx.lineWidth);
    ctx.restore();

    if (this.showCoordinates) this.paintCoordinates(ctx);
  }

  private paintCoordinates(ctx: CanvasRenderingContext2D): void {
    const t = this.theme;
    const fontPx = Math.max(8, Math.round(this.frame * 0.52));
    ctx.fillStyle = t.coordinate;
    ctx.globalAlpha = 0.82;
    ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < 8; i++) {
      const f = this.flipped ? 7 - i : i;
      const r = this.flipped ? i : 7 - i;
      const cx = this.frame + i * this.squareSize + this.squareSize / 2;
      const cy = this.frame + i * this.squareSize + this.squareSize / 2;
      // Files along the bottom, ranks down the left — and repeated top and right, because on a
      // wide screen the eye is as likely to start from either side.
      ctx.fillText('abcdefgh'[f], cx, this.size - this.frame / 2);
      ctx.fillText('abcdefgh'[f], cx, this.frame / 2);
      ctx.fillText(String(r + 1), this.frame / 2, cy);
      ctx.fillText(String(r + 1), this.size - this.frame / 2, cy);
    }
    ctx.globalAlpha = 1;
  }

  private drawHighlights(ctx: CanvasRenderingContext2D): void {
    const t = this.theme;
    const s = this.squareSize;

    if (this.lastMove) {
      for (const sq of [moveFrom(this.lastMove), moveTo(this.lastMove)]) {
        const { x, y } = this.squareXY(sq);
        ctx.fillStyle = t.lastMove;
        ctx.fillRect(x, y, s, s);
      }
    }

    if (this.hovered >= 0 && this.showLegalMoves && !this.dragging) {
      // A whisper of a hover state — enough to confirm the pointer is on a square, not enough to
      // compete with the selection.
      const { x, y } = this.squareXY(this.hovered);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, y, s, s);
    }

    if (this.selected >= 0) {
      const { x, y } = this.squareXY(this.selected);
      ctx.fillStyle = t.selected;
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = Math.max(1.5, s * 0.035);
      ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2,
        s - ctx.lineWidth, s - ctx.lineWidth);
    }

    if (this.checkSquare >= 0) {
      /**
       * The check warning: a radial glow that breathes, not a flashing square.
       *
       * A hard flash is the obvious implementation and it is genuinely unpleasant — it draws the
       * eye away from the position at the exact moment the player needs to read it, and for
       * anyone sensitive to flashing it is worse than that. A slow pulse says the same thing.
       */
      const { x, y } = this.squareXY(this.checkSquare);
      const pulse = 0.55 + 0.45 * Math.sin(this.checkPulse * 3.4);
      const cx = x + s / 2, cy = y + s / 2;
      const glow = ctx.createRadialGradient(cx, cy, s * 0.08, cx, cy, s * 0.72);
      glow.addColorStop(0, t.check);
      glow.addColorStop(0.55, withAlpha(t.check, 0.42 * pulse));
      glow.addColorStop(1, withAlpha(t.check, 0));
      ctx.save();
      ctx.globalAlpha = 0.55 + 0.3 * pulse;
      ctx.fillStyle = glow;
      ctx.fillRect(x - s * 0.25, y - s * 0.25, s * 1.5, s * 1.5);
      ctx.restore();
    }

    if (this.hintMove) {
      for (const sq of [moveFrom(this.hintMove), moveTo(this.hintMove)]) {
        const { x, y } = this.squareXY(sq);
        ctx.strokeStyle = t.hint;
        ctx.lineWidth = Math.max(2, s * 0.06);
        ctx.setLineDash([s * 0.16, s * 0.1]);
        ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2,
          s - ctx.lineWidth, s - ctx.lineWidth);
        ctx.setLineDash([]);
      }
    }
  }

  private drawPieces(ctx: CanvasRenderingContext2D): void {
    const pos = this.position;
    if (!pos) return;
    const s = this.squareSize;
    // The piece is drawn slightly smaller than its square, so neighbours never touch.
    const pieceSize = s * 0.9;
    const pad = (s - pieceSize) / 2;

    // Squares that a currently-animating piece has already left, or is being lifted from.
    const hidden = new Set<number>();
    for (const m of this.moving) hidden.add(m.to);
    if (this.dragging) hidden.add(this.dragging.from);

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = square(f, r);
        const piece = pos.board[sq];
        if (!piece || hidden.has(sq)) continue;
        const { x, y } = this.squareXY(sq);
        const img = this.atlas.get(pieceType(piece), pieceColor(piece), pieceSize, this.dpr);
        ctx.drawImage(img, x + pad, y + pad, pieceSize, pieceSize);
      }
    }

    // Captured pieces fade and shrink out of the way as the attacker lands on them.
    for (const fade of this.fading) {
      const { x, y } = this.squareXY(fade.sq);
      const e = easeIn(fade.t);
      const scale = 1 - 0.35 * e;
      const drawn = pieceSize * scale;
      const off = (s - drawn) / 2;
      ctx.save();
      ctx.globalAlpha = 1 - e;
      const img = this.atlas.get(fade.type, fade.color, pieceSize, this.dpr);
      ctx.drawImage(img, x + off, y + off, drawn, drawn);
      ctx.restore();
    }

    // Travelling pieces last, so they pass over the board rather than under it.
    for (const m of this.moving) {
      const a = this.squareXY(m.from);
      const b = this.squareXY(m.to);
      const e = easeOutCubic(m.t);
      const x = a.x + (b.x - a.x) * e;
      const y = a.y + (b.y - a.y) * e;
      // A slight lift at the midpoint, so the piece arcs over the board instead of grinding
      // across it. Small enough to feel physical rather than cartoonish.
      const lift = Math.sin(m.t * Math.PI) * s * 0.06;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = s * 0.12 * Math.sin(m.t * Math.PI);
      ctx.shadowOffsetY = lift * 0.8;
      const img = this.atlas.get(m.type, m.color, pieceSize, this.dpr);
      ctx.drawImage(img, x + pad, y + pad - lift, pieceSize, pieceSize);
      ctx.restore();
    }
  }

  /**
   * Legal-move markers: a dot for an empty square, a ring for a capture.
   *
   * Two shapes rather than two colours, because the difference has to survive colour blindness
   * and a phone screen in daylight. The ring also sits *around* the piece it would take, which
   * says "this one" far more directly than tinting the square does.
   */
  private drawLegalMarkers(ctx: CanvasRenderingContext2D): void {
    if (!this.showLegalMoves || this.legalTargets.length === 0) return;
    const t = this.theme;
    const s = this.squareSize;

    for (const move of this.legalTargets) {
      const to = moveTo(move);
      const { x, y } = this.squareXY(to);
      const cx = x + s / 2, cy = y + s / 2;

      if (isCapture(move)) {
        ctx.strokeStyle = t.capture;
        ctx.lineWidth = Math.max(2, s * 0.075);
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.44, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = t.legal;
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.145, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = Math.max(1, s * 0.012);
        ctx.stroke();
      }

      // Castling and promotion get their own mark, because "the king moves two squares" and
      // "this pawn becomes a queen" are not things a plain dot communicates.
      const flagged = (move & 0x300000) !== 0;
      if (flagged || (move & 0x400000) !== 0) {
        ctx.fillStyle = t.hint;
        ctx.beginPath();
        ctx.arc(x + s * 0.84, y + s * 0.16, s * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawDragged(ctx: CanvasRenderingContext2D): void {
    const d = this.dragging;
    if (!d) return;
    const s = this.squareSize;
    // The lifted piece is bigger and casts a longer shadow: the two cues together read as
    // "held", and without them a dragged piece looks like it is sliding on the board.
    const pieceSize = s * 1.08;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = s * 0.22;
    ctx.shadowOffsetY = s * 0.09;
    const img = this.atlas.get(d.type, d.color, pieceSize, this.dpr);
    ctx.drawImage(img, this.dragX - pieceSize / 2, this.dragY - pieceSize / 2,
      pieceSize, pieceSize);
    ctx.restore();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number): number => t * t;

/** Re-alpha an `rgba(...)` or hex colour without a colour library. */
function withAlpha(color: string, alpha: number): string {
  const m = /^rgba?\(([^)]+)\)$/.exec(color);
  if (m) {
    const parts = m[1].split(',').map((s) => s.trim());
    return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  }
  const h = color.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export { onBoard, isEnPassant, PAWN, KING, WHITE, BLACK };
