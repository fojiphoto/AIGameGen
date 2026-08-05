import Phaser from 'phaser';
import { VIEW_W, VIEW_H, FONT_BODY } from '../constants.mjs';
import * as save from '../save.mjs';
import { setMuted } from '../audio.mjs';
import { engineGenre } from '../genres/index.mjs';

export default class Boot extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    try {
      const cfg = this.registry.get('cfg');
      const pal = cfg.theme.palette;

      this.cameras.main.setBackgroundColor(pal.bg);
      this.add
        .text(VIEW_W / 2, VIEW_H / 2, 'LOADING', {
          fontFamily: FONT_BODY,
          fontSize: '16px',
          color: pal.text,
        })
        .setOrigin(0.5)
        .setAlpha(0.6);

      // All art is procedural, so "loading" is a single synchronous pass. Which textures
      // get built depends on the genre — a board game has no ground or parallax bands.
      const genre = engineGenre(cfg.genre);
      if (!genre) throw new Error(`no engine support for genre "${cfg.genre}"`);
      genre.textures(this, cfg);

      const s = save.initSave(cfg.buildId);
      setMuted(s.muted);

      if (genre.skipMenu) {
        // Some genres have no level select on purpose: drop straight into the furthest
        // level reached so a returning player is playing within a second of loading.
        const next = Math.min(cfg.levels.length, Math.max(1, s.bestLevel + 1));
        this.time.delayedCall(0, () => this.scene.start('Play', { level: next, attempts: 1 }));
        return;
      }
      this.scene.start('Menu');
    } catch (err) {
      // A crash here means a blank screen with no explanation, which is the worst
      // possible first impression. Surface it instead.
      window.__FORGE_BOOT_ERROR__ = String((err && err.stack) || err);
      console.error('Boot failed', err);
      this.add
        .text(VIEW_W / 2, VIEW_H / 2, 'FAILED TO START', {
          fontFamily: FONT_BODY,
          fontSize: '18px',
          color: '#ff6b6b',
        })
        .setOrigin(0.5);
    }
  }
}
