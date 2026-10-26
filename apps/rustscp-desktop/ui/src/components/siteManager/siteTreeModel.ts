/**
 * Pure model of the connections tree: folder paths, the tree built from the saved sites plus the
 * layout, the flat row list the virtualized tree renders, and a local copy of the backend's tree
 * ops (for optimistic updates and the browser dev fallback).
 *
 * No React, no i18n, no DOM: the unit tests run it under `node --test` with type stripping, so
 * only erasable TypeScript is used and every runtime import ends in `.ts`.
 */
import type { ConnectionConfig, Protocol } from '../../types.ts';
import type {
  CopyItem,
  CreatedSite,
  Density,
  FavoriteRef,
  FlatRows,
  FlattenState,
  FolderNode,
  LabelDef,
  RecentEntry,
  SectionId,
  SiteLayout,
  SiteTreeErrorCode,
  SiteTreeOp,
  SortKey,
  TreeModel,
  TreeRow,
  ViewPrefs,
} from './types.ts';
import { LABEL_COLORS } from './types.ts';

/* -------------------------------------------------------------------------- */
/* Limits (same values as site_layout.rs)                                      */
/* -------------------------------------------------------------------------- */

export const LOCAL_ID = 'local';
export const SITE_LAYOUT_VERSION = 1;
/** Rust `MAX_SITE_GROUP_LEN`: longest folder path, in characters */
export const MAX_FOLDER_PATH_LEN = 255;
export const MAX_SITE_NAME_LEN = 255;
export const MAX_LABEL_NAME_LEN = 40;
export const MAX_FAVORITES = 200;
export const MAX_RECENTS = 50;
export const MAX_LABELS = 12;
export const MAX_COLLAPSED = 2_000;
export const MAX_OPS_PER_CALL = 100;
export const MAX_IDS_PER_CALL = 5_000;
export const MAX_LAYOUT_FOLDERS = 10_000;
/** Recent rows shown in the sidebar */
export const RECENT_SHOWN = 8;

export const COMFORTABLE_ROW_H = 36;
export const COMPACT_ROW_H = 28;
/** Libraries above this many saved sites start in Compact rows */
export const AUTO_COMPACT_ABOVE = 40;
/** localStorage key of the view options (JSON, never folder or site names) */
export const VIEW_PREFS_KEY = 'rustscp_site_tree_view';

/* -------------------------------------------------------------------------- */
/* Strings and paths                                                           */
/* -------------------------------------------------------------------------- */

/** Rust `char::is_control` (Unicode Cc). */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const HAS_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Length in characters (code points), like Rust's `chars().count()`. */
export const charLength = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/**
 * Folder paths are '/'-separated; blank segments, control characters and the spaces around
 * segments are dropped (like the backend's `normalize_site_group`, without its truncation).
 */
export const normalizeGroup = (raw?: string | null): string =>
  (raw ?? '')
    .split('/')
    .map((segment) => segment.replace(CONTROL_RE, '').trim())
    .filter(Boolean)
    .join('/');

/** Folder path plus every parent path ("A/B/C" → "A", "A/B", "A/B/C"). */
export const folderChain = (group: string): string[] => {
  const parts = group ? group.split('/') : [];
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
};

/** "A/B/C" → "A/B"; a top-level folder → "" */
export const parentOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};

/** "A/B/C" → "C" */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const joinPath = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name);

/** True for `ancestor` itself and everything below it. `''` (the top level) contains everything. */
export const isInside = (path: string, ancestor: string): boolean =>
  ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural, case- and accent-insensitive order ("web-2" before "web-10"). */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

/** Lowercase, without accents: "São Paulo" → "sao paulo" (same as the command palette). */
export const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/* -------------------------------------------------------------------------- */
/* Sites                                                                       */
/* -------------------------------------------------------------------------- */

/** `scp` sites are SFTP sites (the backend never returns scp). */
export const canonicalProtocol = (p: Protocol | string): string => {
  const v = String(p || '').toLowerCase();
  if (v === 'scp' || v === 'ssh') return 'sftp';
  return v;
};

export const defaultPort = (p: Protocol | string): number => {
  switch (canonicalProtocol(p)) {
    case 'sftp':
      return 22;
    case 'ftp':
    case 'ftps':
      return 21;
    case 's3':
    case 'webdav':
      return 443;
    default:
      return 0;
  }
};

/** Short text tag shown on line 2 ("SFTP"). Local shows "This computer" in the UI instead. */
export const protocolTag = (p: Protocol | string): string => {
  switch (canonicalProtocol(p)) {
    case 'sftp':
      return 'SFTP';
    case 'ftps':
      return 'FTPS';
    case 'ftp':
      return 'FTP';
    case 's3':
      return 'S3';
    case 'webdav':
      return 'WebDAV';
    case 'local':
      return 'Local';
    default:
      return String(p || '').toUpperCase();
  }
};

/** Order of the "Protocol" sort */
const PROTOCOL_ORDER = ['local', 'sftp', 'ftps', 'ftp', 's3', 'webdav'];
const protocolRank = (p: Protocol | string): number => {
  const i = PROTOCOL_ORDER.indexOf(canonicalProtocol(p));
  return i < 0 ? PROTOCOL_ORDER.length : i;
};

export const isLocalSite = (site: Pick<ConnectionConfig, 'id'>): boolean => site.id === LOCAL_ID;

const hostWithPort = (host: string, port: number, protocol: Protocol | string): string => {
  if (!port || port === defaultPort(protocol)) return host;
  // IPv6 literals need brackets before a port
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
};

const s3Bucket = (site: ConnectionConfig): string => (site.remote_root || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * Address text on line 2. Local: none. S3: host plus `/bucket` (never the access key).
 * Others: `user@host`, plus `:port` only when it differs from the protocol's default.
 */
export const siteAddress = (site: ConnectionConfig): string => {
  if (site.protocol === 'local' || isLocalSite(site)) return '';
  if (site.protocol === 's3') {
    const bucket = s3Bucket(site);
    return bucket ? `${site.host}/${bucket}` : site.host;
  }
  const user = (site.username || '').trim();
  return `${user ? `${user}@` : ''}${hostWithPort(site.host, site.port, site.protocol)}`;
};

const urlUser = (user: string) => user.replace(/[@:/%]/g, (c) => encodeURIComponent(c));

/** Address to copy: `sftp://user@host:port`, `ftps://…`, `s3://host/bucket`, `webdav://…`. Never secrets. */
export const copyAddress = (site: ConnectionConfig): string => {
  if (site.protocol === 'local' || isLocalSite(site)) return '';
  if (site.protocol === 's3') {
    const bucket = s3Bucket(site);
    return `s3://${site.host}${bucket ? `/${bucket}` : ''}`;
  }
  const scheme = canonicalProtocol(site.protocol);
  const user = (site.username || '').trim();
  return `${scheme}://${user ? `${urlUser(user)}@` : ''}${hostWithPort(site.host, site.port, site.protocol)}`;
};

/** A saved secret: a non-empty password (or the stored-secret marker), or a keyring entry. */
const hasSavedPassword = (auth: ConnectionConfig['auth'] | undefined): boolean =>
  (auth?.type === 'Password' && !!auth.value) || auth?.type === 'KeyringRef';

/**
 * True when connecting would need a password that is not saved, so the UI focuses the Password
 * field instead of starting an attempt that will fail. The stored-secret marker counts as saved.
 */
export const needsPassword = (site: ConnectionConfig): boolean => {
  if (site.protocol === 'local' || isLocalSite(site)) return false;
  const p = canonicalProtocol(site.protocol);
  if (p === 'sftp') return site.auth?.type === 'Password' && !site.auth.value;
  if (p === 's3') return !hasSavedPassword(site.auth);
  return !/^(anonymous|ftp)$/i.test((site.username || '').trim()) && !hasSavedPassword(site.auth);
};

export type AuthKind = 'password' | 'key' | 'agent' | 'none';

/** `password` (a saved secret), `key` (key file or embedded key), `agent` (SFTP without a secret type), `none`. */
export const authKind = (site: ConnectionConfig): AuthKind => {
  if (site.auth?.type === 'PrivateKey') return 'key';
  if (hasSavedPassword(site.auth)) return 'password';
  if (canonicalProtocol(site.protocol) === 'sftp' && site.auth?.type === 'None') return 'agent';
  return 'none';
};

/** Sites with the same key are duplicates (`is:dup`). `null` for Local. */
export const duplicateKey = (site: ConnectionConfig): string | null => {
  if (isLocalSite(site) || site.protocol === 'local') return null;
  const p = canonicalProtocol(site.protocol);
  return `${p}\u0001${(site.host || '').trim().toLowerCase()}\u0001${site.port || defaultPort(p)}\u0001${(site.username || '').trim()}`;
};

export const duplicateCounts = (sites: Iterable<ConnectionConfig>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const s of sites) {
    const k = duplicateKey(s);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
};

/** Number of saved sites per protocol (Local excluded), for the filter menu. */
export const protocolCounts = (sites: Iterable<ConnectionConfig>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const s of sites) {
    if (isLocalSite(s)) continue;
    const p = canonicalProtocol(s.protocol);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
};

/* -------------------------------------------------------------------------- */
/* Item keys                                                                   */
/* -------------------------------------------------------------------------- */

export const siteKey = (id: string): string => `s:${id}`;
export const folderKey = (path: string): string => `f:${path}`;

export type ItemRef = { kind: 'site'; id: string } | { kind: 'folder'; path: string };

/** Canonical item key → item (`null` for section, draft, address and other row keys). */
export const parseItemKey = (key: string): ItemRef | null => {
  if (key.startsWith('s:')) return { kind: 'site', id: key.slice(2) };
  if (key.startsWith('f:')) return { kind: 'folder', path: key.slice(2) };
  return null;
};

/** Separates a favorite folder's key from the keys of the rows shown inside it. */
const FAV_NEST = '\u001f';

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export const defaultLayout = (): SiteLayout => ({
  version: SITE_LAYOUT_VERSION,
  folders: [],
  favorites: [],
  recents: [],
  labels: [],
  site_labels: {},
  folder_labels: {},
  collapsed: [],
  migrated_local_storage: false,
  large_library_collapsed: false,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const stringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
};

/** Fills in missing or malformed fields of a layout that came over IPC (never throws). */
export const coerceLayout = (raw: unknown): SiteLayout => {
  const base = defaultLayout();
  if (!isRecord(raw)) return base;
  const favorites: FavoriteRef[] = [];
  if (Array.isArray(raw.favorites)) {
    for (const f of raw.favorites) {
      if (!isRecord(f)) continue;
      if (f.kind === 'site' && typeof f.id === 'string') favorites.push({ kind: 'site', id: f.id });
      else if (f.kind === 'folder' && typeof f.path === 'string') favorites.push({ kind: 'folder', path: f.path });
    }
  }
  const recents: RecentEntry[] = [];
  if (Array.isArray(raw.recents)) {
    for (const r of raw.recents) {
      if (!isRecord(r) || typeof r.id !== 'string') continue;
      recents.push({
        id: r.id,
        at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : null,
        count: typeof r.count === 'number' && Number.isFinite(r.count) ? r.count : 0,
      });
    }
  }
  const labels: LabelDef[] = [];
  if (Array.isArray(raw.labels)) {
    for (const l of raw.labels) {
      if (!isRecord(l) || typeof l.id !== 'string' || typeof l.name !== 'string') continue;
      const color = LABEL_COLORS.includes(l.color as never) ? (l.color as LabelDef['color']) : 'gray';
      labels.push({ id: l.id, name: l.name, color });
    }
  }
  return {
    version: typeof raw.version === 'number' ? raw.version : base.version,
    folders: stringArray(raw.folders),
    favorites,
    recents,
    labels,
    site_labels: stringMap(raw.site_labels),
    folder_labels: stringMap(raw.folder_labels),
    collapsed: stringArray(raw.collapsed),
    migrated_local_storage: raw.migrated_local_storage === true,
    large_library_collapsed: raw.large_library_collapsed === true,
  };
};

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A path for the layout, or `null` when Rust's strict `normalize_folder_path` would refuse it. */
const strictOrNull = (raw: string): string | null => {
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    const seg = part.trim();
    if (!seg) continue;
    if (HAS_CONTROL_RE.test(seg)) return null;
    segments.push(seg);
  }
  const path = segments.join('/');
  return path && charLength(path) <= MAX_FOLDER_PATH_LEN ? path : null;
};

const VALID_LABEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Local mirror of Rust `reconcile`: adds every folder a site names (ancestors included, never for
 * Local), normalizes paths, drops favorites, labels, recents and collapsed entries that point at
 * missing sites, folders or labels, de-duplicates and enforces the caps. Returns a new layout.
 */
export const reconcileLayout = (layout: SiteLayout, sites: readonly ConnectionConfig[]): SiteLayout => {
  const siteIds = new Set<string>();
  const implied = new Set<string>();
  for (const s of sites) {
    siteIds.add(s.id);
    if (isLocalSite(s)) continue;
    for (const c of folderChain(normalizeGroup(s.group))) implied.add(c);
  }
  const folderSet = new Set<string>();
  for (const raw of layout.folders) {
    const p = strictOrNull(raw);
    if (p) for (const c of folderChain(p)) folderSet.add(c);
  }
  for (const f of implied) folderSet.add(f);
  let folders = [...folderSet].sort(byCodeUnits);
  if (folders.length > MAX_LAYOUT_FOLDERS) {
    // Deepest-last order: a folder goes only after everything inside it went; implied ones stay
    let excess = folders.length - MAX_LAYOUT_FOLDERS;
    const drop = new Set<string>();
    for (let i = folders.length - 1; i >= 0 && excess > 0; i--) {
      if (implied.has(folders[i])) continue;
      drop.add(folders[i]);
      excess--;
    }
    folders = folders.filter((f) => !drop.has(f));
    for (const f of drop) folderSet.delete(f);
  }

  const labels: LabelDef[] = [];
  const labelIds = new Set<string>();
  for (const l of layout.labels) {
    const name = [...l.name.trim()].slice(0, MAX_LABEL_NAME_LEN).join('').trim();
    if (!VALID_LABEL_ID.test(l.id) || !name || labelIds.has(l.id)) continue;
    labelIds.add(l.id);
    labels.push({ ...l, name });
    if (labels.length === MAX_LABELS) break;
  }

  const favorites: FavoriteRef[] = [];
  const favSeen = new Set<string>();
  for (const f of layout.favorites) {
    let fav: FavoriteRef;
    if (f.kind === 'site') {
      if (!siteIds.has(f.id)) continue;
      fav = { kind: 'site', id: f.id };
    } else {
      const p = strictOrNull(f.path);
      if (!p || !folderSet.has(p)) continue;
      fav = { kind: 'folder', path: p };
    }
    const key = fav.kind === 'site' ? siteKey(fav.id) : folderKey(fav.path);
    if (favSeen.has(key)) continue;
    favSeen.add(key);
    favorites.push(fav);
    if (favorites.length === MAX_FAVORITES) break;
  }

  const recents: RecentEntry[] = [];
  const recentSeen = new Set<string>();
  for (const r of layout.recents) {
    if (r.id === LOCAL_ID || !siteIds.has(r.id) || recentSeen.has(r.id)) continue;
    recentSeen.add(r.id);
    recents.push({ id: r.id, at: r.at ?? null, count: r.count ?? 0 });
    if (recents.length === MAX_RECENTS) break;
  }

  // Sorted keys, like Rust's BTreeMap, so equal layouts serialize the same
  const byKey = (a: [string, string], b: [string, string]) => byCodeUnits(a[0], b[0]);
  const site_labels: Record<string, string> = {};
  for (const [id, label] of Object.entries(layout.site_labels).sort(byKey)) {
    if (siteIds.has(id) && labelIds.has(label)) site_labels[id] = label;
  }
  const folderLabelPairs: Array<[string, string]> = [];
  const labelled = new Set<string>();
  for (const [raw, label] of Object.entries(layout.folder_labels).sort(byKey)) {
    const p = strictOrNull(raw);
    if (!p || !folderSet.has(p) || !labelIds.has(label) || labelled.has(p)) continue;
    labelled.add(p);
    folderLabelPairs.push([p, label]);
  }
  const folder_labels: Record<string, string> = {};
  for (const [p, label] of folderLabelPairs.sort(byKey)) folder_labels[p] = label;

  const collapsed = new Set<string>();
  for (const raw of [...layout.collapsed].sort(byCodeUnits)) {
    if (collapsed.size === MAX_COLLAPSED) break;
    const p = strictOrNull(raw);
    if (p && folderSet.has(p)) collapsed.add(p);
  }

  return {
    ...layout,
    version: layout.version || SITE_LAYOUT_VERSION,
    folders,
    favorites,
    recents,
    labels,
    site_labels,
    folder_labels,
    collapsed: [...collapsed].sort(byCodeUnits),
  };
};

/* -------------------------------------------------------------------------- */
/* View options                                                                */
/* -------------------------------------------------------------------------- */

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  sort: 'name',
  foldersOnTop: true,
  density: null,
  showAddress: true,
  showFavorites: true,
  showRecent: true,
  resultsAsList: false,
};

const SORT_KEYS: readonly SortKey[] = ['name', 'address', 'protocol', 'last'];

/** Validates stored view options (anything unknown falls back to the default). */
export const parseViewPrefs = (raw: unknown): ViewPrefs => {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
  }
  const out: ViewPrefs = { ...DEFAULT_VIEW_PREFS };
  if (!isRecord(v)) return out;
  if (SORT_KEYS.includes(v.sort as SortKey)) out.sort = v.sort as SortKey;
  if (v.density === 'compact' || v.density === 'comfortable') out.density = v.density;
  for (const k of ['foldersOnTop', 'showAddress', 'showFavorites', 'showRecent', 'resultsAsList'] as const) {
    if (typeof v[k] === 'boolean') out[k] = v[k] as boolean;
  }
  return out;
};

/** Comfortable up to 40 saved sites, Compact above, until the user picks one. */
export const effectiveDensity = (prefs: Pick<ViewPrefs, 'density'>, savedSiteCount: number): Density =>
  prefs.density ?? (savedSiteCount > AUTO_COMPACT_ABOVE ? 'compact' : 'comfortable');

export const rowHeightFor = (density: Density): number => (density === 'compact' ? COMPACT_ROW_H : COMFORTABLE_ROW_H);

/** Left padding of a row at `depth` (spec §3): 12px per level for six levels, then 6px per level. */
export const rowIndent = (depth: number): number => 6 + Math.min(depth, 6) * 12 + Math.max(0, depth - 6) * 6;

const numberFormats = new Map<string, Intl.NumberFormat>();
/** `n` formatted for the UI language ("2,014" / "2.014"); formatters are cached per language. */
export const formatCount = (lang: string, n: number): string => {
  let nf = numberFormats.get(lang);
  if (!nf) {
    nf = new Intl.NumberFormat(lang || undefined);
    numberFormats.set(lang, nf);
  }
  return nf.format(n);
};

/* -------------------------------------------------------------------------- */
/* Tree                                                                        */
/* -------------------------------------------------------------------------- */

export type TreeChild = { kind: 'folder'; folder: FolderNode } | { kind: 'site'; site: ConnectionConfig };

/** Children of a folder in display order (Local first at the top level). */
export const folderChildren = (node: FolderNode): TreeChild[] => (node as FolderNodeInternal).children;

interface FolderNodeInternal extends FolderNode {
  children: TreeChild[];
}

const newNode = (path: string, name: string, parent: string, depth: number): FolderNodeInternal => ({
  path,
  name,
  parent,
  depth,
  folders: [],
  sites: [],
  count: 0,
  folderCount: 0,
  explicit: false,
  label: null,
  effectiveLabel: null,
  lastAt: null,
  children: [],
});

export interface SortPrefs {
  sort?: SortKey;
  foldersOnTop?: boolean;
}

const idCompare = (a: ConnectionConfig, b: ConnectionConfig) => byCodeUnits(a.id, b.id);

/**
 * Builds the tree from the saved sites (redacted is fine) and the layout: explicit ∪ implied
 * folders, sorted children, counts, inherited labels, favorites and recents that still resolve.
 * O(n log n); rebuild only when the sites, the layout or the sort change.
 */
export function buildTree(sites: readonly ConnectionConfig[], layout?: SiteLayout | null, prefs?: SortPrefs): TreeModel {
  const sort: SortKey = prefs?.sort ?? 'name';
  const foldersOnTop = prefs?.foldersOnTop ?? true;

  const root = newNode('', '', '', -1);
  const folders = new Map<string, FolderNodeInternal>([['', root]]);
  const ensure = (path: string): FolderNodeInternal => {
    const found = folders.get(path);
    if (found) return found;
    const parentPath = parentOf(path);
    const parent = ensure(parentPath);
    const node = newNode(path, baseName(path), parentPath, parent.depth + 1);
    folders.set(path, node);
    parent.folders.push(node);
    return node;
  };

  for (const raw of layout?.folders ?? []) {
    const p = normalizeGroup(raw);
    if (p) ensure(p).explicit = true;
  }

  const sitesById = new Map<string, ConnectionConfig>();
  const siteFolder = new Map<string, string>();
  let local: ConnectionConfig | null = null;
  for (const site of sites) {
    if (!site || typeof site.id !== 'string' || sitesById.has(site.id)) continue;
    sitesById.set(site.id, site);
    if (isLocalSite(site)) {
      local = site;
      siteFolder.set(site.id, '');
      root.sites.push(site);
      continue;
    }
    const g = normalizeGroup(site.group);
    siteFolder.set(site.id, g);
    ensure(g).sites.push(site);
  }

  const recentAt = new Map<string, number | null>();
  const recents: RecentEntry[] = [];
  for (const r of layout?.recents ?? []) {
    if (!r || r.id === LOCAL_ID || !sitesById.has(r.id) || recentAt.has(r.id)) continue;
    const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : null;
    recentAt.set(r.id, at);
    recents.push({ id: r.id, at, count: r.count ?? 0 });
  }

  const favorites: FavoriteRef[] = [];
  const favoriteSites = new Set<string>();
  const favoriteFolders = new Set<string>();
  for (const f of layout?.favorites ?? []) {
    if (f?.kind === 'site') {
      if (!sitesById.has(f.id) || favoriteSites.has(f.id)) continue;
      favoriteSites.add(f.id);
      favorites.push({ kind: 'site', id: f.id });
    } else if (f?.kind === 'folder') {
      const p = normalizeGroup(f.path);
      if (!p || !folders.has(p) || favoriteFolders.has(p)) continue;
      favoriteFolders.add(p);
      favorites.push({ kind: 'folder', path: p });
    }
  }

  const labels = new Map<string, LabelDef>();
  for (const l of layout?.labels ?? []) if (l && typeof l.id === 'string' && !labels.has(l.id)) labels.set(l.id, l);
  for (const [raw, id] of Object.entries(layout?.folder_labels ?? {})) {
    const node = folders.get(normalizeGroup(raw));
    if (node && node.path && labels.has(id)) node.label = id;
  }
  const ownSiteLabels = new Map(Object.entries(layout?.site_labels ?? {}));
  const siteLabel = new Map<string, string>();

  // "Last connected" rank: a time, then entries with no time, then never used
  const lastRank = (id: string): number => {
    if (!recentAt.has(id)) return -2;
    return recentAt.get(id) ?? -1;
  };
  const byName = (a: ConnectionConfig, b: ConnectionConfig) =>
    naturalCompare(a.name || '', b.name || '') || naturalCompare(a.host || '', b.host || '') || idCompare(a, b);
  const siteCompare = (a: ConnectionConfig, b: ConnectionConfig): number => {
    if (isLocalSite(a)) return -1;
    if (isLocalSite(b)) return 1;
    switch (sort) {
      case 'address':
        return (
          naturalCompare(a.host || '', b.host || '') ||
          (a.port || 0) - (b.port || 0) ||
          naturalCompare(a.username || '', b.username || '') ||
          byName(a, b)
        );
      case 'protocol':
        return protocolRank(a.protocol) - protocolRank(b.protocol) || byName(a, b);
      case 'last':
        return lastRank(b.id) - lastRank(a.id) || byName(a, b);
      default:
        return byName(a, b);
    }
  };
  const folderCompare = (a: FolderNode, b: FolderNode): number => {
    if (sort === 'last') {
      const d = (b.lastAt ?? -1) - (a.lastAt ?? -1);
      if (d) return d;
    }
    return naturalCompare(a.name, b.name) || byCodeUnits(a.name, b.name);
  };

  const finish = (node: FolderNodeInternal): void => {
    let count = 0;
    let folderCount = 0;
    let lastAt: number | null = null;
    for (const child of node.folders) {
      const c = child as FolderNodeInternal;
      c.effectiveLabel = c.label ?? node.effectiveLabel;
      finish(c);
      count += c.count;
      folderCount += 1 + c.folderCount;
      if (c.lastAt !== null && (lastAt === null || c.lastAt > lastAt)) lastAt = c.lastAt;
    }
    for (const site of node.sites) {
      const own = ownSiteLabels.get(site.id);
      const eff = own && labels.has(own) ? own : node.effectiveLabel;
      if (eff) siteLabel.set(site.id, eff);
      if (!isLocalSite(site)) count++;
      const at = recentAt.get(site.id);
      if (typeof at === 'number' && (lastAt === null || at > lastAt)) lastAt = at;
    }
    node.count = count;
    node.folderCount = folderCount;
    node.lastAt = lastAt;
    node.folders.sort(folderCompare);
    node.sites.sort(siteCompare);

    const folderItems: TreeChild[] = node.folders.map((folder) => ({ kind: 'folder', folder }));
    const siteItems: TreeChild[] = node.sites.map((site) => ({ kind: 'site', site }));
    const first = siteItems[0];
    const localItems = first?.kind === 'site' && isLocalSite(first.site) ? siteItems.splice(0, 1) : [];
    if (foldersOnTop || sort === 'address' || sort === 'protocol') {
      // Folders have no address or protocol: with those sorts they stay together
      node.children = foldersOnTop ? [...localItems, ...folderItems, ...siteItems] : [...localItems, ...siteItems, ...folderItems];
    } else {
      const merged = [...folderItems, ...siteItems];
      const keyName = (c: TreeChild) => (c.kind === 'folder' ? c.folder.name : c.site.name || '');
      const keyLast = (c: TreeChild) => (c.kind === 'folder' ? c.folder.lastAt ?? -1 : lastRank(c.site.id));
      merged.sort((a, b) => (sort === 'last' ? keyLast(b) - keyLast(a) : 0) || naturalCompare(keyName(a), keyName(b)) || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1));
      node.children = [...localItems, ...merged];
    }
  };
  finish(root);

  return {
    root,
    folders,
    sitesById,
    siteFolder,
    local,
    totalSites: root.count,
    totalFolders: folders.size - 1,
    favorites,
    favoriteSites,
    favoriteFolders,
    recents,
    recentAt,
    labels,
    siteLabel,
  };
}

/** Every saved site inside a folder, all levels (Local never). */
export const sitesInside = (model: TreeModel, path: string): ConnectionConfig[] => {
  const node = model.folders.get(path);
  if (!node) return [];
  const out: ConnectionConfig[] = [];
  const walk = (n: FolderNode) => {
    for (const s of n.sites) if (!isLocalSite(s)) out.push(s);
    for (const f of n.folders) walk(f);
  };
  walk(node);
  return out;
};

/** Every folder path strictly inside `path` (all levels). */
export const foldersInside = (model: TreeModel, path: string): string[] => {
  const node = model.folders.get(path);
  if (!node) return [];
  const out: string[] = [];
  const walk = (n: FolderNode) => {
    for (const f of n.folders) {
      out.push(f.path);
      walk(f);
    }
  };
  walk(node);
  return out;
};

/** True when a site sits in a favorite folder (or one above it). */
export const inFavoriteFolder = (model: TreeModel, siteId: string): boolean => {
  if (model.favoriteFolders.size === 0) return false;
  const g = model.siteFolder.get(siteId);
  return !!g && folderChain(g).some((p) => model.favoriteFolders.has(p));
};

/* -------------------------------------------------------------------------- */
/* Selections                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolvedItems {
  /** Saved sites among the items (never Local), in item order */
  sites: ConnectionConfig[];
  /** Selected folders, without those inside another selected folder */
  folders: FolderNode[];
  /** `sites` minus the ones inside a selected folder (those go with their folder) */
  looseSites: ConnectionConfig[];
  /** Local was among the items (actions skip it) */
  local: boolean;
}

/** Canonical item keys (`s:<id>`, `f:<path>`) → the sites and folders they name. Unknown keys are ignored. */
export const resolveItems = (model: TreeModel, itemKeys: Iterable<string>): ResolvedItems => {
  const sites: ConnectionConfig[] = [];
  const nodes: FolderNode[] = [];
  const seen = new Set<string>();
  let local = false;
  for (const key of itemKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = parseItemKey(key);
    if (ref?.kind === 'site') {
      const site = model.sitesById.get(ref.id);
      if (!site) continue;
      if (isLocalSite(site)) local = true;
      else sites.push(site);
    } else if (ref?.kind === 'folder') {
      const node = model.folders.get(ref.path);
      if (node && node.path) nodes.push(node);
    }
  }
  const folders = nodes.filter((f) => !nodes.some((o) => o.path !== f.path && isInside(f.path, o.path)));
  const looseSites = sites.filter((s) => {
    const g = model.siteFolder.get(s.id) ?? '';
    return !g || !folders.some((f) => isInside(g, f.path));
  });
  return { sites, folders, looseSites, local };
};

/** Saved sites per protocol tag, most first ("28 SFTP · 4 FTPS"); Local is never counted. */
export const protocolBreakdown = (sites: Iterable<ConnectionConfig>): Array<{ protocol: string; tag: string; count: number }> =>
  [...protocolCounts(sites)]
    .map(([protocol, count]) => ({ protocol, tag: protocolTag(protocol), count }))
    .sort((a, b) => b.count - a.count || protocolRank(a.protocol) - protocolRank(b.protocol));

export interface FolderMove {
  from: string;
  /** Path after the move (the existing folder when it merges) */
  to: string;
  merges: boolean;
}

export interface MovePlan {
  /** One batch: `create_folder` for a new target, `move_sites`, then one `move_folder` per folder */
  ops: SiteTreeOp[];
  /** Sites that change folder (those inside moved folders go with them and are not listed) */
  sites: ConnectionConfig[];
  /** Folders that change parent */
  folders: FolderMove[];
  /** Moved folders whose name is taken in the target, ignoring case (Merge joins them) */
  clashes: Array<{ path: string; existing: string }>;
  /** A folder would go inside itself */
  intoSelf: boolean;
  /** A resulting path would pass 255 characters */
  tooLong: boolean;
}

/**
 * Plans "Move to…" (and drops): items already in `target` are left out, sites inside a moved folder
 * go with it, a folder whose name exists in the target (or among the folders moved with it) is a
 * clash that needs `merge`. `createTarget` adds `create_folder` when the target does not exist yet
 * (a folder made in the Move dialog), so the whole move is one undoable batch.
 */
export function planMove(
  model: TreeModel,
  itemKeys: Iterable<string>,
  rawTarget: string,
  opts: { merge?: boolean; createTarget?: boolean } = {}
): MovePlan {
  const target = normalizeGroup(rawTarget);
  const { looseSites, folders } = resolveItems(model, itemKeys);
  const sites = looseSites.filter((s) => (model.siteFolder.get(s.id) ?? '') !== target);
  const moving = folders.filter((f) => parentOf(f.path) !== target);
  const intoSelf = moving.some((f) => isInside(target, f.path));

  // Names already used in the target, plus the folders landing there as the plan goes
  const taken = new Map<string, string>();
  for (const child of model.folders.get(target)?.folders ?? []) taken.set(child.name.toLowerCase(), child.path);
  const clashes: MovePlan['clashes'] = [];
  const moves: FolderMove[] = [];
  let tooLong = charLength(target) > MAX_FOLDER_PATH_LEN;
  for (const f of moving) {
    const lower = f.name.toLowerCase();
    const existing = taken.get(lower);
    const to = existing ?? joinPath(target, f.name);
    if (existing !== undefined) clashes.push({ path: f.path, existing });
    else taken.set(lower, to);
    let deepest = 0;
    for (const p of foldersInside(model, f.path)) deepest = Math.max(deepest, charLength(p) - charLength(f.path));
    if (charLength(to) + deepest > MAX_FOLDER_PATH_LEN) tooLong = true;
    moves.push({ from: f.path, to, merges: existing !== undefined });
  }

  const ops: SiteTreeOp[] = [];
  if (opts.createTarget && target && !model.folders.has(target) && (sites.length > 0 || moves.length > 0)) ops.push({ op: 'create_folder', path: target });
  if (sites.length) ops.push({ op: 'move_sites', ids: sites.map((s) => s.id), to: target || null });
  for (const m of moves) {
    ops.push(opts.merge ? { op: 'move_folder', path: m.from, to: target || null, merge: true } : { op: 'move_folder', path: m.from, to: target || null });
  }
  return { ops, sites, folders: moves, clashes, intoSelf, tooLong };
}

/**
 * Copies for Duplicate: each keeps its folder and gets the first free name there
 * ("web-01 copy", "web-01 copy 2"…), counting the names given earlier in the same batch.
 */
export const duplicateItems = (
  model: TreeModel,
  sites: readonly ConnectionConfig[],
  firstName: (name: string) => string,
  nthName: (name: string, n: number) => string
): CopyItem[] => {
  const takenByFolder = new Map<string, string[]>();
  const out: CopyItem[] = [];
  for (const s of sites) {
    if (isLocalSite(s)) continue;
    const folder = model.siteFolder.get(s.id) ?? '';
    let taken = takenByFolder.get(folder);
    if (!taken) {
      taken = (model.folders.get(folder)?.sites ?? []).map((x) => x.name);
      takenByFolder.set(folder, taken);
    }
    const name = pickFreeName(firstName(s.name), taken, (n) => nthName(s.name, n));
    taken.push(name);
    out.push({ id: s.id, name, group: folder || null });
  }
  return out;
};

/* -------------------------------------------------------------------------- */
/* Flat rows                                                                   */
/* -------------------------------------------------------------------------- */

/** The deepest folder of `raw`'s chain that exists ('' when none does). */
const deepestExisting = (model: TreeModel, raw: string): string => {
  const chain = folderChain(normalizeGroup(raw));
  for (let i = chain.length - 1; i >= 0; i--) if (model.folders.has(chain[i])) return chain[i];
  return '';
};

/**
 * Turns the tree into the rows the virtualized list renders, in order, with ARIA level, setsize
 * and posinset. O(visible rows) when browsing; O(matches) while searching.
 *
 * - Browsing: Favorites and Recent (when shown and not empty), then All connections.
 *   The draft row and the new-folder row sit in their folder (whose ancestors are forced open);
 *   an expanded folder with no children gets a placeholder row.
 * - Searching "in folders": matching sites plus the folders above them, expanded unless collapsed
 *   during this search; counts show matches; Favorites, Recent, draft and placeholders are hidden.
 * - Searching "as a list" (`search.ranked`): one flat level of items in rank order.
 * - The address row comes first when nothing matches, last otherwise.
 */
export function flattenRows(model: TreeModel, state: FlattenState): FlatRows {
  const rows: TreeRow[] = [];
  const search = state.search ?? null;
  const collapsedSections = state.collapsedSections ?? new Set<SectionId>();

  const pushSite = (
    key: string,
    section: SectionId | null,
    site: ConnectionConfig,
    depth: number,
    level: number,
    setsize: number,
    posinset: number,
    extra?: { recentAt?: number | null; showPath?: boolean }
  ) => {
    rows.push({
      kind: 'site',
      key,
      section,
      depth,
      level,
      setsize,
      posinset,
      itemKey: siteKey(site.id),
      site,
      folder: model.siteFolder.get(site.id) ?? '',
      label: model.siteLabel.get(site.id) ?? null,
      favorite: model.favoriteSites.has(site.id),
      recentAt: extra?.recentAt ?? null,
      showPath: extra?.showPath ?? false,
    });
  };

  const pushFolder = (
    key: string,
    section: SectionId | null,
    node: FolderNode,
    depth: number,
    level: number,
    setsize: number,
    posinset: number,
    expanded: boolean,
    count: number
  ) => {
    rows.push({
      kind: 'folder',
      key,
      section,
      depth,
      level,
      setsize,
      posinset,
      itemKey: folderKey(node.path),
      path: node.path,
      name: node.name,
      expanded,
      count,
      empty: node.folders.length === 0 && node.sites.length === 0,
      label: node.effectiveLabel,
      favorite: model.favoriteFolders.has(node.path),
    });
  };

  /* ---------------------------- search: list ----------------------------- */
  if (search?.ranked) {
    const items: Array<{ kind: 'site'; site: ConnectionConfig } | { kind: 'folder'; node: FolderNode }> = [];
    for (const key of search.ranked) {
      const ref = parseItemKey(key);
      if (ref?.kind === 'site') {
        const site = model.sitesById.get(ref.id);
        if (site) items.push({ kind: 'site', site });
      } else if (ref?.kind === 'folder') {
        const node = model.folders.get(ref.path);
        if (node && node.path) items.push({ kind: 'folder', node });
      }
    }
    const withAddress = !!state.address;
    const setsize = items.length + (withAddress ? 1 : 0);
    let pos = 0;
    const pushAddress = () => {
      rows.push({ kind: 'address', key: 'addr', section: null, depth: 0, level: 1, setsize, posinset: ++pos, address: state.address as string });
    };
    if (withAddress && items.length === 0) pushAddress();
    for (const item of items) {
      if (item.kind === 'site') pushSite(siteKey(item.site.id), 'all', item.site, 0, 1, setsize, ++pos, { showPath: true });
      else pushFolder(folderKey(item.node.path), 'all', item.node, 0, 1, setsize, ++pos, false, item.node.count);
    }
    if (withAddress && items.length > 0) pushAddress();
    return finishRows(rows);
  }

  /* --------------------------- search: folders --------------------------- */
  if (search) {
    const visible = new Set<string>();
    const matchCount = new Map<string, number>();
    let matches = 0;
    for (const id of search.siteIds) {
      const site = model.sitesById.get(id);
      if (!site) continue;
      if (!isLocalSite(site)) matches++;
      const g = model.siteFolder.get(id) ?? '';
      for (const p of folderChain(g)) {
        visible.add(p);
        matchCount.set(p, (matchCount.get(p) ?? 0) + 1);
      }
    }
    for (const path of search.folderPaths) {
      if (!model.folders.has(path)) continue;
      for (const p of folderChain(path)) visible.add(p);
    }
    const anyMatch = search.siteIds.size > 0 || visible.size > 0;
    const withAddress = !!state.address;
    const topSize = 1 + (withAddress ? 1 : 0);
    let topPos = 0;
    const pushAddress = () => {
      rows.push({ kind: 'address', key: 'addr', section: null, depth: 0, level: 1, setsize: topSize, posinset: ++topPos, address: state.address as string });
    };
    if (withAddress && !anyMatch) pushAddress();
    const allExpanded = !collapsedSections.has('all');
    rows.push({ kind: 'section', key: 'sec:all', section: 'all', sectionId: 'all', depth: 0, level: 1, setsize: topSize, posinset: ++topPos, expanded: allExpanded, count: matches });
    if (allExpanded) {
      const searchCollapsed = state.searchCollapsed ?? new Set<string>();
      const walk = (node: FolderNode, depth: number) => {
        const kids = folderChildren(node).filter((c) => (c.kind === 'folder' ? visible.has(c.folder.path) : search.siteIds.has(c.site.id)));
        kids.forEach((c, i) => {
          if (c.kind === 'site') {
            pushSite(siteKey(c.site.id), 'all', c.site, depth, depth + 2, kids.length, i + 1);
            return;
          }
          const expanded = !searchCollapsed.has(c.folder.path);
          pushFolder(folderKey(c.folder.path), 'all', c.folder, depth, depth + 2, kids.length, i + 1, expanded, matchCount.get(c.folder.path) ?? 0);
          if (expanded) walk(c.folder, depth + 1);
        });
      };
      walk(model.root, 0);
    }
    if (withAddress && anyMatch) pushAddress();
    return finishRows(rows);
  }

  /* ------------------------------ browsing ------------------------------- */
  const favoriteExpanded = state.favoriteExpanded ?? new Set<string>();
  const showFav = state.showFavorites !== false && model.favorites.length > 0;
  const recentRows = state.showRecent === false ? [] : model.recents.filter((r) => !model.favoriteSites.has(r.id)).slice(0, state.recentLimit ?? RECENT_SHOWN);
  const showRec = recentRows.length > 0;
  const topSize = 1 + (showFav ? 1 : 0) + (showRec ? 1 : 0);
  let topPos = 0;

  // Placement of the draft and new-folder rows; their folder chains are forced open
  const draft = state.draft ?? null;
  const draftFolder = draft ? deepestExisting(model, draft.folder) : null;
  const newFolder = state.newFolder ?? null;
  const newFolderParent = newFolder ? (model.folders.has(normalizeGroup(newFolder.parent)) ? normalizeGroup(newFolder.parent) : '') : null;
  const forcedOpen = new Set<string>();
  if (draftFolder) for (const p of folderChain(draftFolder)) forcedOpen.add(p);
  if (newFolderParent) for (const p of folderChain(newFolderParent)) forcedOpen.add(p);
  const isExpanded = (path: string) => forcedOpen.has(path) || !state.collapsed.has(path);

  /** Children of `node` in the All section or inside an expanded favorite folder. */
  const walk = (node: FolderNode, depth: number, levelBase: number, section: SectionId, keyPrefix: string, withInline: boolean) => {
    const kids = folderChildren(node);
    const localFirst = kids.length > 0 && kids[0].kind === 'site' && isLocalSite(kids[0].site) ? 1 : 0;
    const extraNew = withInline && newFolderParent === node.path ? 1 : 0;
    const extraDraft = withInline && draftFolder === node.path ? 1 : 0;
    const setsize = kids.length + extraNew + extraDraft;
    if (setsize === 0) {
      if (node.path) {
        rows.push({ kind: 'placeholder', key: `${keyPrefix}ph:${node.path}`, section, depth, level: depth + levelBase, setsize: 1, posinset: 1, folder: node.path });
      }
      return;
    }
    let pos = 0;
    const emitChild = (c: TreeChild) => {
      if (c.kind === 'site') {
        pushSite(`${keyPrefix}${siteKey(c.site.id)}`, section, c.site, depth, depth + levelBase, setsize, ++pos);
        return;
      }
      const expanded = isExpanded(c.folder.path);
      pushFolder(`${keyPrefix}${folderKey(c.folder.path)}`, section, c.folder, depth, depth + levelBase, setsize, ++pos, expanded, c.folder.count);
      if (expanded) walk(c.folder, depth + 1, levelBase, section, keyPrefix, withInline);
    };
    for (let i = 0; i < localFirst; i++) emitChild(kids[i]);
    if (extraNew && newFolder) {
      rows.push({ kind: 'newFolder', key: 'newfolder', section, depth, level: depth + levelBase, setsize, posinset: ++pos, parent: node.path, name: newFolder.name });
    }
    if (extraDraft && draft) {
      rows.push({ kind: 'draft', key: 'draft', section, depth, level: depth + levelBase, setsize, posinset: ++pos, folder: node.path, name: draft.name });
    }
    for (let i = localFirst; i < kids.length; i++) emitChild(kids[i]);
  };

  // While a drag runs, an empty (but shown) Favorites section offers a drop zone at the top
  if (!showFav && state.favDropZone && state.showFavorites !== false) {
    rows.push({ kind: 'favDrop', key: 'favdrop', section: 'fav', depth: 0, level: 1, setsize: topSize, posinset: 0 });
  }

  if (showFav) {
    const expanded = !collapsedSections.has('fav');
    rows.push({ kind: 'section', key: 'sec:fav', section: 'fav', sectionId: 'fav', depth: 0, level: 1, setsize: topSize, posinset: ++topPos, expanded, count: model.favorites.length });
    if (expanded) {
      const n = model.favorites.length;
      model.favorites.forEach((f, i) => {
        if (f.kind === 'site') {
          const site = model.sitesById.get(f.id);
          if (site) pushSite(`fav:${siteKey(f.id)}`, 'fav', site, 0, 2, n, i + 1, { showPath: true });
          return;
        }
        const node = model.folders.get(f.path);
        if (!node) return;
        const key = `fav:${folderKey(f.path)}`;
        const open = favoriteExpanded.has(f.path);
        pushFolder(key, 'fav', node, 0, 2, n, i + 1, open, node.count);
        if (open) walk(node, 1, 2, 'fav', `${key}${FAV_NEST}`, false);
      });
    }
  }

  if (showRec) {
    const expanded = !collapsedSections.has('rec');
    rows.push({ kind: 'section', key: 'sec:rec', section: 'rec', sectionId: 'rec', depth: 0, level: 1, setsize: topSize, posinset: ++topPos, expanded, count: recentRows.length });
    if (expanded) {
      recentRows.forEach((r, i) => {
        const site = model.sitesById.get(r.id);
        if (site) pushSite(`rec:${r.id}`, 'rec', site, 0, 2, recentRows.length, i + 1, { recentAt: r.at ?? null, showPath: true });
      });
    }
  }

  const allExpanded = !collapsedSections.has('all');
  rows.push({ kind: 'section', key: 'sec:all', section: 'all', sectionId: 'all', depth: 0, level: 1, setsize: topSize, posinset: ++topPos, expanded: allExpanded, count: model.totalSites });
  if (allExpanded) walk(model.root, 0, 2, 'all', '', true);

  return finishRows(rows);
}

const finishRows = (rows: TreeRow[]): FlatRows => {
  const indexByKey = new Map<string, number>();
  rows.forEach((r, i) => indexByKey.set(r.key, i));
  return { rows, indexByKey };
};

/** The folder chain to show above a row in the sticky breadcrumb ('' for top-level rows). */
export const rowFolderPath = (row: TreeRow | undefined): string => {
  if (!row) return '';
  switch (row.kind) {
    case 'site':
      return row.folder;
    case 'folder':
      return parentOf(row.path);
    case 'placeholder':
      return row.folder;
    case 'draft':
      return row.folder;
    case 'newFolder':
      return row.parent;
    default:
      return '';
  }
};

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * First of `first`, `nth(2)`, `nth(3)`… not in `taken` (ignoring case).
 * New folders: `pickFreeName('New folder', siblings, n => \`New folder ${n}\`)`.
 */
export const pickFreeName = (first: string, taken: Iterable<string>, nth: (n: number) => string, limit = 10_000): string => {
  const used = new Set<string>();
  for (const name of taken) used.add(name.toLowerCase());
  if (!used.has(first.toLowerCase())) return first;
  for (let n = 2; n < limit; n++) {
    const candidate = nth(n);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return nth(limit);
};

/** Direct subfolder names of `parent` (for `pickFreeName` and clash checks). */
export const childFolderNames = (model: TreeModel, parent: string): string[] =>
  (model.folders.get(parent)?.folders ?? []).map((f) => f.name);

export type FolderNameProblem =
  | { code: 'empty' }
  | { code: 'slash' }
  | { code: 'control' }
  | { code: 'too_long' }
  /** A sibling has this name (ignoring case): rename/move offers to merge */
  | { code: 'exists'; existing: string };

/**
 * Client-side checks for a folder name (repeated by the backend): not empty, no '/', no control
 * characters, every resulting path within 255 characters, and no sibling with the same name
 * ignoring case. `self` is the folder being renamed (its subtree is measured; it never clashes
 * with itself, so a case-only rename is fine).
 */
export const folderNameProblem = (
  rawName: string,
  parent: string,
  folderPaths: Iterable<string>,
  self?: string | null
): FolderNameProblem | null => {
  const name = rawName.trim();
  if (!name) return { code: 'empty' };
  if (name.includes('/')) return { code: 'slash' };
  if (HAS_CONTROL_RE.test(name)) return { code: 'control' };
  const target = joinPath(parent, name);
  let deepestSuffix = 0;
  let existing: string | null = null;
  const lower = target.toLowerCase();
  for (const p of folderPaths) {
    if (self && p !== self && p.startsWith(`${self}/`)) deepestSuffix = Math.max(deepestSuffix, charLength(p) - charLength(self));
    if (p.toLowerCase() === lower && p !== self) existing = p;
  }
  if (charLength(target) + deepestSuffix > MAX_FOLDER_PATH_LEN) return { code: 'too_long' };
  if (existing !== null) return { code: 'exists', existing };
  return null;
};

/* -------------------------------------------------------------------------- */
/* Recent times                                                                */
/* -------------------------------------------------------------------------- */

export type RecentAge = { unit: 'now' } | { unit: 'min' | 'h' | 'd'; count: number } | { unit: 'date'; date: Date };

/** "now", "5 min", "2 h", "3 d", then a date (the UI formats it with Intl.DateTimeFormat). */
export const recentAge = (atSecs: number, nowMs: number): RecentAge => {
  const secs = Math.max(0, Math.floor(nowMs / 1000 - atSecs));
  if (secs < 60) return { unit: 'now' };
  if (secs < 3600) return { unit: 'min', count: Math.floor(secs / 60) };
  if (secs < 86_400) return { unit: 'h', count: Math.floor(secs / 3600) };
  if (secs < 7 * 86_400) return { unit: 'd', count: Math.floor(secs / 86_400) };
  return { unit: 'date', date: new Date(atSecs * 1000) };
};

/* -------------------------------------------------------------------------- */
/* Tree ops, applied locally                                                   */
/* -------------------------------------------------------------------------- */

/** Same codes and `"[code] message"` text as the backend's `SiteTreeError`. */
export class SiteTreeOpError extends Error {
  code: SiteTreeErrorCode;
  constructor(code: SiteTreeErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'SiteTreeOpError';
    this.code = code;
  }
}

const fail = (code: SiteTreeErrorCode, message: string): never => {
  throw new SiteTreeOpError(code, message);
};

const invalid = (message: string): never => fail('site_tree.invalid_name', message);

const checkLen = (path: string) => {
  if (charLength(path) > MAX_FOLDER_PATH_LEN) {
    fail('site_tree.path_too_long', `"${[...path].slice(0, 40).join('')}…" would be longer than ${MAX_FOLDER_PATH_LEN} characters`);
  }
};

/**
 * Strict folder path (Rust `normalize_folder_path`): segments trimmed, empty ones dropped; a
 * control character or a result over 255 characters is an error (never cut). `null` = top level.
 */
export const normalizeFolderPathStrict = (raw: string | null | undefined): string | null => {
  const segments: string[] = [];
  for (const part of (raw ?? '').split('/')) {
    const seg = part.trim();
    if (!seg) continue;
    if (HAS_CONTROL_RE.test(seg)) invalid("Folder names can't contain control characters");
    segments.push(seg);
  }
  const path = segments.join('/');
  checkLen(path);
  return path || null;
};

/** Rust `validate_folder_name`: trimmed; not empty, no '/', no control characters. */
export const validateFolderName = (raw: string): string => {
  const name = raw.trim();
  if (!name) invalid('Enter a folder name');
  if (name.includes('/')) invalid('Folder names can\'t contain "/"');
  if (HAS_CONTROL_RE.test(name)) invalid("Folder names can't contain control characters");
  checkLen(name);
  return name;
};

/** Rust `validate_site_name`: trimmed; not empty, no control characters, at most 255 characters. */
export const validateSiteName = (raw: string): string => {
  const name = raw.trim();
  if (!name) invalid('Enter a name');
  if (HAS_CONTROL_RE.test(name)) invalid("Names can't contain control characters");
  if (charLength(name) > MAX_SITE_NAME_LEN) invalid(`Names can be at most ${MAX_SITE_NAME_LEN} characters long`);
  return name;
};

export interface ApplyOpsOptions {
  /**
   * Makes the id of a copied site. Without it, `copy_sites` and `copy_folder` are skipped: the UI
   * waits for the backend's result for copies (it never builds sites from redacted data).
   */
  newId?: () => string;
}

export interface ApplyOpsResult {
  sites: ConnectionConfig[];
  layout: SiteLayout;
  created: CreatedSite[];
  sitesChanged: boolean;
  layoutChanged: boolean;
}

/** True when every op can be shown before the backend answers (copies cannot). */
export const opsAreOptimistic = (ops: readonly SiteTreeOp[]): boolean => ops.every((o) => o.op !== 'copy_sites' && o.op !== 'copy_folder');

/** Rust `SiteTreeOp::id_count` */
const idCount = (o: SiteTreeOp): number => {
  switch (o.op) {
    case 'move_sites':
    case 'delete_sites':
      return o.ids.length;
    case 'copy_sites':
    case 'set_favorites':
      return o.items.length;
    case 'set_label':
      return (o.sites?.length ?? 0) + (o.folders?.length ?? 0);
    case 'set_label_defs':
      return o.labels.length;
    default:
      return 1;
  }
};

/** Rust `check_op_limits` */
export const checkOpLimits = (ops: readonly SiteTreeOp[]): void => {
  if (ops.length > MAX_OPS_PER_CALL) fail('site_tree.too_many', 'Too many changes at once');
  if (ops.reduce((n, o) => n + idCount(o), 0) > MAX_IDS_PER_CALL) fail('site_tree.too_many', 'Too many items at once');
};

const folderExists = (name: string, parent: string | null): never =>
  fail(
    'site_tree.folder_exists',
    parent === null ? `A folder named "${name}" already exists at the top level` : `A folder named "${name}" already exists in "${parent}"`
  );
const localImmutable = (): never => fail('site_tree.local_immutable', "The Local site can't be moved, duplicated or deleted");
const siteNotFound = (id: string): never => fail('site_tree.not_found', `No saved connection has the id "${id}"`);

/** Parent as Rust's `parent_path` (`null` at the top level). */
const parentPath = (path: string): string | null => {
  const i = path.lastIndexOf('/');
  return i < 0 ? null : path.slice(0, i);
};
const join = (parent: string | null, name: string): string => (parent === null ? name : `${parent}/${name}`);
const isSameOrUnder = (path: string, ancestor: string): boolean => path === ancestor || path.startsWith(`${ancestor}/`);

/** Working copy of the layout while ops run. */
interface Work {
  folders: Set<string>;
  favorites: FavoriteRef[];
  recents: RecentEntry[];
  labels: LabelDef[];
  siteLabels: Map<string, string>;
  folderLabels: Map<string, string>;
  collapsed: Set<string>;
}

/** Rust `find_sibling_ci`: a folder in `parent` named `name` ignoring case (never `exclude`); the first in sorted order. */
const findSiblingCi = (folders: Set<string>, parent: string | null, name: string, exclude: string | null): string | null => {
  const lower = name.toLowerCase();
  let found: string | null = null;
  for (const f of folders) {
    if (f === exclude || parentPath(f) !== parent || baseName(f).toLowerCase() !== lower) continue;
    if (found === null || f < found) found = f;
  }
  return found;
};

const existingFolder = (w: Work, raw: string): string => {
  const path = normalizeFolderPathStrict(raw);
  if (path === null) return invalid('Enter a folder name');
  if (!w.folders.has(path)) fail('site_tree.not_found', `There is no folder "${path}"`);
  return path;
};

const addWithAncestors = (set: Set<string>, path: string) => {
  for (const p of folderChain(path)) set.add(p);
};

/** The folder a site is filed under (Local: none). */
const siteFolderOf = (s: ConnectionConfig): string | null => (isLocalSite(s) ? null : normalizeGroup(s.group) || null);

const prefixMap =
  (from: string, to: string) =>
  (p: string): string | null =>
    isSameOrUnder(p, from) ? to + p.slice(from.length) : null;

/**
 * Rust `remap_paths`: rewrites every folder path through `map` at once (site groups, folders,
 * folder favorites, folder labels, collapsed). On a merge the label already at the target wins.
 */
const remapPaths = (sites: ConnectionConfig[], w: Work, map: (p: string) => string | null) => {
  const groups: Array<[number, string]> = [];
  sites.forEach((s, i) => {
    const g = siteFolderOf(s);
    const next = g === null ? null : map(g);
    if (next === null) return;
    checkLen(next);
    groups.push([i, next]);
  });
  const folders = new Set<string>();
  for (const f of w.folders) {
    const next = map(f);
    if (next !== null) checkLen(next);
    folders.add(next ?? f);
  }
  for (const [i, g] of groups) sites[i] = { ...sites[i], group: g };
  w.folders = folders;
  w.favorites = w.favorites.map((f) => (f.kind === 'folder' ? { kind: 'folder', path: map(f.path) ?? f.path } : f));
  const labels = new Map<string, string>();
  const moved: Array<[string, string]> = [];
  for (const [p, label] of w.folderLabels) {
    const next = map(p);
    if (next === null) labels.set(p, label);
    else moved.push([next, label]);
  }
  for (const [p, label] of moved) if (!labels.has(p)) labels.set(p, label);
  w.folderLabels = labels;
  w.collapsed = new Set([...w.collapsed].map((p) => map(p) ?? p));
};

/** Rust `fresh_id` */
const freshId = (taken: Set<string>, newId: () => string): string => {
  for (let i = 0; i < 32; i++) {
    const id = newId();
    if (id && id !== LOCAL_ID && !taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  return invalid('Could not make a unique id for the copy');
};

const indexOfSite = (sites: ConnectionConfig[], id: string): number => {
  const i = sites.findIndex((s) => s.id === id);
  return i < 0 ? siteNotFound(id) : i;
};

const LABEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function applyOne(sites: ConnectionConfig[], w: Work, op: SiteTreeOp, newId: (() => string) | undefined, created: CreatedSite[]): ConnectionConfig[] {
  switch (op.op) {
    case 'move_sites': {
      const to = normalizeFolderPathStrict(op.to ?? '');
      const positions = op.ids.map((id) => indexOfSite(sites, id));
      for (const i of positions) {
        if (isLocalSite(sites[i])) localImmutable();
        sites[i] = { ...sites[i], group: to };
      }
      return sites;
    }
    case 'copy_sites': {
      if (!newId) return sites;
      const taken = new Set(sites.map((s) => s.id));
      const copies: ConnectionConfig[] = [];
      for (const item of op.items) {
        const source = sites[indexOfSite(sites, item.id)];
        if (isLocalSite(source)) localImmutable();
        const name = validateSiteName(item.name);
        const group = normalizeFolderPathStrict(item.group ?? '');
        const id = freshId(taken, newId);
        // The whole config, secrets and fields this build does not name included
        copies.push({ ...structuredClone(source), id, name, group });
        const label = w.siteLabels.get(source.id);
        if (label !== undefined) w.siteLabels.set(id, label);
        created.push({ source_id: source.id, id });
      }
      return [...sites, ...copies];
    }
    case 'delete_sites': {
      const doomed = new Set<string>();
      for (const id of op.ids) {
        if (isLocalSite(sites[indexOfSite(sites, id)])) localImmutable();
        doomed.add(id);
      }
      return sites.filter((s) => !doomed.has(s.id));
    }
    case 'rename_site': {
      const name = validateSiteName(op.name);
      const i = indexOfSite(sites, op.id);
      sites[i] = { ...sites[i], name };
      return sites;
    }
    case 'create_folder': {
      const path = normalizeFolderPathStrict(op.path);
      if (path === null) return invalid('Enter a folder name');
      // Every level that does not exist yet must not clash (ignoring case) with a sibling,
      // and the folder itself must be new
      let parent: string | null = null;
      for (const prefix of folderChain(path)) {
        const name = baseName(prefix);
        if (w.folders.has(prefix)) {
          if (prefix === path) folderExists(name, parent);
        } else {
          const existing = findSiblingCi(w.folders, parent, name, null);
          if (existing !== null) folderExists(baseName(existing), parent);
        }
        parent = prefix;
      }
      addWithAncestors(w.folders, path);
      return sites;
    }
    case 'rename_folder': {
      const path = existingFolder(w, op.path);
      const name = validateFolderName(op.name);
      const parent = parentPath(path);
      let target = join(parent, name);
      if (target === path) return sites;
      const existing = findSiblingCi(w.folders, parent, name, path);
      if (existing !== null) {
        if (!op.merge) folderExists(baseName(existing), parent);
        target = existing;
      }
      remapPaths(sites, w, prefixMap(path, target));
      return sites;
    }
    case 'move_folder': {
      const path = existingFolder(w, op.path);
      const to = normalizeFolderPathStrict(op.to ?? '');
      if (to !== null && isSameOrUnder(to, path)) fail('site_tree.into_self', "A folder can't go inside itself");
      if (parentPath(path) === to) return sites;
      const name = baseName(path);
      const existing = findSiblingCi(w.folders, to, name, null);
      if (existing !== null && !op.merge) folderExists(baseName(existing), to);
      remapPaths(sites, w, prefixMap(path, existing ?? join(to, name)));
      return sites;
    }
    case 'copy_folder': {
      if (!newId) return sites;
      const path = existingFolder(w, op.path);
      const to = normalizeFolderPathStrict(op.to ?? '');
      if (to !== null && isSameOrUnder(to, path)) fail('site_tree.into_self', "A folder can't be copied inside itself");
      const name = validateFolderName(op.name);
      const existing = findSiblingCi(w.folders, to, name, null);
      if (existing !== null) folderExists(baseName(existing), to);
      const map = prefixMap(path, join(to, name));
      const newFolders: string[] = [];
      for (const f of w.folders) {
        const next = map(f);
        if (next === null) continue;
        checkLen(next);
        newFolders.push(next);
      }
      const newFolderLabels: Array<[string, string]> = [];
      for (const [p, label] of w.folderLabels) {
        const next = map(p);
        if (next !== null) newFolderLabels.push([next, label]);
      }
      const taken = new Set(sites.map((s) => s.id));
      const copies: ConnectionConfig[] = [];
      for (const source of sites) {
        const g = siteFolderOf(source);
        const group = g === null ? null : map(g);
        if (group === null) continue;
        checkLen(group);
        const id = freshId(taken, newId);
        copies.push({ ...structuredClone(source), id, group });
        const label = w.siteLabels.get(source.id);
        if (label !== undefined) w.siteLabels.set(id, label);
        created.push({ source_id: source.id, id });
      }
      newFolders.forEach((f) => w.folders.add(f));
      for (const [p, label] of newFolderLabels) if (!w.folderLabels.has(p)) w.folderLabels.set(p, label);
      return [...sites, ...copies];
    }
    case 'delete_folder': {
      const path = existingFolder(w, op.path);
      if (!op.keep_contents) {
        // What pointed at the removed folders and sites goes in the closing reconcile
        for (const f of [...w.folders]) if (isSameOrUnder(f, path)) w.folders.delete(f);
        return sites.filter((s) => {
          const g = siteFolderOf(s);
          return !(g !== null && isSameOrUnder(g, path));
        });
      }
      // Keep the contents: lift everything one level, keeping its structure. A lifted folder
      // that clashes (ignoring case) with one already in the parent merges into it.
      const parent = parentPath(path);
      const siblings = new Map<string, string>();
      for (const f of [...w.folders].sort(byCodeUnits)) {
        if (parentPath(f) === parent && !isSameOrUnder(f, path) && !siblings.has(baseName(f).toLowerCase())) siblings.set(baseName(f).toLowerCase(), f);
      }
      const targets = new Map<string, string>();
      for (const f of w.folders) {
        if (parentPath(f) !== path) continue;
        const name = baseName(f);
        targets.set(name, siblings.get(name.toLowerCase()) ?? join(parent, name));
      }
      // The folder itself goes, with what points at it
      w.folders.delete(path);
      w.collapsed.delete(path);
      w.folderLabels.delete(path);
      w.favorites = w.favorites.filter((f) => !(f.kind === 'folder' && f.path === path));
      sites.forEach((s, i) => {
        if (siteFolderOf(s) === path) sites[i] = { ...s, group: parent };
      });
      const prefixLen = path.length + 1;
      remapPaths(sites, w, (p) => {
        if (p.length <= prefixLen || !isSameOrUnder(p, path)) return null;
        const rest = p.slice(prefixLen);
        const slash = rest.indexOf('/');
        const first = slash < 0 ? rest : rest.slice(0, slash);
        const target = targets.get(first) ?? join(parent, first);
        return slash < 0 ? target : `${target}/${rest.slice(slash + 1)}`;
      });
      return sites;
    }
    case 'set_favorites': {
      if (op.items.length > MAX_FAVORITES) fail('site_tree.too_many', 'Too many favorites');
      // Dangling or duplicate entries are dropped by the closing reconcile
      w.favorites = op.items.flatMap((f): FavoriteRef[] => {
        if (f.kind === 'site') return [{ kind: 'site', id: f.id }];
        try {
          const p = normalizeFolderPathStrict(f.path);
          return p ? [{ kind: 'folder', path: p }] : [];
        } catch {
          return [];
        }
      });
      return sites;
    }
    case 'set_label': {
      const label = op.label ?? null;
      if (label !== null && !w.labels.some((l) => l.id === label)) fail('site_tree.not_found', `There is no label "${label}"`);
      for (const id of op.sites ?? []) {
        indexOfSite(sites, id);
        if (label === null) w.siteLabels.delete(id);
        else w.siteLabels.set(id, label);
      }
      for (const raw of op.folders ?? []) {
        const p = existingFolder(w, raw);
        if (label === null) w.folderLabels.delete(p);
        else w.folderLabels.set(p, label);
      }
      return sites;
    }
    case 'set_label_defs': {
      if (op.labels.length > MAX_LABELS) fail('site_tree.too_many', 'Too many labels');
      const ids = new Set<string>();
      w.labels = op.labels.map((l) => {
        if (!LABEL_ID_RE.test(l.id) || ids.has(l.id)) invalid('Invalid or repeated label id');
        ids.add(l.id);
        const name = l.name.trim();
        if (!name) invalid('Enter a label name');
        if (HAS_CONTROL_RE.test(name) || charLength(name) > MAX_LABEL_NAME_LEN) invalid(`Label names can be at most ${MAX_LABEL_NAME_LEN} characters long`);
        return { id: l.id, name, color: LABEL_COLORS.includes(l.color) ? l.color : 'gray' };
      });
      return sites;
    }
    default:
      // An op this build does not know (the backend would not deserialize it either)
      return invalid(`Unknown operation "${(op as { op?: unknown }).op}"`);
  }
}

/**
 * Local copy of the backend's `apply_ops` (same rules, same error codes): all or nothing (throws
 * `SiteTreeOpError` and changes nothing), `reconcile` before the first op and after the last,
 * Local only renamable, sibling clashes compared ignoring case (`merge` joins into the existing
 * folder), folders never moved into themselves, paths never truncated. Inputs are not mutated.
 * Used for optimistic updates (without `newId`, copies are skipped) and by the browser mock.
 */
export function applyOpsLocally(
  sitesIn: readonly ConnectionConfig[],
  layoutIn: SiteLayout,
  ops: readonly SiteTreeOp[],
  options: ApplyOpsOptions = {}
): ApplyOpsResult {
  checkOpLimits(ops);
  let sites: ConnectionConfig[] = [...sitesIn];
  const start = reconcileLayout(coerceLayout(layoutIn), sites);
  const w: Work = {
    folders: new Set(start.folders),
    favorites: start.favorites.map((f) => ({ ...f })),
    recents: start.recents.map((r) => ({ ...r })),
    labels: start.labels.map((l) => ({ ...l })),
    siteLabels: new Map(Object.entries(start.site_labels)),
    folderLabels: new Map(Object.entries(start.folder_labels)),
    collapsed: new Set(start.collapsed),
  };
  const foldersBefore = w.folders.size;
  const created: CreatedSite[] = [];
  for (const op of ops) sites = applyOne(sites, w, op, options.newId, created);
  if (w.folders.size > MAX_LAYOUT_FOLDERS && w.folders.size > foldersBefore) fail('site_tree.too_many', 'Too many folders');

  const layout = reconcileLayout(
    {
      ...start,
      folders: [...w.folders],
      favorites: w.favorites,
      recents: w.recents,
      labels: w.labels,
      site_labels: Object.fromEntries(w.siteLabels),
      folder_labels: Object.fromEntries(w.folderLabels),
      collapsed: [...w.collapsed],
    },
    sites
  );
  const before = new Map(sitesIn.map((s) => [s.id, s]));
  const sitesChanged =
    sites.length !== sitesIn.length || sites.some((s) => before.get(s.id) !== s && JSON.stringify(before.get(s.id) ?? null) !== JSON.stringify(s));
  return { sites, layout, created, sitesChanged, layoutChanged: JSON.stringify(layout) !== JSON.stringify(start) };
}
