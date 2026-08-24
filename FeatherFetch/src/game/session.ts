/**
 * A run in play: rounds, waves, ducks, shells, the dog, and everything a shot sets off.
 *
 * Owns only what exists while a game is running, so restarting is throwing one away and building
 * another. The update order matters and is worth stating: hit-stop first (so a frozen frame
 * really is frozen), then ducks, then the dog, then the wave scheduler. Advancing the scheduler
 * before the ducks would let a wave end on the same frame the last duck was hit, and the score
 * pop-up would be cut off by the round card.
 */

import {
  VIEW_W, SKY_BOTTOM, GROUND_Y, FIXED_DT, MAX_FRAME_TIME, SHELLS, RELOAD_SECONDS,
  HIT_PAD_MOUSE, HIT_PAD_TOUCH, HIT_STOP, HIT_STOP_RARE, MAX_MISSES,
  DOG_RETRIEVE_SECONDS, DOG_TEASE_SECONDS, DOG_SPEED,
  DuckState, spawnDuck, stepDuck, isOffScreen,
  RoundPlan, planRound, makeRandom,
  Stats, emptyStats, awardHit, summariseRound, RoundSummary,
  resolveShot, shotQuality,
  GameMode,
} from '../core/index.js';
import { Env, envFor, DogPose, HARVESTER_W, HARVESTER_H } from '../render/art.js';
import { SpriteCache, Backdrop, Ambience, Particles, Labels, DOG_W, DOG_H } from '../render/scene.js';
import { AudioManager } from '../shell/audio.js';

export type Phase =
  | 'roundCard' | 'ready' | 'playing' | 'waveClear' | 'retrieve' | 'roundEnd'
  | 'harvest' | 'over';

interface ActiveDuck extends DuckState {
  /** Shells spent on this duck, for the first-shell bonus. */
  shellsUsed: number;
  /** Counts down while the hit animation plays, then the duck starts falling. */
  hitTimer: number;
  /** Flap phase, so a flock does not beat its wings in unison. */
  flap: number;
}

interface Retrieved { kind: string; colors: [string, string, string]; size: number }

/** A bird lying in the grass in Open Season, waiting for the harvester. */
interface Piled extends Retrieved { x: number; lean: number; taken: boolean }

/**
 * How far below the fence line the pile and the machine sit.
 *
 * Far enough into the near grass to be unmistakable, close enough that the harvester still looks
 * like it is working the same field the ducks fell into.
 */
const PILE_BASELINE = 26;
const HARVESTER_BASELINE = 34;

export class Session {
  mode: GameMode;
  stats: Stats = emptyStats();
  phase: Phase = 'roundCard';

  round = 1;
  plan: RoundPlan;
  env: Env;

  ducks: ActiveDuck[] = [];
  shells = SHELLS;
  /** Ducks released so far this round, and how many were hit. */
  released = 0;
  hitThisRound = 0;
  shotsThisRound = 0;
  bestComboThisRound = 0;
  roundScoreStart = 0;
  misses = 0;

  /** Time Attack only. */
  timeLeft = 60;

  particles = new Particles();
  labels = new Labels();
  ambience = new Ambience();

  /** Crosshair. */
  aimX = VIEW_W / 2;
  aimY = 220;
  crosshairSpread = 0;
  hitFlash = 0;
  muzzle = 0;
  shake = 0;
  shakeEnabled = true;
  usingTouch = false;

  lastSummary: RoundSummary | null = null;
  onRoundComplete: ((s: RoundSummary) => void) | null = null;
  onGameOver: (() => void) | null = null;

  private accumulator = 0;
  private freeze = 0;
  private phaseTimer = 0;
  private waveIndex = 0;
  private spawnQueue: { plan: RoundPlan['waves'][0]['ducks'][0]; at: number }[] = [];
  private waveElapsed = 0;
  private reload = 0;
  private random: () => number;
  private seed: number;
  private elapsed = 0;

  /** The dog. */
  private dog = {
    x: -120, y: GROUND_Y - 6, pose: 'idle' as DogPose, timer: 0,
    active: false, carrying: null as Retrieved | null, phase: 0, targetX: 0,
    stage: 'in' as 'in' | 'search' | 'out',
  };
  private pendingRetrieve: Retrieved[] = [];
  /** Where the last bird came down, so Biscuit runs to it instead of to a random spot. */
  private lastFellX: number | null = null;
  quickRetrieve = false;
  bandana = '#e2503f';

  /**
   * Open Season: the pile, and the machine that clears it.
   *
   * In every other mode Biscuit fetches each bird as it lands. Here they stay where they fall
   * and build up along the grass line, which is the whole point of the mode — the pile *is* the
   * score, visible the entire time, and calling the harvester is the player deciding to cash it
   * in. The dog gets the round off.
   */
  piled: Piled[] = [];
  harvester = { active: false, x: -HARVESTER_W, phase: 0, collected: 0, done: false };

  constructor(mode: GameMode, seed: number, private audio: AudioManager) {
    this.mode = mode;
    this.seed = seed;
    this.random = makeRandom(seed);
    this.plan = planRound(1, seed);
    this.env = envFor(this.plan.environment);
    this.phaseTimer = 1.5;
    if (mode === 'timeAttack') this.timeLeft = 60;
    // Open Season has no round card to read — it starts the moment the player arrives.
    if (mode === 'free') this.phaseTimer = 0.5;
  }

  get accuracy(): number {
    return this.stats.shotsFired === 0 ? 0 : this.stats.shotsHit / this.stats.shotsFired;
  }
  get ducksLeftInRound(): number { return this.plan.duckCount - this.released + this.aliveCount; }
  get aliveCount(): number { return this.ducks.filter((d) => d.phase === 'flying').length; }
  get reloading(): boolean { return this.reload > 0; }
  get dogState(): { x: number; y: number; pose: DogPose; active: boolean; phase: number;
                    carrying: Retrieved | null } { return this.dog; }

  // ── loop ──────────────────────────────────────────────────────────────────

  update(dtReal: number): void {
    this.accumulator += Math.min(dtReal, MAX_FRAME_TIME);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 8) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 8) this.accumulator = 0;
  }

  private step(dt: number): void {
    this.elapsed += dt;
    this.ambience.update(dt);
    this.crosshairSpread = Math.max(0, this.crosshairSpread - dt * 4.5);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 3.2);
    this.muzzle = Math.max(0, this.muzzle - dt * 12);
    this.shake = Math.max(0, this.shake - dt * 4);
    this.labels.update(dt);

    // Hit-stop freezes the world but never the presentation layer, so the flash and the pop-up
    // still animate during the pause — which is what makes it read as impact rather than as a
    // dropped frame.
    if (this.freeze > 0) { this.freeze -= dt; this.particles.update(dt); return; }

    this.particles.update(dt);
    if (this.reload > 0) {
      this.reload -= dt;
      if (this.reload <= 0) { this.shells = SHELLS; this.audio.play('reload'); }
    }

    switch (this.phase) {
      case 'roundCard':
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) { this.phase = 'ready'; this.phaseTimer = 0.85; }
        break;

      case 'ready':
        this.phaseTimer -= dt;
        this.updateDog(dt);
        if (this.phaseTimer <= 0) { this.phase = 'playing'; this.startWave(); }
        break;

      case 'playing':
        if (this.mode === 'timeAttack') {
          this.timeLeft -= dt;
          if (this.timeLeft <= 0) { this.timeLeft = 0; this.endGame(); return; }
        }
        this.updateDucks(dt);
        this.updateDog(dt);
        this.updateWave(dt);
        break;

      case 'waveClear':
      case 'retrieve':
        this.updateDucks(dt);
        this.updateDog(dt);
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) this.afterRetrieve();
        break;

      case 'roundEnd':
        this.updateDucks(dt);
        this.updateDog(dt);
        break;

      case 'harvest':
        // Ducks already in the air keep flying; the player just cannot shoot any more.
        this.updateDucks(dt);
        this.updateHarvester(dt);
        break;

      case 'over':
        this.updateDucks(dt);
        this.updateDog(dt);
        break;
    }
  }

  // ── ducks ─────────────────────────────────────────────────────────────────

  private updateDucks(dt: number): void {
    for (const duck of this.ducks) {
      duck.flap += dt * (6 + duck.speed / 90);

      if (duck.phase === 'hit') {
        duck.hitTimer -= dt;
        if (duck.hitTimer <= 0) {
          duck.phase = 'falling';
          duck.vy = 60;
          this.audio.play('fall');
        }
      }

      // The escape timer only runs while the duck is genuinely flying.
      if (duck.phase === 'flying' && !duck.fleeing && duck.t >= this.plan.escapeAfter) {
        duck.fleeing = true;
        this.audio.play('quack');
      }

      stepDuck(duck, dt);

      if (duck.phase === 'falling' && duck.y > GROUND_Y - 10) {
        // Into the grass. The dog takes it from here.
        duck.phase = 'gone';
        this.particles.emit('puff', duck.x, GROUND_Y - 6, 8, {
          color: this.env.grass, speed: 90, life: 0.45, size: 6, gravity: 90,
          dir: -Math.PI / 2, spread: Math.PI,
        });
        const bird = {
          kind: duck.type.kind, colors: duck.type.colors, size: duck.type.size,
        };
        if (this.mode === 'free') {
          // It stays where it fell. The pile is the mode.
          this.piled.push({
            ...bird,
            x: Math.max(20, Math.min(VIEW_W - 20, duck.x)),
            lean: (this.random() - 0.5) * 0.9,
            taken: false,
          });
        } else {
          this.lastFellX = duck.x;
          this.pendingRetrieve.push(bird);
        }
      }

      if (duck.phase === 'flying' && isOffScreen(duck)) {
        duck.phase = 'escaped';
        this.onDuckEscaped();
      } else if (duck.phase !== 'flying' && duck.phase !== 'hit' && isOffScreen(duck)) {
        duck.phase = 'gone';
      }
    }

    this.ducks = this.ducks.filter(
      (d) => d.phase !== 'gone' && d.phase !== 'escaped');
  }

  private onDuckEscaped(): void {
    this.stats.ducksEscaped++;
    this.stats.combo = 0;
    this.labels.add(VIEW_W / 2, 150, 'ESCAPED!', '#ffb08a', true);
    this.audio.play('escape');

    if (this.mode === 'survival') {
      this.misses++;
      if (this.misses >= MAX_MISSES) { this.endGame(); return; }
    }
  }

  // ── waves ─────────────────────────────────────────────────────────────────

  private startWave(): void {
    const wave = this.plan.waves[this.waveIndex];
    if (!wave) { this.finishRound(); return; }
    this.spawnQueue = wave.ducks.map((d) => ({ plan: d, at: d.delay }));
    this.waveElapsed = 0;
    this.shells = SHELLS;
    this.reload = 0;
  }

  private updateWave(dt: number): void {
    this.waveElapsed += dt;

    while (this.spawnQueue.length && this.waveElapsed >= this.spawnQueue[0].at) {
      const { plan } = this.spawnQueue.shift()!;
      const duck = spawnDuck(plan.type, plan.pattern, this.plan.difficulty, this.random);
      this.ducks.push({ ...duck, shellsUsed: 0, hitTimer: 0, flap: this.random() * 6 });
      this.released++;
      this.audio.play('flap');
    }

    // The wave is over once nothing is flying and nothing is queued.
    if (this.spawnQueue.length === 0 && this.aliveCount === 0) {
      const falling = this.ducks.some((d) => d.phase === 'falling' || d.phase === 'hit');
      if (falling) return;
      this.waveIndex++;
      if (this.pendingRetrieve.length > 0) this.startRetrieve();
      else if (this.stats.combo === 0 && this.shells < SHELLS) this.startTease();
      else { this.phase = 'waveClear'; this.phaseTimer = 0.35; }
      return;
    }

    // Out of shells with ducks still up: reload after a beat rather than stalling.
    if (this.shells === 0 && this.reload <= 0 && this.aliveCount > 0) {
      this.reload = RELOAD_SECONDS;
    }
  }

  private afterRetrieve(): void {
    if (this.waveIndex >= this.plan.waves.length) {
      /**
       * Open Season has no rounds to finish.
       *
       * When the plan runs out it silently rolls to the next one — same difficulty ramp, no
       * round card, no results screen. The run ends when the player calls the harvester and not
       * before, which is the whole promise of the mode.
       */
      if (this.mode === 'free') { this.rollNextPlan(); return; }
      this.finishRound();
      return;
    }
    this.phase = 'playing';
    this.startWave();
  }

  /** Advance the difficulty without interrupting anything. Open Season only. */
  private rollNextPlan(): void {
    this.round++;
    this.plan = planRound(this.round, this.seed);
    this.waveIndex = 0;
    this.released = 0;
    this.phase = 'playing';
    this.startWave();
  }

  private finishRound(): void {
    const scoreThisRound = this.stats.score - this.roundScoreStart;
    const summary = summariseRound(
      this.round, this.hitThisRound, this.plan.duckCount, this.shotsThisRound,
      this.bestComboThisRound, this.shells, scoreThisRound);

    this.stats.score += summary.bonus;
    if (summary.perfect) {
      this.stats.perfectRounds++;
      this.audio.play('perfect');
      this.labels.add(VIEW_W / 2, 170, 'PERFECT ROUND!', '#ffe08a', true);
      this.particles.emit('star', VIEW_W / 2, 200, 26, {
        color: '#ffe08a', speed: 260, life: 1.1, size: 7, gravity: 60,
      });
      this.dog.active = true;
      this.dog.pose = 'proud';
      this.dog.stage = 'search';
      this.dog.timer = 1.2;
      this.dog.x = VIEW_W / 2;
    }

    this.lastSummary = summary;
    this.phase = 'roundEnd';
    this.onRoundComplete?.(summary);
  }

  /** Move to the next round. Called by the app once the round card has been shown. */
  nextRound(): void {
    this.round++;
    this.plan = planRound(this.round, this.seed);
    this.env = envFor(this.plan.environment);
    this.waveIndex = 0;
    this.released = 0;
    this.hitThisRound = 0;
    this.shotsThisRound = 0;
    this.bestComboThisRound = 0;
    this.roundScoreStart = this.stats.score;
    this.ducks = [];
    this.spawnQueue = [];
    this.shells = SHELLS;
    this.phase = 'roundCard';
    this.phaseTimer = 1.5;
    this.particles.clear();
  }

  private endGame(): void {
    this.phase = 'over';
    this.audio.play('gameOver');
    this.onGameOver?.();
  }

  // ── shooting ──────────────────────────────────────────────────────────────

  aimAt(x: number, y: number, touch: boolean): void {
    this.aimX = x;
    this.aimY = y;
    this.usingTouch = touch;
  }

  /**
   * Fire.
   *
   * Everything that makes a shot feel immediate happens on this frame: the sound, the flash, the
   * crosshair kick and the hit resolution. Nothing is deferred to an animation callback, because
   * a shot that resolves one frame late is the difference between a game that feels tight and
   * one that feels laggy — and players notice it without being able to name it.
   */
  shoot(x: number, y: number, touch: boolean): void {
    if (this.phase !== 'playing') return;
    if (this.harvester.active) return;      // the machine is out; the shooting is over
    this.aimAt(x, y, touch);

    if (this.reload > 0 || this.shells <= 0) {
      this.audio.play('empty');
      this.crosshairSpread = Math.max(this.crosshairSpread, 0.5);
      if (this.shells <= 0 && this.reload <= 0) this.reload = RELOAD_SECONDS;
      return;
    }

    // Open Season is about volume, not conservation: the barrel never runs dry.
    if (this.mode !== 'free') this.shells--;
    this.stats.shotsFired++;
    this.shotsThisRound++;
    this.audio.play('shot');
    this.crosshairSpread = 1;
    this.muzzle = 1;
    if (this.shakeEnabled) this.shake = Math.max(this.shake, 0.5);

    const pad = touch ? HIT_PAD_TOUCH : HIT_PAD_MOUSE;
    const shot = resolveShot(this.ducks, x, y, pad);

    if (shot.index < 0) {
      this.stats.combo = 0;
      this.particles.emit('puff', x, y, 4, {
        color: 'rgba(255,255,255,0.5)', speed: 60, life: 0.3, size: 4, gravity: 40,
      });
      if (this.shells === 0) this.reload = RELOAD_SECONDS;
      return;
    }

    this.registerHit(shot.index, shot.distance, pad);
    if (this.shells === 0 && this.aliveCount > 0) this.reload = RELOAD_SECONDS;
  }

  private registerHit(index: number, distance: number, pad: number): void {
    const duck = this.ducks[index];
    duck.shellsUsed++;
    duck.damage++;

    this.stats.shotsHit++;
    this.hitFlash = 1;

    // An armoured duck takes the hit but keeps flying until its last one.
    if (duck.damage < duck.type.hits) {
      this.audio.play('clang');
      this.particles.emit('spark', duck.x, duck.y, 8, {
        color: '#ffd88a', speed: 170, life: 0.35, size: 3, gravity: 200,
      });
      this.freeze = HIT_STOP * 0.6;
      return;
    }

    const quality = shotQuality(duck, distance, pad);
    const award = awardHit(duck.type, duck.shellsUsed, this.stats.combo);

    this.stats.score += award.points;
    this.stats.ducksHit++;
    this.hitThisRound++;
    this.stats.combo++;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.stats.combo);
    this.bestComboThisRound = Math.max(this.bestComboThisRound, this.stats.combo);
    if (duck.type.rare) this.stats.rareDucks++;

    duck.phase = 'hit';
    duck.hitTimer = 0.24;
    duck.vx *= 0.3;
    duck.vy = -40;

    this.freeze = duck.type.rare ? HIT_STOP_RARE : HIT_STOP;
    if (this.shakeEnabled) this.shake = Math.max(this.shake, duck.type.rare ? 1 : 0.7);
    this.audio.play(duck.type.rare ? 'hitRare' : 'hit');

    // Feathers in the duck's own colours — the single clearest confirmation of a hit.
    this.particles.emit('feather', duck.x, duck.y, duck.type.rare ? 16 : 11, {
      color: duck.type.colors[0], speed: 150, life: 1.5, size: 7, gravity: 120,
    });
    this.particles.emit('feather', duck.x, duck.y, 5, {
      color: duck.type.colors[1], speed: 120, life: 1.4, size: 6, gravity: 110,
    });
    this.particles.emit('ring', duck.x, duck.y, 1, {
      color: '#ffffff', speed: 0, life: 0.3, size: 12, gravity: 0,
    });
    if (duck.type.rare) {
      this.particles.emit('star', duck.x, duck.y, 14, {
        color: '#ffe08a', speed: 220, life: 0.9, size: 6, gravity: 90,
      });
    }

    const label = quality > 0.72 && award.firstShell ? 'PERFECT SHOT' : award.label;
    this.labels.add(duck.x, duck.y - 18, label,
      duck.type.rare ? '#ffe08a' : '#fff3cf', duck.type.rare || this.stats.combo >= 5);
    this.labels.add(duck.x, duck.y + 4, `+${award.points}`, '#ffffff');
  }

  // ── the dog ───────────────────────────────────────────────────────────────

  private startRetrieve(): void {
    this.phase = 'retrieve';
    /**
     * The whole trip is one second, and the *round* only waits for the grab.
     *
     * `phaseTimer` is the pause the player actually feels, and it is deliberately shorter than
     * the dog's animation: he keeps trotting off screen during the next wave. Waiting for him to
     * finish leaving was what made every duck cost two seconds of watching a dog.
     */
    const duration = this.quickRetrieve ? DOG_RETRIEVE_SECONDS * 0.6 : DOG_RETRIEVE_SECONDS;
    this.phaseTimer = duration * 0.62;
    this.dog.active = true;
    this.dog.stage = 'in';
    this.dog.pose = 'run1';
    this.dog.x = -DOG_W;
    // He runs to roughly where the bird came down rather than to a random spot, which reads as
    // fetching rather than as patrolling — and keeps the run short.
    const fell = this.lastFellX ?? VIEW_W * 0.5;
    this.dog.targetX = Math.max(VIEW_W * 0.16, Math.min(VIEW_W * 0.72, fell));
    this.dog.timer = duration;
    this.dog.carrying = null;
    this.audio.play('dogRun');
  }

  private startTease(): void {
    this.phase = 'retrieve';
    this.phaseTimer = DOG_TEASE_SECONDS * 0.7;
    this.dog.active = true;
    this.dog.stage = 'search';
    // Four reactions, chosen at random, so the joke does not wear out in one session.
    const reactions: DogPose[] = ['tease', 'confused', 'tease', 'sniff'];
    this.dog.pose = reactions[Math.floor(this.random() * reactions.length)];
    this.dog.x = VIEW_W * (0.4 + this.random() * 0.2);
    this.dog.y = GROUND_Y - 6;
    this.dog.timer = DOG_TEASE_SECONDS;
    this.dog.carrying = null;
    this.audio.play('dogTease');
  }

  /**
   * The retrieval, as a small state machine.
   *
   * In → search → out, with the pose driven by the stage rather than by a timeline, so cutting
   * the duration in half (the quick-retrieve setting) shortens every stage evenly instead of
   * truncating the end and losing the payoff.
   */
  private updateDog(dt: number): void {
    const dog = this.dog;
    if (!dog.active) {
      // Idle in the grass between rounds, occasionally sniffing about.
      dog.phase += dt;
      return;
    }
    dog.phase += dt;
    dog.timer -= dt;

    const speed = this.quickRetrieve ? DOG_SPEED * 1.3 : DOG_SPEED;

    if (dog.stage === 'in') {
      dog.x += speed * dt;
      dog.pose = Math.floor(dog.phase * 9) % 2 === 0 ? 'run1' : 'run2';
      // A little bounce, so the run does not slide.
      dog.y = GROUND_Y - 6 - Math.abs(Math.sin(dog.phase * 9)) * 5;
      if (dog.x >= dog.targetX) {
        dog.stage = 'search';
        dog.timer = this.quickRetrieve ? 0.1 : 0.16;
        dog.pose = 'sniff';
        this.audio.play('sniff');
      }
      return;
    }

    if (dog.stage === 'search') {
      dog.y = GROUND_Y - 6;
      if (dog.timer <= 0) {
        if (this.pendingRetrieve.length > 0) {
          dog.carrying = this.pendingRetrieve.shift()!;
          dog.pose = 'carry';
          this.audio.play('bark');
          this.particles.emit('puff', dog.x, GROUND_Y - 10, 7, {
            color: this.env.grass, speed: 100, life: 0.4, size: 6, gravity: 120,
            dir: -Math.PI / 2, spread: Math.PI,
          });
        }
        dog.stage = 'out';
        dog.timer = 2;
      } else if (dog.pose === 'sniff' && dog.timer < (this.quickRetrieve ? 0.05 : 0.08)) {
        dog.pose = 'found';
      }
      return;
    }

    // Out: trot off the right edge, holding the duck up.
    dog.x += speed * 1.15 * dt;
    dog.y = GROUND_Y - 6 - Math.abs(Math.sin(dog.phase * 8)) * 4;
    if (dog.carrying) dog.pose = 'proud';
    else dog.pose = Math.floor(dog.phase * 9) % 2 === 0 ? 'run1' : 'run2';

    if (dog.x > VIEW_W + DOG_W) {
      dog.active = false;
      dog.carrying = null;
      dog.x = -DOG_W;
      // More birds down than one trip can carry: go again.
      if (this.pendingRetrieve.length > 0) this.startRetrieve();
    }
  }

  // ── the harvester ─────────────────────────────────────────────────────────

  /** Can the player call it in? Only in Open Season, only with something to collect. */
  get canHarvest(): boolean {
    return this.mode === 'free' && !this.harvester.active
      && this.phase !== 'over' && this.piled.length > 0;
  }

  get pileCount(): number { return this.piled.filter((p) => !p.taken).length; }

  /**
   * Call the harvester in.
   *
   * This is the player choosing to end the run, so it is deliberately theatrical: the machine
   * drives the whole width of the screen, scoops every bird it passes with a puff and a score
   * tick, and the tally lands only when it has driven off the far side. A button that simply cut
   * to a results panel would end the mode with a whimper.
   */
  callHarvester(): void {
    if (!this.canHarvest) return;
    this.phase = 'harvest';
    this.harvester.active = true;
    this.harvester.x = -HARVESTER_W;
    this.harvester.phase = 0;
    this.harvester.collected = 0;
    this.harvester.done = false;
    this.audio.play('harvest');
    this.labels.add(VIEW_W / 2, 150, 'HARVEST!', '#ffe08a', true);
  }

  private updateHarvester(dt: number): void {
    const h = this.harvester;
    if (!h.active) return;
    h.phase += dt;

    // Fast enough that the collection run is a flourish rather than a wait: the full width in
    // about three seconds, however many birds are down.
    h.x += 330 * dt;

    // The scoop is at the machine's front; anything it reaches goes in.
    const mouth = h.x + HARVESTER_W * 0.1;
    for (const bird of this.piled) {
      if (bird.taken || bird.x > mouth) continue;
      bird.taken = true;
      h.collected++;

      // Each bird is worth its own value again on collection — the pile is a bank, and cashing
      // it in is what the mode builds toward.
      const worth = 60 + Math.round(bird.size * 3);
      this.stats.score += worth;
      this.labels.add(bird.x, GROUND_Y - 34, `+${worth}`, '#ffe08a');
      this.particles.emit('feather', bird.x, GROUND_Y - 12, 5, {
        color: bird.colors[0], speed: 130, life: 0.9, size: 6, gravity: 140,
      });
      this.particles.emit('puff', bird.x, GROUND_Y - 8, 5, {
        color: this.env.grass, speed: 90, life: 0.4, size: 6, gravity: 100,
        dir: -Math.PI / 2, spread: Math.PI,
      });
      this.audio.play('scoop');
      if (this.shakeEnabled) this.shake = Math.max(this.shake, 0.3);
    }

    if (h.x > VIEW_W + HARVESTER_W * 0.4 && !h.done) {
      h.done = true;
      h.active = false;
      this.endGame();
    }
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  draw(
    ctx: CanvasRenderingContext2D, cache: SpriteCache, backdrop: Backdrop,
    quality: 'low' | 'high'
  ): void {
    const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 9 : 0;
    const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 9 : 0;

    ctx.save();
    ctx.translate(shakeX, shakeY);

    backdrop.draw(ctx, this.elapsed, this.env);
    this.ambience.draw(ctx, this.env, quality);

    // Ducks, back to front by size so a giant never hides a swift.
    const sorted = [...this.ducks].sort((a, b) => b.type.size - a.type.size);
    for (const duck of sorted) {
      const pose = this.duckPose(duck);
      const sprite = cache.duck(duck.type.kind, pose, duck.type.size,
        duck.type.colors, duck.type.kind === 'armored');
      const w = duck.type.size;
      const h = duck.type.size * 0.78;

      ctx.save();
      ctx.translate(duck.x, duck.y);
      if (duck.phase === 'falling') ctx.rotate(Math.sin(this.elapsed * 14) * 0.5);
      // Sprites are drawn facing right; a duck flying left is mirrored about its own centre.
      if (duck.dir < 0 && duck.phase === 'flying') ctx.scale(-1, 1);

      if (duck.type.rare && duck.phase === 'flying') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const r = w * (0.75 + Math.sin(this.elapsed * 6) * 0.08);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, 'rgba(255,224,138,0.5)');
        g.addColorStop(1, 'rgba(255,180,60,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-r, -r, r * 2, r * 2);
        ctx.restore();
      }

      ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
      ctx.restore();
    }

    this.drawDog(ctx, cache);
    backdrop.drawGround(ctx);
    /**
     * The pile and the machine live in *front* of the fence, not behind it.
     *
     * Drawn after the ground strip on purpose. The first version put them before it, and the
     * fence rails swallowed both — eight birds on the ground with nothing visible, and a
     * harvester that read as a floating orange box with no wheels. Biscuit stays behind, which
     * gives the scene a bit of depth for free: the dog works the fence line, the machine works
     * the near grass.
     */
    this.drawPile(ctx, cache);
    this.drawHarvester(ctx, cache);
    this.particles.draw(ctx, cache);
    this.labels.draw(ctx);

    ctx.restore();
  }

  private duckPose(duck: ActiveDuck): 'up' | 'mid' | 'down' | 'glide' | 'hit' | 'fall' {
    if (duck.phase === 'hit') return 'hit';
    if (duck.phase === 'falling') return 'fall';
    // Gliding while diving, beating hard while fleeing — the flap rate is information.
    if (duck.vy > duck.speed * 0.5) return 'glide';
    const frame = Math.floor(duck.flap * (duck.fleeing ? 1.7 : 1)) % 4;
    return (['up', 'mid', 'down', 'mid'] as const)[frame];
  }

  /**
   * The pile of birds along the grass line.
   *
   * Drawn *before* the ground strip so they sit half-buried in the grass rather than on top of
   * it, which is what makes the meadow fill up rather than acquire a row of stickers. Each one
   * leans a different way, and they are drawn shortest-first so a big bird never hides a small
   * one behind it.
   */
  private drawPile(ctx: CanvasRenderingContext2D, cache: SpriteCache): void {
    if (this.piled.length === 0) return;
    const sorted = [...this.piled].filter((b) => !b.taken).sort((a, b) => b.size - a.size);
    for (const bird of sorted) {
      const s = bird.size * 0.82;
      const sprite = cache.duck(bird.kind, 'fall', Math.round(s), bird.colors, false);
      ctx.save();
      ctx.translate(bird.x, GROUND_Y + PILE_BASELINE);
      ctx.rotate(bird.lean);
      ctx.drawImage(sprite, -s / 2, -s * 0.5, s, s * 0.78);
      ctx.restore();
    }
  }

  private drawHarvester(ctx: CanvasRenderingContext2D, cache: SpriteCache): void {
    const h = this.harvester;
    if (!h.active) return;
    const sprite = cache.harvester(Math.floor(h.phase * 12) % 8, '#e2503f');
    ctx.drawImage(sprite, Math.round(h.x), Math.round(GROUND_Y + HARVESTER_BASELINE - HARVESTER_H));
  }

  private drawDog(ctx: CanvasRenderingContext2D, cache: SpriteCache): void {
    const dog = this.dog;
    if (!dog.active) return;

    const sprite = cache.dog(dog.pose, Math.floor(dog.phase * 8) % 8, this.bandana);
    ctx.save();
    ctx.translate(dog.x, dog.y);
    // Facing is by travel direction; the sprite is authored facing right.
    ctx.drawImage(sprite, -DOG_W / 2, -DOG_H);

    // The retrieved duck, held up over the dog's head.
    if (dog.carrying) {
      const c = dog.carrying;
      const s = Math.min(34, c.size * 0.7);
      const duckSprite = cache.duck(c.kind, 'fall', Math.round(s), c.colors, false);
      ctx.save();
      ctx.translate(14, -DOG_H - 4);
      ctx.rotate(-0.4);
      ctx.drawImage(duckSprite, -s / 2, -s * 0.39, s, s * 0.78);
      ctx.restore();
    }
    ctx.restore();
  }

  /** Crosshair and weapon are drawn after the HUD so nothing ever covers the aim point. */
  get aimState(): { x: number; y: number; spread: number; flash: number; empty: boolean } {
    return {
      x: this.aimX, y: this.aimY,
      spread: this.crosshairSpread,
      flash: this.hitFlash,
      empty: this.shells <= 0 || this.reload > 0,
    };
  }

  get muzzleAmount(): number { return this.muzzle; }
  get elapsedSeconds(): number { return this.elapsed; }
  get skyBottom(): number { return SKY_BOTTOM; }
}
