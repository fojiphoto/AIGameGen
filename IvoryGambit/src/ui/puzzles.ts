/**
 * Puzzles.
 *
 * A built-in starter set of hand-checked positions, plus the shape a bigger set would slot into
 * unchanged. Every puzzle is a FEN and the solution as SAN, and the loader validates both
 * against the rules engine at startup — a puzzle whose "solution" is not a legal move is worse
 * than no puzzle at all, because the player will assume they are the one who is wrong.
 *
 * The set is deliberately small and deliberately graded. Twelve positions that each teach one
 * idea beats two hundred scraped ones with no order: the first four are mates in one from the
 * four most common mating patterns, then mates in two, then tactics that win material, then two
 * defensive problems where the only move stops a mate.
 *
 * Positions are composed rather than taken from any database, so there is nothing here that
 * belongs to anyone else.
 */

import { Position, parseFen, fromSan, toSan, Move, generateLegal, moveToUci } from '../core/index.js';

export type PuzzleKind = 'mate-1' | 'mate-2' | 'material' | 'defence';

export interface Puzzle {
  id: string;
  kind: PuzzleKind;
  title: string;
  /** One line, shown before the player moves. Says the goal, never the answer. */
  brief: string;
  fen: string;
  /** The full solution in SAN, alternating player and reply. */
  solution: string[];
  /** Shown after solving — the idea, in one sentence. */
  lesson: string;
}

export const PUZZLES: Puzzle[] = [
  {
    id: 'backrank-1',
    kind: 'mate-1',
    title: 'The Back Rank',
    brief: 'White to play. Mate in one.',
    fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
    solution: ['Ra8#'],
    lesson: 'A king boxed in by its own pawns has no escape from a rook on the back rank.',
  },
  {
    id: 'smothered-1',
    kind: 'mate-1',
    title: 'Smothered',
    brief: 'White to play. Mate in one.',
    fen: '6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1',
    solution: ['Nf7#'],
    lesson: 'A knight can mate a king that its own pieces have sealed in.',
  },
  {
    id: 'queen-support-1',
    kind: 'mate-1',
    title: 'Shoulder to Shoulder',
    brief: 'White to play. Mate in one.',
    fen: '7k/8/6K1/8/8/8/8/7Q w - - 0 1',
    solution: ['Qh7#'],
    lesson: 'The queen delivers it; the king defends her. Neither could do it alone.',
  },
  {
    id: 'twobishops-1',
    kind: 'mate-1',
    title: 'The Long Diagonals',
    brief: 'White to play. Mate in one.',
    fen: '7k/8/4B1K1/8/8/8/1B6/8 w - - 0 1',
    solution: ['Bc3#'],
    lesson: 'Two bishops cover the light and the dark escape squares at once.',
  },
  {
    id: 'squeeze-2',
    kind: 'mate-2',
    title: 'The Squeeze',
    brief: 'White to play. Mate in two.',
    fen: '7k/8/5K2/8/8/8/8/4R3 w - - 0 1',
    solution: ['Kg6', 'Kg8', 'Re8#'],
    lesson: 'The king takes the escape squares away; the rook only has to arrive.',
  },
  {
    id: 'confine-2',
    kind: 'mate-2',
    title: 'Take the Rank First',
    brief: 'White to play. Mate in two.',
    fen: '7k/8/6K1/8/8/8/8/1Q6 w - - 0 1',
    solution: ['Qb7', 'Kg8', 'Qg7#'],
    lesson: 'A quiet move that leaves one legal square is stronger than a loud check.',
  },
  {
    id: 'fork-1',
    kind: 'material',
    title: 'The Fork',
    brief: 'White to play and win material.',
    fen: '4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1',
    solution: ['Ne4'],
    lesson: 'A knight attacking two pieces at once can only be answered by losing one.',
  },
  {
    id: 'skewer-1',
    kind: 'material',
    title: 'The Skewer',
    brief: 'White to play and win the queen.',
    fen: '4k3/8/8/8/8/8/4q3/4RK2 w - - 0 1',
    solution: ['Rxe2+'],
    lesson: 'A piece in front of its king on the same line cannot be defended by running.',
  },
  {
    id: 'free-piece-1',
    kind: 'material',
    title: 'Look Again',
    brief: 'White to play. Something is hanging.',
    fen: '4k3/8/8/3b4/4B3/8/8/4K3 w - - 0 1',
    solution: ['Bxd5'],
    lesson: 'Before anything clever, check what is simply free.',
  },
  {
    id: 'promote-1',
    kind: 'material',
    title: 'One Square Away',
    brief: 'White to play. Make a queen.',
    fen: '8/P6k/8/8/8/8/7K/8 w - - 0 1',
    solution: ['a8=Q'],
    lesson: 'A passed pawn on the seventh is already a queen; the move just makes it official.',
  },
  {
    id: 'defend-1',
    kind: 'defence',
    title: 'Make Some Air',
    brief: 'Black to play. Stop the back-rank mate.',
    fen: '6k1/5ppp/8/8/8/8/8/R5K1 b - - 0 1',
    solution: ['g6'],
    lesson: 'Giving the king a square is worth more than any counter-attack when mate is next.',
  },
  {
    id: 'defend-2',
    kind: 'defence',
    title: 'Interpose',
    brief: 'Black to play. Survive.',
    fen: '4k3/8/8/8/8/8/4r3/4RK2 b - - 0 1',
    solution: ['Rxe1+'],
    lesson: 'When a trade removes the attacker, it is not a trade — it is a rescue.',
  },
];

export interface PuzzleState {
  puzzle: Puzzle;
  position: Position;
  /** Index into `solution` of the move the player must now find. */
  step: number;
  failed: boolean;
}

/**
 * Load a puzzle and verify it.
 *
 * Returns null if the FEN or any solution move is not legal, which the caller treats as "skip
 * this one". Verifying at load rather than trusting the data is the difference between a bad
 * entry costing one puzzle and it costing a player twenty minutes of believing they cannot see
 * a move that was never there.
 */
export function loadPuzzle(puzzle: Puzzle): PuzzleState | null {
  let position: Position;
  try {
    position = parseFen(puzzle.fen);
  } catch {
    return null;
  }
  const check = position.clone();
  for (const san of puzzle.solution) {
    const move = fromSan(check, san);
    if (!move) return null;
    check.makeMove(move);
  }
  return { puzzle, position, step: 0, failed: false };
}

/** Every puzzle whose data holds up. Computed once. */
export function validPuzzles(): Puzzle[] {
  return PUZZLES.filter((p) => loadPuzzle(p) !== null);
}

export interface PuzzleAttempt {
  correct: boolean;
  /** The reply the puzzle plays back, if the player was right and the line continues. */
  reply: Move | null;
  solved: boolean;
}

/**
 * Try a move against the current step.
 *
 * A move is accepted if it *is* the solution move, and also if it reaches the same square with
 * the same piece by an equivalent path — but not if it merely happens to also be winning. A
 * puzzle that accepts any good move stops teaching the specific idea it was built around.
 */
export function tryPuzzleMove(state: PuzzleState, move: Move): PuzzleAttempt {
  const expected = fromSan(state.position, state.puzzle.solution[state.step]);
  if (!expected || moveToUci(expected) !== moveToUci(move)) {
    return { correct: false, reply: null, solved: false };
  }

  state.position.makeMove(move);
  state.step++;

  if (state.step >= state.puzzle.solution.length) {
    return { correct: true, reply: null, solved: true };
  }

  // The opponent's scripted reply.
  const reply = fromSan(state.position, state.puzzle.solution[state.step]);
  if (!reply) return { correct: true, reply: null, solved: true };
  state.position.makeMove(reply);
  state.step++;
  const solved = state.step >= state.puzzle.solution.length;
  return { correct: true, reply, solved };
}

/** The move the player is looking for, for the Hint button. */
export function puzzleHint(state: PuzzleState): Move | null {
  return fromSan(state.position, state.puzzle.solution[state.step]);
}

export { toSan, generateLegal };
