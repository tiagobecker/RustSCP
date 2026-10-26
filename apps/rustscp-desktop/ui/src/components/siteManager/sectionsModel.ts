/**
 * Favorites, Recent and the first-run view state of the connections tree (spec §13, §19).
 *
 * Pure (no React, no DOM, no storage access): the callers read localStorage and send the ops.
 * `node --test` runs it with type stripping, so only erasable TypeScript is used.
 */
import type { ConnectionConfig } from '../../types.ts';
import type { FavoriteRef, SiteLayout, SiteTreeViewPatch, TreeModel } from './types.ts';
import { LOCAL_ID, MAX_COLLAPSED, MAX_FAVORITES, folderKey, normalizeGroup, parseItemKey, siteKey } from './siteTreeModel.ts';

/** Libraries with more saved sites than this open with their nested folders collapsed, once. */
export const LARGE_LIBRARY_ABOVE = 300;

/* -------------------------------------------------------------------------- */
/* Favorites                                                                   */
/* -------------------------------------------------------------------------- */

/** Canonical item key of a favorite (`s:<id>` / `f:<path>`). */
export const favoriteKey = (f: FavoriteRef): string => (f.kind === 'site' ? siteKey(f.id) : folderKey(f.path));

/** The favorite an item key names (`null` for row keys that are not items, and for the root). */
export const favoriteRefOf = (itemKey: string): FavoriteRef | null => {
  const ref = parseItemKey(itemKey);
  if (!ref) return null;
  if (ref.kind === 'site') return ref.id ? { kind: 'site', id: ref.id } : null;
  return ref.path ? { kind: 'folder', path: ref.path } : null;
};

/** Distinct favorites for these item keys, in order. */
const refsOf = (itemKeys: Iterable<string>): FavoriteRef[] => {
  const out: FavoriteRef[] = [];
  const seen = new Set<string>();
  for (const k of itemKeys) {
    const ref = favoriteRefOf(k);
    if (!ref) continue;
    const key = favoriteKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
};

/** True when there is at least one item and every one of them is a favorite. */
export const allFavorites = (model: Pick<TreeModel, 'favoriteSites' | 'favoriteFolders'>, itemKeys: Iterable<string>): boolean => {
  let any = false;
  for (const ref of refsOf(itemKeys)) {
    any = true;
    if (ref.kind === 'site' ? !model.favoriteSites.has(ref.id) : !model.favoriteFolders.has(ref.path)) return false;
  }
  return any;
};

export const sameFavorites = (a: readonly FavoriteRef[], b: readonly FavoriteRef[]): boolean =>
  a.length === b.length && a.every((f, i) => favoriteKey(f) === favoriteKey(b[i]));

/** The favorites with these items added at the end (in order, skipping ones already there), or removed. */
export function setFavorites(favorites: readonly FavoriteRef[], itemKeys: Iterable<string>, on: boolean): FavoriteRef[] {
  const refs = refsOf(itemKeys);
  const keys = new Set(refs.map(favoriteKey));
  if (!on) return favorites.filter((f) => !keys.has(favoriteKey(f)));
  const have = new Set(favorites.map(favoriteKey));
  return [...favorites, ...refs.filter((r) => !have.has(favoriteKey(r)))];
}

/** ⌥⌘↑ / ⌥⌘↓: the favorite `itemKey` moved `delta` places; null when it is not a favorite or cannot move. */
export function moveFavorite(favorites: readonly FavoriteRef[], itemKey: string, delta: number): FavoriteRef[] | null {
  const from = favorites.findIndex((f) => favoriteKey(f) === itemKey);
  if (from < 0 || delta === 0) return null;
  const to = from + delta;
  if (to < 0 || to >= favorites.length) return null;
  const next = [...favorites];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * A drop on the Favorites section: the items go at `index` (a position in the list before the
 * drop, 0 = first). Items that are favorites already move there; the others are added there.
 */
export function insertFavorites(favorites: readonly FavoriteRef[], itemKeys: Iterable<string>, index: number): FavoriteRef[] {
  const moving = refsOf(itemKeys);
  const movingKeys = new Set(moving.map(favoriteKey));
  let at = Math.max(0, Math.min(index, favorites.length));
  const kept: FavoriteRef[] = [];
  favorites.forEach((f, i) => {
    if (!movingKeys.has(favoriteKey(f))) kept.push(f);
    else if (i < at) at--;
  });
  return [...kept.slice(0, at), ...moving, ...kept.slice(at)];
}

/** `ok`, or why a drop on Favorites does nothing: the order would not change, or the list would pass 200. */
export type FavoriteDropCheck = 'ok' | 'same_place' | 'too_many';

export function checkFavoriteDrop(favorites: readonly FavoriteRef[], itemKeys: Iterable<string>, index: number): FavoriteDropCheck {
  const next = insertFavorites(favorites, itemKeys, index);
  if (sameFavorites(next, favorites)) return 'same_place';
  if (next.length > MAX_FAVORITES) return 'too_many';
  return 'ok';
}

/* -------------------------------------------------------------------------- */
/* First run and migration                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The first time a large library opens (more than 300 saved sites, `large_library_collapsed` not
 * set yet): every folder below the top level starts collapsed, unless the user already collapsed
 * folders. Returns null when there is nothing to do; otherwise the flag gets set, and `collapsed`
 * (when not null) is the new collapsed set. Top-level folders stay open.
 */
export function largeLibraryFirstRun(layout: Pick<SiteLayout, 'folders' | 'collapsed' | 'large_library_collapsed'>, savedSiteCount: number): { collapsed: string[] | null } | null {
  if (layout.large_library_collapsed || savedSiteCount <= LARGE_LIBRARY_ABOVE) return null;
  if (layout.collapsed.length > 0) return { collapsed: null };
  const nested = new Set<string>();
  for (const raw of layout.folders) {
    const p = normalizeGroup(raw);
    if (p.includes('/')) nested.add(p);
  }
  const sorted = [...nested].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { collapsed: sorted.slice(0, MAX_COLLAPSED) };
}

/**
 * The one-time move of WebView storage into the encrypted layout (spec §19), from the raw
 * localStorage values: the old sidebar's collapsed folders, and the saved-site keys of App's
 * last-remote-paths map (newest last there, so reversed) as seed for Recent.
 */
export function legacyMigrationPatch(collapsedRaw: string | null, lastPathsRaw: string | null, sites: readonly ConnectionConfig[]): SiteTreeViewPatch {
  const patch: SiteTreeViewPatch = { migrated_local_storage: true };
  try {
    const raw: unknown = JSON.parse(collapsedRaw || '[]');
    if (Array.isArray(raw)) {
      const paths = raw
        .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 1024)
        .map((p) => normalizeGroup(p))
        .filter(Boolean);
      if (paths.length) patch.collapsed = [...new Set(paths)].slice(0, MAX_COLLAPSED);
    }
  } catch {
    /* unreadable: nothing to carry over */
  }
  try {
    const raw: unknown = JSON.parse(lastPathsRaw || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const saved = new Set(sites.filter((s) => s.id !== LOCAL_ID).map((s) => s.id));
      const ids = Object.keys(raw as Record<string, unknown>)
        .reverse()
        .filter((k) => saved.has(k));
      if (ids.length) patch.seed_recents = ids;
    }
  } catch {
    /* unreadable: Recent just starts empty */
  }
  return patch;
}

/** A connection recorded in the layout's recents (newest first), like the backend's `record_recent`. */
export function recordRecent(layout: SiteLayout, id: string, atSecs: number, max: number): SiteLayout {
  if (!id || id === LOCAL_ID) return layout;
  const prev = layout.recents.find((r) => r.id === id);
  const entry = { id, at: atSecs, count: (prev?.count ?? 0) + 1 };
  return { ...layout, recents: [entry, ...layout.recents.filter((r) => r.id !== id)].slice(0, max) };
}

/** A view patch's effect on recents (`forget_recents`, `clear_recents`), applied locally. */
export function applyRecentsPatch(layout: SiteLayout, patch: SiteTreeViewPatch): SiteLayout {
  let recents = layout.recents;
  if (patch.clear_recents) recents = [];
  if (patch.forget_recents?.length) {
    const forget = new Set(patch.forget_recents);
    recents = recents.filter((r) => !forget.has(r.id));
  }
  let next = recents === layout.recents ? layout : { ...layout, recents };
  if (typeof patch.large_library_collapsed === 'boolean' && patch.large_library_collapsed !== next.large_library_collapsed) {
    next = { ...next, large_library_collapsed: patch.large_library_collapsed };
  }
  return next;
}
