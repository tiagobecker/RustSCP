/**
 * Builders for the connections tree's menus (right-click, ⋯, Shift+F10, the header and footer
 * buttons). Pure: they turn the item and the available actions into `ContextMenuEntry[]`.
 *
 * Menus (spec §5): A one site, B Local, C folder, E empty area / "All connections" header, plus the
 * footer's import & export entries. Items of later work packages (favorites, labels, move, export,
 * paste, sort…) are added by those packages.
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
    SEP,
    { kind: 'item', id: 'delete', label: t('siteTree.deleteFolder', 'Delete folder…'), icon: icon(Trash2), shortcut: k.delete, danger: true, onSelect: () => a.deleteItems([`f:${node.path}`]) },
  ];
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
