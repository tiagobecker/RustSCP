/**
 * State of the connections tree behind the Connect dialog: the layout (folders, favorites, recents,
 * labels), the collapsed folders, and every change to the tree.
 *
 * - The layout loads when the dialog opens (with the one-time localStorage migration, §19).
 * - Changes run through one serial queue. Moves, renames, deletes and folder ops show at once
 *   (applied locally with the same rules as the backend), then the backend's result replaces
 *   them; on an error the tree goes back to the backend's state and an error toast shows.
 *   Copies wait for the backend (it holds the secrets).
 * - Undo keeps the last 20 tokens (⌘Z and the toasts' Undo).
 * - Collapsed folders are written 800 ms after the last change and when the dialog closes.
 * - The first time a large library opens, its nested folders start collapsed (§13).
 * - Recent changes (a connection, "Remove from recent", "Clear recent") show at once and go to the
 *   backend as view patches (not undoable).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionConfig } from '../../types.ts';
import { notify } from '../ui/toast.tsx';
import {
  SITE_TREE_ERROR_KEYS,
  applySiteTreeOps,
  forgetSiteTreeUndo,
  getSiteLayout,
  parseSiteTreeError,
  recordSiteConnected,
  setSiteTreeView,
  siteInvoke,
  undoSiteTreeOps,
} from './siteApi.ts';
import { applyRecentsPatch, largeLibraryFirstRun, legacyMigrationPatch, recordRecent } from './sectionsModel.ts';
import { LOCAL_ID, MAX_COLLAPSED, MAX_RECENTS, applyOpsLocally, coerceLayout, defaultLayout, opsAreOptimistic } from './siteTreeModel.ts';
import type { SiteLayout, SiteTreeErrorCode, SiteTreeOp, SiteTreeResult, SiteTreeViewPatch } from './types.ts';

const UNDO_STACK_MAX = 20;
const VIEW_WRITE_MS = 800;
/** Plaintext folder names the old sidebar kept in WebView storage; moved into the encrypted layout once */
const LEGACY_COLLAPSED_KEY = 'rustscp_site_folders_collapsed';
/** App's map of last remote paths (newest last); its saved-site keys seed Recent once */
const LAST_PATHS_KEY = 'rustscp_last_remote_paths';

/** Warnings already shown in this run of the app (each once) */
const shownWarnings = new Set<string>();

export interface RunOptions {
  /** Names the change in the backend's undo entry (debug only) */
  label?: string;
  /** Show the change before the backend answers (default: everything but copies) */
  optimistic?: boolean;
  /** Values for the translated error text (`{{name}}` in errFolderExists…) */
  errorParams?: Record<string, string>;
}

export interface UndoToast {
  /** Toast title, e.g. "Deleted “web-01”" */
  title: string;
  token: string;
  /** Runs instead of `undo(token)` when the toast's Undo is clicked (the sidebar refocuses the tree first) */
  onUndo?: () => void;
}

/** What `undo` did: the token it used, and whether the backend restored the change. */
export interface UndoOutcome {
  token: string;
  ok: boolean;
}

export interface SiteTreeController {
  /** The layout has been read from the backend at least once */
  loaded: boolean;
  /** Folders, favorites, recents, labels (its `collapsed` is not used: see `collapsed`) */
  layout: SiteLayout;
  /** Layout changes are kept for this run only */
  readOnly: boolean;
  /** Collapsed folder paths (browsing) */
  collapsed: ReadonlySet<string>;
  setCollapsed: (next: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
  /** Runs a batch of tree ops; resolves to the backend's result, or null after an error (already shown) */
  run: (ops: SiteTreeOp[], opts?: RunOptions) => Promise<SiteTreeResult | null>;
  /**
   * Undoes the newest change (or the one with `token`). `announce` also reads the result ("Undone",
   * "Can't undo anymore", the partial text) to screen readers. Resolves to null when there was nothing to undo.
   */
  undo: (token?: string, announce?: (text: string) => void) => Promise<UndoOutcome | null>;
  canUndo: boolean;
  /** Success toast with an Undo button for a change (10 s; hover holds it) */
  toastWithUndo: (toast: UndoToast) => void;
  /** Reloads the layout (after an import) */
  reload: () => Promise<void>;
  /** Drops the undo stack here and in the backend (after an import) */
  forgetUndo: () => void;
  /** Records a successful connection from the dialog (errors ignored) */
  recordConnected: (id: string) => void;
  /** Recent housekeeping ("Remove from recent", "Clear recent"): shown at once, then sent (errors ignored) */
  updateView: (patch: SiteTreeViewPatch) => void;
  /** Translated text of a backend or local tree error */
  errorText: (err: unknown, params?: Record<string, string>) => string;
}

interface Props {
  isOpen: boolean;
  savedSites: ConnectionConfig[];
  onSitesUpdated?: (sites: ConnectionConfig[]) => void;
}

/** Ops that can change `sites.vault` (the rest only touch the layout). */
const SITE_OPS = new Set<SiteTreeOp['op']>(['move_sites', 'copy_sites', 'delete_sites', 'rename_site', 'rename_folder', 'move_folder', 'copy_folder', 'delete_folder']);
const touchesSites = (ops: readonly SiteTreeOp[]) => ops.some((o) => SITE_OPS.has(o.op));

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** The one-time move of localStorage state into the layout (§19). */
const migrationPatch = (sites: readonly ConnectionConfig[]): SiteTreeViewPatch =>
  legacyMigrationPatch(readStorage(LEGACY_COLLAPSED_KEY), readStorage(LAST_PATHS_KEY), sites);

export function useSiteTree({ isOpen, savedSites, onSitesUpdated }: Props): SiteTreeController {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  const [layout, setLayoutState] = useState<SiteLayout>(defaultLayout);
  const [collapsed, setCollapsedState] = useState<ReadonlySet<string>>(() => new Set());
  const [readOnly, setReadOnly] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);

  const sitesRef = useRef(savedSites);
  useEffect(() => {
    sitesRef.current = savedSites;
  }, [savedSites]);
  const onSitesUpdatedRef = useRef(onSitesUpdated);
  onSitesUpdatedRef.current = onSitesUpdated;

  const layoutRef = useRef(layout);
  const collapsedRef = useRef(collapsed);
  /** Bumps on every collapse change made here (so an older result does not undo it) */
  const collapsedVersion = useRef(0);
  const viewDirty = useRef(false);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** Optimistic batches shown but not yet answered, oldest first */
  const pending = useRef<SiteTreeOp[][]>([]);
  const undoStack = useRef<string[]>([]);
  /** Undo token → toast id, so ⌘Z also removes the toast offering the same undo */
  const undoToasts = useRef(new Map<string, number>());
  const loadGen = useRef(0);

  /* ------------------------------- helpers -------------------------------- */

  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(job, job);
    queue.current = p.catch(() => undefined);
    return p;
  }, []);

  const showSites = useCallback((sites: ConnectionConfig[]) => {
    sitesRef.current = sites;
    onSitesUpdatedRef.current?.(sites);
  }, []);

  const setLayout = useCallback((l: SiteLayout) => {
    layoutRef.current = l;
    setLayoutState(l);
  }, []);

  const applyCollapsed = useCallback((next: ReadonlySet<string>) => {
    collapsedRef.current = next;
    setCollapsedState(next);
  }, []);

  /** Takes a layout; its collapsed set too, unless the user changed collapsed folders since `version`. */
  const adoptLayout = useCallback(
    (l: SiteLayout, version: number | null) => {
      setLayout(l);
      if (version !== null && version === collapsedVersion.current) applyCollapsed(new Set(l.collapsed));
    },
    [setLayout, applyCollapsed]
  );

  const errorText = useCallback((err: unknown, params?: Record<string, string>): string => {
    const { code, message } = parseSiteTreeError(err);
    const key = code ? SITE_TREE_ERROR_KEYS[code as SiteTreeErrorCode] : undefined;
    if (!key) return message;
    const tr = tRef.current;
    switch (key) {
      case 'siteTree.errFolderExists':
        return params?.name ? tr(key, { name: params.name, defaultValue: 'A folder named “{{name}}” already exists here.' }) : message;
      case 'siteTree.errIntoSelf':
        return tr(key, "A folder can't go inside itself.");
      case 'siteTree.errEmptyName':
        return tr(key, 'Enter a name.');
      case 'siteTree.errPathTooLong':
        return tr(key, 'This path would be longer than 255 characters.');
      case 'siteTree.errLocal':
        return tr(key, "The Local site can't be moved, duplicated or deleted.");
      case 'siteTree.undoExpired':
        return tr(key, "Can't undo anymore");
      case 'siteTree.errTooMany':
        return tr(key, 'Too many items at once. Select fewer and try again.');
      case 'siteTree.errLayoutReadOnly':
        return tr(key, 'Folders, favorites and labels were saved by a newer RustSCP and are read-only here.');
      case 'siteTree.warnLayoutUnavailable':
        return tr(key, "Folders and favorites can't be saved right now: the key that protects them couldn't be read. Changes last until you quit.");
      case 'siteTree.warnLayoutReset':
        return tr(key, "The file with your folders and favorites couldn't be read, so it was set aside and started fresh. Your connections are safe.");
      default:
        return message;
    }
  }, []);

  const warnOnce = useCallback(
    (code: string, text: string) => {
      if (shownWarnings.has(code)) return;
      shownWarnings.add(code);
      notify.warning(text);
    },
    []
  );

  const showResultWarnings = useCallback(
    (warnings: readonly string[]) => {
      const tr = tRef.current;
      for (const w of warnings) {
        if (w === 'layout_not_saved') warnOnce(w, tr('siteTree.warnLayoutNotSaved', "Folder changes couldn't be saved on this computer."));
        else if (w === 'layout_read_only' && !shownWarnings.has('load')) {
          warnOnce(w, tr('siteTree.errLayoutReadOnly', 'Folders, favorites and labels were saved by a newer RustSCP and are read-only here.'));
        }
      }
    },
    [warnOnce]
  );

  /** Re-applies the batches still waiting for the backend on top of its state. */
  const withPending = useCallback((sites: ConnectionConfig[], l: SiteLayout) => {
    let s = sites;
    let lay = l;
    for (const ops of pending.current) {
      try {
        const r = applyOpsLocally(s, lay, ops);
        s = r.sites;
        lay = r.layout;
      } catch {
        /* the backend will reject it too; its error shows then */
      }
    }
    return { sites: s, layout: lay };
  }, []);

  /** Shows the backend's state again (after a failed change), plus the batches still pending. */
  const resync = useCallback(async () => {
    try {
      const [sites, resp] = await Promise.all([siteInvoke<ConnectionConfig[]>('get_saved_sites'), getSiteLayout()]);
      const next = withPending(Array.isArray(sites) ? sites : sitesRef.current, coerceLayout(resp.layout));
      showSites(next.sites);
      adoptLayout(next.layout, null);
    } catch {
      /* keep what is shown */
    }
  }, [withPending, showSites, adoptLayout]);

  /* ---------------------------- collapsed state --------------------------- */

  /** Sends the collapsed set now (queued, so it reaches the backend before the next op). */
  const flushView = useCallback(() => {
    if (viewTimer.current) {
      clearTimeout(viewTimer.current);
      viewTimer.current = null;
    }
    if (!viewDirty.current) return;
    viewDirty.current = false;
    const list = [...collapsedRef.current].slice(0, MAX_COLLAPSED);
    void enqueue(() => setSiteTreeView({ collapsed: list }).catch(() => undefined));
  }, [enqueue]);

  const setCollapsed = useCallback(
    (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
      const next = fn(collapsedRef.current);
      if (next === collapsedRef.current) return;
      collapsedVersion.current++;
      applyCollapsed(next);
      viewDirty.current = true;
      if (viewTimer.current) clearTimeout(viewTimer.current);
      viewTimer.current = setTimeout(flushView, VIEW_WRITE_MS);
    },
    [applyCollapsed, flushView]
  );

  /* --------------------------------- undo --------------------------------- */

  const dropToken = useCallback((token: string) => {
    const i = undoStack.current.indexOf(token);
    if (i >= 0) {
      undoStack.current.splice(i, 1);
      setUndoDepth(undoStack.current.length);
    }
    const toastId = undoToasts.current.get(token);
    if (toastId !== undefined) {
      notify.dismiss(toastId);
      undoToasts.current.delete(token);
    }
  }, []);

  const pushToken = useCallback((token: string) => {
    undoStack.current.push(token);
    while (undoStack.current.length > UNDO_STACK_MAX) {
      const old = undoStack.current.shift();
      if (old) undoToasts.current.delete(old);
    }
    setUndoDepth(undoStack.current.length);
  }, []);

  const undo = useCallback(
    async (token?: string, announce?: (text: string) => void): Promise<UndoOutcome | null> => {
      const tok = token ?? undoStack.current[undoStack.current.length - 1];
      if (!tok) return null;
      dropToken(tok);
      flushView();
      const version = collapsedVersion.current;
      return enqueue(async (): Promise<UndoOutcome> => {
        const tr = tRef.current;
        try {
          const res = await undoSiteTreeOps(tok);
          const next = withPending(res.sites, coerceLayout(res.layout));
          showSites(next.sites);
          adoptLayout(next.layout, version);
          showResultWarnings(res.warnings);
          const report = res.undo_report;
          if (report && report.skipped > 0) {
            const text = tr('siteTree.undonePartial', {
              restored: report.restored,
              total: report.restored + report.skipped,
              skipped: report.skipped,
              defaultValue: 'Restored {{restored}} of {{total}}; {{skipped}} changed since',
            });
            notify.info(text);
            announce?.(text);
          } else {
            const text = tr('siteTree.undone', 'Undone');
            notify.success(text);
            announce?.(text);
          }
          return { token: tok, ok: true };
        } catch (err) {
          const { code } = parseSiteTreeError(err);
          if (code === 'site_tree.undo_expired') {
            const text = tr('siteTree.undoExpired', "Can't undo anymore");
            notify.info(text);
            announce?.(text);
          } else {
            const text = tr('siteTree.opFailed', "Couldn't update connections");
            notify.error(text, errorText(err));
            announce?.(text);
          }
          return { token: tok, ok: false };
        }
      });
    },
    [dropToken, flushView, enqueue, withPending, showSites, adoptLayout, showResultWarnings, errorText]
  );

  const toastWithUndo = useCallback(
    ({ title, token, onUndo }: UndoToast) => {
      const id = notify.success(title, undefined, {
        durationMs: 10_000,
        action: { label: tRef.current('siteTree.undo', 'Undo'), onClick: () => (onUndo ? onUndo() : void undo(token)) },
      });
      undoToasts.current.set(token, id);
    },
    [undo]
  );

  /* ---------------------------------- ops --------------------------------- */

  const run = useCallback(
    async (ops: SiteTreeOp[], opts: RunOptions = {}): Promise<SiteTreeResult | null> => {
      if (ops.length === 0) return null;
      const tr = tRef.current;
      const report = (err: unknown) => notify.error(tr('siteTree.opFailed', "Couldn't update connections"), errorText(err, opts.errorParams));
      // The backend must have the collapsed set before the op rewrites its paths
      flushView();
      const optimistic = opts.optimistic ?? opsAreOptimistic(ops);
      const sitesOps = touchesSites(ops);
      if (optimistic) {
        try {
          const local = applyOpsLocally(sitesRef.current, { ...layoutRef.current, collapsed: [...collapsedRef.current] }, ops);
          pending.current.push(ops);
          if (local.sitesChanged) showSites(local.sites);
          adoptLayout(local.layout, collapsedVersion.current);
        } catch (err) {
          report(err);
          return null;
        }
      }
      const version = collapsedVersion.current;
      return enqueue(async () => {
        try {
          const res = await applySiteTreeOps(ops, opts.label);
          if (optimistic) pending.current.shift();
          const next = withPending(res.sites, coerceLayout(res.layout));
          if (sitesOps || pending.current.length > 0) showSites(next.sites);
          adoptLayout(next.layout, version);
          if (res.undo_token) pushToken(res.undo_token);
          showResultWarnings(res.warnings);
          return res;
        } catch (err) {
          if (optimistic) {
            pending.current.shift();
            await resync();
          }
          report(err);
          return null;
        }
      });
    },
    [errorText, flushView, showSites, adoptLayout, enqueue, withPending, pushToken, showResultWarnings, resync]
  );

  /* ------------------------------- loading -------------------------------- */

  /** Loads the layout; `opening` (the dialog just opened) also runs the large-library first run. */
  const load = useCallback(async (opening: boolean) => {
    const gen = ++loadGen.current;
    // Folders expanded or collapsed while this load runs (or not sent yet) win over what it reads
    const versionAtStart = collapsedVersion.current;
    try {
      let resp = await getSiteLayout();
      if (gen !== loadGen.current) return;
      if (resp.warning && !shownWarnings.has('load')) {
        shownWarnings.add('load');
        notify.warning(errorText(resp.warning));
      }
      setReadOnly(resp.read_only);
      const first = coerceLayout(resp.layout);
      if (!first.migrated_local_storage && !resp.read_only) {
        await setSiteTreeView(migrationPatch(sitesRef.current));
        try {
          localStorage.removeItem(LEGACY_COLLAPSED_KEY);
        } catch {
          /* storage blocked: nothing was there to remove */
        }
        resp = await getSiteLayout();
        if (gen !== loadGen.current) return;
      }
      let l = coerceLayout(resp.layout);
      // A large library opens with its nested folders collapsed, once. Not after an import's
      // reload: "View connections" expands what was imported.
      const firstRun = opening && !resp.read_only ? largeLibraryFirstRun(l, sitesRef.current.filter((x) => x.id !== LOCAL_ID).length) : null;
      if (firstRun) {
        const patch: SiteTreeViewPatch = { large_library_collapsed: true };
        l = { ...l, large_library_collapsed: true };
        if (firstRun.collapsed) {
          patch.collapsed = firstRun.collapsed;
          l = { ...l, collapsed: firstRun.collapsed };
        }
        void enqueue(() => setSiteTreeView(patch).catch(() => undefined));
      }
      setLayout(l);
      if (!viewDirty.current && collapsedVersion.current === versionAtStart) applyCollapsed(new Set(l.collapsed));
    } catch (err) {
      // The tree still works from the sites' folders; changes report their own errors
      console.warn('Could not load the connections layout:', err);
    } finally {
      if (gen === loadGen.current) setLoaded(true);
    }
  }, [errorText, setLayout, applyCollapsed, enqueue]);

  useEffect(() => {
    if (isOpen) {
      void load(true);
      return;
    }
    flushView();
  }, [isOpen, load, flushView]);

  // Leaving the app's page with the dialog open: send the last collapsed state
  useEffect(() => () => flushView(), [flushView]);

  const reload = useCallback(() => enqueue(() => load(false)), [enqueue, load]);

  const forgetUndo = useCallback(() => {
    for (const id of undoToasts.current.values()) notify.dismiss(id);
    undoToasts.current.clear();
    undoStack.current = [];
    setUndoDepth(0);
    void forgetSiteTreeUndo().catch(() => undefined);
  }, []);

  const recordConnected = useCallback(
    (id: string) => {
      if (!id || id === LOCAL_ID) return;
      // Shown at once (the dialog usually closes; it reloads the layout when it opens again)
      setLayout(recordRecent(layoutRef.current, id, Math.floor(Date.now() / 1000), MAX_RECENTS));
      void recordSiteConnected(id).catch(() => undefined);
    },
    [setLayout]
  );

  const updateView = useCallback(
    (patch: SiteTreeViewPatch) => {
      const next = applyRecentsPatch(layoutRef.current, patch);
      if (next !== layoutRef.current) setLayout(next);
      void enqueue(() => setSiteTreeView(patch).catch(() => undefined));
    },
    [setLayout, enqueue]
  );

  const canUndo = undoDepth > 0;
  return useMemo(
    () => ({ loaded, layout, readOnly, collapsed, setCollapsed, run, undo, canUndo, toastWithUndo, reload, forgetUndo, recordConnected, updateView, errorText }),
    [loaded, layout, readOnly, collapsed, setCollapsed, run, undo, canUndo, toastWithUndo, reload, forgetUndo, recordConnected, updateView, errorText]
  );
}
