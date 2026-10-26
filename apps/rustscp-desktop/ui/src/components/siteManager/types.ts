/**
 * Types of the connections tree (Site Manager).
 *
 * The backend shapes mirror `crates/rustscp-core/src/site_layout.rs` and
 * `apps/rustscp-desktop/src-tauri/src/site_tree.rs`: snake_case fields, `op` / `kind` tags.
 * They are kept here, not in `src/types.ts`, so this feature never edits that shared file.
 *
 * Erasable TypeScript only (no enums, no namespaces): the unit tests run with Node's type stripping.
 */
import type { ConnectionConfig, Protocol } from '../../types.ts';

/* -------------------------------------------------------------------------- */
/* Backend shapes                                                              */
/* -------------------------------------------------------------------------- */

export type LabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray';

export const LABEL_COLORS: readonly LabelColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];

export interface LabelDef {
  /** `label-<uuid>` */
  id: string;
  /** At most 40 characters */
  name: string;
  color: LabelColor;
}

/** Rust `FavoriteRef` (`#[serde(tag = "kind", rename_all = "snake_case")]`). */
export type FavoriteRef = { kind: 'site'; id: string } | { kind: 'folder'; path: string };

/** Rust `RecentEntry`. `at` is Unix seconds; `null` for entries seeded from older data. */
export interface RecentEntry {
  id: string;
  at?: number | null;
  count: number;
}

/**
 * Rust `SiteLayout`: everything about the tree that is not inside `ConnectionConfig`.
 * `site.group` stays the only record of which folder a site is in.
 * BTreeSet / BTreeMap arrive as sorted arrays / plain objects. Unknown future keys may also
 * arrive (Rust keeps them in a flattened `extra` map); the UI never sends the layout back.
 */
export interface SiteLayout {
  version: number;
  /** Explicit folders (empty ones included), normalized paths */
  folders: string[];
  /** User order */
  favorites: FavoriteRef[];
  /** Newest first */
  recents: RecentEntry[];
  labels: LabelDef[];
  /** site id → label id */
  site_labels: Record<string, string>;
  /** folder path → label id (inherited by everything inside) */
  folder_labels: Record<string, string>;
  collapsed: string[];
  migrated_local_storage: boolean;
  large_library_collapsed: boolean;
}

/** Rust `CopyItem` */
export interface CopyItem {
  id: string;
  name: string;
  /** Target folder; `null` = top level */
  group: string | null;
}

/**
 * Rust `SiteTreeOp` (`#[serde(tag = "op", rename_all = "snake_case")]`).
 * `to: null` means the top level. Optional fields are the ones Rust marks `#[serde(default)]`.
 */
export type SiteTreeOp =
  | { op: 'move_sites'; ids: string[]; to: string | null }
  | { op: 'copy_sites'; items: CopyItem[] }
  | { op: 'delete_sites'; ids: string[] }
  | { op: 'rename_site'; id: string; name: string }
  | { op: 'create_folder'; path: string }
  | { op: 'rename_folder'; path: string; name: string; merge?: boolean }
  | { op: 'move_folder'; path: string; to: string | null; merge?: boolean }
  | { op: 'copy_folder'; path: string; to: string | null; name: string }
  | { op: 'delete_folder'; path: string; keep_contents: boolean }
  | { op: 'set_favorites'; items: FavoriteRef[] }
  | { op: 'set_label'; sites?: string[]; folders?: string[]; label: string | null }
  | { op: 'set_label_defs'; labels: LabelDef[] };

export type SiteTreeOpName = SiteTreeOp['op'];

/** Rust `CreatedSite`: one per site made by `copy_sites` / `copy_folder`. */
export interface CreatedSite {
  source_id: string;
  id: string;
}

/** Rust `UndoReport` */
export interface UndoReport {
  restored: number;
  /** Sites changed again after the op, so they were left alone */
  skipped: number;
}

/** Result of `apply_site_tree_ops` and `undo_site_tree_ops`. */
export interface SiteTreeResult {
  /** The whole saved-site list, secrets redacted (like `get_saved_sites`) */
  sites: ConnectionConfig[];
  layout: SiteLayout;
  /** `undo-<uuid>`; `null` for an undo result */
  undo_token: string | null;
  created: CreatedSite[];
  undo_report: UndoReport | null;
  /** For example `layout_not_saved` */
  warnings: string[];
}

/** Result of `get_site_layout`. */
export interface SiteLayoutResponse {
  layout: SiteLayout;
  /** A newer build wrote the layout, or the device key is unavailable: never written */
  read_only: boolean;
  warning: string | null;
}

/** Rust `SiteTreeViewPatch` (`#[serde(default)]`): only the fields that are set change. */
export interface SiteTreeViewPatch {
  /** The full collapsed set */
  collapsed?: string[];
  forget_recents?: string[];
  clear_recents?: boolean;
  /** Migration only: applied while `recents` is empty */
  seed_recents?: string[];
  migrated_local_storage?: boolean;
  large_library_collapsed?: boolean;
}

/** Error codes the backend puts in its `"[code] message"` errors. */
export type SiteTreeErrorCode =
  | 'site_tree.folder_exists'
  | 'site_tree.into_self'
  | 'site_tree.invalid_name'
  | 'site_tree.path_too_long'
  | 'site_tree.local_immutable'
  | 'site_tree.not_found'
  | 'site_tree.too_many'
  | 'site_tree.undo_expired'
  | 'site_tree.layout_read_only'
  /** Load warnings (`SiteLayoutResponse.warning`): the device key could not be read, read-only */
  | 'site_tree.layout_unavailable'
  /** Load warning: the layout file was unreadable, set aside, and started empty */
  | 'site_tree.layout_reset';

/** `SiteTreeResult.warnings` entries. */
export type SiteTreeWarning = 'layout_not_saved' | 'layout_read_only';

/* -------------------------------------------------------------------------- */
/* UI model                                                                    */
/* -------------------------------------------------------------------------- */

export type SortKey = 'name' | 'address' | 'protocol' | 'last';
export type Density = 'compact' | 'comfortable';

/** View options, stored as JSON (no folder or site names) in localStorage `rustscp_site_tree_view`. */
export interface ViewPrefs {
  sort: SortKey;
  foldersOnTop: boolean;
  /** `null` until the user picks one: Comfortable up to 40 saved sites, Compact above */
  density: Density | null;
  /** Compact rows only */
  showAddress: boolean;
  showFavorites: boolean;
  showRecent: boolean;
  resultsAsList: boolean;
}

/** A folder of the tree. The root has `path === ''`. */
export interface FolderNode {
  path: string;
  name: string;
  /** Parent path ('' for a top-level folder) */
  parent: string;
  /** 0 for a top-level folder; -1 for the root */
  depth: number;
  folders: FolderNode[];
  /** Sorted; at the root, Local comes first */
  sites: ConnectionConfig[];
  /** Saved sites inside, all levels (Local not counted) */
  count: number;
  /** Folders inside, all levels */
  folderCount: number;
  /** True when the layout lists it (it survives being emptied) */
  explicit: boolean;
  /** Own label id, if any */
  label: string | null;
  /** Own label, or the nearest ancestor's */
  effectiveLabel: string | null;
  /** Newest `recents.at` among the sites inside (Unix seconds), for the "Last connected" sort */
  lastAt: number | null;
}

export interface TreeModel {
  root: FolderNode;
  /** Every folder by path, the root included under '' */
  folders: Map<string, FolderNode>;
  sitesById: Map<string, ConnectionConfig>;
  /** Site id → its normalized folder path ('' = top level) */
  siteFolder: Map<string, string>;
  local: ConnectionConfig | null;
  /** Saved sites, Local excluded */
  totalSites: number;
  totalFolders: number;
  favorites: FavoriteRef[];
  favoriteSites: Set<string>;
  favoriteFolders: Set<string>;
  /** Saved, not Local, newest first */
  recents: RecentEntry[];
  /** Site id → `recents.at` (Unix seconds; null when unknown) */
  recentAt: Map<string, number | null>;
  labels: Map<string, LabelDef>;
  /** Site id → effective label id (own, else inherited) */
  siteLabel: Map<string, string>;
}

/** Rows live in one of three sections; `addr` is the address row outside them. */
export type SectionId = 'fav' | 'rec' | 'all';

interface RowBase {
  /** Unique per row: `sec:all`, `s:<id>`, `f:<path>`, `fav:s:<id>`, `rec:<id>`, `draft`, `addr`… */
  key: string;
  section: SectionId | null;
  /** Indent depth (0 = a top-level item; also 0 for section headers) */
  depth: number;
  /** `aria-level` */
  level: number;
  /** `aria-setsize` / `aria-posinset` among the row's siblings */
  setsize: number;
  posinset: number;
}

export interface SectionRow extends RowBase {
  kind: 'section';
  sectionId: SectionId;
  expanded: boolean;
  /** Items in the section (All: saved connections, or matches while searching) */
  count: number;
}

export interface FolderRow extends RowBase {
  kind: 'folder';
  /** Canonical item key `f:<path>` */
  itemKey: string;
  path: string;
  name: string;
  expanded: boolean;
  /** Connections inside, all levels; matches while searching */
  count: number;
  /** No sites and no subfolders */
  empty: boolean;
  /** Effective label id */
  label: string | null;
  favorite: boolean;
}

export interface SiteRow extends RowBase {
  kind: 'site';
  /** Canonical item key `s:<id>` */
  itemKey: string;
  site: ConnectionConfig;
  /** The site's folder path ('' = top level) */
  folder: string;
  /** Effective label id */
  label: string | null;
  favorite: boolean;
  /** Recent rows: `recents.at` (Unix seconds) */
  recentAt: number | null;
  /** Favorites, Recent and flat results also show the folder path on line 2 */
  showPath: boolean;
}

/** "Empty folder · New connection here" inside an expanded empty folder. */
export interface PlaceholderRow extends RowBase {
  kind: 'placeholder';
  folder: string;
}

/** The form's unsaved new connection, in the folder it will be saved to. */
export interface DraftRow extends RowBase {
  kind: 'draft';
  folder: string;
  name: string;
}

/** Inline "New folder" row being named. */
export interface NewFolderRow extends RowBase {
  kind: 'newFolder';
  parent: string;
  name: string;
}

/** "New connection to user@host…" when the search text reads as an address. */
export interface AddressRow extends RowBase {
  kind: 'address';
  address: string;
}

export type TreeRow = SectionRow | FolderRow | SiteRow | PlaceholderRow | DraftRow | NewFolderRow | AddressRow;
export type TreeRowKind = TreeRow['kind'];

/** What a search matched, as `flattenRows` consumes it. */
export interface SearchResult {
  /** Matching saved sites (Local included when it matches) */
  siteIds: Set<string>;
  /** Folders that match on their own (empty folders) */
  folderPaths: Set<string>;
  /** Present for "results as a list": canonical item keys (`s:<id>` / `f:<path>`) in rank order */
  ranked?: string[];
}

export interface FlattenState {
  /** Collapsed folder paths (normal browsing) */
  collapsed: ReadonlySet<string>;
  /** Collapsed sections (their headers stay) */
  collapsedSections?: ReadonlySet<SectionId>;
  showFavorites?: boolean;
  showRecent?: boolean;
  /** Recent rows shown at most (default 8) */
  recentLimit?: number;
  /** Favorite folders expanded in place (folder paths) */
  favoriteExpanded?: ReadonlySet<string>;
  /** Present while searching */
  search?: SearchResult | null;
  /** Folders collapsed during the current search (forgotten when the query changes) */
  searchCollapsed?: ReadonlySet<string>;
  draft?: { folder: string; name: string } | null;
  newFolder?: { parent: string; name: string } | null;
  /** Address row text (only while searching) */
  address?: string | null;
}

export interface FlatRows {
  rows: TreeRow[];
  indexByKey: Map<string, number>;
}

export type { ConnectionConfig, Protocol };
