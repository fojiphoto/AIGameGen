/**
 * Chess clocks.
 *
 * Timed against `performance.now()` rather than counted down by an interval. An interval that
 * subtracts 100 ms every 100 ms drifts, and drifts *badly* the moment the tab is throttled — a
 * backgrounded tab gets its timers clamped to once a second or slower, so a player who alt-tabs
 * during a blitz game comes back with time they should not have. Reading a monotonic clock makes
 * the timer correct regardless of how often it is polled.
 *
 * Increment is applied on move completion, Fischer-style: the mover's clock gains the increment
 * after their move, which is what every online chess site does and what players expect.
 */

import { Color, WHITE, BLACK } from '../core/index.js';

export interface TimeControl {
  key: string;
  label: string;
  /** Minutes per side. 0 means no clock. */
  minutes: number;
  /** Seconds added per move. */
  increment: number;
  group: 'none' | 'bullet' | 'blitz' | 'rapid' | 'classical';
}

export const TIME_CONTROLS: TimeControl[] = [
  { key: 'none', label: 'No clock', minutes: 0, increment: 0, group: 'none' },
  { key: '1+0', label: 'Bullet 1+0', minutes: 1, increment: 0, group: 'bullet' },
  { key: '2+1', label: 'Bullet 2+1', minutes: 2, increment: 1, group: 'bullet' },
  { key: '3+0', label: 'Blitz 3+0', minutes: 3, increment: 0, group: 'blitz' },
  { key: '3+2', label: 'Blitz 3+2', minutes: 3, increment: 2, group: 'blitz' },
  { key: '5+0', label: 'Blitz 5+0', minutes: 5, increment: 0, group: 'blitz' },
  { key: '10+0', label: 'Rapid 10+0', minutes: 10, increment: 0, group: 'rapid' },
  { key: '15+10', label: 'Rapid 15+10', minutes: 15, increment: 10, group: 'rapid' },
  { key: '30+0', label: 'Classical 30+0', minutes: 30, increment: 0, group: 'classical' },
];

export const timeControlByKey = (key: string): TimeControl =>
  TIME_CONTROLS.find((t) => t.key === key) ?? TIME_CONTROLS[0];

export class ChessClock {
  /** Remaining milliseconds per colour. */
  private remaining: [number, number] = [0, 0];
  private running: Color | null = null;
  private startedAt = 0;
  private incrementMs = 0;
  enabled = false;
  /** Fires once when a side reaches zero. */
  onFlag: ((loser: Color) => void) | null = null;
  /** Fires when a side first drops under ten seconds, for the warning sound. */
  onLowTime: ((color: Color) => void) | null = null;
  private warned: [boolean, boolean] = [false, false];

  configure(control: TimeControl): void {
    this.enabled = control.minutes > 0;
    const ms = control.minutes * 60_000;
    this.remaining = [ms, ms];
    this.incrementMs = control.increment * 1000;
    this.running = null;
    this.warned = [false, false];
  }

  /** Hand the clock to a colour. Applies the increment to whoever just finished. */
  switchTo(color: Color): void {
    if (!this.enabled) return;
    if (this.running !== null) {
      this.commit();
      this.remaining[this.running] += this.incrementMs;
    }
    this.running = color;
    this.startedAt = performance.now();
  }

  start(color: Color): void {
    if (!this.enabled) return;
    this.running = color;
    this.startedAt = performance.now();
  }

  pause(): void {
    if (!this.enabled || this.running === null) return;
    this.commit();
    this.running = null;
  }

  private commit(): void {
    if (this.running === null) return;
    const now = performance.now();
    this.remaining[this.running] -= now - this.startedAt;
    this.startedAt = now;
  }

  /** Milliseconds left, live. Safe to call as often as the interface likes. */
  msLeft(color: Color): number {
    let ms = this.remaining[color];
    if (this.running === color) ms -= performance.now() - this.startedAt;
    return Math.max(0, ms);
  }

  get activeColor(): Color | null { return this.running; }

  /**
   * Poll. Returns the colour that has flagged, or null.
   *
   * Called from the interface's own tick rather than from a timer of its own, so there is one
   * place in the program that decides how often anything updates.
   */
  tick(): Color | null {
    if (!this.enabled || this.running === null) return null;
    for (const color of [WHITE, BLACK] as Color[]) {
      const left = this.msLeft(color);
      if (left <= 10_000 && !this.warned[color] && left > 0) {
        this.warned[color] = true;
        this.onLowTime?.(color);
      }
    }
    const left = this.msLeft(this.running);
    if (left <= 0) {
      const loser = this.running;
      this.commit();
      this.remaining[loser] = 0;
      this.running = null;
      this.onFlag?.(loser);
      return loser;
    }
    return null;
  }

  /** Give time back, for Undo. */
  addTime(color: Color, ms: number): void {
    this.remaining[color] += ms;
  }
}

/**
 * Format a clock for display.
 *
 * Under ten seconds it switches to tenths. That is not decoration — in a bullet finish the
 * difference between 2 seconds and 2.9 is the whole game, and a display that shows "0:02" for a
 * full second is lying to the player at the only moment they are watching it.
 */
export function formatClock(ms: number): string {
  if (ms <= 0) return '0:00';
  const total = Math.ceil(ms / 100) / 10;
  if (total < 10) return total.toFixed(1);
  const seconds = Math.ceil(total);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Elapsed match time, for the result panel. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export { WHITE, BLACK };
