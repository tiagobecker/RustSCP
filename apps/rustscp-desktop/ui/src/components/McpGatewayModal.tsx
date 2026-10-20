import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, Copy, Info } from 'lucide-react';
import { AuditEvent, McpStatusInfo } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, IconButton, Toggle } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';

interface McpGatewayModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: McpStatusInfo | null;
  auditLogs: AuditEvent[];
  /** Turns the gateway on or off (remembered across restarts). */
  onSetEnabled?: (enabled: boolean) => Promise<unknown>;
}

/** Monospaced, selectable snippet with a copy button. */
const CopyBlock: React.FC<{ label: React.ReactNode; text: string; copyLabel: string }> = ({ label, text, copyLabel }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-ink-faint">{label}</span>
        <IconButton size="sm" label={copyLabel} onClick={handleCopy}>
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </IconButton>
      </div>
      <pre className="rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-[12px] text-ink whitespace-pre-wrap break-all select-text">
        {text}
      </pre>
    </div>
  );
};

export const McpGatewayModal: React.FC<McpGatewayModalProps> = ({ isOpen, onClose, status, auditLogs, onSetEnabled }) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  // The value being applied while the switch is busy.
  const [switching, setSwitching] = useState<boolean | null>(null);

  if (!isOpen) return null;

  const s = status;
  const shipsTransport = !!s && s.transport_available === true;
  const running = shipsTransport && s.transport_running === true && !!s.enabled;
  const turnedOff = shipsTransport && s.turned_off === true;
  const switchedOn = switching ?? !turnedOff;
  const agents = s?.connected_agents ?? 0;
  const copyLabel = isPt ? 'Copiar' : 'Copy';
  const allowLabel = isPt ? 'Permitir agentes de IA' : 'Allow AI agents';

  const handleSwitch = async (on: boolean) => {
    if (!onSetEnabled || switching !== null) return;
    setSwitching(on);
    try {
      await onSetEnabled(on);
    } catch (e) {
      notify.error(isPt ? 'Não foi possível alterar o gateway' : 'The gateway could not be changed', e);
    } finally {
      setSwitching(null);
    }
  };

  const badge = !s
    ? { text: isPt ? 'Status indisponível' : 'Status unavailable', cls: 'bg-dark-650/70 text-ink-muted' }
    : running
      ? {
          text:
            agents > 0
              ? isPt
                ? `Em execução · ${agents} agente(s)`
                : `Running · ${agents} agent${agents === 1 ? '' : 's'}`
              : isPt
                ? 'Em execução'
                : 'Running',
          cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        }
      : turnedOff
        ? { text: isPt ? 'Desligado' : 'Off', cls: 'bg-dark-650/70 text-ink-muted' }
        : shipsTransport
          ? { text: isPt ? 'Parado' : 'Stopped', cls: 'bg-dark-650/70 text-ink-muted' }
          : { text: isPt ? 'Indisponível nesta versão' : 'Not in this build', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString(i18n.language || undefined, { dateStyle: 'short', timeStyle: 'medium' });
    } catch {
      return d.toLocaleString();
    }
  };

  const facts: Array<{ title: string; body: string }> = [
    {
      title: isPt ? 'Conexões usadas pelo RustSCP' : 'Connections are used through RustSCP',
      body: isPt
        ? 'Agentes recebem o id e o nome das sessões conectadas aqui, nunca as senhas ou chaves salvas. Eles podem ler qualquer arquivo que a sessão alcança; o disco deste computador não é compartilhado.'
        : 'Agents get the id and name of the sessions connected here, never your saved passwords or keys. They can read any file a session can reach; this computer’s own disk is not shared.',
    },
    {
      title: isPt ? 'Alterações pedem sua aprovação' : 'Changes need your approval',
      body: isPt
        ? 'Antes de um agente gravar um arquivo, o RustSCP pergunta se você permite. Nada é alterado se você negar ou não responder em 2 minutos.'
        : 'Before an agent writes a file, RustSCP asks you to allow it. Nothing changes if you deny it or do not answer within 2 minutes.',
    },
    {
      title: isPt ? 'Registro de atividade' : 'Activity log',
      body: isPt
        ? 'Cada chamada é registrada com horário, agente, ferramenta e alvo. Os últimos 1.000 eventos aparecem aqui; o histórico completo fica em mcp-audit.log, na pasta de configurações do RustSCP.'
        : 'Each call is recorded with time, agent, tool and target. The last 1,000 events show here; the full history is in mcp-audit.log in the RustSCP settings folder.',
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
              ? `Sessões disponíveis para agentes: ${s?.active_sessions_count ?? 0} · Eventos: ${s?.total_audit_events ?? auditLogs.length}`
              : `Sessions agents can use: ${s?.active_sessions_count ?? 0} · Events: ${s?.total_audit_events ?? auditLogs.length}`}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {isPt ? 'Fechar' : 'Close'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {shipsTransport && (
          <div className="ui-card flex items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink">{allowLabel}</div>
              <div className="text-[12px] text-ink-faint leading-snug mt-0.5">
                {switchedOn
                  ? isPt
                    ? 'Agentes configurados abaixo podem usar as sessões conectadas aqui.'
                    : 'Agents set up below can use the sessions connected here.'
                  : isPt
                    ? 'Nenhum agente consegue se conectar até você ligar de novo.'
                    : 'No agent can connect until you turn this back on.'}
              </div>
            </div>
            <Toggle checked={switchedOn} onChange={handleSwitch} disabled={!onSetEnabled || switching !== null} label={allowLabel} />
          </div>
        )}

        {s && !running && !turnedOff && (
          <div className="flex items-start gap-2.5 rounded-lg bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-800 dark:text-amber-300">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p className="leading-relaxed">
              {!shipsTransport
                ? isPt
                  ? 'Esta versão não tem um canal de conexão para agentes. Nenhum programa fora do RustSCP consegue usar o gateway.'
                  : 'This build has no connection channel for agents. No program outside RustSCP can use the gateway.'
                : isPt
                  ? `O gateway não está aceitando agentes${s.gateway_error ? `: ${s.gateway_error}` : '.'} Desligue e ligue de novo para tentar outra vez.`
                  : `The gateway is not accepting agents${s.gateway_error ? `: ${s.gateway_error}` : '.'} Turn it off and on again to retry.`}
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

        {shipsTransport && s?.setup_command && (
          <div className="space-y-3">
            <div>
              <div className="text-[12px] font-medium text-ink-faint">{isPt ? 'Conectar um agente' : 'Connect an agent'}</div>
              <p className="text-[12px] text-ink-faint leading-snug mt-0.5">
                {isPt
                  ? 'Rode uma vez no terminal. Mantenha o RustSCP aberto enquanto o agente trabalha: ele usa os servidores conectados aqui.'
                  : 'Run this once in a terminal. Keep RustSCP open while the agent works: it uses the servers connected here.'}
              </p>
            </div>
            <CopyBlock label="Claude Code" text={s.setup_command} copyLabel={copyLabel} />
            {s.setup_json && (
              <Disclosure label={isPt ? 'Outros agentes (Cursor, Claude Desktop…)' : 'Other agents (Cursor, Claude Desktop…)'}>
                <CopyBlock
                  label={isPt ? 'Adicione à configuração MCP do agente' : 'Add to the agent’s MCP configuration'}
                  text={s.setup_json}
                  copyLabel={copyLabel}
                />
              </Disclosure>
            )}
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
