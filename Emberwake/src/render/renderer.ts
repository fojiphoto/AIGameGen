/**
 * The renderer: terrain, backdrops, particles and the camera.
 *
 * Three performance decisions carry the whole thing, and all three exist because this has to
 * hold 60 fps on a phone:
 *
 *  1. **Sprites are rasterised once and blitted.** Nim is a few dozen vector paths with
 *     gradients; drawing that thirty times a second is fine, but drawing it *plus* every enemy,
 *     coin and tile is not. Each is baked into a small canvas keyed by size and device pixel
 *     ratio, and the frame is then a sequence of `drawImage` calls.
 *  2. **The backdrop is baked per world.** Five parallax layers of hills, ruins and towers are
 *     drawn once into strips that tile horizontally, then scrolled. Redrawing that geometry
 *     every frame is the single most expensive thing a parallax background can do.
 *  3. **Everything is culled to the camera.** A level is a hundred tiles wide; a screen is
 *     thirty. Drawing the other seventy costs the same as drawing the ones you can see.
 */

import {
  TILE, VIEW_W, VIEW_H, Tile, TileMap,
} from '../core/index.js';
import {
  Palette, makeCanvas, drawHero, drawEnemy, drawSpark, drawEmberstone, drawPower,
  drawBeacon, drawCheckpoint, HeroPose, EnemyArt, PowerArt, HERO_SIZE, shade, roundRect,
} from './art.js';

// ── sprite cache ────────────────────────────────────────────────────────────

/**
 * Baked sprites, keyed by everything that changes their pixels.
 *
 * Animated sprites are baked at a handful of *phases* rather than continuously: a spark that
 * spins is eight frames on a loop, not a fresh render every time it is drawn. Keying a cache on
 * a continuously varying number is how a cache becomes a memory leak — a lesson this studio has
 * already paid for once.
 */
export class SpriteCache {
  private cache = new Map<string, HTMLCanvasElement>();
  private dpr: number;
  private paletteKey = '';

  constructor(dpr: number) { this.dpr = dpr; }

  setDpr(dpr: number): void {
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.cache.clear();
  }

  setPalette(key: string): void {
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    this.cache.clear();
  }

  private bake(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void)
    : HTMLCanvasElement {
    const existing = this.cache.get(key);
    if (existing) return existing;
    const { canvas, ctx } = makeCanvas(w, h, this.dpr);
    draw(ctx);
    // A level uses on the order of a hundred distinct sprites; well past that and something is
    // keying on a value that varies continuously.
    if (this.cache.size > 400) this.cache.clear();
    this.cache.set(key, canvas);
    return canvas;
  }

  hero(pose: HeroPose, palette: Palette, phaseStep: number): HTMLCanvasElement {
    return this.bake(`hero:${this.paletteKey}:${pose}:${phaseStep}`, HERO_SIZE.w, HERO_SIZE.h,
      (ctx) => drawHero(ctx, pose, palette, phaseStep * 0.5));
  }

  enemy(kind: EnemyArt, w: number, h: number, palette: Palette, phaseStep: number, alert: boolean)
    : HTMLCanvasElement {
    return this.bake(`enemy:${this.paletteKey}:${kind}:${w}x${h}:${phaseStep}:${alert ? 1 : 0}`,
      w, h + 6, (ctx) => drawEnemy(ctx, kind, w, h, palette, phaseStep * 0.4, alert));
  }

  spark(size: number, phaseStep: number, glow: string): HTMLCanvasElement {
    return this.bake(`spark:${size}:${phaseStep}`, size, size,
      (ctx) => drawSpark(ctx, size, phaseStep * 0.8, glow));
  }

  ember(size: number, phaseStep: number): HTMLCanvasElement {
    return this.bake(`ember:${size}:${phaseStep}`, size, size,
      (ctx) => drawEmberstone(ctx, size, phaseStep * 0.8));
  }

  power(kind: PowerArt, size: number, phaseStep: number): HTMLCanvasElement {
    return this.bake(`power:${kind}:${size}:${phaseStep}`, size, size,
      (ctx) => drawPower(ctx, kind, size, phaseStep * 0.8));
  }

  beacon(w: number, h: number, palette: Palette, phaseStep: number, litStep: number)
    : HTMLCanvasElement {
    return this.bake(`beacon:${this.paletteKey}:${w}:${phaseStep}:${litStep}`, w * 2, h,
      (ctx) => drawBeacon(ctx, w * 2, h, palette, phaseStep * 0.5, litStep / 4));
  }

  checkpoint(w: number, h: number, palette: Palette, phaseStep: number, on: boolean)
    : HTMLCanvasElement {
    return this.bake(`cp:${this.paletteKey}:${w}:${phaseStep}:${on ? 1 : 0}`, w, h,
      (ctx) => drawCheckpoint(ctx, w, h, palette, phaseStep * 0.5, on));
  }

  /**
   * A terrain tile, baked with its edges.
   *
   * The neighbour mask is part of the key, which is what removes visible seams: a tile with
   * ground above it is drawn without a grass cap, an exposed left edge gets a highlight, and a
   * fully buried tile is flat dark. Eight bits of neighbours gives at most a few dozen distinct
   * tiles per world, all baked once.
   */
  tile(kind: number, mask: number, palette: Palette): HTMLCanvasElement {
    return this.bake(`tile:${this.paletteKey}:${kind}:${mask}`, TILE, TILE,
      (ctx) => paintTile(ctx, kind, mask, palette));
  }
}

/** Bit positions in the neighbour mask. */
const N = 1, S = 2, W = 4, E = 8;

function paintTile(ctx: CanvasRenderingContext2D, kind: number, mask: number, p: Palette): void {
  if (kind === Tile.OneWay) {
    // A thin plank with a lit top edge — visually obviously not solid ground, which is the
    // whole point of a one-way platform.
    const grad = ctx.createLinearGradient(0, 0, 0, TILE * 0.36);
    grad.addColorStop(0, p.platformEdge);
    grad.addColorStop(1, p.platform);
    ctx.fillStyle = grad;
    roundRect(ctx, 0, 1, TILE, TILE * 0.32, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, TILE * 0.3, TILE, 2);
    return;
  }

  if (kind === Tile.Spike) {
    ctx.fillStyle = shade(p.groundDeep, 0.04);
    ctx.fillRect(0, TILE * 0.62, TILE, TILE * 0.38);
    const grad = ctx.createLinearGradient(0, TILE * 0.1, 0, TILE);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.35, p.spike);
    grad.addColorStop(1, shade(p.spike, -0.4));
    ctx.fillStyle = grad;
    for (let i = 0; i < 3; i++) {
      const x = i * (TILE / 3);
      ctx.beginPath();
      ctx.moveTo(x + 1, TILE);
      ctx.lineTo(x + TILE / 6, TILE * 0.12);
      ctx.lineTo(x + TILE / 3 - 1, TILE);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }

  if (kind === Tile.Liquid) {
    const grad = ctx.createLinearGradient(0, 0, 0, TILE);
    grad.addColorStop(0, p.liquidGlow);
    grad.addColorStop(0.3, p.liquid);
    grad.addColorStop(1, shade(p.liquid, -0.3));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, TILE, TILE);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, 0, TILE, 3);
    ctx.restore();
    return;
  }

  if (kind === Tile.Crate) {
    const grad = ctx.createLinearGradient(0, 0, TILE, TILE);
    grad.addColorStop(0, shade(p.platform, 0.24));
    grad.addColorStop(1, shade(p.platform, -0.16));
    ctx.fillStyle = grad;
    roundRect(ctx, 1, 1, TILE - 2, TILE - 2, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(30,20,12,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = shade(p.platformEdge, 0.1);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(5, 5); ctx.lineTo(TILE - 5, TILE - 5);
    ctx.moveTo(TILE - 5, 5); ctx.lineTo(5, TILE - 5);
    ctx.stroke();
    return;
  }

  // Solid ground and rock.
  const face = kind === Tile.Rock ? p.rock : p.groundFace;
  const deep = kind === Tile.Rock ? shade(p.rock, -0.2) : p.groundDeep;
  const grad = ctx.createLinearGradient(0, 0, 0, TILE);
  grad.addColorStop(0, shade(face, 0.06));
  grad.addColorStop(1, deep);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TILE, TILE);

  // Speckle, so a wall of identical tiles does not read as a flat colour. Deterministic from
  // the mask so it never shimmers between frames.
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  let seed = (mask + 1) * 2654435761;
  for (let i = 0; i < 5; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = (seed >>> 8) % TILE;
    const y = (seed >>> 16) % TILE;
    ctx.fillRect(x, y, 2, 2);
  }

  // A grass or crystal cap on any tile with open sky above it.
  if (!(mask & N) && kind !== Tile.Rock) {
    const cap = ctx.createLinearGradient(0, 0, 0, TILE * 0.4);
    cap.addColorStop(0, shade(p.groundTop, 0.14));
    cap.addColorStop(1, p.groundTop);
    ctx.fillStyle = cap;
    ctx.fillRect(0, 0, TILE, TILE * 0.3);
    // A ragged lower edge, so the cap is not a printed stripe.
    ctx.beginPath();
    ctx.moveTo(0, TILE * 0.3);
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * TILE;
      ctx.lineTo(x, TILE * 0.3 + ((i % 2) ? 5 : 1));
    }
    ctx.lineTo(TILE, TILE * 0.3);
    ctx.closePath();
    ctx.fill();
  }

  // Edge lighting, which is what stops adjacent tiles reading as one flat mass.
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  if (!(mask & W)) ctx.fillRect(0, 0, 2, TILE);
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  if (!(mask & E)) ctx.fillRect(TILE - 2, 0, 2, TILE);
  if (!(mask & S)) ctx.fillRect(0, TILE - 2, TILE, 2);
}

// ── parallax backdrops ──────────────────────────────────────────────────────

/**
 * A world's backdrop, baked into three scrolling strips plus a sky gradient.
 *
 * Each strip is drawn twice side by side so it can wrap without a seam, and the silhouettes are
 * generated from a seeded noise walk — so every world gets a skyline that is characteristic but
 * not repetitive, at no asset cost.
 */
export class Backdrop {
  private layers: { canvas: HTMLCanvasElement; speed: number; y: number }[] = [];
  private sky: HTMLCanvasElement | null = null;
  private key = '';

  build(palette: Palette, world: number, dpr: number): void {
    const key = `${world}:${dpr}`;
    if (key === this.key) return;
    this.key = key;

    const sky = makeCanvas(VIEW_W, VIEW_H, dpr);
    const grad = sky.ctx.createLinearGradient(0, 0, 0, VIEW_H);
    grad.addColorStop(0, palette.sky[0]);
    grad.addColorStop(1, palette.sky[1]);
    sky.ctx.fillStyle = grad;
    sky.ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    this.sky = sky.canvas;

    this.layers = [];
    const specs: { color: string; speed: number; amp: number; step: number; y: number }[] = [
      { color: palette.far, speed: 0.12, amp: 70, step: 90, y: VIEW_H * 0.40 },
      { color: palette.mid, speed: 0.28, amp: 55, step: 62, y: VIEW_H * 0.58 },
      { color: palette.near, speed: 0.5, amp: 40, step: 42, y: VIEW_H * 0.74 },
    ];

    for (const [i, spec] of specs.entries()) {
      const w = VIEW_W * 2;
      const { canvas, ctx } = makeCanvas(w, VIEW_H, dpr);
      ctx.fillStyle = spec.color;
      ctx.beginPath();
      ctx.moveTo(0, VIEW_H);

      // A seeded walk gives a horizon that is characteristic per world and identical every run.
      let seed = 0x1234567 + world * 7919 + i * 104729;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      let y = spec.y;
      ctx.lineTo(0, y);
      for (let x = 0; x <= w; x += spec.step) {
        y += (rnd() - 0.5) * spec.amp;
        y = Math.max(spec.y - spec.amp, Math.min(spec.y + spec.amp * 0.6, y));
        // Sky Ruin gets flat-topped towers; everything else gets rolling hills.
        if (world === 5 && rnd() > 0.55) {
          ctx.lineTo(x, y);
          ctx.lineTo(x + spec.step * 0.6, y);
        } else {
          ctx.quadraticCurveTo(x - spec.step * 0.5, y + (rnd() - 0.5) * 20, x, y);
        }
      }
      ctx.lineTo(w, VIEW_H);
      ctx.closePath();
      ctx.fill();

      // A lit rim along the top of each ridge, which is what gives the layers depth.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.12 - i * 0.03;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      this.layers.push({ canvas, speed: spec.speed, y: 0 });
    }
  }

  draw(ctx: CanvasRenderingContext2D, camX: number, camY: number, palette: Palette): void {
    if (this.sky) ctx.drawImage(this.sky, 0, 0, VIEW_W, VIEW_H);

    for (const layer of this.layers) {
      const w = VIEW_W * 2;
      // Wrap by taking the offset modulo the strip width; the strip is drawn twice so the seam
      // is always off-screen.
      let offset = -(camX * layer.speed) % w;
      if (offset > 0) offset -= w;
      const yOff = -camY * layer.speed * 0.35;
      ctx.drawImage(layer.canvas, offset, yOff, w, VIEW_H);
      ctx.drawImage(layer.canvas, offset + w, yOff, w, VIEW_H);
    }

    ctx.fillStyle = palette.haze;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }
}

// ── particles ───────────────────────────────────────────────────────────────

export type ParticleKind = 'dust' | 'spark' | 'burst' | 'trail' | 'ring' | 'shard';

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: string;
  kind: ParticleKind;
  gravity: number;
  active: boolean;
}

/**
 * A fixed pool of particles.
 *
 * Pooled rather than allocated because particles are the only thing in the game created and
 * destroyed dozens of times a second, and a garbage collection pause in the middle of a jump is
 * exactly the kind of stutter that makes a platformer feel bad. The pool is a hard cap: when it
 * is full the oldest particle is recycled, so a heavy moment costs the same as a quiet one.
 */
export class Particles {
  private pool: Particle[] = [];
  private next = 0;

  constructor(size = 320) {
    for (let i = 0; i < size; i++) {
      this.pool.push({
        x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2,
        color: '#fff', kind: 'dust', gravity: 0, active: false,
      });
    }
  }

  /** Density setting: 'low' halves every burst rather than turning effects off entirely. */
  quality: 'low' | 'high' = 'high';

  emit(
    kind: ParticleKind, x: number, y: number, count: number,
    opts: { color?: string; speed?: number; spread?: number; life?: number;
            size?: number; gravity?: number; dir?: number } = {}
  ): void {
    const n = this.quality === 'low' ? Math.ceil(count / 2) : count;
    for (let i = 0; i < n; i++) {
      const p = this.pool[this.next];
      this.next = (this.next + 1) % this.pool.length;
      const dir = opts.dir ?? Math.random() * Math.PI * 2;
      const spread = opts.spread ?? Math.PI * 2;
      const angle = dir + (Math.random() - 0.5) * spread;
      const speed = (opts.speed ?? 90) * (0.5 + Math.random() * 0.7);
      p.x = x; p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.maxLife = p.life = (opts.life ?? 0.5) * (0.7 + Math.random() * 0.6);
      p.size = (opts.size ?? 3) * (0.6 + Math.random() * 0.8);
      p.color = opts.color ?? '#fff';
      p.kind = kind;
      p.gravity = opts.gravity ?? 400;
      p.active = true;
    }
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Drag, so bursts settle rather than flying off in straight lines.
      p.vx *= 1 - Math.min(1, 2.4 * dt);
    }
  }

  draw(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    ctx.save();
    for (const p of this.pool) {
      if (!p.active) continue;
      const x = p.x - camX, y = p.y - camY;
      if (x < -32 || x > VIEW_W + 32 || y < -32 || y > VIEW_H + 32) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.min(1, t * 1.4);

      if (p.kind === 'spark' || p.kind === 'burst') {
        ctx.globalCompositeOperation = 'lighter';
      } else {
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.fillStyle = p.color;
      if (p.kind === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2 * t;
        ctx.beginPath();
        ctx.arc(x, y, p.size * (2.4 - t * 1.6), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'shard') {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.vx * 0.01);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.6);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, p.size * (p.kind === 'dust' ? t : 1), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  clear(): void { for (const p of this.pool) p.active = false; }
  get activeCount(): number { return this.pool.filter((p) => p.active).length; }
}

// ── camera ──────────────────────────────────────────────────────────────────

/**
 * A camera that looks where the player is going.
 *
 * Three behaviours, in order of how much they matter. It leads: the view sits ahead of the
 * player in the direction they are moving, so the next obstacle is on screen before they reach
 * it. It has a vertical dead zone: it ignores small jumps entirely and only follows when the
 * player genuinely changes level, because a camera that tracks every hop makes people ill. And
 * it is clamped to the level, so the player never sees past the edge of the world.
 */
export class Camera {
  x = 0;
  y = 0;
  private shakeAmount = 0;
  private shakeTime = 0;
  shakeEnabled = true;

  private lead = 0;

  follow(
    targetX: number, targetY: number, facing: number, speed: number,
    levelW: number, levelH: number, dt: number, snap = false
  ): void {
    // Look further ahead the faster the player is going, which makes a sprint feel fast.
    const wantLead = facing * Math.min(1, Math.abs(speed) / 300) * VIEW_W * 0.16;
    this.lead += (wantLead - this.lead) * Math.min(1, 2.2 * dt);

    const desiredX = targetX - VIEW_W / 2 + this.lead;

    // Vertical dead zone: a band the player can move within without the camera reacting at all.
    const band = VIEW_H * 0.18;
    const centreY = this.y + VIEW_H / 2;
    let desiredY = this.y;
    if (targetY < centreY - band) desiredY = targetY - VIEW_H / 2 + band;
    else if (targetY > centreY + band) desiredY = targetY - VIEW_H / 2 - band;

    const ease = snap ? 1 : Math.min(1, 6.5 * dt);
    this.x += (desiredX - this.x) * ease;
    this.y += (desiredY - this.y) * (snap ? 1 : Math.min(1, 4.5 * dt));

    this.x = Math.max(0, Math.min(levelW - VIEW_W, this.x));
    this.y = Math.max(0, Math.min(Math.max(0, levelH - VIEW_H), this.y));

    if (this.shakeTime > 0) this.shakeTime -= dt;
  }

  snapTo(targetX: number, targetY: number, levelW: number, levelH: number): void {
    this.lead = 0;
    this.x = Math.max(0, Math.min(levelW - VIEW_W, targetX - VIEW_W / 2));
    this.y = Math.max(0, Math.min(Math.max(0, levelH - VIEW_H), targetY - VIEW_H / 2));
  }

  shake(amount: number, seconds = 0.22): void {
    if (!this.shakeEnabled) return;
    // Never *reduce* an ongoing shake — a small hit during a big one should not calm it down.
    this.shakeAmount = Math.max(this.shakeAmount, amount);
    this.shakeTime = Math.max(this.shakeTime, seconds);
  }

  /** Offsets to add when drawing. Decays to zero, and is always sub-pixel-stable at rest. */
  get offsetX(): number {
    if (this.shakeTime <= 0) return 0;
    return (Math.random() - 0.5) * this.shakeAmount * this.shakeTime * 4;
  }
  get offsetY(): number {
    if (this.shakeTime <= 0) return 0;
    return (Math.random() - 0.5) * this.shakeAmount * this.shakeTime * 4;
  }
}

// ── terrain drawing ─────────────────────────────────────────────────────────

/** Neighbour mask for a tile, used to pick the right baked variant. */
export function neighbourMask(map: TileMap, tx: number, ty: number): number {
  const same = (x: number, y: number) => {
    const t = map.at(x, y);
    return t === Tile.Solid || t === Tile.Rock ? 1 : 0;
  };
  return (same(tx, ty - 1) ? N : 0) | (same(tx, ty + 1) ? S : 0)
       | (same(tx - 1, ty) ? W : 0) | (same(tx + 1, ty) ? E : 0);
}

/** Draw only the tiles the camera can see. */
export function drawTerrain(
  ctx: CanvasRenderingContext2D, map: TileMap, cache: SpriteCache, palette: Palette,
  camX: number, camY: number
): void {
  const x0 = Math.max(0, Math.floor(camX / TILE) - 1);
  const x1 = Math.min(map.width - 1, Math.ceil((camX + VIEW_W) / TILE) + 1);
  const y0 = Math.max(0, Math.floor(camY / TILE) - 1);
  const y1 = Math.min(map.height - 1, Math.ceil((camY + VIEW_H) / TILE) + 1);

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const kind = map.at(tx, ty);
      if (kind === Tile.Empty) continue;
      const mask = kind === Tile.Solid || kind === Tile.Rock ? neighbourMask(map, tx, ty) : 0;
      const sprite = cache.tile(kind, mask, palette);
      ctx.drawImage(sprite, Math.round(tx * TILE - camX), Math.round(ty * TILE - camY), TILE, TILE);
    }
  }
}

export { shade };
