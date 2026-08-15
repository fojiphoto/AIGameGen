/**
 * A small opening book.
 *
 * Not for strength — the search plays perfectly reasonable opening moves on its own. It is for
 * *variety*. A deterministic engine plays the identical first eight moves in every single game,
 * and the second game against it feels like the first one repeating. Twenty lines of book turn
 * that into an opponent that sometimes plays the Italian and sometimes the Sicilian, which is
 * the difference between an opponent and a puzzle.
 *
 * Stored as move sequences in SAN rather than as a hashed position table: at this size a table
 * is more machinery than the data deserves, and a line written out reads as chess.
 */

import { Position, Move, startPosition, toFen, fromSan, toSan } from '../core/index.js';

/** Each entry is a complete line from the initial position. */
const LINES: string[][] = [
  // 1.e4 — open games
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'],   // Ruy Lopez
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4'],   // Italian
  ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3', 'Bb4'], // Scotch
  ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nf3', 'Nxe4', 'd4', 'd5'],   // Petroff
  ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'],   // Najdorf
  ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'g6', 'Nc3', 'Bg7'],  // Accelerated Dragon
  ['e4', 'c5', 'Nc3', 'Nc6', 'g3', 'g6', 'Bg2', 'Bg7', 'd3', 'd6'],      // Closed Sicilian
  ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4', 'e5', 'c5', 'a3', 'Bxc3+'],     // French Winawer
  ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3', 'Bg6'],  // Caro-Kann
  ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'Nf6', 'Nf3', 'c6'],  // Scandinavian
  ['e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'Nf3', 'Bg4', 'Be2', 'e6'],     // Alekhine
  ['e4', 'g6', 'd4', 'Bg7', 'Nc3', 'd6', 'Nf3', 'Nf6', 'Be2', 'O-O'],    // Modern

  // 1.d4 — closed games
  ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O'],     // Queen's Gambit Declined
  ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4', 'a4', 'Bf5'],    // Slav
  ['d4', 'd5', 'c4', 'dxc4', 'Nf3', 'Nf6', 'e3', 'e6', 'Bxc4', 'c5'],    // QGA
  ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O'],     // King's Indian
  ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O', 'Bd3', 'd5'],     // Nimzo-Indian
  ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6', 'g3', 'Ba6', 'b3', 'Bb4+'],     // Queen's Indian
  ['d4', 'f5', 'g3', 'Nf6', 'Bg2', 'g6', 'Nf3', 'Bg7', 'O-O', 'O-O'],    // Dutch
  ['d4', 'd5', 'Nf3', 'Nf6', 'e3', 'e6', 'Bd3', 'c5', 'c3', 'Nc6'],      // Colle

  // flank
  ['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'e6', 'O-O', 'Be7', 'd3', 'O-O'],    // Réti
  ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'g3', 'd5', 'cxd5', 'Nxd5'],  // English
];

/**
 * Positions to book moves, keyed by the first four FEN fields — the parts that define a
 * position. The move counters are excluded deliberately, so a transposition into a booked
 * position still finds it.
 */
type BookEntry = { san: string; weight: number };
const BOOK = new Map<string, BookEntry[]>();

let built = false;

function positionKey(pos: Position): string {
  return toFen(pos).split(' ').slice(0, 4).join(' ');
}

function build(): void {
  if (built) return;
  built = true;
  for (const line of LINES) {
    const pos = startPosition();
    for (const san of line) {
      const move = fromSan(pos, san);
      // A typo in a line would otherwise fail silently and quietly shorten the book.
      if (!move) {
        if (typeof console !== 'undefined') console.warn(`book: illegal move "${san}" in a line`);
        break;
      }
      const key = positionKey(pos);
      const entry = BOOK.get(key) ?? [];
      const existing = entry.find((e) => e.san === san);
      // Repeating a move across lines makes it likelier — mainlines end up more common than
      // sidelines without anyone hand-assigning weights.
      if (existing) existing.weight++;
      else entry.push({ san, weight: 1 });
      BOOK.set(key, entry);
      pos.makeMove(move);
    }
  }
}

/**
 * A book move for this position, or null.
 *
 * @param random 0..1, supplied by the caller so the engine's determinism stays in one place.
 * @param spread 0 keeps to the most-played move, 1 samples the weights fully. Lower difficulty
 *   levels spread wider, which quietly gives them more varied and slightly worse openings.
 */
export function bookMove(pos: Position, random: number, spread = 1): Move | null {
  build();
  const entries = BOOK.get(positionKey(pos));
  if (!entries || entries.length === 0) return null;

  let pick: BookEntry;
  if (spread <= 0) {
    pick = entries.reduce((a, b) => (b.weight > a.weight ? b : a));
  } else {
    const weights = entries.map((e) => Math.pow(e.weight, 1 / Math.max(0.05, spread)));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = random * total;
    let i = 0;
    while (i < entries.length - 1 && r > weights[i]) { r -= weights[i]; i++; }
    pick = entries[i];
  }
  return fromSan(pos, pick.san);
}

/** The opening's name, if the game so far is still in a known line. Shown in the HUD. */
const OPENING_NAMES: [string[], string][] = [
  [['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], 'Ruy Lopez'],
  [['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], 'Italian Game'],
  [['e4', 'e5', 'Nf3', 'Nc6', 'd4'], 'Scotch Game'],
  [['e4', 'e5', 'Nf3', 'Nf6'], 'Petroff Defence'],
  [['e4', 'e5', 'Nf3'], "King's Knight Opening"],
  [['e4', 'e5', 'f4'], "King's Gambit"],
  [['e4', 'e5'], 'Open Game'],
  [['e4', 'c5', 'Nf3', 'd6'], 'Sicilian, Najdorf territory'],
  [['e4', 'c5'], 'Sicilian Defence'],
  [['e4', 'e6'], 'French Defence'],
  [['e4', 'c6'], 'Caro-Kann Defence'],
  [['e4', 'd5'], 'Scandinavian Defence'],
  [['e4', 'Nf6'], 'Alekhine Defence'],
  [['e4', 'g6'], 'Modern Defence'],
  [['e4', 'd6'], 'Pirc Defence'],
  [['d4', 'd5', 'c4', 'e6'], "Queen's Gambit Declined"],
  [['d4', 'd5', 'c4', 'c6'], 'Slav Defence'],
  [['d4', 'd5', 'c4', 'dxc4'], "Queen's Gambit Accepted"],
  [['d4', 'd5', 'c4'], "Queen's Gambit"],
  [['d4', 'Nf6', 'c4', 'g6'], "King's Indian Defence"],
  [['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'], 'Nimzo-Indian Defence'],
  [['d4', 'Nf6', 'c4', 'e6'], 'Indian Defence'],
  [['d4', 'f5'], 'Dutch Defence'],
  [['d4', 'd5'], 'Closed Game'],
  [['d4', 'Nf6'], 'Indian Game'],
  [['Nf3'], 'Réti Opening'],
  [['c4'], 'English Opening'],
  [['b3'], 'Larsen Attack'],
  [['g3'], "King's Fianchetto"],
  [['f4'], 'Bird Opening'],
];

export function openingName(sanMoves: string[]): string | null {
  if (sanMoves.length === 0) return null;
  let best: string | null = null;
  let bestLength = 0;
  for (const [line, name] of OPENING_NAMES) {
    if (line.length > sanMoves.length || line.length <= bestLength) continue;
    let ok = true;
    for (let i = 0; i < line.length; i++) {
      if (sanMoves[i] !== line[i]) { ok = false; break; }
    }
    if (ok) { best = name; bestLength = line.length; }
  }
  return best;
}

/** Exposed for the test suite, which verifies every line in the book is legal chess. */
export function bookLines(): string[][] { return LINES; }
export { toSan };
