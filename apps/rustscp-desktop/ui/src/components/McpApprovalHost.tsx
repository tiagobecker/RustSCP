import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { McpApprovalPrompt } from '../types.ts';
import { formatBytes } from '../utils/paths.ts';
import { AutomationConfirm } from './automation/AutomationConfirm.tsx';
import { notify } from './ui/toast.tsx';

/**
 * Asks the user to allow or deny each file write an AI agent requests through the MCP gateway.
 * Requests arrive as `mcp-approval-request` events and leave on `mcp-approval-resolved`
 * (answered, timed out or the agent disconnected). Deny is the focused, default answer.
 */
export const McpApprovalHost: React.FC = () => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const [queue, setQueue] = useState<McpApprovalPrompt[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const keep = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };
    const add = (prompt: McpApprovalPrompt) =>
      setQueue((q) => (q.some((p) => p.id === prompt.id) ? q : [...q, prompt]));

    listen<McpApprovalPrompt>('mcp-approval-request', (e) => add(e.payload))
      .then(keep)
      .catch(() => {});
    listen<string>('mcp-approval-resolved', (e) => setQueue((q) => q.filter((p) => p.id !== e.payload)))
      .then(keep)
      .catch(() => {});
    // Requests made before this window loaded (or before a reload).
    invoke<McpApprovalPrompt[]>('get_pending_mcp_approvals')
      .then((pending) => {
        if (!disposed && Array.isArray(pending)) pending.forEach(add);
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const current = queue[0];

  // Countdown to the automatic denial.
  useEffect(() => {
    if (!current) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current]);

  if (!current) return null;

  const answer = (approved: boolean) => {
    setQueue((q) => q.filter((p) => p.id !== current.id));
    invoke('respond_mcp_approval', { id: current.id, approved }).catch((err) => {
      notify.warning(
        isPt ? 'O pedido do agente não está mais aguardando' : 'The agent’s request is no longer waiting',
        String(err ?? '')
      );
    });
  };

  const secondsLeft = Math.max(0, Math.ceil((current.expires_at_ms - now) / 1000));
  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const queuePos =
    queue.length > 1 ? (
      <span className="font-sans text-ink-faint"> · {isPt ? `1 de ${queue.length}` : `1 of ${queue.length}`}</span>
    ) : null;
  const deniedIn = isPt ? `Negado automaticamente em ${countdown}.` : `Denied automatically in ${countdown}.`;

  // A command request looks and reads differently from a file write.
  const isCommand = current.kind === 'command';
  if (isCommand) {
    const risk = (current.risk ?? 'caution') as 'safe' | 'caution' | 'dangerous';
    const dangerous = risk === 'dangerous';
    const riskLabel = isPt
      ? { safe: 'Baixo risco', caution: 'Atenção', dangerous: 'Perigoso' }[risk]
      : { safe: 'Low risk', caution: 'Caution', dangerous: 'Dangerous' }[risk];
    return (
      <AutomationConfirm
        isOpen
        tone={dangerous ? 'danger' : 'primary'}
        title={isPt ? 'Permitir que um agente de IA execute este comando?' : 'Allow an AI agent to run this command?'}
        message={
          isPt ? (
            <>
              <span className="text-ink">{current.agent_id}</span> quer executar um comando em{' '}
              <span className="text-ink">{current.connection_name}</span>.
            </>
          ) : (
            <>
              <span className="text-ink">{current.agent_id}</span> wants to run a command on{' '}
              <span className="text-ink">{current.connection_name}</span>.
            </>
          )
        }
        target={<span className="font-mono break-all">{current.connection_name}{queuePos}</span>}
        command={current.command ?? undefined}
        confirmLabel={isPt ? 'Permitir' : 'Allow'}
        cancelLabel={isPt ? 'Negar' : 'Deny'}
        onConfirm={() => answer(true)}
        onCancel={() => answer(false)}
      >
        <div className="space-y-1 text-[12px] text-ink-faint">
          <div>
            <span
              className={
                dangerous
                  ? 'text-red-600 dark:text-red-400'
                  : risk === 'caution'
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-ink-faint'
              }
            >
              {riskLabel}
            </span>
            {isPt
              ? ' · roda com as credenciais já conectadas'
              : ' · runs with the already-connected credentials'}
          </div>
          <div>{deniedIn}</div>
        </div>
      </AutomationConfirm>
    );
  }

  const replacing = current.previous_size !== null && current.previous_size !== undefined;
  const sizeLine = replacing
    ? `${formatBytes(current.previous_size ?? 0)} → ${formatBytes(current.new_size)}`
    : isPt
      ? `Arquivo novo · ${formatBytes(current.new_size)}`
      : `New file · ${formatBytes(current.new_size)}`;

  return (
    <AutomationConfirm
      isOpen
      tone={replacing ? 'danger' : 'primary'}
      title={
        replacing
          ? isPt
            ? 'Permitir que um agente de IA substitua este arquivo?'
            : 'Allow an AI agent to replace this file?'
          : isPt
            ? 'Permitir que um agente de IA crie este arquivo?'
            : 'Allow an AI agent to create this file?'
      }
      message={
        isPt ? (
          <>
            <span className="text-ink">{current.agent_id}</span> quer gravar em <span className="text-ink">{current.connection_name}</span>.
          </>
        ) : (
          <>
            <span className="text-ink">{current.agent_id}</span> wants to write to <span className="text-ink">{current.connection_name}</span>.
          </>
        )
      }
      target={
        <span className="font-mono break-all">
          {current.path}
          {queuePos}
        </span>
      }
      command={current.preview !== null && current.preview !== undefined ? current.preview + (current.preview_truncated ? '\n…' : '') : undefined}
      confirmLabel={isPt ? 'Permitir' : 'Allow'}
      cancelLabel={isPt ? 'Negar' : 'Deny'}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    >
      <div className="space-y-1 text-[12px] text-ink-faint">
        <div>
          {sizeLine}
          {current.preview === null || current.preview === undefined
            ? isPt
              ? ' · conteúdo binário'
              : ' · binary content'
            : ''}
        </div>
        <div className="font-mono break-all" title="SHA-256">
          sha256 {current.new_sha256}
        </div>
        <div>{deniedIn}</div>
      </div>
    </AutomationConfirm>
  );
};
