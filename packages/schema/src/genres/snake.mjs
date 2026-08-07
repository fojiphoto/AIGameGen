/**
 * Genre: snake — grow by eating, never hit yourself or a wall.
 *
 * The validator's real job is the endgame: as the snake grows it fills the board, and a
 * food target that exceeds the free cells makes a level literally impossible to finish.
 * It also guards the step rate, because below roughly 60 ms/step no human can react.
 */

import { z } from 'zod';
import { MetaSchema, ThemeSchema, checkLadder, ProgressionSchema, CopySchema, CURVE_SHAPES } from '../index.mjs';

export const GENRE_ID = 'snake';

export const BoardSchema = z.object({
  cols: z.number().int().min(10).max(30).default(20),
  rows: z.number().int().min(8).max(20).default(13),
  /** Walk off one edge and reappear on the other. Much friendlier. */
  wrapEdges: z.boolean().default(false),
});

export const DifficultySchema = z.object({
  curve: z.enum(CURVE_SHAPES).default('easeInQuad'),
  /** Milliseconds per step. LOWER is faster. 60 is the human reaction floor. */
  stepMsStart: z.number().int().min(90).max(320).default(190),
  stepMsEnd: z.number().int().min(60).max(160).default(90),
  /** Food to eat to clear the level. */
  foodStart: z.number().int().min(3).max(20).default(5),
  growth: z.number().min(1.02).max(1.3).default(1.13),
  /** Interior wall blocks, which grow over the 20 levels. */
  wallsStart: z.number().int().min(0).max(20).default(0),
  wallsEnd: z.number().int().min(0).max(60).default(18),
  /** Segments gained per food. */
  growPerFood: z.number().int().min(1).max(4).default(2),
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
    const d = cfg.difficulty;
    const cells = cfg.board.cols * cfg.board.rows;
    if (d.stepMsEnd >= d.stepMsStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'stepMsEnd'], message: 'stepMsEnd must be smaller than stepMsStart (the snake speeds up)' });
    }
    if (d.wallsEnd < d.wallsStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'wallsEnd'], message: 'wallsEnd cannot be below wallsStart' });
    }
    // Worst case: the final level's food target, fully grown, plus walls, must still fit.
    const finalFood = Math.round(d.foodStart * d.growth ** 19);
    const needed = 3 + finalFood * d.growPerFood + d.wallsEnd;
    if (needed > cells * 0.7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['difficulty', 'foodStart'],
        message: `level 20 would need ~${needed} of ${cells} cells (snake + walls); keep it under ${Math.floor(cells * 0.7)} — lower foodStart, growth, growPerFood or wallsEnd, or enlarge the board`,
      });
    }
  });

export const CLAMP_RANGES = {
  'board.cols': [10, 30], 'board.rows': [8, 20],
  'difficulty.stepMsStart': [90, 320], 'difficulty.stepMsEnd': [60, 160],
  'difficulty.foodStart': [3, 20], 'difficulty.growth': [1.02, 1.3],
  'difficulty.wallsStart': [0, 20], 'difficulty.wallsEnd': [0, 60],
  'difficulty.growPerFood': [1, 4],
};

export function repair(out) {
  const d = out.difficulty;
  const b = out.board;
  if (!d || !b) return out;
  if (d.stepMsEnd >= d.stepMsStart) d.stepMsStart = Math.min(320, d.stepMsEnd + 80);
  if (d.wallsEnd < d.wallsStart) d.wallsEnd = d.wallsStart;

  // Shrink the endgame until it fits the board rather than shipping an unfinishable level.
  let guard = 0;
  while (guard++ < 40) {
    const cells = b.cols * b.rows;
    const finalFood = Math.round(d.foodStart * d.growth ** 19);
    const needed = 3 + finalFood * d.growPerFood + d.wallsEnd;
    if (needed <= cells * 0.7) break;
    if (d.wallsEnd > 4) d.wallsEnd = Math.max(0, Math.round(d.wallsEnd * 0.7));
    else if (d.growth > 1.04) d.growth = Math.round((d.growth - 0.02) * 1000) / 1000;
    else if (d.growPerFood > 1) d.growPerFood -= 1;
    else if (d.foodStart > 3) d.foodStart -= 1;
    else if (b.cols < 30) b.cols = Math.min(30, b.cols + 2);
    else if (b.rows < 20) b.rows = Math.min(20, b.rows + 1);
    else break;
  }
  if (d.wallsStart > d.wallsEnd) d.wallsStart = d.wallsEnd;
  return out;
}

const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description });
const int = (min, max, description) => ({ type: 'integer', minimum: min, maximum: max, description });

export const TOOL_FIELDS = {
  board: {
    type: 'object', additionalProperties: false,
    required: ['cols', 'rows', 'wrapEdges'],
    properties: {
      cols: int(10, 30, 'Grid columns. 20 default.'),
      rows: int(8, 20, 'Grid rows. 13 default (roughly 16:9).'),
      wrapEdges: { type: 'boolean', description: 'If true, leaving one edge reappears on the opposite side. Considerably friendlier; false is the classic rule.' },
    },
  },
  difficulty: {
    type: 'object', additionalProperties: false,
    required: ['curve', 'stepMsStart', 'stepMsEnd', 'foodStart', 'growth', 'wallsStart', 'wallsEnd', 'growPerFood'],
    properties: {
      curve: { type: 'string', enum: CURVE_SHAPES, description: 'easeInQuad recommended.' },
      stepMsStart: int(90, 320, 'Milliseconds per step on level 1. LOWER means faster. 190 is a calm opener.'),
      stepMsEnd: int(60, 160, 'Milliseconds per step on level 20. Must be below stepMsStart. Never go under 60 — no human can react.'),
      foodStart: int(3, 20, 'Food to eat to clear level 1. 5 default.'),
      growth: num(1.02, 1.3, 'Per-level multiplier on the food target. 1.13 default.'),
      wallsStart: int(0, 20, 'Interior wall blocks on level 1. Keep 0.'),
      wallsEnd: int(0, 60, 'Interior wall blocks on level 20. 18 default.'),
      growPerFood: int(1, 4, 'Segments gained per food. 2 default. Higher fills the board fast — keep the food target low if you raise it.'),
    },
  },
};

export const DEFAULT_TAGLINE = 'eat, grow, survive · 20 levels';
