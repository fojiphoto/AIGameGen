/**
 * The tile world and the collision it provides.
 *
 * Axis-separated swept AABB against a tile grid. Move on X, resolve; move on Y, resolve. It is
 * the oldest approach in 2D platformers and still the right one: it never tunnels, it produces
 * exact contact positions, and — the part that matters most — it makes "am I standing on
 * something" a fact rather than an inference. Physics engines answer that question with
 * contact manifolds and normals, and every platformer built on one eventually fights it over
 * a character who is briefly not-quite-grounded while running across a flat floor.
 *
 * Nothing here draws, and nothing here knows about the player specifically. A body is a box
 * with a velocity, and enemies use the same code the hero does — which is why an enemy can
 * never walk through a wall the player cannot.
 */

import { TILE } from './constants.js';

export const enum Tile {
  Empty = 0,
  /** Collides from every direction. */
  Solid = 1,
  /** Collides only downward, and only when the body is already above it. */
  OneWay = 2,
  /** Solid, and hurts. */
  Spike = 3,
  /** Solid until struck from below or ground-pounded. */
  Crate = 4,
  /** Not solid, but hurts on contact — lava, deep water, the void. */
  Liquid = 5,
  /** Solid, but visually a background edge piece. Behaves as Solid. */
  Rock = 6,
}

export const isSolidTile = (t: number): boolean =>
  t === Tile.Solid || t === Tile.Spike || t === Tile.Crate || t === Tile.Rock;
export const isHurtTile = (t: number): boolean => t === Tile.Spike || t === Tile.Liquid;

export interface Body {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  onGround: boolean;
  onCeiling: boolean;
  /** -1 pressing a wall on the left, 1 on the right, 0 for neither. */
  onWall: number;
  /**
   * Whether this body falls through one-way platforms. Set while pressing down, and always
   * true for a body moving upward — a one-way platform the player is jumping through must not
   * stop them.
   */
  dropThrough: boolean;
}

export interface CollisionResult {
  hitX: boolean;
  hitY: boolean;
  /** Tile ids touched this step, so the caller can react to spikes without a second query. */
  touched: number[];
}

/** A rectangle that carries bodies standing on it: a lift, a raft, a crumbling ledge. */
export interface Platform {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Movement applied this step, used to carry riders. */
  dx: number;
  dy: number;
  /** One-way platforms can be jumped through from below. */
  oneWay: boolean;
  active: boolean;
}

export class TileMap {
  readonly width: number;
  readonly height: number;
  private tiles: Uint8Array;

  constructor(width: number, height: number, tiles?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.tiles = tiles ?? new Uint8Array(width * height);
  }

  /**
   * Read a tile. Out of bounds is solid at the sides and below, empty above.
   *
   * The asymmetry is deliberate: a level should have invisible walls at its edges so a player
   * cannot run off into nothing, but the sky has to stay open or a jump near the top of the map
   * hits a ceiling that is not drawn anywhere.
   */
  at(tx: number, ty: number): number {
    if (tx < 0 || tx >= this.width) return Tile.Solid;
    if (ty >= this.height) return Tile.Solid;
    if (ty < 0) return Tile.Empty;
    return this.tiles[ty * this.width + tx];
  }

  set(tx: number, ty: number, value: number): void {
    if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) return;
    this.tiles[ty * this.width + tx] = value;
  }

  get raw(): Uint8Array { return this.tiles; }

  solidAt(tx: number, ty: number): boolean { return isSolidTile(this.at(tx, ty)); }

  /** World-space point test, for spawn checks and the level solver. */
  solidAtPoint(x: number, y: number): boolean {
    return this.solidAt(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  /** True when a body-sized box at this position overlaps anything solid. */
  boxBlocked(x: number, y: number, w: number, h: number): boolean {
    const x0 = Math.floor(x / TILE), x1 = Math.floor((x + w - 1) / TILE);
    const y0 = Math.floor(y / TILE), y1 = Math.floor((y + h - 1) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) if (this.solidAt(tx, ty)) return true;
    }
    return false;
  }

  /** Tile ids overlapping a box, deduplicated. Used for hazard and pickup checks. */
  tilesIn(x: number, y: number, w: number, h: number, out: number[] = []): number[] {
    out.length = 0;
    const x0 = Math.floor(x / TILE), x1 = Math.floor((x + w - 1) / TILE);
    const y0 = Math.floor(y / TILE), y1 = Math.floor((y + h - 1) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = this.at(tx, ty);
        if (t !== Tile.Empty && !out.includes(t)) out.push(t);
      }
    }
    return out;
  }
}

const scratch: number[] = [];

/**
 * Move a body by its velocity for `dt`, resolving against tiles and platforms.
 *
 * The order — X then Y — is not arbitrary. Resolving both at once needs a real sweep and a
 * normal, and gets the corner case wrong: a body running along a floor made of separate tiles
 * catches on the vertical seam between them and stops dead. Doing X first, then Y, means the
 * horizontal pass never sees the floor it is already standing on.
 */
export function moveBody(
  body: Body, map: TileMap, dt: number, platforms: Platform[] = []
): CollisionResult {
  const result: CollisionResult = { hitX: false, hitY: false, touched: [] };

  body.onWall = 0;
  const wasOnGround = body.onGround;
  body.onGround = false;
  body.onCeiling = false;

  // ── horizontal ────────────────────────────────────────────────────────────
  const dx = body.vx * dt;
  if (dx !== 0) {
    body.x += dx;
    const dir = dx > 0 ? 1 : -1;
    const leadX = dir > 0 ? body.x + body.w : body.x;
    const tx = Math.floor(leadX / TILE);
    const y0 = Math.floor(body.y / TILE);
    const y1 = Math.floor((body.y + body.h - 1) / TILE);

    for (let ty = y0; ty <= y1; ty++) {
      if (!map.solidAt(tx, ty)) continue;
      body.x = dir > 0 ? tx * TILE - body.w : (tx + 1) * TILE;
      body.vx = 0;
      body.onWall = dir;
      result.hitX = true;
      break;
    }

    for (const p of platforms) {
      if (!p.active || p.oneWay) continue;
      if (!overlaps(body, p)) continue;
      body.x = dir > 0 ? p.x - body.w : p.x + p.w;
      body.vx = 0;
      body.onWall = dir;
      result.hitX = true;
    }
  }

  // ── vertical ──────────────────────────────────────────────────────────────
  const dy = body.vy * dt;
  if (dy !== 0) {
    const beforeY = body.y;
    body.y += dy;
    const dir = dy > 0 ? 1 : -1;
    const leadY = dir > 0 ? body.y + body.h : body.y;
    const ty = Math.floor(leadY / TILE);
    const x0 = Math.floor(body.x / TILE);
    const x1 = Math.floor((body.x + body.w - 1) / TILE);

    for (let tx = x0; tx <= x1; tx++) {
      const tile = map.at(tx, ty);
      const solid = isSolidTile(tile);
      // A one-way tile only stops a body that is falling and whose feet were above it. Testing
      // the *previous* position is what stops the player being ejected upward after walking
      // into the side of a platform they were already level with.
      const oneWay = tile === Tile.OneWay
        && dir > 0 && !body.dropThrough && beforeY + body.h <= ty * TILE + 1;
      if (!solid && !oneWay) continue;

      if (dir > 0) {
        body.y = ty * TILE - body.h;
        body.onGround = true;
      } else {
        body.y = (ty + 1) * TILE;
        body.onCeiling = true;
      }
      body.vy = 0;
      result.hitY = true;
      break;
    }

    for (const p of platforms) {
      if (!p.active) continue;
      if (p.oneWay && (dir < 0 || body.dropThrough || beforeY + body.h > p.y + 1)) continue;
      if (!overlaps(body, p)) continue;
      if (dir > 0) {
        body.y = p.y - body.h;
        body.onGround = true;
        // Ride it: the platform's own movement this step is applied to whoever is standing on it.
        body.x += p.dx;
        body.y += p.dy;
      } else {
        body.y = p.y + p.h;
        body.onCeiling = true;
      }
      body.vy = 0;
      result.hitY = true;
    }
  } else if (wasOnGround) {
    // Standing still on a moving platform still has to be carried, and a body with zero vertical
    // velocity never enters the block above.
    for (const p of platforms) {
      if (!p.active) continue;
      if (!ridingOn(body, p)) continue;
      body.x += p.dx;
      body.y += p.dy;
      body.onGround = true;
    }
  }

  /**
   * Ground probe.
   *
   * Gravity is applied every step, so a body walking on flat ground technically leaves it for a
   * fraction of a pixel each frame and lands again. Without this probe `onGround` flickers, and
   * anything keyed off it — the run animation, coyote time, footstep dust — flickers with it.
   */
  if (!body.onGround && body.vy >= 0) {
    const feet = body.y + body.h;
    const probeY = Math.floor((feet + 1) / TILE);
    const x0 = Math.floor(body.x / TILE);
    const x1 = Math.floor((body.x + body.w - 1) / TILE);
    for (let tx = x0; tx <= x1; tx++) {
      const tile = map.at(tx, probeY);
      const oneWay = tile === Tile.OneWay && !body.dropThrough && feet <= probeY * TILE + 1;
      if (isSolidTile(tile) || oneWay) {
        if (feet >= probeY * TILE - 1) { body.onGround = true; break; }
      }
    }
    if (!body.onGround) {
      for (const p of platforms) {
        if (!p.active) continue;
        if (ridingOn(body, p)) { body.onGround = true; break; }
      }
    }
  }

  map.tilesIn(body.x, body.y, body.w, body.h, scratch);
  result.touched = scratch.slice();
  return result;
}

function overlaps(b: Body, p: Platform): boolean {
  return b.x < p.x + p.w && b.x + b.w > p.x && b.y < p.y + p.h && b.y + b.h > p.y;
}

/** Standing on top of a platform, within a pixel. */
function ridingOn(b: Body, p: Platform): boolean {
  const feet = b.y + b.h;
  return feet >= p.y - 2 && feet <= p.y + 2 && b.x + b.w > p.x + 1 && b.x < p.x + p.w - 1;
}

export function makeBody(x: number, y: number, w: number, h: number): Body {
  return { x, y, w, h, vx: 0, vy: 0, onGround: false, onCeiling: false, onWall: 0, dropThrough: false };
}

/** Box overlap, for entity-to-entity checks. */
export function boxesOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
