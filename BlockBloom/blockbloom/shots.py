"""
Write a PNG of every screen, for visual review.

Separate from the test suite because it answers a different question. The suite asks "does it
work"; this asks "does it look right", and only a person can answer that. Every screen is advanced
by a fixed simulated time before it is captured, so entrances have finished and the images are
comparable between runs.
"""

from __future__ import annotations

import os
from pathlib import Path


def write_shots(out_dir: str) -> int:
    import pygame

    from . import assets, theme
    from .app import App
    from .board import Board
    from .save import SaveData
    from .scenes.menu import MenuScene
    from .scenes.play import GameOverScene, PauseScene, PlayScene
    from .scenes.settings import SettingsScene
    from .scenes.themes import ThemesScene

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    import tempfile
    app = App(headless=True)
    app.save = SaveData(Path(tempfile.mkdtemp()) / "shots.json")
    # A save with some history, so the screens are not all showing zeros — an empty save hides
    # exactly the layout problems these images exist to find.
    app.save.data["coins"] = 900
    app.save.data["high_scores"]["endless"] = 24680
    app.save.data["challenge_index"] = 3
    app.save.data["tutorial_done"] = True
    app.save.apply_theme()

    surf = pygame.Surface((720, 1280)).convert()

    def capture(name: str, scene, seconds: float = 1.4, under=None):
        for _ in range(int(seconds * 120)):
            if under is not None:
                under.update(1 / 120)
            scene.update(1 / 120)
        if under is not None:
            under.draw(surf)
        scene.draw(surf)
        pygame.image.save(surf, str(out / f"{name}.png"))
        print(f"  wrote {name}.png")

    def fresh_play(mode="endless", fill=True):
        sc = PlayScene(app)
        sc.enter(mode_key=mode)
        if fill:
            # A believable mid-game board: a scattering of tiles plus a row that is one cell short,
            # which is the state worth looking at.
            import random
            rng = random.Random(11)
            for _ in range(26):
                c, r = rng.randrange(8), rng.randrange(8)
                sc.board.cells[r][c] = rng.randrange(7)
            # Row 5 one cell short, and that cell forced empty *after* the scatter — otherwise the
            # scatter can fill it and the drag shot ends up previewing onto an occupied cell.
            for c in range(7):
                sc.board.cells[5][c] = (c * 3) % 7
            sc.board.cells[5][7] = -1
            sc.score.score = 12480
            sc.score.snap()
            sc.score.combo = 3
            sc.score.lines_cleared = 14
            sc.score.best_combo = 4
            sc.score.pieces_placed = 38
        return sc

    capture("01-menu", MenuScene(app))
    capture("02-themes", ThemesScene(app))
    capture("03-settings", SettingsScene(app))

    play = fresh_play()
    capture("04-play", play)

    # Mid-drag, with a ghost preview over a row that would complete: the single most important
    # frame in the game to get right.
    play2 = fresh_play()
    piece = next(p for p in play2.pieces if not p.consumed)
    from .pieces import SHAPES_BY_KEY, Piece
    piece = Piece(SHAPES_BY_KEY["dot"], 4, piece.slot)
    play2._layout_tray()
    play2.pieces[0] = piece
    play2._layout_tray()
    play2.drag = piece
    piece.drag = True
    piece.lift = 1.0
    from .scenes.play import cell_pos
    from .config import DRAG_LIFT_Y
    gx, gy = cell_pos(7, 5)
    # Held a little above and left of the target, the way a hand actually holds it — sitting exactly
    # on the ghost hides the ghost and makes the shot useless for judging the preview.
    piece.x, piece.y = float(gx - 14), float(gy - DRAG_LIFT_Y + 18)
    play2.preview = (7, 5)
    capture("05-play-dragging", play2, seconds=0.4)

    # A clear in flight.
    play3 = fresh_play()
    play3.board.cells[5][7] = 2
    play3._begin_clear([5], [])
    capture("06-play-clearing", play3, seconds=0.22)

    play4 = fresh_play()
    pause = PauseScene(app)
    pause.enter(play=play4)
    capture("07-pause", pause, under=play4)

    play5 = fresh_play()
    play5.score.snap()
    over = GameOverScene(app)
    over.enter(play=play5, result={"new_high": True, "coins": 34})
    capture("08-gameover", over, under=play5)

    # Every theme, on the same board, so palettes can be compared rather than imagined.
    for pal in theme.PALETTES:
        app.save.data["theme"] = pal.key
        app.save.apply_theme()
        assets.clear_cache()
        from . import fonts, ui
        fonts.clear_cache()
        ui.drop_layers()
        capture(f"09-theme-{pal.key}", fresh_play(), seconds=1.0)

    print(f"\n{len(list(out.glob('*.png')))} images in {out}")
    return 0
