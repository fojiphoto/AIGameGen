import { MASCOTS } from './levels';
import { mascot } from './mascots';

export function cover(canvas: HTMLCanvasElement, selected: number) {
  const c = canvas.getContext('2d')!;
  canvas.width = 960;
  canvas.height = 760;
  c.fillStyle = '#fff4db';
  c.fillRect(0, 0, 960, 760);
  c.strokeStyle = '#eddfc0';
  c.lineWidth = 2;
  c.beginPath();
  for (let x = 0; x < 960; x += 36) { c.moveTo(x, 0); c.lineTo(x, 760); }
  for (let y = 0; y < 760; y += 36) { c.moveTo(0, y); c.lineTo(960, y); }
  c.stroke();
  const patches = [
    { ink: '#f5b1df', dark: '#ef77c6', d: [0, 104, 270, 208, 470, 330] },
    { ink: '#a0e9f1', dark: '#29c9de', d: [548, 0, 292, 360, 960, 180] },
    { ink: '#d9c3fa', dark: '#ab78ee', d: [622, 430, 338, 330, 522, 515] },
    { ink: MASCOTS[selected].light, dark: MASCOTS[selected].ink, d: [64, 428, 520, 332, 152, 330] },
  ];
  for (const { ink, dark, d: [x, y, w, h, x2, y2] } of patches) {
    c.beginPath();
    c.roundRect(x, y, w, h, 35);
    c.roundRect(x2, y2, 160, 150, 25);
    c.fillStyle = dark;
    c.fill();
    c.beginPath();
    c.roundRect(x + 6, y + 6, w - 12, h - 12, 30);
    c.roundRect(x2 + 5, y2 + 5, 150, 140, 21);
    c.fillStyle = ink;
    c.fill();
  }
  const path = [[188, 547], [88, 547], [88, 290], [344, 290], [344, 428]];
  c.beginPath();
  path.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
  c.strokeStyle = MASCOTS[selected].dark;
  c.lineWidth = 19; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke();
  c.strokeStyle = MASCOTS[selected].ink;
  c.lineWidth = 12; c.stroke();
  c.strokeStyle = '#ffffffa0'; c.lineWidth = 3; c.setLineDash([3, 15]); c.stroke(); c.setLineDash([]);
  const stars = [[118, 142, 20], [417, 177, 28], [644, 123, 18], [854, 351, 20], [590, 443, 24], [116, 678, 20], [810, 647, 26], [513, 650, 14]];
  for (const [x, y, r] of stars) {
    c.beginPath();
    c.moveTo(x, y - r); c.quadraticCurveTo(x + 4, y - 4, x + r, y);
    c.quadraticCurveTo(x + 4, y + 4, x, y + r); c.quadraticCurveTo(x - 4, y + 4, x - r, y);
    c.quadraticCurveTo(x - 4, y - 4, x, y - r);
    c.fillStyle = '#fffef2'; c.fill();
  }
  mascot(c, 3, 214, 213, 148, 0);
  mascot(c, 1, 718, 245, 223, 0, -1);
  mascot(c, 2, 714, 555, 222, 0, -1);
  mascot(c, selected, 363, 473, 315, 0);
}
