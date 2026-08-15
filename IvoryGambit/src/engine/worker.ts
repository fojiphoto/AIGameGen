/**
 * The engine, as a Web Worker.
 *
 * This file is the entire reason the interface stays at 60 fps while the opponent thinks. A
 * five-second search on the main thread does not "slow the page down" — it stops it completely:
 * no rendering, no scrolling, no response to a click, and on mobile the browser may offer to
 * kill the tab. Moving it here costs one message round-trip and buys a board that keeps
 * animating and a Cancel button that actually works.
 *
 * The protocol is deliberately tiny and one-way-ish: the app posts a position and settings, the
 * worker streams `info` messages as each iteration completes and finishes with `bestmove`.
 */

import { Position, parseFen, moveToUci, toSan, generateLegal, Move } from '../core/index.js';
import { Searcher, SearchInfo, difficultyByKey } from './search.js';
import { bookMove } from './book.js';

interface GoMessage {
  type: 'go';
  id: number;
  fen: string;
  /** Moves already played from `fen`, so repetition inside the search sees the real history. */
  history?: string[];
  difficulty: string;
  /** Overrides for analysis and hints, which want full strength regardless of difficulty. */
  maxDepth?: number;
  maxTime?: number;
  useBook?: boolean;
  seed?: number;
}

type InMessage =
  | GoMessage
  | { type: 'stop' }
  | { type: 'reset' };

const searcher = new Searcher();
let cancelled = false;
let currentId = 0;

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

/**
 * Rebuild the position with its history replayed.
 *
 * The FEN alone cannot express "this position has occurred twice already", and without that the
 * engine cannot see a repetition it is walking into — it will happily shuffle a won game into a
 * draw. Replaying the moves is cheap and makes repetition detection honest.
 */
function buildPosition(fen: string, history?: string[]): Position {
  const pos = parseFen(fen);
  if (!history || history.length === 0) return pos;
  for (const uci of history) {
    const move = generateLegal(pos).find((m: Move) => moveToUci(m) === uci);
    if (!move) break;
    pos.makeMove(move);
  }
  return pos;
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const msg = event.data;

  if (msg.type === 'stop') { cancelled = true; return; }
  if (msg.type === 'reset') { searcher.reset(); return; }
  if (msg.type !== 'go') return;

  cancelled = false;
  currentId = msg.id;
  const difficulty = difficultyByKey(msg.difficulty);

  let pos: Position;
  try {
    pos = buildPosition(msg.fen, msg.history);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: String((err as Error).message ?? err) });
    return;
  }

  if (msg.seed !== undefined) searcher.seedWith(msg.seed);

  // Book first. Lower levels spread wider across the book's weights, which gives them more
  // varied — and slightly worse — openings without any extra machinery.
  if (msg.useBook !== false) {
    const spread = difficulty.randomness > 50 ? 1.4 : difficulty.randomness > 10 ? 1 : 0.55;
    const book = bookMove(pos, Math.random(), spread);
    if (book) {
      post({
        type: 'bestmove', id: msg.id, move: moveToUci(book), san: toSan(pos, book),
        depth: 0, score: 0, mateIn: 0, nodes: 0, timeMs: 0, pv: [moveToUci(book)], book: true,
      });
      return;
    }
  }

  const result = searcher.search(pos, {
    maxDepth: msg.maxDepth ?? difficulty.maxDepth,
    maxTime: msg.maxTime ?? difficulty.maxTime,
    randomness: msg.maxDepth !== undefined ? 0 : difficulty.randomness,
    blunderChance: msg.maxDepth !== undefined ? 0 : difficulty.blunderChance,
    shouldStop: () => cancelled,
    onIteration: (info: SearchInfo) => {
      post({
        type: 'info',
        id: msg.id,
        depth: info.depth,
        score: info.score,
        mateIn: info.mateIn,
        nodes: info.nodes,
        timeMs: info.timeMs,
        pv: info.pv.map(moveToUci),
      });
    },
  });

  if (cancelled || currentId !== msg.id) {
    post({ type: 'cancelled', id: msg.id });
    return;
  }

  post({
    type: 'bestmove',
    id: msg.id,
    move: result.best ? moveToUci(result.best) : null,
    san: result.best ? toSan(pos, result.best) : null,
    depth: result.depth,
    score: result.score,
    mateIn: result.mateIn,
    nodes: result.nodes,
    timeMs: result.timeMs,
    pv: result.pv.map(moveToUci),
    book: false,
  });
};

post({ type: 'ready' });
