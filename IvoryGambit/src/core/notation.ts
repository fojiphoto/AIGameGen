/**
 * Standard Algebraic Notation.
 *
 * SAN is what a chess player reads, so the move list shows it rather than "e2e4". The awkward
 * part is disambiguation: "Nf3" is only correct while one knight can reach f3, and the rule for
 * which coordinate to add (file, else rank, else both) has to consider *legal* moves only —
 * a second knight that is pinned does not create an ambiguity, and writing "Ngf3" when there
 * was never a choice is wrong notation.
 */

import {
  Position, Move, moveFrom, moveTo, movePromo, isCapture,
  pieceType, fileOf, rankOf, squareName, parseSquare, PIECE_CHAR,
  PAWN, FLAG_PROMOTION, FLAG_CASTLE_K, FLAG_CASTLE_Q,
} from './position.js';
import { generateLegal, hasLegalMove } from './movegen.js';

const PIECE_LETTER = ' PNBRQK';

/**
 * Render one move as SAN. `pos` must be the position *before* the move.
 *
 * Check and mate suffixes require playing the move, so this is not free — it is called once per
 * move as it happens, never inside search.
 */
export function toSan(pos: Position, move: Move): string {
  const from = moveFrom(move);
  const to = moveTo(move);
  const piece = pos.board[from];
  const type = pieceType(piece);

  let san: string;

  if (move & (FLAG_CASTLE_K | FLAG_CASTLE_Q)) {
    san = (move & FLAG_CASTLE_K) ? 'O-O' : 'O-O-O';
  } else if (type === PAWN) {
    san = isCapture(move) ? `${'abcdefgh'[fileOf(from)]}x${squareName(to)}` : squareName(to);
    if (move & FLAG_PROMOTION) san += '=' + PIECE_LETTER[movePromo(move)];
  } else {
    // Disambiguate against other pieces of the same type that could legally reach `to`.
    let sameFile = false, sameRank = false, ambiguous = false;
    for (const other of generateLegal(pos)) {
      if (other === move) continue;
      if (moveTo(other) !== to) continue;
      const otherFrom = moveFrom(other);
      if (pieceType(pos.board[otherFrom]) !== type) continue;
      ambiguous = true;
      if (fileOf(otherFrom) === fileOf(from)) sameFile = true;
      if (rankOf(otherFrom) === rankOf(from)) sameRank = true;
    }
    let hint = '';
    if (ambiguous) {
      if (!sameFile) hint = 'abcdefgh'[fileOf(from)];
      else if (!sameRank) hint = String(rankOf(from) + 1);
      else hint = squareName(from);
    }
    san = PIECE_LETTER[type] + hint + (isCapture(move) ? 'x' : '') + squareName(to);
  }

  // Suffix: '#' beats '+', and both need the position after the move.
  if (pos.makeMove(move)) {
    if (pos.inCheck()) san += hasLegalMove(pos) ? '+' : '#';
    pos.undoMove();
  }
  return san;
}

/**
 * Parse SAN (or plain long algebraic like "e2e4") against a position.
 *
 * Matching by generating every legal move and rendering it is slower than parsing the string,
 * and far harder to get wrong — anything this accepts is a move that genuinely exists.
 */
export function fromSan(pos: Position, text: string): Move | null {
  const clean = text.trim().replace(/[!?]+$/, '');
  const legal = generateLegal(pos);

  for (const m of legal) {
    if (toSan(pos, m) === clean) return m;
  }
  // Tolerate a missing check suffix, which hand-written puzzle data often omits.
  const bare = clean.replace(/[+#]$/, '');
  for (const m of legal) {
    if (toSan(pos, m).replace(/[+#]$/, '') === bare) return m;
  }
  // Long algebraic fallback.
  const lan = /^([a-h][1-8])([a-h][1-8])([nbrq])?$/.exec(clean.toLowerCase());
  if (lan) {
    const from = parseSquare(lan[1]);
    const to = parseSquare(lan[2]);
    const promo = lan[3] ? PIECE_CHAR.indexOf(lan[3]) : 0;
    for (const m of legal) {
      if (moveFrom(m) === from && moveTo(m) === to && (!promo || movePromo(m) === promo)) return m;
    }
  }
  return null;
}

/** Move list as numbered pairs: "1. e4 e5  2. Nf3 Nc6". */
export function sanLine(pos: Position, moves: Move[]): string[] {
  const work = pos.clone();
  const out: string[] = [];
  for (const m of moves) {
    out.push(toSan(work, m));
    work.makeMove(m);
  }
  return out;
}
