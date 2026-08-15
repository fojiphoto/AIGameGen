/**
 * The chess position: board state, and the make/unmake that drives everything else.
 *
 * 0x88 board representation. The board is 128 squares wide where only half are real: a square
 * index is valid when `(sq & 0x88) === 0`. That single test replaces four bounds checks per
 * sliding step, which is the whole reason the layout is worth its wasted memory — move
 * generation runs tens of millions of times per game and off-board detection is its inner loop.
 *
 * Squares run a1=0 to h8=0x77, so `rank = sq >> 4` and `file = sq & 7`, and White advances by
 * +16. Nothing here knows about pixels, canvases or the DOM: the rules layer is deliberately
 * separable so a rendering bug can never make an illegal move legal, and so the whole of it can
 * be tested in Node with no browser at all.
 */

export const WHITE = 0;
export const BLACK = 1;
export type Color = 0 | 1;

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;
export type PieceType = 1 | 2 | 3 | 4 | 5 | 6;

/** Pieces are `type | color << 3`, so colour is one mask away and 0 stays empty. */
export const wp = 1, wn = 2, wb = 3, wr = 4, wq = 5, wk = 6;
export const bp = 9, bn = 10, bb = 11, br = 12, bq = 13, bk = 14;

export const pieceType = (p: number): number => p & 7;
export const pieceColor = (p: number): Color => ((p >> 3) & 1) as Color;
export const makePiece = (type: number, color: Color): number => type | (color << 3);

export const rankOf = (sq: number): number => sq >> 4;
export const fileOf = (sq: number): number => sq & 7;
export const square = (file: number, rank: number): number => (rank << 4) | file;
export const onBoard = (sq: number): boolean => (sq & 0x88) === 0;

/** 0x88 index -> 0..63, for anything that wants a compact array (piece-square tables, UI). */
export const to64 = (sq: number): number => (sq >> 4) * 8 + (sq & 7);
export const from64 = (i: number): number => ((i >> 3) << 4) | (i & 7);

export const SQUARE_NAMES: string[] = [];
for (let r = 0; r < 8; r++) {
  for (let f = 0; f < 8; f++) SQUARE_NAMES[square(f, r)] = 'abcdefgh'[f] + (r + 1);
}
export const squareName = (sq: number): string => SQUARE_NAMES[sq] ?? '-';
export const parseSquare = (name: string): number => {
  const f = name.charCodeAt(0) - 97;
  const r = name.charCodeAt(1) - 49;
  return f >= 0 && f < 8 && r >= 0 && r < 8 ? square(f, r) : -1;
};

// ── move encoding ───────────────────────────────────────────────────────────
//
// A move is one 32-bit integer. Search allocates no objects per move, which matters more than
// it looks: at a few hundred thousand nodes per second, an object per move is an object per
// node, and the collector pauses land in the middle of the opponent's thinking time.
//
//   bits  0-6   from square (0x88, 0..119)
//   bits  7-13  to square
//   bits 14-16  promotion piece type (0 = none)
//   bits 17-22  flags

export const FLAG_CAPTURE = 1 << 17;
export const FLAG_DOUBLE_PUSH = 1 << 18;
export const FLAG_EP = 1 << 19;
export const FLAG_CASTLE_K = 1 << 20;
export const FLAG_CASTLE_Q = 1 << 21;
export const FLAG_PROMOTION = 1 << 22;

export type Move = number;

export const encodeMove = (from: number, to: number, flags = 0, promo = 0): Move =>
  (from & 0x7f) | ((to & 0x7f) << 7) | ((promo & 7) << 14) | flags;

export const moveFrom = (m: Move): number => m & 0x7f;
export const moveTo = (m: Move): number => (m >> 7) & 0x7f;
export const movePromo = (m: Move): number => (m >> 14) & 7;
export const isCapture = (m: Move): boolean => (m & FLAG_CAPTURE) !== 0;
export const isPromotion = (m: Move): boolean => (m & FLAG_PROMOTION) !== 0;
export const isEnPassant = (m: Move): boolean => (m & FLAG_EP) !== 0;
export const isCastle = (m: Move): boolean => (m & (FLAG_CASTLE_K | FLAG_CASTLE_Q)) !== 0;

/**
 * Piece letters indexed by piece *type*, so the table has to be padded to line up with
 * PAWN=1..KING=6. Indexing a five-character string with QUEEN=5 lands past its end and yields
 * "e7e8undefined" — a promotion that no parser will ever match.
 */
export const PIECE_CHAR = ' pnbrqk';

/** Long algebraic ("e2e4", "e7e8q") — the lingua franca between UI, worker and tests. */
export const moveToUci = (m: Move): string => {
  const promo = movePromo(m);
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + (promo ? PIECE_CHAR[promo] : '');
};

// ── castling rights ─────────────────────────────────────────────────────────

export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

/**
 * Castling rights are cleared by a mask per square touched. Moving *or capturing* on a rook's
 * home square kills that right, and both cases are covered by masking on `from` and on `to` —
 * a subtlety that a naive "did the rook move" check gets wrong when the rook is captured where
 * it stands.
 */
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[square(4, 0)] = 15 & ~(CASTLE_WK | CASTLE_WQ); // e1
CASTLE_MASK[square(0, 0)] = 15 & ~CASTLE_WQ;               // a1
CASTLE_MASK[square(7, 0)] = 15 & ~CASTLE_WK;               // h1
CASTLE_MASK[square(4, 7)] = 15 & ~(CASTLE_BK | CASTLE_BQ); // e8
CASTLE_MASK[square(0, 7)] = 15 & ~CASTLE_BQ;               // a8
CASTLE_MASK[square(7, 7)] = 15 & ~CASTLE_BK;               // h8

// ── offsets ─────────────────────────────────────────────────────────────────

export const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
export const BISHOP_OFFSETS = [-17, -15, 15, 17];
export const ROOK_OFFSETS = [-16, -1, 1, 16];
export const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];

// ── zobrist ─────────────────────────────────────────────────────────────────
//
// Two 32-bit halves rather than one number: JavaScript's bitwise operators are 32-bit, and a
// 64-bit key held in a double silently loses its low bits. `lo` indexes the transposition
// table and `hi` verifies the hit, which is what keeps a collision from being played as a move.

const rngState = { s: 0x1a2b3c4d };
function rnd32(): number {
  // xorshift32 with a fixed seed: the same keys every run, so a failing search is reproducible.
  let x = rngState.s;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5; x >>>= 0;
  rngState.s = x;
  return x | 0;
}

const Z_PIECE_LO = new Int32Array(16 * 128);
const Z_PIECE_HI = new Int32Array(16 * 128);
const Z_CASTLE_LO = new Int32Array(16);
const Z_CASTLE_HI = new Int32Array(16);
const Z_EP_LO = new Int32Array(128);
const Z_EP_HI = new Int32Array(128);
let Z_SIDE_LO = 0, Z_SIDE_HI = 0;

(function initZobrist() {
  for (let i = 0; i < Z_PIECE_LO.length; i++) { Z_PIECE_LO[i] = rnd32(); Z_PIECE_HI[i] = rnd32(); }
  for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = rnd32(); Z_CASTLE_HI[i] = rnd32(); }
  for (let i = 0; i < 128; i++) { Z_EP_LO[i] = rnd32(); Z_EP_HI[i] = rnd32(); }
  Z_SIDE_LO = rnd32(); Z_SIDE_HI = rnd32();
})();

/** One entry of the undo stack. Everything here is irrecoverable from the board alone. */
interface Undo {
  move: Move;
  captured: number;
  castling: number;
  ep: number;
  halfmove: number;
  keyLo: number;
  keyHi: number;
  repBase: number;
}

export class Position {
  /** 0x88 board. Index with a square, read a piece code, 0 for empty. */
  board = new Int8Array(128);
  turn: Color = WHITE;
  castling = 0;
  /** The square a pawn may be captured *on*, or -1. */
  ep = -1;
  halfmove = 0;
  fullmove = 1;
  keyLo = 0;
  keyHi = 0;

  /** King squares, tracked incrementally — check detection asks for them on every node. */
  kings: [number, number] = [-1, -1];
  /** Piece lists per colour, so generation walks 16 squares rather than 64. */
  pieces: [number[], number[]] = [[], []];

  private history: Undo[] = [];
  /**
   * One position key per ply, starting with the initial position, for threefold repetition.
   *
   * The array is never truncated on a pawn move or capture; `repBase` moves forward instead.
   * Truncating would be simpler, but `undoMove` could not then restore what it removed, and
   * Undo in a casual game against the AI walks back through exactly those moves.
   */
  repetition: number[] = [];
  private repBase = 0;

  clone(): Position {
    const p = new Position();
    p.board.set(this.board);
    p.turn = this.turn;
    p.castling = this.castling;
    p.ep = this.ep;
    p.halfmove = this.halfmove;
    p.fullmove = this.fullmove;
    p.keyLo = this.keyLo;
    p.keyHi = this.keyHi;
    p.kings = [this.kings[0], this.kings[1]];
    p.pieces = [this.pieces[0].slice(), this.pieces[1].slice()];
    p.repetition = this.repetition.slice();
    p.repBase = this.repBase;
    return p;
  }

  clear(): void {
    this.board.fill(0);
    this.turn = WHITE;
    this.castling = 0;
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.kings = [-1, -1];
    this.pieces = [[], []];
    this.history = [];
    this.repetition = [];
    this.repBase = 0;
    this.keyLo = 0;
    this.keyHi = 0;
  }

  /** Rebuild the piece lists, king squares and hash from the board. Called after any bulk edit. */
  refresh(): void {
    this.pieces = [[], []];
    this.kings = [-1, -1];
    for (let r = 7; r >= 0; r--) {
      for (let f = 0; f < 8; f++) {
        const sq = square(f, r);
        const p = this.board[sq];
        if (!p) continue;
        const c = pieceColor(p);
        this.pieces[c].push(sq);
        if (pieceType(p) === KING) this.kings[c] = sq;
      }
    }
    this.rehash();
    this.history = [];
    this.repetition = [this.keyLo];
    this.repBase = 0;
  }

  rehash(): void {
    let lo = 0, hi = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = square(f, r);
        const p = this.board[sq];
        if (!p) continue;
        lo ^= Z_PIECE_LO[p * 128 + sq];
        hi ^= Z_PIECE_HI[p * 128 + sq];
      }
    }
    lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep]; hi ^= Z_EP_HI[this.ep]; }
    if (this.turn === BLACK) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
    this.keyLo = lo | 0;
    this.keyHi = hi | 0;
  }

  private addPiece(sq: number, piece: number): void {
    this.board[sq] = piece;
    const c = pieceColor(piece);
    this.pieces[c].push(sq);
    if (pieceType(piece) === KING) this.kings[c] = sq;
    this.keyLo ^= Z_PIECE_LO[piece * 128 + sq];
    this.keyHi ^= Z_PIECE_HI[piece * 128 + sq];
  }

  private removePiece(sq: number): void {
    const piece = this.board[sq];
    const c = pieceColor(piece);
    const list = this.pieces[c];
    const i = list.indexOf(sq);
    if (i >= 0) list.splice(i, 1);
    this.board[sq] = 0;
    this.keyLo ^= Z_PIECE_LO[piece * 128 + sq];
    this.keyHi ^= Z_PIECE_HI[piece * 128 + sq];
  }

  private movePieceTo(from: number, to: number): void {
    const piece = this.board[from];
    const c = pieceColor(piece);
    const list = this.pieces[c];
    const i = list.indexOf(from);
    if (i >= 0) list[i] = to;
    this.board[from] = 0;
    this.board[to] = piece;
    if (pieceType(piece) === KING) this.kings[c] = to;
    const base = piece * 128;
    this.keyLo ^= Z_PIECE_LO[base + from] ^ Z_PIECE_LO[base + to];
    this.keyHi ^= Z_PIECE_HI[base + from] ^ Z_PIECE_HI[base + to];
  }

  /**
   * Is `sq` attacked by `by`? Used for check, for castling legality, and for king safety.
   *
   * Runs outward from the square rather than over every enemy piece: a square has eight ray
   * directions and eight knight hops regardless of how many pieces are on the board, so the
   * cost is fixed instead of proportional to material.
   */
  isAttacked(sq: number, by: Color): boolean {
    // pawns — look back along the direction that colour's pawns capture *from*
    const dir = by === WHITE ? -16 : 16;
    const pawn = makePiece(PAWN, by);
    if (onBoard(sq + dir - 1) && this.board[sq + dir - 1] === pawn) return true;
    if (onBoard(sq + dir + 1) && this.board[sq + dir + 1] === pawn) return true;

    const knight = makePiece(KNIGHT, by);
    for (let i = 0; i < 8; i++) {
      const t = sq + KNIGHT_OFFSETS[i];
      if (onBoard(t) && this.board[t] === knight) return true;
    }

    const king = makePiece(KING, by);
    for (let i = 0; i < 8; i++) {
      const t = sq + KING_OFFSETS[i];
      if (onBoard(t) && this.board[t] === king) return true;
    }

    const bishop = makePiece(BISHOP, by), queen = makePiece(QUEEN, by);
    for (let i = 0; i < 4; i++) {
      const off = BISHOP_OFFSETS[i];
      for (let t = sq + off; onBoard(t); t += off) {
        const p = this.board[t];
        if (!p) continue;
        if (p === bishop || p === queen) return true;
        break;
      }
    }

    const rook = makePiece(ROOK, by);
    for (let i = 0; i < 4; i++) {
      const off = ROOK_OFFSETS[i];
      for (let t = sq + off; onBoard(t); t += off) {
        const p = this.board[t];
        if (!p) continue;
        if (p === rook || p === queen) return true;
        break;
      }
    }
    return false;
  }

  inCheck(color: Color = this.turn): boolean {
    const k = this.kings[color];
    return k >= 0 && this.isAttacked(k, (color ^ 1) as Color);
  }

  /**
   * Play a move. Always legal-checked by the caller (`generateLegal`), except inside search,
   * where `makeMove` returning false means the move left our own king in check and has already
   * been undone. That "make then verify" shape is cheaper than proving legality up front for
   * every move, and it is the only place pseudo-legal moves are allowed to exist.
   */
  makeMove(move: Move): boolean {
    const from = moveFrom(move);
    const to = moveTo(move);
    const piece = this.board[from];
    const us = pieceColor(piece);
    const them = (us ^ 1) as Color;

    const undo: Undo = {
      move,
      captured: 0,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      keyLo: this.keyLo,
      keyHi: this.keyHi,
      repBase: this.repBase,
    };

    // Clear the old en-passant square from the hash before anything else touches it.
    if (this.ep >= 0) { this.keyLo ^= Z_EP_LO[this.ep]; this.keyHi ^= Z_EP_HI[this.ep]; }
    this.keyLo ^= Z_CASTLE_LO[this.castling]; this.keyHi ^= Z_CASTLE_HI[this.castling];

    if (move & FLAG_EP) {
      // The captured pawn is beside the destination, not on it.
      const capSq = to - (us === WHITE ? 16 : -16);
      undo.captured = this.board[capSq];
      this.removePiece(capSq);
    } else if (this.board[to]) {
      undo.captured = this.board[to];
      this.removePiece(to);
    }

    this.movePieceTo(from, to);

    if (move & FLAG_PROMOTION) {
      this.removePiece(to);
      this.addPiece(to, makePiece(movePromo(move), us));
    }

    if (move & FLAG_CASTLE_K) {
      this.movePieceTo(square(7, rankOf(from)), square(5, rankOf(from)));
    } else if (move & FLAG_CASTLE_Q) {
      this.movePieceTo(square(0, rankOf(from)), square(3, rankOf(from)));
    }

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    this.keyLo ^= Z_CASTLE_LO[this.castling]; this.keyHi ^= Z_CASTLE_HI[this.castling];

    this.ep = (move & FLAG_DOUBLE_PUSH) ? (from + to) >> 1 : -1;
    if (this.ep >= 0) { this.keyLo ^= Z_EP_LO[this.ep]; this.keyHi ^= Z_EP_HI[this.ep]; }

    const irreversible = pieceType(piece) === PAWN || undo.captured !== 0;
    this.halfmove = irreversible ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;

    this.turn = them;
    this.keyLo ^= Z_SIDE_LO; this.keyHi ^= Z_SIDE_HI;

    this.history.push(undo);
    // Pushed before the legality test, not after, so that `undoMove` can pop unconditionally —
    // an illegal move is undone through exactly the same path as a legal one.
    this.repetition.push(this.keyLo);
    if (irreversible) this.repBase = this.repetition.length - 1;

    if (this.isAttacked(this.kings[us], them)) {
      this.undoMove();
      return false;
    }
    return true;
  }

  undoMove(): void {
    const undo = this.history.pop();
    if (!undo) return;
    const move = undo.move;
    const from = moveFrom(move);
    const to = moveTo(move);

    this.turn = (this.turn ^ 1) as Color;
    const us = this.turn;
    if (us === BLACK) this.fullmove--;

    if (move & FLAG_CASTLE_K) {
      this.movePieceTo(square(5, rankOf(from)), square(7, rankOf(from)));
    } else if (move & FLAG_CASTLE_Q) {
      this.movePieceTo(square(3, rankOf(from)), square(0, rankOf(from)));
    }

    if (move & FLAG_PROMOTION) {
      this.removePiece(to);
      this.addPiece(to, makePiece(PAWN, us));
    }

    this.movePieceTo(to, from);

    if (undo.captured) {
      const capSq = (move & FLAG_EP) ? to - (us === WHITE ? 16 : -16) : to;
      this.addPiece(capSq, undo.captured);
    }

    this.castling = undo.castling;
    this.ep = undo.ep;
    this.halfmove = undo.halfmove;
    this.keyLo = undo.keyLo;
    this.keyHi = undo.keyHi;
    this.repetition.pop();
    this.repBase = undo.repBase;
  }

  /**
   * A null move: hand the turn over without playing anything.
   *
   * Search uses it to prove "even if I do nothing, the opponent has no threat here" — but only
   * where the side to move is not in check and has pieces beyond pawns, because a null move in
   * zugzwang proves the opposite of the truth.
   */
  makeNull(): void {
    this.history.push({
      move: 0, captured: 0, castling: this.castling, ep: this.ep,
      halfmove: this.halfmove, keyLo: this.keyLo, keyHi: this.keyHi, repBase: this.repBase,
    });
    if (this.ep >= 0) { this.keyLo ^= Z_EP_LO[this.ep]; this.keyHi ^= Z_EP_HI[this.ep]; }
    this.ep = -1;
    this.turn = (this.turn ^ 1) as Color;
    this.keyLo ^= Z_SIDE_LO; this.keyHi ^= Z_SIDE_HI;
    this.halfmove++;
  }

  undoNull(): void {
    const undo = this.history.pop();
    if (!undo) return;
    this.turn = (this.turn ^ 1) as Color;
    this.castling = undo.castling;
    this.ep = undo.ep;
    this.halfmove = undo.halfmove;
    this.keyLo = undo.keyLo;
    this.keyHi = undo.keyHi;
  }

  /**
   * How many times the current position has occurred, counting itself.
   *
   * Only positions since the last irreversible move can repeat, so the scan starts at
   * `repBase`. Threefold is `>= 3`.
   */
  repetitionCount(): number {
    let n = 0;
    for (let i = this.repetition.length - 1; i >= this.repBase; i--) {
      if (this.repetition[i] === this.keyLo) n++;
    }
    return n;
  }

  /** Number of plies played, used by the UI to know how far back Undo can reach. */
  get ply(): number { return this.history.length; }

  lastMove(): Move | null {
    const h = this.history[this.history.length - 1];
    return h ? h.move : null;
  }
}
