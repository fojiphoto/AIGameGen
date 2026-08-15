/**
 * A match: the game state between the rules engine and the interface.
 *
 * Everything mutable about a game in progress lives here — the position, the moves played, whose
 * clock is running, whether a promotion is pending, whether the game has ended and why. The
 * renderer reads it and never writes it, and the rules layer below knows nothing about it.
 *
 * The one invariant worth stating: a move only ever enters the game through `play()`, and
 * `play()` only accepts a move that came from `generateLegal`. There is no path from a pointer
 * event to the board that skips the rules.
 */

import {
  Position, Move, Color, WHITE, BLACK,
  startPosition, parseFen, toFen, generateLegal, gameStatus, GameStatus,
  toSan, moveFrom, moveTo, movePromo, isCapture, isEnPassant, isCastle, isPromotion,
  pieceType, pieceColor, capturedPieces, materialBalance,
  PAWN, QUEEN, Outcome,
} from '../core/index.js';
import { ChessClock, TimeControl, timeControlByKey } from './clock.js';
import { openingName } from '../engine/book.js';

export type MatchMode = 'ai' | 'local' | 'puzzle';

export interface MatchConfig {
  mode: MatchMode;
  /** Which colour the human plays. Ignored in local two-player. */
  playerColor: Color;
  difficulty: string;
  timeControl: TimeControl;
  startFen?: string;
}

export interface PlayedMove {
  move: Move;
  san: string;
  /** Board state before the move, so the history panel can step back through the game. */
  fenBefore: string;
  /** Milliseconds each side had left after this move, for the record. */
  clockAfter: [number, number];
}

export class Match {
  position: Position;
  readonly startFen: string;
  readonly config: MatchConfig;
  readonly clock = new ChessClock();

  played: PlayedMove[] = [];
  status: GameStatus;
  /** Set when the game ends for a reason the rules cannot see: time, resignation, agreement. */
  private forcedOutcome: { outcome: Outcome; winner: Color | null; reason: string } | null = null;

  startedAt = performance.now();
  endedAt = 0;
  /** Index the history panel is viewing; equal to `played.length` when live. */
  viewIndex = 0;

  constructor(config: MatchConfig) {
    this.config = config;
    this.position = config.startFen ? parseFen(config.startFen) : startPosition();
    this.startFen = toFen(this.position);
    this.status = gameStatus(this.position);
    this.clock.configure(config.timeControl);
    this.viewIndex = 0;
  }

  get turn(): Color { return this.position.turn; }

  /** True when it is the human's move — always true in local play. */
  get humanToMove(): boolean {
    if (this.config.mode === 'local') return true;
    return this.position.turn === this.config.playerColor;
  }

  get over(): boolean { return this.forcedOutcome !== null || this.status.over; }

  get result(): { outcome: Outcome; winner: Color | null; reason: string } {
    if (this.forcedOutcome) return this.forcedOutcome;
    return { outcome: this.status.outcome, winner: this.status.winner, reason: this.status.reason };
  }

  /** Live legal moves. The single source the interface may offer the player. */
  legalMoves(): Move[] {
    return this.over || !this.isLive ? [] : generateLegal(this.position);
  }

  movesFrom(sq: number): Move[] {
    return this.legalMoves().filter((m) => moveFrom(m) === sq);
  }

  /** True while the board shows the live position rather than a past one. */
  get isLive(): boolean { return this.viewIndex === this.played.length; }

  /**
   * Play a move.
   *
   * Returns the record, or null if the move was not legal here — which should be impossible from
   * the interface and is checked anyway, because "impossible" bugs in a rules engine corrupt the
   * board silently and are then blamed on the renderer.
   */
  play(move: Move): PlayedMove | null {
    if (this.over || !this.isLive) return null;
    const legal = generateLegal(this.position);
    if (!legal.some((m) => m === move)) return null;

    const fenBefore = toFen(this.position);
    const san = toSan(this.position, move);
    const mover = this.position.turn;

    if (!this.position.makeMove(move)) return null;

    // The clock passes to the other side, which also applies the mover's increment.
    this.clock.switchTo(this.position.turn);

    const record: PlayedMove = {
      move, san, fenBefore,
      clockAfter: [this.clock.msLeft(WHITE), this.clock.msLeft(BLACK)],
    };
    this.played.push(record);
    this.viewIndex = this.played.length;
    this.status = gameStatus(this.position);
    if (this.status.over) this.finish();
    void mover;
    return record;
  }

  /**
   * Take back moves.
   *
   * Against the AI this undoes a pair — the player's move and the reply — because undoing only
   * the reply would hand the player a free extra move, and undoing only their own would leave
   * the opponent on move. In local play it undoes one, which is what two people sharing a board
   * actually want.
   */
  undo(): number {
    if (this.played.length === 0) return 0;
    const count = this.config.mode === 'ai'
      ? Math.min(this.played.length, this.position.turn === this.config.playerColor ? 2 : 1)
      : 1;
    for (let i = 0; i < count; i++) {
      this.position.undoMove();
      this.played.pop();
    }
    this.viewIndex = this.played.length;
    this.forcedOutcome = null;
    this.endedAt = 0;
    this.status = gameStatus(this.position);
    if (this.clock.enabled) this.clock.switchTo(this.position.turn);
    return count;
  }

  canUndo(): boolean {
    return this.played.length > 0 && this.config.mode !== 'puzzle';
  }

  /** End the game for a reason outside the rules. */
  end(outcome: Outcome, winner: Color | null, reason: string): void {
    if (this.forcedOutcome) return;
    this.forcedOutcome = { outcome, winner, reason };
    this.finish();
  }

  resign(color: Color): void {
    const winner = (color ^ 1) as Color;
    this.end('resignation', winner,
      `${color === WHITE ? 'White' : 'Black'} resigned`);
  }

  flag(color: Color): void {
    /**
     * Timeout, with the rule that catches people out: a player who runs out of time does *not*
     * lose if the opponent could not possibly checkmate them. It is a draw. Getting this wrong
     * is the difference between the game being right and being nearly right.
     */
    const opponent = (color ^ 1) as Color;
    const opponentCanMate = !onlyKingLeft(this.position, opponent);
    if (!opponentCanMate) {
      this.end('timeout', null, 'Draw — time expired, but no mating material remains');
      return;
    }
    this.end('timeout', opponent,
      `${color === WHITE ? 'White' : 'Black'} ran out of time`);
  }

  agreeDraw(reason = 'Draw agreed'): void {
    this.end('agreement', null, reason);
  }

  claimDraw(): boolean {
    const claim = this.status.claimableDraw;
    if (!claim) return false;
    this.end(claim, null,
      claim === 'repetition'
        ? 'Draw claimed — the position occurred three times'
        : 'Draw claimed — fifty moves without a capture or a pawn move');
    return true;
  }

  private finish(): void {
    this.clock.pause();
    if (!this.endedAt) this.endedAt = performance.now();
  }

  get durationMs(): number {
    return (this.endedAt || performance.now()) - this.startedAt;
  }

  // ── views for the interface ───────────────────────────────────────────────

  /** The position the board should draw — the live one, or a past one being reviewed. */
  viewPosition(): Position {
    if (this.isLive) return this.position;
    const pos = parseFen(this.played[this.viewIndex]?.fenBefore ?? this.startFen);
    return pos;
  }

  viewLastMove(): Move | null {
    const index = this.viewIndex - 1;
    return index >= 0 ? this.played[index].move : null;
  }

  /** Step the review cursor. Returns true if it moved. */
  seek(index: number): boolean {
    const clamped = Math.max(0, Math.min(this.played.length, index));
    if (clamped === this.viewIndex) return false;
    this.viewIndex = clamped;
    return true;
  }

  sanList(): string[] { return this.played.map((p) => p.san); }

  opening(): string | null { return openingName(this.sanList()); }

  captures(): { white: number[]; black: number[]; balance: number } {
    const pos = this.viewPosition();
    const caps = capturedPieces(pos);
    return { ...caps, balance: materialBalance(pos) };
  }

  /** Square of the king in check, or -1. Drives the board's warning glow. */
  checkSquare(): number {
    const pos = this.viewPosition();
    return pos.inCheck() ? pos.kings[pos.turn] : -1;
  }

  /**
   * Does this move need a promotion choice?
   *
   * The generator emits four separate moves for a promotion, so "is a dialog needed" is really
   * "are there several legal moves between these two squares" — which is exactly the question,
   * and stays correct without special-casing pawns or ranks anywhere in the interface.
   */
  promotionChoices(from: number, to: number): Move[] {
    return this.legalMoves().filter(
      (m) => moveFrom(m) === from && moveTo(m) === to && isPromotion(m));
  }

  findMove(from: number, to: number, promo = 0): Move | null {
    const candidates = this.legalMoves().filter(
      (m) => moveFrom(m) === from && moveTo(m) === to);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    return candidates.find((m) => movePromo(m) === (promo || QUEEN)) ?? candidates[0];
  }
}

/** Whether a side has nothing but a bare king, for the timeout rule. */
function onlyKingLeft(pos: Position, color: Color): boolean {
  let material = 0;
  for (const sq of pos.pieces[color]) {
    const type = pieceType(pos.board[sq]);
    if (type !== 6) material++;
  }
  return material === 0;
}

export {
  WHITE, BLACK, PAWN, QUEEN, moveFrom, moveTo, movePromo,
  isCapture, isEnPassant, isCastle, isPromotion, pieceType, pieceColor, timeControlByKey,
};
