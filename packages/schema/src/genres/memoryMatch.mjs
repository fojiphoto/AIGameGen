/**
 * Genre: memory_match — flip cards, find pairs before the timer runs out.
 *
 * The validator's job here is arithmetic rather than physics: the grid must hold an even
 * number of cards, the pair count must fit, and the time limit must be achievable by a
 * player with perfect memory (which is the only lower bound that means anything).
 */

import { z } from 'zod';
import { MetaSchema, ThemeSchema, checkLadder, ProgressionSchema, CopySchema, CURVE_SHAPES } from '../index.mjs';

export const GENRE_ID = 'memory_match';

export const BoardSchema = z.object({
  /** Card grid on level 1. Grows with the difficulty curve. */
  colsStart: z.number().int().min(2).max(6).default(3),
  rowsStart: z.number().int().min(2).max(5).default(2),
  colsEnd: z.number().int().min(3).max(8).default(6),
  rowsEnd: z.number().int().min(2).max(6).default(5),
  /** Distinct card faces available. Must be >= the largest pair count. */
  faceCount: z.number().int().min(8).max(24).default(24),
});

export const RulesSchema = z.object({
  /** Seconds a mismatched pair stays visible before flipping back. */
  flipBackMs: z.number().int().min(300).max(1600).default(700),
  /** Free look at the whole board before the level starts. */
  peekSeconds: z.number().min(0).max(5).default(2),
  /** Seconds removed from the clock on a mismatch. 0 = no penalty. */
  mismatchPenalty: z.number().min(0).max(6).default(0),
});

export const DifficultySchema = z.object({
  curve: z.enum(CURVE_SHAPES).default('linear'),
  /** Seconds allowed, as a multiple of the perfect-play lower bound. */
  timeSlackStart: z.number().min(1.6).max(6).default(3.4),
  timeSlackEnd: z.number().min(1.15).max(3).default(1.7),
});

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    genre: z.literal(GENRE_ID),
    meta: MetaSchema,
    theme: ThemeSchema,
    board: BoardSchema,
    rules: RulesSchema,
    difficulty: DifficultySchema,
    progression: ProgressionSchema,
    copy: CopySchema,
  })
  .superRefine((cfg, ctx) => {
    checkLadder(cfg, ctx);
    const b = cfg.board;
    for (const [label, cols, rows] of [['start', b.colsStart, b.rowsStart], ['end', b.colsEnd, b.rowsEnd]]) {
      if ((cols * rows) % 2 !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['board', label === 'start' ? 'colsStart' : 'colsEnd'],
          message: `${label} grid ${cols}x${rows} = ${cols * rows} cards is odd — every card needs a partner`,
        });
      }
    }
    if (b.colsEnd * b.rowsEnd <= b.colsStart * b.rowsStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['board', 'colsEnd'], message: 'the level-20 grid must be larger than the level-1 grid' });
    }
    if (b.faceCount < (b.colsEnd * b.rowsEnd) / 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['board', 'faceCount'],
        message: `faceCount ${b.faceCount} cannot fill ${(b.colsEnd * b.rowsEnd) / 2} pairs on the largest grid`,
      });
    }
    if (cfg.difficulty.timeSlackEnd >= cfg.difficulty.timeSlackStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'timeSlackEnd'], message: 'timeSlackEnd must be tighter (smaller) than timeSlackStart' });
    }
  });

export const CLAMP_RANGES = {
  'board.colsStart': [2, 6], 'board.rowsStart': [2, 5],
  'board.colsEnd': [3, 8], 'board.rowsEnd': [2, 6],
  'board.faceCount': [8, 24],
  'rules.flipBackMs': [300, 1600],
  'rules.peekSeconds': [0, 5],
  'rules.mismatchPenalty': [0, 6],
  'difficulty.timeSlackStart': [1.6, 6],
  'difficulty.timeSlackEnd': [1.15, 3],
};

export function repair(out) {
  const b = out.board;
  if (!b) return out;
  // an odd grid is unsolvable by construction — grow a column rather than reject
  const fix = (colsKey, rowsKey, maxCols) => {
    if ((b[colsKey] * b[rowsKey]) % 2 !== 0) {
      b[colsKey] = Math.min(maxCols, b[colsKey] + 1);
      if ((b[colsKey] * b[rowsKey]) % 2 !== 0) b[colsKey] = Math.max(2, b[colsKey] - 2);
    }
  };
  fix('colsStart', 'rowsStart', 6);
  fix('colsEnd', 'rowsEnd', 8);
  if (b.colsEnd * b.rowsEnd <= b.colsStart * b.rowsStart) {
    b.colsEnd = Math.min(8, b.colsStart + 2);
    b.rowsEnd = Math.min(6, Math.max(b.rowsStart, b.rowsEnd));
    fix('colsEnd', 'rowsEnd', 8);
  }
  b.faceCount = Math.max(b.faceCount, Math.ceil((b.colsEnd * b.rowsEnd) / 2));
  b.faceCount = Math.min(24, b.faceCount);
  const d = out.difficulty;
  if (d && d.timeSlackEnd >= d.timeSlackStart) d.timeSlackStart = Math.min(6, d.timeSlackEnd + 1.2);
  return out;
}

const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description });
const int = (min, max, description) => ({ type: 'integer', minimum: min, maximum: max, description });

export const TOOL_FIELDS = {
  board: {
    type: 'object', additionalProperties: false,
    required: ['colsStart', 'rowsStart', 'colsEnd', 'rowsEnd', 'faceCount'],
    description: 'Card grid. cols x rows MUST be even on both the start and end grid — every card needs a partner.',
    properties: {
      colsStart: int(2, 6, 'Columns on level 1. 3 default.'),
      rowsStart: int(2, 5, 'Rows on level 1. 2 default (a gentle 3x2 = 3 pairs).'),
      colsEnd: int(3, 8, 'Columns on level 20. 6 default.'),
      rowsEnd: int(2, 6, 'Rows on level 20. 5 default (6x5 = 15 pairs).'),
      faceCount: int(8, 24, 'Distinct card symbols available. Must be at least (colsEnd x rowsEnd) / 2.'),
    },
  },
  rules: {
    type: 'object', additionalProperties: false,
    required: ['flipBackMs', 'peekSeconds', 'mismatchPenalty'],
    properties: {
      flipBackMs: int(300, 1600, 'How long a wrong pair stays visible. 700 default; below 450 is punishing.'),
      peekSeconds: num(0, 5, 'Free look at the board before the clock starts. 2 default.'),
      mismatchPenalty: num(0, 6, 'Seconds lost per mismatch. Keep 0 unless the prompt asks for a harsh game.'),
    },
  },
  difficulty: {
    type: 'object', additionalProperties: false,
    required: ['curve', 'timeSlackStart', 'timeSlackEnd'],
    properties: {
      curve: { type: 'string', enum: CURVE_SHAPES, description: 'linear works well for this genre.' },
      timeSlackStart: num(1.6, 6, 'Level 1 time budget as a multiple of perfect play. 3.4 = very generous.'),
      timeSlackEnd: num(1.15, 3, 'Level 20 budget. 1.7 default. Below 1.3 demands near-perfect memory.'),
    },
  },
};

export const DEFAULT_TAGLINE = 'find every pair · 20 levels';
