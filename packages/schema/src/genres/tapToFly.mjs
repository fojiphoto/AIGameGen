/**
 * Genre: tap_to_fly — tap to flap, thread the gaps.
 *
 * Called "Tap-to-Fly" everywhere, never the other name. See §G1 on trademarks.
 *
 * The whole difficulty of this genre lives in ONE constraint: consecutive gaps must be
 * reachable from each other. A gap you cannot physically fly to is the classic unfair
 * bug in every clone of this game, and it is why `packages/generation/src/genres/
 * tapToFly.mjs` refuses to place one.
 */

import { z } from 'zod';
import { MetaSchema, ThemeSchema, ProgressionSchema, CopySchema, CURVE_SHAPES } from '../index.mjs';

export const GENRE_ID = 'tap_to_fly';

export const PlayerSchema = z.object({
  /** Upward velocity applied on each tap, as a POSITIVE magnitude. */
  flapImpulse: z.number().min(180).max(520).default(300),
  gravity: z.number().min(500).max(2200).default(1100),
  /** Downward speed cap — without it, a long fall becomes unrecoverable. */
  terminalVelocity: z.number().min(260).max(900).default(520),
  size: z.number().int().min(20).max(56).default(34),
  hitboxScale: z.number().min(0.5).max(1).default(0.78),
});

export const WorldSchema = z.object({
  groundHeight: z.number().int().min(30).max(140).default(64),
  ceilingKills: z.boolean().default(false),
  parallax: z.number().int().min(0).max(3).default(2),
  showStars: z.boolean().default(false),
  pipeWidth: z.number().int().min(40).max(110).default(66),
});

export const DifficultySchema = z.object({
  startSpeed: z.number().min(110).max(280).default(165),
  maxSpeed: z.number().min(290).max(620).default(430),
  curve: z.enum(CURVE_SHAPES).default('easeInQuad'),
  /** Vertical opening in px — shrinks as levels progress. */
  gapHeightStart: z.number().min(150).max(320).default(230),
  gapHeightEnd: z.number().min(96).max(148).default(126),
  /** Horizontal distance between pipe centres — tightens as levels progress. */
  spacingStart: z.number().min(300).max(700).default(520),
  spacingEnd: z.number().min(200).max(298).default(258),
  /** Pipes to clear on level 1. */
  basePipes: z.number().int().min(4).max(30).default(8),
  growth: z.number().min(1.02).max(1.22).default(1.1),
  /** Vertical drift of gap centres between consecutive pipes, 0..1 of the safe band. */
  driftStart: z.number().min(0).max(0.5).default(0.16),
  driftEnd: z.number().min(0).max(1).default(0.72),
  /** Level at which gaps begin oscillating vertically. 0 = never. */
  movingGapsFromLevel: z.number().int().min(0).max(20).default(14),
});

/** Vertical travel of one flap: the oscillation the player cannot avoid. */
export const bounce = (player) => (player.flapImpulse * player.flapImpulse) / (2 * player.gravity);

/** Smallest opening this player can actually fly through. */
export const minOpening = (player) => player.size * player.hitboxScale + bounce(player) + 22;

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    genre: z.literal(GENRE_ID),
    meta: MetaSchema,
    theme: ThemeSchema,
    player: PlayerSchema,
    world: WorldSchema,
    difficulty: DifficultySchema,
    progression: ProgressionSchema,
    copy: CopySchema,
  })
  .superRefine((cfg, ctx) => {
    const d = cfg.difficulty;
    if (d.maxSpeed <= d.startSpeed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'maxSpeed'], message: 'maxSpeed must exceed startSpeed' });
    }
    if (d.gapHeightEnd >= d.gapHeightStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'gapHeightEnd'], message: 'gapHeightEnd must be smaller than gapHeightStart (gaps tighten as levels rise)' });
    }
    if (d.spacingEnd >= d.spacingStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'spacingEnd'], message: 'spacingEnd must be smaller than spacingStart' });
    }
    // The tightest gap must fit the body AND one unavoidable flap bounce. Holding a level
    // altitude is impossible here — the only control is an upward kick — so the player
    // permanently oscillates by flapImpulse²/2·gravity just to stay put. A gap sized for
    // the body alone is unwinnable in a way that reads as bad play rather than a bad level.
    const needed = minOpening(cfg.player);
    if (d.gapHeightEnd < needed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['difficulty', 'gapHeightEnd'],
        message:
          `gapHeightEnd ${d.gapHeightEnd} cannot fit a ${Math.round(cfg.player.size * cfg.player.hitboxScale)}px body ` +
          `plus the ${Math.round(bounce(cfg.player))}px flap bounce — needs at least ${Math.round(needed)}. ` +
          `Either widen the gap or reduce flapImpulse / raise gravity.`,
      });
    }
    if (d.driftEnd < d.driftStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['difficulty', 'driftEnd'], message: 'driftEnd must be at least driftStart' });
    }
  });

export const CLAMP_RANGES = {
  'player.flapImpulse': [180, 520],
  'player.gravity': [500, 2200],
  'player.terminalVelocity': [260, 900],
  'player.size': [20, 56],
  'world.groundHeight': [30, 140],
  'world.pipeWidth': [40, 110],
  'difficulty.startSpeed': [110, 280],
  'difficulty.maxSpeed': [290, 620],
  'difficulty.gapHeightStart': [150, 320],
  'difficulty.gapHeightEnd': [96, 148],
  'difficulty.spacingStart': [300, 700],
  'difficulty.spacingEnd': [200, 298],
  'difficulty.basePipes': [4, 30],
  'difficulty.growth': [1.02, 1.22],
  'difficulty.driftStart': [0, 0.5],
  'difficulty.driftEnd': [0, 1],
};

/** Structural repairs applied after clamping, before validation. */
export function repair(out) {
  const d = out.difficulty;
  if (!d) return out;
  if (typeof d.maxSpeed === 'number' && typeof d.startSpeed === 'number' && d.maxSpeed <= d.startSpeed) {
    d.maxSpeed = Math.min(620, d.startSpeed + 160);
  }
  if (typeof d.gapHeightEnd === 'number' && typeof d.gapHeightStart === 'number' && d.gapHeightEnd >= d.gapHeightStart) {
    d.gapHeightStart = Math.min(320, d.gapHeightEnd + 80);
  }
  if (typeof d.spacingEnd === 'number' && typeof d.spacingStart === 'number' && d.spacingEnd >= d.spacingStart) {
    d.spacingStart = Math.min(700, d.spacingEnd + 140);
  }
  if (typeof d.driftEnd === 'number' && typeof d.driftStart === 'number' && d.driftEnd < d.driftStart) {
    d.driftEnd = d.driftStart;
  }
  // Guarantee the tightest gap can actually be flown. If widening the gap alone is not
  // enough (a huge flapImpulse against weak gravity can need a 270px opening), soften the
  // physics instead — a slightly floatier bird beats a game with no clearable level.
  if (out.player && typeof d.gapHeightEnd === 'number') {
    out.player.hitboxScale ??= 0.78;
    out.player.size ??= 34;
    let need = minOpening(out.player);
    if (need > 148) {
      // shrink the bounce until it fits the largest permitted end-gap
      const budget = 148 - out.player.size * out.player.hitboxScale - 22;
      out.player.gravity = Math.min(2200, Math.ceil((out.player.flapImpulse ** 2) / (2 * Math.max(8, budget))));
      need = minOpening(out.player);
      if (need > 148) {
        out.player.flapImpulse = Math.max(180, Math.floor(Math.sqrt(2 * out.player.gravity * Math.max(8, budget))));
        need = minOpening(out.player);
      }
    }
    d.gapHeightEnd = Math.max(d.gapHeightEnd, Math.min(148, Math.ceil(need)));
    if (d.gapHeightStart <= d.gapHeightEnd) d.gapHeightStart = Math.min(320, d.gapHeightEnd + 80);
  }
  return out;
}

const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description });
const int = (min, max, description) => ({ type: 'integer', minimum: min, maximum: max, description });

export const TOOL_FIELDS = {
  player: {
    type: 'object', additionalProperties: false,
    required: ['flapImpulse', 'gravity', 'terminalVelocity', 'size'],
    properties: {
      flapImpulse: num(180, 520, 'Upward kick per tap, positive. 300 is the tuned default; above 400 feels floaty.'),
      gravity: num(500, 2200, 'Higher = heavier and less forgiving. 1100 default.'),
      terminalVelocity: num(260, 900, 'Fall-speed cap. Without a low cap a long dive becomes unrecoverable. 520 default.'),
      size: int(20, 56, 'Player size in px. 34 default.'),
    },
  },
  world: {
    type: 'object', additionalProperties: false,
    required: ['groundHeight', 'ceilingKills', 'parallax', 'showStars', 'pipeWidth'],
    properties: {
      groundHeight: int(30, 140, null),
      ceilingKills: { type: 'boolean', description: 'If true, touching the top of the screen ends the run. Harder; false is friendlier.' },
      parallax: int(0, 3, null),
      showStars: { type: 'boolean', description: 'Background particles. Suits night, space and underwater themes.' },
      pipeWidth: int(40, 110, 'Thickness of each obstacle column. 66 default.'),
    },
  },
  difficulty: {
    type: 'object', additionalProperties: false,
    required: ['startSpeed', 'maxSpeed', 'curve', 'gapHeightStart', 'gapHeightEnd', 'spacingStart', 'spacingEnd', 'basePipes', 'growth', 'driftStart', 'driftEnd', 'movingGapsFromLevel'],
    properties: {
      startSpeed: num(110, 280, 'Level 1 scroll speed. Keep LOW — this genre is unforgiving and most players quit in the first minute.'),
      maxSpeed: num(290, 620, 'Level 20 scroll speed. Must exceed startSpeed.'),
      curve: { type: 'string', enum: CURVE_SHAPES, description: 'easeInQuad recommended.' },
      gapHeightStart: num(150, 320, 'Opening height on level 1. Generous: 220-260.'),
      gapHeightEnd: num(96, 148, 'Opening height on level 20. Must stay at least (player size x 0.78) + 46 px.'),
      spacingStart: num(300, 700, 'Distance between pipes on level 1.'),
      spacingEnd: num(200, 298, 'Distance between pipes on level 20. Must be smaller than spacingStart.'),
      basePipes: int(4, 30, 'Pipes to clear on level 1. 8 default.'),
      growth: num(1.02, 1.22, 'Per-level multiplier on the pipe count. 1.1 default.'),
      driftStart: num(0, 0.5, 'How much consecutive gap centres wander on level 1, as a fraction of the safe band. Keep small.'),
      driftEnd: num(0, 1, 'Same on level 20. Must be >= driftStart.'),
      movingGapsFromLevel: int(0, 20, 'Level at which gaps start oscillating vertically. 0 disables it. 14 default.'),
    },
  },
};

export const DEFAULT_TAGLINE = 'thread the gaps · 20 levels · endless mode';
