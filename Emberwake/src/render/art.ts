/**
 * Every pixel in the game, drawn from code.
 *
 * No image files, no sprite sheets, no atlas to download. Each sprite is a set of vector paths
 * rasterised once into an offscreen canvas at the size and device pixel ratio the game actually
 * needs, then blitted. That buys three things at once: the whole game costs zero art bytes over
 * the wire, everything is crisp on a retina screen because it is re-rendered rather than scaled,
 * and a skin or a world palette restyles the entire cast by changing three colours.
 *
 * The character is the part that matters most. Nim is a small lantern-bearing creature — a round
 * body, two tall ears, a scarf that trails, and an ember carried at the hip that is the only
 * bright thing in a dark world. The silhouette is deliberately simple and deliberately
 * asymmetric: round body, pointed ears, trailing scarf. At 36 pixels tall against a busy jungle
 * background that reads instantly, which is the only test of a platformer character that counts.
 */

export interface Palette {
  /** Character. */
  body: string;
  trim: string;
  glow: string;
  /** Terrain. */
  groundTop: string;
  groundFace: string;
  groundDeep: string;
  rock: string;
  platform: string;
  platformEdge: string;
  /** Hazards. */
  spike: string;
  liquid: string;
  liquidGlow: string;
  /** Backdrop layers, far to near. */
  sky: [string, string];
  far: string;
  mid: string;
  near: string;
  /** Atmosphere tint drawn over everything. */
  haze: string;
  /** Ambient motes. */
  mote: string;
}

/**
 * One palette per world.
 *
 * Each is built around a single decision about light: Sunlit Reach is lit from above, Crystal
 * Deep only by what Nim carries, Verdant Snarl by what filters through leaves, Foundry Ash by
 * the furnaces below, Sky Ruin by an unobstructed sun. Everything else follows from that, which
 * is why the five look like five places rather than five hue rotations.
 */
export const WORLD_PALETTES: Palette[] = [
  { // 1 — Sunlit Reach
    body: '#ff9b4a', trim: '#ffe2b0', glow: '#ffd27a',
    groundTop: '#7ec850', groundFace: '#8a6242', groundDeep: '#5d4230',
    rock: '#6f7f8c', platform: '#a5743f', platformEdge: '#c9a06a',
    spike: '#d8dee8', liquid: '#3aa7d8', liquidGlow: '#8ad8f5',
    sky: ['#87ceeb', '#d9f0ff'], far: '#9dc7d8', mid: '#7fb26a', near: '#4f8c46',
    haze: 'rgba(255, 236, 190, 0.06)', mote: 'rgba(255,255,255,0.5)',
  },
  { // 2 — Crystal Deep
    body: '#ff9b4a', trim: '#ffe2b0', glow: '#ffd27a',
    groundTop: '#6d7fbd', groundFace: '#3a3f6b', groundDeep: '#242849',
    rock: '#4a5080', platform: '#4b5590', platformEdge: '#8fa0e0',
    spike: '#c8d8ff', liquid: '#5a3fa8', liquidGlow: '#b48cff',
    sky: ['#101733', '#1e2a52'], far: '#26315c', mid: '#2f3d70', near: '#1a2140',
    haze: 'rgba(120, 160, 255, 0.07)', mote: 'rgba(180,220,255,0.65)',
  },
  { // 3 — Verdant Snarl
    body: '#ff9b4a', trim: '#ffe2b0', glow: '#ffd27a',
    groundTop: '#5fa83c', groundFace: '#4a3a26', groundDeep: '#2f2618',
    rock: '#57604a', platform: '#6b5330', platformEdge: '#96773f',
    spike: '#cbe0a8', liquid: '#2f7a52', liquidGlow: '#7de0a8',
    sky: ['#1d3a24', '#31663a'], far: '#2c5230', mid: '#23461f', near: '#132c14',
    haze: 'rgba(140, 255, 170, 0.06)', mote: 'rgba(210,255,180,0.5)',
  },
  { // 4 — Foundry Ash
    body: '#ff9b4a', trim: '#ffe2b0', glow: '#ffd27a',
    groundTop: '#6a6a72', groundFace: '#3d3a3f', groundDeep: '#241f24',
    rock: '#4a444a', platform: '#5a4238', platformEdge: '#a05f38',
    spike: '#ffb066', liquid: '#e0491c', liquidGlow: '#ffb04a',
    sky: ['#2a1210', '#5c2416'], far: '#43201c', mid: '#301715', near: '#1b0e0c',
    haze: 'rgba(255, 130, 60, 0.09)', mote: 'rgba(255,170,90,0.6)',
  },
  { // 5 — Sky Ruin
    body: '#ff9b4a', trim: '#ffe2b0', glow: '#ffd27a',
    groundTop: '#d9e4ef', groundFace: '#8d9bb0', groundDeep: '#5f6b80',
    rock: '#9aa7ba', platform: '#b0bccd', platformEdge: '#e6eef8',
    spike: '#ffffff', liquid: '#7fb7ff', liquidGlow: '#cfe6ff',
    sky: ['#5aa7e8', '#cfe9ff'], far: '#a9cbe8', mid: '#8fb4d8', near: '#6f97c0',
    haze: 'rgba(255, 255, 255, 0.08)', mote: 'rgba(255,255,255,0.6)',
  },
];

/**
 * A world's palette, as a fresh copy.
 *
 * A copy, not the shared object. Skins recolour the character by overwriting `body`, `trim` and
 * `glow` on the palette a level is using — and handing out the shared instance means the first
 * skin a player picks permanently repaints every world, including the menu behind them.
 */
export const paletteForWorld = (world: number): Palette =>
  ({ ...WORLD_PALETTES[Math.max(0, Math.min(WORLD_PALETTES.length - 1, world - 1))] });

// ── canvas helpers ──────────────────────────────────────────────────────────

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

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function shade(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) + amount * 255);
  const g = clamp(((n >> 8) & 255) + amount * 255);
  const b = clamp((n & 255) + amount * 255);
  return `rgb(${r},${g},${b})`;
}

// ── the hero ────────────────────────────────────────────────────────────────

export type HeroPose =
  | 'idle' | 'run1' | 'run2' | 'run3' | 'run4'
  | 'jump' | 'fall' | 'land' | 'turn' | 'dash' | 'hurt' | 'wallSlide' | 'victory';

const HERO_W = 40;
const HERO_H = 44;

/**
 * Draw Nim in a pose, into a `HERO_W` x `HERO_H` box with the feet at the bottom.
 *
 * Poses are drawn rather than interpolated — a run cycle of four hand-placed frames reads far
 * better at this size than a rig blending between two. The parts that *do* move continuously —
 * the scarf, the ember's flicker, the ears — are driven by a phase passed in, so the character
 * is never completely still even in a held pose.
 */
export function drawHero(
  ctx: CanvasRenderingContext2D, pose: HeroPose, palette: Palette, phase: number
): void {
  const { body, trim, glow } = palette;
  const outline = 'rgba(24, 14, 8, 0.85)';

  // Per-pose geometry. `lean` tilts the whole character, `bob` raises it, the legs are drawn
  // from explicit offsets so a run cycle actually has a contact and a passing pose.
  let lean = 0, bob = 0, earFlop = 0, scarf = 0;
  let legFront = 0, legBack = 0, armFront = 0, armBack = 0;
  let squashX = 1, squashY = 1;

  switch (pose) {
    case 'idle':
      bob = Math.sin(phase * 2.2) * 0.9;
      earFlop = Math.sin(phase * 1.7) * 5;
      scarf = Math.sin(phase * 1.5) * 4;
      break;
    case 'run1': legFront = 7; legBack = -6; armFront = -6; armBack = 6; lean = 0.10; bob = -1; break;
    case 'run2': legFront = 2; legBack = 2; armFront = 0; armBack = 0; lean = 0.13; bob = -3; break;
    case 'run3': legFront = -6; legBack = 7; armFront = 6; armBack = -6; lean = 0.10; bob = -1; break;
    case 'run4': legFront = 2; legBack = 2; armFront = 0; armBack = 0; lean = 0.13; bob = -3; break;
    case 'jump':
      legFront = -5; legBack = 3; armFront = -9; armBack = -7; lean = 0.06;
      squashX = 0.9; squashY = 1.12; scarf = 9; earFlop = -7;
      break;
    case 'fall':
      legFront = 5; legBack = -3; armFront = -11; armBack = -9; lean = -0.05;
      squashX = 1.05; squashY = 0.96; scarf = 12; earFlop = 6;
      break;
    case 'land':
      legFront = 3; legBack = 3; squashX = 1.22; squashY = 0.8; armFront = 8; armBack = 8;
      break;
    case 'turn':
      lean = -0.22; legFront = 4; legBack = -4; armFront = 8; armBack = -8; scarf = -8;
      break;
    case 'dash':
      lean = 0.34; legFront = -8; legBack = 8; armFront = -12; armBack = 10;
      squashX = 1.2; squashY = 0.86; scarf = 16;
      break;
    case 'hurt':
      lean = -0.3; legFront = -6; legBack = 6; armFront = -10; armBack = -10; earFlop = 10;
      break;
    case 'wallSlide':
      lean = 0.16; legFront = 3; legBack = -3; armFront = -4; armBack = 10; scarf = -6;
      break;
    case 'victory':
      bob = -3 + Math.sin(phase * 6) * 2; armFront = -14; armBack = -14; earFlop = -9;
      break;
  }

  ctx.save();
  ctx.translate(HERO_W / 2, HERO_H + bob);
  ctx.rotate(lean);
  ctx.scale(squashX, squashY);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Contact shadow, so Nim sits on the ground rather than floating above it.
  if (pose !== 'jump' && pose !== 'fall' && pose !== 'dash') {
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, 1, 13, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const drawLeg = (offset: number, dark: boolean) => {
    ctx.strokeStyle = dark ? shade(body, -0.28) : shade(body, -0.12);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(offset * 0.35, -12);
    ctx.lineTo(offset, -1);
    ctx.stroke();
    // A foot, which is what stops the legs reading as sticks.
    ctx.fillStyle = shade(body, -0.34);
    roundRect(ctx, offset - 4, -3.5, 8.5, 4, 2);
    ctx.fill();
  };

  const drawArm = (offset: number, dark: boolean) => {
    ctx.strokeStyle = dark ? shade(body, -0.24) : body;
    ctx.lineWidth = 4.4;
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.quadraticCurveTo(offset * 0.6, -22, offset, -17);
    ctx.stroke();
  };

  drawLeg(legBack, true);
  drawArm(armBack, true);

  // Scarf: two trailing ribbons behind the body, the only long shape in the silhouette.
  ctx.strokeStyle = shade(trim, -0.18);
  ctx.lineWidth = 4;
  for (const [i, len] of [10, 15].entries()) {
    ctx.beginPath();
    ctx.moveTo(-3, -27);
    ctx.quadraticCurveTo(-9 - scarf * 0.4, -26 + i * 3, -9 - scarf, -22 + i * 5 + Math.sin(phase * 5 + i) * 2);
    void len;
    ctx.stroke();
  }

  // Body: a soft egg, wider at the base.
  const bodyGrad = ctx.createLinearGradient(-11, -34, 9, -6);
  bodyGrad.addColorStop(0, shade(body, 0.16));
  bodyGrad.addColorStop(1, shade(body, -0.14));
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(0, -19, 10.5, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Belly patch, in the trim colour — the second-brightest thing after the ember.
  ctx.fillStyle = trim;
  ctx.beginPath();
  ctx.ellipse(0.5, -15, 5.6, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head, slightly forward of the body's centre so the character reads as facing somewhere.
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(1.5, -31, 9, 8.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.stroke();

  // Ears: two tall triangles, the strongest thing in the silhouette.
  ctx.fillStyle = shade(body, -0.06);
  for (const [i, base] of [-4.5, 3.5].entries()) {
    ctx.save();
    ctx.translate(base, -37);
    ctx.rotate((earFlop / 60) * (i === 0 ? -1 : 1) + (i === 0 ? -0.2 : 0.18));
    ctx.beginPath();
    ctx.moveTo(-2.6, 2);
    ctx.quadraticCurveTo(0, -11, 2.6, 2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    // Inner ear, in the glow colour, which ties the head to the lantern.
    ctx.fillStyle = shade(glow, -0.05);
    ctx.beginPath();
    ctx.moveTo(-1.1, 1.4);
    ctx.quadraticCurveTo(0, -6, 1.1, 1.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shade(body, -0.06);
    ctx.restore();
  }

  // Eyes. Two dots and a highlight is all this size supports, and all it needs.
  const blink = Math.sin(phase * 0.9) > 0.985 ? 0.15 : 1;
  ctx.fillStyle = '#221208';
  for (const ex of [-1.6, 4.6]) {
    ctx.beginPath();
    ctx.ellipse(ex, -31.5, 1.5, 2.1 * blink, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (blink > 0.5) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const ex of [-1.1, 5.1]) {
      ctx.beginPath();
      ctx.arc(ex, -32.3, 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawLeg(legFront, false);
  drawArm(armFront, false);

  /**
   * The ember Nim carries.
   *
   * The one saturated highlight on the character, and the reason the game is called what it is.
   * Drawn last so it sits over everything, with a soft additive halo that flickers — which also
   * makes the character findable at a glance on a dark background.
   */
  const flicker = 0.82 + Math.sin(phase * 9.3) * 0.1 + Math.sin(phase * 4.1) * 0.08;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(-8, -13, 0, -8, -13, 13 * flicker);
  halo.addColorStop(0, glow);
  halo.addColorStop(0.4, 'rgba(255, 190, 90, 0.35)');
  halo.addColorStop(1, 'rgba(255, 160, 60, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(-24, -30, 34, 34);
  ctx.restore();

  ctx.fillStyle = '#fff3cf';
  ctx.beginPath();
  ctx.arc(-8, -13, 2.9 * flicker, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(-8, -13, 1.7 * flicker, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

export const HERO_SIZE = { w: HERO_W, h: HERO_H };

// ── enemies ─────────────────────────────────────────────────────────────────

export type EnemyArt =
  | 'walker' | 'jumper' | 'flyer' | 'charger' | 'shielded' | 'turret' | 'heavy' | 'boss';

/**
 * Draw an enemy into a box of the given size, feet at the bottom.
 *
 * Each is built from a different primitive so the silhouettes cannot be confused: the walker is
 * a squat dome, the jumper a teardrop, the flyer a wide wedge with wings, the charger a forward
 * arrow, the shielded one a dome with a slab on its face, the turret a hexagon, the heavy a
 * boxy block, the boss a large mass with horns. Colour tells the player which world they are
 * in; shape tells them what the thing does.
 */
export function drawEnemy(
  ctx: CanvasRenderingContext2D, kind: EnemyArt, w: number, h: number,
  palette: Palette, phase: number, alert: boolean
): void {
  const outline = 'rgba(18, 12, 10, 0.9)';
  /**
   * Enemies are lifted well clear of the terrain they stand on.
   *
   * The first pass tinted them from the world's rock colour at +6%, and against Sunlit Reach's
   * green they read as dark blobs — a hazard the player cannot identify until it is close is a
   * hazard that feels unfair. +28% and a rim light keeps them separate from the background in
   * every world while still belonging to it.
   */
  const base = alert ? '#ff6a4a' : shade(palette.rock, 0.28);
  const dark = shade(base, -0.3);
  const eye = alert ? '#fff2c0' : '#ffe9a8';

  ctx.save();
  ctx.translate(w / 2, h);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = outline;

  // Shadow.
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.4, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const bob = Math.sin(phase * 5) * 1.2;
  const grad = ctx.createLinearGradient(0, -h, 0, 0);
  grad.addColorStop(0, shade(base, 0.18));
  grad.addColorStop(1, dark);
  ctx.fillStyle = grad;

  const legs = (count: number, span: number) => {
    ctx.strokeStyle = dark;
    ctx.lineWidth = 3;
    for (let i = 0; i < count; i++) {
      const x = -span / 2 + (span / (count - 1)) * i;
      const swing = Math.sin(phase * 7 + i) * 2.2;
      ctx.beginPath();
      ctx.moveTo(x, -h * 0.28);
      ctx.lineTo(x + swing, -1);
      ctx.stroke();
    }
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.7;
  };

  switch (kind) {
    case 'walker': {
      legs(4, w * 0.6);
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.55 + bob, w * 0.46, h * 0.42, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      break;
    }
    case 'jumper': {
      legs(2, w * 0.42);
      ctx.beginPath();
      ctx.moveTo(0, -h * 1.02 + bob);
      ctx.quadraticCurveTo(w * 0.5, -h * 0.5, 0, -h * 0.2);
      ctx.quadraticCurveTo(-w * 0.5, -h * 0.5, 0, -h * 1.02 + bob);
      ctx.fill(); ctx.stroke();
      break;
    }
    case 'flyer': {
      const beat = Math.sin(phase * 13) * h * 0.28;
      ctx.fillStyle = shade(base, -0.1);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * w * 0.18, -h * 0.55);
        ctx.quadraticCurveTo(side * w * 0.72, -h * 0.55 - beat, side * w * 0.5, -h * 0.2);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.52, w * 0.28, h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      break;
    }
    case 'charger': {
      legs(4, w * 0.62);
      ctx.beginPath();
      ctx.moveTo(w * 0.5, -h * 0.5);
      ctx.lineTo(-w * 0.1, -h * 0.95 + bob);
      ctx.lineTo(-w * 0.48, -h * 0.62);
      ctx.lineTo(-w * 0.42, -h * 0.18);
      ctx.lineTo(w * 0.34, -h * 0.2);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      break;
    }
    case 'shielded': {
      legs(4, w * 0.5);
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.55, w * 0.4, h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      // The slab, in a contrasting metal, on the side it is facing.
      ctx.fillStyle = shade(palette.platformEdge, 0.1);
      roundRect(ctx, w * 0.16, -h * 0.92, w * 0.3, h * 0.78, 3);
      ctx.fill(); ctx.stroke();
      break;
    }
    case 'turret': {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const px = Math.cos(a) * w * 0.42;
        const py = -h * 0.5 + Math.sin(a) * h * 0.42;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // Barrel — the tell that says "this one shoots".
      ctx.fillStyle = dark;
      roundRect(ctx, w * 0.18, -h * 0.62, w * 0.42, h * 0.22, 2);
      ctx.fill(); ctx.stroke();
      break;
    }
    case 'heavy': {
      legs(4, w * 0.7);
      // Boxy and plated, which is what says "do not land on this".
      roundRect(ctx, -w * 0.46, -h * 0.9 + bob * 0.4, w * 0.92, h * 0.72, 5);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = shade(base, -0.34);
      for (let i = 0; i < 3; i++) {
        roundRect(ctx, -w * 0.36 + i * w * 0.26, -h * 0.86 + bob * 0.4, w * 0.16, h * 0.16, 2);
        ctx.fill();
      }
      break;
    }
    case 'boss': {
      legs(6, w * 0.8);
      ctx.beginPath();
      ctx.ellipse(0, -h * 0.55 + bob * 0.5, w * 0.46, h * 0.44, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      // Horns.
      ctx.fillStyle = shade(palette.spike, -0.05);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * w * 0.24, -h * 0.86);
        ctx.quadraticCurveTo(side * w * 0.46, -h * 1.22, side * w * 0.16, -h * 0.98);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
      break;
    }
  }

  // A rim light along the top, which is what separates a silhouette from whatever is behind it.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.ellipse(0, -h * 0.6, w * 0.4, h * 0.38, 0, Math.PI * 1.15, Math.PI * 1.95);
  ctx.stroke();
  ctx.restore();

  // Eyes, always last and always bright — the thing a player's eye finds first.
  ctx.fillStyle = eye;
  const eyeY = kind === 'heavy' ? -h * 0.6 : kind === 'flyer' ? -h * 0.58 : -h * 0.62;
  const eyeSpread = kind === 'boss' ? w * 0.16 : w * 0.11;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * eyeSpread + w * 0.06, eyeY, w * 0.055, h * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (alert) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,110,70,0.4)';
    ctx.beginPath();
    ctx.arc(0, -h * 0.55, w * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

// ── collectibles and props ──────────────────────────────────────────────────

export function drawSpark(ctx: CanvasRenderingContext2D, size: number, phase: number, glow: string): void {
  const r = size / 2;
  const pulse = 0.86 + Math.sin(phase * 4) * 0.14;
  ctx.save();
  ctx.translate(r, r);
  ctx.rotate(phase * 1.4);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.5 * pulse);
  halo.addColorStop(0, 'rgba(255, 226, 150, 0.85)');
  halo.addColorStop(1, 'rgba(255, 180, 70, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(-r * 1.6, -r * 1.6, r * 3.2, r * 3.2);
  ctx.restore();

  // A four-pointed star — reads as "light" rather than as "coin", which is the whole theme.
  ctx.fillStyle = glow;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rad = i % 2 === 0 ? r * 0.72 * pulse : r * 0.26;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fffbe8';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawEmberstone(ctx: CanvasRenderingContext2D, size: number, phase: number): void {
  const r = size / 2;
  ctx.save();
  ctx.translate(r, r + Math.sin(phase * 2) * 1.5);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.8);
  halo.addColorStop(0, 'rgba(255, 120, 200, 0.7)');
  halo.addColorStop(1, 'rgba(200, 60, 255, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
  ctx.restore();

  ctx.rotate(Math.sin(phase) * 0.2);
  // A cut gem: two facets so it catches light and reads as valuable next to a plain spark.
  const grad = ctx.createLinearGradient(-r, -r, r, r);
  grad.addColorStop(0, '#ffd9f2');
  grad.addColorStop(0.5, '#ff5fbf');
  grad.addColorStop(1, '#a238ff');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.9);
  ctx.lineTo(r * 0.72, -r * 0.1);
  ctx.lineTo(0, r * 0.9);
  ctx.lineTo(-r * 0.72, -r * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.9);
  ctx.lineTo(r * 0.28, -r * 0.1);
  ctx.lineTo(0, r * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export type PowerArt = 'shield' | 'speed' | 'jump' | 'magnet' | 'invincible' | 'doubleJump';

const POWER_COLORS: Record<PowerArt, [string, string]> = {
  shield: ['#5ad6ff', '#e6faff'],
  speed: ['#ffcf3a', '#fff6cf'],
  jump: ['#8affa0', '#e8ffee'],
  magnet: ['#ff7ad1', '#ffe4f6'],
  invincible: ['#ffe066', '#fffbe0'],
  doubleJump: ['#b48cff', '#f0e8ff'],
};

/** Power-ups: a coloured capsule with a glyph, so each reads at a glance and in the HUD. */
export function drawPower(
  ctx: CanvasRenderingContext2D, kind: PowerArt, size: number, phase: number
): void {
  const [main, light] = POWER_COLORS[kind];
  const r = size / 2;
  ctx.save();
  ctx.translate(r, r + Math.sin(phase * 2.4) * 1.8);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.6);
  halo.addColorStop(0, main);
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = halo;
  ctx.fillRect(-r * 1.8, -r * 1.8, r * 3.6, r * 3.6);
  ctx.restore();

  const grad = ctx.createLinearGradient(0, -r, 0, r);
  grad.addColorStop(0, light);
  grad.addColorStop(1, main);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.74, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(30,20,15,0.6)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(35,22,14,0.85)';
  ctx.fillStyle = 'rgba(35,22,14,0.85)';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  const s = r * 0.36;
  ctx.beginPath();
  switch (kind) {
    case 'shield':                                  // a crest
      ctx.moveTo(0, -s); ctx.lineTo(s, -s * 0.4); ctx.lineTo(0, s);
      ctx.lineTo(-s, -s * 0.4); ctx.closePath(); ctx.fill();
      break;
    case 'speed':                                   // three motion lines
      for (let i = -1; i <= 1; i++) { ctx.moveTo(-s, i * s * 0.55); ctx.lineTo(s, i * s * 0.55); }
      ctx.stroke();
      break;
    case 'jump':                                    // an up arrow
      ctx.moveTo(0, s); ctx.lineTo(0, -s); ctx.moveTo(-s * 0.6, -s * 0.4);
      ctx.lineTo(0, -s); ctx.lineTo(s * 0.6, -s * 0.4); ctx.stroke();
      break;
    case 'magnet':                                  // a horseshoe
      ctx.arc(0, s * 0.2, s * 0.8, Math.PI, 0);
      ctx.stroke();
      break;
    case 'invincible':                              // a star
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rad = i % 2 === 0 ? s : s * 0.44;
        const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.fill();
      break;
    case 'doubleJump':                              // two chevrons
      ctx.moveTo(-s * 0.6, s * 0.5); ctx.lineTo(0, -s * 0.1); ctx.lineTo(s * 0.6, s * 0.5);
      ctx.moveTo(-s * 0.6, -s * 0.2); ctx.lineTo(0, -s * 0.8); ctx.lineTo(s * 0.6, -s * 0.2);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

/** The beacon that ends a level — a stone shaft with a light that grows as you approach. */
export function drawBeacon(
  ctx: CanvasRenderingContext2D, w: number, h: number, palette: Palette, phase: number, lit: number
): void {
  ctx.save();
  ctx.translate(w / 2, h);

  ctx.fillStyle = shade(palette.rock, -0.1);
  roundRect(ctx, -w * 0.22, -h * 0.72, w * 0.44, h * 0.72, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,14,10,0.7)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.fillStyle = shade(palette.platformEdge, 0.05);
  roundRect(ctx, -w * 0.34, -h * 0.82, w * 0.68, h * 0.14, 3);
  ctx.fill(); ctx.stroke();

  const glowR = w * (0.3 + lit * 0.5) * (0.9 + Math.sin(phase * 3) * 0.1);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(0, -h * 0.9, 0, 0, -h * 0.9, glowR * 2.2);
  halo.addColorStop(0, `rgba(255, 236, 180, ${0.5 + lit * 0.5})`);
  halo.addColorStop(0.5, `rgba(255, 170, 70, ${0.25 * (0.4 + lit)})`);
  halo.addColorStop(1, 'rgba(255, 140, 40, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(-glowR * 2.4, -h * 0.9 - glowR * 2.4, glowR * 4.8, glowR * 4.8);
  ctx.restore();

  ctx.fillStyle = '#fff6d8';
  ctx.beginPath();
  ctx.arc(0, -h * 0.9, w * (0.13 + lit * 0.07), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A checkpoint post: dim until touched, then alight. */
export function drawCheckpoint(
  ctx: CanvasRenderingContext2D, w: number, h: number, palette: Palette, phase: number, on: boolean
): void {
  ctx.save();
  ctx.translate(w / 2, h);
  ctx.fillStyle = shade(palette.rock, -0.12);
  roundRect(ctx, -w * 0.1, -h * 0.86, w * 0.2, h * 0.86, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,14,10,0.65)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  if (on) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, -h * 0.9, 0, 0, -h * 0.9, w * 1.1);
    g.addColorStop(0, 'rgba(255,225,150,0.75)');
    g.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-w * 1.2, -h * 1.3, w * 2.4, w * 2.4);
    ctx.restore();
  }
  ctx.fillStyle = on ? '#ffe9a8' : shade(palette.rock, 0.16);
  ctx.beginPath();
  ctx.arc(0, -h * 0.9, w * 0.17 * (on ? 1 + Math.sin(phase * 4) * 0.1 : 1), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export { shade, roundRect };
