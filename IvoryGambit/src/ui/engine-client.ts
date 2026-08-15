/**
 * The main-thread side of the engine.
 *
 * Wraps the worker in promises and, importantly, in a *request id*. Without one, a search that
 * was cancelled because the player took back a move can still deliver its answer afterwards, and
 * the board plays a move for a position that no longer exists. Every reply carries the id it
 * belongs to and anything stale is dropped.
 *
 * There is also a fallback path. If Workers are unavailable — an exotic embedding, a
 * `file://` page, a strict sandbox in a host portal's iframe — the game must still be playable,
 * so the same search runs on the main thread at a reduced depth. It stutters, and it says so in
 * the console, but it plays chess. A blank board because one API was missing is the worse
 * outcome by a wide margin.
 */

import { Position, Move, moveToUci, generateLegal } from '../core/index.js';
import { Searcher, difficultyByKey } from '../engine/index.js';
import { bookMove } from '../engine/book.js';

export interface EngineReply {
  move: Move | null;
  san: string | null;
  depth: number;
  score: number;
  mateIn: number;
  nodes: number;
  timeMs: number;
  pv: Move[];
  book: boolean;
}

export interface ThinkOptions {
  difficulty: string;
  /** Overrides for hints and analysis, which want full strength whatever the opponent is set to. */
  maxDepth?: number;
  maxTime?: number;
  useBook?: boolean;
  onProgress?: (depth: number, score: number, mateIn: number) => void;
}

const uciToMove = (pos: Position, uci: string | null): Move | null => {
  if (!uci) return null;
  return generateLegal(pos).find((m) => moveToUci(m) === uci) ?? null;
};

export class EngineClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: {
    id: number;
    pos: Position;
    resolve: (r: EngineReply) => void;
    onProgress?: ThinkOptions['onProgress'];
  } | null = null;
  private localSearcher: Searcher | null = null;
  /** True when the worker failed and the search is running inline. */
  fallback = false;
  ready = false;

  constructor(private workerUrl: string) {}

  start(): void {
    if (this.worker || this.fallback) return;
    try {
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        // A worker that throws at load is unrecoverable; drop to the inline path once and
        // never try again, rather than failing on every single move.
        console.warn('IVORY GAMBIT: engine worker failed, falling back to the main thread', e.message);
        this.worker?.terminate();
        this.worker = null;
        this.enableFallback();
      };
    } catch {
      this.enableFallback();
    }
  }

  private enableFallback(): void {
    this.fallback = true;
    this.ready = true;
    this.localSearcher = new Searcher();
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'ready') { this.ready = true; return; }
    const pending = this.pending;
    if (!pending || msg.id !== pending.id) return;      // stale reply from a cancelled search

    if (msg.type === 'info') {
      pending.onProgress?.(msg.depth as number, msg.score as number, msg.mateIn as number);
      return;
    }
    if (msg.type === 'cancelled' || msg.type === 'error') {
      this.pending = null;
      pending.resolve({
        move: null, san: null, depth: 0, score: 0, mateIn: 0, nodes: 0, timeMs: 0,
        pv: [], book: false,
      });
      return;
    }
    if (msg.type === 'bestmove') {
      this.pending = null;
      const move = uciToMove(pending.pos, msg.move as string | null);
      pending.resolve({
        move,
        san: (msg.san as string) ?? null,
        depth: (msg.depth as number) ?? 0,
        score: (msg.score as number) ?? 0,
        mateIn: (msg.mateIn as number) ?? 0,
        nodes: (msg.nodes as number) ?? 0,
        timeMs: (msg.timeMs as number) ?? 0,
        pv: ((msg.pv as string[]) ?? []).map((u) => uciToMove(pending.pos, u)).filter(Boolean) as Move[],
        book: Boolean(msg.book),
      });
    }
  }

  /**
   * Ask for a move.
   *
   * Takes the game's *starting* FEN plus the moves played, not just the current position. A FEN
   * alone cannot say "this position has already occurred twice", so an engine given only the
   * current board cannot see a repetition it is walking into and will happily shuffle a won game
   * into a draw. Replaying is cheap and makes the draw rules honest on both sides.
   *
   * `pos` is the current position, and is used only to turn the reply back into a real move.
   */
  think(pos: Position, startFen: string, history: Move[], opts: ThinkOptions): Promise<EngineReply> {
    this.cancel();
    const id = this.nextId++;

    if (this.fallback || !this.worker) return this.thinkInline(pos, opts);

    return new Promise<EngineReply>((resolve) => {
      this.pending = { id, pos: pos.clone(), resolve, onProgress: opts.onProgress };
      this.worker!.postMessage({
        type: 'go',
        id,
        fen: startFen,
        history: history.map(moveToUci),
        difficulty: opts.difficulty,
        maxDepth: opts.maxDepth,
        maxTime: opts.maxTime,
        useBook: opts.useBook,
        seed: (Math.random() * 0xffffffff) | 0,
      });
    });
  }

  /** The inline path: same engine, shallower, and it will block the frame while it runs. */
  private async thinkInline(pos: Position, opts: ThinkOptions): Promise<EngineReply> {
    if (!this.localSearcher) this.localSearcher = new Searcher();
    const difficulty = difficultyByKey(opts.difficulty);

    if (opts.useBook !== false) {
      const book = bookMove(pos, Math.random(), 1);
      if (book) {
        return {
          move: book, san: null, depth: 0, score: 0, mateIn: 0, nodes: 0, timeMs: 0,
          pv: [book], book: true,
        };
      }
    }

    // Yield first, so the click that triggered this has a chance to paint before the freeze.
    await new Promise((r) => setTimeout(r, 0));

    const result = this.localSearcher.search(pos.clone(), {
      // Capped harder than the worker path: this blocks the page, so a five-second search would
      // read as a crash.
      maxDepth: Math.min(opts.maxDepth ?? difficulty.maxDepth, 5),
      maxTime: Math.min(opts.maxTime ?? difficulty.maxTime, 900),
      randomness: opts.maxDepth !== undefined ? 0 : difficulty.randomness,
      blunderChance: opts.maxDepth !== undefined ? 0 : difficulty.blunderChance,
    });
    return {
      move: result.best || null, san: null, depth: result.depth, score: result.score,
      mateIn: result.mateIn, nodes: result.nodes, timeMs: result.timeMs,
      pv: result.pv, book: false,
    };
  }

  cancel(): void {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      this.worker?.postMessage({ type: 'stop' });
      pending.resolve({
        move: null, san: null, depth: 0, score: 0, mateIn: 0, nodes: 0, timeMs: 0,
        pv: [], book: false,
      });
    }
  }

  /** Forget learned tables between games, so a new match does not inherit the last one's biases. */
  reset(): void {
    this.worker?.postMessage({ type: 'reset' });
    this.localSearcher?.reset();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
