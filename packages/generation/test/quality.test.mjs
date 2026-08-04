/**
 * The product guarantee, enforced in CI.
 *
 * If this file goes red, the platform is shipping unbeatable levels — which is
 * the one failure players never forgive. Treat a failure here as release-blocking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGame } from '../src/index.mjs';
import { planDeterministic } from '../../ai/src/planner.mjs';

// Every prompt here is pinned to endless_runner: this file tests the RUNNER's guarantees,
// and some of these prompts (a gliding paper plane, for one) now legitimately classify as a
// different genre.
import { DENSITY_MAX } from '../src/validator.mjs';

const PROMPTS = [
  'neon cyberpunk runner with a robot',
  'underwater coral reef dash',
  'lava volcano escape, make it hard',
  'calm minimal monochrome runner',
  'space station orbital drift',
  'jungle vine sprint',
  'arctic glacier slide, easy',
  'desert dune crossing at sunset',
  'toxic sewer mutant crawl',
  'retro 8bit arcade blitz',
  'thunderstorm sky glide',
  'sweet pastel dessert hop',
  'dark tense industrial runner, brutal difficulty',
  'playful cute runner for kids',
  'fast paced neon grid escape with double jump',
  'forest runner no gaps',
  'space runner no flying enemies',
  'ek tez runner banao neon style',
  'mushkil jungle runner',
  'asaan bacchon ka runner',
  'a paper plane gliding through blank pages',
  'volcano descent with moving saws',
  'ocean trench submarine run',
  'cyber ninja rooftop chase',
  'frozen tundra penguin escape',
  'radioactive wasteland scramble',
  'vaporwave sunset drive',
  'stormy cloudbase runner tense',
  'candy free sugar rush pastel',
  'ink sketch line runner minimal',
  'emerald canopy leap',
  'magma crucible sprint hardest',
  'starfield nebula vector run',
  'saltflat mirage haul',
  'kelp forest current dive',
  'firewall datastream breach',
  'blizzard whiteout ridge run',
  'pixel turbo hyper dash',
  'gale force updraft chase',
  'rootline bramble hollow run',
];

test('every level of every generated game passes validation', () => {
  const failures = [];

  for (const prompt of PROMPTS) {
    const { config } = planDeterministic(prompt, { genre: 'endless_runner' });
    const { levels, validation, report } = buildGame(config);

    if (levels.length !== 20) {
      failures.push(`"${prompt}": built ${levels.length}/20 levels — ${report.fatals.join('; ')}`);
      continue;
    }
    if (!validation.ok) {
      const detail = validation.perLevel
        .filter((r) => !r.ok)
        .map((r) => `L${r.level}: ${r.reasons.join(' | ')}`)
        .join('\n    ');
      failures.push(`"${prompt}" (${config.meta.title}):\n    ${detail}${validation.curveIssues.length ? '\n    curve: ' + validation.curveIssues.join('; ') : ''}`);
    }
  }

  assert.equal(
    failures.length,
    0,
    `\n${failures.length}/${PROMPTS.length} games produced invalid levels:\n\n${failures.join('\n\n')}\n`
  );
});

test('difficulty rises across the 20 levels', () => {
  for (const prompt of PROMPTS.slice(0, 12)) {
    const { config } = planDeterministic(prompt, { genre: 'endless_runner' });
    const { validation } = buildGame(config);
    const scores = validation.difficultyScores;

    assert.ok(
      scores.at(-1) > scores[0] + 15,
      `"${prompt}": level 20 (${scores.at(-1)}) must be clearly harder than level 1 (${scores[0]})`
    );
    assert.equal(validation.curveIssues.length, 0, `"${prompt}": ${validation.curveIssues.join('; ')}`);
  }
});

test('relief levels are genuinely easier than their neighbours', () => {
  const { config } = planDeterministic('neon cyberpunk runner');
  const { validation } = buildGame(config);
  const s = validation.difficultyScores;
  for (const lv of config.progression.reliefLevels) {
    const i = lv - 1;
    if (i <= 0 || i >= s.length - 1) continue;
    assert.ok(
      s[i] <= s[i - 1],
      `relief level ${lv} (${s[i]}) should not be harder than level ${lv - 1} (${s[i - 1]})`
    );
  }
});

test('level 1 is gentle — low speed, generous runway, sparse obstacles', () => {
  for (const prompt of PROMPTS.slice(0, 10)) {
    const { config } = planDeterministic(prompt, { genre: 'endless_runner' });
    const { levels, validation } = buildGame(config);
    const l1 = levels[0];
    const m = validation.perLevel[0].metrics;

    assert.ok(l1.speed <= 320, `"${prompt}": level 1 speed ${l1.speed} is too fast for onboarding`);
    assert.ok(m.reactionSeconds >= 1.6, `"${prompt}": only ${m.reactionSeconds}s to read level 1`);
    assert.ok(m.density < DENSITY_MAX * 0.7, `"${prompt}": level 1 density ${m.density} too busy`);
    assert.ok(
      l1.pattern.every((p) => l1.rosterIds.includes(p.obstacleId)),
      `"${prompt}": level 1 placed an obstacle that is not in its own roster`
    );
  }
});

test('a new obstacle type is introduced at a steady cadence', () => {
  const { config } = planDeterministic('neon cyberpunk runner');
  const intros = [...new Set(config.obstacles.map((o) => o.introAtLevel))].sort((a, b) => a - b);
  assert.ok(intros.length >= 4, 'expected at least 4 distinct introduction points');
  assert.equal(intros[0], 1, 'something must be available at level 1');
  for (let i = 1; i < intros.length; i++) {
    assert.ok(intros[i] - intros[i - 1] <= 6, `gap of ${intros[i] - intros[i - 1]} levels between new obstacles is too long`);
  }
});

test('level durations stay inside the playable band', () => {
  for (const prompt of PROMPTS.slice(0, 15)) {
    const { config } = planDeterministic(prompt, { genre: 'endless_runner' });
    const { levels } = buildGame(config);
    for (const l of levels) {
      assert.ok(l.estSeconds >= 15 && l.estSeconds <= 90, `"${prompt}" L${l.index}: ${l.estSeconds}s is outside 15-90s`);
    }
  }
});

test('a deliberately broken config is caught rather than shipped', () => {
  const { config } = planDeterministic('neon runner');
  const broken = structuredClone(config);
  // a wall taller than any possible jump
  broken.obstacles = [
    { id: 'wall', kind: 'tall_block', introAtLevel: 1, weight: 100, width: 40, height: 140, yOffset: 90, motionAmp: 0, motionSpeed: 0 },
    { id: 'wall2', kind: 'tall_block', introAtLevel: 2, weight: 50, width: 40, height: 140, yOffset: 90, motionAmp: 0, motionSpeed: 0 },
  ];
  const { report } = buildGame(broken);
  assert.equal(report.ok, false, 'an unclearable roster must not produce a shippable game');
  assert.ok(report.fatals.length > 0, 'the failure must be reported with a reason');
});
