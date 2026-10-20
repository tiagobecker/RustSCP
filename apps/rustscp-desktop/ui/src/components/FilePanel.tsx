import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useDeferredValue,
  useId,
  memo,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  Folder,
  FolderUp,
  FolderSymlink,
  FileSymlink,
  FileText,
  FileCode,
  FileArchive,
  FileImage,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  RotateCw,
  FolderPlus,
  Trash2,
  HardDrive,
  Server,
  House,
  Bookmark,
  BookmarkPlus,
  Search,
  Pencil,
  Check,
  List,
  LayoutGrid,
  Sparkles,
  X,
  Plus,
  Ellipsis,
  Eye,
} from 'lucide-react';
import { FileEntry, ActionDefinition, ClipboardState } from '../types.ts';
import { tabDragManager } from '../utils/tabDragManager.ts';
import { basename, dirname, samePath, isInside, isLikelyBinaryName, EDITOR_MAX_BYTES } from '../utils/paths.ts';
import { plainTextInputProps } from '../utils/inputHardening.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, IconButton } from './ui/controls.tsx';
import { Menu, MenuItem, MenuToggleItem, MenuLabel, MenuSeparator } from './ui/Menu.tsx';
import { notify } from './ui/toast.tsx';
import { FileContextMenu } from './FileContextMenu.tsx';
import {
  FileIconKind,
  extensionOf,
  fileDragState,
  formatCompactDate,
  formatSize,
  iconKindFor,
  isArchiveName,
  isMacPlatform,
  safeDisplayName,
} from './fileListUtils.ts';
import { PaneDropHit, paneDropTargets, setFileDragCursor } from './paneDropTargets.ts';

/**
 * Tauri drag-drop positions: wry reports AppKit points on macOS and GTK logical pixels on Linux
 * (both already CSS pixels), but physical pixels on Windows (WebView2 + ScreenToClient).
 */
const IS_WINDOWS =
  typeof navigator !== 'undefined' && (/^Win/i.test(navigator.platform || '') || /Windows NT/i.test(navigator.userAgent || ''));

/** Pointer travel (px) before a press on a row becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Distance (px) from a list's top/bottom edge where a drag scrolls it. */
const DRAG_SCROLL_EDGE = 32;

interface FilePanelProps {
  title: string;
  isRemote: boolean;
  sessionId: string;
  currentPath: string;
  files: FileEntry[];
  loading: boolean;
  selectedFiles: string[];
  diffMap?: Record<string, string>;
  clipboard?: ClipboardState | null;
  actionsCatalog?: ActionDefinition[];
  remoteTrashEnabled?: boolean;

  onNavigate: (newPath: string) => void;
  onRefresh: () => void;
  onSelectFile: (path: string, multi: boolean) => void;
  onNewFolder: () => void;
  onDelete: (paths?: string[], forcePermanent?: boolean) => void;
  onEditFile?: (file: FileEntry) => void;
  onShowProperties?: (file: FileEntry) => void;
  onCalculateChecksum?: (file: FileEntry) => void;
  onCalculateSize?: (file: FileEntry) => void;
  onOpenSymlink?: (file?: FileEntry) => void;
  onOpenFindFiles?: () => void;
  onOpenGenerateCode?: () => void;

  onCopy?: (paths: string[]) => void;
  onCut?: (paths: string[]) => void;
  onPaste?: () => void;
  onDuplicate?: (path: string) => void;
  onCompress?: (items: string[], format: string, outputName: string) => void;
  onExtract?: (archivePath: string, destSubfolder?: string) => void;
  onRequestCompress?: (targetPaths: string[]) => void;
  onRequestExtract?: (archivePath: string) => void;
  onOpenTerminalHere?: (path: string) => void;
  onOpenNativeTerminalHere?: (path: string) => void;
  onMoveToTrash?: (paths: string[]) => void;
  onExecuteSmartAction?: (action: ActionDefinition, targetPath: string) => void;
  onGoHome?: () => void;
  onOpenAiAssistant?: () => void;
  externalFilterText?: string;
  onDropItems?: (sourceSessionId: string, paths: string[], destSessionId: string, destDir: string, isCopy: boolean) => void;
  onTransferToOtherPane?: () => void;
  onMoveToOtherPane?: () => void;
  onFocusPanel?: () => void;
  isFocused?: boolean;
  onDropTab?: (sessionId: string, sourcePane: 'left' | 'right') => void;
  paneId?: 'left' | 'right';
  onNewSession?: () => void;

  /** Optional: replaces the whole selection in one update (range select, Cmd+A, pruning). Falls back to onSelectFile calls. */
  onSetSelection?: (paths: string[]) => void;
  /** Optional: false when the other pane cannot receive F5/F6 transfers (Explorer mode, no session there). */
  canTransferToOtherPane?: boolean;
  /** Optional: where F5/F6 send files (e.g. "Server · /var/www"); when set, F5/F6 ask for confirmation first. */
  otherPaneLabel?: string;
  /** Optional: rename one item (context menu "Rename…" and F2). Omitted = no rename UI. */
  onRename?: (file: FileEntry) => void;
}

/* -------------------------------------------------------------------------- */
/* Layout constants                                                            */
/* -------------------------------------------------------------------------- */

const ROW_H = 26;
const HEADER_H = 28;
const LIST_OVERSCAN = 10;
const CARD_MIN_W = 104;
const CARD_H = 100;
const CARD_GAP = 8;
const GRID_PAD = 12;
const GRID_OVERSCAN_ROWS = 2;
const COLUMN_STORAGE_KEY = 'rustscp_column_config';
const PARENT_KEY = '__parent__';

type ColumnKey = 'name' | 'size' | 'type' | 'modified' | 'created' | 'permissions' | 'owner' | 'group';

interface ColumnDef {
  key: ColumnKey;
  label: string;
  labelPt: string;
  visible: boolean;
  align: 'left' | 'right';
  /** CSS grid track */
  width: string;
  minPx: number;
}

const DEFAULT_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', labelPt: 'Nome', visible: true, align: 'left', width: 'minmax(180px, 1fr)', minPx: 180 },
  { key: 'size', label: 'Size', labelPt: 'Tamanho', visible: true, align: 'right', width: '84px', minPx: 84 },
  { key: 'type', label: 'Type', labelPt: 'Tipo', visible: true, align: 'left', width: '76px', minPx: 76 },
  { key: 'modified', label: 'Modified', labelPt: 'Modificado', visible: true, align: 'left', width: '148px', minPx: 148 },
  { key: 'created', label: 'Created', labelPt: 'Criado', visible: false, align: 'left', width: '148px', minPx: 148 },
  { key: 'permissions', label: 'Permissions', labelPt: 'Permissões', visible: true, align: 'left', width: '96px', minPx: 96 },
  { key: 'owner', label: 'Owner', labelPt: 'Dono', visible: false, align: 'left', width: '96px', minPx: 96 },
  { key: 'group', label: 'Group', labelPt: 'Grupo', visible: false, align: 'left', width: '88px', minPx: 88 },
];

function loadColumns(): ColumnDef[] {
  try {
    const saved = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Record<string, boolean>;
      return DEFAULT_COLUMNS.map((col) => ({
        ...col,
        visible: col.key === 'name' ? true : parsed[col.key] !== undefined ? !!parsed[col.key] : col.visible,
      }));
    }
  } catch {
    /* ignore unreadable settings */
  }
  return DEFAULT_COLUMNS;
}

/* -------------------------------------------------------------------------- */
/* Per-file display data (computed once per listing)                           */
/* -------------------------------------------------------------------------- */

interface FileMeta {
  display: string;
  nameLower: string;
  ext: string;
  typeLabel: string;
  sizeText: string;
  modifiedTs: number;
  createdTs: number;
  permText: string;
  ownerLower: string;
  icon: FileIconKind;
}

function computeMeta(f: FileEntry, isPt: boolean): FileMeta {
  const isDir = f.file_type === 'directory';
  const ext = isDir ? '' : extensionOf(f.name);
  const typeLabel = isDir
    ? isPt ? 'Pasta' : 'Folder'
    : f.file_type === 'symlink'
    ? 'Link'
    : ext
    ? ext.toUpperCase()
    : isPt ? 'Arquivo' : 'File';
  const mode = f.permissions?.mode || 0;
  return {
    display: safeDisplayName(f.name),
    nameLower: f.name.toLowerCase(),
    ext,
    typeLabel,
    sizeText: isDir ? '—' : formatSize(f.size),
    modifiedTs: f.modified_at ? Date.parse(f.modified_at) || 0 : 0,
    createdTs: f.created_at ? Date.parse(f.created_at) || 0 : 0,
    permText: mode ? '0' + (mode & 0o777).toString(8).padStart(3, '0') : '—',
    ownerLower: (f.permissions?.owner || '').toLowerCase(),
    icon: iconKindFor(f.name, f.file_type),
  };
}

type RowItem =
  | { kind: 'parent'; key: string; path: string }
  | { kind: 'file'; key: string; file: FileEntry; meta: FileMeta };

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Folder a drop on this row/card goes into ('..' = parent folder), or null for plain files. */
const folderTargetOf = (item: RowItem): string | null =>
  item.kind === 'parent' ? item.path : item.file.file_type === 'directory' ? item.file.path : null;

/** Breadcrumb segments. Windows drive paths ('C:\Users\me') split on both separators; POSIX only on '/'. */
function buildCrumbs(path: string): { label: string; path: string }[] {
  if (!path) return [];
  const drive = /^([A-Za-z]:)([\\/]|$)/.exec(path);
  if (drive) {
    const sep = path.includes('\\') ? '\\' : '/';
    const out = [{ label: drive[1], path: drive[1] + sep }];
    let acc = drive[1];
    for (const seg of path.slice(drive[0].length).split(/[\\/]+/).filter(Boolean)) {
      acc = `${acc}${sep}${seg}`;
      out.push({ label: seg, path: acc });
    }
    return out;
  }
  const out = [{ label: '/', path: '/' }];
  let acc = '';
  for (const seg of path.split('/').filter(Boolean)) {
    acc = `${acc}/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

const FileIcon: React.FC<{ kind: FileIconKind; large?: boolean }> = ({ kind, large }) => {
  const cls = large ? 'w-8 h-8' : 'w-4 h-4';
  switch (kind) {
    case 'folder':
      return <Folder className={`${cls} shrink-0 text-ink-muted fill-ink-faint/15`} aria-hidden />;
    case 'folderLink':
      return <FolderSymlink className={`${cls} shrink-0 text-ink-muted fill-ink-faint/15`} aria-hidden />;
    case 'link':
      return <FileSymlink className={`${cls} shrink-0 text-ink-faint`} aria-hidden />;
    case 'archive':
      return <FileArchive className={`${cls} shrink-0 text-ink-faint`} aria-hidden />;
    case 'code':
      return <FileCode className={`${cls} shrink-0 text-ink-faint`} aria-hidden />;
    case 'image':
      return <FileImage className={`${cls} shrink-0 text-ink-faint`} aria-hidden />;
    default:
      return <FileText className={`${cls} shrink-0 text-ink-faint`} aria-hidden />;
  }
};

const diffLabel = (diff: string, isPt: boolean) =>
  diff === 'different_size'
    ? isPt ? '≠ tamanho' : '≠ size'
    : diff === 'different_time'
    ? isPt ? '≠ data' : '≠ time'
    : isPt ? 'novo' : 'new';

const diffTitle = (diff: string, isPt: boolean) =>
  diff === 'different_size'
    ? isPt ? 'Tamanho diferente no outro painel' : 'Different size in the other pane'
    : diff === 'different_time'
    ? isPt ? 'Data de modificação diferente no outro painel' : 'Different modification time in the other pane'
    : isPt ? 'Não existe no outro painel' : 'Missing in the other pane';

const diffChipClass = (diff: string) =>
  diff === 'different_size'
    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
    : diff === 'different_time'
    ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
    : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';

const diffRowTint = (diff?: string) =>
  !diff
    ? ''
    : diff === 'different_size'
    ? 'bg-amber-500/[0.06]'
    : diff === 'different_time'
    ? 'bg-sky-500/[0.06]'
    : 'bg-emerald-500/[0.06]';

/* -------------------------------------------------------------------------- */
/* Rows (memoized; event handlers are delegated to the list container)         */
/* -------------------------------------------------------------------------- */

interface RowProps {
  item: RowItem;
  index: number;
  rowId: string;
  selected: boolean;
  cursor: boolean;
  cut: boolean;
  dropTarget: boolean;
  diff?: string;
  columns: ColumnDef[];
  template: string;
  locale: string;
  isPt: boolean;
}

const FileRow = memo(function FileRow({ item, index, rowId, selected, cursor, cut, dropTarget, diff, columns, template, locale, isPt }: RowProps) {
  const base = 'grid items-center h-[26px] px-2 text-[13px] cursor-default select-none';
  const stateCls = dropTarget
    ? 'bg-rust-500/15 ring-1 ring-inset ring-rust-500/60'
    : selected
    ? 'bg-rust-500/10'
    : cx('hover:bg-dark-650/40', diffRowTint(diff));

  if (item.kind === 'parent') {
    return (
      <div
        role="row"
        id={rowId}
        aria-rowindex={index + 2}
        aria-selected={false}
        data-row-index={index}
        title={isPt ? 'Pasta acima (duplo clique, Enter ou ⌫)' : 'Parent folder (double-click, Enter or ⌫)'}
        className={cx(base, stateCls, cursor && 'ring-1 ring-inset ring-rust-500/45')}
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((col) =>
          col.key === 'name' ? (
            <div key="name" role="gridcell" className="flex items-center gap-2 min-w-0 pr-2">
              <FolderUp className="w-4 h-4 shrink-0 text-ink-muted" aria-hidden />
              <span className="font-mono text-ink">..</span>
              <span className="text-[12px] text-ink-faint truncate">{isPt ? 'Pasta acima' : 'Parent folder'}</span>
            </div>
          ) : (
            <div key={col.key} role="gridcell" />
          )
        )}
      </div>
    );
  }

  const { file, meta } = item;
  return (
    <div
      role="row"
      id={rowId}
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-row-index={index}
      className={cx(base, stateCls, cursor && 'ring-1 ring-inset ring-rust-500/45', cut && 'opacity-50 italic')}
      style={{ gridTemplateColumns: template }}
    >
      {columns.map((col) => {
        switch (col.key) {
          case 'name':
            return (
              <div key="name" role="gridcell" className="flex items-center gap-2 min-w-0 pr-2">
                <FileIcon kind={meta.icon} />
                <bdi className="truncate text-ink" title={meta.display}>
                  {meta.display}
                </bdi>
                {diff && (
                  <span className={cx('shrink-0 text-[10.5px] leading-4 px-1.5 rounded-full', diffChipClass(diff))} title={diffTitle(diff, isPt)}>
                    {diffLabel(diff, isPt)}
                  </span>
                )}
              </div>
            );
          case 'size':
            return (
              <div key="size" role="gridcell" className="text-right pr-3 text-[12px] text-ink-muted tabular-nums whitespace-nowrap truncate">
                {meta.sizeText}
              </div>
            );
          case 'type':
            return (
              <div key="type" role="gridcell" className="pr-2 text-[12px] text-ink-muted whitespace-nowrap truncate">
                {meta.typeLabel}
              </div>
            );
          case 'modified':
            return (
              <div key="modified" role="gridcell" className="pr-2 text-[12px] text-ink-muted tabular-nums whitespace-nowrap truncate">
                {formatCompactDate(file.modified_at, locale).text || '—'}
              </div>
            );
          case 'created':
            return (
              <div key="created" role="gridcell" className="pr-2 text-[12px] text-ink-muted tabular-nums whitespace-nowrap truncate">
                {formatCompactDate(file.created_at, locale).text || '—'}
              </div>
            );
          case 'permissions':
            return (
              <div key="permissions" role="gridcell" className="pr-2 text-[12px] text-ink-faint font-mono tabular-nums whitespace-nowrap">
                {meta.permText}
              </div>
            );
          case 'owner':
            return (
              <div key="owner" role="gridcell" className="pr-2 text-[12px] text-ink-muted whitespace-nowrap truncate">
                {file.permissions?.owner || '—'}
              </div>
            );
          case 'group':
            return (
              <div key="group" role="gridcell" className="pr-2 text-[12px] text-ink-muted whitespace-nowrap truncate">
                {file.permissions?.group || '—'}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
});

interface CardProps {
  item: RowItem;
  index: number;
  rowId: string;
  selected: boolean;
  cursor: boolean;
  cut: boolean;
  dropTarget: boolean;
  diff?: string;
  isPt: boolean;
}

const FileCard = memo(function FileCard({ item, index, rowId, selected, cursor, cut, dropTarget, diff, isPt }: CardProps) {
  const base = 'relative flex flex-col items-center justify-center gap-1.5 px-2 rounded-xl text-center cursor-default select-none';
  const stateCls = dropTarget
    ? 'bg-rust-500/15 ring-1 ring-rust-500/60'
    : selected
    ? 'bg-rust-500/10'
    : 'hover:bg-dark-650/40';

  if (item.kind === 'parent') {
    return (
      <div
        role="option"
        id={rowId}
        aria-selected={false}
        data-row-index={index}
        title={isPt ? 'Pasta acima (clique)' : 'Parent folder (click)'}
        className={cx(base, stateCls, cursor && 'ring-1 ring-rust-500/45')}
        style={{ height: CARD_H }}
      >
        <FolderUp className="w-8 h-8 text-ink-muted" aria-hidden />
        <span className="text-[12px] font-mono text-ink">..</span>
        <span className="text-[11px] text-ink-faint">{isPt ? 'Pasta acima' : 'Parent folder'}</span>
      </div>
    );
  }

  const { file, meta } = item;
  return (
    <div
      role="option"
      id={rowId}
      aria-selected={selected}
      data-row-index={index}
      title={meta.display}
      className={cx(base, stateCls, cursor && 'ring-1 ring-rust-500/45', cut && 'opacity-50 italic')}
      style={{ height: CARD_H }}
    >
      <FileIcon kind={meta.icon} large />
      <bdi className="w-full text-[12px] leading-tight text-ink line-clamp-2 break-all">{meta.display}</bdi>
      <span className="text-[11px] text-ink-faint tabular-nums">{file.file_type === 'directory' ? meta.typeLabel : meta.sizeText}</span>
      {diff && (
        <span
          className={cx('absolute top-1.5 right-1.5 text-[10px] leading-4 px-1.5 rounded-full', diffChipClass(diff))}
          title={diffTitle(diff, isPt)}
        >
          {diffLabel(diff, isPt)}
        </span>
      )}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

interface ConflictState {
  destDir: string;
  names: string[];
  /** The destination could not be listed, so we do not know what would be replaced */
  unknown: boolean;
  onReplace: () => void;
  onSkip?: () => void;
}

interface TransferConfirmState {
  mode: 'copy' | 'move';
  count: number;
}

/** Floating label that follows the pointer during a row drag. */
interface RowDragGhost {
  count: number;
  /** Display name when one item is dragged */
  name: string;
  icon: FileIconKind;
  effect: 'copy' | 'move' | 'none';
}

/** A press on a file row that may become a drag (pointer events, see paneDropTargets.ts). */
interface RowDragState {
  pointerId: number;
  startX: number;
  startY: number;
  /** Row the press started on */
  path: string;
  /** Element that takes pointer capture once the drag starts */
  captureEl: HTMLElement;
  sourceSessionId: string;
  active: boolean;
  paths: string[];
  x: number;
  y: number;
  altKey: boolean;
  /** Registry id of the pane currently highlighted */
  hoverId: string | null;
  scrollRaf: number | null;
}

export const FilePanel: React.FC<FilePanelProps> = ({
  title,
  isRemote,
  sessionId,
  currentPath,
  files,
  loading,
  selectedFiles,
  diffMap,
  clipboard,
  actionsCatalog = [],
  remoteTrashEnabled = false,
  onNavigate,
  onRefresh,
  onSelectFile,
  onNewFolder,
  onDelete,
  onEditFile,
  onShowProperties,
  onCalculateChecksum,
  onCalculateSize,
  onOpenSymlink,
  onOpenFindFiles,
  onOpenGenerateCode,
  onCopy,
  onCut,
  onPaste,
  onDuplicate,
  onCompress,
  onExtract,
  onRequestCompress,
  onRequestExtract,
  onOpenTerminalHere,
  onOpenNativeTerminalHere,
  onMoveToTrash,
  onExecuteSmartAction,
  onGoHome,
  onOpenAiAssistant,
  externalFilterText,
  onDropItems,
  onTransferToOtherPane,
  onMoveToOtherPane,
  onFocusPanel,
  isFocused = false,
  onDropTab,
  paneId,
  onNewSession,
  onSetSelection,
  canTransferToOtherPane,
  otherPaneLabel,
  onRename,
}) => {
  const { t, i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const locale = isPt ? 'pt-BR' : 'en-US';
  const isMac = isMacPlatform();
  const mod = isMac ? '⌘' : 'Ctrl+';
  const idBase = useId();
  const trashAvailable = isRemote && remoteTrashEnabled;

  const [pathInput, setPathInput] = useState(currentPath);
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [showHidden, setShowHidden] = useState<boolean>(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileEntry | null;
    targetPaths: string[];
    isBackground: boolean;
  } | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [isDragOverContainer, setIsDragOverContainer] = useState<boolean>(false);
  const [columns, setColumns] = useState<ColumnDef[]>(loadColumns);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(() => {
    try {
      return localStorage.getItem(`rustscp_view_mode_${paneId || 'main'}`) === 'grid' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  const [filterQuery, setFilterQuery] = useState('');
  const [showFilterBar, setShowFilterBar] = useState(false);
  const [sortColumn, setSortColumn] = useState<ColumnKey>('name');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0 });
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [binaryConfirm, setBinaryConfirm] = useState<FileEntry | null>(null);
  const [transferConfirm, setTransferConfirm] = useState<TransferConfirmState | null>(null);
  const [customBookmarks, setCustomBookmarks] = useState<string[]>([]);
  const [rowDragGhost, setRowDragGhost] = useState<RowDragGhost | null>(null);

  const pathInputRef = useRef<HTMLInputElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const anchorKeyRef = useRef<string | null>(null);
  const restoreCursorFromRef = useRef<string | null>(null);
  const lastPointerGoUpRef = useRef(0);
  const typeAheadRef = useRef({ buffer: '', time: 0 });
  const scrollRafRef = useRef<number | null>(null);
  const rowDragRef = useRef<RowDragState | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  /** Set for the click that follows a finished drag, so it does not also select a row */
  const suppressClickRef = useRef(false);
  /** Latest row-drag handlers (reassigned every render); the window listeners below call through it. */
  const rowDragImplRef = useRef({
    move: (_e: PointerEvent) => {},
    up: (_e: PointerEvent) => {},
    cancel: () => {},
    key: (_e: KeyboardEvent) => {},
    update: () => {},
  });
  /** Stable window listeners for a row drag (same references for add and remove). */
  const [rowDragListeners] = useState(() => ({
    move: (e: PointerEvent) => rowDragImplRef.current.move(e),
    up: (e: PointerEvent) => rowDragImplRef.current.up(e),
    cancel: () => rowDragImplRef.current.cancel(),
    key: (e: KeyboardEvent) => rowDragImplRef.current.key(e),
  }));

  const deferredQuery = useDeferredValue(filterQuery);

  /* ----------------------------- Path & navigation ----------------------------- */

  useEffect(() => {
    setPathInput(currentPath);
  }, [currentPath]);

  useEffect(() => {
    if (isEditingPath && pathInputRef.current) {
      pathInputRef.current.focus();
      pathInputRef.current.select();
    }
  }, [isEditingPath]);

  // Keep the end of long breadcrumbs visible
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [currentPath, isEditingPath]);

  const parentPath = useMemo(() => {
    if (!currentPath) return '/';
    const normalized = currentPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return '/';
    if (parts.length === 1 && /^[a-zA-Z]:$/i.test(parts[0])) return currentPath;
    parts.pop();
    if (parts.length === 0) return '/';
    if (parts.length === 1 && /^[a-zA-Z]:$/i.test(parts[0])) {
      return parts[0] + (currentPath.includes('\\') ? '\\' : '/');
    }
    return (currentPath.startsWith('/') ? '/' : '') + parts.join(currentPath.includes('\\') ? '\\' : '/');
  }, [currentPath]);

  const canGoUp = useMemo(() => {
    if (!currentPath || !sessionId) return false;
    const normalized = currentPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1 && /^[a-zA-Z]:$/i.test(parts[0])) return false;
    return true;
  }, [currentPath, sessionId]);

  const navigateTo = (target: string) => {
    // No session (empty pane): nothing to navigate, so breadcrumbs and bookmarks stay inert.
    if (!target || !sessionId) return;
    onNavigate(target);
    setPathInput(target);
  };

  const handleGoUp = () => {
    if (!canGoUp) return;
    restoreCursorFromRef.current = currentPath;
    navigateTo(parentPath);
  };

  /** Pointer-triggered "go up" ignores repeats (click, click, dblclick) so one gesture climbs one level. */
  const handlePointerGoUp = () => {
    const now = Date.now();
    if (now - lastPointerGoUpRef.current < 500) return;
    lastPointerGoUpRef.current = now;
    handleGoUp();
  };

  const commitPathInput = () => {
    const target = pathInput.trim();
    setIsEditingPath(false);
    if (target && target !== currentPath) navigateTo(target);
    else setPathInput(currentPath);
  };

  const cancelPathInput = () => {
    setPathInput(currentPath);
    setIsEditingPath(false);
  };

  const crumbs = useMemo(() => buildCrumbs(currentPath), [currentPath]);

  /* ---------------------------------- Bookmarks --------------------------------- */

  const bookmarksKey = `rustscp_bookmarks:${isRemote ? sessionId || 'remote' : 'local'}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(bookmarksKey);
      const parsed = raw ? JSON.parse(raw) : [];
      setCustomBookmarks(Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : []);
    } catch {
      setCustomBookmarks([]);
    }
  }, [bookmarksKey]);

  const saveBookmarks = (next: string[]) => {
    setCustomBookmarks(next);
    try {
      localStorage.setItem(bookmarksKey, JSON.stringify(next));
    } catch {
      /* storage unavailable: keep them for this session only */
    }
  };

  const defaultBookmarks = isRemote ? ['/', '/var/www', '/etc', '/home', '/var/log', '/tmp'] : ['/', '/Users', '/Volumes', '/tmp'];
  const allBookmarks = Array.from(new Set([...defaultBookmarks, ...customBookmarks]));

  const handleAddCurrentToBookmarks = () => {
    if (!currentPath) return;
    if (!customBookmarks.includes(currentPath) && !defaultBookmarks.includes(currentPath)) {
      saveBookmarks([...customBookmarks, currentPath]);
      notify.success(isPt ? 'Favorito adicionado' : 'Bookmark added', currentPath);
    } else {
      notify.info(isPt ? 'Esta pasta já está nos favoritos' : 'This folder is already bookmarked', currentPath);
    }
  };

  const handleRemoveBookmark = (path: string) => saveBookmarks(customBookmarks.filter((b) => b !== path));

  /* ---------------------------------- Columns ----------------------------------- */

  const toggleColumn = (key: ColumnKey) => {
    if (key === 'name') return;
    setColumns((prev) => {
      const next = prev.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c));
      try {
        const map = next.reduce<Record<string, boolean>>((acc, c) => ({ ...acc, [c.key]: c.visible }), {});
        localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(map));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const resetColumns = () => {
    setColumns(DEFAULT_COLUMNS);
    try {
      localStorage.removeItem(COLUMN_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const visibleColumns = useMemo(() => columns.filter((c) => c.visible), [columns]);
  const gridTemplate = useMemo(() => visibleColumns.map((c) => c.width).join(' '), [visibleColumns]);
  const listMinWidth = useMemo(() => visibleColumns.reduce((acc, c) => acc + c.minPx, 16), [visibleColumns]);

  const handleSort = (key: ColumnKey) => {
    if (sortColumn === key) {
      setSortAsc((v) => !v);
    } else {
      setSortColumn(key);
      setSortAsc(true);
    }
  };

  const changeViewMode = (mode: 'list' | 'grid') => {
    setViewMode(mode);
    try {
      localStorage.setItem(`rustscp_view_mode_${paneId || 'main'}`, mode);
    } catch {
      /* ignore */
    }
  };

  // Sync external filter if provided
  useEffect(() => {
    if (externalFilterText !== undefined) {
      setFilterQuery(externalFilterText);
      if (externalFilterText) setShowFilterBar(true);
    }
  }, [externalFilterText]);

  /* ------------------------- Listing: meta, sort, filter ------------------------- */

  const metaMap = useMemo(() => {
    const map = new Map<FileEntry, FileMeta>();
    for (const f of files) map.set(f, computeMeta(f, isPt));
    return map;
  }, [files, isPt]);

  const collator = useMemo(() => new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }), [locale]);

  // '.' and '..' from the backend are dropped: the panel draws its own parent row.
  const baseFiles = useMemo(
    () => files.filter((f) => f.name !== '.' && f.name !== '..' && (showHidden || !f.is_hidden)),
    [files, showHidden]
  );

  const hiddenCount = useMemo(
    () => (showHidden ? 0 : files.reduce((n, f) => (f.is_hidden && f.name !== '.' && f.name !== '..' ? n + 1 : n), 0)),
    [files, showHidden]
  );

  const sortedFiles = useMemo(() => {
    const arr = baseFiles.slice();
    const dirRank = (f: FileEntry) => (f.file_type === 'directory' ? 0 : 1);
    arr.sort((a, b) => {
      const d = dirRank(a) - dirRank(b);
      if (d !== 0) return d;
      const ma = metaMap.get(a)!;
      const mb = metaMap.get(b)!;
      let cmp = 0;
      switch (sortColumn) {
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'type':
          cmp = collator.compare(ma.typeLabel, mb.typeLabel);
          break;
        case 'modified':
          cmp = ma.modifiedTs - mb.modifiedTs;
          break;
        case 'created':
          cmp = ma.createdTs - mb.createdTs;
          break;
        case 'permissions':
          cmp = (a.permissions?.mode || 0) - (b.permissions?.mode || 0);
          break;
        case 'owner':
          cmp = collator.compare(a.permissions?.owner || '', b.permissions?.owner || '');
          break;
        case 'group':
          cmp = collator.compare(a.permissions?.group || '', b.permissions?.group || '');
          break;
        default:
          cmp = 0;
      }
      if (cmp === 0) cmp = collator.compare(a.name, b.name);
      return sortAsc ? cmp : -cmp;
    });
    return arr;
  }, [baseFiles, metaMap, sortColumn, sortAsc, collator]);

  const displayedFiles = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return sortedFiles;
    const qExt = q.replace(/^\./, '');
    return sortedFiles.filter((f) => {
      const m = metaMap.get(f)!;
      return m.nameLower.includes(q) || (!!m.ext && m.ext === qExt) || (!!m.ownerLower && m.ownerLower.includes(q));
    });
  }, [sortedFiles, deferredQuery, metaMap]);

  const rows: RowItem[] = useMemo(() => {
    const out: RowItem[] = [];
    if (canGoUp) out.push({ kind: 'parent', key: PARENT_KEY, path: parentPath });
    for (const f of displayedFiles) out.push({ kind: 'file', key: f.path, file: f, meta: metaMap.get(f)! });
    return out;
  }, [displayedFiles, canGoUp, parentPath, metaMap]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const filesRef = useRef(files);
  filesRef.current = files;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const selectedSet = useMemo(() => new Set(selectedFiles), [selectedFiles]);
  const cutSet = useMemo(
    () => (clipboard?.action === 'cut' && clipboard.sourceSession === sessionId ? new Set(clipboard.paths) : null),
    [clipboard, sessionId]
  );
  const visiblePathSet = useMemo(() => new Set(displayedFiles.map((f) => f.path)), [displayedFiles]);
  /** Actions only ever touch what the user can see (filter and hidden files respected). */
  const visibleSelected = useMemo(() => selectedFiles.filter((p) => visiblePathSet.has(p)), [selectedFiles, visiblePathSet]);
  const selectedBytes = useMemo(() => {
    if (!visibleSelected.length) return 0;
    const sel = new Set(visibleSelected);
    let total = 0;
    for (const f of displayedFiles) if (sel.has(f.path) && f.file_type !== 'directory') total += f.size || 0;
    return total;
  }, [visibleSelected, displayedFiles]);

  const selectedRef = useRef(selectedFiles);
  selectedRef.current = selectedFiles;

  /* --------------------------------- Selection ---------------------------------- */

  const applySelection = useCallback(
    (paths: string[]) => {
      if (onSetSelection) {
        onSetSelection(paths);
        return;
      }
      // Fallback through the toggle API (App updates state functionally, so these calls compose).
      if (paths.length === 0) {
        for (const p of selectedRef.current) onSelectFile(p, true);
        return;
      }
      onSelectFile(paths[0], false);
      for (let i = 1; i < paths.length; i++) onSelectFile(paths[i], true);
    },
    [onSetSelection, onSelectFile]
  );

  const applySelectionRef = useRef(applySelection);
  applySelectionRef.current = applySelection;

  // Drop selected items that the filter or the hidden-files toggle no longer shows (FP-21).
  // Runs only when the visible listing changes, never because the selection itself changed.
  useEffect(() => {
    if (loading) return;
    const sel = selectedRef.current;
    if (!sel.length) return;
    const keep = sel.filter((p) => visiblePathSet.has(p));
    if (keep.length !== sel.length) applySelectionRef.current(keep);
  }, [visiblePathSet, loading]);

  const cursorIndex = useMemo(() => (cursorKey ? rows.findIndex((r) => r.key === cursorKey) : -1), [rows, cursorKey]);

  // New folder: reset scroll and cursor; after going up, put the cursor on the folder we came from.
  useLayoutEffect(() => {
    setCursorKey(null);
    anchorKeyRef.current = null;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setViewport((v) => (v.top === 0 ? v : { ...v, top: 0 }));
  }, [currentPath, sessionId]);

  /* ------------------------------ Virtualization -------------------------------- */

  // A new filter shows its results from the top
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || el.scrollTop === 0) return;
    el.scrollTop = 0;
    setViewport((v) => ({ ...v, top: 0 }));
  }, [deferredQuery]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    },
    []
  );

  const handleScroll = () => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      setViewport((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { ...v, top: el.scrollTop, height: el.clientHeight }));
    });
  };

  const gridCols = Math.max(1, Math.floor((Math.max(viewport.width, CARD_MIN_W + GRID_PAD * 2) - GRID_PAD * 2 + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
  const gridColsRef = useRef(gridCols);
  gridColsRef.current = gridCols;

  const listRange = useMemo(() => {
    const height = viewport.height || 600;
    // Clamp to the real scroll range: when the list shrinks (filter), the browser clamps scrollTop a frame later.
    const top = Math.min(viewport.top, Math.max(0, HEADER_H + rows.length * ROW_H - height));
    const first = Math.max(0, Math.floor(top / ROW_H) - LIST_OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((top + height - HEADER_H) / ROW_H) + LIST_OVERSCAN);
    return { first, last: Math.max(first, last) };
  }, [viewport.top, viewport.height, rows.length]);

  const gridRange = useMemo(() => {
    const stride = CARD_H + CARD_GAP;
    const height = viewport.height || 600;
    const rowCount = Math.ceil(rows.length / gridCols);
    const top = Math.min(viewport.top, Math.max(0, GRID_PAD * 2 + rowCount * stride - height));
    const firstRow = Math.max(0, Math.floor((top - GRID_PAD) / stride) - GRID_OVERSCAN_ROWS);
    const lastRow = Math.min(rowCount, Math.ceil((top + height - GRID_PAD) / stride) + GRID_OVERSCAN_ROWS);
    return { firstRow, lastRow: Math.max(firstRow, lastRow), rowCount };
  }, [viewport.top, viewport.height, rows.length, gridCols]);

  const scrollIndexIntoView = useCallback(
    (idx: number) => {
      const el = scrollRef.current;
      if (!el || idx < 0) return;
      if (viewMode === 'list') {
        const top = idx * ROW_H;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (HEADER_H + top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = HEADER_H + top + ROW_H - el.clientHeight;
      } else {
        const stride = CARD_H + CARD_GAP;
        const top = GRID_PAD + Math.floor(idx / gridColsRef.current) * stride;
        if (top < el.scrollTop) el.scrollTop = Math.max(0, top - GRID_PAD);
        else if (top + CARD_H > el.scrollTop + el.clientHeight) el.scrollTop = top + CARD_H + GRID_PAD - el.clientHeight;
      }
    },
    [viewMode]
  );

  // After "go up", land the cursor on the folder we came from (Commander style), without selecting it.
  useEffect(() => {
    const from = restoreCursorFromRef.current;
    if (!from || loading) return;
    const idx = rows.findIndex((r) => r.kind === 'file' && (samePath(r.file.path, from) || isInside(from, r.file.path)));
    restoreCursorFromRef.current = null;
    if (idx >= 0) {
      setCursorKey(rows[idx].key);
      anchorKeyRef.current = rows[idx].key;
      requestAnimationFrame(() => scrollIndexIntoView(idx));
    }
  }, [rows, loading, scrollIndexIntoView]);

  /* ------------------------------ Open / edit files ------------------------------ */

  const editWithGuards = (file: FileEntry) => {
    if (!onEditFile) return;
    if (file.file_type !== 'symlink' && file.size > EDITOR_MAX_BYTES) {
      notify.info(
        isPt ? 'Arquivo grande demais para o editor' : 'File too large for the editor',
        isPt
          ? `${safeDisplayName(file.name)} tem ${formatSize(file.size)}. O editor abre arquivos de até ${formatSize(EDITOR_MAX_BYTES)}. Para baixá-lo, copie para o outro painel (F5).`
          : `${safeDisplayName(file.name)} is ${formatSize(file.size)}. The editor opens files up to ${formatSize(EDITOR_MAX_BYTES)}. To download it, copy it to the other pane (F5).`
      );
      return;
    }
    if (isLikelyBinaryName(file.name)) {
      setBinaryConfirm(file);
      return;
    }
    onEditFile(file);
  };

  const probeDirectory = async (path: string): Promise<boolean> => {
    if (!isTauri() || !sessionId) return false;
    try {
      await invoke<FileEntry[]>('list_directory', { sessionId, path, bypassCache: false });
      return true;
    } catch {
      return false;
    }
  };

  const openEntry = async (file: FileEntry) => {
    if (file.file_type === 'directory') {
      navigateTo(file.path);
      return;
    }
    if (file.file_type === 'symlink' && (await probeDirectory(file.path))) {
      // Link to a folder: browse it instead of loading it into the editor
      navigateTo(file.path);
      return;
    }
    if (isArchiveName(file.name) && onRequestExtract) {
      onRequestExtract(file.path);
      return;
    }
    editWithGuards(file);
  };

  const openRow = (row: RowItem) => {
    if (row.kind === 'parent') handleGoUp();
    else void openEntry(row.file);
  };

  /* --------------------------- Transfers (drop & paste) -------------------------- */

  /** Names in `dir` of session `sid`; null when the folder cannot be listed. */
  const listNames = async (sid: string, dir: string): Promise<Set<string> | null> => {
    if (!isTauri()) return new Set();
    try {
      const list = await invoke<FileEntry[]>('list_directory', { sessionId: sid, path: dir, bypassCache: true });
      return new Set(list.map((f) => f.name));
    } catch {
      return null;
    }
  };

  const existingNamesIn = async (destDir: string): Promise<Set<string> | null> => {
    // While loading, `files` may still be the previous folder's listing: ask the session instead
    if (samePath(destDir, currentPath) && !loading) return new Set(files.map((f) => f.name));
    return listNames(sessionId, destDir);
  };

  /** True when moving/copying `src` into `destDir` of the same session would hit itself. */
  const isSelfTarget = (src: string, destDir: string) => samePath(dirname(src), destDir) || samePath(src, destDir) || isInside(destDir, src);

  /**
   * Single entry point for every drop into this pane. Same-session drops into the item's own
   * folder (or a folder into itself) are skipped, and name collisions always ask first.
   */
  const queueTransfer = async (sourceSessionId: string, paths: string[], destDir: string, isCopy: boolean) => {
    if (!onDropItems || !sessionId || !paths.length) return;
    let candidates = paths;
    if (sourceSessionId === sessionId) {
      const intoSelf = candidates.filter((p) => samePath(p, destDir) || isInside(destDir, p));
      const inPlace = candidates.filter((p) => samePath(dirname(p), destDir));
      candidates = candidates.filter((p) => !isSelfTarget(p, destDir));
      if (intoSelf.length) {
        notify.warning(
          isPt ? 'Uma pasta não pode ir para dentro dela mesma' : "A folder can't go inside itself",
          intoSelf.map((p) => safeDisplayName(basename(p))).join(', ')
        );
      } else if (inPlace.length && !candidates.length) {
        notify.info(isPt ? 'Os itens já estão nesta pasta' : 'Already in this folder');
      }
    }
    if (!candidates.length) return;

    const existing = await existingNamesIn(destDir);
    const collisions = existing ? candidates.filter((p) => existing.has(basename(p))) : [];
    const send = (list: string[]) => {
      if (list.length) onDropItems(sourceSessionId, list, sessionId, destDir, isCopy);
    };

    if (existing === null) {
      setConflict({ destDir, names: [], unknown: true, onReplace: () => send(candidates) });
    } else if (collisions.length) {
      const rest = candidates.filter((p) => !collisions.includes(p));
      setConflict({
        destDir,
        names: collisions.map((p) => basename(p)),
        unknown: false,
        onReplace: () => send(candidates),
        onSkip: rest.length ? () => send(rest) : undefined,
      });
    } else {
      send(candidates);
    }
  };

  const queueTransferRef = useRef(queueTransfer);
  queueTransferRef.current = queueTransfer;

  /** Paste with the same safety rules as drag and drop. */
  const handlePasteHere = () => {
    if (!clipboard || clipboard.paths.length === 0 || !onPaste || !sessionId) return;
    const paths = clipboard.paths;
    const same = clipboard.sourceSession === sessionId;
    const intoSelf = same ? paths.filter((p) => samePath(p, currentPath) || isInside(currentPath, p)) : [];
    const inPlace = same ? paths.filter((p) => samePath(dirname(p), currentPath)) : [];
    const rest = paths.filter((p) => !intoSelf.includes(p) && !inPlace.includes(p));

    if (intoSelf.length) {
      notify.warning(
        isPt ? 'Uma pasta não pode ser colada dentro dela mesma' : "A folder can't be pasted inside itself",
        intoSelf.map((p) => safeDisplayName(basename(p))).join(', ')
      );
    }
    if (inPlace.length) {
      if (clipboard.action === 'copy' && onDuplicate) {
        // Copy into the same folder = duplicate ("name_copy"), never a copy onto itself
        inPlace.forEach((p) => onDuplicate(p));
      } else {
        notify.info(isPt ? 'Os itens já estão nesta pasta' : 'Already in this folder');
      }
    }
    if (!rest.length) return;

    const existing = new Set(files.map((f) => f.name));
    const collisions = rest.filter((p) => existing.has(basename(p)));
    const proceed = (list: string[]) => {
      if (!list.length) return;
      if (list.length === paths.length) {
        onPaste(); // unchanged set: App's paste also clears a "cut" clipboard
      } else if (onDropItems) {
        onDropItems(clipboard.sourceSession, list, sessionId, currentPath, clipboard.action === 'copy');
      }
    };
    if (collisions.length) {
      const remaining = rest.filter((p) => !collisions.includes(p));
      setConflict({
        destDir: currentPath,
        names: collisions.map((p) => basename(p)),
        unknown: false,
        onReplace: () => proceed(rest),
        onSkip: remaining.length ? () => proceed(remaining) : undefined,
      });
    } else {
      proceed(rest);
    }
  };

  const notifyNowhereToTransfer = () =>
    notify.info(
      isPt ? 'Nada para onde transferir' : 'Nowhere to transfer to',
      isPt ? 'Abra uma conexão no outro painel (modo Commander) para usar F5/F6.' : 'Open a connection in the other pane (Commander mode) to use F5/F6.'
    );

  /**
   * F5/F6: same rules as drops and paste. Items that already exist in the other pane's folder ask
   * Replace/Skip first; otherwise the usual "Copy N items?" confirmation (when a label is known).
   */
  const requestTransferToOtherPane = async (mode: 'copy' | 'move') => {
    const fn = mode === 'copy' ? onTransferToOtherPane : onMoveToOtherPane;
    const sel = visibleSelected;
    if (!fn || sel.length === 0) return;
    if (canTransferToOtherPane === false) {
      notifyNowhereToTransfer();
      return;
    }

    const other = paneId ? paneDropTargets.byPaneId(paneId === 'left' ? 'right' : 'left')?.listing() : undefined;
    if (other && other.sessionId && other.path) {
      let candidates = sel;
      if (other.sessionId === sessionId) {
        candidates = sel.filter((p) => !isSelfTarget(p, other.path));
        if (!candidates.length) {
          notify.info(isPt ? 'Os itens já estão nesta pasta' : 'Already in this folder');
          return;
        }
      }
      const names = other.names ?? (await listNames(other.sessionId, other.path));
      const destLabel = otherPaneLabel || other.path;
      if (names === null) {
        setConflict({ destDir: destLabel, names: [], unknown: true, onReplace: () => fn() });
        return;
      }
      const collisions = candidates.filter((p) => names.has(basename(p)));
      if (collisions.length) {
        const rest = candidates.filter((p) => !collisions.includes(p));
        setConflict({
          destDir: destLabel,
          names: collisions.map((p) => basename(p)),
          unknown: false,
          onReplace: () => fn(),
          onSkip:
            rest.length && onDropItems
              ? () => onDropItems(sessionId, rest, other.sessionId, other.path, mode === 'copy')
              : undefined,
        });
        return;
      }
    }

    if (otherPaneLabel) setTransferConfirm({ mode, count: sel.length });
    else fn();
  };

  /* ------------------------------- Drag and drop -------------------------------- */
  //
  // What can be dropped on this pane, and how it arrives:
  //  - File rows (from this pane or the other one): pointer events, see "Row drag" below. HTML5
  //    drag and drop cannot work in the desktop app: Tauri's native drag-drop handler
  //    (dragDropEnabled, required for the absolute paths of Finder/Explorer drops) consumes every
  //    dragover/drop inside the webview, so the page never sees them.
  //  - Files from Finder/Explorer: Tauri's onDragDropEvent with absolute paths (further below).
  //  - Session tabs: pointer drags owned by SessionTabs/tabDragManager (DualPane picks the pane).
  // The HTML5 container handlers only matter in the browser preview.

  const rowFromEvent = (e: React.SyntheticEvent): { index: number; item: RowItem; el: HTMLElement } | null => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-row-index]') as HTMLElement | null;
    if (!el || !(e.currentTarget as HTMLElement).contains(el)) return null;
    const index = Number(el.dataset.rowIndex);
    const item = rowsRef.current[index];
    return item ? { index, item, el } : null;
  };

  /** Folder for an element inside this pane's list: a folder row/card, else the current folder. Reads refs only. */
  const hitTestList = (el: Element): PaneDropHit | null => {
    const listEl = scrollRef.current;
    if (!listEl || !sessionIdRef.current || !listEl.contains(el)) return null;
    const rowEl = el.closest('[data-row-index]') as HTMLElement | null;
    if (rowEl && listEl.contains(rowEl)) {
      const item = rowsRef.current[Number(rowEl.dataset.rowIndex)];
      const folder = item ? folderTargetOf(item) : null;
      if (item && folder) return { destDir: folder, key: item.key };
    }
    return { destDir: currentPathRef.current, key: null };
  };

  const clearDragUi = () => {
    setDragOverKey(null);
    setIsDragOverContainer(false);
  };

  // Every mounted pane is a drop target for row drags and tells F5/F6 in the other pane what it shows.
  // The registered functions read refs only, so registering once per pane is enough.
  useEffect(
    () =>
      paneDropTargets.register(idBase, {
        paneId,
        sessionId: () => sessionIdRef.current,
        listEl: () => scrollRef.current,
        hitTest: hitTestList,
        setHover: (hit) => {
          setDragOverKey(hit?.key ?? null);
          setIsDragOverContainer(!!hit && !hit.key);
        },
        drop: (sourceSessionId, paths, destDir, isCopy) => void queueTransferRef.current(sourceSessionId, paths, destDir, isCopy),
        listing: () => ({
          sessionId: sessionIdRef.current,
          path: currentPathRef.current,
          names: loadingRef.current ? null : new Set(filesRef.current.map((f) => f.name)),
        }),
      }),
    [idBase, paneId]
  );

  /* ---------------------------------- Row drag ---------------------------------- */
  // Press on a file row and move a few pixels: the selection (or that row) follows the pointer.
  // Drop on a folder row, the '..' row or empty space of either pane. Copy between sessions,
  // move within one session; Option/Alt flips it. Escape cancels.

  /** Pane, folder and effect under a viewport point. */
  const resolveDropAt = (x: number, y: number, altKey: boolean, sourceSessionId: string, paths: string[]) => {
    const el = document.elementFromPoint(x, y);
    const found = el ? paneDropTargets.fromElement(el) : null;
    const hit = found && el ? found.target.hitTest(el) : null;
    const targetSid = found?.target.sessionId();
    if (!found || !hit || !targetSid) return null;
    const same = targetSid === sourceSessionId;
    const effect: 'copy' | 'move' | 'none' =
      same && paths.every((p) => isSelfTarget(p, hit.destDir)) ? 'none' : (same ? altKey : !altKey) ? 'copy' : 'move';
    return { id: found.id, target: found.target, hit, effect };
  };

  /** One auto-scroll step of the list under the pointer when it is near the list's top/bottom edge. */
  const autoScrollStep = (st: RowDragState): boolean => {
    const list = paneDropTargets.fromElement(document.elementFromPoint(st.x, st.y))?.target.listEl();
    if (!list) return false;
    const r = list.getBoundingClientRect();
    const fromTop = st.y - r.top;
    const fromBottom = r.bottom - st.y;
    let dy = 0;
    if (fromTop < DRAG_SCROLL_EDGE) dy = -Math.ceil((DRAG_SCROLL_EDGE - fromTop) / 3);
    else if (fromBottom < DRAG_SCROLL_EDGE) dy = Math.ceil((DRAG_SCROLL_EDGE - fromBottom) / 3);
    if (!dy) return false;
    const before = list.scrollTop;
    list.scrollTop = before + dy;
    return list.scrollTop !== before;
  };

  const updateRowDrag = () => {
    const st = rowDragRef.current;
    if (!st || !st.active) return;
    const res = resolveDropAt(st.x, st.y, st.altKey, st.sourceSessionId, st.paths);
    const nextId = res && res.effect !== 'none' ? res.id : null;
    if (st.hoverId && st.hoverId !== nextId) paneDropTargets.get(st.hoverId)?.setHover(null);
    if (res && nextId) res.target.setHover(res.hit);
    st.hoverId = nextId;

    const effect = res?.effect ?? 'none';
    setFileDragCursor(effect);
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${st.x + 14}px, ${st.y + 14}px)`;
    setRowDragGhost((g) => (g && g.effect !== effect ? { ...g, effect } : g));

    if (st.scrollRaf === null) {
      st.scrollRaf = requestAnimationFrame(() => {
        st.scrollRaf = null;
        if (rowDragRef.current === st && st.active && autoScrollStep(st)) rowDragImplRef.current.update();
      });
    }
  };

  const endRowDrag = () => {
    const st = rowDragRef.current;
    rowDragRef.current = null;
    window.removeEventListener('pointermove', rowDragListeners.move, true);
    window.removeEventListener('pointerup', rowDragListeners.up, true);
    window.removeEventListener('pointercancel', rowDragListeners.cancel, true);
    window.removeEventListener('keydown', rowDragListeners.key, true);
    window.removeEventListener('keyup', rowDragListeners.key, true);
    window.removeEventListener('blur', rowDragListeners.cancel);
    if (!st || !st.active) return;
    if (st.scrollRaf !== null) cancelAnimationFrame(st.scrollRaf);
    try {
      if (st.captureEl.hasPointerCapture(st.pointerId)) st.captureEl.releasePointerCapture(st.pointerId);
    } catch {
      /* element already gone */
    }
    if (st.hoverId) paneDropTargets.get(st.hoverId)?.setHover(null);
    fileDragState.set(null);
    setFileDragCursor(null);
    setRowDragGhost(null);
  };

  const beginRowDrag = (st: RowDragState) => {
    const paths = selectedSet.has(st.path) && visibleSelected.length ? visibleSelected : [st.path];
    st.active = true;
    st.paths = paths;
    fileDragState.set({ sourceSessionId: st.sourceSessionId, paths });
    try {
      st.captureEl.setPointerCapture(st.pointerId);
    } catch {
      /* capture is best-effort: the window listeners still see the pointer */
    }
    setContextMenu(null);
    const first = rowsRef.current.find((r) => r.kind === 'file' && r.file.path === paths[0]);
    setRowDragGhost({
      count: paths.length,
      name: first && first.kind === 'file' ? first.meta.display : safeDisplayName(basename(paths[0])),
      icon: first && first.kind === 'file' ? first.meta.icon : 'text',
      effect: 'none',
    });
  };

  const onRowDragMove = (e: PointerEvent) => {
    const st = rowDragRef.current;
    if (!st || e.pointerId !== st.pointerId) return;
    if (e.buttons === 0) {
      // Released outside the window without a pointerup: abort instead of a phantom drag
      endRowDrag();
      return;
    }
    st.x = e.clientX;
    st.y = e.clientY;
    st.altKey = e.altKey;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) <= DRAG_THRESHOLD) return;
      beginRowDrag(st);
    }
    updateRowDrag();
  };

  const onRowDragUp = (e: PointerEvent) => {
    const st = rowDragRef.current;
    if (!st || e.pointerId !== st.pointerId) return;
    if (!st.active) {
      endRowDrag(); // a plain click: the click handlers select/open as usual
      return;
    }
    const res = resolveDropAt(e.clientX, e.clientY, e.altKey, st.sourceSessionId, st.paths);
    const { sourceSessionId, paths } = st;
    endRowDrag();
    // The click that follows this pointerup must not select or clear anything
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (res && res.effect !== 'none') res.target.drop(sourceSessionId, paths, res.hit.destDir, res.effect === 'copy');
  };

  const onRowDragKey = (e: KeyboardEvent) => {
    const st = rowDragRef.current;
    if (!st) return;
    if (e.key === 'Escape' && e.type === 'keydown') {
      if (st.active) {
        e.preventDefault();
        e.stopPropagation();
      }
      endRowDrag();
      return;
    }
    if (e.key === 'Alt' && st.active) {
      st.altKey = e.altKey;
      updateRowDrag();
    }
  };

  rowDragImplRef.current = { move: onRowDragMove, up: onRowDragUp, cancel: endRowDrag, key: onRowDragKey, update: updateRowDrag };

  // A pane that unmounts mid-drag (session closed, mode switch) cleans up after itself
  useEffect(() => () => rowDragImplRef.current.cancel(), []);

  // The ghost's position is set outside React so pointer moves do not re-render the panel
  useLayoutEffect(() => {
    const st = rowDragRef.current;
    if (rowDragGhost && st && ghostRef.current) ghostRef.current.style.transform = `translate(${st.x + 14}px, ${st.y + 14}px)`;
  }, [rowDragGhost]);

  const handleRowsPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.pointerType === 'touch' || !sessionId || !onDropItems) return;
    if (isMac && e.ctrlKey) return; // Control-click opens the context menu on macOS
    const hit = rowFromEvent(e);
    if (!hit || hit.item.kind !== 'file') return;
    endRowDrag();
    rowDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      path: hit.item.file.path,
      captureEl: e.currentTarget as HTMLElement,
      sourceSessionId: sessionId,
      active: false,
      paths: [],
      x: e.clientX,
      y: e.clientY,
      altKey: e.altKey,
      hoverId: null,
      scrollRaf: null,
    };
    window.addEventListener('pointermove', rowDragListeners.move, true);
    window.addEventListener('pointerup', rowDragListeners.up, true);
    window.addEventListener('pointercancel', rowDragListeners.cancel, true);
    window.addEventListener('keydown', rowDragListeners.key, true);
    window.addEventListener('keyup', rowDragListeners.key, true);
    window.addEventListener('blur', rowDragListeners.cancel);
  };

  /* --------------------- HTML5 drops (browser preview only) --------------------- */

  const handleContainerDragOver = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer?.types || []);
    const curDrag = tabDragManager.getDraggingTab();
    if (curDrag || types.includes('text/rustscp-tab-session-id')) {
      if (!onDropTab) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (paneId && curDrag && curDrag.sourcePane !== paneId) tabDragManager.setHoverTarget(paneId);
      if (!isDragOverContainer) setIsDragOverContainer(true);
      return;
    }
    if (!sessionId || !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (dragOverKey) setDragOverKey(null);
    if (!isDragOverContainer) setIsDragOverContainer(true);
  };

  const handleContainerDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      clearDragUi();
      if (paneId) tabDragManager.clearHoverTarget(paneId);
    }
  };

  const handleContainerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    clearDragUi();
    handleDropPayload(e);
  };

  const handleDropPayload = (e: React.DragEvent) => {
    // Session tab dropped from the opposite pane
    const draggingTab = tabDragManager.getDraggingTab();
    if (draggingTab && onDropTab) {
      const target = paneId || (draggingTab.sourcePane === 'left' ? 'right' : 'left');
      tabDragManager.executeDrop(draggingTab.sessionId, draggingTab.sourcePane, target);
      return;
    }

    const textPlain = e.dataTransfer.getData('text/plain');
    if (textPlain && textPlain.startsWith('rustscp-tab:') && onDropTab) {
      const parts = textPlain.split(':');
      const srcPane = parts[1] as 'left' | 'right';
      const sid = parts[2];
      if (sid && srcPane) {
        const target = paneId || (srcPane === 'left' ? 'right' : 'left');
        tabDragManager.executeDrop(sid, srcPane, target);
        return;
      }
    }

    const tabSessionId = e.dataTransfer.getData('text/rustscp-tab-session-id');
    const tabSourcePane = e.dataTransfer.getData('text/rustscp-tab-source-pane') as 'left' | 'right';
    if (tabSessionId && tabSourcePane && onDropTab) {
      const target = paneId || (tabSourcePane === 'left' ? 'right' : 'left');
      tabDragManager.executeDrop(tabSessionId, tabSourcePane, target);
      return;
    }

    // Files from Finder/Explorer arrive through the Tauri drag-drop event (absolute paths, see below).
    // WebKit File objects carry no path, so HTML5 file drops are only explained here.
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0 && !isTauri()) {
      notify.info(
        isPt ? 'Solte arquivos no aplicativo desktop' : 'Drop files in the desktop app',
        isPt ? 'Arrastar arquivos do computador funciona no RustSCP para desktop.' : 'Dragging files from your computer works in the RustSCP desktop app.'
      );
    }
  };

  // OS file drops (Finder/Explorer): Tauri delivers absolute paths and the pointer position.
  useEffect(() => {
    if (!isTauri() || !sessionId) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let active = false;

    /** Folder under the drop point, or null when the point is not on this pane's visible list. */
    const targetAt = (pos: { x: number; y: number }): PaneDropHit | null => {
      // wry reports AppKit points (macOS) and GTK logical pixels (Linux), which already are CSS
      // pixels; only Windows reports physical pixels.
      const scale = IS_WINDOWS ? window.devicePixelRatio || 1 : 1;
      const x = pos.x / scale;
      const y = pos.y / scale;
      const listEl = scrollRef.current;
      const rect = listEl?.getBoundingClientRect();
      if (!listEl || !rect || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
      // A dialog or menu covering the pane takes the drop away from it: never upload "through" an overlay.
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return null;
      const topEl = document.elementFromPoint(x, y);
      if (!topEl || !listEl.contains(topEl)) return null;
      return hitTestList(topEl);
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'leave') {
          active = false;
          clearDragUi();
          return;
        }
        if (p.type === 'enter') {
          active = !!p.paths?.length;
          if (!active) return;
        }
        if (!active) return;
        const hit = targetAt(p.position);
        if (p.type === 'drop') {
          active = false;
          clearDragUi();
          if (hit && p.paths?.length) void queueTransferRef.current('local', p.paths, hit.destDir, true);
          return;
        }
        setDragOverKey(hit?.key ?? null);
        setIsDragOverContainer(!!hit && !hit.key);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* drag-drop events unavailable (web preview) */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]); // targetAt reads refs only

  /* ------------------------------- Pointer handlers ------------------------------ */

  const focusPanel = () => {
    onFocusPanel?.();
    panelRef.current?.focus({ preventScroll: true });
  };

  const selectRange = (fromIdx: number, toIdx: number) => {
    const [a, b] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    const paths: string[] = [];
    for (let i = a; i <= b; i++) {
      const r = rowsRef.current[i];
      if (r && r.kind === 'file') paths.push(r.file.path);
    }
    applySelection(paths);
  };

  const handleRowsClick = (e: React.MouseEvent) => {
    if (suppressClickRef.current) return; // end of a row drag, not a click
    const hit = rowFromEvent(e);
    if (!hit) return;
    e.stopPropagation();
    setContextMenu(null);
    focusPanel();
    const { item, index } = hit;
    setCursorKey(item.key);
    if (item.kind === 'parent') {
      if (viewMode === 'grid') handlePointerGoUp();
      return;
    }
    if (e.shiftKey) {
      const anchorIdx = anchorKeyRef.current ? rowsRef.current.findIndex((r) => r.key === anchorKeyRef.current) : -1;
      selectRange(anchorIdx >= 0 ? anchorIdx : index, index);
      return;
    }
    anchorKeyRef.current = item.key;
    onSelectFile(item.file.path, e.metaKey || e.ctrlKey);
  };

  const handleRowsDoubleClick = (e: React.MouseEvent) => {
    const hit = rowFromEvent(e);
    if (!hit) return;
    e.stopPropagation();
    if (hit.item.kind === 'parent') {
      if (viewMode === 'list') handlePointerGoUp();
      return;
    }
    void openEntry(hit.item.file);
  };

  const handleRowsContextMenu = (e: React.MouseEvent) => {
    const hit = rowFromEvent(e);
    if (!hit || hit.item.kind !== 'file') return; // background menu
    e.preventDefault();
    e.stopPropagation();
    const file = hit.item.file;
    let targets = visibleSelected;
    if (!selectedSet.has(file.path)) {
      onSelectFile(file.path, false);
      targets = [file.path];
    }
    setCursorKey(hit.item.key);
    anchorKeyRef.current = hit.item.key;
    focusPanel();
    setContextMenu({ x: e.clientX, y: e.clientY, file, targetPaths: targets, isBackground: false });
  };

  const handleContainerContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!sessionId) return;
    focusPanel();
    setContextMenu({ x: e.clientX, y: e.clientY, file: null, targetPaths: [], isBackground: true });
  };

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  /* ---------------------------------- Keyboard ---------------------------------- */

  const moveCursorTo = (idx: number, extend: boolean) => {
    const list = rowsRef.current;
    if (!list.length) return;
    const i = Math.max(0, Math.min(list.length - 1, idx));
    const row = list[i];
    setCursorKey(row.key);
    scrollIndexIntoView(i);
    if (extend) {
      let anchorIdx = anchorKeyRef.current ? list.findIndex((r) => r.key === anchorKeyRef.current) : -1;
      if (anchorIdx < 0) {
        anchorIdx = cursorIndex >= 0 ? cursorIndex : i;
        anchorKeyRef.current = list[anchorIdx].key;
      }
      selectRange(anchorIdx, i);
    } else {
      anchorKeyRef.current = row.key;
      if (row.kind === 'file') onSelectFile(row.file.path, false);
      else if (selectedRef.current.length) applySelection([]);
    }
  };

  const startIndex = () => {
    if (cursorIndex >= 0) return cursorIndex;
    if (visibleSelected.length) {
      const idx = rowsRef.current.findIndex((r) => r.kind === 'file' && r.file.path === visibleSelected[0]);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const firstFileIndex = () => {
    const idx = rowsRef.current.findIndex((r) => r.kind === 'file');
    return idx >= 0 ? idx : 0;
  };

  const openFilterBar = () => {
    if (!showFilterBar) {
      setShowFilterBar(true); // the input autofocuses when it mounts
      return;
    }
    filterInputRef.current?.focus();
    filterInputRef.current?.select();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    // Ignore keys typed in dialogs rendered through portals, menus and text fields
    if (target && !e.currentTarget.contains(target)) return;
    const tagName = target?.tagName?.toLowerCase();
    if (isEditingPath || tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable) return;
    if (target?.closest('[role="menu"]')) return;
    if (!sessionId) return;

    const key = e.key;
    const modKey = e.metaKey || e.ctrlKey;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const onControl = !!target && target !== e.currentTarget && !!target.closest('button, a');
    const sel = visibleSelected;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // --- Delete (permanent first) ---
    const isPermanentDelete =
      (modKey && (e.altKey || e.shiftKey) && (key === 'Backspace' || key === 'Delete')) ||
      (!modKey && e.shiftKey && (key === 'Delete' || key === 'F8'));
    const isNormalDelete =
      (!modKey && !e.shiftKey && !e.altKey && (key === 'Delete' || key === 'F8')) ||
      (modKey && !e.altKey && !e.shiftKey && (key === 'Backspace' || key === 'Delete'));
    if (isPermanentDelete) {
      if (sel.length) {
        handled();
        onDelete(sel, true);
      }
      return;
    }
    if (isNormalDelete) {
      if (sel.length) {
        handled();
        onDelete(sel, !remoteTrashEnabled);
      }
      return;
    }

    // --- Go up: Cmd/Ctrl+Up, Alt+Up, plain Backspace ---
    if (((modKey || e.altKey) && key === 'ArrowUp') || (key === 'Backspace' && !modKey && !e.altKey && !e.shiftKey)) {
      handled();
      handleGoUp();
      return;
    }

    // --- Open: Enter or Cmd/Ctrl+Down ---
    if ((key === 'Enter' && !modKey && !e.altKey && !onControl) || (modKey && key === 'ArrowDown')) {
      const idx = startIndex();
      const row = idx >= 0 ? rowsRef.current[idx] : null;
      if (row) {
        handled();
        openRow(row);
      }
      return;
    }

    // --- Command shortcuts ---
    if (modKey && !e.altKey) {
      if (e.shiftKey && (e.code === 'Period' || key === '.' || key === '>')) {
        handled();
        setShowHidden((v) => !v);
        return;
      }
      if (!e.shiftKey) {
        switch (lower) {
          case 'c':
            if (sel.length && onCopy) {
              handled();
              onCopy(sel);
            }
            return;
          case 'x':
            if (sel.length && onCut) {
              handled();
              onCut(sel);
            }
            return;
          case 'v':
            if (clipboard && clipboard.paths.length > 0 && onPaste) {
              handled();
              handlePasteHere();
            }
            return;
          case 'a':
            handled();
            applySelection(displayedFiles.map((f) => f.path));
            return;
          case 'f':
            handled();
            openFilterBar();
            return;
          case 'd':
            handled();
            handleAddCurrentToBookmarks();
            return;
          case 'l':
            handled();
            setIsEditingPath(true);
            return;
          case 'r':
            handled();
            onRefresh();
            return;
          case 'h':
            if (onGoHome) {
              handled();
              onGoHome();
            }
            return;
          default:
            break;
        }
      }
    }

    // --- Function keys (Commander conventions) ---
    if (key === 'F5' && e.shiftKey) {
      if (sel.length && onDuplicate) {
        handled();
        onDuplicate(sel[0]);
      }
      return;
    }
    if (key === 'F5' || key === 'F6') {
      // F5 = copy / F6 = move to the other pane, only when there is a selection and another pane.
      // Otherwise the key is left alone, so App's bubble handler refreshes on F5 (F6 has no other use).
      const mode = key === 'F5' ? 'copy' : 'move';
      const fn = mode === 'copy' ? onTransferToOtherPane : onMoveToOtherPane;
      if (sel.length === 0) return;
      if (!fn) {
        if (key === 'F6' && !onTransferToOtherPane) {
          // Explorer mode: say why F6 does nothing instead of ignoring it
          handled();
          notifyNowhereToTransfer();
        }
        return;
      }
      handled();
      void requestTransferToOtherPane(mode);
      return;
    }
    if (key === 'F4') {
      const idx = startIndex();
      const row = sel.length ? rowsRef.current.find((r) => r.kind === 'file' && r.file.path === sel[0]) : idx >= 0 ? rowsRef.current[idx] : undefined;
      if (row && row.kind === 'file' && row.file.file_type !== 'directory') {
        handled();
        editWithGuards(row.file);
      }
      return;
    }
    // Shift+F7 is Find files and Shift+F2 is Compare directories (App, capture phase): leave both alone.
    if (key === 'F7' && !e.shiftKey) {
      handled();
      onNewFolder();
      return;
    }
    if (key === 'F2' && !e.shiftKey && !modKey && !e.altKey) {
      if (!onRename) return;
      // One item only: the single selection, or the cursor row when nothing is selected. Never '..'.
      let row: RowItem | undefined;
      if (sel.length === 1) row = rowsRef.current.find((r) => r.kind === 'file' && r.file.path === sel[0]);
      else if (sel.length === 0) {
        const idx = startIndex();
        row = idx >= 0 ? rowsRef.current[idx] : undefined;
      }
      if (row && row.kind === 'file') {
        handled();
        onRename(row.file);
      }
      return;
    }

    // --- Cursor movement ---
    const isGrid = viewMode === 'grid';
    const step = isGrid ? gridColsRef.current : 1;
    const pageRows = Math.max(1, Math.floor(((scrollRef.current?.clientHeight || 400) - (isGrid ? 0 : HEADER_H)) / (isGrid ? CARD_H + CARD_GAP : ROW_H)));
    const cur = startIndex();
    if (!modKey && !e.altKey) {
      switch (key) {
        case 'ArrowDown':
          handled();
          moveCursorTo(cur < 0 ? firstFileIndex() : cur + step, e.shiftKey);
          return;
        case 'ArrowUp':
          handled();
          moveCursorTo(cur < 0 ? firstFileIndex() : cur - step, e.shiftKey);
          return;
        case 'ArrowRight':
          if (isGrid) {
            handled();
            moveCursorTo(cur < 0 ? firstFileIndex() : cur + 1, e.shiftKey);
          }
          return;
        case 'ArrowLeft':
          if (isGrid) {
            handled();
            moveCursorTo(cur < 0 ? firstFileIndex() : cur - 1, e.shiftKey);
          }
          return;
        case 'Home':
          handled();
          moveCursorTo(0, e.shiftKey);
          return;
        case 'End':
          handled();
          moveCursorTo(rowsRef.current.length - 1, e.shiftKey);
          return;
        case 'PageDown':
          handled();
          moveCursorTo((cur < 0 ? 0 : cur) + pageRows * step, e.shiftKey);
          return;
        case 'PageUp':
          handled();
          moveCursorTo((cur < 0 ? 0 : cur) - pageRows * step, e.shiftKey);
          return;
        case ' ':
          if (onControl) return;
          if (cur >= 0) {
            const row = rowsRef.current[cur];
            if (row.kind === 'file') {
              handled();
              onSelectFile(row.file.path, true);
            }
          }
          return;
        case 'Escape':
          if (filterQuery) {
            handled();
            setFilterQuery('');
            setShowFilterBar(false);
          } else if (selectedRef.current.length) {
            handled();
            applySelection([]);
          }
          return;
        default:
          break;
      }
    }

    // --- Type to select ---
    if (key.length === 1 && key !== ' ' && !modKey && !e.altKey) {
      const now = Date.now();
      const st = typeAheadRef.current;
      st.buffer = now - st.time > 800 ? key.toLowerCase() : st.buffer + key.toLowerCase();
      st.time = now;
      const list = rowsRef.current;
      const begin = st.buffer.length === 1 ? cur + 1 : Math.max(0, cur);
      for (let n = 0; n < list.length; n++) {
        const r = list[(begin + n) % list.length];
        if (r.kind === 'file' && r.meta.nameLower.startsWith(st.buffer)) {
          handled();
          moveCursorTo((begin + n) % list.length, false);
          return;
        }
      }
    }
  };

  /* ---------------------------------- Rendering --------------------------------- */

  const cursorRowId = cursorIndex >= 0 ? `${idBase}-r${cursorIndex}` : undefined;
  const showCursor = hasFocus || isFocused;
  const transferFn = transferConfirm?.mode === 'move' ? onMoveToOtherPane : onTransferToOtherPane;
  const deleteCount = visibleSelected.length > 1 ? ` (${visibleSelected.length})` : '';
  const deleteLabel = trashAvailable
    ? `${isPt ? 'Mover para a lixeira' : 'Move to trash'}${deleteCount}`
    : `${isPt ? 'Excluir' : 'Delete'}${deleteCount}…`;
  const deleteShortcut = isMac ? '⌘⌫' : 'Del';

  const renderListSkeleton = () => (
    <div aria-hidden>
      {Array.from({ length: 12 }).map((_, idx) => (
        <div key={idx} className="grid items-center h-[26px] px-2" style={{ gridTemplateColumns: gridTemplate }}>
          {visibleColumns.map((col) =>
            col.key === 'name' ? (
              <div key="name" className="flex items-center gap-2 pr-2">
                <div className="w-4 h-4 rounded animate-shimmer shrink-0" />
                <div className="h-2.5 rounded animate-shimmer" style={{ width: `${40 + ((idx * 19) % 45)}%` }} />
              </div>
            ) : (
              <div key={col.key} className={cx('pr-3', col.align === 'right' && 'flex justify-end')}>
                <div className="h-2.5 w-12 rounded animate-shimmer" />
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );

  const renderList = () => (
    <div role="grid" aria-rowcount={rows.length + 1} aria-multiselectable aria-label={title} style={{ minWidth: listMinWidth }} className="relative">
      {/* Column headers */}
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-10 grid items-center px-2 bg-surface-raised border-b border-line text-[12px] text-ink-faint select-none"
        style={{ gridTemplateColumns: gridTemplate, height: HEADER_H }}
      >
        {visibleColumns.map((col) => {
          const active = sortColumn === col.key;
          return (
            <div
              key={col.key}
              role="columnheader"
              aria-sort={active ? (sortAsc ? 'ascending' : 'descending') : 'none'}
              className={cx('min-w-0', col.align === 'right' ? 'pr-3 text-right' : 'pr-2')}
            >
              <button
                type="button"
                onClick={() => handleSort(col.key)}
                className={cx(
                  'inline-flex items-center gap-1 max-w-full h-6 -mx-1 px-1 rounded-md hover:text-ink hover:bg-dark-650/50 transition-colors',
                  col.align === 'right' && 'flex-row-reverse',
                  active && 'text-ink-muted font-medium'
                )}
              >
                <span className="truncate">{isPt ? col.labelPt : col.label}</span>
                {active &&
                  (sortAsc ? <ChevronUp className="w-3 h-3 shrink-0" aria-hidden /> : <ChevronDown className="w-3 h-3 shrink-0" aria-hidden />)}
              </button>
            </div>
          );
        })}
      </div>

      {loading ? (
        renderListSkeleton()
      ) : displayedFiles.length === 0 ? (
        <>
          {rows.length > 0 && renderListRows()}
          <div className="py-10 text-center text-[12.5px] text-ink-faint">
            {deferredQuery.trim()
              ? isPt ? 'Nenhum item corresponde ao filtro' : 'No items match the filter'
              : t('dualPane.emptyDirectory')}
          </div>
        </>
      ) : (
        renderListRows()
      )}
    </div>
  );

  function renderListRows() {
    const { first, last } = listRange;
    const slice = rows.slice(first, last);
    return (
      <div
        role="rowgroup"
        style={{ height: rows.length * ROW_H, position: 'relative' }}
        onClick={handleRowsClick}
        onDoubleClick={handleRowsDoubleClick}
        onContextMenu={handleRowsContextMenu}
        onPointerDown={handleRowsPointerDown}
      >
        <div style={{ position: 'absolute', top: first * ROW_H, left: 0, right: 0 }}>
          {slice.map((item, i) => {
            const index = first + i;
            const isFileRow = item.kind === 'file';
            return (
              <FileRow
                key={item.key}
                item={item}
                index={index}
                rowId={`${idBase}-r${index}`}
                selected={isFileRow && selectedSet.has(item.key)}
                cursor={showCursor && cursorKey === item.key}
                cut={isFileRow && !!cutSet?.has(item.key)}
                dropTarget={dragOverKey === item.key}
                diff={isFileRow ? diffMap?.[item.file.name] : undefined}
                columns={visibleColumns}
                template={gridTemplate}
                locale={locale}
                isPt={isPt}
              />
            );
          })}
        </div>
      </div>
    );
  }

  const renderGrid = () => {
    if (loading) {
      return (
        <div
          className="grid"
          style={{ padding: GRID_PAD, gap: CARD_GAP, gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
          aria-hidden
        >
          {Array.from({ length: Math.min(24, gridCols * 3) }).map((_, idx) => (
            <div key={idx} className="flex flex-col items-center justify-center gap-2 rounded-xl" style={{ height: CARD_H }}>
              <div className="w-8 h-8 rounded-lg animate-shimmer" />
              <div className="h-2.5 w-3/4 rounded animate-shimmer" />
              <div className="h-2 w-1/2 rounded animate-shimmer" />
            </div>
          ))}
        </div>
      );
    }
    const { firstRow, lastRow, rowCount } = gridRange;
    const stride = CARD_H + CARD_GAP;
    const slice = rows.slice(firstRow * gridCols, lastRow * gridCols);
    const height = rowCount > 0 ? GRID_PAD * 2 + rowCount * stride - CARD_GAP : 0;
    return (
      <>
        <div
          role="listbox"
          aria-multiselectable
          aria-label={title}
          style={{ height, position: 'relative' }}
          onClick={handleRowsClick}
          onDoubleClick={handleRowsDoubleClick}
          onContextMenu={handleRowsContextMenu}
          onPointerDown={handleRowsPointerDown}
        >
          <div
            className="grid"
            style={{
              position: 'absolute',
              top: GRID_PAD + firstRow * stride,
              left: GRID_PAD,
              right: GRID_PAD,
              gap: CARD_GAP,
              gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
            }}
          >
            {slice.map((item, i) => {
              const index = firstRow * gridCols + i;
              const isFileRow = item.kind === 'file';
              return (
                <FileCard
                  key={item.key}
                  item={item}
                  index={index}
                  rowId={`${idBase}-r${index}`}
                  selected={isFileRow && selectedSet.has(item.key)}
                  cursor={showCursor && cursorKey === item.key}
                  cut={isFileRow && !!cutSet?.has(item.key)}
                  dropTarget={dragOverKey === item.key}
                  diff={isFileRow ? diffMap?.[item.file.name] : undefined}
                  isPt={isPt}
                />
              );
            })}
          </div>
        </div>
        {displayedFiles.length === 0 && (
          <div className="py-10 text-center text-[12.5px] text-ink-faint">
            {deferredQuery.trim()
              ? isPt ? 'Nenhum item corresponde ao filtro' : 'No items match the filter'
              : t('dualPane.emptyDirectory')}
          </div>
        )}
      </>
    );
  };

  const PaneIcon = isRemote ? Server : HardDrive;

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      role="region"
      aria-label={title}
      aria-activedescendant={showCursor ? cursorRowId : undefined}
      onKeyDown={handleKeyDown}
      onFocus={() => {
        setHasFocus(true);
        onFocusPanel?.();
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setHasFocus(false);
      }}
      onClick={() => {
        onFocusPanel?.();
        setContextMenu(null);
      }}
      className={cx(
        'flex-1 min-w-0 min-h-0 flex flex-col bg-surface-raised border rounded-xl m-1 relative focus:outline-none focus-visible:outline-none transition-colors',
        // Focused pane: a quiet accent hairline instead of a ring
        isFocused ? 'border-rust-500/35' : 'border-line'
      )}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 h-10 pl-3 pr-1.5 border-b border-line select-none">
        <PaneIcon className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
        <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={title}>
          {title}
        </span>

        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          {onGoHome && (
            <IconButton size="sm" label={isPt ? `Pasta inicial (${mod}H)` : `Home folder (${mod}H)`} onClick={onGoHome} disabled={!sessionId}>
              <House className="w-4 h-4" />
            </IconButton>
          )}
          <IconButton size="sm" label={isPt ? `Subir uma pasta (${mod}↑ / ⌫)` : `Go up one folder (${mod}↑ / ⌫)`} onClick={handleGoUp} disabled={!canGoUp}>
            <FolderUp className="w-4 h-4" />
          </IconButton>
          <IconButton size="sm" label={isPt ? `Atualizar (${mod}R)` : `Refresh (${mod}R)`} onClick={onRefresh} disabled={!sessionId}>
            <RotateCw className={cx('w-4 h-4', loading && 'animate-spin')} />
          </IconButton>
          <IconButton size="sm" label={isPt ? 'Nova pasta (F7)' : 'New folder (F7)'} onClick={onNewFolder} disabled={!sessionId}>
            <FolderPlus className="w-4 h-4" />
          </IconButton>
          <IconButton
            size="sm"
            label={isPt ? `Filtrar (${mod}F)` : `Filter (${mod}F)`}
            active={showFilterBar || !!filterQuery}
            disabled={!sessionId}
            onClick={() => {
              if (showFilterBar) {
                setShowFilterBar(false);
                setFilterQuery('');
              } else {
                openFilterBar();
              }
            }}
          >
            <Search className="w-4 h-4" />
          </IconButton>

          <div className="flex items-center p-0.5 mx-0.5 rounded-lg bg-dark-650/50" role="group" aria-label={isPt ? 'Modo de exibição' : 'View mode'}>
            <button
              type="button"
              onClick={() => changeViewMode('list')}
              title={isPt ? 'Lista' : 'List'}
              aria-label={isPt ? 'Lista' : 'List'}
              aria-pressed={viewMode === 'list'}
              className={cx(
                'w-6 h-6 inline-flex items-center justify-center rounded-md transition-colors',
                viewMode === 'list' ? 'bg-surface-raised text-ink shadow-xs' : 'text-ink-faint hover:text-ink'
              )}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => changeViewMode('grid')}
              title={isPt ? 'Ícones' : 'Icons'}
              aria-label={isPt ? 'Ícones' : 'Icons'}
              aria-pressed={viewMode === 'grid'}
              className={cx(
                'w-6 h-6 inline-flex items-center justify-center rounded-md transition-colors',
                viewMode === 'grid' ? 'bg-surface-raised text-ink shadow-xs' : 'text-ink-faint hover:text-ink'
              )}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>

          <Menu
            align="right"
            width="w-64"
            trigger={({ open, toggle, ref }) => (
              <IconButton
                ref={ref}
                size="sm"
                label={isPt ? 'Mais opções' : 'More options'}
                className={open ? 'bg-dark-650/80 text-ink' : undefined}
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
              >
                <Ellipsis className="w-4 h-4" />
              </IconButton>
            )}
          >
            {(close) => (
              <div className="max-h-[min(60vh,460px)] overflow-y-auto">
                <MenuToggleItem
                  icon={<Eye className="w-4 h-4" />}
                  label={isPt ? 'Mostrar arquivos ocultos' : 'Show hidden files'}
                  checked={showHidden}
                  onToggle={() => setShowHidden((v) => !v)}
                />
                <MenuItem
                  icon={<Trash2 className="w-4 h-4" />}
                  label={deleteLabel}
                  shortcut={deleteShortcut}
                  disabled={!sessionId || visibleSelected.length === 0}
                  danger={!trashAvailable}
                  close={close}
                  onSelect={() => onDelete(visibleSelected, !remoteTrashEnabled)}
                />

                <MenuSeparator />
                <MenuLabel>{isPt ? 'Favoritos' : 'Bookmarks'}</MenuLabel>
                <MenuItem
                  icon={<BookmarkPlus className="w-4 h-4" />}
                  label={isPt ? 'Adicionar esta pasta' : 'Add this folder'}
                  shortcut={`${mod}D`}
                  disabled={!sessionId}
                  close={close}
                  onSelect={handleAddCurrentToBookmarks}
                />
                {allBookmarks.map((bm) => {
                  const removable = customBookmarks.includes(bm);
                  return (
                    <div key={bm} className="group flex items-center gap-0.5">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!sessionId}
                        onClick={() => {
                          close();
                          navigateTo(bm);
                        }}
                        className="ui-menu-item h-7 flex-1 min-w-0 disabled:opacity-40"
                        title={bm}
                      >
                        <Bookmark className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
                        <span className="flex-1 min-w-0 truncate font-mono text-[12px]">{bm}</span>
                      </button>
                      {removable && (
                        <button
                          type="button"
                          onClick={() => handleRemoveBookmark(bm)}
                          aria-label={isPt ? `Remover favorito ${bm}` : `Remove bookmark ${bm}`}
                          title={isPt ? 'Remover favorito' : 'Remove bookmark'}
                          className="ui-icon-btn ui-icon-btn-sm w-6 h-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {viewMode === 'list' && (
                  <>
                    <MenuSeparator />
                    <MenuLabel>{isPt ? 'Colunas' : 'Columns'}</MenuLabel>
                    {columns
                      .filter((c) => c.key !== 'name')
                      .map((col) => (
                        <MenuToggleItem key={col.key} label={isPt ? col.labelPt : col.label} checked={col.visible} onToggle={() => toggleColumn(col.key)} />
                      ))}
                    <MenuItem label={isPt ? 'Restaurar colunas' : 'Reset columns'} onSelect={resetColumns} />
                  </>
                )}

                {onOpenAiAssistant && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Sparkles className="w-4 h-4" />}
                      label={isPt ? 'Assistente de IA…' : 'AI assistant…'}
                      disabled={!sessionId}
                      close={close}
                      onSelect={onOpenAiAssistant}
                    />
                  </>
                )}
              </div>
            )}
          </Menu>
        </div>
      </div>

      {/* Breadcrumb / path bar */}
      <div className="flex items-center gap-1 h-8 pl-2 pr-1.5 border-b border-line">
        {isEditingPath ? (
          <>
            <input
              ref={pathInputRef}
              type="text"
              {...plainTextInputProps}
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitPathInput();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelPathInput();
                  panelRef.current?.focus({ preventScroll: true });
                }
              }}
              onBlur={cancelPathInput}
              aria-label={isPt ? 'Caminho da pasta' : 'Folder path'}
              className="ui-input h-6 flex-1 min-w-0 px-2 rounded-md font-mono text-[12px]"
            />
            <IconButton
              size="sm"
              label={isPt ? 'Ir para o caminho (Enter)' : 'Go to path (Enter)'}
              className="w-6 h-6"
              onMouseDown={(e) => e.preventDefault()}
              onClick={commitPathInput}
            >
              <Check className="w-3.5 h-3.5" />
            </IconButton>
          </>
        ) : (
          <>
            <div
              ref={crumbsRef}
              className="flex-1 min-w-0 flex items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onClick={(e) => {
                if (e.target === e.currentTarget && sessionId) setIsEditingPath(true);
              }}
              aria-label={isPt ? 'Caminho' : 'Path'}
            >
              {crumbs.map((c, idx) => {
                const isLast = idx === crumbs.length - 1;
                return (
                  <React.Fragment key={`${idx}-${c.path}`}>
                    {idx > 0 && <ChevronRight className="w-3 h-3 mx-0.5 shrink-0 text-ink-faint" aria-hidden />}
                    <button
                      type="button"
                      disabled={!sessionId}
                      onClick={() => navigateTo(c.path)}
                      title={isPt ? `Ir para ${c.path}` : `Go to ${c.path}`}
                      aria-current={isLast ? 'location' : undefined}
                      className={cx(
                        'shrink-0 h-6 px-1.5 rounded-md text-[12.5px] whitespace-nowrap transition-colors hover:bg-dark-650/60',
                        isLast ? 'text-ink font-medium' : 'text-ink-muted hover:text-ink',
                        c.label === '/' && 'font-mono'
                      )}
                    >
                      <bdi>{safeDisplayName(c.label)}</bdi>
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
            <IconButton
              size="sm"
              label={isPt ? `Editar caminho (${mod}L)` : `Edit path (${mod}L)`}
              className="w-6 h-6 text-ink-faint"
              disabled={!sessionId}
              onClick={() => setIsEditingPath(true)}
            >
              <Pencil className="w-3 h-3" />
            </IconButton>
          </>
        )}
      </div>

      {/* Quick filter */}
      {showFilterBar && (
        <div className="flex items-center gap-2 h-8 pl-3 pr-1.5 border-b border-line">
          <Search className="w-3.5 h-3.5 shrink-0 text-ink-faint" aria-hidden />
          <input
            ref={filterInputRef}
            type="text"
            {...plainTextInputProps}
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setFilterQuery('');
                setShowFilterBar(false);
                panelRef.current?.focus({ preventScroll: true });
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault();
                panelRef.current?.focus({ preventScroll: true });
                const idx = rowsRef.current.findIndex((r) => r.kind === 'file');
                if (idx >= 0) moveCursorTo(idx, false);
              }
            }}
            placeholder={isPt ? 'Filtrar por nome, extensão ou dono' : 'Filter by name, extension or owner'}
            aria-label={isPt ? 'Filtrar arquivos' : 'Filter files'}
            className="flex-1 min-w-0 bg-transparent text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none"
            autoFocus
          />
          {filterQuery && (
            <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums">
              {displayedFiles.length} {isPt ? (displayedFiles.length === 1 ? 'item' : 'itens') : displayedFiles.length === 1 ? 'match' : 'matches'}
            </span>
          )}
          <IconButton
            size="sm"
            className="w-6 h-6"
            label={isPt ? 'Limpar filtro (Esc)' : 'Clear filter (Esc)'}
            onClick={() => {
              setFilterQuery('');
              setShowFilterBar(false);
              panelRef.current?.focus({ preventScroll: true });
            }}
          >
            <X className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      )}

      {/* File list */}
      <div
        ref={scrollRef}
        data-file-pane-id={idBase /* PANE_DROP_ATTR: row drags find this pane through it */}
        className={cx(
          'flex-1 min-h-0 overflow-auto transition-colors',
          isDragOverContainer && 'ring-2 ring-inset ring-rust-500/45 bg-rust-500/[0.04]'
        )}
        onScroll={handleScroll}
        onContextMenu={handleContainerContextMenu}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
        onClick={(e) => {
          // Click on empty space clears the selection (Finder behaviour)
          if (suppressClickRef.current) return; // end of a row drag
          if (e.target === e.currentTarget && selectedRef.current.length && !e.metaKey && !e.ctrlKey && !e.shiftKey) applySelection([]);
        }}
      >
        {!sessionId ? (
          <div className="h-full min-h-[260px] flex flex-col items-center justify-center p-8 text-center select-none">
            <div className="w-12 h-12 rounded-2xl bg-dark-650/50 flex items-center justify-center mb-3">
              <HardDrive className="w-6 h-6 text-ink-faint" aria-hidden />
            </div>
            <h3 className="text-[13px] font-medium text-ink mb-1">{t('dualPane.emptyPaneTitle', 'Nenhum ambiente conectado neste painel')}</h3>
            <p className="text-[12px] text-ink-muted max-w-xs mb-4">
              {t('dualPane.emptyPaneDesc', 'Arraste uma aba de conexão para cá ou clique no botão abaixo para abrir uma nova conexão.')}
            </p>
            {onNewSession && (
              <Button variant="primary" size="sm" className="ui-btn-primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={onNewSession}>
                {t('sessionTabs.connect', 'Conectar')}
              </Button>
            )}
          </div>
        ) : viewMode === 'grid' ? (
          renderGrid()
        ) : (
          renderList()
        )}
      </div>

      {/* Status bar */}
      {sessionId && (
        <div className="flex items-center gap-1.5 h-6 px-3 border-t border-line text-[11.5px] text-ink-faint tabular-nums select-none whitespace-nowrap overflow-hidden">
          <span>
            {displayedFiles.length} {isPt ? (displayedFiles.length === 1 ? 'item' : 'itens') : displayedFiles.length === 1 ? 'item' : 'items'}
          </span>
          {deferredQuery.trim() && (
            <span className="truncate">· {isPt ? `filtrado de ${baseFiles.length}` : `filtered from ${baseFiles.length}`}</span>
          )}
          {hiddenCount > 0 && <span className="truncate">· {isPt ? `${hiddenCount} ocultos` : `${hiddenCount} hidden`}</span>}
          {visibleSelected.length > 0 && (
            <span className="ml-auto truncate">
              {visibleSelected.length} {isPt ? (visibleSelected.length === 1 ? 'selecionado' : 'selecionados') : 'selected'}
              {selectedBytes > 0 && ` · ${formatSize(selectedBytes)}`}
            </span>
          )}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          targetPaths={contextMenu.targetPaths}
          isBackground={contextMenu.isBackground}
          isRemote={isRemote}
          remoteTrashEnabled={remoteTrashEnabled}
          currentPath={currentPath}
          selectedFiles={visibleSelected}
          clipboard={clipboard}
          actionsCatalog={actionsCatalog}
          onClose={closeContextMenu}
          onCut={onCut}
          onCopy={onCopy}
          onPaste={onPaste ? handlePasteHere : undefined}
          onDuplicate={onDuplicate}
          onRename={onRename}
          onGoHome={onGoHome}
          onOpenAiAssistant={onOpenAiAssistant}
          onRequestCompress={onRequestCompress}
          onCompress={onCompress}
          onRequestExtract={onRequestExtract}
          onExtract={onExtract}
          onExecuteSmartAction={onExecuteSmartAction}
          onOpenTerminalHere={onOpenTerminalHere}
          onOpenNativeTerminalHere={onOpenNativeTerminalHere}
          onEditFile={onEditFile ? editWithGuards : undefined}
          onCalculateSize={onCalculateSize}
          onOpenSymlink={onOpenSymlink}
          onShowProperties={onShowProperties}
          onCalculateChecksum={onCalculateChecksum}
          onOpenFindFiles={onOpenFindFiles}
          onOpenGenerateCode={onOpenGenerateCode}
          onMoveToTrash={onMoveToTrash}
          onDelete={onDelete}
          onNewFolder={onNewFolder}
          onRefresh={onRefresh}
        />
      )}

      {/* Dialogs (portaled so their keys never reach the file list) */}
      {conflict &&
        createPortal(
          <Modal
            isOpen
            size="sm"
            onClose={() => setConflict(null)}
            title={
              conflict.unknown
                ? isPt ? 'Não foi possível verificar o destino' : "Couldn't check the destination"
                : conflict.names.length === 1
                ? isPt ? `Substituir “${safeDisplayName(conflict.names[0])}”?` : `Replace “${safeDisplayName(conflict.names[0])}”?`
                : isPt ? `Substituir ${conflict.names.length} itens?` : `Replace ${conflict.names.length} items?`
            }
            footer={
              <>
                <Button variant="ghost" className="ui-btn-ghost" data-autofocus onClick={() => setConflict(null)}>
                  {isPt ? 'Cancelar' : 'Cancel'}
                </Button>
                {conflict.onSkip && (
                  <Button
                    variant="secondary"
                    className="ui-btn-secondary"
                    onClick={() => {
                      const fn = conflict.onSkip;
                      setConflict(null);
                      fn?.();
                    }}
                  >
                    {isPt ? 'Pular existentes' : 'Skip existing'}
                  </Button>
                )}
                <Button
                  variant="danger"
                  className="ui-btn-danger"
                  onClick={() => {
                    const fn = conflict.onReplace;
                    setConflict(null);
                    fn();
                  }}
                >
                  {conflict.unknown ? (isPt ? 'Continuar' : 'Continue') : isPt ? 'Substituir' : 'Replace'}
                </Button>
              </>
            }
          >
            <p className="text-[13px] text-ink-muted leading-relaxed">
              {conflict.unknown
                ? isPt
                  ? 'A pasta de destino não pôde ser listada. Itens com o mesmo nome serão substituídos.'
                  : 'The destination folder could not be listed. Items with the same name will be replaced.'
                : isPt
                ? 'Já existem itens com estes nomes em'
                : 'Items with these names already exist in'}{' '}
              <bdi className="font-mono text-[12px] text-ink break-all">{safeDisplayName(conflict.destDir)}</bdi>
            </p>
            {conflict.names.length > 0 && (
              <ul className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-surface-sunken px-3 py-2 space-y-0.5">
                {conflict.names.slice(0, 50).map((n) => (
                  <li key={n} className="text-[12px] font-mono text-ink truncate">
                    <bdi>{safeDisplayName(n)}</bdi>
                  </li>
                ))}
                {conflict.names.length > 50 && (
                  <li className="text-[12px] text-ink-faint">{isPt ? `…e mais ${conflict.names.length - 50}` : `…and ${conflict.names.length - 50} more`}</li>
                )}
              </ul>
            )}
          </Modal>,
          document.body
        )}

      {binaryConfirm &&
        createPortal(
          <Modal
            isOpen
            size="sm"
            onClose={() => setBinaryConfirm(null)}
            title={isPt ? 'Abrir no editor de texto?' : 'Open in the text editor?'}
            footer={
              <>
                <Button variant="ghost" className="ui-btn-ghost" data-autofocus onClick={() => setBinaryConfirm(null)}>
                  {isPt ? 'Cancelar' : 'Cancel'}
                </Button>
                <Button
                  variant="secondary"
                  className="ui-btn-secondary"
                  onClick={() => {
                    const f = binaryConfirm;
                    setBinaryConfirm(null);
                    onEditFile?.(f);
                  }}
                >
                  {isPt ? 'Abrir mesmo assim' : 'Open anyway'}
                </Button>
              </>
            }
          >
            <p className="text-[13px] text-ink-muted leading-relaxed">
              <bdi className="font-mono text-[12px] text-ink break-all">{safeDisplayName(binaryConfirm.name)}</bdi>{' '}
              {isPt
                ? 'parece ser um arquivo binário. O editor só abre arquivos de texto.'
                : 'looks like a binary file. The editor only opens text files.'}
            </p>
          </Modal>,
          document.body
        )}

      {transferConfirm &&
        createPortal(
          <Modal
            isOpen
            size="sm"
            onClose={() => setTransferConfirm(null)}
            title={
              transferConfirm.mode === 'copy'
                ? isPt ? `Copiar ${transferConfirm.count} ${transferConfirm.count === 1 ? 'item' : 'itens'}?` : `Copy ${transferConfirm.count} ${transferConfirm.count === 1 ? 'item' : 'items'}?`
                : isPt ? `Transferir ${transferConfirm.count} ${transferConfirm.count === 1 ? 'item' : 'itens'}?` : `Transfer ${transferConfirm.count} ${transferConfirm.count === 1 ? 'item' : 'items'}?`
            }
            footer={
              <>
                <Button variant="ghost" className="ui-btn-ghost" onClick={() => setTransferConfirm(null)}>
                  {isPt ? 'Cancelar' : 'Cancel'}
                </Button>
                <Button
                  variant="primary"
                  className="ui-btn-primary"
                  data-autofocus
                  onClick={() => {
                    setTransferConfirm(null);
                    transferFn?.();
                  }}
                >
                  {transferConfirm.mode === 'copy' ? (isPt ? 'Copiar' : 'Copy') : isPt ? 'Transferir' : 'Transfer'}
                </Button>
              </>
            }
          >
            <p className="text-[13px] text-ink-muted">
              {isPt ? 'Destino:' : 'Destination:'} <span className="font-mono text-[12px] text-ink break-all">{otherPaneLabel}</span>
            </p>
          </Modal>,
          document.body
        )}

      {/* Row drag ghost (positioned by the pointer handlers, see updateRowDrag) */}
      {rowDragGhost &&
        createPortal(
          <div
            ref={ghostRef}
            aria-hidden
            style={{ position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 9999 }}
            className="flex items-center gap-2 h-7 max-w-[280px] px-2.5 rounded-lg bg-surface-raised border border-line shadow-pop text-[12px] text-ink select-none whitespace-nowrap"
          >
            <FileIcon kind={rowDragGhost.icon} />
            <bdi className="min-w-0 truncate">
              {rowDragGhost.count === 1 ? rowDragGhost.name : isPt ? `${rowDragGhost.count} itens` : `${rowDragGhost.count} items`}
            </bdi>
            {rowDragGhost.effect !== 'none' && (
              <span className="shrink-0 text-[11px] text-ink-faint">
                {rowDragGhost.effect === 'copy' ? (isPt ? 'Copiar' : 'Copy') : isPt ? 'Mover' : 'Move'}
              </span>
            )}
          </div>,
          document.body
        )}
    </div>
  );
};
