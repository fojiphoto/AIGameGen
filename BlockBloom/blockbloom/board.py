"""
The board: occupancy, legality, line detection and clearing.

This module is deliberately free of pygame. It holds a grid of colour indices and answers
questions about them, which means the whole ruleset is testable without a display and the
animation code above it cannot accidentally become load-bearing for the rules.

One decision worth stating: `clear_lines` does not mutate the grid. It returns which rows and
columns are complete and leaves the removal to a separate call, because the clear has to be
*animated* — the cells must stay visible while they flash and burst, and only then disappear. A
version that cleared immediately and let the animation draw from a copy was the first thing
written here, and it drifted: the copy and the grid disagreed about what had been scored.
"""

from __future__ import annotations

from .config import GRID

#: Empty is -1 rather than 0 so that colour index 0 is a usable colour. An earlier version used 0
#: for empty and lost the first block colour to it.
EMPTY = -1


class Board:
    __slots__ = ("size", "cells")

    def __init__(self, size: int = GRID):
        self.size = size
        #: Row-major, indexed [row][col]. Row-major because clears and the renderer both walk
        #: rows, and a column walk is cheap enough at this size that the asymmetry never shows.
        self.cells = [[EMPTY] * size for _ in range(size)]

    # ── queries ─────────────────────────────────────────────────────────────────
    def at(self, col: int, row: int) -> int:
        return self.cells[row][col]

    def filled(self, col: int, row: int) -> bool:
        return self.cells[row][col] != EMPTY

    def in_bounds(self, col: int, row: int) -> bool:
        return 0 <= col < self.size and 0 <= row < self.size

    def count_filled(self) -> int:
        return sum(1 for row in self.cells for v in row if v != EMPTY)

    def is_empty(self) -> bool:
        return self.count_filled() == 0

    def can_place(self, shape_cells, col: int, row: int) -> bool:
        """Would this shape fit with its origin at (col, row)?"""
        size = self.size
        cells = self.cells
        for dc, dr in shape_cells:
            c = col + dc
            r = row + dr
            if c < 0 or c >= size or r < 0 or r >= size:
                return False
            if cells[r][c] != EMPTY:
                return False
        return True

    def placements(self, shape_cells, limit: int | None = None) -> list:
        """Every legal origin for a shape. `limit` stops early when only existence matters."""
        out = []
        # Bound the scan by the shape's own extent rather than testing all 64 origins and
        # rejecting most of them inside can_place.
        w = max(c for c, _ in shape_cells) + 1
        h = max(r for _, r in shape_cells) + 1
        for row in range(self.size - h + 1):
            for col in range(self.size - w + 1):
                if self.can_place(shape_cells, col, row):
                    out.append((col, row))
                    if limit is not None and len(out) >= limit:
                        return out
        return out

    def has_placement(self, shape_cells) -> bool:
        return bool(self.placements(shape_cells, limit=1))

    def any_placement(self, pieces) -> bool:
        """Can *any* unconsumed piece go anywhere? This is the game-over test."""
        for p in pieces:
            if not p.consumed and self.has_placement(p.cells):
                return True
        return False

    # ── mutation ────────────────────────────────────────────────────────────────
    def place(self, shape_cells, col: int, row: int, color_index: int) -> list:
        """Write a shape in. Returns the absolute cells written, for the animation to use."""
        written = []
        for dc, dr in shape_cells:
            c, r = col + dc, row + dr
            self.cells[r][c] = color_index
            written.append((c, r))
        return written

    def complete_lines(self) -> tuple[list, list]:
        """Which rows and columns are full right now. Does not modify anything."""
        size = self.size
        cells = self.cells
        rows = [r for r in range(size) if EMPTY not in cells[r]]
        cols = [
            c for c in range(size)
            if all(cells[r][c] != EMPTY for r in range(size))
        ]
        return rows, cols

    @staticmethod
    def line_cells(rows, cols, size: int = GRID) -> list:
        """The distinct cells covered by a set of rows and columns.

        Deduplicated, because a row and a column that both clear share their intersection, and
        counting it twice would over-award score and double up the particle burst exactly where
        the eye is already looking.
        """
        seen = set()
        out = []
        for r in rows:
            for c in range(size):
                if (c, r) not in seen:
                    seen.add((c, r))
                    out.append((c, r))
        for c in cols:
            for r in range(size):
                if (c, r) not in seen:
                    seen.add((c, r))
                    out.append((c, r))
        return out

    def remove(self, cells) -> None:
        for c, r in cells:
            self.cells[r][c] = EMPTY

    def clear(self) -> None:
        for row in self.cells:
            for i in range(len(row)):
                row[i] = EMPTY

    # ── analysis, for the generator ─────────────────────────────────────────────
    def largest_empty_run(self) -> int:
        """The longest unbroken empty stretch in any row or column.

        The generator uses this as a coarse read on how much room is left: when the longest run
        is three, offering a five-long piece is not a challenge, it is a dead card.
        """
        best = 0
        size = self.size
        for r in range(size):
            run = 0
            for c in range(size):
                run = run + 1 if self.cells[r][c] == EMPTY else 0
                best = max(best, run)
        for c in range(size):
            run = 0
            for r in range(size):
                run = run + 1 if self.cells[r][c] == EMPTY else 0
                best = max(best, run)
        return best

    def row_gaps(self) -> list:
        """Empty cells remaining per row, then per column, as one list of 2*size counts.

        Used to spot lines that are one or two cells from completing, which is what the generator
        wants to enable.
        """
        size = self.size
        out = [sum(1 for c in range(size) if self.cells[r][c] == EMPTY) for r in range(size)]
        out += [sum(1 for r in range(size) if self.cells[r][c] == EMPTY) for c in range(size)]
        return out

    def snapshot(self) -> list:
        return [row[:] for row in self.cells]

    def restore(self, snap) -> None:
        self.cells = [row[:] for row in snap]
