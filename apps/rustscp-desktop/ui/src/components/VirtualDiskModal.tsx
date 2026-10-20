import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { HardDrive, AlertTriangle, Trash2, RefreshCw, FolderOpen, Eject, ShieldCheck, Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, IconButton, Segmented } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';

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
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const MB = 1024 * 1024;
const PRESET_QUOTAS = [
  { label: '500 MB', bytes: 500 * MB },
  { label: '1 GB', bytes: 1024 * MB },
  { label: '2 GB', bytes: 2 * 1024 * MB },
  { label: '5 GB', bytes: 5 * 1024 * MB },
];

/** Status is refreshed while the dialog is open so an eject in the file manager shows up. */
const STATUS_POLL_MS = 5000;

const PLATFORM = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent || '' : '';
const IS_MAC = /Mac/i.test(PLATFORM);
const IS_WIN = /Win/i.test(PLATFORM);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The local machine is already a normal folder: mounting it over WebDAV only adds exposure. */
const isMountable = (s: ActiveSession) => s.id !== 'local' && (s.config?.protocol || '').toLowerCase() !== 'local';

export const VirtualDiskModal: React.FC<VirtualDiskModalProps> = ({ isOpen, onClose, sessions, activeSessionId }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || 'en').toLowerCase().startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const [disks, setDisks] = useState<VirtualDiskInfo[]>([]);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const cancelClearRef = useRef<HTMLButtonElement>(null);

  const fileManager = IS_MAC ? 'Finder' : IS_WIN ? tr('Explorador de Arquivos', 'File Explorer') : tr('Arquivos', 'Files');

  /** `quiet` (background polling) never replaces an error the user is reading. */
  const loadDisksStatus = async (quiet = false) => {
    try {
      const activeDisks = await invoke<VirtualDiskInfo[]>('get_virtual_disks_status');
      setDisks(Array.isArray(activeDisks) ? activeDisks : []);
    } catch (e) {
      if (!quiet) setErrorMessage(tr(`Não foi possível ler o estado dos discos: ${errText(e)}`, `Could not read the drive status: ${errText(e)}`));
    }
  };

  const loadCacheStats = async () => {
    try {
      const stats = await invoke<CacheStats>('get_cache_stats');
      setCacheStats(stats);
      setCacheError(null);
    } catch (e) {
      setCacheError(errText(e));
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setErrorMessage(null);
    setConfirmClearAll(false);
    void loadDisksStatus();
    void loadCacheStats();
    const timer = setInterval(() => void loadDisksStatus(true), STATUS_POLL_MS);
    const onFocus = () => void loadDisksStatus(true);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleMount = async (sessionId: string) => {
    setLoadingSession(sessionId);
    setErrorMessage(null);
    try {
      const info = await invoke<VirtualDiskInfo>('mount_virtual_disk', { sessionId });
      setDisks((prev) => [...prev.filter((d) => d.session_id !== sessionId), info]);
      void loadCacheStats();
      try {
        await invoke('open_virtual_disk_folder', { sessionId });
      } catch {
        // Mounted fine; opening the file manager is a convenience
      }
    } catch (err) {
      setErrorMessage(tr(`Não foi possível montar: ${errText(err)}`, `Could not mount: ${errText(err)}`));
    } finally {
      setLoadingSession(null);
    }
  };

  const handleOpenDisk = async (sessionId: string) => {
    try {
      await invoke('open_virtual_disk_folder', { sessionId });
    } catch (err) {
      setErrorMessage(tr(`Não foi possível abrir o disco: ${errText(err)}`, `Could not open the drive: ${errText(err)}`));
    }
  };

  const handleUnmount = async (sessionId: string) => {
    setLoadingSession(sessionId);
    setErrorMessage(null);
    try {
      await invoke('unmount_virtual_disk', { sessionId });
      setDisks((prev) => prev.filter((d) => d.session_id !== sessionId));
    } catch (err) {
      setErrorMessage(tr(`Não foi possível ejetar: ${errText(err)}`, `Could not eject: ${errText(err)}`));
    } finally {
      setLoadingSession(null);
    }
  };

  const handleSetMaxQuota = async (bytes: number) => {
    try {
      await invoke('set_max_cache_size', { maxBytes: bytes });
      await loadCacheStats();
    } catch (e) {
      notify.error(tr('Não foi possível alterar o limite do cache', 'Could not change the cache limit'), e);
    }
  };

  const handleClearSiteCache = async (site: SiteCacheStats) => {
    setClearingCache(true);
    try {
      await invoke('clear_site_cache', { sessionId: site.session_id });
      await loadCacheStats();
      notify.success(tr(`Cache de ${site.session_name} limpo`, `Cleared the cache for ${site.session_name}`));
    } catch (e) {
      notify.error(tr('Não foi possível limpar o cache', 'Could not clear the cache'), e);
    } finally {
      setClearingCache(false);
    }
  };

  const handleClearAllCache = async () => {
    setConfirmClearAll(false);
    setClearingCache(true);
    try {
      await invoke('clear_all_cache');
      await loadCacheStats();
      notify.success(tr('Cache limpo', 'Cache cleared'));
    } catch (e) {
      notify.error(tr('Não foi possível limpar o cache', 'Could not clear the cache'), e);
    } finally {
      setClearingCache(false);
    }
  };

  const mountable = sessions.filter(isMountable);
  const maxBytes = cacheStats?.max_bytes || 1024 * MB;
  const usagePercent = cacheStats ? Math.min(100, Math.round((cacheStats.total_bytes / (maxBytes || 1)) * 100)) : 0;
  const presetValue = PRESET_QUOTAS.find((p) => p.bytes === cacheStats?.max_bytes)?.label ?? '';

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="xl"
        icon={<HardDrive className="w-4 h-4" />}
        title={tr('Disco virtual', 'Virtual drive')}
        subtitle={tr(`Abra uma conexão como um disco no ${fileManager}.`, `Open a connection as a drive in ${fileManager}.`)}
        bodyClassName="space-y-4"
        footer={
          <Button variant="secondary" onClick={onClose}>
            {tr('Fechar', 'Close')}
          </Button>
        }
      >
        <div className="flex items-start gap-2 rounded-lg bg-surface-sunken px-3 py-2.5 text-[12.5px] text-ink-muted leading-snug">
          <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-ink-faint" />
          <span>
            {tr(
              'O disco é servido só neste computador (127.0.0.1), nunca na rede. Enquanto estiver montado, outros apps deste computador podem ler e gravar os arquivos dele.',
              'The drive is served only on this computer (127.0.0.1), never on the network. While it is mounted, other apps on this computer can read and write its files.'
            )}
          </span>
        </div>

        {errorMessage && (
          <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300" role="alert">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="flex-1 min-w-0 break-words">{errorMessage}</span>
          </div>
        )}

        {mountable.length === 0 ? (
          <div className="ui-card px-4 py-10 text-center text-[13px] text-ink-muted">
            {tr('Conecte-se a um servidor para montá-lo como disco.', 'Connect to a server to mount it as a drive.')}
          </div>
        ) : (
          <div className="ui-card divide-y divide-line">
            {mountable.map((sess) => {
              const disk = disks.find((d) => d.session_id === sess.id);
              const isMounted = !!disk?.is_mounted;
              const isLoading = loadingSession === sess.id;
              return (
                <div key={sess.id} className="px-3.5 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <HardDrive className={`w-5 h-5 shrink-0 ${isMounted ? 'text-ink' : 'text-ink-faint'}`} />
                    <div className="flex-1 min-w-[180px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-ink truncate">{sess.config.name}</span>
                        {sess.id === activeSessionId && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-dark-650 text-ink-muted">{tr('Aba atual', 'Current tab')}</span>
                        )}
                      </div>
                      <div className="text-[12px] text-ink-faint truncate">
                        {isMounted ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                            <span className="text-ink-muted">{tr('Montado em', 'Mounted at')}</span>
                            <span className="font-mono" title={disk!.mount_point}>
                              {disk!.mount_point}
                            </span>
                          </span>
                        ) : (
                          <span>
                            {(sess.config.protocol || '').toUpperCase()} · <span className="font-mono">{sess.config.host}{sess.config.port ? `:${sess.config.port}` : ''}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {isMounted ? (
                        <>
                          <Button size="sm" variant="secondary" icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={() => void handleOpenDisk(sess.id)}>
                            {tr(`Mostrar no ${fileManager}`, `Show in ${fileManager}`)}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eject className="w-3.5 h-3.5" />}
                            onClick={() => void handleUnmount(sess.id)}
                            disabled={isLoading}
                          >
                            {isLoading ? tr('Ejetando…', 'Ejecting…') : tr('Ejetar', 'Eject')}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="secondary" icon={<HardDrive className="w-3.5 h-3.5" />} onClick={() => void handleMount(sess.id)} loading={isLoading}>
                          {isLoading ? tr('Montando…', 'Mounting…') : tr('Montar como disco', 'Mount as drive')}
                        </Button>
                      )}
                    </div>
                  </div>
                  {isMounted && disk && (disk.mount_root || disk.shortcut_path || disk.read_bytes > 0 || disk.write_bytes > 0) && (
                    <Disclosure label={tr('Detalhes', 'Details')} className="mt-2 ml-8">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
                        {disk.mount_root && (
                          <>
                            <dt className="text-ink-faint">{tr('Pasta no servidor', 'Server folder')}</dt>
                            <dd className="font-mono text-ink-muted truncate" title={disk.mount_root}>
                              {disk.mount_root}
                            </dd>
                          </>
                        )}
                        {disk.shortcut_path && (
                          <>
                            <dt className="text-ink-faint">{tr('Atalho na Mesa', 'Desktop shortcut')}</dt>
                            <dd className="font-mono text-ink-muted truncate" title={disk.shortcut_path}>
                              {disk.shortcut_path}
                            </dd>
                          </>
                        )}
                        <dt className="text-ink-faint">{tr('Tráfego', 'Traffic')}</dt>
                        <dd className="text-ink-muted tabular-nums">
                          ↓ {formatBytes(disk.read_bytes)} · ↑ {formatBytes(disk.write_bytes)}
                        </dd>
                        {disk.port > 0 && (
                          <>
                            <dt className="text-ink-faint">{tr('Endereço local', 'Local address')}</dt>
                            <dd className="font-mono text-ink-muted">127.0.0.1:{disk.port}</dd>
                          </>
                        )}
                      </dl>
                    </Disclosure>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <Disclosure label={tr('Avançado: armazenamento e cache', 'Advanced: storage & cache')}>
          <div className="space-y-3">
            <div className="ui-card px-3.5 py-3 space-y-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-ink">
                  <span className="tabular-nums">{formatBytes(cacheStats?.total_bytes || 0)}</span>{' '}
                  <span className="text-ink-muted">
                    {tr('de', 'of')} <span className="tabular-nums">{formatBytes(maxBytes)}</span> {tr('em cache', 'cached')}
                  </span>
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-ink-faint tabular-nums">
                    {(cacheStats?.file_count || 0).toLocaleString()} {tr('arquivos', 'files')} · {usagePercent}%
                  </span>
                  <IconButton size="sm" label={tr('Atualizar', 'Refresh')} onClick={() => void loadCacheStats()}>
                    <RefreshCw className="w-3.5 h-3.5" />
                  </IconButton>
                </div>
              </div>
              <div className="h-1.5 w-full rounded-full bg-dark-650 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usagePercent} aria-label={tr('Uso do cache', 'Cache usage')}>
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-amber-500' : 'bg-rust-500'}`}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>
              <p className="text-[12px] text-ink-faint">
                {tr(
                  `Pastas no catálogo: ${(cacheStats?.catalog_folders_count || 0).toLocaleString()} · itens: ${(cacheStats?.catalog_items_count || 0).toLocaleString()}. Ao atingir o limite, os arquivos usados há mais tempo são removidos.`,
                  `Catalog: ${(cacheStats?.catalog_folders_count || 0).toLocaleString()} folders · ${(cacheStats?.catalog_items_count || 0).toLocaleString()} items. When the limit is reached, the least recently used files are removed.`
                )}
              </p>
              {cacheError && (
                <p className="text-[12px] text-red-600 dark:text-red-400" role="alert">
                  {tr('Não foi possível ler o cache: ', 'Could not read the cache: ')}
                  {cacheError}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-ink-muted">{tr('Limite', 'Limit')}</span>
                  <Segmented<string>
                    size="sm"
                    ariaLabel={tr('Limite do cache', 'Cache limit')}
                    value={presetValue}
                    onChange={(label) => {
                      const preset = PRESET_QUOTAS.find((p) => p.label === label);
                      if (preset) void handleSetMaxQuota(preset.bytes);
                    }}
                    options={PRESET_QUOTAS.map((p) => ({ value: p.label, label: p.label }))}
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-600 dark:text-red-400"
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                  onClick={() => setConfirmClearAll(true)}
                  disabled={clearingCache || !cacheStats?.total_bytes}
                >
                  {tr('Limpar todo o cache…', 'Clear all cache…')}
                </Button>
              </div>
            </div>

            {cacheStats && cacheStats.sites.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="px-1 text-[12px] font-medium text-ink-faint">{tr('Por servidor', 'By server')}</h3>
                <div className="ui-card divide-y divide-line max-h-40 overflow-y-auto">
                  {cacheStats.sites.map((site) => (
                    <div key={site.session_id} className="flex items-center gap-3 px-3.5 py-1.5 text-[12.5px]">
                      <span className="flex-1 min-w-0 truncate text-ink">{site.session_name}</span>
                      <span className="text-[12px] text-ink-faint tabular-nums shrink-0">
                        {site.file_count.toLocaleString()} {tr('arquivos', 'files')} · {formatBytes(site.total_bytes)}
                      </span>
                      <IconButton
                        size="sm"
                        label={tr(`Limpar cache de ${site.session_name}`, `Clear cache for ${site.session_name}`)}
                        onClick={() => void handleClearSiteCache(site)}
                        disabled={clearingCache}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Disclosure>
      </Modal>

      <Modal
        isOpen={isOpen && confirmClearAll}
        onClose={() => setConfirmClearAll(false)}
        size="sm"
        title={tr('Limpar todo o cache?', 'Clear all cache?')}
        initialFocusRef={cancelClearRef}
        footer={
          <>
            <Button ref={cancelClearRef} variant="secondary" onClick={() => setConfirmClearAll(false)}>
              {tr('Cancelar', 'Cancel')}
            </Button>
            <Button variant="danger" onClick={() => void handleClearAllCache()} loading={clearingCache}>
              {tr('Limpar cache', 'Clear cache')}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">
          {tr(
            `${formatBytes(cacheStats?.total_bytes || 0)} em cópias locais serão removidos. Os arquivos nos servidores não são alterados; eles serão baixados de novo quando forem abertos.`,
            `${formatBytes(cacheStats?.total_bytes || 0)} of local copies will be removed. Files on the servers are not touched; they are downloaded again when opened.`
          )}
        </p>
      </Modal>
    </>
  );
};
