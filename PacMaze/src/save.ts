import { LEVELS } from './levels';

const KEY = 'factorial.pac-maze.v1';
export interface Checkpoint { index: number; score: number; lives: number }
export interface Save { best: number; cleared: number; muted: boolean; checkpoint: Checkpoint | null }

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function loadSave(storage?: Pick<Storage, 'getItem'>): Save {
  const data: Save = { best: 0, cleared: 0, muted: false, checkpoint: null };
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(KEY) ?? 'null');
    if (!value || typeof value !== 'object') return data;
    if (integer(value.best, 0, 9_999_999)) data.best = value.best;
    if (integer(value.cleared, 0, LEVELS.length)) data.cleared = value.cleared;
    if (typeof value.muted === 'boolean') data.muted = value.muted;
    const c = value.checkpoint;
    if (c && integer(c.index, 0, Math.min(LEVELS.length - 1, data.cleared)) && integer(c.score, 0, 9_999_999) && integer(c.lives, 1, 4)) {
      data.checkpoint = { index: c.index, score: c.score, lives: c.lives };
    }
  } catch { /* Invalid data or private storage can use a fresh save. */ }
  return data;
}

export function storeSave(data: Save, storage?: Pick<Storage, 'setItem'>) {
  try { (storage ?? localStorage).setItem(KEY, JSON.stringify(data)); } catch { /* The game remains playable. */ }
}
