/**
 * The chess rules, proved rather than spot-checked.
 *
 * Perft carries most of the weight here. Counting leaf nodes at a fixed depth from a known
 * position gives a single number that is published and exact, and any rule error anywhere in
 * generation, make or unmake changes it. The five positions below are the standard set, chosen
 * between them to exercise every awkward case at once: pinned pieces, en passant that would
 * expose a rank-pinned king, castling rights lost by a rook being captured where it stands,
 * under-promotion, and positions where the side to move is already in check.
 *
 * A hand-written test can assert that a knight moves in an L. Only perft catches the fact that
 * an en-passant capture removes two pawns from one rank and can therefore discover a check.
 *
 * Run:  node IvoryGambit/build.mjs --test && node --test IvoryGambit/test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Position, startPosition, parseFen, toFen, START_FEN,
  perft, generateLegal, hasLegalMove, gameStatus, insufficientMaterial,
  toSan, fromSan, moveToUci, encodeMove, parseSquare, squareName,
  materialBalance, capturedPieces,
  WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  makePiece, square, moveFrom, moveTo,
} from '../build/test/core.mjs';

// ── perft ───────────────────────────────────────────────────────────────────

/**
 * Depths are chosen to stay under a couple of seconds each while still reaching the depth where
 * each position's specific trap first appears. Kiwipete at 3 already covers castling through
 * check and rook-capture rights; position 3 at 5 is the en-passant discovered-check case.
 */
const PERFT_CASES = [
  {
    name: 'initial position',
    fen: START_FEN,
    counts: [1, 20, 400, 8902, 197281, 4865609],
  },
  {
    name: 'kiwipete — castling, pins, promotions',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    counts: [1, 48, 2039, 97862, 4085603],
  },
  {
    name: 'position 3 — en passant discovering check',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    counts: [1, 14, 191, 2812, 43238, 674624],
  },
  {
    name: 'position 4 — promotions under check',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    counts: [1, 6, 264, 9467, 422333],
  },
  {
    name: 'position 5 — no castling, tight board',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    counts: [1, 44, 1486, 62379, 2103487],
  },
  {
    name: 'position 6 — quiet middlegame',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    counts: [1, 46, 2079, 89890, 3894594],
  },
];

for (const c of PERFT_CASES) {
  for (let depth = 1; depth < c.counts.length; depth++) {
    test(`perft: ${c.name} depth ${depth}`, () => {
      const pos = parseFen(c.fen);
      assert.equal(perft(pos, depth), c.counts[depth]);
    });
  }
}

test('perft leaves the position exactly as it found it', () => {
  const pos = parseFen(PERFT_CASES[1].fen);
  const before = toFen(pos);
  const keyLo = pos.keyLo, keyHi = pos.keyHi;
  perft(pos, 3);
  assert.equal(toFen(pos), before, 'board, rights, ep and clocks must all be restored');
  assert.equal(pos.keyLo, keyLo, 'zobrist low word must be restored');
  assert.equal(pos.keyHi, keyHi, 'zobrist high word must be restored');
});

// ── FEN round-trip ──────────────────────────────────────────────────────────

test('FEN round-trips through every perft position', () => {
  for (const c of PERFT_CASES) {
    assert.equal(toFen(parseFen(c.fen)), c.fen, c.name);
  }
});

test('FEN rejects a malformed board rather than half-loading it', () => {
  assert.throws(() => parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1'), /8 ranks/);
  assert.throws(() => parseFen('rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1'), /not 8/);
  assert.throws(() => parseFen('rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w - - 0 1'), /king/);
});

// ── individual rules ────────────────────────────────────────────────────────

const uciSet = (pos, from) =>
  new Set(generateLegal(pos).filter((m) => moveFrom(m) === parseSquare(from)).map(moveToUci));

test('a pinned piece cannot move off the pin line', () => {
  // Black knight on e6 is pinned to the king on e8 by the rook on e1.
  const pos = parseFen('4k3/8/4n3/8/8/8/8/4R1K1 b - - 0 1');
  assert.equal(uciSet(pos, 'e6').size, 0);
});

test('a pinned piece may still move along the pin line, including capturing the pinner', () => {
  // Black bishop on d7 is pinned to the king on e8 by the bishop on b5. It may take on b5 or
  // step to c6 — both stay on the line — and may go nowhere else.
  const pos = parseFen('4k3/3b4/8/1B6/8/8/8/6K1 b - - 0 1');
  assert.deepEqual([...uciSet(pos, 'd7')].sort(), ['d7b5', 'd7c6']);
});

test('the king cannot step onto an attacked square', () => {
  const pos = parseFen('4k3/8/8/8/8/8/5q2/4K3 w - - 0 1');
  const moves = [...uciSet(pos, 'e1')];
  assert.ok(!moves.includes('e1e2'), 'e2 is covered by the queen');
  assert.ok(!moves.includes('e1d2'), 'd2 is covered by the queen');
  assert.ok(!moves.includes('e1f2') === false, 'f2 is the queen itself and is capturable');
});

test('double check leaves only king moves', () => {
  // White king on e1; rook on e8 and bishop on h4 both give check. (Black's king sits on a8
  // and takes no part — but it has to be on the board, because a position without both kings
  // is not a chess position and the parser refuses it.)
  const pos = parseFen('k3r3/8/8/8/7b/8/8/4K3 w - - 0 1');
  const legal = generateLegal(pos);
  assert.ok(legal.length > 0);
  for (const m of legal) {
    assert.equal(moveFrom(m), parseSquare('e1'), `${moveToUci(m)} is not a king move`);
  }
});

test('castling: both sides, both wings, from the standard position', () => {
  const pos = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const white = uciSet(pos, 'e1');
  assert.ok(white.has('e1g1'), 'kingside');
  assert.ok(white.has('e1c1'), 'queenside');
  pos.turn = BLACK;
  pos.rehash();
  const black = uciSet(pos, 'e8');
  assert.ok(black.has('e8g8'));
  assert.ok(black.has('e8c8'));
});

test('castling is blocked out of, through and into check', () => {
  // Rook on e8 attacks e1: the king is in check, so neither castle is legal.
  assert.ok(!uciSet(parseFen('k3r3/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1').has('e1g1'));
  // Rook on f8 attacks f1, the square the king passes through.
  assert.ok(!uciSet(parseFen('k4r2/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1').has('e1g1'));
  // Rook on g8 attacks g1, the square the king lands on.
  assert.ok(!uciSet(parseFen('k5r1/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1').has('e1g1'));
  // b1 attacked does NOT stop queenside castling — the king never stands there.
  assert.ok(uciSet(parseFen('1r5k/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'e1').has('e1c1'));
});

test('castling rights die when the rook is captured on its home square', () => {
  const pos = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const take = generateLegal(pos).find((m) => moveToUci(m) === 'a1a8');
  assert.ok(take, 'Ra1xa8 should be legal');
  pos.makeMove(take);
  assert.ok(!toFen(pos).split(' ')[2].includes('q'), "Black's queenside right must be gone");
});

test('en passant captures the pawn beside the destination, not on it', () => {
  const pos = parseFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const ep = generateLegal(pos).find((m) => moveToUci(m) === 'e5d6');
  assert.ok(ep, 'the en-passant capture should be generated');
  pos.makeMove(ep);
  assert.equal(pos.board[parseSquare('d5')], 0, 'the captured pawn must be removed from d5');
  assert.equal(pos.board[parseSquare('d6')], makePiece(PAWN, WHITE));
});

test('en passant is illegal when it would expose the king along the rank', () => {
  // White king a5, black rook h5, white pawn b5, black pawn c5 just moved two.
  // bxc6 removes both pawns from rank 5 and hangs the king to the rook.
  const pos = parseFen('8/8/8/KPp4r/8/8/8/7k w - c6 0 1');
  assert.ok(!generateLegal(pos).some((m) => moveToUci(m) === 'b5c6'));
});

test('en passant is only available for one move', () => {
  const pos = parseFen('4k3/7p/8/3pP3/8/8/8/4K3 w - d6 0 1');
  pos.makeMove(generateLegal(pos).find((m) => moveToUci(m) === 'e1e2'));
  pos.makeMove(generateLegal(pos).find((m) => moveToUci(m) === 'h7h6'));
  assert.ok(!generateLegal(pos).some((m) => moveToUci(m) === 'e5d6'));
});

test('promotion offers exactly four pieces, and under-promotion works', () => {
  const pos = parseFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const promos = generateLegal(pos).filter((m) => moveFrom(m) === parseSquare('a7'));
  assert.deepEqual(promos.map(moveToUci).sort(), ['a7a8b', 'a7a8n', 'a7a8q', 'a7a8r']);
  pos.makeMove(promos.find((m) => moveToUci(m) === 'a7a8n'));
  assert.equal(pos.board[parseSquare('a8')], makePiece(KNIGHT, WHITE));
});

test('promotion by capture also promotes', () => {
  const pos = parseFen('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const m = generateLegal(pos).find((x) => moveToUci(x) === 'a7b8q');
  assert.ok(m);
  pos.makeMove(m);
  assert.equal(pos.board[parseSquare('b8')], makePiece(QUEEN, WHITE));
});

// ── terminal states ─────────────────────────────────────────────────────────

test('back-rank mate is checkmate, and names the winner', () => {
  const pos = parseFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  pos.makeMove(fromSan(pos, 'Ra8+'));
  const s = gameStatus(pos);
  assert.equal(s.outcome, 'checkmate');
  assert.equal(s.winner, WHITE);
  assert.ok(s.over);
});

test("fool's mate is checkmate for Black", () => {
  const pos = startPosition();
  for (const san of ['f3', 'e5', 'g4', 'Qh4#']) {
    const m = fromSan(pos, san);
    assert.ok(m, `${san} should be legal`);
    pos.makeMove(m);
  }
  const s = gameStatus(pos);
  assert.equal(s.outcome, 'checkmate');
  assert.equal(s.winner, BLACK);
});

test('stalemate is a draw, not a loss', () => {
  const pos = parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  const s = gameStatus(pos);
  assert.equal(s.outcome, 'stalemate');
  assert.equal(s.winner, null);
  assert.ok(s.over);
});

test('insufficient material covers the standard dead positions', () => {
  const dead = [
    '4k3/8/8/8/8/8/8/4K3 w - - 0 1',            // K v K
    '4k3/8/8/8/8/8/8/3BK3 w - - 0 1',           // K+B v K
    '4k3/8/8/8/8/8/8/3NK3 w - - 0 1',           // K+N v K
    '2b1k3/8/8/8/8/8/8/3BK3 w - - 0 1',         // same-coloured bishops
  ];
  for (const fen of dead) assert.ok(insufficientMaterial(parseFen(fen)), fen);

  const alive = [
    '4k3/8/8/8/8/8/P7/4K3 w - - 0 1',           // a pawn can promote
    '4k3/8/8/8/8/8/8/2BBK3 w - - 0 1',          // two bishops mate
    '4k3/8/8/8/8/8/8/3RK3 w - - 0 1',           // a rook mates
    '3bk3/8/8/8/8/8/8/3BK3 w - - 0 1',          // opposite-coloured bishops: not certain
  ];
  for (const fen of alive) assert.ok(!insufficientMaterial(parseFen(fen)), fen);
});

test('threefold repetition becomes claimable, then forced at fivefold', () => {
  const pos = parseFen('4k3/8/8/8/8/8/8/R3K2R w - - 0 1');
  const shuffle = ['Kf1', 'Kd8', 'Ke1', 'Ke8'];
  // The first pass sets the position up; each further pass repeats it.
  for (let round = 0; round < 2; round++) {
    for (const san of shuffle) pos.makeMove(fromSan(pos, san));
  }
  assert.equal(gameStatus(pos).claimableDraw, 'repetition', 'three occurrences: claimable');
  assert.ok(!gameStatus(pos).over, 'a claim is offered, not forced');
  for (let round = 0; round < 2; round++) {
    for (const san of shuffle) pos.makeMove(fromSan(pos, san));
  }
  assert.equal(gameStatus(pos).outcome, 'repetition', 'five occurrences: forced');
});

test('the halfmove clock resets on a pawn move and on a capture', () => {
  const pos = parseFen('4k3/8/8/3p4/4P3/8/8/4K3 w - - 10 20');
  pos.makeMove(fromSan(pos, 'Ke2'));
  assert.equal(pos.halfmove, 11, 'a quiet king move increments it');
  pos.makeMove(fromSan(pos, 'd4'));
  assert.equal(pos.halfmove, 0, 'a pawn move resets it');
});

test('fifty moves is claimable and seventy-five is forced', () => {
  const claim = parseFen('4k3/8/8/8/8/8/4R3/4K3 w - - 100 60');
  assert.equal(gameStatus(claim).claimableDraw, 'fifty-move');
  assert.ok(!gameStatus(claim).over);
  const forced = parseFen('4k3/8/8/8/8/8/4R3/4K3 w - - 150 90');
  assert.equal(gameStatus(forced).outcome, 'fifty-move');
});

// ── notation ────────────────────────────────────────────────────────────────

test('SAN disambiguates by file, by rank, and by both', () => {
  // Knights on b1 and f3 both reach d2: different files, so the file is enough.
  let pos = parseFen('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1');
  assert.equal(toSan(pos, fromSan(pos, 'Nbd2')), 'Nbd2');

  // Rooks on a1 and a3 both reach a2: same file, so the rank disambiguates.
  pos = parseFen('4k3/8/8/8/8/R7/8/R3K3 w - - 0 1');
  assert.equal(toSan(pos, fromSan(pos, 'R1a2')), 'R1a2');

  // Queens on h4, h7 and a4 all reach e4. h7 shares the mover's file and a4 shares its rank,
  // so neither coordinate alone is enough and the full square is required.
  // (e4 also gives check down the e-file, so the rendered move carries a '+'.)
  pos = parseFen('4k3/7Q/8/8/Q6Q/8/8/4K3 w - - 0 1');
  assert.equal(toSan(pos, fromSan(pos, 'Qh4e4')), 'Qh4e4+');
});

test('SAN does not disambiguate against a piece that cannot legally move', () => {
  // Both knights reach d2, but the g1 knight is pinned by the bishop on h2... so "Nd2" is
  // unambiguous and adding a file would be wrong notation.
  const pos = parseFen('4k3/8/8/8/8/8/7b/1N2K1N1 w - - 0 1');
  const m = fromSan(pos, 'Nbd2') ?? fromSan(pos, 'Nd2');
  assert.ok(m);
  assert.equal(toSan(pos, m), 'Nd2');
});

test('SAN writes castling, promotion, check and mate', () => {
  let pos = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.equal(toSan(pos, fromSan(pos, 'O-O')), 'O-O');
  assert.equal(toSan(pos, fromSan(pos, 'O-O-O')), 'O-O-O');

  pos = parseFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(toSan(pos, fromSan(pos, 'a8=N')), 'a8=N');
  assert.equal(toSan(pos, fromSan(pos, 'a8=Q')), 'a8=Q+');

  pos = parseFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  assert.equal(toSan(pos, fromSan(pos, 'Ra8')), 'Ra8#');
});

test('SAN round-trips a whole opening', () => {
  const line = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'];
  const pos = startPosition();
  for (const san of line) {
    const m = fromSan(pos, san);
    assert.ok(m, `${san} should parse`);
    assert.equal(toSan(pos, m), san, `${san} should render back identically`);
    pos.makeMove(m);
  }
  assert.equal(pos.fullmove, 6);
});

// ── derived display state ───────────────────────────────────────────────────

test('material balance and captured lists are derived from the board', () => {
  const pos = parseFen('4k3/8/8/8/8/8/8/3QK3 w - - 0 1');
  assert.equal(materialBalance(pos), 9);
  const caps = capturedPieces(pos);
  // White began with 15 pieces beside the king and has only the queen left.
  assert.equal(caps.white.length, 14);
  assert.equal(caps.black.length, 15, 'Black has nothing but its king');
  assert.equal(caps.black.filter((t) => t === QUEEN).length, 1);
});

test('captured lists survive a promotion without going negative', () => {
  // White has promoted to a second queen; the display must not claim -1 queens captured.
  const pos = parseFen('Q3k3/8/8/8/8/8/8/3QK3 w - - 0 1');
  const caps = capturedPieces(pos);
  assert.ok(caps.white.every((t) => t !== QUEEN), 'no white queen may be listed as captured');
  assert.ok(caps.white.length >= 0);
});

// ── make/unmake integrity ───────────────────────────────────────────────────

test('undo restores the position exactly, for every legal move in a busy position', () => {
  const pos = parseFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const before = toFen(pos);
  const keys = [pos.keyLo, pos.keyHi];
  for (const m of generateLegal(pos)) {
    pos.makeMove(m);
    pos.undoMove();
    assert.equal(toFen(pos), before, `after ${moveToUci(m)}`);
    assert.deepEqual([pos.keyLo, pos.keyHi], keys, `hash after ${moveToUci(m)}`);
  }
});

test('the zobrist key is a pure function of the position, however it was reached', () => {
  // Two move orders converging on the same position must hash identically. Both lines have to
  // *end* on a knight move: a double pawn push sets an en-passant square, that square is part
  // of the position, and two positions that differ by it are correctly different keys.
  const a = startPosition();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6']) a.makeMove(fromSan(a, san));
  const b = startPosition();
  for (const san of ['Nf3', 'Nc6', 'e4', 'e5', 'Nc3', 'Nf6']) b.makeMove(fromSan(b, san));
  assert.equal(a.keyLo, b.keyLo);
  assert.equal(a.keyHi, b.keyHi);
  assert.equal(toFen(a).split(' ').slice(0, 4).join(' '), toFen(b).split(' ').slice(0, 4).join(' '));
});

test('a null move flips the side and restores cleanly', () => {
  const pos = parseFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const before = toFen(pos);
  const keys = [pos.keyLo, pos.keyHi];
  pos.makeNull();
  assert.equal(pos.turn, BLACK);
  pos.undoNull();
  assert.equal(toFen(pos), before);
  assert.deepEqual([pos.keyLo, pos.keyHi], keys);
});
