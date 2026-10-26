/**
 * Typed wrappers for the connections-tree commands (`site_tree.rs`).
 *
 * In the desktop app they go through Tauri's `invoke`; in a plain browser (vite dev / preview)
 * they use the lazily loaded mocks in `devFallback.ts`, like App's own (module-private) invoke
 * helper. Command arguments are camelCase on the JS side; payload fields stay snake_case.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { SiteLayoutResponse, SiteTreeErrorCode, SiteTreeOp, SiteTreeResult, SiteTreeViewPatch } from './types.ts';

export async function siteInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args);
  const { getFallbackData } = await import('../../devFallback.ts');
  return getFallbackData<T>(cmd, args);
}

/** Loads the layout (folders, favorites, recents, labels, collapsed); reconciled with the saved sites. */
export const getSiteLayout = (): Promise<SiteLayoutResponse> => siteInvoke<SiteLayoutResponse>('get_site_layout');

/**
 * Applies a batch of tree ops all-or-nothing: `sites.vault` is written once, then the layout.
 * `label` names the change in the undo stack.
 */
export const applySiteTreeOps = (ops: SiteTreeOp[], label?: string): Promise<SiteTreeResult> =>
  siteInvoke<SiteTreeResult>('apply_site_tree_ops', { ops, label: label ?? null });

/** Restores what an op batch changed, skipping sites changed since. Expired tokens fail with `site_tree.undo_expired`. */
export const undoSiteTreeOps = (token: string): Promise<SiteTreeResult> => siteInvoke<SiteTreeResult>('undo_site_tree_ops', { token });

/** Drops the backend's undo stack (after an import replaced the sites). */
export const forgetSiteTreeUndo = (): Promise<void> => siteInvoke<void>('forget_site_tree_undo');

/** Saves view state (collapsed folders, recents housekeeping, migration flags); debounced on the backend. */
export const setSiteTreeView = (view: SiteTreeViewPatch): Promise<void> => siteInvoke<void>('set_site_tree_view', { view });

/** Records a successful connection to a saved site (not Local) for Recent. */
export const recordSiteConnected = (id: string): Promise<void> => siteInvoke<void>('record_site_connected', { id });

export interface ParsedSiteTreeError {
  /** `site_tree.folder_exists`…, or `null` when the error has no `[code]` prefix */
  code: string | null;
  message: string;
}

const CODE_RE = /^\[([a-z_.]+)\]\s*/;

/** Splits a backend error (`"[site_tree.folder_exists] …"`, an Error or anything else) into code and message. */
export function parseSiteTreeError(err: unknown): ParsedSiteTreeError {
  let text: string;
  if (typeof err === 'string') text = err;
  else if (err instanceof Error) text = err.message;
  else if (err && typeof err === 'object' && 'message' in err) text = String((err as { message: unknown }).message);
  else text = String(err ?? '');
  const m = CODE_RE.exec(text);
  return m ? { code: m[1], message: text.slice(m[0].length) } : { code: null, message: text };
}

/** i18n key (under `siteTree`) for each backend error code; anything else uses `siteTree.opFailed`. */
export const SITE_TREE_ERROR_KEYS: Readonly<Record<SiteTreeErrorCode, string>> = {
  'site_tree.folder_exists': 'siteTree.errFolderExists',
  'site_tree.into_self': 'siteTree.errIntoSelf',
  'site_tree.invalid_name': 'siteTree.errEmptyName',
  'site_tree.path_too_long': 'siteTree.errPathTooLong',
  'site_tree.local_immutable': 'siteTree.errLocal',
  'site_tree.not_found': 'siteTree.opFailed',
  'site_tree.too_many': 'siteTree.errTooMany',
  'site_tree.undo_expired': 'siteTree.undoExpired',
  'site_tree.layout_read_only': 'siteTree.errLayoutReadOnly',
  'site_tree.layout_unavailable': 'siteTree.warnLayoutUnavailable',
  'site_tree.layout_reset': 'siteTree.warnLayoutReset',
};
