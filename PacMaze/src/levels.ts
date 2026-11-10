export const WIDTH = 28;
export const HEIGHT = 31;
export const DIRECTIONS = [0, 1, 2, 3] as const; // Up, left, down, right (ghost tie order)
export type Direction = typeof DIRECTIONS[number];
export const DX = [0, -1, 0, 1];
export const DY = [-1, 0, 1, 0];
export const opposite = (dir: Direction) => ((dir + 2) % 4) as Direction;
export const cell = (x: number, y: number) => y * WIDTH + x;
export const xOf = (tile: number) => tile % WIDTH;
export const yOf = (tile: number) => Math.floor(tile / WIDTH);
export const TUNNEL = 14;
export const START = cell(13, 23);
export const DOOR = cell(13, 11);
export const HOME = cell(13, 14);
export const FRUIT = cell(13, 17);

const classic = [
  '############################',
  '#............##............#',
  '#.####.#####.##.#####.####.#',
  '#o####.#####.##.#####.####o#',
  '#.####.#####.##.#####.####.#',
  '#..........................#',
  '#.####.##.########.##.####.#',
  '#.####.##.########.##.####.#',
  '#......##....##....##......#',
  '######.#####.##.#####.######',
  '######.#####.##.#####.######',
  '###### ##          ## ######',
  '######.## ###==### ##.######',
  '######.## #hhhhhh# ##.######',
  '      .   #hhhhhh#   .      ',
  '######.## #hhhhhh# ##.######',
  '######.## ######## ##.######',
  '###### ##          ## ######',
  '######.## ######## ##.######',
  '######.## ######## ##.######',
  '#............##............#',
  '#.####.#####.##.#####.####.#',
  '#.####.#####.##.#####.####.#',
  '#o..##.......  .......##..o#',
  '###.##.##.########.##.##.###',
  '###.##.##.########.##.##.###',
  '#......##....##....##......#',
  '#.##########.##.##########.#',
  '#.##########.##.##########.#',
  '#..........................#',
  '############################',
];

export interface Level {
  number: number;
  district: string;
  name: string;
  tiles: string;
  playerSpeed: number;
  ghostSpeed: number;
  frightened: number;
  release: number[];
  scatter: number;
  chase: number;
}

export function walkable(tile: string, house = false) {
  return tile === '.' || tile === 'o' || tile === ' ' || (house && (tile === 'h' || tile === '='));
}

export function neighbor(tiles: string, from: number, dir: Direction, house = false) {
  const y = yOf(from) + DY[dir];
  let x = xOf(from) + DX[dir];
  if (y === TUNNEL) x = (x + WIDTH) % WIDTH;
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return -1;
  const dest = cell(x, y);
  return walkable(tiles[dest], house) ? dest : -1;
}

export function distances(tiles: string, start: number, house = false) {
  const distance = new Int16Array(WIDTH * HEIGHT).fill(-1);
  const queue = [start];
  distance[start] = 0;
  for (let i = 0; i < queue.length; i++) {
    for (const dir of DIRECTIONS) {
      const next = neighbor(tiles, queue[i], dir, house);
      if (next < 0 || distance[next] >= 0) continue;
      distance[next] = distance[queue[i]] + 1;
      queue.push(next);
    }
  }
  return distance;
}

// Each recipe names the junction pairs opened on the west side, east side, or both.
// Three districts introduce different parts of the board before the final ten combine them.
const junctions = [
  [[3, 2], [3, 3], [3, 4]], [[9, 2], [9, 3], [9, 4]],
  [[4, 6], [4, 7]], [[7, 8], [8, 8]], [[10, 9], [10, 10]],
  [[3, 21], [3, 22]], [[9, 21], [9, 22]], [[7, 26], [8, 26]],
  [[3, 27], [3, 28]], [[10, 27], [10, 28]],
] as const;
const recipes = [
  ['Cabinet One', '', ''], ['First Cut', '0', ''], ['Cross Street', '1', '1'],
  ['Corner Store', '2', '0'], ['Blue Avenue', '03', '2'], ['Side Step', '14', '0'],
  ['Top Shelf', '012', '1'], ['Pinwheel', '24', '03'], ['Upper Circuit', '013', '124'], ['Midnight Loop', '024', '134'],
  ['South Gate', '5', ''], ['Lower Deck', '6', '5'], ['Twin Bridges', '57', '57'],
  ['Market Run', '68', '5'], ['Back Alley', '59', '68'], ['Long Way Home', '567', '8'],
  ['Turntable', '78', '569'], ['Basement Beat', '689', '57'], ['Double Down', '568', '679'], ['Southern Circuit', '5679', '578'],
  ['Cherry Crossing', '05', '08'], ['Peach Street', '16', '17'], ['Apple Arcade', '27', '25'],
  ['Grape Grid', '38', '36'], ['Melon Mile', '49', '47'], ['Fruit Stand', '056', '189'],
  ['Cherry Rush', '127', '048'], ['Harvest Loop', '238', '156'], ['Market Lights', '349', '267'], ['Closing Bell', '0458', '1379'],
  ['Final Approach', '01259', '03468'], ['Blackout', '02367', '12489'], ['Dead Heat', '01389', '24567'],
  ['Head Start', '14567', '02389'], ['Neon Chase', '024579', '013568'], ['Double Trouble', '013568', '024579'],
  ['Hot Pursuit', '123689', '024567'], ['Last Light', '014578', '123679'], ['One More Turn', '0234568', '0125789'], ['High Score Hall', '01345679', '01246789'],
] as const;

function makeLevel(name: string, west: string, east: string, index: number): Level {
  const tiles = classic.join('').split('');
  for (const [side, layout] of [west, east].entries()) {
    for (const id of layout) {
      for (const [x, y] of junctions[Number(id)]) {
        tiles[cell(side ? WIDTH - 1 - x : x, y)] = '.';
      }
    }
  }
  return {
    number: index + 1, name, tiles: tiles.join(''),
    district: ['Blue Line', 'Southside', 'Fruit Market', 'High Score Hall'][Math.floor(index / 10)],
    playerSpeed: 7.55 + 0.014 * index,
    ghostSpeed: 6.35 + 0.044 * index,
    frightened: 6.4 - 0.107 * index,
    release: [0, 0.8, Math.max(2.2, 4.8 - index * 0.055), Math.max(3.6, 8.8 - index * 0.11)],
    scatter: 7 - index * 0.09,
    chase: 19 + index * 0.3,
  };
}

export const LEVELS = recipes.map(([name, west, east], i) => makeLevel(name, west, east, i));
