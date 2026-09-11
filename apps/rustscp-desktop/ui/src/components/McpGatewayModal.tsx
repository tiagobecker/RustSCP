import React from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Bot, 
  ShieldCheck, 
  Lock, 
  Activity, 
  Terminal,
  CheckCircle2,
  Clock
} from 'lucide-react';
import { AuditEvent, McpStatusInfo } from '../types.ts';

interface McpGatewayModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: McpStatusInfo | null;
  auditLogs: AuditEvent[];
}

export const McpGatewayModal: React.FC<McpGatewayModalProps> = ({
  isOpen,
  onClose,
  status,
  auditLogs,
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl max-w-3xl w-full shadow-2xl flex flex-col max-h-[85vh] overflow-hidden text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/20">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">{t('mcp.title')}</h3>
                <span className="flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse" />
                  <span>{t('mcp.statusActive')}</span>
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('mcp.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white p-1 rounded-md hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex-1 overflow-y-auto space-y-5">
          {/* Security Bastion Highlights */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-50 dark:bg-dark-900/60 border border-slate-200 dark:border-dark-700 p-3 rounded-lg flex items-start space-x-2.5">
              <Lock className="w-4 h-4 text-sky-500 dark:text-sky-400 mt-0.5 flex-shrink-0" />
              <div>
                <h5 className="text-xs font-semibold text-slate-900 dark:text-slate-200">Zero-Credential Leak</h5>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">IAs nunca recebem chaves SSH ou senhas; apenas chamadas mediadas.</p>
              </div>
            </div>

            <div className="bg-slate-50 dark:bg-dark-900/60 border border-slate-200 dark:border-dark-700 p-3 rounded-lg flex items-start space-x-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-500 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
              <div>
                <h5 className="text-xs font-semibold text-slate-900 dark:text-slate-200">Guardrails & RBAC</h5>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">Comandos destrutivos exigem aprovação na interface gráfica.</p>
              </div>
            </div>

            <div className="bg-slate-50 dark:bg-dark-900/60 border border-slate-200 dark:border-dark-700 p-3 rounded-lg flex items-start space-x-2.5">
              <Activity className="w-4 h-4 text-amber-500 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <div>
                <h5 className="text-xs font-semibold text-slate-900 dark:text-slate-200">Trilha de Auditoria</h5>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">Todo arquivo lido ou alterado é gravado com timestamp e diff.</p>
              </div>
            </div>
          </div>

          {/* Connected AI Agents Config Snippet */}
          <div className="bg-slate-50 dark:bg-dark-900 border border-slate-200 dark:border-dark-700 rounded-lg p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center space-x-1.5">
                <Terminal className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
                <span>Configuração de Agentes (Claude Code, Hermes, Antigravity, OpenClaw)</span>
              </span>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">JSON-RPC / stdio</span>
            </div>
            <div className="bg-slate-950 dark:bg-black/70 rounded p-2.5 border border-slate-800 dark:border-dark-700 font-mono text-[11px] text-purple-300">
              {`claude mcp add rustscp -- rustscp-desktop --mcp`}
            </div>
          </div>

          {/* Audit Logs Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center space-x-1.5">
                <Clock className="w-3.5 h-3.5 text-sky-500 dark:text-sky-400" />
                <span>{t('mcp.auditLogs')}</span>
              </h4>
              <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                {auditLogs.length} eventos registrados
              </span>
            </div>

            <div className="border border-slate-200 dark:border-dark-700 rounded-lg overflow-hidden max-h-56 overflow-y-auto bg-white dark:bg-dark-900 shadow-sm">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 dark:bg-dark-750 text-[11px] text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-dark-700 font-semibold">
                  <tr>
                    <th className="py-2 px-3">{t('mcp.agent')}</th>
                    <th className="py-2 px-3">{t('mcp.action')}</th>
                    <th className="py-2 px-3">{t('mcp.target')}</th>
                    <th className="py-2 px-3 text-right">{t('mcp.time')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-dark-700/60 font-mono text-[11px]">
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-slate-500 font-sans text-xs">
                        {t('mcp.noLogs')}
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-dark-700/30 transition-colors">
                        <td className="py-2 px-3 text-emerald-600 dark:text-emerald-400 font-medium">
                          {log.agent_id}
                        </td>
                        <td className="py-2 px-3 text-slate-800 dark:text-slate-200">
                          {log.tool_name}
                        </td>
                        <td className="py-2 px-3 text-slate-600 dark:text-slate-400 truncate max-w-xs">
                          {log.parameters_summary}
                        </td>
                        <td className="py-2 px-3 text-right text-slate-500">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-dark-700 bg-slate-100 dark:bg-dark-750 flex items-center justify-between">
          <span className="text-xs text-slate-600 dark:text-slate-400 flex items-center space-x-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
            <span>Sessões conectadas ativas: {status?.active_sessions_count || 1}</span>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-semibold bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-dark-700 dark:hover:bg-dark-600 dark:text-slate-200 border border-slate-300 dark:border-dark-600 transition-colors"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
