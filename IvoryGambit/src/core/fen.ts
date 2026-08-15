/**
 * FEN in and out.
 *
 * FEN is how positions get into the game from anywhere else — puzzles, test cases, a saved
 * match — so parsing is deliberately forgiving about whitespace and missing trailing fields,
 * and deliberately strict about the board itself. A malformed board is thrown rather than
 * half-loaded, because a position that is 90% right is worse than no position at all.
 */

import {
  Position, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  square, pieceType, pieceColor, makePiece, parseSquare, squareName,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ, Color,
} from './position.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const CHAR_TO_TYPE: Record<string, number> = {
  p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING,
};
const TYPE_TO_CHAR = ' pnbrqk';

export function parseFen(fen: string): Position {
  const pos = new Position();
  pos.clear();

  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`FEN needs at least a board and a side to move: "${fen}"`);

  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error(`FEN board must have 8 ranks, got ${rows.length}`);

  for (let i = 0; i < 8; i++) {
    const rank = 7 - i;                 // FEN starts at rank 8
    let file = 0;
    for (const ch of rows[i]) {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
      } else {
        const type = CHAR_TO_TYPE[ch.toLowerCase()];
        if (!type) throw new Error(`FEN has an unknown piece "${ch}"`);
        if (file > 7) throw new Error(`FEN rank ${rank + 1} overflows the board`);
        const color: Color = ch === ch.toUpperCase() ? WHITE : BLACK;
        pos.board[square(file, rank)] = makePiece(type, color);
        file++;
      }
    }
    if (file !== 8) throw new Error(`FEN rank ${rank + 1} describes ${file} squares, not 8`);
  }

  pos.turn = parts[1] === 'b' ? BLACK : WHITE;

  const rights = parts[2] ?? '-';
  if (rights.includes('K')) pos.castling |= CASTLE_WK;
  if (rights.includes('Q')) pos.castling |= CASTLE_WQ;
  if (rights.includes('k')) pos.castling |= CASTLE_BK;
  if (rights.includes('q')) pos.castling |= CASTLE_BQ;

  const ep = parts[3] ?? '-';
  pos.ep = ep === '-' ? -1 : parseSquare(ep);

  pos.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
  pos.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;

  pos.refresh();

  if (pos.kings[WHITE] < 0 || pos.kings[BLACK] < 0) {
    throw new Error('FEN is missing a king — every position needs both');
  }
  return pos;
}

export function toFen(pos: Position): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = pos.board[square(file, rank)];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      const ch = TYPE_TO_CHAR[pieceType(p)];
      row += pieceColor(p) === WHITE ? ch.toUpperCase() : ch;
    }
    if (empty) row += empty;
    rows.push(row);
  }

  let rights = '';
  if (pos.castling & CASTLE_WK) rights += 'K';
  if (pos.castling & CASTLE_WQ) rights += 'Q';
  if (pos.castling & CASTLE_BK) rights += 'k';
  if (pos.castling & CASTLE_BQ) rights += 'q';

  return [
    rows.join('/'),
    pos.turn === WHITE ? 'w' : 'b',
    rights || '-',
    pos.ep >= 0 ? squareName(pos.ep) : '-',
    pos.halfmove,
    pos.fullmove,
  ].join(' ');
}

export function startPosition(): Position {
  return parseFen(START_FEN);
}
