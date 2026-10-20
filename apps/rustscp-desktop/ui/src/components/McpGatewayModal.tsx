import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, Copy, Info } from 'lucide-react';
import { AuditEvent, McpStatusInfo } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, IconButton } from './ui/controls.tsx';

interface McpGatewayModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: McpStatusInfo | null;
  auditLogs: AuditEvent[];
}

/** Optional fields a newer backend may report; absent today (no MCP transport is wired yet). */
type McpStatusLike = McpStatusInfo & {
  transport_available?: boolean;
  transport_running?: boolean;
  setup_command?: string | null;
};

const DEFAULT_SETUP_COMMAND = 'claude mcp add rustscp -- rustscp-desktop --mcp';

export const McpGatewayModal: React.FC<McpGatewayModalProps> = ({ isOpen, onClose, status, auditLogs }) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const s = status as McpStatusLike | null;
  const transportUp = !!s && (s.transport_running === true || s.transport_available === true);
  const running = transportUp && !!s?.enabled;
  const setupCommand = s?.setup_command || DEFAULT_SETUP_COMMAND;

  const badge = !s
    ? { text: isPt ? 'Status indisponível' : 'Status unavailable', cls: 'bg-dark-650/70 text-ink-muted' }
    : running
      ? { text: isPt ? 'Em execução' : 'Running', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' }
      : transportUp
        ? { text: isPt ? 'Desligado' : 'Off', cls: 'bg-dark-650/70 text-ink-muted' }
        : { text: isPt ? 'Prévia · agentes não conectam ainda' : 'Preview · agents cannot connect yet', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString(i18n.language || undefined, { dateStyle: 'short', timeStyle: 'medium' });
    } catch {
      return d.toLocaleString();
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(setupCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const facts: Array<{ title: string; body: string }> = [
    {
      title: isPt ? 'Conexões usadas pelo RustSCP' : 'Connections are used through RustSCP',
      body: isPt
        ? 'Agentes recebem ids de sessão, não as senhas ou chaves salvas das conexões. Eles podem ler e gravar qualquer arquivo que a sessão alcança.'
        : 'Agents get session ids, not the saved passwords or keys of your connections. They can read and write any file the session can reach.',
    },
    {
      title: isPt ? 'Registro de atividade' : 'Activity log',
      body: isPt
        ? 'Cada chamada é registrada com horário, agente, ferramenta e alvo (últimos 1.000 eventos).'
        : 'Each call is recorded with time, agent, tool and target (last 1,000 events).',
    },
    {
      title: isPt ? 'Sem etapa de aprovação' : 'No approval step',
      body: isPt
        ? 'Ainda não há confirmação na interface antes de uma alteração feita por um agente.'
        : 'There is no in-app confirmation yet before a change made by an agent.',
    },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      icon={<Bot className="w-5 h-5" />}
      title={isPt ? 'Gateway de IA (MCP)' : 'AI gateway (MCP)'}
      subtitle={isPt ? 'Acesso de agentes de IA às suas conexões abertas' : 'AI agent access to your open connections'}
      headerActions={<span className={`inline-flex items-center h-6 px-2 rounded-md text-[11.5px] font-medium whitespace-nowrap ${badge.cls}`}>{badge.text}</span>}
      footer={
        <>
          <span className="mr-auto text-[12px] text-ink-faint">
            {isPt
              ? `Sessões abertas: ${s?.active_sessions_count ?? 0} · Eventos: ${s?.total_audit_events ?? auditLogs.length}`
              : `Open sessions: ${s?.active_sessions_count ?? 0} · Events: ${s?.total_audit_events ?? auditLogs.length}`}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {isPt ? 'Fechar' : 'Close'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!transportUp && (
          <div className="flex items-start gap-2.5 rounded-lg bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-800 dark:text-amber-300">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p className="leading-relaxed">
              {isPt
                ? 'Esta versão ainda não tem um canal de conexão para agentes (stdio ou socket). Nenhum programa fora do RustSCP consegue usar o gateway; a atividade abaixo mostra apenas chamadas feitas dentro do app.'
                : 'This build has no connection channel for agents yet (stdio or socket). No program outside RustSCP can use the gateway; the activity below only lists calls made inside the app.'}
            </p>
          </div>
        )}

        <div className="ui-card divide-y divide-line">
          {facts.map((f) => (
            <div key={f.title} className="px-3.5 py-2.5">
              <div className="text-[13px] text-ink">{f.title}</div>
              <div className="text-[12px] text-ink-faint leading-snug mt-0.5">{f.body}</div>
            </div>
          ))}
        </div>

        {transportUp && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-faint">{isPt ? 'Configurar um agente' : 'Set up an agent'}</span>
              <IconButton size="sm" label={isPt ? 'Copiar comando' : 'Copy command'} onClick={handleCopy}>
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </IconButton>
            </div>
            <pre className="rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-[12px] text-ink whitespace-pre-wrap break-all select-text">
              {setupCommand}
            </pre>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-ink-faint">{isPt ? 'Atividade' : 'Activity'}</span>
            <span className="text-[12px] text-ink-faint tabular-nums">
              {isPt ? `${auditLogs.length} evento(s)` : `${auditLogs.length} event(s)`}
            </span>
          </div>
          <div className="ui-card overflow-hidden max-h-64 overflow-y-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="sticky top-0 bg-surface-raised text-ink-faint border-b border-line">
                <tr>
                  <th className="py-2 px-3 font-medium">{isPt ? 'Agente' : 'Agent'}</th>
                  <th className="py-2 px-3 font-medium">{isPt ? 'Ferramenta' : 'Tool'}</th>
                  <th className="py-2 px-3 font-medium">{isPt ? 'Alvo' : 'Target'}</th>
                  <th className="py-2 px-3 font-medium">{isPt ? 'Resultado' : 'Result'}</th>
                  <th className="py-2 px-3 font-medium text-right">{isPt ? 'Data/hora' : 'Time'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-ink-faint">
                      {isPt ? 'Nenhuma atividade registrada.' : 'No activity recorded.'}
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => {
                    const ok = /^(success|ok)$/i.test(log.status || '');
                    return (
                      <tr key={log.id} className="hover:bg-dark-650/40 transition-colors">
                        <td className="py-1.5 px-3 text-ink">{log.agent_id}</td>
                        <td className="py-1.5 px-3 font-mono text-ink-muted">{log.tool_name}</td>
                        <td className="py-1.5 px-3 font-mono text-ink-muted max-w-[220px] truncate" title={`${log.connection_id} · ${log.parameters_summary}`}>
                          {log.parameters_summary}
                        </td>
                        <td className={`py-1.5 px-3 ${ok ? 'text-ink-muted' : 'text-red-600 dark:text-red-400'}`}>{log.status}</td>
                        <td className="py-1.5 px-3 text-right text-ink-faint tabular-nums whitespace-nowrap">{formatTime(log.timestamp)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Modal>
  );
};
