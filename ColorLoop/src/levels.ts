export type Mode = 'endless' | 'campaign';
export type Direction = 0 | 1 | 2 | 3; // East, south, west, north
export const DX = [1, 0, -1, 0];
export const DY = [0, 1, 0, -1];
export const DIRS = [0, 1, 2, 3] as const;
export const reverse = (dir: Direction) => ((dir + 2) % 4) as Direction;

export const WORLDS = [
  { name: 'Jelly Garden', paper: '#fff4df', grid: '#ead9b9', speck: '#e3c388', accent: '#7ad43b' },
  { name: 'Soda Lagoon', paper: '#e9fafc', grid: '#c8ebec', speck: '#93d4de', accent: '#1cc8d9' },
  { name: 'Candy Cosmos', paper: '#f7efff', grid: '#e5d4f6', speck: '#c5abe9', accent: '#aa6cf3' },
] as const;

export const MASCOTS = [
  { name: 'Kiwi Bloom', animal: 'bud', ink: '#5bcf36', light: '#bcef83', dark: '#238b43', accent: '#fd83cb', unlock: 0 },
  { name: 'Bubble Pilot', animal: 'pilot', ink: '#16c5df', light: '#a3ebf1', dark: '#1275bc', accent: '#dec6ff', unlock: 0 },
  { name: 'Jam Ram', animal: 'ram', ink: '#ae65ef', light: '#dfb5fa', dark: '#6540bd', accent: '#ffe544', unlock: 2 },
  { name: 'Toast Rider', animal: 'toast', ink: '#ff952d', light: '#ffd08a', dark: '#bd532c', accent: '#fce26a', unlock: 4 },
  { name: 'Peach Pop', animal: 'pop', ink: '#f25ca4', light: '#ffc0de', dark: '#b42f7a', accent: '#7df8dc', unlock: 7 },
  { name: 'Moon Glider', animal: 'moon', ink: '#5969ef', light: '#bac7ff', dark: '#343090', accent: '#a9f790', unlock: 10 },
  { name: 'Sun Scoop', animal: 'scoop', ink: '#f1b51e', light: '#ffe69d', dark: '#ad6d1c', accent: '#fb7cba', unlock: 12 },
  { name: 'Melon Tank', animal: 'tank', ink: '#18b697', light: '#90e9cf', dark: '#147d72', accent: '#ff9df3', unlock: 15 },
] as const;

export interface Stage {
  name: string; world: number; goal: number; rivals: number; pace: number;
  aggression: number; obstacles: number; width: number; height: number;
}

const NAMES = [
  'First Fold', 'Petal Paths', 'Jelly Steps', 'Sprout Sprint', 'Garden Party',
  'Soda Surf', 'Bubble Bend', 'Blue Fizz', 'Sugar Reef', 'Lagoon Duel',
  'Gumdrop Orbit', 'Comet Cut', 'Star Swirl', 'Nova Rush', 'Cosmic Crown',
];

export const STAGES: Stage[] = NAMES.map((name, i) => ({
  name, world: Math.floor(i / 5), goal: [12, 15, 18, 21, 24, 25, 28, 30, 33, 36, 38, 41, 44, 47, 50][i],
  rivals: Math.min(7, 2 + Math.floor(i / 2)), pace: .66 + i * .025,
  aggression: 4 + Math.floor(i * .6), obstacles: [0, 0, 1, 2, 2, 1, 2, 3, 3, 4, 2, 3, 4, 4, 5][i],
  width: i < 5 ? 51 : 55, height: i < 5 ? 39 : 43,
}));

export function endlessStage(cycle: number): Stage {
  return {
    name: 'Endless', world: cycle % WORLDS.length, goal: 100, width: 55, height: 43,
    rivals: Math.min(7, 5 + cycle), pace: Math.min(.99, .8 + cycle * .035),
    aggression: Math.min(12, 7 + cycle), obstacles: 2 + cycle % 3,
  };
}
