/**
 * Sound, synthesised at runtime.
 *
 * No audio files. Every sound here is a few oscillators and an envelope, which means the whole
 * sound design costs zero download and cannot fail to load — and, more usefully, that each sound
 * can be *tuned* rather than re-recorded.
 *
 * The design brief for chess audio is unusual: the sounds have to be satisfying enough to make
 * moving a piece feel physical, and quiet enough that a player can sit with them for an hour.
 * So there is no music by default, nothing is bright, and the loudest thing in the game is still
 * under a quarter of full scale. A move is a short filtered noise burst with a wooden thud
 * under it — a click, not a beep.
 *
 * The context starts suspended until a real gesture unlocks it, which every browser now
 * requires. Calling `unlock()` from the first click is the whole workaround.
 */

export type SoundName =
  | 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'illegal'
  | 'click' | 'win' | 'lose' | 'draw' | 'lowTime' | 'start';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer = 0;
  private noiseBuffer: AudioBuffer | null = null;

  sfxVolume = 0.7;
  musicVolume = 0.0;
  sfxEnabled = true;
  musicEnabled = false;

  /** Must be called from inside a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = (window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!Ctor) return;                       // no audio available; the game plays on in silence
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.24;           // headroom: everything else is relative to this
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.master);
      this.buildNoise();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.musicEnabled) this.startMusic();
  }

  get running(): boolean { return this.ctx?.state === 'running'; }

  private buildNoise(): void {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * 0.4);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic noise, so a "move" sound is identical every time. Randomising it per call
    // sounds like a fault rather than like variety.
    let seed = 0x9e3779b9;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0x80000000) - 1;
    }
    this.noiseBuffer = buffer;
  }

  play(name: SoundName): void {
    if (!this.sfxEnabled || !this.ctx || !this.master) return;
    if (this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const gain = this.sfxVolume;

    switch (name) {
      case 'move':
        // A wooden piece set down: a filtered click with a short low body under it.
        this.noise(t, 0.045, 2400, 0.5 * gain, 'bandpass', 1.2);
        this.tone(t, 'sine', 190, 120, 0.07, 0.22 * gain);
        break;
      case 'capture':
        // Harder, with a second contact — one piece displacing another.
        this.noise(t, 0.07, 1500, 0.72 * gain, 'bandpass', 0.9);
        this.tone(t, 'sine', 150, 82, 0.13, 0.32 * gain);
        this.noise(t + 0.035, 0.05, 3200, 0.4 * gain, 'highpass', 1);
        break;
      case 'castle':
        // Two pieces landing, a beat apart.
        this.noise(t, 0.05, 2200, 0.5 * gain, 'bandpass', 1.2);
        this.tone(t, 'sine', 180, 120, 0.08, 0.2 * gain);
        this.noise(t + 0.085, 0.05, 2000, 0.5 * gain, 'bandpass', 1.2);
        this.tone(t + 0.085, 'sine', 165, 110, 0.08, 0.2 * gain);
        break;
      case 'check':
        // A restrained warning: a clean minor third, not an alarm.
        this.tone(t, 'triangle', 740, 740, 0.11, 0.26 * gain);
        this.tone(t + 0.075, 'triangle', 880, 880, 0.16, 0.22 * gain);
        break;
      case 'promote':
        // A small rising figure — the one genuinely celebratory sound in the game.
        this.tone(t, 'triangle', 523, 523, 0.1, 0.2 * gain);
        this.tone(t + 0.08, 'triangle', 659, 659, 0.1, 0.2 * gain);
        this.tone(t + 0.16, 'triangle', 784, 784, 0.14, 0.22 * gain);
        this.tone(t + 0.24, 'sine', 1046, 1046, 0.3, 0.16 * gain);
        break;
      case 'illegal':
        // Low, short and dull: "no", said quietly.
        this.tone(t, 'sawtooth', 120, 96, 0.11, 0.16 * gain, 420);
        break;
      case 'click':
        this.noise(t, 0.02, 3600, 0.28 * gain, 'highpass', 1);
        break;
      case 'start':
        this.tone(t, 'sine', 392, 392, 0.12, 0.15 * gain);
        this.tone(t + 0.1, 'sine', 587, 587, 0.22, 0.15 * gain);
        break;
      case 'win':
        for (const [i, f] of [523, 659, 784, 1046].entries()) {
          this.tone(t + i * 0.11, 'triangle', f, f, 0.3, 0.19 * gain);
        }
        break;
      case 'lose':
        for (const [i, f] of [440, 370, 294, 233].entries()) {
          this.tone(t + i * 0.13, 'sine', f, f, 0.38, 0.17 * gain);
        }
        break;
      case 'draw':
        this.tone(t, 'sine', 440, 440, 0.3, 0.16 * gain);
        this.tone(t + 0.14, 'sine', 415, 415, 0.42, 0.16 * gain);
        break;
      case 'lowTime':
        this.tone(t, 'square', 880, 880, 0.06, 0.1 * gain, 1800);
        break;
    }
  }

  /** One oscillator with an exponential decay and an optional low-pass. */
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

    // A 4 ms attack rather than an instant one: a hard start on a sine is an audible click, and
    // stacking that click under every move is what makes synthesised UI audio sound cheap.
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    let node: AudioNode = osc;
    if (lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lowpass;
      osc.connect(filter);
      node = filter;
    }
    node.connect(env);
    env.connect(this.master!);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  private noise(
    at: number, duration: number, frequency: number, peak: number,
    type: BiquadFilterType, q: number
  ): void {
    const ctx = this.ctx!;
    if (!this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(Math.max(0.0002, peak), at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    src.connect(filter);
    filter.connect(env);
    env.connect(this.master!);
    src.start(at);
    src.stop(at + duration + 0.02);
  }

  // ── ambient music ─────────────────────────────────────────────────────────

  /**
   * Ambient pads, off by default.
   *
   * Chess is a thinking game and most players want silence, so this is opt-in and starts at a
   * low level. It is generated rather than looped — a loop of any length becomes recognisable
   * and then irritating over a forty-minute game, and a slow random walk through one chord
   * never quite repeats.
   */
  setMusic(enabled: boolean, volume: number): void {
    this.musicEnabled = enabled;
    this.musicVolume = volume;
    if (!this.ctx || !this.musicGain) return;
    this.musicGain.gain.setTargetAtTime(
      enabled ? volume * 0.16 : 0, this.ctx.currentTime, 0.6);
    if (enabled) this.startMusic();
    else this.stopMusic();
  }

  private startMusic(): void {
    if (this.musicTimer || !this.ctx) return;
    const chord = [146.83, 220.00, 293.66, 349.23, 440.00];   // Dm9, spread wide
    const step = () => {
      if (!this.ctx || !this.musicEnabled) return;
      const t = this.ctx.currentTime;
      const f = chord[Math.floor(Math.random() * chord.length)];
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      osc.type = 'sine';
      osc.frequency.value = f * (Math.random() < 0.25 ? 2 : 1);
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.5, t + 2.2);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 7);
      osc.connect(filter); filter.connect(env); env.connect(this.musicGain!);
      osc.start(t); osc.stop(t + 7.2);
    };
    step();
    this.musicTimer = window.setInterval(step, 3400);
  }

  private stopMusic(): void {
    if (this.musicTimer) window.clearInterval(this.musicTimer);
    this.musicTimer = 0;
  }

  /** Silence everything when the tab goes away — audio from a hidden tab is always a bug. */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }
}
