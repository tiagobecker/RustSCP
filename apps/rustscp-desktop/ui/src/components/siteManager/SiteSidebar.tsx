import React, { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
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
import { SiteSearchBar } from './SiteSearchBar.tsx';
import { SiteTree } from './SiteTree.tsx';
import type { SiteTreeHandle, TreeActions } from './SiteTree.tsx';
import type { RowEditState } from './SiteTreeRow.tsx';
import { emptyAreaMenu, folderMenu, importExportEntries, localMenu, shortcutLabels, siteMenu, viewOptionsMenu } from './siteMenus.tsx';
import type { MenuActions, MenuContext } from './siteMenus.tsx';
import { highlightTerms, matchContext, parseQuery, searchTree } from './siteQuery.ts';
import {
  MAX_SITE_NAME_LEN,
  VIEW_PREFS_KEY,
  buildTree,
  charLength,
  childFolderNames,
  copyAddress,
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
  rowFolderPath,
  rowHeightFor,
  siteKey,
} from './siteTreeModel.ts';
import type { FolderNameProblem } from './siteTreeModel.ts';
import type { FolderNode, SectionId, SiteTreeOp, TreeRow } from './types.ts';
import type { SiteTreeController } from './useSiteTree.ts';
import { canonicalKey, useTreeSelection } from './useTreeSelection.ts';

/** What LoginDialog can ask of the sidebar (the form header, imports). */
export interface SiteSidebarApi {
  /** Expands the folder's chain, scrolls to it and (optionally) selects it */
  revealFolder: (path: string, opts?: { select?: boolean; focus?: boolean }) => void;
  /** After an import: clears the search, expands the imported folders and selects the first one */
  revealImported: (folders: string[]) => void;
  /** The form header's ⋯: the item's menu anchored to the button */
  openItemMenu: (itemKey: string, rect: DOMRect) => void;
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
  formDirty: boolean;
  /** Loads a site into the form, through the unsaved-changes check unless `force` */
  onSelectSite: (site: ConnectionConfig, opts?: { force?: boolean }) => void;
  onConnectSite: (site: ConnectionConfig) => void;
  onNewConnection: (folder: string) => void;
  /** Loads the site (if needed) and focuses its first field */
  onEditSite: (site: ConnectionConfig) => void;
  onFocusDraft: () => void;
  onShareSite?: (site: ConnectionConfig) => void;
  onOpenVault: (tab?: 'winscp') => void;
  onOpenSharedConnection?: () => void;
  /** LoginDialog's escape registry; the sidebar adds one handler (rename, search) */
  escapeLayers: MutableRefObject<Array<() => boolean>>;
  apiRef: MutableRefObject<SiteSidebarApi | null>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_TERMS: readonly string[] = [];

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
  entries: ContextMenuEntry[];
  label: string;
  focusFirst: boolean;
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
  formDirty,
  onSelectSite,
  onConnectSite,
  onNewConnection,
  onEditSite,
  onFocusDraft,
  onShareSite,
  onOpenVault,
  onOpenSharedConnection,
  escapeLayers,
  apiRef,
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
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<SectionId>>(() => new Set());
  const [prefs] = useState(() => parseViewPrefs(readStorage(VIEW_PREFS_KEY)));
  const selection = useTreeSelection(formKey);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [newFolder, setNewFolder] = useState<NewFolderState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleteReq, setDeleteReq] = useState<{ request: DeleteRequest; run: (choice: DeleteChoice) => void } | null>(null);
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
  const searching = !parsed.isEmpty;
  const search = useMemo(() => (searching ? searchTree(model, parsed, matchContext(model)) : null), [model, parsed, searching]);
  const draft = useMemo(() => (draftFolder !== null ? { folder: draftFolder, name: draftName } : null), [draftFolder, draftName]);
  const newFolderParent = newFolder?.parent ?? null;
  const flat = useMemo(
    () =>
      flattenRows(model, {
        collapsed: tree.collapsed,
        collapsedSections,
        // Favorites and Recent arrive with WP7
        showFavorites: false,
        showRecent: false,
        search,
        searchCollapsed,
        draft,
        newFolder: newFolderParent !== null ? { parent: newFolderParent, name: '' } : null,
      }),
    [model, tree.collapsed, collapsedSections, search, searchCollapsed, draft, newFolderParent]
  );
  const { rows, indexByKey } = flat;
  const nameTerms = useMemo(() => (searching ? highlightTerms(parsed, 'name') : EMPTY_TERMS), [parsed, searching]);
  const addressTerms = useMemo(() => (searching ? highlightTerms(parsed, 'address') : EMPTY_TERMS), [parsed, searching]);
  const matchCount = searching ? (rows.find((r) => r.kind === 'section')?.count ?? 0) : 0;
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

  // A layout effect, so the highlight never trails the form by a frame
  useLayoutEffect(() => {
    if (suppressFollow.current) {
      suppressFollow.current = false;
      return;
    }
    selection.selectOnly(formKey);
    treeRef.current?.scrollToKey(formKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  // The active row vanished (its folder collapsed, it was deleted): fall back to a shown selected
  // row, else the nearest folder shown. Checked against the latest selection, so a selection made
  // in the same update (after a delete) wins.
  useEffect(() => {
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
      if (problem) error = folderProblemText(problem, value);
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
      const newPath = joinPath(parentOf(r.target), value);
      // The renamed folder stays selected under its new path
      if (selection.stateRef.current.keys.has(folderKey(r.target))) selection.selectOnly(folderKey(newPath));
      else if (selection.stateRef.current.active === folderKey(r.target)) selection.setActive(folderKey(newPath));
      void tree.run([{ op: 'rename_folder', path: r.target, name: value }], { errorParams: { name: value } }).then((res) => {
        if (res) announce(t('siteTree.a11yRenamed', { name: value, defaultValue: 'Renamed to “{{name}}”' }));
      });
    }
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

  const duplicateSite = async (site: ConnectionConfig) => {
    if (isLocalSite(site)) return;
    const folder = model.siteFolder.get(site.id) ?? '';
    const siblings = (model.folders.get(folder)?.sites ?? []).map((s) => s.name);
    const name = pickFreeName(t('siteTree.copyName', { name: site.name, defaultValue: '{{name}} copy' }), siblings, (n) =>
      t('siteTree.copyNameN', { name: site.name, n, defaultValue: '{{name}} copy {{n}}' })
    );
    const res = await tree.run([{ op: 'copy_sites', items: [{ id: site.id, name, group: folder || null }] }]);
    const created = res?.created[0];
    const copy = created ? res?.sites.find((s) => s.id === created.id) : undefined;
    if (!copy) return;
    announce(t('siteTree.duplicated', { count: 1, formatted: '1', defaultValue_one: 'Duplicated 1 connection', defaultValue_other: 'Duplicated {{formatted}} connections' }));
    // The copy is selected (and shown in the form unless it has unsaved edits)
    if (formDirtyRef.current) selection.selectOnly(siteKey(copy.id));
    else onSelectSite(copy);
    treeRef.current?.scrollToKey(siteKey(copy.id));
  };

  const copySiteAddress = async (site: ConnectionConfig) => {
    const text = copyAddress(site);
    if (!text) return;
    const ok = await copyText(text);
    if (ok) {
      const msg = t('siteTree.copiedAddresses', { count: 1, formatted: '1', defaultValue_one: 'Copied address', defaultValue_other: 'Copied {{formatted}} addresses' });
      notify.success(msg, text);
      announce(msg);
    } else {
      notify.error(t('siteTree.couldNotCopy', "Couldn't copy to the clipboard"));
    }
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
      const parent = parentOf(top[0].path);
      setDeleteReq({
        request: {
          kind: 'folder',
          name: single?.name ?? null,
          count: total,
          sites: top.reduce((n, f) => n + f.count, 0),
          subfolders: top.reduce((n, f) => n + f.folderCount, 0),
          parent: parent ? parent.split('/').join(' / ') : null,
        },
        run: (choice) => void execute(choice),
      });
    } else if (total >= 2) {
      setDeleteReq({ request: { kind: 'items', count: total, sitesOnly: top.length === 0 }, run: (choice) => void execute(choice) });
    } else {
      void execute('delete');
    }
  };

  /* --------------------------------- menus --------------------------------- */

  const menuActions: MenuActions = {
    connect: (site) => onConnectSite(site),
    editDetails: (site) => onEditSite(site),
    renameSite: (site) => startRenameByKey(siteKey(site.id)),
    duplicate: (site) => void duplicateSite(site),
    share: onShareSite ? (site) => onShareSite(site) : undefined,
    copyAddress: (site) => void copySiteAddress(site),
    deleteItems,
    newConnection: (folder) => onNewConnection(folder),
    newFolder: (parent) => startNewFolder(parent),
    renameFolder: (path) => startRenameByKey(folderKey(path)),
    setSubtreeExpanded: (path, expanded) => setExpanded(path, expanded, true),
    setAllExpanded,
    openVault: (tab) => onOpenVault(tab),
    openShared: onOpenSharedConnection,
  };
  const menuCtx: MenuContext = { t, actions: menuActions, mac };
  const expandState = { hasFolders: folderPaths.length > 0, anyExpanded, anyCollapsed };

  const openMenu = (at: MenuAnchor, entries: ContextMenuEntry[], label: string, focusFirst: boolean) => setMenu({ at, entries, label, focusFirst });

  const menuForRow = (row: TreeRow | null, at: MenuAnchor, focusFirst: boolean) => {
    if (!row || row.kind === 'section') {
      openMenu(at, emptyAreaMenu(menuCtx, expandState), t('siteTree.sectionAll', 'All connections'), focusFirst);
      return;
    }
    if (row.kind === 'site') {
      // Right-click on an unselected row selects it first
      if (!selection.stateRef.current.keys.has(row.key)) {
        if (formDirtyRef.current || `s:${row.site.id}` === formKey) selection.selectOnly(row.key);
        else {
          selection.setActive(row.key);
          onSelectSite(row.site);
        }
      }
      openMenu(at, isLocalSite(row.site) ? localMenu(row.site, menuCtx) : siteMenu(row.site, menuCtx), row.site.name, focusFirst);
      return;
    }
    if (row.kind === 'folder' || row.kind === 'placeholder') {
      const path = row.kind === 'folder' ? row.path : row.folder;
      const node = model.folders.get(path);
      if (!node) return;
      if (row.kind === 'folder' && !selection.stateRef.current.keys.has(row.key)) selection.selectOnly(row.key);
      openMenu(at, folderMenu(node, menuCtx), node.name, focusFirst);
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
      case 'address':
        selection.setActive(row.key);
        return;
      default:
        selection.selectOnly(row.key);
    }
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
    open: (row) => {
      switch (row.kind) {
        case 'site':
          onConnectSite(row.site);
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
    duplicate: (row) => {
      if (row.kind === 'site') void duplicateSite(row.site);
    },
    copyAddress: (row) => {
      if (row.kind === 'site') void copySiteAddress(row.site);
    },
    remove: (row) => {
      if (row.kind === 'site' || row.kind === 'folder') deleteItems([row.itemKey]);
    },
    focusSearch,
  };

  /* ------------------------------ escape layer ------------------------------ */

  const escapeRef = useRef<() => boolean>(() => false);
  escapeRef.current = () => {
    if (rename || newFolder) {
      closeEdit();
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
    if (inSidebar && selection.keys.size > 1) {
      selection.selectOnly(selection.active);
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
      if (site) openMenu(at, isLocalSite(site) ? localMenu(site, menuCtx) : siteMenu(site, menuCtx), site.name, false);
    },
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
    if (!row) return;
    if (connect) {
      onConnectSite(row.site);
      return;
    }
    activate(row, 'key');
    treeRef.current?.scrollToKey(row.key);
    treeRef.current?.focus();
  };

  /* ------------------------------ sidebar keys ------------------------------ */

  // ⌘N / ⇧⌘N anywhere in the sidebar (the tree handles its own keys first)
  const onAsideKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const mod = mac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.key.toLowerCase() !== 'n') return;
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

  let status: React.ReactNode;
  if (searching) {
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
      <div className="order-2">
        <SiteSearchBar
          value={query}
          onChange={setQuery}
          inputRef={searchRef}
          total={total}
          autoFocus={total > 0}
          onArrowDown={onSearchArrowDown}
          onEnter={onSearchEnter}
        />
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
          onClick={(e) =>
            openMenu({ rect: e.currentTarget.getBoundingClientRect(), placement: 'below' }, viewOptionsMenu(menuCtx, expandState), t('siteTree.viewOptions', 'View options'), e.detail === 0)
          }
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

      {menu && <ContextMenu at={menu.at} entries={menu.entries} ariaLabel={menu.label} focusFirst={menu.focusFirst} onClose={() => setMenu(null)} />}
      {deleteReq && <DeleteItemsDialog request={deleteReq.request} onChoose={deleteReq.run} onCancel={() => setDeleteReq(null)} />}
    </aside>
  );
};
