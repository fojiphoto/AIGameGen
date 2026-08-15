/**
 * The completability solver.
 *
 * This is the strongest test this game admits, and it is the reason the controller was written
 * DOM-free. It answers, for a level, the only question that really matters: *can the player
 * actually get to the end, and to everything worth collecting?*
 *
 * It answers it by playing. Rather than modelling jump arcs with a formula — which drifts from
 * the real controller the moment anyone retunes gravity — it instantiates the actual `Player`,
 * feeds it scripted inputs, and steps the real physics at the real timestep. Whatever the
 * controller can do, the solver can do; whatever it cannot, neither can the solver. A level that
 * passes is completable by definition, and if a tuning change breaks a gap somewhere in world 4,
 * the suite says so by name instead of a player finding it.
 *
 * The search is a breadth-first flood over *stand spots* — tiles a player could be standing on.
 * From each, every scripted move is simulated and its landing spot recorded as an edge. The
 * result is the set of places reachable from spawn, which is then checked against the goal, the
 * checkpoints and every pickup.
 */

import { TILE, PLAYER_W, PLAYER_H, FIXED_DT } from './constants.js';
import { TileMap, Platform } from './world.js';
import { Player, InputState, emptyInput } from './player.js';
import { Level } from './level.js';

export interface Reach {
  /** Keys of the form "tx,ty" the player can stand on. */
  spots: Set<string>;
  /** Total stand spots in the level, reachable or not. */
  total: number;
}

export interface SolveResult {
  ok: boolean;
  reach: Reach;
  goalReachable: boolean;
  unreachableCheckpoints: number;
  /** Pickups the player cannot get to. Secrets are allowed to be hard, not impossible. */
  unreachablePickups: { kind: string; x: number; y: number }[];
  problems: string[];
}

const key = (tx: number, ty: number) => `${tx},${ty}`;

/**
 * Every tile a player could stand on: solid underneath, and enough clear space to fit.
 *
 * Clearance is checked at the real body size rather than in whole tiles. A 22x36 body fits
 * places a 32x64 approximation does not, and a solver that is more pessimistic than the game
 * rejects perfectly good level design.
 */
export function standSpots(map: TileMap): { tx: number; ty: number }[] {
  const out: { tx: number; ty: number }[] = [];
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      if (!map.solidAt(tx, ty) && map.at(tx, ty) !== 2) continue;
      const aboveY = ty - 1;
      if (aboveY < 0) continue;
      const x = tx * TILE + (TILE - PLAYER_W) / 2;
      const y = aboveY * TILE + TILE - PLAYER_H;
      if (map.boxBlocked(x, y, PLAYER_W, PLAYER_H)) continue;
      out.push({ tx, ty: aboveY });
    }
  }
  return out;
}

/**
 * The moves the solver knows how to make.
 *
 * Deliberately a small, human set: walk, short hop, full jump, running jump, and the same with a
 * late release. If a level needs an input sequence outside this vocabulary to be completed, the
 * level is asking for something a player will not find, and the solver failing it is the correct
 * outcome rather than a false alarm.
 */
interface Plan {
  name: string;
  /** Horizontal direction held. */
  dir: -1 | 0 | 1;
  jump: boolean;
  /** Seconds the jump button is held. */
  holdFor: number;
  /** Seconds of run-up before jumping, to build speed. */
  runUp: number;
  /** Requires the dash ability. */
  dash?: boolean;
}

const PLANS: Plan[] = [
  { name: 'walk-left', dir: -1, jump: false, holdFor: 0, runUp: 0 },
  { name: 'walk-right', dir: 1, jump: false, holdFor: 0, runUp: 0 },
  { name: 'hop-up', dir: 0, jump: true, holdFor: 0.09, runUp: 0 },
  { name: 'jump-up', dir: 0, jump: true, holdFor: 1, runUp: 0 },
  { name: 'hop-left', dir: -1, jump: true, holdFor: 0.1, runUp: 0 },
  { name: 'hop-right', dir: 1, jump: true, holdFor: 0.1, runUp: 0 },
  { name: 'jump-left', dir: -1, jump: true, holdFor: 1, runUp: 0 },
  { name: 'jump-right', dir: 1, jump: true, holdFor: 1, runUp: 0 },
  { name: 'run-jump-left', dir: -1, jump: true, holdFor: 1, runUp: 0.45 },
  { name: 'run-jump-right', dir: 1, jump: true, holdFor: 1, runUp: 0.45 },
  { name: 'drop-left', dir: -1, jump: false, holdFor: 0, runUp: 0.2 },
  { name: 'drop-right', dir: 1, jump: false, holdFor: 0, runUp: 0.2 },
];

/** How long a single move is simulated before giving up on it. */
const PLAN_SECONDS = 2.6;

/**
 * Simulate one plan from one stand spot, and report where the player ends up standing.
 *
 * Returns null if the move ends in a hazard, out of bounds, or nowhere new. Hazards count as
 * failure rather than as a landing: a route that requires walking through spikes is not a route.
 */
function simulate(
  map: TileMap, platforms: Platform[], tx: number, ty: number, plan: Plan,
  abilities: { dash: boolean; doubleJump: boolean }
): { tx: number; ty: number }[] {
  const player = new Player(
    tx * TILE + (TILE - PLAYER_W) / 2,
    ty * TILE + TILE - PLAYER_H
  );
  player.canDash = abilities.dash;
  player.canDoubleJump = abilities.doubleJump;
  // Give it a frame on the ground so `onGround` is true before the first jump.
  player.body.vy = 1;

  const input: InputState = emptyInput();
  const steps = Math.floor(PLAN_SECONDS / FIXED_DT);
  const runUpSteps = Math.floor(plan.runUp / FIXED_DT);
  const holdSteps = Math.floor(plan.holdFor / FIXED_DT);
  let jumpStep = -1;

  /**
   * Every distinct tile the player stands on during the plan, not just the first.
   *
   * The first version returned one landing and stopped, which made walking useless: a walk that
   * carries on past the end of a platform dies in the pit beyond it, so the tiles in between —
   * the whole platform — were never added to the graph. The flood then had to reach every tile
   * by a separate jump, and reachability collapsed. Recording the whole path is both more
   * complete and much faster, because one walk now contributes ten tiles instead of one.
   */
  const visited: { tx: number; ty: number }[] = [];
  const seen = new Set<string>([key(tx, ty)]);

  for (let i = 0; i < steps; i++) {
    input.left = plan.dir === -1;
    input.right = plan.dir === 1;
    input.jumpPressed = false;
    input.jump = false;
    input.dash = false;
    input.dashPressed = false;

    if (plan.jump && i === runUpSteps) { input.jumpPressed = true; input.jump = true; jumpStep = i; }
    else if (plan.jump && jumpStep >= 0 && i - jumpStep < holdSteps) input.jump = true;

    if (plan.dash && i === runUpSteps) { input.dashPressed = true; input.dash = true; }

    player.update(input, map, platforms, FIXED_DT);

    // Out of the level, or into something that hurts — everything found so far still counts.
    if (player.body.y > map.height * TILE + 64) break;
    const touched = map.tilesIn(player.body.x, player.body.y, player.body.w, player.body.h);
    if (touched.includes(3) || touched.includes(5)) break;

    if (player.body.onGround && i > 4) {
      const ltx = Math.floor((player.body.x + player.body.w / 2) / TILE);
      const lty = Math.floor((player.body.y + player.body.h - 1) / TILE);
      const k = key(ltx, lty);
      if (!seen.has(k)) { seen.add(k); visited.push({ tx: ltx, ty: lty }); }
      // A plan that has come to a stop on the ground has nothing left to show.
      if (Math.abs(player.body.vx) < 4 && !plan.jump && i > runUpSteps + 8) break;
    }
  }
  return visited;
}

/**
 * Flood the level from the spawn.
 *
 * @param abilities what the player has unlocked when they first reach this level — so a level
 *   in world 1 is checked without the dash, and a level that *needs* the dash fails there rather
 *   than passing because the solver was more capable than the player will be.
 */
export function solve(
  level: Level, abilities: { dash: boolean; doubleJump: boolean } = { dash: false, doubleJump: false }
): SolveResult {
  const map = level.map;

  /**
   * Moving platforms, sampled along their path — as one-way surfaces, never as solid blocks.
   *
   * Both halves of that matter. Sampling is because a lift is available *somewhere* on its path
   * whenever the player wants it: simulating its schedule would mean the answer depended on
   * when the player happened to arrive, and a lift you wait four seconds for is still a route.
   *
   * One-way is because the first version used a single box spanning the whole swept volume, and
   * that box is solid — so a lift that rises four tiles became a four-tile wall standing on the
   * ground beside it, and the flood stopped dead at platforms the player can simply walk past.
   * Every level in the game failed, and the levels were not the thing that was wrong. A one-way
   * surface catches a falling player and blocks nothing else, which is exactly what a lift does.
   */
  const platforms: Platform[] = [];
  for (const p of level.platforms) {
    const steps = Math.max(Math.abs(p.dx), Math.abs(p.dy), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      platforms.push({
        x: (p.x + p.dx * t) * TILE,
        y: (p.y + p.dy * t) * TILE,
        w: p.tiles * TILE,
        h: TILE,
        dx: 0, dy: 0,
        oneWay: true,
        active: true,
      });
    }
  }

  const all = standSpots(map);
  const valid = new Set(all.map((s) => key(s.tx, s.ty)));

  const startTx = Math.floor(level.spawn.x / TILE);
  let startTy = Math.floor(level.spawn.y / TILE);
  // Drop the spawn to whatever it is standing on, so a spawn marker floating a tile above the
  // ground still seeds the search.
  while (startTy < map.height && !map.solidAt(startTx, startTy + 1)) startTy++;

  const reached = new Set<string>();
  const queue: { tx: number; ty: number }[] = [];
  const seed = { tx: startTx, ty: startTy };
  reached.add(key(seed.tx, seed.ty));
  queue.push(seed);

  while (queue.length) {
    const spot = queue.shift()!;
    for (const plan of PLANS) {
      if (plan.dash && !abilities.dash) continue;
      for (const landing of simulate(map, platforms, spot.tx, spot.ty, plan, abilities)) {
        const k = key(landing.tx, landing.ty);
        if (reached.has(k)) continue;
        // Only follow landings on real ground; a landing inside geometry means the simulation
        // ended somewhere the flood should not continue from.
        if (!valid.has(k)) continue;
        reached.add(k);
        queue.push(landing);
      }
    }
  }

  const reach: Reach = { spots: reached, total: all.length };
  const problems: string[] = [];

  const nearReached = (x: number, y: number, radiusTiles = 2): boolean => {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    for (let dy = -radiusTiles; dy <= radiusTiles + 1; dy++) {
      for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
        if (reached.has(key(tx + dx, ty + dy))) return true;
      }
    }
    return false;
  };

  const goalReachable = nearReached(level.goal.x, level.goal.y, 3);
  if (!goalReachable) problems.push('the goal cannot be reached from the spawn');

  let unreachableCheckpoints = 0;
  for (const c of level.checkpoints) {
    if (!nearReached(c.x, c.y, 3)) { unreachableCheckpoints++; problems.push('a checkpoint is unreachable'); }
  }

  const unreachablePickups: SolveResult['unreachablePickups'] = [];
  for (const p of level.pickups) {
    // Pickups are collected in flight, so the radius is generous: anything within a jump of a
    // reachable tile counts.
    if (!nearReached(p.x, p.y, 3)) {
      unreachablePickups.push({ kind: p.kind, x: p.x, y: p.y });
    }
  }
  if (unreachablePickups.length) {
    problems.push(`${unreachablePickups.length} pickup(s) cannot be reached`);
  }

  return {
    ok: goalReachable && unreachableCheckpoints === 0 && unreachablePickups.length === 0,
    reach,
    goalReachable,
    unreachableCheckpoints,
    unreachablePickups,
    problems,
  };
}

/**
 * Static level checks that do not need simulation.
 *
 * Cheap, and they catch the mistakes that are easiest to make while authoring a grid by hand:
 * a spawn buried in rock, a goal with no floor, spikes directly under the start.
 */
export function audit(level: Level): string[] {
  const problems: string[] = [];
  const map = level.map;

  // Standing markers give the feet line, so the body hangs above it.
  const spawnX = level.spawn.x - PLAYER_W / 2;
  const spawnY = level.spawn.y - PLAYER_H;
  if (map.boxBlocked(spawnX, spawnY, PLAYER_W, PLAYER_H - 1)) {
    problems.push('the spawn point is inside solid geometry');
  }

  if (map.boxBlocked(level.goal.x - TILE / 2, level.goal.y - TILE, TILE, TILE - 1)) {
    problems.push('the goal is inside solid geometry');
  }

  for (const p of level.pickups) {
    if (map.solidAtPoint(p.x, p.y)) {
      problems.push(`a ${p.kind} at ${Math.round(p.x)},${Math.round(p.y)} is inside a wall`);
    }
  }
  // Enemies are anchored at their feet, which sit *on* the floor — so the probe has to look at
  // the pixel above the anchor, not at it.
  for (const e of level.enemies) {
    if (map.solidAtPoint(e.x, e.y - 1)) {
      problems.push(`a ${e.kind} at ${Math.round(e.x)},${Math.round(e.y)} is inside a wall`);
    }
  }
  for (const c of level.checkpoints) {
    if (map.solidAtPoint(c.x, c.y - 1)) problems.push('a checkpoint is inside a wall');
  }

  if (level.def.parTime <= 0) problems.push('par time must be positive');
  if (level.width < 640) problems.push('level is narrower than one screen');

  return problems;
}
