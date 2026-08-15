/**
 * Level data.
 *
 * Levels are ASCII grids plus a small list of parameterised objects. That choice is worth
 * defending: a binary tilemap is smaller and a visual editor is friendlier, but a level you can
 * *read* in the source is a level whose design can be reviewed, diffed and reasoned about — and
 * a platformer lives or dies on whether the pacing of its gaps and enemies is deliberate. A
 * fifty-line grid shows that at a glance. A JSON array of tile indices shows nothing.
 *
 * The grid carries terrain and point entities; anything with parameters (a platform's path, a
 * camera zone) is listed separately. Parsing is strict and reports the line and column of a bad
 * character, because a silently-ignored typo in a level is a hole in the floor.
 */

import { TILE } from './constants.js';
import { TileMap, Tile } from './world.js';

export type EnemyKind =
  | 'walker' | 'jumper' | 'flyer' | 'charger' | 'shielded' | 'turret' | 'heavy' | 'boss';

export type PickupKind = 'spark' | 'emberstone' | 'heart';

export type PowerKind = 'shield' | 'speed' | 'jump' | 'magnet' | 'invincible' | 'doubleJump';

export interface Vec { x: number; y: number }

export interface EnemySpawn { kind: EnemyKind; x: number; y: number; range?: number }
export interface PickupSpawn { kind: PickupKind; x: number; y: number; secret?: boolean }
export interface PowerSpawn { kind: PowerKind; x: number; y: number }

export interface MovingPlatformDef {
  x: number; y: number;
  /** Width in tiles. */
  tiles: number;
  /** Path end, in tiles, relative to the start. */
  dx: number; dy: number;
  speed: number;
  oneWay?: boolean;
  /** A platform that falls away shortly after being stood on. */
  crumble?: boolean;
}

export interface LevelDef {
  id: string;
  world: number;
  index: number;
  name: string;
  /** One line, shown on the level card. Says what this level is *about*. */
  hook: string;
  /** Rows of the ASCII grid. Every row must be the same length. */
  rows: string[];
  platforms?: MovingPlatformDef[];
  /** Tutorial prompts, shown once when the player first reaches an x position. */
  prompts?: { x: number; text: string }[];
  /** Target time in seconds for the third star. */
  parTime: number;
}

export interface Level {
  def: LevelDef;
  map: TileMap;
  spawn: Vec;
  goal: Vec;
  checkpoints: Vec[];
  enemies: EnemySpawn[];
  pickups: PickupSpawn[];
  powers: PowerSpawn[];
  platforms: MovingPlatformDef[];
  /** Pixel bounds. */
  width: number;
  height: number;
  sparkTotal: number;
  emberTotal: number;
}

/**
 * The legend.
 *
 * Deliberately typographic: `#` reads as ground, `=` as a thin platform, `^` as spikes, `~` as
 * liquid. A legend you have to look up is a legend that gets used wrongly.
 */
const TERRAIN: Record<string, number> = {
  ' ': Tile.Empty,
  '.': Tile.Empty,
  '#': Tile.Solid,
  '=': Tile.OneWay,
  '^': Tile.Spike,
  '*': Tile.Crate,
  '~': Tile.Liquid,
  'r': Tile.Rock,
};

const ENEMY_CHARS: Record<string, EnemyKind> = {
  w: 'walker', j: 'jumper', f: 'flyer', c: 'charger',
  s: 'shielded', t: 'turret', h: 'heavy', B: 'boss',
};

const POWER_CHARS: Record<string, PowerKind> = {
  '1': 'shield', '2': 'speed', '3': 'jump', '4': 'magnet', '5': 'invincible', '6': 'doubleJump',
};

export class LevelParseError extends Error {
  constructor(message: string, readonly row: number, readonly col: number) {
    super(`${message} (row ${row + 1}, column ${col + 1})`);
    this.name = 'LevelParseError';
  }
}

export function parseLevel(def: LevelDef): Level {
  const source = def.rows;
  if (source.length === 0) throw new LevelParseError('level has no rows', 0, 0);

  /**
   * Rows are padded to the widest one rather than required to match.
   *
   * Trailing space in a hand-written grid is invisible and impossible to keep consistent, and
   * an editor that trims it turns a whole level into a parse error. Padding with air is always
   * safe: the row that actually matters is the floor, and a floor is written out in full because
   * it is made of visible characters.
   */
  const width = source.reduce((n, r) => Math.max(n, r.length), 0);
  const rows = source.map((r) => r.padEnd(width, ' '));

  const map = new TileMap(width, rows.length);
  let spawn: Vec | null = null;
  let goal: Vec | null = null;
  const checkpoints: Vec[] = [];
  const enemies: EnemySpawn[] = [];
  const pickups: PickupSpawn[] = [];
  const powers: PowerSpawn[] = [];

  /**
   * Two vertical conventions, and they are not interchangeable.
   *
   * Things that *stand* — the spawn, checkpoints, the goal, enemies — are anchored to the
   * bottom of their tile, because that is where their feet go. Things that *float* — sparks,
   * emberstones, power-ups — are anchored to the tile's centre, because they are drawn as a
   * shape around a point.
   *
   * Using the centre for both is the obvious shortcut and it buries the player in the floor: a
   * 36px body centred in a 32px tile hangs four pixels into whatever is underneath, and the
   * level audit correctly refuses to start.
   */
  const px = (tx: number) => tx * TILE + TILE / 2;
  const feet = (ty: number) => (ty + 1) * TILE;
  const py = (ty: number) => ty * TILE + TILE / 2;

  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];

      if (ch in TERRAIN) { map.set(x, y, TERRAIN[ch]); continue; }

      // Everything below is an entity standing in empty space.
      map.set(x, y, Tile.Empty);

      if (ch === 'P') { spawn = { x: px(x), y: feet(y) }; continue; }
      if (ch === 'G') { goal = { x: px(x), y: feet(y) }; continue; }
      if (ch === 'C') { checkpoints.push({ x: px(x), y: feet(y) }); continue; }
      if (ch === 'o') { pickups.push({ kind: 'spark', x: px(x), y: py(y) }); continue; }
      if (ch === 'O') { pickups.push({ kind: 'spark', x: px(x), y: py(y), secret: true }); continue; }
      if (ch === 'E') { pickups.push({ kind: 'emberstone', x: px(x), y: py(y) }); continue; }
      if (ch === 'H') { pickups.push({ kind: 'heart', x: px(x), y: py(y) }); continue; }
      if (ch in ENEMY_CHARS) { enemies.push({ kind: ENEMY_CHARS[ch], x: px(x), y: feet(y) }); continue; }
      if (ch in POWER_CHARS) { powers.push({ kind: POWER_CHARS[ch], x: px(x), y: py(y) }); continue; }

      throw new LevelParseError(`unknown character "${ch}"`, y, x);
    }
  }

  if (!spawn) throw new LevelParseError('level has no spawn point (P)', 0, 0);
  if (!goal) throw new LevelParseError('level has no goal (G)', 0, 0);

  return {
    def,
    map,
    spawn,
    goal,
    checkpoints,
    enemies,
    pickups,
    powers,
    platforms: def.platforms ?? [],
    width: width * TILE,
    height: rows.length * TILE,
    sparkTotal: pickups.filter((p) => p.kind === 'spark').length,
    emberTotal: pickups.filter((p) => p.kind === 'emberstone').length,
  };
}

/** Stars earned, from the three things a level tracks. */
export function starsFor(
  level: Level, sparks: number, embers: number, timeSeconds: number
): number {
  let stars = 1;                                        // finishing at all
  if (level.sparkTotal > 0 && sparks >= Math.ceil(level.sparkTotal * 0.8)) stars++;
  else if (level.sparkTotal === 0) stars++;
  if (timeSeconds <= level.def.parTime) stars++;
  return Math.min(3, stars);
}

export const WORLD_NAMES = [
  'Sunlit Reach',
  'Crystal Deep',
  'Verdant Snarl',
  'Foundry Ash',
  'Sky Ruin',
];

export const WORLD_HOOKS = [
  'Green hills and a long horizon. Learn to run.',
  'Cold caves lit by what you carry.',
  'Everything here grows, and some of it moves.',
  'Machinery that was never switched off.',
  'What is left of the towers, and the wind between them.',
];
