/**
 * JSON Schema handed to Claude as a FORCED tool definition (§B2).
 *
 * Written by hand rather than derived from Zod on purpose: the tool schema is a
 * prompt, not just a validator. Descriptions here are design guidance the model
 * reads, and hand-authoring lets us tune that wording without touching runtime
 * validation. `packages/generation/test/schema-parity.test.mjs` asserts the two
 * stay structurally in sync.
 */

import { OBSTACLE_KINDS, CURVE_SHAPES } from './index.mjs';

const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const num = (min, max, description) => ({ type: 'number', minimum: min, maximum: max, description });
const int = (min, max, description) => ({ type: 'integer', minimum: min, maximum: max, description });

export const EMIT_CONFIG_TOOL = {
  name: 'emit_game_config',
  description:
    'Emit the complete tuning configuration for one endless-runner game. ' +
    'You are a game designer choosing values, not a programmer writing code. ' +
    'Every field is required.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['meta', 'theme', 'player', 'world', 'difficulty', 'obstacles', 'copy'],
    properties: {
      meta: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'tagline'],
        properties: {
          title: { type: 'string', maxLength: 40, description: 'Punchy game title, 1-3 words. Must NOT reference any existing commercial game or franchise.' },
          tagline: { type: 'string', maxLength: 90, description: 'One short line shown on the title screen.' },
        },
      },
      theme: {
        type: 'object',
        additionalProperties: false,
        required: ['palette', 'styleTags', 'mood'],
        properties: {
          palette: {
            type: 'object',
            additionalProperties: false,
            required: ['bg', 'bgAccent', 'ground', 'player', 'obstacle', 'accent', 'text'],
            description:
              'Cohesive 7-colour palette. bg must be dark enough that text is readable. ' +
              'player and obstacle must contrast strongly against both bg and ground — ' +
              'the player has to read instantly at speed.',
            properties: {
              bg: hex, bgAccent: hex, ground: hex,
              player: hex, obstacle: hex, accent: hex, text: hex,
            },
          },
          styleTags: {
            type: 'array', maxItems: 8,
            items: { type: 'string', maxLength: 24 },
            description: 'Art-direction keywords, e.g. ["neon","cyberpunk","synthwave"].',
          },
          mood: { type: 'string', enum: ['calm', 'energetic', 'tense', 'playful', 'dark'] },
        },
      },
      player: {
        type: 'object',
        additionalProperties: false,
        required: ['jumpVelocity', 'gravity', 'doubleJump', 'size'],
        properties: {
          jumpVelocity: num(-1200, -260, 'Negative = upward impulse. -620 is a comfortable default; -900 is floaty and high.'),
          gravity: num(700, 3200, 'Higher = snappier, less forgiving. 1750 is the tuned default.'),
          doubleJump: { type: 'boolean', description: 'Enable only if the prompt implies air control or extra forgiveness.' },
          size: int(24, 72, 'Player square size in px. 44 default.'),
        },
      },
      world: {
        type: 'object',
        additionalProperties: false,
        required: ['groundHeight', 'parallax', 'showStars'],
        properties: {
          groundHeight: int(40, 200, 'Ground band height in px. 96 default.'),
          parallax: int(0, 3, 'Number of scrolling background layers.'),
          showStars: { type: 'boolean', description: 'Twinkling background particles. Suits night/space themes.' },
        },
      },
      difficulty: {
        type: 'object',
        additionalProperties: false,
        required: ['startSpeed', 'maxSpeed', 'curve', 'spawnGapStart', 'spawnGapEnd', 'baseTarget', 'growth'],
        properties: {
          startSpeed: num(140, 420, 'Level 1 scroll speed px/s. Keep LOW — most players quit in the first 90 seconds.'),
          maxSpeed: num(430, 1150, 'Level 20 scroll speed px/s. Must exceed startSpeed.'),
          curve: {
            type: 'string', enum: CURVE_SHAPES,
            description: 'easeInQuad (recommended) keeps early levels gentle. Use linear only for a "hard" bias.',
          },
          spawnGapStart: num(900, 2600, 'ms between obstacles at level 1. Larger = easier.'),
          spawnGapEnd: num(420, 880, 'ms between obstacles at level 20. Must be smaller than spawnGapStart.'),
          baseTarget: num(120, 700, 'Distance in metres to clear level 1.'),
          growth: num(1.02, 1.2, 'Per-level multiplier on the distance target. 1.08 is the tuned default; above 1.12 late levels all hit the duration cap and feel identical.'),
        },
      },
      obstacles: {
        type: 'array', minItems: 3, maxItems: 6,
        description:
          'The obstacle roster. Stagger introAtLevel so a NEW obstacle appears roughly every 4-5 levels — ' +
          'novelty is what makes progression feel good, not just higher numbers. ' +
          'At least one obstacle MUST have introAtLevel 1.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'kind', 'introAtLevel', 'weight', 'width', 'height', 'yOffset'],
          properties: {
            id: { type: 'string', maxLength: 24, description: 'lowercase_snake identifier, unique.' },
            kind: {
              type: 'string', enum: OBSTACLE_KINDS,
              description:
                'ground_spike: short, jump it. tall_block: tall, jump early. ' +
                'low_bar: floating low, do NOT jump. flying_drone: airborne at jump height. ' +
                'moving_saw: oscillates vertically. gap: hole in the ground.',
            },
            introAtLevel: int(1, 20, 'First level this appears.'),
            weight: int(1, 100, 'Relative spawn frequency once unlocked.'),
            width: int(14, 90, null),
            height: int(14, 140, null),
            yOffset: int(0, 220, 'Height above ground. 0 for ground obstacles.'),
            motionAmp: int(0, 120, 'Vertical oscillation amplitude. Only for moving_saw.'),
            motionSpeed: num(0, 6, 'Oscillation speed. Only for moving_saw.'),
          },
        },
      },
      copy: {
        type: 'object',
        additionalProperties: false,
        required: ['levelNames', 'tutorial', 'winMsg', 'loseMsg', 'endlessMsg'],
        properties: {
          levelNames: {
            type: 'array', minItems: 20, maxItems: 20,
            items: { type: 'string', maxLength: 34 },
            description: 'Exactly 20 thematic level names that escalate in intensity, e.g. "Sector 7: Overdrive".',
          },
          tutorial: { type: 'string', maxLength: 120 },
          winMsg: { type: 'string', maxLength: 60 },
          loseMsg: { type: 'string', maxLength: 60 },
          endlessMsg: { type: 'string', maxLength: 80 },
        },
      },
    },
  },
};

export const CLASSIFY_TOOL = {
  name: 'classify_intent',
  description: 'Classify a game-idea prompt into a supported genre and extract theme intent.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['genre', 'confidence', 'subject', 'theme', 'difficultyBias', 'blocked'],
    properties: {
      genre: {
        type: 'string',
        enum: ['endless_runner', 'tap_to_fly', 'platformer', 'match3', 'bubble_pop'],
        description: 'Best-fit genre. Only endless_runner is implemented today; pick it when the prompt is ambiguous.',
      },
      confidence: num(0, 1, 'Below 0.7 the UI will ask the user to pick a genre explicitly.'),
      subject: { type: 'string', maxLength: 60, description: 'What the player controls, e.g. "robot", "paper plane".' },
      theme: {
        type: 'object',
        additionalProperties: false,
        required: ['setting', 'mood', 'paletteHint'],
        properties: {
          setting: { type: 'string', maxLength: 60 },
          mood: { type: 'string', enum: ['calm', 'energetic', 'tense', 'playful', 'dark'] },
          paletteHint: { type: 'string', maxLength: 40 },
        },
      },
      difficultyBias: { type: 'string', enum: ['easy', 'normal', 'hard'] },
      explicitRequests: {
        type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 },
        description: 'Concrete mechanical asks, e.g. ["double jump","no gaps"].',
      },
      blocked: {
        type: 'boolean',
        description:
          'True if the prompt requests copyrighted characters/franchises (Mario, Pokemon, Sonic, ' +
          'Flappy Bird, Candy Crush, Squid Game, etc.), a real person, NSFW, or hateful content.',
      },
      blockedReason: { type: ['string', 'null'], maxLength: 200 },
    },
  },
};

/** JSON Patch tool for the refinement engine (§B7). */
export const PATCH_TOOL = {
  name: 'emit_config_patch',
  description:
    'Emit the MINIMAL RFC-6902 JSON Patch that applies the user\'s requested change to the ' +
    'existing config. Change only what was asked. Never replace the whole config.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['patch', 'summary'],
    properties: {
      patch: {
        type: 'array', maxItems: 24,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'path'],
          properties: {
            op: { type: 'string', enum: ['replace', 'add', 'remove'] },
            path: { type: 'string', description: 'JSON Pointer, e.g. /difficulty/maxSpeed' },
            value: {},
          },
        },
      },
      summary: { type: 'string', maxLength: 140, description: 'One short line describing what changed, shown to the user.' },
    },
  },
};
