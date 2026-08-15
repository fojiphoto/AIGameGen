/**
 * Move generation.
 *
 * Two layers, deliberately. `generatePseudo` produces every move that obeys how a piece moves,
 * ignoring whether it exposes its own king; search plays those and lets `makeMove` reject the
 * illegal ones, because proving legality up front for moves that get pruned anyway is wasted
 * work. `generateLegal` filters properly and is what the UI asks for — the interface must never
 * offer a move that turns out not to exist.
 *
 * Castling is the one case where legality is checked here rather than after the move: the king
 * passes *through* a square it does not end on, and `makeMove`'s "is my king attacked now" test
 * cannot see that.
 */

import {
  Position, Color, WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  Move, encodeMove, moveToUci, onBoard, rankOf, square, pieceType, pieceColor, makePiece,
  KNIGHT_OFFSETS, BISHOP_OFFSETS, ROOK_OFFSETS, KING_OFFSETS,
  FLAG_CAPTURE, FLAG_DOUBLE_PUSH, FLAG_EP, FLAG_CASTLE_K, FLAG_CASTLE_Q, FLAG_PROMOTION,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ,
} from './position.js';

/** Queen rays are the union of the other two sliders — the same eight the king steps one of. */
const QUEEN_OFFSETS = KING_OFFSETS;

/** Queen first: move ordering is better when the move most likely to be best comes out first. */
const PROMOTION_PIECES = [QUEEN, ROOK, BISHOP, KNIGHT];

/**
 * @param capturesOnly Generate only captures and promotions. Quiescence search uses this to
 *   look past a tactical sequence without exploring quiet moves it will never play.
 */
export function generatePseudo(pos: Position, out: Move[], capturesOnly = false): Move[] {
  out.length = 0;
  const us = pos.turn;
  const them = (us ^ 1) as Color;
  const board = pos.board;
  const list = pos.pieces[us];

  for (let i = 0; i < list.length; i++) {
    const from = list[i];
    const piece = board[from];
    const type = pieceType(piece);

    if (type === PAWN) {
      const forward = us === WHITE ? 16 : -16;
      const startRank = us === WHITE ? 1 : 6;
      const promoRank = us === WHITE ? 7 : 0;

      const one = from + forward;
      if (onBoard(one) && !board[one]) {
        if (rankOf(one) === promoRank) {
          // Promotions survive captures-only mode: a pawn reaching the last rank swings material
          // as hard as any capture, and a quiescence search that skips it walks into a new queen
          // and calls the position quiet.
          for (let q = 0; q < 4; q++) {
            out.push(encodeMove(from, one, FLAG_PROMOTION, PROMOTION_PIECES[q]));
          }
        } else if (!capturesOnly) {
          out.push(encodeMove(from, one));
          const two = from + forward * 2;
          if (rankOf(from) === startRank && !board[two]) {
            out.push(encodeMove(from, two, FLAG_DOUBLE_PUSH));
          }
        }
      }

      for (let s = 0; s < 2; s++) {
        const to = from + forward + (s === 0 ? -1 : 1);
        if (!onBoard(to)) continue;
        const target = board[to];
        if (target && pieceColor(target) === them) {
          if (rankOf(to) === promoRank) {
            for (let q = 0; q < 4; q++) {
              out.push(encodeMove(from, to, FLAG_PROMOTION | FLAG_CAPTURE, PROMOTION_PIECES[q]));
            }
          } else {
            out.push(encodeMove(from, to, FLAG_CAPTURE));
          }
        } else if (!target && to === pos.ep) {
          out.push(encodeMove(from, to, FLAG_CAPTURE | FLAG_EP));
        }
      }
      continue;
    }

    if (type === KNIGHT || type === KING) {
      const offsets = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
      for (let k = 0; k < offsets.length; k++) {
        const to = from + offsets[k];
        if (!onBoard(to)) continue;
        const target = board[to];
        if (!target) {
          if (!capturesOnly) out.push(encodeMove(from, to));
        } else if (pieceColor(target) === them) {
          out.push(encodeMove(from, to, FLAG_CAPTURE));
        }
      }
      continue;
    }

    // sliders
    const offsets = type === BISHOP ? BISHOP_OFFSETS
      : type === ROOK ? ROOK_OFFSETS
      : QUEEN_OFFSETS;
    for (let k = 0; k < offsets.length; k++) {
      const off = offsets[k];
      for (let to = from + off; onBoard(to); to += off) {
        const target = board[to];
        if (!target) {
          if (!capturesOnly) out.push(encodeMove(from, to));
          continue;
        }
        if (pieceColor(target) === them) out.push(encodeMove(from, to, FLAG_CAPTURE));
        break;
      }
    }
  }

  if (!capturesOnly) addCastles(pos, out);
  return out;
}

function addCastles(pos: Position, out: Move[]): void {
  const us = pos.turn;
  const them = (us ^ 1) as Color;
  const rank = us === WHITE ? 0 : 7;
  const king = square(4, rank);
  if (pos.board[king] !== makePiece(KING, us)) return;
  // A king already in check may not castle out of it.
  if (pos.isAttacked(king, them)) return;

  const kingSide = us === WHITE ? CASTLE_WK : CASTLE_BK;
  const queenSide = us === WHITE ? CASTLE_WQ : CASTLE_BQ;
  const rook = makePiece(ROOK, us);

  if ((pos.castling & kingSide) && pos.board[square(7, rank)] === rook) {
    const f = square(5, rank), g = square(6, rank);
    if (!pos.board[f] && !pos.board[g] && !pos.isAttacked(f, them) && !pos.isAttacked(g, them)) {
      out.push(encodeMove(king, g, FLAG_CASTLE_K));
    }
  }
  if ((pos.castling & queenSide) && pos.board[square(0, rank)] === rook) {
    const b = square(1, rank), c = square(2, rank), d = square(3, rank);
    // b1/b8 must be empty but need not be safe — the king never stands on it.
    if (!pos.board[b] && !pos.board[c] && !pos.board[d]
        && !pos.isAttacked(c, them) && !pos.isAttacked(d, them)) {
      out.push(encodeMove(king, c, FLAG_CASTLE_Q));
    }
  }
}

/** Every move that is actually playable. The only generator the interface is allowed to use. */
export function generateLegal(pos: Position, out: Move[] = []): Move[] {
  const pseudo: Move[] = [];
  generatePseudo(pos, pseudo);
  out.length = 0;
  for (let i = 0; i < pseudo.length; i++) {
    if (pos.makeMove(pseudo[i])) {
      out.push(pseudo[i]);
      pos.undoMove();
    }
  }
  return out;
}

/** Legal moves for one piece — what the board shows when a piece is picked up. */
export function legalMovesFrom(pos: Position, from: number): Move[] {
  const all = generateLegal(pos);
  return all.filter((m) => (m & 0x7f) === from);
}

export function hasLegalMove(pos: Position): boolean {
  const pseudo: Move[] = [];
  generatePseudo(pos, pseudo);
  for (let i = 0; i < pseudo.length; i++) {
    if (pos.makeMove(pseudo[i])) {
      pos.undoMove();
      return true;
    }
  }
  return false;
}

/**
 * Count leaf nodes at a fixed depth.
 *
 * This is the acid test for a move generator: the node counts for a handful of standard
 * positions are published and exact, so a single wrong number means a rule is wrong — and it
 * catches the cases that hand-written tests always miss, like an en-passant capture that
 * happens to expose a rank-pinned king. Nothing else in the project verifies as much per line.
 */
export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves: Move[] = [];
  generatePseudo(pos, moves);
  let nodes = 0;
  for (let i = 0; i < moves.length; i++) {
    if (!pos.makeMove(moves[i])) continue;
    nodes += depth === 1 ? 1 : perft(pos, depth - 1);
    pos.undoMove();
  }
  return nodes;
}

/** Perft split by first move, for finding *which* move generates a wrong subtree. */
export function perftDivide(pos: Position, depth: number): Map<string, number> {
  const result = new Map<string, number>();
  const moves: Move[] = [];
  generatePseudo(pos, moves);
  for (const m of moves) {
    if (!pos.makeMove(m)) continue;
    const n = depth <= 1 ? 1 : perft(pos, depth - 1);
    pos.undoMove();
    result.set(moveToUci(m), n);
  }
  return result;
}

export { PROMOTION_PIECES };
