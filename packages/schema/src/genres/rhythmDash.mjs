/**
 * Genre: rhythm_dash — one-button auto-runner. Tap to jump, touch anything and restart.
 *
 * This is the genre, built from scratch. It is NOT a copy of any specific game: no borrowed
 * name, no reproduced level layouts, no lifted art or music. Mechanics are not protectable
 * and this implements the mechanics — a cube that auto-runs at constant speed, dies to a
 * single touch, restarts instantly, and shows an attempt counter and a completion bar.
 *
 * WHAT MAKES THIS GENRE DIFFERENT FROM THE RUNNER ALREADY IN THIS REPO
 *
 *   Endless Runner            rhythm_dash
 *   speed ramps within a run  speed is CONSTANT for a whole level
 *   forgiving, score-based    single touch kills, level restarts from zero
 *   random obstacle stream    fixed, memorisable layout — the same every attempt
 *   level select grid         no menu at all; level 1 starts immediately and
 *                             finishing one drops you straight into the next
 *
 * That last row is why it needs its own progression mode: `skipMenu`.
 *
 * DESIGNING IN JUMP UNITS
 *
 * Obstacle positions are stored as multiples of J — the horizontal distance one full jump
 * covers. Because J is derived from the level's own speed, a chunk authored once is correct
 * at every speed, and "is this spike clearable" stops depending on tuning numbers.
 */

import { z } from 'zod';
import { MetaSchema, ThemeSchema, checkLadder, ProgressionSchema, CopySchema, CURVE_SHAPES } from '../index.mjs';

export const GENRE_ID = 'rhythm_dash';

export const PlayerSchema = z.object({
  /** Negative = upward. A single fixed impulse; there is no variable-height jump. */
  jumpVelocity: z.number().min(-1100).max(-420).default(-680),
  gravity: z.number().min(1400).max(3600).default(2300),
  size: z.number().int().min(26).max(52).default(36),
  /** Deliberately forgiving: a cube that dies on a corner pixel feels broken, not hard. */
  hitboxScale: z.number().min(0.6).max(0.95).default(0.8),
  /** Degrees the cube spins per jump. Pure feel, no gameplay effect. */
  rotationPerJump: z.number().min(0).max(360).default(180),
});

export const WorldSchema = z.object({
  groundHeight: z.number().int().min(50).max(150).default(88),
  /** Ceiling spikes and gravity flips need a bounded playfield. */
  ceilingHeight: z.number().int().min(0).max(90).default(0),
  showGrid: z.boolean().default(true),
  parallax: z.number().int().min(0).max(3).default(2),
  showPulse: z.boolean().default(true),
});

export const DifficultySchema = z.object({
  /**
   * Constant scroll speed for the whole level. The ramp across the ladder comes from
   * chunk difficulty and density, not from acceleration — accelerating inside a level would
   * make a memorised layout stop working halfway through.
   */
  speedStart: z.number().min(240).max(420).default(300),
  speedEnd: z.number().min(430).max(760).default(560),
  curve: z.enum(CURVE_SHAPES).default('easeInQuad'),
  /** Chunks per level: how long a level runs. */
  chunksStart: z.number().int().min(4).max(20).default(7),
  chunksEnd: z.number().int().min(10).max(48).default(26),
  /** Hardest chunk tier allowed, 1 (trivial) to 5 (tight timing). */
  tierStart: z.number().int().min(1).max(3).default(1),
  tierEnd: z.number().int().min(2).max(5).default(5),
  /** Breather chunks per level, as a fraction. Keeps a long level readable. */
  breatherRatioStart: z.number().min(0).max(0.6).default(0.4),
  breatherRatioEnd: z.number().min(0).max(0.4).default(0.12),
});

export const FeaturesSchema = z.object({
  /** Level from which each mechanic may appear. 0 disables it entirely. */
  platformsFromLevel: z.number().int().min(0).max(20).default(3),
  gapsFromLevel: z.number().int().min(0).max(20).default(6),
  jumpPadsFromLevel: z.number().int().min(0).max(20).default(9),
  ceilingSpikesFromLevel: z.number().int().min(0).max(20).default(13),
  /** Gravity flip portals — the most disorienting mechanic, so it arrives last. */
  gravityFlipFromLevel: z.number().int().min(0).max(20).default(17),
});

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    genre: z.literal(GENRE_ID),
    meta: MetaSchema,
    theme: ThemeSchema,
    player: PlayerSchema,
    world: WorldSchema,
    difficulty: DifficultySchema,
    features: FeaturesSchema,
    progression: ProgressionSchema,
    copy: CopySchema,
  })
  .superRefine((cfg, ctx) => {
    checkLadder(cfg, ctx);
    const d = cfg.difficulty;
    if (d.speedEnd <= d.speedStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'speedEnd'], message: 'speedEnd must exceed speedStart' });
    }
    if (d.chunksEnd <= d.chunksStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'chunksEnd'], message: 'chunksEnd must exceed chunksStart' });
    }
    if (d.tierEnd <= d.tierStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'tierEnd'], message: 'tierEnd must exceed tierStart' });
    }
    if (d.breatherRatioEnd >= d.breatherRatioStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['difficulty', 'breatherRatioEnd'],
        message: 'breatherRatioEnd must be smaller than breatherRatioStart — later levels get fewer breathers',
      });
    }
    // The jump has to clear a full-height spike with room to spare, or nothing is passable.
    const peak = (cfg.player.jumpVelocity ** 2) / (2 * cfg.player.gravity);
    const body = cfg.player.size * cfg.player.hitboxScale;
    if (peak < body * 1.9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['player', 'jumpVelocity'],
        message:
          `jump peaks at ${Math.round(peak)}px but a ${Math.round(body)}px cube needs at least ` +
          `${Math.round(body * 1.9)}px to clear an obstacle its own height and land again. ` +
          `Raise jumpVelocity magnitude or lower gravity.`,
      });
    }
    if (cfg.world.ceilingHeight === 0 && cfg.features.ceilingSpikesFromLevel > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['world', 'ceilingHeight'],
        message: 'ceiling spikes need a ceiling — set ceilingHeight above 0 or disable ceilingSpikesFromLevel',
      });
    }
  });

export const CLAMP_RANGES = {
  'player.jumpVelocity': [-1100, -420],
  'player.gravity': [1400, 3600],
  'player.size': [26, 52],
  'player.hitboxScale': [0.6, 0.95],
  'player.rotationPerJump': [0, 360],
  'world.groundHeight': [50, 150],
  'world.ceilingHeight': [0, 90],
  'world.parallax': [0, 3],
  'difficulty.speedStart': [240, 420],
  'difficulty.speedEnd': [430, 760],
  'difficulty.chunksStart': [4, 20],
  'difficulty.chunksEnd': [10, 48],
  'difficulty.tierStart': [1, 3],
  'difficulty.tierEnd': [2, 5],
  'difficulty.breatherRatioStart': [0, 0.6],
  'difficulty.breatherRatioEnd': [0, 0.4],
};

export function repair(out) {
  const d = out.difficulty;
  const p = out.player;
  if (d) {
    if (d.speedEnd <= d.speedStart) d.speedEnd = Math.min(760, d.speedStart + 160);
    if (d.chunksEnd <= d.chunksStart) d.chunksEnd = Math.min(48, d.chunksStart + 12);
    if (d.tierEnd <= d.tierStart) d.tierEnd = Math.min(5, d.tierStart + 2);
    if (d.breatherRatioEnd >= d.breatherRatioStart) {
      d.breatherRatioStart = Math.min(0.6, d.breatherRatioEnd + 0.2);
    }
  }
  // Guarantee the jump can clear an obstacle of the cube's own height and land again.
  if (p) {
    p.size ??= 36;
    p.hitboxScale ??= 0.8;
    const body = p.size * p.hitboxScale;
    const need = body * 1.9;
    let peak = (p.jumpVelocity ** 2) / (2 * p.gravity);
    if (peak < need) {
      // Lower gravity first: it keeps the jump feeling snappy rather than floaty.
      p.gravity = Math.max(1400, Math.floor((p.jumpVelocity ** 2) / (2 * need)));
      peak = (p.jumpVelocity ** 2) / (2 * p.gravity);
      if (peak < need) {
        p.jumpVelocity = -Math.min(1100, Math.ceil(Math.sqrt(2 * p.gravity * need)));
      }
    }
  }
  if (out.world && out.features) {
    if (out.world.ceilingHeight === 0) out.features.ceilingSpikesFromLevel = 0;
    if (out.features.gravityFlipFromLevel > 0 && out.world.ceilingHeight < 40) {
      // A flip with no headroom drops the player straight onto the ceiling.
      out.world.ceilingHeight = 60;
    }
  }
  return out;
}

const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description });
const int = (min, max, description) => ({ type: 'integer', minimum: min, maximum: max, description });

export const TOOL_FIELDS = {
  player: {
    type: 'object', additionalProperties: false,
    required: ['jumpVelocity', 'gravity', 'size', 'rotationPerJump'],
    properties: {
      jumpVelocity: num(-1100, -420, 'Negative = upward. Single fixed impulse, no variable height. -680 default.'),
      gravity: num(1400, 3600, 'High gravity is the signature of this genre — snappy, not floaty. 2300 default.'),
      size: int(26, 52, 'Cube size in px. 36 default.'),
      rotationPerJump: num(0, 360, 'Degrees the cube spins per jump. 180 default. Cosmetic.'),
    },
  },
  world: {
    type: 'object', additionalProperties: false,
    required: ['groundHeight', 'ceilingHeight', 'showGrid', 'parallax', 'showPulse'],
    properties: {
      groundHeight: int(50, 150, null),
      ceilingHeight: int(0, 90, 'Set above 0 only if you enable ceiling spikes or gravity flips. 0 default.'),
      showGrid: { type: 'boolean', description: 'Faint background grid. Suits geometric and neon themes.' },
      parallax: int(0, 3, null),
      showPulse: { type: 'boolean', description: 'Background pulses on the beat.' },
    },
  },
  difficulty: {
    type: 'object', additionalProperties: false,
    required: ['speedStart', 'speedEnd', 'curve', 'chunksStart', 'chunksEnd', 'tierStart', 'tierEnd', 'breatherRatioStart', 'breatherRatioEnd'],
    properties: {
      speedStart: num(240, 420, 'Constant speed for level 1. 300 default.'),
      speedEnd: num(430, 760, 'Constant speed for level 20. Must exceed speedStart.'),
      curve: { type: 'string', enum: CURVE_SHAPES, description: 'easeInQuad recommended.' },
      chunksStart: int(4, 20, 'Segments in level 1 — roughly how long it runs. 7 is about 20 seconds.'),
      chunksEnd: int(10, 48, 'Segments in level 20. 26 default. Must exceed chunksStart.'),
      tierStart: int(1, 3, 'Hardest segment difficulty allowed on level 1. Keep 1.'),
      tierEnd: int(2, 5, 'Hardest allowed on level 20. 5 is tight timing. Must exceed tierStart.'),
      breatherRatioStart: num(0, 0.6, 'Fraction of level 1 that is empty runway. 0.4 = very readable.'),
      breatherRatioEnd: num(0, 0.4, 'Same for level 20. Must be smaller than breatherRatioStart.'),
    },
  },
  features: {
    type: 'object', additionalProperties: false,
    required: ['platformsFromLevel', 'gapsFromLevel', 'jumpPadsFromLevel', 'ceilingSpikesFromLevel', 'gravityFlipFromLevel'],
    description:
      'Level at which each mechanic first appears, 0 to disable. Stagger them — a new mechanic ' +
      'every few levels is what makes progression feel designed rather than just faster.',
    properties: {
      platformsFromLevel: int(0, 20, 'Raised blocks to land on. 3 default.'),
      gapsFromLevel: int(0, 20, 'Holes in the ground. 6 default.'),
      jumpPadsFromLevel: int(0, 20, 'Pads that launch the cube higher. 9 default.'),
      ceilingSpikesFromLevel: int(0, 20, 'Hazards hanging from the ceiling. Needs ceilingHeight above 0. 13 default.'),
      gravityFlipFromLevel: int(0, 20, 'Portals that invert gravity. Most disorienting, so keep it late. 17 default.'),
    },
  },
};

export const DEFAULT_TAGLINE = 'one tap · one life · 10 levels';
