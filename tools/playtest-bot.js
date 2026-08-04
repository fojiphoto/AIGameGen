/**
 * Runtime playability bot — injected into a page running a generated game.
 *
 * WHY THIS EXISTS
 * packages/generation/validator.mjs proves levels are beatable ANALYTICALLY, from
 * closed-form physics. This bot proves it EMPIRICALLY, by actually playing them in
 * the real Phaser engine. The two together are what let us claim "every level is
 * beatable" without hand-testing 20 levels per generated game.
 *
 * It already earned its keep: it caught a validator hole where a low_bar placed
 * just after a jumpable obstacle was never checked, so the player could be forced
 * into it mid-air. See validator.mjs check #4.
 *
 * The bot plays OPTIMALLY, using the same maths the validator uses:
 *   • it groups obstacles that cannot be landed between into one jump
 *   • it takes off at the analytically correct moment for that group's max height
 * So a failure here means the LEVEL is unfair, not that the bot is bad.
 *
 * USAGE
 *   1. serve a generated bundle (tools/serve.mjs) or the assets extracted from an APK
 *   2. inject this file, then:
 *        FORGE_BOT.playAll()            → { won: '20/20', failures: [] }
 *        FORGE_BOT.play(7)              → one level
 *        FORGE_BOT.play(null,'endless') → endless smoke test
 *
 * It drives game.scene.update() rather than game.step() so no frames are rendered —
 * roughly 20x faster, and it works in a headless / hidden browser where
 * requestAnimationFrame never fires.
 */
(function () {
  const DT = 1000 / 60;
  const PLAYER_X = 150;
  const VERTICAL_MARGIN = 12;
  const HORIZONTAL_MARGIN = 10;

  function ctx() {
    const game = window.__FORGE_GAME__;
    const cfg = window.__GAME__;
    if (!game || !cfg) throw new Error('no game on this page (window.__FORGE_GAME__ / __GAME__)');
    const uRaw = Math.abs(cfg.player.jumpVelocity);
    return {
      game,
      cfg,
      u: uRaw * (cfg.player.doubleJump ? Math.SQRT2 : 1),
      g: cfg.player.gravity,
      airT: cfg.player.doubleJump ? (uRaw * (2 + Math.SQRT2)) / cfg.player.gravity : (2 * uRaw) / cfg.player.gravity,
    };
  }

  const reach = (ob) => ob.yOffset + (ob.motionAmp || 0) + ob.height;

  /** Seconds before contact at which to take off. Mirrors physics.mjs. */
  function leadTime(c, height, span, speed, box) {
    const crossing = (span + box) / speed;
    if (height === null) return Math.max(0, (c.airT - crossing) / 2); // ground gap
    const h = height + VERTICAL_MARGIN;
    const disc = c.u * c.u - 2 * c.g * h;
    if (disc <= 0) return null; // unclearable at any timing
    const root = Math.sqrt(disc);
    const tRise = (c.u - root) / c.g;
    const tAbove = (2 * root) / c.g;
    return tRise + Math.max(0, (tAbove - crossing) / 2);
  }

  let clock = 0;

  function play(level, mode, maxSteps) {
    const c = ctx();
    const G = c.game;
    mode = mode || 'level';
    maxSteps = maxSteps || 7000;

    G.scene.stop('Play');
    G.scene.stop('Result');
    G.scene.start('Play', mode === 'endless' ? { mode: 'endless' } : { mode: 'level', level });

    const tick = () => {
      clock += DT;
      G.scene.update(clock, DT);
    };
    for (let i = 0; i < 4; i++) tick();

    const p = G.scene.getScene('Play');
    const box = p.playerBox;
    let taps = 0;

    for (let i = 0; i < maxSteps; i++) {
      if (p.running && !p.dead && !p.finished && p.grounded) {
        const safe = c.airT * p.speed + box + 2 * HORIZONTAL_MARGIN;
        const pRight = PLAYER_X + box / 2;

        // nearest obstacle ahead
        let first = null;
        let fd = Infinity;
        for (const s of p.spawned) {
          const d = PLAYER_X + (s.worldX - p.dist) - pRight;
          if (d >= 0 && d < fd) {
            fd = d;
            first = s;
          }
        }

        if (first && first.ob.kind !== 'low_bar') {
          // Absorb every following obstacle we could not land between: they must
          // all be cleared by ONE jump, so the takeoff must be timed for the group.
          let lastX = first.worldX + first.ob.width;
          let maxReach = reach(first.ob);
          let isGap = first.ob.kind === 'gap';
          let grew = true;
          while (grew) {
            grew = false;
            for (const s of p.spawned) {
              if (s.worldX < first.worldX || s.worldX + s.ob.width <= lastX) continue;
              if (s.ob.kind === 'low_bar') continue;
              if (s.worldX - lastX < safe) {
                lastX = s.worldX + s.ob.width;
                maxReach = Math.max(maxReach, reach(s.ob));
                if (s.ob.kind === 'gap') isGap = true;
                grew = true;
              }
            }
          }
          const span = lastX - first.worldX;
          const lt = leadTime(c, isGap && maxReach <= 20 ? null : maxReach, span, p.speed, box);
          if (lt !== null && fd <= p.speed * lt) {
            p.onTap();
            taps++;
          }
        }
      }
      tick();
      if (p.dead || p.finished) break;
    }

    return {
      level: mode === 'endless' ? 'endless' : level,
      outcome: p.finished ? 'WIN' : p.dead ? 'DIED' : 'RAN',
      pct: p.targetPx === Infinity ? null : Math.round((p.dist / p.targetPx) * 100),
      metres: Math.round(p.dist / 25),
      obstacles: p.level ? p.level.pattern.length : null,
      taps,
    };
  }

  function playAll(from, to) {
    const cfg = window.__GAME__;
    from = from || 1;
    to = to || cfg.levels.length;
    const results = [];
    for (let lv = from; lv <= to; lv++) results.push(play(lv, 'level'));
    const won = results.filter((r) => r.outcome === 'WIN').length;
    return {
      title: cfg.meta.title,
      buildId: cfg.buildId,
      won: `${won}/${to - from + 1}`,
      failures: results.filter((r) => r.outcome !== 'WIN'),
      results,
    };
  }

  window.FORGE_BOT = { play, playAll, resetClock: () => (clock = 0) };
})();
