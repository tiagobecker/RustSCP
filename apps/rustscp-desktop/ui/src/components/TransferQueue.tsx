import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  ChevronUp, 
  ChevronDown, 
  ArrowUpRight, 
  CheckCircle, 
  AlertCircle,
  Clock,
  XCircle,
  Trash2,
  HardDrive
} from 'lucide-react';
import { QueueTransferTask } from '../types.ts';

interface TransferQueueProps {
  tasks: QueueTransferTask[];
  onCancelTask?: (taskId: string) => void;
  onClearCompleted: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export const TransferQueue: React.FC<TransferQueueProps> = ({
  tasks,
  onCancelTask,
  onClearCompleted,
  isExpanded: controlledExpanded,
  onToggleExpand,
}) => {
  const { t, i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const [internalExpanded, setInternalExpanded] = useState<boolean>(false);

  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const toggleExpanded = () => {
    if (onToggleExpand) {
      onToggleExpand();
    } else {
      setInternalExpanded(!internalExpanded);
    }
  };

  const activeTasks = tasks.filter((tr) => tr.status === 'in_progress');
  const totalSpeedBps = activeTasks.reduce((acc, curr) => acc + (curr.speed_bps || 0), 0);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatSpeed = (bps: number) => {
    if (bps === 0) return '-';
    const mbps = bps / (1024 * 1024);
    if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
    return `${Math.round(bps / 1024)} KB/s`;
  };

  const getStatusBadge = (task: QueueTransferTask) => {
    switch (task.status) {
      case 'in_progress':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono font-semibold text-sky-800 dark:text-sky-400 bg-sky-500/15 px-1.5 py-0.5 rounded border border-sky-500/30">
            <ArrowUpRight className="w-3 h-3 animate-pulse" />
            {isPt ? 'Enviando' : 'Transferring'}
          </span>
        );
      case 'queued':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono font-medium text-amber-800 dark:text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded border border-amber-500/30">
            <Clock className="w-3 h-3" />
            {isPt ? 'Na Fila' : 'Queued'}
          </span>
        );
      case 'completed':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono font-medium text-emerald-800 dark:text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded border border-emerald-500/30">
            <CheckCircle className="w-3 h-3" />
            {isPt ? 'Concluído' : 'Completed'}
          </span>
        );
      case 'failed':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono font-medium text-red-700 dark:text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded border border-red-500/30" title={task.error}>
            <AlertCircle className="w-3 h-3" />
            {isPt ? 'Falhou' : 'Failed'}
          </span>
        );
      case 'cancelled':
        return (
          <span className="flex items-center gap-1 text-[10px] font-mono font-medium text-slate-600 dark:text-slate-400 bg-slate-500/15 px-1.5 py-0.5 rounded border border-slate-500/30">
            <XCircle className="w-3 h-3" />
            {isPt ? 'Cancelado' : 'Cancelled'}
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-dark-800 border-t border-dark-700 select-none shadow-lg relative overflow-hidden">
      {/* Natural Transfer Wave Effect when transferring */}
      {activeTasks.length > 0 && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden select-none z-0">
          {/* Top animated wave line (luminous crest) */}
          <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-rust-500 via-sky-400 to-emerald-400 animate-wave-glow shadow-[0_0_10px_rgba(56,189,248,0.6)]" />

          {/* Flowing Organic Waves */}
          <div className="absolute inset-x-0 bottom-0 top-0 opacity-25 dark:opacity-35 flex">
            {/* Primary Sinusoidal Wave */}
            <svg 
              viewBox="0 0 1200 120" 
              preserveAspectRatio="none" 
              className="absolute bottom-0 h-full min-w-[200%] animate-natural-wave-1"
            >
              <defs>
                <linearGradient id="naturalWaveGrad1" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#d9531e" stopOpacity="0.4" />
                  <stop offset="50%" stopColor="#0284c7" stopOpacity="0.7" />
                  <stop offset="100%" stopColor="#d9531e" stopOpacity="0.4" />
                </linearGradient>
              </defs>
              <path 
                d="M0,45 C150,90 350,10 500,55 C650,100 850,20 1000,60 C1150,95 1200,50 1200,50 L1200,120 L0,120 Z" 
                fill="url(#naturalWaveGrad1)" 
              />
            </svg>

            {/* Secondary Counter-Harmonic Wave */}
            <svg 
              viewBox="0 0 1200 120" 
              preserveAspectRatio="none" 
              className="absolute bottom-0 h-full min-w-[200%] animate-natural-wave-2"
            >
              <defs>
                <linearGradient id="naturalWaveGrad2" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#0284c7" stopOpacity="0.3" />
                  <stop offset="50%" stopColor="#10b981" stopOpacity="0.6" />
                  <stop offset="100%" stopColor="#0284c7" stopOpacity="0.3" />
                </linearGradient>
              </defs>
              <path 
                d="M0,60 C200,20 380,85 600,40 C820,-5 980,80 1200,45 L1200,120 L0,120 Z" 
                fill="url(#naturalWaveGrad2)" 
              />
            </svg>
          </div>
        </div>
      )}

      {/* Collapsible Bar */}
      <div 
        onClick={toggleExpanded}
        className="px-4 py-2 flex items-center justify-between cursor-pointer hover:bg-dark-700/50 transition-colors relative z-10"
      >
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5 text-xs font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wider">
            <HardDrive className={`w-3.5 h-3.5 ${activeTasks.length > 0 ? 'text-sky-500 dark:text-sky-400 animate-pulse' : 'text-slate-500 dark:text-slate-400'}`} />
            <span>{t('transfers.queue')}</span>
          </div>

          <span className="text-[11px] bg-dark-700 px-2 py-0.5 rounded-full text-slate-700 dark:text-slate-200 font-mono font-semibold dark:font-normal border border-dark-600">
            {activeTasks.length} {t('transfers.active')} / {tasks.length} total
          </span>

          {totalSpeedBps > 0 && (
            <span className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400 font-semibold bg-emerald-500/15 px-2 py-0.5 rounded-full border border-emerald-500/30 shadow-sm">
              ⚡ {formatSpeed(totalSpeedBps)}
            </span>
          )}

          {activeTasks.length > 0 && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-sky-900 dark:text-sky-300 bg-sky-500/15 dark:bg-sky-500/20 px-2.5 py-0.5 rounded-full border border-sky-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-500 dark:bg-sky-400 animate-ping" />
              <span>{isPt ? 'Transferência em andamento • Clique para expandir' : 'Transfer in progress • Click to expand'}</span>
            </span>
          )}
        </div>

        <div className="flex items-center space-x-2">
          {tasks.some((tr) => tr.status === 'completed' || tr.status === 'failed' || tr.status === 'cancelled') && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClearCompleted();
              }}
              title={t('transfers.clearCompleted')}
              className="px-2 py-1 rounded bg-dark-700 hover:bg-dark-650 dark:hover:bg-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 text-xs flex items-center gap-1 border border-dark-600 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              <span>{t('transfers.clearCompleted')}</span>
            </button>
          )}

          <div className="text-slate-500 dark:text-slate-400 p-1">
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </div>
        </div>
      </div>

      {/* Expanded List */}
      {isExpanded && (
        <div className="max-h-48 overflow-y-auto px-4 pb-3 divide-y divide-dark-700/50 border-t border-dark-700/40">
          {tasks.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
              {t('transfers.noTransfers')}
            </div>
          ) : (
            tasks.map((item) => {
              const pct = item.total_bytes > 0
                ? Math.min(100, Math.round((item.transferred_bytes / item.total_bytes) * 100))
                : (item.status === 'completed' ? 100 : 0);

              return (
                <div key={item.id} className="py-2.5 flex items-center justify-between text-xs hover:bg-dark-700/30 px-2 rounded">
                  <div className="flex items-center space-x-2.5 min-w-0 flex-1 mr-4">
                    {getStatusBadge(item)}
                    <div className="flex flex-col min-w-0">
                      <span className="text-slate-800 dark:text-slate-200 font-medium truncate font-mono text-xs">{item.name}</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate font-mono">
                        {item.source_path} → {item.dest_path}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 flex-shrink-0">
                    <div className="w-28 bg-slate-200 dark:bg-dark-900 rounded-full h-1.5 overflow-hidden border border-slate-300 dark:border-dark-700">
                      <div
                        className={`h-full transition-all duration-300 ${
                          item.status === 'completed'
                            ? 'bg-emerald-500'
                            : item.status === 'failed'
                            ? 'bg-red-500'
                            : 'bg-sky-500'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    <div className="w-16 text-right font-mono text-[11px] text-slate-600 dark:text-slate-400">
                      {formatBytes(item.transferred_bytes)}
                      {item.total_bytes > 0 && ` / ${formatBytes(item.total_bytes)}`}
                    </div>

                    <span className="font-mono text-[11px] text-sky-700 dark:text-sky-400 font-medium w-16 text-right">
                      {item.status === 'in_progress' ? formatSpeed(item.speed_bps) : item.status === 'completed' ? '100%' : '-'}
                    </span>

                    {(item.status === 'in_progress' || item.status === 'queued') && onCancelTask && (
                      <button
                        onClick={() => onCancelTask(item.id)}
                        title={t('transfers.cancel')}
                        className="p-1 text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
