/**
 * Rows of the "Move to…" dialog (pure, tested with `node --test`): "Top level", the recent targets
 * of this session, then every folder fully expanded in natural order, filtered by the search text
 * (accents and case ignored; matches keep their parents for context).
 */
import { fold, folderChain, isInside, naturalCompare, normalizeGroup, parentOf, baseName } from './siteTreeModel.ts';

export type MoveRow =
  | { kind: 'top'; key: 'top'; path: ''; depth: 0; disabled: boolean; current: boolean }
  | { kind: 'label'; key: string; label: 'recent' | 'all' }
  | { kind: 'folder'; key: string; path: string; name: string; depth: number; disabled: boolean; current: boolean; match: boolean; recent: boolean }
  | { kind: 'new'; key: 'new'; parent: string; depth: number };

export interface MoveRowsInput {
  /** Every folder path (parents are added when missing) */
  folders: Iterable<string>;
  query: string;
  /** Recent targets, newest first (only existing folders are shown, at most 3) */
  recents: readonly string[];
  /** The items' shared parent ('' = top level), or null when they differ */
  current: string | null;
  /** Move mode: the shared parent is not a target. Pick mode leaves it enabled. */
  disableCurrent: boolean;
  /** Folders being moved: they and every folder inside them are not targets */
  moving: readonly string[];
  /** Parent of the inline "New folder" row, or null */
  newFolderParent: string | null;
}

export const MOVE_RECENTS_SHOWN = 3;

/** Every folder of `folders` plus their parents, as a set. */
export const allFolderPaths = (folders: Iterable<string>): Set<string> => {
  const all = new Set<string>();
  for (const raw of folders) for (const p of folderChain(normalizeGroup(raw))) all.add(p);
  return all;
};

export function buildMoveRows(input: MoveRowsInput): MoveRow[] {
  const all = allFolderPaths(input.folders);
  const q = fold(input.query.trim());
  const blocked = (p: string) => input.moving.some((m) => m && isInside(p, m));
  const isCurrent = (p: string) => input.current !== null && p === input.current;
  const disabled = (p: string) => blocked(p) || (input.disableCurrent && isCurrent(p));

  // While searching: folders whose name (or path, when the text has '/') matches, plus their parents
  let shown: Set<string> | null = null;
  const matched = new Set<string>();
  if (q) {
    shown = new Set<string>();
    for (const p of all) {
      const hay = q.includes('/') ? fold(p) : fold(baseName(p));
      if (!hay.includes(q)) continue;
      matched.add(p);
      for (const c of folderChain(p)) shown.add(c);
    }
  }

  const children = new Map<string, string[]>();
  for (const p of all) {
    if (shown && !shown.has(p)) continue;
    const parent = parentOf(p);
    const list = children.get(parent);
    if (list) list.push(p);
    else children.set(parent, [p]);
  }
  for (const list of children.values()) list.sort((a, b) => naturalCompare(baseName(a), baseName(b)) || (a < b ? -1 : a > b ? 1 : 0));

  const rows: MoveRow[] = [{ kind: 'top', key: 'top', path: '', depth: 0, disabled: input.disableCurrent && input.current === '', current: input.current === '' }];
  const newParent = input.newFolderParent;
  if (newParent === '') rows.push({ kind: 'new', key: 'new', parent: '', depth: 0 });

  const recents = q ? [] : input.recents.filter((r) => r && all.has(r)).slice(0, MOVE_RECENTS_SHOWN);
  if (recents.length > 0) {
    rows.push({ kind: 'label', key: 'label:recent', label: 'recent' });
    for (const p of recents) {
      rows.push({ kind: 'folder', key: `r:${p}`, path: p, name: p.split('/').join(' / '), depth: 0, disabled: disabled(p), current: isCurrent(p), match: false, recent: true });
    }
    rows.push({ kind: 'label', key: 'label:all', label: 'all' });
  }

  const walk = (parent: string, depth: number) => {
    for (const p of children.get(parent) ?? []) {
      rows.push({ kind: 'folder', key: `f:${p}`, path: p, name: baseName(p), depth, disabled: disabled(p), current: isCurrent(p), match: matched.has(p), recent: false });
      if (newParent !== null && newParent === p) rows.push({ kind: 'new', key: 'new', parent: p, depth: depth + 1 });
      walk(p, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/** Rows the highlight can rest on (enabled folders and the top level; the inline input is not one). */
export const isPickable = (row: MoveRow | undefined): boolean => !!row && (row.kind === 'top' || row.kind === 'folder') && !row.disabled;

/** Index of the next pickable row from `from` in direction `dir` (stays put at the ends), or -1. */
export const nextPickable = (rows: readonly MoveRow[], from: number, dir: 1 | -1): number => {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (isPickable(rows[i])) return i;
  return isPickable(rows[from]) ? from : -1;
};

/** Where the highlight starts: the newest recent target, else the top level, else the first pickable row. */
export const initialPick = (rows: readonly MoveRow[], preferred?: string | null): number => {
  if (preferred !== undefined && preferred !== null) {
    const i = rows.findIndex((r) => (r.kind === 'top' && preferred === '') || (r.kind === 'folder' && !r.recent && r.path === preferred));
    if (i >= 0 && isPickable(rows[i])) return i;
  }
  const recent = rows.findIndex((r) => r.kind === 'folder' && r.recent && !r.disabled);
  if (recent >= 0) return recent;
  return rows.findIndex(isPickable);
};

/**
 * Where the highlight starts when the dialog opens: nowhere in move mode (Move stays off until a
 * folder is chosen, so a stray Enter never moves things to the top level); the current folder in
 * pick mode, when it can be picked.
 */
export const startPick = (rows: readonly MoveRow[], mode: 'move' | 'pick', current: string | null): number => {
  if (mode === 'move' || current === null) return -1;
  const i = rows.findIndex((r) => (r.kind === 'top' && current === '') || (r.kind === 'folder' && !r.recent && r.path === current));
  return i >= 0 && isPickable(rows[i]) ? i : -1;
};

/** First pickable row that matches the search (after the text changes), or -1 when none does. */
export const firstMatch = (rows: readonly MoveRow[]): number => rows.findIndex((r) => r.kind === 'folder' && r.match && !r.disabled);
