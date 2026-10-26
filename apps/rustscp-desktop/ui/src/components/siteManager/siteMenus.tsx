/**
 * Builders for the connections tree's menus (right-click, ⋯, Shift+F10, the header and footer
 * buttons). Pure: they turn the item and the available actions into `ContextMenuEntry[]`.
 *
 * Menus (spec §5): A one site, B Local, C folder, D several items, E empty area / "All connections"
 * header, the footer's import & export entries and the search field's filter menu. Items of later
 * work packages (favorites, labels, export, paste, sort…) are added by those packages.
 */
import React from 'react';
import type { TFunction } from 'i18next';
import {
  ArrowDownUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  CopyPlus,
  FileKey2,
  FolderInput,
  FolderPlus,
  FunnelX,
  Lightbulb,
  ListChecks,
  Plug,
  Plus,
  Share2,
  SquarePen,
  TextCursorInput,
  Trash2,
} from 'lucide-react';
import type { ContextMenuEntry } from '../ui/ContextMenu.tsx';
import { formatShortcut } from '../ui/contextMenuUtils.ts';
import type { ConnectionConfig } from '../../types.ts';
import type { FolderNode } from './types.ts';

export interface MenuActions {
  connect: (site: ConnectionConfig) => void;
  editDetails: (site: ConnectionConfig) => void;
  renameSite: (site: ConnectionConfig) => void;
  duplicate: (site: ConnectionConfig) => void;
  /** Present when the app can share a connection */
  share?: (site: ConnectionConfig) => void;
  copyAddress: (site: ConnectionConfig) => void;
  /** Canonical item keys (`s:<id>`, `f:<path>`) */
  deleteItems: (keys: string[]) => void;
  /** Opens Move to… for these item keys */
  moveItems: (keys: string[]) => void;
  /** Duplicates the sites among these item keys */
  duplicateItems: (keys: string[]) => void;
  /** Copies the addresses of the sites among these item keys, one per line */
  copyAddresses: (keys: string[]) => void;
  /** Selects every connection inside a folder */
  selectInside: (path: string) => void;
  newConnection: (folder: string) => void;
  newFolder: (parent: string) => void;
  renameFolder: (path: string) => void;
  setSubtreeExpanded: (path: string, expanded: boolean) => void;
  setAllExpanded: (expanded: boolean) => void;
  openVault: (tab?: 'winscp') => void;
  /** Present when the app can open a shared `.rustscp` file */
  openShared?: () => void;
}

export interface MenuContext {
  t: TFunction;
  actions: MenuActions;
  /** macOS shortcut glyphs (⌘⌫) instead of Ctrl+…/Del */
  mac: boolean;
}

const ICON = 'w-3.5 h-3.5';
const icon = (C: React.ComponentType<{ className?: string }>) => <C className={ICON} />;

const SEP: ContextMenuEntry = { kind: 'separator' };

/** Shortcut labels of the tree (formatted per platform). */
export const shortcutLabels = (mac: boolean) => ({
  connect: formatShortcut('Enter', mac),
  edit: formatShortcut('Mod+I', mac),
  rename: 'F2',
  duplicate: formatShortcut('Mod+Shift+D', mac),
  copy: formatShortcut('Mod+C', mac),
  newConnection: formatShortcut('Mod+N', mac),
  newFolder: formatShortcut('Mod+Shift+N', mac),
  expandInside: formatShortcut('Alt+ArrowRight', mac),
  collapseInside: formatShortcut('Alt+ArrowLeft', mac),
  delete: mac ? formatShortcut('Mod+Backspace', true) : formatShortcut('Delete', false),
  undo: formatShortcut('Mod+Z', mac),
  moveTo: formatShortcut('Mod+Shift+M', mac),
  connectNow: formatShortcut('Mod+Enter', mac),
});

/** A. One saved site (not Local). */
export function siteMenu(site: ConnectionConfig, ctx: MenuContext): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  const entries: ContextMenuEntry[] = [
    { kind: 'item', id: 'connect', label: t('loginDialog.connect', 'Connect'), icon: icon(Plug), shortcut: k.connect, bold: true, onSelect: () => a.connect(site) },
    { kind: 'item', id: 'edit', label: t('siteTree.editDetails', 'Edit details'), icon: icon(SquarePen), shortcut: k.edit, onSelect: () => a.editDetails(site) },
    { kind: 'item', id: 'rename', label: t('siteTree.rename', 'Rename'), icon: icon(TextCursorInput), shortcut: k.rename, onSelect: () => a.renameSite(site) },
    { kind: 'item', id: 'duplicate', label: t('siteTree.duplicate', 'Duplicate'), icon: icon(CopyPlus), shortcut: k.duplicate, onSelect: () => a.duplicate(site) },
    SEP,
    { kind: 'item', id: 'move', label: t('siteTree.moveTo', 'Move to…'), icon: icon(FolderInput), shortcut: k.moveTo, onSelect: () => a.moveItems([`s:${site.id}`]) },
    SEP,
  ];
  if (a.share) {
    const share = a.share;
    entries.push({ kind: 'item', id: 'share', label: t('loginDialog.shareSite', 'Share connection…'), icon: icon(Share2), onSelect: () => share(site) });
  }
  entries.push(
    { kind: 'item', id: 'copy', label: t('siteTree.copyAddress', 'Copy address'), icon: icon(Copy), shortcut: k.copy, onSelect: () => a.copyAddress(site) },
    SEP,
    { kind: 'item', id: 'delete', label: t('siteTree.delete', 'Delete'), icon: icon(Trash2), shortcut: k.delete, danger: true, onSelect: () => a.deleteItems([`s:${site.id}`]) }
  );
  return entries;
}

/** B. The built-in Local site: no move, duplicate, share, export or delete. */
export function localMenu(site: ConnectionConfig, ctx: MenuContext): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  return [
    { kind: 'item', id: 'connect', label: t('loginDialog.connect', 'Connect'), icon: icon(Plug), shortcut: k.connect, bold: true, onSelect: () => a.connect(site) },
    { kind: 'item', id: 'edit', label: t('siteTree.editDetails', 'Edit details'), icon: icon(SquarePen), shortcut: k.edit, onSelect: () => a.editDetails(site) },
    { kind: 'item', id: 'rename', label: t('siteTree.rename', 'Rename'), icon: icon(TextCursorInput), shortcut: k.rename, onSelect: () => a.renameSite(site) },
  ];
}

/** C. A folder. */
export function folderMenu(node: FolderNode, ctx: MenuContext): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  const hasSubfolders = node.folders.length > 0;
  return [
    { kind: 'item', id: 'new-connection', label: t('siteTree.newConnectionHere', 'New connection here'), icon: icon(Plus), shortcut: k.newConnection, onSelect: () => a.newConnection(node.path) },
    { kind: 'item', id: 'new-folder', label: t('siteTree.newFolderInside', 'New folder inside'), icon: icon(FolderPlus), shortcut: k.newFolder, onSelect: () => a.newFolder(node.path) },
    SEP,
    { kind: 'item', id: 'rename', label: t('siteTree.rename', 'Rename'), icon: icon(TextCursorInput), shortcut: k.rename, onSelect: () => a.renameFolder(node.path) },
    SEP,
    {
      kind: 'item',
      id: 'expand-inside',
      label: t('siteTree.expandAllInside', 'Expand all inside'),
      icon: icon(ChevronsUpDown),
      shortcut: k.expandInside,
      disabled: !hasSubfolders && node.sites.length === 0,
      onSelect: () => a.setSubtreeExpanded(node.path, true),
    },
    {
      kind: 'item',
      id: 'collapse-inside',
      label: t('siteTree.collapseAllInside', 'Collapse all inside'),
      icon: icon(ChevronsDownUp),
      shortcut: k.collapseInside,
      onSelect: () => a.setSubtreeExpanded(node.path, false),
    },
    {
      kind: 'item',
      id: 'select-inside',
      label: t('siteTree.selectInside', 'Select connections inside'),
      icon: icon(ListChecks),
      disabled: node.count === 0,
      onSelect: () => a.selectInside(node.path),
    },
    SEP,
    { kind: 'item', id: 'move', label: t('siteTree.moveTo', 'Move to…'), icon: icon(FolderInput), shortcut: k.moveTo, onSelect: () => a.moveItems([`f:${node.path}`]) },
    SEP,
    { kind: 'item', id: 'delete', label: t('siteTree.deleteFolder', 'Delete folder…'), icon: icon(Trash2), shortcut: k.delete, danger: true, onSelect: () => a.deleteItems([`f:${node.path}`]) },
  ];
}

/** What menu D needs to know about a multi-selection. */
export interface MultiSummary {
  /** Canonical item keys (`s:<id>`, `f:<path>`) */
  keys: string[];
  /** Saved sites selected (Local not counted) */
  sites: number;
  /** Folders selected */
  folders: number;
  /** Some selected site has an address to copy */
  hasAddress: boolean;
  /** Formats a count for the UI language */
  format: (n: number) => string;
}

/** D. Several items (right-clicking inside the selection keeps it). Share works one connection at a time. */
export function multiMenu(sum: MultiSummary, ctx: MenuContext): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  const count = sum.sites + sum.folders;
  return [
    {
      kind: 'item',
      id: 'move',
      label: t('siteTree.moveNTo', { count, formatted: sum.format(count), defaultValue_one: 'Move 1 item to…', defaultValue_other: 'Move {{formatted}} items to…' }),
      icon: icon(FolderInput),
      shortcut: k.moveTo,
      disabled: count === 0,
      onSelect: () => a.moveItems(sum.keys),
    },
    {
      kind: 'item',
      id: 'duplicate',
      label: t('siteTree.duplicate', 'Duplicate'),
      icon: icon(CopyPlus),
      shortcut: k.duplicate,
      // Folders are duplicated one at a time (WP6), so a selection holding one is not duplicated
      disabled: sum.sites === 0 || sum.folders > 0,
      onSelect: () => a.duplicateItems(sum.keys),
    },
    { kind: 'item', id: 'copy', label: t('siteTree.copyAddresses', 'Copy addresses'), icon: icon(Copy), shortcut: k.copy, disabled: !sum.hasAddress, onSelect: () => a.copyAddresses(sum.keys) },
    SEP,
    {
      kind: 'item',
      id: 'delete',
      label: t('siteTree.deleteN', { count, formatted: sum.format(count), defaultValue_one: 'Delete 1 item', defaultValue_other: 'Delete {{formatted}} items' }),
      icon: icon(Trash2),
      shortcut: k.delete,
      danger: true,
      disabled: count === 0,
      onSelect: () => a.deleteItems(sum.keys),
    },
  ];
}

/** State of the search field's filter menu (its checkboxes only edit the search text). */
export interface FilterMenuState {
  /** Active `is:` values (canonical) */
  is: ReadonlySet<string>;
  /** Active `p:` values (canonical) */
  protocols: ReadonlySet<string>;
  /** Active `auth:` values (canonical) */
  auth: ReadonlySet<string>;
  /** Protocols that exist in the library, with their formatted counts */
  protocolOptions: Array<{ value: string; label: string; count: string }>;
  /** Offer "Favorites" / "Used in the last 30 days" (only when there are any) */
  hasFavorites: boolean;
  hasRecents: boolean;
  hasQualifiers: boolean;
  toggle: (key: 'is' | 'p' | 'auth', value: string, on: boolean) => void;
  openTips: () => void;
  clear: () => void;
}

/** The ListFilter menu: Show, Protocol and Sign-in groups of checkboxes, then tips and Clear filters. */
export function filterMenu(ctx: MenuContext, state: FilterMenuState): ContextMenuEntry[] {
  const { t } = ctx;
  const check = (key: 'is' | 'p' | 'auth', value: string, label: string, active: ReadonlySet<string>, detail?: string): ContextMenuEntry => ({
    kind: 'check',
    id: `${key}:${value}`,
    label,
    detail,
    checked: active.has(value),
    keepOpen: true,
    onToggle: () => state.toggle(key, value, !active.has(value)),
  });
  const entries: ContextMenuEntry[] = [{ kind: 'label', label: t('siteTree.filterShow', 'Show') }];
  if (state.hasFavorites) entries.push(check('is', 'fav', t('siteTree.filterFavorites', 'Favorites'), state.is));
  if (state.hasRecents) entries.push(check('is', 'recent', t('siteTree.filterRecent', 'Used in the last 30 days'), state.is));
  entries.push(
    check('is', 'unfiled', t('siteTree.filterUnfiled', 'Not in a folder'), state.is),
    check('is', 'empty', t('siteTree.filterEmpty', 'Empty folders'), state.is),
    check('is', 'dup', t('siteTree.filterDup', 'Duplicates'), state.is),
    check('is', 'nopass', t('siteTree.filterNoPass', 'Password not saved'), state.is)
  );
  if (state.protocolOptions.length > 0) {
    entries.push({ kind: 'label', label: t('siteTree.filterProtocol', 'Protocol') });
    for (const p of state.protocolOptions) entries.push(check('p', p.value, p.label, state.protocols, p.count));
  }
  entries.push(
    { kind: 'label', label: t('siteTree.filterSignIn', 'Sign-in') },
    check('auth', 'password', t('siteTree.authPassword', 'Password'), state.auth),
    check('auth', 'key', t('siteTree.authKey', 'Key file'), state.auth),
    check('auth', 'agent', t('siteTree.authAgent', 'SSH agent'), state.auth),
    check('auth', 'none', t('siteTree.authNone', 'Nothing saved'), state.auth),
    SEP,
    { kind: 'item', id: 'tips', label: t('siteTree.searchTips', 'Search tips…'), icon: icon(Lightbulb), onSelect: state.openTips },
    { kind: 'item', id: 'clear', label: t('siteTree.clearFilters', 'Clear filters'), icon: icon(FunnelX), disabled: !state.hasQualifiers, onSelect: state.clear }
  );
  return entries;
}

/** Import & export entries (footer button, empty-area menu, empty state). */
export function importExportEntries(ctx: MenuContext): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const entries: ContextMenuEntry[] = [
    { kind: 'item', id: 'vault', label: t('siteTree.importExportVault', 'Import or export vault…'), icon: icon(ArrowDownUp), onSelect: () => a.openVault() },
    { kind: 'item', id: 'winscp', label: t('loginDialog.importWinscp', 'Import from WinSCP…'), icon: icon(FolderInput), onSelect: () => a.openVault('winscp') },
  ];
  if (a.openShared) {
    const openShared = a.openShared;
    entries.push({ kind: 'item', id: 'open-shared', label: t('loginDialog.openShared', 'Open shared connection…'), icon: icon(FileKey2), onSelect: () => openShared() });
  }
  return entries;
}

/** E. Empty area of the tree, or the "All connections" header. */
export function emptyAreaMenu(ctx: MenuContext, state: { hasFolders: boolean; anyExpanded: boolean; anyCollapsed: boolean }): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  const entries: ContextMenuEntry[] = [
    { kind: 'item', id: 'new-connection', label: t('loginDialog.newConnection', 'New connection'), icon: icon(Plus), shortcut: k.newConnection, onSelect: () => a.newConnection('') },
    { kind: 'item', id: 'new-folder', label: t('siteTree.newFolder', 'New folder'), icon: icon(FolderPlus), shortcut: k.newFolder, onSelect: () => a.newFolder('') },
  ];
  if (state.hasFolders) {
    entries.push(
      SEP,
      {
        kind: 'item',
        id: 'expand-all',
        label: t('loginDialog.expandFolders', 'Expand all folders'),
        icon: icon(ChevronsUpDown),
        disabled: !state.anyCollapsed,
        onSelect: () => a.setAllExpanded(true),
      },
      {
        kind: 'item',
        id: 'collapse-all',
        label: t('loginDialog.collapseFolders', 'Collapse all folders'),
        icon: icon(ChevronsDownUp),
        disabled: !state.anyExpanded,
        onSelect: () => a.setAllExpanded(false),
      }
    );
  }
  entries.push(SEP, ...importExportEntries(ctx));
  return entries;
}

/** View options (header). Sorting, row size and sections arrive with WP7. */
export function viewOptionsMenu(ctx: MenuContext, state: { hasFolders: boolean; anyExpanded: boolean; anyCollapsed: boolean }): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  return [
    {
      kind: 'item',
      id: 'expand-all',
      label: t('loginDialog.expandFolders', 'Expand all folders'),
      icon: icon(ChevronsUpDown),
      disabled: !state.hasFolders || !state.anyCollapsed,
      onSelect: () => a.setAllExpanded(true),
    },
    {
      kind: 'item',
      id: 'collapse-all',
      label: t('loginDialog.collapseFolders', 'Collapse all folders'),
      icon: icon(ChevronsDownUp),
      disabled: !state.hasFolders || !state.anyExpanded,
      onSelect: () => a.setAllExpanded(false),
    },
  ];
}
