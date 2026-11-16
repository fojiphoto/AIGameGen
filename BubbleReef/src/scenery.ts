import { HEIGHT, ORIGIN, WIDTH, rng } from './levels';

export const TRAY = [ORIGIN, { x: ORIGIN.x - 27, y: 598 }, { x: ORIGIN.x + 27, y: 598 }] as const;

type Canvas = CanvasRenderingContext2D;
const INK = '#51345e';

function oval(c: Canvas, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient, stroke?: string, width = 1.6) {
  c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = fill; c.fill();
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
}

function polygon(c: Canvas, points: number[], fill: string | CanvasGradient, stroke?: string, width = 1.6) {
  c.beginPath(); c.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) c.lineTo(points[i], points[i + 1]);
  c.closePath(); c.fillStyle = fill; c.fill();
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
}

function stroke(c: Canvas, fill: string, width: number, draw: () => void) {
  c.beginPath(); draw(); c.strokeStyle = fill; c.lineWidth = width; c.stroke();
}

function gradient(c: Canvas, top: number, bottom: number, colors: string[]) {
  const paint = c.createLinearGradient(0, top, 0, bottom);
  colors.forEach((color, i) => paint.addColorStop(i / (colors.length - 1), color));
  return paint;
}

export function landscape(c: Canvas, theme: number) {
  const skies = [['#f9b76b', '#fff3ae'], ['#8fddf4', '#fff1b4'], ['#f4a5ae', '#fff1aa'], ['#cfb2f1', '#ffe4b6'], ['#84c9f7', '#fff5bb']];
  const hue = (theme + 5) % 5;
  const w = WIDTH, h = HEIGHT, random = rng(7135 + hue);
  c.fillStyle = gradient(c, 0, h * .72, skies[hue]); c.fillRect(0, 0, w, h);
  const light = c.createRadialGradient(281, 142, 8, 281, 142, 101);
  light.addColorStop(0, '#fffed4b0'); light.addColorStop(1, '#fffed400');
  oval(c, 281, 142, 102, 102, light);
  for (const [x, y, scale] of [[26, 293, .7], [338, 221, .8], [121, 344, .47], [259, 301, .38]]) {
    c.save(); c.translate(x, y); c.scale(scale, scale);
    oval(c, 0, 12, 44, 11, '#ffffdc94');
    oval(c, -20, 3, 19, 16, '#ffffdc94'); oval(c, 4, 0, 22, 20, '#ffffdc94'); oval(c, 27, 8, 19, 12, '#ffffdc94');
    c.restore();
  }
  polygon(c, [0, 433, 18, 397, 39, 404, 54, 379, 90, 416, 116, 402, 153, 429, 199, 389, 230, 405, 252, 382, 300, 413, 338, 391, 374, 412, 374, 506, 0, 506], '#e9a973');
  polygon(c, [0, 454, 33, 428, 67, 437, 107, 422, 143, 453, 194, 424, 224, 432, 258, 418, 291, 442, 344, 419, 374, 436, 374, 510, 0, 510], '#f5c771');
  c.fillStyle = gradient(c, 456, h, ['#ffd567', '#ed9d4f', '#c87454']); c.fillRect(0, 456, w, h - 456);
  c.beginPath(); c.moveTo(221, 467); c.bezierCurveTo(297, 491, 123, 503, 195, 547); c.bezierCurveTo(239, 569, 221, 605, 168, h);
  c.lineTo(71, h); c.bezierCurveTo(180, 580, 133, 568, 153, 544); c.bezierCurveTo(105, 508, 254, 484, 221, 467);
  c.fillStyle = '#ffe498'; c.fill();
  for (let i = 0; i < 84; i++) {
    const x = w * random(), y = 458 + (h - 458) * random(), s = .25 + (y - 458) / 110;
    if (x > 128 && x < 235 && y > 537) continue;
    oval(c, x, y, 2.8 * s, 1.55 * s, i % 4 === 0 ? '#ffe7a1' : '#b86442a6');
  }
  c.save(); c.translate(321, 451); c.scale(.72, .72);
  polygon(c, [-26, 34, -16, -35, 22, -35, 31, 34], '#d18068', '#92546b');
  polygon(c, [-24, -28, 2, -61, 27, -31, 23, -22, -22, -23], '#91405b', '#713757');
  polygon(c, [-3, 34, -3, 8, 7, 4, 14, 10, 14, 34], '#7e4654');
  c.save(); c.translate(0, -19); c.rotate(.6);
  for (let i = 0; i < 4; i++) {
    c.rotate(Math.PI / 2);
    polygon(c, [2, 0, -3, -44, 10, -48, 14, -20], '#f2c58f', '#9f5c6d');
  }
  oval(c, 0, 0, 5, 5, '#fce5a3', '#935563'); c.restore(); c.restore();
  for (const [x, y, s] of [[17, 532, .56], [353, 510, .48], [45, 582, .8], [343, 580, .83], [119, 615, .55]]) {
    c.save(); c.translate(x, y); c.scale(s, s);
    oval(c, 0, 4, 17, 6, '#75496245');
    oval(c, -7, 0, 9, 9, '#e26e3c', '#ac594e'); oval(c, 7, 0, 9, 9, '#d85d42', '#ac594e'); oval(c, 0, 0, 9, 11, '#f69039', '#ac594e');
    stroke(c, '#6b7348', 3, () => { c.moveTo(0, -8); c.quadraticCurveTo(-3, -15, 4, -15); });
    c.restore();
  }
}

function sparkle(c: Canvas, x: number, y: number, radius: number, fill: string) {
  c.beginPath(); c.moveTo(x, y - radius); c.quadraticCurveTo(x + 1, y - 1, x + radius, y);
  c.quadraticCurveTo(x + 1, y + 1, x, y + radius); c.quadraticCurveTo(x - 1, y + 1, x - radius, y);
  c.quadraticCurveTo(x - 1, y - 1, x, y - radius); c.fillStyle = fill; c.fill();
}

export function shooter(c: Canvas, x: number, y: number, scale: number, motion = 0, cast = 0) {
  c.save(); c.translate(x, y); c.scale(scale, scale); c.lineJoin = 'round'; c.lineCap = 'round';
  oval(c, 4, 2, 36, 8, '#784c643e');
  c.translate(0, Math.sin(motion * 3) * 1.3);
  const blue = gradient(c, -83, -7, ['#6ce0f7', '#394dc0', '#263285']);
  const purple = gradient(c, -133, -82, ['#d699f5', '#8853b9', '#4d328c']);
  const skin = gradient(c, -88, -48, ['#fff1cd', '#fab197']);
  const hair = gradient(c, -101, -51, ['#e98659', '#ab4b67', '#754174']);
  // Seated boots, layered robe and swept hair.
  oval(c, -16, -7, 18, 10, '#27366e', INK); oval(c, 22, -5, 15, 8, '#3e3d84', INK);
  polygon(c, [-37, -17, -21, -49, -12, -68, 12, -69, 28, -45, 40, -19, 30, -10, 6, -13, -10, -8], blue, INK);
  polygon(c, [10, -58, 17, -32, 36, -18, 9, -17, -2, -28], '#6f71e9');
  oval(c, -22, -74, 16, 29, hair, INK); oval(c, 21, -75, 17, 29, hair, INK);
  oval(c, -20, -63, 10, 10, '#f8ad8f', INK); oval(c, 22, -71, 8, 9, '#f8ad8f', INK);
  oval(c, 0, -77, 25, 26, skin, INK);
  c.beginPath(); c.moveTo(-23, -82); c.quadraticCurveTo(-22, -106, 9, -106);
  c.quadraticCurveTo(25, -103, 27, -87); c.quadraticCurveTo(10, -85, 4, -95);
  c.quadraticCurveTo(-5, -84, -23, -82); c.fillStyle = hair; c.fill(); c.strokeStyle = INK; c.lineWidth = 1.6; c.stroke();
  for (const side of [-1, 1]) {
    const eye = side * 9 + 2;
    oval(c, eye, -78, 5.3, 6.6, '#fffbeb', '#865271', 1.1);
    oval(c, eye + 1.6, -77.4, 2.9, 4.2, '#346b88'); oval(c, eye + 2.5, -79.1, 1.05, 1.15, '#fff');
    oval(c, eye + side * 6, -68, 4.4, 2, '#f88d9d');
  }
  stroke(c, '#9b4d65', 1.8, () => { c.moveTo(-3, -64); c.quadraticCurveTo(3, -59, 8, -65); });
  oval(c, -5, -99, 39, 10, '#6a3f9e', INK);
  c.beginPath(); c.moveTo(-33, -99); c.bezierCurveTo(-24, -108, -20, -128, -10, -141);
  c.quadraticCurveTo(-2, -146, 9, -132); c.lineTo(21, -136); c.lineTo(16, -118);
  c.lineTo(27, -102); c.quadraticCurveTo(3, -94, -33, -99); c.fillStyle = purple; c.fill(); c.strokeStyle = INK; c.stroke();
  polygon(c, [-29, -105, -25, -112, 20, -113, 25, -105], '#f48bc9');
  sparkle(c, -11, -107, 7, '#fff09a');
  sparkle(c, 2, -48, 7, '#ffdf8a');
  // Wand hand reaches toward the loaded bubble.
  const lift = cast * 11;
  stroke(c, INK, 11, () => { c.moveTo(21, -49); c.quadraticCurveTo(32, -42, 48, -51 - lift); });
  stroke(c, '#ffd0a9', 7, () => { c.moveTo(23, -49); c.quadraticCurveTo(33, -43, 48, -51 - lift); });
  stroke(c, '#8b4b5e', 4.5, () => { c.moveTo(44, -48 - lift); c.lineTo(74, -69 - lift); });
  stroke(c, '#ffc772', 1.5, () => { c.moveTo(53, -55 - lift); c.lineTo(74, -69 - lift); });
  sparkle(c, 74, -69 - lift, 5.5 + cast * 7, '#fffbb5');
  c.restore();
}

export function panda(c: Canvas, x: number, y: number, scale: number, motion = 0, push = 0) {
  c.save(); c.translate(x, y); c.scale(scale, scale); c.lineJoin = 'round';
  oval(c, 1, 4, 34, 7, '#75456055');
  polygon(c, [-25, -4, 15, -4, 29, -10, 29, -3, 13, 4, -25, 3], '#432d83', INK);
  polygon(c, [-21, -11, 18, -11, 25, -16, 25, -10, 17, -5, -21, -5], '#f9dcb0', INK);
  c.translate(-push * 6, Math.sin(motion * 2.5 + .5) * .9);
  const white = gradient(c, -75, 1, ['#fff9ed', '#eee0ef', '#b8aed6']);
  oval(c, 3, -20, 25, 20, white, INK);
  oval(c, 18, -7, 13, 8, '#394871', INK); oval(c, -13, -7, 12, 8, '#394871', INK);
  oval(c, -18, -63, 10, 11, '#394871', INK); oval(c, 19, -65, 10, 11, '#394871', INK);
  oval(c, -18, -64, 5.5, 6, '#aa87c5'); oval(c, 19, -66, 5.5, 6, '#aa87c5');
  oval(c, 0, -49, 29, 25, white, INK);
  for (const side of [-1, 1]) {
    const ox = side * 11;
    oval(c, ox, -51, 8, 10, '#394871'); oval(c, ox - 1, -53, 4.7, 6.2, '#fff8ef');
    oval(c, ox - 2.3, -53, 2.5, 3.1, '#5b4c9e'); oval(c, ox - 2.7, -54.6, 1, 1, '#fff');
    oval(c, side * 18, -42, 5, 2.6, '#ff9eb8');
  }
  oval(c, -1, -44, 4, 2.6, '#394871');
  stroke(c, '#59427a', 1.5, () => { c.moveTo(-4, -39); c.quadraticCurveTo(-1, -35, 3, -40); });
  polygon(c, [-3, -25, -16, -29, -17, -17, -3, -20, 12, -16, 12, -29], '#f487b6', INK);
  oval(c, -2, -23, 4, 4, '#ffc76c', INK);
  oval(c, -24 - push * 11, -25 - push * 5, 9.5, 8, '#52668c', INK);
  if (push > .05) sparkle(c, -32 - push * 14, -25 - push * 6, push * 9, '#fff8b0');
  c.restore();
}
