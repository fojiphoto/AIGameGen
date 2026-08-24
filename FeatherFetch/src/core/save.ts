/**
 * The save file.
 *
 * localStorage, read through one function that assumes the stored value is hostile. Storage
 * survives across versions, gets hand-edited, gets truncated by a browser under pressure, and is
 * shared with whatever else lives on the origin — so a missing key, a broken value and a value
 * of entirely the wrong shape all have to end in "use the defaults and carry on", never in a
 * game that will not start.
 */

import {
  Totals, emptyTotals, ACHIEVEMENTS, DOG_SKINS, WEAPON_SKINS, cosmeticUnlocked,
} from './scoring.js';

const KEY = 'featherfetch.save';
const VERSION = 1;

export type GameMode = 'classic' | 'timeAttack' | 'survival';

export interface Settings {
  sfx: boolean;
  music: boolean;
  sfxVolume: number;
  musicVolume: number;
  screenShake: boolean;
  particles: 'low' | 'high';
  /** Cuts the dog's retrieval animation roughly in half once someone has seen it. */
  quickRetrieve: boolean;
  dogSkin: string;
  weaponSkin: string;
  showTutorial: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sfx: true, music: true, sfxVolume: 0.75, musicVolume: 0.4,
  screenShake: true, particles: 'high', quickRetrieve: false,
  dogSkin: 'red', weaponSkin: 'classic', showTutorial: true,
};

export interface SaveData {
  version: number;
  totals: Totals;
  /** Best score per mode. */
  best: Record<GameMode, number>;
  achievements: string[];
  settings: Settings;
}

export const defaultSave = (): SaveData => ({
  version: VERSION,
  totals: emptyTotals(),
  best: { classic: 0, timeAttack: 0, survival: 0 },
  achievements: [],
  settings: { ...DEFAULT_SETTINGS },
});

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

export class SaveManager {
  data: SaveData;

  constructor(data?: SaveData) {
    this.data = data ?? this.load();
  }

  private load(): SaveData {
    let raw: string | null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      // Storage blocked or disabled. The game is entirely playable, it just forgets.
      return defaultSave();
    }
    if (!raw) return defaultSave();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.drop();
      return defaultSave();
    }
    if (typeof parsed !== 'object' || parsed === null) { this.drop(); return defaultSave(); }

    const stored = parsed as Partial<SaveData>;
    if (stored.version !== VERSION) return defaultSave();

    const out = defaultSave();

    // Field by field with a type check on each: a save from an older build may be missing keys
    // this one reads, and a spread of a partial object leaves those `undefined` — which surfaces
    // much later as "NaN" on a results screen.
    if (stored.totals && typeof stored.totals === 'object') {
      const t = stored.totals as Partial<Totals>;
      for (const key of Object.keys(out.totals) as (keyof Totals)[]) {
        out.totals[key] = num(t[key], out.totals[key]);
      }
      // Accuracy is a ratio, not a counter, so it needs its own bound.
      out.totals.bestAccuracy = Math.min(1, num(t.bestAccuracy, 0));
    }

    if (stored.best && typeof stored.best === 'object') {
      for (const mode of ['classic', 'timeAttack', 'survival'] as GameMode[]) {
        out.best[mode] = num((stored.best as Record<string, unknown>)[mode], 0);
      }
    }

    if (Array.isArray(stored.achievements)) {
      const known = new Set(ACHIEVEMENTS.map((a) => a.id));
      out.achievements = stored.achievements
        .filter((id): id is string => typeof id === 'string' && known.has(id));
    }

    if (stored.settings && typeof stored.settings === 'object') {
      const incoming = stored.settings as unknown as Record<string, unknown>;
      const target = out.settings as unknown as Record<string, unknown>;
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        const value = incoming[key];
        if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
          target[key] = value;
        }
      }
      // A cosmetic that no longer exists, or one that was never unlocked, falls back.
      if (!DOG_SKINS.some((s) => s.id === out.settings.dogSkin)) out.settings.dogSkin = 'red';
      if (!WEAPON_SKINS.some((s) => s.id === out.settings.weaponSkin)) {
        out.settings.weaponSkin = 'classic';
      }
    }
    return out;
  }

  private drop(): void {
    try { localStorage.removeItem(KEY); } catch { /* nothing further to try */ }
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Quota exceeded, or private mode. Losing progress is a disappointment; an exception here
      // would end the run.
    }
  }

  /** Fold a finished run into the lifetime totals, keeping the best of everything. */
  recordRun(
    mode: GameMode, run: {
      score: number; ducksHit: number; ducksEscaped: number;
      shotsFired: number; shotsHit: number; bestCombo: number;
      perfectRounds: number; rareDucks: number; roundsCleared: number; playMs: number;
    }
  ): { newHigh: boolean } {
    const t = this.data.totals;
    t.ducksHit += run.ducksHit;
    t.ducksEscaped += run.ducksEscaped;
    t.shotsFired += run.shotsFired;
    t.shotsHit += run.shotsHit;
    t.perfectRounds += run.perfectRounds;
    t.rareDucks += run.rareDucks;
    t.playMs += run.playMs;
    t.gamesPlayed += 1;
    t.bestCombo = Math.max(t.bestCombo, run.bestCombo);
    t.roundsCleared = Math.max(t.roundsCleared, run.roundsCleared);
    t.highScore = Math.max(t.highScore, run.score);

    // Accuracy is only meaningful over a real number of shots — a one-shot run at 100% is not a
    // record, it is a rounding artefact.
    if (run.shotsFired >= 10) {
      t.bestAccuracy = Math.max(t.bestAccuracy, run.shotsHit / run.shotsFired);
    }

    const newHigh = run.score > this.data.best[mode];
    if (newHigh) this.data.best[mode] = run.score;
    this.save();
    return { newHigh };
  }

  unlockAchievements(ids: string[]): void {
    let changed = false;
    for (const id of ids) {
      if (!this.data.achievements.includes(id)) { this.data.achievements.push(id); changed = true; }
    }
    if (changed) this.save();
  }

  dogUnlocked(id: string): boolean {
    const skin = DOG_SKINS.find((s) => s.id === id);
    return skin ? cosmeticUnlocked(skin.need, this.data.totals) : false;
  }

  weaponUnlocked(id: string): boolean {
    const skin = WEAPON_SKINS.find((s) => s.id === id);
    return skin ? cosmeticUnlocked(skin.need, this.data.totals) : false;
  }

  reset(): void {
    const settings = this.data.settings;
    this.data = defaultSave();
    this.data.settings = settings;      // wiping progress should not reset the volume
    this.save();
  }
}
