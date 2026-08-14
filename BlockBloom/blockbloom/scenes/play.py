"""
The board, the tray, and everything that happens between picking a piece up and putting it down.

Three things in here are worth reading before changing anything.

**Input goes through one pointer path.** `_pointer_down/_move/_up` take a position in virtual
coordinates, and mouse events and touch events both feed them. Nothing below that trio knows which
device it is serving, which is what makes the game work under a browser's synthesised touch events
without a second code path to keep in step.

**The board is authoritative; animations only ever hold pictures.** When a line clears, the cells
stay in the board for the highlight, and are then removed — at which point the clear animation
holds nothing but captured colours and positions. No animation is ever consulted about what is on
the board, so the two cannot disagree about what has been scored.

**Snapping is measured from the piece, not the cursor.** The target cell is derived from where the
piece's own top-left cell has landed, so a five-long piece placed at the edge of the board goes
where it looks like it will. Requiring the cursor to be inside the target cell was the first
version and it felt like fighting the game.
"""

from __future__ import annotations

import math
import random

import pygame

from .. import assets, audio, fonts, theme, tiles, ui
from ..app import Scene
from ..background import Backdrop
from ..board import EMPTY, Board
from ..config import (
    BOARD_PAD, BOARD_RADIUS, BOARD_W, BOARD_X, BOARD_Y, BOARD_PULSE_TIME, CELL, CELL_GAP,
    CLEAR_CELL_TIME, CLEAR_HOLD, CLEAR_STAGGER, DRAG_LIFT_Y, DRAG_SCALE_TIME, GAME_H, GAME_W,
    GRID, HUD_TOP, PLACE_BOUNCE_TIME, RETURN_TIME, TRAY_CELL, TRAY_GAP, TRAY_H, TRAY_SLOTS,
    TRAY_SLOT_W, TRAY_Y,
)
from ..fx import Floaters, Particles, Ripples, Screen, ease_out_back, ease_out_cubic
from ..generator import Generator
from ..scoring import Scoring, clear_banner

_STRIDE = CELL + CELL_GAP

# Rects are built on first use, never at import. Under pygbag the `pygame` name is a lazy proxy
# whose members do not exist yet while a module body runs, so a `pygame.Rect(...)` at module scope
# is fatal in the browser and completely invisible on the desktop. This was written as a module
# constant first, with a comment arguing it was safe; the suite's AST guard disagreed and the guard
# was right. Geometry is cheap to memoise, so there is nothing lost.
_pause_btn: "pygame.Rect | None" = None
_board_rect: "pygame.Rect | None" = None


def cell_pos(col: int, row: int) -> tuple[int, int]:
    """Top-left pixel of a board cell."""
    return (BOARD_X + BOARD_PAD + col * _STRIDE, BOARD_Y + BOARD_PAD + row * _STRIDE)


def pause_btn() -> "pygame.Rect":
    """The pause button, in virtual coordinates.

    One accessor because the draw and the hit test both need it and they must not be able to drift
    apart — the last thing a player should have to discover is a button that looks like it is
    somewhere it is not.
    """
    global _pause_btn
    if _pause_btn is None:
        _pause_btn = pygame.Rect(GAME_W - 84, HUD_TOP + 2, 56, 56)
    return _pause_btn


def board_rect() -> "pygame.Rect":
    global _board_rect
    if _board_rect is None:
        _board_rect = pygame.Rect(BOARD_X, BOARD_Y, BOARD_W, BOARD_W)
    return _board_rect


class ClearFx:
    """One line-clear, in flight.

    Holds captured colours and positions — never a reference to the board — so it cannot disagree
    with the authoritative grid. `hold` keeps the tiles on the board while they flash; after that
    the scene removes them and this object is all that draws them.
    """

    __slots__ = ("cells", "t", "weight", "removed", "lines", "origin")

    def __init__(self, cells, weight: float, lines: int):
        # (col, row, colour index, stagger delay). The delay runs along the line so the clear reads
        # as a sweep rather than a simultaneous blink.
        self.cells = cells
        self.t = 0.0
        self.weight = weight
        self.lines = lines
        self.removed = False
        self.origin = None

    @property
    def duration(self) -> float:
        last = max((d for *_, d in self.cells), default=0.0)
        return CLEAR_HOLD + last + CLEAR_CELL_TIME

    def done(self) -> bool:
        return self.t >= self.duration


class PlayScene(Scene):
    def __init__(self, app):
        super().__init__(app)
        # Quiet backdrop behind gameplay: fewer blobs, lower intensity. The board is the thing the
        # eye should read.
        self.backdrop = Backdrop((GAME_W, GAME_H), intensity=0.55, seed=23, blobs=3)
        self.particles = Particles()
        self.floaters = Floaters()
        self.ripples = Ripples()
        self.screen_fx = Screen()

        self.board = Board()
        self.gen = Generator()
        self.score = Scoring()

        self.mode_key = "endless"
        self.pieces: list = []
        self.drag = None
        self.drag_offset = (0, 0)
        self.preview = None          # (col, row) when the dragged piece would land legally
        self.clears: list = []
        self.cell_anim: dict = {}    # (col, row) -> seconds since placed, for the bounce
        self.board_pulse = 0.0
        self.state = "play"          # play | dying | over
        self.state_t = 0.0
        self.banner = None           # (text, weight, age)
        self.tutorial_step = 0
        self.objective = None
        self.objective_done = False
        self._pending_gameover = 0.0

    # ── lifecycle ───────────────────────────────────────────────────────────────
    def enter(self, mode_key: str = "endless", **kwargs):
        self.mode_key = mode_key if mode_key in ("endless", "challenge") else "endless"
        self.board.clear()
        self.gen = Generator()
        self.score = Scoring()
        self.pieces = self.gen.deal(self.board)
        self._layout_tray()
        self.drag = None
        self.preview = None
        self.clears.clear()
        self.cell_anim.clear()
        self.board_pulse = 0.0
        self.state = "play"
        self.state_t = 0.0
        self.banner = None
        self.particles.clear()
        self.floaters.clear()
        self.ripples.clear()
        self.screen_fx.clear()
        self._pending_gameover = 0.0

        save = self.app.save
        self.objective = save.current_objective() if self.mode_key == "challenge" else None
        self.objective_done = False
        # The tutorial only ever runs on a first endless game. Interrupting a returning player is
        # the fastest way to make a tutorial feel like an obstacle.
        self.tutorial_step = 0 if (self.mode_key == "endless"
                                   and not save.data.get("tutorial_done")) else -1
        audio.duck_music(False)

    def leave(self):
        self.app.save.flush()

    # ── tray geometry ───────────────────────────────────────────────────────────
    def _slot_center(self, slot: int) -> tuple[int, int]:
        return (TRAY_SLOT_W * slot + TRAY_SLOT_W // 2, TRAY_Y + TRAY_H // 2)

    def _piece_size(self, piece, cell: int) -> tuple[int, int]:
        stride = cell + (TRAY_GAP if cell == TRAY_CELL else CELL_GAP)
        return (piece.shape.w * stride - (stride - cell),
                piece.shape.h * stride - (stride - cell))

    def _layout_tray(self) -> None:
        """Park each piece in the middle of its slot, at tray scale."""
        for i, p in enumerate(self.pieces):
            cx, cy = self._slot_center(i)
            w, h = self._piece_size(p, TRAY_CELL)
            p.home_x = cx - w / 2.0
            p.home_y = cy - h / 2.0
            p.x, p.y = p.home_x, p.home_y
            p.bob = i * 1.7

    # ── input ───────────────────────────────────────────────────────────────────
    def handle(self, event):
        if event.type == pygame.KEYDOWN:
            if event.key in (pygame.K_ESCAPE, pygame.K_p):
                self.toggle_pause()
            elif event.key == pygame.K_r:
                self.enter(mode_key=self.mode_key)
            return

        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            self._pointer_down(event.pos)
        elif event.type == pygame.MOUSEBUTTONUP and event.button == 1:
            self._pointer_up(event.pos)
        elif event.type == pygame.MOUSEMOTION:
            self._pointer_move(event.pos)

        # Touch, routed into the same three calls. SDL reports finger positions normalised to the
        # window, so they need the same window-to-virtual conversion the mouse path already gets.
        elif event.type in (pygame.FINGERDOWN, pygame.FINGERMOTION, pygame.FINGERUP):
            pos = self._finger_pos(event)
            if event.type == pygame.FINGERDOWN:
                self._pointer_down(pos)
            elif event.type == pygame.FINGERMOTION:
                self._pointer_move(pos)
            else:
                self._pointer_up(pos)

    def _finger_pos(self, event) -> tuple[int, int]:
        ww, wh = self.app.window.get_size()
        return self.app.to_virtual((event.x * ww, event.y * wh))

    def _pointer_down(self, pos) -> None:
        if pause_btn().collidepoint(pos):
            self.toggle_pause()
            return
        if self.state != "play":
            return
        for p in self.pieces:
            if p.consumed:
                continue
            if self._piece_hitbox(p).collidepoint(pos):
                self.drag = p
                p.drag = True
                p.return_t = 0.0
                # Centre the piece on the pointer and lift it clear, so the preview underneath is
                # never hidden by the cursor or by a finger.
                w, h = self._piece_size(p, CELL)
                self.drag_offset = (-w / 2.0, -h / 2.0 - DRAG_LIFT_Y)
                self._drag_to(pos)
                audio.pickup()
                return

    def _piece_hitbox(self, piece) -> pygame.Rect:
        """A generous grab area: the slot's full height, and the piece's width plus a margin.

        Hit-testing the individual cells of an L-shape means the middle of the L is not grabbable,
        which players read as the game ignoring them.
        """
        w, h = self._piece_size(piece, TRAY_CELL)
        r = pygame.Rect(int(piece.home_x), int(piece.home_y), w, h)
        return r.inflate(46, 46)

    def _pointer_move(self, pos) -> None:
        if self.drag is not None:
            self._drag_to(pos)

    def _drag_to(self, pos) -> None:
        p = self.drag
        p.x = pos[0] + self.drag_offset[0]
        p.y = pos[1] + self.drag_offset[1]
        self.preview = self._snap_target(p)

    def _snap_target(self, piece):
        """Which board origin the piece would occupy, or None if that is not a legal placement."""
        ox, oy = cell_pos(0, 0)
        col = int(round((piece.x - ox) / _STRIDE))
        row = int(round((piece.y - oy) / _STRIDE))
        if not (0 <= col <= GRID - piece.shape.w and 0 <= row <= GRID - piece.shape.h):
            return None
        return (col, row) if self.board.can_place(piece.cells, col, row) else None

    def _pointer_up(self, pos) -> None:
        p = self.drag
        if p is None:
            return
        self.drag = None
        p.drag = False
        target = self._snap_target(p)
        if target is None:
            # Spring back. Rejected placements happen constantly, so this is quiet and quick.
            p.return_t = RETURN_TIME
            p.return_from = (p.x, p.y)
            self.preview = None
            audio.invalid()
            return
        self._place(p, target[0], target[1])

    # ── placing ─────────────────────────────────────────────────────────────────
    def _place(self, piece, col: int, row: int) -> None:
        written = self.board.place(piece.cells, col, row, piece.color_index)
        piece.consumed = True
        piece.drag = False
        piece.lift = 0.0
        self.preview = None
        self.gen.note_move()
        gained = self.score.place(len(written))
        audio.place()

        for c, r in written:
            self.cell_anim[(c, r)] = 0.0
        colour = theme.block_color(piece.color_index)
        cx, cy = cell_pos(col, row)
        w, h = self._piece_size(piece, CELL)
        if self.app.save.settings.get("particles", True):
            self.particles.burst((cx + w / 2, cy + h / 2), 8 + 2 * len(written), colour,
                                 speed=(40, 150), size=(2, 5), life=(0.18, 0.34))
        self.screen_fx.kick(1.4)

        rows, cols = self.board.complete_lines()
        if rows or cols:
            self._begin_clear(rows, cols)
        else:
            self.score.no_clear()
            self.banner = None
            if gained and self.mode_key == "endless" and self.tutorial_step == 0:
                self._advance_tutorial()

        if all(p.consumed for p in self.pieces):
            self.pieces = self.gen.deal(self.board)
            self._layout_tray()

        # Resolved after the deal, and only once nothing is still clearing — a clear frees space,
        # so testing before it lands would end runs that are not over.
        self._pending_gameover = 0.05

    def _begin_clear(self, rows, cols) -> None:
        cells = Board.line_cells(rows, cols, self.board.size)
        lines = len(rows) + len(cols)
        emptied = len(cells) == self.board.count_filled()
        gained, weight = self.score.clear(lines, board_emptied=emptied)

        # Stagger runs outward from the middle of the cleared set, so a row sweeps from its centre
        # and a cross detonates from its intersection.
        mid_c = sum(c for c, _ in cells) / len(cells)
        mid_r = sum(r for _, r in cells) / len(cells)
        captured = []
        for c, r in cells:
            d = math.hypot(c - mid_c, r - mid_r)
            captured.append((c, r, self.board.at(c, r), d * CLEAR_STAGGER))

        fx = ClearFx(captured, weight, lines)
        fx.origin = (mid_c, mid_r)
        self.clears.append(fx)

        self.board_pulse = BOARD_PULSE_TIME
        banner = clear_banner(lines, self.score.combo)
        if banner:
            self.banner = [banner[0], banner[1], 0.0]
        if emptied:
            self.banner = ["PERFECT!", 1.0, 0.0]

        audio.line_clear(lines, self.score.combo)
        if self.score.combo >= 2:
            audio.combo_up(self.score.combo)

        settings = self.app.save.settings
        if settings.get("shake", True):
            self.screen_fx.kick(3.0 + 9.0 * weight)
        self.screen_fx.do_flash(theme.ACCENT, 0.06 + 0.20 * weight)

        px, py = cell_pos(int(round(mid_c)), int(round(mid_r)))
        self.floaters.add(px + CELL // 2, py, f"+{gained:,}", theme.GOLD,
                          size=int(26 + 26 * weight), life=1.0, vy=-70.0)
        self.ripples.add(px + CELL // 2, py + CELL // 2, 20, int(180 + 260 * weight),
                         theme.ACCENT, life=0.5 + 0.2 * weight, width=4)

        if self.tutorial_step == 1:
            self._advance_tutorial()
        self._check_objective()

    # ── tutorial ────────────────────────────────────────────────────────────────
    def _advance_tutorial(self) -> None:
        self.tutorial_step += 1
        if self.tutorial_step >= 2:
            self.tutorial_step = -1
            self.app.save.finish_tutorial()

    def tutorial_text(self) -> str | None:
        if self.tutorial_step == 0:
            return "DRAG A BLOCK ONTO THE BOARD"
        if self.tutorial_step == 1:
            return "FILL A ROW OR COLUMN TO CLEAR IT"
        return None

    # ── challenge ───────────────────────────────────────────────────────────────
    def _check_objective(self) -> None:
        obj = self.objective
        if obj is None or self.objective_done:
            return
        s = self.score
        hit = False
        if obj.key.startswith("lines_"):
            hit = s.lines_cleared >= obj.target
        elif obj.key.startswith("score_"):
            hit = s.score >= obj.target
        elif obj.key.startswith("combo_"):
            hit = s.best_combo >= obj.target
        elif obj.key == "double":
            hit = s.best_simultaneous >= 2
        elif obj.key == "triple":
            hit = s.best_simultaneous >= 3
        elif obj.key.startswith("moves_"):
            hit = s.pieces_placed >= obj.target
        if hit:
            self.objective_done = True
            reward = self.app.save.complete_objective()
            self.banner = ["OBJECTIVE CLEAR", 1.0, 0.0]
            self.floaters.add(GAME_W // 2, BOARD_Y - 40, f"+{reward} COINS", theme.GOLD,
                              size=30, life=1.4, vy=-50.0)
            audio.reward()
            if self.app.save.settings.get("particles", True):
                self.particles.ring((GAME_W // 2, BOARD_Y + BOARD_W // 2), 34, theme.GOLD,
                                    radius_speed=(220, 400), size=(4, 9), life=(0.6, 1.1))

    # ── pause ───────────────────────────────────────────────────────────────────
    def toggle_pause(self) -> None:
        if self.state != "play":
            return
        # Dropping the piece rather than keeping it in hand: resuming with a piece still glued to
        # a cursor that has since moved somewhere else is disorienting.
        if self.drag is not None:
            p, self.drag = self.drag, None
            p.drag = False
            p.return_t = RETURN_TIME
            p.return_from = (p.x, p.y)
            self.preview = None
        audio.click()
        self.app.push(PauseScene(self.app), play=self)

    # ── frame ───────────────────────────────────────────────────────────────────
    def update(self, dt: float):
        self.t += dt
        self.state_t += dt
        self.backdrop.update(dt)
        self.particles.update(dt)
        self.floaters.update(dt)
        self.ripples.update(dt)
        self.screen_fx.update(dt)
        self.score.update(dt)

        if self.board_pulse > 0.0:
            self.board_pulse = max(0.0, self.board_pulse - dt)
        if self.banner is not None:
            self.banner[2] += dt
            if self.banner[2] > 1.5:
                self.banner = None

        for key in list(self.cell_anim):
            self.cell_anim[key] += dt
            if self.cell_anim[key] > PLACE_BOUNCE_TIME:
                del self.cell_anim[key]

        for p in self.pieces:
            p.lift = ui.approach(p.lift, 1.0 if p.drag else 0.0, 1.0 / max(1e-4, DRAG_SCALE_TIME), dt)
            if p.return_t > 0.0:
                p.return_t = max(0.0, p.return_t - dt)
                k = 1.0 - (p.return_t / RETURN_TIME)
                e = ease_out_back(k, 1.1)
                p.x = p.return_from[0] + (p.home_x - p.return_from[0]) * e
                p.y = p.return_from[1] + (p.home_y - p.return_from[1]) * e
                if p.return_t == 0.0:
                    p.x, p.y = p.home_x, p.home_y

        self._update_clears(dt)

        if self._pending_gameover > 0.0 and not self.clears:
            self._pending_gameover = max(0.0, self._pending_gameover - dt)
            if self._pending_gameover == 0.0:
                self._resolve_gameover()

        if self.state == "dying" and self.state_t > 0.9:
            self._finish()

    def _update_clears(self, dt: float) -> None:
        for fx in list(self.clears):
            fx.t += dt
            if not fx.removed and fx.t >= CLEAR_HOLD:
                # The highlight is over: the cells leave the board and this object becomes the only
                # thing that draws them.
                fx.removed = True
                self.board.remove([(c, r) for c, r, _, _ in fx.cells])
                self._burst_clear(fx)
            if fx.done():
                self.clears.remove(fx)

    def _burst_clear(self, fx) -> None:
        if not self.app.save.settings.get("particles", True):
            return
        per = 5 + int(9 * fx.weight)
        for c, r, ci, _ in fx.cells:
            x, y = cell_pos(c, r)
            self.particles.burst((x + CELL / 2, y + CELL / 2), per,
                                 theme.block_color(ci),
                                 speed=(90, 260 + 220 * fx.weight), size=(3, 8),
                                 life=(0.3, 0.6 + 0.3 * fx.weight))
        if fx.weight >= 0.6 and fx.origin:
            ox, oy = cell_pos(int(round(fx.origin[0])), int(round(fx.origin[1])))
            self.particles.ring((ox + CELL / 2, oy + CELL / 2), 20 + int(18 * fx.weight),
                                theme.ACCENT_2, radius_speed=(240, 460), size=(4, 9),
                                life=(0.45, 0.85))

    def _resolve_gameover(self) -> None:
        if self.state != "play":
            return
        if self.board.any_placement(self.pieces):
            return
        self.state = "dying"
        self.state_t = 0.0
        audio.game_over()
        self.screen_fx.kick(6.0)

    def _finish(self) -> None:
        self.state = "over"
        self.state_t = 0.0
        self.score.snap()
        coins = self.score.coins_earned()
        result = self.app.save.record_run(
            self.mode_key, score=self.score.score, combo=self.score.best_combo,
            lines=self.score.lines_cleared, simultaneous=self.score.best_simultaneous,
            coins=coins)
        self.app.push(GameOverScene(self.app), play=self, result=result)

    # ── drawing ─────────────────────────────────────────────────────────────────
    def draw(self, surf: pygame.Surface):
        ox, oy = self.screen_fx.offset()

        self.backdrop.draw(surf)
        self.backdrop.draw_vignette(surf)

        self._draw_board(surf, ox, oy)
        self._draw_tray(surf)
        self.particles.draw(surf)
        self.ripples.draw(surf)
        self._draw_drag(surf)
        self.floaters.draw(surf, fonts)
        self._draw_hud(surf)
        self._draw_banner(surf)
        self._draw_tutorial(surf)
        self.screen_fx.draw_flash(surf)

    def _board_scale(self) -> float:
        """A brief swell on a clear. Small — 3% — because the board is a fixed reference and
        anything larger makes the whole screen feel loose."""
        if self.board_pulse <= 0.0:
            return 1.0
        k = self.board_pulse / BOARD_PULSE_TIME
        return 1.0 + 0.03 * math.sin(k * math.pi)

    def _draw_board(self, surf: pygame.Surface, ox: int, oy: int) -> None:
        rect = board_rect().move(ox, oy)
        surf.blit(tiles.board_panel(BOARD_W, BOARD_W, BOARD_RADIUS), rect.topleft)

        # Empty wells first, then the halo pass, then the tiles. Two passes over the filled cells
        # because additive light has to be laid down before the opaque things that sit on it.
        for r in range(GRID):
            for c in range(GRID):
                if self.board.at(c, r) == EMPTY:
                    x, y = cell_pos(c, r)
                    surf.blit(tiles.well(CELL), (x + ox, y + oy))

        if theme.BLOCK_GLOW:
            for r in range(GRID):
                for c in range(GRID):
                    ci = self.board.at(c, r)
                    if ci != EMPTY:
                        x, y = cell_pos(c, r)
                        tiles.blit_halo(surf, CELL, theme.block_color(ci), (x + ox, y + oy))

        clearing = {}
        for fx in self.clears:
            for c, r, ci, delay in fx.cells:
                clearing[(c, r)] = (fx, delay, ci)

        for r in range(GRID):
            for c in range(GRID):
                ci = self.board.at(c, r)
                if ci == EMPTY:
                    continue
                x, y = cell_pos(c, r)
                self._draw_cell(surf, c, r, ci, x + ox, y + oy,
                                highlight=(c, r) in clearing)

        # Departing tiles: still drawn, no longer on the board.
        for fx in self.clears:
            if not fx.removed:
                continue
            for c, r, ci, delay in fx.cells:
                k = (fx.t - CLEAR_HOLD - delay) / CLEAR_CELL_TIME
                if k <= 0.0:
                    # Not yet started leaving — hold it at full size so the sweep has something to
                    # sweep across.
                    x, y = cell_pos(c, r)
                    self._draw_cell(surf, c, r, ci, x + ox, y + oy, highlight=True)
                    continue
                if k >= 1.0:
                    continue
                x, y = cell_pos(c, r)
                # Up and out: a short rise with a shrink reads as being lifted away, where a plain
                # fade reads as a rendering glitch.
                scale = (1.0 - k) * (1.0 + 0.35 * math.sin(k * math.pi))
                size = max(2, int(CELL * scale))
                off = (CELL - size) // 2
                rise = int(26 * ease_out_cubic(k))
                spr = tiles.flat(size, theme.shade(theme.block_color(ci), 0.25 * k))
                spr.set_alpha(int(255 * (1.0 - k) ** 0.7))
                surf.blit(spr, (x + off + ox, y + off - rise + oy))

    def _draw_cell(self, surf, c: int, r: int, ci: int, x: int, y: int, *,
                   highlight: bool = False) -> None:
        age = self.cell_anim.get((c, r))
        color = theme.block_color(ci)
        if highlight:
            # The pre-clear flash. Lightening the colour rather than blitting white keeps the tile
            # recognisable as itself while it is obviously about to go.
            color = theme.shade(color, 0.45)
        if age is None:
            tiles.blit_tile(surf, CELL, color, (x, y))
            return
        # Placement bounce: overshoot then settle, drawn about the cell's centre.
        k = min(1.0, age / PLACE_BOUNCE_TIME)
        scale = 1.0 + 0.22 * (1.0 - ease_out_back(k, 2.2))
        size = max(4, int(CELL * scale))
        off = (CELL - size) // 2
        tiles.blit_tile(surf, size, color, (x + off, y + off))

    def _draw_tray(self, surf: pygame.Surface) -> None:
        panel_r = pygame.Rect(18, TRAY_Y - 16, GAME_W - 36, TRAY_H + 4)
        surf.blit(assets.rounded_panel(panel_r.w, panel_r.h, 24, theme.PANEL_HI,
                                       theme.shade(theme.PANEL, -0.18), theme.PANEL_LINE, 2, 232),
                  panel_r.topleft)

        for i, p in enumerate(self.pieces):
            if p.consumed or p is self.drag:
                continue
            # A slow bob, out of phase per slot, so the tray is never completely still.
            bob = math.sin(self.t * 1.9 + p.bob) * 3.0
            stuck = self.state == "dying"
            if stuck:
                # The failure beat: the pieces that do not fit shudder.
                bob += math.sin(self.state_t * 46.0 + i) * 4.0 * max(0.0, 1.0 - self.state_t)
            self._draw_piece(surf, p, p.home_x, p.home_y + bob, TRAY_CELL, TRAY_GAP,
                             alpha=110 if stuck else 255)

    def _draw_piece(self, surf, piece, x: float, y: float, cell: int, gap: int,
                    alpha: int = 255) -> None:
        stride = cell + gap
        for dc, dr in piece.cells:
            px = int(x) + dc * stride
            py = int(y) + dr * stride
            if alpha >= 255:
                tiles.blit_tile(surf, cell, theme.block_color(piece.color_index), (px, py))
            else:
                spr = tiles.flat(cell, theme.block_color(piece.color_index))
                spr.set_alpha(alpha)
                surf.blit(spr, (px, py))

    def _draw_drag(self, surf: pygame.Surface) -> None:
        p = self.drag
        if p is None:
            return

        # The ghost first, underneath, so the piece in hand always wins the overlap.
        if self.preview is not None:
            col, row = self.preview
            for dc, dr in p.cells:
                x, y = cell_pos(col + dc, row + dr)
                surf.blit(tiles.flat(CELL, theme.block_color(p.color_index), 92), (x, y))
                surf.blit(tiles.outline(CELL, theme.shade(theme.block_color(p.color_index), 0.4),
                                        width=3, alpha=210), (x, y))
            # Tell the player what the move is worth before they commit to it: any line this
            # placement would complete lights up.
            self._draw_would_clear(surf, p, col, row)

        # The piece in hand, at board scale, with a shadow under it.
        lift = ease_out_cubic(p.lift)
        cell = int(TRAY_CELL + (CELL - TRAY_CELL) * lift)
        gap = int(TRAY_GAP + (CELL_GAP - TRAY_GAP) * lift)
        stride = cell + gap
        invalid = self.preview is None
        for dc, dr in p.cells:
            px = int(p.x) + dc * stride
            py = int(p.y) + dr * stride
            if invalid:
                # Desaturated and dimmed, not red: this state happens constantly while a player
                # hunts for a spot, and a red flash every time would be exhausting.
                col = theme.lerp_color(theme.block_color(p.color_index), (120, 124, 150), 0.55)
                spr = tiles.flat(cell, col)
                spr.set_alpha(200)
                surf.blit(spr, (px, py))
            else:
                tiles.blit_tile(surf, cell, theme.block_color(p.color_index), (px, py))

    def _draw_would_clear(self, surf: pygame.Surface, piece, col: int, row: int) -> None:
        """Highlight rows and columns this placement would complete."""
        snap = self.board.snapshot()
        self.board.place(piece.cells, col, row, piece.color_index)
        rows, cols = self.board.complete_lines()
        self.board.restore(snap)
        if not (rows or cols):
            return
        accent = theme.ACCENT_2
        # Quantised to a handful of steps so the pulse reuses a few cached bands instead of
        # generating a new surface every frame — the same reason `glow` quantises its peak.
        # Kept low. Added light on an already-bright tile drives its channels towards white, so a
        # strong highlight turns the row pastel — visible, but no longer reading as its own colours.
        pulse = 20 + 5 * int((0.5 + 0.5 * math.sin(self.t * 9.0)) * 5)
        span = GRID * _STRIDE - CELL_GAP
        for r in rows:
            x, y = cell_pos(0, r)
            surf.blit(tiles.line_flash(span, CELL, accent, pulse), (x, y),
                      special_flags=pygame.BLEND_ADD)
        for c in cols:
            x, y = cell_pos(c, 0)
            surf.blit(tiles.line_flash(CELL, span, accent, pulse), (x, y),
                      special_flags=pygame.BLEND_ADD)

    # ── HUD ─────────────────────────────────────────────────────────────────────
    def _draw_hud(self, surf: pygame.Surface) -> None:
        save = self.app.save
        best = max(save.high_score(self.mode_key), self.score.score)

        fonts.draw(surf, f"{self.score.shown:,}", (GAME_W // 2, HUD_TOP + 66), 62, theme.TEXT,
                   anchor="center", tracking=3.0, glow=theme.ACCENT, glow_alpha=64)
        fonts.draw(surf, "SCORE", (GAME_W // 2, HUD_TOP + 108), 13, theme.TEXT_FAINT,
                   anchor="center", tracking=4.0, shadow=1)

        fonts.draw(surf, "BEST", (34, HUD_TOP + 20), 12, theme.TEXT_FAINT,
                   anchor="topleft", tracking=3.0, shadow=1)
        fonts.draw(surf, f"{best:,}", (34, HUD_TOP + 38), 24, theme.GOLD,
                   anchor="topleft", tracking=1.4)

        if self.mode_key == "challenge" and self.objective is not None:
            self._draw_objective(surf)
        elif self.score.combo >= 2 and self.banner is None:
            # Not both. The banner sits just above the board and the pill just below the score, and
            # at a large banner size the two collide — which looked like a rendering fault. They
            # also carry the same information during a combo, so the banner simply takes over while
            # it is up and the pill resumes when it fades.
            self._draw_combo(surf)

        self._draw_pause_button(surf)

    def _draw_combo(self, surf: pygame.Surface) -> None:
        combo = self.score.combo
        r = pygame.Rect(0, 0, 128, 44)
        r.center = (GAME_W // 2, HUD_TOP + 150)
        # The ring fills as the combo climbs towards its cap, so the number has a context.
        ui.pill(surf, r, f"COMBO x{combo}", theme.ACCENT_2, size=17, filled=True)

    def _draw_objective(self, surf: pygame.Surface) -> None:
        obj = self.objective
        s = self.score
        if obj.key.startswith("lines_"):
            have, want = s.lines_cleared, obj.target
        elif obj.key.startswith("score_"):
            have, want = s.score, obj.target
        elif obj.key.startswith("combo_"):
            have, want = s.best_combo, obj.target
        elif obj.key.startswith("moves_"):
            have, want = s.pieces_placed, obj.target
        else:
            have, want = s.best_simultaneous, 2 if obj.key == "double" else 3

        done = self.objective_done
        label = "COMPLETE" if done else obj.label.upper()
        colour = theme.GREEN if done else theme.ACCENT_2
        fonts.draw(surf, label, (GAME_W // 2, HUD_TOP + 140), 15, colour,
                   anchor="center", tracking=2.4, shadow=1)
        bar = pygame.Rect(0, 0, 300, 8)
        bar.center = (GAME_W // 2, HUD_TOP + 162)
        ui.progress_bar(surf, bar, 1.0 if done else have / max(1, want), colour)

    def _draw_pause_button(self, surf: pygame.Surface) -> None:
        btn = pause_btn()
        hovered = btn.collidepoint(self.app.mouse)
        surf.blit(assets.rounded_panel(btn.w, btn.h, 16,
                                       theme.PANEL_HI if hovered else theme.PANEL,
                                       theme.shade(theme.PANEL, -0.2),
                                       theme.ACCENT if hovered else theme.PANEL_LINE, 2),
                  btn.topleft)
        bar_c = theme.TEXT if hovered else theme.TEXT_DIM
        for dx in (-7, 4):
            pygame.draw.rect(surf, bar_c,
                             (btn.centerx + dx, btn.centery - 11, 4, 22),
                             border_radius=2)

    def _draw_banner(self, surf: pygame.Surface) -> None:
        if self.banner is None:
            return
        text, weight, age = self.banner
        k = min(1.0, age / 0.24)
        fade = max(0.0, min(1.0, (1.5 - age) / 0.45))
        size = int((30 + 34 * weight) * (0.6 + 0.4 * ease_out_back(k, 2.4)))
        y = BOARD_Y - 46 - int(18 * ease_out_cubic(k))
        fonts.draw(surf, text, (GAME_W // 2, y), size, theme.TEXT, anchor="center",
                   tracking=4.0 + 3.0 * weight, glow=theme.ACCENT_2,
                   glow_alpha=int(140 * weight), alpha=int(255 * fade))

    def _draw_tutorial(self, surf: pygame.Surface) -> None:
        text = self.tutorial_text()
        if not text:
            return
        pulse = 0.72 + 0.28 * (0.5 + 0.5 * math.sin(self.t * 3.4))
        y = TRAY_Y - 52
        r = pygame.Rect(0, 0, 420, 44)
        r.center = (GAME_W // 2, y)
        surf.blit(assets.rounded_panel(r.w, r.h, 22, theme.PANEL_HI,
                                       theme.shade(theme.PANEL, -0.1), theme.ACCENT, 2,
                                       int(210 * pulse)), r.topleft)
        fonts.draw(surf, text, r.center, 16, theme.TEXT, anchor="center", tracking=2.4,
                   alpha=int(255 * pulse))


class PauseScene(Scene):
    """An overlay, not a replacement: the board keeps drawing behind it."""

    transparent = True

    def __init__(self, app):
        super().__init__(app)
        self.group = ui.Group()
        self.play: PlayScene | None = None

    def enter(self, play=None, **kwargs):
        self.play = play
        self.t = 0.0
        audio.duck_music(True)
        self.group.clear()
        cx = GAME_W // 2
        self.group.add(ui.Button(pygame.Rect(cx - 150, 520, 300, 72), "RESUME",
                                 self._resume, color=theme.GREEN))
        self.group.add(ui.Button(pygame.Rect(cx - 150, 606, 300, 66), "RESTART",
                                 self._restart, color=theme.ACCENT))
        self.group.add(ui.Button(pygame.Rect(cx - 150, 684, 300, 66), "MAIN MENU",
                                 self._menu, color=theme.TEXT_DIM))

    def leave(self):
        audio.duck_music(False)

    def _resume(self):
        self.app.pop()

    def _restart(self):
        play = self.play
        self.app.pop()
        if play:
            play.enter(mode_key=play.mode_key)

    def _menu(self):
        from .menu import MenuScene
        self.app.switch(MenuScene(self.app))

    def handle(self, event):
        if event.type == pygame.KEYDOWN and event.key in (pygame.K_ESCAPE, pygame.K_p):
            self._resume()
            return
        self.group.handle(event)

    def update(self, dt):
        self.t += dt
        self.group.update(dt, self.app.mouse, self.app.mouse_down)

    def draw(self, surf):
        ui.scrim(surf, theme.BG_DEEP, int(216 * min(1.0, self.t * 6)))
        k = min(1.0, self.t / 0.3)
        dy = int(26 * (1.0 - ease_out_cubic(k)))
        fonts.draw(surf, "PAUSED", (GAME_W // 2, 400 + dy), 56, theme.TEXT, anchor="center",
                   tracking=9.0, glow=theme.ACCENT, glow_alpha=110, alpha=int(255 * k))
        if self.play:
            fonts.draw(surf, f"SCORE {self.play.score.score:,}", (GAME_W // 2, 452 + dy), 20,
                       theme.TEXT_DIM, anchor="center", bold=False, tracking=2.0,
                       alpha=int(255 * k))
        self.group.draw(surf)


class GameOverScene(Scene):
    transparent = True

    def __init__(self, app):
        super().__init__(app)
        self.group = ui.Group()
        self.play: PlayScene | None = None
        self.result: dict = {}
        self.particles = Particles(320)
        self._celebrated = False

    def enter(self, play=None, result=None, **kwargs):
        self.play = play
        self.result = result or {}
        self.t = 0.0
        self._celebrated = False
        self.particles.clear()
        audio.duck_music(True)
        self.group.clear()
        cx = GAME_W // 2
        self.group.add(ui.Button(pygame.Rect(cx - 150, 880, 300, 72), "PLAY AGAIN",
                                 self._again, color=theme.GREEN))
        self.group.add(ui.Button(pygame.Rect(cx - 150, 966, 300, 66), "MAIN MENU",
                                 self._menu, color=theme.TEXT_DIM))

    def leave(self):
        audio.duck_music(False)

    def _again(self):
        play = self.play
        self.app.pop()
        if play:
            play.enter(mode_key=play.mode_key)

    def _menu(self):
        from .menu import MenuScene
        self.app.switch(MenuScene(self.app))

    def handle(self, event):
        if event.type == pygame.KEYDOWN and event.key in (pygame.K_RETURN, pygame.K_r):
            self._again()
            return
        self.group.handle(event)

    def update(self, dt):
        self.t += dt
        self.particles.update(dt)
        self.group.update(dt, self.app.mouse, self.app.mouse_down)
        # The celebration waits for the panel to have arrived, so it reads as a reaction to the
        # number rather than as part of the transition.
        if not self._celebrated and self.t > 0.45:
            self._celebrated = True
            if self.result.get("new_high"):
                audio.high_score()
                for i in range(3):
                    self.particles.ring((GAME_W // 2, 470), 26, theme.GOLD,
                                        radius_speed=(200 + i * 90, 330 + i * 90),
                                        size=(4, 10), life=(0.7, 1.3))
            elif self.result.get("coins"):
                audio.reward()

    def draw(self, surf):
        ui.scrim(surf, theme.BG_DEEP, int(226 * min(1.0, self.t * 5)))
        p = self.play
        if p is None:
            return
        k = min(1.0, self.t / 0.34)
        dy = int(30 * (1.0 - ease_out_cubic(k)))
        alpha = int(255 * k)
        new_high = self.result.get("new_high")

        head = "NEW BEST!" if new_high else "NO MOVES LEFT"
        fonts.draw(surf, head, (GAME_W // 2, 300 + dy), 42 if new_high else 34,
                   theme.GOLD if new_high else theme.TEXT, anchor="center", tracking=5.0,
                   glow=theme.GOLD if new_high else None, glow_alpha=120, alpha=alpha)

        fonts.draw(surf, f"{p.score.score:,}", (GAME_W // 2, 400 + dy), 76, theme.TEXT,
                   anchor="center", tracking=3.0, glow=theme.ACCENT, glow_alpha=80, alpha=alpha)
        fonts.draw(surf, "FINAL SCORE", (GAME_W // 2, 452 + dy), 13, theme.TEXT_FAINT,
                   anchor="center", tracking=4.0, alpha=alpha, shadow=1)

        self.particles.draw(surf)

        rows = (
            ("HIGH SCORE", f"{self.app.save.high_score(p.mode_key):,}", theme.GOLD),
            ("LINES CLEARED", f"{p.score.lines_cleared}", theme.ACCENT),
            ("BEST COMBO", f"x{p.score.best_combo}", theme.ACCENT_2),
            ("BLOCKS PLACED", f"{p.score.pieces_placed}", theme.TEXT_DIM),
        )
        card = pygame.Rect(0, 0, 420, 256)
        card.center = (GAME_W // 2, 630 + dy)
        with ui.sliding(surf, card.inflate(80, 80), alpha=alpha) as layer:
            ui.panel(layer, card, radius=22)
            y = card.y + 30
            for label, value, colour in rows:
                fonts.draw(layer, label, (card.x + 30, y), 15, theme.TEXT_DIM,
                           anchor="midleft", bold=False, tracking=1.8)
                fonts.draw(layer, value, (card.right - 30, y), 22, colour,
                           anchor="midright", tracking=1.2)
                y += 44
            coins = self.result.get("coins", 0)
            icon = tiles.coin(24)
            layer.blit(icon, icon.get_rect(midleft=(card.x + 30, y + 6)))
            fonts.draw(layer, f"+{coins} EARNED", (card.x + 62, y + 6), 18, theme.GOLD,
                       anchor="midleft", tracking=1.6)

        self.group.draw(surf)
