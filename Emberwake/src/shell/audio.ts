/**
 * Sound and music, synthesised at runtime.
 *
 * No audio files. Every sound is a few oscillators and an envelope, which costs zero download
 * and — more usefully — can be *tuned* rather than re-recorded. A jump that felt a semitone too
 * low is a one-character change.
 *
 * The music is generated too: each world gets a scale, a tempo and a mood, and a small
 * arpeggiator walks it. A loop of any fixed length becomes recognisable and then irritating over
 * a forty-minute session; a walk that never quite repeats does not.
 *
 * Browsers refuse to start audio outside a user gesture, so nothing exists until `unlock()` is
 * called from the first tap or key. That is a requirement, not a workaround.
 */

export type Sfx =
  | 'jump' | 'doubleJump' | 'land' | 'step' | 'coin' | 'gem' | 'stomp' | 'hurt'
  | 'power' | 'checkpoint' | 'complete' | 'button' | 'secret' | 'dash' | 'die'
  | 'break' | 'shoot' | 'bossHit';

/** One scale per world, chosen for mood: bright, cold, warm, tense, open. */
const WORLD_SCALES: number[][] = [
  [0, 2, 4, 7, 9, 12, 14, 16],       // 1 — major pentatonic-ish, bright
  [0, 3, 5, 7, 10, 12, 15, 17],      // 2 — minor pentatonic, cold
  [0, 2, 3, 7, 9, 12, 14, 15],       // 3 — dorian flavour, green
  [0, 1, 5, 7, 8, 12, 13, 17],       // 4 — phrygian, tense
  [0, 2, 5, 7, 9, 12, 14, 17],       // 5 — suspended, open
];

const ROOTS = [220, 174.61, 196, 164.81, 246.94];

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private musicTimer = 0;
  private step = 0;
  private world = 1;

  sfxEnabled = true;
  musicEnabled = true;
  sfxVolume = 0.75;
  musicVolume = 0.45;

  /** Must be called from inside a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;                    // no audio here; the game plays on in silence
      try { this.ctx = new Ctor(); } catch { return; }

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.3;         // headroom — everything below is relative to this
      this.master.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxVolume;
      this.sfxBus.connect(this.master);

      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0;
      this.musicBus.connect(this.master);

      this.buildNoise();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.applyVolumes();
  }

  get available(): boolean { return this.ctx !== null && this.ctx.state === 'running'; }

  private buildNoise(): void {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic, so a landing sounds identical every time. Randomising per call reads as a
    // fault rather than as variety.
    let seed = 0x9e3779b9;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0x80000000) - 1;
    }
    this.noise = buffer;
  }

  applyVolumes(): void {
    if (!this.ctx || !this.sfxBus || !this.musicBus) return;
    const t = this.ctx.currentTime;
    this.sfxBus.gain.setTargetAtTime(this.sfxEnabled ? this.sfxVolume : 0, t, 0.05);
    this.musicBus.gain.setTargetAtTime(
      this.musicEnabled ? this.musicVolume * 0.34 : 0, t, 0.4);
    if (this.musicEnabled) this.startMusic();
  }

  play(sfx: Sfx): void {
    if (!this.sfxEnabled || !this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;

    switch (sfx) {
      case 'jump':        this.tone(t, 'triangle', 330, 620, 0.13, 0.34, 2600); break;
      case 'doubleJump':  this.tone(t, 'triangle', 460, 820, 0.14, 0.32, 3200); break;
      case 'land':
        this.hit(t, 0.055, 900, 0.32, 'lowpass', 1);
        this.tone(t, 'sine', 150, 92, 0.1, 0.22);
        break;
      case 'step':        this.hit(t, 0.022, 2400, 0.1, 'bandpass', 1.4); break;
      case 'coin':
        this.tone(t, 'square', 880, 880, 0.05, 0.16, 5000);
        this.tone(t + 0.045, 'square', 1320, 1320, 0.09, 0.14, 5000);
        break;
      case 'gem':
        for (const [i, f] of [784, 988, 1319, 1568].entries()) {
          this.tone(t + i * 0.055, 'triangle', f, f, 0.18, 0.2);
        }
        break;
      case 'stomp':
        this.hit(t, 0.06, 700, 0.4, 'lowpass', 1);
        this.tone(t, 'square', 220, 90, 0.11, 0.22, 1400);
        this.tone(t + 0.05, 'triangle', 660, 880, 0.1, 0.16);
        break;
      case 'hurt':
        this.tone(t, 'sawtooth', 300, 120, 0.22, 0.3, 1300);
        this.hit(t, 0.07, 500, 0.28, 'lowpass', 1);
        break;
      case 'die':
        for (const [i, f] of [440, 349, 262, 196].entries()) {
          this.tone(t + i * 0.13, 'triangle', f, f * 0.94, 0.3, 0.24);
        }
        break;
      case 'power':
        for (const [i, f] of [523, 659, 784, 1047, 1319].entries()) {
          this.tone(t + i * 0.06, 'triangle', f, f, 0.2, 0.2);
        }
        break;
      case 'checkpoint':
        this.tone(t, 'sine', 523, 523, 0.16, 0.24);
        this.tone(t + 0.1, 'sine', 784, 784, 0.26, 0.22);
        break;
      case 'secret':
        for (const [i, f] of [659, 880, 1175].entries()) {
          this.tone(t + i * 0.09, 'sine', f, f, 0.3, 0.22);
        }
        break;
      case 'complete':
        for (const [i, f] of [523, 659, 784, 1047].entries()) {
          this.tone(t + i * 0.12, 'triangle', f, f, 0.35, 0.26);
        }
        this.tone(t + 0.48, 'sine', 1568, 1568, 0.5, 0.18);
        break;
      case 'button':      this.hit(t, 0.018, 3200, 0.16, 'highpass', 1); break;
      case 'dash':
        this.hit(t, 0.14, 1800, 0.3, 'bandpass', 0.7);
        this.tone(t, 'sawtooth', 180, 520, 0.14, 0.18, 2200);
        break;
      case 'break':
        this.hit(t, 0.12, 1400, 0.36, 'bandpass', 0.8);
        this.tone(t, 'square', 160, 70, 0.12, 0.18, 900);
        break;
      case 'shoot':       this.tone(t, 'square', 420, 260, 0.1, 0.14, 1800); break;
      case 'bossHit':
        this.tone(t, 'sawtooth', 140, 60, 0.3, 0.3, 900);
        this.hit(t, 0.16, 400, 0.34, 'lowpass', 1);
        break;
    }
  }

  private tone(
    at: number, type: OscillatorType, from: number, to: number,
    duration: number, peak: number, lowpass = 0
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + duration);
    // A 4 ms attack rather than an instant one: a hard start is an audible click, and stacking
    // that click under every action is what makes synthesised game audio sound cheap.
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    let node: AudioNode = osc;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      osc.connect(f);
      node = f;
    }
    node.connect(env);
    env.connect(this.sfxBus!);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  private hit(
    at: number, duration: number, freq: number, peak: number, type: BiquadFilterType, q: number
  ): void {
    const ctx = this.ctx!;
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(Math.max(0.0002, peak), at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    src.connect(filter); filter.connect(env); env.connect(this.sfxBus!);
    src.start(at);
    src.stop(at + duration + 0.02);
  }

  // ── music ─────────────────────────────────────────────────────────────────

  setWorld(world: number): void {
    if (world === this.world) return;
    this.world = world;
    this.step = 0;
  }

  private startMusic(): void {
    if (this.musicTimer || !this.ctx) return;
    const tick = () => {
      if (!this.ctx || !this.musicEnabled || this.ctx.state !== 'running') return;
      const scale = WORLD_SCALES[Math.max(0, Math.min(4, this.world - 1))];
      const root = ROOTS[Math.max(0, Math.min(4, this.world - 1))];
      const t = this.ctx.currentTime;

      /**
       * The arpeggio walks the scale rather than looping a fixed figure, and a bass note lands
       * every eighth step. Enough structure to feel composed, enough drift never to repeat.
       */
      const index = (this.step * 3 + Math.floor(this.step / 5)) % scale.length;
      const semitone = scale[index] + (this.step % 16 < 8 ? 0 : 12);
      const freq = root * Math.pow(2, semitone / 12);
      this.musicTone(t, freq, 0.9, 'triangle', 0.16);

      if (this.step % 8 === 0) this.musicTone(t, root / 2, 1.8, 'sine', 0.22);
      if (this.step % 4 === 2) this.musicTone(t + 0.12, freq * 2, 0.5, 'sine', 0.07);
      this.step++;
    };
    tick();
    this.musicTimer = window.setInterval(tick, 340);
  }

  private musicTone(
    at: number, freq: number, duration: number, type: OscillatorType, peak: number
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.value = freq;
    filter.type = 'lowpass';
    filter.frequency.value = 1600;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(filter); filter.connect(env); env.connect(this.musicBus!);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }

  private stopMusic(): void {
    if (this.musicTimer) window.clearInterval(this.musicTimer);
    this.musicTimer = 0;
  }

  setMusic(on: boolean): void {
    this.musicEnabled = on;
    if (!on) this.stopMusic();
    this.applyVolumes();
  }

  /** Silence when the tab goes away — audio from a hidden tab is always a bug. */
  suspend(): void {
    this.stopMusic();
    if (this.ctx?.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
    if (this.musicEnabled) this.startMusic();
  }
}
