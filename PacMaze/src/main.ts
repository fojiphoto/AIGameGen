import { ArcadeAudio } from './audio';
import { COLORS, Game } from './game';
import { LEVELS, type Direction } from './levels';
import { Renderer } from './render';
import { loadSave, storeSave, type Checkpoint } from './save';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = get<HTMLCanvasElement>('maze');
const overlay = get('overlay');
const status = get('status');
const pauseButton = get<HTMLButtonElement>('pause');
const muteButton = get<HTMLButtonElement>('mute');
const scoreboard = ['score', 'high', 'lives', 'board', 'board-name', 'district', 'progress', 'remaining'].map(get);
const renderer = new Renderer(canvas);
const audio = new ArcadeAudio();
const save = loadSave();
audio.muted = save.muted;
let game = new Game();
let screen: 'home' | 'levels' | 'play' | 'pause' | 'result' = 'home';
let previousIndex = 0;
let previousPhase = game.phase;
let accumulator = 0;
let clock = 0;
let last = performance.now();

const num = (n: number) => String(n).padStart(2, '0');
const score = (n: number) => String(n).padStart(6, '0');
const button = (action: string, label: string, primary = false) => `<button type="button" data-action="${action}"${primary ? ' class="primary"' : ''}>${label}</button>`;
const write = (el: HTMLElement, value: string) => { if (el.textContent !== value) el.textContent = value; };

function panel(html: string) {
  overlay.hidden = false;
  overlay.innerHTML = `<div class="panel">${html}</div>`;
  pauseButton.disabled = screen !== 'pause';
  status.hidden = true;
}

function home() {
  screen = 'home';
  const current = save.checkpoint;
  const ghosts = COLORS.map(color => `<i style="--ink:${color}"></i>`).join('');
  panel(`<div class="ghost-row" aria-hidden="true">${ghosts}</div><span class="kicker">INSERT SKILL</span><h2>Clear the maze</h2><p>Eat every dot. Turn the tables with a power pellet. Clear all ${LEVELS.length} boards.</p><nav>${current ? button('continue', `CONTINUE · BOARD ${num(current.index + 1)}`, true) : ''}${button('start', 'NEW GAME', !current)}${button('levels', 'PRACTICE BOARDS')}${button('help', 'HOW TO PLAY')}</nav>`);
}

function chooseBoard() {
  screen = 'levels';
  panel(`<span class="kicker">PRACTICE</span><h2>Choose a board</h2><p>Clear boards in the arcade run to unlock more. Practice keeps its own score.</p><div class="level-grid">${LEVELS.map((level, i) => `<button data-action="board-${i}" title="${level.name}" aria-label="Board ${level.number}: ${level.name}"${i > save.cleared ? ' disabled' : i < save.cleared ? ' class="beaten"' : ''}>${num(level.number)}</button>`).join('')}</div>${button('home', 'BACK')}`);
}

function help() {
  panel(`<span class="kicker">CONTROLS</span><h2>How to play</h2><p>Use arrow keys, WASD, swipe the maze, or tap the directional pad. Queue your next turn before reaching an intersection.</p><p>Dots earn 10 points. Power pellets earn 50 and briefly turn the ghosts blue. Fruit is worth bonus points. Earn an extra life at 10,000.</p><p>Esc or P pauses the game. Continue restarts from the beginning of your saved board.</p>${button('home', 'BACK')}`);
}

function start(checkpoint: Checkpoint, practice = false) {
  game = new Game(checkpoint.index, checkpoint.score, checkpoint.lives, practice);
  previousIndex = game.index;
  previousPhase = game.phase;
  if (!practice) { save.checkpoint = { ...checkpoint }; storeSave(save); }
  resume();
}

function resume() {
  screen = 'play';
  overlay.hidden = true;
  pauseButton.disabled = false;
  pauseButton.setAttribute('aria-label', 'Pause');
  accumulator = 0;
}

function pause() {
  if (screen !== 'play') return;
  screen = 'pause';
  storeSave(save);
  pauseButton.setAttribute('aria-label', 'Resume');
  panel(`<span class="kicker">BOARD ${num(game.index + 1)}</span><h2>Paused</h2><nav>${button('resume', 'RESUME', true)}${button('home', 'MAIN MENU')}</nav>`);
}

function results() {
  screen = 'result';
  const win = game.phase === 'win';
  panel(`<span class="kicker">${game.practice ? 'PRACTICE' : 'ARCADE RUN'}</span><h2>${win ? (game.practice ? 'Board clear!' : `All ${LEVELS.length} cleared!`) : 'Game over'}</h2><p>Score <strong>${score(game.score)}</strong> · Board ${num(game.index + 1)}</p><nav>${button(game.practice ? 'board-' + game.index : 'start', game.practice ? 'TRY AGAIN' : 'NEW GAME', true)}${button('home', 'MAIN MENU')}</nav>`);
}

function refresh() {
  const [points, high, lives, board, name, district, progress, remaining] = scoreboard;
  write(points, score(game.score));
  write(high, score(save.best));
  write(lives, game.lives ? '◕'.repeat(game.lives) : '—');
  lives.setAttribute('aria-label', `${game.lives} lives remaining`);
  write(board, num(game.index + 1));
  write(name, game.level.name);
  write(district, game.level.district);
  const percent = `${Math.round((1 - game.remaining / game.initialDots) * 100)}%`;
  if (progress.style.width !== percent) progress.style.width = percent;
  write(remaining, `${game.remaining} DOTS LEFT`);
  const notice = screen === 'play' ? { ready: 'READY!', clear: 'BOARD CLEAR', caught: '', play: '', win: '', over: '' }[game.phase] : '';
  write(status, notice);
  status.hidden = !notice;
}

overlay.addEventListener('click', e => {
  const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!target || target.disabled) return;
  audio.unlock();
  const action = target.dataset.action!;
  if (action === 'start') start({ index: 0, score: 0, lives: 3 });
  else if (action === 'continue' && save.checkpoint) start(save.checkpoint);
  else if (action === 'levels') chooseBoard();
  else if (action === 'help') help();
  else if (action === 'resume') resume();
  else if (action === 'home') home();
  else if (action.startsWith('board-')) {
    const index = Number(action.slice(6));
    if (Number.isInteger(index) && index >= 0 && index < LEVELS.length && index <= save.cleared) start({ index, score: 0, lives: 3 }, true);
  }
});

pauseButton.onclick = () => screen === 'pause' ? resume() : pause();
function muteLabel() { muteButton.setAttribute('aria-pressed', String(audio.muted)); write(muteButton, audio.muted ? '♪ OFF' : '♪ ON'); }
muteButton.onclick = () => { save.muted = audio.muted = !audio.muted; muteLabel(); audio.unlock(); storeSave(save); };

const keys: Record<string, Direction> = { ArrowUp: 0, KeyW: 0, ArrowLeft: 1, KeyA: 1, ArrowDown: 2, KeyS: 2, ArrowRight: 3, KeyD: 3 };
function direct(direction: Direction) {
  if (screen !== 'play') return;
  game.wanted = direction;
  audio.unlock();
}
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (screen === 'play' || screen === 'pause') {
      e.preventDefault();
      if (!e.repeat) screen === 'play' ? pause() : resume();
    }
  } else if (e.code in keys && screen === 'play') { e.preventDefault(); direct(keys[e.code]); }
});
for (const key of document.querySelectorAll<HTMLButtonElement>('[data-dir]')) {
  key.addEventListener('pointerdown', e => { e.preventDefault(); direct(Number(key.dataset.dir) as Direction); });
  key.addEventListener('click', () => direct(Number(key.dataset.dir) as Direction));
}

let swipe: { id: number; x: number; y: number } | undefined;
canvas.addEventListener('pointerdown', e => {
  if (swipe || screen !== 'play') return;
  swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!swipe || swipe.id !== e.pointerId) return;
  const x = e.clientX - swipe.x, y = e.clientY - swipe.y;
  if (Math.max(Math.abs(x), Math.abs(y)) < 16) return;
  direct(Math.abs(x) > Math.abs(y) ? (x > 0 ? 3 : 1) : (y > 0 ? 2 : 0));
  swipe.x = e.clientX; swipe.y = e.clientY;
});
canvas.addEventListener('lostpointercapture', e => { if (swipe?.id === e.pointerId) swipe = undefined; });
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('pagehide', () => storeSave(save));

function transitions() {
  if (!game.practice) save.best = Math.max(save.best, game.score);
  if (!game.practice && game.phase === 'clear' && previousPhase !== 'clear') {
    save.cleared = Math.max(save.cleared, game.index + 1);
    save.checkpoint = game.index === LEVELS.length - 1 ? null : { index: game.index + 1, score: game.score, lives: game.lives };
    storeSave(save);
  }
  if (!game.practice && (previousIndex !== game.index || game.phase === 'caught' && previousPhase !== 'caught')) storeSave(save);
  if (game.phase === 'over' || game.phase === 'win') {
    if (!game.practice) { save.checkpoint = null; storeSave(save); }
    results();
  }
  previousIndex = game.index;
  previousPhase = game.phase;
}

function frame(now: number) {
  const delta = Math.min(.06, (now - last) / 1000);
  last = now;
  if (screen !== 'pause') clock += delta;
  if (screen === 'play') {
    accumulator += delta;
    while (accumulator >= 1 / 120) { game.update(1 / 120); accumulator -= 1 / 120; }
    for (const cue of game.events.splice(0)) audio.cue(cue);
    if (game.phase === 'play') audio.pulse(game.power > 0, 1 - game.remaining / game.initialDots);
    transitions();
  }
  refresh();
  renderer.draw(game, clock);
  requestAnimationFrame(frame);
}

home();
muteLabel();
requestAnimationFrame(frame);
