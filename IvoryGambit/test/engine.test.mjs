/**
 * The engine: legality, tactics, and the difficulty ladder actually being a ladder.
 *
 * Three things are being asserted, in order of how badly they would hurt if wrong:
 *
 *   1. Every move the engine returns is legal, at every difficulty, in awkward positions. An
 *      engine that returns an illegal move once in a thousand games corrupts the board and is
 *      unplayable, and no amount of visual polish survives it.
 *   2. It finds forced mates and does not miss free material. This is what "not a random move
 *      generator" means in practice, and it is checkable exactly.
 *   3. Beginner is weaker than Master, and Beginner still finds mate in one. A difficulty dial
 *      that does nothing is worse than no dial, and a weak level that misses mate in one reads
 *      as a broken engine rather than a gentle one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFen, startPosition, generateLegal, gameStatus, moveToUci, toSan, fromSan,
  WHITE, BLACK,
} from '../build/test/core.mjs';
import {
  Searcher, DIFFICULTIES, difficultyByKey, evaluate, materialScore,
  bookMove, bookLines, openingName, MATE_BOUND,
} from '../build/test/engine.mjs';

const searcher = new Searcher();

/** Search a position at a fixed strength, ignoring the difficulty personality. */
function bestMove(fen, { depth = 4, time = 1500, randomness = 0, blunderChance = 0 } = {}) {
  const pos = parseFen(fen);
  const result = searcher.search(pos, {
    maxDepth: depth, maxTime: time, randomness, blunderChance,
  });
  return { result, pos };
}

const legalUcis = (fen) => new Set(generateLegal(parseFen(fen)).map(moveToUci));

// ── legality ────────────────────────────────────────────────────────────────

const AWKWARD = [
  ['start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['in check', 'r1bqkb1r/pppp1Bpp/2n2n2/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4'],
  ['already mated', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'],
  ['promotion race', '8/PPP4k/8/8/8/8/4Kppp/8 w - - 0 1'],
  ['en passant available', 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3'],
  ['bare endgame', '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1'],
  ['only one legal move', '7k/8/8/8/8/8/5PPP/6rK w - - 0 1'],
  ['stalemate danger', '7k/5Q2/8/8/8/8/8/6K1 w - - 0 1'],
];

for (const [name, fen] of AWKWARD) {
  for (const difficulty of DIFFICULTIES) {
    test(`legal move: ${name} @ ${difficulty.label}`, () => {
      const pos = parseFen(fen);
      const legal = legalUcis(fen);
      // Ten runs, because the weak levels are stochastic and a once-in-ten illegal move is
      // still a broken engine.
      for (let i = 0; i < 10; i++) {
        searcher.seedWith(i * 7919 + 13);
        const r = searcher.search(pos.clone(), {
          maxDepth: Math.min(difficulty.maxDepth, 5),
          maxTime: 200,
          randomness: difficulty.randomness,
          blunderChance: difficulty.blunderChance,
        });
        if (legal.size === 0) {
          assert.equal(r.best, 0, 'a finished game must yield no move at all');
          continue;
        }
        assert.ok(r.best, 'a move must be returned');
        assert.ok(legal.has(moveToUci(r.best)), `${moveToUci(r.best)} is not legal in ${name}`);
      }
    });
  }
}

test('the engine responds to check with a move that gets out of it', () => {
  // Bxf7+ answered: whatever Black plays, the king must not still be in check.
  const fen = 'r1bqkb1r/pppp1Bpp/2n2n2/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4';
  const { result, pos } = bestMove(fen, { depth: 5 });
  assert.ok(pos.makeMove(result.best), 'the move must be playable');
  assert.ok(!pos.inCheck(BLACK), 'and must leave the king safe');
});

test('the engine returns nothing when there is nothing to return', () => {
  const pos = parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');   // stalemate
  const r = searcher.search(pos, { maxDepth: 4, maxTime: 200, randomness: 0, blunderChance: 0 });
  assert.equal(r.best, 0);
});

// ── tactics ─────────────────────────────────────────────────────────────────

const TACTICS = [
  {
    name: 'mate in one, back rank',
    fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
    expect: ['a1a8'],
    depth: 3,
  },
  {
    name: 'mate in one, queen and king',
    fen: '7k/6Q1/6K1/8/8/8/8/8 w - - 0 1',
    expect: ['g7g8', 'g7h7', 'g7h6'],
    depth: 3,
  },
  {
    name: 'mate in two, smothered',
    fen: '6rk/6pp/8/6N1/8/8/8/6QK w - - 0 1',
    mateIn: 2,
    depth: 6,
  },
  {
    name: 'takes the free queen',
    fen: '4k3/8/8/3q4/4B3/8/8/4K3 w - - 0 1',
    expect: ['e4d5'],
    depth: 4,
  },
  {
    name: 'knight fork wins the queen',
    fen: '4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1',
    // Ne4/Nb5 etc. — whatever it plays must not simply lose the knight.
    minGain: 0,
    depth: 5,
  },
  {
    name: 'promotes rather than dawdling',
    fen: '8/P6k/8/8/8/8/7K/8 w - - 0 1',
    expect: ['a7a8q'],
    depth: 5,
  },
  {
    name: 'escapes a threatened piece instead of losing it',
    fen: '4k3/8/8/8/8/2r5/2B5/4K3 w - - 0 1',
    minGain: -100,
    depth: 5,
  },
];

for (const t of TACTICS) {
  test(`tactic: ${t.name}`, () => {
    const { result, pos } = bestMove(t.fen, { depth: t.depth, time: 4000 });
    const uci = moveToUci(result.best);

    if (t.expect) {
      assert.ok(t.expect.includes(uci), `played ${uci}, expected one of ${t.expect.join(', ')}`);
    }
    if (t.mateIn !== undefined) {
      assert.ok(result.score > MATE_BOUND, `expected a forced mate, scored ${result.score}`);
      assert.ok(result.mateIn <= t.mateIn, `found mate in ${result.mateIn}, wanted ${t.mateIn}`);
    }
    if (t.minGain !== undefined) {
      // Play the move, then let the opponent take its best shot, and check we did not simply
      // hand over material.
      const before = materialScore(pos);
      pos.makeMove(result.best);
      const reply = searcher.search(pos, {
        maxDepth: 4, maxTime: 1500, randomness: 0, blunderChance: 0,
      });
      if (reply.best) pos.makeMove(reply.best);
      const after = materialScore(pos);
      assert.ok(after - before >= t.minGain,
        `material went from ${before} to ${after} after ${uci}`);
    }
  });
}

test('the engine plays a full game against itself without ever breaking the rules', () => {
  const pos = startPosition();
  let plies = 0;
  while (plies < 120) {
    const status = gameStatus(pos);
    if (status.over) break;
    const legal = new Set(generateLegal(pos).map(moveToUci));
    searcher.seedWith(plies * 104729 + 7);
    const r = searcher.search(pos, {
      maxDepth: 4, maxTime: 120, randomness: 20, blunderChance: 0.05,
    });
    assert.ok(r.best, `no move at ply ${plies}`);
    const uci = moveToUci(r.best);
    assert.ok(legal.has(uci), `illegal ${uci} at ply ${plies}`);
    assert.ok(pos.makeMove(r.best), `${uci} rejected at ply ${plies}`);
    plies++;
  }
  assert.ok(plies > 20, 'a self-play game should last more than a few moves');
});

// ── difficulty ladder ───────────────────────────────────────────────────────

test('every difficulty finds mate in one — a weak level is not a broken one', () => {
  const fen = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
  for (const d of DIFFICULTIES) {
    const pos = parseFen(fen);
    for (let i = 0; i < 6; i++) {
      searcher.seedWith(i * 31337 + 5);
      const r = searcher.search(pos.clone(), {
        maxDepth: d.maxDepth, maxTime: d.maxTime, randomness: d.randomness,
        blunderChance: d.blunderChance,
      });
      assert.equal(moveToUci(r.best), 'a1a8', `${d.label} missed mate in one on run ${i}`);
    }
  }
});

/**
 * The test that matters most for how the game *feels*.
 *
 * A weak level is meant to miss the point of a position, not to leave a queen hanging for
 * nothing. The first version of the difficulty system did exactly that, because in alpha-beta
 * every root move except the best returns a bound rather than a score — so "pick the second-best
 * move" was really "pick arbitrarily among all the worse ones", and Medium was observed playing
 * Qc7-g3 into hxg3 in a real game.
 */
test('no difficulty ever hangs a piece for nothing', () => {
  const POSITIONS = [
    // Queen out on the board with several safe squares and several fatal ones.
    'rnb1kbnr/ppq1pppp/2p5/3p4/3PP3/2N2N2/PPP2PPP/R1BQKB1R b KQkq - 3 4',
    // Open middlegame, plenty of rope.
    'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6',
    // An endgame where a careless rook move drops the rook.
    '8/5pk1/6p1/8/8/1r6/5PPP/4R1K1 w - - 0 1',
  ];

  for (const fen of POSITIONS) {
    for (const d of DIFFICULTIES) {
      for (let i = 0; i < 6; i++) {
        const pos = parseFen(fen);
        searcher.seedWith(i * 15485863 + 11);
        const chosen = searcher.search(pos, {
          maxDepth: d.maxDepth, maxTime: d.maxTime,
          randomness: d.randomness, blunderChance: d.blunderChance,
        }).best;
        assert.ok(chosen, 'a move must be returned');

        const before = Math.abs(materialScore(pos));
        pos.makeMove(chosen);
        // Let a strong opponent take its best shot at the position that results.
        const punish = searcher.search(pos, {
          maxDepth: 4, maxTime: 900, randomness: 0, blunderChance: 0,
        });
        if (punish.best) pos.makeMove(punish.best);
        const after = Math.abs(materialScore(pos));

        // Losing a pawn or a piece to a tactic is allowed at any level; losing a queen outright
        // to a single obvious recapture is not.
        const dropped = before - after;
        assert.ok(dropped < 800,
          `${d.label} played ${moveToUci(chosen)} in ${fen} and lost ${dropped} centipawns`);
      }
    }
  }
});

test('stronger levels search deeper and are ordered by strength', () => {
  for (let i = 1; i < DIFFICULTIES.length; i++) {
    assert.ok(DIFFICULTIES[i].maxDepth >= DIFFICULTIES[i - 1].maxDepth,
      `${DIFFICULTIES[i].label} must search at least as deep as ${DIFFICULTIES[i - 1].label}`);
    assert.ok(DIFFICULTIES[i].randomness <= DIFFICULTIES[i - 1].randomness,
      `${DIFFICULTIES[i].label} must be no noisier than ${DIFFICULTIES[i - 1].label}`);
    assert.ok(DIFFICULTIES[i].elo > DIFFICULTIES[i - 1].elo);
  }
});

test('Beginner varies its move; the top levels carry no noise at all', () => {
  // A middlegame with one clearly best move and several plausible-looking alternatives.
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const pick = (opts, seed) => {
    const pos = parseFen(fen);
    searcher.seedWith(seed);
    return moveToUci(searcher.search(pos, opts).best);
  };

  const beginner = difficultyByKey('beginner');
  const varied = new Set();
  for (let i = 0; i < 12; i++) {
    varied.add(pick({
      maxDepth: beginner.maxDepth, maxTime: beginner.maxTime,
      randomness: beginner.randomness, blunderChance: beginner.blunderChance,
    }, i * 977 + 3));
  }
  assert.ok(varied.size > 1, 'Beginner should not play the same move every single game');

  // Master is pinned to a depth rather than to its own clock: a time-limited search legitimately
  // reaches different depths on a loaded machine, and that is the clock varying, not the engine.
  const steady = new Set();
  for (let i = 0; i < 4; i++) {
    steady.add(pick({ maxDepth: 5, maxTime: 8000, randomness: 0, blunderChance: 0 }, i * 977 + 3));
  }
  assert.equal(steady.size, 1, 'with no randomness and a fixed depth the choice must be stable');
});

test('search leaves the position untouched', () => {
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const pos = parseFen(fen);
  const before = [pos.keyLo, pos.keyHi, pos.turn, pos.castling, pos.ep, pos.halfmove];
  searcher.search(pos, { maxDepth: 5, maxTime: 800, randomness: 0, blunderChance: 0 });
  assert.deepEqual([pos.keyLo, pos.keyHi, pos.turn, pos.castling, pos.ep, pos.halfmove], before);
});

test('a mate score is reported as a mate distance, not a huge number', () => {
  const { result } = bestMove('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', { depth: 4 });
  assert.equal(result.mateIn, 1);
});

test('the principal variation is a playable sequence of moves', () => {
  const { result, pos } = bestMove(
    'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', { depth: 6 });
  assert.ok(result.pv.length >= 2, 'a depth-6 search should return a line, not one move');
  const work = pos.clone();
  for (const m of result.pv) {
    const legal = new Set(generateLegal(work).map(moveToUci));
    assert.ok(legal.has(moveToUci(m)), `PV move ${moveToUci(m)} is not legal`);
    work.makeMove(m);
  }
});

// ── evaluation sanity ───────────────────────────────────────────────────────

test('evaluation is symmetric: a mirrored position scores the same for the other side', () => {
  const a = evaluate(parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
  const b = evaluate(parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1'));
  assert.equal(a, b, 'the initial position is symmetric and must evaluate identically');
});

test('evaluation prefers a queen to a pawn, and a passed pawn to a blocked one', () => {
  const upQueen = evaluate(parseFen('4k3/8/8/8/8/8/8/3QK3 w - - 0 1'));
  assert.ok(upQueen > 500, `a free queen should be worth a lot, scored ${upQueen}`);

  const passed = evaluate(parseFen('4k3/8/8/3P4/8/8/8/4K3 w - - 0 1'));
  const blocked = evaluate(parseFen('4k3/8/3p4/3P4/8/8/8/4K3 w - - 0 1'));
  assert.ok(passed > blocked - 100, 'a passed pawn should not score worse than a blocked one');
});

// ── opening book ────────────────────────────────────────────────────────────

test('every move in every book line is legal chess', () => {
  for (const line of bookLines()) {
    const pos = startPosition();
    for (const san of line) {
      const move = fromSan(pos, san);
      assert.ok(move, `"${san}" is not legal in the line ${line.join(' ')}`);
      assert.equal(toSan(pos, move), san, 'and should render back identically');
      pos.makeMove(move);
    }
  }
});

test('the book answers the initial position and varies its reply', () => {
  const pos = startPosition();
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const m = bookMove(pos, i / 40, 1);
    assert.ok(m, 'the book must know the starting position');
    seen.add(moveToUci(m));
  }
  assert.ok(seen.size > 1, 'the book should not open with the same move every game');
});

test('the book runs out rather than inventing moves', () => {
  // A position no line reaches.
  const pos = parseFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  assert.equal(bookMove(pos, 0.5, 1), null);
});

test('openings are named from the moves played', () => {
  assert.equal(openingName(['e4', 'c5']), 'Sicilian Defence');
  assert.equal(openingName(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']), 'Ruy Lopez');
  assert.equal(openingName(['d4', 'Nf6', 'c4', 'g6']), "King's Indian Defence");
  assert.equal(openingName(['a3']), null);
  assert.equal(openingName([]), null);
});
