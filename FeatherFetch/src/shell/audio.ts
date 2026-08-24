/**
 * Sound and music, synthesised at runtime.
 *
 * No audio files — every sound is a few oscillators and an envelope. Zero download, nothing that
 * can fail to load, and each sound is *tunable* rather than needing re-recording.
 *
 * The design brief for a shooter is narrow: the shot has to be the loudest, shortest, most
 * definite thing in the mix, because it is the only sound that confirms an input. Everything
 * else sits underneath it. The duck calls and the dog barks are pitched well away from the shot
 * so they never mask it.
 *
 * Nothing exists until `unlock()` runs inside a user gesture — browsers require it.
 */

export type Sfx =
  | 'shot' | 'empty' | 'reload' | 'hit' | 'hitRare' | 'clang' | 'fall'
  | 'flap' | 'quack' | 'escape' | 'bark' | 'sniff' | 'dogRun' | 'dogTease'
  | 'perfect' | 'roundStart' | 'gameOver' | 'button' | 'combo' | 'unlock';

/** One scale per environment, so the music changes with the place. */
const SCALES = [
  [0, 2, 4, 7, 9, 12, 14, 16],       // meadow — bright
  [0, 2, 5, 7, 9, 12, 14, 17],       // lake — open
  [0, 2, 3, 7, 9, 12, 14, 15],       // autumn — warm minor
  [0, 3, 5, 7, 10, 12, 15, 17],      // marsh — dusky
  [0, 2, 4, 7, 11, 12, 16, 19],      // snow — clear
];
const ROOTS = [196, 174.61, 164.81, 146.83, 220];

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private musicTimer = 0;
  private step = 0;
  private env = 0;

  sfxEnabled = true;
  musicEnabled = true;
  sfxVolume = 0.75;
  musicVolume = 0.4;

  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try { this.ctx = new Ctor(); } catch { return; }

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.3;
      this.master.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0;
      this.musicBus.connect(this.master);
      this.buildNoise();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.applyVolumes();
  }

  private buildNoise(): void {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * 0.6);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic, so a shot sounds identical every time. Randomising per call reads as a
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
    this.musicBus.gain.setTargetAtTime(this.musicEnabled ? this.musicVolume * 0.3 : 0, t, 0.4);
    if (this.musicEnabled) this.startMusic();
  }

  play(sfx: Sfx): void {
    if (!this.sfxEnabled || !this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;

    switch (sfx) {
      case 'shot':
        /**
         * The most important sound in the game.
         *
         * Three layers: a bright crack that gives it attack, a filtered body that gives it
         * weight, and a short low thump underneath. Together they land in about 120 ms, which is
         * short enough to fire three times in a second without turning to mud.
         */
        this.hit(t, 0.045, 5200, 0.9, 'highpass', 1);
        this.hit(t, 0.16, 900, 0.7, 'lowpass', 1);
        this.tone(t, 'sine', 120, 48, 0.14, 0.5);
        break;
      case 'empty':
        this.hit(t, 0.03, 3000, 0.28, 'bandpass', 3);
        this.tone(t + 0.04, 'square', 220, 180, 0.05, 0.12, 1400);
        break;
      case 'reload':
        this.hit(t, 0.04, 1800, 0.32, 'bandpass', 2);
        this.hit(t + 0.11, 0.05, 1200, 0.34, 'bandpass', 2);
        break;
      case 'hit':
        this.hit(t, 0.09, 1600, 0.5, 'bandpass', 0.8);
        this.tone(t, 'triangle', 520, 260, 0.12, 0.3);
        break;
      case 'hitRare':
        this.hit(t, 0.1, 2000, 0.5, 'bandpass', 0.8);
        for (const [i, f] of [660, 880, 1320].entries()) {
          this.tone(t + i * 0.055, 'triangle', f, f, 0.2, 0.24);
        }
        break;
      case 'clang':
        // Armour: metallic, and clearly *not* a kill.
        this.tone(t, 'square', 900, 700, 0.1, 0.24, 4000);
        this.tone(t + 0.01, 'square', 1350, 1100, 0.09, 0.16, 5000);
        this.hit(t, 0.05, 3000, 0.3, 'bandpass', 4);
        break;
      case 'fall':
        this.tone(t, 'sine', 500, 130, 0.5, 0.2, 1600);
        break;
      case 'flap':
        for (let i = 0; i < 3; i++) this.hit(t + i * 0.085, 0.05, 600, 0.14, 'bandpass', 1.4);
        break;
      case 'quack':
        // Two short nasal blips — a duck call without sampling one.
        this.tone(t, 'sawtooth', 420, 380, 0.09, 0.2, 1500);
        this.tone(t + 0.12, 'sawtooth', 380, 330, 0.11, 0.18, 1400);
        break;
      case 'escape':
        this.tone(t, 'sine', 300, 620, 0.28, 0.18, 2200);
        break;
      case 'bark':
        this.tone(t, 'sawtooth', 300, 180, 0.1, 0.32, 1200);
        this.hit(t, 0.06, 900, 0.24, 'bandpass', 1);
        break;
      case 'sniff':
        this.hit(t, 0.08, 2600, 0.16, 'bandpass', 2.6);
        this.hit(t + 0.13, 0.07, 2400, 0.14, 'bandpass', 2.6);
        break;
      case 'dogRun':
        for (let i = 0; i < 4; i++) this.hit(t + i * 0.1, 0.035, 700, 0.13, 'lowpass', 1);
        break;
      case 'dogTease':
        // A little descending giggle — the dog laughing at you.
        for (const [i, f] of [620, 540, 470, 410].entries()) {
          this.tone(t + i * 0.07, 'triangle', f, f * 0.94, 0.08, 0.18);
        }
        break;
      case 'perfect':
        for (const [i, f] of [523, 659, 784, 1047, 1319].entries()) {
          this.tone(t + i * 0.1, 'triangle', f, f, 0.32, 0.24);
        }
        break;
      case 'combo':
        this.tone(t, 'triangle', 880, 1100, 0.14, 0.2);
        break;
      case 'roundStart':
        this.tone(t, 'triangle', 392, 392, 0.14, 0.22);
        this.tone(t + 0.13, 'triangle', 587, 587, 0.24, 0.22);
        break;
      case 'gameOver':
        for (const [i, f] of [440, 370, 294, 220].entries()) {
          this.tone(t + i * 0.16, 'sine', f, f * 0.95, 0.4, 0.24);
        }
        break;
      case 'unlock':
        for (const [i, f] of [784, 988, 1319].entries()) {
          this.tone(t + i * 0.09, 'sine', f, f, 0.3, 0.2);
        }
        break;
      case 'button':
        this.hit(t, 0.018, 3200, 0.18, 'highpass', 1);
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
    // A 4 ms attack, not an instant one: a hard start is an audible click, and stacking that
    // click under every shot is what makes synthesised audio sound cheap.
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

  setEnvironment(index: number): void {
    if (index === this.env) return;
    this.env = index;
    this.step = 0;
  }

  /**
   * A light country walk, generated rather than looped.
   *
   * A fixed loop of any length becomes recognisable and then irritating over a long session; a
   * slow walk through a scale with a bass note every fourth beat never quite repeats. It is
   * mixed well under the effects, because the shot has to stay the loudest thing.
   */
  private startMusic(): void {
    if (this.musicTimer || !this.ctx) return;
    const tick = () => {
      if (!this.ctx || !this.musicEnabled || this.ctx.state !== 'running') return;
      const scale = SCALES[Math.max(0, Math.min(4, this.env))];
      const root = ROOTS[Math.max(0, Math.min(4, this.env))];
      const t = this.ctx.currentTime;

      const index = (this.step * 3 + Math.floor(this.step / 7)) % scale.length;
      const semitone = scale[index] + (this.step % 16 < 8 ? 0 : 12);
      this.musicTone(t, root * Math.pow(2, semitone / 12), 0.75, 'triangle', 0.14);
      if (this.step % 4 === 0) this.musicTone(t, root / 2, 1.4, 'sine', 0.2);
      if (this.step % 8 === 6) {
        this.musicTone(t + 0.1, root * Math.pow(2, (scale[1] + 12) / 12), 0.5, 'sine', 0.07);
      }
      this.step++;
    };
    tick();
    this.musicTimer = window.setInterval(tick, 380);
  }

  private stopMusic(): void {
    if (this.musicTimer) window.clearInterval(this.musicTimer);
    this.musicTimer = 0;
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
    filter.frequency.value = 1500;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(filter); filter.connect(env); env.connect(this.musicBus!);
    osc.start(at);
    osc.stop(at + duration + 0.05);
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
