/**
 * Themes.
 *
 * A theme is not a palette swap on the board alone — it moves the page background, the panel
 * surfaces, the accent, the move highlights and the piece material together. Changing only the
 * squares gives you a neon board sitting in a wooden room, which looks like a bug.
 *
 * Every theme is checked against one hard constraint: both piece colours must stay clearly
 * readable on both square colours. That rules out the obvious pretty choices — a dark board with
 * dark pieces, a low-contrast marble — so each theme's squares are kept in a mid range and the
 * drama is put into the background and the accents instead, where it costs nothing.
 *
 * Applied as CSS custom properties on `<html>`, so the DOM interface restyles itself and only
 * the canvas needs redrawing.
 */

export interface Theme {
  key: string;
  name: string;
  blurb: string;

  /** Board. */
  light: string;
  dark: string;
  /** Frame around the board, and the coordinate text on it. */
  frame: string;
  frameEdge: string;
  coordinate: string;

  /** Feedback colours. */
  lastMove: string;
  selected: string;
  legal: string;
  capture: string;
  check: string;
  hint: string;

  /** Page and panels. */
  bg: string;
  bgAccent: string;
  surface: string;
  surfaceEdge: string;
  text: string;
  muted: string;
  accent: string;
  accentInk: string;

  /** Which procedural piece material to use. */
  pieces: string;
}

export const THEMES: Theme[] = [
  {
    key: 'classic',
    name: 'Classic',
    blurb: 'Warm walnut and cream. The board everyone pictures.',
    light: '#efdfc0', dark: '#a9784f',
    frame: '#4b3221', frameEdge: '#2e2114', coordinate: '#f2e5cd',
    lastMove: 'rgba(250, 204, 21, 0.42)', selected: 'rgba(250, 204, 21, 0.60)',
    legal: 'rgba(60, 42, 24, 0.34)', capture: 'rgba(190, 60, 40, 0.85)',
    check: 'rgba(220, 60, 45, 0.85)', hint: 'rgba(56, 189, 160, 0.75)',
    bg: '#1d1710', bgAccent: '#33261a', surface: 'rgba(48, 36, 24, 0.72)',
    surfaceEdge: 'rgba(233, 205, 158, 0.14)',
    text: '#f4ead9', muted: '#bda887', accent: '#e0a44a', accentInk: '#2a1c0c',
    pieces: 'ivory',
  },
  {
    key: 'royal',
    name: 'Royal',
    blurb: 'Midnight blue and gold leaf.',
    light: '#d9dfe8', dark: '#4a6491',
    frame: '#1a2540', frameEdge: '#0c1222', coordinate: '#dfe6f4',
    lastMove: 'rgba(240, 190, 90, 0.44)', selected: 'rgba(240, 190, 90, 0.62)',
    legal: 'rgba(20, 32, 58, 0.34)', capture: 'rgba(214, 92, 82, 0.85)',
    check: 'rgba(232, 78, 68, 0.88)', hint: 'rgba(120, 210, 255, 0.78)',
    bg: '#0a0f1d', bgAccent: '#16233f', surface: 'rgba(20, 32, 58, 0.74)',
    surfaceEdge: 'rgba(198, 216, 255, 0.14)',
    text: '#eef3ff', muted: '#9fb0cf', accent: '#e8c274', accentInk: '#1b1405',
    pieces: 'gold',
  },
  {
    key: 'marble',
    name: 'Marble',
    blurb: 'Cool stone, gallery light.',
    light: '#f1f2f4', dark: '#8d97a6',
    frame: '#3c4350', frameEdge: '#222831', coordinate: '#eef1f6',
    lastMove: 'rgba(110, 190, 255, 0.40)', selected: 'rgba(110, 190, 255, 0.58)',
    legal: 'rgba(40, 50, 66, 0.30)', capture: 'rgba(200, 80, 80, 0.82)',
    check: 'rgba(226, 72, 72, 0.85)', hint: 'rgba(90, 200, 170, 0.78)',
    bg: '#14171c', bgAccent: '#262c36', surface: 'rgba(38, 44, 54, 0.74)',
    surfaceEdge: 'rgba(224, 230, 240, 0.14)',
    text: '#f2f5fa', muted: '#a8b2c2', accent: '#7cc3ff', accentInk: '#04121f',
    pieces: 'marble',
  },
  {
    key: 'forest',
    name: 'Forest',
    blurb: 'Moss and parchment. Easy on long games.',
    light: '#eae7d2', dark: '#6f8f63',
    frame: '#2c3a2a', frameEdge: '#18231a', coordinate: '#e9f0e0',
    lastMove: 'rgba(233, 196, 84, 0.44)', selected: 'rgba(233, 196, 84, 0.62)',
    legal: 'rgba(28, 44, 26, 0.32)', capture: 'rgba(196, 82, 62, 0.84)',
    check: 'rgba(216, 74, 58, 0.86)', hint: 'rgba(120, 208, 180, 0.78)',
    bg: '#101710', bgAccent: '#1e2c1d', surface: 'rgba(28, 42, 28, 0.74)',
    surfaceEdge: 'rgba(206, 226, 190, 0.14)',
    text: '#eef5e8', muted: '#a8bea0', accent: '#a3d977', accentInk: '#0d1a08',
    pieces: 'ivory',
  },
  {
    key: 'neon',
    name: 'Neon',
    blurb: 'Dark room, restrained glow.',
    light: '#c7d3e4', dark: '#3f4d6b',
    frame: '#141a2c', frameEdge: '#070a14', coordinate: '#cfe3ff',
    lastMove: 'rgba(0, 232, 255, 0.34)', selected: 'rgba(0, 232, 255, 0.55)',
    legal: 'rgba(10, 18, 34, 0.36)', capture: 'rgba(255, 62, 165, 0.85)',
    check: 'rgba(255, 62, 120, 0.88)', hint: 'rgba(180, 130, 255, 0.80)',
    bg: '#06070f', bgAccent: '#131033', surface: 'rgba(16, 20, 40, 0.78)',
    surfaceEdge: 'rgba(120, 200, 255, 0.16)',
    text: '#eaf4ff', muted: '#8fa4c8', accent: '#00e8ff', accentInk: '#00131a',
    pieces: 'glass',
  },
  {
    key: 'midnight',
    name: 'Midnight',
    blurb: 'Near-black, maximum focus.',
    light: '#b9bec8', dark: '#4c525e',
    frame: '#1a1d24', frameEdge: '#0b0d11', coordinate: '#d6dbe4',
    lastMove: 'rgba(255, 214, 120, 0.34)', selected: 'rgba(255, 214, 120, 0.52)',
    legal: 'rgba(12, 14, 20, 0.40)', capture: 'rgba(224, 96, 88, 0.84)',
    check: 'rgba(238, 80, 72, 0.88)', hint: 'rgba(140, 220, 200, 0.78)',
    bg: '#08090c', bgAccent: '#15181f', surface: 'rgba(20, 23, 30, 0.80)',
    surfaceEdge: 'rgba(200, 210, 226, 0.12)',
    text: '#eceff5', muted: '#98a0ae', accent: '#ffd678', accentInk: '#1a1304',
    pieces: 'marble',
  },
];

export const themeByKey = (key: string): Theme =>
  THEMES.find((t) => t.key === key) ?? THEMES[0];

/**
 * Push a theme into CSS custom properties.
 *
 * One write to `<html>` restyles every panel, button and label at once. Doing it here rather
 * than in a stylesheet per theme means adding a theme is adding one object, not one more
 * stylesheet to keep in sync with the other five.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  set('--bg', theme.bg);
  set('--bg-accent', theme.bgAccent);
  set('--surface', theme.surface);
  set('--surface-edge', theme.surfaceEdge);
  set('--text', theme.text);
  set('--muted', theme.muted);
  set('--accent', theme.accent);
  set('--accent-ink', theme.accentInk);
  set('--frame', theme.frame);
  set('--frame-edge', theme.frameEdge);
  set('--sq-light', theme.light);
  set('--sq-dark', theme.dark);
  set('--check', theme.check);
  root.dataset.theme = theme.key;
}
