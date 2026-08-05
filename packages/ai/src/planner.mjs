/**
 * Deterministic rule-based planner.
 *
 * This is NOT a stub. It is a first-class execution path:
 *   • the whole product works with no API key and no network
 *   • it is the fallback when the LLM is down or its output fails repair (§B3)
 *   • it is what CI tests against, so tests never depend on a model
 *
 * Same interface as the LLM path: prompt → intent → GameConfig.
 */

import { makeRng, hashSeed } from '@forge/generation';
import { clampNumbers, packageIdFor, safeParseGameConfig } from '@forge/schema';
import { getGenre, clampAnyConfig, safeParseAnyConfig } from '@forge/schema/genres';
import { selectPalette } from './palettes.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// naming
// ─────────────────────────────────────────────────────────────────────────────

const TITLE_WORDS = {
  forge_green:  { adj: ['WILD', 'LUSH', 'VERDANT', 'THORN'], noun: ['DASH', 'SPRINT', 'CANOPY', 'ROOT'] },
  neon_cyber:   { adj: ['NEON', 'CHROME', 'GLITCH', 'VOLT'],  noun: ['DASH', 'RUNNER', 'CIRCUIT', 'DRIVE'] },
  deep_space:   { adj: ['VOID', 'ORBIT', 'STELLAR', 'COSMIC'],noun: ['DRIFT', 'RUNNER', 'ESCAPE', 'VECTOR'] },
  lava_forge:   { adj: ['MOLTEN', 'EMBER', 'ASH', 'CINDER'],  noun: ['RUSH', 'DESCENT', 'FORGE', 'SPRINT'] },
  ice_tundra:   { adj: ['FROST', 'GLACIER', 'ARCTIC', 'PALE'],noun: ['SLIDE', 'RUNNER', 'DRIFT', 'BREAK'] },
  sunset_desert:{ adj: ['DUNE', 'SUN', 'AMBER', 'MIRAGE'],    noun: ['RUN', 'CROSSING', 'HAUL', 'DASH'] },
  deep_ocean:   { adj: ['TIDAL', 'ABYSS', 'CORAL', 'DEEP'],   noun: ['CURRENT', 'DIVE', 'RUNNER', 'SURGE'] },
  candy_pop:    { adj: ['SUGAR', 'FIZZ', 'CANDY-FREE', 'POP'],noun: ['HOP', 'RUSH', 'BOUNCE', 'DASH'] },
  toxic_waste:  { adj: ['TOXIC', 'RUST', 'BLIGHT', 'SEPTIC'], noun: ['CRAWL', 'RUNNER', 'SPRAWL', 'ESCAPE'] },
  mono_ink:     { adj: ['INK', 'STARK', 'PAPER', 'BLANK'],    noun: ['LINE', 'RUN', 'EDGE', 'MARK'] },
  retro_arcade: { adj: ['PIXEL', 'TURBO', 'HYPER', 'SUPER'],  noun: ['DASH', 'BLITZ', 'RUNNER', 'ARCADE'] },
  storm_sky:    { adj: ['STORM', 'GALE', 'THUNDER', 'CLOUD'], noun: ['CHASE', 'GLIDE', 'RUNNER', 'BREAK'] },
};

const ZONE_WORDS = {
  forge_green:  ['Thicket', 'Grove', 'Hollow', 'Bramble', 'Canopy', 'Fernway', 'Rootline', 'Vine Deck'],
  neon_cyber:   ['Sector', 'Grid', 'Uplink', 'Backdoor', 'Datastream', 'Firewall', 'Nightline', 'Substation'],
  deep_space:   ['Orbit', 'Belt', 'Nebula', 'Airlock', 'Drydock', 'Far Side', 'Signal', 'Deep Field'],
  lava_forge:   ['Vent', 'Caldera', 'Ashfall', 'Flow', 'Crucible', 'Emberway', 'Slagline', 'Firecut'],
  ice_tundra:   ['Shelf', 'Crevasse', 'Whiteout', 'Floe', 'Ridge', 'Frostline', 'Snowfield', 'Blue Ice'],
  sunset_desert:['Dune', 'Wadi', 'Mesa', 'Saltflat', 'Canyon', 'Sunreach', 'Dry Wash', 'Last Well'],
  deep_ocean:   ['Shelf', 'Trench', 'Reef', 'Current', 'Kelpway', 'Dropoff', 'Blue Hole', 'Deepline'],
  candy_pop:    ['Fizz Lane', 'Sprinkle', 'Gumline', 'Frosting', 'Sherbet', 'Taffy Row', 'Jellyway', 'Sugarfall'],
  toxic_waste:  ['Runoff', 'Drum Yard', 'Seepage', 'Scrapline', 'Outflow', 'Hot Zone', 'Sludgeway', 'Containment'],
  mono_ink:     ['Margin', 'Gutter', 'Baseline', 'Crosshatch', 'Blank', 'Ruling', 'Offcut', 'Endpaper'],
  retro_arcade: ['Stage', 'Zone', 'Loop', 'Bonus', 'Warp', 'High Score', 'Coin Row', 'Level Up'],
  storm_sky:    ['Updraft', 'Cell', 'Squall', 'Downburst', 'Anvil', 'Eyewall', 'Shearline', 'Cloudbase'],
};

const INTENSITY = [
  '', '', '', 'Rising', 'Rising', 'Steady', 'Steady', 'Breather',
  'Faster', 'Faster', 'Tight', 'Tight', 'Sharp', 'Sharp', 'Relief',
  'Overdrive', 'Overdrive', 'Critical', 'No Mercy', 'Final Run',
];

function makeTitle(rng, paletteId) {
  const w = TITLE_WORDS[paletteId] ?? TITLE_WORDS.forge_green;
  return `${rng.pick(w.adj)} ${rng.pick(w.noun)}`;
}

function makeLevelNames(rng, paletteId) {
  const zones = rng.shuffle(ZONE_WORDS[paletteId] ?? ZONE_WORDS.forge_green);
  return Array.from({ length: 20 }, (_, i) => {
    const zone = zones[i % zones.length];
    const tag = INTENSITY[i];
    const base = `${zone} ${String(i + 1).padStart(2, '0')}`;
    const name = tag ? `${base} — ${tag}` : base;
    return name.slice(0, 34);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// prompt reading
// ─────────────────────────────────────────────────────────────────────────────

const HARD_WORDS = ['hard', 'harder', 'hardest', 'difficult', 'brutal', 'punishing', 'insane', 'tough', 'challenging', 'nightmare', 'mushkil'];
const EASY_WORDS = ['easy', 'easier', 'chill', 'relaxed', 'casual', 'simple', 'gentle', 'kids', 'beginner', 'asaan'];

/** Franchise/IP blocklist (§G1 stage 1 — deterministic, fast, catches most). */
const BLOCKED_TERMS = [
  'mario', 'luigi', 'bowser', 'zelda', 'link', 'pokemon', 'pikachu', 'sonic',
  'kirby', 'donkey kong', 'megaman', 'mega man', 'metroid', 'samus',
  'flappy bird', 'candy crush', 'angry birds', 'among us', 'fortnite',
  'minecraft', 'roblox', 'subway surfers', 'temple run', 'crossy road',
  'squid game', 'batman', 'spiderman', 'spider-man', 'superman', 'marvel',
  'disney', 'mickey mouse', 'star wars', 'pac-man', 'pacman', 'tetris',
  'geometry dash', 'doodle jump', 'cut the rope', 'plants vs zombies',
  'hollow knight', 'celeste', 'undertale', 'five nights',
];

export function checkBlocked(prompt) {
  const t = String(prompt || '').toLowerCase();
  const hit = BLOCKED_TERMS.find((term) => t.includes(term));
  if (!hit) return { blocked: false, reason: null };
  return {
    blocked: true,
    reason:
      `We can't build games using "${hit}" — it's a protected franchise. ` +
      `Describe your own character instead and we'll theme the whole game around it.`,
  };
}

const has = (t, words) => words.some((w) => t.includes(w));

/**
 * Genre detection by keyword. Ordered most-specific first: "memory card game" must land on
 * memory_match rather than being swallowed by the generic "game" of the runner default.
 */
const GENRE_KEYWORDS = [
  ['memory_match', ['memory', 'memory match', 'matching pairs', 'find the pair', 'card flip', 'flip cards', 'concentration', 'pairs game', 'yaddasht']],
  ['sliding_puzzle', ['sliding puzzle', 'slide puzzle', 'slider puzzle', '15 puzzle', '8 puzzle', 'tile puzzle', 'jigsaw slide', 'rearrange tiles']],
  ['merge_2048', ['2048', 'merge tiles', 'merging numbers', 'number merge', 'power of two', 'combine tiles', 'threes']],
  ['snake', ['snake', 'nokia snake', 'worm game', 'eat and grow', 'saanp']],
  ['tap_to_fly', ['tap to fly', 'flappy', 'flap', 'flying bird', 'fly through pipes', 'pipes', 'helicopter', 'jetpack', 'glider', 'gliding', 'flying game', 'urna', 'parinda']],
  ['endless_runner', ['runner', 'running', 'endless run', 'dino', 'dodge obstacles', 'auto run', 'daurna']],
];

/** Board/puzzle words that should not be mistaken for a themed runner. */
export function detectGenre(text) {
  const t = String(text || '').toLowerCase();
  for (const [genre, words] of GENRE_KEYWORDS) {
    if (has(t, words)) return genre;
  }
  return null;
}

/** Keyword classifier — mirrors the LLM classifier's output shape (§B1). */
export function classifyDeterministic(prompt, opts = {}) {
  const t = String(prompt || '').toLowerCase();
  const block = checkBlocked(prompt);
  const pal = selectPalette(t);
  const genre = opts.genre ?? detectGenre(t) ?? 'endless_runner';

  let difficultyBias = 'normal';
  if (has(t, HARD_WORDS)) difficultyBias = 'hard';
  else if (has(t, EASY_WORDS)) difficultyBias = 'easy';

  const explicitRequests = [];
  if (t.includes('double jump') || t.includes('doublejump')) explicitRequests.push('double jump');
  if (t.includes('no gap') || t.includes('without gap')) explicitRequests.push('no gaps');
  if (t.includes('no fly') || t.includes('no drone')) explicitRequests.push('no flying');

  // subject = first noun-ish token that isn't a stopword
  const STOP = new Set(['a', 'an', 'the', 'game', 'make', 'create', 'build', 'with', 'and', 'for', 'me', 'my', 'banao', 'bnao', 'ek', 'runner', 'endless', 'level', 'levels', 'hard', 'easy', 'style', 'type', 'like']);
  const subject = t.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))[0] ?? 'runner';

  return {
    genre,
    confidence: opts.genre || detectGenre(t) ? 0.86 : 0.72,
    subject,
    theme: { setting: pal.id.replace(/_/g, ' '), mood: pal.mood, paletteHint: pal.styleTags[0] ?? 'bold' },
    difficultyBias,
    explicitRequests,
    blocked: block.blocked,
    blockedReason: block.reason,
    _paletteId: pal.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// config synthesis
// ─────────────────────────────────────────────────────────────────────────────

const BIAS = {
  easy:   { speed: 0.82, gap: 1.18, growth: 0.97, curve: 'easeInQuad', target: 0.85 },
  normal: { speed: 1.0,  gap: 1.0,  growth: 1.0,  curve: 'easeInQuad', target: 1.0 },
  hard:   { speed: 1.16, gap: 0.86, growth: 1.04, curve: 'linear',     target: 1.12 },
};

/**
 * Obstacle roster. introAtLevel is staggered so a NEW obstacle lands every
 * 4-5 levels — novelty is what makes progression feel good (§C2 principle 2).
 * Every geometry here is checked against the default physics by the unit tests.
 */
function buildRoster(rng, bias, explicitRequests) {
  const noFly = explicitRequests.includes('no flying');
  const noGaps = explicitRequests.includes('no gaps');

  const roster = [
    { id: 'spike',    kind: 'ground_spike', introAtLevel: 1,  weight: 40, width: 28, height: 34, yOffset: 0,  motionAmp: 0, motionSpeed: 0 },
    { id: 'block',    kind: 'tall_block',   introAtLevel: 4,  weight: 28, width: 44, height: 60, yOffset: 0,  motionAmp: 0, motionSpeed: 0 },
    { id: 'lowbar',   kind: 'low_bar',      introAtLevel: 8,  weight: 18, width: 62, height: 22, yOffset: 66, motionAmp: 0, motionSpeed: 0 },
  ];

  if (!noGaps) {
    roster.push({ id: 'pit', kind: 'gap', introAtLevel: 11, weight: 16, width: 58, height: 20, yOffset: 0, motionAmp: 0, motionSpeed: 0 });
  }
  if (!noFly) {
    roster.push({ id: 'drone', kind: 'flying_drone', introAtLevel: 14, weight: 18, width: 34, height: 24, yOffset: 42, motionAmp: 0, motionSpeed: 0 });
  }
  roster.push({ id: 'saw', kind: 'moving_saw', introAtLevel: 17, weight: 14, width: 32, height: 30, yOffset: 14, motionAmp: 26, motionSpeed: rng.float(1.6, 2.6) });

  // A "hard" bias front-loads variety rather than inventing new obstacles.
  if (bias === 'hard') {
    for (const o of roster) {
      if (o.introAtLevel > 1) o.introAtLevel = Math.max(1, o.introAtLevel - 3);
    }
  }
  return roster;
}

// ─────────────────────────────────────────────────────────────────────────────
// per-genre section builders
// ─────────────────────────────────────────────────────────────────────────────

/** First-run hint per genre. Shown once, then faded. */
export const GENRE_TUTORIAL = {
  tap_to_fly: 'TAP or SPACE to flap',
  memory_match: 'TAP two cards to find a pair',
  sliding_puzzle: 'TAP a tile next to the gap to slide it',
  merge_2048: 'SWIPE or use ARROW KEYS to merge',
  snake: 'SWIPE or use ARROW KEYS to steer',
};

export const GENRE_LOSE = {
  tap_to_fly: 'CRASHED',
  memory_match: "TIME'S UP",
  sliding_puzzle: 'OUT OF MOVES',
  merge_2048: 'BOARD FULL',
  snake: 'CRASHED',
};

/**
 * Genre-specific config sections, derived from the difficulty bias.
 *
 * Every number here is a tuned default scaled by the bias, NOT a random roll. Randomness
 * is reserved for things that only affect variety (board dimensions within a safe band,
 * oscillation phase); anything that affects finishability is deterministic and then
 * re-checked by the genre's `repair()` + validator.
 */
export function buildGenreSections(genre, { rng, bias, palette, explicitRequests = [] }) {
  const b = BIAS[bias] ?? BIAS.normal;
  const hard = bias === 'hard';
  const easy = bias === 'easy';

  switch (genre) {
    case 'tap_to_fly':
      return {
        player: {
          flapImpulse: Math.round(300 * (easy ? 1.06 : hard ? 0.96 : 1)),
          gravity: Math.round(1100 * (hard ? 1.12 : easy ? 0.9 : 1)),
          terminalVelocity: Math.round(520 * (hard ? 1.1 : 1)),
          size: 34,
          hitboxScale: 0.78,
        },
        world: {
          groundHeight: rng.int(56, 76),
          ceilingKills: hard,
          parallax: 2,
          showStars: ['deep_space', 'neon_cyber', 'mono_ink', 'retro_arcade'].includes(palette.id),
          pipeWidth: rng.int(60, 74),
        },
        difficulty: {
          startSpeed: Math.round(165 * b.speed),
          maxSpeed: Math.round(415 * b.speed),
          curve: b.curve,
          gapHeightStart: Math.round(238 * (easy ? 1.1 : hard ? 0.92 : 1)),
          /**
           * Endgame opening. Sized so that body + flap bounce still leaves ~±35px of error
           * budget at level 20 rather than ±30. The runtime playtest bot could only clear
           * 18/20 at the tighter value, and a guarantee we cannot demonstrate is worth less
           * than the extra difficulty it buys.
           */
          gapHeightEnd: Math.round(144 * (easy ? 1.05 : hard ? 0.95 : 1)),
          spacingStart: Math.round(520 * b.gap),
          spacingEnd: Math.round(288 * b.gap),
          basePipes: 8,
          growth: Math.round(1.1 * b.growth * 1000) / 1000,
          driftStart: easy ? 0.12 : 0.18,
          driftEnd: hard ? 0.82 : 0.68,
          // Off by default. A moving gap is only fair if the player can track it, and
          // tracking under flap-only control is far harder than it looks — the playtest
          // bot proved it turns late levels unwinnable. Reserved for an explicit "hard".
          movingGapsFromLevel: hard ? 16 : 0,
        },
      };

    case 'memory_match':
      return {
        board: {
          colsStart: 3, rowsStart: 2,
          colsEnd: hard ? 8 : 6, rowsEnd: hard ? 6 : 5,
          faceCount: 24,
        },
        rules: {
          flipBackMs: hard ? 480 : easy ? 950 : 700,
          peekSeconds: easy ? 3 : hard ? 0.8 : 2,
          mismatchPenalty: hard ? 1.5 : 0,
        },
        difficulty: {
          curve: 'linear',
          timeSlackStart: easy ? 4.6 : hard ? 2.4 : 3.4,
          timeSlackEnd: easy ? 2.4 : hard ? 1.25 : 1.7,
        },
      };

    case 'sliding_puzzle':
      return {
        board: {
          sizeStart: 3,
          sizeEnd: hard ? 5 : 4,
          faceStyle: rng.chance(0.5) ? 'numbers' : 'blocks',
        },
        difficulty: {
          curve: b.curve,
          scrambleStart: easy ? 5 : hard ? 12 : 8,
          scrambleEnd: easy ? 60 : hard ? 140 : 90,
          moveSlackStart: easy ? 4.5 : hard ? 2.4 : 3.5,
          moveSlackEnd: easy ? 2.2 : hard ? 1.2 : 1.6,
        },
      };

    case 'merge_2048':
      return {
        board: {
          size: hard ? 4 : easy ? 5 : 4,
          spawnFourChance: hard ? 0.2 : easy ? 0.05 : 0.1,
        },
        difficulty: {
          curve: b.curve,
          targetStart: easy ? 16 : hard ? 64 : 32,
          targetEnd: easy ? 512 : hard ? 2048 : 1024,
          // Move limits make this genre frustrating rather than hard; leave unlimited.
          moveSlackStart: 0,
          moveSlackEnd: 0,
        },
      };

    case 'rhythm_dash': {
      // High gravity is the signature of this genre: the jump must feel like a snap, not a
      // float, or the whole thing reads as sluggish.
      const gravity = Math.round(2300 * (hard ? 1.1 : easy ? 0.92 : 1));
      const jumpVelocity = -Math.round(680 * (easy ? 1.04 : 1));
      return {
        player: { jumpVelocity, gravity, size: 36, hitboxScale: easy ? 0.74 : 0.8, rotationPerJump: 180 },
        world: {
          groundHeight: rng.int(82, 96),
          // Only carve out a ceiling if a mechanic actually needs one.
          ceilingHeight: hard ? 64 : 0,
          showGrid: true,
          parallax: 2,
          showPulse: true,
        },
        difficulty: {
          speedStart: Math.round(300 * b.speed),
          speedEnd: Math.round(545 * b.speed),
          curve: b.curve,
          chunksStart: easy ? 6 : 7,
          chunksEnd: easy ? 18 : hard ? 30 : 26,
          tierStart: 1,
          tierEnd: easy ? 3 : hard ? 5 : 4,
          breatherRatioStart: easy ? 0.5 : 0.4,
          breatherRatioEnd: easy ? 0.25 : hard ? 0.1 : 0.14,
        },
        features: {
          platformsFromLevel: 3,
          gapsFromLevel: 6,
          jumpPadsFromLevel: 9,
          // Ceiling hazards need a ceiling, and only the hard bias gives one.
          ceilingSpikesFromLevel: hard ? 13 : 0,
          gravityFlipFromLevel: 0,
        },
      };
    }

    case 'snake':
      return {
        board: {
          cols: hard ? 18 : 22,
          rows: hard ? 12 : 14,
          wrapEdges: easy || explicitRequests.includes('no walls'),
        },
        difficulty: {
          curve: b.curve,
          stepMsStart: easy ? 230 : hard ? 150 : 190,
          stepMsEnd: easy ? 130 : hard ? 70 : 95,
          foodStart: easy ? 4 : 5,
          growth: Math.round((hard ? 1.16 : 1.12) * 1000) / 1000,
          wallsStart: 0,
          wallsEnd: easy ? 6 : hard ? 26 : 16,
          growPerFood: hard ? 2 : 1,
        },
      };

    default:
      return null;
  }
}

/**
 * @param {string} prompt
 * @param {{gameId?:string, seed?:number, intent?:object, genre?:string}} [opts]
 * @returns {{config:object, intent:object, source:'deterministic'}}
 */
export function planDeterministic(prompt, opts = {}) {
  const intent = opts.intent ?? classifyDeterministic(prompt, { genre: opts.genre });
  if (intent.blocked) {
    const e = new Error(intent.blockedReason || 'Prompt blocked by content policy');
    e.code = 'PROMPT_BLOCKED';
    e.statusCode = 422;
    throw e;
  }

  const gameId = opts.gameId ?? hashSeed(prompt).toString(36);
  const seed = (opts.seed ?? hashSeed(`${prompt}:${gameId}`)) >>> 0;
  const rng = makeRng(seed);

  const paletteId = intent._paletteId ?? selectPalette(prompt).id;
  const pal = selectPalette(paletteId === 'forge_green' ? prompt : paletteId);
  const b = BIAS[intent.difficultyBias] ?? BIAS.normal;

  const genre = opts.genre ?? intent.genre ?? 'endless_runner';

  // Registry genres share meta/theme/progression/copy with the runner and differ only in
  // their own sections, so the shared half is built once here.
  if (genre !== 'endless_runner') {
    const entry = getGenre(genre);
    if (!entry) {
      const e = new Error(`"${genre}" is not an implemented genre yet.`);
      e.code = 'GENRE_NOT_IMPLEMENTED';
      e.statusCode = 422;
      throw e;
    }
    const sections = buildGenreSections(genre, {
      rng,
      bias: intent.difficultyBias,
      palette: pal,
      explicitRequests: intent.explicitRequests ?? [],
    });
    const rawGenre = {
      schemaVersion: 1,
      genre,
      meta: {
        title: makeTitle(rng, pal.id),
        tagline: entry.defaultTagline,
        packageId: packageIdFor(gameId),
        seed,
      },
      theme: {
        palette: { ...pal.palette },
        styleTags: pal.styleTags,
        mood: intent.theme?.mood ?? pal.mood,
        spritePack: null,
      },
      ...sections,
      progression: { levels: 20, mode: 'levels_only', endlessUnlockAt: 20, reliefLevels: [8, 15] },
      copy: {
        levelNames: makeLevelNames(rng, pal.id),
        tutorial: GENRE_TUTORIAL[genre] ?? 'TAP to play',
        winMsg: 'LEVEL CLEAR',
        loseMsg: GENRE_LOSE[genre] ?? 'TRY AGAIN',
        endlessMsg: 'ALL LEVELS CLEAR',
      },
    };
    const parsedGenre = safeParseAnyConfig(clampAnyConfig(rawGenre));
    if (!parsedGenre.ok) {
      const e = new Error(`deterministic planner produced an invalid ${genre} config: ${parsedGenre.errors.join('; ')}`);
      e.code = 'PLANNER_INVALID';
      throw e;
    }
    return { config: parsedGenre.config, intent: { ...intent, genre }, source: 'deterministic' };
  }

  const doubleJump =
    intent.explicitRequests.includes('double jump') ||
    (intent.difficultyBias === 'easy' && rng.chance(0.5));

  const raw = {
    schemaVersion: 1,
    genre: 'endless_runner',
    meta: {
      title: makeTitle(rng, pal.id),
      tagline: `${pal.styleTags[0] ?? 'endless'} · 20 levels · endless mode`,
      packageId: packageIdFor(gameId),
      seed,
    },
    theme: {
      palette: { ...pal.palette },
      styleTags: pal.styleTags,
      mood: intent.theme?.mood ?? pal.mood,
      spritePack: null,
    },
    player: {
      jumpVelocity: -Math.round(620 * (doubleJump ? 0.92 : 1)),
      gravity: Math.round(1750 * (intent.difficultyBias === 'hard' ? 1.08 : 1)),
      doubleJump,
      hitboxScale: 0.82,
      size: 44,
    },
    world: {
      groundHeight: rng.int(84, 108),
      parallax: 2,
      showStars: ['deep_space', 'neon_cyber', 'mono_ink', 'retro_arcade'].includes(pal.id),
    },
    difficulty: {
      startSpeed: Math.round(250 * b.speed),
      maxSpeed: Math.round(860 * b.speed),
      curve: b.curve,
      spawnGapStart: Math.round(1750 * b.gap),
      spawnGapEnd: Math.round(640 * b.gap),
      baseTarget: Math.round(280 * b.target),
      growth: Math.round(1.08 * b.growth * 1000) / 1000,
    },
    obstacles: buildRoster(rng, intent.difficultyBias, intent.explicitRequests),
    progression: {
      levels: 20,
      mode: 'hybrid',
      endlessUnlockAt: 20,
      reliefLevels: [8, 15],
    },
    copy: {
      levelNames: makeLevelNames(rng, pal.id),
      tutorial: doubleJump ? 'TAP to jump · TAP again in mid-air' : 'TAP or SPACE to jump',
      winMsg: 'LEVEL CLEAR',
      loseMsg: 'CRASHED',
      endlessMsg: 'ENDLESS MODE UNLOCKED',
    },
  };

  // Validate our own output. The planner used to return an unparsed config, so a
  // schema violation it introduced stayed invisible until the user's first refine.
  // Failing here instead makes it a build-time bug rather than a runtime surprise.
  const parsed = safeParseGameConfig(clampNumbers(raw));
  if (!parsed.ok) {
    const e = new Error(`deterministic planner produced an invalid config: ${parsed.errors.join('; ')}`);
    e.code = 'PLANNER_INVALID';
    throw e;
  }
  return { config: parsed.config, intent, source: 'deterministic' };
}
