/**
 * Input: keyboard, touch and gamepad, funnelled into one struct.
 *
 * The game never asks "is a key down" — it reads an `InputState`, and that is the reason the
 * whole controller is testable and the reason three very different devices produce identical
 * movement. Adding a fourth input method means writing to the same struct and changing nothing
 * else.
 *
 * Touch is the part with real design in it. A platformer on a phone lives or dies on whether the
 * thumbs can find the buttons without looking, so the left pad is a single wide zone split down
 * the middle rather than two small circles, the jump button is large and sits under the right
 * thumb's resting position, and both have a generous invisible margin around their drawn size.
 * Multi-touch is tracked per pointer id, so holding left while tapping jump works — which the
 * naive single-pointer implementation gets wrong and which is most of the game.
 */

import { InputState, emptyInput } from '../core/index.js';

export interface TouchButton {
  id: 'left' | 'right' | 'jump' | 'dash' | 'pause';
  x: number; y: number; w: number; h: number;
  /** Extra hit area beyond the drawn shape. */
  pad: number;
  label: string;
}

export type InputMethod = 'keyboard' | 'touch' | 'gamepad';

export class InputManager {
  state: InputState = emptyInput();
  /** The last method that produced input, so the touch overlay can hide itself on a desktop. */
  method: InputMethod = 'keyboard';
  /** Set for one frame when pause is requested from any device. */
  pausePressed = false;

  private keys = new Set<string>();
  private prevJump = false;
  private prevDash = false;
  private prevPause = false;
  private touchButtons: TouchButton[] = [];
  private activeTouches = new Map<number, string>();
  private canvas: HTMLCanvasElement | null = null;
  private scale = () => ({ sx: 1, sy: 1, ox: 0, oy: 0 });

  /** Held so the listeners can be removed cleanly. */
  private detachers: (() => void)[] = [];

  attach(canvas: HTMLCanvasElement, scale: () => { sx: number; sy: number; ox: number; oy: number }): void {
    this.canvas = canvas;
    this.scale = scale;

    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      // Let the browser have its own shortcuts; only claim what the game uses.
      const claimed = [
        'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
        'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'ShiftLeft', 'ShiftRight',
        'Escape', 'KeyP', 'Enter',
      ];
      if (!claimed.includes(e.code)) return;
      if (e.repeat && down) return;
      e.preventDefault();
      if (down) this.keys.add(e.code); else this.keys.delete(e.code);
      this.method = 'keyboard';
    };
    const kd = onKey(true), ku = onKey(false);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    // A key held when focus is lost never sends its keyup, so the character runs into a wall
    // forever. Clearing on blur is the entire fix and it is not optional.
    const blur = () => this.keys.clear();
    window.addEventListener('blur', blur);
    this.detachers.push(
      () => window.removeEventListener('keydown', kd),
      () => window.removeEventListener('keyup', ku),
      () => window.removeEventListener('blur', blur));

    const pointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      this.method = 'touch';
      const hit = this.hitTest(e.clientX, e.clientY);
      if (hit) {
        this.activeTouches.set(e.pointerId, hit);
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    };
    const pointerMove = (e: PointerEvent) => {
      if (!this.activeTouches.has(e.pointerId)) return;
      // Thumbs slide. Re-testing on move means dragging from left to right works rather than
      // sticking to whichever button was first touched.
      const hit = this.hitTest(e.clientX, e.clientY);
      if (hit) this.activeTouches.set(e.pointerId, hit);
      else this.activeTouches.delete(e.pointerId);
      e.preventDefault();
    };
    const pointerUp = (e: PointerEvent) => {
      this.activeTouches.delete(e.pointerId);
    };
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    this.detachers.push(
      () => canvas.removeEventListener('pointerdown', pointerDown),
      () => canvas.removeEventListener('pointermove', pointerMove),
      () => canvas.removeEventListener('pointerup', pointerUp),
      () => canvas.removeEventListener('pointercancel', pointerUp));
  }

  detach(): void {
    for (const d of this.detachers) d();
    this.detachers = [];
  }

  setTouchButtons(buttons: TouchButton[]): void { this.touchButtons = buttons; }
  get buttons(): TouchButton[] { return this.touchButtons; }
  isTouched(id: string): boolean { return [...this.activeTouches.values()].includes(id); }

  private hitTest(clientX: number, clientY: number): string | null {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const { sx, sy, ox, oy } = this.scale();
    const x = (clientX - rect.left) / sx - ox;
    const y = (clientY - rect.top) / sy - oy;
    for (const b of this.touchButtons) {
      if (x >= b.x - b.pad && x <= b.x + b.w + b.pad
        && y >= b.y - b.pad && y <= b.y + b.h + b.pad) return b.id;
    }
    return null;
  }

  /**
   * Gather this frame's input.
   *
   * Edge detection (`jumpPressed`) is computed here rather than in the event handlers, because
   * an event handler fires whenever the browser feels like it and the simulation needs "was it
   * newly pressed *this step*". Doing it here also means a key, a thumb and a gamepad button all
   * produce the same edge.
   */
  poll(): InputState {
    const s = this.state;
    const key = (...codes: string[]) => codes.some((c) => this.keys.has(c));

    let left = key('ArrowLeft', 'KeyA');
    let right = key('ArrowRight', 'KeyD');
    let down = key('ArrowDown', 'KeyS');
    let jump = key('Space', 'ArrowUp', 'KeyW');
    let dash = key('ShiftLeft', 'ShiftRight');
    let pause = key('Escape', 'KeyP');

    if (this.activeTouches.size > 0) {
      const touched = new Set(this.activeTouches.values());
      left = left || touched.has('left');
      right = right || touched.has('right');
      jump = jump || touched.has('jump');
      dash = dash || touched.has('dash');
      pause = pause || touched.has('pause');
    }

    const pad = this.pollGamepad();
    if (pad) {
      left = left || pad.left; right = right || pad.right; down = down || pad.down;
      jump = jump || pad.jump; dash = dash || pad.dash; pause = pause || pad.pause;
    }

    s.left = left;
    s.right = right;
    s.down = down;
    s.jump = jump;
    s.jumpPressed = jump && !this.prevJump;
    s.dash = dash;
    s.dashPressed = dash && !this.prevDash;
    this.pausePressed = pause && !this.prevPause;

    this.prevJump = jump;
    this.prevDash = dash;
    this.prevPause = pause;
    return s;
  }

  /**
   * The Gamepad API, polled rather than evented.
   *
   * Deliberately minimal: left stick and d-pad move, the bottom face button jumps, the right
   * shoulder dashes, Start pauses. Anything more elaborate is guesswork about a controller whose
   * layout the browser does not actually report.
   */
  private pollGamepad(): { left: boolean; right: boolean; down: boolean;
                           jump: boolean; dash: boolean; pause: boolean } | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      const axis = pad.axes[0] ?? 0;
      const dead = 0.32;      // sticks rest slightly off centre; without this the player drifts
      const result = {
        left: axis < -dead || Boolean(pad.buttons[14]?.pressed),
        right: axis > dead || Boolean(pad.buttons[15]?.pressed),
        down: (pad.axes[1] ?? 0) > dead || Boolean(pad.buttons[13]?.pressed),
        jump: Boolean(pad.buttons[0]?.pressed) || Boolean(pad.buttons[12]?.pressed),
        dash: Boolean(pad.buttons[2]?.pressed) || Boolean(pad.buttons[5]?.pressed)
          || Boolean(pad.buttons[7]?.pressed),
        pause: Boolean(pad.buttons[9]?.pressed),
      };
      if (Object.values(result).some(Boolean)) this.method = 'gamepad';
      return result;
    }
    return null;
  }

  /** Drop every held input — used when the game loses focus or a menu opens. */
  clear(): void {
    this.keys.clear();
    this.activeTouches.clear();
    this.state = emptyInput();
    this.prevJump = this.prevDash = this.prevPause = false;
  }
}
