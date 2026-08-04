/**
 * Minimal PNG encoder + launcher-icon generator.
 *
 * Written from scratch rather than pulling in `sharp` because `sharp` ships a
 * ~30 MB native binary per platform — a heavy dependency for a build worker whose
 * only imaging job is "draw some rectangles at six sizes". Node's zlib does the
 * real work here.
 */

import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';

// zlib.crc32 landed in Node 20.15; keep a fallback so the worker isn't pinned to it.
const crc32 =
  typeof zlibCrc32 === 'function'
    ? (buf) => zlibCrc32(buf) >>> 0
    : (() => {
        const table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          table[n] = c;
        }
        return (buf) => {
          let c = -1;
          for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
          return (c ^ -1) >>> 0;
        };
      })();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

/**
 * Encode an RGBA pixel buffer as a PNG.
 * @param {number} w
 * @param {number} h
 * @param {Buffer|Uint8Array} rgba length must be w*h*4
 */
export function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // one filter byte (0 = None) per scanline
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, rgba.length).copy(
      raw,
      y * (w * 4 + 1) + 1,
      y * w * 4,
      (y + 1) * w * 4
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => {
  const n = parseInt(String(h).slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

/** Simple software rasteriser — enough for icon geometry. */
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 4);
  }
  fill(color, a = 255) {
    const [r, g, b] = hex(color);
    for (let i = 0; i < this.w * this.h; i++) {
      this.px[i * 4] = r;
      this.px[i * 4 + 1] = g;
      this.px[i * 4 + 2] = b;
      this.px[i * 4 + 3] = a;
    }
  }
  rect(x0, y0, rw, rh, color, radius = 0) {
    const [r, g, b] = hex(color);
    const x1 = Math.min(this.w, Math.round(x0 + rw));
    const y1 = Math.min(this.h, Math.round(y0 + rh));
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (radius > 0) {
          // round the corners by distance from the nearest corner centre
          const dx = Math.min(x - x0, x1 - 1 - x);
          const dy = Math.min(y - y0, y1 - 1 - y);
          if (dx < radius && dy < radius) {
            const ddx = radius - dx;
            const ddy = radius - dy;
            if (ddx * ddx + ddy * ddy > radius * radius) continue;
          }
        }
        const i = (y * this.w + x) * 4;
        this.px[i] = r;
        this.px[i + 1] = g;
        this.px[i + 2] = b;
        this.px[i + 3] = 255;
      }
    }
  }
  toPng() {
    return encodePng(this.w, this.h, this.px);
  }
}

/**
 * Launcher icon: the game's own palette rendered as a tiny abstract of the game
 * itself — ground band, player square mid-jump, obstacle. Instantly recognisable
 * as "that game" on a home screen full of icons.
 */
export function renderIcon(size, palette) {
  const c = new Canvas(size, size);
  const u = size / 100;

  c.fill(palette.bg);
  // subtle upper wash
  c.rect(0, 0, size, size * 0.52, palette.bgAccent);
  // ground band
  c.rect(0, size * 0.72, size, size * 0.28, palette.ground);
  c.rect(0, size * 0.72, size, 2.5 * u, palette.accent);
  // obstacle
  c.rect(size * 0.62, size * 0.55, 11 * u, 17 * u, palette.obstacle, 1.5 * u);
  // player, mid-jump
  c.rect(size * 0.2, size * 0.4, 22 * u, 22 * u, palette.player, 5 * u);
  // visor
  c.rect(size * 0.255, size * 0.46, 12 * u, 5 * u, palette.bg, 1 * u);
  return c.toPng();
}

/** Android launcher densities. */
export const MIPMAPS = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];
