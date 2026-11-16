const KEY = 'factorial.bubble-reef.v1';
export interface Best { stars: number; score: number }
export interface Save { best: Best[]; muted: boolean; symbols: boolean }

export function readSave(): Save {
  const save: Save = { best: [], muted: false, symbols: true };
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!data || typeof data !== 'object') return save;
    save.muted = data.muted === true;
    save.symbols = data.symbols !== false;
    if (Array.isArray(data.best)) {
      for (const entry of data.best.slice(0, 100)) {
        if (!entry || !Number.isInteger(entry.stars) || entry.stars < 1 || entry.stars > 3 || !Number.isSafeInteger(entry.score) || entry.score < 0) break;
        save.best.push({ stars: entry.stars, score: entry.score });
      }
    }
  } catch { /* Start fresh if storage is unavailable. */ }
  return save;
}

export function writeSave(save: Save) {
  try { localStorage.setItem(KEY, JSON.stringify(save)); } catch { /* The session remains playable. */ }
}
