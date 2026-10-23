import React, { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Header } from './components/Header.tsx';
import { DualPane } from './components/DualPane.tsx';
import { SessionTabs, ActiveSession } from './components/SessionTabs.tsx';
import { LoginDialog } from './components/LoginDialog.tsx';
import { FilePropertiesModal } from './components/FilePropertiesModal.tsx';
import { RemoteCommandDialog } from './components/RemoteCommandDialog.tsx';
import { ChecksumModal } from './components/ChecksumModal.tsx';
import { TransferQueue } from './components/TransferQueue.tsx';
import { SymlinkModal } from './components/SymlinkModal.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { ConfirmDialogModal } from './components/ConfirmDialogModal.tsx';
import { InputDialogModal } from './components/InputDialogModal.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { CommandPalette, PaletteCommand } from './components/CommandPalette.tsx';
import { notify } from './components/ui/toast.tsx';
import { buildPaletteCommands } from './paletteCommands.tsx';
import {
  ActionDefinition,
  AuditEvent,
  ClipboardState,
  ConnectionConfig,
  FileEntry,
  McpStatusInfo,
  PaneId,
  QueueTransferTask,
  RemoteSystemInfo,
  RemoteTrashItem,
  RemoteTrashResponse,
  RemoteTrashStatus,
  SyncItem,
  VaultSecurityInfo,
} from './types.ts';
import { ThemeMode, getStoredTheme, saveTheme, applyTheme, initThemeWatcher } from './theme.ts';
import { directoryCache } from './utils/directoryCache.ts';
import {
  basename,
  dirname,
  detectSep,
  joinPath,
  samePath,
  isInside,
  relativeMove,
  applyRelativeMove,
  isLikelyBinaryName,
  EDITOR_MAX_BYTES,
  formatBytes,
} from './utils/paths.ts';
import { inDir } from './utils/shell.ts';
import { useRefState } from './utils/useRefState.ts';
import { useStableHandlers } from './utils/useStableHandlers.ts';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { TerminalDock } from './components/terminal/TerminalDock.tsx';
import { initTerminalStore, openTerminal, setDockOpen, toggleDock, useTerminalBadge } from './components/terminal/terminalStore.ts';
import { listen } from '@tauri-apps/api/event';
import type { ShareSource } from './components/ShareConnectionModal.tsx';
import type { ShareFile } from './components/OpenShareModal.tsx';

// Heavy, rarely used modals are split into their own chunks and mounted only while open.
const AiAssistantModal = lazy(() => import('./components/AiAssistantModal.tsx').then((m) => ({ default: m.AiAssistantModal })));
const CommandStudioModal = lazy(() => import('./components/CommandStudioModal.tsx').then((m) => ({ default: m.CommandStudioModal })));
const SysAdminMarketplaceModal = lazy(() =>
  import('./components/SysAdminMarketplaceModal.tsx').then((m) => ({ default: m.SysAdminMarketplaceModal }))
);
const VirtualDiskModal = lazy(() => import('./components/VirtualDiskModal.tsx').then((m) => ({ default: m.VirtualDiskModal })));
const RustScpEditor = lazy(() => import('./components/RustScpEditor.tsx').then((m) => ({ default: m.RustScpEditor })));
const ScriptConsoleModal = lazy(() => import('./components/ScriptConsoleModal.tsx').then((m) => ({ default: m.ScriptConsoleModal })));
const GenerateCodeModal = lazy(() => import('./components/GenerateCodeModal.tsx').then((m) => ({ default: m.GenerateCodeModal })));
const McpGatewayModal = lazy(() => import('./components/McpGatewayModal.tsx').then((m) => ({ default: m.McpGatewayModal })));
const RemoteTrashModal = lazy(() => import('./components/RemoteTrashModal.tsx').then((m) => ({ default: m.RemoteTrashModal })));
const SyncDialog = lazy(() => import('./components/SyncDialog.tsx').then((m) => ({ default: m.SyncDialog })));
const FindFilesModal = lazy(() => import('./components/FindFilesModal.tsx').then((m) => ({ default: m.FindFilesModal })));
const FileSystemInfoModal = lazy(() => import('./components/FileSystemInfoModal.tsx').then((m) => ({ default: m.FileSystemInfoModal })));
const ShareConnectionModal = lazy(() => import('./components/ShareConnectionModal.tsx').then((m) => ({ default: m.ShareConnectionModal })));
const OpenShareModal = lazy(() => import('./components/OpenShareModal.tsx').then((m) => ({ default: m.OpenShareModal })));
const CompressionModal = lazy(() => import('./components/CompressionModal.tsx').then((m) => ({ default: m.CompressionModal })));
const AboutModal = lazy(() => import('./components/AboutModal.tsx').then((m) => ({ default: m.AboutModal })));

// Safe Tauri invocation helper. Outside Tauri (vite dev/preview in a browser) it falls back to
// mock data that lives in its own lazily loaded chunk.
async function invokeTauri<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri()) {
    return await invoke<T>(cmd, args);
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (_e) {
    console.warn(`[Web Fallback] '${cmd}'`, args);
    const { getFallbackData } = await import('./devFallback.ts');
    return getFallbackData<T>(cmd, args);
  }
}

function errText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && 'message' in (err as any)) return String((err as any).message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Error isolation for one dialog: a crash (or a lazy chunk that fails to load) shows a small
 * "something went wrong" dialog that closes just this modal; the panes and connections keep working.
 */
const ModalGuard: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <ErrorBoundary scope="modal" fallbackTitle={title} onClose={onClose}>
    <Suspense fallback={null}>{children}</Suspense>
  </ErrorBoundary>
);

/**
 * Waits for `work`, but resolves true as soon as `attempt` is cancelled (the Site Manager's Stop
 * only flips a flag, so it is polled while the work is pending). Otherwise resolves with the
 * attempt's state once the work settles.
 */
function settledOrCancelled(work: Promise<unknown>, attempt?: { cancelled: boolean }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!attempt) {
      work.then(() => resolve(false), () => resolve(false));
      return;
    }
    const timer = setInterval(() => {
      if (attempt.cancelled) {
        clearInterval(timer);
        resolve(true);
      }
    }, 150);
    const done = () => {
      clearInterval(timer);
      resolve(attempt.cancelled);
    };
    work.then(done, done);
  });
}

const LOCAL_ID = 'local';
const LAST_PATHS_KEY = 'rustscp_last_remote_paths';
const LAST_PATHS_MAX = 100;

const otherPane = (p: PaneId): PaneId => (p === 'left' ? 'right' : 'left');
const PANES: PaneId[] = ['left', 'right'];

const INITIAL_LOCAL_SESSION: ActiveSession = {
  id: LOCAL_ID,
  config: {
    id: LOCAL_ID,
    name: 'Local Machine',
    protocol: 'local',
    host: 'localhost',
    port: 0,
    username: 'user',
    auth: { type: 'None', value: null },
    remote_root: '',
  },
  currentPath: '',
};

/** Everything a tool needs about one pane, always taken from the same pane. */
interface PaneCtx {
  pane: PaneId;
  sessionId: string;
  session?: ActiveSession;
  name: string;
  path: string;
  files: FileEntry[];
  selection: string[];
  isRemote: boolean;
}

type ToolKey = 'find' | 'script' | 'generate' | 'serverInfo' | 'studio' | 'ai' | 'marketplace' | 'trash' | 'virtualDisk' | 'remoteCommand';

interface FileTarget {
  file: FileEntry;
  sessionId: string;
  pane?: PaneId;
}

/** What a rename works on: the session, the item, its folder and the naming rules there. */
interface RenameSubject {
  sid: string;
  file: FileEntry;
  oldName: string;
  dir: string;
  windowsStyle: boolean;
}

interface SyncSide {
  sid: string;
  path: string;
  name: string;
}

interface SyncPair {
  local: SyncSide;
  remote: SyncSide;
}

interface DiffState {
  leftSid: string;
  leftPath: string;
  rightSid: string;
  rightPath: string;
  map: Record<string, string>;
}

export const App: React.FC = () => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  // Saved sites & active sessions
  const [savedSites, setSavedSites, savedSitesRef] = useRefState<ConnectionConfig[]>([]);
  const [sessions, setSessions, sessionsRef] = useRefState<ActiveSession[]>([INITIAL_LOCAL_SESSION]);
  const [localHome, setLocalHome, localHomeRef] = useRefState<string>('');
  const [isDualPane, setIsDualPane] = useState<boolean>(true);

  // Pane session state (refs give the value "right now" to async flows)
  const [leftPaneSessionIds, setLeftPaneSessionIds, leftIdsRef] = useRefState<string[]>([LOCAL_ID]);
  const [rightPaneSessionIds, setRightPaneSessionIds, rightIdsRef] = useRefState<string[]>([LOCAL_ID]);
  const [leftActiveSessionId, setLeftActiveSessionId, leftActiveRef] = useRefState<string>(LOCAL_ID);
  const [rightActiveSessionId, setRightActiveSessionId, rightActiveRef] = useRefState<string>(LOCAL_ID);
  const [focusedPane, setFocusedPane, focusedPaneRef] = useRefState<PaneId>('left');
  const [, setNewSessionTargetPane, newSessionTargetRef] = useRefState<PaneId>('right');

  // Left pane
  const [leftPath, setLeftPath, leftPathRef] = useRefState<string>('');
  const [leftFiles, setLeftFiles] = useState<FileEntry[]>([]);
  const [leftLoading, setLeftLoading] = useState<boolean>(true);
  const [selectedLeft, setSelectedLeft, selectedLeftRef] = useRefState<string[]>([]);
  const leftReqRef = useRef(0);
  const leftShownRef = useRef<string>('');

  // Right pane
  const [rightPath, setRightPath, rightPathRef] = useRefState<string>('');
  const [rightFiles, setRightFiles] = useState<FileEntry[]>([]);
  const [rightLoading, setRightLoading] = useState<boolean>(true);
  const [selectedRight, setSelectedRight, selectedRightRef] = useRefState<string[]>([]);
  const rightReqRef = useRef(0);
  const rightShownRef = useRef<string>('');

  /*
   * `shownRef` (per pane) is the session whose listing the pane's path, files and selection belong
   * to. It differs from the active session while a pane switches tabs and the new folder is still
   * loading; pane-relative actions are refused until both match (see paneSwitching).
   */

  /** Last folder each pane showed for each session (so switching tabs returns to it). */
  const panePathMemoryRef = useRef<Record<PaneId, Record<string, string>>>({ left: {}, right: {} });

  const panes = useMemo(
    () => ({
      left: {
        idsRef: leftIdsRef,
        setIds: setLeftPaneSessionIds,
        activeRef: leftActiveRef,
        setActive: setLeftActiveSessionId,
        pathRef: leftPathRef,
        setPath: setLeftPath,
        setFiles: setLeftFiles,
        setLoading: setLeftLoading,
        selectedRef: selectedLeftRef,
        setSelected: setSelectedLeft,
        reqRef: leftReqRef,
        shownRef: leftShownRef,
      },
      right: {
        idsRef: rightIdsRef,
        setIds: setRightPaneSessionIds,
        activeRef: rightActiveRef,
        setActive: setRightActiveSessionId,
        pathRef: rightPathRef,
        setPath: setRightPath,
        setFiles: setRightFiles,
        setLoading: setRightLoading,
        selectedRef: selectedRightRef,
        setSelected: setSelectedRight,
        reqRef: rightReqRef,
        shownRef: rightShownRef,
      },
    }),
    [] // refs and setters are stable
  );

  // Advanced features
  const [syncBrowsing, setSyncBrowsing, syncBrowsingRef] = useRefState<boolean>(false);
  const [continuousSync, setContinuousSync] = useState<boolean>(false);
  const [diffState, setDiffState] = useState<DiffState | null>(null);

  // Modals
  const [isSiteManagerOpen, setIsSiteManagerOpen] = useState<boolean>(false);
  const [isSyncOpen, setIsSyncOpen] = useState<boolean>(false);
  const [syncPair, setSyncPair] = useState<SyncPair | null>(null);
  const [isRemoteCommandOpen, setIsRemoteCommandOpen] = useState<boolean>(false);
  const [remoteCommandCwd, setRemoteCommandCwd] = useState<string>('');
  const [isActionsOpen, setIsActionsOpen] = useState<boolean>(false);
  const [studioInit, setStudioInit] = useState<{ actionId?: string; paths?: string[] } | null>(null);
  const [isMcpOpen, setIsMcpOpen] = useState<boolean>(false);
  const [isFindFilesOpen, setIsFindFilesOpen] = useState<boolean>(false);
  const [isScriptConsoleOpen, setIsScriptConsoleOpen] = useState<boolean>(false);
  const [scriptConsoleMounted, setScriptConsoleMounted] = useState<boolean>(false);
  const [isGenerateCodeOpen, setIsGenerateCodeOpen] = useState<boolean>(false);
  const [isServerInfoOpen, setIsServerInfoOpen] = useState<boolean>(false);
  const [isVirtualDiskOpen, setIsVirtualDiskOpen] = useState<boolean>(false);
  const [isAiModalOpen, setIsAiModalOpen] = useState<boolean>(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState<boolean>(false);
  const [symlinkData, setSymlinkData] = useState<{ isOpen: boolean; targetPath?: string; sessionId: string; currentDir: string }>({
    isOpen: false,
    sessionId: LOCAL_ID,
    currentDir: '',
  });
  /** Pane each tool was opened for; the tool shows that pane's session, path, files and selection together. */
  const [toolPanes, setToolPanes] = useState<Record<ToolKey, PaneId>>({
    find: 'left',
    script: 'left',
    generate: 'left',
    serverInfo: 'left',
    studio: 'left',
    ai: 'left',
    marketplace: 'left',
    trash: 'left',
    virtualDisk: 'left',
    remoteCommand: 'left',
  });

  // Multi-tab editor (kept mounted after the first open so its tabs and unsaved edits survive closing)
  const [editingFile, setEditingFile] = useState<{
    name: string;
    path: string;
    content: string;
    isRemote: boolean;
    sessionId: string;
  } | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState<boolean>(false);
  const [editorMounted, setEditorMounted] = useState<boolean>(false);

  // Marketplace, trash, settings, about
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isAboutOpen, setIsAboutOpen] = useState<boolean>(false);
  // Connection sharing: the connection being shared, and the .rustscp files waiting to be opened
  // (null: the user asked to pick one). One file is shown at a time.
  const [shareSource, setShareSource] = useState<ShareSource | null>(null);
  const [shareFiles, setShareFiles] = useState<Array<ShareFile | null>>([]);
  const [isMarketplaceOpen, setIsMarketplaceOpen] = useState<boolean>(false);
  const [isRemoteTrashOpen, setIsRemoteTrashOpen] = useState<boolean>(false);
  const [remoteTrashEnabled, setRemoteTrashEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('rustscp_remote_trash_enabled') === 'true';
    } catch {
      return false;
    }
  });
  const [rememberLastRemoteDir, setRememberLastRemoteDir] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('rustscp_remember_last_remote_dir');
      return saved === null ? true : saved === 'true'; // on by default
    } catch {
      return true;
    }
  });

  const handleToggleRememberLastRemoteDir = (enabled: boolean) => {
    setRememberLastRemoteDir(enabled);
    try {
      localStorage.setItem('rustscp_remember_last_remote_dir', String(enabled));
    } catch {
      // ignore
    }
  };

  // ---- Remembered remote folders: in memory, capped, written to localStorage with a debounce ----
  const lastPathsRef = useRef<Record<string, string> | null>(null);
  const lastPathsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readLastPaths = (): Record<string, string> => {
    if (!lastPathsRef.current) {
      try {
        const raw = localStorage.getItem(LAST_PATHS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        lastPathsRef.current = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        lastPathsRef.current = {};
      }
    }
    return lastPathsRef.current!;
  };

  const flushLastPaths = () => {
    if (lastPathsTimerRef.current) {
      clearTimeout(lastPathsTimerRef.current);
      lastPathsTimerRef.current = null;
    }
    if (!lastPathsRef.current) return;
    try {
      localStorage.setItem(LAST_PATHS_KEY, JSON.stringify(lastPathsRef.current));
    } catch (e) {
      console.error('Failed to save last remote paths:', e);
    }
  };

  const getRemoteConnectionKey = (cfg: ConnectionConfig): string => `${cfg.protocol}://${cfg.username}@${cfg.host}:${cfg.port}`;

  /** Saved sites are keyed by their id; quick connections by protocol/user/host/port. */
  const lastPathKey = (cfg: ConnectionConfig): string =>
    cfg.id && cfg.id !== 'quick-connect' && savedSitesRef.current.some((s) => s.id === cfg.id) ? cfg.id : getRemoteConnectionKey(cfg);

  const saveLastRemotePath = (cfg: ConnectionConfig, path: string) => {
    if (!cfg || cfg.protocol === 'local' || !path || path.trim() === '') return;
    const map = readLastPaths();
    const key = lastPathKey(cfg);
    if (map[key] === path) return;
    delete map[key];
    map[key] = path; // re-inserted at the end = most recently used
    const keys = Object.keys(map);
    if (keys.length > LAST_PATHS_MAX) {
      for (const k of keys.slice(0, keys.length - LAST_PATHS_MAX)) delete map[k];
    }
    if (lastPathsTimerRef.current) clearTimeout(lastPathsTimerRef.current);
    lastPathsTimerRef.current = setTimeout(flushLastPaths, 800);
  };

  const getLastRemotePath = (cfg: ConnectionConfig): string | null => {
    if (!cfg || cfg.protocol === 'local') return null;
    const map = readLastPaths();
    if (cfg.id && map[cfg.id]) return map[cfg.id];
    const composite = map[getRemoteConnectionKey(cfg)];
    return composite || null;
  };

  const [externalEditorCmd, setExternalEditorCmd] = useState<string>(() => {
    try {
      return localStorage.getItem('rustscp_external_editor_command') || '';
    } catch {
      return '';
    }
  });
  // Open files (Edit / F4 / double-click) in the external editor instead of the built-in one
  const [preferExternalEditor, setPreferExternalEditor] = useState<boolean>(() => {
    try {
      return localStorage.getItem('rustscp_prefer_external_editor') === 'true';
    } catch {
      return false;
    }
  });
  const [remoteSystemInfo, setRemoteSystemInfo] = useState<RemoteSystemInfo | null>(null);

  // In-app dialogs (WKWebView may ignore window.confirm/prompt)
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    subMessage?: string;
    items?: string[];
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'info';
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const [inputDialog, setInputDialog] = useState<{
    isOpen: boolean;
    title: string;
    message?: string;
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: (val: string) => void | Promise<void>;
  } | null>(null);

  // Stable close handlers: an inline function here would re-run the dialogs' focus effects on every render
  const pendingConfirmRef = useRef<((ok: boolean) => void) | null>(null);
  const closeConfirmDialog = useCallback(() => {
    const pending = pendingConfirmRef.current;
    pendingConfirmRef.current = null;
    setConfirmDialog(null);
    pending?.(false);
  }, []);
  /** Shows the in-app confirm dialog and resolves true only if the user confirms. */
  const askConfirm = useCallback(
    (opts: { title: string; message: string; items?: string[]; confirmText: string; cancelText: string; variant?: 'danger' | 'warning' | 'info' }) =>
      new Promise<boolean>((resolve) => {
        pendingConfirmRef.current?.(false);
        pendingConfirmRef.current = resolve;
        setConfirmDialog({
          isOpen: true,
          ...opts,
          onConfirm: () => {
            pendingConfirmRef.current = null;
            setConfirmDialog(null);
            resolve(true);
          },
        });
      }),
    []
  );
  const closeInputDialog = useCallback(() => setInputDialog(null), []);

  // Compression modal
  const [compressionModalState, setCompressionModalState] = useState<{
    isOpen: boolean;
    mode: 'compress' | 'extract';
    sessionId: string;
    currentDir: string;
    targetItems: string[];
    archivePath: string;
    isRemote: boolean;
  }>({
    isOpen: false,
    mode: 'compress',
    sessionId: LOCAL_ID,
    currentDir: '/',
    targetItems: [],
    archivePath: '',
    isRemote: false,
  });

  // Properties & checksum: the file plus the session it came from
  const [propertiesTarget, setPropertiesTarget] = useState<FileTarget | null>(null);
  const [checksumTarget, setChecksumTarget] = useState<FileTarget | null>(null);

  // Catalogs & stats
  const [actionsCatalog, setActionsCatalog] = useState<ActionDefinition[]>([]);
  const [mcpStatus, setMcpStatus] = useState<McpStatusInfo | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditEvent[]>([]);

  // Clipboard & transfer queue
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [queueTasks, setQueueTasks] = useState<QueueTransferTask[]>([]);
  const [isTransferDrawerOpen, setIsTransferDrawerOpen] = useState<boolean>(false);

  // Theme (System, Dark, Light)
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);

  useEffect(() => {
    applyTheme(themeMode);
    const unwatch = initThemeWatcher((newMode) => {
      applyTheme(newMode);
    });
    return unwatch;
  }, [themeMode]);

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
    saveTheme(mode);
  };

  // ---------------------------------------------------------------------------------------------
  // Session helpers
  // ---------------------------------------------------------------------------------------------
  const sessionById = (id: string) => sessionsRef.current.find((s) => s.id === id);
  const isRemoteSession = (id: string) => {
    const s = sessionById(id);
    return !!s && s.config.protocol !== 'local';
  };
  const defaultPathFor = (sid: string) => (isRemoteSession(sid) ? '/' : localHomeRef.current || '/');
  const rememberedPath = (pane: PaneId, sid: string) =>
    panePathMemoryRef.current[pane][sid] || sessionById(sid)?.currentPath || defaultPathFor(sid);

  const updateSessionPath = (sid: string, path: string) => {
    const sess = sessionById(sid);
    if (!sess) return;
    if (sess.currentPath !== path) {
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, currentPath: path } : s)));
    }
    if (sess.config.protocol !== 'local') saveLastRemotePath(sess.config, path);
  };

  const clearPane = (pane: PaneId) => {
    const api = panes[pane];
    api.reqRef.current++; // drop any listing still in flight
    api.setFiles([]);
    api.setPath('');
    api.setSelected([]);
    api.setLoading(false);
    api.shownRef.current = '';
  };

  /**
   * True while `pane` has switched to another session but still holds the previous session's
   * path, files and selection (its first listing is in flight). Actions that combine the pane's
   * session with its folder or selection must not run then: they would hit the wrong server.
   */
  const paneSwitching = (pane: PaneId) => panes[pane].shownRef.current !== panes[pane].activeRef.current;

  /** Same check for actions that only carry a session id: `pane` when known, else any pane on `sid`. */
  const sessionSwitching = (sid: string, pane?: PaneId) =>
    pane ? paneSwitching(pane) : PANES.some((p) => panes[p].activeRef.current === sid && paneSwitching(p));

  /** Makes `sid` the pane's active session. A different session never inherits the old selection. */
  const switchPaneSession = (pane: PaneId, sid: string) => {
    const api = panes[pane];
    if (api.activeRef.current !== sid) api.setSelected([]);
    api.setActive(sid);
  };

  /**
   * Lists `p` into a pane. Each call takes a per-pane request number; a response is applied only
   * if no newer request was made and the pane still shows the same session, so slow listings can
   * never overwrite a newer navigation or tab switch. Returns true when `p` itself was shown.
   */
  const loadPane = async (pane: PaneId, p: string, overrideSid?: string, forceRefresh = false): Promise<boolean> => {
    const api = panes[pane];
    const req = ++api.reqRef.current;
    const sid = overrideSid !== undefined ? overrideSid : api.activeRef.current;
    const isCurrent = () => req === api.reqRef.current && sid === api.activeRef.current;

    if (!sid) {
      clearPane(pane);
      return false;
    }

    const commit = (path: string, files: FileEntry[]) => {
      api.setFiles(files);
      api.setPath(path);
      api.setSelected([]);
      api.shownRef.current = sid;
      panePathMemoryRef.current[pane][sid] = path;
      updateSessionPath(sid, path);
    };

    // 1. Instant cache hit
    if (!forceRefresh) {
      const cached = directoryCache.get(sid, p);
      if (cached) {
        commit(p, cached);
        api.setLoading(false);
        return true;
      }
    }

    // 2. Cache miss or forced refresh
    api.setLoading(true);
    try {
      const files = await invokeTauri<FileEntry[]>('list_directory', {
        sessionId: sid,
        path: p,
        bypassCache: forceRefresh,
      });
      const list = Array.isArray(files) ? files : [];
      directoryCache.set(sid, p, list);
      if (!isCurrent()) return false;
      commit(p, list);
      return true;
    } catch (e) {
      console.error(`load ${pane} pane error:`, e);
      if (!isCurrent()) return false;
      // A remembered remote folder may no longer exist: fall back to the session's home or '/'
      if (p !== '/' && isRemoteSession(sid)) {
        try {
          const fallback = await invokeTauri<string>('get_session_default_path', { sessionId: sid }).catch(() => '/');
          const fallbackPath = fallback || '/';
          if (!isCurrent()) return false;
          if (fallbackPath !== p) {
            const fallbackFiles = await invokeTauri<FileEntry[]>('list_directory', {
              sessionId: sid,
              path: fallbackPath,
              bypassCache: true,
            });
            directoryCache.set(sid, fallbackPath, fallbackFiles);
            if (!isCurrent()) return false;
            commit(fallbackPath, fallbackFiles);
            return false;
          }
        } catch (_fallbackErr) {
          // report the original error below
        }
      }
      if (!isCurrent()) return false;
      // The pane switched session but nothing of it could be listed: drop the previous session's
      // listing instead of leaving it under the new tab (refresh retries `p`).
      if (api.shownRef.current !== sid) {
        api.setFiles([]);
        api.setPath(p);
        api.setSelected([]);
        api.shownRef.current = sid;
        panePathMemoryRef.current[pane][sid] = p;
      }
      notify.error(tr('Não foi possível abrir a pasta', 'Could not open folder'), `${p}\n${errText(e)}`);
      return false;
    } finally {
      if (req === api.reqRef.current) api.setLoading(false);
    }
  };

  const refreshPane = (pane: PaneId) => {
    const api = panes[pane];
    const sid = api.activeRef.current;
    if (!sid) return Promise.resolve(false);
    // Mid-switch the pane's path is still the previous session's: reload the new session's folder
    const path = paneSwitching(pane) ? rememberedPath(pane, sid) : api.pathRef.current;
    directoryCache.invalidate(sid, path);
    return loadPane(pane, path, sid, true);
  };

  /**
   * After an operation on `sid`, invalidates the given folders and reloads every pane that shows
   * that session (only panes showing one of `dirs`, when given). Never touches other sessions.
   */
  const refreshSession = async (sid: string, dirs?: string[]) => {
    if (!sid) return;
    for (const d of dirs ?? []) directoryCache.invalidate(sid, d);
    const jobs: Array<Promise<boolean>> = [];
    for (const pane of PANES) {
      const api = panes[pane];
      // A pane still switching to `sid` has the previous session's path; its own listing is in flight
      if (api.activeRef.current !== sid || paneSwitching(pane)) continue;
      const cur = api.pathRef.current;
      if (dirs && dirs.length > 0 && !dirs.some((d) => samePath(d, cur))) continue;
      directoryCache.invalidate(sid, cur);
      jobs.push(loadPane(pane, cur, sid, true));
    }
    await Promise.all(jobs);
  };

  // ---------------------------------------------------------------------------------------------
  // Mount: saved sites, actions, MCP status, vault health, live-sync state, local home + both panes
  // ---------------------------------------------------------------------------------------------
  const loadActionsCatalog = async () => {
    try {
      const all = await invokeTauri<ActionDefinition[]>('manage_custom_actions', { action: 'list' });
      if (Array.isArray(all) && all.length > 0) {
        setActionsCatalog(all);
        return;
      }
    } catch (_e) {
      // fall back to the built-in catalog
    }
    try {
      const catalog = await invokeTauri<ActionDefinition[]>('get_actions_catalog');
      setActionsCatalog(Array.isArray(catalog) ? catalog : []);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    invokeTauri<ConnectionConfig[]>('get_saved_sites')
      .then((sites) => {
        if (Array.isArray(sites) && sites.length > 0) setSavedSites(sites);
      })
      .catch(console.error);

    loadActionsCatalog();

    invokeTauri<McpStatusInfo>('get_mcp_status')
      .then(setMcpStatus)
      .catch(console.error);

    invokeTauri<VaultSecurityInfo>('get_vault_security_info')
      .then((info) => {
        if (info && info.load_error) {
          const details = info.backup_path
            ? tr(
                `O arquivo do cofre foi preservado em ${info.backup_path}. Detalhes: ${info.load_error}`,
                `The vault file was kept at ${info.backup_path}. Details: ${info.load_error}`
              )
            : info.load_error;
          notify.warning(tr('Não foi possível ler as conexões salvas', 'Saved connections could not be loaded'), details, { sticky: true });
        }
      })
      .catch(() => {});

    invokeTauri<boolean>('is_continuous_sync_running')
      .then((running) => setContinuousSync(running === true))
      .catch(() => {});

    invokeTauri<string>('get_session_default_path', { sessionId: LOCAL_ID })
      .then((p) => (typeof p === 'string' && p ? p : '/'))
      .catch(() => '/')
      .then((home) => {
        setLocalHome(home);
        setSessions((prev) => prev.map((s) => (s.id === LOCAL_ID && !s.currentPath ? { ...s, currentPath: home } : s)));
        loadPane('left', home, LOCAL_ID);
        loadPane('right', home, LOCAL_ID);
      });
  }, []);

  const setMcpGatewayEnabled = useCallback(
    (enabled: boolean) => invokeTauri<McpStatusInfo>('set_mcp_gateway_enabled', { enabled }).then(setMcpStatus),
    []
  );

  // MCP status and audit log are refreshed while the gateway modal is open
  useEffect(() => {
    if (!isMcpOpen) return;
    let cancelled = false;
    const fetchMcp = () => {
      invokeTauri<McpStatusInfo>('get_mcp_status')
        .then((s) => !cancelled && setMcpStatus(s))
        .catch(console.error);
      invokeTauri<AuditEvent[]>('get_mcp_audit_logs', { limit: 50 })
        .then((logs) => !cancelled && setAuditLogs(Array.isArray(logs) ? logs : []))
        .catch(console.error);
    };
    fetchMcp();
    const timer = setInterval(fetchMcp, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isMcpOpen]);

  // ---------------------------------------------------------------------------------------------
  // Transfer queue polling: adaptive cadence, no state update when nothing changed, and a refresh
  // of the exact destination/source folders of every newly finished task.
  // ---------------------------------------------------------------------------------------------
  const queueSnapshotRef = useRef<string>('[]');
  const pollQueueNowRef = useRef<() => void>(() => {});
  const seenFinishedRef = useRef<Set<string> | null>(null);
  const paneRefreshRef = useRef<(finished: QueueTransferTask[]) => void>(() => {});
  paneRefreshRef.current = (finished) => {
    // Each changed item (the transferred path, and the source of a move) once per session
    const items = new Map<string, { sid: string; path: string; dir: string }>();
    const add = (sid: string, path: string) => {
      if (sid && path) items.set(`${sid}\u0000${path}`, { sid, path, dir: dirname(path) });
    };
    for (const t of finished) {
      add(t.dest_session, t.dest_path);
      if (t.is_move) add(t.source_session, t.source_path);
    }
    const targets = Array.from(items.values());
    const invalidatedDirs = new Set<string>();
    for (const tg of targets) {
      // The item's folder, plus everything cached below a transferred folder
      directoryCache.invalidate(tg.sid, tg.dir);
      directoryCache.invalidateTree(tg.sid, tg.path);
      // The backend keeps its own listing cache (5 min) that the queue never clears: without this,
      // the next visit to a folder no pane shows right now would get the pre-transfer listing.
      const key = `${tg.sid}\u0000${tg.dir}`;
      if (!invalidatedDirs.has(key)) {
        invalidatedDirs.add(key);
        invokeTauri('invalidate_directory_cache', { sessionId: tg.sid, path: tg.dir }).catch(() => {});
      }
    }
    for (const pane of PANES) {
      const api = panes[pane];
      const sid = api.activeRef.current;
      const cur = api.pathRef.current;
      if (sid && !paneSwitching(pane) && targets.some((tg) => tg.sid === sid && samePath(tg.dir, cur))) {
        loadPane(pane, cur, sid, true);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let rerun = false;
    // Exactly one pending timer at any time, so "poll now" requests never start parallel chains
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, ms);
    };

    const poll = async () => {
      if (inFlight) {
        rerun = true;
        return;
      }
      inFlight = true;
      timer = undefined;
      let busy = false;
      try {
        const tasks = await invokeTauri<QueueTransferTask[]>('get_transfer_queue_tasks');
        if (!cancelled && Array.isArray(tasks)) {
          const snapshot = JSON.stringify(tasks);
          if (snapshot !== queueSnapshotRef.current) {
            queueSnapshotRef.current = snapshot;
            setQueueTasks(tasks);
          }
          busy = tasks.some((t) => t.status === 'in_progress' || t.status === 'queued');

          const finished = tasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled');
          if (seenFinishedRef.current === null) {
            seenFinishedRef.current = new Set(finished.map((t) => t.id));
          } else {
            const seen = seenFinishedRef.current;
            const fresh = finished.filter((t) => !seen.has(t.id));
            const present = new Set(tasks.map((t) => t.id));
            for (const id of Array.from(seen)) if (!present.has(id)) seen.delete(id);
            for (const t of fresh) seen.add(t.id);
            const changed = fresh.filter((t) => t.status !== 'cancelled' || t.transferred_bytes > 0);
            if (changed.length > 0) paneRefreshRef.current(changed);
          }
        }
      } catch (_e) {
        // ignore
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      if (rerun) {
        rerun = false;
        schedule(150);
      } else {
        schedule(busy ? 700 : document.hidden ? 5000 : 2500);
      }
    };

    pollQueueNowRef.current = () => schedule(150);
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const openTransferDrawer = () => {
    setIsTransferDrawerOpen(true);
    pollQueueNowRef.current();
  };

  // ---------------------------------------------------------------------------------------------
  // Pane contexts: one explicit model for every tool
  // ---------------------------------------------------------------------------------------------
  const ctxOf = (pane: PaneId): PaneCtx => {
    const sid = pane === 'left' ? leftActiveSessionId : rightActiveSessionId;
    const session = sessions.find((s) => s.id === sid);
    return {
      pane,
      sessionId: sid,
      session,
      name: session?.config.name || '',
      path: pane === 'left' ? leftPath : rightPath,
      files: pane === 'left' ? leftFiles : rightFiles,
      selection: pane === 'left' ? selectedLeft : selectedRight,
      isRemote: !!session && session.config.protocol !== 'local',
    };
  };

  /** Servers reached over SSH can run shell commands (remote trash, command tools, marketplace). */
  const hasShell = (sid: string) => {
    const proto = sessionById(sid)?.config.protocol;
    return proto === 'sftp' || proto === 'scp';
  };

  /** chmod works on SSH servers and this computer; S3 and FTP(S) sessions have no Unix permissions here. */
  const supportsPermissions = (sid: string) => {
    const proto = sessionById(sid)?.config.protocol;
    return proto !== 's3' && proto !== 'ftp' && proto !== 'ftps';
  };

  /**
   * 'focused': the focused pane. 'remote' / 'shell': the focused pane if it shows a server (an SSH
   * server for 'shell'), otherwise the other pane if that one does, otherwise the focused pane.
   * An explicit pane always wins. Session, path, files and selection are then all read from it.
   */
  const pickPane = (kind: 'focused' | 'remote' | 'shell', explicit?: PaneId): PaneId => {
    if (explicit) return explicit;
    const f = focusedPaneRef.current;
    if (kind === 'focused') return f;
    const fits = kind === 'shell' ? hasShell : isRemoteSession;
    if (fits(panes[f].activeRef.current)) return f;
    const o = otherPane(f);
    if (fits(panes[o].activeRef.current)) return o;
    return f;
  };

  const openTool = (key: ToolKey, kind: 'focused' | 'remote' | 'shell', explicit?: PaneId, requireShell = false): PaneId | null => {
    const pane = pickPane(kind, explicit);
    const sid = panes[pane].activeRef.current;
    if (requireShell && !hasShell(sid)) {
      notify.info(
        isRemoteSession(sid)
          ? tr('Esta conexão não oferece um shell', 'This connection has no shell')
          : tr('Conecte-se a um servidor primeiro', 'Connect to a server first'),
        tr('Esta ferramenta executa comandos em um servidor SSH (SFTP).', 'This tool runs commands on an SSH (SFTP) server.')
      );
      return null;
    }
    setToolPanes((prev) => (prev[key] === pane ? prev : { ...prev, [key]: pane }));
    return pane;
  };

  /** Folder of this computer to pair with a tool opened for `pane`. */
  const localSidePath = (pane: PaneId): string => {
    const o = ctxOf(otherPane(pane));
    if (o.sessionId && !o.isRemote) return o.path;
    const s = ctxOf(pane);
    if (s.sessionId && !s.isRemote) return s.path;
    return localHome;
  };

  const openFindFiles = (pane?: PaneId) => {
    if (openTool('find', 'focused', pane) !== null) setIsFindFilesOpen(true);
  };
  const openServerInfo = (pane?: PaneId) => {
    if (openTool('serverInfo', 'focused', pane) !== null) setIsServerInfoOpen(true);
  };
  const openGenerateCode = (pane?: PaneId) => {
    if (openTool('generate', 'remote', pane) !== null) setIsGenerateCodeOpen(true);
  };
  const openScriptConsole = (pane?: PaneId) => {
    if (openTool('script', 'remote', pane) !== null) {
      setScriptConsoleMounted(true);
      setIsScriptConsoleOpen(true);
    }
  };
  const openAiAssistant = (pane?: PaneId) => {
    if (openTool('ai', 'remote', pane) !== null) setIsAiModalOpen(true);
  };
  const openCommandStudio = (pane?: PaneId, init?: { actionId?: string; paths?: string[] }) => {
    if (openTool('studio', 'shell', pane) === null) return;
    setStudioInit(init ?? null);
    setIsActionsOpen(true);
  };
  const openVirtualDisk = () => {
    if (openTool('virtualDisk', 'remote') !== null) setIsVirtualDiskOpen(true);
  };
  const openTrash = (pane?: PaneId) => {
    if (openTool('trash', 'shell', pane, true) !== null) setIsRemoteTrashOpen(true);
  };
  const openRemoteCommand = (pane?: PaneId, cwd?: string) => {
    const p = openTool('remoteCommand', 'shell', pane, true);
    if (p === null) return;
    setRemoteCommandCwd(cwd ?? panes[p].pathRef.current);
    setIsRemoteCommandOpen(true);
  };
  const openMarketplace = (pane?: PaneId) => {
    const p = openTool('marketplace', 'shell', pane);
    if (p === null) return;
    setIsMarketplaceOpen(true);
    handleDetectRemoteSystem(panes[p].activeRef.current);
  };
  const openSiteManager = (pane?: PaneId) => {
    setNewSessionTargetPane(pane ?? focusedPaneRef.current);
    setIsSiteManagerOpen(true);
  };

  // ---------------------------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------------------------
  const handleNavigate = async (pane: PaneId, newPath: string) => {
    // Mid-switch, the old path belongs to the previous session: there is no move to mirror
    const oldPath = paneSwitching(pane) ? '' : panes[pane].pathRef.current;
    const ok = await loadPane(pane, newPath);
    if (!ok || !oldPath || !syncBrowsingRef.current) return;
    // Synchronized browsing: mirror the same relative move (segment based) in the other pane
    const move = relativeMove(oldPath, newPath);
    if (!move || (move.up === 0 && move.down.length === 0)) return;
    const o = otherPane(pane);
    if (!panes[o].activeRef.current) return;
    const target = applyRelativeMove(panes[o].pathRef.current, move);
    if (target) loadPane(o, target);
  };

  const handleSelectSession = async (pane: PaneId, id: string) => {
    switchPaneSession(pane, id);
    setFocusedPane(pane);
    await loadPane(pane, rememberedPath(pane, id), id);
  };

  const handleGoHome = async (pane: PaneId) => {
    const sid = panes[pane].activeRef.current;
    if (!sid) return;
    try {
      const p = await invokeTauri<string>('get_session_default_path', { sessionId: sid });
      if (p && panes[pane].activeRef.current === sid) handleNavigate(pane, p);
    } catch (e) {
      notify.error(tr('Não foi possível abrir a pasta inicial', 'Could not open the home folder'), e);
    }
  };

  /** Explorer mode: shows a session, preferring the pane that already holds it. */
  const showSessionInExplorer = (id: string) => {
    const f = focusedPaneRef.current;
    if (panes[f].idsRef.current.includes(id)) return handleSelectSession(f, id);
    const o = otherPane(f);
    if (panes[o].idsRef.current.includes(id)) return handleSelectSession(o, id);
    panes[f].setIds([...panes[f].idsRef.current, id]);
    return handleSelectSession(f, id);
  };

  /** Opens a folder of this computer in the visible/focused pane (switching it to the local tab). */
  const openLocalFolder = (path: string) => {
    if (!path) return;
    const isLocal = (sid: string) => !!sid && !isRemoteSession(sid) && !!sessionById(sid);
    const f = focusedPaneRef.current;
    const pane = isLocal(panes[f].activeRef.current) ? f : isLocal(panes[otherPane(f)].activeRef.current) && !isDualPane ? otherPane(f) : f;
    const api = panes[pane];
    if (!isLocal(api.activeRef.current)) {
      if (!api.idsRef.current.includes(LOCAL_ID)) api.setIds([...api.idsRef.current, LOCAL_ID]);
      switchPaneSession(pane, LOCAL_ID);
    }
    setFocusedPane(pane);
    loadPane(pane, path, api.activeRef.current);
  };

  // ---------------------------------------------------------------------------------------------
  // Tabs: close, move, reorder, disconnect
  // ---------------------------------------------------------------------------------------------
  /** Removes a tab from a pane. Only when it was the visible tab does the pane switch (to a neighbour). */
  const removeFromPane = (pane: PaneId, id: string) => {
    const api = panes[pane];
    const prev = api.idsRef.current;
    const idx = prev.indexOf(id);
    if (idx < 0) return;
    const next = prev.filter((x) => x !== id);
    api.setIds(next);
    const wasActive = api.activeRef.current === id;
    delete panePathMemoryRef.current[pane][id];
    if (!wasActive) return;
    const fallback = next[idx] ?? next[idx - 1] ?? '';
    switchPaneSession(pane, fallback);
    if (fallback) loadPane(pane, rememberedPath(pane, fallback), fallback);
    else clearPane(pane);
  };

  const disconnectSession = async (id: string) => {
    if (id === LOCAL_ID) return;
    directoryCache.invalidateSession(id);
    const target = sessionById(id);
    if (target && target.config.protocol !== 'local' && target.currentPath) {
      saveLastRemotePath(target.config, target.currentPath);
    }
    for (const pane of PANES) removeFromPane(pane, id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setClipboard((c) => (c && c.sourceSession === id ? null : c));
    setDiffState((d) => (d && (d.leftSid === id || d.rightSid === id) ? null : d));
    try {
      await invokeTauri('disconnect_session', { sessionId: id });
    } catch (e) {
      console.error('disconnect_session error:', e);
    }
  };

  const handleCloseSession = async (pane: PaneId, id: string) => {
    if (id === LOCAL_ID) return;
    removeFromPane(pane, id);
    if (!panes[otherPane(pane)].idsRef.current.includes(id)) {
      await disconnectSession(id);
    }
  };

  /** Explorer mode tab strip: closing a tab closes the session in both panes. */
  const closeSessionEverywhere = async (id: string) => {
    if (id === LOCAL_ID) return;
    await disconnectSession(id);
  };

  const handleReorderTabs = (pane: PaneId, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const api = panes[pane];
    const updated = [...api.idsRef.current];
    const [moved] = updated.splice(fromIndex, 1);
    if (!moved) return;
    const insertIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
    updated.splice(Math.max(0, Math.min(insertIndex, updated.length)), 0, moved);
    api.setIds(updated);
  };

  const handleMoveTabBetweenPanes = (sessionId: string, sourcePane: PaneId, targetPane: PaneId, targetIndex?: number) => {
    if (sourcePane === targetPane || !sessionId) return;
    const src = panes[sourcePane];
    const dst = panes[targetPane];
    if (!src.idsRef.current.includes(sessionId)) return; // stale drag
    const path = rememberedPath(sourcePane, sessionId);
    removeFromPane(sourcePane, sessionId);

    const filtered = dst.idsRef.current.filter((id) => id !== sessionId);
    const insertAt = targetIndex !== undefined && targetIndex >= 0 ? Math.min(targetIndex, filtered.length) : filtered.length;
    filtered.splice(insertAt, 0, sessionId);
    dst.setIds(filtered);
    switchPaneSession(targetPane, sessionId);
    setFocusedPane(targetPane);
    loadPane(targetPane, path, sessionId);
  };

  // ---------------------------------------------------------------------------------------------
  // Compare, sync and live sync
  // ---------------------------------------------------------------------------------------------
  const sideOf = (pane: PaneId): SyncSide => {
    const sid = panes[pane].activeRef.current;
    return { sid, path: panes[pane].pathRef.current, name: sessionById(sid)?.config.name || sid };
  };

  /** One pane on this computer and the other on a server, or null. */
  const getSyncPair = (): SyncPair | null => {
    const l = sideOf('left');
    const r = sideOf('right');
    if (!l.sid || !r.sid) return null;
    const lr = isRemoteSession(l.sid);
    const rr = isRemoteSession(r.sid);
    if (!lr && rr) return { local: l, remote: r };
    if (lr && !rr) return { local: r, remote: l };
    return null;
  };

  const notifyNeedPair = () =>
    notify.info(
      tr('Abra este computador em um painel e um servidor no outro', 'Open this computer in one pane and a server in the other'),
      tr('A sincronização precisa de uma pasta local e uma remota.', 'Syncing needs one local folder and one remote folder.')
    );

  const handleCompareDirectories = async () => {
    const l = sideOf('left');
    const r = sideOf('right');
    if (!l.sid || !r.sid) {
      notify.info(tr('Abra uma pasta em cada painel para comparar', 'Open a folder in each pane to compare'));
      return;
    }
    // The backend labels its sides local/remote; keep a local pane on the local side when there is one
    const swap = isRemoteSession(l.sid) && !isRemoteSession(r.sid);
    const a = swap ? r : l;
    const b = swap ? l : r;
    try {
      const diffs = await invokeTauri<Array<{ name: string; diff_type: string }>>('compare_directories_fast', {
        localSession: a.sid,
        localDir: a.path,
        remoteSession: b.sid,
        remoteDir: b.path,
        mode: 'both',
      });
      const map: Record<string, string> = {};
      // The backend also lists names that match on both sides ('identical', e.g. every shared folder)
      for (const d of Array.isArray(diffs) ? diffs : []) if (d.diff_type !== 'identical') map[d.name] = d.diff_type;
      setDiffState({ leftSid: l.sid, leftPath: l.path, rightSid: r.sid, rightPath: r.path, map });
      const n = Object.keys(map).length;
      if (n === 0) notify.success(tr('As pastas são iguais', 'The folders match'));
      else notify.info(tr(`${n} diferença(s) encontrada(s)`, `${n} difference(s) found`), tr('Os itens diferentes estão marcados nos dois painéis.', 'Differing items are marked in both panes.'));
    } catch (e) {
      notify.error(tr('Não foi possível comparar as pastas', 'Could not compare the folders'), e);
    }
  };

  // Compare badges only apply while both panes still show the compared folders
  const activeDiffMap = useMemo(() => {
    if (!diffState) return undefined;
    if (diffState.leftSid !== leftActiveSessionId || diffState.rightSid !== rightActiveSessionId) return undefined;
    if (!samePath(diffState.leftPath, leftPath) || !samePath(diffState.rightPath, rightPath)) return undefined;
    return diffState.map;
  }, [diffState, leftActiveSessionId, rightActiveSessionId, leftPath, rightPath]);

  const refreshContinuousSyncState = () => {
    invokeTauri<boolean>('is_continuous_sync_running')
      .then((running) => setContinuousSync(running === true))
      .catch(() => {});
  };

  const handleToggleContinuousSync = async () => {
    if (continuousSync) {
      try {
        await invokeTauri('stop_continuous_sync');
        setContinuousSync(false);
      } catch (e) {
        notify.error(tr('Não foi possível parar a sincronização contínua', 'Could not stop continuous sync'), e);
      }
      refreshContinuousSyncState();
      return;
    }
    const pair = getSyncPair();
    if (!pair) {
      notifyNeedPair();
      return;
    }
    setConfirmDialog({
      isOpen: true,
      title: tr('Manter o servidor atualizado?', 'Keep the server up to date?'),
      message: tr(
        `Alterações em ${pair.local.path} neste computador serão enviadas automaticamente para ${pair.remote.name}:${pair.remote.path}.`,
        `Changes in ${pair.local.path} on this computer will be uploaded automatically to ${pair.remote.name}:${pair.remote.path}.`
      ),
      subMessage: tr(
        'Arquivos novos e alterados são enviados até você desligar. Nada é excluído no servidor.',
        'New and changed files are uploaded until you turn this off. Nothing is deleted on the server.'
      ),
      confirmText: tr('Iniciar', 'Start'),
      cancelText: tr('Cancelar', 'Cancel'),
      variant: 'warning',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await invokeTauri('start_continuous_sync', {
            localPath: pair.local.path,
            remoteSession: pair.remote.sid,
            remotePath: pair.remote.path,
            deleteRemote: false,
          });
          setContinuousSync(true);
        } catch (e) {
          notify.error(tr('Não foi possível iniciar a sincronização contínua', 'Could not start continuous sync'), e);
        }
        refreshContinuousSyncState();
      },
    });
  };

  const openSync = () => {
    const pair = getSyncPair();
    if (!pair) {
      notifyNeedPair();
      return;
    }
    setSyncPair(pair);
    setIsSyncOpen(true);
  };

  const executeSyncDeletes = async (pair: SyncPair, items: SyncItem[]) => {
    const remotePaths = items.filter((i) => i.action === 'delete_remote').map((i) => joinPath(pair.remote.path, i.relative_path));
    const localPaths = items.filter((i) => i.action === 'delete_local').map((i) => joinPath(pair.local.path, i.relative_path));
    const failures: string[] = [];
    if (remotePaths.length > 0) {
      try {
        if (remoteTrashEnabled && hasShell(pair.remote.sid)) {
          await invokeTauri('manage_remote_trash', {
            sessionId: pair.remote.sid,
            action: 'move_to_trash',
            targetPath: remotePaths[0],
            payload: JSON.stringify(remotePaths),
          });
        } else {
          await invokeTauri('delete_items', { sessionId: pair.remote.sid, paths: remotePaths });
        }
        for (const p of remotePaths) directoryCache.invalidateTree(pair.remote.sid, p);
      } catch (e) {
        failures.push(`${pair.remote.name}: ${errText(e)}`);
      }
    }
    if (localPaths.length > 0) {
      try {
        await invokeTauri('delete_items', { sessionId: pair.local.sid, paths: localPaths });
        for (const p of localPaths) directoryCache.invalidateTree(pair.local.sid, p);
      } catch (e) {
        failures.push(`${tr('Este computador', 'This computer')}: ${errText(e)}`);
      }
    }
    if (failures.length > 0) {
      notify.error(tr('Algumas exclusões falharam', 'Some deletions failed'), failures.join('\n'));
    } else {
      const toTrash = remotePaths.length > 0 && remoteTrashEnabled && hasShell(pair.remote.sid);
      const parts = [
        remotePaths.length > 0
          ? toTrash
            ? tr(`${remotePaths.length} movido(s) para a lixeira remota de ${pair.remote.name}`, `${remotePaths.length} moved to the remote trash on ${pair.remote.name}`)
            : tr(`${remotePaths.length} excluído(s) em ${pair.remote.name}`, `${remotePaths.length} deleted on ${pair.remote.name}`)
          : '',
        localPaths.length > 0 ? tr(`${localPaths.length} excluído(s) neste computador`, `${localPaths.length} deleted on this computer`) : '',
      ].filter(Boolean);
      notify.success(tr('Itens removidos do destino', 'Items removed at the destination'), parts.join(' · '));
    }
    await Promise.all([refreshSession(pair.remote.sid), refreshSession(pair.local.sid)]);
  };

  /**
   * A recursive plan lists files only (`js/app.js`), and a single-file transfer does not create
   * missing parent folders on every server (FTP rejects the upload). Creates the server folders
   * the uploads need first. mkdir is recursive and a no-op for existing folders, so the deepest
   * folders are enough. S3 has no real folders, and local writes create their parents.
   */
  const createSyncUploadFolders = async (pair: SyncPair, plan: SyncItem[]) => {
    if (sessionById(pair.remote.sid)?.config.protocol === 's3') return;
    const dirs = new Set<string>();
    for (const item of plan) {
      if (item.action !== 'upload') continue;
      const parent = dirname(joinPath(pair.remote.path, item.relative_path));
      if (parent && !samePath(parent, pair.remote.path)) dirs.add(parent);
    }
    const all = Array.from(dirs);
    const deepest = all.filter((d) => !all.some((o) => o !== d && isInside(o, d)));
    for (const d of deepest) {
      try {
        await invokeTauri('create_new_directory', { sessionId: pair.remote.sid, path: d });
      } catch (_e) {
        // already there, or the uploads into it fail and show in the transfer drawer
      }
    }
  };

  const handleExecuteSync = async (plan: SyncItem[]) => {
    const pair = syncPair;
    if (!pair) return;
    let queued = 0;
    const failures: string[] = [];
    await createSyncUploadFolders(pair, plan);
    for (const item of plan) {
      const localFile = joinPath(pair.local.path, item.relative_path);
      const remoteFile = joinPath(pair.remote.path, item.relative_path);
      try {
        if (item.action === 'upload') {
          await invokeTauri('enqueue_transfer', {
            sourceSession: pair.local.sid,
            sourcePath: localFile,
            destSession: pair.remote.sid,
            destPath: remoteFile,
            isMove: false,
          });
          queued++;
        } else if (item.action === 'download') {
          await invokeTauri('enqueue_transfer', {
            sourceSession: pair.remote.sid,
            sourcePath: remoteFile,
            destSession: pair.local.sid,
            destPath: localFile,
            isMove: false,
          });
          queued++;
        }
      } catch (e) {
        failures.push(`${item.relative_path}: ${errText(e)}`);
      }
    }
    if (queued > 0) openTransferDrawer();
    if (failures.length > 0) {
      notify.error(tr('Alguns itens não foram enfileirados', 'Some items could not be queued'), failures.slice(0, 6).join('\n'));
    }

    // Mirror deletions: SyncDialog already asked (counts and item list, Cancel by default), so
    // they run now; the result toast says whether server items went to the remote trash.
    const deletes = plan.filter((i) => i.action === 'delete_remote' || i.action === 'delete_local');
    if (deletes.length > 0) await executeSyncDeletes(pair, deletes);
  };

  // ---------------------------------------------------------------------------------------------
  // File actions (each one receives the session id of the pane the file came from)
  // ---------------------------------------------------------------------------------------------
  const sessionForPane = (sessionId?: string, pane?: PaneId) =>
    sessionId || panes[pane ?? focusedPaneRef.current].activeRef.current;

  const handleCalculateDirectorySize = async (file: FileEntry, sessionId?: string, pane?: PaneId) => {
    const sid = sessionForPane(sessionId, pane);
    if (!sid) return;
    try {
      const sizeBytes = await invokeTauri<number>('calculate_directory_size', { sessionId: sid, path: file.path });
      notify.info(file.name, `${formatBytes(sizeBytes)} (${Number(sizeBytes).toLocaleString()} bytes)`);
    } catch (e) {
      notify.error(tr('Erro ao calcular tamanho', 'Could not calculate size'), e);
    }
  };

  const handleOpenExternal = async (path: string, sessionId?: string) => {
    const sid = sessionId || editingFile?.sessionId || LOCAL_ID;
    try {
      await invokeTauri('open_in_external_editor', {
        path,
        editorCmd: externalEditorCmd.trim() || undefined,
        sessionId: sid,
      });
      if (isRemoteSession(sid)) {
        notify.info(
          tr('Aberto no editor externo', 'Opened in the external editor'),
          tr('É uma cópia temporária: ao salvar, as alterações são enviadas para o servidor.', 'This is a temporary copy: saved changes are uploaded to the server.')
        );
      }
    } catch (e) {
      notify.error(tr('Não foi possível abrir o editor externo', 'Could not open the external editor'), e);
    }
  };

  const offerExternalEditor = (kind: 'tooLarge' | 'binary', name: string, path: string, sessionId: string, bytes?: number) => {
    setConfirmDialog({
      isOpen: true,
      title:
        kind === 'tooLarge'
          ? tr('Arquivo grande demais para o editor', 'File is too large for the editor')
          : tr('Este arquivo não parece ser texto', 'This file doesn’t look like text'),
      message:
        kind === 'tooLarge'
          ? tr(
              `${name}${bytes ? ` tem ${formatBytes(bytes)}` : ' é muito grande'}. O editor integrado abre arquivos de até ${formatBytes(EDITOR_MAX_BYTES)}.`,
              `${name}${bytes ? ` is ${formatBytes(bytes)}` : ' is too large'}. The built-in editor opens files up to ${formatBytes(EDITOR_MAX_BYTES)}.`
            )
          : tr(
              `${name} parece ser um arquivo binário e poderia ser corrompido se fosse editado como texto.`,
              `${name} looks like a binary file and could be corrupted if it were edited as text.`
            ),
      confirmText: tr('Abrir no editor externo', 'Open in external editor'),
      cancelText: tr('Cancelar', 'Cancel'),
      variant: 'info',
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleOpenExternal(path, sessionId);
      },
    });
  };

  /** Opens a file in the built-in editor after the size/binary checks; links to folders navigate instead. */
  const openInEditor = async (file: Pick<FileEntry, 'name' | 'path'> & Partial<FileEntry>, sessionId: string, pane?: PaneId) => {
    if (!sessionId) return;
    if (file.file_type === 'directory') {
      if (pane) handleNavigate(pane, file.path);
      return;
    }
    if (file.file_type === 'symlink' && pane) {
      try {
        const entries = await invokeTauri<FileEntry[]>('list_directory', { sessionId, path: file.path });
        if (Array.isArray(entries)) {
          handleNavigate(pane, file.path);
          return;
        }
      } catch (_e) {
        // not a folder: open it as a file
      }
    }
    if (typeof file.size === 'number' && file.size > EDITOR_MAX_BYTES) {
      offerExternalEditor('tooLarge', file.name, file.path, sessionId, file.size);
      return;
    }
    if (isLikelyBinaryName(file.name)) {
      offerExternalEditor('binary', file.name, file.path, sessionId);
      return;
    }
    try {
      const content = await invokeTauri<string>('read_file_content', { sessionId, path: file.path });
      setEditingFile({
        name: file.name,
        path: file.path,
        content: typeof content === 'string' ? content : '',
        isRemote: isRemoteSession(sessionId),
        sessionId,
      });
      setEditorMounted(true);
      setIsEditorOpen(true);
    } catch (e) {
      const msg = errText(e);
      const tooLarge = /RUSTSCP_E_TOO_LARGE(?::(\d+))?/.exec(msg);
      if (tooLarge) {
        offerExternalEditor('tooLarge', file.name, file.path, sessionId, tooLarge[1] ? Number(tooLarge[1]) : file.size);
      } else if (msg.includes('RUSTSCP_E_BINARY')) {
        offerExternalEditor('binary', file.name, file.path, sessionId);
      } else {
        notify.error(tr('Erro ao ler arquivo', 'Could not read file'), e);
      }
    }
  };

  const handleEditFile = (file: FileEntry, sessionId?: string, pane?: PaneId) => {
    const sid = sessionForPane(sessionId, pane);
    if (sessionSwitching(sid, pane)) return;
    if (preferExternalEditor && file.file_type !== 'directory' && sid) {
      handleOpenExternal(file.path, sid);
      return;
    }
    openInEditor(file, sid, pane);
  };

  const handleEditorSave = async (path: string, content: string, sessionId: string) => {
    await invokeTauri('write_file_content', { sessionId, path, content });
    directoryCache.invalidate(sessionId, path);
    await refreshSession(sessionId, [dirname(path)]);
  };

  // --- Native terminal / terminal here ---
  const handleOpenNativeTerminal = async (path: string, _isRemote?: boolean, sessionId?: string, pane?: PaneId) => {
    const sid = sessionForPane(sessionId, pane);
    if (!sid) return;
    try {
      await invokeTauri('open_native_terminal', { sessionId: sid, path, isRemote: isRemoteSession(sid) });
    } catch (e) {
      notify.error(tr('Erro ao abrir o terminal', 'Could not open terminal'), e);
    }
  };

  /** Built-in terminal on the SSH server of `pane` (the focused SSH pane by default), in `path`. */
  const openBuiltinTerminal = (pane?: PaneId, path?: string, sessionId?: string) => {
    const p = pickPane('shell', pane);
    const sid = sessionId ?? panes[p].activeRef.current;
    if (!hasShell(sid)) {
      notify.info(
        isRemoteSession(sid) ? tr('Esta conexão não oferece um shell', 'This connection has no shell') : tr('Conecte-se a um servidor SSH primeiro', 'Connect to an SSH server first'),
        tr('O terminal integrado abre um shell em um servidor SSH (SFTP).', 'The built-in terminal opens a shell on an SSH (SFTP) server.')
      );
      return;
    }
    const cfg = sessionById(sid)?.config;
    void openTerminal({
      sessionId: sid,
      path: path ?? (panes[p].activeRef.current === sid ? panes[p].pathRef.current : rememberedPath(p, sid)),
      title: cfg?.name || (cfg ? `${cfg.username}@${cfg.host}` : tr('Servidor', 'Server')),
      host: cfg?.host,
      username: cfg?.username,
    });
  };

  /** Shows a server folder (a terminal's current folder) in the file pane that has that session. */
  const showRemoteFolder = (sid: string, path: string) => {
    if (!sessionById(sid)) {
      notify.info(tr('Esta conexão foi fechada nos arquivos', 'This connection was closed in the file panes'), tr('Conecte-se de novo para ver a pasta.', 'Connect again to see the folder.'));
      return;
    }
    const f = focusedPaneRef.current;
    const pane = panes[f].idsRef.current.includes(sid) ? f : isDualPane && panes[otherPane(f)].idsRef.current.includes(sid) ? otherPane(f) : f;
    const api = panes[pane];
    if (!api.idsRef.current.includes(sid)) api.setIds([...api.idsRef.current, sid]);
    switchPaneSession(pane, sid);
    setFocusedPane(pane);
    void loadPane(pane, path, sid);
  };

  const handleOpenTerminalHere = (path: string, isRemote: boolean, sessionId?: string, pane?: PaneId) => {
    const sid = sessionForPane(sessionId, pane);
    if (isRemote && isRemoteSession(sid)) {
      openBuiltinTerminal(pane, path, sid);
    } else {
      handleOpenNativeTerminal(path, false, sid, pane);
    }
  };

  // --- Remote trash ---
  const handleMoveToTrash = async (sessionId: string, paths: string[]) => {
    if (!paths || paths.length === 0) return;
    try {
      await invokeTauri('manage_remote_trash', {
        sessionId,
        action: 'move_to_trash',
        targetPath: paths[0],
        payload: JSON.stringify(paths),
      });
      for (const p of paths) directoryCache.invalidateTree(sessionId, p);
      await refreshSession(sessionId);
    } catch (e) {
      notify.error(tr('Erro ao mover para a lixeira', 'Could not move to trash'), e);
    }
  };

  const confirmMoveToTrash = (sessionId: string, paths: string[]) => {
    if (!paths || paths.length === 0) return;
    const count = paths.length;
    setConfirmDialog({
      isOpen: true,
      title: tr('Mover para a lixeira remota', 'Move to remote trash'),
      message: tr(`Mover ${count} item(ns) para a lixeira remota?`, `Move ${count} item(s) to the remote trash?`),
      subMessage: tr('Você pode restaurá-los depois em Lixeira remota.', 'You can restore them later from Remote trash.'),
      items: paths,
      confirmText: tr('Mover para a lixeira', 'Move to trash'),
      cancelText: tr('Cancelar', 'Cancel'),
      variant: 'warning',
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleMoveToTrash(sessionId, paths);
      },
    });
  };

  // --- Delete (remote quick delete rm -rf / safe trash / local) ---
  const handleDeleteItems = (sessionId: string, paths: string[], currentDir: string, forcePermanent = false) => {
    if (!sessionId || !paths || paths.length === 0) return;
    const isRemote = isRemoteSession(sessionId);
    const trashAvailable = isRemote && hasShell(sessionId);
    const count = paths.length;

    if (trashAvailable && remoteTrashEnabled && !forcePermanent) {
      confirmMoveToTrash(sessionId, paths);
      return;
    }

    let title: string;
    let message: string;
    let subMessage: string;
    if (isRemote) {
      const how = trashAvailable ? ' (rm -rf)' : '';
      if (!remoteTrashEnabled || !trashAvailable) {
        title = tr('Excluir permanentemente?', 'Delete permanently?');
        message = tr(
          `${count} item(ns) serão excluídos permanentemente no servidor${how}. ${
            remoteTrashEnabled ? 'Esta conexão não oferece a lixeira remota.' : 'A lixeira remota está desativada nas configurações.'
          }`,
          `${count} item(s) will be deleted permanently on the server${how}. ${
            remoteTrashEnabled ? 'This connection does not support the remote trash.' : 'Remote trash is turned off in Settings.'
          }`
        );
      } else {
        title = tr('Excluir permanentemente, sem a lixeira?', 'Delete permanently, skipping the trash?');
        message = tr(`${count} item(ns) serão excluídos permanentemente no servidor${how}.`, `${count} item(s) will be deleted permanently on the server${how}.`);
      }
      subMessage = tr('Esta ação não pode ser desfeita.', 'This cannot be undone.');
    } else {
      title = tr('Excluir permanentemente?', 'Delete permanently?');
      message = tr(`${count} item(ns) serão excluídos permanentemente deste computador.`, `${count} item(s) will be deleted permanently from this computer.`);
      subMessage = tr('Esta ação não pode ser desfeita.', 'This cannot be undone.');
    }

    setConfirmDialog({
      isOpen: true,
      title,
      message,
      subMessage,
      items: paths,
      confirmText: tr('Excluir permanentemente', 'Delete permanently'),
      cancelText: tr('Cancelar', 'Cancel'),
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await invokeTauri('delete_items', { sessionId, paths });
          for (const p of paths) directoryCache.invalidateTree(sessionId, p);
          directoryCache.invalidate(sessionId, currentDir);
          setClipboard((c) => (c && c.sourceSession === sessionId && c.paths.some((p) => paths.includes(p)) ? null : c));
          await refreshSession(sessionId);
        } catch (e) {
          notify.error(tr('Erro ao excluir', 'Delete failed'), e);
          refreshSession(sessionId);
        }
      },
    });
  };

  const handleDeleteInPane = (pane: PaneId, targetPaths?: string[], forcePermanent?: boolean) => {
    if (paneSwitching(pane)) return;
    const api = panes[pane];
    const paths = Array.isArray(targetPaths) && targetPaths.length > 0 ? targetPaths : api.selectedRef.current;
    handleDeleteItems(api.activeRef.current, paths, api.pathRef.current, forcePermanent);
  };

  const handleNewFolder = (pane: PaneId) => {
    const sid = panes[pane].activeRef.current;
    const dir = panes[pane].pathRef.current;
    if (!sid || paneSwitching(pane)) return;
    setInputDialog({
      isOpen: true,
      title: tr('Nova pasta', 'New folder'),
      message: tr('Nome da nova pasta:', 'Name of the new folder:'),
      placeholder: tr('nova-pasta', 'new-folder'),
      confirmText: tr('Criar', 'Create'),
      cancelText: tr('Cancelar', 'Cancel'),
      onConfirm: async (name) => {
        setInputDialog(null);
        const clean = (name || '').trim();
        if (!clean) return;
        try {
          await invokeTauri('create_new_directory', { sessionId: sid, path: joinPath(dir, clean) });
          await refreshSession(sid, [dir]);
        } catch (e) {
          notify.error(tr('Erro ao criar pasta', 'Could not create folder'), e);
        }
      },
    });
  };

  /** Why `name` cannot be used as a new file name in a folder (null when it can). */
  const renameProblem = (name: string, windowsStyle: boolean): string | null => {
    if (!name) return tr('Digite um nome.', 'Enter a name.');
    if (name === '.' || name === '..') return tr('“.” e “..” são nomes reservados.', '“.” and “..” are reserved names.');
    if (name.includes('/') || (windowsStyle && name.includes('\\'))) {
      return windowsStyle ? tr('O nome não pode conter / ou \\.', 'The name can’t contain / or \\.') : tr('O nome não pode conter /.', 'The name can’t contain /.');
    }
    if (name.includes('\0')) return tr('O nome contém um caractere inválido.', 'The name contains an invalid character.');
    if (windowsStyle && /[<>:"|?*]/.test(name)) return tr('O nome não pode conter < > : " | ? *', 'The name can’t contain < > : " | ? *');
    return null;
  };

  /** The rename subject for `file`, or null when it cannot be renamed now ('.', '..', a pane mid-switch). */
  const renameSubjectOf = (file: FileEntry, sessionId?: string, pane?: PaneId, currentDir?: string): RenameSubject | null => {
    const sid = sessionForPane(sessionId, pane);
    if (!sid || !file?.path || sessionSwitching(sid, pane)) return null;
    const oldName = file.name || basename(file.path);
    if (!oldName || oldName === '.' || oldName === '..') return null;
    const dir = dirname(file.path) || currentDir || (pane ? panes[pane].pathRef.current : '');
    if (!dir) return null;
    const windowsStyle = !isRemoteSession(sid) && (detectSep(dir) === '\\' || /^[A-Za-z]:/.test(dir));
    return { sid, file, oldName, dir, windowsStyle };
  };

  /**
   * Checks a new name before renaming: the naming rules, and never another item's name (local and
   * S3 renames would overwrite it silently). 'invalid' means the name must be fixed (a toast says why).
   */
  const checkRenameName = async (rs: RenameSubject, name: string): Promise<'invalid' | 'unchanged' | { target: string }> => {
    const problem = renameProblem(name, rs.windowsStyle);
    if (problem) {
      notify.warning(tr('Nome inválido', 'Invalid name'), problem);
      return 'invalid';
    }
    if (name === rs.oldName) return 'unchanged';
    const target = joinPath(rs.dir, name);
    // A case-only change ("readme" -> "README") is the same item on case-insensitive disks.
    if (name.toLowerCase() !== rs.oldName.toLowerCase()) {
      let exists = (directoryCache.get(rs.sid, rs.dir) ?? []).some((f) => f.name === name);
      if (!exists) {
        try {
          const meta = await invokeTauri<FileEntry>('get_file_properties', { sessionId: rs.sid, path: target });
          exists = !!meta && typeof meta.name === 'string' && meta.name !== '';
        } catch (_e) {
          // not found: the name is free
        }
      }
      if (exists) {
        notify.warning(tr('Já existe um item com esse nome', 'An item with that name already exists'), `${name}\n${tr('Escolha outro nome.', 'Choose another name.')}`);
        return 'invalid';
      }
    }
    return { target };
  };

  /**
   * Renames through `rename_item`, then refreshes the folder and keeps the renamed item selected.
   * `onSettled` runs as soon as the rename itself finished (success or failure). False on failure
   * (an error toast was shown).
   */
  const applyRename = async (rs: RenameSubject, name: string, target: string, onSettled?: () => void): Promise<boolean> => {
    const { sid, file, dir } = rs;
    try {
      await invokeTauri('rename_item', { sessionId: sid, from: file.path, to: target });
    } catch (e) {
      onSettled?.();
      notify.error(tr('Não foi possível renomear', 'Could not rename'), e);
      return false;
    }
    onSettled?.();
    // Paths below the old name are gone: drop them from the cache and the clipboard
    directoryCache.invalidateTree(sid, file.path);
    setClipboard((c) =>
      c && c.sourceSession === sid && c.paths.some((p) => samePath(p, file.path) || isInside(p, file.path)) ? null : c
    );
    await refreshSession(sid, [dir]);
    // Keep the renamed item selected in the pane(s) showing that folder
    const renamed = (directoryCache.get(sid, dir) ?? []).find((f) => f.name === name)?.path;
    if (renamed) {
      for (const p of PANES) {
        const api = panes[p];
        if (api.activeRef.current === sid && samePath(api.pathRef.current, dir)) api.setSelected([renamed]);
      }
    }
    return true;
  };

  /**
   * Rename in place in a file list (F2, context menu, slow second click): same checks as the
   * dialog. Resolves false only when the name must be fixed (the field stays open).
   */
  const handleRenameInline = async (file: FileEntry, newName: string, sessionId?: string, pane?: PaneId, currentDir?: string): Promise<boolean> => {
    const rs = renameSubjectOf(file, sessionId, pane, currentDir);
    if (!rs) return true;
    const name = (newName || '').trim();
    const check = await checkRenameName(rs, name);
    if (check === 'invalid') return false;
    if (check === 'unchanged') return true;
    await applyRename(rs, name, check.target);
    return true;
  };

  /** Rename in a dialog prefilled with the current name, stem selected (used where inline renaming is not possible). */
  const handleRenameFile = (file: FileEntry, sessionId?: string, pane?: PaneId, currentDir?: string) => {
    const rs = renameSubjectOf(file, sessionId, pane, currentDir);
    if (!rs) return;
    const { oldName } = rs;
    // Select the name without its extension (like Finder); folders and dotfiles select everything
    const dot = file.file_type === 'directory' ? -1 : oldName.lastIndexOf('.');
    const stemLength = dot > 0 ? dot : oldName.length;

    setInputDialog({
      isOpen: true,
      title: tr('Renomear', 'Rename'),
      message: tr(`Novo nome para ${oldName}:`, `New name for ${oldName}:`),
      defaultValue: oldName,
      placeholder: oldName,
      confirmText: tr('Renomear', 'Rename'),
      cancelText: tr('Cancelar', 'Cancel'),
      onConfirm: async (value) => {
        const name = (value || '').trim();
        const check = await checkRenameName(rs, name);
        if (check === 'invalid') return; // the dialog stays open to fix it
        if (check === 'unchanged') {
          setInputDialog(null);
          return;
        }
        await applyRename(rs, name, check.target, () => setInputDialog(null));
      },
    });

    // The dialog selects the whole value when it opens; narrow that to the stem afterwards.
    if (stemLength < oldName.length) {
      setTimeout(() => {
        const el = document.activeElement;
        if (el instanceof HTMLInputElement && el.value === oldName && el.selectionStart === 0 && el.selectionEnd === oldName.length) {
          el.setSelectionRange(0, stemLength);
        }
      }, 120);
    }
  };

  const handleGetTrashStatus = async (): Promise<{ status: RemoteTrashStatus; items: RemoteTrashItem[] }> => {
    const sid = panes[toolPanes.trash].activeRef.current;
    const res = await invokeTauri<RemoteTrashResponse>('manage_remote_trash', { sessionId: sid, action: 'list' });
    return { status: res?.status, items: Array.isArray(res?.items) ? res.items : [] };
  };

  const handleSetupTrash = async () => {
    await invokeTauri('manage_remote_trash', { sessionId: panes[toolPanes.trash].activeRef.current, action: 'setup' });
  };

  const handleRestoreTrashItem = async (itemId: string) => {
    const sid = panes[toolPanes.trash].activeRef.current;
    await invokeTauri('manage_remote_trash', { sessionId: sid, action: 'restore', payload: itemId });
    directoryCache.invalidateSession(sid);
    await refreshSession(sid);
  };

  const handleEmptyTrash = async () => {
    await invokeTauri('manage_remote_trash', { sessionId: panes[toolPanes.trash].activeRef.current, action: 'empty' });
  };

  const handleToggleRemoteTrash = (enabled: boolean) => {
    setRemoteTrashEnabled(enabled);
    try {
      localStorage.setItem('rustscp_remote_trash_enabled', enabled ? 'true' : 'false');
    } catch {
      // ignore
    }
  };

  const handleTogglePreferExternalEditor = (enabled: boolean) => {
    setPreferExternalEditor(enabled);
    try {
      localStorage.setItem('rustscp_prefer_external_editor', String(enabled));
    } catch {
      // ignore
    }
  };

  const handleSaveExternalEditorCmd = (cmd: string) => {
    setExternalEditorCmd(cmd);
    try {
      localStorage.setItem('rustscp_external_editor_command', cmd);
    } catch {
      // ignore
    }
  };

  // --- SysAdmin marketplace & remote probing ---
  const handleDetectRemoteSystem = async (sid?: string) => {
    const target = sid ?? panes[toolPanes.marketplace].activeRef.current;
    if (!target || !hasShell(target)) {
      setRemoteSystemInfo(null);
      return;
    }
    try {
      const info = await invokeTauri<RemoteSystemInfo>('detect_remote_system', { sessionId: target });
      setRemoteSystemInfo(info);
    } catch (e) {
      console.error('Failed to probe remote system:', e);
    }
  };

  const handleInstallMarketplaceTool = async (toolId: string) =>
    await invokeTauri<{ stdout: string; stderr: string; exit_code: number }>('install_marketplace_tool', {
      sessionId: panes[toolPanes.marketplace].activeRef.current,
      toolId,
    });

  const handleCheckTool = async (checkCmd: string): Promise<boolean> => {
    try {
      const res = await invokeTauri<{ exit_code: number }>('execute_remote_command', {
        sessionId: panes[toolPanes.marketplace].activeRef.current,
        command: checkCmd,
      });
      return res.exit_code === 0;
    } catch (_e) {
      return false;
    }
  };

  // --- Compression ---
  const handleRequestCompress = (sessionId: string, currentDir: string, targetItems: string[]) => {
    if (sessionSwitching(sessionId)) return;
    setCompressionModalState({
      isOpen: true,
      mode: 'compress',
      sessionId,
      currentDir,
      targetItems,
      archivePath: '',
      isRemote: isRemoteSession(sessionId),
    });
  };

  const handleRequestExtract = (sessionId: string, currentDir: string, archivePath: string) => {
    if (sessionSwitching(sessionId)) return;
    setCompressionModalState({
      isOpen: true,
      mode: 'extract',
      sessionId,
      currentDir,
      targetItems: [],
      archivePath,
      isRemote: isRemoteSession(sessionId),
    });
  };

  // --- Custom actions (Command Studio) ---
  const handleSaveCustomAction = async (action: ActionDefinition) => {
    const all = await invokeTauri<ActionDefinition[]>('manage_custom_actions', {
      action: 'save',
      actionJson: JSON.stringify(action),
    });
    if (Array.isArray(all) && all.length > 0) setActionsCatalog(all);
    else await loadActionsCatalog();
  };

  const handleDeleteCustomAction = async (actionId: string) => {
    const all = await invokeTauri<ActionDefinition[]>('manage_custom_actions', {
      action: 'delete',
      actionJson: actionId,
    });
    if (Array.isArray(all) && all.length > 0) setActionsCatalog(all);
    else await loadActionsCatalog();
  };

  // ---------------------------------------------------------------------------------------------
  // Transfers
  // ---------------------------------------------------------------------------------------------
  /** Same session: `src` dropped into `destDir` would land on itself or inside itself. */
  const isSelfTransfer = (src: string, destDir: string) => {
    const dst = joinPath(destDir, basename(src));
    return samePath(src, dst) || samePath(src, destDir) || isInside(destDir, src);
  };

  const notifySkippedSelf = (skipped: number) =>
    notify.info(
      tr(`${skipped} item(ns) ignorado(s)`, `Skipped ${skipped} item(s)`),
      tr(
        'O destino é a própria origem (ou fica dentro dela). Para copiar na mesma pasta, use Duplicar.',
        'The destination is the source itself (or inside it). To copy within the same folder, use Duplicate.'
      )
    );

  /**
   * Queues copies/moves of `paths` into `destDir`. Items whose destination is the source itself
   * (same session and same folder) or lies inside the source folder are skipped: the worker would
   * otherwise truncate or delete the file.
   */
  const enqueueTransfers = async (paths: string[], sourceSession: string, destSession: string, destDir: string, isMove: boolean) => {
    if (!paths || paths.length === 0 || !sourceSession || !destSession) return 0;
    let skipped = 0;
    let queued = 0;
    const failures: string[] = [];
    for (const src of paths) {
      const dst = joinPath(destDir, basename(src));
      if (sourceSession === destSession && isSelfTransfer(src, destDir)) {
        skipped++;
        continue;
      }
      try {
        await invokeTauri('enqueue_transfer', {
          sourceSession,
          sourcePath: src,
          destSession,
          destPath: dst,
          isMove,
        });
        queued++;
      } catch (e) {
        failures.push(`${basename(src)}: ${errText(e)}`);
      }
    }
    if (skipped > 0) notifySkippedSelf(skipped);
    if (failures.length > 0) {
      notify.error(tr('Algumas transferências não foram enfileiradas', 'Some transfers could not be queued'), failures.slice(0, 6).join('\n'));
    }
    if (queued > 0) openTransferDrawer();
    return queued;
  };

  /**
   * Move inside one session through `move_items`: renames, instant, no data copied. Same guards as
   * the queue (never onto or into itself). `move_items` never replaces anything, so names that
   * already exist in `destDir` (the user confirmed Replace in the pane or for F6 first) keep the
   * queue's replace semantics, and so do items on another disk. Returns how many items were moved
   * or queued.
   */
  const moveWithinSession = async (sid: string, paths: string[], destDir: string): Promise<number> => {
    if (!sid || !paths || paths.length === 0 || !destDir) return 0;
    const candidates = paths.filter((src) => !isSelfTransfer(src, destDir));
    if (candidates.length < paths.length) notifySkippedSelf(paths.length - candidates.length);
    if (candidates.length === 0) return 0;

    let existing: Set<string> | null = null;
    try {
      const list = await invokeTauri<FileEntry[]>('list_directory', { sessionId: sid, path: destDir, bypassCache: true });
      existing = new Set((Array.isArray(list) ? list : []).map((f) => f.name));
    } catch (_e) {
      existing = null;
    }
    // The destination cannot be listed: the queue handles (and reports) it, as before
    if (!existing) return enqueueTransfers(candidates, sid, sid, destDir, true);
    const taken = existing;
    const replacing = candidates.filter((p) => taken.has(basename(p)));
    const renames = candidates.filter((p) => !taken.has(basename(p)));

    let count = 0;
    if (renames.length > 0) {
      let touched = true;
      try {
        const moved = await invokeTauri<string[]>('move_items', { sessionId: sid, sources: renames, destDir });
        count += Array.isArray(moved) ? moved.length : renames.length;
      } catch (e) {
        const msg = errText(e);
        if (msg.startsWith('RUSTSCP_E_CROSS_DEVICE') || /\bmove_items\b.*\bnot found\b/i.test(msg)) {
          // Another disk (a rename cannot cross it), or an older backend: copy, then delete, in the queue
          touched = false;
          count += await enqueueTransfers(renames, sid, sid, destDir, true);
        } else {
          // Nothing is ever replaced; items moved before the error stay moved (the message says how many)
          notify.error(tr('Não foi possível mover', 'Could not move'), msg.replace(/^RUSTSCP_E_[A-Z_]+:\s*/, ''));
        }
      }
      if (touched) {
        // Moved items (and everything cached below a moved folder) left their folders
        for (const p of renames) directoryCache.invalidateTree(sid, p);
        setClipboard((c) =>
          c && c.sourceSession === sid && c.paths.some((p) => renames.some((r) => samePath(p, r) || isInside(p, r))) ? null : c
        );
        await refreshSession(sid, [destDir, ...Array.from(new Set(renames.map((p) => dirname(p))))]);
      }
    }
    if (replacing.length > 0) count += await enqueueTransfers(replacing, sid, sid, destDir, true);
    return count;
  };

  /**
   * F5 / arrow buttons (copy) and F6 (move) from one pane into the other pane's folder. F5/F6 are
   * confirmed by the pane itself (DualPane gives it the destination label), so nothing is asked here.
   * Between sessions a move removes each source only after its copy finished (transfer queue);
   * inside one session it is a rename (moveWithinSession).
   */
  const handleTransferToOtherPane = (from: PaneId, isMove: boolean) => {
    const src = panes[from];
    const dst = panes[otherPane(from)];
    const paths = src.selectedRef.current;
    const srcSid = src.activeRef.current;
    const dstSid = dst.activeRef.current;
    const destDir = dst.pathRef.current;
    if (paths.length === 0 || !srcSid) return;
    if (!dstSid) {
      notify.info(tr('O outro painel não tem conexão', 'The other pane has no connection'));
      return;
    }
    // A pane mid-switch still holds the previous session's folder/selection: never mix the two
    if (paneSwitching(from) || paneSwitching(otherPane(from))) {
      notify.info(tr('A pasta ainda está abrindo', 'The folder is still opening'), tr('Tente de novo quando a lista aparecer.', 'Try again when the list appears.'));
      return;
    }
    const run = async () => {
      // F6 inside one session is a rename (instant); between sessions it goes through the queue
      const queued =
        isMove && srcSid === dstSid
          ? await moveWithinSession(srcSid, paths, destDir)
          : await enqueueTransfers(paths, srcSid, dstSid, destDir, isMove);
      // Moved items leave the source pane: do not keep them selected
      if (isMove && queued > 0 && src.activeRef.current === srcSid) {
        const moved = new Set(paths);
        src.setSelected((prev) => prev.filter((p) => !moved.has(p)));
      }
    };
    // Never replace same-named items in the destination without asking
    const existing = new Set((directoryCache.get(dstSid, destDir) || []).map((f) => f.name));
    const collisions = paths.filter((p) => existing.has(basename(p)));
    if (collisions.length === 0) {
      run();
      return;
    }
    askConfirm({
      title: tr('Substituir itens existentes?', 'Replace existing items?'),
      message: tr(
        `${collisions.length} item(ns) já existe(m) em ${destDir}. Substituir pela versão de origem?`,
        `${collisions.length} item(s) already exist in ${destDir}. Replace them with the source version?`
      ),
      items: collisions.map((p) => basename(p)),
      confirmText: tr('Substituir', 'Replace'),
      cancelText: tr('Cancelar', 'Cancel'),
      variant: 'warning',
    }).then((ok) => {
      if (ok) run();
    });
  };

  // Drops (row drags, Finder/Explorer, session tabs) after the pane's own checks (self-target, Replace/Skip)
  const handleDropItems = async (sourceSessionId: string, paths: string[], destSessionId: string, destDir: string, isCopy: boolean) => {
    if (sessionSwitching(sourceSessionId) || sessionSwitching(destSessionId)) return;
    // A move inside one session is a rename (instant); everything else goes through the queue
    if (!isCopy && sourceSessionId === destSessionId) {
      await moveWithinSession(sourceSessionId, paths, destDir);
      return;
    }
    await enqueueTransfers(paths, sourceSessionId, destSessionId, destDir, !isCopy);
  };

  // Clipboard
  const handleCopy = (sessionId: string, paths: string[]) => {
    if (!sessionSwitching(sessionId)) setClipboard({ action: 'copy', sourceSession: sessionId, paths });
  };
  const handleCut = (sessionId: string, paths: string[]) => {
    if (!sessionSwitching(sessionId)) setClipboard({ action: 'cut', sourceSession: sessionId, paths });
  };

  const handlePaste = async (destSessionId: string, destDir: string) => {
    const clip = clipboard;
    if (!clip || clip.paths.length === 0 || sessionSwitching(destSessionId)) return;
    const isCut = clip.action === 'cut';
    // Cut and paste inside one session is a rename (instant); otherwise the queue copies/moves
    const queued =
      isCut && clip.sourceSession === destSessionId
        ? await moveWithinSession(destSessionId, clip.paths, destDir)
        : await enqueueTransfers(clip.paths, clip.sourceSession, destSessionId, destDir, isCut);
    if (isCut && queued > 0) setClipboard(null);
  };

  const handleDuplicate = async (sessionId: string, path: string) => {
    if (sessionSwitching(sessionId)) return;
    try {
      await invokeTauri('duplicate_item', { sessionId, path });
      await refreshSession(sessionId, [dirname(path)]);
    } catch (e) {
      notify.error(tr('Erro ao duplicar item', 'Could not duplicate item'), e);
    }
  };

  /** Throws a readable Error on failure (CompressionModal shows it inline and stays open). */
  const runCompress = async (sessionId: string, currentDir: string, items: string[], format: string, outputName: string) => {
    try {
      await invokeTauri('compress_items', { sessionId, currentDir, items, format, outputName });
    } catch (e) {
      const msg = errText(e);
      if (!msg.startsWith('RUSTSCP_E_EXISTS')) throw new Error(msg || tr('Erro ao compactar', 'Compression failed'));
      // The archive name is taken: replace it only after an explicit confirmation
      const replace = await askConfirm({
        title: tr('Substituir o arquivo existente?', 'Replace the existing archive?'),
        message: msg.replace(/^RUSTSCP_E_EXISTS:?\s*/, ''),
        confirmText: tr('Substituir', 'Replace'),
        cancelText: tr('Cancelar', 'Cancel'),
        variant: 'warning',
      });
      if (!replace) throw new Error(tr('Já existe um arquivo com esse nome. Escolha outro nome.', 'An archive with that name already exists. Choose another name.'));
      try {
        await invokeTauri('compress_items', { sessionId, currentDir, items, format, outputName, overwrite: true });
      } catch (e2) {
        throw new Error(errText(e2) || tr('Erro ao compactar', 'Compression failed'));
      }
    }
    await refreshSession(sessionId, [currentDir]);
  };

  const runExtract = async (sessionId: string, currentDir: string, archivePath: string, destSubfolder?: string) => {
    try {
      await invokeTauri('extract_archive', { sessionId, currentDir, archivePath, destSubfolder });
    } catch (e) {
      throw new Error(errText(e) || tr('Erro ao extrair arquivo', 'Extraction failed'));
    }
    if (destSubfolder) directoryCache.invalidateTree(sessionId, joinPath(currentDir, destSubfolder));
    await refreshSession(sessionId, [currentDir]);
  };

  // Direct (no dialog) variants used by the file panes: errors become toasts
  const handleCompress = async (sessionId: string, currentDir: string, items: string[], format: string, outputName: string) => {
    if (sessionSwitching(sessionId)) return;
    try {
      await runCompress(sessionId, currentDir, items, format, outputName);
    } catch (e) {
      notify.error(tr('Erro ao compactar', 'Compression failed'), e);
    }
  };

  const handleExtract = async (sessionId: string, currentDir: string, archivePath: string, destSubfolder?: string) => {
    if (sessionSwitching(sessionId)) return;
    try {
      await runExtract(sessionId, currentDir, archivePath, destSubfolder);
    } catch (e) {
      notify.error(tr('Erro ao extrair arquivo', 'Extraction failed'), e);
    }
  };

  const handleExecuteSmartAction = (action: ActionDefinition, targetPath: string, _sessionId?: string, pane?: PaneId) => {
    openCommandStudio(pane ?? focusedPaneRef.current, { actionId: action.id, paths: [targetPath] });
  };

  const handleCancelTransferTask = async (taskId: string) => {
    try {
      await invokeTauri('cancel_transfer_task', { taskId });
    } catch (e) {
      notify.error(tr('Não foi possível cancelar', 'Could not cancel'), e);
    }
    pollQueueNowRef.current();
  };

  const handleClearCompletedTransfers = async () => {
    await invokeTauri('clear_completed_transfers');
    setQueueTasks((prev) => prev.filter((t) => t.status === 'in_progress' || t.status === 'queued'));
    pollQueueNowRef.current();
  };

  // ---------------------------------------------------------------------------------------------
  // Connect / disconnect / sites
  // ---------------------------------------------------------------------------------------------
  const handleConnect = async (cfg: ConnectionConfig, attempt?: { cancelled: boolean }, opts?: { startPath?: string }) => {
    const sessionId = await invokeTauri<string>('connect_session', { config: cfg });
    const dropIfCancelled = () => {
      if (!attempt?.cancelled) return false;
      // The user stopped the attempt while it was in flight: close the session that just opened
      if (!sessionsRef.current.some((s) => s.id === sessionId)) {
        invokeTauri('disconnect_session', { sessionId }).catch((e) => console.error('disconnect_session error:', e));
      }
      return true;
    };
    if (dropIfCancelled()) return;

    // A shared connection opens in the folder it was shared from
    let initialPath = opts?.startPath?.trim() || '';
    if (!initialPath && rememberLastRemoteDir && cfg.protocol !== 'local') {
      const lastVisited = getLastRemotePath(cfg);
      if (lastVisited && lastVisited.trim().length > 0) initialPath = lastVisited.trim();
    }
    if (!initialPath) {
      initialPath = cfg.remote_root ? cfg.remote_root.trim() : '';
      if (!initialPath || initialPath === '/' || initialPath === '.') {
        try {
          const defaultPath = await invokeTauri<string>('get_session_default_path', { sessionId });
          if (defaultPath && defaultPath !== '/') initialPath = defaultPath;
          else if (!initialPath || initialPath === '.') initialPath = '/';
        } catch (_e) {
          if (!initialPath || initialPath === '.') initialPath = '/';
        }
      }
    }
    if (dropIfCancelled()) return;

    const isNewSession = !sessionsRef.current.some((s) => s.id === sessionId);
    if (!isNewSession) {
      // Same id as an open tab (older backends reuse the site id): refresh it instead of duplicating
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, config: cfg } : s)));
    } else {
      setSessions((prev) => [...prev, { id: sessionId, config: cfg, currentPath: initialPath }]);
    }

    const pane = newSessionTargetRef.current;
    const api = panes[pane];
    let replacedPlaceholder = false;
    if (pane === 'left') {
      api.setIds(Array.from(new Set([...api.idsRef.current, sessionId])));
    } else {
      // The right pane's lone placeholder "Local" tab is replaced by the first server
      const prev = api.idsRef.current;
      const filtered = prev.filter((id) => id !== LOCAL_ID || prev.length > 1);
      replacedPlaceholder = filtered.length < prev.length;
      api.setIds(Array.from(new Set([...filtered, sessionId])));
    }
    switchPaneSession(pane, sessionId);
    setFocusedPane(pane);
    // Stopped while the first folder was loading: the dialog reports the attempt as cancelled, so
    // the tab and the connection go too, right away (a tab that already existed under this id stays).
    const cancelled = await settledOrCancelled(loadPane(pane, initialPath, sessionId), attempt);
    if (!cancelled || !isNewSession) return;
    await disconnectSession(sessionId);
    // Put back the placeholder "Local" tab this session replaced
    if (replacedPlaceholder && api.idsRef.current.length === 0) {
      api.setIds([LOCAL_ID]);
      switchPaneSession(pane, LOCAL_ID);
      loadPane(pane, rememberedPath(pane, LOCAL_ID), LOCAL_ID);
    }
  };

  const handleSaveSite = async (cfg: ConnectionConfig) => {
    await invokeTauri('save_site', { config: cfg });
    setSavedSites((prev) => [...prev.filter((s) => s.id !== cfg.id), cfg]);
  };

  const handleDeleteSite = async (id: string) => {
    await invokeTauri('delete_site', { id });
    setSavedSites((prev) => prev.filter((s) => s.id !== id));
  };

  /** Connects a site accepted from a .rustscp file (already in the vault when `saved`). */
  const handleOpenSharedSite = async (site: ConnectionConfig, startPath: string, saved: boolean) => {
    if (saved) setSavedSites((prev) => [...prev.filter((s) => s.id !== site.id), site]);
    await handleConnect(site, undefined, { startPath });
    setIsSiteManagerOpen(false);
  };

  /** Shares the remote connection of the focused pane (or the other pane), opening in its current folder. */
  const shareCurrentConnection = () => {
    const focused = focusedPaneRef.current;
    const ctx = [focused, otherPane(focused)].map(ctxOf).find((c) => c.isRemote && c.session);
    if (!ctx?.session) {
      notify.info(
        tr('Nenhuma conexão remota aberta', 'No remote connection open'),
        tr('Abra uma conexão, ou compartilhe um site salvo pelo Gerenciador de conexões.', 'Open a connection, or share a saved site from the connection manager.')
      );
      return;
    }
    const cfg = ctx.session.config;
    setShareSource({ sessionId: ctx.sessionId, name: cfg.name, host: cfg.host, username: cfg.username, startPath: ctx.path });
  };

  // .rustscp files the OS hands over (double-click, Open With, a second launch), also the one
  // that started the app: queued by the backend until this window takes them.
  // Built-in terminals run in the backend; their events are followed from the start.
  useEffect(() => {
    void initTerminalStore();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const take = () =>
      invoke<Array<{ name: string; contents: string | null; error: string | null }>>('take_pending_share_files')
        .then((files) => {
          if (disposed || !Array.isArray(files)) return;
          const ready: ShareFile[] = [];
          for (const f of files) {
            if (f.contents != null) ready.push({ name: f.name, contents: f.contents });
            else notify.error(f.name, f.error ?? undefined);
          }
          if (ready.length) setShareFiles((prev) => [...prev, ...ready]);
        })
        .catch(() => {});
    listen('share-files-pending', take)
      .then((fn) => (disposed ? fn() : unlisteners.push(fn)))
      .catch(() => {});
    take();
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Persist the last folder of every server when the window goes away
  useEffect(() => {
    const handleUnload = () => {
      sessionsRef.current.forEach((s) => {
        if (s.config.protocol !== 'local' && s.currentPath) saveLastRemotePath(s.config, s.currentPath);
      });
      flushLastPaths();
    };
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
    };
  }, []);

  // ---------------------------------------------------------------------------------------------
  // Keyboard shortcuts (Shift+F7, Shift+F2, F5 / ⌘R refresh, ⌘K, ⌘,)
  // ---------------------------------------------------------------------------------------------
  const anyModalOpen =
    isSiteManagerOpen ||
    isSyncOpen ||
    isRemoteCommandOpen ||
    isActionsOpen ||
    isMcpOpen ||
    isFindFilesOpen ||
    isScriptConsoleOpen ||
    isGenerateCodeOpen ||
    isServerInfoOpen ||
    isVirtualDiskOpen ||
    isAiModalOpen ||
    isEditorOpen ||
    isSettingsOpen ||
    isAboutOpen ||
    isMarketplaceOpen ||
    isRemoteTrashOpen ||
    symlinkData.isOpen ||
    compressionModalState.isOpen ||
    !!propertiesTarget ||
    !!checksumTarget ||
    !!confirmDialog ||
    !!inputDialog;

  const isTypingTarget = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  };
  const blockedByOverlay = () => anyModalOpen || isPaletteOpen || !!document.querySelector('[aria-modal="true"]');

  /**
   * Capture phase: app-wide shortcuts run before the panes see the key, so Shift+F7 opens Find
   * instead of also triggering the pane's F7 (new folder).
   */
  const globalKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  globalKeyRef.current = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Ctrl+` shows/hides the terminals (they keep running), Ctrl+Shift+` opens a new one.
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote') {
      if (anyModalOpen || isPaletteOpen) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) openBuiltinTerminal();
      else toggleDock();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && key === 'k') {
      if (isPaletteOpen || !anyModalOpen) {
        e.preventDefault();
        setIsPaletteOpen((o) => !o);
      }
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && key === ',') {
      if (!anyModalOpen && !isPaletteOpen) {
        e.preventDefault();
        setIsSettingsOpen(true);
      }
      return;
    }
    // F5 refreshes the focused pane unless that pane uses it to copy its selection to the other
    // pane (Commander mode with a selection). Decided here because the pane always consumes F5,
    // so the bubble-phase refresh below never sees it while a file list has focus.
    if (key === 'F5' && !mod && !e.shiftKey && !e.altKey) {
      if (isTypingTarget(e) || blockedByOverlay()) return;
      const pane = focusedPaneRef.current;
      if (isDualPane && panes[pane].selectedRef.current.length > 0) return; // the pane copies (F5)
      e.preventDefault();
      e.stopPropagation();
      refreshPane(pane);
      return;
    }
    if (!e.shiftKey || mod || e.altKey || (key !== 'F7' && key !== 'F2')) return;
    if (isTypingTarget(e) || blockedByOverlay()) return;
    e.preventDefault();
    e.stopPropagation();
    if (key === 'F7') openFindFiles();
    else handleCompareDirectories();
  };

  /** Bubble phase: ⌘R / F5 refresh when no pane used the key (F5 copy with a selection). */
  const refreshKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  refreshKeyRef.current = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // Tabs of the focused pane: ⌘/Ctrl+1…9 selects a tab, Ctrl+Tab / Ctrl+Shift+Tab cycles
    const tabIndex = mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
    const cycle = e.ctrlKey && !e.metaKey && !e.altKey && key === 'Tab' ? (e.shiftKey ? -1 : 1) : 0;
    if (tabIndex >= 0 || cycle !== 0) {
      if (e.defaultPrevented || isTypingTarget(e) || blockedByOverlay()) return;
      const pane = focusedPaneRef.current;
      const ids = panes[pane].idsRef.current;
      if (ids.length === 0) return;
      const current = ids.indexOf(panes[pane].activeRef.current);
      const nextIndex = tabIndex >= 0 ? (tabIndex === 8 ? ids.length - 1 : tabIndex) : (current + cycle + ids.length) % ids.length;
      const nextId = ids[nextIndex];
      if (!nextId) return;
      e.preventDefault();
      if (nextId !== panes[pane].activeRef.current) handleSelectSession(pane, nextId);
      return;
    }

    if (e.shiftKey || e.altKey || !(key === 'F5' || (mod && key === 'r'))) return;
    if (e.defaultPrevented || isTypingTarget(e) || blockedByOverlay()) return;
    e.preventDefault();
    refreshPane(focusedPaneRef.current);
  };

  useEffect(() => {
    const onCapture = (e: KeyboardEvent) => globalKeyRef.current(e);
    const onBubble = (e: KeyboardEvent) => refreshKeyRef.current(e);
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onBubble);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onBubble);
    };
  }, []);

  // ---------------------------------------------------------------------------------------------
  // Derived view data
  // ---------------------------------------------------------------------------------------------
  const leftCtx = ctxOf('left');
  const rightCtx = ctxOf('right');
  const focusedCtx = focusedPane === 'left' ? leftCtx : rightCtx;

  const leftSessions = useMemo(
    () => leftPaneSessionIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is ActiveSession => !!s),
    [leftPaneSessionIds, sessions]
  );
  const rightSessions = useMemo(
    () => rightPaneSessionIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is ActiveSession => !!s),
    [rightPaneSessionIds, sessions]
  );

  const findCtx = ctxOf(toolPanes.find);
  const scriptCtx = ctxOf(toolPanes.script);
  const generateCtx = ctxOf(toolPanes.generate);
  const serverInfoCtx = ctxOf(toolPanes.serverInfo);
  const studioCtx = ctxOf(toolPanes.studio);
  const aiCtx = ctxOf(toolPanes.ai);
  const marketplaceCtx = ctxOf(toolPanes.marketplace);
  const trashCtx = ctxOf(toolPanes.trash);
  const virtualDiskCtx = ctxOf(toolPanes.virtualDisk);
  const remoteCommandCtx = ctxOf(toolPanes.remoteCommand);

  // Stable callbacks for the memoized workspace (DualPane only re-renders when its data changes)
  const dp = useStableHandlers({
    toggleDualPane: () => setIsDualPane((v) => !v),
    openAi: (pane?: PaneId) => openAiAssistant(pane),
    moveTab: handleMoveTabBetweenPanes,
    reorderTabs: handleReorderTabs,
    selectLeft: (id: string) => handleSelectSession('left', id),
    selectRight: (id: string) => handleSelectSession('right', id),
    closeLeft: (id: string) => handleCloseSession('left', id),
    closeRight: (id: string) => handleCloseSession('right', id),
    newLeft: () => openSiteManager('left'),
    newRight: () => openSiteManager('right'),
    // Pane-relative actions are ignored while that pane switches session (paneSwitching): its
    // breadcrumbs, rows and folder still belong to the previous session.
    navLeft: (p: string) => {
      if (!paneSwitching('left')) handleNavigate('left', p);
    },
    navRight: (p: string) => {
      if (!paneSwitching('right')) handleNavigate('right', p);
    },
    refreshLeft: () => refreshPane('left'),
    refreshRight: () => refreshPane('right'),
    selLeft: (p: string, multi: boolean) =>
      setSelectedLeft((prev) => (multi ? (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]) : [p])),
    selRight: (p: string, multi: boolean) =>
      setSelectedRight((prev) => (multi ? (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]) : [p])),
    // Whole-selection updates (⌘A, Shift+click ranges) in one step instead of one toggle per item
    setSelLeft: (paths: string[]) => setSelectedLeft(paths),
    setSelRight: (paths: string[]) => setSelectedRight(paths),
    newFolderLeft: () => handleNewFolder('left'),
    newFolderRight: () => handleNewFolder('right'),
    deleteLeft: (paths?: string[], force?: boolean) => handleDeleteInPane('left', paths, force),
    deleteRight: (paths?: string[], force?: boolean) => handleDeleteInPane('right', paths, force),
    homeLeft: () => handleGoHome('left'),
    homeRight: () => handleGoHome('right'),
    focusPane: (pane: PaneId) => setFocusedPane(pane),
    editFile: handleEditFile,
    rename: handleRenameFile,
    renameInline: handleRenameInline,
    showProperties: (file: FileEntry, sessionId?: string, pane?: PaneId) => {
      const sid = sessionForPane(sessionId, pane);
      if (!sessionSwitching(sid, pane)) setPropertiesTarget({ file, sessionId: sid, pane });
    },
    checksum: (file: FileEntry, sessionId?: string, pane?: PaneId) => {
      const sid = sessionForPane(sessionId, pane);
      if (!sessionSwitching(sid, pane)) setChecksumTarget({ file, sessionId: sid, pane });
    },
    size: (file: FileEntry, sessionId?: string, pane?: PaneId) => {
      if (!sessionSwitching(sessionForPane(sessionId, pane), pane)) handleCalculateDirectorySize(file, sessionId, pane);
    },
    symlink: (file?: FileEntry, sessionId?: string, pane?: PaneId, currentDir?: string) => {
      const p = pane ?? focusedPaneRef.current;
      if (paneSwitching(p)) return;
      setSymlinkData({
        isOpen: true,
        targetPath: file?.path,
        sessionId: sessionForPane(sessionId, p),
        currentDir: currentDir ?? panes[p].pathRef.current,
      });
    },
    findFiles: (pane?: PaneId) => openFindFiles(pane),
    generateCode: (pane?: PaneId) => openGenerateCode(pane),
    copyLR: () => handleTransferToOtherPane('left', false),
    copyRL: () => handleTransferToOtherPane('right', false),
    moveLR: () => handleTransferToOtherPane('left', true),
    moveRL: () => handleTransferToOtherPane('right', true),
    dropItems: handleDropItems,
    copy: handleCopy,
    cut: handleCut,
    paste: handlePaste,
    duplicate: handleDuplicate,
    compress: handleCompress,
    extract: handleExtract,
    requestCompress: handleRequestCompress,
    requestExtract: handleRequestExtract,
    terminalHere: handleOpenTerminalHere,
    nativeTerminalHere: handleOpenNativeTerminal,
    moveToTrash: (sessionId: string, paths: string[]) => {
      if (!sessionSwitching(sessionId)) confirmMoveToTrash(sessionId, paths);
    },
    smartAction: handleExecuteSmartAction,
    showInExplorer: showSessionInExplorer,
    openLocalFolder,
  });

  const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const paletteActionsRef = useRef<() => PaletteCommand[]>(() => []);
  paletteActionsRef.current = () =>
    buildPaletteCommands(
      {
        openSiteManager: () => openSiteManager(),
        shareConnection: shareCurrentConnection,
        openSharedConnection: () => setShareFiles((prev) => [...prev, null]),
        compareDirectories: handleCompareDirectories,
        openSync,
        toggleSyncBrowsing: () => setSyncBrowsing((v) => !v),
        toggleContinuousSync: handleToggleContinuousSync,
        openNativeTerminal: () => handleOpenNativeTerminal(focusedCtx.path, focusedCtx.isRemote, focusedCtx.sessionId, focusedPane),
        openTerminal: () => openBuiltinTerminal(),
        toggleTerminals: () => {
          if (terminalBadge.count === 0) openBuiltinTerminal();
          else toggleDock();
        },
        openRemoteCommand: () => openRemoteCommand(),
        openScriptConsole: () => openScriptConsole(),
        openFindFiles: () => openFindFiles(),
        openServerInfo: () => openServerInfo(),
        openVirtualDisk,
        openTrash: () => openTrash(),
        openMarketplace: () => openMarketplace(),
        openGenerateCode: () => openGenerateCode(),
        openAiAssistant: () => openAiAssistant(),
        openCommandStudio: () => openCommandStudio(),
        openMcp: () => setIsMcpOpen(true),
        openSettings: () => setIsSettingsOpen(true),
        openAbout: () => setIsAboutOpen(true),
        setTheme: handleThemeChange,
        setLanguage: (lng) => i18n.changeLanguage(lng),
        toggleLayout: () => setIsDualPane((v) => !v),
        toggleTransfers: () => setIsTransferDrawerOpen((v) => !v),
        refresh: () => refreshPane(focusedPaneRef.current),
        syncBrowsing,
        continuousSync,
        isDualPane,
        modKey: isMacPlatform ? '⌘' : 'Ctrl+',
      },
      isPt
    );
  // Recomputed only while the palette is open (cheap, and always reflects current state)
  const paletteCommands = useMemo(
    () => (isPaletteOpen ? paletteActionsRef.current() : []),
    [isPaletteOpen, isPt, syncBrowsing, continuousSync, isDualPane]
  );
  const activeTransferCount = queueTasks.filter((t) => t.status === 'in_progress').length;
  const terminalBadge = useTerminalBadge();
  const totalSpeedBps = queueTasks.filter((t) => t.status === 'in_progress').reduce((acc, t) => acc + (t.speed_bps || 0), 0);

  return (
    <div className="h-screen w-screen flex flex-col bg-dark-900 text-ink font-sans overflow-hidden">
      <ErrorBoundary scope="section" fallbackTitle={tr('Barra de ferramentas', 'Toolbar')}>
        <Header
          onOpenSiteManager={() => openSiteManager()}
          onOpenSync={openSync}
          onOpenRemoteCommand={() => openRemoteCommand()}
          onOpenActions={() => openCommandStudio()}
          onOpenMcp={() => setIsMcpOpen(true)}
          onOpenFindFiles={() => openFindFiles()}
          onOpenScriptConsole={() => openScriptConsole()}
          onOpenGenerateCode={() => openGenerateCode()}
          onOpenServerInfo={() => openServerInfo()}
          onOpenVirtualDisk={openVirtualDisk}
          onOpenMarketplace={() => openMarketplace()}
          onOpenTrash={() => openTrash()}
          onOpenNativeTerminal={() => handleOpenNativeTerminal(focusedCtx.path, focusedCtx.isRemote, focusedCtx.sessionId, focusedPane)}
          onNewTerminal={() => openBuiltinTerminal()}
          onShowTerminals={() => setDockOpen(true)}
          terminalBadge={terminalBadge}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenCommandPalette={() => setIsPaletteOpen(true)}
          onOpenAbout={() => setIsAboutOpen(true)}
          remoteTrashEnabled={remoteTrashEnabled}
          onCompareDirectories={handleCompareDirectories}
          syncBrowsing={syncBrowsing}
          onToggleSyncBrowsing={() => setSyncBrowsing((v) => !v)}
          continuousSync={continuousSync}
          onToggleContinuousSync={handleToggleContinuousSync}
          mcpStatus={mcpStatus}
          activeTransferCount={activeTransferCount}
          totalSpeedBps={totalSpeedBps}
          onToggleTransferDrawer={() => setIsTransferDrawerOpen((v) => !v)}
          onOpenAiAssistant={() => openAiAssistant()}
          themeMode={themeMode}
          onThemeChange={handleThemeChange}
        />
      </ErrorBoundary>

      {/* Explorer mode: one tab strip for every session; the visible pane is the focused one */}
      {!isDualPane && (
        <SessionTabs
          variant="global"
          sessions={sessions}
          activeSessionId={focusedCtx.sessionId}
          onSelectSession={dp.showInExplorer}
          onCloseSession={closeSessionEverywhere}
          onNewSession={() => openSiteManager()}
          isDualPane={isDualPane}
          onToggleDualPane={dp.toggleDualPane}
        />
      )}

      {/* Main workspace (Commander / Explorer) */}
      <DualPane
        isDualPane={isDualPane}
        onToggleDualPane={dp.toggleDualPane}
        onOpenAiAssistant={dp.openAi}
        onMoveTabBetweenPanes={dp.moveTab}
        onReorderTabs={dp.reorderTabs}
        allSessions={sessions}
        leftSessions={leftSessions}
        leftActiveSessionId={leftActiveSessionId}
        onSelectLeftSession={dp.selectLeft}
        onCloseLeftSession={dp.closeLeft}
        onNewLeftSession={dp.newLeft}
        leftSessionName={leftCtx.name || undefined}
        leftIsRemote={leftCtx.isRemote}
        leftPath={leftPath}
        leftFiles={leftFiles}
        leftLoading={leftLoading}
        selectedLeft={selectedLeft}
        diffMap={activeDiffMap}
        onLeftNavigate={dp.navLeft}
        onLeftRefresh={dp.refreshLeft}
        onSelectLeft={dp.selLeft}
        onSetLeftSelection={dp.setSelLeft}
        onLeftNewFolder={dp.newFolderLeft}
        remoteTrashEnabled={remoteTrashEnabled}
        onLeftDelete={dp.deleteLeft}
        onLeftGoHome={dp.homeLeft}
        rightSessions={rightSessions}
        rightActiveSessionId={rightActiveSessionId}
        onSelectRightSession={dp.selectRight}
        onCloseRightSession={dp.closeRight}
        onNewRightSession={dp.newRight}
        rightSessionName={rightCtx.name || undefined}
        rightIsRemote={rightCtx.isRemote}
        rightPath={rightPath}
        rightFiles={rightFiles}
        rightLoading={rightLoading}
        selectedRight={selectedRight}
        onRightNavigate={dp.navRight}
        onRightRefresh={dp.refreshRight}
        onSelectRight={dp.selRight}
        onSetRightSelection={dp.setSelRight}
        onRightNewFolder={dp.newFolderRight}
        onRightDelete={dp.deleteRight}
        onRightGoHome={dp.homeRight}
        focusedPane={focusedPane}
        onFocusPane={dp.focusPane}
        onEditFile={dp.editFile}
        onRenameFile={dp.rename}
        onRenameInline={dp.renameInline}
        onShowProperties={dp.showProperties}
        onCalculateChecksum={dp.checksum}
        onCalculateSize={dp.size}
        onOpenSymlink={dp.symlink}
        onOpenFindFiles={dp.findFiles}
        onOpenGenerateCode={dp.generateCode}
        onTransferLeftToRight={dp.copyLR}
        onTransferRightToLeft={dp.copyRL}
        onMoveLeftToRight={dp.moveLR}
        onMoveRightToLeft={dp.moveRL}
        onDropItems={dp.dropItems}
        clipboard={clipboard}
        actionsCatalog={actionsCatalog}
        onCopy={dp.copy}
        onCut={dp.cut}
        onPaste={dp.paste}
        onDuplicate={dp.duplicate}
        onCompress={dp.compress}
        onExtract={dp.extract}
        onRequestCompress={dp.requestCompress}
        onRequestExtract={dp.requestExtract}
        onOpenTerminalHere={dp.terminalHere}
        onOpenNativeTerminalHere={dp.nativeTerminalHere}
        onMoveToTrash={dp.moveToTrash}
        onExecuteSmartAction={dp.smartAction}
        onSelectExplorerSession={dp.showInExplorer}
        localHomePath={localHome}
        onOpenLocalFolder={dp.openLocalFolder}
      />

      {/* Built-in terminals: keep running when hidden; a slim bar shows their state */}
      <ErrorBoundary scope="section" fallbackTitle={tr('Terminais', 'Terminals')}>
        <TerminalDock
          isPt={isPt}
          onNewTerminal={hasShell(panes[pickPane('shell')].activeRef.current) ? () => openBuiltinTerminal() : null}
          onOpenFolder={showRemoteFolder}
          onOpenNative={(sid, path) => {
            if (!sessionById(sid)) {
              notify.info(tr('Esta conexão foi fechada nos arquivos', 'This connection was closed in the file panes'), tr('Conecte-se de novo para abrir no terminal do sistema.', 'Connect again to open it in the system terminal.'));
              return;
            }
            void handleOpenNativeTerminal(path, true, sid);
          }}
        />
      </ErrorBoundary>

      {/* Transfer queue drawer */}
      <ErrorBoundary scope="section" fallbackTitle={tr('Transferências', 'Transfers')}>
        <TransferQueue
          tasks={queueTasks}
          onCancelTask={handleCancelTransferTask}
          onClearCompleted={handleClearCompletedTransfers}
          isExpanded={isTransferDrawerOpen}
          onToggleExpand={() => setIsTransferDrawerOpen((v) => !v)}
        />
      </ErrorBoundary>

      {/* Site Manager */}
      <ModalGuard title={tr('Conexões', 'Connections')} onClose={() => setIsSiteManagerOpen(false)}>
        <LoginDialog
          isOpen={isSiteManagerOpen}
          onClose={() => setIsSiteManagerOpen(false)}
          savedSites={savedSites}
          onConnect={handleConnect}
          onSaveSite={handleSaveSite}
          onDeleteSite={handleDeleteSite}
          onSitesUpdated={(newSites) => setSavedSites(newSites)}
          onShareSite={(site) => setShareSource({ siteId: site.id, name: site.name, host: site.host, username: site.username, startPath: '' })}
          onOpenSharedConnection={() => setShareFiles((prev) => [...prev, null])}
        />
      </ModalGuard>

      {/* Connection sharing (.rustscp files); after the Site Manager so they stack above it */}
      {shareSource && (
        <ModalGuard title={tr('Compartilhar conexão', 'Share connection')} onClose={() => setShareSource(null)}>
          <ShareConnectionModal isOpen={!!shareSource} source={shareSource} onClose={() => setShareSource(null)} />
        </ModalGuard>
      )}
      {shareFiles.length > 0 && (
        <ModalGuard title={tr('Abrir conexão compartilhada', 'Open shared connection')} onClose={() => setShareFiles((prev) => prev.slice(1))}>
          <OpenShareModal isOpen file={shareFiles[0]} onClose={() => setShareFiles((prev) => prev.slice(1))} onOpen={handleOpenSharedSite} />
        </ModalGuard>
      )}

      {/* Symlink / hardlink, created in the folder of the pane it was opened from */}
      <ModalGuard title={tr('Criar link', 'Create link')} onClose={() => setSymlinkData((d) => ({ ...d, isOpen: false }))}>
        <SymlinkModal
          isOpen={symlinkData.isOpen}
          onClose={() => setSymlinkData((d) => ({ ...d, isOpen: false }))}
          sessionId={symlinkData.sessionId}
          currentDir={symlinkData.currentDir}
          selectedItemPath={symlinkData.targetPath}
          onSuccess={() => refreshSession(symlinkData.sessionId, [symlinkData.currentDir])}
        />
      </ModalGuard>

      {/* Properties & chmod, on the session the file came from */}
      {propertiesTarget && (
        <ModalGuard title={tr('Propriedades', 'Properties')} onClose={() => setPropertiesTarget(null)}>
          <FilePropertiesModal
            isOpen={true}
            onClose={() => setPropertiesTarget(null)}
            file={propertiesTarget.file}
            permissionsSupported={supportsPermissions(propertiesTarget.sessionId)}
            onApplyPermissions={async (path, mode) => {
              const sid = propertiesTarget.sessionId;
              await invokeTauri('change_permissions', { sessionId: sid, path, mode });
              directoryCache.invalidate(sid, path);
              await refreshSession(sid, [dirname(path)]);
            }}
          />
        </ModalGuard>
      )}

      {/* Remote command, run in the folder of the pane it was opened from */}
      <ModalGuard title={tr('Executar comando', 'Run command')} onClose={() => setIsRemoteCommandOpen(false)}>
        <RemoteCommandDialog
          isOpen={isRemoteCommandOpen}
          onClose={() => setIsRemoteCommandOpen(false)}
          remoteSessionName={remoteCommandCtx.name || tr('Servidor remoto', 'Remote server')}
          isRemote={hasShell(remoteCommandCtx.sessionId)}
          cwd={remoteCommandCwd || undefined}
          onExecute={async (cmd) => {
            return await invokeTauri<{ exit_code: number; stdout: string; stderr: string }>('execute_remote_command', {
              sessionId: remoteCommandCtx.sessionId,
              command: remoteCommandCwd ? inDir(remoteCommandCwd, cmd) : cmd,
            });
          }}
        />
      </ModalGuard>

      {/* Checksums, on the session the file came from */}
      {checksumTarget && (
        <ModalGuard title={tr('Checksum', 'Checksum')} onClose={() => setChecksumTarget(null)}>
          <ChecksumModal
            isOpen={true}
            onClose={() => setChecksumTarget(null)}
            fileName={checksumTarget.file.name}
            filePath={checksumTarget.file.path}
            onCalculate={async (algorithm) => {
              const res = await invokeTauri<{ hash: string }>('calculate_checksum', {
                sessionId: checksumTarget.sessionId,
                path: checksumTarget.file.path,
                algorithm,
              });
              return res.hash;
            }}
          />
        </ModalGuard>
      )}

      {isVirtualDiskOpen && (
        <ModalGuard title={tr('Disco virtual', 'Virtual drive')} onClose={() => setIsVirtualDiskOpen(false)}>
          <VirtualDiskModal
            isOpen={isVirtualDiskOpen}
            onClose={() => setIsVirtualDiskOpen(false)}
            sessions={sessions}
            activeSessionId={virtualDiskCtx.sessionId}
          />
        </ModalGuard>
      )}

      {isFindFilesOpen && (
        <ModalGuard title={tr('Localizar arquivos', 'Find files')} onClose={() => setIsFindFilesOpen(false)}>
          <FindFilesModal
            isOpen={isFindFilesOpen}
            onClose={() => setIsFindFilesOpen(false)}
            sessionId={findCtx.sessionId}
            protocol={findCtx.session?.config.protocol}
            initialPath={findCtx.path}
            onNavigateToPath={(p) => handleNavigate(findCtx.pane, p)}
            onOpenFileEditor={(p) => openInEditor({ name: basename(p), path: p }, findCtx.sessionId, findCtx.pane)}
          />
        </ModalGuard>
      )}

      {scriptConsoleMounted && (
        <ModalGuard
          title={tr('Console de scripts', 'Script console')}
          onClose={() => {
            setIsScriptConsoleOpen(false);
            setScriptConsoleMounted(false);
          }}
        >
          <ScriptConsoleModal
            isOpen={isScriptConsoleOpen}
            onClose={() => setIsScriptConsoleOpen(false)}
            sessionId={scriptCtx.sessionId}
            localPath={localSidePath(scriptCtx.pane)}
            remotePath={scriptCtx.path}
          />
        </ModalGuard>
      )}

      {isGenerateCodeOpen && (
        <ModalGuard title={tr('Gerar código e URL', 'Generate code & URL')} onClose={() => setIsGenerateCodeOpen(false)}>
          <GenerateCodeModal
            isOpen={isGenerateCodeOpen}
            onClose={() => setIsGenerateCodeOpen(false)}
            sessionId={generateCtx.sessionId}
            config={generateCtx.session?.config || null}
            remotePath={generateCtx.path}
            localPath={localSidePath(generateCtx.pane)}
          />
        </ModalGuard>
      )}

      {isServerInfoOpen && (
        <ModalGuard title={tr('Disco e servidor', 'Disk & server info')} onClose={() => setIsServerInfoOpen(false)}>
          <FileSystemInfoModal
            isOpen={isServerInfoOpen}
            onClose={() => setIsServerInfoOpen(false)}
            sessionId={serverInfoCtx.sessionId}
            path={serverInfoCtx.path}
          />
        </ModalGuard>
      )}

      {editorMounted && (
        <ModalGuard
          title={tr('Editor', 'Editor')}
          onClose={() => {
            setIsEditorOpen(false);
            setEditingFile(null);
            setEditorMounted(false);
          }}
        >
          <RustScpEditor
            isOpen={isEditorOpen}
            onClose={() => {
              setIsEditorOpen(false);
              setEditingFile(null);
            }}
            initialFile={editingFile}
            onSave={handleEditorSave}
            onOpenExternal={(path: string, sessionId?: string) => handleOpenExternal(path, sessionId)}
          />
        </ModalGuard>
      )}

      {isSyncOpen && syncPair && (
        <ModalGuard title={tr('Sincronizar pastas', 'Synchronize folders')} onClose={() => setIsSyncOpen(false)}>
          <SyncDialog
            isOpen={isSyncOpen}
            onClose={() => setIsSyncOpen(false)}
            localPath={syncPair.local.path}
            remotePath={syncPair.remote.path}
            onCompare={async (options) => {
              return await invokeTauri<SyncItem[]>('compare_and_sync_plan', {
                localSession: syncPair.local.sid,
                localDir: syncPair.local.path,
                remoteSession: syncPair.remote.sid,
                remoteDir: syncPair.remote.path,
                options,
              });
            }}
            onExecuteSync={handleExecuteSync}
          />
        </ModalGuard>
      )}

      {isActionsOpen && (
        <ModalGuard title={tr('Estúdio de comandos', 'Command Studio')} onClose={() => setIsActionsOpen(false)}>
          <CommandStudioModal
            isOpen={isActionsOpen}
            onClose={() => setIsActionsOpen(false)}
            initialActionId={studioInit?.actionId}
            sessionName={studioCtx.name || undefined}
            actions={actionsCatalog}
            selectedPaths={studioInit?.paths ?? studioCtx.selection}
            currentDir={studioCtx.path}
            isRemote={studioCtx.isRemote}
            onExecute={async (cmd) => {
              return await invokeTauri<{ stdout: string; stderr: string; exit_code: number }>('execute_remote_command', {
                sessionId: studioCtx.sessionId,
                command: cmd,
              });
            }}
            onSaveCustomAction={handleSaveCustomAction}
            onDeleteCustomAction={handleDeleteCustomAction}
          />
        </ModalGuard>
      )}

      {isMarketplaceOpen && (
        <ModalGuard title={tr('Ferramentas do servidor', 'Server tools')} onClose={() => setIsMarketplaceOpen(false)}>
          <SysAdminMarketplaceModal
            isOpen={isMarketplaceOpen}
            onClose={() => setIsMarketplaceOpen(false)}
            sessionId={marketplaceCtx.sessionId}
            sessionName={marketplaceCtx.name || tr('Servidor remoto', 'Remote server')}
            isRemote={marketplaceCtx.isRemote && hasShell(marketplaceCtx.sessionId)}
            systemInfo={remoteSystemInfo}
            onRefreshSystemInfo={() => handleDetectRemoteSystem()}
            onCheckTool={handleCheckTool}
            onInstallTool={handleInstallMarketplaceTool}
          />
        </ModalGuard>
      )}

      {isRemoteTrashOpen && (
        <ModalGuard title={tr('Lixeira remota', 'Remote trash')} onClose={() => setIsRemoteTrashOpen(false)}>
          <RemoteTrashModal
            isOpen={isRemoteTrashOpen}
            onClose={() => setIsRemoteTrashOpen(false)}
            sessionId={trashCtx.sessionId}
            sessionName={trashCtx.name || tr('Servidor remoto', 'Remote server')}
            isTrashEnabled={remoteTrashEnabled}
            onGetTrashStatus={handleGetTrashStatus}
            onSetupTrash={handleSetupTrash}
            onRestoreItem={handleRestoreTrashItem}
            onEmptyTrash={handleEmptyTrash}
          />
        </ModalGuard>
      )}

      {compressionModalState.isOpen && (
        <ModalGuard
          title={compressionModalState.mode === 'compress' ? tr('Compactar', 'Compress') : tr('Extrair', 'Extract')}
          onClose={() => setCompressionModalState((prev) => ({ ...prev, isOpen: false }))}
        >
          <CompressionModal
            isOpen={compressionModalState.isOpen}
            onClose={() => setCompressionModalState((prev) => ({ ...prev, isOpen: false }))}
            mode={compressionModalState.mode}
            currentDir={compressionModalState.currentDir}
            targetItems={compressionModalState.targetItems}
            archivePath={compressionModalState.archivePath}
            isRemote={compressionModalState.isRemote}
            onCompress={(items, format, outputName) =>
              runCompress(compressionModalState.sessionId, compressionModalState.currentDir, items, format, outputName)
            }
            onExtract={(archivePath, destSubfolder) =>
              runExtract(compressionModalState.sessionId, compressionModalState.currentDir, archivePath, destSubfolder)
            }
          />
        </ModalGuard>
      )}

      {isAboutOpen && (
        <ModalGuard title={tr('Sobre o RustSCP', 'About RustSCP')} onClose={() => setIsAboutOpen(false)}>
          <AboutModal isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} />
        </ModalGuard>
      )}

      {isMcpOpen && (
        <ModalGuard title={tr('Gateway de IA (MCP)', 'AI gateway (MCP)')} onClose={() => setIsMcpOpen(false)}>
          <McpGatewayModal
            isOpen={isMcpOpen}
            onClose={() => setIsMcpOpen(false)}
            status={mcpStatus}
            auditLogs={auditLogs}
            onSetEnabled={setMcpGatewayEnabled}
          />
        </ModalGuard>
      )}

      {isAiModalOpen && (
        <ModalGuard title={tr('Assistente', 'Assistant')} onClose={() => setIsAiModalOpen(false)}>
          <AiAssistantModal
            isOpen={isAiModalOpen}
            onClose={() => setIsAiModalOpen(false)}
            activeSessionId={aiCtx.sessionId || LOCAL_ID}
            activeSessionName={aiCtx.name || tr('Este computador', 'This computer')}
            isRemote={aiCtx.isRemote}
            currentPath={aiCtx.path}
            files={aiCtx.files}
            onRefreshFiles={() => {
              refreshSession(aiCtx.sessionId);
            }}
            onExecuteRemoteCommand={async (cmd) => {
              return await invokeTauri<{ exit_code: number; stdout: string; stderr: string }>('execute_remote_command', {
                sessionId: aiCtx.sessionId,
                command: cmd,
              });
            }}
          />
        </ModalGuard>
      )}

      {/* Settings */}
      <ModalGuard title={tr('Configurações', 'Settings')} onClose={() => setIsSettingsOpen(false)}>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          themeMode={themeMode}
          onThemeChange={handleThemeChange}
          isRemoteTrashEnabled={remoteTrashEnabled}
          onToggleRemoteTrash={handleToggleRemoteTrash}
          rememberLastRemoteDir={rememberLastRemoteDir}
          onToggleRememberLastRemoteDir={handleToggleRememberLastRemoteDir}
          externalEditorCmd={externalEditorCmd}
          onSaveExternalEditorCmd={handleSaveExternalEditorCmd}
          preferExternalEditor={preferExternalEditor}
          onTogglePreferExternalEditor={handleTogglePreferExternalEditor}
          onOpenRemoteTrashModal={() => {
            setIsSettingsOpen(false);
            openTrash();
          }}
          onOpenAbout={() => {
            setIsSettingsOpen(false);
            setIsAboutOpen(true);
          }}
        />
      </ModalGuard>

      {/* ⌘K command palette */}
      <ModalGuard title={tr('Paleta de comandos', 'Command palette')} onClose={() => setIsPaletteOpen(false)}>
        <CommandPalette isOpen={isPaletteOpen} onClose={() => setIsPaletteOpen(false)} commands={paletteCommands} />
      </ModalGuard>

      {confirmDialog && <ConfirmDialogModal {...confirmDialog} onClose={closeConfirmDialog} />}

      {inputDialog && <InputDialogModal {...inputDialog} onClose={closeInputDialog} />}
    </div>
  );
};
