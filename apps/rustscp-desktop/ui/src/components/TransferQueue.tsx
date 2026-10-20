import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronUp,
  ChevronDown,
  ArrowUpDown,
  ArrowLeftRight,
  Upload,
  Download,
  CircleCheck,
  CircleAlert,
  CircleX,
  CirclePause,
  Clock,
  X,
} from 'lucide-react';
import { QueueTransferTask } from '../types.ts';
import { formatEta, formatSize, safeDisplayName } from './fileListUtils.ts';

interface TransferQueueProps {
  tasks: QueueTransferTask[];
  onCancelTask?: (taskId: string) => void;
  onClearCompleted: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

type Direction = 'upload' | 'download' | 'copy' | 'move';

const directionOf = (task: QueueTransferTask): Direction => {
  const srcLocal = task.source_session === 'local';
  const dstLocal = task.dest_session === 'local';
  if (srcLocal && !dstLocal) return 'upload';
  if (!srcLocal && dstLocal) return 'download';
  return task.is_move ? 'move' : 'copy';
};

const formatSpeed = (bps: number) => (bps > 0 ? `${formatSize(bps)}/s` : '');

const isPending = (task: QueueTransferTask) =>
  task.status === 'in_progress' || task.status === 'queued' || task.status === 'paused';

export const TransferQueue: React.FC<TransferQueueProps> = ({
  tasks,
  onCancelTask,
  onClearCompleted,
  isExpanded: controlledExpanded,
  onToggleExpand,
}) => {
  const { t, i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const listId = useId();
  const [internalExpanded, setInternalExpanded] = useState<boolean>(false);

  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const toggleExpanded = () => {
    if (onToggleExpand) {
      onToggleExpand();
    } else {
      setInternalExpanded((v) => !v);
    }
  };

  const stats = useMemo(() => {
    let active = 0;
    let queued = 0;
    let failed = 0;
    let finished = 0;
    let speed = 0;
    let pendingTotal = 0;
    let pendingDone = 0;
    for (const task of tasks) {
      if (task.status === 'in_progress') {
        active++;
        speed += task.speed_bps || 0;
      } else if (task.status === 'queued' || task.status === 'paused') {
        queued++;
      } else {
        finished++;
        if (task.status === 'failed') failed++;
      }
      if (isPending(task)) {
        pendingTotal += Math.max(0, task.total_bytes || 0);
        pendingDone += Math.max(0, Math.min(task.transferred_bytes || 0, task.total_bytes || 0));
      }
    }
    const pct = pendingTotal > 0 ? Math.min(100, (pendingDone / pendingTotal) * 100) : 0;
    const eta = speed > 0 && pendingTotal > pendingDone ? (pendingTotal - pendingDone) / speed : 0;
    return { active, queued, failed, finished, speed, pct, eta, hasPending: active + queued > 0 };
  }, [tasks]);

  const statusLabel = (task: QueueTransferTask): string => {
    switch (task.status) {
      case 'in_progress': {
        const dir = directionOf(task);
        if (dir === 'upload') return isPt ? 'Enviando' : 'Uploading';
        if (dir === 'download') return isPt ? 'Baixando' : 'Downloading';
        if (dir === 'move') return isPt ? 'Movendo' : 'Moving';
        return isPt ? 'Copiando' : 'Copying';
      }
      case 'queued':
        return isPt ? 'Na fila' : 'Queued';
      case 'paused':
        return isPt ? 'Pausado' : 'Paused';
      case 'completed':
        return isPt ? 'Concluído' : 'Done';
      case 'failed':
        return isPt ? 'Falhou' : 'Failed';
      case 'cancelled':
        return isPt ? 'Cancelado' : 'Cancelled';
      default:
        return '';
    }
  };

  const statusIcon = (task: QueueTransferTask) => {
    const cls = 'w-4 h-4 shrink-0';
    switch (task.status) {
      case 'in_progress': {
        const dir = directionOf(task);
        const Icon = dir === 'upload' ? Upload : dir === 'download' ? Download : ArrowLeftRight;
        return <Icon className={`${cls} text-rust-500`} aria-hidden />;
      }
      case 'queued':
        return <Clock className={`${cls} text-ink-faint`} aria-hidden />;
      case 'paused':
        return <CirclePause className={`${cls} text-ink-faint`} aria-hidden />;
      case 'completed':
        return <CircleCheck className={`${cls} text-emerald-600 dark:text-emerald-400`} aria-hidden />;
      case 'failed':
        return <CircleAlert className={`${cls} text-red-600 dark:text-red-400`} aria-hidden />;
      case 'cancelled':
        return <CircleX className={`${cls} text-ink-faint`} aria-hidden />;
      default:
        return <span className={cls} />;
    }
  };

  const summaryParts: string[] = [];
  if (stats.active > 0) summaryParts.push(isPt ? `${stats.active} em andamento` : `${stats.active} active`);
  if (stats.queued > 0) summaryParts.push(isPt ? `${stats.queued} na fila` : `${stats.queued} queued`);
  if (stats.speed > 0) summaryParts.push(formatSpeed(stats.speed));
  if (stats.hasPending && stats.pct > 0) summaryParts.push(`${Math.floor(stats.pct)}%`);
  if (stats.eta > 0) summaryParts.push(isPt ? `~${formatEta(stats.eta)} restantes` : `~${formatEta(stats.eta)} left`);
  if (summaryParts.length === 0) {
    summaryParts.push(
      tasks.length === 0
        ? isPt ? 'Nenhuma transferência' : 'No transfers'
        : isPt ? `${tasks.length} no total` : `${tasks.length} total`
    );
  }

  return (
    <div className="relative bg-surface-raised border-t border-line select-none">
      {/* Aggregate progress hairline (determinate, no animation loops) */}
      {stats.hasPending && (
        <div
          className="absolute top-0 inset-x-0 h-[2px] bg-transparent overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(stats.pct)}
          aria-label={isPt ? 'Progresso total das transferências' : 'Overall transfer progress'}
        >
          <div className="h-full bg-rust-500/80 transition-[width] duration-500 ease-out" style={{ width: `${stats.pct}%` }} />
        </div>
      )}

      <div className="flex items-center gap-2 px-2 h-9">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={isExpanded}
          aria-controls={listId}
          className="flex-1 min-w-0 flex items-center gap-2.5 h-7 px-2 rounded-md text-left hover:bg-dark-650/50 transition-colors"
        >
          <ArrowUpDown className={`w-4 h-4 shrink-0 ${stats.active > 0 ? 'text-rust-500' : 'text-ink-muted'}`} aria-hidden />
          <span className="text-[13px] font-medium text-ink shrink-0">{isPt ? 'Transferências' : 'Transfers'}</span>
          <span className="text-[12px] text-ink-faint truncate tabular-nums">{summaryParts.join(' · ')}</span>
          {stats.failed > 0 && (
            <span className="text-[12px] text-red-600 dark:text-red-400 shrink-0">
              {isPt ? `${stats.failed} com falha` : `${stats.failed} failed`}
            </span>
          )}
          <span className="ml-auto text-ink-faint shrink-0">
            {isExpanded ? <ChevronDown className="w-4 h-4" aria-hidden /> : <ChevronUp className="w-4 h-4" aria-hidden />}
          </span>
        </button>

        {stats.finished > 0 && (
          <button
            type="button"
            onClick={onClearCompleted}
            title={isPt ? 'Remover da lista as transferências finalizadas' : 'Remove finished transfers from the list'}
            className="ui-btn ui-btn-ghost ui-btn-sm shrink-0"
          >
            {isPt ? 'Limpar finalizadas' : 'Clear finished'}
          </button>
        )}
      </div>

      {isExpanded && (
        <div id={listId} className="max-h-56 overflow-y-auto border-t border-line px-1.5 py-1">
          {tasks.length === 0 ? (
            <div className="py-6 text-center text-[12.5px] text-ink-faint">{t('transfers.noTransfers')}</div>
          ) : (
            <ul className="space-y-0.5" aria-label={isPt ? 'Transferências' : 'Transfers'}>
              {tasks.map((item) => {
                const total = Math.max(0, item.total_bytes || 0);
                const doneBytes = Math.max(0, item.transferred_bytes || 0);
                const pct =
                  total > 0 ? Math.min(100, Math.round((doneBytes / total) * 100)) : item.status === 'completed' ? 100 : 0;
                const cancellable = (item.status === 'in_progress' || item.status === 'queued' || item.status === 'paused') && !!onCancelTask;
                const route = `${safeDisplayName(item.source_path)} → ${safeDisplayName(item.dest_path)}`;
                const barColor =
                  item.status === 'completed'
                    ? 'bg-emerald-500/80'
                    : item.status === 'failed'
                    ? 'bg-red-500/80'
                    : item.status === 'cancelled'
                    ? 'bg-ink-faint/50'
                    : 'bg-rust-500/80';
                const speedText = item.status === 'in_progress' ? formatSpeed(item.speed_bps) : '';
                const itemEta =
                  item.status === 'in_progress' && item.speed_bps > 0 && total > doneBytes ? formatEta((total - doneBytes) / item.speed_bps) : '';

                return (
                  <li key={item.id} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-dark-650/40">
                    {statusIcon(item)}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <bdi className="truncate text-[13px] text-ink" title={item.name}>
                          {safeDisplayName(item.name)}
                        </bdi>
                        <span className={`shrink-0 text-[11.5px] ${item.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-ink-faint'}`}>
                          {statusLabel(item)}
                        </span>
                      </div>
                      {item.status === 'failed' && item.error ? (
                        <div
                          className="text-[12px] text-red-600 dark:text-red-400 truncate select-text cursor-text"
                          title={`${item.error}\n${route}`}
                        >
                          {item.error}
                        </div>
                      ) : (
                        <div className="text-[11.5px] text-ink-faint truncate font-mono" title={route}>
                          {route}
                        </div>
                      )}
                    </div>

                    <div className="hidden sm:block w-28 shrink-0">
                      <div
                        className="h-1 rounded-full bg-dark-650 overflow-hidden"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct}
                        aria-label={safeDisplayName(item.name)}
                      >
                        <div className={`h-full rounded-full transition-[width] duration-300 ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>

                    <div className="w-36 shrink-0 text-right text-[11.5px] leading-tight text-ink-muted tabular-nums">
                      <div className="truncate">
                        {formatSize(doneBytes)}
                        {total > 0 && ` / ${formatSize(total)}`}
                      </div>
                      {(speedText || itemEta) && (
                        <div className="truncate text-ink-faint">
                          {[speedText, itemEta && `~${itemEta}`].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>

                    <div className="w-7 shrink-0 flex justify-end">
                      {cancellable && (
                        <button
                          type="button"
                          onClick={() => onCancelTask?.(item.id)}
                          title={isPt ? 'Cancelar transferência' : 'Cancel transfer'}
                          aria-label={`${isPt ? 'Cancelar transferência' : 'Cancel transfer'}: ${safeDisplayName(item.name)}`}
                          className="ui-icon-btn ui-icon-btn-sm hover:text-red-600 dark:hover:text-red-400"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
