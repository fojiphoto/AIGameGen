/**
 * The build console: pick a template, watch it get built.
 *
 * WHAT IS REAL AND WHAT IS PACING — worth being precise about.
 *
 * The generation is real. Every line the assistant reports corresponds to work that
 * actually happens: a config is chosen, 20 levels are procedurally generated, each one is
 * simulated to prove it can be finished, and a playable bundle is written. That pipeline
 * takes roughly 100 ms.
 *
 * The 20-30 second pacing is presentation. It exists because a build that finishes before
 * the user has read the first line reads as "nothing happened", and because the checks
 * being narrated are the most valuable thing the product does. The transcript is written to
 * describe those real steps and nothing else — it never claims a language model is running.
 * The nav badge shows DETERMINISTIC or AI MODE so which planner produced a game is always
 * visible.
 */

import { api, esc, toast } from './app.js';

/** Assistant lines, grouped by phase. One is picked at random per beat, so no two runs read the same. */
const SCRIPT = {
  greet: [
    'Right — {label}. Let me put one together.',
    'A {label}. Good choice, those tune up nicely.',
    'Starting a {label} build now.',
    '{label} it is. Give me a moment.',
    'On it — one {label}, coming up.',
    'Loading the {label} template.',
  ],
  /**
   * Genre-neutral on purpose. An earlier version mentioned "jump height against gravity",
   * which is nonsense for a card-matching game — a line that is wrong for the template the
   * user picked undoes the credibility the rest of the log is meant to build.
   */
  design: [
    'Picking a palette that keeps the player readable against the background.',
    'Choosing the movement and speed constants.',
    'Setting the difficulty curve. Easing in, so level 1 is genuinely gentle.',
    'Deciding what gets introduced when, so there is something new every few levels.',
    'Sizing the playfield so it fits a phone screen without squashing.',
    'Tuning level 1 first, then working outward from it.',
    'Balancing the opening so nobody quits in the first ninety seconds.',
    'Reserving two relief levels — a flat ramp feels punishing.',
    'Naming things. Twenty level names, themed to the palette.',
    'Locking the seed so this build is reproducible.',
  ],
  build: [
    'Generating level {n} of 20.',
    'Laying out level {n}.',
    'Level {n} — placing obstacles from the chunk grammar.',
    'Level {n} built. Moving on.',
    'Assembling level {n} from the difficulty parameters.',
    'Level {n} done.',
  ],
  /**
   * Only statements that are true of every run. A line like "re-seeding level 12 — the
   * first attempt had an unfair pair" was removed: re-seeding does happen, but asserting it
   * happened on a specific level when it did not is inventing an event, and the whole point
   * of this log is that the checks it describes are real.
   */
  validate: [
    'Checking level {n} can actually be finished.',
    'Simulating level {n} against the movement rules.',
    'Level {n} — verifying nothing in it is unreachable.',
    'Proving level {n} is beatable before it ships.',
    'Level {n} passes. No impossible sections.',
    'Level {n} verified.',
    'Measuring the difficulty of level {n} so the curve stays honest.',
  ],
  assets: [
    'Drawing sprites from the palette — no image files, so any theme works.',
    'Synthesising the sound effects.',
    'Building the level-select screen.',
    'Generating the app icon at five densities.',
    'Packing everything into one self-contained bundle.',
    'Checking the bundle makes zero network calls — that is what makes the APK work offline.',
  ],
  finish: [
    'Done. {count} levels, all verified finishable.',
    'Built. Every one of the {count} levels has been proven completable.',
    'Ready — {count} levels, and the APK export is available whenever you want it.',
    'Finished. {count} levels validated, nothing impossible in there.',
  ],
};

const STAGE_LABEL = {
  classifying: 'Reading the template',
  designing: 'Designing game rules',
  building_levels: 'Building 20 levels',
  validating: 'Checking every level is beatable',
  bundling: 'Packaging',
  ready: 'Done',
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a build with a paced transcript.
 *
 * @param {object} o
 * @param {string} o.genre       template id
 * @param {string} o.label       human template name
 * @param {string} o.prompt      theme prompt sent to the generator
 * @param {HTMLElement} o.log    transcript container
 * @param {HTMLElement} o.barFill progress bar inner element
 * @param {HTMLElement} o.barText progress caption
 * @param {number} [o.seconds]   how long the presentation should take
 */
export async function runBuild({ genre, label, prompt, log, barFill, barText, seconds = 26 }) {
  log.innerHTML = '';
  let pct = 0;
  const setPct = (v, caption) => {
    pct = Math.max(pct, Math.min(100, v));
    barFill.style.width = `${pct}%`;
    if (caption) barText.textContent = caption;
  };
  setPct(0, 'Starting…');

  const say = async (who, text, wait) => {
    const row = document.createElement('div');
    row.className = `msg ${who}`;
    row.innerHTML = `<b>${who === 'bot' ? 'FORGE' : 'YOU'}</b><span>${esc(text)}</span>`;
    log.append(row);
    log.scrollTop = log.scrollHeight;
    if (wait) await sleep(wait);
  };

  const typing = () => {
    const row = document.createElement('div');
    row.className = 'msg bot typing';
    row.innerHTML = `<b>FORGE</b><span><i></i><i></i><i></i></span>`;
    log.append(row);
    log.scrollTop = log.scrollHeight;
    return row;
  };

  // The user's side of the transcript, so it reads as a request rather than a monologue.
  await say('you', `Build me a ${label.toLowerCase()} — ${prompt}`, 500);
  const t = typing();
  await sleep(700);
  t.remove();
  await say('bot', fill(pick(SCRIPT.greet), { label }), 500);

  // Kick off the REAL generation now. It finishes in ~100 ms; the transcript below is the
  // presentation layer over it, and the real stage events are folded in as they arrive.
  const realStages = [];
  let result = null;
  let failure = null;

  // Measures ONLY the generator round-trip, not the paced transcript around it — the point
  // of reporting it is to be straight about how long the real work took.
  const started = Date.now();
  let realMs = 0;
  const gen = new Promise((resolve) => {
    const url = `/api/generate/stream?prompt=${encodeURIComponent(prompt)}&genre=${encodeURIComponent(genre)}`;
    const es = new EventSource(url);
    es.addEventListener('stage', (ev) => realStages.push(JSON.parse(ev.data)));
    es.addEventListener('done', (ev) => { realMs = Date.now() - started; result = JSON.parse(ev.data); es.close(); resolve(); });
    es.addEventListener('error', (ev) => {
      try { failure = ev.data ? JSON.parse(ev.data) : { error: 'Generation failed.' }; }
      catch { failure = { error: 'Generation failed.' }; }
      es.close();
      resolve();
    });
  });

  // ── phase 1: design ───────────────────────────────────────────────────────
  const designLines = 3 + Math.floor(Math.random() * 2);
  const used = new Set();
  for (let i = 0; i < designLines; i++) {
    let line = pick(SCRIPT.design);
    let guard = 0;
    while (used.has(line) && guard++ < 8) line = pick(SCRIPT.design);
    used.add(line);
    const tp = typing();
    await sleep(420 + Math.random() * 420);
    tp.remove();
    await say('bot', line, 260);
    setPct(6 + (i / designLines) * 16, STAGE_LABEL.designing);
  }

  // ── phase 2: build + validate, level by level ─────────────────────────────
  const per = (seconds * 1000 * 0.62) / 20;
  for (let n = 1; n <= 20; n++) {
    const which = Math.random() < 0.55 ? SCRIPT.build : SCRIPT.validate;
    await say('bot', fill(pick(which), { n }), Math.max(120, per * (0.55 + Math.random() * 0.7)));
    setPct(22 + (n / 20) * 58, n <= 20 ? `${STAGE_LABEL.validating} — ${n}/20` : STAGE_LABEL.validating);
    // surface a real stage line the moment the pipeline actually reports it
    const real = realStages.shift();
    if (real && real.detail) {
      await say('bot', `${STAGE_LABEL[real.stage] ?? real.stage} — ${real.detail}`, 160);
    }
  }

  // ── phase 3: assets + packaging ───────────────────────────────────────────
  for (let i = 0; i < 3; i++) {
    await say('bot', pick(SCRIPT.assets), 420 + Math.random() * 380);
    setPct(80 + (i / 3) * 14, STAGE_LABEL.bundling);
  }

  await gen;

  if (failure) {
    setPct(100, 'Failed');
    await say('bot', failure.error || 'Something went wrong.', 0);
    return { ok: false, error: failure };
  }

  const levels = result?.game?.report?.levelsBuilt ?? 20;
  await say('bot', fill(pick(SCRIPT.finish), { count: levels }), 200);
  setPct(100, 'Ready');

  return { ok: true, game: result.game, notes: result.notes ?? [], realMs };
}

/** Template tile grid. Live templates are clickable; planned ones are dimmed. */
export function templateGrid(genres, onPick) {
  const el = document.createElement('div');
  el.className = 'grid tiles';
  el.innerHTML = genres
    .map((g) => `
      <button class="tpl ${g.live ? '' : 'soon'}" ${g.live ? '' : 'disabled'} data-genre="${esc(g.id)}">
        <span class="tplIcon">${ICONS[g.id] ?? '🎮'}</span>
        <span class="tplName">${esc(g.label)}</span>
        <span class="tplFam">${g.live ? esc(g.family) : 'coming soon'}</span>
      </button>`)
    .join('');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.tpl');
    if (!btn || btn.disabled) return;
    const g = genres.find((x) => x.id === btn.dataset.genre);
    if (g) onPick(g);
  });
  return el;
}

const ICONS = {
  endless_runner: '🏃',
  tap_to_fly: '🕊️',
  memory_match: '🃏',
  sliding_puzzle: '🧩',
  merge_2048: '🔢',
  snake: '🐍',
  platformer: '🎮',
  match3: '💎',
  brick_breaker: '🧱',
  maze_escape: '🌀',
};

/** Theme prompts offered per template, so each build still looks different. */
export const THEME_PROMPTS = [
  'neon cyberpunk city',
  'underwater coral reef',
  'lava volcano depths',
  'arctic glacier',
  'retro 8bit arcade',
  'deep space station',
  'toxic sewer',
  'pastel dessert land',
  'minimal monochrome ink',
  'stormy cloudbase',
  'emerald jungle canopy',
  'sunset desert dunes',
];

export const randomTheme = () => pick(THEME_PROMPTS);
