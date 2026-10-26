/**
 * Selection and keyboard focus of the connections tree.
 *
 * The tree holds DOM focus itself (`aria-activedescendant`), so "focus" here is the active row key.
 * Selected entries are row keys; actions work on their canonical items (`s:<id>`, `f:<path>`),
 * without duplicates (`canonicalKey`). The pure helpers below are what the key map needs: moving,
 * parents and first children, and ranges that stay inside one section.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { SectionId, TreeRow } from './types.ts';

export interface SelectionState {
  /** Selected row keys */
  keys: ReadonlySet<string>;
  /** Bumps on every change (cheap memo key) */
  version: number;
  /** Where Shift ranges start (a row key) */
  anchor: string | null;
  /** The active row (keyboard focus), a row key */
  active: string | null;
  /** Bumps when the active row must be scrolled into view (a fix-up moved it: ensureActive, undo) */
  reveal: number;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Separates a favorite folder's row key from the keys of the rows shown inside it (siteTreeModel). */
const FAV_NEST = '\u001f';

/**
 * The item a row key stands for: `fav:s:<id>` and `rec:<id>` → `s:<id>`, `fav:f:<path>` → `f:<path>`,
 * a row nested in an expanded favorite folder → its own key. Other keys (`sec:all`, `draft`…) are returned as is.
 */
export const canonicalKey = (rowKey: string): string => {
  const nest = rowKey.lastIndexOf(FAV_NEST);
  if (nest >= 0) return rowKey.slice(nest + 1);
  if (rowKey.startsWith('fav:')) return rowKey.slice(4);
  if (rowKey.startsWith('rec:')) return `s:${rowKey.slice(4)}`;
  return rowKey;
};

/** Canonical item keys of a set of row keys, without duplicates, in first-seen order. */
export const canonicalItems = (rowKeys: Iterable<string>): string[] => {
  const out = new Set<string>();
  for (const k of rowKeys) out.add(canonicalKey(k));
  return [...out];
};

/** `i + delta`, kept inside the list. */
export const moveIndex = (count: number, from: number, delta: number): number => {
  if (count <= 0) return -1;
  if (from < 0) return delta >= 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, from + delta));
};

/** The row's parent row: its folder, or the section header for a top-level item; -1 for none. */
export const parentIndex = (rows: readonly TreeRow[], i: number): number => {
  const row = rows[i];
  if (!row || row.kind === 'section' || row.kind === 'address') return -1;
  for (let j = i - 1; j >= 0; j--) {
    const r = rows[j];
    if (r.section !== row.section) return -1;
    if (row.depth === 0 && r.kind === 'section') return j;
    if (r.kind === 'folder' && r.depth === row.depth - 1) return j;
  }
  return -1;
};

/** The first child row of an expanded folder or section, or -1. */
export const firstChildIndex = (rows: readonly TreeRow[], i: number): number => {
  const row = rows[i];
  const next = rows[i + 1];
  if (!row || !next || next.section !== row.section) return -1;
  if (row.kind === 'section') return next.kind === 'section' ? -1 : i + 1;
  if (row.kind === 'folder' && row.expanded) return next.depth > row.depth ? i + 1 : -1;
  return -1;
};

/** `[start, end)` of the rows in the same section as row `i` (its header included). */
export const sectionBounds = (rows: readonly TreeRow[], i: number): [number, number] => {
  const section: SectionId | null = rows[i]?.section ?? null;
  let start = i;
  while (start > 0 && rows[start - 1].section === section) start--;
  let end = i + 1;
  while (end < rows.length && rows[end].section === section) end++;
  return [start, end];
};

/** Rows that stand for an item (a site or a folder): what multi-selection holds. */
export const isItemRow = (row: TreeRow | undefined): boolean => !!row && (row.kind === 'site' || row.kind === 'folder');

/**
 * Row keys from `from` to `to` (inclusive, either order), clipped to `from`'s section. Only sites
 * and folders: headers, the draft, placeholders and the address row are left out.
 */
export const rangeKeys = (rows: readonly TreeRow[], from: number, to: number): string[] => {
  if (from < 0 || to < 0 || from >= rows.length || to >= rows.length) return [];
  const [start, end] = sectionBounds(rows, from);
  const a = Math.max(start, Math.min(from, to));
  const b = Math.min(end - 1, Math.max(from, to));
  const out: string[] = [];
  for (let i = a; i <= b; i++) if (isItemRow(rows[i])) out.push(rows[i].key);
  return out;
};

/** Canonical item keys (`s:<id>`, `f:<path>`) of a selection, without duplicates. */
export const selectedItems = (rowKeys: Iterable<string>): string[] => canonicalItems(rowKeys).filter((k) => k.startsWith('s:') || k.startsWith('f:'));

/** What the right pane shows for a selection (spec §4). A form with unsaved edits wins before this is asked. */
export type PaneTarget = { kind: 'form' } | { kind: 'root' } | { kind: 'folder'; path: string } | { kind: 'selection'; items: string[] };

export const paneFor = (rowKeys: Iterable<string>): PaneTarget => {
  const keys = [...rowKeys];
  const items = selectedItems(keys);
  if (items.length >= 2) return { kind: 'selection', items };
  if (items.length === 1) return items[0].startsWith('f:') ? { kind: 'folder', path: items[0].slice(2) } : { kind: 'form' };
  if (keys.includes('sec:all')) return { kind: 'root' };
  return { kind: 'form' };
};

/** Rows that can hold the selection (everything but the address row and the inline new-folder row). */
export const isSelectableRow = (row: TreeRow | undefined): boolean => !!row && row.kind !== 'newFolder';

/**
 * The items a keyboard action (Delete, ⌘D, ⇧⌘D, ⌘X, Move to…) covers: the focused row when it is
 * part of the selection (or nothing is selected), else the selection itself. A focus ring that
 * wandered off (a twisty click, a cleared search) never makes an action hit a row nobody picked.
 */
export const actionItems = (selectedRowKeys: ReadonlySet<string>, row: TreeRow | null | undefined): string[] => {
  const items = selectedItems(selectedRowKeys);
  if (items.length > 1) return items;
  if (row && isItemRow(row) && (selectedRowKeys.has(row.key) || items.length === 0)) return [canonicalKey(row.key)];
  return items;
};

/**
 * ⌘-click: the selection with the item of `rowKey` added, or, when that item is selected already
 * (on this row or on its twin in Favorites, Recent or All connections), with every row of it removed.
 */
export const toggleItemKeys = (selectedRowKeys: Iterable<string>, rowKey: string): string[] => {
  const item = canonicalKey(rowKey);
  const base = [...selectedRowKeys].filter((k) => /^[sf]:/.test(canonicalKey(k)));
  return base.some((k) => canonicalKey(k) === item) ? base.filter((k) => canonicalKey(k) !== item) : [...base, rowKey];
};

/** `path` moved from folder `from` to `to` (itself or anything inside), else unchanged. */
const remapPath = (path: string, from: string, to: string): string => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);

/**
 * A row key after folder `from` became `to` (a rename, a move or its undo): `f:` keys, favorite
 * folder rows and the rows nested in them follow; other keys stay.
 */
export const remapRowKey = (rowKey: string, from: string, to: string): string =>
  rowKey
    .split(FAV_NEST)
    .map((part) => {
      if (part.startsWith('fav:f:')) return `fav:f:${remapPath(part.slice(6), from, to)}`;
      if (part.startsWith('f:')) return `f:${remapPath(part.slice(2), from, to)}`;
      if (part.startsWith('ph:')) return `ph:${remapPath(part.slice(3), from, to)}`;
      return part;
    })
    .join(FAV_NEST);

/**
 * Where Shift+navigation may take the range: row `target` kept inside the anchor's section, never
 * on its header. -1 when the section has no item rows.
 */
export const clampToSection = (rows: readonly TreeRow[], anchorIndex: number, target: number): number => {
  if (anchorIndex < 0 || anchorIndex >= rows.length) return target;
  const [start, end] = sectionBounds(rows, anchorIndex);
  const first = rows[start]?.kind === 'section' ? start + 1 : start;
  if (first >= end) return -1;
  return Math.max(first, Math.min(end - 1, target));
};

/* -------------------------------------------------------------------------- */
/* Hook                                                                        */
/* -------------------------------------------------------------------------- */

const EMPTY: ReadonlySet<string> = new Set();

export interface TreeSelection extends SelectionState {
  /** Latest state (for event handlers that run before a re-render) */
  stateRef: MutableRefObject<SelectionState>;
  /** Selects one row (and makes it active, unless `active` says otherwise) */
  selectOnly: (rowKey: string | null, active?: string | null) => void;
  /** Moves keyboard focus without changing the selection (`reveal`: scroll it into view too) */
  setActive: (rowKey: string | null, reveal?: boolean) => void;
  /**
   * When the active row is no longer shown (checked against the latest state, after any pending
   * selection change), moves it to a shown selected row, else to `fallback(active)`.
   */
  ensureActive: (isShown: (rowKey: string) => boolean, fallback: (rowKey: string) => string | null) => void;
  /**
   * A single selected Favorites or Recent row that is no longer shown: the item stays selected on
   * its own row (checked against the latest state, so a selection made in the same update wins).
   * The focus stays where it is when that row is still shown.
   */
  followTwin: (isShown: (rowKey: string) => boolean) => void;
  /** Adds or removes one row (⌘-click, WP5b) */
  toggle: (rowKey: string) => void;
  /** Selects the anchor…row range within one section (Shift-click / Shift+arrows, WP5b) */
  selectRange: (rows: readonly TreeRow[], toKey: string, indexByKey: ReadonlyMap<string, number>) => void;
  /** Replaces the selection with these row keys (`anchor` defaults to the first; `reveal` scrolls to the active row) */
  selectKeys: (rowKeys: readonly string[], active?: string | null, anchor?: string | null, reveal?: boolean) => void;
  isSelected: (rowKey: string) => boolean;
}

export function useTreeSelection(initialKey: string | null = null): TreeSelection {
  const [state, setState] = useState<SelectionState>(() => ({
    keys: initialKey ? new Set([initialKey]) : EMPTY,
    version: 0,
    anchor: initialKey,
    active: initialKey,
    reveal: 0,
  }));
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((next: (s: SelectionState) => SelectionState) => {
    setState((s) => {
      const n = next(s);
      stateRef.current = n;
      return n;
    });
  }, []);

  const selectOnly = useCallback(
    (rowKey: string | null, active?: string | null) =>
      commit((s) => {
        const nextActive = active === undefined ? rowKey ?? s.active : active;
        if (s.keys.size === (rowKey ? 1 : 0) && (!rowKey || s.keys.has(rowKey)) && s.active === nextActive && s.anchor === rowKey) return s;
        return { keys: rowKey ? new Set([rowKey]) : EMPTY, version: s.version + 1, anchor: rowKey, active: nextActive, reveal: s.reveal };
      }),
    [commit]
  );

  const setActive = useCallback(
    (rowKey: string | null, reveal = false) =>
      commit((s) => (s.active === rowKey ? (reveal ? { ...s, reveal: s.reveal + 1 } : s) : { ...s, active: rowKey, reveal: reveal ? s.reveal + 1 : s.reveal })),
    [commit]
  );

  // The row that takes over is scrolled into view (it may be far from where the focus was)
  const ensureActive = useCallback(
    (isShown: (rowKey: string) => boolean, fallback: (rowKey: string) => string | null) =>
      commit((s) => {
        if (s.active === null || isShown(s.active)) return s;
        for (const k of s.keys) if (isShown(k)) return { ...s, active: k, reveal: s.reveal + 1 };
        const next = fallback(s.active);
        return next === s.active ? s : { ...s, active: next, reveal: s.reveal + 1 };
      }),
    [commit]
  );

  const followTwin = useCallback(
    (isShown: (rowKey: string) => boolean) =>
      commit((s) => {
        if (s.keys.size !== 1) return s;
        const [only] = s.keys;
        const item = canonicalKey(only);
        if (item === only || isShown(only) || !isShown(item)) return s;
        const active = s.active !== null && s.active !== only && isShown(s.active) ? s.active : item;
        return { keys: new Set([item]), version: s.version + 1, anchor: item, active, reveal: s.reveal };
      }),
    [commit]
  );

  const toggle = useCallback(
    (rowKey: string) =>
      commit((s) => {
        const keys = new Set(s.keys);
        if (keys.has(rowKey)) keys.delete(rowKey);
        else keys.add(rowKey);
        return { keys, version: s.version + 1, anchor: rowKey, active: rowKey, reveal: s.reveal };
      }),
    [commit]
  );

  const selectRange = useCallback(
    (rows: readonly TreeRow[], toKey: string, indexByKey: ReadonlyMap<string, number>) =>
      commit((s) => {
        const from = s.anchor !== null ? indexByKey.get(s.anchor) ?? -1 : -1;
        const to = indexByKey.get(toKey) ?? -1;
        const keys = new Set(from >= 0 ? rangeKeys(rows, from, to) : [toKey]);
        return { keys, version: s.version + 1, anchor: from >= 0 ? s.anchor : toKey, active: toKey, reveal: s.reveal };
      }),
    [commit]
  );

  const selectKeys = useCallback(
    (rowKeys: readonly string[], active?: string | null, anchor?: string | null, reveal = false) =>
      commit((s) => ({
        keys: rowKeys.length ? new Set(rowKeys) : EMPTY,
        version: s.version + 1,
        anchor: anchor === undefined ? rowKeys[0] ?? null : anchor,
        active: active === undefined ? rowKeys[0] ?? s.active : active,
        reveal: reveal ? s.reveal + 1 : s.reveal,
      })),
    [commit]
  );

  const isSelected = useCallback((rowKey: string) => stateRef.current.keys.has(rowKey), []);

  return useMemo(
    () => ({ ...state, stateRef, selectOnly, setActive, ensureActive, followTwin, toggle, selectRange, selectKeys, isSelected }),
    [state, selectOnly, setActive, ensureActive, followTwin, toggle, selectRange, selectKeys, isSelected]
  );
}
