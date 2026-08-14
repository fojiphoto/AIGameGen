"""
The QA harness.

Runs with no display and no sound card, which is the point: a game that can only be checked by a
person watching it gets checked much less often than one that checks itself in fifteen seconds.

Two conventions carried over from the game this engine came from, both of them learned the hard
way:

* **Prefer an exact structural assertion to a timing threshold.** "Composing a frame allocates no
  full-screen surfaces" never flaps. "Under 16.6 ms" flaps on a loaded machine, and a test that
  fails one time in three teaches you to ignore it.
* **Measure the minimum across batches, never the mean or median.** Another process stealing a
  slice can only ever make a batch look slower, so the fastest batch is the closest reading of what
  the code costs.

And the lesson that cost a user-visible bug last time: the frame-time checks cover **every screen**,
not just gameplay. The menus turned out to be the expensive part, and nobody found out until a
player reported it.
"""

from __future__ import annotations

import json
import math
import random
import sys
import tempfile
import time
from pathlib import Path

import pygame

_passed = 0
_failed: list = []
_ansi = sys.stdout.isatty()


def _c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _ansi else text


def section(name: str) -> None:
    print(f"\n{_c(name, '1')}")


def check(condition, label: str, detail: str = "") -> bool:
    global _passed
    ok = bool(condition)
    if ok:
        _passed += 1
        print(f"  {_c('ok', '32')}   {label}" + (f"  {_c(detail, '2')}" if detail else ""))
    else:
        _failed.append(label)
        print(f"  {_c('FAIL', '31')} {label}" + (f"  {detail}" if detail else ""))
    return ok


# ── fixtures ────────────────────────────────────────────────────────────────────
def _fresh_app(tmp_save: Path):
    """An App with an isolated save file, so a test run never touches real progress.

    The caches are dropped first. Cached Font objects and cached Surfaces are both tied to the
    pygame session that created them, so any earlier `pygame.quit()` leaves the caches holding
    handles that raise "font module quit since font created" the next time they are drawn. Doing it
    here rather than at each call site is what makes the suite safe to reorder.
    """
    from . import assets, fonts, theme, ui
    from .app import App
    from .save import SaveData

    assets.clear_cache()
    fonts.clear_cache()
    ui.drop_layers()
    theme.apply(theme.DEFAULT_THEME)

    app = App(headless=True)
    app.save = SaveData(tmp_save)
    app.save.data["settings"]["music"] = False
    app.save.apply_theme()
    return app


def _drive(scene, seconds: float, dt: float = 1 / 120, surf=None):
    """Advance a scene, drawing too if a surface is given."""
    for _ in range(int(seconds / dt)):
        scene.update(dt)
        if surf is not None:
            scene.draw(surf)


def _click(app, scene, pos) -> None:
    """A full press-and-release at a virtual position, as the app would deliver it."""
    for kind in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP):
        app.mouse = pos
        app.mouse_down = kind == pygame.MOUSEBUTTONDOWN
        scene.handle(pygame.event.Event(kind, {"pos": pos, "button": 1, "touch": False}))
    app.mouse_down = False


def _settle(app, surf, seconds: float = 1.2) -> None:
    """Run the app's own frame loop long enough for a scene transition to complete."""
    for _ in range(int(seconds * 120)):
        app._advance_transition(1 / 120)
        if app.scene:
            app.scene.update(1 / 120)
            app.scene.draw(surf)


def _fill_row(board, row: int, exclude: int | None = None) -> None:
    for c in range(board.size):
        if c != exclude:
            board.cells[row][c] = c % 7


def _fill_col(board, col: int, exclude: int | None = None) -> None:
    for r in range(board.size):
        if r != exclude:
            board.cells[r][col] = r % 7


# ── the rules ───────────────────────────────────────────────────────────────────
def _test_shapes():
    section("Shapes")
    from .config import GRID
    from .pieces import SHAPES, SHAPES_BY_TIER, normalise

    check(len(SHAPES) >= 24, "the catalogue has real variety", f"{len(SHAPES)} shapes")
    check(all(len(t) >= 3 for t in SHAPES_BY_TIER), "every difficulty tier is populated",
          f"tiers {[len(t) for t in SHAPES_BY_TIER]}")
    check(all(s.w <= GRID and s.h <= GRID for s in SHAPES),
          "every shape fits the board")
    check(all(min(c for c, _ in s.cells) == 0 and min(r for _, r in s.cells) == 0
              for s in SHAPES), "every shape is normalised to the origin")
    check(all(len(set(s.cells)) == len(s.cells) for s in SHAPES),
          "no shape lists a cell twice")
    # The catalogue must cover what the design promised.
    keys = {s.key for s in SHAPES}
    wanted = {"dot", "h2", "h3", "h4", "h5", "v5", "square", "rect_h",
              "l_n", "t_n", "plus", "corner", "s_h", "diag2"}
    missing = wanted - keys
    check(not missing, "every promised shape family is present",
          "all present" if not missing else f"missing {sorted(missing)}")
    check(normalise([(3, 4), (4, 4)]) == ((0, 0), (1, 0)),
          "normalise shifts and sorts")


def _test_board():
    section("Board rules")
    from .board import EMPTY, Board
    from .pieces import SHAPES_BY_KEY

    b = Board()
    check(b.is_empty() and b.count_filled() == 0, "a new board is empty")

    dot = SHAPES_BY_KEY["dot"]
    h5 = SHAPES_BY_KEY["h5"]
    check(b.can_place(dot.cells, 0, 0), "a single block fits an empty board")
    check(b.can_place(h5.cells, 3, 0), "a five-long fits with room to spare")
    check(not b.can_place(h5.cells, 4, 0), "a shape may not hang off the right edge")
    check(not b.can_place(dot.cells, -1, 0), "a shape may not hang off the left edge")
    check(not b.can_place(dot.cells, 0, 8), "a shape may not hang off the bottom")

    b.place(dot.cells, 2, 2, 3)
    check(b.filled(2, 2) and b.at(2, 2) == 3, "placing writes the colour")
    check(not b.can_place(dot.cells, 2, 2), "an occupied cell rejects a placement")
    check(b.count_filled() == 1, "placing fills exactly the shape's cells")

    # Row clearing.
    b2 = Board()
    _fill_row(b2, 3, exclude=7)
    rows, cols = b2.complete_lines()
    check(not rows and not cols, "a row one cell short does not clear")
    b2.cells[3][7] = 1
    rows, cols = b2.complete_lines()
    check(rows == [3] and not cols, "a full row clears", f"rows={rows}")

    # Column clearing.
    b3 = Board()
    _fill_col(b3, 5, exclude=0)
    check(b3.complete_lines() == ([], []), "a column one cell short does not clear")
    b3.cells[0][5] = 2
    rows, cols = b3.complete_lines()
    check(cols == [5] and not rows, "a full column clears", f"cols={cols}")

    # Simultaneous, and the shared cell counted once.
    b4 = Board()
    _fill_row(b4, 0)
    _fill_col(b4, 0)
    rows, cols = b4.complete_lines()
    cells = Board.line_cells(rows, cols)
    check(rows == [0] and cols == [0], "a row and a column can clear together")
    check(len(cells) == 15, "the shared cell is counted once, not twice",
          f"{len(cells)} cells for 8+8-1")

    # Four rows at once.
    b5 = Board()
    for r in range(4):
        _fill_row(b5, r)
    rows, cols = b5.complete_lines()
    check(rows == [0, 1, 2, 3], "four rows clear together", f"rows={rows}")
    b5.remove(Board.line_cells(rows, cols))
    check(b5.is_empty(), "removal empties exactly the cleared cells")

    # Whole-board clear detection, used for the PERFECT bonus.
    b6 = Board()
    for r in range(8):
        _fill_row(b6, r)
    rows, cols = b6.complete_lines()
    check(len(Board.line_cells(rows, cols)) == 64, "a full board clears every cell")

    b7 = Board()
    _fill_row(b7, 0, exclude=3)
    check(b7.largest_empty_run() == 8, "the largest empty run sees a clear column",
          f"{b7.largest_empty_run()}")


def _test_generator():
    section("Piece generation")
    from .board import Board
    from .config import MIN_PLACEABLE, TRAY_SLOTS
    from .generator import Generator

    g = Generator(seed=1)
    b = Board()
    deal = g.deal(b)
    check(len(deal) == TRAY_SLOTS, "a deal is three pieces", f"{len(deal)} pieces")
    check(len({p.color_index for p in deal}) == TRAY_SLOTS,
          "the three pieces get distinct colours")
    check(all(not p.consumed for p in deal), "a fresh deal is unconsumed")

    # The guarantee, over a long simulated play session against real boards.
    worst = 99
    starved = 0
    trials = 40
    for trial in range(trials):
        bb = Board()
        gg = Generator(seed=trial)
        rng = random.Random(trial * 31 + 7)
        for _ in range(400):
            d = gg.deal(bb)
            playable = sum(1 for p in d if bb.has_placement(p.cells))
            if not any(bb.has_placement(s.cells) for s in
                       [p.shape for p in d] + [__import__(
                           "blockbloom.pieces", fromlist=["x"]).SHAPES_BY_KEY["dot"]]):
                # The board is genuinely full: not a generator failure.
                break
            worst = min(worst, playable)
            if playable == 0:
                starved += 1
                break
            for p in d:
                spots = bb.placements(p.cells, limit=48)
                if not spots:
                    continue
                col, row = rng.choice(spots)
                bb.place(p.cells, col, row, p.color_index)
                gg.note_move()
                rws, cls = bb.complete_lines()
                if rws or cls:
                    bb.remove(Board.line_cells(rws, cls))
    check(starved == 0, "never deals an unplayable hand while a move exists",
          f"{trials} runs, worst deal had {worst} placeable of 3")
    check(worst >= MIN_PLACEABLE, "the placeable floor holds", f"floor is {MIN_PLACEABLE}")

    # Difficulty must actually move, and must respond to a cramped board.
    g2 = Generator(seed=5)
    early = g2.tier_weights(8)
    g2.moves = 200
    late = g2.tier_weights(8)
    check(late[3] > early[3] and late[0] < early[0],
          "big shapes get likelier as a run goes on",
          f"tier3 {early[3]:.2f} -> {late[3]:.2f}")
    cramped = g2.tier_weights(2)
    check(cramped[3] < late[3] * 0.5, "a cramped board suppresses the big shapes",
          f"tier3 {late[3]:.2f} -> {cramped[3]:.2f} when the longest gap is 2")
    check(cramped[0] > 0, "the small shapes never drop out entirely")

    # A board with exactly one hole must still be served.
    b3 = Board()
    for r in range(8):
        _fill_row(b3, r)
    b3.cells[4][4] = -1
    d = Generator(seed=9).deal(b3)
    check(any(b3.has_placement(p.cells) for p in d),
          "a board with one hole is still dealt something that fits")


def _test_scoring():
    section("Scoring and combos")
    from .config import COMBO_MAX, POINTS_PER_CELL
    from .scoring import Scoring, clear_banner, combo_multiplier, multi_multiplier

    s = Scoring()
    gained = s.place(4)
    check(gained == 4 * POINTS_PER_CELL and s.score == gained,
          "a placement scores per cell", f"{gained} for 4 cells")
    check(s.pieces_placed == 1 and s.moves == 1, "a placement counts as a move")

    check(multi_multiplier(2) > multi_multiplier(1) * 2,
          "two lines at once beat two lines separately",
          f"x{multi_multiplier(1)} vs x{multi_multiplier(2)}")
    check(multi_multiplier(4) > multi_multiplier(3) > multi_multiplier(2),
          "the multi-clear reward keeps escalating")

    a = Scoring(); a.place(3); p1, _ = a.clear(1)
    b = Scoring(); b.place(3); p2, _ = b.clear(2)
    c = Scoring(); c.place(3); p3, _ = c.clear(3)
    check(p1 < p2 < p3, "more lines in one move scores more", f"{p1} < {p2} < {p3}")

    s2 = Scoring()
    for _ in range(4):
        s2.place(3)
        s2.clear(1)
    check(s2.combo == 4 and s2.best_combo == 4, "consecutive clears build the combo",
          f"combo x{s2.combo}")
    s2.place(3)
    s2.no_clear()
    check(s2.combo == 0 and s2.best_combo == 4,
          "a move without a clear resets the combo but not the best")

    s3 = Scoring()
    for _ in range(COMBO_MAX + 6):
        s3.place(1)
        s3.clear(1)
    check(s3.combo == COMBO_MAX, "the combo is capped", f"x{s3.combo} at cap {COMBO_MAX}")
    check(combo_multiplier(1) == 1.0, "combo x1 is not a bonus")
    check(combo_multiplier(COMBO_MAX) > combo_multiplier(2) > 1.0,
          "a higher combo multiplies more")

    s4 = Scoring()
    s4.place(4)
    before = s4.score
    gained, weight = s4.clear(1, board_emptied=True)
    check(s4.perfect_clears == 1 and gained > 2000,
          "emptying the board pays a perfect-clear bonus", f"+{gained}")
    check(weight == 1.0, "a perfect clear gets maximum juice")

    check(clear_banner(1, 1) is None, "an ordinary single line gets no banner")
    check(clear_banner(4, 1)[0] == "MEGA CLEAR", "four lines is a MEGA CLEAR")
    check(clear_banner(2, 1)[0] == "DOUBLE!", "two lines is a DOUBLE")
    check(clear_banner(1, 4)[0] == "COMBO x4", "a combo announces itself")
    weights = [clear_banner(n, 1)[1] for n in (2, 3, 4)]
    check(weights == sorted(weights), "banner weight rises with the clear size",
          f"{weights}")

    # The displayed score must chase and then actually arrive.
    s5 = Scoring()
    s5.score = 5000
    s5.update(1 / 60)
    check(0 < s5.shown < 5000, "the displayed score interpolates", f"showing {s5.shown}")
    for _ in range(600):
        s5.update(1 / 60)
    check(s5.shown == 5000, "and reaches the real value", f"showing {s5.shown}")
    s6 = Scoring()
    s6.score = 12345
    s6.snap()
    check(s6.shown == 12345, "snap jumps straight to the real value")

    s7 = Scoring()
    s7.score = 6000
    s7.lines_cleared = 12
    s7.best_combo = 5
    check(s7.coins_earned() > 0, "a run earns coins", f"{s7.coins_earned()} coins")


def _test_save(tmp: Path):
    section("Save data")
    from . import theme
    from .save import SaveData

    p = tmp / "save.json"
    s = SaveData(p)
    check(s.data["version"] >= 1, "a missing save resolves to defaults")
    check(s.coins == 0 and s.challenge_index == 0, "a new player starts at zero")
    check(s.theme_unlocked(theme.DEFAULT_THEME), "the default theme is unlocked")
    check(not s.theme_unlocked("galaxy"), "a paid theme starts locked")

    s.add_coins(500)
    s.data["high_scores"]["endless"] = 1234
    s.mark()
    check(s.flush(), "the save writes")
    check(p.exists(), "and the file exists")

    s2 = SaveData(p)
    check(s2.coins == 500 and s2.high_score("endless") == 1234,
          "values survive a round trip", f"{s2.coins} coins, best {s2.high_score('endless')}")

    check(not s2.buy_theme("galaxy"), "a theme you cannot afford is refused")
    check(s2.buy_theme("neon"), "a theme you can afford is bought")
    check(s2.coins == 100 and s2.theme_unlocked("neon"), "buying spends the coins",
          f"{s2.coins} left")
    check(not s2.buy_theme("neon"), "you cannot buy the same theme twice")
    check(s2.select_theme("neon") and theme.current.key == "neon",
          "selecting a theme applies it live")
    check(not s2.select_theme("candy"), "a locked theme cannot be worn")

    # Objectives advance one rung at a time and pay out.
    s3 = SaveData(tmp / "obj.json")
    first = s3.current_objective()
    check(first is not None and first.key == theme.CHALLENGES[0].key,
          "a new player is on the first objective", first.key)
    reward = s3.complete_objective()
    check(reward == first.reward and s3.coins == reward,
          "completing an objective pays its reward", f"+{reward}")
    check(s3.current_objective().key == theme.CHALLENGES[1].key,
          "and advances the ladder")
    for _ in range(len(theme.CHALLENGES) + 4):
        s3.complete_objective()
    check(s3.current_objective() is None, "the ladder ends cleanly rather than overrunning")
    check(s3.challenge_index == len(theme.CHALLENGES), "the index stops at the end",
          f"{s3.challenge_index}/{len(theme.CHALLENGES)}")

    # Corrupt and hostile saves.
    bad = tmp / "bad.json"
    bad.write_text("{not json at all", encoding="utf-8")
    s4 = SaveData(bad)
    check(s4.coins == 0 and s4.data["theme"] == theme.DEFAULT_THEME,
          "a corrupt save falls back to defaults instead of crashing")

    hostile = tmp / "hostile.json"
    hostile.write_text(json.dumps({
        "coins": -5000, "challenge_index": 999, "theme": "nonexistent",
        "unlocked_themes": ["nonexistent", 17], "high_scores": "not a dict",
        "settings": {"volume": 44.0, "sfx": "yes"},
    }), encoding="utf-8")
    s5 = SaveData(hostile)
    check(s5.coins == 0, "a negative coin count is clamped", f"{s5.coins}")
    check(s5.challenge_index <= len(theme.CHALLENGES),
          "an out-of-range objective index is clamped", f"{s5.challenge_index}")
    check(s5.data["theme"] == theme.DEFAULT_THEME, "an unknown theme falls back")
    check(all(k in theme.PALETTES_BY_KEY for k in s5.data["unlocked_themes"]),
          "junk entries are dropped from the unlock list")
    check(isinstance(s5.data["high_scores"], dict), "a malformed score table is replaced")
    check(0.0 <= s5.settings["volume"] <= 1.0, "volume is clamped into range",
          f"{s5.settings['volume']}")
    check(isinstance(s5.settings["sfx"], bool), "a wrongly-typed setting is replaced")

    s6 = SaveData(tmp / "tut.json")
    check(not s6.data["tutorial_done"], "the tutorial starts unfinished")
    s6.finish_tutorial()
    check(SaveData(tmp / "tut.json").data["tutorial_done"],
          "and stays finished across a reload")
    theme.apply(theme.DEFAULT_THEME)


def _test_themes(tmp: Path):
    section("Themes")
    from . import assets, theme, tiles

    check(len(theme.PALETTES) >= 5, "there are at least five palettes",
          f"{len(theme.PALETTES)}")
    check(sum(1 for p in theme.PALETTES if p.cost == 0) == 1,
          "exactly one palette is free")
    costs = [p.cost for p in theme.PALETTES]
    check(costs == sorted(costs), "the palettes are ordered by price", f"{costs}")
    check(all(len(p.blocks) == 7 for p in theme.PALETTES),
          "every palette defines seven block colours")

    for pal in theme.PALETTES:
        # Distinguishability: no two block colours in a palette may be near-identical, or the player
        # cannot tell them apart on the board.
        worst = 999
        pair = None
        for i in range(len(pal.blocks)):
            for j in range(i + 1, len(pal.blocks)):
                a, b = pal.blocks[i], pal.blocks[j]
                d = math.sqrt(sum((a[k] - b[k]) ** 2 for k in range(3)))
                if d < worst:
                    worst, pair = d, (i, j)
        check(worst > 55, f"{pal.name} block colours are distinguishable",
              f"closest pair {pair} at distance {worst:.0f}")
        # Contrast: a tile has to stand off the board it sits on.
        board_lum = sum(pal.board) / 3
        block_lum = min(sum(c) / 3 for c in pal.blocks)
        check(block_lum - board_lum > 60, f"{pal.name} tiles stand off the board",
              f"board {board_lum:.0f} vs dimmest tile {block_lum:.0f}")
        # An empty cell must be visible against the board without competing with a tile.
        well_lum = sum(pal.well) / 3
        check(4 < well_lum - board_lum < 40, f"{pal.name} empty cells read as cells",
              f"well {well_lum:.0f} vs board {board_lum:.0f}")

    theme.apply("neon")
    check(theme.BLOCKS == theme.PALETTES_BY_KEY["neon"].blocks,
          "applying a theme repoints the live colours")
    check(theme.block_color(9) == theme.BLOCKS[2],
          "block colours wrap rather than raising")
    theme.apply("nonexistent")
    check(theme.current.key == theme.DEFAULT_THEME,
          "an unknown theme key falls back to the default")
    theme.apply(theme.DEFAULT_THEME)


def _test_gameplay(app, surf):
    section("Gameplay")
    from .board import Board
    from .config import CLEAR_HOLD, GRID
    from .pieces import SHAPES_BY_KEY, Piece
    from .scenes.play import PlayScene, cell_pos

    sc = PlayScene(app)
    sc.enter(mode_key="endless")
    check(len(sc.pieces) == 3 and sc.board.is_empty(),
          "a new game starts with an empty board and three pieces")
    check(sc.state == "play", "and is playable immediately")

    # Placement through the real pointer path, not by calling _place directly.
    piece = sc.pieces[0]
    target = sc.board.placements(piece.cells, limit=1)[0]
    px, py = cell_pos(*target)
    grab = (int(piece.home_x + 8), int(piece.home_y + 8))
    sc._pointer_down(grab)
    check(sc.drag is piece, "pressing a tray piece picks it up")
    w, h = sc._piece_size(piece, 12)
    sc._pointer_move((px + sc._piece_size(piece, 76)[0] // 2,
                      py + sc._piece_size(piece, 76)[1] // 2 + 86))
    check(sc.preview is not None, "dragging over a legal spot shows a preview",
          f"preview {sc.preview}")
    sc._pointer_up((px + sc._piece_size(piece, 76)[0] // 2,
                    py + sc._piece_size(piece, 76)[1] // 2 + 86))
    check(piece.consumed, "releasing over a legal spot places the piece")
    check(sc.board.count_filled() == piece.shape.size,
          "exactly the shape's cells are filled", f"{sc.board.count_filled()} cells")
    check(sc.score.score > 0, "and it scores", f"{sc.score.score}")

    # An illegal drop must spring back and change nothing.
    sc2 = PlayScene(app)
    sc2.enter(mode_key="endless")
    p2 = sc2.pieces[0]
    filled_before = sc2.board.count_filled()
    score_before = sc2.score.score
    sc2._pointer_down((int(p2.home_x + 8), int(p2.home_y + 8)))
    sc2._pointer_move((10, 10))            # far off the board
    check(sc2.preview is None, "dragging off the board shows no preview")
    sc2._pointer_up((10, 10))
    check(not p2.consumed, "an illegal drop does not consume the piece")
    check(sc2.board.count_filled() == filled_before, "and does not touch the board")
    check(sc2.score.score == score_before, "and does not score")
    check(p2.return_t > 0, "it springs back instead of staying where it was dropped")
    _drive(sc2, 0.6, surf=surf)
    check(abs(p2.x - p2.home_x) < 0.6 and abs(p2.y - p2.home_y) < 0.6,
          "and arrives home", f"({p2.x - p2.home_x:.2f}, {p2.y - p2.home_y:.2f}) off")

    # A row clear, end to end.
    sc3 = PlayScene(app)
    sc3.enter(mode_key="endless")
    _fill_row(sc3.board, 4, exclude=7)
    dot = Piece(SHAPES_BY_KEY["dot"], 3, 0)
    sc3.pieces[0] = dot
    sc3._layout_tray()
    sc3._place(dot, 7, 4)
    check(len(sc3.clears) == 1, "completing a row starts a clear")
    check(sc3.board.filled(0, 4), "the cells stay on the board for the highlight")
    check(sc3.score.combo == 1, "and the combo opens")
    _drive(sc3, CLEAR_HOLD + 0.02, surf=surf)
    check(not sc3.board.filled(0, 4), "then the row is removed")
    _drive(sc3, 1.0, surf=surf)
    check(not sc3.clears, "and the animation finishes")
    check(sc3.board.count_filled() == 0, "leaving the board clear",
          f"{sc3.board.count_filled()} cells left")
    check(sc3.score.lines_cleared == 1, "one line is recorded")

    # A simultaneous row and column. A stray tile is parked well away from both lines on purpose:
    # without it the cross clears the entire board and the game correctly announces PERFECT
    # instead of DOUBLE, which is what the first version of this test tripped over.
    sc4 = PlayScene(app)
    sc4.enter(mode_key="endless")
    _fill_row(sc4.board, 0, exclude=0)
    _fill_col(sc4.board, 0, exclude=0)
    sc4.board.cells[5][5] = 4
    dot4 = Piece(SHAPES_BY_KEY["dot"], 5, 0)
    sc4.pieces[0] = dot4
    sc4._layout_tray()
    sc4._place(dot4, 0, 0)
    check(sc4.score.best_simultaneous == 2, "a cross counts as two lines",
          f"{sc4.score.best_simultaneous}")
    check(sc4.banner and sc4.banner[0] == "DOUBLE!", "and announces a DOUBLE",
          str(sc4.banner[0]) if sc4.banner else "no banner")
    _drive(sc4, 1.4, surf=surf)
    check(sc4.board.count_filled() == 1, "both lines are removed and nothing else",
          f"{sc4.board.count_filled()} left of 1 expected")

    # And the whole-board case really does say PERFECT and pay the bonus.
    sc4b = PlayScene(app)
    sc4b.enter(mode_key="endless")
    _fill_row(sc4b.board, 0, exclude=0)
    _fill_col(sc4b.board, 0, exclude=0)
    dotp = Piece(SHAPES_BY_KEY["dot"], 5, 0)
    sc4b.pieces[0] = dotp
    sc4b._layout_tray()
    sc4b._place(dotp, 0, 0)
    check(sc4b.banner and sc4b.banner[0] == "PERFECT!",
          "clearing the last tile on the board announces PERFECT",
          str(sc4b.banner[0]) if sc4b.banner else "no banner")
    check(sc4b.score.perfect_clears == 1, "and counts a perfect clear")
    _drive(sc4b, 1.4, surf=surf)
    check(sc4b.board.count_filled() == 0, "leaving nothing behind")

    # The pause button's rect must be reachable and inside the screen.
    from .config import GAME_H as _GH, GAME_W as _GW
    from .scenes.play import pause_btn
    pb = pause_btn()
    check(0 <= pb.x and pb.right <= _GW and 0 <= pb.y and pb.bottom <= _GH,
          "the pause button is on screen", f"{pb}")
    sc4._pointer_down(pb.center)
    check(any(type(s).__name__ == "PauseScene" for s in app.stack),
          "and pressing it pauses")
    while app.stack:
        app.pop()

    # The combo resets on a move that clears nothing.
    sc5 = PlayScene(app)
    sc5.enter(mode_key="endless")
    _fill_row(sc5.board, 2, exclude=7)
    d1 = Piece(SHAPES_BY_KEY["dot"], 1, 0)
    sc5.pieces[0] = d1
    sc5._layout_tray()
    sc5._place(d1, 7, 2)
    check(sc5.score.combo == 1, "combo opens on the clear")
    _drive(sc5, 1.2, surf=surf)
    d2 = Piece(SHAPES_BY_KEY["dot"], 1, 1)
    sc5.pieces[1] = d2
    sc5._layout_tray()
    sc5._place(d2, 4, 6)
    check(sc5.score.combo == 0, "and resets on a placement that clears nothing")

    # A new deal arrives only once all three are used.
    sc6 = PlayScene(app)
    sc6.enter(mode_key="endless")
    ids = [id(p) for p in sc6.pieces]
    for i in range(2):
        p = sc6.pieces[i]
        spot = sc6.board.placements(p.cells, limit=1)[0]
        sc6._place(p, *spot)
        check([id(x) for x in sc6.pieces] == ids,
              f"the tray is not refilled after {i + 1} of 3 pieces")
    last = sc6.pieces[2]
    spot = sc6.board.placements(last.cells, limit=1)
    if spot:
        sc6._place(last, *spot[0])
        check([id(x) for x in sc6.pieces] != ids, "using all three deals a new set")
        check(all(not p.consumed for p in sc6.pieces), "and the new set is unconsumed")


def _test_gameover(app, surf):
    section("Game over")
    from .board import Board
    from .config import GRID
    from .pieces import SHAPES_BY_KEY, Piece
    from .scenes.play import GameOverScene, PlayScene

    # It must not fire while a move exists — including one that is only available after a clear.
    sc = PlayScene(app)
    sc.enter(mode_key="endless")
    _drive(sc, 2.0, surf=surf)
    check(sc.state == "play", "does not fire on an empty board")

    for _ in range(30):
        placed = False
        for p in sc.pieces:
            if p.consumed:
                continue
            spots = sc.board.placements(p.cells, limit=1)
            if spots:
                sc._place(p, *spots[0])
                placed = True
                break
        _drive(sc, 0.9, surf=surf)
        if not placed:
            break
    check(sc.state != "play" or sc.board.any_placement(sc.pieces),
          "never sits in 'play' with no legal move available",
          f"state={sc.state}")

    # Now force the real thing: a board where nothing can go.
    sc2 = PlayScene(app)
    sc2.enter(mode_key="endless")
    for r in range(GRID):
        for c in range(GRID):
            sc2.board.cells[r][c] = 0
    # Leave a single hole so no shape but a dot fits, then deal only non-dots.
    sc2.board.cells[0][0] = -1
    sc2.pieces = [Piece(SHAPES_BY_KEY["h2"], 0, 0),
                  Piece(SHAPES_BY_KEY["v2"], 1, 1),
                  Piece(SHAPES_BY_KEY["square"], 2, 2)]
    sc2._layout_tray()
    check(not sc2.board.any_placement(sc2.pieces), "the fixture really has no legal move")
    sc2._pending_gameover = 0.02
    _drive(sc2, 0.4, surf=surf)
    check(sc2.state == "dying", "no legal move starts the failure sequence",
          f"state={sc2.state}")
    _drive(sc2, 1.4, surf=surf)
    check(sc2.state == "over", "which reaches the game-over state")
    check(isinstance(app.scene, GameOverScene) or any(
        isinstance(s, GameOverScene) for s in app.stack),
        "and pushes the game-over screen")

    over = next(s for s in app.stack if isinstance(s, GameOverScene))
    _drive(over, 1.2, surf=surf)
    check(app.save.high_score("endless") >= sc2.score.score,
          "the score is recorded as a high score")

    # Restart must genuinely reset.
    sc2.enter(mode_key="endless")
    check(sc2.board.is_empty() and sc2.score.score == 0 and sc2.state == "play",
          "restarting clears the board, the score and the state")
    check(len(sc2.pieces) == 3 and all(not p.consumed for p in sc2.pieces),
          "and deals a fresh tray")
    while app.stack:
        app.pop()


def _test_pause(app, surf):
    section("Pause")
    from .scenes.play import PauseScene, PlayScene

    play = PlayScene(app)
    app.stack.clear()
    app.push(play, mode_key="endless")
    _drive(play, 0.4, surf=surf)

    play.toggle_pause()
    check(isinstance(app.scene, PauseScene), "the pause button pushes the pause overlay")
    check(app.scene.transparent, "which draws the board behind it")

    # The simulation must genuinely freeze: only the top of the stack updates.
    before = play.t
    for _ in range(60):
        app._update_stack(1 / 120)
    check(play.t == before, "the game does not advance while paused",
          f"t held at {before:.3f}")

    # And a piece in hand is released rather than left glued to the cursor.
    app.pop()
    p = play.pieces[0]
    play._pointer_down((int(p.home_x + 8), int(p.home_y + 8)))
    check(play.drag is p, "picked a piece up")
    play.toggle_pause()
    check(play.drag is None, "pausing mid-drag puts the piece down")
    app.pop()
    for _ in range(60):
        app._update_stack(1 / 120)
    check(play.t > before, "and the game advances again after resuming")
    app.stack.clear()


def _test_challenge(app, surf):
    section("Challenge mode")
    from .pieces import SHAPES_BY_KEY, Piece
    from .scenes.play import PlayScene

    app.save.data["challenge_index"] = 0
    app.save.data["coins"] = 0
    sc = PlayScene(app)
    sc.enter(mode_key="challenge")
    check(sc.objective is not None, "challenge mode has an objective",
          sc.objective.key if sc.objective else "none")
    check(sc.objective.key == "lines_5", "starting at the first rung", sc.objective.key)

    # Meet it, and check the payout and the advance.
    coins_before = app.save.coins
    sc.score.lines_cleared = 5
    sc._check_objective()
    check(sc.objective_done, "meeting the target completes the objective")
    check(app.save.coins > coins_before, "which pays coins",
          f"{coins_before} -> {app.save.coins}")
    check(app.save.challenge_index == 1, "and advances the ladder")

    # The next run picks up the next rung.
    sc.enter(mode_key="challenge")
    check(sc.objective.key == "score_1500", "the next run gets the next objective",
          sc.objective.key)
    check(not sc.objective_done, "and starts incomplete")

    # A score objective.
    sc.score.score = 1500
    sc._check_objective()
    check(sc.objective_done, "a score objective completes on score")

    # Endless mode must not touch the ladder.
    idx = app.save.challenge_index
    sc.enter(mode_key="endless")
    check(sc.objective is None, "endless mode has no objective")
    sc.score.lines_cleared = 99
    sc._check_objective()
    check(app.save.challenge_index == idx, "and cannot advance the ladder")

    # Simultaneous-clear objectives read the right statistic.
    app.save.data["challenge_index"] = 2      # "clear two lines at once"
    sc.enter(mode_key="challenge")
    check(sc.objective.key == "double", "the double objective loads", sc.objective.key)
    sc.score.lines_cleared = 40               # lots of lines, never two at once
    sc._check_objective()
    check(not sc.objective_done, "which many single clears do not satisfy")
    sc.score.best_simultaneous = 2
    sc._check_objective()
    check(sc.objective_done, "but one double does")
    app.save.data["challenge_index"] = 0


def _test_tutorial(app, surf):
    section("Tutorial")
    from .pieces import SHAPES_BY_KEY, Piece
    from .scenes.play import PlayScene

    app.save.data["tutorial_done"] = False
    sc = PlayScene(app)
    sc.enter(mode_key="endless")
    check(sc.tutorial_step == 0, "a first endless game starts the tutorial")
    check(sc.tutorial_text() is not None, "and shows a hint", sc.tutorial_text())

    p = sc.pieces[0]
    sc._place(p, *sc.board.placements(p.cells, limit=1)[0])
    check(sc.tutorial_step == 1, "placing a piece advances it")
    first_hint_done = sc.tutorial_text()
    check(first_hint_done is not None and "CLEAR" in first_hint_done,
          "to the line-clearing hint", first_hint_done)

    _fill_row(sc.board, 7, exclude=7)
    dot = Piece(SHAPES_BY_KEY["dot"], 2, 1)
    sc.pieces[1] = dot
    sc._layout_tray()
    sc._place(dot, 7, 7)
    check(sc.tutorial_step == -1, "clearing a line finishes the tutorial")
    check(sc.tutorial_text() is None, "and the hint goes away")
    check(app.save.data["tutorial_done"], "which is remembered")

    sc.enter(mode_key="endless")
    check(sc.tutorial_step == -1, "a returning player is not shown it again")
    check(sc.tutorial_text() is None, "and sees no hint")

    sc2 = PlayScene(app)
    app.save.data["tutorial_done"] = False
    sc2.enter(mode_key="challenge")
    check(sc2.tutorial_step == -1, "challenge mode never runs the tutorial")
    app.save.data["tutorial_done"] = True


def _test_screens(app, surf):
    section("Screens")
    from .scenes.menu import MenuScene
    from .scenes.play import PlayScene
    from .scenes.settings import SettingsScene
    from .scenes.themes import ThemesScene

    for name, cls, kw in (("menu", MenuScene, {}),
                          ("themes", ThemesScene, {}),
                          ("settings", SettingsScene, {}),
                          ("play", PlayScene, {"mode_key": "endless"}),
                          ("challenge", PlayScene, {"mode_key": "challenge"})):
        sc = cls(app)
        sc.enter(**kw)
        _drive(sc, 1.0, surf=surf)
        check(True, f"{name} builds, updates and draws")

    # Navigation: every menu button must actually arrive somewhere.
    app.stack.clear()
    menu = MenuScene(app)
    app.push(menu)
    _drive(menu, 0.9, surf=surf)

    labels = [(w.label, w) for w in menu.group.widgets]
    check(len(labels) == 4, "the menu offers four ways in",
          ", ".join(l for l, _ in labels))
    for label, w in labels:
        app.stack.clear()
        m = MenuScene(app)
        app.push(m)
        _drive(m, 0.9, surf=surf)
        _click(app, m, w.rect.center)
        _settle(app, surf, 1.2)
        arrived = app.scene is not None and not isinstance(app.scene, MenuScene)
        check(arrived, f"{label} navigates somewhere",
              type(app.scene).__name__ if app.scene else "nothing")

    # And back from each of them.
    for cls in (ThemesScene, SettingsScene):
        app.stack.clear()
        sc = cls(app)
        app.push(sc)
        _drive(sc, 0.9, surf=surf)
        back = sc.group.widgets[-1]
        _click(app, sc, back.rect.center)
        _settle(app, surf, 1.2)
        check(isinstance(app.scene, MenuScene), f"{cls.__name__} returns to the menu",
              type(app.scene).__name__ if app.scene else "nothing")
    app.stack.clear()


def _test_theme_switching(app, surf):
    section("Theme switching")
    from . import assets, theme
    from .scenes.play import PlayScene
    from .scenes.themes import ThemesScene

    app.save.data["coins"] = 5000
    app.save.data["unlocked_themes"] = ["classic"]
    app.save.data["theme"] = "classic"
    app.save.apply_theme()

    sc = ThemesScene(app)
    sc.enter()
    _drive(sc, 0.9, surf=surf)

    neon_tab = next(tab for tab, pal in sc.cards if pal.key == "neon")
    _click(app, sc, neon_tab.rect.center)
    check(app.save.theme_unlocked("neon"), "clicking a locked theme with coins buys it")
    check(app.save.data["theme"] == "neon", "and wears it")
    check(theme.current.key == "neon", "the live palette follows", theme.current.key)
    _drive(sc, 0.9, surf=surf)

    # The board must draw in the new palette without a restart.
    play = PlayScene(app)
    play.enter(mode_key="endless")
    _drive(play, 0.6, surf=surf)
    check(theme.BLOCKS == theme.PALETTES_BY_KEY["neon"].blocks,
          "and gameplay draws with it")

    app.save.data["coins"] = 0
    sc2 = ThemesScene(app)
    sc2.enter()
    _drive(sc2, 0.6, surf=surf)
    galaxy = next(tab for tab, pal in sc2.cards if pal.key == "galaxy")
    _click(app, sc2, galaxy.rect.center)
    check(not app.save.theme_unlocked("galaxy"),
          "a locked theme with no coins stays locked")
    check(app.save.data["theme"] == "neon", "and the worn theme does not change")

    app.save.data["unlocked_themes"] = ["classic"]
    app.save.data["theme"] = "classic"
    app.save.apply_theme()
    assets.clear_cache()


def _test_window(app, surf):
    section("Window handling")
    from .config import GAME_H, GAME_W

    for size in ((720, 1280), (540, 960), (400, 900), (1080, 1920), (900, 700)):
        app.window = pygame.display.set_mode(size, pygame.RESIZABLE)
        app._layout_window()
        ok = (app.view.w <= size[0] + 1 and app.view.h <= size[1] + 1
              and abs(app.view.w / max(1, app.view.h) - GAME_W / GAME_H) < 0.02)
        check(ok, f"letterbox is correct at {size[0]}x{size[1]}",
              f"view {app.view.w}x{app.view.h}")

    centre = app.to_virtual(app.view.center)
    check(abs(centre[0] - GAME_W // 2) <= 2 and abs(centre[1] - GAME_H // 2) <= 2,
          "mouse mapping survives scaling", f"centre maps to {centre}")

    app.window = pygame.display.set_mode((GAME_W, GAME_H), pygame.RESIZABLE)
    app._layout_window()
    app.screen.fill((0, 0, 0))
    app.present()
    check(True, "presenting to the window succeeds")

    check(0.4 <= app._fit_scale() <= 1.0, "the startup window scale is sane",
          f"{app._fit_scale():.1f}")


def _test_web_paths(tmp: Path):
    section("Browser paths")
    from . import save as save_mod

    class _Storage:
        def __init__(self):
            self.data = {}

        def getItem(self, k):
            return self.data.get(k)

        def setItem(self, k, v):
            self.data[k] = v

    store = _Storage()
    real_on_web = save_mod.ON_WEB
    try:
        save_mod.ON_WEB = True
        s = save_mod.SaveData.__new__(save_mod.SaveData)
        # The store is built by hand rather than constructed, because its constructor reaches for
        # pygbag's JS bridge, which does not exist here. `_ls` is the handle it would have found.
        s.store = save_mod._WebStore.__new__(save_mod._WebStore)
        s.store._ls = store
        s.path = None
        s.data = save_mod._defaults()
        s.dirty = True
        s.readonly = False
        check(s.flush(), "the browser save writes to localStorage")
        check(save_mod.WEB_KEY in store.data, "under the expected key", save_mod.WEB_KEY)

        s.data["coins"] = 77
        s.dirty = True
        s.flush()
        raw = json.loads(store.data[save_mod.WEB_KEY])
        check(raw["coins"] == 77, "and round-trips its values")

        class _Refuses:
            def getItem(self, k):
                raise RuntimeError("blocked")

            def setItem(self, k, v):
                raise RuntimeError("blocked")

        s.store._ls = _Refuses()
        s.dirty = True
        check(s.flush() is False, "storage that refuses is handled, not fatal")
        check(s.store.read() is None, "and reading from it returns nothing rather than raising")

        s.store._ls = None
        s.dirty = True
        check(s.flush() is False, "storage that is absent is handled too")
        check("unavailable" in s.store.describe(), "and says so", s.store.describe())
    finally:
        save_mod.ON_WEB = real_on_web


def _test_async_driver(tmp: Path, surf):
    section("Async frame driver")
    import asyncio

    from .scenes.menu import MenuScene

    app = _fresh_app(tmp / "async.json")
    scene = MenuScene(app)
    asyncio.run(app.run_async(scene, max_frames=24))
    check(app.frame >= 24, "the browser driver advances frames", f"{app.frame} frames")
    check(not app.running, "and stops when asked")


def _test_import_safety():
    section("Import safety")
    import ast
    import pathlib

    # pygbag's pygame is a lazy proxy whose members do not exist while a module body runs, so any
    # pygame call at import time is fatal in the browser and invisible on the desktop. This walks
    # the source rather than trusting a convention.
    root = pathlib.Path(__file__).parent
    offenders = []
    for path in sorted(root.rglob("*.py")):
        if path.name in ("selftest.py", "shots.py"):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in tree.body:
            # Only module-level statements matter; inside a function is evaluated later.
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                                 ast.Import, ast.ImportFrom)):
                continue
            for sub in ast.walk(node):
                if not isinstance(sub, ast.Call):
                    continue
                fn = sub.func
                name = None
                if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name):
                    name = f"{fn.value.id}.{fn.attr}"
                elif isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Attribute):
                    name = f"{fn.value.attr}.{fn.attr}"
                if name and name.startswith("pygame."):
                    offenders.append(f"{path.name}:{sub.lineno} {name}")
    check(not offenders, "nothing calls pygame at import time",
          "clean" if not offenders else "; ".join(offenders))


def _test_numpy_free():
    section("Rendering without numpy")
    from . import assets

    # The browser ships no numpy, so the fallbacks are the shipping path rather than insurance.
    check(hasattr(assets, "HAVE_NUMPY"), "the numpy fast path is optional by construction")
    check(assets.glow(24, (0, 200, 255), peak=200).get_size() == (48, 48),
          "glows generate at the requested size")
    g = assets.glow(24, (0, 200, 255), peak=200)
    centre = g.get_at((24, 24))[:3]
    edge = g.get_at((1, 24))[:3]
    check(sum(centre) > sum(edge), "and ramp from bright centre to dark edge",
          f"centre {centre} vs edge {edge}")
    check(assets.glow(24, (0, 200, 255), peak=200) is g, "and are cached")


def _test_tiles():
    section("Tile rendering")
    from . import assets, theme, tiles

    theme.apply("classic")
    t = tiles.tile(76, theme.block_color(0))
    check(t.get_width() > 76, "a tile carries padding for its shadow",
          f"{t.get_width()}px for a 76px tile")
    check(t is tiles.tile(76, theme.block_color(0)), "and is cached")

    # The gradient has to actually vary, or the tile is flat.
    pad = (t.get_width() - 76) // 2
    top = t.get_at((pad + 38, pad + 6))[:3]
    bottom = t.get_at((pad + 38, pad + 70))[:3]
    check(sum(top) > sum(bottom) + 40, "the body is lit at the top and deep at the bottom",
          f"top {top} vs bottom {bottom}")

    # The corners must be transparent, or the rounding is not happening.
    check(t.get_at((pad + 1, pad + 1))[3] < 120, "the corners are rounded",
          f"corner alpha {t.get_at((pad + 1, pad + 1))[3]}")

    # A lit theme's halo has to reach past the tile edge, which is the bug that shipped invisible
    # the first time: the glow was narrower than the tile it was meant to surround.
    theme.apply("neon")
    h = tiles.halo(76, theme.block_color(0))
    reach = (h.get_width() - 76) // 2
    check(reach >= 12, "a lit theme's halo reaches past the tile", f"{reach}px of reach")
    at_edge = h.get_at((h.get_width() // 2 + 38, h.get_height() // 2))[:3]
    check(sum(at_edge) > 30, "and is still bright at the tile's edge", f"{at_edge}")

    dest = pygame.Surface((200, 200)).convert()
    dest.fill(theme.BOARD)
    before = dest.get_at((100, 50))[:3]
    tiles.blit_halo(dest, 76, theme.block_color(0), (62, 62))
    after = dest.get_at((100, 50))[:3]
    check(sum(after) > sum(before), "and lands on the board when blitted",
          f"{before} -> {after}")

    theme.apply("classic")
    w = tiles.well(76)
    check(w.get_size() == (76, 76), "an empty cell is exactly one cell")
    lf = tiles.line_flash(600, 76, theme.ACCENT_2, 40)
    check(lf.get_size() == (600, 76), "the line highlight spans a whole row")


# ── performance ─────────────────────────────────────────────────────────────────
def _test_performance(app, surf):
    section("Performance")
    from .board import Board
    from .scenes.menu import MenuScene
    from .scenes.play import PlayScene
    from .scenes.settings import SettingsScene
    from .scenes.themes import ThemesScene

    def best_ms(scene, batches=4, frames=14):
        out = []
        for _ in range(batches):
            t0 = time.perf_counter()
            for _ in range(frames):
                scene.draw(surf)
            out.append((time.perf_counter() - t0) / frames * 1000.0)
        return min(out)

    # A worst case for the board: nearly full, a clear in flight, particles going.
    play = PlayScene(app)
    play.enter(mode_key="endless")
    for r in range(8):
        for c in range(8):
            play.board.cells[r][c] = (r + c) % 7
    play.board.cells[3][3] = -1
    play._begin_clear([5], [2])
    _drive(play, 0.3, surf=surf)
    for _ in range(3):
        play.particles.burst((360, 600), 80, (255, 200, 80), speed=(60, 400), life=(6.0, 8.0))
    _drive(play, 0.2, surf=surf)

    worst = ("play", best_ms(play))
    rows = [worst]
    for name, cls in (("menu", MenuScene), ("themes", ThemesScene),
                      ("settings", SettingsScene)):
        sc = cls(app)
        sc.enter()
        _drive(sc, 0.5, surf=surf)
        # Both phases: mid-entrance, when every widget is composed on a layer, and settled.
        sc.t = 0.15
        early = best_ms(sc)
        sc.t = 3.0
        late = best_ms(sc)
        rows.append((name, max(early, late)))

    for name, ms in rows:
        check(ms < 16.6, f"{name} fits inside the 60fps budget",
              f"{ms:.2f}ms best ({1000 / ms:.0f} fps equivalent)")

    slowest = max(rows, key=lambda kv: kv[1])
    # The browser runs Python roughly 3-6x slower, so a native frame has to come in well under the
    # native budget for the WebAssembly build to hold 60fps. This is the number that matters.
    check(slowest[1] < 9.0, "and leaves headroom for the WebAssembly build",
          f"slowest is {slowest[0]} at {slowest[1]:.2f}ms; "
          f"~{slowest[1] * 4:.0f}ms in the browser")

    # The structural half: composing a frame must not allocate full-screen surfaces.
    real_surface = pygame.Surface
    big = []

    class _Counting(real_surface):
        def __init__(self, size, *a, **kw):
            if size[0] >= 720 and size[1] >= 1280:
                big.append(tuple(size))
            super().__init__(size, *a, **kw)

    scenes = [play]
    for cls in (MenuScene, ThemesScene, SettingsScene):
        sc = cls(app)
        sc.enter()
        _drive(sc, 0.5, surf=surf)
        scenes.append(sc)

    pygame.Surface = _Counting
    try:
        for sc in scenes:
            sc.t = 0.15
            sc.draw(surf)
            sc.t = 3.0
            sc.draw(surf)
    finally:
        pygame.Surface = real_surface
    check(not big, "drawing a frame allocates no full-screen surfaces",
          "none, across every screen" if not big else f"{len(big)} allocated")

    check(play.particles.live <= 700, "the particle pool respects its ceiling",
          f"{play.particles.live} live")


def _test_endurance(app, surf):
    section("Endurance")
    from .board import Board
    from .scenes.play import PlayScene

    sc = PlayScene(app)
    sc.enter(mode_key="endless")
    rng = random.Random(99)
    runs = 0
    placements = 0
    lines = 0
    for _ in range(12000):
        if sc.state != "play":
            lines += sc.score.lines_cleared
            runs += 1
            sc.enter(mode_key="endless")
            if runs >= 6:
                break
            continue
        acted = False
        for p in sc.pieces:
            if p.consumed:
                continue
            spots = sc.board.placements(p.cells, limit=48)
            if spots:
                sc._place(p, *rng.choice(spots))
                placements += 1
                acted = True
                break
        _drive(sc, 0.08, surf=surf)
        if not acted:
            _drive(sc, 0.9, surf=surf)

    check(runs >= 3, "many complete runs finish without raising",
          f"{runs} runs, {placements} placements, {lines} lines cleared")
    check(len(sc.cell_anim) <= 64, "the placement-animation table stays bounded",
          f"{len(sc.cell_anim)} entries")
    check(len(sc.clears) <= 4, "clear animations do not accumulate", f"{len(sc.clears)}")
    check(sc.particles.live <= 700, "particles stay inside the pool",
          f"{sc.particles.live} live")
    from . import assets
    check(len(assets._cache) < 2600, "the sprite cache stays bounded",
          f"{len(assets._cache)} entries")


# ── runner ──────────────────────────────────────────────────────────────────────
def run_selftest() -> int:
    global _passed, _failed
    _passed = 0
    _failed = []

    t0 = time.perf_counter()
    tmp = Path(tempfile.mkdtemp(prefix="blockbloom-test-"))

    # Rules first: these need no display at all, so a failure here is unambiguous.
    _test_shapes()
    _test_board()
    _test_generator()
    _test_scoring()
    _test_save(tmp)

    app = _fresh_app(tmp / "main.json")
    surf = pygame.Surface((720, 1280))

    _test_themes(tmp)
    _test_tiles()
    _test_numpy_free()
    _test_gameplay(app, surf)
    _test_gameover(app, surf)
    _test_pause(app, surf)
    _test_challenge(app, surf)
    _test_tutorial(app, surf)
    _test_screens(app, surf)
    _test_theme_switching(app, surf)
    _test_window(app, surf)
    _test_web_paths(tmp)
    _test_import_safety()
    _test_async_driver(tmp, surf)

    # Timing last, and on a fresh app, so nothing above has left caches cold or hot in a way that
    # skews it.
    app2 = _fresh_app(tmp / "perf.json")
    _test_performance(app2, surf)
    _test_endurance(app2, surf)

    elapsed = time.perf_counter() - t0
    print()
    if _failed:
        print(_c(f"{len(_failed)} of {_passed + len(_failed)} checks FAILED", "31;1"))
        for f in _failed:
            print(f"  - {f}")
        return 1
    print(_c(f"all {_passed} checks passed", "32;1") + _c(f"  in {elapsed:.1f}s", "2"))
    return 0
