/**
 * Pure helpers for ui/ContextMenu.tsx: placement, shortcut labels and type-ahead.
 * No React and no DOM access, so `node --test` can run them (erasable TypeScript only).
 */
import { isMacPlatform } from '../fileListUtils.ts';

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

/** A point (right-click), or an element to drop down from (⋯ buttons, filter and footer menus). */
export type MenuAnchor = { x: number; y: number } | { rect: RectLike; placement?: 'below' | 'above' | 'right' };

export interface MenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
  /** Side the menu grows from, for transform-origin. */
  originX: 'left' | 'right';
  originY: 'top' | 'bottom';
}

/** Distance kept from the window edges. */
export const MENU_MARGIN = 12;
/** Gap between an anchor element and its menu. */
export const MENU_GAP = 4;
/** A submenu overlaps its parent menu by this much, so the pointer crosses no gap. */
const SUBMENU_OVERLAP = 4;
/** Padding (4px) plus border (1px) of .ui-menu: lines a submenu's first item up with its trigger. */
const MENU_INSET = 5;

/**
 * Horizontal: start at `start` going right; else end at `end` going left; else clamp.
 * `preferLeft` tries the left side first (a submenu keeps the direction its parent took).
 */
function placeX(start: number, end: number, width: number, viewportWidth: number, margin: number, preferLeft = false) {
  const right = start + width <= viewportWidth - margin ? { left: Math.max(margin, start), originX: 'left' as const } : null;
  const left = end - width >= margin ? { left: end - width, originX: 'right' as const } : null;
  const pick = preferLeft ? left ?? right : right ?? left;
  return pick ?? { left: Math.max(margin, viewportWidth - margin - width), originX: 'left' as const };
}

/** Vertical, free-floating: top at `downTop` growing down; else bottom at `upBottom` growing up; else clamp. */
function placeY(downTop: number, upBottom: number, height: number, viewportHeight: number, margin: number) {
  const maxHeight = Math.max(0, viewportHeight - 2 * margin);
  const h = Math.min(height, maxHeight);
  if (downTop + h <= viewportHeight - margin) return { top: Math.max(margin, downTop), maxHeight, originY: 'top' as const };
  if (upBottom - h >= margin) return { top: upBottom - h, maxHeight, originY: 'bottom' as const };
  return { top: Math.max(margin, viewportHeight - margin - h), maxHeight, originY: 'top' as const };
}

/** Vertical, attached to an element: never covers it; takes the roomier side and scrolls when neither fits. */
function placeYAround(rect: RectLike, height: number, viewportHeight: number, margin: number, preferAbove: boolean) {
  const belowTop = rect.bottom + MENU_GAP;
  const spaceBelow = Math.max(0, viewportHeight - margin - belowTop);
  const spaceAbove = Math.max(0, rect.top - MENU_GAP - margin);
  const below = { top: belowTop, maxHeight: spaceBelow, originY: 'top' as const };
  const above = (h: number) => ({ top: rect.top - MENU_GAP - h, maxHeight: spaceAbove, originY: 'bottom' as const });
  const order = preferAbove ? ['above', 'below'] : ['below', 'above'];
  for (const side of order) {
    if (side === 'below' && height <= spaceBelow) return below;
    if (side === 'above' && height <= spaceAbove) return above(height);
  }
  return spaceBelow >= spaceAbove ? below : above(Math.min(height, spaceAbove));
}

/** Where a top-level menu of `size` goes for `anchor`, inside a viewport of `viewport`. */
export function placeMenu(anchor: MenuAnchor, size: SizeLike, viewport: SizeLike, margin: number = MENU_MARGIN): MenuPlacement {
  if ('rect' in anchor) {
    const { rect } = anchor;
    const placement = anchor.placement ?? 'below';
    if (placement === 'right') {
      const x = placeX(rect.right + MENU_GAP, rect.left - MENU_GAP, size.width, viewport.width, margin);
      const y = placeY(rect.top, rect.bottom, size.height, viewport.height, margin);
      return { left: x.left, top: y.top, maxHeight: y.maxHeight, originX: x.originX, originY: y.originY };
    }
    const x = placeX(rect.left, rect.right, size.width, viewport.width, margin);
    const y = placeYAround(rect, size.height, viewport.height, margin, placement === 'above');
    return { left: x.left, top: y.top, maxHeight: y.maxHeight, originX: x.originX, originY: y.originY };
  }
  const x = placeX(anchor.x, anchor.x, size.width, viewport.width, margin);
  const y = placeY(anchor.y, anchor.y, size.height, viewport.height, margin);
  return { left: x.left, top: y.top, maxHeight: y.maxHeight, originX: x.originX, originY: y.originY };
}

/**
 * A submenu opens beside its parent menu (`panel`), its first item level with `trigger`. It flips left when
 * there is no room, and keeps going left once its parent did (`parentOpenedLeft`), like native menus.
 */
export function placeSubmenu(
  panel: RectLike,
  trigger: RectLike,
  size: SizeLike,
  viewport: SizeLike,
  margin: number = MENU_MARGIN,
  parentOpenedLeft = false
): MenuPlacement {
  const x = placeX(panel.right - SUBMENU_OVERLAP, panel.left + SUBMENU_OVERLAP, size.width, viewport.width, margin, parentOpenedLeft);
  const y = placeY(trigger.top - MENU_INSET, trigger.bottom + MENU_INSET, size.height, viewport.height, margin);
  return { left: x.left, top: y.top, maxHeight: y.maxHeight, originX: x.originX, originY: y.originY };
}

/* -------------------------------------------------------------------------- */
/* Shortcut labels                                                             */
/* -------------------------------------------------------------------------- */

// U+FE0E keeps ↩ a text glyph: without it WebKit and Chromium draw the colour emoji.
const MAC_KEYS: Record<string, string> = {
  enter: '↩\uFE0E',
  return: '↩\uFE0E',
  backspace: '⌫',
  delete: '⌦',
  escape: '⎋',
  esc: '⎋',
  tab: '⇥',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  space: 'Space',
};

const OTHER_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Del',
  escape: 'Esc',
  esc: 'Esc',
  tab: 'Tab',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  space: 'Space',
};

/**
 * Display label for a shortcut written as `Mod+Shift+N` (Mod is ⌘ on macOS and Ctrl elsewhere).
 * Modifiers: Mod, Ctrl, Alt, Shift. Keys: a letter, F1–F12, Enter, Backspace, Delete, Escape, Tab, Space, Arrow*.
 * macOS uses glyphs in Apple's order (⌃⌥⇧⌘), e.g. `⇧⌘N`; elsewhere `Ctrl+Shift+N`, `Ctrl+Alt+N`, `Del`, `Enter`.
 */
export function formatShortcut(spec: string, mac: boolean = isMacPlatform()): string {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  if (spec.endsWith('++')) parts.push('+');
  const mods = new Set<string>();
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'meta') mods.add(mac ? 'cmd' : 'ctrl');
    else if (lower === 'ctrl' || lower === 'control') mods.add('ctrl');
    else if (lower === 'alt' || lower === 'option' || lower === 'opt') mods.add('alt');
    else if (lower === 'shift') mods.add('shift');
    else key = part;
  }
  const lowerKey = key.toLowerCase();
  const keyLabel = (mac ? MAC_KEYS : OTHER_KEYS)[lowerKey] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) {
    const glyphs = (mods.has('ctrl') ? '⌃' : '') + (mods.has('alt') ? '⌥' : '') + (mods.has('shift') ? '⇧' : '') + (mods.has('cmd') ? '⌘' : '');
    return glyphs + keyLabel;
  }
  const names = [mods.has('ctrl') && 'Ctrl', mods.has('alt') && 'Alt', mods.has('shift') && 'Shift'].filter(Boolean) as string[];
  return [...names, keyLabel].join('+');
}

const ARIA_MAC_MODS: Record<string, string> = { '⌃': 'Control', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Meta' };
const ARIA_KEYS: Record<string, string> = {
  '↩': 'Enter',
  '⏎': 'Enter',
  '⌫': 'Backspace',
  '⌦': 'Delete',
  '⎋': 'Escape',
  '⇥': 'Tab',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
};
const ARIA_MODS: Record<string, string> = { ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift', win: 'Meta', meta: 'Meta', cmd: 'Meta' };

/**
 * `aria-keyshortcuts` value for a display label from formatShortcut (or written by hand):
 * `⇧⌘N` → `Shift+Meta+N`, `Ctrl+Alt+N` → `Control+Alt+N`, `Del` → `Delete`. Undefined when it cannot tell.
 */
export function ariaKeyShortcuts(label: string | undefined): string | undefined {
  const text = (label ?? '').replace(/[\uFE0E\uFE0F]/g, '').trim();
  if (!text) return undefined;
  const mods: string[] = [];
  let rest = text;
  while (rest && ARIA_MAC_MODS[rest[0]]) {
    mods.push(ARIA_MAC_MODS[rest[0]]);
    rest = rest.slice(1);
  }
  let key: string;
  if (mods.length > 0) {
    key = rest;
  } else {
    const parts = text.split('+');
    if (text.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
    key = parts.pop() ?? '';
    for (const part of parts) {
      const mod = ARIA_MODS[part.trim().toLowerCase()];
      if (!mod) return undefined;
      mods.push(mod);
    }
  }
  key = key.trim();
  if (!key) return undefined;
  const mapped = ARIA_KEYS[key] ?? ARIA_KEYS[key.toLowerCase()] ?? key;
  return [...mods, mapped].join('+');
}

/* -------------------------------------------------------------------------- */
/* Type-ahead                                                                  */
/* -------------------------------------------------------------------------- */

/** Lowercase without accents ("Ações" → "acoes"), like the command palette. */
export const foldLabel = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Index of the item a type-ahead `buffer` jumps to, or -1. Repeating one letter cycles through the
 * items that start with it; a longer prefix stays on the current item while it still matches.
 */
export function nextTypeaheadIndex(labels: string[], current: number, buffer: string): number {
  const needleFull = foldLabel(buffer);
  if (!needleFull || labels.length === 0) return -1;
  const repeated = needleFull.length > 1 && [...needleFull].every((c) => c === needleFull[0]);
  const needle = repeated ? needleFull[0] : needleFull;
  const cycle = repeated || needleFull.length === 1;
  const start = cycle ? current + 1 : Math.max(0, current);
  const n = labels.length;
  for (let i = 0; i < n; i++) {
    const j = (((start + i) % n) + n) % n;
    if (foldLabel(labels[j]).startsWith(needle)) return j;
  }
  return -1;
}
