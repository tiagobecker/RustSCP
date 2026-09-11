import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Trash2, 
  RotateCcw, 
  RefreshCw, 
  Folder, 
  FileText, 
  HardDrive,
  ShieldCheck
} from 'lucide-react';
import { RemoteTrashItem, RemoteTrashStatus } from '../types.ts';

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
  const isPt = i18n.language.startsWith('pt');

  const [loading, setLoading] = useState<boolean>(false);
  const [status, setStatus] = useState<RemoteTrashStatus | null>(null);
  const [items, setItems] = useState<RemoteTrashItem[]>([]);
  const [actionMessage, setActionMessage] = useState<string>('');

  const loadStatus = async () => {
    setLoading(true);
    try {
      const res = await onGetTrashStatus();
      setStatus(res.status);
      setItems(res.items);
    } catch (e: any) {
      setActionMessage(`Erro ao consultar lixeira: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadStatus();
    }
  }, [isOpen, sessionId]);

  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);

  const handleSetup = async () => {
    setLoading(true);
    try {
      await onSetupTrash();
      await loadStatus();
      setActionMessage(isPt ? 'Lixeira remota inicializada com sucesso!' : 'Remote trash initialized successfully!');
    } catch (e: any) {
      setActionMessage(`Erro ao inicializar: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (itemId: string, filename: string) => {
    setLoading(true);
    try {
      await onRestoreItem(itemId);
      await loadStatus();
      setConfirmRestoreId(null);
      setActionMessage(isPt ? `'${filename}' restaurado com sucesso!` : `'${filename}' restored successfully!`);
    } catch (e: any) {
      setActionMessage(`Erro ao restaurar: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleEmpty = async () => {
    setLoading(true);
    try {
      await onEmptyTrash();
      await loadStatus();
      setConfirmEmpty(false);
      setActionMessage(isPt ? 'Lixeira remota esvaziada permanentemente.' : 'Remote trash permanently emptied.');
    } catch (e: any) {
      setActionMessage(`Erro ao esvaziar: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-3 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl max-w-4xl w-full h-[80vh] flex flex-col overflow-hidden text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-dark-600 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none shrink-0">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-rust-500/15 text-rust-500 dark:text-rust-400 border border-rust-500/30">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <span>{isPt ? 'Lixeira Remota Segura (Move-to-Trash)' : 'Secure Remote Trash Bin'}</span>
                <span className="text-[10px] bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 font-mono px-2 py-0.5 rounded border border-slate-300 dark:border-dark-600">
                  {sessionName}
                </span>
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isPt 
                  ? 'Permite exclusão atômica segura movendo arquivos para a pasta do usuário (~/.local/share/Trash) sem exigir privilégios de root.'
                  : 'Safe atomic deletion moving files into user space (~/.local/share/Trash) without requiring root permissions.'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Status Card & Actions */}
        <div className="bg-slate-50 dark:bg-dark-850 border-b border-slate-200 dark:border-dark-600 px-5 py-3 flex flex-wrap items-center justify-between gap-3 select-none shrink-0">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center space-x-2">
              <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Status no RustSCP:' : 'RustSCP Setting:'}</span>
              <span className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                isTrashEnabled 
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-600 dark:text-emerald-400' 
                  : 'bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400'
              }`}>
                {isTrashEnabled ? (isPt ? 'Ativada nas Configurações' : 'Enabled in Settings') : (isPt ? 'Desativada (Exclusão Direta)' : 'Disabled (Direct Deletion)')}
              </span>
            </div>

            <div className="flex items-center space-x-2 text-slate-700 dark:text-slate-300">
              <HardDrive className="w-3.5 h-3.5 text-rust-500 dark:text-rust-400" />
              <span>{status?.trash_dir || '~/.local/share/Trash'}</span>
              <span className="text-slate-500 dark:text-slate-400 font-mono">({items.length} itens, {formatSize(status?.total_size_bytes || 0)})</span>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {!status?.initialized && (
              <button
                onClick={handleSetup}
                disabled={loading}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-rust-600 hover:bg-rust-500 text-white text-xs font-semibold shadow-sm transition-all"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>{isPt ? 'Inicializar Lixeira no Servidor' : 'Initialize Trash on Server'}</span>
              </button>
            )}

            <button
              onClick={loadStatus}
              disabled={loading}
              title={isPt ? 'Recarregar' : 'Refresh'}
              className="p-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-dark-700 dark:hover:bg-dark-600 dark:text-slate-300 border border-slate-300 dark:border-dark-600 transition-colors shadow-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>

            {items.length > 0 && (
              confirmEmpty ? (
                <div className="flex items-center space-x-1.5 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-1">
                  <span className="text-xs text-red-600 dark:text-red-400 font-medium">
                    {isPt ? 'Esvaziar permanentemente?' : 'Empty permanently?'}
                  </span>
                  <button
                    onClick={handleEmpty}
                    disabled={loading}
                    className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-xs"
                  >
                    {isPt ? 'Confirmar' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setConfirmEmpty(false)}
                    className="px-2 py-0.5 rounded bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 text-xs"
                  >
                    {isPt ? 'Cancelar' : 'Cancel'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmEmpty(true)}
                  disabled={loading}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-red-600/15 hover:bg-red-600/25 text-red-600 dark:text-red-400 border border-red-500/30 text-xs font-semibold transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{isPt ? 'Esvaziar Lixeira' : 'Empty Trash'}</span>
                </button>
              )
            )}
          </div>
        </div>

        {/* Action Message Feedback */}
        {actionMessage && (
          <div className="bg-slate-100 dark:bg-dark-900 border-b border-slate-200 dark:border-dark-700 px-5 py-2 text-xs text-rust-600 dark:text-rust-300 flex items-center justify-between">
            <span>{actionMessage}</span>
            <button onClick={() => setActionMessage('')} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Trashed Items List Table */}
        <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-dark-900 p-4">
          {items.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-2">
              <Trash2 className="w-10 h-10 stroke-1 opacity-40 text-slate-400 dark:text-slate-500" />
              <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                {isPt ? 'Nenhum item na lixeira remota' : 'Remote trash bin is empty'}
              </p>
              {!isTrashEnabled && (
                <p className="text-[11px] text-slate-500 max-w-sm text-center">
                  {isPt 
                    ? 'Para enviar arquivos para esta lixeira ao excluir com F8, ative a opção "Lixeira Remota" nas Configurações do RustSCP.' 
                    : 'To move files to this trash bin upon pressing F8, enable "Remote Trash" in RustSCP Settings.'}
                </p>
              )}
            </div>
          ) : (
            <div className="border border-slate-200 dark:border-dark-600 rounded-xl overflow-hidden bg-white dark:bg-dark-800 shadow-sm">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-100 dark:bg-dark-750 border-b border-slate-200 dark:border-dark-600 text-slate-600 dark:text-slate-400 font-semibold text-[11px] uppercase tracking-wider select-none">
                    <th className="py-2.5 px-4">{isPt ? 'Nome do Arquivo' : 'Filename'}</th>
                    <th className="py-2.5 px-4">{isPt ? 'Caminho Original' : 'Original Path'}</th>
                    <th className="py-2.5 px-4">{isPt ? 'Data de Exclusão' : 'Deleted Date'}</th>
                    <th className="py-2.5 px-4">{isPt ? 'Tamanho' : 'Size'}</th>
                    <th className="py-2.5 px-4 text-right">{isPt ? 'Ação' : 'Action'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-dark-700/60">
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-dark-700/50 transition-colors">
                      <td className="py-2 px-4 font-semibold text-slate-900 dark:text-slate-100 flex items-center space-x-2">
                        {item.is_dir ? (
                          <Folder className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
                        ) : (
                          <FileText className="w-4 h-4 text-sky-500 dark:text-sky-400 shrink-0" />
                        )}
                        <span className="truncate max-w-[200px]" title={item.filename}>{item.filename}</span>
                      </td>
                      <td className="py-2 px-4 text-slate-600 dark:text-slate-300 font-mono text-[11px] truncate max-w-[260px]" title={item.original_path}>
                        {item.original_path}
                      </td>
                      <td className="py-2 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                        {item.deletion_date ? new Date(item.deletion_date).toLocaleString() : '-'}
                      </td>
                      <td className="py-2 px-4 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                        {formatSize(item.size)}
                      </td>
                      <td className="py-2 px-4 text-right">
                        {confirmRestoreId === item.id ? (
                          <div className="flex items-center justify-end space-x-1">
                            <span className="text-[11px] text-sky-600 dark:text-sky-400 font-medium">
                              {isPt ? 'Restaurar?' : 'Restore?'}
                            </span>
                            <button
                              onClick={() => handleRestore(item.id, item.filename)}
                              disabled={loading}
                              className="px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold"
                            >
                              {isPt ? 'Sim' : 'Yes'}
                            </button>
                            <button
                              onClick={() => setConfirmRestoreId(null)}
                              className="px-2 py-0.5 rounded bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 text-[11px]"
                            >
                              {isPt ? 'Não' : 'No'}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmRestoreId(item.id)}
                            disabled={loading}
                            className="flex items-center space-x-1 ml-auto px-2.5 py-1 rounded bg-sky-500/10 hover:bg-sky-500/20 text-sky-600 dark:text-sky-300 border border-sky-500/30 text-xs font-semibold transition-colors"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>{isPt ? 'Restaurar' : 'Restore'}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
