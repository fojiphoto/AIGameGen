import { cover } from './cover';
import { Match, STEP } from './game';
import { MASCOTS, STAGES, WORLDS, type Direction, type Mode } from './levels';
import { mascot } from './mascots';
import { Renderer } from './render';
import { loadSave, saveStats, skinUnlocked } from './save';

function el<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
const board = el<HTMLCanvasElement>('board');
const renderer = new Renderer(board);
const save = loadSave();
const ui = {
  menu: el('menu'), play: el('play'), overlay: el('overlay'), dialog: el('dialog'), sound: el('sound'), home: el('home'),
  pause: el<HTMLButtonElement>('pause'), cover: el<HTMLCanvasElement>('cover'), skinName: el('skin-name'), record: el('record'),
  stage: el('stage-name'), mode: el('mode-label'), share: el('share'), peak: el('peak'), cuts: el('cuts'),
  target: el('target'), meter: el('meter'), ranks: el('ranks'), cue: el('cue'),
};
if (!skinUnlocked(MASCOTS[save.skin].unlock, save)) save.skin = 0;
let match: Match | undefined;
let panel = '';
let waiting = false;
let clock = 0, last = performance.now(), acc = 0, timeToResult = 0;
let rankHtml = '';
let savedFocus: HTMLElement | null = null;
let sound: AudioContext | undefined;
let runPeak = 0, runCuts = 0;

const percent = (value: number) => `${value.toFixed(1)}%`;
const text = (where: HTMLElement, value: string) => { if (where.textContent !== value) where.textContent = value; };
const action = (id: string, label: string) => `<button type="button" class="action" data-action="${id}">${label}</button>`;

function enableSound() {
  if (save.muted) return;
  try { sound ??= new AudioContext(); if (sound.state === 'suspended') void sound.resume().catch(() => {}); } catch { /* Audio is optional. */ }
}

function beep(kind: 'claim' | 'cut' | 'clear' | 'tap', count = 0) {
  if (!sound || sound.state !== 'running' || save.muted) return;
  const notes = kind === 'cut' ? [330, 170] : kind === 'clear' ? [523, 660, 784, 1047] : kind === 'claim' ? [470 + Math.min(count, 100), 710 + Math.min(count * 2, 220)] : [530];
  for (const [i, note] of notes.entries()) {
    const o = sound.createOscillator(), g = sound.createGain(), at = sound.currentTime + i * .075;
    o.type = 'triangle'; o.frequency.value = note;
    g.gain.setValueAtTime(.001, at); g.gain.linearRampToValueAtTime(.08, at + .009); g.gain.exponentialRampToValueAtTime(.001, at + .13);
    o.connect(g).connect(sound.destination); o.start(at); o.stop(at + .14);
  }
}

function soundLabel() { text(ui.sound, save.muted ? 'Sound off' : 'Sound on'); ui.sound.setAttribute('aria-pressed', String(save.muted)); }
function persistEndless() {
  if (match?.mode !== 'endless') return;
  save.peak = Math.max(save.peak, runPeak, match.peak);
  save.islands = Math.max(save.islands, match.cycle + Number(match.outcome === 'island'));
  saveStats(save);
}

function show(id: string, title: string, body: string) {
  if (ui.overlay.hidden) savedFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  panel = id;
  acc = 0;
  ui.overlay.hidden = false;
  document.querySelector('main')!.inert = true;
  ui.dialog.innerHTML = `<h2 id="dialog-title" tabindex="-1">${title}</h2>${body}`;
  ui.dialog.querySelector<HTMLElement>('h2')!.focus();
}

function close() {
  panel = '';
  acc = 0;
  ui.overlay.hidden = true;
  document.querySelector('main')!.inert = false;
  if (savedFocus?.isConnected) savedFocus.focus();
  savedFocus = null;
}

function home() {
  persistEndless();
  match = undefined;
  close();
  ui.play.hidden = true;
  ui.menu.hidden = false;
  cover(ui.cover, save.skin);
  text(ui.skinName, MASCOTS[save.skin].name);
  text(ui.record, save.peak ? `Best ${percent(save.peak)}` : 'Beat your best');
}

function campaign() {
  const levels = WORLDS.map((world, group) => `<div><h3>${world.name}</h3><div class="stage-row">${STAGES.slice(group * 5, group * 5 + 5).map((stage, i) => {
    const index = group * 5 + i;
    const status = index > save.unlocked ? 'Locked' : index < save.cleared ? 'Clear' : `${stage.goal}%`;
    return `<button class="level ${index === save.unlocked ? 'current' : ''}" data-action="level-${index}" aria-label="Level ${index + 1} ${stage.name}, ${status}" ${index > save.unlocked ? 'disabled' : ''}>${index + 1}<small>${status}</small></button>`;
  }).join('')}</div></div>`).join('');
  show('campaign', 'Campaign', `<p>Claim the target share to unlock the next stage.</p><div class="stages">${levels}</div><nav>${action('back', 'Back')}</nav>`);
}

function skins() {
  show('skins', 'Pick a mascot', `<div class="wardrobe">${MASCOTS.map((skin, i) => `<button class="skin" data-action="skin-${i}" aria-pressed="${i === save.skin}" ${skinUnlocked(skin.unlock, save) ? '' : 'disabled'}><canvas data-skin="${i}" width="106" height="92" aria-hidden="true"></canvas>${skin.name}<small>${skinUnlocked(skin.unlock, save) ? (i === save.skin ? 'Selected' : 'Equip') : `Stage ${skin.unlock} or ${skin.unlock * 5}%`}</small></button>`).join('')}</div><p>Unlock mascots by clearing campaign stages or raising your Endless record.</p><nav>${action('back', 'Back')}</nav>`);
  for (const canvas of ui.dialog.querySelectorAll<HTMLCanvasElement>('canvas[data-skin]')) mascot(canvas.getContext('2d')!, Number(canvas.dataset.skin), 53, 51, 82);
}

function help() {
  show('help', 'How to play', `<p>Steer with arrow keys, WASD, the direction buttons, or a drag across the arena.</p><p>Leave your patch to draw a ribbon. Reconnect to your own color to claim the smaller area you enclose. Cross a rival's exposed ribbon to knock them out.</p><p>Your ribbon can be cut too. Avoid crossing it yourself, and turn before hitting arena edges or bumpers.</p><p>Campaign stages unlock on a clear. Endless keeps going until you crash or a rival cuts you. Capture an entire arena to move on to the next island.</p><nav>${action('back', 'Back')}</nav>`);
}

function start(mode: Mode, index = 0, cycle = 0) {
  if (cycle === 0) runPeak = runCuts = 0;
  match = new Match(mode, index, save.skin, cycle);
  close();
  ui.menu.hidden = true;
  ui.play.hidden = false;
  ui.pause.disabled = false;
  waiting = true;
  timeToResult = 0;
  rankHtml = '';
  text(ui.stage, mode === 'endless' ? WORLDS[match.stage.world].name : match.stage.name);
  text(ui.mode, mode === 'endless' ? `ENDLESS · ISLAND ${cycle + 1}` : `CAMPAIGN · STAGE ${index + 1} / ${STAGES.length}`);
  text(ui.target, mode === 'campaign' ? `Goal ${match.stage.goal}%` : 'Fill the arena');
  text(ui.cue, 'Steer to start');
  ui.cue.hidden = false;
  ui.meter.style.background = MASCOTS[save.skin].ink;
  updateHud();
}

function updateHud() {
  if (!match) return;
  const game = match;
  text(ui.share, percent(game.share()));
  text(ui.peak, percent(Math.max(runPeak, game.peak)));
  text(ui.cuts, String(runCuts + game.cuts));
  ui.meter.style.width = `${Math.min(100, game.share() / game.stage.goal * 100)}%`;
  const rank = game.riders.filter(r => r.alive).sort((a, b) => b.area - a.area).map(r => `<li><span><i style="background:${MASCOTS[r.skin].ink}"></i>${r.name}</span><strong style="font-size:inherit;letter-spacing:normal">${percent(game.share(r))}</strong></li>`).join('');
  if (rank !== rankHtml) { ui.ranks.innerHTML = rank; rankHtml = rank; }
}

function steer(dir: Direction) {
  if (!match || panel || match.outcome !== 'playing') return;
  enableSound();
  match.steer(dir);
  if (!waiting) return;
  waiting = false;
  ui.cue.hidden = true;
  acc = 0;
}

function pause() {
  if (!match || panel || match.outcome !== 'playing') return;
  persistEndless();
  show('pause', 'Paused', `<nav>${action('back', 'Resume')}${action('retry', 'Restart')}${action('home', 'Main menu')}</nav>`);
}

function results() {
  const game = match!;
  if (game.outcome === 'cleared') {
    save.cleared = Math.max(save.cleared, game.level + 1);
    save.unlocked = Math.min(STAGES.length - 1, save.cleared);
    saveStats(save);
  } else persistEndless();
  const next = game.outcome === 'cleared' && game.level < STAGES.length - 1;
  const island = game.outcome === 'island';
  const won = game.outcome !== 'lost';
  const title = island ? 'Island captured!' : next ? 'Stage clear!' : won ? 'Campaign complete!' : 'Ribbon broken!';
  show('result', title, `<p>${won ? `${percent(game.share())} claimed.` : game.reason} Peak ${percent(Math.max(game.peak, runPeak))} · ${game.cuts + runCuts} rival cuts.</p><nav>${island ? action('island', 'Next island') : next ? action('next', 'Next stage') : ''}${action('retry', 'Play again')}${game.mode === 'campaign' ? action('campaign', 'Stage select') : ''}${action('home', 'Main menu')}</nav>`);
}

ui.home.onclick = home;
ui.sound.onclick = () => { save.muted = !save.muted; soundLabel(); enableSound(); saveStats(save); };
el('campaign').onclick = campaign;
el('endless').onclick = () => start('endless');
el('skins').onclick = skins;
el('help').onclick = help;
ui.pause.onclick = pause;

ui.dialog.addEventListener('click', e => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button || button.disabled) return;
  enableSound(); beep('tap');
  const name = button.dataset.action!;
  if (name === 'back') close();
  else if (name === 'home') home();
  else if (name === 'campaign') { home(); campaign(); }
  else if (name === 'retry' && match) start(match.mode, match.level);
  else if (name === 'next' && match) start('campaign', match.level + 1);
  else if (name === 'island' && match) {
    runPeak = Math.max(runPeak, match.peak);
    runCuts += match.cuts;
    start('endless', 0, match.cycle + 1);
  } else if (name.startsWith('level-')) {
    const index = Number(name.slice(6));
    if (Number.isInteger(index) && index >= 0 && index <= save.unlocked) start('campaign', index);
  } else if (name.startsWith('skin-')) {
    const index = Number(name.slice(5));
    if (MASCOTS[index] && skinUnlocked(MASCOTS[index].unlock, save)) { save.skin = index; saveStats(save); cover(ui.cover, index); text(ui.skinName, MASCOTS[index].name); skins(); }
  }
});

const keys: Partial<Record<string, Direction>> = { ArrowRight: 0, KeyD: 0, ArrowDown: 1, KeyS: 1, ArrowLeft: 2, KeyA: 2, ArrowUp: 3, KeyW: 3 };
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' && !e.repeat) {
    if (panel === 'result') home();
    else if (panel) close();
    else pause();
  } else if (panel && e.code === 'Tab') {
    const buttons = [...ui.dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const edge = e.shiftKey ? buttons[0] : buttons.at(-1);
    if (document.activeElement === edge || !buttons.includes(document.activeElement as HTMLButtonElement)) {
      e.preventDefault();
      (e.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
    }
  } else if (match && !panel && keys[e.code] !== undefined) { e.preventDefault(); steer(keys[e.code]!); }
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-dir]')) {
  const dir = Number(button.dataset.dir) as Direction;
  button.addEventListener('pointerdown', e => { e.preventDefault(); steer(dir); });
  button.onclick = () => steer(dir);
}

let drag: { id: number; x: number; y: number } | undefined;
board.addEventListener('pointerdown', e => {
  if (panel || !match || drag) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  board.setPointerCapture(e.pointerId);
});
board.addEventListener('pointermove', e => {
  if (drag?.id !== e.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 11) return;
  steer(Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3));
  drag.x = e.clientX;
  drag.y = e.clientY;
});
board.addEventListener('lostpointercapture', e => { if (drag?.id === e.pointerId) drag = undefined; });
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('pagehide', persistEndless);

function frame(now: number) {
  const dt = Math.max(0, Math.min(.15, (now - last) / 1000));
  last = now;
  if (match) {
    if (!panel) clock += dt;
    if (!panel && !waiting && match.outcome === 'playing') {
      acc += dt;
      while (acc >= STEP && match.outcome === 'playing') { match.tick(); acc -= STEP; }
      for (const event of match.effects.splice(0)) {
        renderer.effect(event);
        if (event.type !== 'claim' || event.skin === save.skin) beep(event.type, event.count);
      }
      updateHud();
    }
    if (!panel && match.outcome !== 'playing') {
      timeToResult += dt;
      ui.pause.disabled = true;
      if (timeToResult > .65) results();
    }
    renderer.draw(match, match.outcome !== 'playing' ? 1 : Math.min(1, acc / STEP), clock, panel ? 0 : dt);
  }
  requestAnimationFrame(frame);
}

home();
soundLabel();
requestAnimationFrame(frame);
