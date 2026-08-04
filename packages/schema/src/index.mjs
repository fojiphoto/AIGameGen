/**
 * packages/schema — SINGLE SOURCE OF TRUTH
 *
 * One Zod definition produces:
 *   1. runtime validation (API boundary)
 *   2. the JSON Schema handed to Claude as a forced tool definition
 *   3. hard numeric clamps so a bad LLM output can never ship an unplayable game
 *
 * Rule: the AI may SUGGEST any number. The clamp decides what actually ships.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const GENRES = ['endless_runner', 'tap_to_fly', 'platformer', 'match3', 'bubble_pop'];

/** Genres actually implemented right now. */
export const LIVE_GENRES = ['endless_runner'];

// ─────────────────────────────────────────────────────────────────────────────
// primitives
// ─────────────────────────────────────────────────────────────────────────────

const Hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour like #7cb342');

/** Java package segment rules: starts with a letter, alphanumeric only. */
const PackageId = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/,
    'must be reverse-domain, lowercase, each segment starting with a letter'
  )
  .max(120);

export const CURVE_SHAPES = ['linear', 'easeInQuad', 'easeOutQuad', 'sCurve', 'stepped'];

export const OBSTACLE_KINDS = [
  'ground_spike', // short, must jump
  'tall_block',   // tall, must jump early
  'low_bar',      // floating low — must NOT jump (or duck)
  'flying_drone', // airborne, hovers at jump height
  'moving_saw',   // oscillates vertically
  'gap',          // hole in the ground
];

// ─────────────────────────────────────────────────────────────────────────────
// sections
// ─────────────────────────────────────────────────────────────────────────────

export const PaletteSchema = z.object({
  bg:       Hex.default('#06281c'),
  bgAccent: Hex.default('#0a5a42'),
  ground:   Hex.default('#11704f'),
  player:   Hex.default('#a3d977'),
  obstacle: Hex.default('#ff7043'),
  accent:   Hex.default('#fbbf24'),
  text:     Hex.default('#eaf5ee'),
});

export const MetaSchema = z.object({
  title:     z.string().min(1).max(40),
  tagline:   z.string().max(90).default(''),
  packageId: PackageId,
  /**
   * uint32. Must match the range hashSeed()/mulberry32 actually produce — a narrower
   * bound here rejects roughly half of all legitimately generated seeds, and because
   * the planner used to skip validation it only surfaced later, on the first refine.
   */
  seed:      z.number().int().min(0).max(0xffffffff),
});

export const ThemeSchema = z.object({
  palette:   PaletteSchema,
  styleTags: z.array(z.string().max(24)).max(8).default([]),
  mood:      z.enum(['calm', 'energetic', 'tense', 'playful', 'dark']).default('energetic'),
  /** Reserved for the asset-pack resolver (§B4). Procedural rendering in v1. */
  spritePack: z.string().max(60).nullable().default(null),
});

/**
 * Physics. Clamps here are the single most important safety net in the system:
 * they make an unplayable game structurally impossible.
 */
export const PlayerSchema = z.object({
  jumpVelocity: z.number().min(-1200).max(-260).default(-620),
  gravity:      z.number().min(700).max(3200).default(1750),
  doubleJump:   z.boolean().default(false),
  hitboxScale:  z.number().min(0.5).max(1).default(0.82),
  size:         z.number().int().min(24).max(72).default(44),
});

export const WorldSchema = z.object({
  groundHeight:  z.number().int().min(40).max(200).default(96),
  parallax:      z.number().int().min(0).max(3).default(2),
  showStars:     z.boolean().default(true),
});

export const DifficultySchema = z.object({
  startSpeed:    z.number().min(140).max(420).default(250),
  maxSpeed:      z.number().min(430).max(1150).default(880),
  curve:         z.enum(CURVE_SHAPES).default('easeInQuad'),
  /** ms between obstacle spawns — start (easy) → end (hard) */
  spawnGapStart: z.number().min(900).max(2600).default(1750),
  spawnGapEnd:   z.number().min(420).max(880).default(620),
  /** distance target for level 1, in metres */
  baseTarget:    z.number().min(120).max(700).default(280),
  /**
   * Geometric growth of the distance target per level. Kept modest on purpose:
   * 1.08^19 ≈ 4.3x, so level 20 is a long-but-fair run. Higher values slam into
   * the duration clamp in curve.mjs and make every late level feel identical.
   */
  growth:        z.number().min(1.02).max(1.20).default(1.08),
});

export const ObstacleSchema = z.object({
  id:            z.string().min(1).max(24),
  kind:          z.enum(OBSTACLE_KINDS),
  introAtLevel:  z.number().int().min(1).max(20).default(1),
  weight:        z.number().int().min(1).max(100).default(25),
  width:         z.number().int().min(14).max(90).default(30),
  height:        z.number().int().min(14).max(140).default(42),
  /** vertical offset above ground; used by flying/low obstacles */
  yOffset:       z.number().int().min(0).max(220).default(0),
  /** vertical oscillation amplitude in px (moving_saw) */
  motionAmp:     z.number().int().min(0).max(120).default(0),
  motionSpeed:   z.number().min(0).max(6).default(0),
});

export const ProgressionSchema = z.object({
  levels:          z.literal(20).default(20),
  mode:            z.enum(['hybrid', 'levels_only', 'endless_only']).default('hybrid'),
  endlessUnlockAt: z.number().int().min(1).max(20).default(20),
  /** levels that dip easier to create rhythm (§C2 relief valleys) */
  reliefLevels:    z.array(z.number().int().min(1).max(20)).max(6).default([8, 15]),
});

export const CopySchema = z.object({
  levelNames: z.array(z.string().min(1).max(34)).length(20),
  tutorial:   z.string().max(120).default('TAP or SPACE to jump'),
  winMsg:     z.string().max(60).default('LEVEL CLEAR'),
  loseMsg:    z.string().max(60).default('CRASHED'),
  endlessMsg: z.string().max(80).default('ENDLESS MODE UNLOCKED'),
});

// ─────────────────────────────────────────────────────────────────────────────
// the config
// ─────────────────────────────────────────────────────────────────────────────

export const GameConfigSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    genre:         z.literal('endless_runner'),
    meta:          MetaSchema,
    theme:         ThemeSchema,
    player:        PlayerSchema,
    world:         WorldSchema,
    difficulty:    DifficultySchema,
    obstacles:     z.array(ObstacleSchema).min(2).max(8),
    progression:   ProgressionSchema,
    copy:          CopySchema,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.difficulty.maxSpeed <= cfg.difficulty.startSpeed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['difficulty', 'maxSpeed'],
        message: 'maxSpeed must exceed startSpeed',
      });
    }
    if (cfg.difficulty.spawnGapEnd >= cfg.difficulty.spawnGapStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['difficulty', 'spawnGapEnd'],
        message: 'spawnGapEnd must be smaller than spawnGapStart (gaps tighten as difficulty rises)',
      });
    }
    if (!cfg.obstacles.some((o) => o.introAtLevel === 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obstacles'],
        message: 'at least one obstacle must be available at level 1',
      });
    }
    const ids = cfg.obstacles.map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obstacles'],
        message: 'obstacle ids must be unique',
      });
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// intent (classifier output — §B1)
// ─────────────────────────────────────────────────────────────────────────────

export const IntentSchema = z.object({
  genre:      z.enum(GENRES),
  confidence: z.number().min(0).max(1),
  subject:    z.string().max(60).default('runner'),
  theme: z.object({
    setting:      z.string().max(60).default('abstract'),
    mood:         z.enum(['calm', 'energetic', 'tense', 'playful', 'dark']).default('energetic'),
    paletteHint:  z.string().max(40).default('neon'),
  }),
  difficultyBias:   z.enum(['easy', 'normal', 'hard']).default('normal'),
  explicitRequests: z.array(z.string().max(40)).max(10).default([]),
  blocked:          z.boolean().default(false),
  blockedReason:    z.string().max(200).nullable().default(null),
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Validate + apply defaults + clamp. Throws a readable error on failure. */
export function parseGameConfig(input) {
  return GameConfigSchema.parse(input);
}

/** Non-throwing variant for the AI repair loop (§B3). */
export function safeParseGameConfig(input) {
  const r = GameConfigSchema.safeParse(input);
  if (r.success) return { ok: true, config: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/**
 * Clamp every numeric knob into its schema range instead of rejecting.
 * The LLM often lands slightly out of bounds; silently pulling it back into
 * range yields a playable game rather than a failed generation.
 */
export function clampNumbers(raw) {
  const out = structuredClone(raw);
  const ranges = {
    'player.jumpVelocity': [-1200, -260],
    'player.gravity': [700, 3200],
    'player.size': [24, 72],
    'player.hitboxScale': [0.5, 1],
    'world.groundHeight': [40, 200],
    'world.parallax': [0, 3],
    'difficulty.startSpeed': [140, 420],
    'difficulty.maxSpeed': [430, 1150],
    'difficulty.spawnGapStart': [900, 2600],
    'difficulty.spawnGapEnd': [420, 880],
    'difficulty.baseTarget': [120, 700],
    'difficulty.growth': [1.04, 1.3],
  };
  for (const [path, [lo, hi]] of Object.entries(ranges)) {
    const parts = path.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) {
      if (node == null) break;
      node = node[p];
    }
    const key = parts.at(-1);
    if (node && typeof node[key] === 'number' && Number.isFinite(node[key])) {
      node[key] = Math.min(hi, Math.max(lo, node[key]));
    }
  }
  // structural repair: keep the ordering invariants the refinement can violate
  if (out.difficulty) {
    const d = out.difficulty;
    if (typeof d.maxSpeed === 'number' && typeof d.startSpeed === 'number' && d.maxSpeed <= d.startSpeed) {
      d.maxSpeed = Math.min(1150, d.startSpeed + 300);
    }
    if (
      typeof d.spawnGapEnd === 'number' &&
      typeof d.spawnGapStart === 'number' &&
      d.spawnGapEnd >= d.spawnGapStart
    ) {
      d.spawnGapStart = Math.min(2600, d.spawnGapEnd + 500);
    }
  }
  if (Array.isArray(out.obstacles) && out.obstacles.length && !out.obstacles.some((o) => o.introAtLevel === 1)) {
    out.obstacles[0].introAtLevel = 1;
  }
  return out;
}

/** Deterministic, valid package id from a game id. */
export function packageIdFor(gameId, brand = 'com.factorialstudio.forge') {
  const clean = String(gameId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'game';
  return `${brand}.g${clean.startsWith('0') ? 'x' + clean : clean}`;
}
