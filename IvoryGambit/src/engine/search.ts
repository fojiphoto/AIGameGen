/**
 * The search: alpha-beta with iterative deepening, a transposition table, quiescence, and the
 * move-ordering heuristics that make the pruning actually pay.
 *
 * Alpha-beta only prunes well when the best move is tried first — with perfect ordering it
 * examines the square root of the tree, with random ordering it examines all of it. So most of
 * what follows is not about *searching*, it is about guessing the best move before searching:
 * the hash move first, then winning captures ordered by what they take and what takes it, then
 * two "killer" quiet moves that caused a cutoff at this depth elsewhere, then everything else
 * ranked by a history table. That ordering is worth more depth than any amount of raw speed.
 *
 * Everything runs inside a Web Worker, so the only real-time constraint is the soft time limit
 * checked every few thousand nodes. A search that overruns is worse than a shallow one: the
 * board stops responding to the player, which is exactly the thing the worker exists to prevent.
 */

import {
  Position, Move, Color,
  generatePseudo, generateLegal,
  moveFrom, moveTo, movePromo, isCapture, isPromotion, isEnPassant,
  pieceType, PAWN, QUEEN, KING,
  insufficientMaterial,
} from '../core/index.js';
import { evaluate, MG_VALUE } from './eval.js';

export const MATE_SCORE = 30000;
/** Anything past this is a forced mate, and the distance is encoded in the remainder. */
export const MATE_BOUND = MATE_SCORE - 1000;
const INFINITY = 40000;

const MAX_PLY = 64;

// ── transposition table ─────────────────────────────────────────────────────

const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

/**
 * A fixed-size, always-replace table in flat typed arrays.
 *
 * Flat arrays rather than objects because this is the largest allocation in the program and the
 * one touched most often; a million small objects would spend more time in the collector than
 * the search saves. `hi` is stored so a hit can be verified — the index only uses the low word,
 * and playing a move that came from a colliding entry is the kind of bug that looks like the
 * engine "sometimes blundering" and is nearly impossible to reproduce.
 */
class TranspositionTable {
  private mask: number;
  private keyHi: Int32Array;
  private keyLo: Int32Array;
  private move: Int32Array;
  private score: Int32Array;
  private depthFlag: Int32Array;   // depth << 2 | flag
  private generation = 0;
  private age: Uint8Array;

  constructor(sizeMb = 16) {
    // Each entry is 4+4+4+4+4+1 bytes; round the count down to a power of two so indexing is a
    // mask rather than a modulo.
    const entries = 1 << Math.max(10, Math.floor(Math.log2((sizeMb * 1024 * 1024) / 24)));
    this.mask = entries - 1;
    this.keyHi = new Int32Array(entries);
    this.keyLo = new Int32Array(entries);
    this.move = new Int32Array(entries);
    this.score = new Int32Array(entries);
    this.depthFlag = new Int32Array(entries);
    this.age = new Uint8Array(entries);
  }

  newSearch(): void { this.generation = (this.generation + 1) & 0xff; }

  clear(): void {
    this.keyHi.fill(0); this.keyLo.fill(0); this.move.fill(0);
    this.score.fill(0); this.depthFlag.fill(0); this.age.fill(0);
  }

  probe(pos: Position, depth: number, alpha: number, beta: number, ply: number):
    { hit: boolean; score: number; move: Move } {
    const i = pos.keyLo & this.mask;
    if (this.keyLo[i] !== pos.keyLo || this.keyHi[i] !== pos.keyHi) {
      return { hit: false, score: 0, move: 0 };
    }
    const move = this.move[i];
    const storedDepth = this.depthFlag[i] >> 2;
    if (storedDepth < depth) return { hit: false, score: 0, move };

    // Mate scores are stored relative to the entry's own ply and re-based on the way out, or a
    // mate found at ply 8 gets reported as a mate at ply 2 when the same position is reached
    // earlier in a later iteration.
    let score = this.score[i];
    if (score > MATE_BOUND) score -= ply;
    else if (score < -MATE_BOUND) score += ply;

    const flag = this.depthFlag[i] & 3;
    if (flag === TT_EXACT) return { hit: true, score, move };
    if (flag === TT_LOWER && score >= beta) return { hit: true, score, move };
    if (flag === TT_UPPER && score <= alpha) return { hit: true, score, move };
    return { hit: false, score: 0, move };
  }

  store(pos: Position, depth: number, score: number, flag: number, move: Move, ply: number): void {
    const i = pos.keyLo & this.mask;
    // Keep a deeper entry from this same search; anything from an older search is fair game.
    const sameSlot = this.keyLo[i] === pos.keyLo && this.keyHi[i] === pos.keyHi;
    if (sameSlot && this.age[i] === this.generation && (this.depthFlag[i] >> 2) > depth) return;

    let stored = score;
    if (stored > MATE_BOUND) stored += ply;
    else if (stored < -MATE_BOUND) stored -= ply;

    this.keyLo[i] = pos.keyLo;
    this.keyHi[i] = pos.keyHi;
    this.move[i] = move;
    this.score[i] = stored;
    this.depthFlag[i] = (depth << 2) | flag;
    this.age[i] = this.generation;
  }
}

// ── search options and result ───────────────────────────────────────────────

export interface SearchOptions {
  /** Hard ceiling on iterative deepening. */
  maxDepth: number;
  /** Soft wall-clock budget in ms. The current iteration finishes; the next is not started. */
  maxTime: number;
  /**
   * Centipawns of noise added to each root move's score before picking.
   *
   * This is how the lower difficulties are made weaker, and it matters *how*. Playing a random
   * legal move produces an opponent that hangs its queen for no reason and is no fun to beat.
   * Adding noise to a real evaluation produces one that plays a reasonable-looking move that is
   * simply not the best — which is what a weaker human does.
   */
  randomness: number;
  /**
   * Probability of picking the second- or third-best root move outright.
   *
   * Noise alone still converges on the best move when it is far ahead of the rest, so the very
   * lowest levels also need an occasional deliberate second choice to miss a tactic a beginner
   * would miss.
   */
  blunderChance: number;
  /** Called with each completed iteration, for a "thinking, depth 9" readout. */
  onIteration?: (info: SearchInfo) => void;
  /** Polled between nodes; returning true abandons the search. */
  shouldStop?: () => boolean;
}

export interface SearchInfo {
  depth: number;
  score: number;
  /** Moves from the root, best line first. */
  pv: Move[];
  nodes: number;
  timeMs: number;
  /** Positive = mate in N for the side to move, negative = mated in N. 0 = no mate found. */
  mateIn: number;
}

export interface SearchResult extends SearchInfo {
  best: Move;
}

const now = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Searcher {
  private tt = new TranspositionTable(16);
  private killers: Int32Array = new Int32Array(MAX_PLY * 2);
  private history: Int32Array = new Int32Array(16 * 128);
  private nodes = 0;
  private startTime = 0;
  private deadline = 0;
  private stopped = false;
  private opts!: SearchOptions;
  /** Principal variation, triangular: pv[ply][0..len]. */
  private pv: Int32Array = new Int32Array(MAX_PLY * MAX_PLY);
  private pvLength: Int32Array = new Int32Array(MAX_PLY);
  /** Deterministic noise, so the same seed replays the same game. */
  private seed = 0x2545f491;

  reset(): void {
    this.tt.clear();
    this.history.fill(0);
    this.killers.fill(0);
  }

  private rand(): number {
    let x = this.seed;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.seed = x;
    return x / 0x100000000;
  }

  seedWith(n: number): void { this.seed = (n | 0) || 0x2545f491; }

  /**
   * Search the position and return the move to play.
   *
   * Iterative deepening rather than one deep search: each iteration's best move orders the next
   * one, which more than pays back the repeated shallow work, and it means a search cut short by
   * the clock still has a complete answer from the previous depth rather than half of a deeper
   * one.
   */
  search(pos: Position, opts: SearchOptions): SearchResult {
    this.opts = opts;
    this.nodes = 0;
    this.stopped = false;
    this.startTime = now();
    this.deadline = this.startTime + opts.maxTime;
    this.tt.newSearch();
    this.killers.fill(0);
    // Decay rather than clear: history from the previous move is still broadly true, and
    // halving it stops early noise dominating for the rest of the game.
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 1;

    const root = generateLegal(pos);
    if (root.length === 0) {
      return { best: 0, depth: 0, score: 0, pv: [], nodes: 0, timeMs: 0, mateIn: 0 };
    }
    if (root.length === 1) {
      // Nothing to decide. Returning immediately keeps forced recaptures instant, which reads
      // as the opponent being sharp rather than as the interface stalling.
      return {
        best: root[0], depth: 1, score: 0, pv: [root[0]],
        nodes: 1, timeMs: now() - this.startTime, mateIn: 0,
      };
    }

    let best = root[0];
    let bestScore = 0;
    let lastInfo: SearchInfo = {
      depth: 0, score: 0, pv: [best], nodes: 0, timeMs: 0, mateIn: 0,
    };
    const scored: { move: Move; score: number }[] = [];

    /**
     * Whether this search will perturb its own choice afterwards.
     *
     * It changes how the root is searched, and the reason is subtle enough to be worth stating:
     * in alpha-beta, every root move except the best one returns a *bound*, not a score. A move
     * that fails low has only been proved "worse than the best so far" — the number attached to
     * it is whatever its subtree happened to reach before cutting off, and the ordering among
     * those numbers means nothing.
     *
     * So picking "the second-best move" from a normally-pruned root is picking arbitrarily
     * among every move that is not best, which is exactly the random-mover the brief rules out:
     * it hangs a queen for no reason and reads as broken rather than as weak. Where the choice
     * is going to be perturbed, the root is searched without raising alpha so that every move
     * comes back with a true, comparable score. It costs a few times the nodes, and it only
     * applies to the lower levels, which are the cheap ones anyway.
     */
    const perturbs = opts.randomness > 0 || opts.blunderChance > 0;

    for (let depth = 1; depth <= opts.maxDepth; depth++) {
      scored.length = 0;
      let alpha = -INFINITY;
      const beta = INFINITY;
      let iterationBest = 0;
      let iterationScore = -INFINITY;

      // Try the previous iteration's best first.
      const ordered = this.orderRoot(pos, root, best);
      // The root is ply 0 and is searched here rather than by `negamax`, so its row of the PV
      // table has to be seeded and extended by hand — leaving it to the recursion means the
      // reported line is always empty, which silently costs the hint arrow and the analysis
      // readout while every score still looks correct.
      this.pvLength[0] = 0;

      for (const move of ordered) {
        if (!pos.makeMove(move)) continue;
        const score = -this.negamax(pos, depth - 1, -beta, -alpha, 1, true);
        pos.undoMove();

        if (this.stopped) break;

        scored.push({ move, score });
        if (score > iterationScore) {
          iterationScore = score;
          iterationBest = move;
          if (score > alpha && !perturbs) alpha = score;
          this.updatePv(0, move);
        }
      }

      if (this.stopped && iterationBest === 0) break;
      if (iterationBest !== 0) {
        best = iterationBest;
        bestScore = iterationScore;
        lastInfo = {
          depth,
          score: bestScore,
          pv: this.extractPv(),
          nodes: this.nodes,
          timeMs: now() - this.startTime,
          mateIn: this.mateDistance(bestScore),
        };
        opts.onIteration?.(lastInfo);
      }

      if (this.stopped) break;
      // A forced mate is the end of the useful search — deeper only finds the same mate later.
      if (Math.abs(bestScore) > MATE_BOUND) break;
      // Do not start an iteration there is no chance of finishing. Each one costs roughly three
      // times the last, so past a third of the budget the next will overrun.
      if (now() - this.startTime > opts.maxTime * 0.4) break;
    }

    const chosen = this.chooseWithPersonality(scored, best, bestScore);
    return { ...lastInfo, best: chosen, score: bestScore };
  }

  /**
   * Apply the difficulty personality to the finished root scores.
   *
   * Done once at the root rather than by weakening the search itself. Weakening the search
   * (shallower depth alone) makes an opponent that is uniformly blind; perturbing the choice
   * makes one that sees the position and then picks a slightly worse plan, which is what
   * playing a weaker human feels like.
   */
  private chooseWithPersonality(
    scored: { move: Move; score: number }[], best: Move, bestScore: number
  ): Move {
    const { randomness, blunderChance } = this.opts;
    if (scored.length < 2 || (randomness <= 0 && blunderChance <= 0)) return best;
    // Never throw away a forced mate or walk into one: even a beginner-level opponent finishing
    // the game off correctly reads as competent, and missing mate-in-one reads as broken.
    if (Math.abs(bestScore) > MATE_BOUND) return best;

    /**
     * Only moves within a window of the best are candidates.
     *
     * This is the difference between a weak opponent and a broken one. A weak human misses the
     * point of the position and plays something a pawn or two worse; they do not leave a queen
     * en prise for nothing. The window scales with the level's noise — Beginner may drop about
     * four pawns, Medium about one and a half — so the ladder gets weaker in a way that still
     * looks like chess all the way down.
     */
    const window = randomness * 3 + 60;
    const candidates = scored.filter((s) => s.score >= bestScore - window);
    if (candidates.length < 2) return best;

    const noisy = candidates.map((s) => ({
      move: s.move,
      score: s.score + (randomness > 0 ? (this.rand() * 2 - 1) * randomness : 0),
    }));
    noisy.sort((a, b) => b.score - a.score);

    if (blunderChance > 0 && noisy.length > 1 && this.rand() < blunderChance) {
      const pick = 1 + Math.floor(this.rand() * Math.min(2, noisy.length - 1));
      return noisy[pick].move;
    }
    return noisy[0].move;
  }

  private mateDistance(score: number): number {
    if (score > MATE_BOUND) return Math.ceil((MATE_SCORE - score) / 2);
    if (score < -MATE_BOUND) return -Math.ceil((MATE_SCORE + score) / 2);
    return 0;
  }

  private extractPv(): Move[] {
    const out: Move[] = [];
    for (let i = 0; i < this.pvLength[0]; i++) {
      const m = this.pv[i];
      if (!m) break;
      out.push(m);
    }
    return out;
  }

  private checkTime(): void {
    if ((this.nodes & 2047) !== 0) return;
    if (now() >= this.deadline || this.opts.shouldStop?.()) this.stopped = true;
  }

  private negamax(
    pos: Position, depth: number, alpha: number, beta: number, ply: number, allowNull: boolean
  ): number {
    this.pvLength[ply] = ply;
    if (this.stopped) return 0;
    this.nodes++;
    this.checkTime();

    // Draws by rule are draws no matter how good the position looks. Checking repetition inside
    // the search is what lets the engine both claim a draw when losing and *avoid* repeating
    // when winning — an engine that only checks at the root shuffles into a draw it could win.
    if (ply > 0) {
      if (pos.halfmove >= 100 || pos.repetitionCount() >= 2) return 0;
      if (insufficientMaterial(pos)) return 0;
    }

    const inCheck = pos.inCheck();
    // Extend rather than evaluate while in check: a static score in the middle of a forcing
    // sequence is meaningless, and the extension costs almost nothing because checks are rare.
    if (inCheck) depth++;

    if (depth <= 0) return this.quiesce(pos, alpha, beta, ply);
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    const alphaOrig = alpha;
    const probe = this.tt.probe(pos, depth, alpha, beta, ply);
    if (probe.hit && ply > 0) return probe.score;
    const hashMove = probe.move;

    /**
     * Null-move pruning: give the opponent a free move, and if we are still winning easily,
     * the real move will be at least as good, so the branch can be cut short.
     *
     * Forbidden in check (it would be an illegal position) and when the side to move has only
     * pawns, because in a zugzwang position having to move is precisely the problem and "what
     * if I pass" proves the opposite of the truth.
     */
    if (allowNull && !inCheck && depth >= 3 && ply > 0 && this.hasNonPawnMaterial(pos)) {
      const staticEval = evaluate(pos);
      if (staticEval >= beta) {
        const R = 2 + (depth > 6 ? 1 : 0);
        pos.makeNull();
        const score = -this.negamax(pos, depth - 1 - R, -beta, -beta + 1, ply + 1, false);
        pos.undoNull();
        if (this.stopped) return 0;
        if (score >= beta) return beta;
      }
    }

    const moves: Move[] = [];
    generatePseudo(pos, moves);
    const scores = this.scoreMoves(pos, moves, hashMove, ply);

    let bestScore = -INFINITY;
    let bestMove = 0;
    let legalCount = 0;

    for (let i = 0; i < moves.length; i++) {
      // Selection sort one move at a time: with a beta cutoff usually landing in the first two
      // or three, sorting the whole list up front is work thrown away.
      let pick = i;
      for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[pick]) pick = j;
      if (pick !== i) {
        const m = moves[i]; moves[i] = moves[pick]; moves[pick] = m;
        const s = scores[i]; scores[i] = scores[pick]; scores[pick] = s;
      }
      const move = moves[i];

      if (!pos.makeMove(move)) continue;
      legalCount++;

      let score: number;
      const quiet = !isCapture(move) && !isPromotion(move);

      if (legalCount === 1) {
        score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        /**
         * Late move reductions: moves this far down an ordered list are rarely best, so search
         * them shallower first and only re-search at full depth if one surprises us. This is
         * where most of the depth comes from in practice.
         */
        let reduction = 0;
        if (quiet && depth >= 3 && legalCount > 3 && !inCheck) {
          reduction = legalCount > 6 ? 2 : 1;
        }
        score = -this.negamax(pos, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && reduction > 0) {
          score = -this.negamax(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        }
        if (score > alpha && score < beta) {
          score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
        }
      }
      pos.undoMove();
      if (this.stopped) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (score > alpha) {
          alpha = score;
          this.updatePv(ply, move);
          if (alpha >= beta) {
            if (quiet) this.recordCutoff(pos, move, depth, ply);
            break;
          }
        }
      }
    }

    if (legalCount === 0) {
      // Mate scores are ply-relative so that a mate in 3 beats a mate in 5 rather than tying.
      return inCheck ? -MATE_SCORE + ply : 0;
    }

    const flag = bestScore <= alphaOrig ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
    this.tt.store(pos, depth, bestScore, flag, bestMove, ply);
    return bestScore;
  }

  /**
   * Quiescence: at the leaves, keep searching captures until the position is quiet.
   *
   * Without it the engine happily "wins" a queen on the last ply of its search and never sees
   * the recapture — the horizon effect, and by far the most visible weakness an otherwise
   * correct engine can have. It is the difference between an opponent that plays chess and one
   * that hangs pieces on exactly the move where it stopped looking.
   */
  private quiesce(pos: Position, alpha: number, beta: number, ply: number): number {
    this.nodes++;
    this.checkTime();
    if (this.stopped) return 0;
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    const standPat = evaluate(pos);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    // Delta pruning: if even winning a queen outright would not reach alpha, nothing here will.
    if (standPat + MG_VALUE[QUEEN] + 200 < alpha) return alpha;

    const moves: Move[] = [];
    generatePseudo(pos, moves, true);
    const scores = this.scoreMoves(pos, moves, 0, ply);

    for (let i = 0; i < moves.length; i++) {
      let pick = i;
      for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[pick]) pick = j;
      if (pick !== i) {
        const m = moves[i]; moves[i] = moves[pick]; moves[pick] = m;
        const s = scores[i]; scores[i] = scores[pick]; scores[pick] = s;
      }
      const move = moves[i];

      // Skip captures that lose material outright, unless they are promotions.
      if (!isPromotion(move) && this.captureGain(pos, move) < -50) continue;

      if (!pos.makeMove(move)) continue;
      const score = -this.quiesce(pos, -beta, -alpha, ply + 1);
      pos.undoMove();
      if (this.stopped) return 0;

      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /** Rough static exchange: what the capture wins, minus what it risks if it is defended. */
  private captureGain(pos: Position, move: Move): number {
    const to = moveTo(move);
    const victim = isEnPassant(move) ? PAWN : pieceType(pos.board[to]);
    const attacker = pieceType(pos.board[moveFrom(move)]);
    const gain = MG_VALUE[victim] - MG_VALUE[attacker];
    if (gain >= 0) return gain;
    // Only bother with the defended test when we are giving up more than we take.
    return pos.isAttacked(to, (pos.turn ^ 1) as Color) ? gain : MG_VALUE[victim];
  }

  private scoreMoves(pos: Position, moves: Move[], hashMove: Move, ply: number): Int32Array {
    const scores = new Int32Array(moves.length);
    const k0 = this.killers[ply * 2];
    const k1 = this.killers[ply * 2 + 1];

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (move === hashMove) { scores[i] = 1 << 24; continue; }

      if (isCapture(move)) {
        // MVV-LVA: take the most valuable thing with the least valuable piece. Ordering
        // captures this way is most of what makes alpha-beta prune at all.
        const victim = isEnPassant(move) ? PAWN : pieceType(pos.board[moveTo(move)]);
        const attacker = pieceType(pos.board[moveFrom(move)]);
        scores[i] = (1 << 20) + MG_VALUE[victim] * 16 - MG_VALUE[attacker];
        if (isPromotion(move)) scores[i] += MG_VALUE[movePromo(move)];
        continue;
      }
      if (isPromotion(move)) { scores[i] = (1 << 20) + MG_VALUE[movePromo(move)]; continue; }
      if (move === k0) { scores[i] = 1 << 19; continue; }
      if (move === k1) { scores[i] = (1 << 19) - 1; continue; }

      const piece = pos.board[moveFrom(move)];
      scores[i] = this.history[piece * 128 + moveTo(move)];
    }
    return scores;
  }

  /**
   * Remember a quiet move that caused a cutoff.
   *
   * Killers are per-ply and capture "this refutation works against most things the opponent
   * tries here"; history is global and captures "this piece going to this square tends to be
   * good in this game". They pull in different directions on purpose.
   */
  private recordCutoff(pos: Position, move: Move, depth: number, ply: number): void {
    const slot = ply * 2;
    if (this.killers[slot] !== move) {
      this.killers[slot + 1] = this.killers[slot];
      this.killers[slot] = move;
    }
    const piece = pos.board[moveFrom(move)];
    const idx = piece * 128 + moveTo(move);
    this.history[idx] += depth * depth;
    // Rescale before the table can overflow into nonsense ordering.
    if (this.history[idx] > (1 << 18)) {
      for (let i = 0; i < this.history.length; i++) this.history[i] >>= 1;
    }
  }

  private hasNonPawnMaterial(pos: Position): boolean {
    for (const sq of pos.pieces[pos.turn]) {
      const t = pieceType(pos.board[sq]);
      if (t !== PAWN && t !== KING) return true;
    }
    return false;
  }

  /**
   * Triangular PV table: row `ply` holds the best line from that ply on, indexed by absolute
   * ply so a child's row can be copied straight over its parent's tail.
   *
   * The line is worth keeping for its own sake — it is what the hint arrow and the analysis
   * readout show, and "the engine expects Nf3 Nc6 Bb5" is far more useful to a learning player
   * than a bare score.
   */
  private updatePv(ply: number, move: Move): void {
    const row = ply * MAX_PLY;
    const childRow = (ply + 1) * MAX_PLY;
    this.pv[row + ply] = move;
    const childLen = this.pvLength[ply + 1];
    for (let i = ply + 1; i < childLen; i++) this.pv[row + i] = this.pv[childRow + i];
    this.pvLength[ply] = childLen > ply + 1 ? childLen : ply + 1;
  }

  private orderRoot(pos: Position, moves: Move[], previousBest: Move): Move[] {
    const scored = moves.map((m) => {
      let s = 0;
      if (m === previousBest) s = 1 << 24;
      else if (isCapture(m)) {
        const victim = isEnPassant(m) ? PAWN : pieceType(pos.board[moveTo(m)]);
        s = (1 << 20) + MG_VALUE[victim];
      } else {
        s = this.history[pos.board[moveFrom(m)] * 128 + moveTo(m)];
      }
      return { m, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.m);
  }
}

/**
 * Difficulty levels.
 *
 * Depth alone is a poor difficulty dial — the gap between depth 2 and depth 4 is enormous and
 * the gap between 8 and 10 is barely visible — so each level combines a depth cap, a time
 * budget, evaluation noise and a chance of deliberately taking the second-best move. Beginner
 * still finds mate in one and still recaptures; it simply misses the deeper point of the
 * position, which is what makes it beatable without being silly.
 */
export interface Difficulty {
  key: string;
  label: string;
  blurb: string;
  maxDepth: number;
  maxTime: number;
  randomness: number;
  blunderChance: number;
  /** Approximate playing strength, shown so the ladder means something. */
  elo: number;
}

export const DIFFICULTIES: Difficulty[] = [
  { key: 'beginner', label: 'Beginner', blurb: 'Plays real moves, misses real plans.',
    maxDepth: 2, maxTime: 220, randomness: 130, blunderChance: 0.34, elo: 700 },
  { key: 'easy', label: 'Easy', blurb: 'Sees one move ahead and takes what you leave.',
    maxDepth: 3, maxTime: 350, randomness: 75, blunderChance: 0.18, elo: 1000 },
  { key: 'medium', label: 'Medium', blurb: 'A solid club opponent. Punishes loose pieces.',
    maxDepth: 5, maxTime: 700, randomness: 35, blunderChance: 0.07, elo: 1400 },
  { key: 'hard', label: 'Hard', blurb: 'Calculates tactics several moves deep.',
    maxDepth: 7, maxTime: 1300, randomness: 12, blunderChance: 0.02, elo: 1750 },
  { key: 'expert', label: 'Expert', blurb: 'Very strong. You will need a plan.',
    maxDepth: 10, maxTime: 2600, randomness: 0, blunderChance: 0, elo: 2050 },
  { key: 'master', label: 'Master', blurb: 'Full strength. No mercy, no mistakes.',
    maxDepth: 24, maxTime: 5200, randomness: 0, blunderChance: 0, elo: 2300 },
];

export const difficultyByKey = (key: string): Difficulty =>
  DIFFICULTIES.find((d) => d.key === key) ?? DIFFICULTIES[2];
