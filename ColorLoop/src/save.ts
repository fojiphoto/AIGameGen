const KEY = 'factorial.color-loop.v1';
export interface Save { unlocked: number; cleared: number; skin: number; peak: number; islands: number; muted: boolean }

export function skinUnlocked(unlock: number, stats: Save) {
  return stats.cleared >= unlock || stats.peak >= unlock * 5;
}

export function loadSave(storage?: Pick<Storage, 'getItem'>): Save {
  const defaults: Save = { unlocked: 0, cleared: 0, skin: 0, peak: 0, islands: 0, muted: false };
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(KEY) ?? 'null');
    if (!value || typeof value !== 'object') return defaults;
    const whole = (part: unknown, max: number) => typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= max ? part : 0;
    const cleared = whole(value.cleared, 15);
    return { unlocked: Math.min(14, cleared), cleared, skin: whole(value.skin, 7),
      peak: typeof value.peak === 'number' && value.peak >= 0 && value.peak <= 100 ? value.peak : 0,
      islands: whole(value.islands, Number.MAX_SAFE_INTEGER), muted: value.muted === true };
  } catch { return defaults; }
}

export function saveStats(save: Save, storage?: Pick<Storage, 'setItem'>) {
  try { (storage ?? localStorage).setItem(KEY, JSON.stringify(save)); } catch { /* Private browsing can still play. */ }
}
