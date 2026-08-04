/**
 * Seeded PRNG. §C7 — determinism is a hard requirement:
 *   same (config, seed) → byte-identical game, forever.
 *
 * Math.random() is BANNED in this package. `npm run lint:determinism` enforces it.
 */

/** mulberry32 — small, fast, good distribution, trivially portable. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** float in [0,1) */
    next,
    /** integer in [min,max] inclusive */
    int(min, max) {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    /** float in [min,max) */
    float(min, max) {
      return next() * (max - min) + min;
    },
    /** true with probability p */
    chance(p) {
      return next() < p;
    },
    pick(arr) {
      if (!arr.length) throw new Error('pick() on empty array');
      return arr[Math.floor(next() * arr.length)];
    },
    /** weighted pick — items need a numeric `weight` */
    weighted(items) {
      const total = items.reduce((s, i) => s + (i.weight || 0), 0);
      if (total <= 0) return items[0];
      let r = next() * total;
      for (const it of items) {
        r -= it.weight || 0;
        if (r <= 0) return it;
      }
      return items.at(-1);
    },
    /** Fisher–Yates, non-mutating */
    shuffle(arr) {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

/** Stable 32-bit string hash — derives reproducible seeds from ids. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Per-level sub-seed so re-rolling level 7 cannot disturb level 6. */
export function subSeed(baseSeed, label) {
  return (hashSeed(`${baseSeed}:${label}`) ^ baseSeed) >>> 0;
}
