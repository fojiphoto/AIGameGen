/**
 * Genre: sliding_puzzle — slide tiles back into order.
 *
 * Solvability is guaranteed by CONSTRUCTION, not by checking: levels are built by
 * walking N legal moves backwards from the solved board, so the solution is simply that
 * walk reversed. This sidesteps the permutation-parity test entirely and means an
 * unsolvable board cannot be generated even in principle.
 */

import { z } from 'zod';
import { MetaSchema, ThemeSchema, checkLadder, ProgressionSchema, CopySchema, CURVE_SHAPES } from '../index.mjs';

export const GENRE_ID = 'sliding_puzzle';

export const BoardSchema = z.object({
  /** 3 = 8-puzzle, 4 = 15-puzzle. Grows over the 20 levels. */
  sizeStart: z.number().int().min(3).max(5).default(3),
  sizeEnd: z.number().int().min(3).max(5).default(4),
  /** Numbered tiles vs a sliced picture. Pictures are built from the palette. */
  faceStyle: z.enum(['numbers', 'blocks']).default('numbers'),
});

export const DifficultySchema = z.object({
  curve: z.enum(CURVE_SHAPES).default('easeInQuad'),
  /** How many legal moves to scramble by. Also the optimal-solution upper bound. */
  scrambleStart: z.number().int().min(3).max(40).default(8),
  scrambleEnd: z.number().int().min(20).max(160).default(90),
  /**
   * Move budget as a multiple of the scramble depth. Must stay above 1.0 or a level can
   * be mathematically solvable yet unwinnable inside the limit.
   */
  moveSlackStart: z.number().min(1.5).max(6).default(3.5),
  moveSlackEnd: z.number().min(1.15).max(3).default(1.6),
});

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
    const b = cfg.board;
    const d = cfg.difficulty;
    if (b.sizeEnd < b.sizeStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['board', 'sizeEnd'], message: 'sizeEnd cannot be smaller than sizeStart' });
    }
    if (d.scrambleEnd <= d.scrambleStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'scrambleEnd'], message: 'scrambleEnd must exceed scrambleStart' });
    }
    if (d.moveSlackEnd >= d.moveSlackStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'moveSlackEnd'], message: 'moveSlackEnd must be tighter (smaller) than moveSlackStart' });
    }
    if (d.moveSlackEnd <= 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'moveSlackEnd'], message: 'a move budget below 1x the scramble depth can make a solvable board unwinnable' });
    }
  });

export const CLAMP_RANGES = {
  'board.sizeStart': [3, 5], 'board.sizeEnd': [3, 5],
  'difficulty.scrambleStart': [3, 40], 'difficulty.scrambleEnd': [20, 160],
  'difficulty.moveSlackStart': [1.5, 6], 'difficulty.moveSlackEnd': [1.15, 3],
};

export function repair(out) {
  const b = out.board;
  const d = out.difficulty;
  if (b && b.sizeEnd < b.sizeStart) b.sizeEnd = b.sizeStart;
  if (d) {
    if (d.scrambleEnd <= d.scrambleStart) d.scrambleEnd = Math.min(160, d.scrambleStart + 40);
    if (d.moveSlackEnd >= d.moveSlackStart) d.moveSlackStart = Math.min(6, d.moveSlackEnd + 1.2);
    if (d.moveSlackEnd <= 1) d.moveSlackEnd = 1.15;
  }
  return out;
}

const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description });
const int = (min, max, description) => ({ type: 'integer', minimum: min, maximum: max, description });

export const TOOL_FIELDS = {
  board: {
    type: 'object', additionalProperties: false,
    required: ['sizeStart', 'sizeEnd', 'faceStyle'],
    properties: {
      sizeStart: int(3, 5, 'Grid size on level 1. 3 means a 3x3 (8 tiles). Start at 3.'),
      sizeEnd: int(3, 5, 'Grid size on level 20. 4 means a 4x4 (15 tiles). 5 is very demanding.'),
      faceStyle: { type: 'string', enum: ['numbers', 'blocks'], description: 'numbers is readable and universal; blocks slices a palette-coloured picture.' },
    },
  },
  difficulty: {
    type: 'object', additionalProperties: false,
    required: ['curve', 'scrambleStart', 'scrambleEnd', 'moveSlackStart', 'moveSlackEnd'],
    properties: {
      curve: { type: 'string', enum: CURVE_SHAPES, description: 'easeInQuad recommended.' },
      scrambleStart: int(3, 40, 'Legal moves used to scramble level 1. 8 is a gentle few-move puzzle.'),
      scrambleEnd: int(20, 160, 'Scramble depth on level 20. 90 default. Must exceed scrambleStart.'),
      moveSlackStart: num(1.5, 6, 'Level 1 move budget as a multiple of scramble depth. 3.5 = forgiving.'),
      moveSlackEnd: num(1.15, 3, 'Level 20 budget. Must stay above 1.0 or a solvable board becomes unwinnable.'),
    },
  },
};

export const DEFAULT_TAGLINE = 'slide it back into order · 20 levels';
