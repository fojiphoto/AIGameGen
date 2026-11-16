const cues = {
  launch: .29,
  swap: .24,
  land: .20,
  pop: .50,
  combo: .33,
  row: .23,
  clear: .53,
  lose: .42,
} as const;
type Cue = keyof typeof cues;

export class BubbleAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private mix?: DynamicsCompressorNode;
  private buffers = new Map<Cue, Promise<AudioBuffer | undefined>>();
  private active = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private streak = 0;
  private variation = 0;

  constructor(private muted: boolean) {}

  unlock() {
    if (this.muted) return;
    try {
      if (!this.context) {
        const context = new AudioContext();
        this.context = context;
        this.master = context.createGain();
        this.master.gain.value = .78;
        this.mix = context.createDynamicsCompressor();
        this.mix.threshold.value = -10;
        this.mix.ratio.value = 4;
        this.mix.attack.value = .003;
        this.mix.release.value = .085;
        this.mix.connect(this.master).connect(context.destination);
        for (const cue of Object.keys(cues) as Cue[]) {
          const sample = new URL(`sfx/${cue}.wav`, document.baseURI);
          this.buffers.set(cue, fetch(sample).then(response => {
            if (!response.ok) throw new Error(`Could not load ${cue}`);
            return response.arrayBuffer();
          }).then(data => context.decodeAudioData(data)).catch(() => undefined));
        }
      }
      if (this.context.state !== 'running') void this.context.resume().catch(() => {});
    } catch { /* Gameplay can continue if audio is unavailable. */ }
  }

  reset() {
    this.streak = this.variation = 0;
    this.stop();
  }

  stop() {
    this.generation++;
    for (const source of this.active) source.stop();
    this.active.clear();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.stop();
    else this.unlock();
  }

  play(cue: Cue, pitch = 1, level = 1, delay = 0) {
    if (this.muted || !this.context || !this.mix) return;
    const context = this.context, mix = this.mix;
    const scheduled = context.currentTime + delay, generation = this.generation;
    void this.buffers.get(cue)?.then(buffer => {
      if (!buffer || this.muted || this.generation !== generation || context.currentTime > scheduled + .18) return;
      const voice = context.createBufferSource(), gain = context.createGain();
      voice.buffer = buffer;
      voice.playbackRate.value = pitch;
      gain.gain.value = cues[cue] * level;
      voice.connect(gain).connect(mix);
      this.active.add(voice);
      voice.onended = () => { this.active.delete(voice); voice.disconnect(); gain.disconnect(); };
      voice.start(Math.max(scheduled, context.currentTime));
    });
  }

  landed(popped: number, dropped: number, ceilingMoved: boolean) {
    if (!popped) {
      this.streak = 0;
      this.play(ceilingMoved ? 'row' : 'land', ceilingMoved ? .95 : 1);
      return;
    }
    this.streak++;
    const variation = [1, 1.075, .96, 1.035][this.variation++ % 4];
    const pitch = variation * (1 + Math.min(4, this.streak - 1) * .035);
    this.play('pop', pitch);
    if (popped >= 5 || dropped) this.play('pop', pitch * 1.18, .54, .037);
    if (popped + dropped >= 8) this.play('pop', pitch * 1.36, .39, .071);
    if (dropped || popped >= 8 || this.streak >= 3) this.play('combo', 1 + Math.min(5, this.streak - 1) * .045, 1, .085);
  }
}
