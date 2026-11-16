import { type Aim, type Game, type Point, type Result } from './game';
import { GAP, HEIGHT, LIMIT, ORIGIN, PALETTE, RADIUS, WIDTH, coords, rng } from './levels';
import { landscape, panda, shooter, TRAY } from './scenery';

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
  glass.addColorStop(0, theme.hi); glass.addColorStop(.3, theme.mid); glass.addColorStop(.64, theme.mid); glass.addColorStop(1, theme.low);
  c.fillStyle = glass; c.beginPath(); c.arc(0, 0, RADIUS - .65, 0, Math.PI * 2); c.fill();
  c.strokeStyle = theme.hi; c.globalAlpha *= .66; c.lineWidth = 1.05; c.stroke();
  c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.lineCap = 'round';
  c.beginPath(); c.arc(-.8, -.35, RADIUS - 4, 3.72, 4.52); c.stroke();
  c.globalAlpha = .92; c.fillStyle = '#fff9ff'; c.beginPath(); c.ellipse(5.8, -8.3, 2.65, 2.15, .35, 0, Math.PI * 2); c.fill();
  c.globalAlpha = .34; c.beginPath(); c.arc(0, 0, RADIUS - 3, .73, 2.23); c.stroke();
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
  private clock = 0;
  private pose = 0;
  private feed = 1;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = this.surface.width = WIDTH * 2;
    canvas.height = this.surface.height = HEIGHT * 2;
    this.c = canvas.getContext('2d', { alpha: false })!;
    this.c.scale(2, 2);
  }

  reset() { this.sparks.length = 0; this.drop = this.pose = 0; }
  rowArrived() { if (!this.reduced) this.drop -= GAP; }
  pushBubble(from: 1 | 2 = 1) { this.feed = from; this.pose = this.reduced ? 0 : 1; }

  private background(index: number) {
    this.theme = index;
    const c = this.surface.getContext('2d')!;
    c.setTransform(2, 0, 0, 2, 0, 0);
    landscape(c, index);
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

  pop(result: Result, stagger: number) {
    const random = rng(result.hit * 19 + result.removed.length);
    const limit = this.reduced ? 35 : 160;
    for (const bubble of result.removed) {
      const p = coords(bubble.cell, result.oldDrop, stagger), count = bubble.falling || this.reduced ? 1 : 5;
      if (this.sparks.length + count > limit) break;
      for (let i = 0; i < count; i++) {
        const span = bubble.falling ? .75 : .28 + random() * .19;
        this.sparks.push({ ...p, vx: (random() - .5) * 160, vy: -30 - random() * 79, life: span, span, color: bubble.color, falling: bubble.falling });
      }
    }
  }

  draw(game: Game, path: Aim | undefined, flight: Flight | undefined, dt: number, symbols: boolean) {
    if (this.theme !== game.level.chapter) this.background(game.level.chapter);
    if (!this.reduced) this.clock += dt;
    this.pose = Math.max(0, this.pose - dt * 3.2);
    const c = this.c;
    c.drawImage(this.surface, 0, 0, WIDTH, HEIGHT);
    this.drop += (game.drop - this.drop) * (this.reduced ? 1 : Math.min(1, dt * 15));
    if (this.drop >= 0) {
      c.fillStyle = '#1e64ca'; c.fillRect(0, 0, WIDTH, 8 + this.drop);
      c.fillStyle = '#85d4ff'; c.fillRect(0, 7 + this.drop, WIDTH, 2);
    }
    c.strokeStyle = '#ffedb5'; c.lineWidth = 3; c.beginPath(); c.moveTo(0, LIMIT); c.lineTo(WIDTH, LIMIT); c.stroke();
    c.strokeStyle = game.mode === 'campaign' && game.chances === 1 ? '#d63960' : '#834260'; c.lineWidth = 1.6; c.setLineDash([6, 6]);
    c.beginPath(); c.moveTo(0, LIMIT); c.lineTo(WIDTH, LIMIT); c.stroke(); c.setLineDash([]);
    for (let i = 0; i < game.board.length; i++) if (game.board[i]) {
      const p = coords(i, this.drop, game.stagger); this.bubble(p.x, p.y, game.board[i], symbols);
    }
    const motion = Math.sin(Math.PI * this.pose);
    shooter(c, 65, 611, .85, this.clock, flight ? Math.max(motion, .65) : motion * .45);
    panda(c, 306, 611, 1.02, this.clock, motion);
    if (path && !flight && game.status === 'playing') {
      c.fillStyle = '#fffdf4'; c.strokeStyle = '#5e3c7a'; c.lineWidth = .85;
      const points = path.points;
      let elapsed = 27;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], length = Math.hypot(a.x - b.x, a.y - b.y);
        while (elapsed < length) {
          const t = elapsed / length; c.beginPath(); c.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2.3, 0, Math.PI * 2); c.fill(); c.stroke(); elapsed += 14;
        }
        elapsed -= length;
      }
      if (path.slot >= 0) {
        const p = coords(path.slot, this.drop, game.stagger);
        c.strokeStyle = '#804880b2'; c.lineWidth = 1.1; c.beginPath(); c.arc(p.x, p.y, RADIUS - 1, 0, Math.PI * 2); c.stroke();
      }
    }
    c.lineJoin = 'round';
    c.beginPath(); c.moveTo(TRAY[0].x, TRAY[0].y); c.lineTo(TRAY[1].x, TRAY[1].y); c.lineTo(TRAY[2].x, TRAY[2].y); c.closePath();
    c.strokeStyle = '#7d56b2'; c.lineWidth = 8; c.stroke(); c.strokeStyle = '#f8ecff'; c.lineWidth = 3; c.stroke();
    for (let i = 0; i < TRAY.length; i++) {
      const point = TRAY[i];
      c.beginPath(); c.arc(point.x, point.y, i === 0 ? 22 : 19, 0, Math.PI * 2); c.fillStyle = i === 0 ? '#25a0ed' : '#7654b8'; c.fill();
      c.lineWidth = i === 0 ? 3 : 2; c.strokeStyle = i === 0 ? '#fff39e' : '#f9d9ff'; c.stroke();
    }
    if (game.status === 'playing') {
      this.bubble(TRAY[1].x, TRAY[1].y, game.next, symbols);
      this.bubble(TRAY[2].x, TRAY[2].y, game.reserve, symbols);
      const progress = this.pose ** 2;
      const input = TRAY[this.feed];
      const loaded = { x: ORIGIN.x + (input.x - ORIGIN.x) * progress, y: ORIGIN.y + (input.y - ORIGIN.y) * progress };
      const point = flight ? travel(flight.aim.points, flight.distance) : loaded;
      this.bubble(point.x, point.y, flight?.color ?? game.current, symbols);
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
  c.save(); c.scale(720 / WIDTH, 720 / HEIGHT); landscape(c, 0); c.restore();
  for (const [x, y, r, color] of [[100, 114, 65, 2], [249, 82, 68, 1], [429, 109, 82, 5], [581, 104, 60, 4], [532, 242, 84, 2], [325, 200, 61, 3], [179, 255, 65, 4], [409, 329, 66, 1], [620, 357, 45, 6], [238, 369, 48, 2]]) {
    orb(c, x, y, r, color);
  }
  shooter(c, 174, 680, 2.95);
  panda(c, 552, 680, 2.95);
  orb(c, 379, 498, 44, 4); orb(c, 342, 573, 36, 2); orb(c, 426, 573, 36, 3);
  c.strokeStyle = '#fff7ccae'; c.lineWidth = 2.5;
  const random = rng(2388);
  for (let i = 0; i < 22; i++) { c.beginPath(); c.arc(720 * random(), 720 * random(), 2 + 12 * random(), 0, Math.PI * 2); c.stroke(); }
}
