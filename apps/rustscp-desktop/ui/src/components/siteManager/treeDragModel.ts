/**
 * Pure rules behind moving items with the pointer (drag and drop), the tree clipboard (⌘X / ⌘V),
 * copies (⌥-drop, Duplicate folder) and "New folder with selection" (spec §7, §11).
 * No React and no DOM, so `node --test` covers it.
 */
import type { ConnectionConfig } from '../../types.ts';
import type { CopyItem, SiteTreeOp, TreeModel, TreeRow } from './types.ts';
import {
  MAX_FOLDER_PATH_LEN,
  charLength,
  childFolderNames,
  folderChain,
  folderKey,
  foldersInside,
  isInside,
  joinPath,
  parentOf,
  pickFreeName,
  resolveItems,
  siteKey,
  sitesInside,
} from './siteTreeModel.ts';

/** What a drag (or a cut) carries. */
export interface DragPayload {
  /** Canonical item keys: the loose sites (`s:<id>`) and the top folders (`f:<path>`), never Local */
  keys: string[];
  /** Paths of the folders carried (none inside another) */
  folders: string[];
  /** Distinct folders the items sit in ('' = top level) */
  parents: string[];
  /** Items carried (loose sites + folders) */
  count: number;
  /** Connections a copy would create (the loose sites plus every site inside the folders) */
  connections: number;
  /** The first item, for the drag ghost */
  first: { kind: 'site'; site: ConnectionConfig } | { kind: 'folder'; name: string };
}

/**
 * The items behind these canonical keys, ready to drag or cut. Local is left out, and so is
 * anything inside a folder that is carried too; null when nothing is left.
 */
export function dragPayload(model: TreeModel, itemKeys: Iterable<string>): DragPayload | null {
  const { looseSites, folders } = resolveItems(model, itemKeys);
  const count = looseSites.length + folders.length;
  if (count === 0) return null;
  const parents = new Set<string>();
  for (const s of looseSites) parents.add(model.siteFolder.get(s.id) ?? '');
  for (const f of folders) parents.add(parentOf(f.path));
  let connections = looseSites.length;
  for (const f of folders) connections += sitesInside(model, f.path).length;
  return {
    keys: [...looseSites.map((s) => siteKey(s.id)), ...folders.map((f) => folderKey(f.path))],
    folders: folders.map((f) => f.path),
    parents: [...parents],
    count,
    connections,
    first: looseSites.length > 0 ? { kind: 'site', site: looseSites[0] } : { kind: 'folder', name: folders[0].name },
  };
}

/** Where a drop lands. */
export interface DropSpot {
  /** Folder the items go into ('' = top level) */
  folder: string;
  /** Row that shows the highlight: the folder row, or the "All connections" header for the top level */
  highlightKey: string;
  /** Folder whose rows get the block tint (null for the top level) */
  block: string | null;
}

const TOP_SPOT: DropSpot = { folder: '', highlightKey: 'sec:all', block: null };

/**
 * The drop spot for the row under the pointer (`null` row: the empty space under the rows).
 * A folder row takes the items, a site row sends them to its folder, the "All connections"
 * header and the empty space to the top level. The draft, the inline new-folder row, the
 * address row and the Favorites / Recent sections (WP7) are not drop targets.
 */
export function dropSpotForRow(row: TreeRow | null | undefined): DropSpot | null {
  if (!row) return TOP_SPOT;
  if (row.section !== 'all') return null;
  switch (row.kind) {
    case 'section':
      return TOP_SPOT;
    case 'folder':
      return { folder: row.path, highlightKey: row.key, block: row.path };
    case 'site':
    case 'placeholder':
    case 'draft':
      return row.folder ? { folder: row.folder, highlightKey: folderKey(row.folder), block: row.folder } : TOP_SPOT;
    default:
      return null;
  }
}

/** `ok`, or why a drop is refused: a folder into itself (or a folder inside it), or every item is already there. */
export type DropCheck = 'ok' | 'into_self' | 'same_place';

/** Copies may land where the items already are (that duplicates them); moves may not. */
export function checkDrop(payload: Pick<DragPayload, 'folders' | 'parents'>, folder: string, copy: boolean): DropCheck {
  if (payload.folders.some((f) => isInside(folder, f))) return 'into_self';
  if (!copy && payload.parents.every((p) => p === folder)) return 'same_place';
  return 'ok';
}

/** True when the row sits inside `block` (the drop folder's contents get a tint). */
export function inDropBlock(row: TreeRow, block: string | null): boolean {
  if (!block || row.section !== 'all') return false;
  switch (row.kind) {
    case 'folder':
      return row.path !== block && isInside(row.path, block);
    case 'site':
    case 'placeholder':
    case 'draft':
      return isInside(row.folder, block);
    case 'newFolder':
      return isInside(row.parent, block);
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Copies                                                                      */
/* -------------------------------------------------------------------------- */

export interface CopyNames {
  /** "web-01 copy" */
  first: (name: string) => string;
  /** "web-01 copy 2" */
  nth: (name: string, n: number) => string;
}

export interface CopyPlan {
  /** One batch: `copy_sites` for the loose sites, then one `copy_folder` per folder */
  ops: SiteTreeOp[];
  /** The `copy_sites` items; the backend's `created` lists them first, in this order */
  siteItems: CopyItem[];
  /** Folder copies: the source and the new path */
  folders: Array<{ from: string; to: string }>;
  /** Connections the copy creates */
  connections: number;
  /** A folder would be copied into itself */
  intoSelf: boolean;
  /** A resulting path would pass 255 characters */
  tooLong: boolean;
}

/**
 * Plans copies of the items into `target`, or each into its own folder when `target` is null
 * (Duplicate). A copy keeps its name where that name is free (ignoring case); otherwise, and so
 * always in its own folder, it gets "name copy", "name copy 2"… counting the names given earlier
 * in the same batch. Copies run on the backend, which clones every field, secrets included.
 */
export function planCopies(model: TreeModel, itemKeys: Iterable<string>, target: string | null, names: CopyNames): CopyPlan {
  const { looseSites, folders } = resolveItems(model, itemKeys);
  const siteNames = new Map<string, string[]>();
  const folderNames = new Map<string, string[]>();
  const takenIn = (cache: Map<string, string[]>, folder: string, init: () => string[]) => {
    let taken = cache.get(folder);
    if (!taken) {
      taken = init();
      cache.set(folder, taken);
    }
    return taken;
  };
  const pick = (name: string, taken: string[]) => {
    const lower = name.toLowerCase();
    const chosen = taken.some((n) => n.toLowerCase() === lower) ? pickFreeName(names.first(name), taken, (n) => names.nth(name, n)) : name;
    taken.push(chosen);
    return chosen;
  };

  const siteItems: CopyItem[] = [];
  for (const s of looseSites) {
    const dest = target ?? model.siteFolder.get(s.id) ?? '';
    const taken = takenIn(siteNames, dest, () => (model.folders.get(dest)?.sites ?? []).map((x) => x.name));
    siteItems.push({ id: s.id, name: pick(s.name, taken), group: dest || null });
  }

  let intoSelf = false;
  let tooLong = target !== null && charLength(target) > MAX_FOLDER_PATH_LEN;
  let connections = looseSites.length;
  const copies: CopyPlan['folders'] = [];
  const ops: SiteTreeOp[] = [];
  if (siteItems.length) ops.push({ op: 'copy_sites', items: siteItems });
  for (const f of folders) {
    const dest = target ?? parentOf(f.path);
    if (isInside(dest, f.path)) intoSelf = true;
    const name = pick(f.name, takenIn(folderNames, dest, () => childFolderNames(model, dest)));
    const to = joinPath(dest, name);
    let deepest = 0;
    for (const p of foldersInside(model, f.path)) deepest = Math.max(deepest, charLength(p) - charLength(f.path));
    if (charLength(to) + deepest > MAX_FOLDER_PATH_LEN) tooLong = true;
    connections += sitesInside(model, f.path).length;
    copies.push({ from: f.path, to });
    ops.push({ op: 'copy_folder', path: f.path, to: dest || null, name });
  }
  return { ops, siteItems, folders: copies, connections, intoSelf, tooLong };
}

/* -------------------------------------------------------------------------- */
/* New folder with selection                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The deepest folder that holds every item (the folder of a site, the parent of a folder);
 * '' when they share none. "New folder with selection" creates its folder there.
 */
export function commonParent(model: TreeModel, itemKeys: Iterable<string>): string {
  const { looseSites, folders } = resolveItems(model, itemKeys);
  const places = [...looseSites.map((s) => model.siteFolder.get(s.id) ?? ''), ...folders.map((f) => parentOf(f.path))];
  if (places.length === 0) return '';
  let common = folderChain(places[0]);
  for (const place of places.slice(1)) {
    const chain = folderChain(place);
    let i = 0;
    while (i < common.length && i < chain.length && common[i] === chain[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  return common.length ? common[common.length - 1] : '';
}
