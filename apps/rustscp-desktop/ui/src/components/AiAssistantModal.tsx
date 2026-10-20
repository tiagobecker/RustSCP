import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Copy, File, Folder, Play, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { FileEntry } from '../types';
import { Modal } from './ui/Modal.tsx';
import { Button, Field, IconButton, Segmented, Select, TextInput } from './ui/controls.tsx';
import { formatBytes, joinPath, dirname } from '../utils/paths.ts';
import { commandInDir } from './automation/actionTemplate.ts';
import { AutomationConfirm } from './automation/AutomationConfirm.tsx';
import { CommandOutput, CommandResult } from './automation/CommandOutput.tsx';
import {
  AuditIssue,
  RenamePattern,
  auditPermissions,
  buildRenamePlan,
  formatMode,
  matchesFilter,
  parseFilterQuery,
  renameProblemText,
} from './automation/assistantLogic.ts';

interface AiAssistantModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeSessionId: string;
  activeSessionName: string;
  isRemote: boolean;
  currentPath: string;
  files: FileEntry[];
  onApplyFilter?: (filterText: string) => void;
  onRefreshFiles?: () => void;
  onExecuteRemoteCommand?: (cmd: string) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
}

type TabType = 'nl_filter' | 'batch_rename' | 'explainer' | 'cmd_generator' | 'security_audit';
type Risk = 'safe' | 'medium' | 'high';
type Feedback = { kind: 'success' | 'error'; text: string } | null;

/** Rows shown in list previews; the plan itself always covers every item. */
const PREVIEW_ROWS = 200;

const FeedbackBanner: React.FC<{ feedback: Feedback }> = ({ feedback }) =>
  feedback ? (
    <div
      role={feedback.kind === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] ${
        feedback.kind === 'error' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      }`}
    >
      {feedback.kind === 'error' ? <AlertTriangle className="w-4 h-4 mt-px shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-px shrink-0" />}
      <span className="whitespace-pre-wrap break-words">{feedback.text}</span>
    </div>
  ) : null;

export const AiAssistantModal: React.FC<AiAssistantModalProps> = ({
  isOpen,
  onClose,
  activeSessionId,
  activeSessionName,
  isRemote,
  currentPath,
  files = [],
  onApplyFilter,
  onRefreshFiles,
  onExecuteRemoteCommand,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  // The listing may contain a '..' parent entry: it is navigation, never a target for rename or chmod
  const safeFiles = useMemo(
    () => (Array.isArray(files) ? files.filter((f) => Boolean(f && f.name) && f.name !== '..' && f.name !== '.') : []),
    [files]
  );
  const pathOf = (f: FileEntry) => f.path || joinPath(currentPath, f.name);

  const [activeTab, setActiveTab] = useState<TabType>('nl_filter');

  // --- Filter ---
  const [nlQuery, setNlQuery] = useState('');
  const criteria = useMemo(() => parseFilterQuery(nlQuery), [nlQuery]);
  const filteredFiles = useMemo(() => safeFiles.filter((f) => matchesFilter(f, criteria)), [safeFiles, criteria]);

  // --- Batch rename ---
  const [renamePattern, setRenamePattern] = useState<RenamePattern>('kebab');
  const [renamePrefix, setRenamePrefix] = useState('backup_');
  const [renameSuffix, setRenameSuffix] = useState('_v2');
  const [findText, setFindText] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameProgress, setRenameProgress] = useState<{ done: number; total: number } | null>(null);
  const [renameFeedback, setRenameFeedback] = useState<Feedback>(null);
  const [confirmRename, setConfirmRename] = useState(false);
  const plan = useMemo(
    () => buildRenamePlan(safeFiles, renamePattern, { prefix: renamePrefix, suffix: renameSuffix, find: findText, replace: replaceWith }),
    [safeFiles, renamePattern, renamePrefix, renameSuffix, findText, replaceWith]
  );
  const previewRows = useMemo(() => {
    const changed = plan.rows.filter((r) => r.changed);
    const sorted = [...changed.filter((r) => r.problem), ...changed.filter((r) => !r.problem), ...plan.rows.filter((r) => !r.changed)];
    return sorted.slice(0, PREVIEW_ROWS);
  }, [plan]);

  // --- Explainer ---
  const [selectedFileForExplain, setSelectedFileForExplain] = useState('');
  const [explainedName, setExplainedName] = useState<string | null>(null);
  useEffect(() => {
    if (!safeFiles.some((f) => f.name === selectedFileForExplain)) {
      const first = safeFiles.find((f) => f.file_type !== 'directory') || safeFiles[0];
      setSelectedFileForExplain(first ? first.name : '');
    }
  }, [safeFiles, selectedFileForExplain]);

  // --- Command generator ---
  const [cmdQuery, setCmdQuery] = useState('');
  const [generatedCommand, setGeneratedCommand] = useState<{ command: string; explanation: string; risk: Risk } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [cmdResult, setCmdResult] = useState<CommandResult | null>(null);
  const [isExecutingCmd, setIsExecutingCmd] = useState(false);
  const [confirmCmd, setConfirmCmd] = useState(false);
  const cmdRunId = useRef(0);

  // --- Security audit ---
  const report = useMemo(() => auditPermissions(safeFiles, isPt), [safeFiles, isPt]);
  const [fixSelection, setFixSelection] = useState<Record<string, boolean>>({});
  const [isFixingPermissions, setIsFixingPermissions] = useState(false);
  const [auditFeedback, setAuditFeedback] = useState<Feedback>(null);
  const [confirmFix, setConfirmFix] = useState(false);
  useEffect(() => {
    // Preselect critical and warning issues; shared (sticky) folders stay opt-in
    const next: Record<string, boolean> = {};
    for (const issue of report.issues) next[pathOf(issue.item)] = issue.severity !== 'info';
    setFixSelection(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);
  const selectedIssues = report.issues.filter((i) => fixSelection[pathOf(i.item)]);

  const runTarget = `${activeSessionName} · ${currentPath || '/'}`;

  if (!isOpen) return null;

  // ------------------------------------------------------------------ rename
  const handleExecuteBatchRename = async () => {
    setConfirmRename(false);
    const items = plan.ordered;
    if (items.length === 0 || plan.problemCount > 0) return;
    setIsRenaming(true);
    setRenameFeedback(null);
    setRenameProgress({ done: 0, total: items.length });
    let count = 0;
    try {
      for (const row of items) {
        const from = pathOf(row.file);
        const to = joinPath(dirname(from) || currentPath, row.newName);
        try {
          await invoke('rename_item', { sessionId: activeSessionId, from, to });
        } catch (err) {
          throw new Error(
            isPt
              ? `${count} de ${items.length} renomeados. Parou em "${row.original}": ${String(err)}`
              : `Renamed ${count} of ${items.length}. Stopped at "${row.original}": ${String(err)}`
          );
        }
        count++;
        setRenameProgress({ done: count, total: items.length });
      }
      setRenameFeedback({
        kind: 'success',
        text: isPt ? `${count} arquivo(s) renomeado(s).` : `Renamed ${count} file(s).`,
      });
    } catch (err) {
      setRenameFeedback({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsRenaming(false);
      setRenameProgress(null);
      if (count > 0) onRefreshFiles?.();
    }
  };

  // ------------------------------------------------------------------ explainer
  const explainFile = (name: string) => {
    const f = safeFiles.find((file) => file.name === name);
    const lower = name.toLowerCase();
    const ext = lower.includes('.') ? lower.split('.').pop() || '' : '';
    const size = f ? formatBytes(f.size || 0) : '0 B';
    const mode = f?.permissions?.mode ? formatMode(f.permissions.mode) : null;

    if (f?.file_type === 'directory') {
      return {
        type: isPt ? 'Pasta' : 'Folder',
        summary: isPt ? 'Uma pasta da listagem atual.' : 'A folder in the current listing.',
        bestPractices: isPt
          ? 'Pastas costumam usar 755. Evite 777: qualquer usuário poderia criar ou trocar arquivos dentro dela.'
          : 'Folders usually use 755. Avoid 777: any user could create or replace files inside it.',
        details: mode ? (isPt ? `Permissões: ${mode}.` : `Permissions: ${mode}.`) : '',
      };
    }
    if (lower === '.env' || lower.startsWith('.env.')) {
      return {
        type: isPt ? 'Variáveis de ambiente e segredos' : 'Environment variables and secrets',
        summary: isPt
          ? 'Guarda chaves de API, senhas de banco de dados, portas e outras variáveis secretas da aplicação.'
          : 'Holds API keys, database passwords, ports and other secret application variables.',
        bestPractices: isPt
          ? 'Nunca envie ao Git (adicione ao .gitignore). Restrinja as permissões (chmod 600) para que outros usuários do servidor não leiam as credenciais.'
          : 'Never commit it to Git (add it to .gitignore). Restrict permissions (chmod 600) so other users on the server cannot read the credentials.',
        details: isPt ? `Tamanho: ${size}. Formato CHAVE=VALOR.` : `Size: ${size}. KEY=VALUE format.`,
      };
    }
    if (ext === 'conf' || ext === 'cfg' || lower.includes('nginx')) {
      return {
        type: isPt ? 'Configuração de servidor ou serviço' : 'Server or service configuration',
        summary: isPt
          ? 'Define rotas, certificados TLS, portas e limites de um servidor web ou serviço.'
          : 'Defines routes, TLS certificates, ports and limits of a web server or service.',
        bestPractices: isPt
          ? 'Valide a sintaxe (ex.: "nginx -t") antes de recarregar o serviço para não derrubar a produção.'
          : 'Validate the syntax (e.g. "nginx -t") before reloading the service so production stays up.',
        details: isPt
          ? 'Normalmente lido como root e executado por um usuário restrito (ex.: www-data).'
          : 'Usually read as root and run by a restricted user (e.g. www-data).',
      };
    }
    if (ext === 'json') {
      return {
        type: 'JSON',
        summary: isPt
          ? 'Usado em configurações de projeto (package.json, tsconfig.json) ou troca de dados entre APIs.'
          : 'Used for project settings (package.json, tsconfig.json) or data exchanged between APIs.',
        bestPractices: isPt
          ? 'JSON não aceita comentários. Use um formatador para manter a indentação.'
          : 'JSON does not allow comments. Use a formatter to keep indentation clean.',
        details: isPt ? `Tamanho: ${size}. Permissões recomendadas: 644.` : `Size: ${size}. Recommended permissions: 644.`,
      };
    }
    if (ext === 'yaml' || ext === 'yml') {
      return {
        type: isPt ? 'Configuração YAML' : 'YAML configuration',
        summary: isPt
          ? 'Configuração legível baseada em indentação (Docker Compose, CI/CD, Kubernetes).'
          : 'Readable, indentation-based configuration (Docker Compose, CI/CD, Kubernetes).',
        bestPractices: isPt
          ? 'Tabulações são proibidas em YAML. Confira o alinhamento de cada nível.'
          : 'Tabs are not allowed in YAML. Check the alignment of every level.',
        details: isPt ? `Tamanho: ${size}.` : `Size: ${size}.`,
      };
    }
    if (['sh', 'bash', 'zsh'].includes(ext)) {
      return {
        type: isPt ? 'Script de shell' : 'Shell script',
        summary: isPt
          ? 'Comandos em sequência para build, backup, implantação ou tarefas agendadas (cron).'
          : 'Commands in sequence for builds, backups, deployments or scheduled (cron) tasks.',
        bestPractices: isPt
          ? 'Comece com "#!/usr/bin/env bash" e "set -euo pipefail" para parar no primeiro erro.'
          : 'Start with "#!/usr/bin/env bash" and "set -euo pipefail" to stop at the first error.',
        details: isPt
          ? `Precisa do bit de execução (chmod +x ou 755).${mode ? ` Atual: ${mode}.` : ''}`
          : `Needs the execute bit (chmod +x or 755).${mode ? ` Current: ${mode}.` : ''}`,
      };
    }
    if (['log', 'out'].includes(ext)) {
      return {
        type: isPt ? 'Arquivo de log' : 'Log file',
        summary: isPt
          ? 'Histórico de requisições, erros, alertas e rastros de pilha da aplicação.'
          : 'History of requests, errors, warnings and stack traces of the application.',
        bestPractices: isPt
          ? 'Configure rotação (logrotate) para não encher o disco.'
          : 'Set up rotation (logrotate) so it does not fill the disk.',
        details: isPt ? `Tamanho: ${size}.` : `Size: ${size}.`,
      };
    }
    return {
      type: ext ? (isPt ? `Arquivo .${ext}` : `.${ext} file`) : isPt ? 'Arquivo' : 'File',
      summary: isPt ? `Arquivo em ${pathOf(f || ({ name } as FileEntry))}.` : `File at ${pathOf(f || ({ name } as FileEntry))}.`,
      bestPractices: isPt
        ? 'Mantenha permissões seguras (644 para arquivos comuns) e faça backup antes de editar.'
        : 'Keep safe permissions (644 for regular files) and back it up before editing.',
      details: isPt ? `Tamanho: ${size}.${mode ? ` Permissões: ${mode}.` : ''}` : `Size: ${size}.${mode ? ` Permissions: ${mode}.` : ''}`,
    };
  };
  const fileExplanation = explainedName ? explainFile(explainedName) : null;

  // ------------------------------------------------------------------ command generator
  const handleGenerateCommand = (queryText: string) => {
    const q = queryText
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    let command: string;
    let explanation: string;
    let risk: Risk = 'safe';

    if (/espaco|disco|tamanho|pastas|space|disk|size|largest|biggest/.test(q)) {
      command = "df -h . && echo '--- Largest items ---' && du -sh -- * 2>/dev/null | sort -hr | head -n 10";
      explanation = isPt
        ? 'Mostra o espaço usado e livre da partição da pasta atual e os 10 maiores itens desta pasta.'
        : 'Shows used and free space on the partition of the current folder and the 10 largest items in it.';
    } else if (/porta|aberta|conex|port|listen|socket/.test(q)) {
      command = 'ss -tulpn 2>/dev/null | grep LISTEN || netstat -tulpn 2>/dev/null | grep LISTEN';
      explanation = isPt
        ? 'Lista as portas TCP e UDP ouvindo conexões, com o processo e o PID.'
        : 'Lists TCP and UDP ports listening for connections, with the process and PID.';
    } else if (/memoria|ram|cpu|processo|memory|process/.test(q)) {
      command = "free -m && echo '--- Top processes ---' && ps aux --sort=-%mem | head -n 10";
      explanation = isPt
        ? 'Mostra o uso de RAM e swap em MB e os 10 processos que mais usam memória.'
        : 'Shows RAM and swap usage in MB and the 10 processes using the most memory.';
    } else if (/nginx/.test(q) && /reini|reload|restart|recarreg/.test(q)) {
      command = 'nginx -t && systemctl reload nginx';
      explanation = isPt
        ? 'Testa a configuração do Nginx e, só se o teste passar, recarrega o serviço sem derrubar conexões.'
        : 'Tests the Nginx configuration and, only if the test passes, reloads the service without dropping connections.';
      risk = 'medium';
    } else if (/compactar|zip|backup|compress|archive/.test(q)) {
      command =
        "tar -czf \"backup_$(date +%Y%m%d_%H%M%S).tar.gz\" --exclude='*.log' --exclude='node_modules' --exclude='backup_*.tar.gz' .";
      explanation = isPt
        ? 'Cria um .tar.gz da pasta atual (com data e hora no nome) dentro dela mesma, sem logs, node_modules e backups anteriores.'
        : 'Creates a .tar.gz of the current folder (date and time in the name) inside it, without logs, node_modules and earlier backups.';
      risk = 'medium';
    } else if (/buscar|modificad|hoje|24h|recent|modified|today|changed/.test(q)) {
      command = 'find . -type f -mtime -1 -ls 2>/dev/null | head -n 500';
      explanation = isPt
        ? 'Lista os arquivos desta pasta (e subpastas) modificados nas últimas 24 horas.'
        : 'Lists files in this folder (and subfolders) modified in the last 24 hours.';
    } else {
      command = 'ls -la';
      explanation = isPt
        ? 'Lista os itens da pasta atual com permissões, dono, tamanho e datas.'
        : 'Lists the items of the current folder with permissions, owner, size and dates.';
    }

    setGeneratedCommand({ command: commandInDir(currentPath, command), explanation, risk });
    setCopiedCmd(false);
    setCmdResult(null);
  };

  const executeGeneratedCmd = async () => {
    if (!generatedCommand || !onExecuteRemoteCommand || isExecutingCmd) return;
    const id = ++cmdRunId.current;
    setIsExecutingCmd(true);
    setCmdResult(null);
    try {
      const res = await onExecuteRemoteCommand(generatedCommand.command);
      if (id === cmdRunId.current) setCmdResult({ stdout: res.stdout || '', stderr: res.stderr || '', exitCode: res.exit_code });
    } catch (err) {
      if (id === cmdRunId.current) setCmdResult({ stdout: '', stderr: String(err), exitCode: -1 });
    } finally {
      if (id === cmdRunId.current) setIsExecutingCmd(false);
    }
  };

  const riskBadge = (risk: Risk) => {
    const map: Record<Risk, { text: string; cls: string }> = {
      safe: { text: isPt ? 'Somente leitura' : 'Read-only', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
      medium: { text: isPt ? 'Altera o servidor' : 'Changes the server', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
      high: { text: isPt ? 'Destrutivo' : 'Destructive', cls: 'bg-red-500/10 text-red-700 dark:text-red-400' },
    };
    const b = map[risk];
    return <span className={`inline-flex items-center h-5 px-1.5 rounded-md text-[11px] font-medium ${b.cls}`}>{b.text}</span>;
  };

  // ------------------------------------------------------------------ permissions
  const handleFixPermissions = async () => {
    setConfirmFix(false);
    const items = selectedIssues;
    if (items.length === 0) return;
    setIsFixingPermissions(true);
    setAuditFeedback(null);
    let fixed = 0;
    const errors: string[] = [];
    for (const issue of items) {
      try {
        await invoke('change_permissions', { sessionId: activeSessionId, path: pathOf(issue.item), mode: issue.newMode });
        fixed++;
      } catch (err) {
        errors.push(`${issue.item.name}: ${String(err)}`);
      }
    }
    setIsFixingPermissions(false);
    if (errors.length > 0) {
      setAuditFeedback({
        kind: 'error',
        text: isPt
          ? `${fixed} de ${items.length} corrigido(s). Falhas:\n${errors.join('\n')}`
          : `Fixed ${fixed} of ${items.length}. Failed:\n${errors.join('\n')}`,
      });
    } else {
      setAuditFeedback({ kind: 'success', text: isPt ? `Permissões ajustadas em ${fixed} item(ns).` : `Permissions updated on ${fixed} item(s).` });
    }
    if (fixed > 0) onRefreshFiles?.();
  };

  const issueKey = (i: AuditIssue) => pathOf(i.item);

  // ------------------------------------------------------------------ view
  const filterPills = isPt
    ? ['Arquivos > 5MB', 'Imagens (.png, .jpg)', 'Configurações (.env, .yaml)', 'Scripts (.sh, .py, .rs)', 'Compactados (.zip, .tar)', 'Apenas pastas']
    : ['Files > 5MB', 'Images (.png, .jpg)', 'Config (.env, .yaml)', 'Scripts (.sh, .py, .rs)', 'Archives (.zip, .tar)', 'Folders only'];

  const cmdPills = isPt
    ? ['Maiores pastas no disco', 'Portas abertas', 'Uso de memória e CPU', 'Recarregar Nginx com teste', 'Compactar pasta atual (backup)', 'Arquivos modificados hoje']
    : ['Largest folders on disk', 'Open ports', 'Memory and CPU usage', 'Reload Nginx after a test', 'Compress current folder (backup)', 'Files modified today'];

  const pillClass =
    'h-7 px-2.5 rounded-md border border-line bg-surface-raised hover:bg-dark-650/60 text-[12px] text-ink-muted hover:text-ink transition-colors';

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="xl"
        className="h-[min(760px,calc(100vh-2rem))]"
        icon={<Sparkles className="w-5 h-5" />}
        title={isPt ? 'Assistente' : 'Assistant'}
        subtitle={
          <span>
            {activeSessionName} · <span className="font-mono text-[12px]">{currentPath || '/'}</span>
          </span>
        }
        footer={
          <>
            <span className="mr-auto text-[12px] text-ink-faint">
              {isPt ? 'Ferramentas baseadas em regras, sem envio de dados.' : 'Rule-based tools; nothing is sent anywhere.'}
            </span>
            <Button variant="secondary" onClick={onClose}>
              {isPt ? 'Fechar' : 'Close'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Segmented
            value={activeTab}
            onChange={setActiveTab}
            className="w-full"
            ariaLabel={isPt ? 'Ferramenta' : 'Tool'}
            options={[
              { value: 'nl_filter', label: isPt ? 'Filtrar' : 'Filter' },
              { value: 'batch_rename', label: isPt ? 'Renomear' : 'Rename' },
              { value: 'explainer', label: isPt ? 'Explicar' : 'Explain' },
              { value: 'cmd_generator', label: isPt ? 'Comandos' : 'Commands' },
              {
                value: 'security_audit',
                label: (
                  <>
                    {isPt ? 'Segurança' : 'Security'}
                    {report.critCount > 0 && (
                      <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500/15 text-red-700 dark:text-red-300 text-[10.5px] tabular-nums">
                        {report.critCount}
                      </span>
                    )}
                  </>
                ),
              },
            ]}
          />

          {/* Filter */}
          {activeTab === 'nl_filter' && (
            <div className="space-y-3">
              <Field label={isPt ? 'Descreva o que procura nesta pasta' : 'Describe what you are looking for in this folder'}>
                {(id) => (
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <TextInput
                      id={id}
                      value={nlQuery}
                      onChange={(e) => setNlQuery(e.target.value)}
                      placeholder={isPt ? 'ex.: arquivos maiores que 5MB, imagens, .env' : 'e.g. files larger than 5MB, images, .env'}
                      className="pl-8 pr-8"
                    />
                    {nlQuery && (
                      <button
                        type="button"
                        aria-label={isPt ? 'Limpar' : 'Clear'}
                        onClick={() => setNlQuery('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {filterPills.map((sug) => (
                  <button key={sug} type="button" onClick={() => setNlQuery(sug)} className={pillClass}>
                    {sug}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-ink-muted">
                  {isPt
                    ? `${filteredFiles.length} de ${safeFiles.length} itens`
                    : `${filteredFiles.length} of ${safeFiles.length} items`}
                </span>
                {onApplyFilter && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Check className="w-3.5 h-3.5" />}
                    onClick={() => {
                      onApplyFilter(nlQuery);
                      onClose();
                    }}
                  >
                    {isPt ? 'Aplicar no painel' : 'Apply to pane'}
                  </Button>
                )}
              </div>
              <div className="ui-card max-h-72 overflow-y-auto divide-y divide-line">
                {filteredFiles.length === 0 && (
                  <p className="px-3 py-6 text-center text-[12px] text-ink-faint">{isPt ? 'Nenhum item corresponde.' : 'No items match.'}</p>
                )}
                {filteredFiles.slice(0, PREVIEW_ROWS * 5).map((file) => (
                  <div key={file.path || file.name} className="px-3 py-1.5 flex items-center gap-2">
                    {file.file_type === 'directory' ? (
                      <Folder className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                    ) : (
                      <File className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                    )}
                    <span className="flex-1 truncate text-[12.5px] text-ink">{file.name}</span>
                    <span className="text-[11.5px] text-ink-faint tabular-nums shrink-0">
                      {file.file_type === 'directory' ? (isPt ? 'Pasta' : 'Folder') : formatBytes(file.size || 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rename */}
          {activeTab === 'batch_rename' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label={isPt ? 'Transformação' : 'Transformation'}>
                  {(id) => (
                    <Select id={id} value={renamePattern} onChange={(e) => setRenamePattern(e.target.value as RenamePattern)}>
                      <option value="kebab">kebab-case ({isPt ? 'meu-arquivo.txt' : 'my-file.txt'})</option>
                      <option value="snake">snake_case ({isPt ? 'meu_arquivo.txt' : 'my_file.txt'})</option>
                      <option value="lower">{isPt ? 'minúsculas' : 'lowercase'}</option>
                      <option value="upper">{isPt ? 'MAIÚSCULAS' : 'UPPERCASE'}</option>
                      <option value="prefix">{isPt ? 'Adicionar prefixo' : 'Add prefix'}</option>
                      <option value="suffix">{isPt ? 'Adicionar sufixo' : 'Add suffix'}</option>
                      <option value="replace">{isPt ? 'Localizar e substituir' : 'Find and replace'}</option>
                    </Select>
                  )}
                </Field>
                {renamePattern === 'prefix' && (
                  <Field label={isPt ? 'Prefixo' : 'Prefix'}>
                    {(id) => <TextInput id={id} mono value={renamePrefix} onChange={(e) => setRenamePrefix(e.target.value)} placeholder="backup_" />}
                  </Field>
                )}
                {renamePattern === 'suffix' && (
                  <Field label={isPt ? 'Sufixo (antes da extensão)' : 'Suffix (before the extension)'}>
                    {(id) => <TextInput id={id} mono value={renameSuffix} onChange={(e) => setRenameSuffix(e.target.value)} placeholder="_v2" />}
                  </Field>
                )}
                {renamePattern === 'replace' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={isPt ? 'Localizar' : 'Find'}>
                      {(id) => <TextInput id={id} mono value={findText} onChange={(e) => setFindText(e.target.value)} />}
                    </Field>
                    <Field label={isPt ? 'Substituir por' : 'Replace with'}>
                      {(id) => <TextInput id={id} mono value={replaceWith} onChange={(e) => setReplaceWith(e.target.value)} />}
                    </Field>
                  </div>
                )}
              </div>

              <FeedbackBanner feedback={renameFeedback} />

              <div className="flex items-center justify-between gap-3">
                <div className="text-[12px] text-ink-muted">
                  {isPt
                    ? `${plan.changedCount} de ${plan.rows.length} arquivo(s) serão renomeados`
                    : `${plan.changedCount} of ${plan.rows.length} file(s) will be renamed`}
                  {plan.problemCount > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      {' · '}
                      {isPt ? `${plan.problemCount} conflito(s)` : `${plan.problemCount} conflict(s)`}
                    </span>
                  )}
                  {renameProgress && (
                    <span>
                      {' · '}
                      {isPt ? `Renomeando ${renameProgress.done}/${renameProgress.total}…` : `Renaming ${renameProgress.done}/${renameProgress.total}…`}
                    </span>
                  )}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setConfirmRename(true)}
                  disabled={isRenaming || plan.ordered.length === 0 || plan.problemCount > 0}
                  loading={isRenaming}
                  icon={<Play className="w-3.5 h-3.5" />}
                >
                  {isPt ? `Renomear ${plan.ordered.length || ''}`.trim() : `Rename ${plan.ordered.length || ''}`.trim()}
                </Button>
              </div>
              {plan.problemCount > 0 && (
                <p className="text-[12px] text-red-600 dark:text-red-400">
                  {isPt ? 'Resolva os conflitos (em vermelho) antes de renomear.' : 'Resolve the conflicts (in red) before renaming.'}
                </p>
              )}

              <div className="ui-card max-h-72 overflow-y-auto divide-y divide-line font-mono text-[12px]">
                {plan.rows.length === 0 && (
                  <p className="px-3 py-6 text-center font-sans text-ink-faint">{isPt ? 'Nenhum arquivo nesta pasta.' : 'No files in this folder.'}</p>
                )}
                {previewRows.map((p) => (
                  <div key={p.file.path || p.original} className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 truncate text-ink-muted" title={p.original}>
                        {p.original}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                      <span
                        className={`flex-1 min-w-0 truncate ${
                          p.problem ? 'text-red-600 dark:text-red-400' : p.changed ? 'text-ink font-medium' : 'text-ink-faint'
                        }`}
                        title={p.newName}
                      >
                        {p.newName}
                      </span>
                    </div>
                    {p.problem && <div className="font-sans text-[11.5px] text-red-600 dark:text-red-400">{renameProblemText(p.problem, isPt)}</div>}
                  </div>
                ))}
                {plan.rows.length > previewRows.length && (
                  <p className="px-3 py-1.5 font-sans text-[11.5px] text-ink-faint">
                    {isPt ? `… e mais ${plan.rows.length - previewRows.length}` : `… and ${plan.rows.length - previewRows.length} more`}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Explain */}
          {activeTab === 'explainer' && (
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <Field className="flex-1" label={isPt ? 'Item' : 'Item'}>
                  {(id) => (
                    <Select
                      id={id}
                      value={selectedFileForExplain}
                      onChange={(e) => {
                        setSelectedFileForExplain(e.target.value);
                        setExplainedName(null);
                      }}
                    >
                      {safeFiles.length === 0 && <option value="">{isPt ? '(nenhum item)' : '(no items)'}</option>}
                      {safeFiles.map((f) => (
                        <option key={f.path || f.name} value={f.name}>
                          {f.file_type === 'directory' ? `${f.name}/` : f.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button variant="primary" onClick={() => setExplainedName(selectedFileForExplain)} disabled={!selectedFileForExplain}>
                  {isPt ? 'Explicar tipo' : 'Explain type'}
                </Button>
              </div>
              <p className="text-[12px] text-ink-faint">
                {isPt
                  ? 'A explicação vem de regras pelo nome e extensão; o conteúdo do arquivo não é lido.'
                  : 'The explanation comes from rules based on the name and extension; the file content is not read.'}
              </p>
              {fileExplanation && (
                <div className="ui-card p-4 space-y-3">
                  <div className="text-[13px] font-semibold text-ink">{fileExplanation.type}</div>
                  <div>
                    <div className="text-[12px] font-medium text-ink-faint mb-0.5">{isPt ? 'Para que serve' : 'What it is for'}</div>
                    <p className="text-[13px] text-ink-muted leading-relaxed">{fileExplanation.summary}</p>
                  </div>
                  <div className="rounded-lg bg-amber-500/10 px-3 py-2">
                    <div className="text-[12px] font-medium text-amber-800 dark:text-amber-300 mb-0.5">
                      {isPt ? 'Cuidados e boas práticas' : 'Care and good practice'}
                    </div>
                    <p className="text-[12.5px] text-ink-muted leading-relaxed">{fileExplanation.bestPractices}</p>
                  </div>
                  {fileExplanation.details && <p className="text-[12px] text-ink-faint">{fileExplanation.details}</p>}
                </div>
              )}
            </div>
          )}

          {/* Commands */}
          {activeTab === 'cmd_generator' && (
            <div className="space-y-3">
              <Field label={isPt ? 'O que você quer ver ou fazer no servidor?' : 'What do you want to check or do on the server?'}>
                {(id) => (
                  <div className="flex gap-2">
                    <TextInput
                      id={id}
                      value={cmdQuery}
                      onChange={(e) => setCmdQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleGenerateCommand(cmdQuery)}
                      placeholder={isPt ? 'ex.: pastas que ocupam mais espaço, portas abertas' : 'e.g. folders using the most space, open ports'}
                    />
                    <Button variant="primary" onClick={() => handleGenerateCommand(cmdQuery)}>
                      {isPt ? 'Sugerir' : 'Suggest'}
                    </Button>
                  </div>
                )}
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {cmdPills.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={pillClass}
                    onClick={() => {
                      setCmdQuery(s);
                      handleGenerateCommand(s);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>

              {generatedCommand && (
                <div className="ui-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-ink-faint">{isPt ? 'Comando sugerido' : 'Suggested command'}</span>
                    <div className="flex items-center gap-1.5">
                      {riskBadge(generatedCommand.risk)}
                      <IconButton
                        size="sm"
                        label={isPt ? 'Copiar comando' : 'Copy command'}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(generatedCommand.command);
                            setCopiedCmd(true);
                            setTimeout(() => setCopiedCmd(false), 1500);
                          } catch {
                            /* clipboard unavailable */
                          }
                        }}
                      >
                        {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </IconButton>
                    </div>
                  </div>
                  <pre className="rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-[12px] text-ink whitespace-pre-wrap break-all select-text">
                    {generatedCommand.command}
                  </pre>
                  <p className="text-[12.5px] text-ink-muted leading-relaxed">{generatedCommand.explanation}</p>
                  {isRemote && onExecuteRemoteCommand && (
                    <div className="flex justify-end">
                      <Button
                        variant="primary"
                        size="sm"
                        loading={isExecutingCmd}
                        icon={<Play className="w-3.5 h-3.5" />}
                        onClick={() => (generatedCommand.risk === 'safe' ? void executeGeneratedCmd() : setConfirmCmd(true))}
                      >
                        {isPt ? `Executar em ${activeSessionName}` : `Run on ${activeSessionName}`}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {(cmdResult || isExecutingCmd) && <CommandOutput result={cmdResult} running={isExecutingCmd} isPt={isPt} onClear={() => setCmdResult(null)} />}
            </div>
          )}

          {/* Security */}
          {activeTab === 'security_audit' && (
            <div className="space-y-3">
              <div className="ui-card p-4 flex items-center gap-4">
                <div
                  className={`w-12 h-12 rounded-xl flex items-center justify-center text-[17px] font-semibold tabular-nums ${
                    report.score >= 80
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : report.score >= 50
                        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'bg-red-500/10 text-red-700 dark:text-red-400'
                  }`}
                >
                  {report.score}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-ink">{isPt ? 'Pontuação de segurança da pasta' : 'Folder security score'}</div>
                  <p className="text-[12px] text-ink-muted">
                    {isPt
                      ? `${report.critCount} problema(s) crítico(s), ${report.warnCount} alerta(s). Links simbólicos não são verificados.`
                      : `${report.critCount} critical issue(s), ${report.warnCount} warning(s). Symbolic links are not checked.`}
                  </p>
                </div>
                {report.issues.length > 0 && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setConfirmFix(true)}
                    disabled={isFixingPermissions || selectedIssues.length === 0}
                    loading={isFixingPermissions}
                  >
                    {isPt ? `Corrigir selecionados (${selectedIssues.length})` : `Fix selected (${selectedIssues.length})`}
                  </Button>
                )}
              </div>

              <FeedbackBanner feedback={auditFeedback} />

              {report.issues.length === 0 ? (
                <div className="ui-card p-6 text-center space-y-1.5">
                  <ShieldCheck className="w-7 h-7 text-emerald-600 dark:text-emerald-400 mx-auto" />
                  <p className="text-[13px] font-medium text-ink">{isPt ? 'Nenhum problema encontrado' : 'No issues found'}</p>
                  <p className="text-[12px] text-ink-faint">
                    {isPt
                      ? 'Nenhum item gravável por todos ou segredo exposto nesta pasta.'
                      : 'No world-writable items or exposed secrets in this folder.'}
                  </p>
                </div>
              ) : (
                <div className="ui-card max-h-80 overflow-y-auto divide-y divide-line">
                  {report.issues.map((issue) => {
                    const key = issueKey(issue);
                    const checked = !!fixSelection[key];
                    return (
                      <label key={key} className="flex items-start gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-dark-650/40">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-rust-500"
                          checked={checked}
                          onChange={(e) => setFixSelection((prev) => ({ ...prev, [key]: e.target.checked }))}
                        />
                        <div className="flex-1 min-w-0 space-y-0.5">
                          {issue.reasons.map((r, idx) => (
                            <div key={idx}>
                              <div
                                className={`text-[12.5px] font-medium ${
                                  r.severity === 'critical'
                                    ? 'text-red-700 dark:text-red-400'
                                    : r.severity === 'warning'
                                      ? 'text-amber-700 dark:text-amber-400'
                                      : 'text-ink'
                                }`}
                              >
                                {r.title}
                              </div>
                              <p className="text-[12px] text-ink-muted leading-snug">{r.description}</p>
                            </div>
                          ))}
                          <div className="font-mono text-[11.5px] text-ink-faint truncate" title={pathOf(issue.item)}>
                            {pathOf(issue.item)}
                          </div>
                        </div>
                        <span className="font-mono text-[11.5px] text-ink-muted whitespace-nowrap shrink-0">
                          {formatMode(issue.currentMode)} → {formatMode(issue.newMode)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <AutomationConfirm
        isOpen={confirmRename}
        tone="primary"
        title={isPt ? `Renomear ${plan.ordered.length} arquivo(s)?` : `Rename ${plan.ordered.length} file(s)?`}
        message={isPt ? 'Os arquivos abaixo serão renomeados nesta pasta.' : 'The files below will be renamed in this folder.'}
        target={runTarget}
        confirmLabel={isPt ? 'Renomear' : 'Rename'}
        cancelLabel={isPt ? 'Cancelar' : 'Cancel'}
        onCancel={() => setConfirmRename(false)}
        onConfirm={handleExecuteBatchRename}
      >
        <div className="max-h-48 overflow-y-auto rounded-lg border border-line divide-y divide-line font-mono text-[12px]">
          {plan.ordered.slice(0, 12).map((r) => (
            <div key={r.file.path || r.original} className="px-3 py-1 truncate">
              <span className="text-ink-muted">{r.original}</span> <span className="text-ink-faint">→</span> <span className="text-ink">{r.newName}</span>
            </div>
          ))}
          {plan.ordered.length > 12 && (
            <div className="px-3 py-1 font-sans text-ink-faint">{isPt ? `… e mais ${plan.ordered.length - 12}` : `… and ${plan.ordered.length - 12} more`}</div>
          )}
        </div>
      </AutomationConfirm>

      <AutomationConfirm
        isOpen={confirmFix}
        tone="primary"
        title={isPt ? `Alterar permissões de ${selectedIssues.length} item(ns)?` : `Change permissions of ${selectedIssues.length} item(s)?`}
        message={
          isPt
            ? 'Somente os bits arriscados são removidos; bits especiais (setgid, sticky) são mantidos. Nada é alterado recursivamente.'
            : 'Only the risky bits are removed; special bits (setgid, sticky) are kept. Nothing is changed recursively.'
        }
        target={runTarget}
        confirmLabel={isPt ? 'Alterar permissões' : 'Change permissions'}
        cancelLabel={isPt ? 'Cancelar' : 'Cancel'}
        onCancel={() => setConfirmFix(false)}
        onConfirm={handleFixPermissions}
      >
        <div className="max-h-48 overflow-y-auto rounded-lg border border-line divide-y divide-line font-mono text-[12px]">
          {selectedIssues.map((i) => (
            <div key={issueKey(i)} className="px-3 py-1 flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-ink">{i.item.name}</span>
              <span className="text-ink-muted shrink-0">
                {formatMode(i.currentMode)} → {formatMode(i.newMode)}
              </span>
            </div>
          ))}
        </div>
      </AutomationConfirm>

      <AutomationConfirm
        isOpen={confirmCmd && !!generatedCommand}
        tone={generatedCommand?.risk === 'high' ? 'danger' : 'primary'}
        title={isPt ? 'Executar este comando?' : 'Run this command?'}
        message={isPt ? 'Este comando altera o servidor.' : 'This command changes the server.'}
        target={runTarget}
        command={generatedCommand?.command}
        confirmLabel={isPt ? 'Executar' : 'Run'}
        cancelLabel={isPt ? 'Cancelar' : 'Cancel'}
        onCancel={() => setConfirmCmd(false)}
        onConfirm={() => {
          setConfirmCmd(false);
          void executeGeneratedCmd();
        }}
      />
    </>
  );
};
