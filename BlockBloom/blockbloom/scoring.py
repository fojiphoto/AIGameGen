"""
Score, combo, and the words that go with them.

Two things here are less obvious than they look.

**The combo counts moves, not time.** In a puzzle game with no clock, a timed combo window would
punish thinking, which is the opposite of what this genre is for. So the combo rises on a move
that clears and resets on a move that does not — the player is rewarded for keeping the board
productive, not for hurrying.

**The displayed score is not the score.** It chases the real value exponentially, so a big clear
reads as a run of numbers rather than a jump. The real value is always authoritative; the display
is presentation only, and `snap()` exists for the game-over panel, which must not show a number
still in motion.
"""

from __future__ import annotations

import math

from .config import (
    COMBO_MAX, COMBO_STEP, LINE_BASE, MULTI_CLEAR, PERFECT_CLEAR_BONUS,
    POINTS_PER_CELL, SCORE_LERP_RATE,
)


def multi_multiplier(lines: int) -> float:
    """Reward for clearing several lines in one move."""
    if lines <= 0:
        return 0.0
    return MULTI_CLEAR[min(lines, len(MULTI_CLEAR)) - 1]


def combo_multiplier(combo: int) -> float:
    """Combo adds a fraction per step above one, rather than multiplying outright."""
    return 1.0 + COMBO_STEP * max(0, min(combo, COMBO_MAX) - 1)


#: The banner shown for a clear, chosen by how big it was. Ordered most impressive first so the
#: lookup is a plain scan and the precedence is visible on the page.
def clear_banner(lines: int, combo: int) -> tuple | None:
    """(text, weight) for a clear, or None when it does not deserve a banner.

    Weight is 0..1 and drives everything the presentation scales: text size, particle count,
    shake, flash. One number so the juice cannot get out of step with the words.
    """
    if lines >= 4:
        return ("MEGA CLEAR", 1.0)
    if lines == 3:
        return ("AMAZING!", 0.85)
    if combo >= 5:
        return (f"COMBO x{combo}", 0.8)
    if lines == 2:
        return ("DOUBLE!", 0.6)
    if combo >= 2:
        return (f"COMBO x{combo}", 0.35 + 0.06 * min(combo, 8))
    return None


class Scoring:
    """Score and combo for one run."""

    def __init__(self):
        self.score = 0
        self.display = 0.0
        self.combo = 0
        self.best_combo = 0
        self.lines_cleared = 0
        self.moves = 0
        self.pieces_placed = 0
        #: Largest number of lines cleared in a single move this run — a challenge objective and a
        #: statistic worth showing.
        self.best_simultaneous = 0
        self.perfect_clears = 0

    # ── events ──────────────────────────────────────────────────────────────────
    def place(self, cells: int) -> int:
        """A piece went down. Returns the points awarded for the placement itself."""
        gained = cells * POINTS_PER_CELL
        self.score += gained
        self.moves += 1
        self.pieces_placed += 1
        return gained

    def clear(self, lines: int, *, board_emptied: bool = False) -> tuple[int, float]:
        """Lines were cleared by the move just made. Returns (points, banner weight).

        Must be called after `place` for the same move, because the combo it applies is the one
        this clear has just earned.
        """
        if lines <= 0:
            return (0, 0.0)

        self.combo = min(COMBO_MAX, self.combo + 1)
        self.best_combo = max(self.best_combo, self.combo)
        self.lines_cleared += lines
        self.best_simultaneous = max(self.best_simultaneous, lines)

        gained = int(LINE_BASE * lines * multi_multiplier(lines) * combo_multiplier(self.combo))
        if board_emptied:
            self.perfect_clears += 1
            gained += PERFECT_CLEAR_BONUS

        self.score += gained
        banner = clear_banner(lines, self.combo)
        weight = banner[1] if banner else 0.25
        if board_emptied:
            weight = 1.0
        return (gained, weight)

    def no_clear(self) -> None:
        """A move that cleared nothing. Breaks the chain."""
        self.combo = 0

    # ── presentation ────────────────────────────────────────────────────────────
    def update(self, dt: float) -> None:
        """Advance the displayed score towards the real one.

        Exponential, so it is frame-rate independent, plus a floor on the step: a pure
        exponential approaches its target asymptotically and the last few points would crawl for
        seconds. The floor also guarantees it *arrives*, which matters because the game-over panel
        reads this value.
        """
        gap = self.score - self.display
        if gap <= 0.0:
            self.display = float(self.score)
            return
        step = gap * (1.0 - math.exp(-SCORE_LERP_RATE * dt))
        self.display = min(float(self.score), self.display + max(step, 60.0 * dt, 1.0))

    def snap(self) -> None:
        self.display = float(self.score)

    @property
    def shown(self) -> int:
        return int(self.display)

    # ── rewards ─────────────────────────────────────────────────────────────────
    def coins_earned(self) -> int:
        """Coins for this run. Deliberately modest: themes should take several runs."""
        from .config import COIN_COMBO_BONUS, COIN_PER_LINE, COIN_PER_SCORE

        coins = self.score // COIN_PER_SCORE
        coins += self.lines_cleared * COIN_PER_LINE
        if self.best_combo >= 5:
            coins += COIN_COMBO_BONUS
        return int(coins)
