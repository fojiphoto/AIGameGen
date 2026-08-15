/**
 * Progression and the save file.
 *
 * localStorage, read through one function that assumes the stored value is hostile. Storage
 * survives across versions, gets truncated by a browser under pressure, gets hand-edited, and is
 * shared with whatever else lives on the origin — so a missing key, a syntactically broken value
 * and a value of entirely the wrong shape all have to end in "use the defaults and carry on",
 * never in a game that will not start.
 *
 * The unlock rules live here rather than in the interface, so the level solver can ask exactly
 * what a player will have when they first arrive at a level and check it against that.
 */

import { LEVELS } from './levels.js';

const KEY = 'emberwake.save';
const VERSION = 1;

export interface LevelRecord {
  completed: boolean;
  stars: number;
  bestTimeMs: number;
  sparks: number;
  embersFound: boolean;
  secretFound: boolean;
}

export interface Settings {
  sfx: boolean;
  music: boolean;
  sfxVolume: number;
  musicVolume: number;
  /** Touch controls: 'auto' shows them once a touch is seen. */
  touchControls: 'auto' | 'on' | 'off';
  screenShake: boolean;
  particles: 'low' | 'high';
  skin: string;
  showTimer: boolean;
}

export interface SaveData {
  version: number;
  levels: Record<string, LevelRecord>;
  totalSparks: number;
  totalEmbers: number;
  deaths: number;
  playMs: number;
  unlockedSkins: string[];
  seenPrompts: string[];
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  sfx: true,
  music: true,
  sfxVolume: 0.75,
  musicVolume: 0.45,
  touchControls: 'auto',
  screenShake: true,
  particles: 'high',
  skin: 'ember',
  showTimer: true,
};

const emptyRecord = (): LevelRecord => ({
  completed: false, stars: 0, bestTimeMs: 0, sparks: 0, embersFound: false, secretFound: false,
});

export const defaultSave = (): SaveData => ({
  version: VERSION,
  levels: {},
  totalSparks: 0,
  totalEmbers: 0,
  deaths: 0,
  playMs: 0,
  unlockedSkins: ['ember'],
  seenPrompts: [],
  settings: { ...DEFAULT_SETTINGS },
});

/**
 * Skins, and what they cost.
 *
 * Cosmetic only, and every one keeps the same silhouette — a skin that changes the outline
 * changes how readable the character is against a busy background, which is a gameplay change
 * dressed as a reward.
 */
export interface Skin {
  id: string;
  name: string;
  blurb: string;
  /** Body, trim, glow. */
  colors: [string, string, string];
  /** How it is earned. */
  requirement: { kind: 'default' } | { kind: 'embers'; count: number }
    | { kind: 'stars'; count: number } | { kind: 'world'; world: number };
}

export const SKINS: Skin[] = [
  {
    id: 'ember', name: 'Ember', blurb: 'How Nim started out.',
    colors: ['#ff9b4a', '#ffe2b0', '#ffd27a'],
    requirement: { kind: 'default' },
  },
  {
    id: 'frost', name: 'Frost', blurb: 'Cold light, carried anyway.',
    colors: ['#6fd6ff', '#e8fbff', '#a8ecff'],
    requirement: { kind: 'embers', count: 3 },
  },
  {
    id: 'moss', name: 'Moss', blurb: 'Something that grew back.',
    colors: ['#8fd45a', '#e8ffd4', '#c2f08a'],
    requirement: { kind: 'stars', count: 9 },
  },
  {
    id: 'dusk', name: 'Dusk', blurb: 'The hour after the beacons go out.',
    colors: ['#a97bff', '#f0e4ff', '#c9a8ff'],
    requirement: { kind: 'world', world: 4 },
  },
  {
    id: 'gold', name: 'Gilt', blurb: 'For finding everything.',
    colors: ['#ffd15c', '#fff6d8', '#ffe79a'],
    requirement: { kind: 'embers', count: 8 },
  },
  {
    id: 'ash', name: 'Ash', blurb: 'What the foundry left behind.',
    colors: ['#8d93a3', '#e6eaf2', '#b8c0d0'],
    requirement: { kind: 'stars', count: 24 },
  },
];

export class Progress {
  data: SaveData;

  constructor(data?: SaveData) {
    this.data = data ?? this.load();
    this.refreshSkins();
  }

  private load(): SaveData {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      // Storage disabled or blocked. The game is still entirely playable, it just forgets.
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

    const base = defaultSave();
    // Field by field, with a type check on each: a save written by an older build may be missing
    // keys this one reads, and a spread of a partial object leaves those `undefined` rather than
    // defaulted — which surfaces later as "NaN stars" on a screen.
    const out: SaveData = {
      ...base,
      totalSparks: num(stored.totalSparks, 0),
      totalEmbers: num(stored.totalEmbers, 0),
      deaths: num(stored.deaths, 0),
      playMs: num(stored.playMs, 0),
      unlockedSkins: Array.isArray(stored.unlockedSkins)
        ? stored.unlockedSkins.filter((s): s is string => typeof s === 'string') : ['ember'],
      seenPrompts: Array.isArray(stored.seenPrompts)
        ? stored.seenPrompts.filter((s): s is string => typeof s === 'string') : [],
      settings: { ...DEFAULT_SETTINGS },
      levels: {},
    };

    if (stored.settings && typeof stored.settings === 'object') {
      const incoming = stored.settings as unknown as Record<string, unknown>;
      const target = out.settings as unknown as Record<string, unknown>;
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        const value = incoming[key];
        if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
          target[key] = value;
        }
      }
    }

    if (stored.levels && typeof stored.levels === 'object') {
      for (const [id, record] of Object.entries(stored.levels)) {
        if (!LEVELS.some((l) => l.id === id)) continue;   // a level that no longer exists
        if (typeof record !== 'object' || record === null) continue;
        const r = record as Partial<LevelRecord>;
        out.levels[id] = {
          completed: Boolean(r.completed),
          stars: Math.max(0, Math.min(3, num(r.stars, 0))),
          bestTimeMs: num(r.bestTimeMs, 0),
          sparks: num(r.sparks, 0),
          embersFound: Boolean(r.embersFound),
          secretFound: Boolean(r.secretFound),
        };
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
      // would end the run, so it is swallowed.
    }
  }

  record(id: string): LevelRecord {
    return this.data.levels[id] ?? emptyRecord();
  }

  /**
   * Record a finished level, keeping the best of everything.
   *
   * A worse run never overwrites a better one — a player who replays a level for fun should not
   * lose their three stars to a lap they did not care about.
   */
  complete(
    id: string, stars: number, timeMs: number, sparks: number, embers: boolean, secret: boolean
  ): { improved: boolean; newStars: number } {
    const before = this.record(id);
    const after: LevelRecord = {
      completed: true,
      stars: Math.max(before.stars, stars),
      bestTimeMs: before.bestTimeMs === 0 ? timeMs : Math.min(before.bestTimeMs, timeMs),
      sparks: Math.max(before.sparks, sparks),
      embersFound: before.embersFound || embers,
      secretFound: before.secretFound || secret,
    };
    const improved = after.stars > before.stars
      || after.bestTimeMs < (before.bestTimeMs || Infinity)
      || after.sparks > before.sparks;

    this.data.levels[id] = after;
    this.data.totalSparks = Object.values(this.data.levels).reduce((n, r) => n + r.sparks, 0);
    this.data.totalEmbers = Object.values(this.data.levels).filter((r) => r.embersFound).length;
    this.refreshSkins();
    this.save();
    return { improved, newStars: after.stars - before.stars };
  }

  get totalStars(): number {
    return Object.values(this.data.levels).reduce((n, r) => n + r.stars, 0);
  }

  /**
   * Whether a level can be played.
   *
   * The first level of a world opens when the previous world is finished; within a world, each
   * level opens when the one before it is done. Deliberately forgiving — stars are never
   * required to progress, only to unlock cosmetics, so a player who finds the timing star hard
   * is never stuck.
   */
  isUnlocked(id: string): boolean {
    const index = LEVELS.findIndex((l) => l.id === id);
    if (index <= 0) return true;
    const previous = LEVELS[index - 1];
    return this.record(previous.id).completed;
  }

  isWorldUnlocked(world: number): boolean {
    if (world <= 1) return true;
    const previousWorld = LEVELS.filter((l) => l.world === world - 1);
    return previousWorld.every((l) => this.record(l.id).completed);
  }

  nextLevelId(after: string): string | null {
    const index = LEVELS.findIndex((l) => l.id === after);
    return index >= 0 && index + 1 < LEVELS.length ? LEVELS[index + 1].id : null;
  }

  /** Abilities the player currently has, from how far they have got. */
  abilities(): { dash: boolean; doubleJump: boolean; wallJump: boolean } {
    let furthest = -1;
    LEVELS.forEach((l, i) => { if (this.record(l.id).completed) furthest = Math.max(furthest, i); });
    const reached = furthest + 1;
    return { dash: reached >= 2, doubleJump: reached >= 4, wallJump: reached >= 6 };
  }

  skinUnlocked(skin: Skin): boolean {
    switch (skin.requirement.kind) {
      case 'default': return true;
      case 'embers': return this.data.totalEmbers >= skin.requirement.count;
      case 'stars': return this.totalStars >= skin.requirement.count;
      case 'world': return this.isWorldUnlocked(skin.requirement.world);
    }
  }

  private refreshSkins(): void {
    for (const skin of SKINS) {
      if (this.skinUnlocked(skin) && !this.data.unlockedSkins.includes(skin.id)) {
        this.data.unlockedSkins.push(skin.id);
      }
    }
  }

  markPrompt(id: string): boolean {
    if (this.data.seenPrompts.includes(id)) return false;
    this.data.seenPrompts.push(id);
    this.save();
    return true;
  }

  reset(): void {
    const settings = this.data.settings;
    this.data = defaultSave();
    this.data.settings = settings;      // wiping progress should not reset the volume
    this.save();
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
