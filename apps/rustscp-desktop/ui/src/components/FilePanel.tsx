import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  Folder, 
  FolderUp,
  FileText, 
  ArrowUp, 
  ArrowDown,
  ArrowUpDown,
  RotateCw, 
  FolderPlus, 
  Trash2, 
  FileCode, 
  FileArchive, 
  HardDrive,
  Home,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Search,
  Pencil,
  Check,
  SlidersHorizontal,
  List,
  LayoutGrid,
  Sparkles,
  X,
  CheckSquare,
  Square,
  Plus
} from 'lucide-react';
import { FileEntry, ActionDefinition, ClipboardState } from '../types.ts';
import { tabDragManager } from '../utils/tabDragManager.ts';
import { FileContextMenu } from './FileContextMenu.tsx';

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
}) => {
  const { t, i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [pathInput, setPathInput] = useState(currentPath);
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [showHidden, setShowHidden] = useState<boolean>(false);
  const [showBookmarks, setShowBookmarks] = useState<boolean>(false);
  const [customBookmarks, setCustomBookmarks] = useState<string[]>([]);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ 
    x: number; 
    y: number; 
    file: FileEntry | null; 
    targetPaths: string[];
    isBackground: boolean;
  } | null>(null);

  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [isDragOverContainer, setIsDragOverContainer] = useState<boolean>(false);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPathInput(currentPath);
  }, [currentPath]);

  useEffect(() => {
    if (isEditingPath && pathInputRef.current) {
      pathInputRef.current.focus();
      pathInputRef.current.select();
    }
  }, [isEditingPath]);

  // Drag & Drop Handlers
  const handleDragStart = (e: React.DragEvent, file: FileEntry) => {
    const paths = selectedFiles.includes(file.path) ? selectedFiles : [file.path];
    e.dataTransfer.setData(
      'application/rustscp-drag',
      JSON.stringify({
        sourceSessionId: sessionId,
        paths,
      })
    );
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  const handleFolderDragOver = (e: React.DragEvent, folderPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
    if (dragOverFolder !== folderPath) {
      setDragOverFolder(folderPath);
    }
  };

  const handleFolderDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);
  };

  const handleFolderDrop = (e: React.DragEvent, folderPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);
    setIsDragOverContainer(false);
    handleDropPayload(e, folderPath);
  };

  const handleContainerDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    const curDrag = tabDragManager.getDraggingTab();
    if (curDrag) {
      e.dataTransfer.dropEffect = 'move';
      if (paneId && curDrag.sourcePane !== paneId) {
        tabDragManager.setHoverTarget(paneId);
      }
    } else {
      e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
    }
    if (!isDragOverContainer) {
      setIsDragOverContainer(true);
    }
  };

  const handleContainerDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOverContainer(false);
      if (paneId) {
        tabDragManager.clearHoverTarget(paneId);
      }
    }
  };

  const handleContainerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOverContainer(false);
    handleDropPayload(e, currentPath);
  };

  const handleDropPayload = (e: React.DragEvent, destDir: string) => {
    // Tab dropped from opposite pane
    const draggingTab = tabDragManager.getDraggingTab();
    if (draggingTab && onDropTab) {
      console.log('[FilePanel handleDropPayload] Dropping tab:', draggingTab);
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

    const customData = e.dataTransfer.getData('application/rustscp-drag');
    if (customData) {
      try {
        const parsed = JSON.parse(customData);
        if (onDropItems && parsed.paths && parsed.paths.length > 0) {
          onDropItems(parsed.sourceSessionId, parsed.paths, sessionId, destDir, e.altKey);
          return;
        }
      } catch (err) {
        console.error('Failed to parse drag data:', err);
      }
    }

    // OS Native files drop (e.g. from macOS Finder / Windows Explorer)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const localPaths: string[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        const filePath = (file as any).path || file.name;
        if (filePath) localPaths.push(filePath);
      }
      if (onDropItems && localPaths.length > 0) {
        onDropItems('local', localPaths, sessionId, destDir, true);
      }
    }
  };

  // Parent Directory calculation & Navigation
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
    if (!currentPath) return false;
    const normalized = currentPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1 && /^[a-zA-Z]:$/i.test(parts[0])) return false;
    return true;
  }, [currentPath]);

  const handleGoUp = () => {
    if (!canGoUp) return;
    onNavigate(parentPath);
    setPathInput(parentPath);
  };

  // Keyboard shortcut listener on this panel
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tagName = target?.tagName?.toLowerCase();
    if (isEditingPath || tagName === 'input' || tagName === 'textarea' || target?.isContentEditable) {
      return;
    }

    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

    const isPermanentDeleteShortcut =
      (isMac && (e.metaKey || e.ctrlKey) && (e.altKey || e.shiftKey) && (e.key === 'Backspace' || e.key === 'Delete')) ||
      (e.shiftKey && (e.key === 'Delete' || e.key === 'F8'));

    const isNormalDeleteShortcut =
      e.key === 'Delete' ||
      e.key === 'F8' ||
      ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) ||
      (isMac && e.key === 'Backspace' && selectedFiles.length > 0);

    // Standard macOS navigation to parent is Cmd+Up or Alt+Up (never plain Backspace)
    const isGoUpShortcut =
      ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') ||
      (e.altKey && e.key === 'ArrowUp');

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      if (selectedFiles.length > 0 && onCopy) {
        e.preventDefault();
        onCopy(selectedFiles);
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x') {
      if (selectedFiles.length > 0 && onCut) {
        e.preventDefault();
        onCut(selectedFiles);
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      if (clipboard && clipboard.paths.length > 0 && onPaste) {
        e.preventDefault();
        onPaste();
      }
    } else if (e.shiftKey && e.key === 'F5') {
      if (selectedFiles.length > 0 && onDuplicate) {
        e.preventDefault();
        onDuplicate(selectedFiles[0]);
      }
    } else if (e.key === 'F5') {
      if (selectedFiles.length > 0 && onTransferToOtherPane) {
        e.preventDefault();
        onTransferToOtherPane();
      }
    } else if (e.key === 'F6') {
      if (selectedFiles.length > 0 && onMoveToOtherPane) {
        e.preventDefault();
        onMoveToOtherPane();
      }
    } else if (e.key === 'F4') {
      if (selectedFiles.length > 0 && onEditFile) {
        e.preventDefault();
        const file = files.find((f) => f.path === selectedFiles[0]);
        if (file && file.file_type !== 'directory') onEditFile(file);
      }
    } else if (e.key === 'F7') {
      e.preventDefault();
      onNewFolder();
    } else if (isPermanentDeleteShortcut) {
      if (selectedFiles.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        onDelete(selectedFiles, true);
      }
    } else if (isNormalDeleteShortcut) {
      if (selectedFiles.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        onDelete(selectedFiles, !remoteTrashEnabled);
      }
    } else if (isGoUpShortcut) {
      if (canGoUp) {
        e.preventDefault();
        e.stopPropagation();
        handleGoUp();
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'h') {
      if (onGoHome) {
        e.preventDefault();
        onGoHome();
      }
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '-';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const isArchiveFile = (fileName: string) => {
    const lower = fileName.toLowerCase();
    return (
      lower.endsWith('.zip') ||
      lower.endsWith('.tar.gz') ||
      lower.endsWith('.tgz') ||
      lower.endsWith('.tar.bz2') ||
      lower.endsWith('.tbz2') ||
      lower.endsWith('.tar') ||
      lower.endsWith('.gz') ||
      lower.endsWith('.zst')
    );
  };

  const getFileIcon = (file: FileEntry) => {
    if (file.file_type === 'directory') {
      return <Folder className="w-4 h-4 text-amber-600 dark:text-amber-400 fill-amber-500/20 flex-shrink-0" />;
    }
    if (isArchiveFile(file.name)) {
      return <FileArchive className="w-4 h-4 text-purple-700 dark:text-purple-400 flex-shrink-0" />;
    }
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'rs' || ext === 'ts' || ext === 'js' || ext === 'json' || ext === 'yaml' || ext === 'toml') {
      return <FileCode className="w-4 h-4 text-blue-700 dark:text-sky-400 flex-shrink-0" />;
    }
    return <FileText className="w-4 h-4 text-slate-600 dark:text-slate-400 flex-shrink-0" />;
  };

  const handleRowClick = (e: React.MouseEvent, file: FileEntry) => {
    setContextMenu(null);
    onSelectFile(file.path, e.metaKey || e.ctrlKey);
    if (onFocusPanel) onFocusPanel();
    panelRef.current?.focus({ preventScroll: true });
  };

  const handleRowDoubleClick = (file: FileEntry) => {
    if (file.file_type === 'directory') {
      onNavigate(file.path);
      setPathInput(file.path);
    } else if (onEditFile) {
      onEditFile(file);
    }
  };

  const handleRowContextMenu = (e: React.MouseEvent, file: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();

    let targets = selectedFiles;
    if (!selectedFiles.includes(file.path)) {
      onSelectFile(file.path, false);
      targets = [file.path];
    }

    if (onFocusPanel) onFocusPanel();
    panelRef.current?.focus({ preventScroll: true });

    setContextMenu({ x: e.clientX, y: e.clientY, file, targetPaths: targets, isBackground: false });
  };

  const handleContainerContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file: null, targetPaths: [], isBackground: true });
  };

  const defaultBookmarks = isRemote
    ? ['/', '/var/www', '/etc', '/home', '/var/log', '/tmp']
    : ['/', '/Users', '/Volumes', '/tmp'];

  const allBookmarks = Array.from(new Set([...defaultBookmarks, ...customBookmarks]));

  const handleAddCurrentToBookmarks = () => {
    if (!customBookmarks.includes(currentPath)) {
      setCustomBookmarks((prev) => [...prev, currentPath]);
    }
    setShowBookmarks(false);
  };

  // Breadcrumbs calculation
  const pathSegments = currentPath.split('/').filter(Boolean);

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      onNavigate('/');
      setPathInput('/');
      return;
    }
    const target = '/' + pathSegments.slice(0, index + 1).join('/');
    onNavigate(target);
    setPathInput(target);
  };

  // Column definitions & custom configuration
  const DEFAULT_COLUMNS = [
    { key: 'name', label: 'Name', labelPt: 'Nome', visible: true, align: 'left' },
    { key: 'size', label: 'Size', labelPt: 'Tamanho', visible: true, align: 'right', width: 'w-24' },
    { key: 'type', label: 'Type', labelPt: 'Tipo', visible: true, align: 'left', width: 'w-24' },
    { key: 'modified', label: 'Modified', labelPt: 'Modificado em', visible: true, align: 'right', width: 'w-36' },
    { key: 'created', label: 'Created / Added', labelPt: 'Adicionado em', visible: false, align: 'right', width: 'w-36' },
    { key: 'permissions', label: 'Permissions', labelPt: 'Permissões', visible: true, align: 'right', width: 'w-24' },
    { key: 'owner', label: 'Owner', labelPt: 'Proprietário', visible: false, align: 'left', width: 'w-24' },
    { key: 'group', label: 'Group', labelPt: 'Grupo', visible: false, align: 'left', width: 'w-20' },
  ];

  const [columns, setColumns] = useState(() => {
    try {
      const saved = localStorage.getItem('rustscp_column_config');
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, boolean>;
        return DEFAULT_COLUMNS.map((col) => ({
          ...col,
          visible: col.key === 'name' ? true : (parsed[col.key] !== undefined ? parsed[col.key] : col.visible),
        }));
      }
    } catch {}
    return DEFAULT_COLUMNS;
  });

  const [showColumnConfig, setShowColumnConfig] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [filterQuery, setFilterQuery] = useState('');
  const [showFilterBar, setShowFilterBar] = useState(false);
  const [sortColumn, setSortColumn] = useState<string>('name');
  const [sortAsc, setSortAsc] = useState<boolean>(true);

  // Sync external filter if provided
  useEffect(() => {
    if (externalFilterText !== undefined) {
      setFilterQuery(externalFilterText);
      if (externalFilterText) setShowFilterBar(true);
    }
  }, [externalFilterText]);

  const toggleColumn = (key: string) => {
    if (key === 'name') return;
    setColumns((prev) => {
      const next = prev.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c));
      try {
        const map = next.reduce((acc, c) => ({ ...acc, [c.key]: c.visible }), {});
        localStorage.setItem('rustscp_column_config', JSON.stringify(map));
      } catch {}
      return next;
    });
  };

  const handleSort = (key: string) => {
    if (sortColumn === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortColumn(key);
      setSortAsc(true);
    }
  };

  const formatDate = (isoStr?: string) => {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleString(isPt ? 'pt-BR' : 'en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoStr;
    }
  };

  const getFileTypeDesc = (file: FileEntry) => {
    if (file.file_type === 'directory') return isPt ? 'Pasta' : 'Folder';
    if (file.file_type === 'symlink') return 'Link';
    const ext = file.name.split('.').pop()?.toUpperCase();
    return ext ? ext : (isPt ? 'Arquivo' : 'File');
  };

  // Filter and Sort files
  const displayedFiles = useMemo(() => {
    let result = files.filter((f) => showHidden || !f.is_hidden);

    if (filterQuery.trim()) {
      const q = filterQuery.toLowerCase().trim();
      result = result.filter((f) => {
        if (f.name.toLowerCase().includes(q)) return true;
        const ext = f.name.split('.').pop()?.toLowerCase() || '';
        if (ext === q.replace('.', '')) return true;
        if (f.permissions.owner?.toLowerCase().includes(q)) return true;
        return false;
      });
    }

    result.sort((a, b) => {
      if (a.file_type === 'directory' && b.file_type !== 'directory') return -1;
      if (a.file_type !== 'directory' && b.file_type === 'directory') return 1;

      let cmp = 0;
      switch (sortColumn) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'type':
          cmp = getFileTypeDesc(a).localeCompare(getFileTypeDesc(b));
          break;
        case 'modified':
          cmp = (a.modified_at || '').localeCompare(b.modified_at || '');
          break;
        case 'created':
          cmp = (a.created_at || '').localeCompare(b.created_at || '');
          break;
        case 'permissions':
          cmp = (a.permissions.mode || 0) - (b.permissions.mode || 0);
          break;
        case 'owner':
          cmp = (a.permissions.owner || '').localeCompare(b.permissions.owner || '');
          break;
        case 'group':
          cmp = (a.permissions.group || '').localeCompare(b.permissions.group || '');
          break;
        default:
          cmp = a.name.localeCompare(b.name);
      }
      return sortAsc ? cmp : -cmp;
    });

    return result;
  }, [files, showHidden, filterQuery, sortColumn, sortAsc, isPt]);

  const isCut = (path: string) => {
    return clipboard?.action === 'cut' && clipboard?.sourceSession === sessionId && clipboard?.paths.includes(path);
  };

  return (
    <div 
      ref={panelRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={onFocusPanel}
      onClick={() => {
        if (onFocusPanel) onFocusPanel();
        setContextMenu(null);
      }}
      className={`flex-1 flex flex-col bg-white dark:bg-dark-800 border rounded-lg overflow-hidden shadow-sm m-1 relative focus:outline-none transition-all ${
        isFocused 
          ? 'border-rust-500 ring-2 ring-rust-500/30' 
          : 'border-slate-300 dark:border-dark-700'
      }`}
    >
      {/* Panel Header */}
      <div className="bg-slate-100 dark:bg-dark-750 border-b border-slate-200 dark:border-dark-600 px-3 py-1.5 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <HardDrive className={`w-4 h-4 ${isRemote ? 'text-purple-600 dark:text-purple-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">{title}</span>
          <span className="text-[10px] bg-slate-200/70 dark:bg-dark-900/60 px-1.5 py-0.5 rounded text-slate-700 dark:text-slate-400 font-mono border border-slate-300 dark:border-dark-700/60">
            {displayedFiles.length} {isPt ? 'itens' : 'items'}
          </span>
          {selectedFiles.length > 0 && (
            <span className="text-[10px] bg-sky-500/20 text-sky-800 dark:text-sky-300 font-mono px-1.5 py-0.5 rounded border border-sky-500/30">
              {selectedFiles.length} {isPt ? 'selecionado(s)' : 'selected'}
            </span>
          )}
        </div>

        {/* Action Toolbar */}
        <div className="flex items-center space-x-1">
          {/* Bookmarks */}
          <div className="relative">
            <button
              onClick={() => setShowBookmarks(!showBookmarks)}
              title={isPt ? 'Favoritos / Atalhos de Pastas (Ctrl+D)' : 'Bookmarks (Ctrl+D)'}
              className="p-1 rounded hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 flex items-center space-x-0.5"
            >
              <Bookmark className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
              <ChevronDown className="w-3 h-3 text-slate-500 dark:text-slate-400" />
            </button>

            {showBookmarks && (
              <div className="absolute right-0 mt-1 w-52 bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-lg shadow-xl py-1 z-30">
                <div className="px-3 py-1 border-b border-slate-200 dark:border-dark-700 flex justify-between items-center">
                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">
                    {isPt ? 'Favoritos' : 'Bookmarks'}
                  </span>
                  <button
                    onClick={handleAddCurrentToBookmarks}
                    className="text-[10px] text-sky-600 dark:text-sky-400 hover:text-sky-800 dark:hover:text-sky-300 font-semibold"
                  >
                    + {isPt ? 'Salvar Atual' : 'Add Current'}
                  </button>
                </div>
                {allBookmarks.map((bm) => (
                  <button
                    key={bm}
                    onClick={() => {
                      onNavigate(bm);
                      setShowBookmarks(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-dark-700 font-mono truncate transition-colors"
                  >
                    {bm}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => setShowHidden(!showHidden)}
            title={showHidden ? 'Ocultar arquivos ocultos (.*)' : 'Mostrar arquivos ocultos (.*)'}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors ${
              showHidden
                ? 'bg-sky-500/20 dark:bg-sky-600/30 border-sky-500/40 text-sky-800 dark:text-sky-300 font-bold'
                : 'bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-700 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            .*
          </button>

          {onGoHome && (
            <button
              onClick={onGoHome}
              title={isPt ? 'Ir para Pasta Padrão / Home (Ctrl+H)' : 'Go to Home Directory (Ctrl+H)'}
              className="p-1 rounded hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 transition-colors"
            >
              <Home className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            </button>
          )}
          <button
            onClick={handleGoUp}
            disabled={!canGoUp}
            title={isPt ? 'Subir Diretório (Backspace / ..)' : 'Go up directory (Backspace / ..)'}
            className={`p-1 rounded transition-colors ${
              canGoUp
                ? 'hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100'
                : 'opacity-40 cursor-not-allowed text-slate-400'
            }`}
          >
            <FolderUp className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
          </button>
          <button
            onClick={onRefresh}
            title={isPt ? 'Recarregar do Servidor (F5 / Cmd+R)' : 'Refresh from Server (F5 / Ctrl+R)'}
            className="p-1 rounded hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 transition-colors"
          >
            <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-rust-500' : ''}`} />
          </button>
          <button
            onClick={onNewFolder}
            title={isPt ? 'Criar Pasta (F7)' : 'New Folder (F7)'}
            className="p-1 rounded hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 transition-colors"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(selectedFiles, !remoteTrashEnabled)}
            disabled={selectedFiles.length === 0}
            title={
              isRemote && remoteTrashEnabled
                ? (isPt ? 'Mover para Lixeira (⌘⌫ / Del / F8)' : 'Move to Trash (⌘⌫ / Del / F8)')
                : (isPt ? 'Excluir (⌘⌫ / Del / F8)' : 'Delete (⌘⌫ / Del / F8)')
            }
            className="p-1 rounded hover:bg-red-500/10 dark:hover:bg-red-500/20 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Quick Search / Filter Toggle */}
          <button
            onClick={() => setShowFilterBar(!showFilterBar)}
            title={isPt ? 'Filtrar Arquivos (Ctrl+F)' : 'Filter Files (Ctrl+F)'}
            className={`p-1 rounded transition-colors ${
              showFilterBar || filterQuery
                ? 'bg-sky-600/30 text-sky-700 dark:text-sky-300'
                : 'hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100'
            }`}
          >
            <Search className="w-3.5 h-3.5" />
          </button>

          {/* View Mode Toggle: List vs Grid */}
          <div className="flex items-center bg-white dark:bg-dark-900/60 p-0.5 rounded border border-slate-300 dark:border-dark-700/60 shadow-xs">
            <button
              onClick={() => setViewMode('list')}
              title={isPt ? 'Modo Lista / Detalhes' : 'List / Details View'}
              className={`p-0.5 rounded ${
                viewMode === 'list'
                  ? 'bg-sky-600/30 text-sky-800 dark:text-sky-300 font-bold'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-100'
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              title={isPt ? 'Modo Ícones / Grade' : 'Icons / Grid View'}
              className={`p-0.5 rounded ${
                viewMode === 'grid'
                  ? 'bg-sky-600/30 text-sky-800 dark:text-sky-300 font-bold'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-100'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Column Settings Popover */}
          <div className="relative">
            <button
              onClick={() => setShowColumnConfig(!showColumnConfig)}
              title={isPt ? 'Configurar Colunas Visíveis' : 'Configure Visible Columns'}
              className={`p-1 rounded hover:bg-slate-200 dark:hover:bg-dark-600 transition-colors ${
                showColumnConfig ? 'bg-slate-200 dark:bg-dark-600 text-sky-700 dark:text-sky-400' : 'text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>

            {showColumnConfig && (
              <div className="absolute right-0 mt-1 w-56 bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-lg shadow-2xl p-2 z-30 space-y-1.5 animate-in fade-in zoom-in-95 duration-100 text-slate-900 dark:text-slate-100">
                <div className="px-2 py-1 border-b border-slate-200 dark:border-dark-700 flex justify-between items-center text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase">
                  <span>{isPt ? 'Colunas da Tabela' : 'Table Columns'}</span>
                  <button
                    onClick={() => {
                      setColumns(DEFAULT_COLUMNS);
                      localStorage.removeItem('rustscp_column_config');
                    }}
                    className="text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 font-semibold lowercase"
                  >
                    {isPt ? 'restaurar' : 'reset'}
                  </button>
                </div>
                {columns.map((col) => {
                  const isName = col.key === 'name';
                  return (
                    <button
                      key={col.key}
                      disabled={isName}
                      onClick={() => toggleColumn(col.key)}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                        col.visible
                          ? 'text-slate-900 dark:text-slate-100 bg-slate-100 dark:bg-dark-700/60 font-semibold'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      } ${isName ? 'opacity-70 cursor-not-allowed' : 'hover:bg-slate-100 dark:hover:bg-dark-700'}`}
                    >
                      <span>{isPt ? col.labelPt : col.label}</span>
                      {col.visible ? (
                        <CheckSquare className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* AI Assistant Button */}
          {onOpenAiAssistant && (
            <button
              onClick={onOpenAiAssistant}
              title={isPt ? 'Assistente Inteligente (IA)' : 'RustSCP AI Assistant'}
              className="p-1 rounded hover:bg-purple-500/20 text-purple-400 hover:text-purple-300 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Interactive Breadcrumb & Path Bar */}
      <div className="px-3 py-1 bg-slate-50 dark:bg-dark-900/60 border-b border-slate-200 dark:border-dark-700/60 flex items-center justify-between gap-2 min-h-[30px]">
        {isEditingPath ? (
          <div className="flex-1 flex items-center gap-1">
            <input
              ref={pathInputRef}
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onNavigate(pathInput);
                  setIsEditingPath(false);
                } else if (e.key === 'Escape') {
                  setPathInput(currentPath);
                  setIsEditingPath(false);
                }
              }}
              onBlur={() => setIsEditingPath(false)}
              className="flex-1 bg-white dark:bg-dark-950 border border-sky-500 rounded px-2 py-0.5 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none shadow-inner"
            />
            <button
              onClick={() => {
                onNavigate(pathInput);
                setIsEditingPath(false);
              }}
              className="p-1 hover:bg-slate-200 dark:hover:bg-dark-700 rounded text-sky-600 dark:text-sky-400"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex-1 flex items-center overflow-x-auto no-scrollbar py-0.5 text-xs font-mono">
            {/* Quick Go Up icon button */}
            <button
              onClick={handleGoUp}
              disabled={!canGoUp}
              title={isPt ? 'Subir um nível (..)' : 'Go up one level (..)'}
              className={`p-1 mr-1 rounded transition-colors shrink-0 ${
                canGoUp
                  ? 'hover:bg-slate-200 dark:hover:bg-dark-700 text-amber-600 dark:text-amber-400'
                  : 'opacity-30 cursor-not-allowed text-slate-400'
              }`}
            >
              <FolderUp className="w-3.5 h-3.5" />
            </button>

            {/* Root item */}
            <button
              onClick={() => handleBreadcrumbClick(-1)}
              className="text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-100 px-1.5 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-dark-700/70 shrink-0 font-semibold"
              title="Ir para /"
            >
              /
            </button>

            {pathSegments.map((seg, idx) => (
              <React.Fragment key={idx}>
                <ChevronRight className="w-3 h-3 text-slate-400 dark:text-slate-600 shrink-0 mx-0.5" />
                <button
                  onClick={() => handleBreadcrumbClick(idx)}
                  className={`px-1.5 py-0.5 rounded shrink-0 hover:bg-slate-200 dark:hover:bg-dark-700/70 transition-colors ${
                    idx === pathSegments.length - 1
                      ? 'text-sky-800 dark:text-sky-300 font-bold bg-slate-200/70 dark:bg-dark-800 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200'
                  }`}
                >
                  {seg}
                </button>
              </React.Fragment>
            ))}
          </div>
        )}

        <button
          onClick={() => setIsEditingPath(!isEditingPath)}
          title={isPt ? 'Editar Caminho Manualmente' : 'Edit Path Manually'}
          className="p-1 hover:bg-slate-200 dark:hover:bg-dark-700 rounded text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 shrink-0"
        >
          <Pencil className="w-3 h-3" />
        </button>
      </div>

      {/* Quick Filter Bar */}
      {showFilterBar && (
        <div className="px-3 py-1 bg-slate-100 dark:bg-dark-900/90 border-b border-slate-200 dark:border-dark-700/80 flex items-center gap-2 animate-in fade-in duration-100">
          <Search className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder={isPt ? 'Filtrar por nome, extensão ou proprietário...' : 'Filter by name, extension or owner...'}
            className="flex-1 bg-transparent text-xs text-slate-900 dark:text-slate-100 placeholder-slate-500 focus:outline-none font-mono"
            autoFocus
          />
          {filterQuery && (
            <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
              {displayedFiles.length} {isPt ? 'correspondências' : 'matches'}
            </span>
          )}
          <button
            onClick={() => {
              setFilterQuery('');
              setShowFilterBar(false);
            }}
            className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-dark-700 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* File Table / Grid View */}
      <div 
        className={`flex-1 overflow-auto transition-colors ${
          isDragOverContainer ? 'ring-2 ring-sky-500 ring-inset bg-sky-500/5' : ''
        }`}
        onContextMenu={handleContainerContextMenu}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        {!sessionId ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center select-none min-h-[300px]">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-dark-850 flex items-center justify-center mb-3 border border-slate-200 dark:border-dark-700/60 shadow-xs">
              <HardDrive className="w-7 h-7 text-slate-400 dark:text-slate-500" />
            </div>
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-1">
              {t('dualPane.emptyPaneTitle', 'Nenhum ambiente conectado neste painel')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mb-4">
              {t('dualPane.emptyPaneDesc', 'Arraste uma aba de conexão para cá ou clique no botão abaixo para abrir uma nova conexão.')}
            </p>
            {onNewSession && (
              <button
                onClick={onNewSession}
                className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-rust-500 hover:bg-rust-600 text-white shadow-sm transition-all active:scale-95 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('sessionTabs.connect', 'Conectar')}</span>
              </button>
            )}
          </div>
        ) : viewMode === 'grid' ? (
          /* Grid View */
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {loading ? (
              /* Shimmer Skeleton Grid Cards */
              Array.from({ length: 12 }).map((_, idx) => (
                <div
                  key={`skeleton-grid-${idx}`}
                  className="p-3 rounded-xl border border-dark-700/50 bg-dark-900/40 flex flex-col items-center animate-pulse"
                >
                  <div className="w-10 h-10 rounded-lg bg-dark-700/80 animate-shimmer mb-2.5" />
                  <div className="h-3 w-3/4 rounded bg-dark-700/80 animate-shimmer mb-1.5" />
                  <div className="h-2.5 w-1/2 rounded bg-dark-700/80 animate-shimmer" />
                </div>
              ))
            ) : (
              <>
                {canGoUp && (
                  <div
                    key="__parent_dir_grid__"
                    onClick={handleGoUp}
                    onDoubleClick={handleGoUp}
                    onDragOver={(e) => {
                      const cur = tabDragManager.getDraggingTab();
                      if (cur) return;
                      handleFolderDragOver(e, parentPath);
                    }}
                    onDragLeave={handleFolderDragLeave}
                    onDrop={(e) => {
                      const cur = tabDragManager.getDraggingTab();
                      if (cur) return;
                      handleFolderDrop(e, parentPath);
                    }}
                    title={isPt ? 'Subir diretório (Clique ou Duplo clique)' : 'Go to parent directory (Click or Double-click)'}
                    className={`group p-3 rounded-xl border flex flex-col items-center text-center cursor-pointer select-none transition-all ${
                      dragOverFolder === parentPath
                        ? 'ring-2 ring-sky-500 bg-sky-500/20 font-bold scale-[1.02] shadow-lg'
                        : 'bg-amber-500/5 dark:bg-amber-500/10 border-amber-500/30 dark:border-amber-500/20 hover:bg-amber-500/15 dark:hover:bg-amber-500/20 hover:border-amber-500/50 hover:scale-[1.02]'
                    }`}
                  >
                    <div className="w-12 h-12 flex items-center justify-center mb-2 relative">
                      <FolderUp className="w-10 h-10 text-amber-500 dark:text-amber-400 fill-amber-500/20 group-hover:scale-110 transition-transform" />
                    </div>
                    <span className="text-xs text-slate-900 dark:text-slate-100 font-bold truncate w-full font-mono">
                      ..
                    </span>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 font-sans mt-0.5">
                      {isPt ? 'Subir pasta' : 'Parent folder'}
                    </span>
                  </div>
                )}

                {displayedFiles.length === 0 ? (
                  <div className="col-span-full py-12 text-center text-slate-500 text-xs italic">
                    {t('dualPane.emptyDirectory')}
                  </div>
                ) : (
                  displayedFiles.map((file) => {
                    const isSelected = selectedFiles.includes(file.path);
                    const diffType = diffMap?.[file.name];
                    const cutActive = isCut(file.path);

                    return (
                      <div
                        key={file.path}
                        draggable={true}
                        onDragStart={(e) => handleDragStart(e, file)}
                        onDragOver={(e) => {
                          const cur = tabDragManager.getDraggingTab();
                          if (cur) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (paneId && cur.sourcePane !== paneId) {
                              tabDragManager.setHoverTarget(paneId);
                            }
                            return;
                          }
                          if (file.file_type === 'directory') {
                            handleFolderDragOver(e, file.path);
                          }
                        }}
                        onDragLeave={file.file_type === 'directory' ? handleFolderDragLeave : undefined}
                        onDrop={(e) => {
                          const cur = tabDragManager.getDraggingTab();
                          if (cur) {
                            e.preventDefault();
                            e.stopPropagation();
                            handleDropPayload(e, currentPath);
                            return;
                          }
                          if (file.file_type === 'directory') {
                            handleFolderDrop(e, file.path);
                          }
                        }}
                        onClick={(e) => handleRowClick(e, file)}
                        onDoubleClick={() => handleRowDoubleClick(file)}
                        onContextMenu={(e) => handleRowContextMenu(e, file)}
                        className={`group p-3 rounded-xl border flex flex-col items-center text-center cursor-pointer transition-all ${
                          cutActive ? 'opacity-40 italic' : ''
                        } ${
                          dragOverFolder === file.path
                            ? 'ring-2 ring-sky-500 bg-sky-500/20 font-bold scale-[1.02] shadow-lg'
                            : isSelected
                            ? 'bg-sky-600/25 border-sky-500/50 shadow-md ring-1 ring-sky-500/30'
                            : diffType === 'different_size'
                            ? 'bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20'
                            : 'bg-dark-900/40 border-dark-700/60 hover:bg-dark-700/50 hover:border-dark-600'
                        }`}
                      >
                        <div className="w-12 h-12 flex items-center justify-center mb-2 relative">
                          {file.file_type === 'directory' ? (
                            <Folder className="w-10 h-10 text-amber-600 dark:text-amber-400 fill-amber-500/20" />
                          ) : isArchiveFile(file.name) ? (
                            <FileArchive className="w-10 h-10 text-purple-700 dark:text-purple-400" />
                          ) : (
                            <FileText className="w-10 h-10 text-slate-600 dark:text-slate-400" />
                          )}
                          {diffType && (
                            <span className="absolute -top-1 -right-1 text-[8px] px-1 rounded bg-amber-500 text-black font-bold">
                              DIFF
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-slate-900 dark:text-slate-100 font-medium truncate w-full" title={file.name}>
                          {file.name}
                        </span>
                        <span className="text-[10px] text-slate-600 dark:text-slate-400 font-mono mt-0.5">
                          {file.file_type === 'directory' ? (isPt ? 'Pasta' : 'Folder') : formatSize(file.size)}
                        </span>
                      </div>
                    );
                  })
                )}
              </>
            )}
          </div>
        ) : (
          /* Table / List View with Dynamic Columns */
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 bg-slate-100 dark:bg-dark-800 text-[11px] font-semibold text-slate-700 dark:text-slate-300 border-b border-slate-200 dark:border-dark-700 z-10">
              <tr>
                {columns.filter((c) => c.visible).map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={`py-1.5 px-3 select-none cursor-pointer hover:text-slate-950 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-dark-700/60 transition-colors ${
                      col.width || ''
                    } ${
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                    }`}
                  >
                    <div className={`inline-flex items-center gap-1 ${col.align === 'right' ? 'flex-row-reverse' : ''}`}>
                      <span>{isPt ? col.labelPt : col.label}</span>
                      {sortColumn === col.key ? (
                        sortAsc ? (
                          <ArrowUp className="w-3 h-3 text-sky-500 dark:text-sky-400 shrink-0" />
                        ) : (
                          <ArrowDown className="w-3 h-3 text-sky-500 dark:text-sky-400 shrink-0" />
                        )
                      ) : (
                        <ArrowUpDown className="w-2.5 h-2.5 text-slate-400 dark:text-slate-500 opacity-60 shrink-0" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-dark-700/40">
              {loading ? (
                /* Shimmer Skeleton Table Rows */
                Array.from({ length: 10 }).map((_, idx) => (
                  <tr key={`skeleton-row-${idx}`} className="animate-pulse">
                    <td className="py-2 px-3 flex items-center space-x-2">
                      <div className="w-4 h-4 rounded bg-slate-200 dark:bg-dark-700/80 animate-shimmer shrink-0" />
                      <div
                        className="h-3 rounded bg-slate-200 dark:bg-dark-700/80 animate-shimmer"
                        style={{ width: `${40 + ((idx * 19) % 45)}%` }}
                      />
                    </td>
                    {columns.filter((c) => c.visible && c.key !== 'name').map((col) => (
                      <td key={col.key} className="py-2 px-3">
                        <div
                          className={`h-3 rounded bg-slate-200 dark:bg-dark-700/80 animate-shimmer ${
                            col.align === 'right' ? 'ml-auto w-14' : 'w-20'
                          }`}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <>
                  {canGoUp && (
                    <tr
                      key="__parent_dir__"
                      onDoubleClick={handleGoUp}
                      onDragOver={(e) => {
                        const cur = tabDragManager.getDraggingTab();
                        if (cur) return;
                        handleFolderDragOver(e, parentPath);
                      }}
                      onDragLeave={handleFolderDragLeave}
                      onDrop={(e) => {
                        const cur = tabDragManager.getDraggingTab();
                        if (cur) return;
                        handleFolderDrop(e, parentPath);
                      }}
                      title={isPt ? 'Subir diretório (Duplo clique ou Enter)' : 'Go to parent directory (Double-click or Enter)'}
                      className={`cursor-pointer group select-none transition-colors border-b border-slate-200/80 dark:border-dark-700/60 ${
                        dragOverFolder === parentPath
                          ? 'ring-2 ring-sky-500 bg-sky-500/25 text-sky-950 dark:text-sky-100 font-bold'
                          : 'hover:bg-amber-500/10 dark:hover:bg-amber-500/15 bg-slate-50/40 dark:bg-dark-800/40'
                      }`}
                    >
                      {columns.filter((c) => c.visible).map((col) => {
                        switch (col.key) {
                          case 'name':
                            return (
                              <td key="name" className="py-1.5 px-3 flex items-center space-x-2 truncate max-w-xs">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleGoUp();
                                  }}
                                  title={isPt ? 'Subir diretório' : 'Go up'}
                                  className="p-1 -ml-1 rounded hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 transition-colors"
                                >
                                  <FolderUp className="w-4 h-4 fill-amber-500/20 shrink-0" />
                                </button>
                                <span className="font-bold font-mono text-slate-900 dark:text-slate-100">..</span>
                                <span className="text-[10px] text-slate-500 dark:text-slate-400 group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors ml-1 font-sans">
                                  [{isPt ? 'Subir pasta' : 'Up'}]
                                </span>
                              </td>
                            );
                          case 'size':
                            return (
                              <td key="size" className="py-1.5 px-3 text-right font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                &lt;DIR&gt;
                              </td>
                            );
                          case 'type':
                            return (
                              <td key="type" className="py-1.5 px-3 text-left font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                {isPt ? 'Pasta' : 'Folder'}
                              </td>
                            );
                          default:
                            return (
                              <td key={col.key} className="py-1.5 px-3 text-right font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                -
                              </td>
                            );
                        }
                      })}
                    </tr>
                  )}

                  {displayedFiles.length === 0 ? (
                    <tr>
                      <td colSpan={columns.filter((c) => c.visible).length} className="py-8 text-center text-slate-500 text-xs italic">
                        {t('dualPane.emptyDirectory')}
                      </td>
                    </tr>
                  ) : (
                    displayedFiles.map((file) => {
                  const isSelected = selectedFiles.includes(file.path);
                  const diffType = diffMap?.[file.name];
                  const cutActive = isCut(file.path);

                  return (
                    <tr
                      key={file.path}
                      draggable={true}
                      onDragStart={(e) => handleDragStart(e, file)}
                      onDragOver={(e) => {
                        const cur = tabDragManager.getDraggingTab();
                        if (cur) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (paneId && cur.sourcePane !== paneId) {
                            tabDragManager.setHoverTarget(paneId);
                          }
                          return;
                        }
                        if (file.file_type === 'directory') {
                          handleFolderDragOver(e, file.path);
                        }
                      }}
                      onDragLeave={file.file_type === 'directory' ? handleFolderDragLeave : undefined}
                      onDrop={(e) => {
                        const cur = tabDragManager.getDraggingTab();
                        if (cur) {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDropPayload(e, currentPath);
                          return;
                        }
                        if (file.file_type === 'directory') {
                          handleFolderDrop(e, file.path);
                        }
                      }}
                      onClick={(e) => handleRowClick(e, file)}
                      onDoubleClick={() => handleRowDoubleClick(file)}
                      onContextMenu={(e) => handleRowContextMenu(e, file)}
                      className={`cursor-pointer transition-colors ${
                        cutActive ? 'opacity-40 italic' : ''
                      } ${
                        dragOverFolder === file.path
                          ? 'ring-2 ring-sky-500 bg-sky-500/25 text-sky-950 dark:text-sky-100 font-bold'
                          : isSelected
                          ? 'bg-sky-500/20 dark:bg-sky-600/30 text-sky-950 dark:text-sky-100 font-semibold'
                          : diffType === 'different_size'
                          ? 'bg-amber-500/15 hover:bg-amber-500/25 text-slate-900 dark:text-slate-100'
                          : diffType === 'different_time'
                          ? 'bg-blue-500/15 hover:bg-blue-500/25 text-slate-900 dark:text-slate-100'
                          : diffType === 'missing_in_remote' || diffType === 'missing_in_local'
                          ? 'bg-emerald-500/15 hover:bg-emerald-500/25 text-slate-900 dark:text-slate-100'
                          : 'hover:bg-slate-100 dark:hover:bg-dark-700/60 text-slate-900 dark:text-slate-200'
                      }`}
                    >
                      {columns.filter((c) => c.visible).map((col) => {
                        switch (col.key) {
                          case 'name':
                            return (
                              <td key="name" className="py-1 px-3 flex items-center space-x-2 truncate max-w-xs">
                                {getFileIcon(file)}
                                <span className="truncate text-slate-900 dark:text-slate-100 font-medium">{file.name}</span>
                                {diffType && (
                                  <span className={`text-[9px] px-1 py-0.2 rounded font-mono font-bold uppercase shrink-0 ${
                                    diffType === 'different_size'
                                      ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300'
                                      : diffType === 'different_time'
                                      ? 'bg-blue-500/20 text-blue-600 dark:text-blue-300'
                                      : 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300'
                                  }`}>
                                    {diffType === 'different_size' ? '≠ Size' : diffType === 'different_time' ? '≠ Time' : 'New'}
                                  </span>
                                )}
                              </td>
                            );
                          case 'size':
                            return (
                              <td key="size" className="py-1 px-3 text-right font-mono text-[11px] text-slate-600 dark:text-slate-400">
                                {file.file_type === 'directory' ? '<DIR>' : formatSize(file.size)}
                              </td>
                            );
                          case 'type':
                            return (
                              <td key="type" className="py-1 px-3 text-left font-mono text-[11px] text-slate-600 dark:text-slate-400">
                                {getFileTypeDesc(file)}
                              </td>
                            );
                          case 'modified':
                            return (
                              <td key="modified" className="py-1 px-3 text-right font-mono text-[11px] text-slate-600 dark:text-slate-400">
                                {formatDate(file.modified_at)}
                              </td>
                            );
                          case 'created':
                            return (
                              <td key="created" className="py-1 px-3 text-right font-mono text-[11px] text-slate-600 dark:text-slate-400">
                                {formatDate(file.created_at)}
                              </td>
                            );
                          case 'permissions':
                            return (
                              <td key="permissions" className="py-1 px-3 text-right font-mono text-[11px] text-slate-600 dark:text-slate-500">
                                {file.permissions.mode ? '0' + (file.permissions.mode & 0o777).toString(8) : '-'}
                              </td>
                            );
                          case 'owner':
                            return (
                              <td key="owner" className="py-1 px-3 text-left font-mono text-[11px] text-slate-600 dark:text-slate-400 truncate">
                                {file.permissions.owner || '-'}
                              </td>
                            );
                          case 'group':
                            return (
                              <td key="group" className="py-1 px-3 text-left font-mono text-[11px] text-slate-600 dark:text-slate-400 truncate">
                                {file.permissions.group || '-'}
                              </td>
                            );
                          default:
                            return null;
                        }
                      })}
                    </tr>
                  );
                })
              )}
            </>
          )}
        </tbody>
          </table>
        )}
      </div>

      {/* Super Context Menu with edge mapping and scroll indicators */}
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
          selectedFiles={selectedFiles}
          clipboard={clipboard}
          actionsCatalog={actionsCatalog}
          onClose={() => setContextMenu(null)}
          onCut={onCut}
          onCopy={onCopy}
          onPaste={onPaste}
          onDuplicate={onDuplicate}
          onGoHome={onGoHome}
          onOpenAiAssistant={onOpenAiAssistant}
          onRequestCompress={onRequestCompress}
          onCompress={onCompress}
          onRequestExtract={onRequestExtract}
          onExtract={onExtract}
          onExecuteSmartAction={onExecuteSmartAction}
          onOpenTerminalHere={onOpenTerminalHere}
          onOpenNativeTerminalHere={onOpenNativeTerminalHere}
          onEditFile={onEditFile}
          onCalculateSize={onCalculateSize}
          onOpenSymlink={onOpenSymlink}
          onShowProperties={onShowProperties}
          onCalculateChecksum={onCalculateChecksum}
          onOpenFindFiles={onOpenFindFiles}
          onOpenGenerateCode={onOpenGenerateCode}
          onMoveToTrash={onMoveToTrash}
          onDelete={onDelete}
        />
      )}
    </div>
  );
};
