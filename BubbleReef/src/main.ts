import { BubbleAudio } from './audio';
import { Game, type Aim, type Mode, type Result } from './game';
import { ANGLE_LIMIT, CHAPTERS, HEIGHT, LEVELS, ORIGIN, PALETTE, WIDTH } from './levels';
import { Renderer, postcard, travel, type Flight } from './render';
import { TRAY } from './scenery';
import { readSave, writeSave } from './save';

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const screen = get('shell'), canvas = get<HTMLCanvasElement>('board');
const renderer = new Renderer(canvas), save = readSave();
const menu = get('menu'), play = get('play'), overlay = get('overlay'), dialog = get('dialog');
const soundButton = get('sound'), symbolsButton = get('symbols'), pauseButton = get<HTMLButtonElement>('pause');
const shootButton = get<HTMLButtonElement>('shoot'), endlessButton = get<HTMLButtonElement>('endless');
const slots = [...document.querySelectorAll<HTMLButtonElement>('.bubble-slot')];
const pressure = get('pressure'), remaining = get('remaining'), score = get('score'), callout = get('callout');
const missesLeft = get('misses-left'), rowMeter = get('row-meter'), rowFill = rowMeter.querySelector('i')!;
let game: Game | undefined, flight: Flight | undefined, path: Aim | undefined;
let angle = 0, chosenChapter = 0, pointer: number | undefined, panel = '';
let last = performance.now(), nextShot = 0, messageTimeout = 0, finish = 0;
let oldFocus: HTMLElement | undefined;
const audio = new BubbleAudio(save.muted);
const aimKeys = new Set<string>();
const format = (n: number) => String(n).padStart(2, '0');
const action = (id: string, label: string, primary = false) => `<button type="button" data-action="${id}" class="${primary ? 'primary' : 'quiet'}">${label}</button>`;

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
  audio.reset();
  saveEndless();
  game = undefined; flight = undefined; pointer = undefined; aimKeys.clear();
  play.hidden = true; menu.hidden = false; close(false);
  get('start').innerHTML = `${save.best.length >= LEVELS.length ? 'Replay level 100' : `Play level ${format(save.best.length + 1)}`} <span aria-hidden="true">→</span>`;
  endlessButton.innerHTML = `Endless <span aria-hidden="true">∞</span>${save.endlessBest ? `<small>Best ${save.endlessBest.toLocaleString('en-US')}</small>` : ''}`;
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
  modal('help', 'How to play', `<p>Aim and release to shoot. Match three or more bubbles of one color and knock loose anything below them. Bank shots off the walls to reach around groups.</p><p>The top bubble in the triangle is loaded. Tap a lower bubble to load it. Right-click or press X to rotate all three.</p><p>In Endless, new rows arrive on a timer. In Campaign, misses push the ceiling down. In both modes you lose if a bubble reaches the dashed line.</p><p>On a keyboard, hold ← or → to aim and press Space to shoot. Press Esc to pause.</p><nav>${action('back', 'Back', true)}</nav>`);
}

function hud() {
  if (!game) return;
  score.textContent = game.score.toLocaleString('en-US');
  const endless = game.mode === 'endless';
  remaining.textContent = String(endless ? game.waves : game.left);
  if (!endless) {
    missesLeft.textContent = `${game.chances} misses before the ceiling drops`;
    pressure.innerHTML = Array.from({ length: game.level.tension }, (_, i) => `<i class="${i >= game!.chances ? 'empty' : game!.chances === 1 ? 'last' : ''}"></i>`).join('');
  }
  const disabled = !!flight || game.status !== 'playing';
  const colors = [game.current, game.next, game.reserve];
  slots.forEach((button, index) => {
    const color = PALETTE[colors[index] - 1].name;
    button.setAttribute('aria-label', index === 0 ? `${color} loaded. Rotate bubbles` : `Load ${color}, reserve ${index}`);
    button.disabled = disabled;
  });
  shootButton.disabled = disabled;
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

function start(index: number, mode: Mode = 'campaign') {
  if (index < 0 || index >= LEVELS.length || index > save.best.length) return;
  audio.reset();
  audio.unlock();
  game = new Game(index, mode, mode === 'endless' ? Date.now() : undefined);
  flight = undefined; path = undefined; pointer = undefined; aimKeys.clear();
  nextShot = finish = messageTimeout = 0;
  close(false); menu.hidden = true; play.hidden = false; callout.hidden = true;
  renderer.reset();
  const endless = mode === 'endless';
  get('chapter').textContent = endless ? 'SURVIVAL' : CHAPTERS[game.level.chapter][0];
  get('level-title').textContent = endless ? 'Endless' : `Level ${format(index + 1)} / ${LEVELS.length}`;
  get('count-label').textContent = endless ? 'ROWS' : 'BUBBLES';
  get('pressure-label').textContent = endless ? 'NEXT ROW' : 'MISSES BEFORE DROP';
  pressure.hidden = endless;
  rowMeter.hidden = !endless;
  if (endless) {
    rowFill.style.width = '100%'; missesLeft.textContent = '';
    message('Keep the bubbles above the line.', 3);
  } else if (index === 0) message('Match three. Aim and release to shoot.', 3);
  aimAt(0); hud();
  canvas.focus({ preventScroll: true });
}

function ready() { return game?.status === 'playing' && !panel && !flight && nextShot <= 0; }

function fire() {
  if (!game || !path || !ready()) return;
  audio.unlock(); audio.play('launch'); callout.hidden = true;
  flight = { aim: path, color: game.current, distance: 0 };
  hud();
}

function swap(pick?: 1 | 2) {
  if (!game || !ready()) return;
  audio.unlock(); game.swap(pick); renderer.pushBubble(pick); audio.play('swap'); hud();
}

function settled(result: Result) {
  renderer.pop(result, game?.stagger ?? 0);
  renderer.pushBubble(1);
  saveEndless();
  const dropped = result.removed.filter(bubble => bubble.falling).length;
  audio.landed(result.removed.length - dropped, dropped, result.newDrop > result.oldDrop);
  if (result.removed.length >= 8 && game?.status === 'playing') message(`${result.removed.length} bubbles cleared`, .8);
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
    audio.play('clear');
    modal('result', game.level.number === LEVELS.length ? 'Reef complete!' : 'Level clear!', `<p class="stars" aria-label="${game.stars} of 3 stars">${'★'.repeat(game.stars)}${'☆'.repeat(3 - game.stars)}</p><p>${game.score.toLocaleString('en-US')} points · ${game.shots} shots</p><nav>${game.level.number < LEVELS.length ? action('next-level', 'Next level', true) : ''}${action('retry', 'Replay')}${action('level-select', 'Level select')}${action('home', 'Main menu')}</nav>`);
  } else if (game.mode === 'endless') {
    saveEndless();
    audio.play('lose');
    modal('result', 'Line reached', `<p>${game.score.toLocaleString('en-US')} points · ${game.waves} rows survived</p><p>Best ${save.endlessBest.toLocaleString('en-US')}</p><nav>${action('retry', 'Play Endless again', true)}${action('home', 'Main menu')}</nav>`);
  } else {
    audio.play('lose');
    modal('result', 'Reef overflowed', `<p>${game.left} bubbles left · ${game.score.toLocaleString('en-US')} points</p><nav>${action('retry', 'Try again', true)}${action('level-select', 'Level select')}${action('home', 'Main menu')}</nav>`);
  }
}

function saveEndless() {
  if (!game || game.mode !== 'endless' || game.score <= save.endlessBest) return;
  save.endlessBest = game.score;
  writeSave(save);
}

function pause() {
  if (!game || game.status !== 'playing' || panel) return;
  audio.stop();
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
  e.preventDefault(); audio.unlock(); pointer = e.pointerId; canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => { if (ready() && (pointer === e.pointerId || (pointer === undefined && e.pointerType === 'mouse'))) point(e); });
canvas.addEventListener('pointerup', e => { if (pointer === e.pointerId) { pointer = undefined; if (point(e)) fire(); } });
canvas.addEventListener('lostpointercapture', e => { if (pointer === e.pointerId) pointer = undefined; });
get('arena').addEventListener('contextmenu', e => { e.preventDefault(); swap(); });
slots.forEach((button, index) => {
  button.style.left = `${TRAY[index].x / WIDTH * 100}%`;
  button.style.top = `${TRAY[index].y / HEIGHT * 100}%`;
  button.onclick = () => { swap(index === 1 || index === 2 ? index : undefined); canvas.focus({ preventScroll: true }); };
});

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
get('start').onclick = () => start(Math.min(save.best.length, LEVELS.length - 1));
endlessButton.onclick = () => start(0, 'endless');
get('levels').onclick = () => levels();
get('help').onclick = help;
soundButton.onclick = () => { save.muted = !save.muted; labels(); writeSave(save); audio.setMuted(save.muted); if (!save.muted) audio.play('swap'); };
symbolsButton.onclick = () => { save.symbols = !save.symbols; labels(); writeSave(save); hud(); };
pauseButton.onclick = pause;
shootButton.onclick = fire;
dialog.onclick = e => {
  const target = (e.target as Element).closest<HTMLButtonElement>('button[data-action]');
  if (!target || target.disabled) return;
  const id = target.dataset.action!;
  if (id === 'back') close();
  else if (id === 'home') home();
  else if (id === 'retry' && game) start(game.index, game.mode);
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
      if (game.mode === 'endless' && game.status === 'playing') {
        if (game.advance(dt, !flight)) {
          renderer.rowArrived();
          path = game.trace(angle);
          nextShot = Math.max(nextShot, .26);
          audio.play('row');
          hud();
        }
        rowFill.style.width = `${100 * game.untilRow / game.rowInterval}%`;
      }
      if (game.status !== 'playing' && (finish += dt) >= .54) results();
    }
    renderer.draw(game, nextShot <= 0 ? path : undefined, flight, panel ? 0 : dt, save.symbols);
  }
  requestAnimationFrame(frame);
}

home(); labels(); postcard(get<HTMLCanvasElement>('postcard'));
requestAnimationFrame(frame);
