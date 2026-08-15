/**
 * How a game ends.
 *
 * The result panel names the exact reason rather than "Game Over", so every terminal condition
 * is a distinct value here: a draw by repetition and a draw by insufficient material feel
 * completely different to the player who reached one, and collapsing them loses the only
 * information the screen is there to give.
 *
 * Note the asymmetry the rules actually specify: checkmate and stalemate are automatic, while
 * threefold repetition and the fifty-move rule are *claims* — a player may keep playing. The
 * game offers them as claimable and auto-draws only at the hard limits (fivefold, seventy-five
 * moves), which is what over-the-board rules do too.
 */

import {
  Position, Color, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN,
  pieceType, fileOf, rankOf,
} from './position.js';
import { hasLegalMove } from './movegen.js';

export type Outcome =
  | 'playing'
  | 'checkmate'
  | 'stalemate'
  | 'repetition'
  | 'fifty-move'
  | 'insufficient'
  | 'timeout'
  | 'resignation'
  | 'agreement';

export interface GameStatus {
  outcome: Outcome;
  /** Winner, or null for any draw / still playing. */
  winner: Color | null;
  over: boolean;
  /** True when the side to move may claim a draw but is not forced to. */
  claimableDraw: Outcome | null;
  /** One line, already player-facing. */
  reason: string;
}

const PLAYING: GameStatus = {
  outcome: 'playing', winner: null, over: false, claimableDraw: null, reason: '',
};

/**
 * Neither side can construct a mate with the material on the board.
 *
 * The strict FIDE test is "mate is impossible by any sequence of legal moves", which is wider
 * than this — K+B vs K+B on the same colour is dead, and so is K+N vs K+N in most but not all
 * arrangements. The standard practical set is used instead: bare kings, K+minor, and K+B vs K+B
 * on the same square colour. Anything beyond that is left playable, which errs toward letting
 * the game continue rather than declaring a draw a player did not expect.
 */
export function insufficientMaterial(pos: Position): boolean {
  const minors: { color: Color; type: number; squareColor: number }[] = [];

  for (const color of [WHITE, BLACK] as Color[]) {
    for (const sq of pos.pieces[color]) {
      const type = pieceType(pos.board[sq]);
      if (type === PAWN || type === ROOK || type === QUEEN) return false;
      if (type === KNIGHT || type === BISHOP) {
        minors.push({ color, type, squareColor: (fileOf(sq) + rankOf(sq)) & 1 });
        if (minors.length > 2) return false;
      }
    }
  }

  if (minors.length <= 1) return true;                    // K vs K, K+minor vs K
  const [a, b] = minors;
  if (a.color === b.color) return false;                  // two minors on one side can mate
  return a.type === BISHOP && b.type === BISHOP && a.squareColor === b.squareColor;
}

/**
 * The current status.
 *
 * `hasLegalMove` is the expensive part and runs first because both mate and stalemate need it;
 * the draw tests are cheap and only matter when the game would otherwise continue.
 */
export function gameStatus(pos: Position): GameStatus {
  const canMove = hasLegalMove(pos);
  const check = pos.inCheck();

  if (!canMove) {
    if (check) {
      const winner = (pos.turn ^ 1) as Color;
      return {
        outcome: 'checkmate',
        winner,
        over: true,
        claimableDraw: null,
        reason: `${winner === WHITE ? 'White' : 'Black'} delivers checkmate`,
      };
    }
    return {
      outcome: 'stalemate', winner: null, over: true, claimableDraw: null,
      reason: 'Stalemate — no legal move, and the king is not in check',
    };
  }

  if (insufficientMaterial(pos)) {
    return {
      outcome: 'insufficient', winner: null, over: true, claimableDraw: null,
      reason: 'Draw — neither side has enough material to checkmate',
    };
  }

  const reps = pos.repetitionCount();
  if (reps >= 5) {
    return {
      outcome: 'repetition', winner: null, over: true, claimableDraw: null,
      reason: 'Draw — the same position occurred five times',
    };
  }
  if (pos.halfmove >= 150) {
    return {
      outcome: 'fifty-move', winner: null, over: true, claimableDraw: null,
      reason: 'Draw — seventy-five moves without a capture or a pawn move',
    };
  }

  if (reps >= 3) return { ...PLAYING, claimableDraw: 'repetition' };
  if (pos.halfmove >= 100) return { ...PLAYING, claimableDraw: 'fifty-move' };
  return PLAYING;
}

export function outcomeTitle(status: GameStatus): string {
  switch (status.outcome) {
    case 'checkmate': return 'CHECKMATE';
    case 'stalemate': return 'STALEMATE';
    case 'repetition': return 'DRAW BY REPETITION';
    case 'fifty-move': return 'DRAW BY FIFTY-MOVE RULE';
    case 'insufficient': return 'DRAW BY INSUFFICIENT MATERIAL';
    case 'timeout': return 'TIME OUT';
    case 'resignation': return 'RESIGNATION';
    case 'agreement': return 'DRAW AGREED';
    default: return '';
  }
}

/** Material value in pawns, for the "White +3" readout beside the captured pieces. */
export const MATERIAL_VALUE = [0, 1, 3, 3, 5, 9, 0];

export function materialBalance(pos: Position): number {
  let score = 0;
  for (const sq of pos.pieces[WHITE]) score += MATERIAL_VALUE[pieceType(pos.board[sq])];
  for (const sq of pos.pieces[BLACK]) score -= MATERIAL_VALUE[pieceType(pos.board[sq])];
  return score;
}

/**
 * Which pieces each side has captured, derived from what is missing rather than tracked.
 *
 * Deriving it means Undo cannot desynchronise the display from the board — there is no separate
 * list to forget to roll back. Promotions can make a side hold more queens than it started
 * with, so counts are clamped at zero rather than allowed to go negative.
 */
export function capturedPieces(pos: Position): { white: number[]; black: number[] } {
  const START: Record<number, number> = {
    [PAWN]: 8, [KNIGHT]: 2, [BISHOP]: 2, [ROOK]: 2, [QUEEN]: 1,
  };
  const alive: Record<number, [number, number]> = {
    [PAWN]: [0, 0], [KNIGHT]: [0, 0], [BISHOP]: [0, 0], [ROOK]: [0, 0], [QUEEN]: [0, 0],
  };
  for (const color of [WHITE, BLACK] as Color[]) {
    for (const sq of pos.pieces[color]) {
      const t = pieceType(pos.board[sq]);
      if (alive[t]) alive[t][color]++;
    }
  }
  // "white" holds the white pieces that were captured, i.e. Black's trophies.
  const white: number[] = [], black: number[] = [];
  for (const t of [QUEEN, ROOK, BISHOP, KNIGHT, PAWN]) {
    for (let i = 0; i < Math.max(0, START[t] - alive[t][WHITE]); i++) white.push(t);
    for (let i = 0; i < Math.max(0, START[t] - alive[t][BLACK]); i++) black.push(t);
  }
  return { white, black };
}
