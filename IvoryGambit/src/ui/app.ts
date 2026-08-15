/**
 * The application: screens, input, and the turn loop.
 *
 * One class, because everything here is one state machine and splitting it across files would
 * mean threading the same six references through every one of them. The sections below are the
 * seams that matter: screen management, the game loop, input, and each screen's markup.
 *
 * The turn loop is worth reading first. It is asynchronous end to end — a move animates, then
 * the engine is asked in a worker, then its reply animates — and every step checks that the game
 * it started in is still the game it is finishing in. Without that check, resigning mid-search
 * or hitting Undo during an animation lands a move on a board that has moved on, which is the
 * single most common way a chess interface corrupts itself.
 */

import {
  Position, Move, Color, WHITE, BLACK, generateLegal,
  moveFrom, moveTo, movePromo, isEnPassant, isCastle, isPromotion,
  pieceType, pieceColor, squareName, rankOf, fileOf, square,
  KNIGHT, BISHOP, ROOK, QUEEN, KING,
  outcomeTitle, toFen,
} from '../core/index.js';
import { DIFFICULTIES, difficultyByKey } from '../engine/index.js';
import { BoardView } from './board.js';
import { PIECE_SETS, IVORY_SET, pieceImage } from './pieces.js';
import { THEMES, themeByKey, applyTheme, Theme } from './theme.js';
import { AudioManager } from './audio.js';
import { SaveManager, MatchRecord } from './save.js';
import { TIME_CONTROLS, timeControlByKey, formatClock, formatDuration } from './clock.js';
import { LayoutManager, LayoutResult, pixelRatio, toggleFullscreen } from './layout.js';
import { EngineClient } from './engine-client.js';
import { Match, MatchConfig } from './match.js';
import {
  validPuzzles, loadPuzzle, tryPuzzleMove, puzzleHint, PuzzleState, Puzzle,
} from './puzzles.js';
import { el, $, clear, replace, esc, afterPaint } from './dom.js';

type ScreenName = 'menu' | 'setup' | 'game' | 'themes' | 'stats' | 'settings' | 'puzzles';

const PIECE_NAMES: Record<number, string> = {
  [QUEEN]: 'Queen', [ROOK]: 'Rook', [BISHOP]: 'Bishop', [KNIGHT]: 'Knight',
};

export class App {
  private root: HTMLElement;
  private screens = new Map<ScreenName, HTMLElement>();
  private modalRoot: HTMLElement;
  /**
   * Null until the first screen is shown.
   *
   * Not `'menu'`: `show()` returns early when asked for the screen already displayed, so seeding
   * this with the first screen's own name makes the opening `show('menu')` a no-op and the game
   * boots to an empty page with every screen built and none of them visible.
   */
  private current: ScreenName | null = null;

  private board: BoardView;
  private engine: EngineClient;
  private audio = new AudioManager();
  private save = new SaveManager();
  private layout: LayoutManager;
  private theme: Theme;

  private match: Match | null = null;
  private puzzle: PuzzleState | null = null;
  /**
   * Incremented whenever the game changes identity — new match, undo, resign, leaving the
   * screen. Every async step captures it and abandons itself if it no longer matches.
   */
  private generation = 0;

  private selected = -1;
  private dragFrom = -1;
  private dragStartedAt = 0;
  private pendingPromotion: { from: number; to: number } | null = null;
  private thinking = false;
  private tickTimer = 0;

  /** Setup screen state, held between visits so the panel remembers the last game. */
  private setupSide: 'white' | 'black' | 'random';
  private setupDifficulty: string;
  private setupClock: string;

  constructor(root: HTMLElement, workerUrl: string) {
    this.root = root;
    this.engine = new EngineClient(workerUrl);
    this.theme = themeByKey(this.save.settings.theme);

    this.setupSide = this.save.settings.lastSide;
    this.setupDifficulty = this.save.settings.lastDifficulty;
    this.setupClock = this.save.settings.lastClock;

    this.board = new BoardView({
      onSquareDown: (sq, x, y) => this.onPointerDown(sq, x, y),
      onSquareUp: (sq) => this.onPointerUp(sq),
      onDragMove: () => { /* the board redraws itself while dragging */ },
      onHover: () => { /* hover feedback is drawn by the board */ },
    });

    this.modalRoot = el('div', { class: 'modal-root' });
    this.layout = new LayoutManager(root, (r) => this.onLayout(r));

    this.audio.sfxEnabled = this.save.settings.sfx;
    this.audio.sfxVolume = this.save.settings.sfxVolume;
    this.audio.musicEnabled = this.save.settings.music;
    this.audio.musicVolume = this.save.settings.musicVolume;
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  start(): void {
    applyTheme(this.theme);
    this.board.setTheme(this.theme);
    this.board.setPieceSet(this.save.settings.pieceSet);
    this.applyDisplaySettings();

    this.buildScreens();
    this.root.append(this.modalRoot);
    this.root.setAttribute('aria-hidden', 'false');

    this.engine.start();
    this.layout.start();
    this.bindGlobalEvents();
    this.show('menu');

    // The clock and the "thinking" readout are the only things that need a heartbeat, and both
    // are text. Four times a second is smooth enough to read and ten times cheaper than a frame
    // loop that exists only to update a label.
    this.tickTimer = window.setInterval(() => this.tick(), 250);
  }

  private applyDisplaySettings(): void {
    const s = this.save.settings;
    this.board.showCoordinates = s.showCoordinates;
    this.board.showLegalMoves = s.showLegalMoves;
    this.board.animationScale = this.save.animationScale;
    this.board.setPieceSet(s.pieceSet);
  }

  private bindGlobalEvents(): void {
    // Audio can only be created inside a gesture. Any gesture will do, and it is idempotent.
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });

    /**
     * Losing focus.
     *
     * A backgrounded tab must not keep a blitz clock running, must not keep asking for frames,
     * and must not keep making noise. Coming back resumes all three — and the clock resumes
     * correctly because it reads a monotonic timestamp rather than counting ticks.
     */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.board.suspend();
        this.audio.suspend();
        if (this.match && !this.match.over && this.match.clock.enabled) {
          this.match.clock.pause();
          this.pausedByBlur = true;
        }
      } else {
        this.board.resume();
        this.audio.resume();
        // A hidden tab does not reliably deliver resize or ResizeObserver callbacks, so a device
        // rotated while the game was in the background comes back with the layout it had before.
        // Re-measuring on return costs nothing and is the only place that can catch it.
        this.layout.measure();
        if (this.pausedByBlur && this.match && !this.match.over) {
          this.match.clock.switchTo(this.match.turn);
          this.pausedByBlur = false;
        }
      }
    });

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private pausedByBlur = false;

  // ── screens ───────────────────────────────────────────────────────────────

  private buildScreens(): void {
    for (const name of ['menu', 'setup', 'game', 'themes', 'stats', 'settings', 'puzzles'] as ScreenName[]) {
      const section = el('section', { class: 'screen', id: `screen-${name}` });
      this.screens.set(name, section);
      this.root.append(section);
    }
    this.renderMenu();
    this.renderGameScreen();
  }

  private show(name: ScreenName): void {
    if (this.current === name) return;
    const previous = this.current ? this.screens.get(this.current) : null;
    if (previous) { previous.classList.remove('shown'); previous.classList.remove('active'); }

    // Rebuilt on entry rather than kept live: these screens read saved state that other screens
    // change, and re-reading on show is far more reliable than remembering to invalidate.
    if (name === 'setup') this.renderSetup();
    if (name === 'themes') this.renderThemes();
    if (name === 'stats') this.renderStats();
    if (name === 'settings') this.renderSettings();
    if (name === 'puzzles') this.renderPuzzleList();

    const next = this.screens.get(name)!;
    next.classList.add('active');
    // Two frames before `.shown`, or the transition has no previous style to run from and the
    // screen snaps in. See `afterPaint`.
    afterPaint(() => next.classList.add('shown'));
    this.current = name;

    if (name !== 'game') {
      this.engine.cancel();
      this.thinking = false;
    }
    if (name === 'game') this.layout.measure();
  }

  private leaveGame(): void {
    this.generation++;
    this.engine.cancel();
    this.thinking = false;
    this.match = null;
    this.puzzle = null;
    this.selected = -1;
    this.board.legalTargets = [];
    this.show('menu');
  }

  // ── main menu ─────────────────────────────────────────────────────────────

  private renderMenu(): void {
    const screen = this.screens.get('menu')!;
    const s = this.save.stats;
    replace(screen, el('div', { class: 'menu-inner' },
      el('h1', { class: 'title', text: 'IVORY GAMBIT' }),
      el('p', { class: 'tagline', text: 'Play the long game' }),
      el('div', { class: 'menu-buttons' },
        this.menuButton('PLAY', 'btn wide', () => this.show('setup')),
        this.menuButton('QUICK MATCH', 'btn ghost wide', () => this.startQuickMatch()),
        this.menuButton('PUZZLES', 'btn ghost wide', () => this.show('puzzles')),
        this.menuButton('TWO PLAYER', 'btn ghost wide', () => this.startLocalMatch()),
        this.menuButton('THEMES', 'btn ghost wide', () => this.show('themes')),
        this.menuButton('STATISTICS', 'btn ghost wide', () => this.show('stats')),
        this.menuButton('SETTINGS', 'btn ghost wide', () => this.show('settings')),
      ),
      el('div', { class: 'menu-foot' },
        el('span', { html: `<b>${s.played}</b> played` }),
        el('span', { html: `<b>${s.wins}</b> won` }),
        el('span', { html: `<b>${Math.round(this.save.winRate * 100)}%</b> win rate` }),
        s.bestStreak > 1 ? el('span', { html: `<b>${s.bestStreak}</b> best streak` }) : null,
      ),
    ));
  }

  private menuButton(label: string, cls: string, onClick: () => void): HTMLElement {
    return el('button', {
      class: cls,
      onclick: () => { this.audio.play('click'); onClick(); },
    }, label);
  }

  // ── match setup ───────────────────────────────────────────────────────────

  private renderSetup(): void {
    const screen = this.screens.get('setup')!;
    screen.className = 'screen sheet-screen';

    const sideField = el('div', { class: 'field' },
      el('label', { text: 'Your side' }),
      el('div', { class: 'choices' },
        ...(['white', 'black', 'random'] as const).map((side) =>
          el('button', {
            class: 'choice grow',
            'aria-pressed': String(this.setupSide === side),
            onclick: (e) => {
              this.setupSide = side;
              this.markPressed(e, '.choices');
              this.audio.play('click');
            },
          },
            el('b', { text: side === 'white' ? 'White' : side === 'black' ? 'Black' : 'Random' }),
            el('small', {
              text: side === 'white' ? 'You move first'
                : side === 'black' ? 'The engine opens' : 'Decided at the board',
            }),
          )),
      ));

    const difficultyField = el('div', { class: 'field' },
      el('label', { text: 'Opponent' }),
      el('div', { class: 'choices' },
        ...DIFFICULTIES.map((d) =>
          el('button', {
            class: 'choice grow',
            'aria-pressed': String(this.setupDifficulty === d.key),
            onclick: (e) => {
              this.setupDifficulty = d.key;
              this.markPressed(e, '.choices');
              this.audio.play('click');
            },
          },
            el('b', { text: `${d.label} · ${d.elo}` }),
            el('small', { text: d.blurb }),
          )),
      ));

    const clockField = el('div', { class: 'field' },
      el('label', { text: 'Clock' }),
      el('div', { class: 'choices' },
        ...TIME_CONTROLS.map((c) =>
          el('button', {
            class: 'choice',
            'aria-pressed': String(this.setupClock === c.key),
            onclick: (e) => {
              this.setupClock = c.key;
              this.markPressed(e, '.choices');
              this.audio.play('click');
            },
          }, c.label)),
      ));

    replace(screen, el('div', { class: 'sheet panel' },
      el('div', { class: 'sheet-head' },
        el('button', { class: 'back', onclick: () => this.show('menu') }, '←'),
        el('h2', { text: 'New game' }),
      ),
      sideField,
      difficultyField,
      clockField,
      el('button', {
        class: 'btn wide',
        onclick: () => this.startConfiguredMatch(),
      }, 'START GAME'),
    ));
  }

  /** Single-select behaviour for a `.choices` group, driven from the DOM rather than re-rendering. */
  private markPressed(event: Event, groupSelector: string): void {
    const button = (event.currentTarget as HTMLElement);
    const group = button.closest(groupSelector);
    if (!group) return;
    for (const other of Array.from(group.querySelectorAll('[aria-pressed]'))) {
      other.setAttribute('aria-pressed', String(other === button));
    }
  }

  // ── starting a game ───────────────────────────────────────────────────────

  private startConfiguredMatch(): void {
    const color: Color = this.setupSide === 'random'
      ? (Math.random() < 0.5 ? WHITE : BLACK)
      : this.setupSide === 'white' ? WHITE : BLACK;

    this.save.settings.lastSide = this.setupSide;
    this.save.settings.lastDifficulty = this.setupDifficulty;
    this.save.settings.lastClock = this.setupClock;
    this.save.saveSettings();

    this.beginMatch({
      mode: 'ai',
      playerColor: color,
      difficulty: this.setupDifficulty,
      timeControl: timeControlByKey(this.setupClock),
    });
  }

  private startQuickMatch(): void {
    this.beginMatch({
      mode: 'ai',
      playerColor: WHITE,
      difficulty: 'medium',
      timeControl: timeControlByKey('none'),
    });
  }

  private startLocalMatch(): void {
    this.beginMatch({
      mode: 'local',
      playerColor: WHITE,
      difficulty: 'medium',
      timeControl: timeControlByKey(this.save.settings.lastClock),
    });
  }

  private beginMatch(config: MatchConfig): void {
    this.generation++;
    this.engine.cancel();
    this.engine.reset();
    this.puzzle = null;
    this.match = new Match(config);
    this.selected = -1;
    this.thinking = false;
    this.pendingPromotion = null;

    // Orientation: the human's side is always at the bottom. In local play the board can rotate
    // between turns, which is what two people sharing one screen expect.
    this.board.flipped = config.mode === 'local' ? false : config.playerColor === BLACK;
    this.board.lastMove = null;
    this.board.hintMove = null;
    this.board.legalTargets = [];
    this.board.selected = -1;

    this.match.clock.onFlag = (loser) => this.onFlag(loser);
    this.match.clock.onLowTime = () => this.audio.play('lowTime');
    if (this.match.clock.enabled) this.match.clock.start(WHITE);

    this.syncBoard();
    this.show('game');
    this.audio.play('start');
    this.refreshHud();
    void this.maybeEngineMove();
  }

  // ── the game screen ───────────────────────────────────────────────────────

  private hud!: {
    top: HTMLElement; bottom: HTMLElement; side: HTMLElement;
    moves: HTMLElement; controls: HTMLElement;
    thinking: HTMLElement; flash: HTMLElement; drawer: HTMLElement;
  };

  private renderGameScreen(): void {
    const screen = this.screens.get('game')!;

    const boardArea = el('div', { class: 'board-area' });
    boardArea.append(this.board.canvas);
    const thinking = el('div', { class: 'thinking' },
      el('span', { class: 'spin' }), el('span', { class: 'label', text: 'Thinking' }));
    const flash = el('div', { class: 'flash' });
    boardArea.append(thinking, flash);

    const top = el('div', { class: 'player top' });
    const bottom = el('div', { class: 'player bottom' });
    const moves = el('div', { class: 'moves' });
    const historyPanel = el('div', { class: 'history panel' },
      el('h3', {}, el('span', { text: 'Moves' }), el('span', { class: 'opening' })),
      moves);
    const controls = el('div', { class: 'controls' });
    const side = el('div', { class: 'side' }, historyPanel);

    const drawer = el('div', { class: 'drawer panel' },
      el('div', { class: 'grip' }),
      el('div', { class: 'history' },
        el('h3', {},
          el('span', { text: 'Moves' }),
          el('button', { class: 'btn small ghost', onclick: () => this.toggleDrawer(false) }, 'Close')),
        el('div', { class: 'moves' })));

    // The control bar is a sibling of the side panel, not a child of it. In portrait the side
    // panel is hidden in favour of the drawer, and a nested control bar would disappear with it —
    // taking Undo, Hint and Resign off the screen on exactly the devices that need them most.
    replace(screen, el('div', { class: 'game-grid' }, top, boardArea, bottom, side, controls));
    this.root.append(drawer);

    this.hud = { top, bottom, side, moves, controls, thinking, flash, drawer };
    this.renderControls();
  }

  private renderControls(): void {
    const button = (key: string, label: string, onClick: () => void, id?: string) =>
      el('button', {
        class: 'icon-btn', id: id ? `ctl-${id}` : undefined,
        onclick: () => { this.audio.play('click'); onClick(); },
      }, el('span', { class: 'k', text: key }), el('span', { text: label }));

    replace(this.hud.controls,
      button('↶', 'Undo', () => this.undo(), 'undo'),
      button('✦', 'Hint', () => void this.showHint(), 'hint'),
      button('↻', 'Flip', () => this.flipBoard()),
      button('≡', 'Moves', () => this.toggleDrawer(), 'drawer'),
      button('⚑', 'Resign', () => this.confirmResign(), 'resign'),
      button('⤡', 'Full', () => void toggleFullscreen(this.root)),
      button('✕', 'Menu', () => this.confirmLeave()),
    );
  }

  private onLayout(result: LayoutResult): void {
    this.board.resize(result.boardSize, pixelRatio());
    // The side panel and the drawer are the same content in two places; exactly one is live.
    if (this.hud) this.hud.side.style.display = result.drawerHistory ? 'none' : '';
    const drawerBtn = $('#ctl-drawer');
    if (drawerBtn) drawerBtn.style.display = result.drawerHistory ? '' : 'none';
    if (!result.drawerHistory) this.toggleDrawer(false);
    this.refreshHud();
  }

  private toggleDrawer(force?: boolean): void {
    const open = force ?? !this.hud.drawer.classList.contains('open');
    this.hud.drawer.classList.toggle('open', open);
    if (open) this.renderMoveList($('.moves', this.hud.drawer)!);
  }

  private flipBoard(): void {
    this.board.flipped = !this.board.flipped;
    this.board.markDirty();
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  private refreshHud(): void {
    const match = this.match;
    if (!match || !this.hud) return;

    const caps = match.captures();
    const bottomColor: Color = this.board.flipped ? BLACK : WHITE;
    const topColor: Color = (bottomColor ^ 1) as Color;

    this.renderPlayer(this.hud.top, topColor, caps);
    this.renderPlayer(this.hud.bottom, bottomColor, caps);

    this.renderMoveList(this.hud.moves);
    if (this.hud.drawer.classList.contains('open')) {
      this.renderMoveList($('.moves', this.hud.drawer)!);
    }

    const opening = match.opening();
    const openingLabel = $('.opening', this.hud.side);
    if (openingLabel) openingLabel.textContent = opening ?? '';

    const undo = $('#ctl-undo') as HTMLButtonElement | null;
    if (undo) undo.toggleAttribute('disabled', !match.canUndo() || this.thinking);
    const hint = $('#ctl-hint') as HTMLButtonElement | null;
    if (hint) hint.toggleAttribute('disabled', match.over || this.thinking || !match.humanToMove);
    const resign = $('#ctl-resign') as HTMLButtonElement | null;
    if (resign) resign.toggleAttribute('disabled', match.over);
  }

  private renderPlayer(
    node: HTMLElement, color: Color,
    caps: { white: number[]; black: number[]; balance: number }
  ): void {
    const match = this.match!;
    const isHuman = match.config.mode === 'local' || color === match.config.playerColor;
    const difficulty = difficultyByKey(match.config.difficulty);
    const name = match.config.mode === 'local'
      ? (color === WHITE ? 'White' : 'Black')
      : isHuman ? 'You' : difficulty.label;
    const meta = match.config.mode === 'local'
      ? 'Local player'
      : isHuman ? (color === WHITE ? 'White' : 'Black') : `Engine · ${difficulty.elo}`;

    // Trophies: the pieces this side has taken are the *other* colour's missing pieces.
    const taken = color === WHITE ? caps.black : caps.white;
    const edge = color === WHITE ? caps.balance : -caps.balance;

    const strip = el('div', { class: 'captures' });
    for (const type of taken) {
      strip.append(el('img', {
        src: this.pieceIcon(type, (color ^ 1) as Color),
        alt: '', width: 19, height: 19,
      }));
    }
    if (edge > 0) strip.append(el('span', { class: 'edge', text: `+${edge}` }));

    const active = !match.over && match.turn === color;
    node.className = `player ${node.classList.contains('top') ? 'top' : 'bottom'}${active ? ' active' : ''}`;

    const children: (Node | null)[] = [
      el('span', { class: `dot ${color === WHITE ? 'w' : 'b'}` }),
      el('div', { class: 'who' },
        el('div', { class: 'name', text: name }),
        el('div', { class: 'meta', text: meta }),
        strip),
    ];

    if (match.clock.enabled) {
      const ms = match.clock.msLeft(color);
      children.push(el('div', {
        class: `clock${ms <= 10_000 && active ? ' low' : ''}`,
        text: formatClock(ms),
      }));
    }
    replace(node, ...children.filter(Boolean) as Node[]);
  }

  private iconCache = new Map<string, string>();

  /**
   * A piece as a data URL, cached per set and size.
   *
   * The size is a parameter and not a constant because the same helper feeds two very different
   * places: a 19px trophy in the captured-piece strip, and a 72px button in the promotion
   * dialog. Rendering one size and letting CSS scale it up is what makes a promotion dialog look
   * like a blurry afterthought — the pieces are drawn from paths, so the right size costs
   * nothing but asking for it.
   */
  private pieceIcon(type: number, color: Color, size = 26): string {
    const setKey = this.save.settings.pieceSet;
    const key = `${setKey}:${type}:${color}:${size}`;
    let url = this.iconCache.get(key);
    if (!url) {
      url = pieceImage(type, color, size, PIECE_SETS[setKey] ?? IVORY_SET);
      this.iconCache.set(key, url);
    }
    return url;
  }

  private renderMoveList(container: HTMLElement): void {
    const match = this.match;
    if (!match) return;
    const played = match.played;
    if (played.length === 0) {
      replace(container, el('div', { class: 'empty', text: 'No moves yet. White to play.' }));
      return;
    }

    const rows: HTMLElement[] = [];
    for (let i = 0; i < played.length; i += 2) {
      const number = Math.floor(i / 2) + 1;
      const cells: (HTMLElement | null)[] = [el('span', { class: 'no', text: `${number}.` })];
      for (let j = 0; j < 2; j++) {
        const index = i + j;
        if (index >= played.length) { cells.push(el('span', {})); continue; }
        cells.push(el('span', {
          class: `san${match.viewIndex === index + 1 ? ' current' : ''}`,
          onclick: () => this.seekTo(index + 1),
          text: played[index].san,
        }));
      }
      rows.push(el('div', { class: 'row' }, ...cells.filter(Boolean) as Node[]));
    }
    replace(container, ...rows);
    // Follow the game unless the player has scrolled back to review it.
    if (match.isLive) container.scrollTop = container.scrollHeight;
  }

  /**
   * Jump the board to a past position.
   *
   * Review is read-only: the live game is untouched, and moving a piece snaps straight back to
   * the present. Letting a player branch from a past position is a different feature (analysis)
   * and pretending to support it half-way is worse than not offering it.
   */
  private seekTo(index: number): void {
    const match = this.match;
    if (!match) return;
    if (!match.seek(index)) return;
    this.selected = -1;
    this.board.legalTargets = [];
    this.syncBoard();
    this.refreshHud();
  }

  private syncBoard(): void {
    const match = this.match;
    if (this.puzzle) {
      this.board.setPosition(this.puzzle.position);
      this.board.checkSquare = this.puzzle.position.inCheck()
        ? this.puzzle.position.kings[this.puzzle.position.turn] : -1;
      this.board.selected = this.selected;
      return;
    }
    if (!match) return;
    this.board.setPosition(match.viewPosition());
    this.board.lastMove = this.save.settings.highlightLastMove ? match.viewLastMove() : null;
    this.board.checkSquare = match.checkSquare();
    this.board.selected = this.selected;
    this.board.markDirty();
  }

  // ── input ─────────────────────────────────────────────────────────────────

  private onPointerDown(sq: number, x: number, y: number): void {
    this.audio.unlock();
    if (sq < 0) { this.clearSelection(); return; }
    if (this.pendingPromotion) return;

    const pos = this.activePosition();
    if (!pos || !this.canPlayerMove()) return;

    const piece = pos.board[sq];

    // Second click completes a move that a first click started.
    if (this.selected >= 0 && this.selected !== sq) {
      const move = this.findPlayerMove(this.selected, sq);
      if (move !== null) { this.commitPlayerMove(this.selected, sq); return; }
    }

    if (piece && pieceColor(piece) === pos.turn) {
      this.selected = sq;
      this.board.selected = sq;
      this.board.legalTargets = this.movesFrom(sq);
      this.board.hintMove = null;
      this.dragFrom = sq;
      this.dragStartedAt = performance.now();
      this.board.startDrag(pieceType(piece), pieceColor(piece), sq);
      this.board.markDirty();
      void x; void y;
      return;
    }

    this.clearSelection();
  }

  private onPointerUp(sq: number): void {
    if (this.dragFrom < 0) return;
    const from = this.dragFrom;
    this.dragFrom = -1;
    this.board.endDrag();

    // A tap that never travelled is a *selection*, not a drop — otherwise every tap-to-select on
    // a phone would also try to move the piece onto its own square and clear the selection.
    const wasTap = performance.now() - this.dragStartedAt < 220 && sq === from;
    if (wasTap || sq < 0) { this.board.markDirty(); return; }

    if (sq === from) { this.board.markDirty(); return; }

    const move = this.findPlayerMove(from, sq);
    if (move === null) {
      // The invalid drop returns the piece and says so, quietly.
      this.audio.play('illegal');
      this.board.markDirty();
      return;
    }
    this.commitPlayerMove(from, sq);
  }

  private activePosition(): Position | null {
    if (this.puzzle) return this.puzzle.position;
    if (this.match) return this.match.viewPosition();
    return null;
  }

  private canPlayerMove(): boolean {
    if (this.puzzle) return true;
    const match = this.match;
    if (!match) return false;
    if (match.over || this.thinking) return false;
    if (!match.isLive) {
      // Touching a piece while reviewing jumps back to the live game rather than doing nothing,
      // which is what a player who has forgotten they scrolled back actually wants.
      match.seek(match.played.length);
      this.syncBoard();
      this.refreshHud();
    }
    return match.humanToMove;
  }

  private movesFrom(sq: number): Move[] {
    if (this.puzzle) {
      const pos = this.puzzle.position;
      const piece = pos.board[sq];
      return piece && pieceColor(piece) === pos.turn ? legalFrom(pos, sq) : [];
    }
    return this.match?.movesFrom(sq) ?? [];
  }

  private findPlayerMove(from: number, to: number): Move | null {
    if (this.puzzle) {
      return legalFrom(this.puzzle.position, from).find((m) => moveTo(m) === to) ?? null;
    }
    const match = this.match;
    if (!match) return null;
    const choices = match.promotionChoices(from, to);
    if (choices.length > 0) return choices[0];
    return match.findMove(from, to);
  }

  private clearSelection(): void {
    if (this.selected < 0 && this.board.legalTargets.length === 0) return;
    this.selected = -1;
    this.board.selected = -1;
    this.board.legalTargets = [];
    this.board.markDirty();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();

    if (key === 'escape') {
      if (this.modalRoot.classList.contains('active')) { this.closeModal(); return; }
      if (this.current === 'game') this.confirmLeave();
      else if (this.current !== 'menu') this.show('menu');
      return;
    }
    if (this.current !== 'game' || !this.match) return;

    switch (key) {
      case 'u': this.undo(); break;
      case 'h': void this.showHint(); break;
      case 'f': this.flipBoard(); break;
      case 'm': this.toggleDrawer(); break;
      case 'arrowleft': this.seekTo(this.match.viewIndex - 1); break;
      case 'arrowright': this.seekTo(this.match.viewIndex + 1); break;
      case 'home': this.seekTo(0); break;
      case 'end': this.seekTo(this.match.played.length); break;
      default: return;
    }
    e.preventDefault();
  }

  // ── playing a move ────────────────────────────────────────────────────────

  private commitPlayerMove(from: number, to: number): void {
    if (this.puzzle) { this.playPuzzleMove(from, to); return; }
    const match = this.match;
    if (!match) return;

    const choices = match.promotionChoices(from, to);
    if (choices.length > 1 && !this.save.settings.autoQueen) {
      this.pendingPromotion = { from, to };
      this.clearSelection();
      this.openPromotionDialog(choices, match.turn);
      return;
    }

    const move = match.findMove(from, to, this.save.settings.autoQueen ? QUEEN : 0);
    if (move === null) { this.audio.play('illegal'); return; }
    void this.applyMove(move);
  }

  /**
   * Play a move and drive everything that follows from it.
   *
   * Sound, animation, HUD, board rotation in local play, end-of-game handling, and then the
   * engine's reply. Kept in one place so the order is visible: the audio fires with the move
   * rather than after the animation, because a delayed click feels like input lag even when it
   * is not.
   */
  private async applyMove(move: Move): Promise<void> {
    const match = this.match;
    if (!match) return;
    const generation = this.generation;

    const before = match.position.clone();
    const from = moveFrom(move), to = moveTo(move);
    const piece = before.board[from];
    const captureSquare = isEnPassant(move)
      ? to - (pieceColor(piece) === WHITE ? 16 : -16)
      : to;
    const captured = before.board[captureSquare];

    const record = match.play(move);
    if (!record) return;

    this.clearSelection();
    this.board.hintMove = null;

    if (captured) {
      this.board.animateCapture(pieceType(captured), pieceColor(captured), captureSquare);
    }
    this.board.animateMove(pieceType(piece), pieceColor(piece), from, to);
    if (isCastle(move)) {
      // The rook travels too. Animating only the king is the classic tell of a chess UI that
      // treats castling as a special case bolted on afterwards.
      const rank = rankOf(from);
      const rookFrom = square(isCastle(move) && fileOf(to) === 6 ? 7 : 0, rank);
      const rookTo = square(fileOf(to) === 6 ? 5 : 3, rank);
      this.board.animateMove(ROOK, pieceColor(piece), rookFrom, rookTo);
    }

    this.audio.play(
      isPromotion(move) ? 'promote'
        : isCastle(move) ? 'castle'
        : captured ? 'capture'
        : 'move');

    this.syncBoard();
    this.refreshHud();

    await this.waitForAnimation();
    if (generation !== this.generation) return;

    if (match.position.inCheck() && !match.over) {
      this.audio.play('check');
      this.flash('CHECK');
    }

    if (match.over) { this.endMatch(); return; }

    // Local two-player: rotate the board so the player to move is at the bottom.
    if (match.config.mode === 'local' && this.save.settings.rotateBoardLocal) {
      this.board.flipped = match.turn === BLACK;
      this.board.markDirty();
      this.refreshHud();
    }

    void this.maybeEngineMove();
  }

  /**
   * Wait for the board to finish moving pieces.
   *
   * Polled on a timer, deliberately, and never on `requestAnimationFrame`.
   *
   * A hidden tab fires no animation frames at all. Waiting on one there does not merely pause the
   * game, it *deadlocks the turn loop*: the move that was mid-flight never completes, so the
   * engine is never asked for its reply, and coming back to the tab finds a board that has
   * stopped accepting input for good. Switching tabs while a piece slides is an entirely ordinary
   * thing to do, so this has to survive it.
   *
   * The deadline is the second half of the same defence — if an animation is somehow never
   * cleared, the game continues a beat late rather than never.
   */
  private waitForAnimation(): Promise<void> {
    if (!this.board.animating) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = performance.now() + 2000;
      const timer = window.setInterval(() => {
        if (this.board.animating && performance.now() < deadline && !document.hidden) return;
        window.clearInterval(timer);
        resolve();
      }, 32);
    });
  }

  private async maybeEngineMove(): Promise<void> {
    const match = this.match;
    if (!match || match.over || match.config.mode !== 'ai') return;
    if (match.humanToMove) return;

    const generation = this.generation;
    this.thinking = true;
    this.setThinking(true, 'Thinking');
    this.refreshHud();

    const reply = await this.engine.think(match.position, match.startFen, match.played.map((p) => p.move), {
      difficulty: match.config.difficulty,
      onProgress: (depth, score, mateIn) => {
        if (generation !== this.generation) return;
        const label = mateIn !== 0
          ? `Mate in ${Math.abs(mateIn)}`
          : `Depth ${depth}`;
        this.setThinking(true, label);
        void score;
      },
    });

    if (generation !== this.generation) return;
    this.thinking = false;
    this.setThinking(false);

    if (!reply.move) {
      // No move came back: either the search was cancelled, or the game is genuinely over.
      this.refreshHud();
      if (match.over) this.endMatch();
      return;
    }
    await this.applyMove(reply.move);
  }

  private setThinking(on: boolean, label = 'Thinking'): void {
    if (!this.hud) return;
    this.hud.thinking.classList.toggle('on', on);
    const text = $('.label', this.hud.thinking);
    if (text) text.textContent = label;
  }

  private flash(text: string, good = false): void {
    if (!this.hud) return;
    const node = this.hud.flash;
    node.textContent = text;
    node.classList.toggle('good', good);
    node.classList.add('on');
    window.setTimeout(() => node.classList.remove('on'), 900);
  }

  // ── promotion ─────────────────────────────────────────────────────────────

  private openPromotionDialog(choices: Move[], color: Color): void {
    const buttons = choices
      .slice()
      .sort((a, b) => movePromo(b) - movePromo(a))
      .map((move) => el('button', {
        onclick: () => {
          this.closeModal();
          const pending = this.pendingPromotion;
          this.pendingPromotion = null;
          if (!pending) return;
          void this.applyMove(move);
        },
      },
        el('img', { src: this.pieceIcon(movePromo(move), color, 72), alt: '' }),
        el('span', { text: PIECE_NAMES[movePromo(move)] ?? '' }),
      ));

    this.openModal(el('div', { class: 'modal panel' },
      el('h2', { text: 'Promotion' }),
      el('div', { class: 'headline', text: 'Choose a piece' }),
      el('p', { class: 'reason', text: 'Your pawn has reached the far rank.' }),
      el('div', { class: 'promo-choices' }, ...buttons),
    ), () => {
      // Dismissing the dialog cancels the move rather than picking for the player.
      this.pendingPromotion = null;
      this.syncBoard();
    });
  }

  // ── ending ────────────────────────────────────────────────────────────────

  private onFlag(loser: Color): void {
    const match = this.match;
    if (!match || match.over) return;
    match.flag(loser);
    this.endMatch();
  }

  private endMatch(): void {
    const match = this.match;
    if (!match) return;
    this.engine.cancel();
    this.thinking = false;
    this.setThinking(false);
    this.syncBoard();
    this.refreshHud();

    const result = match.result;
    const playerWon = result.winner !== null
      && (match.config.mode === 'local' || result.winner === match.config.playerColor);
    const drawn = result.winner === null;

    this.audio.play(drawn ? 'draw' : playerWon ? 'win' : 'lose');

    if (match.config.mode === 'ai') {
      const record: MatchRecord = {
        at: Date.now(),
        result: drawn ? 'draw' : playerWon ? 'win' : 'loss',
        reason: result.reason,
        playerColor: match.config.playerColor === WHITE ? 'white' : 'black',
        mode: 'Player vs AI',
        difficulty: difficultyByKey(match.config.difficulty).label,
        moves: Math.ceil(match.played.length / 2),
        durationMs: match.durationMs,
        san: match.sanList(),
      };
      const index = DIFFICULTIES.findIndex((d) => d.key === match.config.difficulty);
      this.save.recordMatch(record, index);
      this.renderMenu();
    }

    // A beat before the panel, so the final move is seen landing rather than being covered by a
    // dialog the instant it arrives.
    window.setTimeout(() => this.showResult(), 620);
  }

  private showResult(): void {
    const match = this.match;
    if (!match) return;
    const result = match.result;
    const drawn = result.winner === null;
    const playerWon = !drawn
      && (match.config.mode === 'local' || result.winner === match.config.playerColor);

    const headline = match.config.mode === 'local'
      ? (drawn ? 'Draw' : `${result.winner === WHITE ? 'White' : 'Black'} wins`)
      : drawn ? 'Draw' : playerWon ? 'You win' : 'You lose';

    const caps = match.captures();
    const captureCount = caps.white.length + caps.black.length;

    this.openModal(el('div', { class: 'modal panel' },
      el('h2', { text: outcomeTitle({ ...result, over: true, claimableDraw: null }) }),
      el('div', { class: 'headline', text: headline }),
      el('p', { class: 'reason', text: result.reason }),
      el('div', { class: 'result-stats' },
        stat(String(Math.ceil(match.played.length / 2)), 'Moves'),
        stat(formatDuration(match.durationMs), 'Duration'),
        stat(String(captureCount), 'Captures'),
        stat(match.opening() ?? '—', 'Opening'),
      ),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => { this.closeModal(); this.rematch(); } }, 'REMATCH'),
        el('button', {
          class: 'btn ghost',
          onclick: () => { this.closeModal(); this.show('setup'); },
        }, 'NEW GAME'),
        el('button', {
          class: 'btn ghost',
          onclick: () => { this.closeModal(); this.seekTo(0); },
        }, 'REVIEW THE GAME'),
        el('button', {
          class: 'btn ghost',
          onclick: () => { this.closeModal(); this.leaveGame(); },
        }, 'MAIN MENU'),
      ),
    ));
  }

  private rematch(): void {
    const match = this.match;
    if (!match) return;
    const config = { ...match.config };
    // Swap sides on a rematch against the engine, which is what an opponent across a real board
    // would do and quietly balances the colour statistics.
    if (config.mode === 'ai') config.playerColor = (config.playerColor ^ 1) as Color;
    this.beginMatch(config);
  }

  private undo(): void {
    const match = this.match;
    if (!match || !match.canUndo()) return;
    this.generation++;            // abandon any search in flight
    this.engine.cancel();
    this.thinking = false;
    this.setThinking(false);
    match.undo();
    this.clearSelection();
    this.board.hintMove = null;
    if (match.config.mode === 'local' && this.save.settings.rotateBoardLocal) {
      this.board.flipped = match.turn === BLACK;
    }
    this.audio.play('click');
    this.syncBoard();
    this.refreshHud();
  }

  private async showHint(): Promise<void> {
    const match = this.match;
    if (this.puzzle) {
      const move = puzzleHint(this.puzzle);
      if (move) { this.board.hintMove = move; this.board.markDirty(); }
      return;
    }
    if (!match || match.over || !match.humanToMove || this.thinking) return;

    this.thinking = true;
    this.setThinking(true, 'Finding a good move');
    this.refreshHud();
    const generation = this.generation;

    // Hints ignore the opponent's difficulty: a beginner asking for help wants the *best* move,
    // not a beginner-level one.
    const reply = await this.engine.think(match.position, match.startFen, match.played.map((p) => p.move), {
      difficulty: 'expert', maxDepth: 8, maxTime: 1200, useBook: false,
    });

    if (generation !== this.generation) return;
    this.thinking = false;
    this.setThinking(false);
    this.refreshHud();

    if (reply.move) {
      this.board.hintMove = reply.move;
      this.board.markDirty();
      window.setTimeout(() => {
        if (generation === this.generation) { this.board.hintMove = null; this.board.markDirty(); }
      }, 4000);
    }
  }

  private confirmResign(): void {
    const match = this.match;
    if (!match || match.over) return;
    const resign = () => {
      const color = match.config.mode === 'local' ? match.turn : match.config.playerColor;
      match.resign(color);
      this.endMatch();
    };
    if (!this.save.settings.confirmResign) { resign(); return; }
    this.confirm('Resign?', 'The game will be recorded as a loss.', 'RESIGN', resign);
  }

  private confirmLeave(): void {
    const match = this.match;
    if (!match || match.over) { this.leaveGame(); return; }
    this.confirm(
      'Leave the game?',
      'This game will not be saved.',
      'LEAVE',
      () => this.leaveGame());
  }

  // ── puzzles ───────────────────────────────────────────────────────────────

  private renderPuzzleList(): void {
    const screen = this.screens.get('puzzles')!;
    screen.className = 'screen sheet-screen';
    const puzzles = validPuzzles();
    const solved = this.save.puzzleProgress;

    replace(screen, el('div', { class: 'sheet panel' },
      el('div', { class: 'sheet-head' },
        el('button', { class: 'back', onclick: () => this.show('menu') }, '←'),
        el('h2', { text: 'Puzzles' }),
      ),
      el('p', { class: 'hint-text',
        text: `${Object.keys(solved).length} of ${puzzles.length} solved. `
            + 'Each one teaches a single idea — find the move the position is asking for.' }),
      el('div', { class: 'puzzle-list' },
        ...puzzles.map((p) => el('button', {
          class: 'puzzle-card',
          onclick: () => this.startPuzzle(p),
        },
          el('span', { class: 'pk', text: kindLabel(p.kind) }),
          el('span', { class: 'pt' },
            el('b', { text: p.title }),
            el('small', { text: p.brief })),
          solved[p.id] ? el('span', { class: 'done', text: '✓' }) : null,
        )),
      ),
    ));
  }

  private startPuzzle(puzzle: Puzzle): void {
    const state = loadPuzzle(puzzle);
    if (!state) return;
    this.generation++;
    this.engine.cancel();
    this.match = null;
    this.puzzle = state;
    this.selected = -1;
    this.board.flipped = state.position.turn === BLACK;
    this.board.lastMove = null;
    this.board.hintMove = null;
    this.board.legalTargets = [];
    this.syncBoard();
    this.show('game');
    this.renderPuzzleHud();
    this.flash(puzzle.brief.toUpperCase(), true);
  }

  private renderPuzzleHud(): void {
    const state = this.puzzle;
    if (!state || !this.hud) return;
    const toMove = state.position.turn === WHITE ? 'White' : 'Black';

    replace(this.hud.top,
      el('span', { class: `dot ${state.position.turn === WHITE ? 'w' : 'b'}` }),
      el('div', { class: 'who' },
        el('div', { class: 'name', text: state.puzzle.title }),
        el('div', { class: 'meta', text: state.puzzle.brief })));

    replace(this.hud.bottom,
      el('div', { class: 'who' },
        el('div', { class: 'name', text: `${toMove} to play` }),
        el('div', { class: 'meta', text: kindLabel(state.puzzle.kind) })));

    replace(this.hud.moves, el('div', { class: 'empty', text: state.puzzle.brief }));

    replace(this.hud.controls,
      el('button', { class: 'icon-btn', onclick: () => void this.showHint() },
        el('span', { class: 'k', text: '✦' }), el('span', { text: 'Hint' })),
      el('button', { class: 'icon-btn', onclick: () => this.startPuzzle(state.puzzle) },
        el('span', { class: 'k', text: '↻' }), el('span', { text: 'Retry' })),
      el('button', { class: 'icon-btn', onclick: () => { this.puzzle = null; this.show('puzzles'); } },
        el('span', { class: 'k', text: '✕' }), el('span', { text: 'Puzzles' })),
    );
  }

  private playPuzzleMove(from: number, to: number): void {
    const state = this.puzzle;
    if (!state) return;
    const move = legalFrom(state.position, from).find((m) => moveTo(m) === to);
    if (!move) { this.audio.play('illegal'); return; }

    const before = state.position.clone();
    const piece = before.board[from];
    const captured = before.board[to];

    const attempt = tryPuzzleMove(state, move);
    if (!attempt.correct) {
      this.audio.play('illegal');
      this.flash('NOT THIS ONE');
      this.clearSelection();
      this.board.markDirty();
      return;
    }

    this.clearSelection();
    if (captured) this.board.animateCapture(pieceType(captured), pieceColor(captured), to);
    this.board.animateMove(pieceType(piece), pieceColor(piece), from, to);
    this.audio.play(captured ? 'capture' : 'move');

    if (attempt.reply) {
      const rFrom = moveFrom(attempt.reply), rTo = moveTo(attempt.reply);
      // The reply has already been made on the position, so its piece is read from the board it
      // came from rather than the one it landed on.
      const replyPiece = state.position.board[rTo];
      window.setTimeout(() => {
        this.board.animateMove(pieceType(replyPiece), pieceColor(replyPiece), rFrom, rTo);
        this.audio.play('move');
        this.syncBoard();
      }, 260);
    }

    this.syncBoard();

    if (attempt.solved) {
      window.setTimeout(() => {
        this.audio.play('win');
        const first = this.save.markPuzzleSolved(state.puzzle.id);
        this.openModal(el('div', { class: 'modal panel' },
          el('h2', { text: 'Solved' }),
          el('div', { class: 'headline', text: state.puzzle.title }),
          el('p', { class: 'reason', text: state.puzzle.lesson }),
          first ? el('p', { class: 'hint-text', text: 'First time — added to your record.' }) : null,
          el('div', { class: 'actions' },
            el('button', {
              class: 'btn',
              onclick: () => { this.closeModal(); this.nextPuzzle(state.puzzle); },
            }, 'NEXT PUZZLE'),
            el('button', {
              class: 'btn ghost',
              onclick: () => { this.closeModal(); this.puzzle = null; this.show('puzzles'); },
            }, 'ALL PUZZLES'),
          ),
        ));
      }, 620);
    }
  }

  private nextPuzzle(after: Puzzle): void {
    const all = validPuzzles();
    const index = all.findIndex((p) => p.id === after.id);
    const next = all[index + 1];
    if (next) this.startPuzzle(next);
    else { this.puzzle = null; this.show('puzzles'); }
  }

  // ── themes, stats, settings ───────────────────────────────────────────────

  private renderThemes(): void {
    const screen = this.screens.get('themes')!;
    screen.className = 'screen sheet-screen';

    const themeCards = THEMES.map((t) => el('button', {
      class: 'theme-card',
      'aria-pressed': String(t.key === this.theme.key),
      onclick: (e) => {
        this.theme = t;
        this.save.settings.theme = t.key;
        this.save.settings.pieceSet = t.pieces;
        this.save.saveSettings();
        applyTheme(t);
        this.board.setTheme(t);
        this.iconCache.clear();
        this.markPressed(e, '.theme-grid');
        this.audio.play('click');
        this.refreshHud();
      },
    },
      el('div', {
        class: 'theme-swatch',
        style: `background: repeating-conic-gradient(${t.light} 0% 25%, ${t.dark} 0% 50%) 0 0 / 34px 34px`,
      }),
      el('div', { class: 'tl' }, el('b', { text: t.name }), el('small', { text: t.blurb })),
    ));

    const setCards = Object.keys(PIECE_SETS).map((key) => el('button', {
      class: 'choice grow',
      'aria-pressed': String(key === this.save.settings.pieceSet),
      onclick: (e) => {
        this.save.settings.pieceSet = key;
        this.save.saveSettings();
        this.board.setPieceSet(key);
        this.iconCache.clear();
        this.markPressed(e, '.choices');
        this.audio.play('click');
        this.refreshHud();
      },
    },
      el('img', {
        src: pieceImage(KING, WHITE, 30, PIECE_SETS[key]),
        alt: '', width: 26, height: 26, style: 'vertical-align:-6px;margin-right:6px',
      }),
      key[0].toUpperCase() + key.slice(1),
    ));

    replace(screen, el('div', { class: 'sheet panel' },
      el('div', { class: 'sheet-head' },
        el('button', { class: 'back', onclick: () => this.show('menu') }, '←'),
        el('h2', { text: 'Themes' }),
      ),
      el('div', { class: 'theme-grid' }, ...themeCards),
      el('div', { class: 'field' },
        el('label', { text: 'Piece material' }),
        el('div', { class: 'choices' }, ...setCards)),
    ));
  }

  private renderStats(): void {
    const screen = this.screens.get('stats')!;
    screen.className = 'screen sheet-screen';
    const s = this.save.stats;
    const best = s.bestDifficultyBeaten >= 0
      ? DIFFICULTIES[s.bestDifficultyBeaten]?.label ?? '—' : '—';

    const history = this.save.history.length === 0
      ? [el('p', { class: 'hint-text', text: 'No games yet. Your last thirty will appear here.' })]
      : this.save.history.map((m) => el('div', { class: 'match' },
          el('span', { class: `badge ${m.result}`, text: m.result.toUpperCase() }),
          el('span', {
            text: `${m.difficulty} · ${m.playerColor === 'white' ? 'White' : 'Black'} · ${m.moves} moves`,
          }),
          el('span', { class: 'm', text: relativeDate(m.at) }),
        ));

    replace(screen, el('div', { class: 'sheet panel' },
      el('div', { class: 'sheet-head' },
        el('button', { class: 'back', onclick: () => this.show('menu') }, '←'),
        el('h2', { text: 'Statistics' }),
      ),
      el('div', { class: 'stat-grid' },
        stat(String(s.played), 'Played', 'stat'),
        stat(String(s.wins), 'Wins', 'stat'),
        stat(String(s.losses), 'Losses', 'stat'),
        stat(String(s.draws), 'Draws', 'stat'),
        stat(`${Math.round(this.save.winRate * 100)}%`, 'Win rate', 'stat'),
        stat(String(s.winsAsWhite), 'As White', 'stat'),
        stat(String(s.winsAsBlack), 'As Black', 'stat'),
        stat(best, 'Best beaten', 'stat'),
        stat(String(s.checkmatesDelivered), 'Checkmates', 'stat'),
        stat(String(s.puzzlesSolved), 'Puzzles', 'stat'),
        stat(s.fastestWinMs ? formatDuration(s.fastestWinMs) : '—', 'Fastest win', 'stat'),
        stat(String(s.streak), 'Streak', 'stat'),
        stat(String(s.bestStreak), 'Best streak', 'stat'),
        stat(String(s.totalMoves), 'Total moves', 'stat'),
      ),
      el('div', { class: 'field' },
        el('label', { text: 'Recent matches' }),
        el('div', { class: 'match-list' }, ...history)),
      el('button', {
        class: 'btn ghost',
        onclick: () => this.confirm(
          'Reset everything?',
          'Statistics, match history and puzzle progress will be erased.',
          'RESET',
          () => { this.save.resetStats(); this.renderStats(); this.renderMenu(); }),
      }, 'RESET STATISTICS'),
    ));
  }

  private renderSettings(): void {
    const screen = this.screens.get('settings')!;
    screen.className = 'screen sheet-screen';
    const s = this.save.settings;

    const toggle = (
      label: string, description: string, get: () => boolean, set: (v: boolean) => void
    ) => {
      const button = el('button', {
        class: 'toggle', 'aria-pressed': String(get()), 'aria-label': label,
        onclick: () => {
          const next = !get();
          set(next);
          button.setAttribute('aria-pressed', String(next));
          this.save.saveSettings();
          this.applyDisplaySettings();
          this.board.markDirty();
          this.audio.play('click');
        },
      });
      return el('div', { class: 'row-item' },
        el('div', { class: 'rl' }, el('b', { text: label }), el('small', { text: description })),
        button);
    };

    const options = <T extends string>(
      label: string, description: string, values: readonly T[],
      get: () => T, set: (v: T) => void
    ) => el('div', { class: 'row-item' },
      el('div', { class: 'rl' }, el('b', { text: label }), el('small', { text: description })),
      el('div', { class: 'choices' },
        ...values.map((v) => el('button', {
          class: 'choice', 'aria-pressed': String(get() === v),
          onclick: (e) => {
            set(v);
            this.save.saveSettings();
            this.applyDisplaySettings();
            this.markPressed(e, '.choices');
            this.audio.play('click');
          },
        }, v[0].toUpperCase() + v.slice(1)))));

    const slider = (
      label: string, get: () => number, set: (v: number) => void
    ) => el('div', { class: 'row-item' },
      el('div', { class: 'rl' }, el('b', { text: label })),
      el('input', {
        type: 'range', min: '0', max: '100', value: String(Math.round(get() * 100)),
        oninput: (e) => {
          set(Number((e.target as HTMLInputElement).value) / 100);
          this.save.saveSettings();
        },
      }));

    replace(screen, el('div', { class: 'sheet panel' },
      el('div', { class: 'sheet-head' },
        el('button', { class: 'back', onclick: () => this.show('menu') }, '←'),
        el('h2', { text: 'Settings' }),
      ),

      el('div', { class: 'field' },
        el('label', { text: 'Gameplay' }),
        el('div', { class: 'rows' },
          toggle('Legal move hints', 'Show where the selected piece can go',
            () => s.showLegalMoves, (v) => { s.showLegalMoves = v; }),
          toggle('Board coordinates', 'Files and ranks around the board',
            () => s.showCoordinates, (v) => {
              s.showCoordinates = v;
              this.board.showCoordinates = v;
              this.layout.measure();
              this.board.resize(this.board.canvas.clientWidth, pixelRatio());
            }),
          toggle('Highlight the last move', 'Mark the squares the last move used',
            () => s.highlightLastMove, (v) => { s.highlightLastMove = v; this.syncBoard(); }),
          toggle('Auto-queen', 'Promote to a queen without asking',
            () => s.autoQueen, (v) => { s.autoQueen = v; }),
          toggle('Rotate in two-player', 'Turn the board to face whoever is on move',
            () => s.rotateBoardLocal, (v) => { s.rotateBoardLocal = v; }),
          toggle('Confirm resignation', 'Ask before ending a game',
            () => s.confirmResign, (v) => { s.confirmResign = v; }),
        )),

      el('div', { class: 'field' },
        el('label', { text: 'Graphics' }),
        el('div', { class: 'rows' },
          options('Animation speed', 'How fast pieces travel',
            ['off', 'fast', 'normal', 'slow'] as const,
            () => s.animationSpeed, (v) => { s.animationSpeed = v; }),
          options('Effects', 'Glows, shadows and the animated background',
            ['low', 'high'] as const,
            () => s.effectsQuality, (v) => {
              s.effectsQuality = v;
              document.documentElement.dataset.effects = v;
            }),
        )),

      el('div', { class: 'field' },
        el('label', { text: 'Audio' }),
        el('div', { class: 'rows' },
          toggle('Sound effects', 'Moves, captures, check and results',
            () => s.sfx, (v) => { s.sfx = v; this.audio.sfxEnabled = v; if (v) this.audio.play('click'); }),
          slider('Effects volume', () => s.sfxVolume, (v) => {
            s.sfxVolume = v; this.audio.sfxVolume = v;
          }),
          toggle('Ambient music', 'Slow generated pads, off by default',
            () => s.music, (v) => { s.music = v; this.audio.setMusic(v, s.musicVolume); }),
          slider('Music volume', () => s.musicVolume, (v) => {
            s.musicVolume = v; this.audio.setMusic(s.music, v);
          }),
        )),

      el('p', { class: 'hint-text',
        text: 'Keyboard: U undo · H hint · F flip · M moves · arrows to review · Esc to leave.' }),
    ));
  }

  // ── modals ────────────────────────────────────────────────────────────────

  private modalDismiss: (() => void) | null = null;

  private openModal(content: HTMLElement, onDismiss?: () => void): void {
    this.modalDismiss = onDismiss ?? null;
    replace(this.modalRoot, content);
    this.modalRoot.classList.add('active');
    afterPaint(() => this.modalRoot.classList.add('shown'));
    this.modalRoot.onclick = (e) => {
      if (e.target === this.modalRoot) this.closeModal();
    };
  }

  private closeModal(): void {
    if (!this.modalRoot.classList.contains('active')) return;
    this.modalRoot.classList.remove('shown');
    const dismiss = this.modalDismiss;
    this.modalDismiss = null;
    window.setTimeout(() => {
      this.modalRoot.classList.remove('active');
      clear(this.modalRoot);
    }, 200);
    dismiss?.();
  }

  private confirm(title: string, body: string, confirmLabel: string, onConfirm: () => void): void {
    this.openModal(el('div', { class: 'modal panel' },
      el('div', { class: 'headline', text: title }),
      el('p', { class: 'reason', text: body }),
      el('div', { class: 'actions row' },
        el('button', { class: 'btn ghost', onclick: () => this.closeModal() }, 'CANCEL'),
        el('button', {
          class: 'btn',
          onclick: () => { this.closeModal(); onConfirm(); },
        }, confirmLabel),
      ),
    ));
  }

  // ── heartbeat ─────────────────────────────────────────────────────────────

  private tick(): void {
    const match = this.match;
    if (!match || this.current !== 'game') return;
    if (match.clock.enabled && !match.over) {
      match.clock.tick();
      this.refreshHud();
    }
  }

  dispose(): void {
    window.clearInterval(this.tickTimer);
    this.layout.stop();
    this.engine.dispose();
  }
}

// ── small helpers ───────────────────────────────────────────────────────────

function stat(value: string, label: string, cls = ''): HTMLElement {
  return el('div', { class: cls },
    el('div', { class: 'v', text: value }),
    el('div', { class: 'l', text: label }));
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'mate-1': return 'Mate in 1';
    case 'mate-2': return 'Mate in 2';
    case 'material': return 'Win material';
    default: return 'Defence';
  }
}

function relativeDate(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

/** Legal moves for one square, without going through a Match — used by puzzle mode. */
function legalFrom(pos: Position, from: number): Move[] {
  return generateLegal(pos).filter((m) => moveFrom(m) === from);
}

export { esc, squareName, toFen };
