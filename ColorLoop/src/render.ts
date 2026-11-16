import { type Effect, type Match, WALL } from './game';
import { MASCOTS, WORLDS } from './levels';
import { mascot } from './mascots';

const TILE = 20;
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number }
interface Label { x: number; y: number; text: string; life: number; color: string }

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly paper = document.createElement('canvas');
  private match?: Match;
  private particles: Particle[] = [];
  private labels: Label[] = [];
  private readonly reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private canvas: HTMLCanvasElement) { this.ctx = canvas.getContext('2d', { alpha: false })!; }

  private reset(match: Match) {
    this.match = match;
    this.particles = [];
    this.labels = [];
    this.canvas.width = this.paper.width = match.width * TILE;
    this.canvas.height = this.paper.height = match.height * TILE;
    const c = this.paper.getContext('2d')!;
    const world = WORLDS[match.stage.world];
    const w = this.paper.width, h = this.paper.height;
    c.fillStyle = world.paper;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = world.grid;
    c.lineWidth = 1;
    c.beginPath();
    for (let x = TILE; x < w; x += TILE) { c.moveTo(x + .5, 0); c.lineTo(x + .5, h); }
    for (let y = TILE; y < h; y += TILE) { c.moveTo(0, y + .5); c.lineTo(w, y + .5); }
    c.stroke();
    for (let i = 0; i < 150; i++) {
      const x = (i * 313 + i * i * 71) % w, y = (i * 127 + i * i * 29) % h;
      c.fillStyle = world.speck;
      c.globalAlpha = .48;
      c.fillRect(x, y, 2 + i % 3, 2 + i % 2);
    }
    c.globalAlpha = 1;
  }

  effect(event: Effect) {
    if (!this.match) return;
    const m = MASCOTS[event.skin];
    const x = (event.x + .5) * TILE, y = (event.y + .5) * TILE;
    const count = this.reduce ? 0 : event.type === 'clear' ? 45 : Math.min(34, 9 + event.count / 5);
    for (let i = 0; i < count; i++) {
      const a = i * 2.399, speed = 42 + (i * 19) % 145;
      this.particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: .46 + i % 5 * .07, color: [m.ink, m.accent, '#fff2bc', '#fff'][i % 4], size: 4 + i % 5 });
    }
    if (event.type === 'claim' && event.count > 0) this.labels.push({ x, y: y - 31, text: `+${(event.count / this.match.playable * 100).toFixed(1)}%`, life: .8, color: m.dark });
  }

  draw(match: Match, blend: number, clock: number, dt: number) {
    if (match !== this.match) this.reset(match);
    const c = this.ctx;
    c.drawImage(this.paper, 0, 0);
    const { width, height, land, trail, riders } = match;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const owner = land[at];
      if (owner === 0) continue;
      const px = x * TILE, py = y * TILE;
      if (owner === WALL) {
        c.fillStyle = '#49315f';
        c.fillRect(px, py, TILE, TILE);
        c.fillStyle = '#67507f';
        c.fillRect(px + 4, py + 4, TILE - 8, TILE - 8);
        c.fillStyle = '#b9a1cf';
        c.fillRect(px + 8, py + 8, 4, 4);
        continue;
      }
      const color = MASCOTS[riders[owner - 1].skin];
      c.fillStyle = color.light;
      c.fillRect(px, py, TILE, TILE);
      c.globalAlpha = .22;
      c.fillStyle = color.ink;
      c.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
      c.globalAlpha = 1;
      c.fillStyle = color.ink;
      if (x === 0 || land[at - 1] !== owner) c.fillRect(px, py, 3, TILE);
      if (x === width - 1 || land[at + 1] !== owner) c.fillRect(px + TILE - 3, py, 3, TILE);
      if (y === 0 || land[at - width] !== owner) c.fillRect(px, py, TILE, 3);
      if (y === height - 1 || land[at + width] !== owner) c.fillRect(px, py + TILE - 3, TILE, 3);
    }
    for (const rider of riders) {
      if (!rider.alive) continue;
      const m = MASCOTS[rider.skin];
      for (const tile of rider.path) {
        if (trail[tile] !== rider.id) continue;
        const x = tile % width * TILE, y = Math.floor(tile / width) * TILE;
        c.fillStyle = m.dark;
        c.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
        c.fillStyle = m.ink;
        c.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
        c.fillStyle = '#ffffff72';
        c.fillRect(x + 6, y + 4, 4, 3);
      }
      const x = (rider.lastX + (rider.x - rider.lastX) * blend + .5) * TILE;
      const y = (rider.lastY + (rider.y - rider.lastY) * blend + .5) * TILE;
      const player = rider === match.player;
      mascot(c, rider.skin, x, y - 5, player ? 66 : 60, this.reduce ? 0 : clock, rider.dir === 2 ? -1 : 1);
      c.font = `900 ${player ? 18 : 15}px system-ui`;
      c.textAlign = 'center';
      c.lineWidth = 5;
      c.strokeStyle = '#fff8e9';
      c.strokeText(rider.name, x, y - 44);
      c.fillStyle = '#35234e';
      c.fillText(rider.name, x, y - 44);
    }
    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 120 * dt; p.life -= dt;
      c.globalAlpha = Math.min(1, Math.max(0, p.life * 3));
      c.fillStyle = p.color;
      c.fillRect(p.x, p.y, p.size, p.size);
    }
    c.globalAlpha = 1;
    this.particles = this.particles.filter(p => p.life > 0);
    for (const label of this.labels) {
      label.life -= dt; label.y -= dt * 24;
      c.globalAlpha = Math.min(1, Math.max(0, label.life * 3));
      c.font = '950 27px system-ui';
      c.textAlign = 'center';
      c.lineWidth = 6;
      c.strokeStyle = '#fff8ed';
      c.strokeText(label.text, label.x, label.y);
      c.fillStyle = label.color;
      c.fillText(label.text, label.x, label.y);
    }
    c.globalAlpha = 1;
    this.labels = this.labels.filter(label => label.life > 0);
  }
}
