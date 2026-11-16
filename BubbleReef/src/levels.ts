export const HEIGHT = 632;
export const DIAMETER = 34;
export const RADIUS = 16;
export const GAP = Math.sqrt(3) * DIAMETER / 2;
export const MAX_ROWS = 18;
export const LIMIT = 500;
export const ANGLE_LIMIT = 76 * Math.PI / 180;

function makeGrid(columns: number) {
  const width = columns * DIAMETER;
  const origin = { x: width / 2, y: 557 };
  const rowsize = (row: number, stagger = 0) => columns - (row + stagger) % 2;
  const slot = (row: number, col: number) => row * columns + col;
  const rowOf = (cell: number) => Math.floor(cell / columns);
  const colOf = (cell: number) => cell % columns;
  const coords = (cell: number, drop = 0, stagger = 0) => ({
    x: DIAMETER * (colOf(cell) + .5 + (rowOf(cell) + stagger) % 2 * .5), y: 24 + drop + GAP * rowOf(cell),
  });
  const neighborTables = [0, 1].map(stagger => Array.from({ length: MAX_ROWS * columns }, (_, i) => {
    const row = rowOf(i), col = colOf(i), left = col - ((row + stagger) % 2 === 0 ? 1 : 0);
    return [[row, col - 1], [row, col + 1], [row - 1, left], [row - 1, left + 1], [row + 1, left], [row + 1, left + 1]]
      .filter(([r, c]) => r >= 0 && r < MAX_ROWS && c >= 0 && c < rowsize(r, stagger)).map(([r, c]) => slot(r, c));
  }));
  const links = (cell: number, stagger = 0) => neighborTables[stagger][cell];
  return { columns, width, origin, rowsize, slot, rowOf, coords, links };
}

export type Grid = ReturnType<typeof makeGrid>;
export const PORTRAIT = makeGrid(11);
export const WIDE = makeGrid(17);
export const { width: WIDTH, columns: COLS, rowsize, slot, coords } = PORTRAIT;
export const neighbors = Array.from({ length: MAX_ROWS * COLS }, (_, cell) => PORTRAIT.links(cell));

export const PALETTE = [
  { name: 'Coral', hi: '#fff0b0', mid: '#ff411d', low: '#a10b35', mark: 'heart' },
  { name: 'Lagoon', hi: '#ddffff', mid: '#159bea', low: '#1445a7', mark: 'wave' },
  { name: 'Mango', hi: '#ffffcd', mid: '#ffc321', low: '#d77608', mark: 'sun' },
  { name: 'Orchid', hi: '#ffdeff', mid: '#cd32f1', low: '#7226aa', mark: 'diamond' },
  { name: 'Kelp', hi: '#efffbc', mid: '#73da42', low: '#26904a', mark: 'leaf' },
  { name: 'Cobalt', hi: '#e3dfff', mid: '#6d63fa', low: '#332392', mark: 'ring' },
] as const;

export const CHAPTERS = [
  ['Glasswater Cove', '#164f70', '#0a2340', '#62eee6'],
  ['Sunlit Shelf', '#1e746c', '#0d3a4b', '#b3f3a1'],
  ['Coral Arcade', '#73436d', '#352649', '#ffb1a0'],
  ['Saffron Tides', '#365d75', '#1d304e', '#ffd27a'],
  ['Blue Grotto', '#304f97', '#171d4b', '#7ebfff'],
  ['Jelly Drift', '#56398d', '#1c194f', '#e1b0ff'],
  ['Lantern Kelp', '#275d54', '#102b37', '#aee28e'],
  ['Opal Trench', '#413881', '#151e43', '#bec7ff'],
  ['Moonpool', '#30426c', '#15192f', '#8dffed'],
  ['Pearl Abyss', '#37365f', '#16132e', '#ffc9ed'],
] as const;

export interface Level { number: number; chapter: number; depth: number; colors: number; tension: number; board: Int8Array; seed: number }
export function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function silhouette(pattern: number, row: number, col: number, depth: number, grid: Grid) {
  if (row === 0) return true;
  const span = grid.rowsize(row), x = (col + row % 2 * .5) * (COLS - 1) / (grid.columns - 1), middle = Math.abs(x - 5);
  switch (pattern) {
    case 0: return middle <= 5.1 - Math.max(0, row - depth + 4) * .95;
    case 1: return row < 2 || middle >= .55 + row * .14;
    case 2: return row < 2 || Math.abs(x - (row % 4 < 2 ? 4 : 6)) <= 3.3;
    case 3: return row < 2 || (col >= Math.floor(row / 3) && col < span - Math.floor(row / 4));
    case 4: return row < depth - 2 || middle > 1.3;
    case 5: return row < 2 || ((col + 1) % 4 !== 0 || row % 3 === 0);
    case 6: return row < 3 || middle <= 2.5 || (row < depth - 1 && middle >= 4.2);
    case 7: return row < 3 || Math.abs(x - 2.1) < 1.75 || Math.abs(x - 7.8) < 1.75;
    case 8: return row < 3 || x <= 4 + Math.sin(row * .85) * 2.5 || x >= 8.1;
    default: return row < depth - 3 || (Math.floor(x / 2.2) + row) % 3 !== 0;
  }
}

export function connected(board: Int8Array, stagger = 0, grid = PORTRAIT) {
  const seen = new Uint8Array(board.length), queue: number[] = [];
  for (let col = 0; col < grid.rowsize(0, stagger); col++) if (board[col]) { queue.push(col); seen[col] = 1; }
  for (let i = 0; i < queue.length; i++) for (const dest of grid.links(queue[i], stagger)) {
    if (seen[dest] || !board[dest]) continue;
    queue.push(dest);
    seen[dest] = 1;
  }
  return seen;
}

export function makeLevel(index: number, grid = PORTRAIT): Level {
  const chapter = Math.floor(index / 10);
  const depth = index === 0 ? 4 : 5 + Math.floor(chapter * .65) + Number(index % 5 > 2);
  const colors = index === 0 ? 3 : Math.min(6, 3 + Math.floor((chapter + 1) / 2));
  const seed = 13137 + index * 8731;
  const draw = rng(seed);
  const board = new Int8Array(MAX_ROWS * grid.columns);
  for (let row = 0; row < depth; row++) for (let col = 0; col < grid.rowsize(row); col++) {
    if (!silhouette((index + chapter * 3) % 10, row, col, depth, grid)) continue;
    const cell = grid.slot(row, col);
    const stripe = 1 + (Math.floor((col + Math.floor(row / 2)) / 2.7) + Math.floor(row / 3) + index) % colors;
    const adjacent = grid.links(cell).filter(i => board[i]);
    const value = draw();
    board[cell] = index === 0 || value < .44 ? stripe : value < .84 && adjacent.length ? board[adjacent[Math.floor(draw() * adjacent.length)]] : 1 + Math.floor(draw() * colors);
  }
  const anchored = connected(board, 0, grid);
  for (let i = 0; i < board.length; i++) if (!anchored[i]) board[i] = 0;
  return { number: index + 1, chapter, depth, colors, tension: Math.max(4, 7 - Math.floor(chapter / 3)), board, seed };
}

export const LEVELS = Array.from({ length: 100 }, (_, i) => makeLevel(i));
export const WIDE_LEVELS = Array.from({ length: LEVELS.length }, (_, i) => makeLevel(i, WIDE));
