/**
 * Local persistence.
 *
 * localStorage rather than IndexedDB: everything saved here is settings, counters and a short
 * list of finished games — a few kilobytes that want to be read synchronously at startup before
 * the first frame. IndexedDB would mean an async boot and a transaction for a preference toggle,
 * and would buy nothing until this data is orders of magnitude bigger.
 *
 * Every read goes through `load`, and `load` assumes the stored value is hostile. Storage
 * survives across versions of the game, gets edited by hand, gets truncated by a browser under
 * pressure, and is shared with whatever else lives on the origin — so a missing key, a
 * syntactically broken value and a value of entirely the wrong shape all have to end in
 * "use the defaults and carry on", never in a game that will not start.
 */

const PREFIX = 'ivorygambit.';

/** Bumped when a stored shape changes incompatibly; older data is dropped rather than migrated. */
const VERSION = 1;

export interface Settings {
  version: number;
  theme: string;
  pieceSet: string;
  showLegalMoves: boolean;
  showCoordinates: boolean;
  autoQueen: boolean;
  rotateBoardLocal: boolean;
  confirmResign: boolean;
  animationSpeed: 'off' | 'fast' | 'normal' | 'slow';
  effectsQuality: 'low' | 'high';
  sfx: boolean;
  sfxVolume: number;
  music: boolean;
  musicVolume: number;
  lastDifficulty: string;
  lastSide: 'white' | 'black' | 'random';
  lastClock: string;
  highlightLastMove: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: VERSION,
  theme: 'classic',
  pieceSet: 'ivory',
  showLegalMoves: true,
  showCoordinates: true,
  autoQueen: false,
  rotateBoardLocal: true,
  confirmResign: true,
  animationSpeed: 'normal',
  effectsQuality: 'high',
  sfx: true,
  sfxVolume: 0.7,
  music: false,
  musicVolume: 0.5,
  lastDifficulty: 'medium',
  lastSide: 'white',
  lastClock: 'none',
  highlightLastMove: true,
};

export interface Stats {
  version: number;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  winsAsWhite: number;
  winsAsBlack: number;
  /** Highest difficulty *beaten*, by index into the ladder. -1 for none. */
  bestDifficultyBeaten: number;
  totalMoves: number;
  checkmatesDelivered: number;
  puzzlesSolved: number;
  /** Milliseconds; 0 means no win yet. */
  fastestWinMs: number;
  fewestMovesWin: number;
  streak: number;
  bestStreak: number;
}

export const DEFAULT_STATS: Stats = {
  version: VERSION,
  played: 0, wins: 0, losses: 0, draws: 0,
  winsAsWhite: 0, winsAsBlack: 0,
  bestDifficultyBeaten: -1,
  totalMoves: 0, checkmatesDelivered: 0, puzzlesSolved: 0,
  fastestWinMs: 0, fewestMovesWin: 0,
  streak: 0, bestStreak: 0,
};

export interface MatchRecord {
  at: number;
  result: 'win' | 'loss' | 'draw';
  reason: string;
  playerColor: 'white' | 'black';
  mode: string;
  difficulty: string;
  moves: number;
  durationMs: number;
  /** SAN, so a stored game can be replayed without storing a position per ply. */
  san: string[];
}

const MAX_HISTORY = 30;

function read<T>(key: string, fallback: T, validate: (value: unknown) => boolean): T {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PREFIX + key);
  } catch {
    // Private mode on some browsers throws on access rather than returning null.
    return fallback;
  }
  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt. Drop it rather than leaving a value that will fail again on every load.
    try { localStorage.removeItem(PREFIX + key); } catch { /* nothing more to try */ }
    return fallback;
  }
  if (!validate(parsed)) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* nothing more to try */ }
    return fallback;
  }
  return parsed as T;
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded, or storage disabled. A preference that fails to persist is a small
    // disappointment; an exception here would take the whole game down, so it is swallowed.
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class SaveManager {
  settings: Settings;
  stats: Stats;
  history: MatchRecord[];
  puzzleProgress: Record<string, boolean>;

  constructor() {
    this.settings = this.loadSettings();
    this.stats = this.loadStats();
    this.history = this.loadHistory();
    this.puzzleProgress = read<Record<string, boolean>>('puzzles', {}, isObject);
  }

  private loadSettings(): Settings {
    const stored = read<Partial<Settings>>('settings', {}, isObject);
    if (stored.version !== VERSION) return { ...DEFAULT_SETTINGS };
    // Merge field by field: a value written by an older build may be missing keys this one
    // reads, and a spread of a partial object leaves those `undefined` rather than defaulted.
    const out = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const value = stored[key];
      if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
    return out;
  }

  private loadStats(): Stats {
    const stored = read<Partial<Stats>>('stats', {}, isObject);
    if (stored.version !== VERSION) return { ...DEFAULT_STATS };
    const out = { ...DEFAULT_STATS };
    for (const key of Object.keys(DEFAULT_STATS) as (keyof Stats)[]) {
      const value = stored[key];
      // Counters that have gone negative or non-finite are treated as absent — a corrupted
      // number that propagates into a win-rate calculation shows up as "NaN%" on screen.
      if (typeof value === 'number' && Number.isFinite(value)) {
        (out as Record<string, number>)[key] = value;
      }
    }
    return out;
  }

  private loadHistory(): MatchRecord[] {
    const stored = read<unknown[]>('history', [], Array.isArray);
    return stored
      .filter((r): r is MatchRecord =>
        isObject(r) && typeof r.at === 'number' && typeof r.result === 'string')
      .slice(0, MAX_HISTORY);
  }

  saveSettings(): void { write('settings', this.settings); }
  saveStats(): void { write('stats', this.stats); }
  saveHistory(): void { write('history', this.history.slice(0, MAX_HISTORY)); }
  savePuzzles(): void { write('puzzles', this.puzzleProgress); }

  recordMatch(record: MatchRecord, difficultyIndex: number): void {
    this.history.unshift(record);
    this.history = this.history.slice(0, MAX_HISTORY);
    this.saveHistory();

    const s = this.stats;
    s.played++;
    s.totalMoves += record.moves;
    if (record.result === 'win') {
      s.wins++;
      s.streak = Math.max(0, s.streak) + 1;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      if (record.playerColor === 'white') s.winsAsWhite++; else s.winsAsBlack++;
      if (difficultyIndex > s.bestDifficultyBeaten) s.bestDifficultyBeaten = difficultyIndex;
      if (record.reason.toLowerCase().includes('checkmate')) s.checkmatesDelivered++;
      if (record.durationMs > 0 && (s.fastestWinMs === 0 || record.durationMs < s.fastestWinMs)) {
        s.fastestWinMs = record.durationMs;
      }
      if (s.fewestMovesWin === 0 || record.moves < s.fewestMovesWin) {
        s.fewestMovesWin = record.moves;
      }
    } else if (record.result === 'loss') {
      s.losses++;
      s.streak = 0;
    } else {
      s.draws++;
      // A draw neither builds nor breaks a streak — losing a five-game streak to a stalemate
      // in a drawn endgame feels like a punishment for playing correctly.
    }
    this.saveStats();
  }

  markPuzzleSolved(id: string): boolean {
    if (this.puzzleProgress[id]) return false;
    this.puzzleProgress[id] = true;
    this.stats.puzzlesSolved++;
    this.savePuzzles();
    this.saveStats();
    return true;
  }

  resetStats(): void {
    this.stats = { ...DEFAULT_STATS };
    this.history = [];
    this.puzzleProgress = {};
    this.saveStats();
    this.saveHistory();
    this.savePuzzles();
  }

  get winRate(): number {
    return this.stats.played === 0 ? 0 : this.stats.wins / this.stats.played;
  }

  /** Milliseconds an animation should take, from the speed setting. 0 disables animation. */
  get animationScale(): number {
    switch (this.settings.animationSpeed) {
      case 'off': return 0;
      case 'fast': return 0.6;
      case 'slow': return 1.7;
      default: return 1;
    }
  }
}
