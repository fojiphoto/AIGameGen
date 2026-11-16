import { type Aim, type Game, type Point, type Result } from './game';
import { CHAPTERS, HEIGHT, LIMIT, ORIGIN, PALETTE, RADIUS, WIDTH, coords, rng } from './levels';

interface Spark { x: number; y: number; vx: number; vy: number; life: number; span: number; color: number; falling: boolean }
export interface Flight { aim: Aim; color: number; distance: number }

function mark(c: CanvasRenderingContext2D, color: number) {
  const type = PALETTE[color - 1].mark;
  c.beginPath();
  switch (type) {
    case 'heart':
      c.moveTo(0, 5); c.bezierCurveTo(-15, -5, -3, -10, 0, -4); c.bezierCurveTo(3, -10, 15, -5, 0, 5); break;
    case 'wave':
      c.moveTo(-6, 2); c.bezierCurveTo(-2, -7, 1, 8, 6, -2); break;
    case 'sun':
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, r = i % 2 ? 2.2 : 6.5;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (!i) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath(); break;
    case 'diamond':
      c.moveTo(0, -6); c.lineTo(5, 0); c.lineTo(0, 6); c.lineTo(-5, 0); c.closePath(); break;
    case 'leaf':
      c.moveTo(-5, 5); c.quadraticCurveTo(-7, -4, 6, -6); c.quadraticCurveTo(6, 6, -5, 5); break;
    case 'ring': c.arc(0, 0, 4.7, 0, Math.PI * 2); break;
  }
  c.strokeStyle = '#30184578'; c.lineWidth = 2.9; c.stroke();
  c.strokeStyle = '#fffdf0be'; c.lineWidth = 1.5; c.stroke();
}

export function orb(c: CanvasRenderingContext2D, x: number, y: number, size: number, color: number, symbols = true) {
  const theme = PALETTE[color - 1];
  c.save(); c.translate(x, y); c.scale(size / RADIUS, size / RADIUS);
  c.fillStyle = '#020d2b88'; c.beginPath(); c.arc(0, 1.4, RADIUS, 0, Math.PI * 2); c.fill();
  const glass = c.createRadialGradient(-5.8, -7, .7, 1.4, 2.5, RADIUS + 3);
  glass.addColorStop(0, theme.hi); glass.addColorStop(.33, theme.mid); glass.addColorStop(.77, theme.mid); glass.addColorStop(1, theme.low);
  c.fillStyle = glass; c.beginPath(); c.arc(0, 0, RADIUS - .65, 0, Math.PI * 2); c.fill();
  c.strokeStyle = theme.hi; c.globalAlpha *= .66; c.lineWidth = 1.05; c.stroke();
  c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.lineCap = 'round';
  c.beginPath(); c.arc(-.8, -.35, RADIUS - 4, 3.72, 4.52); c.stroke();
  if (symbols) { c.globalAlpha = 1; mark(c, color); }
  c.restore();
}

export function travel(points: Point[], distance: number) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = Math.hypot(a.x - b.x, a.y - b.y);
    if (distance <= length && length > 0) return { x: a.x + (b.x - a.x) * distance / length, y: a.y + (b.y - a.y) * distance / length, done: false };
    distance -= length;
  }
  return { ...points[points.length - 1], done: true };
}

export class Renderer {
  private c: CanvasRenderingContext2D;
  private surface = document.createElement('canvas');
  private theme = -1;
  private sprites = new Map<string, HTMLCanvasElement>();
  private sparks: Spark[] = [];
  private drop = 0;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = this.surface.width = WIDTH * 2;
    canvas.height = this.surface.height = HEIGHT * 2;
    this.c = canvas.getContext('2d', { alpha: false })!;
    this.c.scale(2, 2);
  }

  reset() { this.sparks.length = 0; this.drop = 0; }

  private background(index: number) {
    this.theme = index;
    const [, top, deep, light] = CHAPTERS[index], c = this.surface.getContext('2d')!;
    c.setTransform(2, 0, 0, 2, 0, 0);
    const sea = c.createLinearGradient(0, 0, 50, HEIGHT);
    sea.addColorStop(0, top); sea.addColorStop(.55, deep); sea.addColorStop(1, '#081529');
    c.fillStyle = sea; c.fillRect(0, 0, WIDTH, HEIGHT);
    const tint = c.createRadialGradient(120, 40, 3, 138, 76, 324);
    tint.addColorStop(0, `${light}39`); tint.addColorStop(1, `${light}00`);
    c.fillStyle = tint; c.fillRect(0, 0, WIDTH, HEIGHT);
    for (let i = 0; i < 5; i++) {
      c.fillStyle = `${light}0c`;
      c.beginPath(); c.moveTo(18 + i * 48, 0); c.lineTo(37 + i * 50, 0); c.lineTo(WIDTH, 315 + i * 38); c.closePath(); c.fill();
    }
    const random = rng(2719 + index);
    for (let i = 0; i < 78; i++) {
      const x = WIDTH * random(), y = HEIGHT * random(), r = .6 + random() * 2;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = `${light}2e`; c.fill();
    }
    for (const side of [-1, 1]) for (let i = 0; i < 11; i++) {
      const x = side < 0 ? i * 5 : WIDTH - i * 5, h = 18 + random() * 106;
      c.strokeStyle = `${light}${i % 2 === 0 ? '24' : '15'}`; c.lineWidth = 2 + random() * 5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x, HEIGHT); c.bezierCurveTo(x + side * 20, HEIGHT - h * .45, x - side * 20, HEIGHT - h * .7, x - side * 7, HEIGHT - h); c.stroke();
    }
  }

  private bubble(x: number, y: number, color: number, symbols: boolean) {
    const key = `${color}/${symbols}`;
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = document.createElement('canvas'); sprite.width = sprite.height = 72;
      const context = sprite.getContext('2d')!;
      context.scale(2, 2); orb(context, 18, 18, RADIUS, color, symbols);
      this.sprites.set(key, sprite);
    }
    this.c.drawImage(sprite, x - 18, y - 18, 36, 36);
  }

  pop(result: Result) {
    const random = rng(result.hit * 19 + result.removed.length);
    const limit = this.reduced ? 35 : 160;
    for (const bubble of result.removed) {
      const p = coords(bubble.cell, result.oldDrop), count = bubble.falling || this.reduced ? 1 : 5;
      if (this.sparks.length + count > limit) break;
      for (let i = 0; i < count; i++) {
        const span = bubble.falling ? .75 : .28 + random() * .19;
        this.sparks.push({ ...p, vx: (random() - .5) * 160, vy: -30 - random() * 79, life: span, span, color: bubble.color, falling: bubble.falling });
      }
    }
  }

  draw(game: Game, path: Aim | undefined, flight: Flight | undefined, dt: number, symbols: boolean) {
    if (this.theme !== game.level.chapter) this.background(game.level.chapter);
    const c = this.c, accent = CHAPTERS[this.theme][3];
    c.drawImage(this.surface, 0, 0, WIDTH, HEIGHT);
    this.drop += (game.drop - this.drop) * (this.reduced ? 1 : Math.min(1, dt * 15));
    c.fillStyle = '#0014258a'; c.fillRect(0, 0, WIDTH, 8 + this.drop);
    c.fillStyle = `${accent}9a`; c.fillRect(0, 7 + this.drop, WIDTH, 2);
    c.strokeStyle = game.chances === 1 ? '#ff959d' : '#b6eaf764'; c.lineWidth = 1; c.setLineDash([6, 6]);
    c.beginPath(); c.moveTo(0, LIMIT); c.lineTo(WIDTH, LIMIT); c.stroke(); c.setLineDash([]);
    for (let i = 0; i < game.board.length; i++) if (game.board[i]) {
      const p = coords(i, this.drop); this.bubble(p.x, p.y, game.board[i], symbols);
    }
    if (path && !flight && game.status === 'playing') {
      c.fillStyle = `${PALETTE[game.current - 1].hi}b0`;
      const points = path.points;
      let elapsed = 27;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], length = Math.hypot(a.x - b.x, a.y - b.y);
        while (elapsed < length) {
          const t = elapsed / length; c.beginPath(); c.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2.3, 0, Math.PI * 2); c.fill(); elapsed += 14;
        }
        elapsed -= length;
      }
      if (path.slot >= 0) {
        const p = coords(path.slot, this.drop);
        c.strokeStyle = '#f9ffffb2'; c.lineWidth = 1.1; c.beginPath(); c.arc(p.x, p.y, RADIUS - 1, 0, Math.PI * 2); c.stroke();
      }
    }
    c.strokeStyle = `${accent}72`; c.lineWidth = 2; c.beginPath(); c.arc(ORIGIN.x, ORIGIN.y, 26, .15, Math.PI - .15); c.stroke();
    c.fillStyle = '#88d0d445'; c.beginPath(); c.ellipse(ORIGIN.x, ORIGIN.y + 17, 22, 7.5, 0, 0, Math.PI * 2); c.fill();
    if (game.status === 'playing') {
      const p = flight ? travel(flight.aim.points, flight.distance) : ORIGIN;
      this.bubble(p.x, p.y, flight?.color ?? game.current, symbols);
    }
    for (const spark of this.sparks) {
      spark.life -= dt;
      spark.x += spark.vx * dt; spark.y += spark.vy * dt; spark.vy += dt * (spark.falling ? 850 : 240);
      c.globalAlpha = Math.max(0, Math.min(1, spark.life / spark.span * 1.4));
      if (spark.falling) orb(c, spark.x, spark.y, RADIUS * .83, spark.color, false);
      else { c.fillStyle = PALETTE[spark.color - 1].hi; c.beginPath(); c.arc(spark.x, spark.y, 2.9, 0, Math.PI * 2); c.fill(); }
    }
    c.globalAlpha = 1;
    this.sparks = this.sparks.filter(s => s.life > 0);
  }
}

export function postcard(canvas: HTMLCanvasElement) {
  canvas.width = 720; canvas.height = 720;
  const c = canvas.getContext('2d')!;
  const g = c.createLinearGradient(20, 0, 650, 700);
  g.addColorStop(0, '#207c90'); g.addColorStop(.45, '#16576e'); g.addColorStop(1, '#111a38');
  c.fillStyle = g; c.fillRect(0, 0, 720, 720);
  for (let i = 0; i < 5; i++) {
    c.fillStyle = '#96faf813'; c.beginPath(); c.moveTo(95 + i * 75, 0); c.lineTo(120 + i * 90, 0); c.lineTo(720, 420 + i * 36); c.closePath(); c.fill();
  }
  for (const [x, y, r, color] of [[160, 180, 90, 2], [332, 116, 75, 1], [479, 174, 58, 5], [561, 310, 108, 4], [333, 342, 132, 3], [153, 402, 54, 1], [323, 598, 70, 2], [530, 563, 82, 6], [132, 576, 49, 4]]) {
    orb(c, x, y, r, color);
  }
  c.strokeStyle = '#c9fffb90'; c.lineWidth = 2.5;
  const random = rng(2388);
  for (let i = 0; i < 22; i++) { c.beginPath(); c.arc(720 * random(), 720 * random(), 2 + 12 * random(), 0, Math.PI * 2); c.stroke(); }
}
