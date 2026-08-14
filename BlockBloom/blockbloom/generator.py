"""
Smart piece generation.

Careless random dealing ruins this genre in two opposite ways. It hands out five-long pieces onto
a board with no room for them, which ends runs for reasons the player could not have influenced;
and it hands out three dots in a row on an empty board, which is boring. Neither reads as random
to a player — both read as the game not paying attention.

So the deal is built, scored and sometimes rebuilt:

1. Pick a tier mix from how far into the run we are, so shapes get larger as the player settles
   in, and clamp it by how much room is actually left. A board whose longest empty run is three
   cannot be sent a five.
2. Build a candidate deal from that mix.
3. Score it: is anything placeable at all, could any piece complete a line, is it varied.
4. Keep the best of several candidates.

What is guaranteed is only the floor — at least `MIN_PLACEABLE` of the three pieces fits
somewhere. Everything above the floor is a preference, which is what keeps the game feeling
random rather than curated. Guaranteeing a *line* every deal would remove the strategy entirely.
"""

from __future__ import annotations

import random

from .config import DIFFICULTY_MOVES, GEN_ATTEMPTS, MIN_PLACEABLE, TRAY_SLOTS
from .pieces import SHAPES_BY_TIER, Piece


class Generator:
    """Deals pieces for one run.

    Owns its own Random so a run can be replayed from a seed, which is what makes the generation
    tests deterministic and repeatable rather than statistical.
    """

    def __init__(self, seed: int | None = None, *, color_count: int = 7):
        self.rng = random.Random(seed)
        self.color_count = color_count
        self.moves = 0
        self.deals = 0
        #: The last few shape keys dealt, so the same piece is not offered three deals running.
        self._recent: list = []

    # ── difficulty ──────────────────────────────────────────────────────────────
    def progress(self) -> float:
        """0 at the start of a run, 1 once the player is established."""
        return min(1.0, self.moves / float(DIFFICULTY_MOVES))

    def tier_weights(self, room: int) -> list:
        """How likely each tier is, given progression and the space available.

        `room` is the longest empty run on the board. It gates the big shapes: there is no point
        offering a five when the largest gap is three, and doing so is exactly what makes a
        generator feel spiteful.
        """
        p = self.progress()

        # Early: small shapes dominate. Late: the awkward tiers carry real weight, but tier 0
        # never drops to zero — those are the pieces that let a crowded board be recovered, and
        # removing them is how a difficulty curve turns into a wall.
        w = [
            0.40 - 0.22 * p,     # tier 0
            0.34 - 0.06 * p,     # tier 1
            0.20 + 0.14 * p,     # tier 2
            0.06 + 0.14 * p,     # tier 3
        ]

        if room < 5:
            # Nothing in tier 3 is guaranteed to be under five long, and tier 2 has fours.
            w[3] *= 0.15
            if room < 4:
                w[2] *= 0.35
            if room < 3:
                w[2] *= 0.2
                w[1] *= 0.5
        return w

    # ── one candidate ───────────────────────────────────────────────────────────
    def _pick_shape(self, weights):
        tier = self.rng.choices((0, 1, 2, 3), weights=weights, k=1)[0]
        pool = SHAPES_BY_TIER[tier]
        shape = self.rng.choice(pool)
        # One retry to avoid repeating a very recent shape. One, not a loop: insisting produces a
        # noticeably uniform spread, which reads as less random than the occasional repeat.
        if shape.key in self._recent:
            shape = self.rng.choice(pool)
        return shape

    def _candidate(self, board, weights) -> list:
        shapes = [self._pick_shape(weights) for _ in range(TRAY_SLOTS)]
        colors = self._colors(len(shapes))
        return [Piece(s, c, i) for i, (s, c) in enumerate(zip(shapes, colors))]

    def _colors(self, n: int) -> list:
        """Distinct colours where possible — three identical tiles in the tray look like a bug."""
        pool = list(range(self.color_count))
        self.rng.shuffle(pool)
        return pool[:n] if n <= len(pool) else [self.rng.randrange(self.color_count)
                                               for _ in range(n)]

    # ── scoring a candidate ─────────────────────────────────────────────────────
    def _score(self, board, pieces) -> tuple:
        """Rank a candidate deal. Higher is better; returned as a tuple for lexicographic sort.

        The first element is the hard requirement and the rest are preferences, so a deal that
        meets the floor always beats one that does not, however pretty it is otherwise.
        """
        placeable = sum(1 for p in pieces if board.has_placement(p.cells))
        meets_floor = 1 if placeable >= MIN_PLACEABLE else 0

        # Could any single piece finish a row or column from here? This is what makes a deal feel
        # like an opportunity. It is checked on a snapshot so nothing leaks into the real board.
        completing = 0
        if meets_floor:
            snap = board.snapshot()
            for p in pieces:
                for (col, row) in board.placements(p.cells, limit=14):
                    board.place(p.cells, col, row, 0)
                    rows, cols = board.complete_lines()
                    board.restore(snap)
                    if rows or cols:
                        completing += 1
                        break
            board.restore(snap)

        variety = len({p.shape.key for p in pieces})
        total_cells = sum(p.shape.size for p in pieces)
        return (meets_floor, min(completing, 2), variety, total_cells)

    # ── the public call ─────────────────────────────────────────────────────────
    def deal(self, board) -> list:
        """Three pieces for this board. Never returns a deal where nothing fits, if one exists."""
        room = board.largest_empty_run()
        weights = self.tier_weights(room)

        best = None
        best_score = None
        for _ in range(GEN_ATTEMPTS):
            cand = self._candidate(board, weights)
            score = self._score(board, cand)
            if best_score is None or score > best_score:
                best, best_score = cand, score
            # A deal that meets the floor and offers a line is as good as this needs to get;
            # stopping early keeps the cost of a deal off the frame that asks for it.
            if score[0] and score[1] >= 1 and score[2] == TRAY_SLOTS:
                break

        # Last resort. If every candidate failed the floor, the board is genuinely tight — so
        # deal the smallest shapes that exist and check them directly. If even a single cell has
        # nowhere to go the board is full and the run is legitimately over.
        if best_score is not None and not best_score[0]:
            forced = self._rescue(board)
            if forced is not None:
                best = forced

        self.deals += 1
        self._recent = [p.shape.key for p in best][-TRAY_SLOTS:]
        return best

    def _rescue(self, board) -> list | None:
        """Build a deal from the smallest placeable shapes, when a normal deal found nothing.

        This is not generosity — it is the difference between "you ran out of room" and "the game
        stopped dealing you anything usable". If nothing at all is placeable this returns None and
        the run ends, which by then is the honest outcome.
        """
        usable = [s for tier in SHAPES_BY_TIER for s in tier if board.has_placement(s.cells)]
        if not usable:
            return None
        usable.sort(key=lambda s: s.size)
        pool = usable[:6]
        colors = self._colors(TRAY_SLOTS)
        return [
            Piece(self.rng.choice(pool), colors[i], i)
            for i in range(TRAY_SLOTS)
        ]

    def note_move(self) -> None:
        self.moves += 1
