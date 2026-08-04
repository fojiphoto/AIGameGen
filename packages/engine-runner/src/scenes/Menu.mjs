/**
 * Title + 20-level select grid + endless entry.
 * One scene rather than two — a level grid this small doesn't justify a
 * separate scene, and it keeps transitions instant on low-end devices.
 */

import Phaser from 'phaser';
import { VIEW_W, VIEW_H, FONT_DISPLAY, FONT_BODY } from '../constants.mjs';
import { asInt, shade } from '../textures.mjs';
import { sfx, unlock as unlockAudio, setMuted, isMuted } from '../audio.mjs';
import * as save from '../save.mjs';

export default class Menu extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    const cfg = this.registry.get('cfg');
    const pal = cfg.theme.palette;
    this.cameras.main.setBackgroundColor(pal.bg);

    // Decorative ground strip so the menu shares the game's identity. Board genres have
    // no world/ground, so this is conditional rather than assumed.
    if (cfg.world?.groundHeight && this.textures.exists('ground')) {
      this.add
        .tileSprite(0, VIEW_H, VIEW_W, cfg.world.groundHeight * 0.7, 'ground')
        .setOrigin(0, 1)
        .setAlpha(0.5);
    } else {
      const g = this.add.graphics();
      g.fillStyle(asInt(pal.bgAccent), 0.45);
      g.fillRect(0, VIEW_H - 54, VIEW_W, 54);
    }

    this.add
      .text(VIEW_W / 2, 52, cfg.meta.title.toUpperCase(), {
        fontFamily: FONT_DISPLAY,
        fontSize: '46px',
        color: pal.text,
      })
      .setOrigin(0.5);

    if (cfg.meta.tagline) {
      this.add
        .text(VIEW_W / 2, 92, cfg.meta.tagline.toUpperCase(), {
          fontFamily: FONT_BODY,
          fontSize: '13px',
          color: pal.accent,
        })
        .setOrigin(0.5)
        .setAlpha(0.85);
    }

    const s = save.getSave();
    this.add
      .text(VIEW_W / 2, 116, `${save.totalStars()} / 60 STARS   ·   BEST LEVEL ${s.bestLevel}`, {
        fontFamily: FONT_BODY,
        fontSize: '12px',
        color: pal.text,
      })
      .setOrigin(0.5)
      .setAlpha(0.5);

    this.drawGrid(cfg, pal);
    this.drawEndless(cfg, pal, s);
    this.drawMute(pal);

    this.input.once('pointerdown', () => unlockAudio());
  }

  drawGrid(cfg, pal) {
    const cols = 10;
    const cell = 62;
    const gapX = 10;
    const gapY = 12;
    const totalW = cols * cell + (cols - 1) * gapX;
    const startX = (VIEW_W - totalW) / 2;
    const startY = 152;

    for (let i = 0; i < 20; i++) {
      const lv = i + 1;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = startX + col * (cell + gapX);
      const y = startY + row * (cell + gapY);

      const unlocked = save.isUnlocked(lv);
      const stars = save.getSave().stars[lv] ?? 0;
      const isNext = unlocked && stars === 0 && lv === save.highestUnlocked();

      const g = this.add.graphics();
      g.fillStyle(unlocked ? asInt(pal.bgAccent) : shade(pal.bg, 0.06), 1);
      g.fillRoundedRect(x, y, cell, cell, 12);
      if (isNext) {
        g.lineStyle(3, asInt(pal.accent), 1);
        g.strokeRoundedRect(x, y, cell, cell, 12);
      } else if (unlocked) {
        g.lineStyle(1, asInt(pal.ground), 1);
        g.strokeRoundedRect(x, y, cell, cell, 12);
      }

      this.add
        .text(x + cell / 2, y + cell / 2 - 8, unlocked ? String(lv) : '·', {
          fontFamily: FONT_DISPLAY,
          fontSize: unlocked ? '22px' : '20px',
          color: unlocked ? pal.text : pal.ground,
        })
        .setOrigin(0.5);

      if (unlocked) {
        this.add
          .text(x + cell / 2, y + cell - 15, '★'.repeat(stars) + '☆'.repeat(3 - stars), {
            fontFamily: FONT_BODY,
            fontSize: '10px',
            color: stars > 0 ? pal.accent : pal.ground,
          })
          .setOrigin(0.5);

        const hit = this.add
          .zone(x, y, cell, cell)
          .setOrigin(0, 0)
          .setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => {
          unlockAudio();
          sfx.select();
          save.recordRun();
          this.scene.start('Play', { mode: 'level', level: lv });
        });
      }
    }
  }

  drawEndless(cfg, pal, s) {
    const y = VIEW_H - 62;
    // Only the runner has an endless mode; other genres are level-based only.
    if (cfg.progression?.mode !== 'hybrid' && cfg.progression?.mode !== 'endless_only') {
      const cleared = s.bestLevel >= cfg.progression.levels;
      this.add
        .text(VIEW_W / 2, y, cleared ? 'ALL LEVELS CLEAR — REPLAY ANY LEVEL' : `${s.bestLevel} / ${cfg.progression.levels} LEVELS CLEARED`, {
          fontFamily: FONT_BODY, fontSize: '13px', color: cleared ? pal.accent : pal.text,
        })
        .setOrigin(0.5)
        .setAlpha(cleared ? 0.9 : 0.45);
      return;
    }
    if (s.endlessUnlocked) {
      const t = this.add
        .text(VIEW_W / 2, y, `ENDLESS MODE   ·   BEST ${s.endlessBest} M`, {
          fontFamily: FONT_DISPLAY,
          fontSize: '18px',
          color: pal.bg,
          backgroundColor: pal.accent,
          padding: { x: 24, y: 11 },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      t.on('pointerdown', () => {
        unlockAudio();
        sfx.select();
        this.scene.start('Play', { mode: 'endless' });
      });
    } else {
      this.add
        .text(VIEW_W / 2, y, `CLEAR LEVEL ${cfg.progression.endlessUnlockAt} TO UNLOCK ENDLESS MODE`, {
          fontFamily: FONT_BODY,
          fontSize: '13px',
          color: pal.text,
        })
        .setOrigin(0.5)
        .setAlpha(0.45);
    }
  }

  drawMute(pal) {
    const btn = this.add
      .text(VIEW_W - 16, 16, isMuted() ? 'SOUND OFF' : 'SOUND ON', {
        fontFamily: FONT_BODY,
        fontSize: '11px',
        color: pal.text,
        backgroundColor: 'rgba(0,0,0,0.25)',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(1, 0)
      .setAlpha(0.7)
      .setInteractive({ useHandCursor: true });

    btn.on('pointerdown', () => {
      unlockAudio();
      const next = !isMuted();
      setMuted(next);
      save.setSavedMuted(next);
      btn.setText(next ? 'SOUND OFF' : 'SOUND ON');
    });
  }
}
