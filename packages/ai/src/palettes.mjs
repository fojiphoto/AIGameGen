/**
 * Curated palette library (§B4 asset resolver, v1 = procedural rendering).
 *
 * Hand-picked rather than AI-generated for one reason: contrast. The player and
 * obstacle colours must read instantly against both bg and ground at 900px/s.
 * An LLM picking seven hex codes freehand gets this wrong often enough to matter,
 * so the deterministic planner selects from here and the LLM path is nudged
 * toward these by the few-shot examples.
 */

export const PALETTES = [
  {
    id: 'forge_green',
    keywords: ['default', 'forest', 'jungle', 'nature', 'leaf', 'emerald', 'factorial'],
    mood: 'energetic',
    styleTags: ['lush', 'organic', 'bold'],
    palette: {
      bg: '#06281c', bgAccent: '#0a5a42', ground: '#11704f',
      player: '#a3d977', obstacle: '#ff7043', accent: '#fbbf24', text: '#eaf5ee',
    },
  },
  {
    id: 'neon_cyber',
    keywords: ['neon', 'cyber', 'cyberpunk', 'synthwave', 'robot', 'tech', 'hacker', 'futuristic', 'city'],
    mood: 'tense',
    styleTags: ['neon', 'cyberpunk', 'synthwave'],
    palette: {
      bg: '#0b0620', bgAccent: '#1e0a3c', ground: '#2a1155',
      player: '#00f0ff', obstacle: '#ff2d95', accent: '#ffe14d', text: '#f0eaff',
    },
  },
  {
    id: 'deep_space',
    keywords: ['space', 'galaxy', 'star', 'cosmic', 'astronaut', 'alien', 'moon', 'orbit', 'nebula'],
    mood: 'calm',
    styleTags: ['cosmic', 'minimal', 'starfield'],
    palette: {
      bg: '#050514', bgAccent: '#12123a', ground: '#232358',
      player: '#7dd3fc', obstacle: '#f472b6', accent: '#fde047', text: '#e8eaff',
    },
  },
  {
    id: 'lava_forge',
    keywords: ['lava', 'volcano', 'fire', 'hell', 'magma', 'inferno', 'demon', 'molten'],
    mood: 'dark',
    styleTags: ['molten', 'harsh', 'ember'],
    palette: {
      bg: '#1a0703', bgAccent: '#3d1005', ground: '#5c1a06',
      player: '#ffd166', obstacle: '#ff3b30', accent: '#ff8c42', text: '#ffe8d6',
    },
  },
  {
    id: 'ice_tundra',
    keywords: ['ice', 'snow', 'winter', 'frozen', 'arctic', 'glacier', 'penguin', 'frost'],
    mood: 'calm',
    styleTags: ['crisp', 'icy', 'clean'],
    palette: {
      bg: '#071a2b', bgAccent: '#0d3550', ground: '#14507a',
      player: '#e0f7ff', obstacle: '#ff6b6b', accent: '#66e0ff', text: '#eaf6ff',
    },
  },
  {
    id: 'sunset_desert',
    keywords: ['desert', 'sand', 'sunset', 'dune', 'egypt', 'canyon', 'western', 'pyramid'],
    mood: 'energetic',
    styleTags: ['warm', 'retro', 'sunbaked'],
    palette: {
      bg: '#2b1206', bgAccent: '#6b2d0e', ground: '#a8541f',
      player: '#ffe9b0', obstacle: '#3b1f4d', accent: '#ffb347', text: '#fff3e0',
    },
  },
  {
    id: 'deep_ocean',
    keywords: ['ocean', 'sea', 'water', 'underwater', 'fish', 'submarine', 'coral', 'aqua', 'diver'],
    mood: 'calm',
    styleTags: ['aquatic', 'flowing', 'deep'],
    palette: {
      bg: '#021a2b', bgAccent: '#053a52', ground: '#07607a',
      player: '#ffe066', obstacle: '#ff5c8a', accent: '#4dd0e1', text: '#e0f7fa',
    },
  },
  {
    id: 'candy_pop',
    keywords: ['sweet', 'sugar', 'dessert', 'cute', 'pastel', 'kawaii', 'bubblegum', 'cake', 'playful'],
    mood: 'playful',
    styleTags: ['pastel', 'cute', 'soft'],
    palette: {
      bg: '#2d1033', bgAccent: '#571d5c', ground: '#7d2a80',
      player: '#fff0f5', obstacle: '#ff4d6d', accent: '#ffd60a', text: '#ffeef7',
    },
  },
  {
    id: 'toxic_waste',
    keywords: ['toxic', 'slime', 'zombie', 'radioactive', 'apocalypse', 'sewer', 'mutant', 'acid'],
    mood: 'dark',
    styleTags: ['grimy', 'toxic', 'gritty'],
    palette: {
      bg: '#0d1407', bgAccent: '#1e2e0c', ground: '#33470f',
      player: '#c6ff00', obstacle: '#8d2fbf', accent: '#ffea00', text: '#eaffd0',
    },
  },
  {
    id: 'mono_ink',
    keywords: ['minimal', 'mono', 'monochrome', 'black', 'white', 'simple', 'clean', 'paper', 'sketch'],
    mood: 'calm',
    styleTags: ['minimal', 'monochrome', 'geometric'],
    palette: {
      bg: '#0f0f10', bgAccent: '#1d1d21', ground: '#2b2b31',
      player: '#fafafa', obstacle: '#ff4136', accent: '#9e9e9e', text: '#f5f5f5',
    },
  },
  {
    id: 'retro_arcade',
    keywords: ['retro', 'arcade', '8bit', 'pixel', '80s', 'crt', 'vaporwave', 'classic'],
    mood: 'playful',
    styleTags: ['retro', 'pixel', 'arcade'],
    palette: {
      bg: '#11071f', bgAccent: '#2b0f45', ground: '#43156b',
      player: '#39ff14', obstacle: '#ff206e', accent: '#05d9e8', text: '#f6f0ff',
    },
  },
  {
    id: 'storm_sky',
    keywords: ['storm', 'sky', 'cloud', 'rain', 'thunder', 'wind', 'plane', 'bird', 'flight'],
    mood: 'tense',
    styleTags: ['stormy', 'airy', 'dramatic'],
    palette: {
      bg: '#101a24', bgAccent: '#1f3242', ground: '#2e4a5e',
      player: '#ffd93d', obstacle: '#e63946', accent: '#8ecae6', text: '#edf6f9',
    },
  },
];

export const DEFAULT_PALETTE_ID = 'forge_green';

/** Score palettes by keyword overlap with the prompt; deterministic tie-break. */
export function selectPalette(text) {
  const t = String(text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const p of PALETTES) {
    let score = 0;
    for (const k of p.keywords) {
      if (k === 'default') continue;
      if (t.includes(k)) score += k.length >= 6 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best ?? PALETTES.find((p) => p.id === DEFAULT_PALETTE_ID);
}

export function paletteById(id) {
  return PALETTES.find((p) => p.id === id) ?? PALETTES.find((p) => p.id === DEFAULT_PALETTE_ID);
}
