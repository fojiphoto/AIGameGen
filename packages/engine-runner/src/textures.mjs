/**
 * Procedural texture generation from the config palette.
 *
 * v1 ships ZERO art files. Every sprite is drawn at boot from the seven palette
 * colours, which means:
 *   • the APK stays tiny (no atlas, no PNGs)
 *   • any theme the AI invents is renderable immediately
 *   • no asset licensing questions at all
 *
 * §B4's asset-pack resolver slots in later behind the same `assetSlots` names —
 * this module is the fallback renderer, not a dead end.
 */

const toInt = (hex) => parseInt(hex.slice(1), 16);

/** Lighten/darken a #rrggbb hex by ratio (-1..1). */
export function shade(hex, ratio) {
  const n = toInt(hex);
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;
  if (ratio >= 0) {
    r += (255 - r) * ratio;
    g += (255 - g) * ratio;
    b += (255 - b) * ratio;
  } else {
    const k = 1 + ratio;
    r *= k;
    g *= k;
    b *= k;
  }
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

export const asInt = toInt;

function makeGfx(scene) {
  return scene.make.graphics({ x: 0, y: 0, add: false });
}

/** Player: rounded body, visor stripe, subtle outline — reads at speed. */
function playerTexture(scene, palette, size) {
  const g = makeGfx(scene);
  const c = toInt(palette.player);
  const r = Math.max(4, Math.round(size * 0.22));

  g.fillStyle(shade(palette.player, -0.45), 1);
  g.fillRoundedRect(2, 2, size, size, r);
  g.fillStyle(c, 1);
  g.fillRoundedRect(0, 0, size, size, r);
  // visor
  g.fillStyle(shade(palette.player, -0.55), 1);
  g.fillRoundedRect(size * 0.22, size * 0.28, size * 0.56, size * 0.2, r * 0.5);
  g.fillStyle(toInt(palette.accent), 1);
  g.fillRoundedRect(size * 0.26, size * 0.32, size * 0.34, size * 0.1, 2);
  // feet
  g.fillStyle(shade(palette.player, -0.35), 1);
  g.fillRect(size * 0.16, size * 0.86, size * 0.22, size * 0.14);
  g.fillRect(size * 0.62, size * 0.86, size * 0.22, size * 0.14);

  g.generateTexture('player', size + 3, size + 3);
  g.destroy();
}

/** One texture per obstacle, shaped by kind so each reads differently. */
function obstacleTexture(scene, ob, palette) {
  const g = makeGfx(scene);
  const w = ob.width;
  const h = ob.height;
  const base = palette.obstacle;
  const dark = shade(base, -0.4);
  const light = shade(base, 0.3);

  switch (ob.kind) {
    case 'ground_spike': {
      const teeth = Math.max(2, Math.round(w / 14));
      g.fillStyle(dark, 1);
      g.fillRect(0, h * 0.82, w, h * 0.18);
      g.fillStyle(toInt(base), 1);
      for (let i = 0; i < teeth; i++) {
        const tw = w / teeth;
        g.fillTriangle(i * tw, h, i * tw + tw / 2, 0, (i + 1) * tw, h);
      }
      break;
    }
    case 'tall_block': {
      g.fillStyle(dark, 1);
      g.fillRect(0, 0, w, h);
      g.fillStyle(toInt(base), 1);
      g.fillRect(0, 0, w - 3, h - 3);
      g.fillStyle(light, 1);
      for (let y = 6; y < h - 8; y += 12) g.fillRect(4, y, w - 11, 3);
      break;
    }
    case 'low_bar': {
      g.fillStyle(dark, 1);
      g.fillRect(0, 0, w, h);
      g.fillStyle(toInt(base), 1);
      g.fillRect(0, 0, w, h - 3);
      g.fillStyle(toInt(palette.accent), 1);
      for (let x = 4; x < w - 6; x += 14) g.fillRect(x, h * 0.32, 8, h * 0.28);
      break;
    }
    case 'flying_drone': {
      g.fillStyle(dark, 1);
      g.fillEllipse(w / 2, h / 2 + 2, w, h);
      g.fillStyle(toInt(base), 1);
      g.fillEllipse(w / 2, h / 2, w * 0.92, h * 0.86);
      g.fillStyle(toInt(palette.accent), 1);
      g.fillCircle(w / 2, h / 2, Math.max(2, h * 0.18));
      g.fillStyle(light, 1);
      g.fillRect(0, h * 0.14, w, 2);
      break;
    }
    case 'moving_saw': {
      const cx = w / 2;
      const cy = h / 2;
      const rad = Math.min(w, h) / 2;
      g.fillStyle(dark, 1);
      g.fillCircle(cx, cy, rad);
      g.fillStyle(toInt(base), 1);
      g.fillCircle(cx, cy, rad * 0.84);
      g.fillStyle(dark, 1);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.fillCircle(cx + Math.cos(a) * rad * 0.88, cy + Math.sin(a) * rad * 0.88, rad * 0.16);
      }
      g.fillStyle(toInt(palette.accent), 1);
      g.fillCircle(cx, cy, rad * 0.22);
      break;
    }
    case 'gap': {
      // rendered as a hole in the ground — this texture is only the edge lip
      g.fillStyle(shade(palette.ground, -0.6), 1);
      g.fillRect(0, 0, w, h);
      break;
    }
    default: {
      g.fillStyle(toInt(base), 1);
      g.fillRect(0, 0, w, h);
    }
  }

  g.generateTexture(`ob_${ob.id}`, w, Math.max(1, h));
  g.destroy();
}

/** Ground strip: a repeating tile so scrolling is cheap. */
export function groundTexture(scene, palette, height) {
  const g = makeGfx(scene);
  const W = 64;
  g.fillStyle(toInt(palette.ground), 1);
  g.fillRect(0, 0, W, height);
  g.fillStyle(shade(palette.ground, 0.22), 1);
  g.fillRect(0, 0, W, 4);
  g.fillStyle(shade(palette.ground, -0.3), 1);
  for (let x = 0; x < W; x += 16) g.fillRect(x, 10, 8, 3);
  g.fillStyle(shade(palette.ground, -0.45), 1);
  g.fillRect(0, height - 6, W, 6);
  g.generateTexture('ground', W, height);
  g.destroy();
}

/** Two parallax silhouette bands built from bgAccent. */
export function parallaxTextures(scene, palette, viewW, viewH) {
  for (const [name, scale, ratio] of [
    ['par_far', 0.42, -0.15],
    ['par_near', 0.28, 0.1],
  ]) {
    const g = makeGfx(scene);
    const h = Math.round(viewH * scale);
    g.fillStyle(shade(palette.bgAccent, ratio), 1);
    let x = 0;
    let i = 0;
    while (x < viewW) {
      const w = 40 + ((i * 37) % 90);
      const top = h - (18 + ((i * 53) % Math.max(20, h - 20)));
      g.fillRect(x, top, w, h - top);
      x += w + 8 + ((i * 17) % 26);
      i++;
    }
    g.generateTexture(name, viewW, h);
    g.destroy();
  }
}

/** Soft glow dot used for stars and score pops. */
export function dotTexture(scene, palette) {
  const g = makeGfx(scene);
  g.fillStyle(toInt(palette.text), 0.9);
  g.fillCircle(4, 4, 3);
  g.generateTexture('dot', 8, 8);
  g.destroy();

  const a = makeGfx(scene);
  a.fillStyle(toInt(palette.accent), 1);
  a.fillCircle(5, 5, 4);
  a.generateTexture('spark', 10, 10);
  a.destroy();
}

export function buildAllTextures(scene, cfg, viewW, viewH) {
  const p = cfg.theme.palette;
  playerTexture(scene, p, cfg.player.size);
  groundTexture(scene, p, cfg.world.groundHeight);
  parallaxTextures(scene, p, viewW, viewH);
  dotTexture(scene, p);
  for (const ob of cfg.obstacles) obstacleTexture(scene, ob, p);
}
