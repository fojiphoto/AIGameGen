import { Game, type Aim, type Result } from './game';
import { ANGLE_LIMIT, CHAPTERS, LEVELS, ORIGIN, PALETTE, WIDTH } from './levels';
import { Renderer, orb, postcard, travel, type Flight } from './render';
import { readSave, writeSave } from './save';

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screen = get('shell'), canvas = get<HTMLCanvasElement>('board'), next = get<HTMLCanvasElement>('next');
const renderer = new Renderer(canvas), save = readSave();
const menu = get('menu'), play = get('play'), overlay = get('overlay'), dialog = get('dialog');
const soundButton = get('sound'), symbolsButton = get('symbols'), pauseButton = get<HTMLButtonElement>('pause');
const shootButton = get<HTMLButtonElement>('shoot'), swapButton = get<HTMLButtonElement>('swap');
const pressure = get('pressure'), remaining = get('remaining'), score = get('score'), callout = get('callout');
const nextLabel = get('next-label'), missesLeft = get('misses-left');
let game: Game | undefined, flight: Flight | undefined, path: Aim | undefined;
let angle = 0, chosenChapter = 0, pointer: number | undefined, panel = '';
let last = performance.now(), nextShot = 0, messageTimeout = 0, finish = 0;
let oldFocus: HTMLElement | undefined;
let audio: AudioContext | undefined;
const aimKeys = new Set<string>();
const format = (n: number) => String(n).padStart(2, '0');
const action = (id: string, label: string, primary = false) => `<button type="button" data-action="${id}" class="${primary ? 'primary' : 'quiet'}">${label}</button>`;

function audioOn() {
  if (save.muted) return;
  try { audio ??= new AudioContext(); if (audio.state === 'suspended') void audio.resume().catch(() => {}); } catch { /* Sound is optional. */ }
}

function sound(notes: number[], volume = .06) {
  if (!audio || audio.state !== 'running' || save.muted) return;
  for (const [i, note] of notes.entries()) {
    const osc = audio.createOscillator(), gain = audio.createGain(), at = audio.currentTime + i * .064;
    osc.type = 'sine'; osc.frequency.setValueAtTime(note, at); osc.frequency.exponentialRampToValueAtTime(note * .82, at + .13);
    gain.gain.setValueAtTime(.001, at); gain.gain.linearRampToValueAtTime(volume, at + .006); gain.gain.exponentialRampToValueAtTime(.001, at + .15);
    osc.connect(gain).connect(audio.destination); osc.start(at); osc.stop(at + .16);
  }
}

function labels() {
  soundButton.textContent = save.muted ? 'Sound off' : 'Sound on';
  soundButton.setAttribute('aria-pressed', String(!save.muted));
  symbolsButton.textContent = save.symbols ? 'Symbols on' : 'Symbols off';
  symbolsButton.setAttribute('aria-pressed', String(save.symbols));
}

function modal(kind: string, title: string, html: string) {
  if (overlay.hidden && document.activeElement instanceof HTMLElement) oldFocus = document.activeElement;
  pointer = undefined; aimKeys.clear(); panel = kind;
  screen.inert = true; overlay.hidden = false;
  dialog.innerHTML = `<h2 id="dialog-title" tabindex="-1">${title}</h2>${html}`;
  dialog.querySelector<HTMLElement>('h2')!.focus();
}

function close(restore = true) {
  panel = ''; overlay.hidden = true; screen.inert = false;
  if (restore && oldFocus?.isConnected) oldFocus.focus();
  oldFocus = undefined;
}

function home() {
  game = undefined; flight = undefined; pointer = undefined; aimKeys.clear();
  play.hidden = true; menu.hidden = false; close(false);
  get('start').innerHTML = `${save.best.length >= LEVELS.length ? 'Replay level 100' : `Play level ${format(save.best.length + 1)}`} <span aria-hidden="true">→</span>`;
}

function levels(chapter = Math.min(CHAPTERS.length - 1, Math.floor(save.best.length / 10))) {
  chosenChapter = chapter;
  const list = LEVELS.slice(chapter * 10, chapter * 10 + 10).map(level => {
    const index = level.number - 1, stars = save.best[index]?.stars ?? 0, locked = index > save.best.length;
    const label = locked ? `Level ${level.number}, locked` : stars ? `Level ${level.number}, ${stars} stars` : `Level ${level.number}`;
    return `<button type="button" data-action="level-${index}" class="level${index === save.best.length ? ' current' : ''}" aria-label="${label}" ${locked ? 'disabled' : ''}>${format(level.number)}<small>${locked ? 'Locked' : '★'.repeat(stars)}</small></button>`;
  }).join('');
  modal('levels', 'Level select', `<p>${save.best.length} of ${LEVELS.length} cleared</p><div class="chapter-nav"><button class="quiet" data-action="prev-chapter" aria-label="Previous chapter" ${chapter === 0 ? 'disabled' : ''}>←</button><strong>${CHAPTERS[chapter][0]}</strong><button class="quiet" data-action="next-chapter" aria-label="Next chapter" ${chapter + 1 === CHAPTERS.length ? 'disabled' : ''}>→</button></div><div class="level-list">${list}</div><nav>${action('home', 'Back')}</nav>`);
}

function help() {
  modal('help', 'How to play', `<p>Aim at a group and release to shoot. Connect three or more bubbles of the same color to pop them. Bubbles with no connection to the ceiling drop.</p><p>Bank shots off the walls. Tap Swap or press X to switch to the next bubble. After the miss meter runs out, the ceiling moves down. Clear every bubble before the reef crosses the dashed line.</p><p>On a keyboard, hold ← or → to aim and press Space to shoot. Press Esc to pause.</p><nav>${action('back', 'Back', true)}</nav>`);
}

function hud() {
  if (!game) return;
  score.textContent = game.score.toLocaleString('en-US');
  remaining.textContent = String(game.left);
  missesLeft.textContent = `${game.chances} misses before the ceiling drops`;
  pressure.innerHTML = Array.from({ length: game.level.tension }, (_, i) => `<i class="${i >= game!.chances ? 'empty' : game!.chances === 1 ? 'last' : ''}"></i>`).join('');
  const context = next.getContext('2d')!;
  context.clearRect(0, 0, next.width, next.height);
  orb(context, 36, 36, 29, game.next, save.symbols);
  const nextName = PALETTE[game.next - 1].name;
  nextLabel.textContent = nextName;
  swapButton.setAttribute('aria-label', `Swap to ${nextName}`);
  const disabled = !!flight || game.status !== 'playing';
  shootButton.disabled = swapButton.disabled = disabled;
  pauseButton.disabled = game.status !== 'playing';
}

function aimAt(a: number) {
  const target = Math.max(-ANGLE_LIMIT, Math.min(ANGLE_LIMIT, a));
  if (target === angle && path) return;
  angle = target;
  path = game?.trace(angle);
}

function message(text: string, seconds: number) {
  callout.textContent = text; callout.hidden = false; messageTimeout = seconds;
}

function start(index: number) {
  if (index < 0 || index >= LEVELS.length || index > save.best.length) return;
  game = new Game(index);
  flight = undefined; path = undefined; pointer = undefined; aimKeys.clear();
  nextShot = finish = messageTimeout = 0;
  close(false); menu.hidden = true; play.hidden = false; callout.hidden = true;
  renderer.reset();
  get('chapter').textContent = CHAPTERS[game.level.chapter][0];
  get('level-title').textContent = `Level ${format(index + 1)} / ${LEVELS.length}`;
  if (index === 0) message('Match three. Aim and release to shoot.', 4);
  aimAt(0); hud();
  canvas.focus({ preventScroll: true });
}

function ready() { return game?.status === 'playing' && !panel && !flight && nextShot <= 0; }

function fire() {
  if (!game || !path || !ready()) return;
  audioOn(); sound([330], .047); callout.hidden = true;
  flight = { aim: path, color: game.current, distance: 0 };
  hud();
}

function swap() {
  if (!game || !ready()) return;
  audioOn(); game.swap(); sound([470]); hud();
}

function settled(result: Result) {
  renderer.pop(result);
  if (result.removed.length) {
    sound(result.removed.some(b => b.falling) ? [520, 690, 890] : [510, 720]);
    if (result.removed.length >= 8 && game?.status === 'playing') message(`${result.removed.length} bubbles cleared`, .8);
  } else sound(result.newDrop > result.oldDrop ? [240, 150] : [285], .05);
  if (result.newDrop > result.oldDrop) message('Ceiling moved down', .8);
  nextShot = result.newDrop > result.oldDrop ? .18 : .045;
  path = game?.trace(angle);
  hud();
}

function results() {
  if (!game) return;
  if (game.status === 'won') {
    const best = save.best[game.index];
    save.best[game.index] = { stars: Math.max(game.stars, best?.stars ?? 0), score: Math.max(game.score, best?.score ?? 0) };
    writeSave(save);
    sound([523, 659, 784, 1047], .085);
    modal('result', game.level.number === LEVELS.length ? 'Reef complete!' : 'Level clear!', `<p class="stars" aria-label="${game.stars} of 3 stars">${'★'.repeat(game.stars)}${'☆'.repeat(3 - game.stars)}</p><p>${game.score.toLocaleString('en-US')} points · ${game.shots} shots</p><nav>${game.level.number < LEVELS.length ? action('next-level', 'Next level', true) : ''}${action('retry', 'Replay')}${action('level-select', 'Level select')}${action('home', 'Main menu')}</nav>`);
  } else {
    sound([390, 280, 150]);
    modal('result', 'Reef overflowed', `<p>${game.left} bubbles left · ${game.score.toLocaleString('en-US')} points</p><nav>${action('retry', 'Try again', true)}${action('level-select', 'Level select')}${action('home', 'Main menu')}</nav>`);
  }
}

function pause() {
  if (!game || game.status !== 'playing' || panel) return;
  modal('pause', 'Paused', `<nav>${action('back', 'Resume', true)}${action('retry', 'Restart')}${action('home', 'Main menu')}</nav>`);
}

function point(e: PointerEvent) {
  const rect = canvas.getBoundingClientRect(), scale = WIDTH / rect.width;
  const x = (e.clientX - rect.left) * scale, y = (e.clientY - rect.top) * scale;
  if (y >= ORIGIN.y - 4) return false;
  aimAt(Math.atan2(x - ORIGIN.x, ORIGIN.y - y));
  return true;
}

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !ready() || pointer !== undefined || !point(e)) return;
  e.preventDefault(); audioOn(); pointer = e.pointerId; canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => { if (ready() && (pointer === e.pointerId || (pointer === undefined && e.pointerType === 'mouse'))) point(e); });
canvas.addEventListener('pointerup', e => { if (pointer === e.pointerId) { pointer = undefined; if (point(e)) fire(); } });
canvas.addEventListener('lostpointercapture', e => { if (pointer === e.pointerId) pointer = undefined; });

const leftKeys = ['ArrowLeft', 'KeyA'], rightKeys = ['ArrowRight', 'KeyD'];
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' && !e.repeat) {
    if (panel === 'result') home(); else if (panel) close(); else pause();
  } else if (panel && e.code === 'Tab') {
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.includes(document.activeElement as HTMLButtonElement) || document.activeElement === (e.shiftKey ? buttons[0] : buttons[buttons.length - 1])) {
      e.preventDefault(); (e.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus();
    }
  } else if (game && !panel) {
    if (leftKeys.includes(e.code) || rightKeys.includes(e.code)) {
      e.preventDefault(); aimKeys.add(e.code);
      if (!e.repeat && ready()) aimAt(angle + (leftKeys.includes(e.code) ? -.025 : .025));
    } else if (e.code === 'Space' && !(document.activeElement instanceof HTMLButtonElement)) { e.preventDefault(); if (!e.repeat) fire(); }
    else if (e.code === 'KeyX' && !e.repeat) swap();
  }
});
window.addEventListener('keyup', e => aimKeys.delete(e.code));
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

get('home').onclick = home;
get('start').onclick = () => { audioOn(); start(Math.min(save.best.length, LEVELS.length - 1)); };
get('levels').onclick = () => levels();
get('help').onclick = help;
soundButton.onclick = () => { save.muted = !save.muted; labels(); writeSave(save); audioOn(); if (!save.muted) sound([580]); };
symbolsButton.onclick = () => { save.symbols = !save.symbols; labels(); writeSave(save); hud(); };
pauseButton.onclick = pause;
swapButton.onclick = swap;
shootButton.onclick = fire;
dialog.onclick = e => {
  const target = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
  if (!target || target.disabled) return;
  audioOn();
  const id = target.dataset.action!;
  if (id === 'back') close();
  else if (id === 'home') home();
  else if (id === 'retry' && game) start(game.index);
  else if (id === 'next-level' && game) start(game.index + 1);
  else if (id === 'level-select') { const chapter = game?.level.chapter; home(); levels(chapter); }
  else if (id === 'prev-chapter' && chosenChapter > 0) levels(chosenChapter - 1);
  else if (id === 'next-chapter' && chosenChapter + 1 < CHAPTERS.length) levels(chosenChapter + 1);
  else if (id.startsWith('level-')) {
    const index = Number(id.slice(6)); if (Number.isInteger(index)) start(index);
  }
};

function frame(now: number) {
  const dt = Math.max(0, Math.min(.06, (now - last) / 1000));
  last = now;
  if (game) {
    if (!panel) {
      nextShot -= dt;
      if (messageTimeout > 0 && (messageTimeout -= dt) <= 0) callout.hidden = true;
      if (flight) {
        flight.distance += dt * 1160;
        if (travel(flight.aim.points, flight.distance).done) {
          const result = game.resolve(flight.aim); flight = undefined;
          if (result) settled(result);
        }
      } else if (ready() && aimKeys.size) {
        const direction = Number(rightKeys.some(key => aimKeys.has(key))) - Number(leftKeys.some(key => aimKeys.has(key)));
        if (direction) aimAt(angle + direction * dt * 1.5);
      }
      if (game.status !== 'playing' && (finish += dt) >= .54) results();
    }
    renderer.draw(game, nextShot <= 0 ? path : undefined, flight, panel ? 0 : dt, save.symbols);
  }
  requestAnimationFrame(frame);
}

home(); labels(); postcard(get<HTMLCanvasElement>('postcard'));
requestAnimationFrame(frame);
