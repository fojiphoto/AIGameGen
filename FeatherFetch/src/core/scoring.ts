/**
 * Score, combo, accuracy and achievements.
 *
 * Pure arithmetic over a small state object, deliberately: scoring is the thing players argue
 * with, so every bonus has to be explainable in one line and reproducible in a test. Nothing
 * here reads a clock or a canvas.
 *
 * The design principle throughout is that the score should reward *aim*, not persistence. A
 * player who hits everything with the first shell out-scores one who sprays three shells at each
 * duck by a wide margin, and the combo multiplier is what does most of that work.
 */

import {
  comboMultiplier, PERFECT_ROUND_BONUS, FIRST_SHELL_BONUS, UNUSED_SHELL_BONUS, SHELLS,
} from './config.js';
import { DuckType } from './ducks.js';

export interface Stats {
  score: number;
  ducksHit: number;
  ducksEscaped: number;
  shotsFired: number;
  shotsHit: number;
  bestCombo: number;
  combo: number;
  perfectRounds: number;
  rareDucks: number;
  misses: number;
}

export const emptyStats = (): Stats => ({
  score: 0, ducksHit: 0, ducksEscaped: 0, shotsFired: 0, shotsHit: 0,
  bestCombo: 0, combo: 0, perfectRounds: 0, rareDucks: 0, misses: 0,
});

export const accuracyOf = (s: { shotsFired: number; shotsHit: number }): number =>
  s.shotsFired === 0 ? 0 : s.shotsHit / s.shotsFired;

export interface HitAward {
  points: number;
  /** Parts of the award, so the pop-up can explain itself. */
  base: number;
  comboMult: number;
  firstShell: boolean;
  /** A short line shown over the duck: 'PERFECT SHOT', 'x3', 'GILDED DUCK'. */
  label: string;
}

/**
 * Award for hitting a duck.
 *
 * Three components: the duck's own worth, a first-shell bonus, and the combo multiplier applied
 * to the total. The multiplier last is what makes a long streak feel exponential rather than
 * additive — which is the whole reason to chase one.
 */
export function awardHit(
  type: DuckType, shellsUsedThisDuck: number, streakBefore: number
): HitAward {
  const firstShell = shellsUsedThisDuck <= 1;
  const base = type.score + (firstShell ? FIRST_SHELL_BONUS : 0);
  const comboMult = comboMultiplier(streakBefore + 1);
  const points = Math.round(base * comboMult);

  let label: string;
  if (type.rare) label = type.name.toUpperCase();
  else if (streakBefore + 1 >= 3) label = `x${comboMult % 1 === 0 ? comboMult : comboMult.toFixed(2)}`;
  else if (firstShell) label = 'PERFECT SHOT';
  else label = `+${points}`;

  return { points, base, comboMult, firstShell, label };
}

export interface RoundSummary {
  round: number;
  ducksHit: number;
  ducksTotal: number;
  shotsFired: number;
  accuracy: number;
  bestCombo: number;
  shellsUnused: number;
  perfect: boolean;
  bonus: number;
  roundScore: number;
}

/**
 * Score a completed round.
 *
 * A perfect round — every duck hit — is worth more than any individual bonus, because it is the
 * thing worth chasing and because "I hit all eight" should feel different from "I hit seven and
 * got lucky on the last one".
 */
export function summariseRound(
  round: number, ducksHit: number, ducksTotal: number,
  shotsFired: number, bestCombo: number, shellsUnused: number, roundScore: number
): RoundSummary {
  const perfect = ducksHit === ducksTotal && ducksTotal > 0;
  let bonus = shellsUnused * UNUSED_SHELL_BONUS;
  if (perfect) bonus += PERFECT_ROUND_BONUS;
  return {
    round, ducksHit, ducksTotal, shotsFired,
    accuracy: shotsFired === 0 ? 0 : ducksHit / shotsFired,
    bestCombo, shellsUnused, perfect, bonus,
    roundScore: roundScore + bonus,
  };
}

// ── achievements ────────────────────────────────────────────────────────────

export interface Achievement {
  id: string;
  name: string;
  hint: string;
  /** Evaluated against the lifetime totals plus the run that just finished. */
  test: (totals: Totals, run: Stats) => boolean;
}

export interface Totals {
  ducksHit: number;
  ducksEscaped: number;
  shotsFired: number;
  shotsHit: number;
  bestCombo: number;
  perfectRounds: number;
  rareDucks: number;
  highScore: number;
  bestAccuracy: number;
  roundsCleared: number;
  playMs: number;
  gamesPlayed: number;
}

export const emptyTotals = (): Totals => ({
  ducksHit: 0, ducksEscaped: 0, shotsFired: 0, shotsHit: 0, bestCombo: 0,
  perfectRounds: 0, rareDucks: 0, highScore: 0, bestAccuracy: 0,
  roundsCleared: 0, playMs: 0, gamesPlayed: 0,
});

/**
 * Achievements, named to fit the game rather than borrowed.
 *
 * Every one is checkable from the totals, which means none of them can be awarded by accident
 * and all of them can be tested.
 */
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first', name: 'First Feather', hint: 'Hit your first duck',
    test: (t) => t.ducksHit >= 1 },
  { id: 'ten', name: 'Getting the Eye', hint: 'Hit 10 ducks',
    test: (t) => t.ducksHit >= 10 },
  { id: 'hundred', name: 'Season Regular', hint: 'Hit 100 ducks',
    test: (t) => t.ducksHit >= 100 },
  { id: 'perfect', name: 'Clean Sweep', hint: 'Clear a round without missing a duck',
    test: (t) => t.perfectRounds >= 1 },
  { id: 'accuracy', name: 'Steady Hands', hint: 'Finish a run at 90% accuracy',
    test: (t) => t.bestAccuracy >= 0.9 },
  { id: 'combo', name: 'On a Roll', hint: 'Reach a streak of 10',
    test: (t) => t.bestCombo >= 10 },
  { id: 'gilded', name: 'Gilded', hint: 'Bring down a Gilded Duck',
    test: (t) => t.rareDucks >= 1 },
  { id: 'rare5', name: 'Trophy Wall', hint: 'Bring down 15 rare ducks',
    test: (t) => t.rareDucks >= 15 },
  { id: 'round10', name: 'Long Afternoon', hint: 'Clear 10 rounds in one run',
    test: (_t, run) => run.perfectRounds + 0 >= 0 && _t.roundsCleared >= 10 },
  { id: 'score', name: 'Master Hunter', hint: 'Score 50,000 in a single run',
    test: (t) => t.highScore >= 50_000 },
];

/** Which achievements are newly earned, given what was already unlocked. */
export function newlyEarned(
  totals: Totals, run: Stats, already: string[]
): Achievement[] {
  return ACHIEVEMENTS.filter((a) => !already.includes(a.id) && a.test(totals, run));
}

// ── unlocks ─────────────────────────────────────────────────────────────────

export interface Cosmetic {
  id: string;
  name: string;
  blurb: string;
  /** How it is earned. */
  need: { kind: 'default' } | { kind: 'ducks'; count: number }
    | { kind: 'score'; count: number } | { kind: 'rare'; count: number }
    | { kind: 'rounds'; count: number };
}

/** Dog bandanas — cosmetic only, and all keep the same silhouette. */
export const DOG_SKINS: (Cosmetic & { color: string })[] = [
  { id: 'red', name: 'Red Bandana', blurb: 'How Biscuit turned up.', color: '#e2503f',
    need: { kind: 'default' } },
  { id: 'blue', name: 'River Blue', blurb: 'For the lake days.', color: '#3f86e2',
    need: { kind: 'ducks', count: 25 } },
  { id: 'green', name: 'Meadow Green', blurb: 'Blends into the grass. Biscuit does not.', color: '#4fa83f',
    need: { kind: 'ducks', count: 75 } },
  { id: 'gold', name: 'Gold Trim', blurb: 'Earned the hard way.', color: '#f0c04a',
    need: { kind: 'rare', count: 10 } },
  { id: 'plaid', name: 'Autumn Plaid', blurb: 'Season appropriate.', color: '#c9713a',
    need: { kind: 'rounds', count: 15 } },
  { id: 'violet', name: 'Dusk Violet', blurb: 'For the marsh at sunset.', color: '#8a5fd0',
    need: { kind: 'score', count: 30_000 } },
];

/** Weapon finishes — reload speed is identical; only the look changes. */
export const WEAPON_SKINS: (Cosmetic & { barrel: string; stock: string })[] = [
  { id: 'classic', name: 'Field Classic', blurb: 'Walnut and blued steel.',
    barrel: '#5a6068', stock: '#8a5a34', need: { kind: 'default' } },
  { id: 'forest', name: 'Forest', blurb: 'Green stock, worn edges.',
    barrel: '#4a5450', stock: '#3f6a44', need: { kind: 'ducks', count: 40 } },
  { id: 'gold', name: 'Gilded', blurb: 'More for show than for shooting.',
    barrel: '#d9a93a', stock: '#7a4a20', need: { kind: 'score', count: 20_000 } },
  { id: 'frost', name: 'Frostline', blurb: 'Pale and cold.',
    barrel: '#9fb6c8', stock: '#5a6f80', need: { kind: 'rounds', count: 10 } },
  { id: 'ember', name: 'Ember', blurb: 'Warm metal, dark grain.',
    barrel: '#b05a30', stock: '#3a2a24', need: { kind: 'rare', count: 20 } },
];

export function cosmeticUnlocked(need: Cosmetic['need'], t: Totals): boolean {
  switch (need.kind) {
    case 'default': return true;
    case 'ducks': return t.ducksHit >= need.count;
    case 'score': return t.highScore >= need.count;
    case 'rare': return t.rareDucks >= need.count;
    case 'rounds': return t.roundsCleared >= need.count;
  }
}

export function cosmeticHint(need: Cosmetic['need']): string {
  switch (need.kind) {
    case 'default': return '';
    case 'ducks': return `Hit ${need.count} ducks`;
    case 'score': return `Score ${need.count.toLocaleString()}`;
    case 'rare': return `Bring down ${need.count} rare ducks`;
    case 'rounds': return `Clear ${need.count} rounds`;
  }
}

export { SHELLS };
