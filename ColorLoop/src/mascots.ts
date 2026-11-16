import { MASCOTS } from './levels';

const EDGE = '#30224a';

// Mascots share a readable face at board scale. Each has its own hat, silhouette and base.
export function mascot(ctx: CanvasRenderingContext2D, skin: number, x: number, y: number, size: number, time = 0, facing = 1) {
  const m = MASCOTS[skin];
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 72, size / 72);
  const oval = (ox: number, oy: number, rx: number, ry: number, color: string, outline = true, angle = 0) => {
    ctx.beginPath();
    ctx.ellipse(ox, oy, rx, ry, angle, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (outline) ctx.stroke();
  };
  const box = (ox: number, oy: number, w: number, h: number, r: number, color: string) => {
    ctx.beginPath();
    ctx.roundRect(ox, oy, w, h, r);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.stroke();
  };
  const shape = (vertices: [number, number][], color: string) => {
    ctx.beginPath();
    vertices.forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.stroke();
  };
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 2.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  oval(1, 25, 30, 8, '#43285235', false);
  ctx.translate(0, Math.sin(time * 6 + skin) * 1.6);
  if (m.animal === 'pilot' || m.animal === 'moon') {
    shape([[-19, 4], [-34, 10], [-27, -6], [-17, -10]], m.accent);
    shape([[18, 5], [34, 9], [27, -7], [18, -11]], m.accent);
  }
  if (m.animal === 'ram') {
    oval(-19, -13, 12, 15, '#ffe383', true, -.45);
    oval(19, -13, 12, 15, '#ffe383', true, .45);
    oval(-21, -14, 5, 7, '#e9875e', false);
    oval(21, -14, 5, 7, '#e9875e', false);
  }
  if (m.animal === 'pop') {
    oval(-17, -15, 10, 16, m.accent, true, -.56);
    oval(17, -15, 10, 16, m.accent, true, .56);
  }
  const base = m.animal === 'ram' ? '#fff0bc' : m.animal === 'bud' ? '#f9ee72' : m.dark;
  oval(0, 18, 27, 11, base);
  oval(0, 14, 26, 10, m.light);
  for (const sx of [-15, 15]) oval(sx, 17, 6.6, 5, m.dark);
  const body = ctx.createLinearGradient(-12, -27, 14, 16);
  body.addColorStop(0, m.light);
  body.addColorStop(.49, m.ink);
  body.addColorStop(1, m.dark);
  if (m.animal === 'toast') {
    box(-25, -22, 50, 40, 12, '#b75133');
    box(-20, -17, 40, 31, 9, '#ffcf79');
  } else {
    oval(0, -6, 23.5, 23, m.dark);
    ctx.beginPath();
    ctx.ellipse(-1, -8, 21.8, 21.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();
  }
  if (m.animal === 'bud') {
    shape([[-5, -23], [-15, -26], [-20, -37], [-10, -40], [0, -28], [7, -38], [19, -36], [17, -27], [4, -21]], '#7cf064');
    oval(0, -27, 8, 6, '#f9d94a');
    oval(-7, -30, 6, 8, '#fa83c0', true, -.55);
    oval(7, -30, 6, 8, '#fa83c0', true, .55);
  } else if (m.animal === 'pilot') {
    oval(0, -19, 22, 11, '#13d5ef');
    box(-20, -23, 40, 11, 5, '#614cb6');
    box(-16, -22, 31, 7, 3, '#d5c4ff');
    oval(13, -34, 7, 6, '#d5c4ff');
  } else if (m.animal === 'ram') {
    oval(-7, -24, 11, 5, '#dba9ff', true, -.28);
    shape([[-4, -23], [-8, -39], [3, -32], [7, -23]], m.accent);
  } else if (m.animal === 'toast') {
    oval(3, -19, 17, 8, '#fff4e4', true, -.1);
    oval(6, -21, 8, 6, '#ffc12b');
    oval(4, -23, 2.5, 1.5, '#ffe899', false);
  } else if (m.animal === 'pop') {
    oval(-8, -23, 10, 8, '#ffe576');
    oval(6, -24, 11, 7, '#fff3bd');
  } else if (m.animal === 'moon') {
    box(-8, -40, 16, 17, 6, '#8e66e8');
    oval(0, -36, 4, 3, m.accent, false);
    oval(0, -16, 19, 9, '#3740a3');
  } else if (m.animal === 'scoop') {
    shape([[-18, -17], [-18, -31], [-4, -25], [2, -37], [10, -25], [21, -33], [21, -16]], '#fff07e');
    oval(4, -22, 5, 5, m.accent);
  } else {
    oval(-9, -25, 10, 8, '#b6f36a');
    oval(10, -25, 10, 8, '#79d34a');
    oval(1, -31, 8, 9, '#b6f36a');
  }
  const blink = time > 0 && (time + skin * .36) % 4.8 > 4.69;
  for (const side of [-1, 1]) {
    const px = side * 8 + 1;
    if (blink) oval(px, -7, 5.5, 1.1, EDGE, false);
    else {
      oval(px, -6, 6.4, 8.4, '#fffbed');
      oval(px + facing * 1.65, -5.2, 2.8, 4.1, '#27233e', false);
      oval(px + facing * 1.65 + 1, -6.7, .95, 1.25, '#fff', false);
    }
    oval(side * 15, 3, 4, 1.8, '#ff91b1', false);
  }
  ctx.beginPath();
  ctx.arc(1, 4, 4.4, .13, Math.PI - .13);
  ctx.fillStyle = EDGE;
  ctx.fill();
  oval(2, 7.1, 2.1, 1, '#ff93c4', false);
  ctx.restore();
}
