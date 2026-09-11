import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Header } from './components/Header.tsx';
import { DualPane } from './components/DualPane.tsx';
import { SessionTabs, ActiveSession } from './components/SessionTabs.tsx';
import { LoginDialog } from './components/LoginDialog.tsx';
import { RustScpEditor } from './components/RustScpEditor.tsx';
import { FilePropertiesModal } from './components/FilePropertiesModal.tsx';
import { SyncDialog } from './components/SyncDialog.tsx';
import { RemoteCommandDialog } from './components/RemoteCommandDialog.tsx';
import { ChecksumModal } from './components/ChecksumModal.tsx';
import { CommandStudioModal } from './components/CommandStudioModal.tsx';
import { McpGatewayModal } from './components/McpGatewayModal.tsx';
import { TransferQueue } from './components/TransferQueue.tsx';
import { FindFilesModal } from './components/FindFilesModal.tsx';
import { ScriptConsoleModal } from './components/ScriptConsoleModal.tsx';
import { GenerateCodeModal } from './components/GenerateCodeModal.tsx';
import { FileSystemInfoModal } from './components/FileSystemInfoModal.tsx';
import { SymlinkModal } from './components/SymlinkModal.tsx';
import { VirtualDiskModal } from './components/VirtualDiskModal.tsx';
import { AiAssistantModal } from './components/AiAssistantModal.tsx';
import { SysAdminMarketplaceModal } from './components/SysAdminMarketplaceModal.tsx';
import { RemoteTrashModal } from './components/RemoteTrashModal.tsx';
import { CompressionModal } from './components/CompressionModal.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { AboutModal } from './components/AboutModal.tsx';
import { ConfirmDialogModal } from './components/ConfirmDialogModal.tsx';
import { InputDialogModal } from './components/InputDialogModal.tsx';
import { 
  ActionDefinition, 
  AuditEvent, 
  ClipboardState,
  ConnectionConfig, 
  FileEntry, 
  McpStatusInfo, 
  QueueTransferTask,
  RemoteSystemInfo,
  RemoteTrashItem,
  RemoteTrashStatus,
  SyncItem 
} from './types.ts';
import { ThemeMode, getStoredTheme, saveTheme, applyTheme, initThemeWatcher } from './theme.ts';
import { directoryCache } from './utils/directoryCache.ts';
import { invoke, isTauri } from '@tauri-apps/api/core';

// Safe Tauri invocation helper (with web mode fallback)
async function invokeTauri<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri()) {
    return await invoke<T>(cmd, args);
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (_e) {
    console.warn(`[Web Fallback] '${cmd}'`, args);
    return getFallbackData<T>(cmd, args);
  }
}

function getFallbackData<T>(cmd: string, args?: any): T {
  if (cmd === 'list_directory') {
    const p = args?.path || '/';
    const fallbackFiles: FileEntry[] = [
      {
        name: '..',
        path: p === '/' ? '/' : p.split('/').slice(0, -1).join('/') || '/',
        file_type: 'directory',
        size: 0,
        permissions: { mode: 0o755, readonly: false },
        is_hidden: false,
      },
      {
        name: 'nginx.conf',
        path: `${p}/nginx.conf`,
        file_type: 'file',
        size: 2450,
        modified_at: new Date().toISOString(),
        permissions: { mode: 0o644, readonly: false },
        is_hidden: false,
      },
      {
        name: 'app.log',
        path: `${p}/app.log`,
        file_type: 'file',
        size: 89120,
        modified_at: new Date().toISOString(),
        permissions: { mode: 0o644, readonly: false },
        is_hidden: false,
      },
      {
        name: 'backup_database.sql.gz',
        path: `${p}/backup_database.sql.gz`,
        file_type: 'file',
        size: 15420000,
        modified_at: new Date().toISOString(),
        permissions: { mode: 0o600, readonly: false },
        is_hidden: false,
      },
    ];
    return fallbackFiles as unknown as T;
  }

  if (cmd === 'get_saved_sites') {
    return [
      {
        id: 'local',
        name: 'Local Machine',
        protocol: 'local',
        host: 'localhost',
        port: 0,
        username: 'user',
        auth: { type: 'None', value: '' },
        remote_root: '/',
      },
      {
        id: 'demo-sftp',
        name: 'Demo Production SFTP',
        protocol: 'sftp',
        host: 'ssh.demo.com',
        port: 22,
        username: 'root',
        auth: { type: 'Password', value: 'secret' },
        remote_root: '/var/www',
      },
    ] as unknown as T;
  }

  if (cmd === 'read_file_content') {
    return `# Nginx Configuration File\nserver {\n    listen 80;\n    server_name rustscp.net;\n    root /var/www/html;\n    index index.html;\n}\n` as unknown as T;
  }

  if (cmd === 'execute_remote_command') {
    return {
      exit_code: 0,
      stdout: `Linux rustscp-prod 6.5.0-x86_64 #1 SMP PREEMPT_DYNAMIC\nuptime: 42 days, 12:34, 2 users, load average: 0.12, 0.08, 0.05\n`,
      stderr: '',
    } as unknown as T;
  }

  if (cmd === 'compare_and_sync_plan') {
    return [
      {
        relative_path: 'index.html',
        action: 'upload',
        local_size: 4096,
        remote_size: 3800,
      },
    ] as unknown as T;
  }

  if (cmd === 'compare_directories_fast') {
    return [] as unknown as T;
  }

  if (cmd === 'calculate_checksum') {
    return {
      algorithm: 'SHA-256',
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    } as unknown as T;
  }

  if (cmd === 'calculate_directory_size') {
    return 1024 * 1024 * 50 as unknown as T;
  }

  if (cmd === 'get_session_default_path') {
    return '/home/aquelelink.com.br' as unknown as T;
  }

  if (cmd === 'get_transfer_queue_tasks') {
    return [] as unknown as T;
  }

  return {} as T;
}

export const App: React.FC = () => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  // Saved Sites & Active Sessions
  const [savedSites, setSavedSites] = useState<ConnectionConfig[]>([]);
  const [sessions, setSessions] = useState<ActiveSession[]>([
    {
      id: 'local',
      config: {
        id: 'local',
        name: 'Local Machine',
        protocol: 'local',
        host: 'localhost',
        port: 0,
        username: 'user',
        auth: { type: 'None', value: '' },
        remote_root: '',
      },
      currentPath: '/Users',
    },
  ]);
  const [isDualPane, setIsDualPane] = useState<boolean>(true);

  // Independent Pane Session States
  const [leftPaneSessionIds, setLeftPaneSessionIds] = useState<string[]>(['local']);
  const [rightPaneSessionIds, setRightPaneSessionIds] = useState<string[]>(['local']);
  const [leftActiveSessionId, setLeftActiveSessionId] = useState<string>('local');
  const [rightActiveSessionId, setRightActiveSessionId] = useState<string>('local');
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left');
  const [newSessionTargetPane, setNewSessionTargetPane] = useState<'left' | 'right'>('right');

  // Left Pane State
  const [leftPath, setLeftPath] = useState<string>('/Users');
  const [leftFiles, setLeftFiles] = useState<FileEntry[]>([]);
  const [leftLoading, setLeftLoading] = useState<boolean>(false);
  const [selectedLeft, setSelectedLeft] = useState<string[]>([]);

  // Right Pane State
  const [rightPath, setRightPath] = useState<string>('/var/www');
  const [rightFiles, setRightFiles] = useState<FileEntry[]>([]);
  const [rightLoading, setRightLoading] = useState<boolean>(false);
  const [selectedRight, setSelectedRight] = useState<string[]>([]);

  // Backward-compatibility aliases for modals & secondary dialogs
  const localPath = leftPath;
  const setLocalPath = setLeftPath;
  const localFiles = leftFiles;
  const selectedLocal = selectedLeft;

  const remotePath = rightPath;
  const remoteFiles = rightFiles;
  const selectedRemote = selectedRight;
  const setSelectedRemote = setSelectedRight;

  const activeRemoteSessionId = (() => {
    const focusedSid = focusedPane === 'left' ? leftActiveSessionId : rightActiveSessionId;
    if (focusedSid !== 'local') return focusedSid;
    const otherSid = focusedPane === 'left' ? rightActiveSessionId : leftActiveSessionId;
    if (otherSid !== 'local') return otherSid;
    const anyRemote = sessions.find((s) => s.id !== 'local');
    return anyRemote ? anyRemote.id : 'local';
  })();

  // RustSCP Advanced Features States
  const [syncBrowsing, setSyncBrowsing] = useState<boolean>(false);
  const [continuousSync, setContinuousSync] = useState<boolean>(false);
  const [diffMap, setDiffMap] = useState<Record<string, string>>({});

  // Modals State
  const [isSiteManagerOpen, setIsSiteManagerOpen] = useState<boolean>(false);
  const [isSyncOpen, setIsSyncOpen] = useState<boolean>(false);
  const [isRemoteCommandOpen, setIsRemoteCommandOpen] = useState<boolean>(false);
  const [isActionsOpen, setIsActionsOpen] = useState<boolean>(false);
  const [isMcpOpen, setIsMcpOpen] = useState<boolean>(false);
  const [isFindFilesOpen, setIsFindFilesOpen] = useState<boolean>(false);
  const [isScriptConsoleOpen, setIsScriptConsoleOpen] = useState<boolean>(false);
  const [isGenerateCodeOpen, setIsGenerateCodeOpen] = useState<boolean>(false);
  const [isServerInfoOpen, setIsServerInfoOpen] = useState<boolean>(false);
  const [isVirtualDiskOpen, setIsVirtualDiskOpen] = useState<boolean>(false);
  const [isAiModalOpen, setIsAiModalOpen] = useState<boolean>(false);
  const [symlinkData, setSymlinkData] = useState<{ isOpen: boolean; targetPath?: string }>({ isOpen: false });

  // RustSCP Modern Multi-Tab Editor State
  const [editingFile, setEditingFile] = useState<{
    name: string;
    path: string;
    content: string;
    isRemote: boolean;
    sessionId: string;
  } | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState<boolean>(false);

  // New Modals State (Marketplace, Trash, Compression, Settings, About)
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isAboutOpen, setIsAboutOpen] = useState<boolean>(false);
  const [isMarketplaceOpen, setIsMarketplaceOpen] = useState<boolean>(false);
  const [isRemoteTrashOpen, setIsRemoteTrashOpen] = useState<boolean>(false);
  const [remoteTrashEnabled, setRemoteTrashEnabled] = useState<boolean>(() => {
    return localStorage.getItem('rustscp_remote_trash_enabled') === 'true';
  });
  const [rememberLastRemoteDir, setRememberLastRemoteDir] = useState<boolean>(() => {
    const saved = localStorage.getItem('rustscp_remember_last_remote_dir');
    return saved === null ? true : saved === 'true'; // Enabled by default as requested
  });

  const handleToggleRememberLastRemoteDir = (enabled: boolean) => {
    setRememberLastRemoteDir(enabled);
    localStorage.setItem('rustscp_remember_last_remote_dir', String(enabled));
  };

  const getRemoteConnectionKey = (cfg: ConnectionConfig): string => {
    return `${cfg.protocol}://${cfg.username}@${cfg.host}:${cfg.port}`;
  };

  const saveLastRemotePath = (cfg: ConnectionConfig, path: string) => {
    if (!cfg || cfg.protocol === 'local' || !path || path.trim() === '') return;
    try {
      const raw = localStorage.getItem('rustscp_last_remote_paths');
      const map: Record<string, string> = raw ? JSON.parse(raw) : {};
      if (cfg.id && cfg.id !== 'quick-connect') {
        map[cfg.id] = path;
      }
      const compositeKey = getRemoteConnectionKey(cfg);
      map[compositeKey] = path;
      localStorage.setItem('rustscp_last_remote_paths', JSON.stringify(map));
    } catch (e) {
      console.error('Failed to save last remote path:', e);
    }
  };

  const getLastRemotePath = (cfg: ConnectionConfig): string | null => {
    if (!cfg || cfg.protocol === 'local') return null;
    try {
      const raw = localStorage.getItem('rustscp_last_remote_paths');
      if (!raw) return null;
      const map: Record<string, string> = JSON.parse(raw);
      if (cfg.id && map[cfg.id]) return map[cfg.id];
      const compositeKey = getRemoteConnectionKey(cfg);
      if (map[compositeKey]) return map[compositeKey];
    } catch (e) {
      console.error('Failed to read last remote path:', e);
    }
    return null;
  };

  const [externalEditorCmd, setExternalEditorCmd] = useState<string>(() => {
    return localStorage.getItem('rustscp_external_editor_command') || '';
  });
  const [remoteSystemInfo, setRemoteSystemInfo] = useState<RemoteSystemInfo | null>(null);

  // In-app Modal Dialogs (replacing window.confirm and window.prompt for native macOS/WKWebView support)
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

  // Compression Modal State
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
    sessionId: 'local',
    currentDir: '/',
    targetItems: [],
    archivePath: '',
    isRemote: false,
  });

  // Properties & Checksum Modals
  const [propertiesFile, setPropertiesFile] = useState<FileEntry | null>(null);
  const [checksumFile, setChecksumFile] = useState<FileEntry | null>(null);

  // Catalogs & Stats
  const [actionsCatalog, setActionsCatalog] = useState<ActionDefinition[]>([]);
  const [mcpStatus, setMcpStatus] = useState<McpStatusInfo | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditEvent[]>([]);

  // Clipboard & Async Transfer Queue
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [queueTasks, setQueueTasks] = useState<QueueTransferTask[]>([]);
  const [isTransferDrawerOpen, setIsTransferDrawerOpen] = useState<boolean>(false);

  // Theme State (System, Dark, Light)
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

  // Load Saved Sites & Actions on mount
  useEffect(() => {
    invokeTauri<ConnectionConfig[]>('get_saved_sites')
      .then((sites) => {
        if (sites && sites.length > 0) setSavedSites(sites);
      })
      .catch(console.error);

    invokeTauri<ActionDefinition[]>('get_actions_catalog')
      .then(setActionsCatalog)
      .catch(console.error);

    invokeTauri<McpStatusInfo>('get_mcp_status')
      .then(setMcpStatus)
      .catch(console.error);

    invokeTauri<AuditEvent[]>('get_mcp_audit_logs', { limit: 50 })
      .then(setAuditLogs)
      .catch(console.error);

    invokeTauri<string>('get_session_default_path', { sessionId: 'local' })
      .then((p) => {
        const path = p && p !== '/' ? p : '/Users';
        setLocalPath(path);
        loadLocalFiles(path);
      })
      .catch(() => loadLocalFiles('/Users'));
  }, []);

  // Poll Background Transfer Queue every 1000ms
  useEffect(() => {
    let prevActiveCount = 0;
    const interval = setInterval(async () => {
      try {
        const tasks = await invokeTauri<QueueTransferTask[]>('get_transfer_queue_tasks');
        if (Array.isArray(tasks)) {
          setQueueTasks(tasks);
          const currentActive = tasks.filter((t) => t.status === 'in_progress').length;
          // Auto-refresh panes when transfers finish
          if (prevActiveCount > 0 && currentActive === 0) {
            directoryCache.invalidate(leftActiveSessionId, leftPath);
            directoryCache.invalidate(rightActiveSessionId, rightPath);
            loadLeftFiles(leftPath, undefined, true);
            loadRightFiles(rightPath, undefined, true);
          }
          prevActiveCount = currentActive;
        }
      } catch (_e) {
        // ignore
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [localPath, remotePath, leftPath, rightPath, leftActiveSessionId, rightActiveSessionId]);

  // Keyboard Shortcuts Listener (Shift+F7, Shift+F2, F5, Ctrl+R, etc.)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'F7') {
        e.preventDefault();
        setIsFindFilesOpen(true);
      } else if (e.shiftKey && e.key === 'F2') {
        e.preventDefault();
        handleCompareDirectories();
      } else if (e.key === 'F5' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        // Force refresh current focused pane bypassing cache
        if (focusedPane === 'left') {
          loadLeftFiles(leftPath, undefined, true);
        } else {
          loadRightFiles(rightPath, undefined, true);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [localPath, remotePath, activeRemoteSessionId, focusedPane, leftPath, rightPath, leftActiveSessionId, rightActiveSessionId]);

  // Save last active remote paths when window is closed or app exits
  useEffect(() => {
    const handleUnload = () => {
      sessions.forEach((s) => {
        if (s.config.protocol !== 'local' && s.currentPath) {
          saveLastRemotePath(s.config, s.currentPath);
        }
      });
    };
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
    };
  }, [sessions]);

  const loadLeftFiles = async (p: string, overrideSid?: string, forceRefresh = false) => {
    const sid = overrideSid !== undefined ? overrideSid : leftActiveSessionId;
    if (!sid) {
      setLeftFiles([]);
      setLeftPath('');
      setLeftLoading(false);
      return;
    }

    // 1. Instant Cache Hit Check (0ms transition without blocking loading screen)
    if (!forceRefresh) {
      const cached = directoryCache.get(sid, p);
      if (cached) {
        setLeftFiles(cached);
        setLeftPath(p);
        setSelectedLeft([]);
        setLeftLoading(false);
        setSessions((prev) =>
          prev.map((s) => (s.id === sid ? { ...s, currentPath: p } : s))
        );
        if (sid !== 'local') {
          const sess = sessions.find((s) => s.id === sid);
          if (sess) saveLastRemotePath(sess.config, p);
        }
        return;
      }
    }

    // 2. Cache Miss or Force Refresh: query backend
    setLeftLoading(true);
    try {
      const files = await invokeTauri<FileEntry[]>('list_directory', {
        sessionId: sid,
        path: p,
        bypassCache: forceRefresh,
      });
      directoryCache.set(sid, p, files);
      setLeftFiles(files);
      setLeftPath(p);
      setSelectedLeft([]);
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, currentPath: p } : s))
      );
      if (sid !== 'local') {
        const sess = sessions.find((s) => s.id === sid);
        if (sess) saveLastRemotePath(sess.config, p);
      }
    } catch (e) {
      console.error('loadLeftFiles error:', e);
      // Resilience fallback: if remembered path failed to load, fallback to default user path or '/'
      if (p !== '/' && sid !== 'local') {
        try {
          const fallback = await invokeTauri<string>('get_session_default_path', { sessionId: sid }).catch(() => '/');
          const fallbackPath = fallback || '/';
          if (fallbackPath !== p) {
            const fallbackFiles = await invokeTauri<FileEntry[]>('list_directory', {
              sessionId: sid,
              path: fallbackPath,
              bypassCache: true,
            });
            directoryCache.set(sid, fallbackPath, fallbackFiles);
            setLeftFiles(fallbackFiles);
            setLeftPath(fallbackPath);
            setSessions((prev) =>
              prev.map((s) => (s.id === sid ? { ...s, currentPath: fallbackPath } : s))
            );
          }
        } catch (_fallbackErr) {
          // ignore
        }
      }
    } finally {
      setLeftLoading(false);
    }
  };

  const loadRightFiles = async (p: string, overrideSid?: string, forceRefresh = false) => {
    const sid = overrideSid !== undefined ? overrideSid : rightActiveSessionId;
    if (!sid) {
      setRightFiles([]);
      setRightPath('');
      setRightLoading(false);
      return;
    }

    // 1. Instant Cache Hit Check (0ms transition without blocking loading screen)
    if (!forceRefresh) {
      const cached = directoryCache.get(sid, p);
      if (cached) {
        setRightFiles(cached);
        setRightPath(p);
        setSelectedRight([]);
        setRightLoading(false);
        setSessions((prev) =>
          prev.map((s) => (s.id === sid ? { ...s, currentPath: p } : s))
        );
        if (sid !== 'local') {
          const sess = sessions.find((s) => s.id === sid);
          if (sess) saveLastRemotePath(sess.config, p);
        }
        return;
      }
    }

    // 2. Cache Miss or Force Refresh: query backend
    setRightLoading(true);
    try {
      const files = await invokeTauri<FileEntry[]>('list_directory', {
        sessionId: sid,
        path: p,
        bypassCache: forceRefresh,
      });
      directoryCache.set(sid, p, files);
      setRightFiles(files);
      setRightPath(p);
      setSelectedRight([]);
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, currentPath: p } : s))
      );
      if (sid !== 'local') {
        const sess = sessions.find((s) => s.id === sid);
        if (sess) saveLastRemotePath(sess.config, p);
      }
    } catch (e) {
      console.error('loadRightFiles error:', e);
      // Resilience fallback: if remembered path failed to load, fallback to default user path or '/'
      if (p !== '/' && sid !== 'local') {
        try {
          const fallback = await invokeTauri<string>('get_session_default_path', { sessionId: sid }).catch(() => '/');
          const fallbackPath = fallback || '/';
          if (fallbackPath !== p) {
            const fallbackFiles = await invokeTauri<FileEntry[]>('list_directory', {
              sessionId: sid,
              path: fallbackPath,
              bypassCache: true,
            });
            directoryCache.set(sid, fallbackPath, fallbackFiles);
            setRightFiles(fallbackFiles);
            setRightPath(fallbackPath);
            setSessions((prev) =>
              prev.map((s) => (s.id === sid ? { ...s, currentPath: fallbackPath } : s))
            );
          }
        } catch (_fallbackErr) {
          // ignore
        }
      }
    } finally {
      setRightLoading(false);
    }
  };

  // Backward-compatibility load delegates
  const loadLocalFiles = async (p: string, forceRefresh = false) => loadLeftFiles(p, 'local', forceRefresh);
  const loadRemoteFiles = async (p: string, forceRefresh = false) => loadRightFiles(p, rightActiveSessionId, forceRefresh);

  // Synchronize Browsing Handler for Left Navigation
  const handleLeftNavigate = async (newPath: string) => {
    const oldPath = leftPath;
    await loadLeftFiles(newPath);

    if (syncBrowsing) {
      if (oldPath.startsWith(newPath) && newPath !== oldPath) {
        // Going up
        const parts = rightPath.split('/').filter(Boolean);
        parts.pop();
        const parentRight = '/' + parts.join('/');
        loadRightFiles(parentRight);
      } else if (newPath.startsWith(oldPath)) {
        // Going into subfolder
        const sub = newPath.substring(oldPath.length).replace(/^\//, '');
        const targetRight = `${rightPath.replace(/\/$/, '')}/${sub}`;
        loadRightFiles(targetRight);
      }
    }
  };

  // Synchronize Browsing Handler for Right Navigation
  const handleRightNavigate = async (newPath: string) => {
    const oldPath = rightPath;
    await loadRightFiles(newPath);

    if (syncBrowsing) {
      if (oldPath.startsWith(newPath) && newPath !== oldPath) {
        // Going up
        const parts = leftPath.split('/').filter(Boolean);
        parts.pop();
        const parentLeft = '/' + parts.join('/');
        loadLeftFiles(parentLeft);
      } else if (newPath.startsWith(oldPath)) {
        // Going into subfolder
        const sub = newPath.substring(oldPath.length).replace(/^\//, '');
        const targetLeft = `${leftPath.replace(/\/$/, '')}/${sub}`;
        loadLeftFiles(targetLeft);
      }
    }
  };


  const handleSelectLeftSession = async (id: string) => {
    setLeftActiveSessionId(id);
    setFocusedPane('left');
    const sess = sessions.find((s) => s.id === id);
    if (sess) {
      await loadLeftFiles(sess.currentPath || (id === 'local' ? '/Users' : '/'), id);
    }
  };

  const handleSelectRightSession = async (id: string) => {
    setRightActiveSessionId(id);
    setFocusedPane('right');
    const sess = sessions.find((s) => s.id === id);
    if (sess) {
      await loadRightFiles(sess.currentPath || (id === 'local' ? '/Users' : '/'), id);
    }
  };

  const handleCloseLeftSession = async (id: string) => {
    if (id === 'local') return;
    let fallback = '';
    setLeftPaneSessionIds((prev) => {
      const next = prev.filter((sid) => sid !== id);
      fallback = next[0] || '';
      return next;
    });
    setLeftActiveSessionId((prev) => (prev === id ? fallback : prev));
    if (fallback) {
      const sess = sessions.find((s) => s.id === fallback);
      loadLeftFiles(sess?.currentPath || '/Users', fallback);
    } else {
      setLeftFiles([]);
      setLeftPath('');
    }
    if (!rightPaneSessionIds.includes(id)) {
      await handleDisconnect(id);
    }
  };

  const handleCloseRightSession = async (id: string) => {
    if (id === 'local') return;
    let fallback = '';
    setRightPaneSessionIds((prev) => {
      const next = prev.filter((sid) => sid !== id);
      fallback = next[0] || '';
      return next;
    });
    setRightActiveSessionId((prev) => (prev === id ? fallback : prev));
    if (fallback) {
      const sess = sessions.find((s) => s.id === fallback);
      loadRightFiles(sess?.currentPath || (fallback === 'local' ? '/Users' : '/'), fallback);
    } else {
      setRightFiles([]);
      setRightPath('');
    }
    if (!leftPaneSessionIds.includes(id)) {
      await handleDisconnect(id);
    }
  };

  const handleReorderTabs = (pane: 'left' | 'right', fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    console.log('[App handleReorderTabs] Reordering tabs:', { pane, fromIndex, toIndex });
    if (pane === 'left') {
      setLeftPaneSessionIds((prev) => {
        const updated = [...prev];
        const [moved] = updated.splice(fromIndex, 1);
        if (!moved) return prev;
        const insertIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
        updated.splice(Math.max(0, Math.min(insertIndex, updated.length)), 0, moved);
        return updated;
      });
    } else {
      setRightPaneSessionIds((prev) => {
        const updated = [...prev];
        const [moved] = updated.splice(fromIndex, 1);
        if (!moved) return prev;
        const insertIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
        updated.splice(Math.max(0, Math.min(insertIndex, updated.length)), 0, moved);
        return updated;
      });
    }
  };

  const handleMoveTabBetweenPanes = async (
    sessionId: string,
    sourcePane: 'left' | 'right',
    targetPane: 'left' | 'right',
    targetIndex?: number
  ) => {
    console.log('[App handleMoveTabBetweenPanes] Moving session:', { sessionId, sourcePane, targetPane, targetIndex });
    if (sourcePane === targetPane || !sessionId) return;

    if (sourcePane === 'left' && targetPane === 'right') {
      const nextLeft = leftPaneSessionIds.filter((id) => id !== sessionId);
      const fallbackLeft = nextLeft[0] || '';

      setLeftPaneSessionIds(nextLeft);
      if (leftActiveSessionId === sessionId) {
        setLeftActiveSessionId(fallbackLeft);
      }

      setRightPaneSessionIds((prev) => {
        const filtered = prev.filter((id) => id !== sessionId);
        const insertAt = targetIndex !== undefined && targetIndex >= 0 ? Math.min(targetIndex, filtered.length) : filtered.length;
        filtered.splice(insertAt, 0, sessionId);
        return filtered;
      });
      setRightActiveSessionId(sessionId);
      setFocusedPane('right');

      // 2. Load directory contents asynchronously in background
      try {
        const sess = sessions.find((s) => s.id === sessionId);
        const targetPath = sess?.currentPath || (sessionId === 'local' ? '/Users' : '/');
        loadRightFiles(targetPath, sessionId);
      } catch (err) {
        console.error('Error loading right files after tab move:', err);
      }

      if (fallbackLeft) {
        try {
          const fallbackSess = sessions.find((s) => s.id === fallbackLeft);
          loadLeftFiles(fallbackSess?.currentPath || (fallbackLeft === 'local' ? '/Users' : '/'), fallbackLeft);
        } catch (err) {
          console.error('Error loading left fallback files after tab move:', err);
        }
      } else {
        setLeftFiles([]);
        setLeftPath('');
      }
    } else if (sourcePane === 'right' && targetPane === 'left') {
      const nextRight = rightPaneSessionIds.filter((id) => id !== sessionId);
      const fallbackRight = nextRight[0] || '';

      setRightPaneSessionIds(nextRight);
      if (rightActiveSessionId === sessionId) {
        setRightActiveSessionId(fallbackRight);
      }

      setLeftPaneSessionIds((prev) => {
        const filtered = prev.filter((id) => id !== sessionId);
        const insertAt = targetIndex !== undefined && targetIndex >= 0 ? Math.min(targetIndex, filtered.length) : filtered.length;
        filtered.splice(insertAt, 0, sessionId);
        return filtered;
      });
      setLeftActiveSessionId(sessionId);
      setFocusedPane('left');

      // 2. Load directory contents asynchronously in background
      try {
        const sess = sessions.find((s) => s.id === sessionId);
        const targetPath = sess?.currentPath || (sessionId === 'local' ? '/Users' : '/');
        loadLeftFiles(targetPath, sessionId);
      } catch (err) {
        console.error('Error loading left files after tab move:', err);
      }

      if (fallbackRight) {
        try {
          const fallbackSess = sessions.find((s) => s.id === fallbackRight);
          loadRightFiles(fallbackSess?.currentPath || (fallbackRight === 'local' ? '/Users' : '/'), fallbackRight);
        } catch (err) {
          console.error('Error loading right fallback files after tab move:', err);
        }
      } else {
        setRightFiles([]);
        setRightPath('');
      }
    }
  };

  // Directory Comparison (Shift+F2)
  const handleCompareDirectories = async () => {
    try {
      const diffs = await invokeTauri<Array<{ name: string; diff_type: string }>>('compare_directories_fast', {
        localSession: 'local',
        localDir: localPath,
        remoteSession: activeRemoteSessionId,
        remoteDir: remotePath,
        mode: 'both',
      });
      const map: Record<string, string> = {};
      for (const d of diffs) {
        map[d.name] = d.diff_type;
      }
      setDiffMap(map);
    } catch (e) {
      console.error('Comparison error:', e);
    }
  };

  // Keep Remote Up to Date (Continuous Live Sync)
  const handleToggleContinuousSync = async () => {
    if (continuousSync) {
      await invokeTauri('stop_continuous_sync');
      setContinuousSync(false);
    } else {
      try {
        await invokeTauri('start_continuous_sync', {
          localPath,
          remoteSession: activeRemoteSessionId,
          remotePath,
          deleteRemote: false,
        });
        setContinuousSync(true);
      } catch (e) {
        alert(`Failed to start continuous sync: ${e}`);
      }
    }
  };

  // Calculate Directory Size
  const handleCalculateDirectorySize = async (file: FileEntry) => {
    try {
      const isRemote = file.path.startsWith(remotePath);
      const session = isRemote ? activeRemoteSessionId : 'local';
      const sizeBytes = await invokeTauri<number>('calculate_directory_size', {
        sessionId: session,
        path: file.path,
      });
      const format = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const s = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + s[i];
      };
      alert(`Diretório: ${file.name}\nTamanho Total: ${format(sizeBytes)} (${sizeBytes.toLocaleString()} bytes)`);
    } catch (e) {
      alert(`Erro ao calcular tamanho: ${e}`);
    }
  };

  // Connect new session from Site Manager
  const handleConnect = async (cfg: ConnectionConfig) => {
    const sessionId = await invokeTauri<string>('connect_session', { config: cfg });

    let initialPath = '';

    // If "Remember Last Remote Directory" is enabled (default: true), check saved path
    if (rememberLastRemoteDir && cfg.protocol !== 'local') {
      const lastVisited = getLastRemotePath(cfg);
      if (lastVisited && lastVisited.trim().length > 0) {
        initialPath = lastVisited.trim();
      }
    }

    // If disabled OR no last path was saved, use configured remote_root or user home root
    if (!initialPath) {
      initialPath = cfg.remote_root ? cfg.remote_root.trim() : '';
      if (!initialPath || initialPath === '/' || initialPath === '.') {
        try {
          const defaultPath = await invokeTauri<string>('get_session_default_path', { sessionId });
          if (defaultPath && defaultPath !== '/') {
            initialPath = defaultPath;
          } else if (!initialPath) {
            initialPath = '/';
          }
        } catch (_e) {
          if (!initialPath) initialPath = '/';
        }
      }
    }

    const newSession: ActiveSession = {
      id: sessionId,
      config: cfg,
      currentPath: initialPath,
    };

    setSessions((prev) => [...prev, newSession]);

    if (newSessionTargetPane === 'left') {
      setLeftPaneSessionIds((prev) => Array.from(new Set([...prev, sessionId])));
      setLeftActiveSessionId(sessionId);
      await loadLeftFiles(initialPath, sessionId);
      setFocusedPane('left');
    } else {
      setRightPaneSessionIds((prev) => {
        const filtered = prev.filter((id) => id !== 'local' || prev.length > 1);
        return Array.from(new Set([...filtered, sessionId]));
      });
      setRightActiveSessionId(sessionId);
      await loadRightFiles(initialPath, sessionId);
      setFocusedPane('right');
    }
  };

  const handleDisconnect = async (id: string) => {
    directoryCache.invalidateSession(id);
    const targetSession = sessions.find((s) => s.id === id);
    if (targetSession && targetSession.config.protocol !== 'local' && targetSession.currentPath) {
      saveLastRemotePath(targetSession.config, targetSession.currentPath);
    }
    try {
      await invokeTauri('disconnect_session', { sessionId: id });
    } catch (e) {
      console.error('disconnect_session error:', e);
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setLeftPaneSessionIds((prev) => {
      const filtered = prev.filter((sid) => sid !== id);
      return filtered.length > 0 ? filtered : ['local'];
    });
    setRightPaneSessionIds((prev) => {
      const filtered = prev.filter((sid) => sid !== id);
      return filtered.length > 0 ? filtered : ['local'];
    });
    if (leftActiveSessionId === id) {
      setLeftActiveSessionId('local');
      loadLeftFiles(leftPath, 'local');
    }
    if (rightActiveSessionId === id) {
      setRightActiveSessionId('local');
      loadRightFiles(rightPath, 'local');
    }
  };

  const handleSaveSite = async (cfg: ConnectionConfig) => {
    await invokeTauri('save_site', { config: cfg });
    setSavedSites((prev) => {
      const filtered = prev.filter((s) => s.id !== cfg.id);
      return [...filtered, cfg];
    });
  };

  const handleDeleteSite = async (id: string) => {
    await invokeTauri('delete_site', { id });
    setSavedSites((prev) => prev.filter((s) => s.id !== id));
  };

  // --- Modern Code Studio (Editor) Operations ---
  const handleEditFile = async (file: FileEntry) => {
    try {
      const isRemote = file.path.startsWith(remotePath) || (activeRemoteSessionId !== 'local' && selectedRemote.includes(file.path));
      const session = isRemote ? activeRemoteSessionId : 'local';

      const content = await invokeTauri<string>('read_file_content', {
        sessionId: session,
        path: file.path,
      });

      setEditingFile({
        name: file.name,
        path: file.path,
        content: content || '',
        isRemote: session !== 'local',
        sessionId: session,
      });
      setIsEditorOpen(true);
    } catch (e: any) {
      alert(`Erro ao ler arquivo: ${e?.message || e}`);
    }
  };

  // --- Platform Native Terminal ---
  const handleOpenNativeTerminal = async (path: string, isRemote: boolean) => {
    try {
      const sessionId = isRemote ? activeRemoteSessionId : 'local';
      await invokeTauri('open_native_terminal', { sessionId, path, isRemote });
    } catch (e: any) {
      alert(`Erro ao abrir terminal nativo: ${e?.message || e}`);
    }
  };

  // --- Safe Remote Trash Operations ---
  const handleMoveToTrash = async (sessionId: string, paths: string[]) => {
    if (!paths || paths.length === 0) return;
    try {
      await invokeTauri('manage_remote_trash', {
        sessionId,
        action: 'move_to_trash',
        targetPath: paths[0],
        payload: JSON.stringify(paths),
      });
      for (const p of paths) {
        directoryCache.invalidate(sessionId, p);
      }
      if (sessionId === leftActiveSessionId) {
        await loadLeftFiles(leftPath, undefined, true);
      }
      if (sessionId === rightActiveSessionId) {
        await loadRightFiles(rightPath, undefined, true);
      }
    } catch (e: any) {
      alert(`Erro ao mover para a lixeira: ${e?.message || e}`);
    }
  };

  // --- Deletion Handler (Remote Linux Quick Delete rm -rf / Safe Trash / Local) ---
  const handleDeleteItems = async (
    sessionId: string,
    paths: string[],
    currentDir: string,
    refreshPane: () => Promise<void>,
    forcePermanent = false
  ) => {
    if (!paths || paths.length === 0) return;
    const isRemote = sessionId !== 'local';
    const count = paths.length;

    if (isRemote && remoteTrashEnabled && !forcePermanent) {
      setConfirmDialog({
        isOpen: true,
        title: isPt ? 'Mover para a Lixeira Remota' : 'Move to Remote Trash',
        message: isPt
          ? `Deseja mover ${count} item(ns) selecionado(s) para a lixeira remota?`
          : `Move ${count} selected item(s) to remote trash?`,
        subMessage: isPt
          ? 'Os itens poderão ser restaurados posteriormente através do painel de Lixeira Remota.'
          : 'Items can be restored later from the Remote Trash manager.',
        items: paths,
        confirmText: isPt ? 'Mover para Lixeira' : 'Move to Trash',
        cancelText: isPt ? 'Cancelar' : 'Cancel',
        variant: 'warning',
        onConfirm: async () => {
          setConfirmDialog(null);
          await handleMoveToTrash(sessionId, paths);
          directoryCache.invalidate(sessionId, currentDir);
          await refreshPane();
        },
      });
      return;
    }

    // Remote trash is disabled OR Local session OR forced permanent: Permanent deletion
    let title = '';
    let message = '';
    let subMessage = '';

    if (isRemote) {
      if (!remoteTrashEnabled) {
        title = isPt ? 'Exclusão Permanente (Lixeira Remota Desativada)' : 'Permanent Deletion (Remote Trash Disabled)';
        message = isPt
          ? `A Lixeira Remota está DESATIVADA nas configurações. Esta ação executará a exclusão rápida permanente no servidor Linux (rm -rf) para ${count} item(ns) selecionado(s).`
          : `Remote Trash is DISABLED in settings. This action will execute a permanent quick delete on the remote Linux server (rm -rf) for ${count} selected item(s).`;
        subMessage = isPt
          ? '⚠️ ATENÇÃO: Como a função de lixeira está desativada nas configurações, este processo é IRREVERSÍVEL e NÃO poderá ser desfeito!'
          : '⚠️ WARNING: As remote trash is disabled in settings, this process is IRREVERSIBLE and CANNOT be undone!';
      } else {
        title = isPt ? 'Exclusão Permanente Direta' : 'Direct Permanent Deletion';
        message = isPt
          ? `Deseja excluir permanentemente ${count} item(ns) no servidor Linux (rm -rf), sem passar pela lixeira?`
          : `Permanently delete ${count} selected item(s) on Linux server (rm -rf), bypassing trash?`;
        subMessage = isPt
          ? '⚠️ ATENÇÃO: Este processo é IRREVERSÍVEL e NÃO poderá ser desfeito!'
          : '⚠️ WARNING: This process is IRREVERSIBLE and CANNOT be undone!';
      }
    } else {
      title = isPt ? 'Excluir Itens Permanentemente' : 'Permanently Delete Items';
      message = isPt
        ? `Deseja excluir ${count} item(ns) selecionado(s) permanentemente?`
        : `Permanently delete ${count} selected item(s)?`;
      subMessage = isPt
        ? '⚠️ Este processo é irreversível e NÃO poderá ser desfeito.'
        : '⚠️ This process is irreversible and CANNOT be undone.';
    }

    setConfirmDialog({
      isOpen: true,
      title,
      message,
      subMessage,
      items: paths,
      confirmText: isPt ? 'Excluir Permanentemente' : 'Permanently Delete',
      cancelText: isPt ? 'Cancelar' : 'Cancel',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await invokeTauri('delete_items', {
            sessionId,
            paths,
          });
          for (const p of paths) {
            directoryCache.invalidate(sessionId, p);
          }
          directoryCache.invalidate(sessionId, currentDir);
          await refreshPane();
        } catch (e: any) {
          alert(isPt ? `Erro ao excluir: ${e?.message || e}` : `Delete error: ${e?.message || e}`);
        }
      },
    });
  };

  const handleGetTrashStatus = async (): Promise<{ status: RemoteTrashStatus; items: RemoteTrashItem[] }> => {
    try {
      const status = await invokeTauri<RemoteTrashStatus>('manage_remote_trash', {
        sessionId: activeRemoteSessionId,
        action: 'status',
      });
      const items = await invokeTauri<RemoteTrashItem[]>('manage_remote_trash', {
        sessionId: activeRemoteSessionId,
        action: 'list',
      });
      return { status, items: Array.isArray(items) ? items : [] };
    } catch (e) {
      console.error('Failed to query trash status:', e);
      return {
        status: { enabled: remoteTrashEnabled, initialized: remoteTrashEnabled, trash_dir: '~/.local/share/Trash', item_count: 0, total_size_bytes: 0 },
        items: [],
      };
    }
  };

  const handleSetupTrash = async () => {
    await invokeTauri('manage_remote_trash', {
      sessionId: activeRemoteSessionId,
      action: 'setup',
    });
  };

  const handleRestoreTrashItem = async (itemId: string) => {
    await invokeTauri('manage_remote_trash', {
      sessionId: activeRemoteSessionId,
      action: 'restore',
      payload: itemId,
    });
    await loadRemoteFiles(remotePath);
  };

  const handleEmptyTrash = async () => {
    await invokeTauri('manage_remote_trash', {
      sessionId: activeRemoteSessionId,
      action: 'empty',
    });
  };

  const handleToggleRemoteTrash = (enabled: boolean) => {
    setRemoteTrashEnabled(enabled);
    localStorage.setItem('rustscp_remote_trash_enabled', enabled ? 'true' : 'false');
  };

  const handleSaveExternalEditorCmd = (cmd: string) => {
    setExternalEditorCmd(cmd);
    localStorage.setItem('rustscp_external_editor_command', cmd);
  };

  // --- SysAdmin Marketplace & Remote Probing ---
  const handleDetectRemoteSystem = async () => {
    if (activeRemoteSessionId === 'local') return;
    try {
      const info = await invokeTauri<RemoteSystemInfo>('detect_remote_system', {
        sessionId: activeRemoteSessionId,
      });
      setRemoteSystemInfo(info);
    } catch (e) {
      console.error('Failed to probe remote system:', e);
    }
  };

  const handleInstallMarketplaceTool = async (toolId: string) => {
    return await invokeTauri<{ stdout: string; stderr: string; exit_code: number }>('install_marketplace_tool', {
      sessionId: activeRemoteSessionId,
      toolId,
    });
  };

  const handleCheckTool = async (checkCmd: string): Promise<boolean> => {
    try {
      const res = await invokeTauri<{ exit_code: number }>('execute_remote_command', {
        sessionId: activeRemoteSessionId,
        command: checkCmd,
      });
      return res.exit_code === 0;
    } catch (_e) {
      return false;
    }
  };

  // --- Compression Modal Request Triggers ---
  const handleRequestCompress = (sessionId: string, currentDir: string, targetItems: string[]) => {
    setCompressionModalState({
      isOpen: true,
      mode: 'compress',
      sessionId,
      currentDir,
      targetItems,
      archivePath: '',
      isRemote: sessionId !== 'local',
    });
  };

  const handleRequestExtract = (sessionId: string, currentDir: string, archivePath: string) => {
    setCompressionModalState({
      isOpen: true,
      mode: 'extract',
      sessionId,
      currentDir,
      targetItems: [],
      archivePath,
      isRemote: sessionId !== 'local',
    });
  };

  // --- Custom Actions Studio Handlers ---
  const handleSaveCustomAction = async (action: ActionDefinition) => {
    await invokeTauri('manage_custom_actions', {
      action: 'save',
      payload: JSON.stringify(action),
    });
    const catalog = await invokeTauri<ActionDefinition[]>('get_actions_catalog');
    if (catalog) setActionsCatalog(catalog);
  };

  const handleDeleteCustomAction = async (actionId: string) => {
    await invokeTauri('manage_custom_actions', {
      action: 'delete',
      payload: actionId,
    });
    const catalog = await invokeTauri<ActionDefinition[]>('get_actions_catalog');
    if (catalog) setActionsCatalog(catalog);
  };

  // Asynchronous Background Transfers between Panes
  const handleTransferLeftToRight = async () => {
    if (selectedLeft.length === 0) return;
    for (const srcPath of selectedLeft) {
      const fileName = srcPath.split('/').pop() || srcPath;
      const dstPath = `${rightPath.replace(/\/$/, '')}/${fileName}`;
      try {
        await invokeTauri('enqueue_transfer', {
          sourceSession: leftActiveSessionId,
          sourcePath: srcPath,
          destSession: rightActiveSessionId,
          destPath: dstPath,
          isMove: false,
        });
      } catch (e) {
        console.error('Enqueue transfer error:', e);
      }
    }
    setIsTransferDrawerOpen(true);
  };

  const handleTransferRightToLeft = async () => {
    if (selectedRight.length === 0) return;
    for (const srcPath of selectedRight) {
      const fileName = srcPath.split('/').pop() || srcPath;
      const dstPath = `${leftPath.replace(/\/$/, '')}/${fileName}`;
      try {
        await invokeTauri('enqueue_transfer', {
          sourceSession: rightActiveSessionId,
          sourcePath: srcPath,
          destSession: leftActiveSessionId,
          destPath: dstPath,
          isMove: false,
        });
      } catch (e) {
        console.error('Enqueue transfer error:', e);
      }
    }
    setIsTransferDrawerOpen(true);
  };


  // HTML5 Drag & Drop Transfer Handler
  const handleDropItems = async (
    sourceSessionId: string,
    paths: string[],
    destSessionId: string,
    destDir: string,
    isCopy: boolean
  ) => {
    if (!paths || paths.length === 0) return;
    for (const srcPath of paths) {
      const fileName = srcPath.split('/').pop() || srcPath;
      const dstPath = `${destDir.replace(/\/$/, '')}/${fileName}`;
      try {
        await invokeTauri('enqueue_transfer', {
          sourceSession: sourceSessionId,
          sourcePath: srcPath,
          destSession: destSessionId,
          destPath: dstPath,
          isMove: !isCopy,
        });
      } catch (e) {
        console.error('Enqueue drop transfer error:', e);
      }
    }
    setIsTransferDrawerOpen(true);
  };

  // Clipboard & Context Menu Operations
  const handleCopy = (sessionId: string, paths: string[]) => {
    setClipboard({ action: 'copy', sourceSession: sessionId, paths });
  };

  const handleCut = (sessionId: string, paths: string[]) => {
    setClipboard({ action: 'cut', sourceSession: sessionId, paths });
  };

  const handlePaste = async (destSessionId: string, destDir: string) => {
    if (!clipboard || clipboard.paths.length === 0) return;

    for (const path of clipboard.paths) {
      const fileName = path.split('/').pop() || path;
      const destPath = `${destDir.replace(/\/$/, '')}/${fileName}`;
      try {
        await invokeTauri('enqueue_transfer', {
          sourceSession: clipboard.sourceSession,
          sourcePath: path,
          destSession: destSessionId,
          destPath,
          isMove: clipboard.action === 'cut',
        });
      } catch (e) {
        console.error('Enqueue paste transfer error:', e);
      }
    }

    if (clipboard.action === 'cut') {
      setClipboard(null);
    }
    setIsTransferDrawerOpen(true);
  };

  const handleDuplicate = async (sessionId: string, path: string) => {
    try {
      await invokeTauri('duplicate_item', { sessionId, path });
      directoryCache.invalidate(sessionId, path);
      if (sessionId === 'local') {
        loadLocalFiles(localPath, true);
      } else {
        loadRemoteFiles(remotePath, true);
      }
    } catch (e) {
      alert(`Erro ao duplicar item: ${e}`);
    }
  };

  const handleCompress = async (
    sessionId: string,
    currentDir: string,
    items: string[],
    format: string,
    outputName: string
  ) => {
    try {
      await invokeTauri('compress_items', {
        sessionId,
        currentDir,
        items,
        format,
        outputName,
      });
      directoryCache.invalidate(sessionId, currentDir);
      if (sessionId === 'local') {
        loadLocalFiles(localPath, true);
      } else {
        loadRemoteFiles(remotePath, true);
      }
    } catch (e) {
      alert(`Erro ao compactar: ${e}`);
    }
  };

  const handleExtract = async (
    sessionId: string,
    currentDir: string,
    archivePath: string,
    destSubfolder?: string
  ) => {
    try {
      await invokeTauri('extract_archive', {
        sessionId,
        currentDir,
        archivePath,
        destSubfolder,
      });
      directoryCache.invalidate(sessionId, currentDir);
      if (destSubfolder) {
        directoryCache.invalidate(sessionId, `${currentDir}/${destSubfolder}`);
      }
      if (sessionId === 'local') {
        loadLocalFiles(localPath, true);
      } else {
        loadRemoteFiles(remotePath, true);
      }
    } catch (e) {
      alert(`Erro ao extrair arquivo: ${e}`);
    }
  };

  const handleOpenTerminalHere = (path: string, isRemote: boolean) => {
    if (isRemote) {
      setIsRemoteCommandOpen(true);
    } else {
      alert(`Diretório Local Selecionado:\n${path}`);
    }
  };

  const handleExecuteSmartAction = (_action: ActionDefinition, targetPath: string) => {
    setSelectedRemote([targetPath]);
    setIsActionsOpen(true);
  };

  const handleCancelTransferTask = async (taskId: string) => {
    await invokeTauri('cancel_transfer_task', { taskId });
  };

  const handleClearCompletedTransfers = async () => {
    await invokeTauri('clear_completed_transfers');
    setQueueTasks((prev) => prev.filter((t) => t.status === 'in_progress' || t.status === 'queued'));
  };

  const handleLeftGoHome = async () => {
    try {
      const p = await invokeTauri<string>('get_session_default_path', { sessionId: leftActiveSessionId });
      if (p) handleLeftNavigate(p);
    } catch (_e) {}
  };

  const handleRightGoHome = async () => {
    try {
      const p = await invokeTauri<string>('get_session_default_path', { sessionId: rightActiveSessionId });
      if (p) handleRightNavigate(p);
    } catch (_e) {}
  };


  const activeSessionObj = sessions.find((s) => s.id === activeRemoteSessionId);
  const activeTransferCount = queueTasks.filter((t) => t.status === 'in_progress').length;
  const totalSpeedBps = queueTasks
    .filter((t) => t.status === 'in_progress')
    .reduce((acc, t) => acc + (t.speed_bps || 0), 0);

  return (
    <div className="h-screen w-screen flex flex-col bg-dark-900 text-slate-900 dark:text-slate-100 font-sans select-none overflow-hidden">
      {/* Modern Grouped Header with Tools & Virtual Disk */}
      <Header
        onOpenSiteManager={() => {
          setNewSessionTargetPane(focusedPane);
          setIsSiteManagerOpen(true);
        }}
        onOpenSync={() => setIsSyncOpen(true)}
        onOpenRemoteCommand={() => setIsRemoteCommandOpen(true)}
        onOpenActions={() => setIsActionsOpen(true)}
        onOpenMcp={() => setIsMcpOpen(true)}
        onOpenFindFiles={() => setIsFindFilesOpen(true)}
        onOpenScriptConsole={() => setIsScriptConsoleOpen(true)}
        onOpenGenerateCode={() => setIsGenerateCodeOpen(true)}
        onOpenServerInfo={() => setIsServerInfoOpen(true)}
        onOpenVirtualDisk={() => setIsVirtualDiskOpen(true)}
        onOpenMarketplace={() => {
          handleDetectRemoteSystem();
          setIsMarketplaceOpen(true);
        }}
        onOpenTrash={() => setIsRemoteTrashOpen(true)}
        onOpenNativeTerminal={() => handleOpenNativeTerminal(remotePath || localPath, activeRemoteSessionId !== 'local')}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenAbout={() => setIsAboutOpen(true)}
        remoteTrashEnabled={remoteTrashEnabled}
        onCompareDirectories={handleCompareDirectories}
        syncBrowsing={syncBrowsing}
        onToggleSyncBrowsing={() => setSyncBrowsing(!syncBrowsing)}
        continuousSync={continuousSync}
        onToggleContinuousSync={handleToggleContinuousSync}
        mcpStatus={mcpStatus}
        activeTransferCount={activeTransferCount}
        totalSpeedBps={totalSpeedBps}
        onToggleTransferDrawer={() => setIsTransferDrawerOpen(!isTransferDrawerOpen)}
        onOpenAiAssistant={() => setIsAiModalOpen(true)}
        themeMode={themeMode}
        onThemeChange={handleThemeChange}
      />

      {/* RustSCP Session Tabs (Global for Explorer Mode) */}
      {!isDualPane && (
        <SessionTabs
          variant="global"
          sessions={sessions}
          activeSessionId={rightActiveSessionId || leftActiveSessionId}
          onSelectSession={(id) => handleSelectRightSession(id)}
          onCloseSession={handleCloseRightSession}
          onNewSession={() => {
            setNewSessionTargetPane('right');
            setIsSiteManagerOpen(true);
          }}
          isDualPane={isDualPane}
          onToggleDualPane={() => setIsDualPane(!isDualPane)}
        />
      )}

      {/* Main Workspace (Dual-Pane Commander / Explorer) */}
      <DualPane
        isDualPane={isDualPane}
        onToggleDualPane={() => setIsDualPane(!isDualPane)}
        onOpenAiAssistant={() => setIsAiModalOpen(true)}
        onMoveTabBetweenPanes={handleMoveTabBetweenPanes}
        onReorderTabs={handleReorderTabs}

        allSessions={sessions}

        leftSessions={leftPaneSessionIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is ActiveSession => !!s)}
        leftActiveSessionId={leftActiveSessionId}
        onSelectLeftSession={handleSelectLeftSession}
        onCloseLeftSession={handleCloseLeftSession}
        onNewLeftSession={() => {
          setNewSessionTargetPane('left');
          setIsSiteManagerOpen(true);
        }}
        leftSessionName={sessions.find((s) => s.id === leftActiveSessionId)?.config.name}
        leftIsRemote={leftActiveSessionId !== 'local'}
        leftPath={leftPath}
        leftFiles={leftFiles}
        leftLoading={leftLoading}
        selectedLeft={selectedLeft}
        diffMap={diffMap}
        onLeftNavigate={handleLeftNavigate}
        onLeftRefresh={() => loadLeftFiles(leftPath, undefined, true)}
        onSelectLeft={(p, multi) =>
          setSelectedLeft((prev) => (multi ? (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]) : [p]))
        }
        onLeftNewFolder={() => {
          setInputDialog({
            isOpen: true,
            title: isPt ? 'Criar Nova Pasta' : 'Create New Folder',
            message: isPt ? 'Informe o nome para o novo diretório:' : 'Enter name for the new folder:',
            placeholder: isPt ? 'nova-pasta' : 'new-folder',
            confirmText: isPt ? 'Criar Pasta' : 'Create Folder',
            cancelText: isPt ? 'Cancelar' : 'Cancel',
            onConfirm: async (name) => {
              setInputDialog(null);
              if (!name) return;
              try {
                await invokeTauri('create_new_directory', {
                  sessionId: leftActiveSessionId,
                  path: `${leftPath}/${name}`,
                });
                directoryCache.invalidate(leftActiveSessionId, leftPath);
                loadLeftFiles(leftPath, undefined, true);
              } catch (e: any) {
                alert(isPt ? `Erro ao criar pasta: ${e?.message || e}` : `Error creating folder: ${e?.message || e}`);
              }
            },
          });
        }}
        remoteTrashEnabled={remoteTrashEnabled}
        onLeftDelete={(targetPaths, forcePermanent) => {
          const paths = Array.isArray(targetPaths) && targetPaths.length > 0 ? targetPaths : selectedLeft;
          handleDeleteItems(leftActiveSessionId, paths, leftPath, () => loadLeftFiles(leftPath, undefined, true), forcePermanent);
        }}
        onLeftGoHome={handleLeftGoHome}

        rightSessions={rightPaneSessionIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is ActiveSession => !!s)}
        rightActiveSessionId={rightActiveSessionId}
        onSelectRightSession={handleSelectRightSession}
        onCloseRightSession={handleCloseRightSession}
        onNewRightSession={() => {
          setNewSessionTargetPane('right');
          setIsSiteManagerOpen(true);
        }}
        rightSessionName={sessions.find((s) => s.id === rightActiveSessionId)?.config.name}
        rightIsRemote={rightActiveSessionId !== 'local'}
        rightPath={rightPath}
        rightFiles={rightFiles}
        rightLoading={rightLoading}
        selectedRight={selectedRight}
        onRightNavigate={handleRightNavigate}
        onRightRefresh={() => loadRightFiles(rightPath, undefined, true)}
        onSelectRight={(p, multi) =>
          setSelectedRight((prev) => (multi ? (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]) : [p]))
        }
        onRightNewFolder={() => {
          setInputDialog({
            isOpen: true,
            title: isPt ? 'Criar Nova Pasta' : 'Create New Folder',
            message: isPt ? 'Informe o nome para o novo diretório:' : 'Enter name for the new folder:',
            placeholder: isPt ? 'nova-pasta' : 'new-folder',
            confirmText: isPt ? 'Criar Pasta' : 'Create Folder',
            cancelText: isPt ? 'Cancelar' : 'Cancel',
            onConfirm: async (name) => {
              setInputDialog(null);
              if (!name) return;
              try {
                await invokeTauri('create_new_directory', {
                  sessionId: rightActiveSessionId,
                  path: `${rightPath}/${name}`,
                });
                directoryCache.invalidate(rightActiveSessionId, rightPath);
                loadRightFiles(rightPath, undefined, true);
              } catch (e: any) {
                alert(isPt ? `Erro ao criar pasta: ${e?.message || e}` : `Error creating folder: ${e?.message || e}`);
              }
            },
          });
        }}
        onRightDelete={(targetPaths, forcePermanent) => {
          const paths = Array.isArray(targetPaths) && targetPaths.length > 0 ? targetPaths : selectedRight;
          handleDeleteItems(rightActiveSessionId, paths, rightPath, () => loadRightFiles(rightPath, undefined, true), forcePermanent);
        }}
        onRightGoHome={handleRightGoHome}

        focusedPane={focusedPane}
        onFocusPane={setFocusedPane}

        onEditFile={handleEditFile}
        onShowProperties={(file: FileEntry) => setPropertiesFile(file)}
        onCalculateChecksum={(file: FileEntry) => setChecksumFile(file)}
        onCalculateSize={handleCalculateDirectorySize}
        onOpenSymlink={(file?: FileEntry) => setSymlinkData({ isOpen: true, targetPath: file?.path })}
        onOpenFindFiles={() => setIsFindFilesOpen(true)}
        onOpenGenerateCode={() => setIsGenerateCodeOpen(true)}

        onTransferLeftToRight={handleTransferLeftToRight}
        onTransferRightToLeft={handleTransferRightToLeft}
        onDropItems={handleDropItems}

        clipboard={clipboard}
        actionsCatalog={actionsCatalog}
        onCopy={handleCopy}
        onCut={handleCut}
        onPaste={handlePaste}
        onDuplicate={handleDuplicate}
        onCompress={handleCompress}
        onExtract={handleExtract}
        onRequestCompress={handleRequestCompress}
        onRequestExtract={handleRequestExtract}
        onOpenTerminalHere={handleOpenTerminalHere}
        onOpenNativeTerminalHere={handleOpenNativeTerminal}
        onMoveToTrash={(sessionId, paths) => {
          if (!paths || paths.length === 0) return;
          const count = paths.length;
          setConfirmDialog({
            isOpen: true,
            title: isPt ? 'Mover para a Lixeira Remota' : 'Move to Remote Trash',
            message: isPt
              ? `Mover ${count} item(ns) selecionado(s) para a lixeira remota?`
              : `Move ${count} selected item(s) to remote trash?`,
            subMessage: isPt
              ? 'Os itens poderão ser restaurados posteriormente através do painel de Lixeira Remota.'
              : 'Items can be restored later from the Remote Trash manager.',
            items: paths,
            confirmText: isPt ? 'Mover para Lixeira' : 'Move to Trash',
            cancelText: isPt ? 'Cancelar' : 'Cancel',
            variant: 'warning',
            onConfirm: async () => {
              setConfirmDialog(null);
              await handleMoveToTrash(sessionId, paths);
              if (sessionId === leftActiveSessionId) {
                directoryCache.invalidate(sessionId, leftPath);
                await loadLeftFiles(leftPath, undefined, true);
              }
              if (sessionId === rightActiveSessionId) {
                directoryCache.invalidate(sessionId, rightPath);
                await loadRightFiles(rightPath, undefined, true);
              }
            },
          });
        }}
        onExecuteSmartAction={handleExecuteSmartAction}
      />

      {/* Bottom Asynchronous Transfer Queue Drawer */}
      <TransferQueue
        tasks={queueTasks}
        onCancelTask={handleCancelTransferTask}
        onClearCompleted={handleClearCompletedTransfers}
        isExpanded={isTransferDrawerOpen}
        onToggleExpand={() => setIsTransferDrawerOpen(!isTransferDrawerOpen)}
      />

      {/* Native Virtual Disk & Network Drive (Mountain Duck style) */}
      <VirtualDiskModal
        isOpen={isVirtualDiskOpen}
        onClose={() => setIsVirtualDiskOpen(false)}
        sessions={sessions}
        activeSessionId={activeRemoteSessionId}
      />

      {/* RustSCP Site Manager (Login Dialog) */}
      <LoginDialog
        isOpen={isSiteManagerOpen}
        onClose={() => setIsSiteManagerOpen(false)}
        savedSites={savedSites}
        onConnect={handleConnect}
        onSaveSite={handleSaveSite}
        onDeleteSite={handleDeleteSite}
        onSitesUpdated={(newSites) => setSavedSites(newSites)}
      />

      {/* RustSCP Find Files (Shift+F7) */}
      <FindFilesModal
        isOpen={isFindFilesOpen}
        onClose={() => setIsFindFilesOpen(false)}
        sessionId={activeRemoteSessionId}
        initialPath={remotePath}
        onNavigateToPath={(p) => loadRemoteFiles(p)}
        onOpenFileEditor={(p) => {
          invokeTauri<string>('read_file_content', {
            sessionId: activeRemoteSessionId,
            path: p,
          }).then((content) => {
            const fileName = p.split('/').pop() || p;
            setEditingFile({
              name: fileName,
              path: p,
              content: content || '',
              isRemote: activeRemoteSessionId !== 'local',
              sessionId: activeRemoteSessionId,
            });
            setIsEditorOpen(true);
          });
        }}
      />

      {/* RustSCP Script Console */}
      <ScriptConsoleModal
        isOpen={isScriptConsoleOpen}
        onClose={() => setIsScriptConsoleOpen(false)}
        sessionId={activeRemoteSessionId}
        localPath={localPath}
        remotePath={remotePath}
      />

      {/* RustSCP Generate Code & URL Dialog */}
      <GenerateCodeModal
        isOpen={isGenerateCodeOpen}
        onClose={() => setIsGenerateCodeOpen(false)}
        config={activeSessionObj?.config || null}
        remotePath={remotePath}
        localPath={localPath}
      />

      {/* RustSCP Server & Filesystem Information Dialog */}
      <FileSystemInfoModal
        isOpen={isServerInfoOpen}
        onClose={() => setIsServerInfoOpen(false)}
        sessionId={activeRemoteSessionId}
        path={remotePath}
      />

      {/* RustSCP Symlink / Hardlink Dialog */}
      <SymlinkModal
        isOpen={symlinkData.isOpen}
        onClose={() => setSymlinkData({ isOpen: false })}
        sessionId={activeRemoteSessionId}
        currentDir={remotePath}
        selectedItemPath={symlinkData.targetPath}
        onSuccess={() => {
          directoryCache.invalidate(activeRemoteSessionId, remotePath);
          directoryCache.invalidate('local', localPath);
          loadRemoteFiles(remotePath, true);
          loadLocalFiles(localPath, true);
        }}
      />

      {/* RustSCP Code Studio (Modern Multi-Tab Editor) */}
      <RustScpEditor
        isOpen={isEditorOpen}
        onClose={() => {
          setIsEditorOpen(false);
          setEditingFile(null);
        }}
        initialFile={editingFile}
        onSave={async (path, content, sessionId) => {
          await invokeTauri('write_file_content', { sessionId, path, content });
          directoryCache.invalidate(sessionId, path);
          if (sessionId === 'local') {
            await loadLocalFiles(localPath, true);
          } else {
            await loadRemoteFiles(remotePath, true);
          }
        }}
        onOpenExternal={async (path) => {
          const session = path.startsWith(remotePath) ? activeRemoteSessionId : 'local';
          await invokeTauri('open_in_external_editor', {
            sessionId: session,
            path,
            editorCommand: externalEditorCmd || undefined,
          });
        }}
      />

      {/* RustSCP Properties & Permissions Chmod */}
      {propertiesFile && (
        <FilePropertiesModal
          isOpen={true}
          onClose={() => setPropertiesFile(null)}
          file={propertiesFile}
          onApplyPermissions={async (path, mode) => {
            await invokeTauri('change_permissions', {
              sessionId: activeRemoteSessionId,
              path,
              mode,
            });
            directoryCache.invalidate(activeRemoteSessionId, path);
            loadRemoteFiles(remotePath, true);
          }}
        />
      )}

      {/* RustSCP Directory Synchronization & Compare */}
      <SyncDialog
        isOpen={isSyncOpen}
        onClose={() => setIsSyncOpen(false)}
        localPath={localPath}
        remotePath={remotePath}
        onCompare={async (options) => {
          return await invokeTauri<SyncItem[]>('compare_and_sync_plan', {
            localSession: 'local',
            localDir: localPath,
            remoteSession: activeRemoteSessionId,
            remoteDir: remotePath,
            options,
          });
        }}
        onExecuteSync={async (plan) => {
          for (const item of plan) {
            if (item.action === 'upload') {
              await invokeTauri('enqueue_transfer', {
                sourceSession: 'local',
                sourcePath: `${localPath}/${item.relative_path}`,
                destSession: activeRemoteSessionId,
                destPath: `${remotePath}/${item.relative_path}`,
                isMove: false,
              });
            } else if (item.action === 'download') {
              await invokeTauri('enqueue_transfer', {
                sourceSession: activeRemoteSessionId,
                sourcePath: `${remotePath}/${item.relative_path}`,
                destSession: 'local',
                destPath: `${localPath}/${item.relative_path}`,
                isMove: false,
              });
            }
          }
          setIsTransferDrawerOpen(true);
        }}
      />

      {/* RustSCP Execute Remote Command */}
      <RemoteCommandDialog
        isOpen={isRemoteCommandOpen}
        onClose={() => setIsRemoteCommandOpen(false)}
        remoteSessionName={activeSessionObj?.config.name || 'Remote'}
        onExecute={async (cmd) => {
          return await invokeTauri('execute_remote_command', {
            sessionId: activeRemoteSessionId,
            command: cmd,
          });
        }}
      />

      {/* RustSCP Checksums */}
      {checksumFile && (
        <ChecksumModal
          isOpen={true}
          onClose={() => setChecksumFile(null)}
          fileName={checksumFile.name}
          filePath={checksumFile.path}
          onCalculate={async (algorithm) => {
            const res = await invokeTauri<{ hash: string }>('calculate_checksum', {
              sessionId: activeRemoteSessionId,
              path: checksumFile.path,
              algorithm,
            });
            return res.hash;
          }}
        />
      )}

      {/* Smart Command Studio Modal */}
      <CommandStudioModal
        isOpen={isActionsOpen}
        onClose={() => setIsActionsOpen(false)}
        actions={actionsCatalog}
        selectedPaths={selectedRemote.length > 0 ? selectedRemote : selectedLocal}
        currentDir={remotePath}
        isRemote={activeRemoteSessionId !== 'local'}
        onExecute={async (cmd) => {
          return await invokeTauri<{ stdout: string; stderr: string; exit_code: number }>('execute_remote_command', {
            sessionId: activeRemoteSessionId,
            command: cmd,
          });
        }}
        onSaveCustomAction={handleSaveCustomAction}
        onDeleteCustomAction={handleDeleteCustomAction}
      />

      {/* SysAdmin Marketplace (1-Click) */}
      <SysAdminMarketplaceModal
        isOpen={isMarketplaceOpen}
        onClose={() => setIsMarketplaceOpen(false)}
        sessionId={activeRemoteSessionId}
        sessionName={activeSessionObj?.config.name || 'Remote Server'}
        isRemote={activeRemoteSessionId !== 'local'}
        systemInfo={remoteSystemInfo}
        onRefreshSystemInfo={handleDetectRemoteSystem}
        onCheckTool={handleCheckTool}
        onInstallTool={handleInstallMarketplaceTool}
      />

      {/* Secure Remote Trash Modal */}
      <RemoteTrashModal
        isOpen={isRemoteTrashOpen}
        onClose={() => setIsRemoteTrashOpen(false)}
        sessionId={activeRemoteSessionId}
        sessionName={activeSessionObj?.config.name || 'Remote Server'}
        isTrashEnabled={remoteTrashEnabled}
        onGetTrashStatus={handleGetTrashStatus}
        onSetupTrash={handleSetupTrash}
        onRestoreItem={handleRestoreTrashItem}
        onEmptyTrash={handleEmptyTrash}
      />

      {/* Advanced Compression & Extraction Modal */}
      <CompressionModal
        isOpen={compressionModalState.isOpen}
        onClose={() => setCompressionModalState((prev) => ({ ...prev, isOpen: false }))}
        mode={compressionModalState.mode}
        currentDir={compressionModalState.currentDir}
        targetItems={compressionModalState.targetItems}
        archivePath={compressionModalState.archivePath}
        isRemote={compressionModalState.isRemote}
        onCompress={async (items, format, outputName) => {
          await handleCompress(
            compressionModalState.sessionId,
            compressionModalState.currentDir,
            items,
            format,
            outputName
          );
        }}
        onExtract={async (archivePath, destSubfolder) => {
          await handleExtract(
            compressionModalState.sessionId,
            compressionModalState.currentDir,
            archivePath,
            destSubfolder
          );
        }}
      />

      {/* Settings Modal */}
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
        onOpenRemoteTrashModal={() => {
          setIsSettingsOpen(false);
          setIsRemoteTrashOpen(true);
        }}
        onOpenAbout={() => {
          setIsSettingsOpen(false);
          setIsAboutOpen(true);
        }}
      />

      {/* RustSCP About & Version Diagnostic Modal */}
      <AboutModal
        isOpen={isAboutOpen}
        onClose={() => setIsAboutOpen(false)}
      />

      {/* MCP AI Gateway */}
      <McpGatewayModal
        isOpen={isMcpOpen}
        onClose={() => setIsMcpOpen(false)}
        status={mcpStatus}
        auditLogs={auditLogs}
      />

      {/* RustSCP AI Assistant Modal */}
      {isAiModalOpen && (
        <AiAssistantModal
          isOpen={isAiModalOpen}
          onClose={() => setIsAiModalOpen(false)}
          activeSessionId={activeRemoteSessionId || 'local'}
          activeSessionName={activeSessionObj?.config.name || 'Local Machine'}
          isRemote={!!activeRemoteSessionId && activeRemoteSessionId !== 'local'}
          currentPath={remotePath || localPath}
          files={remoteFiles.length > 0 ? remoteFiles : localFiles}
          onRefreshFiles={() => {
            if (activeRemoteSessionId) loadRemoteFiles(remotePath);
            loadLocalFiles(localPath);
          }}
          onExecuteRemoteCommand={async (cmd) => {
            return await invokeTauri('execute_remote_command', {
              sessionId: activeRemoteSessionId,
              command: cmd,
            });
          }}
        />
      )}

      {/* Confirmation Dialog Modal */}
      {confirmDialog && (
        <ConfirmDialogModal
          {...confirmDialog}
          onClose={() => setConfirmDialog(null)}
        />
      )}

      {/* Input Dialog Modal */}
      {inputDialog && (
        <InputDialogModal
          {...inputDialog}
          onClose={() => setInputDialog(null)}
        />
      )}
    </div>
  );
};
