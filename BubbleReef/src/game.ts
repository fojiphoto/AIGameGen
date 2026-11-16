import { ANGLE_LIMIT, COLS, DIAMETER, LEVELS, LIMIT, ORIGIN, WIDTH, connected, coords, neighbors, rowOf } from './levels';

export type Status = 'playing' | 'won' | 'lost';
export interface Point { x: number; y: number }
export interface Aim { points: Point[]; slot: number; bounces: number }
export interface Removed { cell: number; color: number; falling: boolean }
export interface Result { removed: Removed[]; hit: number; color: number; oldDrop: number; newDrop: number; bounces: number }

const WALL = DIAMETER / 2;
const COLLISION = 31.8;
const PRESS = 18;

function nearest(cells: Iterable<number>, to: Point, board: Int8Array, drop: number) {
  let best = -1, distance = Infinity;
  for (const cell of cells) {
    if (board[cell]) continue;
    const p = coords(cell, drop), d = (p.x - to.x) ** 2 + (p.y - to.y) ** 2;
    if (d < distance) { distance = d; best = cell; }
  }
  return best;
}

export function aim(board: Int8Array, drop: number, angle: number): Aim {
  const a = Math.max(-ANGLE_LIMIT, Math.min(ANGLE_LIMIT, angle));
  let vx = Math.sin(a);
  const vy = -Math.cos(a);
  let x = ORIGIN.x, y = ORIGIN.y;
  const points = [{ x, y }];
  const targets: { cell: number; x: number; y: number }[] = [];
  for (let i = 0; i < board.length; i++) if (board[i]) targets.push({ cell: i, ...coords(i, drop) });
  for (let bounces = 0; bounces < 12; bounces++) {
    const ceiling = (24 + drop - y) / vy;
    const wall = vx > 1e-8 ? (WIDTH - WALL - x) / vx : vx < -1e-8 ? (WALL - x) / vx : Infinity;
    let t = Math.min(ceiling, wall), hit = -1;
    for (const p of targets) {
      const dx = p.x - x, dy = p.y - y;
      const along = dx * vx + dy * vy;
      const inside = COLLISION ** 2 - (dx * dx + dy * dy - along * along);
      if (inside < 0 || along <= 0) continue;
      const t0 = Math.max(0, along - Math.sqrt(inside));
      if (t0 < t) { t = t0; hit = p.cell; }
    }
    x += vx * t;
    y += vy * t;
    const p = { x, y };
    points.push(p);
    if (hit >= 0) return { points, slot: nearest(neighbors[hit], p, board, drop), bounces };
    if (ceiling <= wall) {
      const col = Math.max(0, Math.min(COLS - 1, Math.floor(x / DIAMETER)));
      return { points, slot: nearest([col, ...(col > 0 ? [col - 1] : []), ...(col + 1 < COLS ? [col + 1] : [])], p, board, drop), bounces };
    }
    vx = -vx;
  }
  return { points, slot: -1, bounces: 11 };
}

export function group(board: Int8Array, start: number, color = board[start]) {
  const found = [start], seen = new Set(found);
  for (let i = 0; i < found.length; i++) for (const n of neighbors[found[i]]) {
    if (seen.has(n) || board[n] !== color) continue;
    seen.add(n);
    found.push(n);
  }
  return found;
}

export class Game {
  board: Int8Array;
  status: Status = 'playing';
  current: number;
  next: number;
  score = 0;
  shots = 0;
  misses = 0;
  pressure = 0;
  drop = 0;
  left: number;
  readonly total: number;
  readonly level;
  private random: number;

  constructor(readonly index: number) {
    this.level = LEVELS[index];
    this.board = this.level.board.slice();
    this.random = this.level.seed ^ 0xb0bb1e;
    this.left = this.total = this.board.reduce((n, v) => n + Number(v > 0), 0);
    this.current = this.draw();
    this.next = this.draw();
  }

  private draw() {
    const colors = [...new Set(this.board.filter(Boolean))].sort((a, b) => a - b);
    this.random = (Math.imul(this.random, 1664525) + 1013904223) >>> 0;
    return colors.length ? colors[Math.floor(this.random / 2 ** 32 * colors.length)] : 1;
  }

  get chances() { return this.level.tension - this.pressure; }
  get stars() { return this.status === 'won' ? this.misses <= 2 + this.level.chapter ? 3 : this.misses <= 7 + this.level.chapter * 2 ? 2 : 1 : 0; }
  trace(angle: number) { return aim(this.board, this.drop, angle); }
  swap() { if (this.status === 'playing') [this.current, this.next] = [this.next, this.current]; }

  resolve(path: Aim): Result | undefined {
    if (this.status !== 'playing') return;
    const color = this.current, hit = path.slot;
    const result: Result = { hit, color, oldDrop: this.drop, newDrop: this.drop, bounces: path.bounces, removed: [] };
    this.shots++;
    if (hit < 0) { this.status = 'lost'; return result; }
    if (this.board[hit]) throw new Error('Shot cannot attach to an occupied cell');
    this.board[hit] = color;
    this.left++;
    const cluster = group(this.board, hit);
    if (cluster.length >= 3) {
      for (const cell of cluster) {
        this.board[cell] = 0;
        result.removed.push({ cell, color, falling: false });
      }
      const supported = connected(this.board);
      for (let cell = 0; cell < this.board.length; cell++) if (this.board[cell] && !supported[cell]) {
        result.removed.push({ cell, color: this.board[cell], falling: true });
        this.board[cell] = 0;
      }
      this.left -= result.removed.length;
      this.score += cluster.length * 20 + (result.removed.length - cluster.length) * 55 + Math.min(3, path.bounces) * 15;
    } else {
      this.misses++;
      this.pressure++;
      if (this.pressure >= this.level.tension) {
        this.pressure = 0;
        this.drop += PRESS;
        result.newDrop = this.drop;
      }
    }
    if (this.left === 0) { this.status = 'won'; this.score += this.chances * 50; }
    else {
      let last = this.board.length - 1;
      while (!this.board[last]) last--;
      if (coords(last, this.drop).y + COLLISION / 2 >= LIMIT) this.status = 'lost';
      this.current = this.board.includes(this.next) ? this.next : this.draw();
      this.next = this.draw();
    }
    return result;
  }

  clone() {
    const copy: Game = Object.assign(Object.create(Game.prototype), this);
    copy.board = this.board.slice();
    return copy;
  }

  get deepest() {
    let last = this.board.length - 1;
    while (last >= 0 && !this.board[last]) last--;
    return last < 0 ? 0 : rowOf(last);
  }
}
