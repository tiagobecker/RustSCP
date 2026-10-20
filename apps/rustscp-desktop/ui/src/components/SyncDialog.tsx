import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ArrowRight, ArrowLeft, ArrowLeftRight, Trash2, ChevronRight, AlertTriangle, Monitor, Server } from 'lucide-react';
import { SyncActionType, SyncDirection, SyncItem, SyncOptions } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Segmented, Toggle } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';

interface SyncDialogProps {
  isOpen: boolean;
  onClose: () => void;
  localPath: string;
  remotePath: string;
  onCompare: (options: SyncOptions) => Promise<SyncItem[]>;
  onExecuteSync: (plan: SyncItem[]) => Promise<void>;
}

/** Options sent to `compare_and_sync_plan`; `recursive` is an optional backend field. */
type CompareOptions = SyncOptions & { recursive?: boolean };

type Group = 'upload' | 'download' | 'delete' | 'conflict' | 'identical';

const GROUP_ORDER: Group[] = ['upload', 'download', 'delete', 'conflict', 'identical'];

function groupOf(action: SyncActionType): Group {
  switch (action) {
    case 'upload':
      return 'upload';
    case 'download':
      return 'download';
    case 'delete_remote':
    case 'delete_local':
      return 'delete';
    case 'conflict':
      return 'conflict';
    default:
      return 'identical';
  }
}

const isExecutable = (action: SyncActionType) =>
  action === 'upload' || action === 'download' || action === 'delete_remote' || action === 'delete_local';

function formatBytes(bytes?: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
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

function formatDate(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export const SyncDialog: React.FC<SyncDialogProps> = ({ isOpen, onClose, localPath, remotePath, onCompare, onExecuteSync }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || 'en').toLowerCase().startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const [direction, setDirection] = useState<SyncDirection>('local_to_remote');
  const [mirrorDelete, setMirrorDelete] = useState<boolean>(false);
  const [sizeOnly, setSizeOnly] = useState<boolean>(false);
  const [recursive, setRecursive] = useState<boolean>(false);
  const [isComparing, setIsComparing] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [compareError, setCompareError] = useState<string>('');
  /** The plan plus the exact folders/options it was computed for. */
  const [result, setResult] = useState<{ key: string; items: SyncItem[] } | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<Group>>(new Set(['upload', 'download', 'delete', 'conflict']));
  const [confirmDeletes, setConfirmDeletes] = useState<boolean>(false);
  const requestSeq = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const planKey = JSON.stringify({ localPath, remotePath, direction, mirrorDelete, sizeOnly, recursive });

  // A plan only applies to the folders and options it was computed for. Anything else
  // (another folder, direction or option, or reopening the dialog) discards it.
  useEffect(() => {
    requestSeq.current++;
    setResult(null);
    setExcluded(new Set());
    setCompareError('');
    setConfirmDeletes(false);
    setIsComparing(false);
  }, [planKey, isOpen]);

  const plan = result && result.key === planKey ? result.items : null;

  const groups = useMemo(() => {
    const map: Record<Group, SyncItem[]> = { upload: [], download: [], delete: [], conflict: [], identical: [] };
    for (const item of plan ?? []) map[groupOf(item.action)].push(item);
    return map;
  }, [plan]);

  const selected = useMemo(
    () => (plan ?? []).filter((i) => isExecutable(i.action) && !excluded.has(i.relative_path)),
    [plan, excluded]
  );
  const selectedDeletes = selected.filter((i) => i.action === 'delete_remote' || i.action === 'delete_local');
  const counts = {
    upload: selected.filter((i) => i.action === 'upload').length,
    download: selected.filter((i) => i.action === 'download').length,
    deleteRemote: selectedDeletes.filter((i) => i.action === 'delete_remote').length,
    deleteLocal: selectedDeletes.filter((i) => i.action === 'delete_local').length,
  };

  const handleRunCompare = async () => {
    const seq = ++requestSeq.current;
    const key = planKey;
    setIsComparing(true);
    setCompareError('');
    setConfirmDeletes(false);
    try {
      const options: CompareOptions = {
        direction,
        mirror_delete: mirrorDelete,
        compare_by_size_only: sizeOnly,
        recursive,
      };
      const items = await onCompare(options);
      if (seq !== requestSeq.current) return; // folders or options changed meanwhile
      setResult({ key, items: Array.isArray(items) ? items : [] });
      setExcluded(new Set());
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setCompareError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === requestSeq.current) setIsComparing(false);
    }
  };

  const runSync = async () => {
    // Never run a plan that was computed for other folders or options
    if (!plan || result?.key !== planKey || selected.length === 0) return;
    setIsSyncing(true);
    try {
      await onExecuteSync(selected);
      onClose();
    } catch (err) {
      notify.error(tr('Erro na sincronização', 'Sync failed'), err);
    } finally {
      setIsSyncing(false);
      setConfirmDeletes(false);
    }
  };

  const handleStartSync = () => {
    if (selectedDeletes.length > 0) {
      setConfirmDeletes(true);
      return;
    }
    void runSync();
  };

  const toggleItem = (path: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleGroupSelection = (items: SyncItem[], include: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      items.forEach((i) => (include ? next.delete(i.relative_path) : next.add(i.relative_path)));
      return next;
    });
  };

  const toggleGroupOpen = (g: Group) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  const groupLabel = (g: Group) => {
    switch (g) {
      case 'upload':
        return tr('Enviar', 'Upload');
      case 'download':
        return tr('Baixar', 'Download');
      case 'delete':
        return tr('Excluir no destino', 'Delete at destination');
      case 'conflict':
        return tr('Conflitos (ignorados)', 'Conflicts (skipped)');
      default:
        return tr('Sem alterações', 'Unchanged');
    }
  };

  const groupIcon = (g: Group) => {
    const cls = 'w-3.5 h-3.5 shrink-0';
    switch (g) {
      case 'upload':
        return <ArrowRight className={`${cls} text-ink-muted`} />;
      case 'download':
        return <ArrowLeft className={`${cls} text-ink-muted`} />;
      case 'delete':
        return <Trash2 className={`${cls} text-red-600 dark:text-red-400`} />;
      case 'conflict':
        return <AlertTriangle className={`${cls} text-amber-600 dark:text-amber-400`} />;
      default:
        return null;
    }
  };

  const changeCount = selected.length;
  const deleteSummary = [
    counts.deleteRemote > 0 ? tr(`${counts.deleteRemote} no servidor`, `${counts.deleteRemote} on the server`) : '',
    counts.deleteLocal > 0 ? tr(`${counts.deleteLocal} neste computador`, `${counts.deleteLocal} on this computer`) : '',
  ]
    .filter(Boolean)
    .join(tr(' e ', ' and '));

  const DirectionArrow = direction === 'local_to_remote' ? ArrowRight : direction === 'remote_to_local' ? ArrowLeft : ArrowLeftRight;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="2xl"
        title={tr('Sincronizar pastas', 'Synchronize folders')}
        subtitle={
          recursive
            ? tr('Compara os arquivos e as subpastas das duas pastas.', 'Compares the files and subfolders of both folders.')
            : tr('Compara apenas os arquivos do primeiro nível das duas pastas.', 'Compares only the top-level files of both folders.')
        }
        icon={<RefreshCw className="w-4 h-4" />}
        bodyClassName="space-y-4"
        footer={
          <>
            {plan && (
              <span className="mr-auto text-[12px] text-ink-faint tabular-nums">
                {[
                  counts.upload ? tr(`${counts.upload} para enviar`, `${counts.upload} to upload`) : '',
                  counts.download ? tr(`${counts.download} para baixar`, `${counts.download} to download`) : '',
                  selectedDeletes.length ? tr(`${selectedDeletes.length} para excluir`, `${selectedDeletes.length} to delete`) : '',
                ]
                  .filter(Boolean)
                  .join(' · ') || tr('Nada para sincronizar', 'Nothing to sync')}
              </span>
            )}
            <Button variant="secondary" onClick={onClose}>
              {tr('Cancelar', 'Cancel')}
            </Button>
            {plan && changeCount > 0 ? (
              <Button variant={selectedDeletes.length ? 'danger' : 'primary'} onClick={handleStartSync} loading={isSyncing} disabled={isComparing}>
                {changeCount === 1 ? tr('Sincronizar 1 alteração', 'Sync 1 change') : tr(`Sincronizar ${changeCount} alterações`, `Sync ${changeCount} changes`)}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void handleRunCompare()}
                loading={isComparing}
                icon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                {isComparing ? tr('Comparando…', 'Comparing…') : plan ? tr('Comparar de novo', 'Compare again') : tr('Comparar', 'Compare')}
              </Button>
            )}
          </>
        }
      >
        {/* Folders */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="ui-card px-3 py-2 min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-faint">
              <Monitor className="w-3.5 h-3.5" />
              {tr('Este computador', 'This computer')}
            </div>
            <div className="font-mono text-[12px] text-ink truncate mt-0.5" title={localPath}>
              {localPath}
            </div>
          </div>
          <DirectionArrow className="w-4 h-4 text-ink-muted" aria-hidden="true" />
          <div className="ui-card px-3 py-2 min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-faint">
              <Server className="w-3.5 h-3.5" />
              {tr('Servidor', 'Server')}
            </div>
            <div className="font-mono text-[12px] text-ink truncate mt-0.5" title={remotePath}>
              {remotePath}
            </div>
          </div>
        </div>

        {/* Direction + options */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented<SyncDirection>
            ariaLabel={tr('Direção', 'Direction')}
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'local_to_remote', label: tr('Enviar', 'Upload'), icon: <ArrowRight className="w-3.5 h-3.5" />, title: tr('Este computador → servidor', 'This computer → server') },
              { value: 'remote_to_local', label: tr('Baixar', 'Download'), icon: <ArrowLeft className="w-3.5 h-3.5" />, title: tr('Servidor → este computador', 'Server → this computer') },
              { value: 'both', label: tr('Nos dois sentidos', 'Two-way'), icon: <ArrowLeftRight className="w-3.5 h-3.5" />, title: tr('Copia a versão mais nova em cada lado', 'Copies the newer version to each side') },
            ]}
          />
          {mirrorDelete && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-red-600 dark:text-red-400">
              <Trash2 className="w-3.5 h-3.5" />
              {tr('Exclusões espelhadas ativadas', 'Mirror deletions on')}
            </span>
          )}
        </div>

        <Disclosure label={tr('Avançado', 'Advanced')}>
          <div className="ui-card divide-y divide-line">
            <label className="flex items-start gap-3 px-3.5 py-2.5 cursor-pointer">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-ink">{tr('Excluir no destino o que não existe na origem', 'Delete files missing from the source')}</div>
                <div className="text-[11.5px] text-red-600 dark:text-red-400 leading-snug mt-0.5">
                  {tr(
                    'Espelha a origem: arquivos que só existem no destino são excluídos. Você confirma antes de qualquer exclusão.',
                    'Mirrors the source: files that only exist at the destination are deleted. You confirm before anything is deleted.'
                  )}
                </div>
              </div>
              <Toggle checked={mirrorDelete} onChange={setMirrorDelete} label={tr('Excluir no destino', 'Delete at destination')} />
            </label>
            <label className="flex items-start gap-3 px-3.5 py-2.5 cursor-pointer">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-ink">{tr('Comparar só pelo tamanho', 'Compare by size only')}</div>
                <div className="text-[11.5px] text-ink-faint leading-snug mt-0.5">
                  {tr('Ignora a data de modificação.', 'Ignores the modification time.')}
                </div>
              </div>
              <Toggle checked={sizeOnly} onChange={setSizeOnly} label={tr('Comparar só pelo tamanho', 'Compare by size only')} />
            </label>
            <label className="flex items-start gap-3 px-3.5 py-2.5 cursor-pointer">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-ink">{tr('Incluir subpastas', 'Include subfolders')}</div>
                <div className="text-[11.5px] text-ink-faint leading-snug mt-0.5">
                  {tr('Compara também o conteúdo das subpastas.', 'Also compares the contents of subfolders.')}
                </div>
              </div>
              <Toggle checked={recursive} onChange={setRecursive} label={tr('Incluir subpastas', 'Include subfolders')} />
            </label>
          </div>
        </Disclosure>

        {compareError && (
          <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300" role="alert">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
              {tr('Não foi possível comparar as pastas: ', 'Could not compare the folders: ')}
              {compareError}
            </span>
          </div>
        )}

        {/* Plan */}
        {!plan ? (
          <div className="ui-card px-4 py-10 text-center">
            <p className="text-[13px] text-ink-muted">
              {isComparing
                ? tr('Comparando as pastas…', 'Comparing the folders…')
                : tr('Compare as pastas para ver o que será sincronizado.', 'Compare the folders to see what will be synced.')}
            </p>
          </div>
        ) : plan.length === 0 ? (
          <div className="ui-card px-4 py-10 text-center text-[13px] text-ink-muted">{tr('As duas pastas estão vazias.', 'Both folders are empty.')}</div>
        ) : (
          <div className="ui-card divide-y divide-line overflow-hidden">
            {GROUP_ORDER.filter((g) => groups[g].length > 0).map((g) => {
              const items = groups[g];
              const open = openGroups.has(g);
              const selectable = g !== 'conflict' && g !== 'identical';
              const includedCount = selectable ? items.filter((i) => !excluded.has(i.relative_path)).length : 0;
              return (
                <section key={g}>
                  <div className="flex items-center gap-2 px-3 h-9 bg-surface">
                    <button
                      type="button"
                      onClick={() => toggleGroupOpen(g)}
                      aria-expanded={open}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left text-[12.5px] font-medium text-ink"
                    >
                      <ChevronRight className={`w-3.5 h-3.5 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} />
                      {groupIcon(g)}
                      <span>{groupLabel(g)}</span>
                      <span className="text-ink-faint tabular-nums font-normal">
                        {selectable && includedCount !== items.length ? `${includedCount}/${items.length}` : items.length}
                      </span>
                    </button>
                    {selectable && (
                      <input
                        type="checkbox"
                        aria-label={tr(`Incluir todos: ${groupLabel(g)}`, `Include all: ${groupLabel(g)}`)}
                        checked={includedCount === items.length}
                        ref={(el) => {
                          if (el) el.indeterminate = includedCount > 0 && includedCount < items.length;
                        }}
                        onChange={(e) => toggleGroupSelection(items, e.target.checked)}
                        className="w-3.5 h-3.5 accent-rust-500"
                      />
                    )}
                  </div>
                  {g === 'conflict' && open && (
                    <p className="px-3 pb-2 bg-surface text-[11.5px] text-ink-faint leading-snug">
                      {tr(
                        'O destino parece mais novo ou não dá para saber qual versão é a mais nova. Esses arquivos não são alterados.',
                        'The destination looks newer, or it can’t be told which copy is newer. These files are left alone.'
                      )}
                    </p>
                  )}
                  {open && (
                    <ul className="max-h-64 overflow-y-auto divide-y divide-line/60">
                      {items.map((item) => {
                        const included = selectable && !excluded.has(item.relative_path);
                        const dates = [
                          item.local_modified ? `${tr('Local', 'Local')}: ${formatDate(item.local_modified)}` : '',
                          item.remote_modified ? `${tr('Servidor', 'Server')}: ${formatDate(item.remote_modified)}` : '',
                        ]
                          .filter(Boolean)
                          .join('\n');
                        return (
                          <li key={item.relative_path} className="flex items-center gap-3 px-3 py-1.5 text-[12px] hover:bg-dark-650/40" title={dates || undefined}>
                            {selectable ? (
                              <input
                                type="checkbox"
                                checked={included}
                                onChange={() => toggleItem(item.relative_path)}
                                aria-label={tr(`Incluir ${item.relative_path}`, `Include ${item.relative_path}`)}
                                className="w-3.5 h-3.5 shrink-0 accent-rust-500"
                              />
                            ) : (
                              <span className="w-3.5 shrink-0" />
                            )}
                            <span className={`flex-1 min-w-0 truncate font-mono ${selectable && !included ? 'text-ink-faint line-through' : 'text-ink'}`}>
                              {item.relative_path}
                              {item.action === 'delete_local' && <span className="ml-2 font-sans text-ink-faint">({tr('neste computador', 'on this computer')})</span>}
                              {item.action === 'delete_remote' && <span className="ml-2 font-sans text-ink-faint">({tr('no servidor', 'on the server')})</span>}
                            </span>
                            <span className="w-20 text-right font-mono text-ink-faint tabular-nums" title={tr('Tamanho local', 'Local size')}>
                              {formatBytes(item.local_size)}
                            </span>
                            <span className="w-20 text-right font-mono text-ink-faint tabular-nums" title={tr('Tamanho no servidor', 'Server size')}>
                              {formatBytes(item.remote_size)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
        {plan && plan.length > 0 && (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => void handleRunCompare()} loading={isComparing} icon={<RefreshCw className="w-3.5 h-3.5" />}>
              {tr('Comparar de novo', 'Compare again')}
            </Button>
          </div>
        )}
      </Modal>

      {/* Mirror deletions are destructive: state the counts and make Cancel the default */}
      <Modal
        isOpen={isOpen && confirmDeletes}
        onClose={() => setConfirmDeletes(false)}
        size="sm"
        title={
          selectedDeletes.length === 1
            ? tr('Excluir 1 item no destino?', 'Delete 1 item at the destination?')
            : tr(`Excluir ${selectedDeletes.length} itens no destino?`, `Delete ${selectedDeletes.length} items at the destination?`)
        }
        initialFocusRef={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} variant="secondary" onClick={() => setConfirmDeletes(false)}>
              {tr('Cancelar', 'Cancel')}
            </Button>
            <Button variant="danger" onClick={() => void runSync()} loading={isSyncing}>
              {tr('Sincronizar e excluir', 'Sync and delete')}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-[13px] text-ink-muted">
          <p>
            {tr(
              `Esta sincronização exclui ${deleteSummary} porque não existem na origem.`,
              `This sync deletes ${deleteSummary} because they no longer exist in the source.`
            )}
            {(counts.upload > 0 || counts.download > 0) &&
              ' ' +
                tr(
                  `Também envia ${counts.upload} e baixa ${counts.download} arquivo(s).`,
                  `It also uploads ${counts.upload} and downloads ${counts.download} file(s).`
                )}
          </p>
          <ul className="font-mono text-[12px] max-h-32 overflow-y-auto space-y-0.5">
            {selectedDeletes.slice(0, 50).map((i) => (
              <li key={i.relative_path} className="truncate" title={i.relative_path}>
                {i.relative_path}
              </li>
            ))}
            {selectedDeletes.length > 50 && <li>{tr(`… e mais ${selectedDeletes.length - 50}`, `… and ${selectedDeletes.length - 50} more`)}</li>}
          </ul>
        </div>
      </Modal>
    </>
  );
};
