/**
 * Genre registry — the plug-in point for game templates.
 *
 * Adding a genre means adding ONE entry here plus three files:
 *   packages/schema/src/genres/<id>.mjs        config schema + AI tool fields
 *   packages/generation/src/genres/<id>.mjs    level builder + validator
 *   packages/engine-runner/src/genres/<id>.mjs Phaser scene + textures
 *
 * IMPORTANT — import direction. This module imports `../index.mjs`, never the reverse.
 * The genre modules build their schemas from shared pieces (MetaSchema, ThemeSchema…) at
 * module-evaluation time, so if `../index.mjs` imported this file the cycle would hit
 * those consts before they were initialised and throw. Consumers import
 * `@forge/schema/genres`; `@forge/schema` stays cycle-free.
 */

import {
  GameConfigSchema as RunnerConfigSchema,
  clampNumbers as clampRunner,
  safeParseGameConfig as safeParseRunner,
} from '../index.mjs';
import { EMIT_CONFIG_TOOL as RUNNER_TOOL } from '../toolSchema.mjs';

import * as tapToFly from './tapToFly.mjs';
import * as memoryMatch from './memoryMatch.mjs';
import * as slidingPuzzle from './slidingPuzzle.mjs';
import * as merge2048 from './merge2048.mjs';
import * as snake from './snake.mjs';
import * as rhythmDash from './rhythmDash.mjs';

/** Clamp every numeric knob into its declared range instead of rejecting the config. */
export function clampByRanges(raw, ranges) {
  const out = structuredClone(raw);
  for (const [path, [lo, hi]] of Object.entries(ranges)) {
    const parts = path.split('.');
    let node = out;
    for (const seg of parts.slice(0, -1)) {
      if (node == null) break;
      node = node[seg];
    }
    const key = parts.at(-1);
    if (node && typeof node[key] === 'number' && Number.isFinite(node[key])) {
      node[key] = Math.min(hi, Math.max(lo, node[key]));
    }
  }
  return out;
}

function makeEntry(mod, { label, family, blurb }) {
  return {
    id: mod.GENRE_ID,
    label,
    family,
    blurb,
    configSchema: mod.ConfigSchema,
    toolFields: mod.TOOL_FIELDS,
    defaultTagline: mod.DEFAULT_TAGLINE,
    clamp: (raw) => mod.repair(clampByRanges(raw, mod.CLAMP_RANGES)),
    safeParse(input) {
      const r = mod.ConfigSchema.safeParse(input);
      if (r.success) return { ok: true, config: r.data };
      return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
    },
  };
}

export const GENRE_REGISTRY = {
  /**
   * endless_runner predates the registry and keeps its original schema untouched, so the
   * shipped, tested genre cannot regress while the others are added around it.
   */
  endless_runner: {
    id: 'endless_runner',
    label: 'Endless Runner',
    family: 'arcade',
    blurb: 'Auto-run, jump the obstacles, survive further each level.',
    configSchema: RunnerConfigSchema,
    toolFields: RUNNER_TOOL.input_schema.properties,
    defaultTagline: 'run further every level · 20 levels · endless mode',
    clamp: clampRunner,
    safeParse: safeParseRunner,
  },

  [tapToFly.GENRE_ID]: makeEntry(tapToFly, {
    label: 'Tap-to-Fly',
    family: 'arcade',
    blurb: 'Tap to flap, thread the gaps, do not touch anything.',
  }),
  [memoryMatch.GENRE_ID]: makeEntry(memoryMatch, {
    label: 'Memory Match',
    family: 'board',
    blurb: 'Flip cards and find every pair before the clock runs out.',
  }),
  [slidingPuzzle.GENRE_ID]: makeEntry(slidingPuzzle, {
    label: 'Sliding Puzzle',
    family: 'board',
    blurb: 'Slide the tiles back into order within a move budget.',
  }),
  [merge2048.GENRE_ID]: makeEntry(merge2048, {
    label: '2048 Merge',
    family: 'board',
    blurb: 'Swipe to merge matching tiles and reach the target number.',
  }),
  [snake.GENRE_ID]: makeEntry(snake, {
    label: 'Snake',
    family: 'arcade',
    blurb: 'Eat to grow, and never run into a wall or your own tail.',
  }),
  [rhythmDash.GENRE_ID]: makeEntry(rhythmDash, {
    label: 'Rhythm Dash',
    family: 'reflex',
    blurb: 'One tap, one life. Memorise the layout, no menus between attempts.',
  }),
};

/** Ids that are fully implemented end to end (schema + generation + engine scene). */
export const IMPLEMENTED_GENRES = Object.keys(GENRE_REGISTRY);

/** Genres named in the design doc but not built yet — shown as "coming soon" in the UI. */
export const PLANNED_GENRES = [
  { id: 'platformer', label: 'Platformer', family: 'platform' },
  { id: 'match3', label: 'Match-3 Puzzle', family: 'board' },
  { id: 'brick_breaker', label: 'Brick Breaker', family: 'arcade' },
  { id: 'maze_escape', label: 'Maze Escape', family: 'puzzle' },
];

/** Genres that skip the level-select menu and drop straight into play. */
export const SKIP_MENU_GENRES = new Set(['rhythm_dash']);

export const getGenre = (id) => GENRE_REGISTRY[id] ?? null;
export const isImplemented = (id) => Boolean(GENRE_REGISTRY[id]);

/** Catalogue for the studio genre picker and the landing page. */
export const genreCatalogue = () => [
  ...Object.values(GENRE_REGISTRY).map((g) => ({
    id: g.id, label: g.label, family: g.family, blurb: g.blurb, live: true,
  })),
  ...PLANNED_GENRES.map((g) => ({ ...g, blurb: null, live: false })),
];

/**
 * Validate any genre's config, dispatching on the discriminator.
 * Returns the same `{ok, config} | {ok, errors}` shape every genre uses.
 */
export function safeParseAnyConfig(input) {
  const genre = input?.genre;
  const entry = getGenre(genre);
  if (!entry) {
    return { ok: false, errors: [`genre: "${genre}" is not an implemented genre`] };
  }
  return entry.safeParse(input);
}

export function clampAnyConfig(raw) {
  const entry = getGenre(raw?.genre);
  return entry ? entry.clamp(raw) : raw;
}
