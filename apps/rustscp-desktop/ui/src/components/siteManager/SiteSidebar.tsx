import React, { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDownUp, ChevronDown, FileKey2, FolderInput, FolderPlus, Plus, SlidersHorizontal } from 'lucide-react';
import type { ConnectionConfig } from '../../types.ts';
import { copyText } from '../copyToClipboard.ts';
import { isMacPlatform } from '../fileListUtils.ts';
import { ContextMenu } from '../ui/ContextMenu.tsx';
import type { ContextMenuEntry } from '../ui/ContextMenu.tsx';
import type { MenuAnchor } from '../ui/contextMenuUtils.ts';
import { Button } from '../ui/controls.tsx';
import { notify } from '../ui/toast.tsx';
import { DeleteItemsDialog } from './DeleteItemsDialog.tsx';
import type { DeleteChoice, DeleteRequest } from './DeleteItemsDialog.tsx';
import { FolderPane } from './FolderPane.tsx';
import { MoveToDialog } from './MoveToDialog.tsx';
import { SelectionPane } from './SelectionPane.tsx';
import type { SelectedItem } from './SelectionPane.tsx';
import { FilterPills, SearchTips, SiteSearchBar } from './SiteSearchBar.tsx';
import { SiteTree } from './SiteTree.tsx';
import type { SiteTreeHandle, TreeActions } from './SiteTree.tsx';
import type { RowEditState } from './SiteTreeRow.tsx';
import {
  emptyAreaMenu,
  favoriteMenu,
  filterMenu,
  folderMenu,
  importExportEntries,
  localMenu,
  multiMenu,
  recentMenu,
  sectionMenu,
  shortcutLabels,
  siteMenu,
  viewOptionsMenu,
} from './siteMenus.tsx';
import type { MenuActions, MenuContext, ViewMenuState } from './siteMenus.tsx';
import { allFavorites, checkFavoriteDrop, favoriteKey, favoriteRefOf, insertFavorites, moveFavorite, sameFavorites, setFavorites } from './sectionsModel.ts';
import { activeValues, addressFromQuery, clearQualifiers, highlightTerms, matchContext, parseQuery, removeToken, searchTree, toggleQualifier } from './siteQuery.ts';
import {
  LOCAL_ID,
  MAX_FAVORITES,
  MAX_SITE_NAME_LEN,
  VIEW_PREFS_KEY,
  baseName,
  buildTree,
  charLength,
  childFolderNames,
  copyAddress,
  duplicateItems,
  effectiveDensity,
  flattenRows,
  folderChain,
  folderKey,
  folderNameProblem,
  foldersInside,
  formatCount,
  isInside,
  isLocalSite,
  joinPath,
  parentOf,
  parseItemKey,
  parseViewPrefs,
  pickFreeName,
  planMove,
  protocolBreakdown,
  resolveItems,
  rowFolderPath,
  rowHeightFor,
  siteKey,
  sitesInside,
} from './siteTreeModel.ts';
import type { FolderNameProblem, MovePlan } from './siteTreeModel.ts';
import { checkDrop, commonParent, dragPayload, planCopies } from './treeDragModel.ts';
import type { CopyNames, DragPayload, DropSpot } from './treeDragModel.ts';
import type { FavoriteRef, FolderNode, SectionId, SiteTreeOp, TreeRow, ViewPrefs } from './types.ts';
import type { SiteTreeController } from './useSiteTree.ts';
import { canonicalKey, isItemRow, paneFor, rangeKeys, selectedItems, useTreeSelection } from './useTreeSelection.ts';

/** What LoginDialog can ask of the sidebar (the form header, imports). */
export interface SiteSidebarApi {
  /** Expands the folder's chain, scrolls to it and (optionally) selects it */
  revealFolder: (path: string, opts?: { select?: boolean; focus?: boolean }) => void;
  /** After an import: clears the search, expands the imported folders and selects the first one */
  revealImported: (folders: string[]) => void;
  /** The form header's ⋯: the item's menu anchored to the button */
  openItemMenu: (itemKey: string, rect: DOMRect) => void;
  /** The form header's Star: adds the item to the favorites or removes it */
  toggleFavorite: (itemKey: string) => void;
}

export interface SiteSidebarProps {
  tree: SiteTreeController;
  savedSites: ConnectionConfig[];
  /** The item the form shows: `draft` (new connection) or `s:<id>` */
  formKey: string;
  /** The new connection's folder while the form is in new mode, else null */
  draftFolder: string | null;
  /** The new connection's typed name ('' when none) */
  draftName: string;
  /** Bumps whenever the form starts a new connection, so the draft row is selected again */
  formEpoch: number;
  formDirty: boolean;
  /** Loads a site into the form, through the unsaved-changes check unless `force` */
  onSelectSite: (site: ConnectionConfig, opts?: { force?: boolean }) => void;
  onConnectSite: (site: ConnectionConfig) => void;
  onNewConnection: (folder: string) => void;
  /** The address row: opens the new-connection form filled in from `address` (never connects) */
  onNewConnectionTo: (address: string) => void;
  /** Closes the Connect dialog (the folder overview's Close) */
  onCloseDialog: () => void;
  /** Loads the site (if needed) and focuses its first field */
  onEditSite: (site: ConnectionConfig) => void;
  onFocusDraft: () => void;
  onShareSite?: (site: ConnectionConfig) => void;
  onOpenVault: (tab?: 'winscp') => void;
  onOpenSharedConnection?: () => void;
  /** LoginDialog's escape registry; the sidebar adds one handler (rename, search) */
  escapeLayers: MutableRefObject<Array<() => boolean>>;
  apiRef: MutableRefObject<SiteSidebarApi | null>;
  /** The right pane's slot for the folder overview and the selection panel */
  paneHost: HTMLElement | null;
  /** What the right pane shows; LoginDialog hides the form unless it is 'form' */
  onPaneModeChange: (mode: PaneMode) => void;
}

/** The right pane follows the selection (spec §4); a form with unsaved edits always stays. */
export type PaneMode = 'form' | 'folder' | 'selection';

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_TERMS: readonly string[] = [];

/**
 * View state kept for this run of the app, across openings of the dialog (never stored: folder
 * paths are names): favorite folders expanded in place, and collapsed sections.
 */
const session: { favoriteExpanded: ReadonlySet<string>; collapsedSections: ReadonlySet<SectionId> } = {
  favoriteExpanded: new Set(),
  collapsedSections: new Set(),
};

/** An ⌥/Alt drop that copies more connections than this asks first */
const COPY_ASK_ABOVE = 50;

const WIDTH_KEY = 'rustscp_site_sidebar_width';
const WIDTH_DEFAULT = 300;
const WIDTH_MIN = 240;
const WIDTH_MAX = 440;
/** The form keeps at least this much room */
const FORM_MIN = 480;

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the width is just not remembered */
  }
};

interface RenameState {
  rowKey: string;
  kind: 'site' | 'folder';
  /** Site id or folder path */
  target: string;
  original: string;
  value: string;
  error: string | null;
}

interface NewFolderState {
  parent: string;
  value: string;
  error: string | null;
}

interface MenuState {
  at: MenuAnchor;
  /**
   * 'filter' (the filter menu) and 'view' (View options) are rebuilt on every render, so their
   * checkboxes, which keep the menu open, follow the state
   */
  entries: ContextMenuEntry[] | 'filter' | 'view';
  label: string;
  focusFirst: boolean;
}

interface MoveRequest {
  /** Canonical item keys */
  keys: string[];
  title: string;
  current: string | null;
  moving: string[];
}

/**
 * The Connect dialog's sidebar: header, search, the connections tree, status line, import & export
 * footer and the resize handle. It owns the tree's view state (search, selection, rename, menus)
 * and turns tree actions into backend ops through `tree.run`.
 */
export const SiteSidebar: React.FC<SiteSidebarProps> = ({
  tree,
  savedSites,
  formKey,
  draftFolder,
  draftName,
  formEpoch,
  formDirty,
  onSelectSite,
  onConnectSite,
  onNewConnection,
  onNewConnectionTo,
  onCloseDialog,
  onEditSite,
  onFocusDraft,
  onShareSite,
  onOpenVault,
  onOpenSharedConnection,
  escapeLayers,
  apiRef,
  paneHost,
  onPaneModeChange,
}) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const mac = useMemo(() => isMacPlatform(), []);
  const descId = useId();
  const asideRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<SiteTreeHandle>(null);
  const formDirtyRef = useRef(formDirty);
  formDirtyRef.current = formDirty;

  /* --------------------------------- state --------------------------------- */

  const [query, setQueryState] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [collapsedSections, setCollapsedSectionsState] = useState<ReadonlySet<SectionId>>(() => session.collapsedSections);
  const setCollapsedSections = useCallback((fn: (prev: ReadonlySet<SectionId>) => ReadonlySet<SectionId>) => {
    setCollapsedSectionsState((prev) => {
      const next = fn(prev);
      session.collapsedSections = next;
      return next;
    });
  }, []);
  const [favoriteExpanded, setFavoriteExpandedState] = useState<ReadonlySet<string>>(() => session.favoriteExpanded);
  const setFavoriteExpanded = useCallback((fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
    setFavoriteExpandedState((prev) => {
      const next = fn(prev);
      session.favoriteExpanded = next;
      return next;
    });
  }, []);
  const [prefs, setPrefs] = useState<ViewPrefs>(() => parseViewPrefs(readStorage(VIEW_PREFS_KEY)));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** View options: kept in localStorage as JSON (sort, sizes, switches; never names) */
  const setView = useCallback((patch: Partial<ViewPrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefs(next);
    writeStorage(VIEW_PREFS_KEY, JSON.stringify(next));
  }, []);
  /** A drag is running (an empty Favorites section shows its drop zone) */
  const [dragging, setDragging] = useState(false);
  const selection = useTreeSelection(formKey);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [newFolder, setNewFolder] = useState<NewFolderState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleteReq, setDeleteReq] = useState<{ request: DeleteRequest; run: (choice: DeleteChoice) => void } | null>(null);
  const [moveReq, setMoveReq] = useState<MoveRequest | null>(null);
  const [showTips, setShowTips] = useState(false);
  /** Items marked by ⌘X (canonical keys), kept in memory only until ⌘V or Escape */
  const [cutKeys, setCutKeys] = useState<ReadonlySet<string>>(EMPTY_SET);
  /** The folder overview's escape layer (reverts an edited name) */
  const paneEscapeRef = useRef<(() => boolean) | null>(null);
  const [width, setWidth] = useState(() => {
    const n = Number(readStorage(WIDTH_KEY));
    return Number.isFinite(n) && n >= WIDTH_MIN && n <= WIDTH_MAX ? n : WIDTH_DEFAULT;
  });
  const [containerWidth, setContainerWidth] = useState(0);
  const [live, setLive] = useState('');
  /** Ignore the blur that follows an Enter / Escape on the inline input */
  const editClosing = useRef(false);
  /** Folders to reveal once they are rows (after an import) */
  const pendingReveal = useRef<Set<string> | null>(null);
  /** A rename asked for before its row exists (a collapsed folder) */
  const pendingRename = useRef<string | null>(null);
  /** A row to scroll to once the rows change (after a move the row's old place is still shown); short-lived */
  const scrollAfterChange = useRef<{ key: string; until: number } | null>(null);
  const scrollWhenShown = (key: string, now: boolean) => {
    scrollAfterChange.current = { key, until: Date.now() + 1500 };
    if (now) treeRef.current?.scrollToKey(key);
  };
  /** The next form change must not move the selection (it follows a delete) */
  const suppressFollow = useRef(false);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    // Folders collapsed during a search are forgotten when the query changes
    setSearchCollapsed(EMPTY_SET);
  }, []);

  const announce = useCallback((text: string) => {
    setLive('');
    // A new node each time, so the same message is read again
    window.setTimeout(() => setLive(text), 30);
  }, []);

  /* --------------------------------- model --------------------------------- */

  const model = useMemo(
    () => buildTree(savedSites, tree.layout, { sort: prefs.sort, foldersOnTop: prefs.foldersOnTop }),
    [savedSites, tree.layout, prefs.sort, prefs.foldersOnTop]
  );
  const density = effectiveDensity(prefs, model.totalSites);
  const rowHeight = rowHeightFor(density);
  const parsed = useMemo(() => parseQuery(deferredQuery), [deferredQuery]);
  /** The text as typed (pills and the filter menu follow it at once) */
  const parsedNow = useMemo(() => parseQuery(query), [query]);
  const searching = !parsed.isEmpty;
  const search = useMemo(
    () => (searching ? searchTree(model, parsed, matchContext(model), { asList: prefs.resultsAsList }) : null),
    [model, parsed, searching, prefs.resultsAsList]
  );
  const address = useMemo(() => (searching ? addressFromQuery(parsed) : null), [parsed, searching]);
  const draft = useMemo(() => (draftFolder !== null ? { folder: draftFolder, name: draftName } : null), [draftFolder, draftName]);
  const newFolderParent = newFolder?.parent ?? null;
  const flat = useMemo(
    () =>
      flattenRows(model, {
        collapsed: tree.collapsed,
        collapsedSections,
        showFavorites: prefs.showFavorites,
        showRecent: prefs.showRecent,
        favoriteExpanded,
        search,
        searchCollapsed,
        draft,
        newFolder: newFolderParent !== null ? { parent: newFolderParent, name: '' } : null,
        address,
        favDropZone: dragging,
      }),
    [model, tree.collapsed, collapsedSections, prefs.showFavorites, prefs.showRecent, favoriteExpanded, search, searchCollapsed, draft, newFolderParent, address, dragging]
  );
  const { rows, indexByKey } = flat;
  const nameTerms = useMemo(() => (searching ? highlightTerms(parsed, 'name') : EMPTY_TERMS), [parsed, searching]);
  const addressTerms = useMemo(() => (searching ? highlightTerms(parsed, 'address') : EMPTY_TERMS), [parsed, searching]);
  // Matching saved connections (Local not counted), in folders or as a list
  const matchCount = useMemo(() => {
    let n = 0;
    if (search) for (const id of search.siteIds) if (id !== LOCAL_ID) n++;
    return n;
  }, [search]);
  const noResults = searching && !!search && search.siteIds.size === 0 && search.folderPaths.size === 0;

  const folderPaths = useMemo(() => [...model.folders.keys()].filter(Boolean), [model]);
  const anyExpanded = useMemo(() => {
    if (searching) return rows.some((r) => r.kind === 'folder' && r.expanded);
    return folderPaths.some((p) => !tree.collapsed.has(p));
  }, [searching, rows, folderPaths, tree.collapsed]);
  const anyCollapsed = useMemo(() => {
    if (searching) return rows.some((r) => r.kind === 'folder' && !r.expanded);
    return folderPaths.some((p) => tree.collapsed.has(p));
  }, [searching, rows, folderPaths, tree.collapsed]);

  const rowOf = useCallback((key: string | null | undefined): TreeRow | undefined => {
    if (!key) return undefined;
    const i = indexByKey.get(key);
    return i === undefined ? undefined : rows[i];
  }, [indexByKey, rows]);

  /** The first selected row that is shown (the target of header buttons). */
  const selectedRow = (): TreeRow | undefined => {
    for (const k of selection.keys) {
      const r = rowOf(k);
      if (r) return r;
    }
    return undefined;
  };

  /** Folder new things go into: the folder itself, a site's folder, else the top level. */
  const folderOfRow = (row: TreeRow | null | undefined): string => {
    if (!row) return '';
    switch (row.kind) {
      case 'folder':
        return row.path;
      case 'site':
        return isLocalSite(row.site) ? '' : row.folder;
      case 'placeholder':
      case 'draft':
        return row.folder;
      case 'newFolder':
        return row.parent;
      default:
        return '';
    }
  };

  /* ------------------------- selection follows form ------------------------ */

  // A layout effect, so the highlight never trails the form by a frame. A site opened from its
  // Favorites or Recent row stays selected there (the list does not jump to "All connections").
  useLayoutEffect(() => {
    if (suppressFollow.current) {
      suppressFollow.current = false;
      return;
    }
    const active = selection.stateRef.current.active;
    const key = active && active !== formKey && canonicalKey(active) === formKey && indexByKey.has(active) ? active : formKey;
    selection.selectOnly(key);
    treeRef.current?.scrollToKey(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey, formEpoch]);

  // The active row vanished (its folder collapsed, it was deleted): fall back to a shown selected
  // row, else the nearest folder shown. Checked against the latest selection, so a selection made
  // in the same update (after a delete) wins.
  useEffect(() => {
    // A selected Favorites or Recent row that went away (unfavorited, cleared, section hidden):
    // the item stays selected on its own row in All connections
    const s = selection.stateRef.current;
    if (s.keys.size === 1) {
      const [only] = s.keys;
      const item = canonicalKey(only);
      if (item !== only && !indexByKey.has(only) && indexByKey.has(item)) selection.selectOnly(item);
    }
    selection.ensureActive(
      (key) => indexByKey.has(key),
      (key) => {
        const ref = parseItemKey(canonicalKey(key));
        const start = ref?.kind === 'site' ? model.siteFolder.get(ref.id) ?? '' : ref?.kind === 'folder' ? parentOf(ref.path) : '';
        const chain = folderChain(start);
        for (let i = chain.length - 1; i >= 0; i--) if (indexByKey.has(folderKey(chain[i]))) return folderKey(chain[i]);
        return rows[0]?.key ?? null;
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexByKey]);

  // Reveal and rename requests that waited for their row
  useEffect(() => {
    const reveal = pendingReveal.current;
    if (reveal) {
      const row = rows.find((r) => r.kind === 'folder' && reveal.has(r.path));
      if (row) {
        pendingReveal.current = null;
        selection.selectOnly(row.key);
        treeRef.current?.scrollToKey(row.key, 'start');
      }
    }
    const after = scrollAfterChange.current;
    if (after && (Date.now() > after.until || indexByKey.has(after.key))) {
      scrollAfterChange.current = null;
      if (Date.now() <= after.until) treeRef.current?.scrollToKey(after.key);
    }
    const key = pendingRename.current;
    if (key && indexByKey.has(key)) {
      pendingRename.current = null;
      const row = rowOf(key);
      if (row) startRename(row);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Result counts are announced once typing pauses
  useEffect(() => {
    if (!searching) return;
    const timer = window.setTimeout(() => {
      announce(
        t('siteTree.a11yResults', {
          count: matchCount,
          formatted: formatCount(lang, matchCount),
          defaultValue_zero: 'No results',
          defaultValue_one: '1 result',
          defaultValue_other: '{{formatted}} results',
        })
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [searching, matchCount, deferredQuery, announce, t, lang]);

  /* ------------------------------ expand/collapse ------------------------------ */

  const updateCollapsed = useCallback(
    (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
      if (searching) setSearchCollapsed(fn);
      else tree.setCollapsed(fn);
    },
    [searching, tree]
  );

  const setExpanded = (path: string, expand: boolean, subtree: boolean) => {
    const paths = subtree ? [path, ...foldersInside(model, path)] : [path];
    updateCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of paths) {
        if (expand ? next.delete(p) : !next.has(p) && !!next.add(p)) changed = true;
      }
      return changed ? next : prev;
    });
    announce(expand ? t('siteTree.a11yExpanded', 'Folder expanded') : t('siteTree.a11yCollapsed', 'Folder collapsed'));
  };

  const setAllExpanded = (expand: boolean) => {
    if (searching) {
      setSearchCollapsed(expand ? EMPTY_SET : new Set(rows.filter((r): r is Extract<TreeRow, { kind: 'folder' }> => r.kind === 'folder').map((r) => r.path)));
    } else {
      tree.setCollapsed(() => (expand ? EMPTY_SET : new Set(folderPaths)));
    }
  };

  /** Expands every folder above `path` (and `path` itself when `self`). */
  const expandChain = (path: string, self = true) => {
    const chain = folderChain(path);
    if (!self) chain.pop();
    if (chain.length === 0) return;
    tree.setCollapsed((prev) => {
      if (!chain.some((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      chain.forEach((p) => next.delete(p));
      return next;
    });
  };

  /* --------------------------------- rename -------------------------------- */

  const folderProblemText = (problem: FolderNameProblem, name: string): string => {
    switch (problem.code) {
      case 'empty':
        return t('siteTree.errEmptyName', 'Enter a name.');
      case 'slash':
        return t('siteTree.errSlash', "Folder names can't contain “/”. Use Move to… to nest folders.");
      case 'control':
        return t('siteTree.errControl', "Names can't contain control characters.");
      case 'too_long':
        return t('siteTree.errPathTooLong', 'This path would be longer than 255 characters.');
      default:
        return t('siteTree.errFolderExists', { name, defaultValue: 'A folder named “{{name}}” already exists here.' });
    }
  };

  function startRename(row: TreeRow) {
    if (row.kind !== 'site' && row.kind !== 'folder') return;
    editClosing.current = false;
    setNewFolder(null);
    if (row.kind === 'site') setRename({ rowKey: row.key, kind: 'site', target: row.site.id, original: row.site.name, value: row.site.name, error: null });
    else setRename({ rowKey: row.key, kind: 'folder', target: row.path, original: row.name, value: row.name, error: null });
    selection.setActive(row.key);
    treeRef.current?.scrollToKey(row.key);
  }

  /** Rename by item key; reveals a hidden row first. */
  const startRenameByKey = (itemKey: string) => {
    const row = rowOf(itemKey);
    if (row) {
      startRename(row);
      return;
    }
    const ref = parseItemKey(itemKey);
    if (!ref) return;
    if (searching) setQuery('');
    if (ref.kind === 'site') expandChain(model.siteFolder.get(ref.id) ?? '');
    else expandChain(ref.path, false);
    pendingRename.current = itemKey;
  };

  const closeEdit = () => {
    editClosing.current = true;
    setRename(null);
    setNewFolder(null);
    treeRef.current?.focus();
  };

  const commitRename = (fromBlur: boolean) => {
    const r = rename;
    if (!r || editClosing.current) return;
    const value = r.value.trim();
    if (!value || value === r.original) {
      closeEdit();
      return;
    }
    let error: string | null = null;
    if (r.kind === 'site') {
      if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) error = t('siteTree.errControl', "Names can't contain control characters.");
      else if (charLength(value) > MAX_SITE_NAME_LEN) error = t('siteTree.errNameTooLong', 'Names can be at most 255 characters long.');
    } else {
      const problem = folderNameProblem(value, parentOf(r.target), folderPaths, r.target);
      // A name a sibling already has asks to merge (after the field closes)
      if (problem && problem.code !== 'exists') error = folderProblemText(problem, value);
    }
    if (error) {
      // Leaving the field with an invalid name reverts it
      if (fromBlur) closeEdit();
      else setRename({ ...r, error });
      return;
    }
    closeEdit();
    if (r.kind === 'site') {
      void tree.run([{ op: 'rename_site', id: r.target, name: value }]).then((res) => {
        if (res) announce(t('siteTree.a11yRenamed', { name: value, defaultValue: 'Renamed to “{{name}}”' }));
      });
    } else {
      requestFolderRename(r.target, value);
    }
  };

  /** The selection (or keyboard focus) on folder `from` follows it to `to`. */
  const followFolder = (from: string, to: string) => {
    const s = selection.stateRef.current;
    if (s.keys.has(folderKey(from))) selection.selectOnly(folderKey(to));
    else if (s.active === folderKey(from)) selection.setActive(folderKey(to));
  };

  /**
   * Renames a folder (inline rename and the folder overview). A name a sibling already has opens
   * the Merge prompt. Returns the error to show, or null when the rename went ahead or the prompt opened.
   */
  const requestFolderRename = (path: string, raw: string): string | null => {
    const node = model.folders.get(path);
    const value = raw.trim();
    if (!node || !value || value === node.name) return null;
    const parent = parentOf(path);
    const problem = folderNameProblem(value, parent, folderPaths, path);
    const renamed = (name = value) => announce(t('siteTree.a11yRenamed', { name, defaultValue: 'Renamed to “{{name}}”' }));
    if (problem?.code === 'exists') {
      const existing = problem.existing;
      setDeleteReq({
        request: { kind: 'merge', name: baseName(existing), parent: parent ? parent.split('/').join(' / ') : null, sites: node.count },
        run: (choice) => {
          setDeleteReq(null);
          if (choice !== 'merge') return;
          followFolder(path, existing);
          void tree.run([{ op: 'rename_folder', path, name: value, merge: true }], { errorParams: { name: value } }).then((res) => {
            if (res) renamed(baseName(existing));
          });
        },
      });
      return null;
    }
    if (problem) return folderProblemText(problem, value);
    // The renamed folder stays selected under its new path
    followFolder(path, joinPath(parent, value));
    void tree.run([{ op: 'rename_folder', path, name: value }], { errorParams: { name: value } }).then((res) => {
      if (res) renamed();
    });
    return null;
  };

  /* ------------------------------- new folder ------------------------------ */

  const startNewFolder = (parent: string) => {
    if (searching) setQuery('');
    editClosing.current = false;
    setRename(null);
    expandChain(parent);
    const value = pickFreeName(t('siteTree.newFolder', 'New folder'), childFolderNames(model, parent), (n) => t('siteTree.newFolderN', { n, defaultValue: 'New folder {{n}}' }));
    setNewFolder({ parent, value, error: null });
    selection.setActive('newfolder');
    treeRef.current?.scrollToKey('newfolder');
  };

  const commitNewFolder = (fromBlur: boolean) => {
    const nf = newFolder;
    if (!nf || editClosing.current) return;
    const name = nf.value.trim();
    if (!name) {
      closeEdit();
      return;
    }
    const problem = folderNameProblem(name, nf.parent, folderPaths, null);
    if (problem) {
      if (fromBlur) closeEdit();
      else setNewFolder({ ...nf, error: folderProblemText(problem, name) });
      return;
    }
    const path = joinPath(nf.parent, name);
    closeEdit();
    selection.selectOnly(folderKey(path));
    treeRef.current?.scrollToKey(folderKey(path));
    void tree.run([{ op: 'create_folder', path }], { errorParams: { name } }).then((res) => {
      if (res) announce(t('siteTree.a11yFolderCreated', { name, defaultValue: 'Folder “{{name}}” created' }));
    });
  };

  const edit = ((): { rowKey: string; state: RowEditState } | null => {
    if (rename) {
      const name = rename.original;
      return {
        rowKey: rename.rowKey,
        state: {
          value: rename.value,
          error: rename.error,
          ariaLabel: t('siteTree.a11yRename', { name, defaultValue: 'Rename {{name}}' }),
          onChange: (value) => setRename((r) => (r ? { ...r, value, error: null } : r)),
          onCommit: () => commitRename(false),
          onCancel: closeEdit,
          onBlur: () => commitRename(true),
        },
      };
    }
    if (newFolder) {
      return {
        rowKey: 'newfolder',
        state: {
          value: newFolder.value,
          error: newFolder.error,
          ariaLabel: t('siteTree.a11yNewFolderName', 'New folder name'),
          onChange: (value) => setNewFolder((n) => (n ? { ...n, value, error: null } : n)),
          onCommit: () => commitNewFolder(false),
          onCancel: closeEdit,
          onBlur: () => commitNewFolder(true),
        },
      };
    }
    return null;
  })();

  /* ------------------------ duplicate, copy, delete ------------------------ */

  /** Duplicates sites in their folders ("web-01 copy"); the copies end up selected. */
  const duplicateSites = async (sites: readonly ConnectionConfig[]) => {
    const items = duplicateItems(
      model,
      sites,
      (name) => t('siteTree.copyName', { name, defaultValue: '{{name}} copy' }),
      (name, n) => t('siteTree.copyNameN', { name, n, defaultValue: '{{name}} copy {{n}}' })
    );
    if (items.length === 0) return;
    const res = await tree.run([{ op: 'copy_sites', items }]);
    if (!res) return;
    const copies = res.created.map((c) => res.sites.find((s) => s.id === c.id)).filter((s): s is ConnectionConfig => !!s);
    if (copies.length === 0) return;
    announce(
      t('siteTree.duplicated', {
        count: copies.length,
        formatted: formatCount(lang, copies.length),
        defaultValue_one: 'Duplicated 1 connection',
        defaultValue_other: 'Duplicated {{formatted}} connections',
      })
    );
    if (copies.length === 1) {
      // The copy is selected (and shown in the form unless it has unsaved edits)
      if (formDirtyRef.current) selection.selectOnly(siteKey(copies[0].id));
      else onSelectSite(copies[0]);
    } else {
      selection.selectKeys(copies.map((c) => siteKey(c.id)));
    }
    treeRef.current?.scrollToKey(siteKey(copies[0].id));
  };

  /** Copies addresses as text, one per line (never secrets). */
  const copySiteAddresses = async (sites: readonly ConnectionConfig[]) => {
    const lines = sites.map(copyAddress).filter(Boolean);
    if (lines.length === 0) return;
    const ok = await copyText(lines.join('\n'));
    if (ok) {
      const msg = t('siteTree.copiedAddresses', {
        count: lines.length,
        formatted: formatCount(lang, lines.length),
        defaultValue_one: 'Copied address',
        defaultValue_other: 'Copied {{formatted}} addresses',
      });
      notify.success(msg, lines.length === 1 ? lines[0] : undefined);
      announce(msg);
    } else {
      notify.error(t('siteTree.couldNotCopy', "Couldn't copy to the clipboard"));
    }
  };

  const copyNames: CopyNames = {
    first: (name) => t('siteTree.copyName', { name, defaultValue: '{{name}} copy' }),
    nth: (name, n) => t('siteTree.copyNameN', { name, n, defaultValue: '{{name}} copy {{n}}' }),
  };

  /** Toast / announcement for copies into `target` (an ⌥/Alt drop). */
  const copiedTitle = (count: number, name: string, target: string): string => {
    const formatted = formatCount(lang, count);
    const folder = target.split('/').join(' / ');
    if (count === 1) {
      return target
        ? t('siteTree.copiedOne', { name, folder, defaultValue: 'Copied “{{name}}” to “{{folder}}”' })
        : t('siteTree.copiedOneTop', { name, defaultValue: 'Copied “{{name}}” to the top level' });
    }
    return target
      ? t('siteTree.copiedItems', { count, formatted, folder, defaultValue_one: 'Copied 1 item to “{{folder}}”', defaultValue_other: 'Copied {{formatted}} items to “{{folder}}”' })
      : t('siteTree.copiedTop', { count, formatted, defaultValue_one: 'Copied 1 item to the top level', defaultValue_other: 'Copied {{formatted}} items to the top level' });
  };

  /**
   * Copies items as one batch: into `target` (an ⌥/Alt drop; above 50 connections it asks first),
   * or each next to itself when `target` is null (Duplicate, folders included). Copies run on the
   * backend (it holds the secrets); the copies end up selected.
   */
  const runCopies = async (keys: string[], target: string | null, confirmed = false) => {
    const plan = planCopies(model, keys, target, copyNames);
    const failed = (text: string) => notify.error(t('siteTree.opFailed', "Couldn't update connections"), text);
    if (plan.intoSelf) return failed(t('siteTree.errIntoSelf', "A folder can't go inside itself."));
    if (plan.tooLong) return failed(t('siteTree.errPathTooLong', 'This path would be longer than 255 characters.'));
    if (plan.ops.length === 0) return;
    if (target !== null && !confirmed && plan.connections > COPY_ASK_ABOVE) {
      setDeleteReq({
        request: { kind: 'copy', connections: plan.connections },
        run: (choice) => {
          setDeleteReq(null);
          if (choice === 'copy') void runCopies(keys, target, true);
        },
      });
      return;
    }
    const count = plan.siteItems.length + plan.folders.length;
    const firstName = plan.siteItems.length ? model.sitesById.get(plan.siteItems[0].id)?.name ?? '' : baseName(plan.folders[0].from);
    const res = await tree.run(plan.ops, { errorParams: plan.folders.length ? { name: baseName(plan.folders[0].to) } : undefined });
    if (!res) return;
    // `created` lists the copy_sites copies first, in item order
    const siteCopies = res.created
      .slice(0, plan.siteItems.length)
      .map((c) => res.sites.find((x) => x.id === c.id))
      .filter((x): x is ConnectionConfig => !!x);
    const copies = [...plan.folders.map((f) => folderKey(f.to)), ...siteCopies.map((x) => siteKey(x.id))];
    if (copies.length === 0) return;
    if (target !== null) expandChain(target);
    if (copies.length === 1 && siteCopies.length === 1) {
      // One copied site is selected (and shown in the form unless it has unsaved edits)
      if (formDirtyRef.current) selection.selectOnly(copies[0]);
      else onSelectSite(siteCopies[0]);
    } else {
      selection.selectKeys(copies);
    }
    // The copies may already be rows (the result came back), or show with the next render
    scrollWhenShown(copies[0], true);
    if (target !== null) {
      const title = copiedTitle(count, firstName, target);
      if (res.undo_token) tree.toastWithUndo({ title, token: res.undo_token });
      announce(title);
    } else {
      announce(
        count === 1 && plan.folders.length === 1
          ? t('siteTree.duplicatedFolder', { name: baseName(plan.folders[0].from), defaultValue: 'Duplicated folder “{{name}}”' })
          : t('siteTree.duplicatedItems', { count, formatted: formatCount(lang, count), defaultValue_one: 'Duplicated 1 item', defaultValue_other: 'Duplicated {{formatted}} items' })
      );
    }
  };

  /** Duplicate (⇧⌘D, the menus): sites next to themselves; folders with everything inside (copy_folder). */
  const duplicate = (keys: string[]) => {
    const items = resolveItems(model, keys);
    if (items.folders.length === 0) void duplicateSites(items.sites);
    else void runCopies(keys, null);
  };

  const deleteItems = (keys: string[]) => {
    const sites: ConnectionConfig[] = [];
    const folders: FolderNode[] = [];
    for (const k of new Set(keys.map(canonicalKey))) {
      const ref = parseItemKey(k);
      if (ref?.kind === 'site') {
        const site = model.sitesById.get(ref.id);
        if (site && !isLocalSite(site)) sites.push(site);
      } else if (ref?.kind === 'folder') {
        const node = model.folders.get(ref.path);
        if (node && node.path) folders.push(node);
      }
    }
    // A folder inside another selected folder goes with it
    const top = folders.filter((f) => !folders.some((o) => o !== f && f.path !== o.path && isInside(f.path, o.path)));
    const total = sites.length + top.length;
    if (total === 0) return;

    // Where the selection goes: the row after the deleted block, else the one before it
    const doomed = (row: TreeRow) => {
      const c = canonicalKey(row.key);
      if (sites.some((s) => c === siteKey(s.id)) || top.some((f) => c === folderKey(f.path))) return true;
      const inside = rowFolderPath(row);
      return row.kind !== 'section' && top.some((f) => isInside(inside, f.path) && inside !== '');
    };
    let first = -1;
    let last = -1;
    rows.forEach((r, i) => {
      if (doomed(r)) {
        if (first < 0) first = i;
        last = i;
      }
    });
    const after = rows.slice(last + 1).find((r) => r.kind !== 'section' && r.kind !== 'newFolder' && !doomed(r));
    const before = first > 0 ? [...rows.slice(0, first)].reverse().find((r) => r.kind !== 'newFolder' && !doomed(r)) : undefined;
    const nextRow = after ?? before;

    const formSiteId = formKey.startsWith('s:') ? formKey.slice(2) : null;

    const execute = async (choice: DeleteChoice) => {
      setDeleteReq(null);
      const ops: SiteTreeOp[] = [];
      if (sites.length) ops.push({ op: 'delete_sites', ids: sites.map((s) => s.id) });
      for (const f of top) ops.push({ op: 'delete_folder', path: f.path, keep_contents: choice === 'keep' });
      const formSiteGone =
        !!formSiteId &&
        (sites.some((s) => s.id === formSiteId) ||
          (choice !== 'keep' && top.some((f) => isInside(model.siteFolder.get(formSiteId) ?? '', f.path) && (model.siteFolder.get(formSiteId) ?? '') !== '')));
      if (nextRow?.kind === 'site' && (formSiteGone || !formDirtyRef.current)) {
        onSelectSite(nextRow.site, { force: true });
      } else if (nextRow) {
        if (formSiteGone) {
          // The form resets to a new connection; the selection stays on the next row
          suppressFollow.current = true;
          window.setTimeout(() => {
            suppressFollow.current = false;
          }, 500);
        }
        selection.selectOnly(nextRow.key);
      }
      const res = await tree.run(ops);
      if (!res?.undo_token) return;
      const nf = (n: number) => formatCount(lang, n);
      let title: string;
      if (total === 1 && sites.length === 1) title = t('siteTree.deletedOne', { name: sites[0].name, defaultValue: 'Deleted “{{name}}”' });
      else if (total === 1) title = t('siteTree.deletedFolder', { name: top[0].name, defaultValue: 'Deleted folder “{{name}}”' });
      else if (top.length === 0)
        title = t('siteTree.deleted', { count: total, formatted: nf(total), defaultValue_one: 'Deleted 1 connection', defaultValue_other: 'Deleted {{formatted}} connections' });
      else title = t('siteTree.deletedItems', { count: total, formatted: nf(total), defaultValue_one: 'Deleted 1 item', defaultValue_other: 'Deleted {{formatted}} items' });
      tree.toastWithUndo({ title, token: res.undo_token });
      announce(t('siteTree.a11yDeletedUndo', { shortcut: shortcutLabels(mac).undo, defaultValue: 'Deleted. Press {{shortcut}} to undo.' }));
    };

    const withContents = top.filter((f) => f.count > 0 || f.folderCount > 0);
    if (withContents.length > 0) {
      const single = total === 1 ? top[0] : null;
      const parents = new Set(top.map((f) => parentOf(f.path)));
      const parent = parentOf(top[0].path);
      setDeleteReq({
        request: {
          kind: 'folder',
          name: single?.name ?? null,
          count: total,
          sites: top.reduce((n, f) => n + f.count, 0),
          subfolders: top.reduce((n, f) => n + f.folderCount, 0),
          parent: parent ? parent.split('/').join(' / ') : null,
          mixedParents: parents.size > 1,
        },
        run: (choice) => void execute(choice),
      });
    } else if (total >= 2) {
      setDeleteReq({ request: { kind: 'items', count: total, sitesOnly: top.length === 0 }, run: (choice) => void execute(choice) });
    } else {
      void execute('delete');
    }
  };

  /* ------------------------------ multi-selection ------------------------------ */

  const selectedText = (n: number) =>
    t('siteTree.statusSelected', { count: n, formatted: formatCount(lang, n), defaultValue_one: '1 selected', defaultValue_other: '{{formatted}} selected' });

  /**
   * The items a keyboard action covers: a multi-selection as a whole (even when the focused row is
   * outside it, as after ⌘A while searching or a ⌘-click that took the row out), else the focused row.
   */
  const itemsFor = (row: TreeRow | null | undefined): string[] => {
    const items = selectedItems(selection.stateRef.current.keys);
    if (items.length > 1) return items;
    if (!row || !isItemRow(row)) return [];
    return [canonicalKey(row.key)];
  };

  /** Sets a multi-selection; when it comes down to one site, that site loads (if the form has no unsaved edits). */
  const applySelection = (keys: string[], active: string | null, anchor: string | null) => {
    selection.selectKeys(keys, active, anchor);
    const items = selectedItems(keys);
    if (items.length === 1 && items[0].startsWith('s:') && items[0] !== formKey && !formDirtyRef.current) {
      const site = model.sitesById.get(items[0].slice(2));
      if (site) onSelectSite(site);
    }
  };

  /** ⌘-click: adds or removes one item (non-item rows such as the draft drop out). */
  const toggleSelect = (row: TreeRow) => {
    if (!isItemRow(row)) return;
    const base = [...selection.stateRef.current.keys].filter((k) => /^[sf]:/.test(canonicalKey(k)));
    const next = base.includes(row.key) ? base.filter((k) => k !== row.key) : [...base, row.key];
    applySelection(next, row.key, row.key);
  };

  /** Shift-click and Shift+arrows: the anchor…row range of one section. */
  const extendSelect = (row: TreeRow) => {
    const s = selection.stateRef.current;
    const from = s.anchor !== null ? indexByKey.get(s.anchor) ?? -1 : -1;
    const to = indexByKey.get(row.key) ?? -1;
    if (to < 0) return;
    const keys = from >= 0 ? rangeKeys(rows, from, to) : isItemRow(row) ? [row.key] : [];
    applySelection(keys, row.key, from >= 0 ? s.anchor : row.key);
  };

  /** ⌘A: every site and folder of the section (while searching, the matching sites only). */
  const selectAll = (row: TreeRow) => {
    const keys = rows.filter((r) => r.section === row.section && (r.kind === 'site' || (r.kind === 'folder' && !searching))).map((r) => r.key);
    if (keys.length === 0) return;
    applySelection(keys, row.key, keys[0]);
    announce(selectedText(selectedItems(keys).length));
  };

  /** "Select connections inside": every site in the folder (all levels), shown expanded. */
  const selectInside = (path: string) => {
    let ids = sitesInside(model, path).map((s) => s.id);
    if (search) ids = ids.filter((id) => search.siteIds.has(id));
    if (ids.length === 0) return;
    const paths = [path, ...foldersInside(model, path)];
    updateCollapsed((prev) => {
      if (!paths.some((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      paths.forEach((p) => next.delete(p));
      return next;
    });
    const keys = ids.map(siteKey);
    applySelection(keys, keys[0], keys[0]);
    // The folder row comes into view, with its (now expanded) contents under it
    treeRef.current?.scrollToKey(folderKey(path), 'start');
    announce(selectedText(keys.length));
  };

  /** The selection panel's Close (and Escape with several selected): back to the focused row alone. */
  const reduceSelection = () => {
    const s = selection.stateRef.current;
    const row = rowOf(s.active);
    // With unsaved edits the form stays as it is; only the selection shrinks
    if (row && isItemRow(row) && !formDirtyRef.current) activate(row, 'key');
    else selection.selectOnly(row && isItemRow(row) ? row.key : formKey);
  };

  /* ---------------------------------- move ---------------------------------- */

  /** Opens Move to… for these items (Local is left out; sites inside a moved folder go with it). */
  const openMove = (keys: string[]) => {
    const { looseSites, folders } = resolveItems(model, keys);
    const count = looseSites.length + folders.length;
    if (count === 0) return;
    const parents = new Set<string>([...looseSites.map((s) => model.siteFolder.get(s.id) ?? ''), ...folders.map((f) => parentOf(f.path))]);
    const name = count === 1 ? looseSites[0]?.name ?? folders[0].name : null;
    setMoveReq({
      keys,
      title:
        name !== null
          ? t('siteTree.moveTitleOne', { name, defaultValue: 'Move “{{name}}” to…' })
          : t('siteTree.moveTitle', { count, formatted: formatCount(lang, count), defaultValue_one: 'Move 1 item to…', defaultValue_other: 'Move {{formatted}} items to…' }),
      current: parents.size === 1 ? [...parents][0] : null,
      moving: folders.map((f) => f.path),
    });
  };

  const movedTitle = (plan: MovePlan, target: string): string => {
    const count = plan.sites.length + plan.folders.length;
    const formatted = formatCount(lang, count);
    const folder = target.split('/').join(' / ');
    if (count === 1) {
      const name = plan.sites[0]?.name ?? baseName(plan.folders[0].from);
      return target
        ? t('siteTree.movedOne', { name, folder, defaultValue: 'Moved “{{name}}” to “{{folder}}”' })
        : t('siteTree.movedOneTop', { name, defaultValue: 'Moved “{{name}}” to the top level' });
    }
    if (!target) return t('siteTree.movedTop', { count, formatted, defaultValue_one: 'Moved 1 item to the top level', defaultValue_other: 'Moved {{formatted}} items to the top level' });
    if (plan.folders.length === 0) {
      return t('siteTree.moved', { count, formatted, folder, defaultValue_one: 'Moved 1 connection to “{{folder}}”', defaultValue_other: 'Moved {{formatted}} connections to “{{folder}}”' });
    }
    return t('siteTree.movedItems', { count, formatted, folder, defaultValue_one: 'Moved 1 item to “{{folder}}”', defaultValue_other: 'Moved {{formatted}} items to “{{folder}}”' });
  };

  /** One undoable batch; a folder name taken in the target asks to merge first. */
  const runMove = (keys: string[], target: string, merge: boolean) => {
    const plan = planMove(model, keys, target, { merge, createTarget: true });
    const failed = (text: string) => notify.error(t('siteTree.opFailed', "Couldn't update connections"), text);
    if (plan.intoSelf) return failed(t('siteTree.errIntoSelf', "A folder can't go inside itself."));
    if (plan.tooLong) return failed(t('siteTree.errPathTooLong', 'This path would be longer than 255 characters.'));
    if (plan.clashes.length > 0 && !merge) {
      const sites = plan.clashes.reduce((n, c) => n + (model.folders.get(c.path)?.count ?? 0), 0);
      setDeleteReq({
        request: { kind: 'merge', name: baseName(plan.clashes[0].existing), parent: target ? target.split('/').join(' / ') : null, sites },
        run: (choice) => {
          setDeleteReq(null);
          if (choice === 'merge') runMove(keys, target, true);
        },
      });
      return;
    }
    if (plan.ops.length === 0) return;
    // The moved items stay selected at their new place, which opens
    const moved = [...plan.sites.map((s) => siteKey(s.id)), ...plan.folders.map((f) => folderKey(f.to))];
    expandChain(target);
    if (moved.length > 0) {
      selection.selectKeys(moved, moved[0], moved[0]);
      scrollWhenShown(moved[0], false);
    }
    void tree.run(plan.ops).then((res) => {
      if (!res?.undo_token) return;
      const title = movedTitle(plan, target);
      tree.toastWithUndo({ title, token: res.undo_token });
      announce(title);
    });
  };

  /* ------------------------- cut / paste, new folder with ------------------------- */

  /** ⌘X: marks the items (rows at 50% opacity) until ⌘V moves them or Escape clears the marks. */
  const cutItems = (keys: string[]) => {
    const payload = dragPayload(model, keys);
    if (!payload) return;
    setCutKeys(new Set(payload.keys));
    announce(
      t('siteTree.a11yCut', {
        count: payload.count,
        formatted: formatCount(lang, payload.count),
        shortcut: shortcutLabels(mac).paste,
        defaultValue_one: 'Cut 1 item. Select a folder and press {{shortcut}} to move it.',
        defaultValue_other: 'Cut {{formatted}} items. Select a folder and press {{shortcut}} to move them.',
      })
    );
  };

  /** ⌘V / Paste: moves the cut items into `folder` (one undoable batch, like Move to…). */
  const pasteInto = (folder: string) => {
    const payload = dragPayload(model, cutKeys);
    if (!payload) {
      setCutKeys(EMPTY_SET);
      return;
    }
    if (checkDrop(payload, folder, false) === 'into_self') {
      // The marks stay, so another folder can be picked
      notify.error(t('siteTree.opFailed', "Couldn't update connections"), t('siteTree.errIntoSelf', "A folder can't go inside itself."));
      return;
    }
    setCutKeys(EMPTY_SET);
    runMove(payload.keys, folder, false);
  };

  /**
   * ⌃⌘N (Ctrl+Alt+N), menus A and D: one batch in the items' common parent (`create_folder` plus
   * the moves), so one ⌘Z undoes it; then the new folder's name is edited in place.
   */
  const newFolderWithItems = (keys: string[], merge = false) => {
    const { looseSites, folders } = resolveItems(model, keys);
    const count = looseSites.length + folders.length;
    if (count === 0) return;
    const parent = commonParent(model, keys);
    const name = pickFreeName(t('siteTree.newFolder', 'New folder'), childFolderNames(model, parent), (n) => t('siteTree.newFolderN', { n, defaultValue: 'New folder {{n}}' }));
    const path = joinPath(parent, name);
    const plan = planMove(model, keys, path, { merge, createTarget: true });
    if (plan.tooLong) {
      notify.error(t('siteTree.opFailed', "Couldn't update connections"), t('siteTree.errPathTooLong', 'This path would be longer than 255 characters.'));
      return;
    }
    if (plan.clashes.length > 0 && !merge) {
      // Two of the folders share a name: they merge in the new folder (after asking)
      const sites = plan.clashes.reduce((n, c) => n + (model.folders.get(c.path)?.count ?? 0), 0);
      setDeleteReq({
        request: { kind: 'merge', name: baseName(plan.clashes[0].existing), parent: path.split('/').join(' / '), sites },
        run: (choice) => {
          setDeleteReq(null);
          if (choice === 'merge') newFolderWithItems(keys, true);
        },
      });
      return;
    }
    if (plan.ops.length === 0) return;
    selection.selectOnly(folderKey(path));
    void tree.run(plan.ops, { errorParams: { name } }).then((res) => {
      if (res) {
        announce(
          t('siteTree.a11yFolderCreatedWith', {
            name,
            count,
            formatted: formatCount(lang, count),
            defaultValue_one: 'Folder “{{name}}” created with 1 item',
            defaultValue_other: 'Folder “{{name}}” created with {{formatted}} items',
          })
        );
      }
    });
    // The folder shows at once (the batch is applied locally first); its name is edited then
    startRenameByKey(folderKey(path));
  };

  /* ------------------------------ drag and drop ------------------------------ */

  /** What a drag from this row carries: the selection when the row is in it, else the row alone. Never Local. */
  const dragPayloadFor = (row: TreeRow): DragPayload | null => {
    if (row.kind !== 'site' && row.kind !== 'folder') return null;
    if (row.kind === 'site' && isLocalSite(row.site)) return null;
    const s = selection.stateRef.current;
    return dragPayload(model, s.keys.has(row.key) ? selectedItems(s.keys) : [canonicalKey(row.key)]);
  };

  /** Spring-loading (and folding back) during a drag; while searching, the search's own collapsed set. */
  const dragExpand = (paths: string[], expanded: boolean) => {
    if (paths.length === 0) return;
    updateCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of paths) {
        if (expanded ? next.delete(p) : !next.has(p) && !!next.add(p)) changed = true;
      }
      return changed ? next : prev;
    });
  };

  const dragHover = (spot: DropSpot | null, valid: boolean, copy: boolean) => {
    if (!spot) return;
    const name = spot.folder ? baseName(spot.folder) : t('siteTree.topLevel', 'Top level');
    if (!valid) announce(t('siteTree.a11yDragNotHere', "Can't drop here"));
    else if (spot.favoriteIndex !== undefined) announce(t('siteTree.a11yDragFavorite', 'Over Favorites. Release to add.'));
    else if (copy) announce(t('siteTree.a11yDragCopyOver', { name, defaultValue: 'Over {{name}}. Release to copy.' }));
    else announce(t('siteTree.a11yDragOver', { name, defaultValue: 'Over {{name}}. Release to move.' }));
  };

  /** A drop: one batch (a move, or copies with ⌥/Alt). Folders spring-loading opened fold back unless they took it. */
  const dropItems = (payload: DragPayload, folder: string, copy: boolean, springOpened: string[]) => {
    const keep = new Set(folderChain(folder));
    dragExpand(
      springOpened.filter((p) => !keep.has(p)),
      false
    );
    if (copy) void runCopies(payload.keys, folder);
    else runMove(payload.keys, folder, false);
  };

  /* --------------------------- favorites and recent --------------------------- */

  const favoriteText = (on: boolean, n: number) =>
    on
      ? t('siteTree.favAdded', { count: n, formatted: formatCount(lang, n), defaultValue_one: 'Added to favorites', defaultValue_other: 'Added {{formatted}} items to favorites' })
      : t('siteTree.favRemoved', { count: n, formatted: formatCount(lang, n), defaultValue_one: 'Removed from favorites', defaultValue_other: 'Removed {{formatted}} items from favorites' });

  /** Saves a new favorites list (one undoable op); refuses a list over the limit. */
  const writeFavorites = (next: FavoriteRef[], done?: () => void) => {
    if (sameFavorites(next, model.favorites)) return;
    if (next.length > MAX_FAVORITES) {
      notify.error(t('siteTree.errTooManyFavorites', { max: MAX_FAVORITES, defaultValue: 'You can keep up to {{max}} favorites.' }));
      return;
    }
    void tree.run([{ op: 'set_favorites', items: next }]).then((res) => {
      if (res) done?.();
    });
  };

  /** ⌘D, the Star buttons, the menus: adds the items to the favorites, or removes them when all of them are favorites. */
  const toggleFavorites = (keys: string[]) => {
    const items = [...new Set(keys.map(canonicalKey))].filter((k) => favoriteRefOf(k) !== null);
    if (items.length === 0) return;
    const on = !allFavorites(model, items);
    const next = setFavorites(model.favorites, items, on);
    const changed = Math.abs(next.length - model.favorites.length);
    writeFavorites(next, () => announce(favoriteText(on, changed)));
  };

  /** ⌥⌘↑ / ⌥⌘↓ on a favorite: one place up or down (it stays selected). */
  const reorderFavorite = (row: TreeRow, delta: number) => {
    if (row.section !== 'fav' || row.depth !== 0 || !isItemRow(row)) return;
    const key = canonicalKey(row.key);
    const next = moveFavorite(model.favorites, key, delta);
    if (!next) return;
    selection.selectOnly(row.key);
    scrollWhenShown(row.key, false);
    const pos = next.findIndex((f) => favoriteKey(f) === key) + 1;
    writeFavorites(next, () => announce(t('siteTree.a11yFavMoved', { pos, total: next.length, defaultValue: 'Moved to position {{pos}} of {{total}}' })));
  };

  /** A drop on Favorites: the items join (or move to) position `index`; they end up selected there. */
  const dropFavorites = (payload: DragPayload, index: number) => {
    const before = model.favorites;
    const next = insertFavorites(before, payload.keys, index);
    const added = next.length - before.length;
    if (collapsedSections.has('fav')) setCollapsedSections((prev) => new Set([...prev].filter((s) => s !== 'fav')));
    const keys = payload.keys.map((k) => `fav:${k}`);
    selection.selectKeys(keys, keys[0], keys[0]);
    scrollWhenShown(keys[0], false);
    writeFavorites(next, () => announce(added > 0 ? favoriteText(true, added) : t('siteTree.favReordered', 'Favorites reordered')));
  };

  /** "Remove from recent" (a view change: not undoable, like the backend's recents). */
  const removeRecent = (id: string) => {
    tree.updateView({ forget_recents: [id] });
    announce(t('siteTree.a11yRecentRemoved', 'Removed from recent'));
  };

  const clearRecent = () => {
    tree.updateView({ clear_recents: true });
    announce(t('siteTree.a11yRecentCleared', 'Recent cleared'));
  };

  /** "Show in folder": the item's own row in All connections, revealed, selected and focused. */
  const showInFolder = (itemKey: string) => {
    const ref = parseItemKey(itemKey);
    if (!ref) return;
    if (searching) setQuery('');
    if (collapsedSections.has('all')) setCollapsedSections((prev) => new Set([...prev].filter((s) => s !== 'all')));
    if (ref.kind === 'site') expandChain(model.siteFolder.get(ref.id) ?? '');
    else expandChain(ref.path, false);
    selection.selectOnly(itemKey);
    if (ref.kind === 'site' && itemKey !== formKey && !formDirtyRef.current) {
      const site = model.sitesById.get(ref.id);
      if (site) onSelectSite(site);
    }
    treeRef.current?.scrollToKey(itemKey, 'center');
    treeRef.current?.focus();
  };

  const hideSection = (section: 'fav' | 'rec') => setView(section === 'fav' ? { showFavorites: false } : { showRecent: false });

  /* --------------------------------- menus --------------------------------- */

  const menuActions: MenuActions = {
    connect: (site) => onConnectSite(site),
    editDetails: (site) => onEditSite(site),
    renameSite: (site) => startRenameByKey(siteKey(site.id)),
    duplicate: (site) => void duplicateSites([site]),
    share: onShareSite ? (site) => onShareSite(site) : undefined,
    copyAddress: (site) => void copySiteAddresses([site]),
    deleteItems,
    moveItems: openMove,
    duplicateItems: duplicate,
    copyAddresses: (keys) => void copySiteAddresses(resolveItems(model, keys).sites),
    selectInside,
    newFolderWith: (keys) => newFolderWithItems(keys),
    duplicateFolder: (path) => duplicate([folderKey(path)]),
    paste: cutKeys.size > 0 ? pasteInto : undefined,
    newConnection: (folder) => onNewConnection(folder),
    newFolder: (parent) => startNewFolder(parent),
    renameFolder: (path) => startRenameByKey(folderKey(path)),
    setSubtreeExpanded: (path, expanded) => setExpanded(path, expanded, true),
    setAllExpanded,
    openVault: (tab) => onOpenVault(tab),
    openShared: onOpenSharedConnection,
    toggleFavorites,
    showInFolder,
    removeRecent,
    clearRecent,
    hideSection,
    setView,
  };
  const menuCtx: MenuContext = { t, actions: menuActions, mac };
  const expandState = { hasFolders: folderPaths.length > 0, anyExpanded, anyCollapsed };
  const viewState: ViewMenuState = { prefs, density };

  const openMenu = (at: MenuAnchor, entries: ContextMenuEntry[] | 'view', label: string, focusFirst: boolean) => setMenu({ at, entries, label, focusFirst });

  /** Menu A or B for a site, with its favorite state. */
  const siteEntries = (site: ConnectionConfig) => {
    const favorite = model.favoriteSites.has(site.id);
    return isLocalSite(site) ? localMenu(site, menuCtx, { favorite }) : siteMenu(site, menuCtx, { favorite });
  };

  /** Menu D for the items of a multi-selection. */
  const openMultiMenu = (keys: string[], at: MenuAnchor, focusFirst: boolean) => {
    let sites = 0;
    let folders = 0;
    let hasAddress = false;
    let favoriteCount = 0;
    for (const k of keys) {
      if (favoriteRefOf(k)) favoriteCount++;
      const ref = parseItemKey(k);
      if (ref?.kind === 'folder') folders++;
      else if (ref?.kind === 'site') {
        const site = model.sitesById.get(ref.id);
        if (!site || isLocalSite(site)) continue;
        sites++;
        if (!hasAddress && copyAddress(site)) hasAddress = true;
      }
    }
    openMenu(
      at,
      multiMenu({ keys, sites, folders, hasAddress, favoriteCount, allFavorite: allFavorites(model, keys), format: (n) => formatCount(lang, n) }, menuCtx),
      selectedText(keys.length),
      focusFirst
    );
  };

  const menuForRow = (row: TreeRow | null, at: MenuAnchor, focusFirst: boolean) => {
    // Right-click inside a multi-selection keeps it; Shift+F10 / the ContextMenu key (focusFirst)
    // always opens the selection's menu
    if (row && (isItemRow(row) || focusFirst)) {
      const s = selection.stateRef.current;
      const items = s.keys.has(row.key) || focusFirst ? selectedItems(s.keys) : [];
      if (items.length > 1) {
        openMultiMenu(items, at, focusFirst);
        return;
      }
    }
    if (row?.kind === 'section' && row.sectionId !== 'all') {
      // H: the Favorites or Recent header
      const name = row.sectionId === 'fav' ? t('siteTree.sectionFavorites', 'Favorites') : t('siteTree.sectionRecent', 'Recent');
      openMenu(at, sectionMenu(row.sectionId, menuCtx), name, focusFirst);
      return;
    }
    if (!row || row.kind === 'section') {
      openMenu(at, emptyAreaMenu(menuCtx, expandState, viewState), t('siteTree.sectionAll', 'All connections'), focusFirst);
      return;
    }
    // F applies to the favorites themselves; rows inside an expanded favorite folder get A / C
    const favoriteRow = row.section === 'fav' && row.depth === 0;
    if (row.kind === 'site') {
      // Right-click on an unselected row selects it first
      if (!selection.stateRef.current.keys.has(row.key)) {
        if (formDirtyRef.current || `s:${row.site.id}` === formKey) selection.selectOnly(row.key);
        else {
          selection.setActive(row.key);
          onSelectSite(row.site);
        }
      }
      let entries: ContextMenuEntry[];
      if (favoriteRow) entries = favoriteMenu({ kind: 'site', site: row.site, local: isLocalSite(row.site) }, menuCtx);
      else if (row.section === 'rec') entries = recentMenu(row.site, menuCtx, { favorite: model.favoriteSites.has(row.site.id) });
      else entries = siteEntries(row.site);
      openMenu(at, entries, row.site.name, focusFirst);
      return;
    }
    if (row.kind === 'folder' || row.kind === 'placeholder') {
      const path = row.kind === 'folder' ? row.path : row.folder;
      const node = model.folders.get(path);
      if (!node) return;
      if (row.kind === 'folder' && !selection.stateRef.current.keys.has(row.key)) selection.selectOnly(row.key);
      const entries =
        row.kind === 'folder' && favoriteRow ? favoriteMenu({ kind: 'folder', node }, menuCtx) : folderMenu(node, menuCtx, { favorite: model.favoriteFolders.has(path) });
      openMenu(at, entries, node.name, focusFirst);
    }
    // The draft and the inline new-folder row have no menu
  };

  /* --------------------------------- actions -------------------------------- */

  const activate = (row: TreeRow, how: 'click' | 'space' | 'key') => {
    switch (row.kind) {
      case 'site':
        if (`s:${row.site.id}` === formKey) selection.selectOnly(row.key);
        else {
          selection.setActive(row.key);
          onSelectSite(row.site);
        }
        return;
      case 'draft':
        selection.selectOnly(row.key);
        if (how === 'click') onFocusDraft();
        return;
      case 'newFolder':
        selection.setActive(row.key);
        return;
      case 'address':
        selection.setActive(row.key);
        // Arrowing over it only moves focus; a click or Space opens the form
        if (how !== 'key') newConnectionTo(row.address);
        return;
      default:
        selection.selectOnly(row.key);
    }
  };

  /** The address row: a new connection filled in from the search text (the search clears, so the draft shows). */
  const newConnectionTo = (text: string) => {
    setQuery('');
    onNewConnectionTo(text);
  };

  const toggleRow = (row: TreeRow, subtree: boolean, expand?: boolean) => {
    if (row.kind === 'section') {
      const open = expand ?? !row.expanded;
      setCollapsedSections((prev) => {
        if (open !== prev.has(row.sectionId)) return prev;
        const next = new Set(prev);
        if (open) next.delete(row.sectionId);
        else next.add(row.sectionId);
        return next;
      });
      return;
    }
    if (row.kind !== 'folder') return;
    const open = expand ?? !row.expanded;
    if (row.section === 'fav' && row.depth === 0) {
      // A favorite folder expands in place (its subfolders keep their own state)
      if (open !== row.expanded) {
        setFavoriteExpanded((prev) => {
          const next = new Set(prev);
          if (open) next.add(row.path);
          else next.delete(row.path);
          return next;
        });
      }
      if (subtree) setExpanded(row.path, open, true);
      else if (open !== row.expanded) announce(open ? t('siteTree.a11yExpanded', 'Folder expanded') : t('siteTree.a11yCollapsed', 'Folder collapsed'));
      return;
    }
    if (open === row.expanded && !subtree) return;
    setExpanded(row.path, open, subtree);
  };

  const focusSearch = (append?: string) => {
    const input = searchRef.current;
    if (!input) return;
    input.focus();
    if (append) {
      const next = query + append;
      setQuery(next);
      requestAnimationFrame(() => input.setSelectionRange(next.length, next.length));
    } else {
      input.select();
    }
  };

  const actionsRef = useRef<TreeActions>(null as unknown as TreeActions);
  actionsRef.current = {
    activate: (row, how) => activate(row, how),
    move: (row) => {
      // With unsaved edits only the focus moves; Space, Enter or a click selects
      if (formDirtyRef.current) selection.setActive(row.key);
      else activate(row, 'key');
    },
    toggleSelect,
    extendSelect,
    selectAll,
    moveTo: (row) => openMove(itemsFor(row)),
    open: (row) => {
      switch (row.kind) {
        case 'site':
          // Connecting several at once comes later (Connect N): Enter connects the focused one
          if (selectedItems(selection.stateRef.current.keys).length > 1) selection.selectOnly(row.key);
          onConnectSite(row.site);
          return;
        case 'address':
          newConnectionTo(row.address);
          return;
        case 'folder':
        case 'section':
          toggleRow(row, false);
          return;
        case 'draft':
          onFocusDraft();
          return;
        case 'placeholder':
          onNewConnection(row.folder);
          return;
        default:
          return;
      }
    },
    toggle: toggleRow,
    toggleAll: () => setAllExpanded(!anyExpanded),
    expandSiblings: (row) => {
      const parent = row.kind === 'folder' ? parentOf(row.path) : row.kind === 'site' ? row.folder : '';
      const node = model.folders.get(parent);
      if (!node) return;
      const paths = node.folders.map((f) => f.path);
      updateCollapsed((prev) => {
        if (!paths.some((p) => prev.has(p))) return prev;
        const next = new Set(prev);
        paths.forEach((p) => next.delete(p));
        return next;
      });
    },
    menu: menuForRow,
    rename: startRename,
    editDetails: (row) => {
      if (row.kind === 'site') onEditSite(row.site);
      else if (row.kind === 'folder') startRename(row);
      else if (row.kind === 'draft') onFocusDraft();
    },
    newConnection: (row) => onNewConnection(folderOfRow(row)),
    newFolder: (row) => startNewFolder(folderOfRow(row)),
    duplicate: (row) => duplicate(itemsFor(row)),
    copyAddress: (row) => void copySiteAddresses(resolveItems(model, itemsFor(row)).sites),
    remove: (row) => deleteItems(itemsFor(row)),
    focusSearch,
    cut: (row) => cutItems(itemsFor(row)),
    paste: (row) => {
      if (cutKeys.size > 0) pasteInto(folderOfRow(row));
    },
    newFolderWith: (row) => newFolderWithItems(itemsFor(row)),
    dragPayload: dragPayloadFor,
    dragExpand,
    dragHover,
    drop: dropItems,
    dragActive: setDragging,
    canFavorite: (payload, index) => checkFavoriteDrop(model.favorites, payload.keys, index) === 'ok',
    dropFavorite: dropFavorites,
    toggleFavorite: (row, onlyRow) => toggleFavorites(onlyRow ? (isItemRow(row) ? [canonicalKey(row.key)] : []) : itemsFor(row)),
    reorderFavorite,
    clearRecent,
    revealCrumb: (path) => {
      const key = folderKey(path);
      selection.selectOnly(key);
      treeRef.current?.scrollToKey(key, 'start');
      treeRef.current?.focus();
    },
  };

  /* ------------------------------ escape layer ------------------------------ */

  const escapeRef = useRef<() => boolean>(() => false);
  escapeRef.current = () => {
    if (rename || newFolder) {
      closeEdit();
      return true;
    }
    // A drag, then the cut marks (spec §6, steps 2 and 3)
    if (treeRef.current?.cancelDrag()) return true;
    if (cutKeys.size > 0) {
      setCutKeys(EMPTY_SET);
      return true;
    }
    if (paneEscapeRef.current?.()) return true;
    if (showTips) {
      setShowTips(false);
      return true;
    }
    const activeEl = document.activeElement;
    const inSidebar = !!activeEl && !!asideRef.current?.contains(activeEl);
    if (inSidebar && activeEl === searchRef.current) {
      if (query) setQuery('');
      else treeRef.current?.focus();
      return true;
    }
    if (inSidebar && query) {
      setQuery('');
      return true;
    }
    if (inSidebar && selectedItems(selection.keys).length > 1) {
      reduceSelection();
      return true;
    }
    return false;
  };
  useEffect(() => {
    const layers = escapeLayers.current;
    const layer = () => escapeRef.current();
    layers.push(layer);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [escapeLayers]);

  /* ------------------------------ imperative api ------------------------------ */

  apiRef.current = {
    revealFolder: (path, opts) => {
      if (searching) setQuery('');
      expandChain(path, false);
      const key = folderKey(path);
      if (opts?.select) selection.selectOnly(key);
      treeRef.current?.scrollToKey(key, 'center');
      if (opts?.focus) treeRef.current?.focus();
    },
    revealImported: (folders) => {
      setQuery('');
      const paths = new Set<string>();
      for (const f of folders) for (const p of folderChain(f)) paths.add(p);
      if (paths.size === 0) return;
      tree.setCollapsed((prev) => {
        if (![...paths].some((p) => prev.has(p))) return prev;
        const next = new Set(prev);
        paths.forEach((p) => next.delete(p));
        return next;
      });
      pendingReveal.current = paths;
    },
    openItemMenu: (itemKey, rect) => {
      const row = rowOf(itemKey);
      const at: MenuAnchor = { rect, placement: 'below' };
      if (row) {
        menuForRow(row, at, false);
        return;
      }
      const ref = parseItemKey(itemKey);
      const site = ref?.kind === 'site' ? model.sitesById.get(ref.id) : undefined;
      if (site) openMenu(at, siteEntries(site), site.name, false);
    },
    toggleFavorite: (itemKey) => toggleFavorites([itemKey]),
  };
  useEffect(
    () => () => {
      apiRef.current = null;
    },
    [apiRef]
  );

  /* ------------------------------- search keys ------------------------------- */

  const firstResultRow = () => rows.find((r) => r.kind !== 'section');
  const firstSiteRow = () => rows.find((r): r is Extract<TreeRow, { kind: 'site' }> => r.kind === 'site');

  const onSearchArrowDown = () => {
    const row = firstResultRow();
    if (row) {
      selection.setActive(row.key);
      treeRef.current?.scrollToKey(row.key);
    }
    treeRef.current?.focus();
  };

  const onSearchEnter = (connect: boolean) => {
    const row = firstSiteRow();
    if (!row) {
      // Nothing matches but the text is an address: open the filled-in form (never connect)
      const addr = rows.find((r): r is Extract<TreeRow, { kind: 'address' }> => r.kind === 'address');
      if (addr) newConnectionTo(addr.address);
      return;
    }
    if (connect) {
      onConnectSite(row.site);
      return;
    }
    activate(row, 'key');
    treeRef.current?.scrollToKey(row.key);
    treeRef.current?.focus();
  };

  /* ------------------------------ sidebar keys ------------------------------ */

  // ⌘N / ⇧⌘N / ⌃⌘N anywhere in the sidebar (the tree handles its own keys first)
  const onAsideKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const lower = e.key.toLowerCase();
    const withSelection = mac ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
    // Not in the search field: Ctrl+Alt is AltGr on many Windows layouts (AltGr+N types a letter)
    const inField = (e.target as HTMLElement).closest?.('input, textarea') != null;
    if (withSelection && !inField && !e.shiftKey && (lower === 'n' || e.code === 'KeyN')) {
      e.preventDefault();
      newFolderWithItems(itemsFor(selectedRow()));
      return;
    }
    const mod = mac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || (mac && e.ctrlKey) || lower !== 'n') return;
    e.preventDefault();
    const row = selectedRow();
    if (e.shiftKey) startNewFolder(folderOfRow(row));
    else onNewConnection(folderOfRow(row));
  };

  /* ---------------------------------- resize ---------------------------------- */

  useEffect(() => {
    const parent = asideRef.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setContainerWidth(parent.clientWidth));
    ro.observe(parent);
    setContainerWidth(parent.clientWidth);
    return () => ro.disconnect();
  }, []);
  const maxWidth = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, containerWidth ? containerWidth - FORM_MIN : WIDTH_MAX));
  const shownWidth = Math.max(WIDTH_MIN, Math.min(width, maxWidth));

  const commitWidth = (w: number) => {
    const clamped = Math.round(Math.max(WIDTH_MIN, Math.min(w, maxWidth)));
    setWidth(clamped);
    writeStorage(WIDTH_KEY, String(clamped));
  };

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = shownWidth;
    let last = startW;
    const onMove = (ev: PointerEvent) => {
      last = Math.max(WIDTH_MIN, Math.min(startW + ev.clientX - startX, maxWidth));
      setWidth(last);
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      commitWidth(last);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  /* ---------------------------------- render ---------------------------------- */

  const k = shortcutLabels(mac);
  const total = model.totalSites;
  const onlyLocal = total === 0 && !searching;
  const footerMenu = (btn: HTMLElement) => openMenu({ rect: btn.getBoundingClientRect(), placement: 'above' }, importExportEntries(menuCtx), t('siteTree.importExportMenu', 'Import & export'), false);
  const overlayTop = rows.length * rowHeight + 8;

  const selectedCount = useMemo(() => selectedItems(selection.keys).length, [selection.keys]);

  /* ------------------------------ filter menu ------------------------------ */

  const protocolOptions = useMemo(
    () => protocolBreakdown(model.sitesById.values()).map((p) => ({ value: p.protocol, label: p.tag, count: formatCount(lang, p.count) })),
    [model, lang]
  );
  const openFilters = (rect: DOMRect, viaKeyboard: boolean) =>
    setMenu({ at: { rect, placement: 'below' }, entries: 'filter', label: t('siteTree.filters', 'Filters'), focusFirst: viaKeyboard });
  const filterEntries = (): ContextMenuEntry[] =>
    filterMenu(menuCtx, {
      is: activeValues(parsedNow, 'is'),
      protocols: activeValues(parsedNow, 'p'),
      auth: activeValues(parsedNow, 'auth'),
      protocolOptions,
      hasFavorites: model.favorites.length > 0,
      hasRecents: model.recents.length > 0,
      hasQualifiers: parsedNow.hasQualifiers,
      toggle: (key, value, on) => setQuery(toggleQualifier(query, key, value, on)),
      openTips: () => setShowTips(true),
      clear: () => setQuery(clearQualifiers(query)),
    });

  /* ------------------------------- right pane ------------------------------- */

  const pane = useMemo(() => (formDirty ? ({ kind: 'form' } as const) : paneFor(selection.keys)), [formDirty, selection.keys]);
  let paneMode: PaneMode = 'form';
  let paneContent: React.ReactNode = null;
  if (pane.kind === 'root' || pane.kind === 'folder') {
    const node = pane.kind === 'folder' ? model.folders.get(pane.path) ?? null : null;
    if (pane.kind === 'root' || node) {
      paneMode = 'folder';
      paneContent = (
        <FolderPane
          node={node}
          model={model}
          onRename={requestFolderRename}
          onMove={() => node && openMove([folderKey(node.path)])}
          onDelete={() => node && deleteItems([folderKey(node.path)])}
          onNewFolder={() => startNewFolder(node?.path ?? '')}
          onNewConnection={() => onNewConnection(node?.path ?? '')}
          onReveal={(path) => {
            if (path) apiRef.current?.revealFolder(path, { select: true, focus: true });
            else {
              selection.selectOnly('sec:all');
              treeRef.current?.scrollToKey('sec:all');
              treeRef.current?.focus();
            }
          }}
          onClose={onCloseDialog}
          escapeRef={paneEscapeRef}
        />
      );
    }
  } else if (pane.kind === 'selection') {
    const ordered = [...pane.items].sort((a, b) => (indexByKey.get(a) ?? Infinity) - (indexByKey.get(b) ?? Infinity));
    const items: SelectedItem[] = [];
    for (const k of ordered) {
      const ref = parseItemKey(k);
      if (ref?.kind === 'site') {
        const site = model.sitesById.get(ref.id);
        if (site) items.push({ kind: 'site', site });
      } else if (ref?.kind === 'folder') {
        const node = model.folders.get(ref.path);
        if (node) items.push({ kind: 'folder', node });
      }
    }
    if (items.length > 1) {
      paneMode = 'selection';
      paneContent = (
        <SelectionPane
          items={items}
          onMove={() => openMove(pane.items)}
          onDelete={() => deleteItems(pane.items)}
          allFavorite={allFavorites(model, pane.items)}
          onFavorite={() => toggleFavorites(pane.items)}
          onClose={reduceSelection}
        />
      );
    }
  }
  useLayoutEffect(() => {
    onPaneModeChange(paneMode);
  }, [paneMode, onPaneModeChange]);

  let status: React.ReactNode;
  if (selectedCount > 1) {
    status = selectedText(selectedCount);
  } else if (searching) {
    status = (
      <>
        {t('siteTree.statusMatches', { matches: formatCount(lang, matchCount), total: formatCount(lang, total), defaultValue: '{{matches}} of {{total}}' })}
        {' · '}
        <button type="button" onClick={() => setQuery('')} className="text-ink-muted hover:text-ink hover:underline underline-offset-2">
          {t('siteTree.clear', 'Clear')}
        </button>
      </>
    );
  } else {
    const parts = [
      t('siteTree.statusConnections', {
        count: total,
        formatted: formatCount(lang, total),
        defaultValue_zero: 'No connections',
        defaultValue_one: '1 connection',
        defaultValue_other: '{{formatted}} connections',
      }),
    ];
    if (model.totalFolders > 0) {
      parts.push(
        t('siteTree.statusFolders', {
          count: model.totalFolders,
          formatted: formatCount(lang, model.totalFolders),
          defaultValue_one: '1 folder',
          defaultValue_other: '{{formatted}} folders',
        })
      );
    }
    status = parts.join(' · ');
  }

  return (
    <aside
      ref={asideRef}
      className="shrink-0 bg-dark-850 border-r border-line flex flex-col select-none relative min-h-0"
      style={{ width: shownWidth }}
      onKeyDown={onAsideKeyDown}
    >
      {/* Search comes first in the tab order, though it sits under the header */}
      <div className="order-2 flex flex-col">
        <SiteSearchBar
          value={query}
          onChange={setQuery}
          inputRef={searchRef}
          total={total}
          autoFocus={total > 0}
          onArrowDown={onSearchArrowDown}
          onEnter={onSearchEnter}
          filtersActive={parsedNow.hasQualifiers}
          onOpenFilters={openFilters}
        />
        <FilterPills
          parsed={parsedNow}
          onRemove={(index) => {
            setQuery(removeToken(query, index));
            searchRef.current?.focus();
          }}
        />
        {showTips && <SearchTips onClose={() => setShowTips(false)} />}
      </div>

      <div className="order-1 h-12 shrink-0 px-3 pt-3 pb-2 flex items-center gap-1">
        <h2 className="flex-1 min-w-0 truncate text-[15px] font-semibold text-ink">{t('loginDialog.title', 'Connections')}</h2>
        <button
          type="button"
          className="ui-icon-btn ui-icon-btn-sm"
          title={`${t('siteTree.newFolder', 'New folder')} (${k.newFolder})`}
          aria-label={t('siteTree.newFolder', 'New folder')}
          aria-keyshortcuts={mac ? 'Meta+Shift+N' : 'Control+Shift+N'}
          onClick={() => startNewFolder(folderOfRow(selectedRow()))}
        >
          <FolderPlus className="w-4 h-4" />
        </button>
        <button
          type="button"
          className="ui-icon-btn ui-icon-btn-sm"
          title={`${t('loginDialog.newConnection', 'New connection')} (${k.newConnection})`}
          aria-label={t('loginDialog.newConnection', 'New connection')}
          aria-keyshortcuts={mac ? 'Meta+N' : 'Control+N'}
          onClick={() => onNewConnection(folderOfRow(selectedRow()))}
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          type="button"
          className="ui-icon-btn ui-icon-btn-sm"
          title={t('siteTree.viewOptions', 'View options')}
          aria-label={t('siteTree.viewOptions', 'View options')}
          aria-haspopup="menu"
          onClick={(e) => openMenu({ rect: e.currentTarget.getBoundingClientRect(), placement: 'below' }, 'view', t('siteTree.viewOptions', 'View options'), e.detail === 0)}
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
      </div>

      <div className="order-3 flex-1 min-h-0 relative">
        <SiteTree
          ref={treeRef}
          rows={rows}
          indexByKey={indexByKey}
          rowHeight={rowHeight}
          compact={density === 'compact'}
          showAddress={prefs.showAddress}
          selection={selection}
          nameTerms={nameTerms}
          addressTerms={addressTerms}
          anyExpanded={anyExpanded}
          edit={edit}
          actionsRef={actionsRef}
          ariaLabel={t('loginDialog.title', 'Connections')}
          describedById={descId}
          cutKeys={cutKeys}
        />
        {onlyLocal && (
          <div className="absolute inset-x-3 flex flex-col items-center gap-1 text-center" style={{ top: overlayTop }}>
            <p className="py-4 text-[13px] text-ink-muted">{t('siteTree.noSaved', 'No saved connections yet')}</p>
            <Button variant="ghost" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => onNewConnection('')}>
              {t('loginDialog.newConnection', 'New connection')}
            </Button>
            <Button variant="ghost" size="sm" icon={<FolderInput className="w-3.5 h-3.5" />} onClick={() => onOpenVault('winscp')}>
              {t('loginDialog.importWinscp', 'Import from WinSCP…')}
            </Button>
            <Button variant="ghost" size="sm" icon={<ArrowDownUp className="w-3.5 h-3.5" />} onClick={() => onOpenVault()}>
              {t('siteTree.importExportVault', 'Import or export vault…')}
            </Button>
            {onOpenSharedConnection && (
              <Button variant="ghost" size="sm" icon={<FileKey2 className="w-3.5 h-3.5" />} onClick={onOpenSharedConnection}>
                {t('loginDialog.openShared', 'Open shared connection…')}
              </Button>
            )}
          </div>
        )}
        {noResults && (
          <div className="absolute inset-x-3 flex flex-col items-center gap-2 text-center" style={{ top: overlayTop }}>
            <p className="pt-3 text-[13px] text-ink-muted break-words max-w-full">{t('siteTree.noResults', { query: query.trim(), defaultValue: 'No connections match “{{query}}”' })}</p>
            <Button variant="secondary" size="sm" onClick={() => setQuery('')}>
              {t('siteTree.clearSearch', 'Clear search')}
            </Button>
            <p className="text-[11.5px] text-ink-faint">{t('siteTree.noResultsHint', 'Try p:sftp, in:folder, user:, is:fav')}</p>
          </div>
        )}
      </div>

      {/* Resize handle (between the tree and the footer in the tab order) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('siteTree.resizeSidebar', 'Resize the connections list')}
        aria-valuenow={shownWidth}
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={maxWidth}
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onDoubleClick={() => commitWidth(WIDTH_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            commitWidth(shownWidth + (e.key === 'ArrowRight' ? 16 : -16));
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            commitWidth(e.key === 'Home' ? WIDTH_MIN : maxWidth);
          }
        }}
        className="absolute top-0 bottom-0 -right-[3px] w-1.5 z-10 cursor-col-resize flex justify-center group/resize focus-visible:[outline-offset:-1px]"
      >
        <div className="w-px h-full group-hover/resize:bg-line-strong" />
      </div>

      <div className="order-4 h-6 shrink-0 px-3 flex items-center text-[11.5px] text-ink-faint tabular-nums truncate">
        <span className="truncate">{status}</span>
      </div>

      <div className="order-5 h-11 shrink-0 border-t border-line px-2 flex items-center">
        <Button variant="ghost" size="sm" icon={<ArrowDownUp className="w-3.5 h-3.5" />} aria-haspopup="menu" onClick={(e) => footerMenu(e.currentTarget)}>
          {t('siteTree.importExportMenu', 'Import & export')}
          <ChevronDown className="w-3.5 h-3.5 text-ink-faint" aria-hidden />
        </Button>
      </div>

      <span id={descId} className="sr-only">
        {t('siteTree.a11yInstructions', 'Enter connects, F2 renames, Shift+F10 opens actions')}
      </span>
      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>

      {menu && (
        <ContextMenu
          at={menu.at}
          entries={menu.entries === 'filter' ? filterEntries() : menu.entries === 'view' ? viewOptionsMenu(menuCtx, expandState, viewState) : menu.entries}
          // pt-BR labels run long ("Usadas nos últimos 30 dias" plus a count, "Mostrar resultados da busca em lista")
          width={menu.entries === 'filter' ? 268 : menu.entries === 'view' ? 284 : undefined}
          ariaLabel={menu.label}
          focusFirst={menu.focusFirst}
          onClose={() => setMenu(null)}
        />
      )}
      {deleteReq && <DeleteItemsDialog request={deleteReq.request} onChoose={deleteReq.run} onCancel={() => setDeleteReq(null)} />}
      {moveReq && (
        <MoveToDialog
          mode="move"
          title={moveReq.title}
          folders={folderPaths}
          current={moveReq.current}
          moving={moveReq.moving}
          onChoose={(target) => {
            setMoveReq(null);
            runMove(moveReq.keys, target, false);
          }}
          onCancel={() => setMoveReq(null)}
        />
      )}
      {paneHost && paneContent && createPortal(paneContent, paneHost)}
    </aside>
  );
};
