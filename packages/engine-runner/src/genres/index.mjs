/**
 * Engine genre registry.
 *
 * Maps a payload's `genre` to the scene that plays it and the textures it needs. All
 * scenes register under the key 'Play', so Menu/Result never have to know which genre
 * they are sitting next to.
 *
 * endless_runner keeps its original scene and texture builder untouched.
 */

import PlayRunner from '../scenes/Play.mjs';
import PlayFly, { buildTextures as flyTextures } from './flyScene.mjs';
import {
  PlayMemory, PlaySliding, PlayMerge, PlaySnake, buildTextures as boardTextures,
} from './boardScenes.mjs';
import { buildAllTextures, groundTexture, parallaxTextures, dotTexture } from '../textures.mjs';
import { VIEW_W, VIEW_H } from '../constants.mjs';

export const ENGINE_GENRES = {
  endless_runner: {
    Scene: PlayRunner,
    textures: (scene, cfg) => buildAllTextures(scene, cfg, VIEW_W, VIEW_H),
    hasEndless: true,
    menuGround: true,
  },
  tap_to_fly: {
    Scene: PlayFly,
    textures: (scene, cfg) => {
      groundTexture(scene, cfg.theme.palette, cfg.world.groundHeight);
      parallaxTextures(scene, cfg.theme.palette, VIEW_W, VIEW_H);
      dotTexture(scene, cfg.theme.palette);
      flyTextures(scene, cfg);
    },
    hasEndless: false,
    menuGround: true,
  },
  memory_match: { Scene: PlayMemory, textures: boardTextures, hasEndless: false, menuGround: false },
  sliding_puzzle: { Scene: PlaySliding, textures: boardTextures, hasEndless: false, menuGround: false },
  merge_2048: { Scene: PlayMerge, textures: boardTextures, hasEndless: false, menuGround: false },
  snake: { Scene: PlaySnake, textures: boardTextures, hasEndless: false, menuGround: false },
};

export function engineGenre(id) {
  return ENGINE_GENRES[id] ?? null;
}
