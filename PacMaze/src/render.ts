import { COLORS, Game, position, type Actor, type Ghost } from './game';
import { FRUIT, HEIGHT, WIDTH, cell, xOf, yOf, walkable } from './levels';

const TILE = 18;
const FRUIT_COLORS = ['#ff3754', '#ff526b', '#ffa738', '#fb515d', '#8cf053', '#ffce38', '#66ebf6', '#ffda74'];
const ANGLE = [-Math.PI / 2, Math.PI, Math.PI / 2, 0];

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private walls = document.createElement('canvas');
  private wallKey = '';

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = this.walls.width = WIDTH * TILE;
    canvas.height = this.walls.height = HEIGHT * TILE;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  private drawWalls(tiles: string, flash: boolean) {
    const c = this.walls.getContext('2d')!;
    c.fillStyle = '#05050a';
    c.fillRect(0, 0, this.walls.width, this.walls.height);
    c.beginPath();
    c.lineCap = 'round';
    const sides = [[0, -1, 0, 0, 1, 0], [1, 0, 1, 0, 1, 1], [0, 1, 1, 1, 0, 1], [-1, 0, 0, 1, 0, 0]];
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      if (tiles[cell(x, y)] !== '#') continue;
      for (const [dx, dy, ax, ay, bx, by] of sides) {
        if (x + dx < 0 || x + dx >= WIDTH || y + dy < 0 || y + dy >= HEIGHT) continue;
        if (!walkable(tiles[cell(x + dx, y + dy)], true)) continue;
        if (tiles[cell(x + dx, y + dy)] === '=') continue;
        c.moveTo((x + ax) * TILE - dx * 1.3, (y + ay) * TILE - dy * 1.3);
        c.lineTo((x + bx) * TILE - dx * 1.3, (y + by) * TILE - dy * 1.3);
      }
    }
    c.lineWidth = 5;
    c.strokeStyle = flash ? '#aabafa' : '#101b64';
    c.stroke();
    c.lineWidth = 2.1;
    c.strokeStyle = flash ? '#fffaf0' : '#465eff';
    c.stroke();
    c.fillStyle = '#ffa0ca';
    c.fillRect(13 * TILE, 12.54 * TILE, 2 * TILE, 3.5);
  }

  private disc(x: number, y: number, radius: number, color: string) {
    const c = this.ctx;
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, radius, 0, Math.PI * 2);
    c.fill();
  }

  private at(actor: Actor, draw: () => void) {
    const { x, y } = position(actor);
    for (const shift of [-WIDTH, 0, WIDTH]) {
      if (x + shift < -1.5 || x + shift > WIDTH + .5) continue;
      this.ctx.save();
      this.ctx.translate((x + shift + .5) * TILE, (y + .5) * TILE);
      draw();
      this.ctx.restore();
    }
  }

  private player(game: Game, clock: number) {
    const c = this.ctx;
    this.at(game.player, () => {
      if (game.phase === 'caught' && game.timer < .27) return;
      c.rotate(ANGLE[game.player.dir]);
      const mouth = game.phase === 'caught' ? Math.min(Math.PI, (1.35 - game.timer) * 2.4) : game.player.next < 0 ? .25 : .11 + .50 * Math.abs(Math.sin(clock * 20));
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, 8.4, mouth, Math.PI * 2 - mouth);
      c.closePath();
      c.fillStyle = '#ffdf2b';
      c.fill();
    });
  }

  private ghost(ghost: Ghost, game: Game, clock: number) {
    const c = this.ctx;
    this.at(ghost, () => {
      const scared = game.power > 0 && ghost.state === 'roam';
      const flash = scared && game.power < Math.min(1.5, game.level.frightened * .38) && Math.floor(clock * 9) % 2 === 0;
      if (ghost.state !== 'eyes') {
        c.fillStyle = scared ? (flash ? '#fff5ef' : '#333ee6') : COLORS[ghost.id];
        c.beginPath();
        c.moveTo(-8.2, 8.1);
        c.lineTo(-8.2, .1);
        c.arc(0, .1, 8.2, Math.PI, Math.PI * 2);
        c.lineTo(8.2, 8.1);
        for (let i = 1; i < 6; i++) c.lineTo(8.2 - i * 16.4 / 6, (i + Math.floor(clock * 11)) % 2 ? 5.5 : 8.1);
        c.closePath();
        c.fill();
      }
      if (scared) {
        const ink = flash ? '#d52a48' : '#fff3dd';
        this.disc(-3.3, -1.7, 1.05, ink);
        this.disc(3.3, -1.7, 1.05, ink);
        c.strokeStyle = ink;
        c.lineWidth = 1.2;
        c.beginPath();
        c.moveTo(-5.2, 4.5);
        for (let i = 1; i < 6; i++) c.lineTo(-5.2 + i * 2.08, i % 2 ? 2.5 : 4.5);
        c.stroke();
      } else {
        const a = ANGLE[ghost.dir];
        for (const x of [-3.5, 3.5]) {
          this.disc(x, -.9, 3, '#fffdf4');
          this.disc(x + Math.cos(a) * 1.25, -.9 + Math.sin(a) * 1.25, 1.55, '#2035ba');
        }
      }
    });
  }

  private fruit(type: number) {
    const c = this.ctx;
    const x = (xOf(FRUIT) + .5) * TILE, y = (yOf(FRUIT) + .5) * TILE;
    const color = FRUIT_COLORS[type];
    if (type === 0) {
      c.strokeStyle = '#80eb70'; c.lineWidth = 1.8;
      c.beginPath(); c.moveTo(x - 4, y + 2); c.lineTo(x + 2, y - 7); c.lineTo(x + 5, y + 3); c.stroke();
      this.disc(x - 4, y + 3, 4.5, color);
      this.disc(x + 4, y + 4, 4.5, color);
    } else if (type === 7) {
      c.strokeStyle = color; c.lineWidth = 2.7;
      c.beginPath(); c.arc(x, y - 4, 3.4, 0, Math.PI * 2); c.moveTo(x, y - 1); c.lineTo(x, y + 7); c.lineTo(x + 3, y + 7); c.stroke();
    } else if (type >= 5) {
      c.fillStyle = color;
      c.beginPath(); c.moveTo(x, y - 8); c.lineTo(x + 7, y + 5); c.lineTo(x - 7, y + 5); c.closePath(); c.fill();
      this.disc(x, y + 6, 2, '#fff5c2');
    } else {
      this.disc(x, y + 1, 6.4, color);
      this.disc(x + 2, y - 6, 2.6, '#8ced76');
      this.disc(x - 2, y - 1, 1.6, '#fff3b4');
    }
  }

  draw(game: Game, clock: number) {
    const c = this.ctx;
    const flash = game.phase === 'clear' && Math.floor(clock * 8) % 2 === 0;
    const key = `${game.index}-${flash}`;
    if (this.wallKey !== key) {
      this.drawWalls(game.level.tiles, flash);
      this.wallKey = key;
    }
    c.drawImage(this.walls, 0, 0);
    c.fillStyle = '#ffe4be';
    for (const dot of game.dots) c.fillRect((xOf(dot) + .5) * TILE - 1.55, (yOf(dot) + .5) * TILE - 1.55, 3.1, 3.1);
    for (const tile of game.powers) this.disc((xOf(tile) + .5) * TILE, (yOf(tile) + .5) * TILE, 4.15 + Math.sin(clock * 8) * 1.05, '#ffebd4');
    if (game.fruit > 0) this.fruit(game.fruitType);
    if (game.phase !== 'caught' && game.phase !== 'clear') for (const ghost of game.ghosts) this.ghost(ghost, game, clock);
    this.player(game, clock);
    c.font = 'bold 12px monospace';
    c.textAlign = 'center';
    c.fillStyle = '#99f6ff';
    for (const label of game.labels) c.fillText(String(label.value), (xOf(label.tile) + .5) * TILE, (yOf(label.tile) - .3 - (.95 - label.time) * .9) * TILE);
  }
}
