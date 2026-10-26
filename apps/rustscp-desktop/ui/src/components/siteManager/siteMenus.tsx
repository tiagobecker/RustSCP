/**
 * Builders for the connections tree's menus (right-click, ⋯, Shift+F10, the header and footer
 * buttons). Pure: they turn the item and the available actions into `ContextMenuEntry[]`.
 *
 * Menus (spec §5): A one site, B Local, C folder, D several items, E empty area / "All connections"
 * header, F a favorite row, G a recent row, H the Favorites / Recent headers, the header's View
 * options, the footer's import & export entries and the search field's filter menu, plus the
 * Label ▸ submenu (labels, export and Connect N came with WP8).
 */
import React from 'react';
import type { TFunction } from 'i18next';
import {
  ArrowDownUp,
  ArrowDownWideNarrow,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  Copy,
  CopyPlus,
  EyeOff,
  FileKey2,
  FileOutput,
  FolderInput,
  FolderPlus,
  FunnelX,
  History,
  Lightbulb,
  ListChecks,
  ListX,
  LocateFixed,
  Plug,
  Plus,
  Rows3,
  Share2,
  SquarePen,
  Star,
  StarOff,
  Tag,
  Tags,
  TextCursorInput,
  Trash2,
} from 'lucide-react';
import type { ContextMenuEntry } from '../ui/ContextMenu.tsx';
import { formatShortcut } from '../ui/contextMenuUtils.ts';
import type { ConnectionConfig } from '../../types.ts';
import { LABEL_DOT_CLASS } from './labelsModel.ts';
import type { LabelChoice } from './labelsModel.ts';
import { CONNECT_MAX, formatCount } from './siteTreeModel.ts';
import type { Density, FolderNode, LabelColor, LabelDef, SortKey, ViewPrefs } from './types.ts';

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
  /** Duplicates these items: sites next to themselves ("web-01 copy"), folders with everything inside */
  duplicateItems: (keys: string[]) => void;
  /** Copies the addresses of the sites among these item keys, one per line */
  copyAddresses: (keys: string[]) => void;
  /** Selects every connection inside a folder */
  selectInside: (path: string) => void;
  /** A new folder holding these items (in their common parent), then rename */
  newFolderWith: (keys: string[]) => void;
  /** Copies a folder with everything inside next to it ("Acme copy") */
  duplicateFolder: (path: string) => void;
  /** Present while items are cut (⌘X): moves them into `folder` ('' = top level) */
  paste?: (folder: string) => void;
  newConnection: (folder: string) => void;
  newFolder: (parent: string) => void;
  renameFolder: (path: string) => void;
  setSubtreeExpanded: (path: string, expanded: boolean) => void;
  setAllExpanded: (expanded: boolean) => void;
  openVault: (tab?: 'winscp') => void;
  /** Present when the app can open a shared `.rustscp` file */
  openShared?: () => void;
  /** Adds these items to the favorites, or removes them when all of them are favorites */
  toggleFavorites: (keys: string[]) => void;
  /** Selects the item where it lives in "All connections" (folders opened, scrolled to) */
  showInFolder: (key: string) => void;
  /** Takes one site off Recent */
  removeRecent: (id: string) => void;
  /** Empties Recent */
  clearRecent: () => void;
  /** Hides the Favorites or Recent section (View options shows it again) */
  hideSection: (section: 'fav' | 'rec') => void;
  /** Changes view options (sort, folders on top, row size, sections…) */
  setView: (patch: Partial<ViewPrefs>) => void;
  /** The Label ▸ submenu's entries for these item keys */
  labelSubmenu: (keys: string[]) => ContextMenuEntry[];
  /** Opens the Labels dialog */
  editLabels: () => void;
  /** Exports the connections these items stand for (folders: everything inside) */
  exportItems: (keys: string[]) => void;
  /** Connects the sites among these items (a folder: every site inside); asks above 5 */
  connectItems: (keys: string[]) => void;
}

export interface MenuContext {
  t: TFunction;
  actions: MenuActions;
  /** macOS shortcut glyphs (⌘⌫) instead of Ctrl+…/Del */
  mac: boolean;
  /** UI language (number formatting) */
  lang?: string;
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
  // ⌃⌘N on macOS; Ctrl+Alt+N elsewhere (Ctrl+Shift+N is New folder)
  newFolderWith: mac ? formatShortcut('Ctrl+Mod+N', true) : formatShortcut('Ctrl+Alt+N', false),
  cut: formatShortcut('Mod+X', mac),
  paste: formatShortcut('Mod+V', mac),
  favorite: formatShortcut('Mod+D', mac),
});

/** Add to favorites / Remove from favorites (⌘D) for one item. */
const favoriteEntry = (ctx: MenuContext, key: string, favorite: boolean): ContextMenuEntry => ({
  kind: 'item',
  id: 'favorite',
  label: favorite ? ctx.t('siteTree.removeFavorite', 'Remove from favorites') : ctx.t('siteTree.addFavorite', 'Add to favorites'),
  icon: icon(favorite ? StarOff : Star),
  shortcut: shortcutLabels(ctx.mac).favorite,
  onSelect: () => ctx.actions.toggleFavorites([key]),
});

const showInFolderEntry = (ctx: MenuContext, key: string): ContextMenuEntry => ({
  kind: 'item',
  id: 'show-in-folder',
  label: ctx.t('siteTree.showInFolder', 'Show in folder'),
  icon: icon(LocateFixed),
  onSelect: () => ctx.actions.showInFolder(key),
});

/** "Paste" while items are cut (⌘X), moving them into `folder`. */
const pasteEntry = (ctx: MenuContext, folder: string): ContextMenuEntry[] => {
  const paste = ctx.actions.paste;
  if (!paste) return [];
  return [{ kind: 'item', id: 'paste', label: ctx.t('siteTree.paste', 'Paste'), icon: icon(ClipboardPaste), shortcut: shortcutLabels(ctx.mac).paste, onSelect: () => paste(folder) }];
};

/** Label ▸ for these item keys. */
const labelSubmenuEntry = (ctx: MenuContext, keys: string[]): ContextMenuEntry => ({
  kind: 'submenu',
  id: 'label',
  label: ctx.t('siteTree.label', 'Label'),
  icon: icon(Tag),
  entries: ctx.actions.labelSubmenu(keys),
});

/** "Connect N" / "Connect all (N)…": disabled above 20, with the reason in its tooltip. */
const tooManyTitle = (ctx: MenuContext, n: number): string | undefined =>
  n > CONNECT_MAX ? ctx.t('siteTree.connectTooMany', { max: CONNECT_MAX, defaultValue: 'You can open up to {{max}} connections at once.' }) : undefined;

/** A small coloured dot (label menus and the filter menu). */
export const labelDot = (color: LabelColor) => <span aria-hidden className={`w-2 h-2 rounded-full ${LABEL_DOT_CLASS[color]}`} />;

/** What a Label ▸ submenu shows. */
export interface LabelMenuState {
  /** Defined labels, in order */
  labels: LabelDef[];
  /** The items' own label: an id, null for none, 'mixed' */
  own: string | null | 'mixed';
  /** What they inherit from their folder (the "None" entry names it) */
  inherited: LabelDef | null;
  /** Presets not defined yet (translated names); picking one defines it */
  presets: Array<{ name: string; color: LabelColor }>;
  set: (choice: LabelChoice) => void;
}

/** The Label ▸ entries: None (or "Same as folder"), each label, unused presets, Edit labels…. */
export function labelEntries(ctx: MenuContext, state: LabelMenuState): ContextMenuEntry[] {
  const { t } = ctx;
  const entries: ContextMenuEntry[] = [
    {
      kind: 'radio',
      id: 'label-none',
      label: state.inherited
        ? t('siteTree.labelSameAsFolder', { name: state.inherited.name, defaultValue: 'Same as folder ({{name}})' })
        : t('siteTree.labelNone', 'None'),
      checked: state.own === null,
      onSelect: () => state.set({ kind: 'none' }),
    },
    ...state.labels.map(
      (l): ContextMenuEntry => ({ kind: 'radio', id: `label-${l.id}`, label: l.name, icon: labelDot(l.color), checked: state.own === l.id, onSelect: () => state.set({ kind: 'label', id: l.id }) })
    ),
  ];
  if (state.presets.length > 0) {
    // Nothing exists until first use: the presets are defined when picked
    if (state.labels.length > 0) entries.push(SEP, { kind: 'label', label: t('siteTree.labelSuggestions', 'Suggestions') });
    for (const p of state.presets) {
      entries.push({ kind: 'radio', id: `preset-${p.name}`, label: p.name, icon: labelDot(p.color), checked: false, onSelect: () => state.set({ kind: 'preset', name: p.name, color: p.color }) });
    }
  }
  entries.push(SEP, { kind: 'item', id: 'edit-labels', label: t('siteTree.editLabels', 'Edit labels…'), icon: icon(Tags), onSelect: () => ctx.actions.editLabels() });
  return entries;
}

/** A. One saved site (not Local). */
export function siteMenu(site: ConnectionConfig, ctx: MenuContext, opts: { favorite: boolean } = { favorite: false }): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  const entries: ContextMenuEntry[] = [
    { kind: 'item', id: 'connect', label: t('loginDialog.connect', 'Connect'), icon: icon(Plug), shortcut: k.connect, bold: true, onSelect: () => a.connect(site) },
    { kind: 'item', id: 'edit', label: t('siteTree.editDetails', 'Edit details'), icon: icon(SquarePen), shortcut: k.edit, onSelect: () => a.editDetails(site) },
    { kind: 'item', id: 'rename', label: t('siteTree.rename', 'Rename'), icon: icon(TextCursorInput), shortcut: k.rename, onSelect: () => a.renameSite(site) },
    { kind: 'item', id: 'duplicate', label: t('siteTree.duplicate', 'Duplicate'), icon: icon(CopyPlus), shortcut: k.duplicate, onSelect: () => a.duplicate(site) },
    favoriteEntry(ctx, `s:${site.id}`, opts.favorite),
    labelSubmenuEntry(ctx, [`s:${site.id}`]),
    SEP,
    { kind: 'item', id: 'move', label: t('siteTree.moveTo', 'Move to…'), icon: icon(FolderInput), shortcut: k.moveTo, onSelect: () => a.moveItems([`s:${site.id}`]) },
    {
      kind: 'item',
      id: 'new-folder-with',
      label: t('siteTree.newFolderWithSelection', 'New folder with selection'),
      icon: icon(FolderPlus),
      shortcut: k.newFolderWith,
      onSelect: () => a.newFolderWith([`s:${site.id}`]),
    },
    SEP,
  ];
  if (a.share) {
    const share = a.share;
    entries.push({ kind: 'item', id: 'share', label: t('loginDialog.shareSite', 'Share connection…'), icon: icon(Share2), onSelect: () => share(site) });
  }
  entries.push(
    { kind: 'item', id: 'copy', label: t('siteTree.copyAddress', 'Copy address'), icon: icon(Copy), shortcut: k.copy, onSelect: () => a.copyAddress(site) },
    { kind: 'item', id: 'export', label: t('siteTree.exportEllipsis', 'Export…'), icon: icon(FileOutput), onSelect: () => a.exportItems([`s:${site.id}`]) },
    SEP,
    { kind: 'item', id: 'delete', label: t('siteTree.delete', 'Delete'), icon: icon(Trash2), shortcut: k.delete, danger: true, onSelect: () => a.deleteItems([`s:${site.id}`]) }
  );
  return entries;
}

/** B. The built-in Local site: no move, duplicate, share, export or delete. */
export function localMenu(site: ConnectionConfig, ctx: MenuContext, opts: { favorite: boolean } = { favorite: false }): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  return [
    { kind: 'item', id: 'connect', label: t('loginDialog.connect', 'Connect'), icon: icon(Plug), shortcut: k.connect, bold: true, onSelect: () => a.connect(site) },
    { kind: 'item', id: 'edit', label: t('siteTree.editDetails', 'Edit details'), icon: icon(SquarePen), shortcut: k.edit, onSelect: () => a.editDetails(site) },
    { kind: 'item', id: 'rename', label: t('siteTree.rename', 'Rename'), icon: icon(TextCursorInput), shortcut: k.rename, onSelect: () => a.renameSite(site) },
    favoriteEntry(ctx, `s:${site.id}`, opts.favorite),
  ];
}

/** C. A folder. */
export function folderMenu(node: FolderNode, ctx: MenuContext, opts: { favorite: boolean } = { favorite: false }): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  const hasSubfolders = node.folders.length > 0;
  const n = node.count;
  const formatted = formatCount(ctx.lang ?? '', n);
  return [
    { kind: 'item', id: 'new-connection', label: t('siteTree.newConnectionHere', 'New connection here'), icon: icon(Plus), shortcut: k.newConnection, onSelect: () => a.newConnection(node.path) },
    { kind: 'item', id: 'new-folder', label: t('siteTree.newFolderInside', 'New folder inside'), icon: icon(FolderPlus), shortcut: k.newFolder, onSelect: () => a.newFolder(node.path) },
    ...pasteEntry(ctx, node.path),
    SEP,
    { kind: 'item', id: 'rename', label: t('siteTree.rename', 'Rename'), icon: icon(TextCursorInput), shortcut: k.rename, onSelect: () => a.renameFolder(node.path) },
    favoriteEntry(ctx, `f:${node.path}`, opts.favorite),
    labelSubmenuEntry(ctx, [`f:${node.path}`]),
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
    { kind: 'item', id: 'duplicate', label: t('siteTree.duplicateFolder', 'Duplicate folder'), icon: icon(CopyPlus), shortcut: k.duplicate, onSelect: () => a.duplicateFolder(node.path) },
    {
      kind: 'item',
      id: 'export',
      label: t('siteTree.exportN', { count: n, formatted, defaultValue_one: 'Export 1 connection…', defaultValue_other: 'Export {{formatted}} connections…' }),
      icon: icon(FileOutput),
      disabled: n === 0,
      onSelect: () => a.exportItems([`f:${node.path}`]),
    },
    {
      kind: 'item',
      id: 'connect-all',
      label: t('siteTree.connectAll', { count: n, formatted, defaultValue_one: 'Connect (1)…', defaultValue_other: 'Connect all ({{formatted}})…' }),
      icon: icon(Plug),
      disabled: n === 0 || n > CONNECT_MAX,
      title: tooManyTitle(ctx, n),
      onSelect: () => a.connectItems([`f:${node.path}`]),
    },
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
  /** Items that can be favorites (sites, Local included, and folders) */
  favoriteCount: number;
  /** Every one of them is a favorite already (the entry removes them) */
  allFavorite: boolean;
  /** Selected sites Connect N opens (Local included; folders' contents are not) */
  connectSites: number;
  /** Connections an export holds (the sites, and everything inside the folders) */
  exportCount: number;
  /** Formats a count for the UI language */
  format: (n: number) => string;
}

/** D. Several items (right-clicking inside the selection keeps it). Share works one connection at a time. */
export function multiMenu(sum: MultiSummary, ctx: MenuContext): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  const count = sum.sites + sum.folders;
  const fav = sum.favoriteCount;
  const favFormatted = sum.format(fav);
  const connect: ContextMenuEntry[] =
    sum.connectSites > 0
      ? [
          {
            kind: 'item',
            id: 'connect',
            label: t('siteTree.connectN', { count: sum.connectSites, formatted: sum.format(sum.connectSites), defaultValue_one: 'Connect 1', defaultValue_other: 'Connect {{formatted}}' }),
            icon: icon(Plug),
            shortcut: k.connect,
            bold: true,
            disabled: sum.connectSites > CONNECT_MAX,
            title: tooManyTitle(ctx, sum.connectSites),
            onSelect: () => a.connectItems(sum.keys),
          },
          SEP,
        ]
      : [];
  return [
    ...connect,
    {
      kind: 'item',
      id: 'favorite',
      label: sum.allFavorite
        ? t('siteTree.removeFavoritesN', { count: fav, formatted: favFormatted, defaultValue_one: 'Remove 1 from favorites', defaultValue_other: 'Remove {{formatted}} from favorites' })
        : t('siteTree.addFavoritesN', { count: fav, formatted: favFormatted, defaultValue_one: 'Add 1 to favorites', defaultValue_other: 'Add {{formatted}} to favorites' }),
      icon: icon(sum.allFavorite ? StarOff : Star),
      shortcut: k.favorite,
      disabled: fav === 0,
      onSelect: () => a.toggleFavorites(sum.keys),
    },
    labelSubmenuEntry(ctx, sum.keys),
    SEP,
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
      id: 'new-folder-with',
      label: t('siteTree.newFolderWithN', { count, formatted: sum.format(count), defaultValue_one: 'New folder with 1 item', defaultValue_other: 'New folder with {{formatted}} items' }),
      icon: icon(FolderPlus),
      shortcut: k.newFolderWith,
      disabled: count === 0,
      onSelect: () => a.newFolderWith(sum.keys),
    },
    {
      kind: 'item',
      id: 'duplicate',
      label: t('siteTree.duplicate', 'Duplicate'),
      icon: icon(CopyPlus),
      shortcut: k.duplicate,
      // Sites with copy_sites, folders with everything inside (copy_folder), in one batch
      disabled: count === 0,
      onSelect: () => a.duplicateItems(sum.keys),
    },
    { kind: 'item', id: 'copy', label: t('siteTree.copyAddresses', 'Copy addresses'), icon: icon(Copy), shortcut: k.copy, disabled: !sum.hasAddress, onSelect: () => a.copyAddresses(sum.keys) },
    {
      kind: 'item',
      id: 'export',
      label: t('siteTree.exportN', { count: sum.exportCount, formatted: sum.format(sum.exportCount), defaultValue_one: 'Export 1 connection…', defaultValue_other: 'Export {{formatted}} connections…' }),
      icon: icon(FileOutput),
      disabled: sum.exportCount === 0,
      onSelect: () => a.exportItems(sum.keys),
    },
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
  /** Offer "Favorites" / "Used in the last 30 days" / "Connected now" (only when there are any) */
  hasFavorites: boolean;
  hasRecents: boolean;
  hasOpen: boolean;
  /** Defined labels (the Labels group shows when there are any) */
  labels: LabelDef[];
  /** Active `label:` values (folded) */
  labelValues: ReadonlySet<string>;
  /** Folds a label name the way `label:` values are compared */
  foldLabel: (name: string) => string;
  hasQualifiers: boolean;
  toggle: (key: 'is' | 'p' | 'auth' | 'label', value: string, on: boolean) => void;
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
  if (state.hasOpen || state.is.has('open')) entries.push(check('is', 'open', t('siteTree.filterOpen', 'Connected now'), state.is));
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
    check('auth', 'none', t('siteTree.authNone', 'Nothing saved'), state.auth)
  );
  if (state.labels.length > 0) {
    entries.push({ kind: 'label', label: t('siteTree.filterLabels', 'Labels') });
    for (const l of state.labels) {
      const on = state.labelValues.has(state.foldLabel(l.name));
      entries.push({ kind: 'check', id: `label:${l.id}`, label: l.name, icon: labelDot(l.color), checked: on, keepOpen: true, onToggle: () => state.toggle('label', l.name, !on) });
    }
  }
  entries.push(
    SEP,
    { kind: 'item', id: 'tips', label: t('siteTree.searchTips', 'Search tips…'), icon: icon(Lightbulb), onSelect: state.openTips },
    { kind: 'item', id: 'clear', label: t('siteTree.clearFilters', 'Clear filters'), icon: icon(FunnelX), disabled: !state.hasQualifiers, onSelect: state.clear }
  );
  return entries;
}

/**
 * Import & export entries (footer button, empty-area menu, empty state). The footer adds
 * "Export selected (N)…" while sites are selected.
 */
export function importExportEntries(ctx: MenuContext, exportSelected?: { keys: string[]; count: number }): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const entries: ContextMenuEntry[] = [
    { kind: 'item', id: 'vault', label: t('siteTree.importExportVault', 'Import or export vault…'), icon: icon(ArrowDownUp), onSelect: () => a.openVault() },
    { kind: 'item', id: 'winscp', label: t('loginDialog.importWinscp', 'Import from WinSCP…'), icon: icon(FolderInput), onSelect: () => a.openVault('winscp') },
  ];
  if (a.openShared) {
    const openShared = a.openShared;
    entries.push({ kind: 'item', id: 'open-shared', label: t('loginDialog.openShared', 'Open shared connection…'), icon: icon(FileKey2), onSelect: () => openShared() });
  }
  if (exportSelected && exportSelected.count > 0) {
    const { keys, count } = exportSelected;
    entries.push(SEP, {
      kind: 'item',
      id: 'export-selected',
      label: t('siteTree.exportSelected', { count, formatted: formatCount(ctx.lang ?? '', count), defaultValue_one: 'Export selected (1)…', defaultValue_other: 'Export selected ({{formatted}})…' }),
      icon: icon(FileOutput),
      onSelect: () => a.exportItems(keys),
    });
  }
  return entries;
}

/** What the view-options entries show. */
export interface ViewMenuState {
  prefs: ViewPrefs;
  /** The row size in use (the stored choice, or the default for the library's size) */
  density: Density;
}

const SORTS: ReadonlyArray<{ key: SortKey; i18n: string; label: string }> = [
  { key: 'name', i18n: 'siteTree.sortName', label: 'Name' },
  { key: 'address', i18n: 'siteTree.sortAddress', label: 'Server address' },
  { key: 'protocol', i18n: 'siteTree.sortProtocol', label: 'Protocol' },
  { key: 'last', i18n: 'siteTree.sortLastConnected', label: 'Last connected' },
];

/** Sort by ▸, Keep folders on top, Row size ▸ (the header's View options and menu E). */
function arrangeEntries(ctx: MenuContext, view: ViewMenuState, keepOpen: boolean): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const { prefs, density } = view;
  return [
    {
      kind: 'submenu',
      id: 'sort',
      label: t('siteTree.sortBy', 'Sort by'),
      icon: icon(ArrowDownWideNarrow),
      entries: SORTS.map((o) => ({ kind: 'radio', id: `sort-${o.key}`, label: t(o.i18n, o.label), checked: prefs.sort === o.key, onSelect: () => a.setView({ sort: o.key }) })),
    },
    { kind: 'check', id: 'folders-on-top', label: t('siteTree.foldersOnTop', 'Keep folders on top'), checked: prefs.foldersOnTop, keepOpen, onToggle: () => a.setView({ foldersOnTop: !prefs.foldersOnTop }) },
    {
      kind: 'submenu',
      id: 'row-size',
      label: t('siteTree.rowSize', 'Row size'),
      icon: icon(Rows3),
      entries: [
        { kind: 'radio', id: 'density-compact', label: t('siteTree.compact', 'Compact'), checked: density === 'compact', onSelect: () => a.setView({ density: 'compact' }) },
        { kind: 'radio', id: 'density-comfortable', label: t('siteTree.comfortable', 'Comfortable'), checked: density === 'comfortable', onSelect: () => a.setView({ density: 'comfortable' }) },
      ],
    },
  ];
}

const expandEntries = (ctx: MenuContext, state: { hasFolders: boolean; anyExpanded: boolean; anyCollapsed: boolean }): ContextMenuEntry[] => [
  {
    kind: 'item',
    id: 'expand-all',
    label: ctx.t('loginDialog.expandFolders', 'Expand all folders'),
    icon: icon(ChevronsUpDown),
    disabled: !state.hasFolders || !state.anyCollapsed,
    onSelect: () => ctx.actions.setAllExpanded(true),
  },
  {
    kind: 'item',
    id: 'collapse-all',
    label: ctx.t('loginDialog.collapseFolders', 'Collapse all folders'),
    icon: icon(ChevronsDownUp),
    disabled: !state.hasFolders || !state.anyExpanded,
    onSelect: () => ctx.actions.setAllExpanded(false),
  },
];

/** E. Empty area of the tree, or the "All connections" header. */
export function emptyAreaMenu(ctx: MenuContext, state: { hasFolders: boolean; anyExpanded: boolean; anyCollapsed: boolean }, view: ViewMenuState): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  const entries: ContextMenuEntry[] = [
    { kind: 'item', id: 'new-connection', label: t('loginDialog.newConnection', 'New connection'), icon: icon(Plus), shortcut: k.newConnection, onSelect: () => a.newConnection('') },
    { kind: 'item', id: 'new-folder', label: t('siteTree.newFolder', 'New folder'), icon: icon(FolderPlus), shortcut: k.newFolder, onSelect: () => a.newFolder('') },
    ...pasteEntry(ctx, ''),
    SEP,
    ...arrangeEntries(ctx, view, false),
  ];
  if (state.hasFolders) entries.push(SEP, ...expandEntries(ctx, state));
  entries.push(SEP, ...importExportEntries(ctx));
  return entries;
}

/**
 * View options (the header's SlidersHorizontal): sort, folders on top, row size, server address
 * (compact rows), the Favorites and Recent sections, search results as a list, expand/collapse all.
 * Its checkboxes keep the menu open, so the owner rebuilds the entries on every render.
 */
export function viewOptionsMenu(ctx: MenuContext, state: { hasFolders: boolean; anyExpanded: boolean; anyCollapsed: boolean }, view: ViewMenuState): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const { prefs } = view;
  const entries: ContextMenuEntry[] = [...arrangeEntries(ctx, view, true)];
  // The address has its own line in comfortable rows; compact rows may leave it out
  if (view.density === 'compact') {
    entries.push({ kind: 'check', id: 'show-address', label: t('siteTree.showAddress', 'Show server address'), checked: prefs.showAddress, keepOpen: true, onToggle: () => a.setView({ showAddress: !prefs.showAddress }) });
  }
  entries.push(
    SEP,
    { kind: 'check', id: 'show-favorites', label: t('siteTree.showFavorites', 'Show favorites'), checked: prefs.showFavorites, keepOpen: true, onToggle: () => a.setView({ showFavorites: !prefs.showFavorites }) },
    { kind: 'check', id: 'show-recent', label: t('siteTree.showRecent', 'Show recent'), checked: prefs.showRecent, keepOpen: true, onToggle: () => a.setView({ showRecent: !prefs.showRecent }) },
    { kind: 'check', id: 'results-as-list', label: t('siteTree.resultsAsList', 'Show search results as a list'), checked: prefs.resultsAsList, keepOpen: true, onToggle: () => a.setView({ resultsAsList: !prefs.resultsAsList }) },
    SEP,
    ...expandEntries(ctx, state),
    SEP,
    { kind: 'item', id: 'edit-labels', label: t('siteTree.editLabels', 'Edit labels…'), icon: icon(Tags), onSelect: () => a.editLabels() }
  );
  return entries;
}

/** The row an F menu belongs to: a favorite site or a favorite folder. */
export type FavoriteMenuItem = { kind: 'site'; site: ConnectionConfig; local: boolean } | { kind: 'folder'; node: FolderNode };

/** F. A row of the Favorites section. */
export function favoriteMenu(item: FavoriteMenuItem, ctx: MenuContext): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  if (item.kind === 'folder') {
    const path = item.node.path;
    return [
      showInFolderEntry(ctx, `f:${path}`),
      { kind: 'item', id: 'new-connection', label: t('siteTree.newConnectionHere', 'New connection here'), icon: icon(Plus), shortcut: k.newConnection, onSelect: () => a.newConnection(path) },
      favoriteEntry(ctx, `f:${path}`, true),
    ];
  }
  const { site, local } = item;
  const entries: ContextMenuEntry[] = [
    { kind: 'item', id: 'connect', label: t('loginDialog.connect', 'Connect'), icon: icon(Plug), shortcut: k.connect, bold: true, onSelect: () => a.connect(site) },
    { kind: 'item', id: 'edit', label: t('siteTree.editDetails', 'Edit details'), icon: icon(SquarePen), shortcut: k.edit, onSelect: () => a.editDetails(site) },
    showInFolderEntry(ctx, `s:${site.id}`),
    favoriteEntry(ctx, `s:${site.id}`, true),
  ];
  // Local is never shared or deleted
  if (local) return entries;
  const tail: ContextMenuEntry[] = [];
  if (a.share) {
    const share = a.share;
    tail.push({ kind: 'item', id: 'share', label: t('loginDialog.shareSite', 'Share connection…'), icon: icon(Share2), onSelect: () => share(site) });
  }
  tail.push({ kind: 'item', id: 'delete', label: t('siteTree.delete', 'Delete'), icon: icon(Trash2), shortcut: k.delete, danger: true, onSelect: () => a.deleteItems([`s:${site.id}`]) });
  return [...entries, SEP, ...tail];
}

/** G. A row of the Recent section. */
export function recentMenu(site: ConnectionConfig, ctx: MenuContext, opts: { favorite: boolean }): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const k = shortcutLabels(ctx.mac);
  return [
    { kind: 'item', id: 'connect', label: t('loginDialog.connect', 'Connect'), icon: icon(Plug), shortcut: k.connect, bold: true, onSelect: () => a.connect(site) },
    showInFolderEntry(ctx, `s:${site.id}`),
    favoriteEntry(ctx, `s:${site.id}`, opts.favorite),
    SEP,
    { kind: 'item', id: 'remove-recent', label: t('siteTree.removeFromRecent', 'Remove from recent'), icon: icon(ListX), onSelect: () => a.removeRecent(site.id) },
    { kind: 'item', id: 'clear-recent', label: t('siteTree.clearRecent', 'Clear recent'), icon: icon(History), onSelect: () => a.clearRecent() },
  ];
}

/** H. The Favorites or Recent header: hide the section (View options brings it back); Recent can also be cleared. */
export function sectionMenu(section: 'fav' | 'rec', ctx: MenuContext): ContextMenuEntry[] {
  const { t, actions: a } = ctx;
  const entries: ContextMenuEntry[] = [{ kind: 'item', id: 'hide-section', label: t('siteTree.hideSection', 'Hide section'), icon: icon(EyeOff), onSelect: () => a.hideSection(section) }];
  if (section === 'rec') entries.push({ kind: 'item', id: 'clear-recent', label: t('siteTree.clearRecent', 'Clear recent'), icon: icon(History), onSelect: () => a.clearRecent() });
  return entries;
}
