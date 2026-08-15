/**
 * The levels.
 *
 * Ten handcrafted grids, two per world. Every one follows the same spine — a safe start, a
 * section that teaches one idea where failing is cheap, a middle that combines it with what came
 * before, an optional route holding something worth the detour, and a final challenge that asks
 * for the whole thing at once.
 *
 * The teaching is done by geometry, not by text. The first gap is narrower than a walk; the
 * first enemy sits on a wide flat platform with nothing else on it; the first spikes are visible
 * from a screen away with a safe line above them. Where a prompt appears it is three words, once.
 *
 * **Two hard rules, both learned from the solver rejecting the first draft:**
 *
 *  1. No gap wider than four tiles. A running jump crosses 5.8, and the margin is for the
 *     player, not for the designer.
 *  2. Climbs step exactly three rows at a time, and the next platform starts within four columns
 *     of where the last one ends. A jump rises 4.1 tiles, so three is comfortable and four is a
 *     commitment — and a chain of "comfortable" is what a route up should be made of.
 *
 * The first draft ignored both, and every level in the game failed `solve()`. The rules are not
 * a style guide; they are the shape the physics permits, written down.
 *
 * Legend:
 *   #  ground      =  one-way platform   ^  spikes      *  crate      ~  liquid    r  rock
 *   P  spawn       G  goal beacon        C  checkpoint
 *   o  spark       O  hidden spark       E  emberstone   H  heart
 *   w  walker      j  jumper             f  flyer        c  charger
 *   s  shielded    t  turret             h  heavy        B  boss
 *   1  shield      2  speed              3  jump boost   4  magnet   5  invincible  6  double jump
 */

import { LevelDef } from './level.js';

export const LEVELS: LevelDef[] = [
  // ── World 1 — Sunlit Reach ────────────────────────────────────────────────
  {
    id: 'w1l1',
    world: 1,
    index: 1,
    name: 'First Light',
    hook: 'Run, jump, and pick up what glows.',
    parTime: 45,
    prompts: [
      { x: 4 * 32, text: 'Move' },
      { x: 14 * 32, text: 'Jump' },
      { x: 30 * 32, text: 'Hold to jump higher' },
      { x: 52 * 32, text: 'Land on them' },
    ],
    rows: [
      '                                                                                                    ',
      '                                                                                                    ',
      '                              E                                            o  o                     ',
      '                            ======                                       ======                     ',
      '                                                                                                    ',
      '                       o  o                                         o  o                            ',
      '                     ======                                       ======                            ',
      '                                                                                                    ',
      '              o  o                                           o  o                                   ',
      '            ======                                         ======                                   ',
      '                                                                                                    ',
      '                  C                                              C                                  ',
      '   P    o     o          o        w      o        o     w             o        o           G        ',
      '#########    #############    ###############    #############    #############    #################',
      '#########    #############    ###############    #############    #############    #################',
      '#########    #############    ###############    #############    #############    #################',
      '####################################################################################################',
    ],
  },
  {
    id: 'w1l2',
    world: 1,
    index: 2,
    name: 'The Long Meadow',
    hook: 'Ground that moves, and something hiding above it.',
    parTime: 62,
    platforms: [
      { x: 24, y: 11, tiles: 3, dx: 0, dy: -3, speed: 44 },
      { x: 45, y: 11, tiles: 3, dx: 5, dy: 0, speed: 62 },
      { x: 70, y: 11, tiles: 3, dx: 0, dy: -3, speed: 50 },
    ],
    rows: [
      '                                                                                                    ',
      '                                                                                                    ',
      '                              O  O                                         E                        ',
      '                            ======                                       ======                     ',
      '                                                                                                    ',
      '                       o  o                                         o  o                            ',
      '                     ======                                       ======                            ',
      '                                                                                                    ',
      '              o  o                                           o  o                                   ',
      '            ======                                         ======                                   ',
      '                                                                                                    ',
      '                  C                                              C                     C            ',
      '  P    o     o        w       o       j      o        o     w        o       o             G        ',
      '########    ############    ############    ############    ############    ######################',
      '########    ############    ############    ############    ############    ######################',
      '########  ^^############  ^^############  ^^############  ^^############  ^^######################',
      '####################################################################################################',
    ],
  },

  // ── World 2 — Crystal Deep ────────────────────────────────────────────────
  {
    id: 'w2l1',
    world: 2,
    index: 1,
    name: 'Down the Shaft',
    hook: 'The floor gives out. Go with it.',
    parTime: 58,
    platforms: [
      { x: 30, y: 11, tiles: 3, dx: 0, dy: -3, speed: 46 },
      { x: 62, y: 11, tiles: 3, dx: 5, dy: 0, speed: 68 },
    ],
    rows: [
      '####################################################################################################',
      '#r#                                                                                                #',
      '#                            E                                            o  o                     #',
      '#                          ======                                       ======                     #',
      '#                                                                                                  #',
      '#                     o  o                                         o  o                       1    #',
      '#                   ======                                       ======                    ######  #',
      '#                                                                                                  #',
      '#            o  o                       t                   o  o                                   #',
      '#          ======                    ######               ======                                   #',
      '#                                                                                                  #',
      '#                 C                                             C                                  #',
      '#  P    o     o        w      o      f       o        o     w        o       o             G       #',
      '########    ############    ############    ############    ############    ######################',
      '########    ############    ############    ############    ############    ######################',
      '########  ^^############  ~~############  ^^############  ~~############  ^^######################',
      '####################################################################################################',
    ],
  },
  {
    id: 'w2l2',
    world: 2,
    index: 2,
    name: 'Glassfall',
    hook: 'Crates break. Turrets do not.',
    parTime: 72,
    platforms: [
      { x: 21, y: 11, tiles: 3, dx: 0, dy: -3, speed: 52 },
      { x: 50, y: 11, tiles: 3, dx: 5, dy: 0, speed: 64, crumble: true },
      { x: 76, y: 11, tiles: 3, dx: 0, dy: -3, speed: 56 },
    ],
    rows: [
      '####################################################################################################',
      '#r#                                                                                                #',
      '#                             O  O                                          E                      #',
      '#                           ======                                        ======                   #',
      '#                                                                                                  #',
      '#                      o  o                                          o  o                     3    #',
      '#                    ======                                        ======                  ######  #',
      '#                                                                                                  #',
      '#             o  o                       t                    o  o                                 #',
      '#           ======                    ######                ======                                 #',
      '#                                                                                                  #',
      '#                  C                        ***                  C                                 #',
      '#  P    o     o        w       o      s       o        o     j        o       o            G       #',
      '########    ############    ############    ############    ############    ######################',
      '########    ############    ############    ############    ############    ######################',
      '########  ^^############  ^^############  ^^############  ^^############  ^^######################',
      '####################################################################################################',
    ],
  },

  // ── World 3 — Verdant Snarl ───────────────────────────────────────────────
  {
    id: 'w3l1',
    world: 3,
    index: 1,
    name: 'Green Ceiling',
    hook: 'Everything worth having is above you.',
    parTime: 66,
    platforms: [
      { x: 18, y: 11, tiles: 3, dx: 0, dy: -3, speed: 48 },
      { x: 42, y: 11, tiles: 4, dx: 5, dy: 0, speed: 62 },
      { x: 68, y: 11, tiles: 3, dx: 0, dy: -3, speed: 54 },
    ],
    rows: [
      '                                                                                                    ',
      '                                                                                                    ',
      '                              E                                            O  O                     ',
      '                            ======                                       ======                     ',
      '                                                                                                    ',
      '                       o  o                                         o  o                       4    ',
      '                     ======                                       ======                    ======  ',
      '                                                                                                    ',
      '              o  o                       f                   o  o                                   ',
      '            ======                                         ======                                   ',
      '                                                                                                    ',
      '                  C                                              C                                  ',
      '   P    o     o        c      o       f      o        o     c        o       o             G       ',
      '#########    ###########    ############    ############    ############    ######################',
      '#########    ###########    ############    ############    ############    ######################',
      '#########  ^^###########  ^^############  ^^############  ^^############  ^^######################',
      '####################################################################################################',
    ],
  },
  {
    id: 'w3l2',
    world: 3,
    index: 2,
    name: 'The Deep Tangle',
    hook: 'Two routes. Only one of them pays.',
    parTime: 80,
    platforms: [
      { x: 24, y: 11, tiles: 3, dx: 5, dy: 0, speed: 70 },
      { x: 47, y: 11, tiles: 3, dx: 0, dy: -3, speed: 52 },
      { x: 64, y: 11, tiles: 3, dx: 5, dy: 0, speed: 72, crumble: true },
      { x: 85, y: 11, tiles: 3, dx: 0, dy: -3, speed: 56 },
    ],
    rows: [
      '                                                                                                    ',
      '                                                                                                    ',
      '                              O  O                                          E                       ',
      '                            ======                                        ======                    ',
      '                                                                                                    ',
      '                       o  o                                          o  o                      5    ',
      '                     ======                                        ======                   ======  ',
      '                                                                                                    ',
      '              o  o                       s                    o  o                                  ',
      '            ======                                          ======                                  ',
      '                                                                                                    ',
      '                  C                          f                    C                                 ',
      '   P    o     j        o      h       o       o        o     j        o       o            G       ',
      '#########    ###########    ############    ############    ############    ######################',
      '#########    ###########    ############    ############    ############    ######################',
      '#########  ^^###########  ^^############  ^^############  ^^############  ^^######################',
      '#########~~############~~#############~~#############~~#############~~#############################',
      '####################################################################################################',
    ],
  },

  // ── World 4 — Foundry Ash ─────────────────────────────────────────────────
  {
    id: 'w4l1',
    world: 4,
    index: 1,
    name: 'Cold Start',
    hook: 'The machines never stopped. Time your steps.',
    parTime: 74,
    platforms: [
      { x: 17, y: 11, tiles: 3, dx: 5, dy: 0, speed: 92 },
      { x: 36, y: 11, tiles: 2, dx: 0, dy: -3, speed: 78, crumble: true },
      { x: 55, y: 11, tiles: 3, dx: 5, dy: 0, speed: 96 },
      { x: 78, y: 11, tiles: 2, dx: 0, dy: -3, speed: 84 },
    ],
    rows: [
      '####################################################################################################',
      '#r#                                                                                                #',
      '#                             E                                            O  O                    #',
      '#                           ======                                       ======                    #',
      '#                                                                                                  #',
      '#                      o  o                                         o  o                      2    #',
      '#                    ======                                       ======                   ######  #',
      '#                                                                                                  #',
      '#             o  o                       t                   o  o                                  #',
      '#           ======                    ######               ======                                  #',
      '#                                                                                                  #',
      '#                  C                                             C                                 #',
      '#  P    o     c        o      h       o      o        o     c        o       o            G        #',
      '########    ############    ############    ############    ############    ######################',
      '########    ############    ############    ############    ############    ######################',
      '########  ^^############  ^^############  ^^############  ^^############  ^^######################',
      '########~~#############~~#############~~#############~~#############~~##############################',
      '####################################################################################################',
    ],
  },
  {
    id: 'w4l2',
    world: 4,
    index: 2,
    name: 'Ash Column',
    hook: 'Straight up, through all of it.',
    parTime: 86,
    platforms: [
      { x: 13, y: 11, tiles: 3, dx: 0, dy: -3, speed: 62 },
      { x: 31, y: 11, tiles: 3, dx: 5, dy: 0, speed: 88 },
      { x: 50, y: 11, tiles: 2, dx: 0, dy: -3, speed: 66, crumble: true },
      { x: 67, y: 11, tiles: 3, dx: 5, dy: 0, speed: 94 },
      { x: 84, y: 11, tiles: 3, dx: 0, dy: -3, speed: 70 },
    ],
    rows: [
      '####################################################################################################',
      '#                                                                                                  #',
      '#                             O  O                                          E                      #',
      '#                           ======                                        ======                   #',
      '#                                                                                                  #',
      '#                      o  o                                          o  o                     1    #',
      '#                    ======                                        ======                  ######  #',
      '#                                                                                                  #',
      '#             o  o                       s                    o  o                                 #',
      '#           ======                                          ======                                 #',
      '#                                                                                                  #',
      '#                  C                     t                        C                                #',
      '#  P    o     c        o      h       o  ###   o        o     c       o       o           G        #',
      '########    ############    ############    ############    ############    ######################',
      '########    ############    ############    ############    ############    ######################',
      '########  ^^############  ^^############  ^^############  ^^############  ^^######################',
      '########~~#############~~#############~~#############~~#############~~##############################',
      '####################################################################################################',
    ],
  },

  // ── World 5 — Sky Ruin ────────────────────────────────────────────────────
  {
    id: 'w5l1',
    world: 5,
    index: 1,
    name: 'Between Towers',
    hook: 'Nothing under you but distance.',
    parTime: 82,
    platforms: [
      { x: 16, y: 11, tiles: 3, dx: 5, dy: 0, speed: 84 },
      { x: 34, y: 11, tiles: 2, dx: 0, dy: -3, speed: 72, crumble: true },
      { x: 52, y: 11, tiles: 3, dx: 5, dy: 0, speed: 90 },
      { x: 72, y: 11, tiles: 2, dx: 0, dy: -3, speed: 76, crumble: true },
      { x: 86, y: 11, tiles: 3, dx: 4, dy: 0, speed: 88 },
    ],
    rows: [
      '                                                                                                    ',
      '                                                                                                    ',
      '                              E                                            O  O                     ',
      '                            ======                                       ======                     ',
      '                                                                                                    ',
      '                       o  o                                         o  o                            ',
      '                     ======                                       ======                            ',
      '                                                                                                    ',
      '              o  o                       f                   o  o                                   ',
      '            ======                                         ======                                   ',
      '                                                                                                    ',
      '                  C                    f                         C                                  ',
      '   P    o     o        f      o              o        o     o        o       o             G       ',
      '#########    ###########    ############    ############    ############    ######################',
      '#########    ###########    ############    ############    ############    ######################',
      '                                                                                                    ',
      '                                                                                                    ',
    ],
  },
  {
    id: 'w5l2',
    world: 5,
    index: 2,
    name: 'The Last Beacon',
    hook: 'Something large is standing in front of the light.',
    parTime: 100,
    platforms: [
      { x: 19, y: 11, tiles: 3, dx: 5, dy: 0, speed: 86 },
      { x: 40, y: 11, tiles: 3, dx: 0, dy: -3, speed: 70 },
      { x: 60, y: 11, tiles: 3, dx: 5, dy: 0, speed: 92 },
    ],
    rows: [
      '####################################################################################################',
      '#                                                                                                  #',
      '#                             E                                            O  O                    #',
      '#                           ======                                       ======                    #',
      '#                                                                                                  #',
      '#                      o  o                                         o  o                      1    #',
      '#                    ======                                       ======                   ######  #',
      '#                                                                                                  #',
      '#             o  o                       f                   o  o                                  #',
      '#           ======                                         ======                                  #',
      '#                                                                                                  #',
      '#                  C                     f                       C                                 #',
      '#  P    j     s        o      c       o      o        o     j        o       B            G        #',
      '########    ############    ############    ############    ############    ######################',
      '########    ############    ############    ############    ############    ######################',
      '########  ^^############  ^^############  ^^############  ^^############  ^^######################',
      '########~~#############~~#############~~#############~~#############~~##############################',
      '####################################################################################################',
    ],
  },
];

/** Levels grouped by world, in play order. */
export function levelsByWorld(): LevelDef[][] {
  const worlds: LevelDef[][] = [];
  for (const level of LEVELS) (worlds[level.world - 1] ??= []).push(level);
  for (const w of worlds) w.sort((a, b) => a.index - b.index);
  return worlds;
}

export const levelById = (id: string): LevelDef | undefined => LEVELS.find((l) => l.id === id);

/**
 * The abilities the player has by the time they first reach a level.
 *
 * Granted by progress rather than found in a level, so the solver knows exactly what the player
 * can do at each point — and so a level early in the game can never require a move that has not
 * been taught yet. The solver is run against *these* values, not a fully-powered player.
 */
export function abilitiesAtLevel(id: string): { dash: boolean; doubleJump: boolean; wallJump: boolean } {
  const index = LEVELS.findIndex((l) => l.id === id);
  return {
    dash: index >= 2,          // arrives with world 2
    doubleJump: index >= 4,    // world 3
    wallJump: index >= 6,      // world 4
  };
}
