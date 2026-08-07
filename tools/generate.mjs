#!/usr/bin/env node
/**
 * End-to-end generation CLI.
 *
 *   node tools/generate.mjs "neon cyberpunk runner with a robot"
 *   node tools/generate.mjs "lava escape, hard" --deterministic --out artifacts/lava
 *
 * Runs the exact pipeline the API runs, so anything that works here works in
 * production and vice versa.
 */

import { plan } from '@forge/ai';
import { buildAnyGame as buildGame } from '@forge/generation/genres';
import { bundleGame } from '@forge/bundler';
import { hashSeed } from '@forge/generation';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const outFlagIdx = argv.indexOf('--out');
const outOverride = outFlagIdx >= 0 ? argv[outFlagIdx + 1] : null;
const genreFlagIdx = argv.indexOf('--genre');
const genreOverride = genreFlagIdx >= 0 ? argv[genreFlagIdx + 1] : null;

const prompt = positional.filter((p) => p !== outOverride && p !== genreOverride).join(' ') || 'neon cyberpunk runner with a robot';
const deterministic = flags.has('--deterministic');
const quiet = flags.has('--quiet');

const log = (...a) => !quiet && console.log(...a);
const t0 = Date.now();

log(`\n\x1b[1mFORGE — generate\x1b[0m`);
log(`prompt: "${prompt}"\n`);

// ── 1. plan ─────────────────────────────────────────────────────────────────
const tPlan = Date.now();
let planned;
try {
  planned = await plan(prompt, { forceDeterministic: deterministic, genre: genreOverride ?? undefined });
} catch (err) {
  if (err.code === 'PROMPT_BLOCKED') {
    console.error(`\x1b[31m✖ blocked:\x1b[0m ${err.message}`);
    process.exit(2);
  }
  throw err;
}
const { config, source, usage, notes } = planned;
log(`\x1b[32m✓\x1b[0m plan            ${source.padEnd(14)} ${Date.now() - tPlan}ms`);
for (const n of notes ?? []) log(`  \x1b[33m!\x1b[0m ${n}`);
if (usage?.length) {
  const cost = usage.reduce((s, u) => s + (u.costUsd ?? 0), 0);
  const tok = usage.reduce((s, u) => s + u.outputTokens, 0);
  log(`  tokens out ${tok}  ·  est $${cost.toFixed(4)}`);
}

// ── 2. build + validate levels ──────────────────────────────────────────────
const tBuild = Date.now();
const { levels, validation, ladder, report } = buildGame(config);
if (!report.ok) {
  console.error(`\x1b[31m✖ generation failed\x1b[0m`);
  for (const f of report.fatals) console.error(`   ${f}`);
  for (const c of validation.curveIssues) console.error(`   curve: ${c}`);
  process.exit(1);
}
log(`\x1b[32m✓\x1b[0m levels          ${report.levelsBuilt}/${report.levelsRequested} valid    ${Date.now() - tBuild}ms`);
log(`\x1b[32m✓\x1b[0m validated       ${report.totalObstacles} obstacles, all beatable`);
if (report.levelsNeedingRetry.length) log(`  \x1b[33m!\x1b[0m re-seeded: L${report.levelsNeedingRetry.join(', L')}`);
if (report.levelsRelaxed.length) log(`  \x1b[33m!\x1b[0m relaxed:   L${report.levelsRelaxed.join(', L')}`);

// ── 3. bundle ───────────────────────────────────────────────────────────────
const gameId = hashSeed(`${prompt}:${config.genre}`).toString(36);
const outDir = resolve(outOverride ?? join('artifacts', gameId, 'bundle'));
const tBundle = Date.now();
const bundle = await bundleGame({ config, levels, outDir });
log(`\x1b[32m✓\x1b[0m bundled         ${(bundle.totalBytes / 1024).toFixed(0)} KB        ${Date.now() - tBundle}ms`);

// keep the inputs beside the output so any build is reproducible
await mkdir(resolve(outDir, '..'), { recursive: true });
await writeFile(resolve(outDir, '..', 'config.json'), JSON.stringify(config, null, 2));
await writeFile(
  resolve(outDir, '..', 'report.json'),
  JSON.stringify({ prompt, source, report, ladder, notes }, null, 2)
);

// ── summary ─────────────────────────────────────────────────────────────────
log(`\n\x1b[1m${config.meta.title}\x1b[0m — ${config.meta.tagline}`);
log(`genre    ${config.genre}`);
log(`package  ${config.meta.packageId}`);
log(`seed     ${config.meta.seed}   ·   palette ${config.theme.palette.bg} / ${config.theme.palette.player}`);
log(`playtime ~${report.estTotalMinutes} min across ${config.progression.levels} levels`);
if (config.obstacles) {
  log(`obstacles ${config.obstacles.map((o) => `${o.id}@L${o.introAtLevel}`).join('  ')}`);
}

// The ladder is genre-shaped: a runner level is metres and obstacles, a puzzle level is a
// scramble depth and a move budget. `ladder[].label` is each genre's own summary.
log(`\n\x1b[2mlevel  what it asks                          secs  diff\x1b[0m`);
for (const l of levels) {
  const v = validation.perLevel.find((p) => p.level === l.index);
  const diff = v?.metrics.estimatedDifficulty ?? 0;
  const rung = ladder.find((r) => r.level === l.index);
  const label =
    rung?.label ??
    (l.targetMetres !== undefined ? `${l.targetMetres} m · ${l.pattern?.length ?? 0} obstacles` : `level ${l.index}`);
  const tag = l.isRelief
    ? '\x1b[36mrelief\x1b[0m'
    : l.newObstacleIds?.length
      ? `\x1b[33m+${l.newObstacleIds.join(',')}\x1b[0m`
      : '';
  log(
    `${String(l.index).padStart(4)}  ` +
      `${String(label).padEnd(38).slice(0, 38)}  ` +
      `${String(l.estSeconds).padStart(4)}  ` +
      `${String(diff).padStart(4)}  ` +
      `\x1b[2m${'█'.repeat(Math.round(diff / 6)).padEnd(17)}\x1b[0m ${tag}`
  );
}

log(`\n\x1b[32m✓ done in ${Date.now() - t0}ms\x1b[0m`);
log(`  bundle → ${outDir}`);
log(`  play   → npx serve "${outDir}"  (or use tools/serve.mjs)\n`);

// machine-readable tail for the APK tool / CI
if (flags.has('--json')) {
  console.log(JSON.stringify({ gameId, outDir, config, report }, null, 2));
}
