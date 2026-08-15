/**
 * The interface logic, tested without a browser.
 *
 * Everything here is a decision the game makes rather than a pixel it draws: how big the board
 * should be at a given viewport, what the clock reads, what the save layer does with corrupt
 * data, whether Undo takes back the right number of moves. All of it is reachable from Node
 * because none of it touches the DOM — which is why it was written that way.
 *
 * The board-size tests carry the most weight. "The board must always be perfectly square" is a
 * hard requirement, and it is exactly the kind of requirement that a visual check passes on the
 * three window sizes anyone happens to try and fails on the fourth.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFen, startPosition, fromSan, moveToUci, WHITE, BLACK } from '../build/test/core.mjs';
import {
  computeLayout, formatClock, formatDuration, ChessClock, TIME_CONTROLS, timeControlByKey,
  Match, SaveManager, DEFAULT_SETTINGS, DEFAULT_STATS,
  validPuzzles, loadPuzzle, tryPuzzleMove, puzzleHint, PUZZLES,
  THEMES, themeByKey, PIECE_SETS,
} from '../build/test/ui.mjs';

// ── layout ──────────────────────────────────────────────────────────────────

/** A spread of real devices, plus the awkward sizes in between. */
const VIEWPORTS = [
  ['iPhone SE portrait', 375, 667],
  ['iPhone 14 portrait', 390, 844],
  ['iPhone 14 landscape', 844, 390],
  ['Pixel 7 portrait', 412, 915],
  ['iPad portrait', 768, 1024],
  ['iPad landscape', 1024, 768],
  ['iPad Pro landscape', 1366, 1024],
  ['laptop', 1440, 900],
  ['desktop', 1920, 1080],
  ['ultrawide', 3440, 1440],
  ['tiny', 320, 480],
  ['short and wide', 1280, 420],
  ['almost square', 800, 780],
  ['very tall', 400, 1600],
];

for (const [name, width, height] of VIEWPORTS) {
  test(`layout: ${name} (${width}x${height}) keeps the board square and on screen`, () => {
    const layout = computeLayout(width, height);

    assert.ok(layout.boardSize >= 200, 'the board must stay usable');
    assert.equal(layout.boardSize % 8, 0,
      `${layout.boardSize} is not a multiple of 8, so squares would be fractional`);

    // The board must fit the width it was given, whatever the mode.
    assert.ok(layout.boardSize <= width,
      `board ${layout.boardSize} is wider than the ${width}px viewport`);

    // …and the height, once its own chrome is accounted for. 200 is the floor the sizer
    // enforces, below which a board is unusable anyway and something has to give.
    if (layout.boardSize > 200) {
      assert.ok(layout.boardSize <= height,
        `board ${layout.boardSize} is taller than the ${height}px viewport`);
    }
  });
}

test('layout mode follows the shape of the viewport, not its width alone', () => {
  // A phone in landscape and a narrow desktop window can be the same width and want different
  // layouts; the aspect ratio is the question that actually distinguishes them.
  assert.equal(computeLayout(844, 390).mode, 'landscape-compact', 'phone on its side');
  assert.equal(computeLayout(844, 1100).mode, 'portrait', 'same width, tall window');
  assert.equal(computeLayout(1440, 900).mode, 'desktop');
  assert.equal(computeLayout(390, 844).mode, 'portrait');
  assert.equal(computeLayout(768, 1024).mode, 'portrait', 'tablet upright');
  assert.equal(computeLayout(1024, 768).mode, 'desktop', 'tablet on its side has room for the panel');
});

test('the move panel becomes a drawer wherever it will not fit beside the board', () => {
  assert.equal(computeLayout(1440, 900).drawerHistory, false);
  assert.equal(computeLayout(390, 844).drawerHistory, true);
  assert.equal(computeLayout(844, 390).drawerHistory, true);
});

test('the board grows with the window and never shrinks as it gets bigger', () => {
  let previous = 0;
  for (let w = 900; w <= 2400; w += 100) {
    const size = computeLayout(w, 1000).boardSize;
    assert.ok(size >= previous, `board shrank from ${previous} to ${size} at width ${w}`);
    previous = size;
  }
});

// ── clock ───────────────────────────────────────────────────────────────────

test('the clock reads in minutes normally and in tenths under ten seconds', () => {
  assert.equal(formatClock(3 * 60_000), '3:00');
  assert.equal(formatClock(65_000), '1:05');
  assert.equal(formatClock(9_400), '9.4');
  assert.equal(formatClock(900), '0.9');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(-50), '0:00');
  assert.equal(formatClock(3_600_000), '1:00:00');
});

test('duration is formatted for the result panel', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(95_000), '1:35');
});

test('every time control is coherent, and unknown keys fall back to no clock', () => {
  for (const c of TIME_CONTROLS) {
    assert.ok(c.minutes >= 0 && c.increment >= 0, c.key);
    assert.ok(c.label.length > 0);
  }
  assert.equal(timeControlByKey('nonsense').key, 'none');
  assert.equal(timeControlByKey('3+2').increment, 2);
});

test('the clock counts down, applies increment on the switch, and flags', () => {
  const clock = new ChessClock();
  clock.configure({ key: 't', label: 't', minutes: 1, increment: 5, group: 'blitz' });
  assert.ok(clock.enabled);
  assert.equal(clock.msLeft(WHITE), 60_000);

  clock.start(WHITE);
  const before = clock.msLeft(WHITE);
  // Busy-wait a few milliseconds: the clock reads a monotonic timestamp, so it needs real time
  // to pass rather than a counter to be nudged.
  const until = Date.now() + 12;
  while (Date.now() < until) { /* spin */ }
  assert.ok(clock.msLeft(WHITE) < before, 'the running side loses time');
  assert.equal(clock.msLeft(BLACK), 60_000, 'the idle side does not');

  clock.switchTo(BLACK);
  assert.ok(clock.msLeft(WHITE) > 60_000, 'the mover gains the increment');
  assert.equal(clock.activeColor, BLACK);

  clock.pause();
  assert.equal(clock.activeColor, null);
});

test('a clock with no time control never runs', () => {
  const clock = new ChessClock();
  clock.configure(timeControlByKey('none'));
  assert.equal(clock.enabled, false);
  clock.start(WHITE);
  assert.equal(clock.tick(), null);
});

// ── match ───────────────────────────────────────────────────────────────────

const aiConfig = (overrides = {}) => ({
  mode: 'ai',
  playerColor: WHITE,
  difficulty: 'medium',
  timeControl: timeControlByKey('none'),
  ...overrides,
});

test('a match only accepts legal moves and records them in notation', () => {
  const match = new Match(aiConfig());
  const e4 = fromSan(match.position, 'e4');
  const record = match.play(e4);
  assert.ok(record);
  assert.equal(record.san, 'e4');
  assert.equal(match.played.length, 1);
  assert.equal(match.turn, BLACK);

  // A move that is not legal here must be refused rather than corrupting the board.
  assert.equal(match.play(0), null);
  assert.equal(match.played.length, 1);
});

test('it is the human to move only on the human side, and always in local play', () => {
  const vsAi = new Match(aiConfig({ playerColor: WHITE }));
  assert.equal(vsAi.humanToMove, true);
  vsAi.play(fromSan(vsAi.position, 'e4'));
  assert.equal(vsAi.humanToMove, false);

  const local = new Match(aiConfig({ mode: 'local' }));
  local.play(fromSan(local.position, 'e4'));
  assert.equal(local.humanToMove, true, 'both sides are human on one device');
});

test('undo takes back a pair against the engine and a single move locally', () => {
  const vsAi = new Match(aiConfig());
  vsAi.play(fromSan(vsAi.position, 'e4'));
  vsAi.play(fromSan(vsAi.position, 'e5'));
  assert.equal(vsAi.undo(), 2, 'the player move and the reply');
  assert.equal(vsAi.played.length, 0);

  const local = new Match(aiConfig({ mode: 'local' }));
  local.play(fromSan(local.position, 'e4'));
  local.play(fromSan(local.position, 'e5'));
  assert.equal(local.undo(), 1);
  assert.equal(local.played.length, 1);
});

test('undo cannot go back past the start', () => {
  const match = new Match(aiConfig());
  assert.equal(match.undo(), 0);
  assert.equal(match.canUndo(), false);
});

test('a match ends on checkmate with the right winner and reason', () => {
  const match = new Match(aiConfig({ mode: 'local' }));
  for (const san of ['f3', 'e5', 'g4', 'Qh4#']) {
    assert.ok(match.play(fromSan(match.position, san)), san);
  }
  assert.ok(match.over);
  assert.equal(match.result.outcome, 'checkmate');
  assert.equal(match.result.winner, BLACK);
  assert.ok(match.result.reason.includes('checkmate'));
});

test('resignation names the resigning side and hands the game to the other', () => {
  const match = new Match(aiConfig());
  match.resign(WHITE);
  assert.equal(match.result.outcome, 'resignation');
  assert.equal(match.result.winner, BLACK);
  assert.ok(match.over);
});

/**
 * The timeout rule people forget: running out of time is only a loss if the opponent could
 * actually have delivered mate. Against a bare king it is a draw.
 */
test('a flag is a loss, unless the opponent has no mating material', () => {
  const losable = new Match(aiConfig({ startFen: '4k3/8/8/8/8/8/8/3QK3 w - - 0 1' }));
  losable.flag(BLACK);
  assert.equal(losable.result.outcome, 'timeout');
  assert.equal(losable.result.winner, WHITE);

  const drawn = new Match(aiConfig({ startFen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }));
  drawn.flag(BLACK);
  assert.equal(drawn.result.outcome, 'timeout');
  assert.equal(drawn.result.winner, null, 'a bare king cannot mate, so it is a draw');
});

test('a claimable draw can be claimed, and cannot be claimed when it is not offered', () => {
  const match = new Match(aiConfig({ mode: 'local', startFen: '4k3/8/8/8/8/8/8/R3K2R w - - 0 1' }));
  assert.equal(match.claimDraw(), false, 'nothing to claim yet');
  for (let round = 0; round < 2; round++) {
    for (const san of ['Kf1', 'Kd8', 'Ke1', 'Ke8']) match.play(fromSan(match.position, san));
  }
  assert.equal(match.status.claimableDraw, 'repetition');
  assert.equal(match.claimDraw(), true);
  assert.equal(match.result.outcome, 'repetition');
});

test('promotion offers four choices between the same two squares', () => {
  const match = new Match(aiConfig({ startFen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1' }));
  const from = 'a7'.charCodeAt(0) - 97 + ((7 - 1) << 4);
  const to = 'a8'.charCodeAt(0) - 97 + ((8 - 1) << 4);
  assert.equal(match.promotionChoices(from, to).length, 4);
  // Asking for a specific piece gets that piece; asking for nothing gets a queen.
  assert.equal(moveToUci(match.findMove(from, to)), 'a7a8q');
});

test('reviewing a past position does not disturb the live game', () => {
  const match = new Match(aiConfig({ mode: 'local' }));
  for (const san of ['e4', 'e5', 'Nf3']) match.play(fromSan(match.position, san));
  assert.ok(match.isLive);

  match.seek(1);
  assert.equal(match.isLive, false);
  assert.equal(match.viewPosition().turn, BLACK, 'the board shown is after 1.e4');
  assert.equal(match.played.length, 3, 'the game itself is untouched');
  assert.equal(match.play(fromSan(match.position, 'Nc6')), null, 'and cannot be branched');

  match.seek(match.played.length);
  assert.ok(match.isLive);
});

test('captures and material balance are derived from the board', () => {
  const match = new Match(aiConfig({ mode: 'local' }));
  for (const san of ['e4', 'd5', 'exd5']) match.play(fromSan(match.position, san));
  const caps = match.captures();
  assert.equal(caps.black.length, 1, 'White has taken one black pawn');
  assert.equal(caps.balance, 1);
});

test('the opening is named from the moves played', () => {
  const match = new Match(aiConfig({ mode: 'local' }));
  for (const san of ['e4', 'c5']) match.play(fromSan(match.position, san));
  assert.equal(match.opening(), 'Sicilian Defence');
});

test('the king in check is reported so the board can highlight it', () => {
  const match = new Match(aiConfig({ mode: 'local', startFen: '4k3/8/8/8/8/8/8/R5K1 w - - 0 1' }));
  assert.equal(match.checkSquare(), -1, 'nobody is in check yet');
  const check = fromSan(match.position, 'Ra8+');
  assert.ok(check, 'Ra8+ should be legal');
  match.play(check);
  assert.notEqual(match.checkSquare(), -1, 'the black king is now in check');
});

// ── save layer ──────────────────────────────────────────────────────────────

/** A localStorage good enough to test against, including its failure modes. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

test('settings and statistics survive a round trip', () => {
  globalThis.localStorage = fakeStorage();
  const a = new SaveManager();
  a.settings.theme = 'neon';
  a.settings.sfxVolume = 0.25;
  a.saveSettings();
  a.stats.wins = 7;
  a.saveStats();

  const b = new SaveManager();
  assert.equal(b.settings.theme, 'neon');
  assert.equal(b.settings.sfxVolume, 0.25);
  assert.equal(b.stats.wins, 7);
});

test('corrupt storage falls back to defaults instead of failing to start', () => {
  const storage = fakeStorage();
  globalThis.localStorage = storage;
  storage.setItem('ivorygambit.settings', '{ this is not json');
  storage.setItem('ivorygambit.stats', 'null');
  storage.setItem('ivorygambit.history', '"not an array"');

  const save = new SaveManager();
  assert.equal(save.settings.theme, DEFAULT_SETTINGS.theme);
  assert.equal(save.stats.played, DEFAULT_STATS.played);
  assert.deepEqual(save.history, []);
  // …and the unreadable value is cleared, so it cannot fail again on every load.
  assert.equal(storage.getItem('ivorygambit.settings'), null);
});

test('settings written by an older version are merged, not adopted wholesale', () => {
  const storage = fakeStorage();
  globalThis.localStorage = storage;
  // A stored object from a build that had fewer keys, and one key of the wrong type.
  storage.setItem('ivorygambit.settings', JSON.stringify({
    version: 1, theme: 'forest', showLegalMoves: 'yes-please',
  }));
  const save = new SaveManager();
  assert.equal(save.settings.theme, 'forest', 'valid values are kept');
  assert.equal(save.settings.showLegalMoves, DEFAULT_SETTINGS.showLegalMoves,
    'a value of the wrong type is replaced by the default');
  assert.equal(save.settings.autoQueen, DEFAULT_SETTINGS.autoQueen, 'missing keys are filled in');
});

test('storage that throws on access does not take the game down', () => {
  globalThis.localStorage = {
    getItem() { throw new Error('access denied'); },
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { throw new Error('nope'); },
  };
  const save = new SaveManager();
  assert.equal(save.settings.theme, DEFAULT_SETTINGS.theme);
  save.saveSettings();          // must not throw
  save.stats.wins = 3;
  save.saveStats();             // must not throw
});

test('recording a match updates every statistic it should', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  const record = {
    at: Date.now(), result: 'win', reason: 'White delivers checkmate',
    playerColor: 'white', mode: 'Player vs AI', difficulty: 'Hard',
    moves: 31, durationMs: 420_000, san: [],
  };
  save.recordMatch(record, 3);

  assert.equal(save.stats.played, 1);
  assert.equal(save.stats.wins, 1);
  assert.equal(save.stats.winsAsWhite, 1);
  assert.equal(save.stats.checkmatesDelivered, 1);
  assert.equal(save.stats.bestDifficultyBeaten, 3);
  assert.equal(save.stats.streak, 1);
  assert.equal(save.stats.fastestWinMs, 420_000);
  assert.equal(save.history.length, 1);

  save.recordMatch({ ...record, result: 'loss' }, 3);
  assert.equal(save.stats.streak, 0, 'a loss breaks the streak');
  assert.equal(save.stats.bestStreak, 1, 'but the best is remembered');

  save.recordMatch({ ...record, result: 'draw' }, 3);
  assert.equal(save.stats.draws, 1);
  assert.equal(save.stats.streak, 0, 'a draw neither builds nor breaks a streak');
});

test('a faster win replaces the record; a slower one does not', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  const base = {
    at: Date.now(), result: 'win', reason: 'checkmate', playerColor: 'black',
    mode: 'Player vs AI', difficulty: 'Easy', moves: 20, san: [],
  };
  save.recordMatch({ ...base, durationMs: 300_000 }, 1);
  save.recordMatch({ ...base, durationMs: 500_000 }, 1);
  assert.equal(save.stats.fastestWinMs, 300_000);
  save.recordMatch({ ...base, durationMs: 120_000 }, 1);
  assert.equal(save.stats.fastestWinMs, 120_000);
  assert.equal(save.stats.winsAsBlack, 3);
});

test('the match history is capped so storage cannot grow without bound', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  for (let i = 0; i < 45; i++) {
    save.recordMatch({
      at: Date.now() - i, result: 'draw', reason: 'x', playerColor: 'white',
      mode: 'Player vs AI', difficulty: 'Easy', moves: 5, durationMs: 1000, san: [],
    }, 0);
  }
  assert.ok(save.history.length <= 30, `history grew to ${save.history.length}`);
});

test('a puzzle counts once, however many times it is solved', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  assert.equal(save.markPuzzleSolved('backrank-1'), true);
  assert.equal(save.markPuzzleSolved('backrank-1'), false);
  assert.equal(save.stats.puzzlesSolved, 1);
});

test('animation speed maps to a scale, and Off means no animation at all', () => {
  globalThis.localStorage = fakeStorage();
  const save = new SaveManager();
  for (const [speed, expected] of [['off', 0], ['fast', 0.6], ['normal', 1], ['slow', 1.7]]) {
    save.settings.animationSpeed = speed;
    assert.equal(save.animationScale, expected);
  }
});

// ── puzzles ─────────────────────────────────────────────────────────────────

test('every built-in puzzle is legal chess with a legal solution', () => {
  assert.equal(validPuzzles().length, PUZZLES.length,
    'a puzzle whose data does not hold up is worse than no puzzle');
});

test('a mate-in-one puzzle accepts its solution and rejects anything else', () => {
  const state = loadPuzzle(PUZZLES.find((p) => p.id === 'backrank-1'));
  assert.ok(state);
  const wrong = fromSan(state.position, 'Ra7');
  assert.equal(tryPuzzleMove(state, wrong).correct, false);
  assert.equal(state.step, 0, 'a wrong move does not advance the puzzle');

  const right = fromSan(state.position, 'Ra8#');
  const attempt = tryPuzzleMove(state, right);
  assert.equal(attempt.correct, true);
  assert.equal(attempt.solved, true);
});

test('a mate-in-two plays the scripted reply and then finishes', () => {
  const state = loadPuzzle(PUZZLES.find((p) => p.id === 'squeeze-2'));
  assert.ok(state);
  const first = tryPuzzleMove(state, fromSan(state.position, state.puzzle.solution[0]));
  assert.equal(first.correct, true);
  assert.equal(first.solved, false);
  assert.ok(first.reply, 'the opponent answers');

  const second = tryPuzzleMove(state, fromSan(state.position, state.puzzle.solution[2]));
  assert.equal(second.correct, true);
  assert.equal(second.solved, true);
});

test('a puzzle hint is the move the puzzle is waiting for', () => {
  const state = loadPuzzle(PUZZLES.find((p) => p.id === 'smothered-1'));
  const hint = puzzleHint(state);
  assert.ok(hint);
  assert.equal(tryPuzzleMove(state, hint).correct, true);
});

test('puzzles cover more than one idea and are labelled', () => {
  const kinds = new Set(PUZZLES.map((p) => p.kind));
  assert.ok(kinds.size >= 3, 'a set that only teaches one thing is a list, not a course');
  for (const p of PUZZLES) {
    assert.ok(p.title && p.brief && p.lesson, `${p.id} is missing its copy`);
    assert.ok(!p.brief.includes(p.solution[0]), `${p.id} gives away the answer in the brief`);
  }
});

// ── themes ──────────────────────────────────────────────────────────────────

test('every theme defines every colour the renderer reads', () => {
  const required = [
    'light', 'dark', 'frame', 'frameEdge', 'coordinate', 'lastMove', 'selected', 'legal',
    'capture', 'check', 'hint', 'bg', 'bgAccent', 'surface', 'surfaceEdge', 'text', 'muted',
    'accent', 'accentInk', 'pieces',
  ];
  for (const theme of THEMES) {
    for (const key of required) {
      assert.ok(theme[key], `${theme.key} is missing ${key}`);
    }
    assert.ok(PIECE_SETS[theme.pieces], `${theme.key} names a piece set that does not exist`);
  }
});

/**
 * Contrast between the two square colours.
 *
 * Not a pixel-perfect accessibility audit — it is the check that catches a theme where the
 * light and dark squares have drifted so close together that the board stops reading as a
 * board, which is easy to do while tuning colours and impossible to unsee afterwards.
 */
test('light and dark squares stay far enough apart to read as a board', () => {
  const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const theme of THEMES) {
    const a = luminance(theme.light) + 0.05;
    const b = luminance(theme.dark) + 0.05;
    const ratio = Math.max(a, b) / Math.min(a, b);
    assert.ok(ratio >= 1.8,
      `${theme.key}: squares differ by only ${ratio.toFixed(2)}:1`);
  }
});

test('an unknown theme falls back rather than leaving the game unstyled', () => {
  assert.equal(themeByKey('does-not-exist').key, THEMES[0].key);
  assert.equal(themeByKey('neon').key, 'neon');
});
