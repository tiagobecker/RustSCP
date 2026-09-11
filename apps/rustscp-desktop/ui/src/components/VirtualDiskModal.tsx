import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  HardDrive,
  X,
  Check,
  Disc,
  Power,
  AlertCircle,
  FolderCheck,
  Database,
  Trash2,
  RefreshCw,
  Zap,
  Sliders,
  ShieldCheck,
  ExternalLink,
  CornerDownRight,
} from 'lucide-react';

interface VirtualDiskInfo {
  session_id: string;
  session_name: string;
  mount_point: string;
  mount_root: string;
  port: number;
  is_mounted: boolean;
  read_bytes: number;
  write_bytes: number;
  shortcut_path?: string | null;
}

interface SiteCacheStats {
  session_id: string;
  session_name: string;
  total_bytes: number;
  file_count: number;
  last_accessed: string;
}

interface CacheStats {
  total_bytes: number;
  max_bytes: number;
  file_count: number;
  catalog_folders_count?: number;
  catalog_items_count?: number;
  sites: SiteCacheStats[];
}

interface ActiveSession {
  id: string;
  config: {
    id: string;
    name: string;
    protocol: string;
    host: string;
    port: number;
  };
}

interface VirtualDiskModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: ActiveSession[];
  activeSessionId: string;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const PRESET_QUOTAS = [
  { label: '500 MB', bytes: 500 * 1024 * 1024 },
  { label: '1 GB', bytes: 1024 * 1024 * 1024 },
  { label: '2 GB', bytes: 2 * 1024 * 1024 * 1024 },
  { label: '5 GB', bytes: 5 * 1024 * 1024 * 1024 },
];

export const VirtualDiskModal: React.FC<VirtualDiskModalProps> = ({
  isOpen,
  onClose,
  sessions,
  activeSessionId,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [disks, setDisks] = useState<VirtualDiskInfo[]>([]);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadDisksStatus();
      loadCacheStats();
    }
  }, [isOpen]);

  const loadDisksStatus = async () => {
    try {
      const activeDisks = await invoke<VirtualDiskInfo[]>('get_virtual_disks_status');
      setDisks(activeDisks);
    } catch (e: any) {
      console.error(e);
    }
  };

  const loadCacheStats = async () => {
    try {
      const stats = await invoke<CacheStats>('get_cache_stats');
      setCacheStats(stats);
    } catch (e: any) {
      console.error('Failed to get cache stats', e);
    }
  };

  const handleMount = async (sessionId: string) => {
    setLoadingSession(sessionId);
    setErrorMessage(null);
    try {
      const info = await invoke<VirtualDiskInfo>('mount_virtual_disk', { sessionId });
      setDisks((prev) => {
        const filtered = prev.filter((d) => d.session_id !== sessionId);
        return [...filtered, info];
      });
      loadCacheStats();
      // Auto-open in native file manager
      try {
        await invoke('open_virtual_disk_folder', { sessionId });
      } catch (openErr) {
        console.warn('Auto-open folder notice:', openErr);
      }
    } catch (err: any) {
      setErrorMessage(err.toString());
    } finally {
      setLoadingSession(null);
    }
  };

  const handleOpenDisk = async (sessionId: string) => {
    try {
      await invoke('open_virtual_disk_folder', { sessionId });
    } catch (err: any) {
      setErrorMessage(err.toString());
    }
  };

  const handleUnmount = async (sessionId: string) => {
    setLoadingSession(sessionId);
    setErrorMessage(null);
    try {
      await invoke('unmount_virtual_disk', { sessionId });
      setDisks((prev) => prev.filter((d) => d.session_id !== sessionId));
    } catch (err: any) {
      setErrorMessage(err.toString());
    } finally {
      setLoadingSession(null);
    }
  };

  const handleSetMaxQuota = async (bytes: number) => {
    try {
      await invoke('set_max_cache_size', { maxBytes: bytes });
      loadCacheStats();
    } catch (e: any) {
      console.error(e);
    }
  };

  const handleClearSiteCache = async (sessionId: string) => {
    setClearingCache(true);
    try {
      await invoke('clear_site_cache', { sessionId });
      await loadCacheStats();
    } catch (e: any) {
      console.error(e);
    } finally {
      setClearingCache(false);
    }
  };

  const handleClearAllCache = async () => {
    setClearingCache(true);
    try {
      await invoke('clear_all_cache');
      await loadCacheStats();
    } catch (e: any) {
      console.error(e);
    } finally {
      setClearingCache(false);
    }
  };

  if (!isOpen) return null;

  const usagePercent = cacheStats
    ? Math.min(100, Math.round((cacheStats.total_bytes / (cacheStats.max_bytes || 1)) * 100))
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden text-slate-900 dark:text-slate-100 my-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-xl border border-emerald-500/20">
              <Disc className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 tracking-wide">
                {isPt ? 'Disco Virtual & Local de Rede' : 'Virtual Network Disk'}
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {isPt
                  ? 'Montagem shadow/fake ultrarrápida a partir do root do usuário com cache gerenciável'
                  : 'Ultra-fast shadow mount rooted at user home with manageable disk cache'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto bg-white dark:bg-dark-900">
          {errorMessage && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-300 text-xs rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Highlights / Features Banner */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-dark-800/80 border border-slate-200 dark:border-slate-800 flex items-start gap-2.5">
              <Zap className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-slate-900 dark:text-slate-200">
                  {isPt ? 'Catálogo Sombra (Shadow Mount)' : 'Shadow Catalog Mount'}
                </span>
                <p className="text-slate-600 dark:text-slate-400 mt-0.5 text-[11px] leading-relaxed">
                  {isPt
                    ? 'Navegação instantânea no Finder/Explorer sem baixar arquivos com antecedência. Downloads ocorrem sob demanda apenas ao abrir.'
                    : 'Instant folder browsing without pre-downloading. Files are downloaded lazily on-demand upon open.'}
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 dark:bg-dark-800/80 border border-slate-200 dark:border-slate-800 flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-slate-900 dark:text-slate-200">
                  {isPt ? 'Isolamento no Root do Usuário' : 'Chrooted User Root'}
                </span>
                <p className="text-slate-600 dark:text-slate-400 mt-0.5 text-[11px] leading-relaxed">
                  {isPt
                    ? 'Monta estritamente a pasta pessoal do usuário logado (ex: /home/aquelelink.com.br), blindando a raiz do Linux.'
                    : 'Mounts strictly inside the user’s home directory, preventing unnecessary exposure of server system root.'}
                </p>
              </div>
            </div>
          </div>

          {/* Active Sessions Mount List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
              <span className="font-semibold">{isPt ? 'Conexões Disponíveis para Montagem:' : 'Available Sessions for Mounting:'}</span>
              <span className="text-[11px] text-slate-500 font-mono">
                {sessions.length} {isPt ? 'servidor(es)' : 'server(s)'}
              </span>
            </div>

            {sessions.map((sess) => {
              const disk = disks.find((d) => d.session_id === sess.id);
              const isMounted = disk?.is_mounted;
              const isLoading = loadingSession === sess.id;

              return (
                <div
                  key={sess.id}
                  className={`p-4 rounded-xl border transition-all flex flex-col md:flex-row md:items-center justify-between gap-3 ${
                    isMounted
                      ? 'bg-emerald-500/10 border-emerald-500/30 shadow-lg shadow-emerald-950/10'
                      : 'bg-slate-50 dark:bg-dark-800/60 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div
                      className={`p-2.5 rounded-xl shrink-0 mt-0.5 ${
                        isMounted ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300' : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      <HardDrive className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-sm text-slate-900 dark:text-slate-100">{sess.config.name}</span>
                        <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold">
                          {sess.config.protocol}
                        </span>
                        {sess.id === activeSessionId && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-700 dark:text-sky-300 border border-sky-500/30 font-semibold">
                            {isPt ? 'Aba Ativa' : 'Active Tab'}
                          </span>
                        )}
                        {isMounted && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded-full border border-emerald-500/30">
                            <Check className="w-3 h-3" />
                            {isPt ? 'Montado no SO' : 'Mounted'}
                          </span>
                        )}
                      </div>

                      {/* Mount Details */}
                      <div className="text-xs font-mono text-slate-600 dark:text-slate-400 mt-1 space-y-0.5">
                        {isMounted ? (
                          <>
                            <div className="text-emerald-700 dark:text-emerald-300 flex items-center gap-1 truncate font-medium">
                              <span className="text-slate-500">Local SO:</span>
                              <span>{disk.mount_point}</span>
                            </div>
                            {disk.shortcut_path && (
                              <div className="text-sky-700 dark:text-sky-300/90 flex items-center gap-1 truncate font-medium">
                                <CornerDownRight className="w-3.5 h-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                                <span className="text-slate-500">{isPt ? 'Atalho na Mesa:' : 'Desktop Shortcut:'}</span>
                                <span className="font-semibold truncate">{disk.shortcut_path}</span>
                              </div>
                            )}
                            {disk.mount_root && (
                              <div className="text-emerald-700 dark:text-emerald-400/90 flex items-center gap-1 truncate font-medium">
                                <FolderCheck className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                <span className="text-slate-500">Root Remoto:</span>
                                <span className="font-semibold">{disk.mount_root}</span>
                              </div>
                            )}
                            {(disk.read_bytes > 0 || disk.write_bytes > 0) && (
                              <div className="text-slate-500 dark:text-slate-400 text-[11px] flex items-center gap-2 pt-0.5">
                                <span>{isPt ? 'Tráfego:' : 'Traffic:'}</span>
                                <span className="text-emerald-600 dark:text-emerald-400">↓ {formatBytes(disk.read_bytes)}</span>
                                <span>•</span>
                                <span className="text-sky-600 dark:text-sky-400">↑ {formatBytes(disk.write_bytes)}</span>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-slate-600 dark:text-slate-400">
                            {sess.config.host}:{sess.config.port || 22}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                    {isMounted ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleOpenDisk(sess.id)}
                          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors shadow-md"
                          title={isPt ? 'Abrir no gerenciador de arquivos nativo' : 'Open in native file explorer'}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>{isPt ? 'Acessar Disco' : 'Open Drive'}</span>
                        </button>
                        <button
                          onClick={() => handleUnmount(sess.id)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-600/15 hover:bg-rose-600/25 border border-rose-500/40 text-rose-700 dark:text-rose-300 text-xs font-medium transition-colors"
                        >
                          <Power className="w-3.5 h-3.5" />
                          {isLoading ? (isPt ? 'Ejetando...' : 'Ejecting...') : isPt ? 'Desmontar' : 'Unmount'}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleMount(sess.id)}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors shadow-md"
                      >
                        <Disc className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                        {isLoading
                          ? isPt
                            ? 'Montando...'
                            : 'Mounting...'
                          : isPt
                          ? 'Montar no Finder'
                          : 'Mount Drive'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Intelligent Cache Management Section */}
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-200">
                  {isPt ? 'Gerenciamento de Cache Local (LRU)' : 'Local Cache Management (LRU)'}
                </h3>
              </div>
              <button
                onClick={loadCacheStats}
                className="text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 flex items-center gap-1 transition-colors"
                title={isPt ? 'Atualizar estatísticas' : 'Refresh stats'}
              >
                <RefreshCw className="w-3 h-3" />
                <span>{isPt ? 'Atualizar' : 'Refresh'}</span>
              </button>
            </div>

            {/* Storage Usage Bar */}
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-dark-800/60 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-700 dark:text-slate-300">
                  {isPt ? 'Armazenamento Usado em Cache:' : 'Cache Storage Used:'}{' '}
                  <strong className="text-indigo-700 dark:text-indigo-300 font-mono">
                    {formatBytes(cacheStats?.total_bytes || 0)}
                  </strong>{' '}
                  <span className="text-slate-500">
                    / {formatBytes(cacheStats?.max_bytes || 1024 * 1024 * 1024)}
                  </span>
                </span>
                <span className="text-slate-600 dark:text-slate-400 font-mono font-medium">
                  {cacheStats?.file_count || 0} {isPt ? 'arquivos em cache' : 'cached files'} ({usagePercent}%)
                </span>
              </div>

              {/* Shadow Catalog in-memory stats */}
              <div className="flex flex-wrap items-center justify-between text-xs gap-2 pt-1 border-t border-slate-200 dark:border-slate-800/80">
                <span className="text-slate-600 dark:text-slate-400">
                  {isPt ? 'Catálogo Sombra em Memória:' : 'Shadow Catalog in Memory:'}{' '}
                  <strong className="text-emerald-700 dark:text-emerald-300 font-mono">
                    {cacheStats?.catalog_folders_count || 0}
                  </strong>{' '}
                  <span className="text-slate-500">
                    {isPt ? 'pastas indexadas' : 'folders indexed'}
                  </span>
                  {' • '}
                  <strong className="text-emerald-700 dark:text-emerald-300 font-mono">
                    {cacheStats?.catalog_items_count || 0}
                  </strong>{' '}
                  <span className="text-slate-500">
                    {isPt ? 'arquivos em cache de metadados' : 'files in metadata cache'}
                  </span>
                </span>
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 rounded-full ${
                    usagePercent > 90
                      ? 'bg-rose-500'
                      : usagePercent > 70
                      ? 'bg-amber-500'
                      : 'bg-indigo-500'
                  }`}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>

              {/* Quota Selector */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <Sliders className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                  <span className="text-xs text-slate-700 dark:text-slate-400 font-semibold">
                    {isPt ? 'Limite Máximo (Cota):' : 'Max Cache Quota:'}
                  </span>
                  <div className="flex items-center gap-1">
                    {PRESET_QUOTAS.map((preset) => {
                      const isSelected = cacheStats?.max_bytes === preset.bytes;
                      return (
                        <button
                          key={preset.label}
                          onClick={() => handleSetMaxQuota(preset.bytes)}
                          className={`text-[11px] px-2.5 py-1 rounded-lg font-mono transition-all border ${
                            isSelected
                              ? 'bg-indigo-600 text-white font-bold shadow-sm border-indigo-600'
                              : 'bg-slate-200 hover:bg-slate-300 text-slate-700 border-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:border-slate-700'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <button
                  onClick={handleClearAllCache}
                  disabled={clearingCache || !cacheStats?.total_bytes}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-600/15 hover:bg-rose-600/25 border border-rose-500/30 text-rose-700 dark:text-rose-300 text-xs font-semibold transition-colors disabled:opacity-40"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>{isPt ? 'Limpar Todo o Cache' : 'Clear All Cache'}</span>
                </button>
              </div>

              <p className="text-[11px] text-slate-500 leading-tight">
                {isPt
                  ? '💡 Descarte automático LRU: quando o limite for atingido, o RustSCP expurga automaticamente os arquivos mais antigos ou de sites que não são mais acessados.'
                  : '💡 Automatic LRU Eviction: when the limit is reached, RustSCP automatically purges oldest files and stale site caches.'}
              </p>
            </div>

            {/* Per-Site Cache List */}
            {cacheStats && cacheStats.sites.length > 0 && (
              <div className="space-y-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-400">
                  {isPt ? 'Detalhamento de Cache por Servidor:' : 'Cache Breakdown by Server:'}
                </span>
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {cacheStats.sites.map((site) => (
                    <div
                      key={site.session_id}
                      className="p-2.5 rounded-lg bg-slate-50 dark:bg-dark-800/40 border border-slate-200 dark:border-slate-800/80 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="font-semibold text-slate-900 dark:text-slate-200 truncate">
                          {site.session_name}
                        </span>
                        <span className="text-slate-500 font-mono text-[11px]">
                          ({site.file_count} {isPt ? 'arquivos' : 'files'}, {formatBytes(site.total_bytes)})
                        </span>
                      </div>
                      <button
                        onClick={() => handleClearSiteCache(site.session_id)}
                        disabled={clearingCache}
                        className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-300 p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
                        title={isPt ? 'Limpar cache deste site' : 'Clear site cache'}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none">
          <span className="text-xs text-slate-600 dark:text-slate-400">
            {isPt
              ? 'WebDAV Loopback local de altíssimo desempenho com cache LRU'
              : 'High-performance local loopback WebDAV with LRU cache'}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-semibold border border-slate-300 dark:border-slate-700 transition-colors"
          >
            {isPt ? 'Fechar' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};
