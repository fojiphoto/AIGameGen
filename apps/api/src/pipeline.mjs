/**
 * The generate / refine / build pipelines, with credits and persistence attached.
 *
 * Credit rule, applied everywhere: **check the balance up front, charge only after the
 * work succeeded, and charge inside the same transaction that records the work.** A user
 * must never pay for a game they did not get. Where a charge happens before an
 * unavoidably-external step (the APK build), a failure refunds in full.
 */

import { plan, refine } from '@forge/ai';
import { hashSeed } from '@forge/generation';
import { buildAnyGame as buildGame } from '@forge/generation/genres';
import { bundleGame } from '@forge/bundler';
import { packageIdFor } from '@forge/schema';
import * as db from '@forge/db';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export const ARTIFACTS = resolve(process.env.ARTIFACTS_DIR || 'artifacts');
export const gameDir = (id) => join(ARTIFACTS, id);
export const bundleDir = (id) => join(ARTIFACTS, id, 'bundle');

/**
 * Mirror the config and report to disk next to the bundle.
 *
 * The database is the source of truth, but `tools/build-apk.mjs` is a standalone CLI —
 * it must work when run by hand or by a CI worker that has no database access. Writing
 * these two files keeps that contract, and doubles as a reproducibility record.
 */
async function writeSidecars(id, config, report, ladder) {
  const dir = gameDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  await writeFile(join(dir, 'report.json'), JSON.stringify({ report, ladder }, null, 2));
}

/** Throws 402 before any expensive work if the user cannot afford it. */
export function ensureAffordable(user, action) {
  if (!user) return; // anonymous work is rate-limited instead of charged
  const cost = db.CREDIT_COSTS[action];
  if (!cost) return;
  const balance = db.getBalance(user.id);
  if (balance < cost) {
    const e = new Error(`This costs ${cost} credits and you have ${balance}.`);
    e.code = 'INSUFFICIENT_CREDITS';
    e.statusCode = 402;
    e.required = cost;
    e.balance = balance;
    throw e;
  }
}

const logUsage = (usage, userId, gameId, prompt) => {
  for (const u of usage ?? []) {
    db.logGeneration({
      userId, gameId, stage: u.stage, model: u.model, prompt,
      inTokens: u.inputTokens, outTokens: u.outputTokens,
      costUsd: u.costUsd ?? 0, status: 'ok', latencyMs: u.latencyMs,
    });
  }
};

/**
 * prompt → validated levels → bundle → persisted game.
 * @returns {Promise<{game:object, report:object, config:object}>}
 */
export async function generateGame({
  prompt, user = null, anonKey = null, deterministic = false, parentGameId = null,
  genre = null, onStage = () => {},
}) {
  const action = parentGameId ? 'remix' : 'generate';
  ensureAffordable(user, action);

  onStage('classifying', 'reading your idea');
  const planned = await plan(prompt, { forceDeterministic: deterministic, genre: genre ?? undefined });

  onStage('designing', planned.source === 'llm' ? 'AI-designed config' : 'rule-based config');

  // A remix must not collide with its parent: same prompt would otherwise yield the
  // same id, silently overwriting the original's bundle on disk.
  //
  // The id is also scoped to the owner (user id, or anon key pre-signup). Without this,
  // two different accounts submitting the same prompt text hash to the same id, and the
  // second submitter's "new game" silently becomes a version bump of the first
  // submitter's game — while still being charged as if a game were created for them.
  // Genre is part of the key too: the same words asking for a Snake and a Sliding Puzzle
  // are two different games and must not share an id (or a bundle directory).
  const ownerKey = user?.id ?? anonKey ?? '';
  const id = parentGameId
    ? hashSeed(`${prompt}:${parentGameId}:${randomUUID()}`).toString(36)
    : hashSeed(`${prompt}:${planned.config.genre}:${ownerKey}`).toString(36);
  planned.config.meta.packageId = packageIdFor(id);

  onStage('building_levels', `generating ${planned.config.progression.levels} levels`);
  const { levels, validation, ladder, report } = buildGame(planned.config);
  if (!report.ok) {
    const e = new Error(`Level generation failed: ${report.fatals.join('; ')}`);
    e.statusCode = 422;
    e.details = { fatals: report.fatals, curveIssues: validation.curveIssues };
    throw e;
  }

  onStage('validating', `${report.totalObstacles} obstacles verified beatable`);
  onStage('bundling', 'packaging');
  await bundleGame({ config: planned.config, levels, outDir: bundleDir(id) });
  await writeSidecars(id, planned.config, report, ladder);

  const cfg = planned.config;
  const existing = db.getGame(id);

  // Belt-and-suspenders: the owner-scoped id above should make a cross-owner collision
  // unreachable, but a hash collision is not mathematically impossible, and charging one
  // user to silently overwrite another user's game would be a much worse bug than this
  // extra check. Never bump a version the caller does not own.
  if (existing) {
    const ownedByUser = existing.user_id && user && existing.user_id === user.id;
    const ownedByAnon = !existing.user_id && existing.anon_key && existing.anon_key === anonKey;
    const ownedByNobody = !existing.user_id && !existing.anon_key && !user && !anonKey;
    if (!ownedByUser && !ownedByAnon && !ownedByNobody) {
      const e = new Error('That game id is already taken.');
      e.statusCode = 409;
      e.code = 'ID_COLLISION';
      throw e;
    }
  }

  const game = db.tx(() => {
    if (user) db.chargeCredits(user.id, action, 'game', id);

    if (existing) {
      // Regenerating the same prompt: keep the row, add a version.
      const version = existing.current_version + 1;
      db.addVersion({ gameId: id, version, config: cfg, report: { report, ladder }, summary: 'regenerated' });
      db.bumpGameVersion(id, version, cfg.meta.title, cfg.theme.palette);
      return db.getGame(id);
    }

    const created = db.createGame({
      id, userId: user?.id ?? null, anonKey: user ? null : anonKey,
      title: cfg.meta.title, tagline: cfg.meta.tagline, genre: cfg.genre,
      prompt, source: planned.source, seed: cfg.meta.seed,
      packageId: cfg.meta.packageId, palette: cfg.theme.palette, parentGameId,
    });
    db.addVersion({ gameId: id, version: 1, config: cfg, report: { report, ladder }, summary: 'initial' });
    return created;
  });

  logUsage(planned.usage, user?.id ?? null, id, prompt);
  onStage('ready', 'done');

  return { game, report, ladder, config: cfg, source: planned.source, notes: planned.notes ?? [] };
}

/**
 * Apply a refinement. Rejects any patch that would make a level unbeatable — the same
 * guarantee generation gives, applied to edits.
 */
export async function refineGame({ gameId, instruction, user, deterministic = false }) {
  const current = db.getCurrentVersion(gameId);
  if (!current) {
    const e = new Error('Game not found.');
    e.statusCode = 404;
    throw e;
  }
  ensureAffordable(user, 'refine');

  const out = await refine(current.config, instruction, { forceDeterministic: deterministic });

  const { levels, validation, ladder, report } = buildGame(out.config);
  if (!report.ok || !validation.ok) {
    const e = new Error('That change would make some levels unbeatable, so it was not applied.');
    e.statusCode = 422;
    e.code = 'WOULD_BREAK_LEVELS';
    e.details = { fatals: report.fatals, curveIssues: validation.curveIssues };
    throw e;
  }

  await bundleGame({ config: out.config, levels, outDir: bundleDir(gameId) });
  await writeSidecars(gameId, out.config, report, ladder);

  const game = db.tx(() => {
    if (user) db.chargeCredits(user.id, 'refine', 'game', gameId);
    const version = db.getGame(gameId).current_version + 1;
    db.addVersion({
      gameId, version, config: out.config, report: { report, ladder },
      patch: out.patch, summary: out.summary,
    });
    db.bumpGameVersion(gameId, version, out.config.meta.title, out.config.theme.palette);
    return db.getGame(gameId);
  });

  logUsage(out.usage, user?.id ?? null, gameId, instruction);
  return { game, report, ladder, summary: out.summary, patch: out.patch, source: out.source };
}

/**
 * Copy a public game into the caller's account so they can tweak it.
 * Forks the exact config rather than re-running the prompt — a remix must start from
 * what the user actually saw and liked, not from a fresh roll of the same words.
 */
export async function remixGame({ sourceGameId, user, anonKey }) {
  const src = db.getGame(sourceGameId);
  if (!src) {
    const e = new Error('Game not found.');
    e.statusCode = 404;
    throw e;
  }
  const srcVersion = db.getCurrentVersion(sourceGameId);
  ensureAffordable(user, 'remix');

  const id = hashSeed(`remix:${sourceGameId}:${user?.id ?? anonKey}:${randomUUID()}`).toString(36);
  const cfg = structuredClone(srcVersion.config);
  cfg.meta.packageId = packageIdFor(id);
  cfg.meta.title = `${cfg.meta.title} REMIX`.slice(0, 40);

  const { levels, report, ladder } = buildGame(cfg);
  if (!report.ok) {
    const e = new Error('Could not rebuild that game for remixing.');
    e.statusCode = 422;
    throw e;
  }
  await bundleGame({ config: cfg, levels, outDir: bundleDir(id) });
  await writeSidecars(id, cfg, report, ladder);

  return db.tx(() => {
    if (user) db.chargeCredits(user.id, 'remix', 'game', id);
    const created = db.createGame({
      id, userId: user?.id ?? null, anonKey: user ? null : anonKey,
      title: cfg.meta.title, tagline: cfg.meta.tagline, genre: cfg.genre,
      prompt: src.prompt, source: src.source, seed: cfg.meta.seed,
      packageId: cfg.meta.packageId, palette: cfg.theme.palette, parentGameId: sourceGameId,
    });
    db.addVersion({ gameId: id, version: 1, config: cfg, report: { report, ladder }, summary: `remix of ${src.title}` });
    return created;
  });
}

/** Serialise a game row plus its report for API responses. */
export function publicGame(game, { includeConfig = false } = {}) {
  if (!game) return null;
  const version = db.getVersion(game.id, game.current_version);
  const build = db.findReadyBuild(game.id, game.current_version);
  return {
    id: game.id,
    title: game.title,
    tagline: game.tagline,
    genre: game.genre,
    prompt: game.prompt,
    source: game.source,
    palette: game.palette,
    version: game.current_version,
    visibility: game.visibility,
    isPublic: game.visibility === 'public',
    parentGameId: game.parent_game_id,
    author: game.author ?? null,
    playCount: game.play_count,
    downloadCount: game.download_count,
    remixCount: game.remix_count,
    status: game.status,
    createdAt: game.created_at,
    updatedAt: game.updated_at,
    playUrl: `/play/${game.id}/bundle/`,
    report: version?.report?.report ?? null,
    ladder: version?.report?.ladder ?? null,
    apk: build
      ? { name: build.artifact_name, bytes: build.size_bytes, downloadUrl: `/api/games/${game.id}/apk`, builtAt: build.finished_at }
      : null,
    ...(includeConfig ? { config: version?.config ?? null } : {}),
  };
}
