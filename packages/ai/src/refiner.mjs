/**
 * Deterministic refinement (§B7, no-API-key path).
 *
 * Without this, "make it harder" is a paid feature — which for a zero-budget launch
 * means the product's best interaction is broken for every free user. So the rule-based
 * refiner is not a downgrade of the LLM path, it is the default one.
 *
 * It emits the SAME RFC-6902 patch shape the model emits, so downstream code (clamp →
 * validate → rebuild → reject-if-unbeatable) is identical for both paths.
 *
 * Multiple intents in one instruction are supported and composed:
 *   "make it harder and change to space theme with double jump"
 */

import { selectPalette, PALETTES } from './palettes.mjs';

const has = (t, words) => words.some((w) => t.includes(w));
const round = (n, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Roman Urdu terms appear in real prompts from this user base, so match them too. */
const HARDER = ['harder', 'hard', 'difficult', 'tough', 'brutal', 'punishing', 'insane', 'mushkil', 'sakht'];
const EASIER = ['easier', 'easy', 'simpler', 'gentle', 'chill', 'relaxed', 'forgiving', 'asaan', 'aasan'];
const FASTER = ['faster', 'fast', 'quicker', 'speed up', 'tez', 'speedier'];
const SLOWER = ['slower', 'slow', 'slow down', 'ahista'];
const LONGER = ['longer', 'long levels', 'bigger levels', 'more distance', 'lamba'];
const SHORTER = ['shorter', 'short levels', 'quicker levels', 'less distance', 'chota'];
const BUSIER = ['more obstacles', 'busier', 'denser', 'more stuff', 'crowded', 'zyada'];
const SPARSER = ['fewer obstacles', 'less obstacles', 'sparser', 'emptier', 'kam obstacles'];
const HIGHER_JUMP = ['higher jump', 'jump higher', 'bigger jump', 'floaty', 'more air'];
const LOWER_JUMP = ['lower jump', 'jump lower', 'smaller jump', 'snappier', 'less air'];

const clampRange = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {object} config current validated GameConfig
 * @param {string} instruction natural-language tweak
 * @returns {{patch:Array, summary:string, matched:boolean}}
 */
export function planRefinement(config, instruction) {
  const t = String(instruction || '').toLowerCase().trim();
  const patch = [];
  const notes = [];
  const d = config.difficulty;
  const pl = config.player;

  // ── difficulty ────────────────────────────────────────────────────────────
  const wantsHarder = has(t, HARDER) || has(t, FASTER);
  const wantsEasier = has(t, EASIER) || has(t, SLOWER);

  if (wantsHarder && !wantsEasier) {
    patch.push({ op: 'replace', path: '/difficulty/maxSpeed', value: round(clampRange(d.maxSpeed * 1.15, 430, 1150)) });
    patch.push({ op: 'replace', path: '/difficulty/startSpeed', value: round(clampRange(d.startSpeed * 1.08, 140, 420)) });
    patch.push({ op: 'replace', path: '/difficulty/spawnGapEnd', value: round(clampRange(d.spawnGapEnd * 0.88, 420, 880)) });
    if (d.curve === 'easeInQuad') patch.push({ op: 'replace', path: '/difficulty/curve', value: 'linear' });
    notes.push('harder — faster top speed, tighter obstacle spacing');
  } else if (wantsEasier && !wantsHarder) {
    patch.push({ op: 'replace', path: '/difficulty/maxSpeed', value: round(clampRange(d.maxSpeed * 0.86, 430, 1150)) });
    patch.push({ op: 'replace', path: '/difficulty/startSpeed', value: round(clampRange(d.startSpeed * 0.9, 140, 420)) });
    patch.push({ op: 'replace', path: '/difficulty/spawnGapEnd', value: round(clampRange(d.spawnGapEnd * 1.14, 420, 880)) });
    patch.push({ op: 'replace', path: '/difficulty/spawnGapStart', value: round(clampRange(d.spawnGapStart * 1.08, 900, 2600)) });
    if (d.curve === 'linear') patch.push({ op: 'replace', path: '/difficulty/curve', value: 'easeInQuad' });
    notes.push('easier — lower top speed, more room between obstacles');
  }

  // ── level length ──────────────────────────────────────────────────────────
  if (has(t, LONGER)) {
    patch.push({ op: 'replace', path: '/difficulty/baseTarget', value: round(clampRange(d.baseTarget * 1.3, 120, 700)) });
    notes.push('longer levels');
  } else if (has(t, SHORTER)) {
    patch.push({ op: 'replace', path: '/difficulty/baseTarget', value: round(clampRange(d.baseTarget * 0.72, 120, 700)) });
    notes.push('shorter levels');
  }

  // ── density ───────────────────────────────────────────────────────────────
  if (has(t, BUSIER)) {
    patch.push({ op: 'replace', path: '/difficulty/spawnGapStart', value: round(clampRange(d.spawnGapStart * 0.85, 900, 2600)) });
    patch.push({ op: 'replace', path: '/difficulty/spawnGapEnd', value: round(clampRange(d.spawnGapEnd * 0.9, 420, 880)) });
    notes.push('more obstacles');
  } else if (has(t, SPARSER)) {
    patch.push({ op: 'replace', path: '/difficulty/spawnGapStart', value: round(clampRange(d.spawnGapStart * 1.2, 900, 2600)) });
    patch.push({ op: 'replace', path: '/difficulty/spawnGapEnd', value: round(clampRange(d.spawnGapEnd * 1.12, 420, 880)) });
    notes.push('fewer obstacles');
  }

  // ── jump feel ─────────────────────────────────────────────────────────────
  if (has(t, HIGHER_JUMP)) {
    patch.push({ op: 'replace', path: '/player/jumpVelocity', value: round(clampRange(pl.jumpVelocity * 1.12, -1200, -260)) });
    patch.push({ op: 'replace', path: '/player/gravity', value: round(clampRange(pl.gravity * 0.9, 700, 3200)) });
    notes.push('higher, floatier jump');
  } else if (has(t, LOWER_JUMP)) {
    patch.push({ op: 'replace', path: '/player/jumpVelocity', value: round(clampRange(pl.jumpVelocity * 0.9, -1200, -260)) });
    patch.push({ op: 'replace', path: '/player/gravity', value: round(clampRange(pl.gravity * 1.12, 700, 3200)) });
    notes.push('snappier jump');
  }

  // ── double jump ───────────────────────────────────────────────────────────
  if (/\b(no|remove|disable|without)\b[^.]{0,20}double\s*jump/.test(t)) {
    if (pl.doubleJump) {
      patch.push({ op: 'replace', path: '/player/doubleJump', value: false });
      notes.push('double jump off');
    }
  } else if (/double\s*jump/.test(t)) {
    if (!pl.doubleJump) {
      patch.push({ op: 'replace', path: '/player/doubleJump', value: true });
      patch.push({ op: 'replace', path: '/copy/tutorial', value: 'TAP to jump · TAP again in mid-air' });
      notes.push('double jump on');
    }
  }

  // ── obstacle roster ───────────────────────────────────────────────────────
  // Rebuilt as a whole array rather than by index: index-based removal patches break
  // as soon as two of them apply in the same instruction.
  const removeKinds = new Set();
  if (/\b(no|remove|without)\b[^.]{0,20}(gap|pit|hole)/.test(t)) removeKinds.add('gap');
  if (/\b(no|remove|without)\b[^.]{0,20}(fly|flying|drone|air)/.test(t)) removeKinds.add('flying_drone');
  if (/\b(no|remove|without)\b[^.]{0,20}(saw|blade|spinning)/.test(t)) removeKinds.add('moving_saw');
  if (/\b(no|remove|without)\b[^.]{0,20}(bar|duck|slide)/.test(t)) removeKinds.add('low_bar');

  if (removeKinds.size) {
    const kept = config.obstacles.filter((o) => !removeKinds.has(o.kind));
    // the schema requires >= 2 obstacles with at least one at level 1
    if (kept.length >= 2) {
      if (!kept.some((o) => o.introAtLevel === 1)) kept[0] = { ...kept[0], introAtLevel: 1 };
      patch.push({ op: 'replace', path: '/obstacles', value: kept });
      notes.push(`removed ${[...removeKinds].join(', ')}`);
    } else {
      notes.push(`kept ${[...removeKinds].join(', ')} — removing them would leave too few obstacles`);
    }
  }

  // ── theme ─────────────────────────────────────────────────────────────────
  // Only re-theme on an explicit colour/theme word, so "make it harder" cannot silently
  // repaint a game the user was happy with.
  const themeAsked = /\b(theme|colou?r|palette|look|style|vibe|skin|repaint)\b/.test(t) || namedTheme(t);
  if (themeAsked) {
    const pal = selectPalette(t);
    const differs = pal.palette.bg !== config.theme.palette.bg;
    if (differs) {
      patch.push({ op: 'replace', path: '/theme/palette', value: { ...pal.palette } });
      patch.push({ op: 'replace', path: '/theme/styleTags', value: pal.styleTags });
      patch.push({ op: 'replace', path: '/world/showStars', value: ['deep_space', 'neon_cyber', 'mono_ink', 'retro_arcade'].includes(pal.id) });
      notes.push(`re-themed to ${pal.id.replace(/_/g, ' ')}`);
    }
  }

  // ── rename ────────────────────────────────────────────────────────────────
  const rename = t.match(/(?:call it|rename (?:it )?to|name it|title)\s+["']?([a-z0-9 \-]{2,30})["']?/i);
  if (rename) {
    const title = rename[1].trim().toUpperCase().slice(0, 40);
    if (title) {
      patch.push({ op: 'replace', path: '/meta/title', value: title });
      notes.push(`renamed to ${title}`);
    }
  }

  return {
    patch,
    summary: notes.length ? notes.join('; ') : 'No change — that instruction was not recognised.',
    matched: patch.length > 0,
  };
}

/** Does the instruction name one of the curated palettes by keyword? */
function namedTheme(t) {
  return PALETTES.some((pal) => pal.keywords.some((k) => k !== 'default' && k.length >= 4 && t.includes(k)));
}

/** Human-readable list of what the deterministic refiner understands, for the UI. */
export const REFINE_EXAMPLES = [
  'make it harder',
  'make it easier',
  'change to space theme',
  'add double jump',
  'more obstacles',
  'longer levels',
  'no gaps',
  'higher jump',
  'call it VOID RUNNER',
];
