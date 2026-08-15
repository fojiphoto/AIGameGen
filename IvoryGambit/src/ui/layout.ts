/**
 * Responsive layout.
 *
 * The board is the only element whose size is computed in JavaScript, and it is computed as one
 * number. Everything else is CSS grid and flexbox, which the browser is better at than any
 * measuring code — but a canvas has to be told its pixel size, and a chess board that is one
 * pixel wider than it is tall is immediately, obviously wrong.
 *
 * So: measure the space actually available, take the smaller dimension, round it down to a
 * multiple of eight, and hand back a single square edge. Rounding to eight is not fussiness —
 * a board of 401 pixels gives squares of 50.125, and the accumulated fraction shows up as
 * uneven-looking ranks and a seam down the side. Eight-pixel multiples make every square an
 * exact integer.
 *
 * Three layouts, chosen by aspect ratio rather than by width alone: a phone held sideways is
 * 700 pixels wide and wants the landscape layout, while a narrow desktop window at the same
 * width wants the portrait one. Aspect ratio asks the question that actually matters — is there
 * more room beside the board, or above and below it?
 */

export type LayoutMode = 'desktop' | 'portrait' | 'landscape-compact';

export interface LayoutResult {
  mode: LayoutMode;
  /** CSS pixels, one edge of the square board. */
  boardSize: number;
  /** True when the move history must open as a drawer rather than sit beside the board. */
  drawerHistory: boolean;
}

/** Below this the side panel stops fitting beside a usable board. */
const DESKTOP_MIN_WIDTH = 900;
const SIDE_PANEL_WIDTH = 300;

/**
 * Reserved heights, measured from the rendered interface rather than estimated.
 *
 * A player strip comes out at 80px (two lines of text plus the captured-piece row) and the
 * control bar at 89px, because seven buttons wrap to two rows in a 300px column. Guessing these
 * low is the mistake that puts the bottom rank under the edge of the window, so each carries a
 * little headroom over what it measures.
 */
const STRIP = 84, BAR = 92, GAP = 14;

/**
 * The layout decision, as a pure function of the viewport.
 *
 * Separated from the DOM so it can be tested directly. Board sizing is the one piece of layout
 * this game cannot delegate to CSS — a canvas has to be told its pixel size — and it is also the
 * piece with a hard correctness requirement: the board must be exactly square at every viewport
 * on every device. That deserves a test, and a function that needs a browser to run cannot have
 * one.
 */
export function computeLayout(width: number, height: number): LayoutResult {
  const aspect = width / Math.max(1, height);

  let mode: LayoutMode;
  if (width >= DESKTOP_MIN_WIDTH && aspect > 1.15) mode = 'desktop';
  else if (aspect > 1.25) mode = 'landscape-compact';
  else mode = 'portrait';

  let availableW: number;
  let availableH: number;
  switch (mode) {
    case 'desktop':
      // The control bar shares its row with the bottom strip, so it costs the taller of the two.
      availableW = width - SIDE_PANEL_WIDTH - 96;
      availableH = height - (STRIP + BAR + GAP * 2 + 48);
      break;
    case 'landscape-compact':
      // The strips move into the side columns, so the board keeps nearly the full height.
      availableW = width - 320;
      availableH = height - 28;
      break;
    default:
      // Portrait: a strip above and below, plus the control bar under them.
      availableW = width - 24;
      availableH = height - (STRIP * 2 + BAR + GAP * 3 + 24);
      break;
  }

  /**
   * One number for both dimensions, rounded down to a multiple of eight.
   *
   * Taking the smaller dimension is what guarantees the board is square — there is no code path
   * in which a width and a height can disagree. The multiple of eight is not fussiness: a board
   * of 401 pixels gives squares of 50.125, and the accumulated fraction shows up as ranks of
   * visibly different heights and a seam down one side.
   */
  const raw = Math.max(200, Math.min(availableW, availableH));
  const boardSize = Math.floor(raw / 8) * 8;

  return { mode, boardSize, drawerHistory: mode !== 'desktop' };
}

export class LayoutManager {
  private observer: ResizeObserver | null = null;
  private lastKey = '';

  constructor(
    private root: HTMLElement,
    private onChange: (result: LayoutResult) => void
  ) {}

  start(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.measure());
      this.observer.observe(this.root);
    }
    // ResizeObserver does not fire on an orientation change that keeps the same element box,
    // and on iOS the viewport height changes without any element resizing at all when the
    // address bar collapses. Both events are cheap and both are needed.
    window.addEventListener('resize', this.measure);
    window.addEventListener('orientationchange', this.measure);
    this.measure();
  }

  stop(): void {
    this.observer?.disconnect();
    window.removeEventListener('resize', this.measure);
    window.removeEventListener('orientationchange', this.measure);
  }

  measure = (): void => {
    const width = this.root.clientWidth || window.innerWidth;
    const height = this.root.clientHeight || window.innerHeight;
    const result = computeLayout(width, height);

    const key = `${result.mode}:${result.boardSize}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // On `<html>`, not on the app container: the stylesheet keys every layout rule off
    // `html[data-layout=…]`, and an attribute set one element lower matches nothing at all —
    // which leaves the grid with no template and every panel stacked in one cell.
    document.documentElement.dataset.layout = result.mode;
    this.onChange(result);
  };
}

/**
 * Device pixel ratio, capped.
 *
 * Uncapped, a 4x display asks for sixteen times the pixels of a 1x one, which on a phone is the
 * difference between a smooth board and a hot one. Three is past the point where any further
 * sharpness is visible on a chess piece.
 */
export const pixelRatio = (): number => Math.min(3, Math.max(1, window.devicePixelRatio || 1));

/** Fullscreen, where the browser allows it. Silently does nothing where it does not. */
export async function toggleFullscreen(target: HTMLElement = document.documentElement): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (target.requestFullscreen) await target.requestFullscreen();
  } catch {
    // iOS Safari on iPhone has no element fullscreen at all. Not an error worth surfacing.
  }
}
