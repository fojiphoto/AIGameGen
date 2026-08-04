/**
 * Progress persistence.
 *
 * localStorage works in both the web player and the Android WebView, so one code
 * path covers both. Keyed by buildId so two generated games installed side by
 * side never collide, and a rebuilt game starts clean rather than inheriting
 * progress from different level layouts.
 */

const KEY_PREFIX = 'forge.save.';

const EMPTY = {
  version: 1,
  bestLevel: 0,       // highest level cleared
  stars: {},          // level -> 0..3
  endlessBest: 0,     // best endless distance (metres)
  endlessUnlocked: false,
  muted: false,
  totalDeaths: 0,
  totalRuns: 0,
};

let cache = null;
let storageKey = KEY_PREFIX + 'default';

export function initSave(buildId) {
  storageKey = KEY_PREFIX + (buildId || 'default');
  cache = read();
  return cache;
}

function read() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { ...EMPTY, stars: {} };
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return { ...EMPTY, stars: {} };
    return { ...EMPTY, ...parsed, stars: parsed.stars ?? {} };
  } catch {
    return { ...EMPTY, stars: {} };
  }
}

function write() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(cache));
  } catch {
    /* private mode / quota — progress is best-effort, never fatal */
  }
}

export function getSave() {
  if (!cache) cache = read();
  return cache;
}

export function isUnlocked(level) {
  return level === 1 || getSave().bestLevel >= level - 1;
}

export function highestUnlocked() {
  return Math.min(20, getSave().bestLevel + 1);
}

/** @returns {{newBest:boolean, unlockedEndless:boolean}} */
export function recordWin(level, stars, endlessUnlockAt) {
  const s = getSave();
  const prevStars = s.stars[level] ?? 0;
  if (stars > prevStars) s.stars[level] = stars;

  const newBest = level > s.bestLevel;
  if (newBest) s.bestLevel = level;

  let unlockedEndless = false;
  if (!s.endlessUnlocked && s.bestLevel >= endlessUnlockAt) {
    s.endlessUnlocked = true;
    unlockedEndless = true;
  }
  write();
  return { newBest, unlockedEndless };
}

export function recordDeath() {
  const s = getSave();
  s.totalDeaths++;
  write();
}

export function recordRun() {
  const s = getSave();
  s.totalRuns++;
  write();
}

export function recordEndless(metres) {
  const s = getSave();
  if (metres > s.endlessBest) {
    s.endlessBest = Math.floor(metres);
    write();
    return true;
  }
  return false;
}

export function setSavedMuted(v) {
  getSave().muted = Boolean(v);
  write();
}

export function totalStars() {
  return Object.values(getSave().stars).reduce((a, b) => a + b, 0);
}

/** Stars are awarded on cleanliness, not just completion. */
export function starsFor(deaths) {
  if (deaths === 0) return 3;
  if (deaths <= 2) return 2;
  return 1;
}

export function resetSave() {
  cache = { ...EMPTY, stars: {} };
  write();
}
