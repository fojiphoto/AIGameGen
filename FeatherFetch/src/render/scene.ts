/**
 * Sprite baking, parallax backdrops and particles.
 *
 * Three performance decisions carry the frame budget, and all three exist so this holds 60 fps
 * on a phone:
 *
 *  1. **Sprites are rasterised once and blitted.** A duck is thirty vector paths with gradients;
 *     drawing that for eight ducks plus the dog plus the weapon every frame is not affordable.
 *     Each is baked into a small canvas keyed by everything that changes its pixels.
 *  2. **The backdrop is baked per environment.** Four layers of hills, trees and reeds drawn once
 *     into wrapping strips, then scrolled. Regenerating that geometry every frame is the single
 *     most expensive thing a parallax background can do.
 *  3. **Particles are pooled.** Feathers are created and destroyed dozens of times a second, and
 *     a collection pause in the middle of a shot is exactly the stutter that makes a shooter
 *     feel unresponsive.
 */

import { VIEW_W, VIEW_H, SKY_TOP, SKY_BOTTOM, GROUND_Y } from '../core/index.js';
import {
  Env, makeCanvas, shade, roundRect,
  drawDuck, DuckPose, drawDog, DogPose, drawFeather, drawShell, DOG_W, DOG_H,
} from './art.js';

export class SpriteCache {
  private cache = new Map<string, HTMLCanvasElement>();
  private dpr: number;

  constructor(dpr: number) { this.dpr = dpr; }

  setDpr(dpr: number): void {
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.cache.clear();
  }

  private bake(
    key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void
  ): HTMLCanvasElement {
    const existing = this.cache.get(key);
    if (existing) return existing;
    const { canvas, ctx } = makeCanvas(w, h, this.dpr);
    draw(ctx);
    // Well past what a scene needs; past this something is keying on a continuous value.
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(key, canvas);
    return canvas;
  }

  duck(
    kind: string, pose: DuckPose, size: number, colors: [string, string, string], armored: boolean
  ): HTMLCanvasElement {
    return this.bake(`duck:${kind}:${pose}:${size}`, size, size * 0.78,
      (ctx) => drawDuck(ctx, pose, size, colors, armored));
  }

  dog(pose: DogPose, phaseStep: number, bandana: string): HTMLCanvasElement {
    return this.bake(`dog:${pose}:${phaseStep}:${bandana}`, DOG_W, DOG_H,
      (ctx) => drawDog(ctx, pose, phaseStep * 0.42, bandana));
  }

  feather(size: number, color: string, angleStep: number): HTMLCanvasElement {
    return this.bake(`feather:${size}:${color}:${angleStep}`, size, size,
      (ctx) => drawFeather(ctx, size, color, (angleStep / 8) * Math.PI * 2));
  }

  shell(loaded: boolean): HTMLCanvasElement {
    return this.bake(`shell:${loaded}`, 12, 22, (ctx) => drawShell(ctx, 12, 22, loaded));
  }
}

// ── backdrop ────────────────────────────────────────────────────────────────

/**
 * A world's scenery, baked into wrapping strips plus a sky gradient.
 *
 * Silhouettes come from a seeded walk, so each environment gets a characteristic skyline at no
 * asset cost and the same one every time. Layers scroll at different speeds against a slow
 * drift, so the scene has depth without the player ever moving.
 */
export class Backdrop {
  private sky: HTMLCanvasElement | null = null;
  private layers: { canvas: HTMLCanvasElement; speed: number; y: number }[] = [];
  private ground: HTMLCanvasElement | null = null;
  private key = '';

  build(env: Env, index: number, dpr: number): void {
    const key = `${index}:${dpr}`;
    if (key === this.key) return;
    this.key = key;

    const sky = makeCanvas(VIEW_W, VIEW_H, dpr);
    const grad = sky.ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    grad.addColorStop(0, env.sky[0]);
    grad.addColorStop(1, env.sky[1]);
    sky.ctx.fillStyle = grad;
    sky.ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // A soft sun, low and off-centre, which is what gives each environment its time of day.
    const sunY = index === 3 ? GROUND_Y * 0.72 : GROUND_Y * 0.3;
    const sun = sky.ctx.createRadialGradient(VIEW_W * 0.74, sunY, 0, VIEW_W * 0.74, sunY, 220);
    sun.addColorStop(0, 'rgba(255,250,220,0.55)');
    sun.addColorStop(1, 'rgba(255,240,190,0)');
    sky.ctx.fillStyle = sun;
    sky.ctx.fillRect(0, 0, VIEW_W, GROUND_Y);
    this.sky = sky.canvas;

    this.layers = [];
    const specs = [
      { color: env.far, speed: 5, amp: 46, step: 110, y: GROUND_Y * 0.62, trees: false },
      { color: env.mid, speed: 11, amp: 40, step: 74, y: GROUND_Y * 0.78, trees: true },
      { color: env.near, speed: 20, amp: 30, step: 52, y: GROUND_Y * 0.9, trees: true },
    ];

    for (const [i, spec] of specs.entries()) {
      const w = VIEW_W * 2;
      const { canvas, ctx } = makeCanvas(w, VIEW_H, dpr);
      let seed = 0x2f6a1c + index * 7919 + i * 104729;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };

      ctx.fillStyle = spec.color;
      ctx.beginPath();
      ctx.moveTo(0, VIEW_H);
      let y = spec.y;
      ctx.lineTo(0, y);
      for (let x = 0; x <= w; x += spec.step) {
        y += (rnd() - 0.5) * spec.amp;
        y = Math.max(spec.y - spec.amp, Math.min(spec.y + spec.amp * 0.7, y));
        ctx.quadraticCurveTo(x - spec.step * 0.5, y + (rnd() - 0.5) * 18, x, y);
      }
      ctx.lineTo(w, VIEW_H);
      ctx.closePath();
      ctx.fill();

      // Tree silhouettes along the ridge — conifers in the snow, round canopies elsewhere.
      if (spec.trees) {
        ctx.fillStyle = shade(spec.color, -0.12);
        for (let x = 20; x < w; x += 46 + rnd() * 60) {
          const th = 26 + rnd() * 34;
          const ty = spec.y + (rnd() - 0.5) * spec.amp * 0.6;
          if (index === 4) {
            ctx.beginPath();
            ctx.moveTo(x, ty - th);
            ctx.lineTo(x + th * 0.42, ty);
            ctx.lineTo(x - th * 0.42, ty);
            ctx.closePath();
            ctx.fill();
          } else {
            /**
             * A canopy of two overlapping lobes on a short, wide trunk.
             *
             * One ellipse on a thin stick reads as a balloon, which is exactly what the first
             * version looked like. Two offset lobes and a trunk a third of the canopy's width
             * read as a tree at any distance, for one extra path.
             */
            const r = th * 0.42;
            ctx.fillRect(x - r * 0.22, ty - th * 0.55, r * 0.44, th * 0.6);
            ctx.beginPath();
            ctx.ellipse(x - r * 0.34, ty - th * 0.58, r * 0.78, r * 0.68, 0, 0, Math.PI * 2);
            ctx.ellipse(x + r * 0.38, ty - th * 0.66, r * 0.7, r * 0.62, 0, 0, Math.PI * 2);
            ctx.ellipse(x, ty - th * 0.86, r * 0.72, r * 0.6, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.1 - i * 0.025;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      this.layers.push({ canvas, speed: spec.speed, y: 0 });
    }

    // Ground, fence and foreground reeds — baked once because none of it moves.
    const g = makeCanvas(VIEW_W, VIEW_H - GROUND_Y + 40, dpr);
    const gc = g.ctx;
    const gg = gc.createLinearGradient(0, 0, 0, VIEW_H - GROUND_Y + 40);
    gg.addColorStop(0, env.grass);
    gg.addColorStop(1, env.grassDark);
    gc.fillStyle = gg;
    gc.fillRect(0, 12, VIEW_W, VIEW_H);

    // A ragged grass line rather than a ruled edge.
    gc.fillStyle = env.grass;
    gc.beginPath();
    gc.moveTo(0, 20);
    for (let x = 0; x <= VIEW_W; x += 11) {
      gc.lineTo(x, 12 + ((x / 11) % 2 ? 7 : 0) + Math.sin(x * 0.09) * 4);
    }
    gc.lineTo(VIEW_W, 40);
    gc.lineTo(0, 40);
    gc.closePath();
    gc.fill();

    // A simple wooden fence, which is what makes the meadow read as a place rather than a field
    // of colour.
    gc.fillStyle = shade('#8a5f36', index === 4 ? 0.1 : 0);
    gc.strokeStyle = 'rgba(30,20,12,0.5)';
    gc.lineWidth = 1.5;
    for (let x = 24; x < VIEW_W; x += 96) {
      roundRect(gc, x, 4, 9, 44, 2);
      gc.fill(); gc.stroke();
    }
    for (const railY of [14, 30]) {
      roundRect(gc, 0, railY, VIEW_W, 7, 2);
      gc.fill(); gc.stroke();
    }

    /**
     * Foreground reeds along the bottom edge, dark and out of focus.
     *
     * Positioned against the *ground canvas's own* height, not `VIEW_H`. The first version used
     * VIEW_H, which is three times taller than this canvas — so every reed was drawn hundreds of
     * pixels below the bitmap and none of them ever appeared. A silent no-op, and exactly the
     * kind that survives a code review because the code reads correctly.
     */
    const groundH = VIEW_H - GROUND_Y + 40;
    gc.fillStyle = env.fore;
    for (let x = -10; x < VIEW_W + 20; x += 15) {
      const h = 22 + ((x * 7919) % 26);
      gc.beginPath();
      gc.moveTo(x, groundH);
      gc.quadraticCurveTo(x + 5, groundH - h * 0.6, x + 2, groundH - h);
      gc.quadraticCurveTo(x + 9, groundH - h * 0.55, x + 11, groundH);
      gc.closePath();
      gc.fill();
    }
    this.ground = g.canvas;
  }

  draw(ctx: CanvasRenderingContext2D, time: number, env: Env): void {
    if (this.sky) ctx.drawImage(this.sky, 0, 0, VIEW_W, VIEW_H);

    for (const layer of this.layers) {
      const w = VIEW_W * 2;
      let offset = -(time * layer.speed) % w;
      if (offset > 0) offset -= w;
      ctx.drawImage(layer.canvas, offset, 0, w, VIEW_H);
      ctx.drawImage(layer.canvas, offset + w, 0, w, VIEW_H);
    }

    ctx.fillStyle = env.haze;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  /** Drawn after the ducks so a falling duck disappears behind the grass. */
  drawGround(ctx: CanvasRenderingContext2D): void {
    if (this.ground) ctx.drawImage(this.ground, 0, GROUND_Y - 40, VIEW_W, VIEW_H - GROUND_Y + 40);
  }
}

// ── ambience ────────────────────────────────────────────────────────────────

/**
 * The little things: clouds, leaves, snow, fog, fireflies.
 *
 * Kept to a fixed count and drawn from a deterministic walk, so the ambience costs the same
 * every frame and never competes with the ducks for attention. Weather is explicitly forbidden
 * from reducing contrast in the shootable band — fog sits below it, snow is drawn small and
 * sparse.
 */
export class Ambience {
  private t = 0;

  update(dt: number): void { this.t += dt; }

  draw(ctx: CanvasRenderingContext2D, env: Env, quality: 'low' | 'high'): void {
    const count = quality === 'low' ? 14 : 30;

    // Clouds, in every environment, high and slow.
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 5; i++) {
      const seed = i * 9973;
      const speed = 5 + (i % 3) * 4;
      let x = ((seed % VIEW_W) - this.t * speed) % (VIEW_W + 260);
      if (x < -260) x += VIEW_W + 260;
      const y = 30 + ((seed >> 4) % 90);
      const s = 40 + (i % 3) * 22;
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * 0.42, 0, 0, Math.PI * 2);
      ctx.ellipse(x + s * 0.6, y + 5, s * 0.7, s * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    for (let i = 0; i < count; i++) {
      const seed = i * 7919;
      switch (env.weather) {
        case 'leaves': {
          const x = ((seed % VIEW_W) + this.t * (22 + (i % 5) * 9)) % (VIEW_W + 40) - 20;
          const y = ((seed >> 3) % SKY_BOTTOM) + Math.sin(this.t * 0.8 + i) * 30
            + (this.t * 26) % (SKY_BOTTOM + 60);
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = i % 2 ? '#d8873a' : '#b85f2a';
          ctx.save();
          ctx.translate(x, y % (SKY_BOTTOM + 40));
          ctx.rotate(this.t * 1.6 + i);
          ctx.beginPath();
          ctx.ellipse(0, 0, 5, 3, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'snow': {
          const x = ((seed % VIEW_W) + Math.sin(this.t * 0.6 + i) * 26) % VIEW_W;
          const y = ((seed >> 3) % VIEW_H + this.t * (26 + (i % 4) * 12)) % VIEW_H;
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x, y, 1.4 + (i % 3) * 0.7, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'fireflies': {
          if (i > 12) break;
          const x = (seed % VIEW_W + Math.sin(this.t * 0.5 + i * 2) * 60) % VIEW_W;
          const y = SKY_BOTTOM - 40 + Math.sin(this.t * 0.9 + i) * 34;
          ctx.globalAlpha = 0.4 + Math.sin(this.t * 4 + i * 3) * 0.35;
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = '#ffe28a';
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
          break;
        }
        default: {
          if (i > 16) break;
          const x = ((seed % VIEW_W) + this.t * (7 + (i % 4) * 4)) % VIEW_W;
          const y = SKY_TOP + ((seed >> 5) % (SKY_BOTTOM - SKY_TOP));
          ctx.globalAlpha = 0.2;
          ctx.fillStyle = env.motes;
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();

    /**
     * Fog sits *below* the shootable band, never across it.
     *
     * Atmosphere must not become a difficulty modifier the player did not choose — a duck that
     * is hard to see because of weather is the least fair kind of hard there is.
     */
    if (env.weather === 'fog') {
      const g = ctx.createLinearGradient(0, SKY_BOTTOM - 20, 0, GROUND_Y + 30);
      g.addColorStop(0, 'rgba(230,244,248,0)');
      g.addColorStop(1, 'rgba(230,244,248,0.5)');
      ctx.fillStyle = g;
      ctx.fillRect(0, SKY_BOTTOM - 20, VIEW_W, GROUND_Y - SKY_BOTTOM + 50);
    }
  }
}

// ── particles ───────────────────────────────────────────────────────────────

export type ParticleKind = 'feather' | 'spark' | 'puff' | 'ring' | 'star';

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number;
  color: string; kind: ParticleKind; gravity: number; spin: number; angle: number;
  active: boolean;
}

export class Particles {
  private pool: Particle[] = [];
  private next = 0;
  quality: 'low' | 'high' = 'high';

  constructor(size = 260) {
    for (let i = 0; i < size; i++) {
      this.pool.push({
        x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 3,
        color: '#fff', kind: 'puff', gravity: 0, spin: 0, angle: 0, active: false,
      });
    }
  }

  emit(
    kind: ParticleKind, x: number, y: number, count: number,
    o: { color?: string; speed?: number; spread?: number; life?: number;
         size?: number; gravity?: number; dir?: number } = {}
  ): void {
    const n = this.quality === 'low' ? Math.ceil(count / 2) : count;
    for (let i = 0; i < n; i++) {
      const p = this.pool[this.next];
      this.next = (this.next + 1) % this.pool.length;
      const dir = o.dir ?? Math.random() * Math.PI * 2;
      const spread = o.spread ?? Math.PI * 2;
      const angle = dir + (Math.random() - 0.5) * spread;
      const speed = (o.speed ?? 110) * (0.5 + Math.random() * 0.8);
      p.x = x; p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.maxLife = p.life = (o.life ?? 0.7) * (0.7 + Math.random() * 0.6);
      p.size = (o.size ?? 6) * (0.6 + Math.random() * 0.8);
      p.color = o.color ?? '#fff';
      p.kind = kind;
      p.gravity = o.gravity ?? 260;
      p.spin = (Math.random() - 0.5) * 6;
      p.angle = Math.random() * Math.PI * 2;
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
      p.angle += p.spin * dt;
      // Feathers drift rather than fall — the whole reason to have them as a separate kind.
      const drag = p.kind === 'feather' ? 3.4 : 1.6;
      p.vx *= 1 - Math.min(1, drag * dt);
      if (p.kind === 'feather') p.vy *= 1 - Math.min(1, 2.6 * dt);
    }
  }

  draw(ctx: CanvasRenderingContext2D, cache: SpriteCache): void {
    ctx.save();
    for (const p of this.pool) {
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.min(1, t * 1.5);

      if (p.kind === 'feather') {
        const step = Math.floor(((p.angle % (Math.PI * 2)) / (Math.PI * 2)) * 8 + 8) % 8;
        const sprite = cache.feather(Math.round(p.size * 2), p.color, step);
        ctx.drawImage(sprite, p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
        continue;
      }

      ctx.globalCompositeOperation = p.kind === 'spark' || p.kind === 'star'
        ? 'lighter' : 'source-over';
      ctx.fillStyle = p.color;

      if (p.kind === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2.5 * t;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (2.6 - t * 1.8), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'star') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const r = i % 2 === 0 ? p.size : p.size * 0.4;
          const px = Math.cos(a) * r, py = Math.sin(a) * r;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (p.kind === 'puff' ? t : 1), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  clear(): void { for (const p of this.pool) p.active = false; }
}

// ── floating score labels ───────────────────────────────────────────────────

interface Label { x: number; y: number; text: string; life: number; color: string; big: boolean }

/** Score pop-ups. Pooled the same way, and always drawn above everything else. */
export class Labels {
  private items: Label[] = [];

  add(x: number, y: number, text: string, color = '#fff3cf', big = false): void {
    this.items.push({ x, y, text, life: 1, color, big });
    if (this.items.length > 24) this.items.shift();
  }

  update(dt: number): void {
    for (const l of this.items) { l.life -= dt * 1.1; l.y -= dt * 46; }
    this.items = this.items.filter((l) => l.life > 0);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const l of this.items) {
      const scale = l.big ? 1.5 : 1;
      ctx.globalAlpha = Math.min(1, l.life * 1.6);
      ctx.font = `800 ${Math.round(17 * scale)}px system-ui, sans-serif`;
      ctx.lineWidth = 4 * scale;
      ctx.strokeStyle = 'rgba(24,16,10,0.75)';
      ctx.strokeText(l.text, l.x, l.y);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, l.x, l.y);
    }
    ctx.restore();
  }

  clear(): void { this.items = []; }
}

export { DOG_W, DOG_H };
