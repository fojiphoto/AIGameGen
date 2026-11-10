import type { SoundCue } from './game';

export class ArcadeAudio {
  muted = false;
  private context?: AudioContext;
  private alternating = false;
  private lastPulse = 0;

  unlock() {
    if (this.muted) return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
    } catch { /* Sound support is optional. */ }
  }

  private note(from: number, to: number, seconds: number, offset = 0, volume = .045) {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running' || this.muted) return;
    const start = ctx.currentTime + offset;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to, start + seconds);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, start + seconds);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + seconds + .015);
  }

  cue(cue: SoundCue) {
    switch (cue) {
      case 'dot':
        this.alternating = !this.alternating;
        this.note(this.alternating ? 620 : 445, this.alternating ? 320 : 245, .085, 0, .055);
        break;
      case 'power': this.note(160, 540, .24); break;
      case 'ghost': this.note(250, 1350, .20, 0, .075); break;
      case 'fruit': this.note(720, 1320, .18); break;
      case 'caught':
        for (let i = 0; i < 7; i++) this.note(900 - i * 90, 610 - i * 81, .12, i * .09, .08);
        break;
      case 'ready': this.tune([262, 392, 523, 440, 392, 659], .13); break;
      case 'clear': this.tune([392, 494, 587, 784], .12); break;
      case 'life': this.tune([659, 784, 988, 1319], .09); break;
    }
  }

  private tune(notes: number[], step: number) {
    notes.forEach((note, i) => this.note(note, note, step * .92, step * i, .08));
  }

  pulse(powered: boolean, progress: number) {
    const now = this.context?.currentTime ?? 0;
    if (now - this.lastPulse < (powered ? .16 : .44 - .22 * progress)) return;
    this.lastPulse = now;
    this.note(powered ? 410 : 118 + 90 * progress, powered ? 140 : 195 + 90 * progress, powered ? .12 : .32, 0, .028);
  }
}
