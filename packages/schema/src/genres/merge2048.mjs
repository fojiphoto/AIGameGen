/**
 * Genre: merge_2048 — swipe to merge equal tiles, reach the target.
 *
 * The interesting constraint is a ceiling: a 4x4 board physically cannot hold enough
 * tiles to build past a certain power of two. Letting the AI ask for 8192 on a 3x3 board
 * would produce a level nobody can finish, so the validator computes the theoretical
 * maximum for the board size and refuses targets above it.
 */

import { z } from 'zod';
import { MetaSchema, ThemeSchema, checkLadder, ProgressionSchema, CopySchema, CURVE_SHAPES } from '../index.mjs';

export const GENRE_ID = 'merge_2048';

/**
 * Largest tile a board of `cells` cells can realistically reach.
 * A board can hold at most one tile per cell; building 2^n needs a chain, and empirically
 * the practical ceiling sits around 2^(cells-1) with a safety margin. Kept conservative
 * on purpose — an impossible target is a much worse bug than a slightly easy one.
 */
export function maxReachableTile(cells) {
  return 2 ** Math.max(2, Math.min(17, cells - 3));
}

export const BoardSchema = z.object({
  size: z.number().int().min(3).max(6).default(4),
  /** Chance a spawned tile is a 4 rather than a 2. Higher = faster but less controllable. */
  spawnFourChance: z.number().min(0).max(0.4).default(0.1),
});

export const DifficultySchema = z.object({
  curve: z.enum(CURVE_SHAPES).default('easeInQuad'),
  /** Target tile on level 1 and level 20. Both must be powers of two. */
  targetStart: z.number().int().min(8).max(256).default(32),
  targetEnd: z.number().int().min(64).max(8192).default(1024),
  /** 0 = unlimited moves (recommended); otherwise a budget multiple of the estimate. */
  moveSlackStart: z.number().min(0).max(8).default(0),
  moveSlackEnd: z.number().min(0).max(8).default(0),
});

const isPow2 = (n) => Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    genre: z.literal(GENRE_ID),
    meta: MetaSchema,
    theme: ThemeSchema,
    board: BoardSchema,
    difficulty: DifficultySchema,
    progression: ProgressionSchema,
    copy: CopySchema,
  })
  .superRefine((cfg, ctx) => {
    checkLadder(cfg, ctx);
    const d = cfg.difficulty;
    const cap = maxReachableTile(cfg.board.size * cfg.board.size);
    for (const key of ['targetStart', 'targetEnd']) {
      if (!isPow2(d[key])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', key], message: `${key} must be a power of two` });
      }
      if (d[key] > cap) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['difficulty', key],
          message: `${key} ${d[key]} is unreachable on a ${cfg.board.size}x${cfg.board.size} board (max ${cap})`,
        });
      }
    }
    if (d.targetEnd <= d.targetStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'targetEnd'], message: 'targetEnd must exceed targetStart' });
    }
  });

export const CLAMP_RANGES = {
  'board.size': [3, 6],
  'board.spawnFourChance': [0, 0.4],
  'difficulty.targetStart': [8, 256],
  'difficulty.targetEnd': [64, 8192],
  'difficulty.moveSlackStart': [0, 8],
  'difficulty.moveSlackEnd': [0, 8],
};

const floorPow2 = (n) => 2 ** Math.floor(Math.log2(Math.max(2, n)));

export function repair(out) {
  const d = out.difficulty;
  const b = out.board;
  if (!d || !b) return out;
  const cap = maxReachableTile(b.size * b.size);
  d.targetStart = Math.min(floorPow2(d.targetStart), cap);
  d.targetEnd = Math.min(floorPow2(d.targetEnd), cap);
  if (d.targetEnd <= d.targetStart) {
    d.targetStart = Math.max(8, d.targetEnd / 2);
    if (d.targetEnd <= d.targetStart) {
      // board is too small for any ramp — grow it rather than ship a flat game
      b.size = Math.min(6, b.size + 1);
      const grown = maxReachableTile(b.size * b.size);
      d.targetEnd = Math.min(floorPow2(d.targetStart * 4), grown);
    }
  }
  return out;
}

const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description });
const int = (min, max, description) => ({ type: 'integer', minimum: min, maximum: max, description });

export const TOOL_FIELDS = {
  board: {
    type: 'object', additionalProperties: false,
    required: ['size', 'spawnFourChance'],
    properties: {
      size: int(3, 6, 'Grid size. 4 is the familiar 4x4; 3 is much harder because there is no room to manoeuvre.'),
      spawnFourChance: num(0, 0.4, 'Probability a new tile is a 4. 0.1 default; high values make the board fill faster.'),
    },
  },
  difficulty: {
    type: 'object', additionalProperties: false,
    required: ['curve', 'targetStart', 'targetEnd', 'moveSlackStart', 'moveSlackEnd'],
    properties: {
      curve: { type: 'string', enum: CURVE_SHAPES, description: 'easeInQuad recommended.' },
      targetStart: int(8, 256, 'Tile to reach on level 1. MUST be a power of two. 32 is a friendly opener.'),
      targetEnd: int(64, 8192, 'Tile to reach on level 20. MUST be a power of two, must exceed targetStart, and must be reachable on the chosen board size (a 4x4 caps around 8192, a 3x3 around 64).'),
      moveSlackStart: num(0, 8, 'Use 0 for unlimited moves — strongly recommended for this genre.'),
      moveSlackEnd: num(0, 8, 'Use 0 for unlimited moves.'),
    },
  },
};

export const DEFAULT_TAGLINE = 'merge to the target · 20 levels';
