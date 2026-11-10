import { cell, DIRECTIONS, distances, DOOR, DX, DY, FRUIT, HOME, LEVELS, neighbor, opposite, START, TUNNEL, WIDTH, xOf, yOf, type Direction } from './levels';

export type Phase = 'ready' | 'play' | 'caught' | 'clear' | 'over' | 'win';
export type SoundCue = 'ready' | 'dot' | 'power' | 'ghost' | 'fruit' | 'caught' | 'clear' | 'life';
export interface Actor { tile: number; next: number; progress: number; dir: Direction }
type GhostState = 'house' | 'leaving' | 'roam' | 'eyes';
export interface Ghost extends Actor { id: number; state: GhostState; reverse: boolean; release: number }
export const COLORS = ['#ff334f', '#ff9fdc', '#45effa', '#ffaf49'];
export const FRUIT_VALUES = [100, 300, 500, 700, 1000, 2000, 3000, 5000];
export const FRUIT_NAMES = ['Cherry', 'Strawberry', 'Orange', 'Apple', 'Melon', 'Bell', 'Galaxian', 'Key'];
const spawn = (tile: number, dir: Direction): Actor => ({ tile, next: -1, progress: 0, dir });
export function position(actor: Actor) {
  const x = xOf(actor.tile) + DX[actor.dir] * actor.progress;
  const y = yOf(actor.tile) + DY[actor.dir] * actor.progress;
  return { x, y };
}

export class Game {
  level;
  dots = new Set<number>();
  powers = new Set<number>();
  initialDots = 0;
  player = spawn(START, 1);
  ghosts: Ghost[] = [];
  wanted: Direction = 1;
  phase: Phase = 'ready';
  timer = 0;
  power = 0;
  chain = 0;
  fruit = 0;
  fruitWave = 0;
  score: number;
  lives: number;
  mode: 'scatter' | 'chase' = 'scatter';
  modeTime = 0;
  shifts = 0;
  elapsed = 0;
  chew = 0;
  labels: { tile: number; value: number; time: number }[] = [];
  events: SoundCue[] = [];
  private seed = 3779;
  private homePath: Int16Array;
  private exitPath: Int16Array;

  constructor(public index = 0, score = 0, lives = 3, public readonly practice = false) {
    this.score = score;
    this.lives = lives;
    this.level = LEVELS[index];
    this.homePath = distances(this.level.tiles, HOME, true);
    this.exitPath = distances(this.level.tiles, DOOR, true);
    this.load(index);
  }

  get remaining() { return this.dots.size + this.powers.size; }
  get fruitType() { return Math.min(FRUIT_VALUES.length - 1, this.index); }

  private load(index: number) {
    this.index = index;
    this.level = LEVELS[index];
    this.homePath = distances(this.level.tiles, HOME, true);
    this.exitPath = distances(this.level.tiles, DOOR, true);
    this.dots.clear();
    this.powers.clear();
    [...this.level.tiles].forEach((tile, i) => {
      if (tile === '.') this.dots.add(i);
      if (tile === 'o') this.powers.add(i);
    });
    this.initialDots = this.remaining;
    this.fruitWave = 0;
    this.seed = 3779 + index;
    this.resetActors();
  }

  private resetActors() {
    this.player = spawn(START, 1);
    this.wanted = 1;
    this.ghosts = [DOOR, HOME, cell(11, 14), cell(16, 14)].map((tile, id) => ({
      ...spawn(tile, 1), id, state: id ? 'house' : 'roam', reverse: false, release: this.level.release[id],
    }));
    this.phase = 'ready';
    this.timer = 1.65;
    this.mode = 'scatter';
    this.modeTime = this.level.scatter;
    this.shifts = 0;
    this.elapsed = this.power = this.chain = this.fruit = this.chew = 0;
    this.labels = [];
    this.events.push('ready');
  }

  private add(points: number) {
    const before = this.score;
    this.score += points;
    if (before < 10_000 && this.score >= 10_000) {
      this.lives++;
      this.events.push('life');
    }
  }

  private eat() {
    const tile = this.player.tile;
    if (this.dots.delete(tile)) {
      this.add(10);
      this.chew = 0.015;
      this.events.push('dot');
    }
    if (this.powers.delete(tile)) {
      this.add(50);
      this.chew = 0.045;
      this.power = this.level.frightened;
      this.chain = 0;
      this.reverseGhosts();
      this.events.push('power');
    }
    const eaten = this.initialDots - this.remaining;
    const fruitThreshold = [Math.round(this.initialDots * .29), Math.round(this.initialDots * .70)][this.fruitWave];
    if (fruitThreshold !== undefined && eaten >= fruitThreshold) {
      this.fruitWave++;
      this.fruit = 9.5;
    }
    if (tile === FRUIT && this.fruit > 0) {
      const points = FRUIT_VALUES[this.fruitType];
      this.add(points);
      this.fruit = 0;
      this.labels.push({ tile, value: points, time: 0.95 });
      this.events.push('fruit');
    }
  }

  private reverseGhosts() {
    for (const ghost of this.ghosts) if (ghost.state === 'roam') ghost.reverse = !ghost.reverse;
  }

  private move(actor: Actor, distance: number, choose: () => Direction | undefined, arrived?: () => void) {
    while (distance > 1e-7) {
      if (actor.next < 0) {
        const dir = choose();
        if (dir === undefined) break;
        actor.dir = dir;
        actor.next = neighbor(this.level.tiles, actor.tile, dir, actor !== this.player);
        if (actor.next < 0) break;
      }
      const step = Math.min(distance, 1 - actor.progress);
      actor.progress += step;
      distance -= step;
      if (actor.progress < 1 - 1e-7) break;
      actor.tile = actor.next;
      actor.next = -1;
      actor.progress = 0;
      arrived?.();
    }
  }

  private movePlayer(dt: number) {
    const actor = this.player;
    if (actor.next >= 0 && this.wanted === opposite(actor.dir)) {
      [actor.next, actor.tile] = [actor.tile, actor.next];
      actor.progress = 1 - actor.progress;
      actor.dir = this.wanted;
    }
    if (this.chew > 0) {
      this.chew -= dt;
      return;
    }
    this.move(actor, dt * (this.level.playerSpeed + (this.power > 0 ? .25 : 0)), () => {
      if (neighbor(this.level.tiles, actor.tile, this.wanted) >= 0) return this.wanted;
      if (neighbor(this.level.tiles, actor.tile, actor.dir) >= 0) return actor.dir;
    }, () => this.eat());
  }

  target(ghost: Ghost): [number, number] {
    const p = this.player;
    const x = xOf(p.tile), y = yOf(p.tile);
    const corner: [number, number] = [[25, -2], [2, -2], [27, 32], [0, 32]][ghost.id] as [number, number];
    if (this.mode === 'scatter') return corner;
    if (ghost.id === 1) return [x + 4 * DX[p.dir], y + 4 * DY[p.dir]];
    if (ghost.id === 2) {
      const leader = this.ghosts[0].tile;
      return [2 * (x + 2 * DX[p.dir]) - xOf(leader), 2 * (y + 2 * DY[p.dir]) - yOf(leader)];
    }
    if (ghost.id === 3 && (x - xOf(ghost.tile)) ** 2 + (y - yOf(ghost.tile)) ** 2 < 64) return corner;
    return [x, y];
  }

  private ghostDirection(ghost: Ghost): Direction | undefined {
    const house = ghost.state !== 'roam';
    const options = DIRECTIONS.flatMap(dir => {
      const tile = neighbor(this.level.tiles, ghost.tile, dir, house);
      return tile < 0 ? [] : [{ dir, tile }];
    });
    if (house) {
      const path = ghost.state === 'eyes' ? this.homePath : this.exitPath;
      return options.find(option => path[option.tile] === path[ghost.tile] - 1)?.dir;
    }
    const reverse = opposite(ghost.dir);
    if (ghost.reverse) {
      ghost.reverse = false;
      if (options.some(option => option.dir === reverse)) return reverse;
    }
    const turns = options.filter(option => option.dir !== reverse);
    if (!turns.length) return options[0]?.dir;
    if (this.power > 0) {
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
      return turns[Math.floor(this.seed / 2 ** 32 * turns.length)].dir;
    }
    const [x, y] = this.target(ghost);
    let best = Infinity;
    let dir = turns[0].dir;
    for (const option of turns) {
      const length = (x - xOf(option.tile)) ** 2 + (y - yOf(option.tile)) ** 2;
      if (length < best) { best = length; dir = option.dir; }
    }
    return dir;
  }

  private moveGhost(ghost: Ghost, dt: number) {
    if (ghost.state === 'house') {
      if (this.elapsed < ghost.release) return;
      ghost.state = 'leaving';
    }
    const tunnel = yOf(ghost.tile) === TUNNEL && (xOf(ghost.tile) < 5 || xOf(ghost.tile) > WIDTH - 6);
    const speed = ghost.state === 'eyes' ? 13 : ghost.state === 'leaving' ? 4.7 : this.level.ghostSpeed * (tunnel ? .60 : this.power > 0 ? .65 : 1);
    this.move(ghost, dt * speed, () => this.ghostDirection(ghost), () => {
      if (ghost.state === 'eyes' && ghost.tile === HOME) {
        ghost.state = 'leaving';
      } else if (ghost.state === 'leaving' && ghost.tile === DOOR) {
        ghost.state = 'roam';
        ghost.dir = 1;
      }
    });
  }

  private contact(ghost: Ghost) {
    if (ghost.state !== 'roam') return;
    const a = position(this.player), b = position(ghost);
    const dx = Math.abs(a.x - b.x);
    if (Math.hypot(Math.min(dx, Math.abs(WIDTH - dx)), a.y - b.y) > .68) return;
    if (this.power > 0) {
      ghost.state = 'eyes';
      ghost.reverse = false;
      const points = 200 * 2 ** Math.min(3, this.chain++);
      this.add(points);
      this.labels.push({ tile: ghost.tile, value: points, time: .9 });
      this.events.push('ghost');
    } else {
      this.lives--;
      this.phase = 'caught';
      this.timer = 1.35;
      this.events.push('caught');
    }
  }

  update(dt: number) {
    if (this.phase === 'over' || this.phase === 'win') return;
    if (this.phase !== 'play') {
      this.timer -= dt;
      if (this.timer > 0) return;
      if (this.phase === 'ready') this.phase = 'play';
      else if (this.phase === 'caught') {
        if (this.lives <= 0) this.phase = 'over';
        else this.resetActors();
      } else if (this.practice || this.index === LEVELS.length - 1) this.phase = 'win';
      else this.load(this.index + 1);
      return;
    }
    this.elapsed += dt;
    this.fruit = Math.max(0, this.fruit - dt);
    this.power = Math.max(0, this.power - dt);
    for (const label of this.labels) label.time -= dt;
    this.labels = this.labels.filter(label => label.time > 0);
    if (this.power <= 0 && this.shifts < 7) {
      this.modeTime -= dt;
      if (this.modeTime <= 0) {
        this.mode = this.mode === 'scatter' ? 'chase' : 'scatter';
        this.shifts++;
        this.modeTime = this.mode === 'scatter' ? this.level.scatter : this.level.chase;
        this.reverseGhosts();
      }
    }
    this.movePlayer(dt);
    if (!this.remaining) {
      this.phase = 'clear';
      this.timer = 1.45;
      this.events.push('clear');
      return;
    }
    for (const ghost of this.ghosts) {
      this.moveGhost(ghost, dt);
      this.contact(ghost);
      if (this.phase !== 'play') break;
    }
  }
}
