import React, { useState } from 'react';
import { 
  X, 
  RefreshCw, 
  ArrowRight, 
  ArrowLeft, 
  
  Trash2, 
  Check, 
  Play
} from 'lucide-react';
import { SyncActionType, SyncDirection, SyncItem, SyncOptions } from '../types.ts';

interface SyncDialogProps {
  isOpen: boolean;
  onClose: () => void;
  localPath: string;
  remotePath: string;
  onCompare: (options: SyncOptions) => Promise<SyncItem[]>;
  onExecuteSync: (plan: SyncItem[]) => Promise<void>;
}

export const SyncDialog: React.FC<SyncDialogProps> = ({
  isOpen,
  onClose,
  localPath,
  remotePath,
  onCompare,
  onExecuteSync,
}) => {
  const [direction, setDirection] = useState<SyncDirection>('local_to_remote');
  const [mirrorDelete, setMirrorDelete] = useState<boolean>(false);
  const [isComparing, setIsComparing] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [plan, setPlan] = useState<SyncItem[]>([]);

  if (!isOpen) return null;

  const handleRunCompare = async () => {
    setIsComparing(true);
    try {
      const items = await onCompare({
        direction,
        mirror_delete: mirrorDelete,
        compare_by_size_only: false,
      });
      setPlan(items);
    } catch (err) {
      alert(`Falha ao comparar diretórios: ${err}`);
    } finally {
      setIsComparing(false);
    }
  };

  const handleStartSync = async () => {
    setIsSyncing(true);
    try {
      await onExecuteSync(plan);
      onClose();
    } catch (err) {
      alert(`Erro na sincronização: ${err}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const getActionBadge = (action: SyncActionType) => {
    switch (action) {
      case 'upload':
        return (
          <span className="flex items-center space-x-1 text-sky-400 font-semibold">
            <ArrowRight className="w-3.5 h-3.5" />
            <span>Upload</span>
          </span>
        );
      case 'download':
        return (
          <span className="flex items-center space-x-1 text-purple-400 font-semibold">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Download</span>
          </span>
        );
      case 'delete_remote':
      case 'delete_local':
        return (
          <span className="flex items-center space-x-1 text-red-400 font-semibold">
            <Trash2 className="w-3.5 h-3.5" />
            <span>Excluir</span>
          </span>
        );
      case 'identical':
      default:
        return (
          <span className="flex items-center space-x-1 text-slate-500 font-medium">
            <Check className="w-3.5 h-3.5 text-emerald-400" />
            <span>Idêntico</span>
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl max-w-4xl w-full shadow-2xl flex flex-col h-[600px] overflow-hidden text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750 select-none">
          <div className="flex items-center space-x-2">
            <RefreshCw className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            <h3 className="font-bold text-slate-900 dark:text-slate-100 text-xs">Sincronização & Comparação de Pastas</h3>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white p-1 rounded-md hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sync Settings */}
        <div className="p-4 bg-slate-50 dark:bg-dark-900 border-b border-slate-200 dark:border-dark-700 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white dark:bg-dark-800/80 p-2.5 rounded border border-slate-200 dark:border-dark-700 shadow-sm">
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase">Origem (Local)</span>
              <span className="font-mono text-slate-900 dark:text-slate-200 block truncate mt-0.5 font-medium">{localPath}</span>
            </div>
            <div className="bg-white dark:bg-dark-800/80 p-2.5 rounded border border-slate-200 dark:border-dark-700 shadow-sm">
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase">Destino (Remoto)</span>
              <span className="font-mono text-slate-900 dark:text-slate-200 block truncate mt-0.5 font-medium">{remotePath}</span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            {/* Direction Radio */}
            <div className="flex items-center space-x-4">
              <label className="flex items-center space-x-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="direction"
                  checked={direction === 'local_to_remote'}
                  onChange={() => setDirection('local_to_remote')}
                />
                <span className="text-slate-800 dark:text-slate-300 font-semibold">Local → Remoto (Upload)</span>
              </label>

              <label className="flex items-center space-x-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="direction"
                  checked={direction === 'remote_to_local'}
                  onChange={() => setDirection('remote_to_local')}
                />
                <span className="text-slate-800 dark:text-slate-300 font-semibold">Remoto → Local (Download)</span>
              </label>

              <label className="flex items-center space-x-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="direction"
                  checked={direction === 'both'}
                  onChange={() => setDirection('both')}
                />
                <span className="text-slate-800 dark:text-slate-300 font-semibold">Ambos (Bidirecional)</span>
              </label>
            </div>

            {/* Mirror Delete */}
            <label className="flex items-center space-x-2 text-slate-800 dark:text-slate-300 cursor-pointer font-medium">
              <input
                type="checkbox"
                checked={mirrorDelete}
                onChange={(e) => setMirrorDelete(e.target.checked)}
              />
              <span>Espelhar (Excluir arquivos órfãos no destino)</span>
            </label>
          </div>
        </div>

        {/* Diff Table */}
        <div className="flex-1 overflow-auto p-4 bg-white dark:bg-dark-900">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-slate-800 dark:text-slate-300 uppercase tracking-wider">
              Plano de Ações ({plan.filter(p => p.action !== 'identical').length} alterações)
            </span>
            <button
              onClick={handleRunCompare}
              disabled={isComparing}
              className="flex items-center space-x-1.5 px-3 py-1 rounded bg-slate-200 hover:bg-slate-300 dark:bg-dark-700 dark:hover:bg-dark-600 text-sky-700 dark:text-sky-400 font-semibold text-xs border border-slate-300 dark:border-dark-600 transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${isComparing ? 'animate-spin' : ''}`} />
              <span>{isComparing ? 'Comparando...' : 'Comparar Pastas'}</span>
            </button>
          </div>

          <table className="w-full text-left text-xs border border-slate-200 dark:border-dark-700 rounded bg-white dark:bg-dark-900 overflow-hidden">
            <thead className="bg-slate-100 dark:bg-dark-750 text-[11px] text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-dark-700 font-semibold">
              <tr>
                <th className="py-2 px-3">Arquivo / Caminho Relativo</th>
                <th className="py-2 px-3 w-32">Ação</th>
                <th className="py-2 px-3 w-28 text-right">Tam. Local</th>
                <th className="py-2 px-3 w-28 text-right">Tam. Remoto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-dark-700/50 font-mono text-[11px]">
              {plan.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-slate-500 font-sans text-xs">
                    Clique em "Comparar Pastas" para analisar as diferenças entre local e remoto.
                  </td>
                </tr>
              ) : (
                plan.map((item) => (
                  <tr key={item.relative_path} className="hover:bg-slate-50 dark:hover:bg-dark-800 transition-colors">
                    <td className="py-1.5 px-3 text-slate-900 dark:text-slate-200 font-medium">{item.relative_path}</td>
                    <td className="py-1.5 px-3">{getActionBadge(item.action)}</td>
                    <td className="py-1.5 px-3 text-right text-slate-600 dark:text-slate-400">
                      {item.local_size !== null && item.local_size !== undefined ? `${item.local_size} B` : '-'}
                    </td>
                    <td className="py-1.5 px-3 text-right text-slate-600 dark:text-slate-400">
                      {item.remote_size !== null && item.remote_size !== undefined ? `${item.remote_size} B` : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-dark-700 bg-slate-100 dark:bg-dark-750 flex items-center justify-end space-x-2 select-none">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-xs text-slate-700 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-dark-700 font-sans transition-colors font-semibold border border-slate-300 dark:border-slate-700">
            Cancelar
          </button>
          <button
            onClick={handleStartSync}
            disabled={isSyncing || plan.filter(p => p.action !== 'identical').length === 0}
            className="flex items-center space-x-1.5 px-5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md disabled:opacity-40"
          >
            <Play className={`w-3.5 h-3.5 ${isSyncing ? 'animate-pulse' : ''}`} />
            <span>{isSyncing ? 'Sincronizando...' : 'Iniciar Sincronização'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
