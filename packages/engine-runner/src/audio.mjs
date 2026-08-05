/**
 * Procedural WebAudio SFX — no audio files, so nothing to bundle or license.
 *
 * Mobile browsers and Android WebView refuse to start an AudioContext until a
 * user gesture, so `unlock()` is wired to the first tap. Everything degrades to
 * silence rather than throwing if audio is unavailable at all.
 */

let ctx = null;
let master = null;
let muted = false;

export function unlock() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.28;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
}

export function setMuted(v) {
  muted = Boolean(v);
  if (master) master.gain.value = muted ? 0 : 0.28;
}

export const isMuted = () => muted;

function tone({ type = 'square', from, to, dur, gain = 0.6, delay = 0 }) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.18, gain = 0.5 }) {
  if (!ctx || muted) return;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1200;
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(lp).connect(g).connect(master);
  src.start();
}

/**
 * Punchier variants for rhythm_dash.
 *
 * A player in this genre hears the jump sound several hundred times in a sitting, so it has
 * to be short and dry — a long or bright tone becomes unbearable fast. The death sound is the
 * opposite: it should land hard enough to register as a mistake without being punishing.
 */
export const dashSfx = {
  jump: () => {
    tone({ type: 'square', from: 420, to: 700, dur: 0.075, gain: 0.26 });
    tone({ type: 'sine', from: 900, to: 1300, dur: 0.05, gain: 0.1 });
  },
  land: () => {
    tone({ type: 'sine', from: 150, to: 88, dur: 0.06, gain: 0.2 });
    noise({ dur: 0.05, gain: 0.14 });
  },
  death: () => {
    noise({ dur: 0.34, gain: 0.5 });
    tone({ type: 'sawtooth', from: 300, to: 44, dur: 0.4, gain: 0.34 });
    tone({ type: 'square', from: 160, to: 40, dur: 0.26, gain: 0.2, delay: 0.03 });
  },
  pad: () => tone({ type: 'triangle', from: 520, to: 1150, dur: 0.16, gain: 0.3 }),
  complete: () => {
    [523, 659, 784, 1046, 1318].forEach((f, i) =>
      tone({ type: 'triangle', from: f, to: f, dur: 0.2, gain: 0.28, delay: i * 0.085 })
    );
  },
  /** Faint tick under the action, on the jump-rhythm beat. Very quiet by design. */
  beat: () => tone({ type: 'sine', from: 110, to: 96, dur: 0.045, gain: 0.055 }),
};

export const sfx = {
  jump:      () => tone({ type: 'square',   from: 300, to: 680, dur: 0.12, gain: 0.35 }),
  doubleJump:() => tone({ type: 'triangle', from: 520, to: 900, dur: 0.11, gain: 0.32 }),
  land:      () => tone({ type: 'sine',     from: 180, to: 110, dur: 0.07, gain: 0.22 }),
  crash:     () => { noise({ dur: 0.3, gain: 0.55 }); tone({ type: 'sawtooth', from: 220, to: 50, dur: 0.34, gain: 0.4 }); },
  milestone: () => tone({ type: 'triangle', from: 700, to: 1050, dur: 0.09, gain: 0.25 }),
  win:       () => { [523, 659, 784, 1046].forEach((f, i) => tone({ type: 'triangle', from: f, to: f, dur: 0.16, gain: 0.3, delay: i * 0.11 })); },
  unlock:    () => { [392, 523, 659, 784, 1046].forEach((f, i) => tone({ type: 'square', from: f, to: f, dur: 0.14, gain: 0.28, delay: i * 0.09 })); },
  select:    () => tone({ type: 'square', from: 440, to: 560, dur: 0.06, gain: 0.2 }),
};
