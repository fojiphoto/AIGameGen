/**
 * Position evaluation, in centipawns from the side-to-move's point of view.
 *
 * The score is *tapered*: every term has a middlegame and an endgame value, and the two are
 * blended by how much material is left. Without that, an engine plays the opening like an
 * endgame — it marches the king up the board on move 12 because the endgame table says a
 * central king is strong, and it keeps the king cowering behind pawns in a king-and-pawn ending
 * where activity is the whole game. One set of tables cannot express both, and a hard switch at
 * some material threshold makes the engine change its mind mid-game for no reason the player
 * can see.
 *
 * Values are in centipawns with a pawn at 100. They are hand-tuned rather than learned: the
 * point is an opponent that plays recognisable, human-looking chess at a range of strengths,
 * not the last fifty Elo.
 */

import {
  Position, Color, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  pieceType, pieceColor, to64, fileOf, rankOf, onBoard,
  KNIGHT_OFFSETS, BISHOP_OFFSETS, ROOK_OFFSETS, KING_OFFSETS,
} from '../core/index.js';

/** Indexed by piece type. Kings are priceless and never counted. */
export const MG_VALUE = [0, 82, 337, 365, 477, 1025, 0];
export const EG_VALUE = [0, 94, 281, 297, 512, 936, 0];

/**
 * Piece-square tables, a1..h8 from White's point of view. Black reads them mirrored
 * (`index ^ 56` flips the rank and leaves the file alone).
 */
const PST_MG: number[][] = [];
const PST_EG: number[][] = [];

PST_MG[PAWN] = [
    0,   0,   0,   0,   0,   0,   0,   0,
  -35,  -1, -20, -23, -15,  24,  38, -22,
  -26,  -4,  -4, -10,   3,   3,  33, -12,
  -27,  -2,  -5,  12,  17,   6,  10, -25,
  -14,  13,   6,  21,  23,  12,  17, -23,
   -6,   7,  26,  31,  65,  56,  25, -20,
   98, 134,  61,  95,  68, 126,  34, -11,
    0,   0,   0,   0,   0,   0,   0,   0,
];
PST_EG[PAWN] = [
    0,   0,   0,   0,   0,   0,   0,   0,
   13,   8,   8,  10,  13,   0,   2,  -7,
    4,   7,  -6,   1,   0,  -5,  -1,  -8,
   13,   9,  -3,  -7,  -7,  -8,   3,  -1,
   32,  24,  13,   5,  -2,   4,  17,  17,
   94, 100,  85,  67,  56,  53,  82,  84,
  178, 173, 158, 134, 147, 132, 165, 187,
    0,   0,   0,   0,   0,   0,   0,   0,
];

PST_MG[KNIGHT] = [
 -105, -21, -58, -33, -17, -28, -19, -23,
  -29, -53, -12,  -3,  -1,  18, -14, -19,
  -23,  -9,  12,  10,  19,  17,  25, -16,
  -13,   4,  16,  13,  28,  19,  21,  -8,
   -9,  17,  19,  53,  37,  69,  18,  22,
  -47,  60,  37,  65,  84, 129,  73,  44,
  -73, -41,  72,  36,  23,  62,   7, -17,
 -167, -89, -34, -49,  61, -97, -15, -107,
];
PST_EG[KNIGHT] = [
  -29, -51, -23, -15, -22, -18, -50, -64,
  -42, -20, -10,  -5,  -2, -20, -23, -44,
  -23,  -3,  -1,  15,  10,  -3, -20, -22,
  -18,  -6,  16,  25,  16,  17,   4, -18,
  -17,   3,  22,  22,  22,  11,   8, -18,
  -24, -20,  10,   9,  -1,  -9, -19, -41,
  -25,  -8, -25,  -2,  -9, -25, -24, -52,
  -58, -38, -13, -28, -31, -27, -63, -99,
];

PST_MG[BISHOP] = [
  -33,  -3, -14, -21, -13, -12, -39, -21,
    4,  15,  16,   0,   7,  21,  33,   1,
    0,  15,  15,  15,  14,  27,  18,  10,
   -6,  13,  13,  26,  34,  12,  10,   4,
   -4,   5,  19,  50,  37,  37,   7,  -2,
  -16,  37,  43,  40,  35,  50,  37,  -2,
  -26,  16, -18, -13,  30,  59,  18, -47,
  -29,   4, -82, -37, -25, -42,   7,  -8,
];
PST_EG[BISHOP] = [
  -23,  -9, -23,  -5,  -9, -16,  -5, -17,
  -14, -18,  -7,  -1,   4,  -9, -15, -27,
  -12,  -3,   8,  10,  13,   3,  -7, -15,
   -6,   3,  13,  19,   7,  10,  -3,  -9,
   -3,   9,  12,   9,  14,  10,   3,   2,
    2,  -8,   0,  -1,  -2,   6,   0,   4,
   -8,  -4,   7, -12,  -3, -13,  -4, -14,
  -14, -21, -11,  -8,  -7,  -9, -17, -24,
];

PST_MG[ROOK] = [
  -19, -13,   1,  17,  16,   7, -37, -26,
  -44, -16, -20,  -9,  -1,  11,  -6, -71,
  -45, -25, -16, -17,   3,   0,  -5, -33,
  -36, -26, -12,  -1,   9,  -7,   6, -23,
  -24, -11,   7,  26,  24,  35,  -8, -20,
   -5,  19,  26,  36,  17,  45,  61,  16,
   27,  32,  58,  62,  80,  67,  26,  44,
   32,  42,  32,  51,  63,   9,  31,  43,
];
PST_EG[ROOK] = [
   -9,   2,   3,  -1,  -5, -13,   4, -20,
   -6,  -6,   0,   2,  -9,  -9, -11,  -3,
   -4,   0,  -5,  -1,  -7, -12,  -8, -16,
    3,   5,   8,   4,  -5,  -6,  -8, -11,
    4,   3,  13,   1,   2,   1,  -1,   2,
    7,   7,   7,   5,   4,  -3,  -5,  -3,
   11,  13,  13,  11,  -3,   3,   8,   3,
   13,  10,  18,  15,  12,  12,   8,   5,
];

PST_MG[QUEEN] = [
   -1, -18,  -9,  10, -15, -25, -31, -50,
  -35,  -8,  11,   2,   8,  15,  -3,   1,
  -14,   2, -11,  -2,  -5,   2,  14,   5,
   -9, -26,  -9, -10,  -2,  -4,   3,  -3,
  -27, -27, -16, -16,  -1,  17,  -2,   1,
  -13, -17,   7,   8,  29,  56,  47,  57,
  -24, -39,  -5,   1, -16,  57,  28,  54,
  -28,   0,  29,  12,  59,  44,  43,  45,
];
PST_EG[QUEEN] = [
  -33, -28, -22, -43,  -5, -32, -20, -41,
  -22, -23, -30, -16, -16, -23, -36, -32,
  -16, -27,  15,   6,   9,  17,  10,   5,
  -18,  28,  19,  47,  31,  34,  39,  23,
    3,  22,  24,  45,  57,  40,  57,  36,
  -20,   6,   9,  49,  47,  35,  19,   9,
  -17,  20,  32,  41,  58,  25,  30,   0,
   -9,  22,  22,  27,  27,  19,  10,  20,
];

PST_MG[KING] = [
  -15,  36,  12, -54,   8, -28,  24,  14,
    1,   7,  -8, -64, -43, -16,   9,   8,
  -14, -14, -22, -46, -44, -30, -15, -27,
  -49,  -1, -27, -39, -46, -44, -33, -51,
  -17, -20, -12, -27, -30, -25, -14, -36,
   -9,  24,   2, -16, -20,   6,  22, -22,
   29,  -1, -20,  -7,  -8,  -4, -38, -29,
  -65,  23,  16, -15, -56, -34,   2,  13,
];
PST_EG[KING] = [
  -53, -34, -21, -11, -28, -14, -24, -43,
  -27, -11,   4,  13,  14,   4,  -5, -17,
  -19,  -3,  11,  21,  23,  16,   7,  -9,
  -18,  -4,  21,  24,  27,  23,   9, -11,
   -8,  22,  24,  27,  26,  33,  26,   3,
   10,  17,  23,  15,  20,  45,  44,  13,
  -12,  17,  14,  17,  17,  38,  23,  11,
  -74, -35, -18, -18, -11,  15,   4, -17,
];

/**
 * Game phase weights. The blend runs from 24 (all pieces on) to 0 (bare kings), so it tracks
 * the disappearance of *pieces* rather than pawns — a queenless position with all sixteen pawns
 * is an endgame in every sense that matters to the evaluation.
 */
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const TOTAL_PHASE = 24;

// ── term weights ────────────────────────────────────────────────────────────

const BISHOP_PAIR_MG = 30, BISHOP_PAIR_EG = 55;
const DOUBLED_PAWN_MG = -11, DOUBLED_PAWN_EG = -26;
const ISOLATED_PAWN_MG = -14, ISOLATED_PAWN_EG = -17;
/** Passed pawn bonus by the rank it has reached, from its own side's view. */
const PASSED_MG = [0, 5, 8, 18, 38, 68, 110, 0];
const PASSED_EG = [0, 12, 22, 44, 78, 130, 190, 0];
const ROOK_OPEN_FILE = 26, ROOK_SEMI_OPEN = 12;
const ROOK_ON_SEVENTH = 20;
const MOBILITY_MG = [0, 0, 4, 4, 2, 1, 0];
const MOBILITY_EG = [0, 0, 4, 5, 4, 2, 0];
const KING_SHIELD = 12;
const KING_OPEN_FILE_PENALTY = -22;
const TEMPO = 10;

/**
 * Scratch buffers, reused across calls — evaluation runs at every leaf of the search.
 *
 * Both the highest and the lowest pawn per file are needed, and which one is "most advanced"
 * depends on colour. A passed-pawn test asks whether *any* enemy pawn stands ahead, so a White
 * pawn is blocked by the highest Black pawn on the file and a Black pawn by the lowest White
 * one — keeping only one extreme per file gets the wrong answer half the time.
 */
const pawnFiles = [new Int8Array(8), new Int8Array(8)];
const pawnMax = [new Int8Array(8), new Int8Array(8)];
const pawnMin = [new Int8Array(8), new Int8Array(8)];

/**
 * Full evaluation. Positive means the side to move is better.
 *
 * Everything is accumulated as a White-positive score and flipped once at the end, which keeps
 * every term readable in the same direction rather than each one needing a sign.
 */
export function evaluate(pos: Position): number {
  let mg = 0, eg = 0, phase = 0;

  for (let c = 0; c < 2; c++) {
    pawnFiles[c].fill(0);
    pawnMax[c].fill(-1);
    pawnMin[c].fill(8);
  }
  for (const color of [WHITE, BLACK] as Color[]) {
    for (const sq of pos.pieces[color]) {
      if (pieceType(pos.board[sq]) !== PAWN) continue;
      const f = fileOf(sq), r = rankOf(sq);
      pawnFiles[color][f]++;
      if (r > pawnMax[color][f]) pawnMax[color][f] = r;
      if (r < pawnMin[color][f]) pawnMin[color][f] = r;
    }
  }

  for (const color of [WHITE, BLACK] as Color[]) {
    const sign = color === WHITE ? 1 : -1;
    const them = (color ^ 1) as Color;
    let bishops = 0;

    for (const sq of pos.pieces[color]) {
      const type = pieceType(pos.board[sq]);
      const idx = color === WHITE ? to64(sq) : to64(sq) ^ 56;
      const f = fileOf(sq), r = rankOf(sq);

      phase += PHASE_WEIGHT[type];
      mg += sign * (MG_VALUE[type] + PST_MG[type][idx]);
      eg += sign * (EG_VALUE[type] + PST_EG[type][idx]);

      switch (type) {
        case PAWN: {
          if (pawnFiles[color][f] > 1) {
            mg += sign * DOUBLED_PAWN_MG; eg += sign * DOUBLED_PAWN_EG;
          }
          const left = f > 0 ? pawnFiles[color][f - 1] : 0;
          const right = f < 7 ? pawnFiles[color][f + 1] : 0;
          if (!left && !right) { mg += sign * ISOLATED_PAWN_MG; eg += sign * ISOLATED_PAWN_EG; }
          if (isPassed(color, f, r)) {
            const adv = color === WHITE ? r : 7 - r;
            mg += sign * PASSED_MG[adv]; eg += sign * PASSED_EG[adv];
          }
          break;
        }
        case BISHOP:
          bishops++;
          mg += sign * MOBILITY_MG[BISHOP] * slideCount(pos, sq, BISHOP_OFFSETS);
          eg += sign * MOBILITY_EG[BISHOP] * slideCount(pos, sq, BISHOP_OFFSETS);
          break;
        case KNIGHT: {
          const m = stepCount(pos, sq, KNIGHT_OFFSETS, color);
          mg += sign * MOBILITY_MG[KNIGHT] * m;
          eg += sign * MOBILITY_EG[KNIGHT] * m;
          break;
        }
        case ROOK: {
          const m = slideCount(pos, sq, ROOK_OFFSETS);
          mg += sign * MOBILITY_MG[ROOK] * m;
          eg += sign * MOBILITY_EG[ROOK] * m;
          if (!pawnFiles[color][f]) {
            mg += sign * (pawnFiles[them][f] ? ROOK_SEMI_OPEN : ROOK_OPEN_FILE);
          }
          // A rook on the seventh cuts the enemy king off and eats the pawn chain behind it.
          if (r === (color === WHITE ? 6 : 1)) mg += sign * ROOK_ON_SEVENTH;
          break;
        }
        case QUEEN: {
          const m = slideCount(pos, sq, KING_OFFSETS);
          mg += sign * MOBILITY_MG[QUEEN] * m;
          eg += sign * MOBILITY_EG[QUEEN] * m;
          break;
        }
      }
    }

    if (bishops >= 2) { mg += sign * BISHOP_PAIR_MG; eg += sign * BISHOP_PAIR_EG; }

    // King safety is a middlegame term only — in the endgame the king wants to be out.
    mg += sign * kingSafety(pos, color);
  }

  // Blend. `phase` counts down from 24; clamp because promotions can push it back up.
  const p = Math.max(0, Math.min(TOTAL_PHASE, phase));
  let score = (mg * p + eg * (TOTAL_PHASE - p)) / TOTAL_PHASE;

  score = pos.turn === WHITE ? score : -score;
  return Math.round(score) + TEMPO;
}

/** No enemy pawn on this file or either neighbour stands anywhere ahead of it. */
function isPassed(color: Color, f: number, r: number): boolean {
  const them = (color ^ 1) as Color;
  for (let df = -1; df <= 1; df++) {
    const nf = f + df;
    if (nf < 0 || nf > 7) continue;
    if (!pawnFiles[them][nf]) continue;
    // "Ahead" is up the board for White and down it for Black, so each side asks the opposite
    // extreme of the enemy's pawns on that file.
    if (color === WHITE ? pawnMax[them][nf] > r : pawnMin[them][nf] < r) return false;
  }
  return true;
}

/** Squares a slider reaches, counting the blocker it runs into. */
function slideCount(pos: Position, from: number, offsets: number[]): number {
  let n = 0;
  for (let i = 0; i < offsets.length; i++) {
    const off = offsets[i];
    for (let to = from + off; onBoard(to); to += off) {
      n++;
      if (pos.board[to]) break;
    }
  }
  return n;
}

/** Squares a stepper reaches that are not occupied by its own side. */
function stepCount(pos: Position, from: number, offsets: number[], color: Color): number {
  let n = 0;
  for (let i = 0; i < offsets.length; i++) {
    const to = from + offsets[i];
    if (!onBoard(to)) continue;
    const p = pos.board[to];
    if (!p || pieceColor(p) !== color) n++;
  }
  return n;
}

/**
 * King safety: how intact the pawns in front of the king are, and whether the files around it
 * are open. Deliberately cheap — a full attack-unit table costs more than it is worth against
 * an opponent whose job is to be fun rather than to win a computer match.
 */
function kingSafety(pos: Position, color: Color): number {
  const k = pos.kings[color];
  if (k < 0) return 0;
  const kf = fileOf(k), kr = rankOf(k);
  let score = 0;

  for (let df = -1; df <= 1; df++) {
    const f = kf + df;
    if (f < 0 || f > 7) continue;
    if (!pawnFiles[color][f]) {
      score += KING_OPEN_FILE_PENALTY;
      continue;
    }
    // The shielding pawn is the one closest to our own back rank on that file.
    const shield = color === WHITE ? pawnMin[color][f] : pawnMax[color][f];
    const distance = color === WHITE ? shield - kr : kr - shield;
    // Directly in front is worth full value, one square further is worth half, beyond that the
    // pawn has left and is no longer a shield at all.
    if (distance === 1) score += KING_SHIELD;
    else if (distance === 2) score += KING_SHIELD >> 1;
  }
  return score;
}

/**
 * Material only, for the "am I winning?" readout and for drawishness checks. Positive is White.
 */
export function materialScore(pos: Position): number {
  let score = 0;
  for (const color of [WHITE, BLACK] as Color[]) {
    const sign = color === WHITE ? 1 : -1;
    for (const sq of pos.pieces[color]) score += sign * MG_VALUE[pieceType(pos.board[sq])];
  }
  return score;
}

export { PST_MG, PST_EG };
