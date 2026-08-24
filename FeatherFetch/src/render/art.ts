/**
 * Every pixel, drawn from code.
 *
 * No image files. Ducks, the dog, the weapon, the environments and the particles are all vector
 * paths rasterised once into offscreen canvases at the size and pixel ratio the game needs, then
 * blitted. Zero art bytes over the wire, crisp on a retina screen, and a cosmetic restyles the
 * whole cast by changing two colours.
 *
 * The two characters carry the game. A duck has to be identifiable by *silhouette* at 40 pixels
 * while crossing the screen in a second and a half, so each type differs in size and outline as
 * well as colour. Biscuit the retriever has to be legible and funny in eleven different poses at
 * a size where a face is about twelve pixels across, so the expression lives in the ears, the
 * tail and the tilt of the head rather than in the features.
 */

export interface Env {
  name: string;
  sky: [string, string];
  far: string;
  mid: string;
  near: string;
  grass: string;
  grassDark: string;
  /** Foreground reeds/bushes at the very bottom. */
  fore: string;
  haze: string;
  /** Ambient particle colour and kind. */
  motes: string;
  weather: 'none' | 'leaves' | 'snow' | 'fog' | 'fireflies';
}

/**
 * Five environments.
 *
 * Each is built around one decision about light — midday overhead, flat overcast on water, low
 * sun through leaves, sunset behind the marsh, cold blue on snow — and everything else follows
 * from it. Contrast between sky and ducks is held roughly constant across all five, because an
 * environment that makes the targets harder to see is not a mood, it is a difficulty spike the
 * player did not agree to.
 */
export const ENVIRONMENTS: Env[] = [
  {
    name: 'Sunny Meadow',
    sky: ['#5cb8e8', '#c9ecff'], far: '#8fbfd8', mid: '#7fb56a', near: '#4f8f46',
    grass: '#5da84a', grassDark: '#3d7a33', fore: '#356b2c',
    haze: 'rgba(255,246,210,0.05)', motes: 'rgba(255,255,255,0.55)', weather: 'none',
  },
  {
    name: 'Forest Lake',
    sky: ['#7fb6c9', '#dceef2'], far: '#8aa9b0', mid: '#557a68', near: '#33564a',
    grass: '#3f6f57', grassDark: '#2b5040', fore: '#22422f',
    haze: 'rgba(200,235,240,0.09)', motes: 'rgba(220,245,255,0.5)', weather: 'fog',
  },
  {
    name: 'Autumn Woods',
    sky: ['#e8a95c', '#ffe6bd'], far: '#c98f5f', mid: '#a35f2f', near: '#7a3f22',
    grass: '#8a6a2f', grassDark: '#5f4620', fore: '#4a3418',
    haze: 'rgba(255,190,120,0.08)', motes: 'rgba(255,205,140,0.6)', weather: 'leaves',
  },
  {
    name: 'Sunset Marsh',
    sky: ['#e2643f', '#ffc98a'], far: '#a8543f', mid: '#6a3a3f', near: '#43273a',
    grass: '#5a4340', grassDark: '#3a2a2c', fore: '#2a1e22',
    haze: 'rgba(255,150,90,0.1)', motes: 'rgba(255,210,150,0.55)', weather: 'fireflies',
  },
  {
    name: 'Snowy Valley',
    sky: ['#8fb6d8', '#e8f4ff'], far: '#a8c4d8', mid: '#6f8aa0', near: '#4f6a80',
    grass: '#dce8f2', grassDark: '#b0c4d4', fore: '#93a8bc',
    haze: 'rgba(255,255,255,0.1)', motes: 'rgba(255,255,255,0.75)', weather: 'snow',
  },
];

export const envFor = (index: number): Env =>
  ENVIRONMENTS[Math.max(0, Math.min(ENVIRONMENTS.length - 1, index))];

// ── helpers ─────────────────────────────────────────────────────────────────

export function makeCanvas(w: number, h: number, dpr: number): {
  canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return { canvas, ctx };
}

export function shade(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${clamp(((n >> 16) & 255) + amount * 255)},`
       + `${clamp(((n >> 8) & 255) + amount * 255)},`
       + `${clamp((n & 255) + amount * 255)})`;
}

export function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number
): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ── ducks ───────────────────────────────────────────────────────────────────

export type DuckPose = 'up' | 'mid' | 'down' | 'glide' | 'hit' | 'fall';

/**
 * Draw a duck facing right, into a box of `size` × `size * 0.78`.
 *
 * Four flap frames rather than a continuous rig: at this size a hand-placed wing beat reads
 * far better than an interpolated one, and the shape of the wing is most of what makes a duck
 * legible against a busy background. The body is drawn *after* the far wing and *before* the
 * near one, so the wing genuinely passes in front of and behind it.
 */
export function drawDuck(
  ctx: CanvasRenderingContext2D, pose: DuckPose, size: number,
  colors: [string, string, string], armored = false
): void {
  const [body, wing, accent] = colors;
  const w = size;
  const h = size * 0.78;
  const outline = 'rgba(26, 18, 12, 0.85)';

  // Wing angle and body tilt per pose.
  let wingA = 0, tilt = 0, headDrop = 0;
  switch (pose) {
    case 'up': wingA = -1.15; tilt = -0.08; break;
    case 'mid': wingA = -0.25; tilt = 0; break;
    case 'down': wingA = 0.85; tilt = 0.06; break;
    case 'glide': wingA = -0.05; tilt = 0.02; break;
    case 'hit': wingA = 1.35; tilt = 0.5; headDrop = 3; break;
    case 'fall': wingA = 1.5; tilt = 1.15; headDrop = 5; break;
  }

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(tilt);
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.2, size * 0.035);
  ctx.strokeStyle = outline;

  const S = size / 46;   // everything below is authored at size 46 and scaled

  // Far wing, behind the body.
  ctx.save();
  ctx.translate(-2 * S, -2 * S);
  ctx.rotate(wingA * 0.75);
  ctx.fillStyle = shade(wing, -0.14);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-14 * S, -6 * S, -20 * S, 4 * S);
  ctx.quadraticCurveTo(-11 * S, 6 * S, 0, 2 * S);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();

  // Tail.
  ctx.fillStyle = shade(body, -0.1);
  ctx.beginPath();
  ctx.moveTo(-13 * S, 0);
  ctx.lineTo(-23 * S, -5 * S);
  ctx.lineTo(-21 * S, 3 * S);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Body.
  const grad = ctx.createLinearGradient(0, -10 * S, 0, 10 * S);
  grad.addColorStop(0, shade(body, 0.18));
  grad.addColorStop(1, shade(body, -0.12));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(-2 * S, 1 * S, 14 * S, 9 * S, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();

  // Belly, a lighter patch that keeps the underside from going flat.
  ctx.fillStyle = shade(body, 0.3);
  ctx.beginPath();
  ctx.ellipse(-3 * S, 4 * S, 9 * S, 4.5 * S, 0, 0, Math.PI * 2);
  ctx.fill();

  // Neck and head.
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(8 * S, -3 * S);
  ctx.quadraticCurveTo(14 * S, -8 * S + headDrop * S, 15 * S, -9 * S + headDrop * S);
  ctx.lineTo(17 * S, -4 * S + headDrop * S);
  ctx.quadraticCurveTo(13 * S, -1 * S, 9 * S, 2 * S);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = shade(body, 0.24);
  ctx.beginPath();
  ctx.ellipse(16 * S, -9 * S + headDrop * S, 6.2 * S, 5.4 * S, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();

  // Bill — the accent colour, and the single most recognisable part of a duck.
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(21 * S, -10 * S + headDrop * S);
  ctx.quadraticCurveTo(29 * S, -9 * S + headDrop * S, 28 * S, -6.5 * S + headDrop * S);
  ctx.quadraticCurveTo(24 * S, -5.5 * S + headDrop * S, 21 * S, -7 * S + headDrop * S);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Eye. A hit duck gets a cross, which is comic rather than gruesome — the game is meant to be
  // family-friendly and the difference is entirely in this one shape.
  if (pose === 'hit' || pose === 'fall') {
    ctx.strokeStyle = '#241a12';
    ctx.lineWidth = Math.max(1.2, 1.6 * S);
    const ex = 17.5 * S, ey = -10.5 * S + headDrop * S, r = 2.1 * S;
    ctx.beginPath();
    ctx.moveTo(ex - r, ey - r); ctx.lineTo(ex + r, ey + r);
    ctx.moveTo(ex + r, ey - r); ctx.lineTo(ex - r, ey + r);
    ctx.stroke();
    ctx.strokeStyle = outline;
  } else {
    ctx.fillStyle = '#fdfdfd';
    ctx.beginPath();
    ctx.arc(17.5 * S, -10.5 * S + headDrop * S, 2.4 * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#241a12';
    ctx.beginPath();
    ctx.arc(18.2 * S, -10.5 * S + headDrop * S, 1.3 * S, 0, Math.PI * 2);
    ctx.fill();
  }

  // Armour plating, for the Ironback — a visual promise that one shell will not do it.
  if (armored) {
    ctx.strokeStyle = shade(accent, -0.1);
    ctx.lineWidth = Math.max(1.4, 2 * S);
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(-3 * S + i * 6 * S, 1 * S, 6.5 * S, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.max(1.2, size * 0.035);
  }

  // Near wing, in front of the body.
  ctx.save();
  ctx.translate(-1 * S, -1 * S);
  ctx.rotate(wingA);
  ctx.fillStyle = wing;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-15 * S, -8 * S, -23 * S, 3 * S);
  ctx.quadraticCurveTo(-12 * S, 7 * S, 0, 3 * S);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Wing tip highlight, which is what makes the beat readable at speed.
  ctx.fillStyle = shade(wing, 0.28);
  ctx.beginPath();
  ctx.moveTo(-8 * S, 0);
  ctx.quadraticCurveTo(-16 * S, -3 * S, -21 * S, 2.5 * S);
  ctx.quadraticCurveTo(-14 * S, 3 * S, -8 * S, 1.5 * S);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

/** A rare duck gets a halo, so it is spotted the instant it enters. */
export function drawDuckGlow(
  ctx: CanvasRenderingContext2D, size: number, color: string, phase: number
): void {
  const r = size * (0.8 + Math.sin(phase * 5) * 0.08);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(size / 2, size * 0.39, 0, size / 2, size * 0.39, r);
  g.addColorStop(0, color);
  g.addColorStop(0.45, 'rgba(255,210,110,0.22)');
  g.addColorStop(1, 'rgba(255,180,60,0)');
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = g;
  ctx.fillRect(-r, -r, size + r * 2, size + r * 2);
  ctx.restore();
}

// ── Biscuit ─────────────────────────────────────────────────────────────────

export type DogPose =
  | 'idle' | 'sniff' | 'run1' | 'run2' | 'leap' | 'found'
  | 'carry' | 'proud' | 'tease' | 'confused' | 'sleep';

export const DOG_W = 76;
export const DOG_H = 62;

/**
 * Biscuit, an original brown-and-white retriever with a bandana.
 *
 * Everything expressive is in three places: the ears (up, flat, one-up), the tail (still,
 * wagging, tucked) and the head tilt. At the size this is drawn, the face is about ten pixels
 * across and cannot carry an expression — so the pose does, and it reads from across the room.
 */
export function drawDog(
  ctx: CanvasRenderingContext2D, pose: DogPose, phase: number, bandana: string
): void {
  const coat = '#b9773f';
  const patch = '#f4e4cf';
  const dark = shade(coat, -0.22);
  const outline = 'rgba(40, 24, 14, 0.88)';

  let tilt = 0, bob = 0, tailA = 0, earA = 0, legF = 0, legB = 0;
  let mouthOpen = false, eyesShut = false, carrying = false;

  switch (pose) {
    case 'idle': bob = Math.sin(phase * 2.4) * 1.2; tailA = Math.sin(phase * 5) * 0.5; break;
    case 'sniff': tilt = 0.22; bob = 1.5; tailA = Math.sin(phase * 8) * 0.7; earA = 0.3; break;
    case 'run1': legF = 9; legB = -8; bob = -2; tailA = 0.5; tilt = 0.06; break;
    case 'run2': legF = -8; legB = 9; bob = 0; tailA = -0.3; tilt = 0.06; break;
    case 'leap': legF = 12; legB = -12; bob = -6; tailA = 0.9; tilt = -0.16; break;
    case 'found': tilt = -0.1; bob = -2; tailA = Math.sin(phase * 14) * 1.1; mouthOpen = true; break;
    case 'carry': carrying = true; bob = Math.sin(phase * 6) * 1.4; tailA = Math.sin(phase * 9) * 0.8; break;
    case 'proud': carrying = true; tilt = -0.12; bob = -3; tailA = Math.sin(phase * 12) * 1.2; break;
    case 'tease': tilt = -0.2; bob = -2; mouthOpen = true; tailA = Math.sin(phase * 10) * 1.1; earA = -0.25; break;
    case 'confused': tilt = 0.3; earA = 0.5; tailA = -0.2; break;
    case 'sleep': tilt = 0.1; bob = 2; eyesShut = true; tailA = Math.sin(phase * 1.2) * 0.2; break;
  }

  ctx.save();
  ctx.translate(DOG_W / 2, DOG_H + bob);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = outline;

  // Contact shadow.
  ctx.save();
  ctx.globalAlpha = pose === 'leap' ? 0.1 : 0.22;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, 0, 24, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const leg = (x: number, offset: number, back: boolean) => {
    ctx.strokeStyle = back ? dark : coat;
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.moveTo(x, -18);
    ctx.quadraticCurveTo(x + offset * 0.5, -10, x + offset, -1);
    ctx.stroke();
    ctx.fillStyle = patch;
    ctx.beginPath();
    ctx.ellipse(x + offset, -1.5, 4, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.8;
  };

  leg(-11, legB, true);
  leg(10, legF * 0.7, true);

  // Tail — the loudest signal in the whole character.
  ctx.save();
  ctx.translate(-19, -26);
  ctx.rotate(-0.5 + tailA);
  ctx.strokeStyle = coat;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-8, -6, -13, -13);
  ctx.stroke();
  ctx.strokeStyle = patch;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-9, -8);
  ctx.quadraticCurveTo(-11, -11, -13, -13);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.8;

  // Body.
  const grad = ctx.createLinearGradient(0, -34, 0, -12);
  grad.addColorStop(0, shade(coat, 0.16));
  grad.addColorStop(1, shade(coat, -0.08));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(-2, -25, 19, 12, -0.06, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();

  // Chest patch.
  ctx.fillStyle = patch;
  ctx.beginPath();
  ctx.ellipse(8, -21, 8, 7.5, 0, 0, Math.PI * 2);
  ctx.fill();

  leg(-6, legF, false);
  leg(14, legB * 0.7, false);

  // Head.
  ctx.save();
  ctx.translate(17, -36);
  ctx.rotate(tilt);

  // Ears, drawn before the skull so they hang behind it.
  ctx.fillStyle = dark;
  for (const [i, side] of [-1, 1].entries()) {
    ctx.save();
    ctx.rotate(side * 0.2 + earA * (i === 0 ? -1 : 1));
    ctx.beginPath();
    ctx.moveTo(side * 5, -4);
    ctx.quadraticCurveTo(side * 15, 2, side * 11, 14);
    ctx.quadraticCurveTo(side * 4, 10, side * 3, -2);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(0, 0, 12, 10.5, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();

  // Muzzle.
  ctx.fillStyle = patch;
  ctx.beginPath();
  ctx.ellipse(7, 4, 8, 6, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#3a241a';
  ctx.beginPath();
  ctx.ellipse(13, 2.5, 2.8, 2.2, 0, 0, Math.PI * 2);
  ctx.fill();

  if (mouthOpen) {
    ctx.fillStyle = '#8a3b3b';
    ctx.beginPath();
    ctx.ellipse(8, 8.5, 4.5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // A lolling tongue is most of what makes the tease pose funny rather than smug.
    ctx.fillStyle = '#e2717f';
    ctx.beginPath();
    ctx.ellipse(9, 11, 3, 2.4, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Eyes.
  if (eyesShut) {
    ctx.strokeStyle = '#3a241a';
    ctx.lineWidth = 1.6;
    for (const ex of [1, 8]) {
      ctx.beginPath();
      ctx.arc(ex, -2, 2.4, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.8;
  } else {
    for (const ex of [1, 8]) {
      ctx.fillStyle = '#fdfdfd';
      ctx.beginPath();
      ctx.arc(ex, -2.5, 3.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2a1a12';
      ctx.beginPath();
      ctx.arc(ex + (pose === 'confused' ? 0.9 : 0.6), -2.5, 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(ex + 1.3, -3.5, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // A question mark for the confused pose — the one place a symbol beats a pose.
  if (pose === 'confused') {
    ctx.fillStyle = '#fff3cf';
    ctx.strokeStyle = 'rgba(40,24,14,0.8)';
    ctx.lineWidth = 1.4;
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeText('?', 2, -16);
    ctx.fillText('?', 2, -16);
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = outline;
  }
  ctx.restore();

  // Bandana, over the neck join. Its colour is the customisation.
  ctx.save();
  ctx.translate(11, -32);
  ctx.rotate(tilt * 0.5);
  ctx.fillStyle = bandana;
  ctx.beginPath();
  ctx.moveTo(-8, -4);
  ctx.lineTo(9, -3);
  ctx.lineTo(2, 9);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = shade(bandana, -0.2);
  ctx.beginPath();
  ctx.moveTo(-8, -4);
  ctx.lineTo(1, -1);
  ctx.lineTo(2, 9);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.restore();
  void carrying;
}

// ── the weapon ──────────────────────────────────────────────────────────────

/**
 * The barrel, drawn at the bottom edge of the screen.
 *
 * Deliberately just a hint of a gun: a foreshortened double barrel and a sliver of stock,
 * pointing where the crosshair is. Enough to anchor the muzzle flash and the recoil, not so much
 * that it eats the playfield or turns an arcade game into a weapon simulator.
 */
export function drawWeapon(
  ctx: CanvasRenderingContext2D, x: number, y: number, aimX: number, aimY: number,
  recoil: number, barrelColor: string, stockColor: string
): void {
  const angle = Math.atan2(aimY - y, aimX - x);
  ctx.save();
  ctx.translate(x, y + recoil * 14);
  ctx.rotate(angle + Math.PI / 2);
  ctx.lineJoin = 'round';

  ctx.fillStyle = stockColor;
  roundRect(ctx, -13, 4, 26, 46, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,14,10,0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const grad = ctx.createLinearGradient(-11, 0, 11, 0);
  grad.addColorStop(0, shade(barrelColor, -0.22));
  grad.addColorStop(0.45, shade(barrelColor, 0.24));
  grad.addColorStop(1, shade(barrelColor, -0.28));
  ctx.fillStyle = grad;
  roundRect(ctx, -11, -46 - recoil * 5, 22, 54, 5);
  ctx.fill(); ctx.stroke();

  // Two bores, which is the whole reason it reads as a shotgun.
  ctx.fillStyle = 'rgba(12,8,6,0.9)';
  for (const bx of [-5, 5]) {
    ctx.beginPath();
    ctx.ellipse(bx, -45 - recoil * 5, 3.4, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Muzzle flash: three overlapping shapes, gone in two frames. */
export function drawMuzzleFlash(
  ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, t: number
): void {
  const fade = 1 - t;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = fade;

  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 42 * fade);
  g.addColorStop(0, '#fffbe0');
  g.addColorStop(0.35, 'rgba(255,196,90,0.7)');
  g.addColorStop(1, 'rgba(255,140,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-46, -46, 92, 92);

  ctx.fillStyle = '#fff3c0';
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = (i % 2 === 0 ? 26 : 10) * fade;
    const px = Math.cos(a) * r, py = Math.sin(a) * r;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The crosshair.
 *
 * Four ticks and a dot, with a gap in the middle so it never hides the thing being aimed at —
 * which a solid cross does, and which is the most common way a shooter's crosshair gets in the
 * way. It spreads on recoil and flashes green on a hit.
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D, x: number, y: number,
  spread: number, hitFlash: number, empty: boolean
): void {
  const gap = 7 + spread * 9;
  const len = 9;
  const color = hitFlash > 0 ? '#8dff9a' : empty ? '#ff8a7a' : '#ffffff';

  ctx.save();
  ctx.translate(x, y);
  ctx.lineCap = 'round';

  // A dark under-stroke, so the crosshair stays visible on snow and on sky alike.
  for (const [width, stroke] of [[4.5, 'rgba(20,14,10,0.55)'], [2, color]] as const) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      ctx.moveTo(dx * gap, dy * gap);
      ctx.lineTo(dx * (gap + len), dy * (gap + len));
    }
    ctx.stroke();
  }

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
  ctx.fill();

  if (hitFlash > 0) {
    ctx.globalAlpha = hitFlash;
    ctx.strokeStyle = '#8dff9a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 14 + (1 - hitFlash) * 16, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** A shell icon for the HUD — filled when loaded, hollow when spent. */
export function drawShell(ctx: CanvasRenderingContext2D, w: number, h: number, loaded: boolean): void {
  ctx.save();
  if (loaded) {
    ctx.fillStyle = '#c9452f';
    roundRect(ctx, 1, h * 0.28, w - 2, h * 0.72, 2);
    ctx.fill();
    ctx.fillStyle = '#e0b04a';
    roundRect(ctx, 1, 1, w - 2, h * 0.34, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,14,10,0.6)';
    ctx.lineWidth = 1.2;
    roundRect(ctx, 1, 1, w - 2, h - 2, 2);
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.4;
    roundRect(ctx, 1, 1, w - 2, h - 2, 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** A feather, for the hit burst. */
export function drawFeather(
  ctx: CanvasRenderingContext2D, size: number, color: string, angle: number
): void {
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.5);
  ctx.quadraticCurveTo(size * 0.32, 0, 0, size * 0.5);
  ctx.quadraticCurveTo(-size * 0.32, 0, 0, -size * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.45);
  ctx.lineTo(0, size * 0.45);
  ctx.stroke();
  ctx.restore();
}
