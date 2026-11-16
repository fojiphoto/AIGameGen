import { DIRS, DX, DY, MASCOTS, STAGES, endlessStage, reverse, type Direction, type Mode, type Stage } from './levels';

export const WALL = -1;
export const STEP = 1 / 10.5;
export type Outcome = 'playing' | 'lost' | 'cleared' | 'island';
export interface Rider {
  id: number; skin: number; name: string; x: number; y: number; lastX: number; lastY: number;
  dir: Direction; alive: boolean; area: number; path: number[]; stride: number;
  respawn: number; spawnAge: number; route: number[];
}
export interface Effect { type: 'claim' | 'cut' | 'clear'; x: number; y: number; count: number; skin: number }

const RIVAL_NAMES = ['Fizz', 'Taffy', 'Pip', 'Mochi', 'Zuzu', 'Boba', 'Doodle'];
type Move = { rider: Rider; to: number };

export class Match {
  readonly stage: Stage;
  readonly land: Int8Array;
  readonly trail: Int8Array;
  readonly riders: Rider[] = [];
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly playable: number;
  readonly player: Rider;
  readonly effects: Effect[] = [];
  outcome: Outcome = 'playing';
  reason = '';
  age = 0;
  peak = 0;
  cuts = 0;
  wanted: Direction = 0;
  private randomState: number;
  private queue: Int32Array;
  private marks: Uint8Array;

  constructor(readonly mode: Mode, readonly level = 0, skin = 0, readonly cycle = 0, seed = 3819) {
    this.stage = mode === 'campaign' ? STAGES[level] : endlessStage(cycle);
    this.width = this.stage.width;
    this.height = this.stage.height;
    this.size = this.width * this.height;
    this.land = new Int8Array(this.size);
    this.trail = new Int8Array(this.size);
    this.queue = new Int32Array(this.size);
    this.marks = new Uint8Array(this.size);
    this.randomState = (seed + level * 1723 + cycle * 997) >>> 0;
    const y = Math.floor(this.height / 2);
    const spots = [[9, y], [this.width - 9, y - 9], [this.width - 9, y + 9], [this.width / 2 | 0, 7],
      [this.width / 2 | 0, this.height - 8], [9, 7], [9, this.height - 8], [this.width - 8, y]];
    this.player = this.addRider(1, skin, 'You', 9, y, 2);
    for (let i = 0; i < this.stage.rivals; i++) {
      const [x, sy] = spots[i + 1];
      this.addRider(i + 2, (skin + i + 1) % MASCOTS.length, RIVAL_NAMES[i], x, sy, 2);
    }
    const center = this.width / 2 | 0;
    const rocks = [[center + 3, y, 3, 2], [center - 10, y - 9, 2, 2], [center - 9, y + 9, 2, 2],
      [center + 10, y - 3, 2, 2], [center + 9, y + 6, 2, 2]];
    for (const [x, sy, w, h] of rocks.slice(0, this.stage.obstacles)) {
      for (let dy = -h; dy <= h; dy++) for (let dx = -w; dx <= w; dx++) {
        if (Math.abs(dx) + Math.abs(dy) < w + h) {
          const tile = this.at(x + dx, sy + dy);
          if (this.land[tile] === 0) this.land[tile] = WALL;
        }
      }
    }
    this.playable = this.land.reduce((sum, owner) => sum + Number(owner !== WALL), 0);
    this.peak = this.share(this.player);
  }

  private random() {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 2 ** 32;
  }

  at(x: number, y: number) { return x < 0 || y < 0 || x >= this.width || y >= this.height ? -1 : y * this.width + x; }
  share(rider = this.player) { return 100 * rider.area / this.playable; }

  private adjacent(tile: number, dir: Direction) {
    return this.at(tile % this.width + DX[dir], Math.floor(tile / this.width) + DY[dir]);
  }

  private paint(tile: number, id: number) {
    const owner = this.land[tile];
    if (owner === id) return;
    if (owner > 0) this.riders[owner - 1].area--;
    this.land[tile] = id;
    if (id > 0) this.riders[id - 1].area++;
  }

  private seedHome(rider: Rider, x: number, y: number, radius: number) {
    rider.x = rider.lastX = x;
    rider.y = rider.lastY = y;
    rider.dir = 0;
    rider.alive = true;
    rider.spawnAge = 0;
    rider.stride = 0;
    rider.route.length = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const tile = this.at(x + dx, y + dy);
      if (tile >= 0 && this.land[tile] === 0) this.paint(tile, rider.id);
    }
  }

  private addRider(id: number, skin: number, name: string, x: number, y: number, radius: number) {
    const rider: Rider = { id, skin, name, x, y, lastX: x, lastY: y, dir: 0, alive: true, area: 0, path: [], stride: 0, respawn: 0, spawnAge: 0, route: [] };
    this.riders.push(rider);
    this.seedHome(rider, x, y, radius);
    return rider;
  }

  steer(dir: Direction) { this.wanted = dir; }

  private cut(rider: Rider, reason: string, killer?: Rider) {
    if (!rider.alive) return;
    rider.alive = false;
    rider.respawn = this.age + 2.9 + this.random() * 1.5;
    for (const tile of rider.path) if (this.trail[tile] === rider.id) this.trail[tile] = 0;
    rider.path.length = 0;
    for (let tile = 0; tile < this.size; tile++) if (this.land[tile] === rider.id) this.paint(tile, 0);
    this.effects.push({ type: 'cut', x: rider.x, y: rider.y, count: 0, skin: rider.skin });
    if (killer === this.player && rider !== this.player) this.cuts++;
    if (rider === this.player) { this.outcome = 'lost'; this.reason = reason; }
  }

  private flood(start: number, mark: number, canVisit: (tile: number) => boolean) {
    let count = 1;
    this.queue[0] = start;
    this.marks[start] = mark;
    for (let read = 0; read < count; read++) {
      for (const dir of DIRS) {
        const next = this.adjacent(this.queue[read], dir);
        if (next < 0 || !canVisit(next)) continue;
        this.marks[next] = mark;
        this.queue[count++] = next;
      }
    }
    return count;
  }

  private claim(rider: Rider) {
    const id = rider.id;
    this.marks.fill(0);
    // Only fill regions split by the current trail. Keep the largest remaining region open.
    this.flood(rider.path[0], 1, tile => this.marks[tile] === 0 && this.land[tile] !== id && this.land[tile] !== WALL);
    for (const tile of rider.path) { this.paint(tile, id); this.trail[tile] = 0; this.marks[tile] = 0; }
    let count = rider.path.length;
    rider.path.length = 0;
    let largest = 0, keep: number[] = [];
    const fill: number[] = [];
    for (let i = 0; i < this.size; i++) {
      if (this.marks[i] !== 1) continue;
      const length = this.flood(i, 2, tile => this.marks[tile] === 1);
      const region = Array.from(this.queue.subarray(0, length));
      if (length > largest) {
        for (const tile of keep) fill.push(tile);
        largest = length;
        keep = region;
      } else for (const tile of region) fill.push(tile);
    }
    for (const tile of fill) { this.paint(tile, id); count++; }
    for (const rival of this.riders) if (rival.alive && rival.area === 0) this.cut(rival, `${rider.name} took your last patch.`, rider);
    this.effects.push({ type: 'claim', x: rider.x, y: rider.y, count, skin: rider.skin });
  }

  private respawn(rider: Rider) {
    if (this.share() >= 97) return;
    for (let trial = 0; trial < 46; trial++) {
      const x = 2 + Math.floor(this.random() * (this.width - 4));
      const y = 2 + Math.floor(this.random() * (this.height - 4));
      if (this.riders.some(other => other.alive && Math.abs(other.x - x) + Math.abs(other.y - y) < 9)) continue;
      let free = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const tile = this.at(x + dx, y + dy);
        if (this.land[tile] || this.trail[tile]) free = false;
      }
      if (free) { this.seedHome(rider, x, y, 1); return; }
    }
    rider.respawn = this.age + 1;
  }

  private routeTo(start: number, goal: (tile: number) => boolean, id: number) {
    const parent = new Int32Array(this.size).fill(-1);
    this.queue[0] = start;
    parent[start] = start;
    let count = 1;
    for (let i = 0; i < count; i++) {
      const at = this.queue[i];
      if (at !== start && goal(at)) {
        const route: number[] = [];
        for (let tile = at; tile !== start; tile = parent[tile]) route.push(tile);
        return route.reverse();
      }
      for (const dir of DIRS) {
        const next = this.adjacent(at, dir);
        if (next < 0 || parent[next] >= 0 || this.land[next] === WALL || this.trail[next] === id) continue;
        parent[next] = at;
        this.queue[count++] = next;
      }
    }
    return [];
  }

  private excursion(rider: Rider, start: number) {
    let best: number[] = [];
    let score = -Infinity;
    for (let attempt = 0; attempt < 34; attempt++) {
      const dir = (this.random() * 4 | 0) as Direction;
      const side = ((dir + (this.random() < .5 ? 1 : 3)) % 4) as Direction;
      const leg = 3 + (this.random() * (this.stage.aggression > 8 ? 9 : 6) | 0);
      const span = 2 + (this.random() * 6 | 0);
      const route: number[] = [];
      let tile = start, value = 0, leftHome = false, done = false;
      const legs: [Direction, number][] = [[dir, leg], [side, span], [reverse(dir), leg + 3]];
      for (const [heading, steps] of legs) {
        for (let j = 0; j < steps; j++) {
          tile = this.adjacent(tile, heading);
          if (tile < 0 || this.land[tile] === WALL) break;
          route.push(tile);
          if (this.land[tile] === rider.id) {
            if (leftHome) { done = true; break; }
          } else {
            leftHome = true;
            value += this.land[tile] === 0 ? 1.1 : 1.5;
          }
        }
        if (done || tile < 0 || this.land[tile] === WALL) break;
      }
      if (done && value > score) { best = route; score = value; }
    }
    return best;
  }

  private brain(rider: Rider): Direction {
    const start = this.at(rider.x, rider.y);
    const dirFor = (tile: number) => DIRS.find(dir => this.adjacent(start, dir) === tile);
    const home = (tile: number) => this.land[tile] === rider.id;
    const distance = (tile: number) => Math.abs(tile % this.width - rider.x) + Math.abs(Math.floor(tile / this.width) - rider.y);
    const target = this.player.path.find(tile => distance(tile) <= this.stage.aggression);
    if (!rider.path.length && target !== undefined && rider.spawnAge > 2 && this.random() < .22) {
      const attack = this.routeTo(start, tile => tile === target, rider.id);
      if (attack.length && attack.length <= this.stage.aggression + 2) rider.route = attack;
    }
    const next = rider.route[0];
    if (next === undefined || this.trail[next] === rider.id || dirFor(next) === undefined || rider.path.length > 27) {
      rider.route = rider.path.length || !home(start) ? this.routeTo(start, home, rider.id) : this.excursion(rider, start);
    }
    if (!rider.route.length && home(start)) {
      rider.route = this.routeTo(start, tile => this.land[tile] === 0, rider.id).slice(0, 5);
    }
    const dir = dirFor(rider.route.shift() ?? -2);
    if (dir !== undefined) return dir;
    return DIRS.find(d => {
      const tile = this.adjacent(start, d);
      return tile >= 0 && this.land[tile] !== WALL && this.trail[tile] !== rider.id;
    }) ?? rider.dir;
  }

  tick() {
    if (this.outcome !== 'playing') return;
    this.age += STEP;
    const moves: Move[] = [];
    for (const rider of this.riders) {
      rider.lastX = rider.x;
      rider.lastY = rider.y;
      if (!rider.alive) {
        if (this.mode === 'endless' && rider.respawn <= this.age) this.respawn(rider);
        continue;
      }
      rider.spawnAge += STEP;
      rider.stride += rider === this.player ? 1 : this.stage.pace;
      if (rider.stride < 1) continue;
      rider.stride -= 1;
      const from = this.at(rider.x, rider.y);
      const direction = rider === this.player ? this.wanted : this.brain(rider);
      if (rider !== this.player || !rider.path.length || direction !== reverse(rider.dir)) rider.dir = direction;
      const to = this.adjacent(from, rider.dir);
      if (to < 0 || this.land[to] === WALL) {
        if (rider === this.player) this.cut(rider, to < 0 ? 'You hit the edge of the arena.' : 'You hit a bumper.');
        else rider.route.length = 0;
        continue;
      }
      moves.push({ rider, to });
    }
    const victims = new Map<Rider, { reason: string; killer?: Rider }>();
    for (const { rider, to } of moves) {
      const id = this.trail[to];
      if (id <= 0) continue;
      const victim = this.riders[id - 1];
      victims.set(victim, { reason: victim === rider ? 'You crossed your own ribbon.' : `${rider.name} cut your ribbon.`, killer: rider });
    }
    for (let i = 0; i < this.riders.length; i++) for (let j = i + 1; j < this.riders.length; j++) {
      const a = this.riders[i], b = this.riders[j];
      if (!a.alive || !b.alive || victims.has(a) || victims.has(b)) continue;
      const am = moves.find(move => move.rider === a), bm = moves.find(move => move.rider === b);
      const af = this.at(a.x, a.y), bf = this.at(b.x, b.y);
      const at = am?.to ?? af, bt = bm?.to ?? bf;
      if (at !== bt && !(at === bf && bt === af)) continue;
      const aSafe = this.land[at] === a.id, bSafe = this.land[bt] === b.id;
      if (!aSafe || bSafe) victims.set(a, { reason: `Head-on with ${b.name}.`, killer: b });
      if (!bSafe || aSafe) victims.set(b, { reason: `Head-on with ${a.name}.`, killer: a });
    }
    for (const [rider, { reason, killer }] of victims) this.cut(rider, reason, killer);
    for (const { rider, to } of moves) if (rider.alive) {
      rider.x = to % this.width;
      rider.y = Math.floor(to / this.width);
    }
    for (const { rider, to } of moves) if (rider.alive) {
      if (this.land[to] === rider.id) {
        if (rider.path.length) this.claim(rider);
      } else {
        rider.path.push(to);
        this.trail[to] = rider.id;
      }
    }
    if (this.player.alive) this.peak = Math.max(this.peak, this.share());
    if (this.outcome === 'playing' && this.share() + 1e-8 >= this.stage.goal) {
      this.outcome = this.mode === 'campaign' ? 'cleared' : 'island';
      this.effects.push({ type: 'clear', x: this.player.x, y: this.player.y, count: 0, skin: this.player.skin });
    }
  }
}
