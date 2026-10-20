import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, RotateCcw, RefreshCw, Folder, FileText, AlertTriangle, Info } from 'lucide-react';
import { RemoteTrashItem, RemoteTrashStatus } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, IconButton } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';

interface RemoteTrashModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  sessionName: string;
  isTrashEnabled: boolean;
  onGetTrashStatus: () => Promise<{ status: RemoteTrashStatus; items: RemoteTrashItem[] }>;
  onSetupTrash: () => Promise<void>;
  onRestoreItem: (itemId: string) => Promise<void>;
  onEmptyTrash: () => Promise<void>;
}

function formatSize(bytes?: number | null): string {
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

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const RemoteTrashModal: React.FC<RemoteTrashModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  sessionName,
  isTrashEnabled,
  onGetTrashStatus,
  onSetupTrash,
  onRestoreItem,
  onEmptyTrash,
}) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || 'en').toLowerCase().startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const [loading, setLoading] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [status, setStatus] = useState<RemoteTrashStatus | null>(null);
  const [items, setItems] = useState<RemoteTrashItem[]>([]);
  const [loadError, setLoadError] = useState<string>('');
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  /** Bumped on every load and on session/open changes so late responses are ignored. */
  const requestSeq = useRef(0);
  const cancelEmptyRef = useRef<HTMLButtonElement>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const loadStatus = async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError('');
    try {
      const res = await onGetTrashStatus();
      if (seq !== requestSeq.current) return;
      setStatus(res?.status ?? null);
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setLoadError(errText(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  // Each server gets its own state: nothing armed for server A may act on server B.
  useEffect(() => {
    requestSeq.current++;
    setStatus(null);
    setItems([]);
    setLoadError('');
    setConfirmEmpty(false);
    setConfirmRestoreId(null);
    setShowInfo(false);
    setLoading(false);
    if (isOpen) void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sessionId]);

  const runAction = async (fn: () => Promise<void>, success: string, failure: string) => {
    const session = sessionRef.current;
    setBusy(true);
    try {
      await fn();
      if (session !== sessionRef.current) return;
      notify.success(success);
      await loadStatus();
    } catch (e) {
      notify.error(failure, e);
    } finally {
      setBusy(false);
    }
  };

  const handleSetup = () =>
    runAction(onSetupTrash, tr('Lixeira configurada no servidor', 'Trash set up on the server'), tr('Não foi possível configurar a lixeira', 'Could not set up the trash'));

  const handleRestore = async (item: RemoteTrashItem) => {
    setConfirmRestoreId(null);
    await runAction(
      () => onRestoreItem(item.id),
      tr(`“${item.filename}” foi devolvido`, `“${item.filename}” was put back`),
      tr(`Não foi possível devolver “${item.filename}”`, `Could not put back “${item.filename}”`)
    );
  };

  const handleEmpty = async () => {
    setConfirmEmpty(false);
    await runAction(onEmptyTrash, tr('Lixeira esvaziada', 'Trash emptied'), tr('Não foi possível esvaziar a lixeira', 'Could not empty the trash'));
  };

  const totalSize = status?.total_size_bytes ?? items.reduce((sum, i) => sum + (i.size || 0), 0);
  const countLabel = items.length === 1 ? tr('1 item', '1 item') : tr(`${items.length} itens`, `${items.length} items`);
  const trashDir = status?.trash_dir || '~/.local/share/Trash';
  const disabled = loading || busy;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="2xl"
        icon={<Trash2 className="w-4 h-4" />}
        title={`${tr('Lixeira', 'Trash')} — ${sessionName}`}
        subtitle={status || items.length ? `${countLabel} · ${formatSize(totalSize)}` : loading ? tr('Carregando…', 'Loading…') : undefined}
        headerActions={
          <>
            <IconButton size="sm" label={tr('Sobre a lixeira remota', 'About the remote trash')} active={showInfo} onClick={() => setShowInfo((v) => !v)}>
              <Info className="w-4 h-4" />
            </IconButton>
            <IconButton size="sm" label={tr('Atualizar', 'Refresh')} onClick={() => void loadStatus()} disabled={disabled}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </IconButton>
          </>
        }
        bodyClassName="space-y-3"
        footer={
          <>
            {items.length > 0 && (
              <Button variant="ghost" className="mr-auto text-red-600 dark:text-red-400" onClick={() => setConfirmEmpty(true)} disabled={disabled} icon={<Trash2 className="w-3.5 h-3.5" />}>
                {tr('Esvaziar lixeira…', 'Empty trash…')}
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              {tr('Fechar', 'Close')}
            </Button>
          </>
        }
      >
        {(showInfo || !isTrashEnabled) && (
          <div className={`rounded-lg px-3 py-2.5 text-[12.5px] leading-snug ${isTrashEnabled ? 'bg-surface-sunken text-ink-muted' : 'bg-amber-500/10 text-ink'}`}>
            {isTrashEnabled ? (
              <p>
                {tr(
                  'Arquivos excluídos neste servidor são movidos para a lixeira do seu usuário, sem precisar de root. Você pode devolvê-los até esvaziar a lixeira.',
                  'Files you delete on this server are moved to your user’s trash, no root needed. You can put them back until you empty the trash.'
                )}
              </p>
            ) : (
              <p className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  {tr(
                    'A lixeira remota está desativada: excluir remove os arquivos do servidor permanentemente. Ative “Mover para a lixeira remota em vez de excluir” em Configurações.',
                    'Remote trash is off: deleting removes files from the server permanently. Turn on “Move to remote trash instead of deleting” in Settings.'
                  )}
                </span>
              </p>
            )}
            <p className="mt-1 font-mono text-[11.5px] text-ink-faint truncate" title={trashDir}>
              {trashDir}
            </p>
          </div>
        )}

        {loadError && (
          <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300" role="alert">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
              {tr('Não foi possível ler a lixeira: ', 'Could not read the trash: ')}
              {loadError}
            </span>
          </div>
        )}

        {status && !status.initialized && (
          <div className="ui-card flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-[200px]">
              <div className="text-[13px] text-ink">{tr('A lixeira ainda não existe neste servidor', 'The trash isn’t set up on this server yet')}</div>
              <div className="text-[12px] text-ink-faint">
                {tr('Ela também é criada automaticamente na primeira vez que você move algo para a lixeira.', 'It is also created automatically the first time you move something to the trash.')}
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={() => void handleSetup()} loading={busy} disabled={loading}>
              {tr('Configurar agora', 'Set up now')}
            </Button>
          </div>
        )}

        {items.length === 0 ? (
          !loading &&
          !loadError && (
            <div className="py-14 flex flex-col items-center justify-center text-center gap-2">
              <Trash2 className="w-8 h-8 text-ink-faint" strokeWidth={1.5} />
              <p className="text-[13px] text-ink-muted">{tr('A lixeira está vazia', 'The trash is empty')}</p>
            </div>
          )
        ) : (
          <div className="ui-card overflow-hidden">
            <table className="w-full text-left text-[12.5px] table-fixed">
              <thead>
                <tr className="border-b border-line text-[12px] font-medium text-ink-faint select-none">
                  <th className="py-2 px-3 w-[28%] font-medium">{tr('Nome', 'Name')}</th>
                  <th className="py-2 px-3 font-medium">{tr('Local original', 'Original location')}</th>
                  <th className="py-2 px-3 w-40 font-medium">{tr('Excluído em', 'Date deleted')}</th>
                  <th className="py-2 px-3 w-20 font-medium text-right">{tr('Tamanho', 'Size')}</th>
                  <th className="py-2 px-3 w-44 font-medium text-right">
                    <span className="sr-only">{tr('Ações', 'Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-dark-650/40">
                    <td className="py-1.5 px-3">
                      <div className="flex items-center gap-2 min-w-0">
                        {item.is_dir ? <Folder className="w-4 h-4 text-ink-muted shrink-0" /> : <FileText className="w-4 h-4 text-ink-faint shrink-0" />}
                        <span className="truncate text-ink" title={item.filename}>
                          {item.filename}
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 px-3 font-mono text-[11.5px] text-ink-muted truncate" title={item.original_path}>
                      {item.original_path}
                    </td>
                    <td className="py-1.5 px-3 text-ink-muted tabular-nums truncate">{formatDate(item.deletion_date)}</td>
                    <td className="py-1.5 px-3 text-right text-ink-muted tabular-nums">{formatSize(item.size)}</td>
                    <td className="py-1.5 px-3 text-right">
                      {confirmRestoreId === item.id ? (
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setConfirmRestoreId(null)}>
                            {tr('Cancelar', 'Cancel')}
                          </Button>
                          <Button size="sm" variant="primary" onClick={() => void handleRestore(item)} loading={busy}>
                            {tr('Devolver', 'Put back')}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<RotateCcw className="w-3.5 h-3.5" />}
                          onClick={() => setConfirmRestoreId(item.id)}
                          disabled={disabled}
                          title={tr(`Devolver para ${item.original_path}`, `Put back to ${item.original_path}`)}
                        >
                          {tr('Devolver', 'Put back')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isOpen && confirmEmpty}
        onClose={() => setConfirmEmpty(false)}
        size="sm"
        title={
          items.length === 1
            ? tr('Apagar 1 item para sempre?', 'Permanently delete 1 item?')
            : tr(`Apagar ${items.length} itens para sempre?`, `Permanently delete ${items.length} items?`)
        }
        initialFocusRef={cancelEmptyRef}
        footer={
          <>
            <Button ref={cancelEmptyRef} variant="secondary" onClick={() => setConfirmEmpty(false)}>
              {tr('Cancelar', 'Cancel')}
            </Button>
            <Button variant="danger" onClick={() => void handleEmpty()} loading={busy}>
              {tr('Esvaziar lixeira', 'Empty trash')}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">
          {tr(
            `${formatSize(totalSize)} serão apagados da lixeira em ${sessionName}. Isso não pode ser desfeito.`,
            `${formatSize(totalSize)} will be erased from the trash on ${sessionName}. This can’t be undone.`
          )}
        </p>
      </Modal>
    </>
  );
};
