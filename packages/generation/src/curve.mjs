/**
 * §C2 Difficulty Curve Engine.
 *
 * Design principles encoded here, not left to the AI:
 *   1. Gentle onboarding  — easeInQuad keeps levels 1-4 genuinely easy.
 *   2. Novelty > numbers  — a new obstacle every ~4-5 levels beats "same, faster".
 *   3. Relief valleys     — levels 8 & 15 dip easier so the ramp has rhythm.
 *   4. Bias shifts, never reshapes — "hard" moves the whole curve, the shape holds.
 *   5. Duration guard     — no level may run absurdly long, whatever the AI asked for.
 */

export const PIXELS_PER_METRE = 25;

/** Level duration is clamped into this band regardless of AI knob values. */
export const MIN_LEVEL_SECONDS = 18;
export const MAX_LEVEL_SECONDS = 85;

const CURVES = {
  linear:      (t) => t,
  easeInQuad:  (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  sCurve:      (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  stepped:     (t) => Math.floor(t * 5) / 4,
};

export function applyCurve(t, shape) {
  const f = CURVES[shape] ?? CURVES.easeInQuad;
  return Math.max(0, Math.min(1, f(Math.max(0, Math.min(1, t)))));
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Relief valleys pull difficulty back ~15% so progression has texture. */
const RELIEF_FACTOR = 0.85;

/**
 * Per-level tuning parameters. Pure function of (level, config).
 * @returns {{level:number,progress:number,eased:number,speed:number,spawnGap:number,
 *            targetMetres:number,targetPx:number,estSeconds:number,
 *            activeObstacles:Array,isRelief:boolean,newObstacleIds:string[]}}
 */
export function levelParams(level, config) {
  const { difficulty: d, progression: p, obstacles } = config;
  const total = p.levels;

  const t = total > 1 ? (level - 1) / (total - 1) : 0;
  let eased = applyCurve(t, d.curve);

  const isRelief = p.reliefLevels.includes(level);
  if (isRelief) eased *= RELIEF_FACTOR;

  const speed = lerp(d.startSpeed, d.maxSpeed, eased);
  const spawnGap = lerp(d.spawnGapStart, d.spawnGapEnd, eased);

  // Target distance grows geometrically, then gets duration-clamped.
  let targetMetres = d.baseTarget * Math.pow(d.growth, level - 1);
  if (isRelief) targetMetres *= 0.9;

  let targetPx = targetMetres * PIXELS_PER_METRE;
  let estSeconds = targetPx / speed;

  if (estSeconds > MAX_LEVEL_SECONDS) {
    estSeconds = MAX_LEVEL_SECONDS;
    targetPx = estSeconds * speed;
    targetMetres = targetPx / PIXELS_PER_METRE;
  } else if (estSeconds < MIN_LEVEL_SECONDS) {
    estSeconds = MIN_LEVEL_SECONDS;
    targetPx = estSeconds * speed;
    targetMetres = targetPx / PIXELS_PER_METRE;
  }

  const activeObstacles = obstacles.filter((o) => o.introAtLevel <= level);
  const newObstacleIds = obstacles.filter((o) => o.introAtLevel === level).map((o) => o.id);

  return {
    level,
    progress: t,
    eased,
    speed: Math.round(speed * 100) / 100,
    spawnGap: Math.round(spawnGap),
    targetMetres: Math.round(targetMetres),
    targetPx: Math.round(targetPx),
    estSeconds: Math.round(estSeconds * 10) / 10,
    activeObstacles,
    newObstacleIds,
    isRelief,
  };
}

/**
 * Endless mode scales past level 20 with a soft cap so it stays survivable.
 * Called by the runtime, not the builder.
 */
export function endlessParams(elapsedSeconds, config) {
  const d = config.difficulty;
  const rampSeconds = 150;
  const t = 1 - Math.exp(-elapsedSeconds / rampSeconds); // asymptotic
  return {
    speed: lerp(d.maxSpeed * 0.8, d.maxSpeed * 1.35, t),
    spawnGap: lerp(d.spawnGapEnd * 1.25, d.spawnGapEnd * 0.85, t),
  };
}

/** Human-readable difficulty ladder — used by the UI level inspector. */
export function difficultyLadder(config) {
  return Array.from({ length: config.progression.levels }, (_, i) => {
    const p = levelParams(i + 1, config);
    return {
      level: p.level,
      speed: p.speed,
      spawnGap: p.spawnGap,
      targetMetres: p.targetMetres,
      estSeconds: p.estSeconds,
      isRelief: p.isRelief,
      newObstacles: p.newObstacleIds,
    };
  });
}
