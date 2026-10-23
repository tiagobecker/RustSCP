import type { ITheme } from '@xterm/xterm';

/** Warm charcoal terminal that matches the app's dark theme. */
export const DARK_TERMINAL_THEME: ITheme = {
  background: '#1a1918',
  foreground: '#ecebe4',
  cursor: '#e48c70',
  cursorAccent: '#1a1918',
  selectionBackground: 'rgba(217, 119, 87, 0.38)',
  selectionInactiveBackground: 'rgba(217, 119, 87, 0.22)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.14)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.24)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.30)',
  black: '#262624',
  red: '#e5776b',
  green: '#a6c98a',
  yellow: '#e5b567',
  blue: '#8ab8e6',
  magenta: '#c3a6e0',
  cyan: '#7cc7c3',
  white: '#d6d4c9',
  brightBlack: '#78776f',
  brightRed: '#f09a8f',
  brightGreen: '#bddba5',
  brightYellow: '#f0cc8c',
  brightBlue: '#a9cdf0',
  brightMagenta: '#d6c0ec',
  brightCyan: '#9fdcd8',
  brightWhite: '#faf9f5',
};

/**
 * Ivory terminal for the light theme. "White" ANSI colors are grays here: programs print
 * with them assuming a dark background and would otherwise vanish.
 */
export const LIGHT_TERMINAL_THEME: ITheme = {
  background: '#fdfcf9',
  foreground: '#262624',
  cursor: '#c96442',
  cursorAccent: '#fdfcf9',
  selectionBackground: 'rgba(201, 100, 66, 0.26)',
  selectionInactiveBackground: 'rgba(201, 100, 66, 0.14)',
  scrollbarSliderBackground: 'rgba(0, 0, 0, 0.14)',
  scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.24)',
  scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.30)',
  black: '#262624',
  red: '#b3362b',
  green: '#3f7a2c',
  yellow: '#8f6200',
  blue: '#2f6a9e',
  magenta: '#7a4c9c',
  cyan: '#1f7a78',
  white: '#8a887f',
  brightBlack: '#5e5d58',
  brightRed: '#c94a3f',
  brightGreen: '#4f8f3a',
  brightYellow: '#a87400',
  brightBlue: '#3b7dba',
  brightMagenta: '#8d5cb0',
  brightCyan: '#278e8b',
  brightWhite: '#a9a79e',
};

export const isAppDark = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
