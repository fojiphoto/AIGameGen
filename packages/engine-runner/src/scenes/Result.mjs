import Phaser from 'phaser';
import { VIEW_W, VIEW_H, FONT_DISPLAY, FONT_BODY } from '../constants.mjs';
import { asInt } from '../textures.mjs';
import { sfx } from '../audio.mjs';
import * as save from '../save.mjs';

export default class Result extends Phaser.Scene {
  constructor() {
    super('Result');
  }

  init(data) {
    this.data_ = data;
  }

  create() {
    const cfg = this.registry.get('cfg');
    const pal = cfg.theme.palette;
    const d = this.data_;
    this.cameras.main.setBackgroundColor(pal.bg);

    const win = d.outcome === 'win';
    const headline = win ? cfg.copy.winMsg : cfg.copy.loseMsg;

    this.add
      .text(VIEW_W / 2, 118, headline.toUpperCase(), {
        fontFamily: FONT_DISPLAY,
        fontSize: '52px',
        color: win ? pal.accent : pal.obstacle,
      })
      .setOrigin(0.5);

    // The runner reports distance in metres; other genres report their own unit
    // (pipes, pairs, moves, food) or a bare number for 2048.
    const unit = d.unit !== undefined ? (d.unit ? ` ${d.unit.toUpperCase()}` : '') : ' M';
    const score = d.score !== undefined ? d.score : d.metres;
    const scored = d.target ? `${score} / ${d.target}${unit}` : `${score}${unit}`;

    const sub =
      d.mode === 'endless'
        ? `${score} M   ·   BEST ${save.getSave().endlessBest} M`
        : win
          ? `LEVEL ${d.level} · ${scored} · ${'★'.repeat(d.stars)}${'☆'.repeat(3 - d.stars)}`
          : `LEVEL ${d.level} · ${scored}`;

    this.add
      .text(VIEW_W / 2, 176, sub, { fontFamily: FONT_BODY, fontSize: '19px', color: pal.text })
      .setOrigin(0.5)
      .setAlpha(0.9);

    if (d.unlockedEndless) {
      const banner = this.add
        .text(VIEW_W / 2, 224, cfg.copy.endlessMsg.toUpperCase(), {
          fontFamily: FONT_DISPLAY,
          fontSize: '20px',
          color: pal.bg,
          backgroundColor: pal.accent,
          padding: { x: 18, y: 8 },
        })
        .setOrigin(0.5);
      this.tweens.add({ targets: banner, scale: 1.06, duration: 620, yoyo: true, repeat: -1 });
      sfx.unlock();
    }

    const buttons = [];
    if (d.mode === 'endless') {
      buttons.push(['RUN AGAIN', () => this.scene.start('Play', { mode: 'endless' })]);
    } else if (win) {
      const next = d.level + 1;
      if (next <= 20) {
        buttons.push([`LEVEL ${next}`, () => this.scene.start('Play', { mode: 'level', level: next })]);
      }
      buttons.push(['REPLAY', () => this.scene.start('Play', { mode: 'level', level: d.level })]);
    } else {
      buttons.push([
        'RETRY',
        () => this.scene.start('Play', { mode: 'level', level: d.level, deaths: d.deaths }),
      ]);
    }
    buttons.push(['MENU', () => this.scene.start('Menu')]);

    const startY = d.unlockedEndless ? 290 : 262;
    buttons.forEach(([label, fn], i) => {
      const primary = i === 0;
      const t = this.add
        .text(VIEW_W / 2, startY + i * 62, label, {
          fontFamily: primary ? FONT_DISPLAY : FONT_BODY,
          fontSize: primary ? '22px' : '17px',
          color: primary ? pal.bg : pal.text,
          backgroundColor: primary ? pal.accent : 'rgba(255,255,255,0.09)',
          padding: { x: 30, y: 13 },
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      t.on('pointerdown', () => {
        sfx.select();
        fn();
      });
      t.on('pointerover', () => t.setAlpha(0.85));
      t.on('pointerout', () => t.setAlpha(1));
    });

    this.input.keyboard?.on('keydown-SPACE', () => {
      sfx.select();
      buttons[0][1]();
    });
    this.input.keyboard?.on('keydown-ESC', () => this.scene.start('Menu'));
  }
}
