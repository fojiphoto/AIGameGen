/**
 * Scene furniture shared by every genre: HUD strip, pause overlay, countdown, buttons.
 *
 * Extracted so a new genre only has to implement its actual gameplay. The runner predates
 * this file and keeps its own inline copies rather than being refactored — it is the
 * APK-verified genre and churning it to save duplication is a bad trade.
 */

import { VIEW_W, VIEW_H, FONT_DISPLAY, FONT_BODY } from '../constants.mjs';
import { asInt } from '../textures.mjs';
import { sfx, unlock as unlockAudio } from '../audio.mjs';

export function hudBar(scene, title, pal, { showProgress = true } = {}) {
  const bar = scene.add.graphics().setDepth(50);
  const left = scene.add
    .text(18, 14, String(title).toUpperCase(), { fontFamily: FONT_DISPLAY, fontSize: '18px', color: pal.text })
    .setDepth(51);
  const right = scene.add
    .text(VIEW_W - 18, 14, '', { fontFamily: FONT_BODY, fontSize: '17px', color: pal.accent })
    .setOrigin(1, 0)
    .setDepth(51);

  const pause = scene.add
    .text(VIEW_W - 18, VIEW_H - 16, 'II', {
      fontFamily: FONT_DISPLAY, fontSize: '20px', color: pal.text,
      backgroundColor: 'rgba(0,0,0,0.28)', padding: { x: 10, y: 4 },
    })
    .setOrigin(1, 1)
    .setDepth(51)
    .setInteractive({ useHandCursor: true });
  pause.on('pointerdown', (p, x, y, e) => {
    e?.stopPropagation?.();
    scene.togglePause?.();
  });

  const accent = asInt(pal.accent);
  return {
    setLeft: (t) => left.setText(String(t).toUpperCase()),
    setRight: (t) => right.setText(String(t)),
    setProgress(pct) {
      if (!showProgress) return;
      bar.clear();
      bar.fillStyle(0x000000, 0.35);
      bar.fillRect(18, 44, VIEW_W - 36, 7);
      bar.fillStyle(accent, 1);
      bar.fillRect(18, 44, (VIEW_W - 36) * Math.max(0, Math.min(1, pct)), 7);
    },
  };
}

export function mkButton(scene, x, y, label, pal, onClick, { primary = true } = {}) {
  const t = scene.add
    .text(x, y, label, {
      fontFamily: primary ? FONT_DISPLAY : FONT_BODY,
      fontSize: primary ? '20px' : '17px',
      color: primary ? pal.bg : pal.text,
      backgroundColor: primary ? pal.accent : 'rgba(255,255,255,0.09)',
      padding: { x: 26, y: 12 },
    })
    .setOrigin(0.5)
    .setInteractive({ useHandCursor: true });
  t.on('pointerdown', (p, lx, ly, e) => {
    e?.stopPropagation?.();
    unlockAudio();
    sfx.select();
    onClick();
  });
  t.on('pointerover', () => t.setAlpha(0.86));
  t.on('pointerout', () => t.setAlpha(1));
  return t;
}

export function pauseOverlay(scene, pal, onResume) {
  const c = scene.add.container(0, 0).setDepth(70);
  const bg = scene.add.graphics();
  bg.fillStyle(0x000000, 0.72);
  bg.fillRect(0, 0, VIEW_W, VIEW_H);
  const label = scene.add
    .text(VIEW_W / 2, VIEW_H / 2 - 44, 'PAUSED', { fontFamily: FONT_DISPLAY, fontSize: '42px', color: pal.text })
    .setOrigin(0.5);
  c.add([
    bg,
    label,
    mkButton(scene, VIEW_W / 2, VIEW_H / 2 + 24, 'RESUME', pal, onResume),
    mkButton(scene, VIEW_W / 2, VIEW_H / 2 + 88, 'QUIT TO MENU', pal, () => scene.scene.start('Menu'), { primary: false }),
  ]);
  return c;
}

/**
 * 3-2-1-GO gate. Board genres skip it (there is nothing moving to be surprised by) but
 * anything with a scroll or a clock needs the player oriented before it starts.
 */
export function countdown(scene, pal, onGo) {
  const t = scene.add
    .text(VIEW_W / 2, VIEW_H / 2 - 30, '3', { fontFamily: FONT_DISPLAY, fontSize: '68px', color: pal.accent })
    .setOrigin(0.5)
    .setDepth(60);
  const steps = ['3', '2', '1', 'GO'];
  let i = 0;
  scene.time.addEvent({
    delay: 420,
    repeat: 3,
    callback: () => {
      i++;
      if (i < steps.length) {
        t.setText(steps[i]);
        t.setScale(1.3);
        scene.tweens.add({ targets: t, scale: 1, duration: 200 });
        sfx.select();
      }
      if (i === steps.length - 1) {
        onGo();
        scene.time.delayedCall(300, () => t.destroy());
      }
    },
  });
  return t;
}

/** Centred board geometry that fits the viewport with a HUD strip reserved at the top. */
export function boardLayout(cols, rows, { top = 74, bottom = 22, gap = 8, maxCell = 96 } = {}) {
  const availW = VIEW_W - 48;
  const availH = VIEW_H - top - bottom;
  const cell = Math.min(maxCell, Math.floor(Math.min((availW - gap * (cols - 1)) / cols, (availH - gap * (rows - 1)) / rows)));
  const w = cols * cell + gap * (cols - 1);
  const h = rows * cell + gap * (rows - 1);
  return {
    cell, gap, w, h,
    x: Math.round((VIEW_W - w) / 2),
    y: Math.round(top + (availH - h) / 2),
    cx: (c) => Math.round((VIEW_W - w) / 2 + c * (cell + gap)),
    cy: (r) => Math.round(top + (availH - h) / 2 + r * (cell + gap)),
  };
}
