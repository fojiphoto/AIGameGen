/**
 * The chess pieces, drawn from code.
 *
 * No image files, no sprite sheets to download, no font glyphs. Every piece is a set of Bézier
 * paths in a 100x100 space, rendered into a canvas at exactly the size the board needs and
 * cached. That buys three things at once: the whole set costs zero network bytes, it is crisp at
 * any device pixel ratio because it is re-rendered rather than scaled, and a theme can restyle
 * the pieces by changing four colours instead of shipping six more PNGs.
 *
 * The look is a polished vector Staunton — real silhouettes with a vertical body gradient, a
 * bevel highlight down the left, a rim light along the top edge and a contact shadow underneath.
 * Enough dimensionality to look moulded rather than stencilled, and no more: a piece has to stay
 * readable at 34 pixels on a phone, and detail that survives at 120 becomes mud at 34.
 *
 * Unicode chess characters were rejected deliberately. They are one line of code and they look
 * like a text document — the metrics differ per platform, the black pieces are solid blobs, and
 * on Windows they render from a font that has no business in a premium product.
 */

import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK, Color } from '../core/index.js';

export interface PieceStyle {
  /** Body gradient, light to dark. */
  light: string;
  dark: string;
  /** Outline. */
  edge: string;
  /** Rim light along the top of the silhouette. */
  rim: string;
}

export interface PieceSet {
  white: PieceStyle;
  black: PieceStyle;
}

/**
 * The default set: warm ivory against a cool graphite.
 *
 * Not white-on-black. Pure white pieces glare on a light board and pure black ones lose all
 * internal shading — ivory keeps a highlight visible and graphite keeps a bevel visible, which
 * is what makes the two sets look like the same object in two materials rather than a shape and
 * its silhouette.
 */
export const IVORY_SET: PieceSet = {
  white: { light: '#fdfaf3', dark: '#cdbfa4', edge: '#5c4f3a', rim: '#ffffff' },
  black: { light: '#5a606e', dark: '#191c24', edge: '#05070b', rim: '#98a2b8' },
};

export const PIECE_SETS: Record<string, PieceSet> = {
  ivory: IVORY_SET,
  marble: {
    white: { light: '#ffffff', dark: '#d5d8dd', edge: '#6b7280', rim: '#ffffff' },
    black: { light: '#6b7280', dark: '#2b3038', edge: '#12151a', rim: '#aab2c0' },
  },
  gold: {
    white: { light: '#fff6dd', dark: '#e0bf7a', edge: '#7a5a1e', rim: '#fffdf5' },
    black: { light: '#4b3f6b', dark: '#1a1430', edge: '#070512', rim: '#a89bd6' },
  },
  glass: {
    white: { light: '#f2fbff', dark: '#b4d9ea', edge: '#3f6577', rim: '#ffffff' },
    black: { light: '#3d5566', dark: '#101a22', edge: '#04090d', rim: '#7fb2cc' },
  },
};

// ── silhouettes ─────────────────────────────────────────────────────────────
//
// All drawn in a 0..100 box with the piece standing on y=94 and centred on x=50. Sharing one
// baseline and one centre is what makes a set look designed rather than assembled: a king that
// stands two pixels lower than a queen is invisible in isolation and obvious on a full board.

const BASE_Y = 93;

/** The flared base every piece stands on. Shared, so the whole set sits identically. */
function base(p: Path2D, halfWidth: number, top: number): void {
  const w = halfWidth;
  p.moveTo(50 - w, BASE_Y);
  p.lineTo(50 + w, BASE_Y);
  p.quadraticCurveTo(50 + w, BASE_Y - 4, 50 + w - 3, BASE_Y - 5.5);
  p.lineTo(50 + w * 0.62, top + 3);
  p.quadraticCurveTo(50 + w * 0.55, top, 50 + w * 0.48, top);
  p.lineTo(50 - w * 0.48, top);
  p.quadraticCurveTo(50 - w * 0.55, top, 50 - w * 0.62, top + 3);
  p.lineTo(50 - w + 3, BASE_Y - 5.5);
  p.quadraticCurveTo(50 - w, BASE_Y - 4, 50 - w, BASE_Y);
  p.closePath();
}

/** A collar ring — the moulding between base and body. */
function collar(p: Path2D, y: number, halfWidth: number, height: number): void {
  p.moveTo(50 - halfWidth, y);
  p.quadraticCurveTo(50, y - height * 0.55, 50 + halfWidth, y);
  p.quadraticCurveTo(50, y + height, 50 - halfWidth, y);
  p.closePath();
}

function pawnPath(): Path2D {
  const p = new Path2D();
  base(p, 20, 79);
  collar(p, 76, 15, 5);
  // body: a waisted cone
  p.moveTo(40, 74);
  p.bezierCurveTo(41, 62, 44, 56, 45, 50);
  p.lineTo(55, 50);
  p.bezierCurveTo(56, 56, 59, 62, 60, 74);
  p.closePath();
  // collar under the head
  p.moveTo(42, 50);
  p.quadraticCurveTo(50, 46, 58, 50);
  p.quadraticCurveTo(50, 53, 42, 50);
  p.closePath();
  // head
  p.moveTo(50, 22);
  p.arc(50, 34, 12, -Math.PI / 2, Math.PI * 1.5);
  p.closePath();
  return p;
}

function rookPath(): Path2D {
  const p = new Path2D();
  base(p, 22, 78);
  collar(p, 75, 17, 5);
  // body: slightly tapered tower
  p.moveTo(37, 72);
  p.lineTo(39, 42);
  p.lineTo(61, 42);
  p.lineTo(63, 72);
  p.closePath();
  // cornice
  p.moveTo(33, 42);
  p.lineTo(67, 42);
  p.lineTo(67, 36);
  p.lineTo(33, 36);
  p.closePath();
  // crenellations — four merlons and three gaps
  const top = 22, bottom = 36;
  const merlons = [[31, 41], [44.5, 55.5], [58, 69]];
  p.moveTo(31, bottom);
  for (const [a, b] of merlons) {
    p.lineTo(a, top);
    p.lineTo(b, top);
    p.lineTo(b, top + 7);
    if (b < 69) p.lineTo(b + 3.5, top + 7);
    if (b < 69) p.lineTo(b + 3.5, top);
  }
  p.lineTo(69, top);
  p.lineTo(69, bottom);
  p.closePath();
  return p;
}

function knightPath(): Path2D {
  const p = new Path2D();
  base(p, 21, 79);
  collar(p, 76, 16, 5);
  /**
   * The horse's head, in profile facing right.
   *
   * The knight is the one piece that cannot be built from arcs and cones, and it is also the
   * one players identify fastest — so the silhouette carries the whole load. What matters is
   * the notch between muzzle and jaw and the sweep of the mane; get those two and it reads as a
   * horse at any size, miss them and it reads as a blob.
   */
  p.moveTo(35, 75);
  p.bezierCurveTo(33, 62, 36, 54, 42, 47);      // neck, front edge
  p.bezierCurveTo(38, 45, 33, 44, 29, 41);      // under the muzzle
  p.bezierCurveTo(26, 39, 25, 35, 27, 32);      // muzzle tip
  p.bezierCurveTo(30, 29, 35, 30, 38, 32);      // nose bridge
  p.bezierCurveTo(41, 27, 45, 22, 51, 19);      // forehead
  p.lineTo(53, 12);                             // near ear
  p.lineTo(58, 19);
  p.lineTo(62, 13);                             // far ear
  p.lineTo(65, 22);
  p.bezierCurveTo(71, 28, 74, 38, 72, 50);      // mane, back edge
  p.bezierCurveTo(70, 62, 68, 69, 67, 75);
  p.closePath();
  return p;
}

function bishopPath(): Path2D {
  const p = new Path2D();
  base(p, 21, 79);
  collar(p, 76, 16, 5);
  // body
  p.moveTo(39, 73);
  p.bezierCurveTo(40, 62, 43, 56, 44, 51);
  p.lineTo(56, 51);
  p.bezierCurveTo(57, 56, 60, 62, 61, 73);
  p.closePath();
  // brim
  p.moveTo(38, 51);
  p.quadraticCurveTo(50, 45, 62, 51);
  p.quadraticCurveTo(50, 55, 38, 51);
  p.closePath();
  // mitre
  p.moveTo(50, 16);
  p.bezierCurveTo(60, 24, 63, 36, 60, 47);
  p.quadraticCurveTo(50, 51, 40, 47);
  p.bezierCurveTo(37, 36, 40, 24, 50, 16);
  p.closePath();
  // finial
  p.moveTo(50, 9);
  p.arc(50, 12.5, 3.5, 0, Math.PI * 2);
  p.closePath();
  return p;
}

function queenPath(): Path2D {
  const p = new Path2D();
  base(p, 24, 78);
  collar(p, 75, 19, 5);
  // body flares up into the crown
  p.moveTo(37, 72);
  p.bezierCurveTo(38, 60, 40, 52, 40, 45);
  p.lineTo(60, 45);
  p.bezierCurveTo(60, 52, 62, 60, 63, 72);
  p.closePath();
  // crown band
  p.moveTo(35, 45);
  p.quadraticCurveTo(50, 40, 65, 45);
  p.quadraticCurveTo(50, 49, 35, 45);
  p.closePath();
  /**
   * The coronet: five points, each tipped with a pearl. Five rather than the crown's cross is
   * what separates a queen from a king at a glance — the two are the same height and the same
   * body, so the top is the only place the difference can live.
   */
  const points = [
    [30, 24], [40, 18], [50, 15], [60, 18], [70, 24],
  ];
  p.moveTo(34, 45);
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    p.lineTo(x, y + 6);
    p.lineTo(x, y + 3);
    p.lineTo(x + 2, y + 5);
  }
  p.lineTo(66, 45);
  p.closePath();
  for (const [x, y] of points) {
    p.moveTo(x + 3.6, y);
    p.arc(x, y, 3.6, 0, Math.PI * 2);
    p.closePath();
  }
  return p;
}

function kingPath(): Path2D {
  const p = new Path2D();
  base(p, 24, 78);
  collar(p, 75, 19, 5);
  // body
  p.moveTo(37, 72);
  p.bezierCurveTo(38, 60, 40, 52, 40, 45);
  p.lineTo(60, 45);
  p.bezierCurveTo(60, 52, 62, 60, 63, 72);
  p.closePath();
  // crown band
  p.moveTo(35, 45);
  p.quadraticCurveTo(50, 40, 65, 45);
  p.quadraticCurveTo(50, 49, 35, 45);
  p.closePath();
  // crown: a shallow bowl with two shoulders
  p.moveTo(35, 44);
  p.bezierCurveTo(34, 34, 40, 28, 50, 28);
  p.bezierCurveTo(60, 28, 66, 34, 65, 44);
  p.quadraticCurveTo(50, 39, 35, 44);
  p.closePath();
  // cross
  p.moveTo(46.5, 24);
  p.lineTo(46.5, 17);
  p.lineTo(41, 17);
  p.lineTo(41, 11.5);
  p.lineTo(46.5, 11.5);
  p.lineTo(46.5, 5);
  p.lineTo(53.5, 5);
  p.lineTo(53.5, 11.5);
  p.lineTo(59, 11.5);
  p.lineTo(59, 17);
  p.lineTo(53.5, 17);
  p.lineTo(53.5, 24);
  p.closePath();
  return p;
}

const PATHS: Record<number, () => Path2D> = {
  [PAWN]: pawnPath,
  [KNIGHT]: knightPath,
  [BISHOP]: bishopPath,
  [ROOK]: rookPath,
  [QUEEN]: queenPath,
  [KING]: kingPath,
};

/** Built once — a Path2D is immutable in use and rebuilding it per frame is pure waste. */
const PATH_CACHE = new Map<number, Path2D>();
function pathFor(type: number): Path2D {
  let p = PATH_CACHE.get(type);
  if (!p) { p = PATHS[type](); PATH_CACHE.set(type, p); }
  return p;
}

// ── rendering ───────────────────────────────────────────────────────────────

/**
 * Draw one piece into a context, filling a `size` x `size` box.
 *
 * The order matters and is the whole illusion: contact shadow, body, gradient, bevel, rim,
 * outline. Every layer is clipped to the silhouette except the shadow, so the piece reads as one
 * solid object rather than as a stack of decals.
 */
export function drawPiece(
  ctx: CanvasRenderingContext2D, type: number, color: Color, size: number, set: PieceSet
): void {
  const style = color === WHITE ? set.white : set.black;
  const path = pathFor(type);
  const scale = size / 100;

  ctx.save();
  ctx.scale(scale, scale);

  // Contact shadow: an ellipse under the base, so the piece sits *on* the square rather than
  // floating above it. Drawn first and unclipped.
  ctx.save();
  const shadow = ctx.createRadialGradient(50, BASE_Y + 1, 2, 50, BASE_Y + 1, 26);
  shadow.addColorStop(0, 'rgba(0,0,0,0.34)');
  shadow.addColorStop(0.6, 'rgba(0,0,0,0.16)');
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(50, BASE_Y + 1.5, 27, 7.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Body.
  const body = ctx.createLinearGradient(28, 6, 74, BASE_Y);
  body.addColorStop(0, style.light);
  body.addColorStop(0.55, mix(style.light, style.dark, 0.45));
  body.addColorStop(1, style.dark);
  ctx.fillStyle = body;
  ctx.fill(path, 'nonzero');

  // Bevel and rim, both clipped to the silhouette.
  ctx.save();
  ctx.clip(path, 'nonzero');

  // A soft light down the upper-left, as if from a window above and to the left.
  const bevel = ctx.createLinearGradient(20, 0, 62, 60);
  bevel.addColorStop(0, 'rgba(255,255,255,0.42)');
  bevel.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  bevel.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bevel;
  ctx.fillRect(0, 0, 100, 100);

  // Occlusion at the foot, which is what stops the base looking like a flat disc.
  const foot = ctx.createLinearGradient(0, BASE_Y - 22, 0, BASE_Y);
  foot.addColorStop(0, 'rgba(0,0,0,0)');
  foot.addColorStop(1, 'rgba(0,0,0,0.30)');
  ctx.fillStyle = foot;
  ctx.fillRect(0, 0, 100, 100);

  // Rim light: the outline stroked from inside the clip, so only the inner half survives and
  // reads as a lit edge rather than as a border.
  ctx.strokeStyle = style.rim;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.globalAlpha = 1;
  ctx.restore();

  // Outline last, so it sits over everything and holds the shape at small sizes.
  ctx.strokeStyle = style.edge;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke(path);

  ctx.restore();
}

function mix(a: string, b: string, t: number): string {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function hexToRgb(hex: string): number[] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A cache of rendered pieces, keyed by type, colour, pixel size and set.
 *
 * Redrawing twelve Bézier silhouettes with four gradient layers each, thirty-two times a frame,
 * is roughly a hundred times the cost of blitting a cached bitmap — and the piece does not
 * change between frames. Sizes are bucketed to whole pixels so a resize drag does not fill the
 * cache with a hundred near-identical entries.
 */
export class PieceAtlas {
  private cache = new Map<string, HTMLCanvasElement>();
  private setKey = 'ivory';
  private set: PieceSet = IVORY_SET;

  useSet(key: string): void {
    const next = PIECE_SETS[key] ?? IVORY_SET;
    if (next === this.set) return;
    this.set = next;
    this.setKey = key;
    this.cache.clear();
  }

  get style(): PieceSet { return this.set; }

  /**
   * @param size CSS pixels of the square the piece fills.
   * @param dpr device pixel ratio — the bitmap is rendered at full device resolution so the
   *   piece is sharp on a retina screen instead of being upscaled.
   */
  get(type: number, color: Color, size: number, dpr: number): HTMLCanvasElement {
    const px = Math.max(8, Math.round(size));
    const key = `${this.setKey}:${type}:${color}:${px}:${dpr.toFixed(2)}`;
    let canvas = this.cache.get(key);
    if (canvas) return canvas;

    canvas = document.createElement('canvas');
    canvas.width = Math.round(px * dpr);
    canvas.height = Math.round(px * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    drawPiece(ctx, type, color, px, this.set);

    // A board only ever needs a handful of sizes at once; anything more is a leak from resizing.
    if (this.cache.size > 96) this.cache.clear();
    this.cache.set(key, canvas);
    return canvas;
  }
}

/** A standalone piece bitmap, for the promotion dialog and the captured-piece strips. */
export function pieceImage(type: number, color: Color, size: number, set = IVORY_SET): string {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  drawPiece(ctx, type, color, size, set);
  return canvas.toDataURL();
}

export { BLACK, WHITE };
