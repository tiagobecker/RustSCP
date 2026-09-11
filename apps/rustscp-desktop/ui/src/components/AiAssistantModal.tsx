import React, { useState, useMemo, useEffect } from 'react';
import {
  Sparkles,
  Search,
  FileText,
  Terminal,
  ShieldCheck,
  ShieldAlert,
  Check,
  Copy,
  Play,
  ArrowRight,
  RefreshCw,
  AlertTriangle,
  X,
  FileCode,
  CheckCircle2,
  Lock,
  Zap,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { FileEntry } from '../types';

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
  const safeFiles = useMemo(() => (Array.isArray(files) ? files.filter((f) => Boolean(f && f.name)) : []), [files]);

  const [activeTab, setActiveTab] = useState<TabType>('nl_filter');

  // --- TAB 1: Natural Language Filter States ---
  const [nlQuery, setNlQuery] = useState('');

  // --- TAB 2: Batch Renamer States ---
  const [renamePattern, setRenamePattern] = useState<'kebab' | 'snake' | 'lower' | 'upper' | 'prefix' | 'suffix' | 'replace'>('kebab');
  const [renamePrefix, setRenamePrefix] = useState('backup_');
  const [renameSuffix, setRenameSuffix] = useState('_v2');
  const [findText, setFindText] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameSuccess, setRenameSuccess] = useState<string | null>(null);

  // --- TAB 3: File Explainer States ---
  const [selectedFileForExplain, setSelectedFileForExplain] = useState<string>('');

  useEffect(() => {
    if (!selectedFileForExplain && safeFiles.length > 0) {
      const firstFile = safeFiles.find((f) => f && f.file_type !== 'directory');
      if (firstFile) {
        setSelectedFileForExplain(firstFile.name);
      }
    }
  }, [safeFiles, selectedFileForExplain]);

  const [fileExplanation, setFileExplanation] = useState<{
    summary: string;
    type: string;
    bestPractices: string;
    details: string;
  } | null>(null);
  const [isExplaining, setIsExplaining] = useState(false);

  // --- TAB 4: Command Generator States ---
  const [cmdQuery, setCmdQuery] = useState('');
  const [generatedCommand, setGeneratedCommand] = useState<{
    command: string;
    explanation: string;
    risk: 'safe' | 'medium' | 'high';
  } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [cmdExecutionOutput, setCmdExecutionOutput] = useState<{ stdout: string; stderr: string; code: number } | null>(null);
  const [isExecutingCmd, setIsExecutingCmd] = useState(false);

  // --- TAB 5: Security Auditor States ---
  const [isFixingPermissions, setIsFixingPermissions] = useState(false);
  const [auditSuccessMsg, setAuditSuccessMsg] = useState<string | null>(null);

  // --- Helper: Filtered Files by NL Query ---
  const filteredFiles = useMemo(() => {
    if (!nlQuery.trim()) return safeFiles;
    const q = nlQuery.toLowerCase().trim();

    return safeFiles.filter((f) => {
      const name = f.name.toLowerCase();
      const ext = name.split('.').pop() || '';

      if (name.includes(q)) return true;

      if ((q.includes('pasta') || q.includes('diretorio') || q.includes('folder') || q.includes('dir')) && f.file_type === 'directory') return true;
      if ((q.includes('arquivo') || q.includes('file')) && f.file_type !== 'directory') {
        if (!q.includes('zip') && !q.includes('imagem') && !q.includes('maior')) {
          return true;
        }
      }

      if (q.includes('imagem') || q.includes('foto') || q.includes('image') || q.includes('picture')) {
        return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext);
      }

      if (q.includes('zip') || q.includes('compactad') || q.includes('tar') || q.includes('archive')) {
        return ['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'].includes(ext);
      }

      if (q.includes('config') || q.includes('env') || q.includes('json') || q.includes('yaml')) {
        return ['env', 'json', 'yaml', 'yml', 'conf', 'config', 'ini', 'toml', 'xml'].includes(ext) || name.startsWith('.env');
      }

      if (q.includes('código') || q.includes('script') || q.includes('code')) {
        return ['rs', 'go', 'py', 'js', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'php', 'rb', 'html', 'css'].includes(ext);
      }

      if (q.includes('maior') || q.includes('grande') || q.includes('>')) {
        const mbMatch = q.match(/(\d+)\s*(?:mb|mega)/);
        const kbMatch = q.match(/(\d+)\s*(?:kb|kilo)/);
        if (mbMatch) {
          const minBytes = parseInt(mbMatch[1], 10) * 1024 * 1024;
          return (f.size || 0) >= minBytes;
        }
        if (kbMatch) {
          const minBytes = parseInt(kbMatch[1], 10) * 1024;
          return (f.size || 0) >= minBytes;
        }
        return (f.size || 0) > 5 * 1024 * 1024;
      }

      if (ext === q.replace('.', '')) return true;

      return false;
    });
  }, [safeFiles, nlQuery]);

  // --- Helper: Batch Rename Previews ---
  const renamePreviews = useMemo(() => {
    return safeFiles
      .filter((f) => f.file_type !== 'directory')
      .slice(0, 30)
      .map((f) => {
        let newName = f.name;
        const lastDot = f.name.lastIndexOf('.');
        const baseName = lastDot > 0 ? f.name.substring(0, lastDot) : f.name;
        const ext = lastDot > 0 ? f.name.substring(lastDot) : '';

        switch (renamePattern) {
          case 'kebab':
            newName = `${baseName.toLowerCase().replace(/[\s_]+/g, '-')}${ext.toLowerCase()}`;
            break;
          case 'snake':
            newName = `${baseName.toLowerCase().replace(/[\s-]+/g, '_')}${ext.toLowerCase()}`;
            break;
          case 'lower':
            newName = `${baseName.toLowerCase()}${ext.toLowerCase()}`;
            break;
          case 'upper':
            newName = `${baseName.toUpperCase()}${ext.toUpperCase()}`;
            break;
          case 'prefix':
            newName = `${renamePrefix}${f.name}`;
            break;
          case 'suffix':
            newName = `${baseName}${renameSuffix}${ext}`;
            break;
          case 'replace':
            if (findText) {
              newName = f.name.split(findText).join(replaceWith);
            }
            break;
        }

        return {
          original: f.name,
          newName,
          changed: newName !== f.name,
        };
      });
  }, [safeFiles, renamePattern, renamePrefix, renameSuffix, findText, replaceWith]);

  // --- Execute Batch Rename ---
  const handleExecuteBatchRename = async () => {
    const toRename = renamePreviews.filter((p) => p.changed);
    if (toRename.length === 0) return;

    setIsRenaming(true);
    setRenameSuccess(null);
    let count = 0;

    try {
      for (const item of toRename) {
        const separator = currentPath.endsWith('/') ? '' : '/';
        const oldPath = `${currentPath}${separator}${item.original}`;
        const newPath = `${currentPath}${separator}${item.newName}`;

        await invoke('rename_file', {
          sessionId: activeSessionId,
          oldPath,
          newPath,
        });
        count++;
      }
      setRenameSuccess(`Sucesso! ${count} arquivo(s) foram renomeados.`);
      if (onRefreshFiles) onRefreshFiles();
    } catch (err: any) {
      setRenameSuccess(`Erro durante renomeação: ${err}`);
    } finally {
      setIsRenaming(false);
    }
  };

  // --- Explain File Logic ---
  const handleExplainFile = async () => {
    if (!selectedFileForExplain) return;
    setIsExplaining(true);
    setFileExplanation(null);

    const f = safeFiles.find((file) => file.name === selectedFileForExplain);
    const ext = selectedFileForExplain.split('.').pop()?.toLowerCase() || '';

    let summary = '';
    let type = '';
    let bestPractices = '';
    let details = '';

    if (selectedFileForExplain === '.env' || selectedFileForExplain.startsWith('.env.')) {
      type = 'Arquivo de Configuração de Ambiente / Segredos';
      summary = 'Armazena chaves de API, senhas de banco de dados, portas e variáveis de ambiente secretas da aplicação.';
      bestPractices = 'CRÍTICO: Nunca comite no Git (adicione ao .gitignore). Assegure permissões restritas (chmod 600) para evitar que outros usuários do servidor leiam suas credenciais.';
      details = `Tamanho: ${f?.size || 0} bytes. Formato CHAVE=VALOR.`;
    } else if (ext === 'conf' || ext === 'cfg' || selectedFileForExplain.includes('nginx')) {
      type = 'Arquivo de Configuração de Servidor / Daemon';
      summary = 'Define diretivas de roteamento reverso, certificados SSL, portas de escuta HTTP/HTTPS e limites de buffer do servidor web.';
      bestPractices = 'Sempre valide a sintaxe (ex: "nginx -t") antes de recarregar o daemon para evitar queda de produção.';
      details = 'Geralmente lido pelo processo pai como root, mas executado sob usuário restrito (ex: www-data ou nobody).';
    } else if (ext === 'json') {
      type = 'Documento Estruturado JSON (JavaScript Object Notation)';
      summary = 'Utilizado para configurações de projeto (package.json, tsconfig.json) ou intercâmbio de dados entre APIs.';
      bestPractices = 'Evite comentários inline (não suportados por padrão na spec JSON). Use formatador para manter indentação limpa.';
      details = `Tamanho: ${f?.size || 0} bytes. Permissões recomendadas: 644.`;
    } else if (ext === 'yaml' || ext === 'yml') {
      type = 'Configuração YAML (Docker Compose, CI/CD, Kubernetes)';
      summary = 'Arquivo de configuração legível por humanos baseado em indentação estrita por espaços.';
      bestPractices = 'Cuidado com caracteres de tabulação (proibidos no YAML). Verifique o alinhamento de 2 espaços por nível.';
      details = 'Muito comum para pipelines GitHub Actions, definições Docker Compose e orquestração.';
    } else if (['sh', 'bash', 'zsh'].includes(ext)) {
      type = 'Script Shell / Automação Unix';
      summary = 'Script executável contendo comandos sequenciais para compilação, backup, implantação ou tarefas agendadas (Cron).';
      bestPractices = 'Inicie com `#!/usr/bin/env bash` e `set -euo pipefail` para interromper a execução imediatamente em caso de erro.';
      details = `Permissões necessárias: Requer bit de execução (chmod +x ou 755).`;
    } else if (['log', 'out'].includes(ext)) {
      type = 'Arquivo de Registro de Eventos (Log)';
      summary = 'Contém histórico cronológico de requisições, erros, alertas e rastreamentos de pilha da aplicação.';
      bestPractices = 'Configure rotação de logs (logrotate) para evitar consumo excessivo de disco.';
      details = 'Geralmente seguro para leitura e truncamento se o serviço estiver configurado para escrita contínua.';
    } else {
      type = `Arquivo com extensão .${ext.toUpperCase() || 'genérico'}`;
      summary = `Arquivo localizado no caminho ${currentPath}/${selectedFileForExplain}.`;
      bestPractices = 'Mantenha permissões de leitura seguras (644 para arquivos normais) e faça backup regular antes de editar.';
      details = `Tamanho: ${f?.size || 0} bytes.`;
    }

    setTimeout(() => {
      setFileExplanation({ summary, type, bestPractices, details });
      setIsExplaining(false);
    }, 300);
  };

  // --- Command Generator Logic ---
  const handleGenerateCommand = (queryText: string) => {
    const q = queryText.toLowerCase();
    let command = '';
    let explanation = '';
    let risk: 'safe' | 'medium' | 'high' = 'safe';

    if (q.includes('espaço') || q.includes('disco') || q.includes('tamanho')) {
      command = 'df -h && echo "--- Maiores diretórios ---" && du -sh * 2>/dev/null | sort -hr | head -n 10';
      explanation = 'Exibe o espaço total, usado e disponível em todas as partições do sistema (-h legível em GB/MB) e lista os 10 maiores itens na pasta atual.';
      risk = 'safe';
    } else if (q.includes('porta') || q.includes('aberta') || q.includes('conex')) {
      command = 'ss -tulpn | grep LISTEN';
      explanation = 'Lista todas as portas TCP e UDP abertas ouvindo conexões, com o nome do processo e PID associado.';
      risk = 'safe';
    } else if (q.includes('memoria') || q.includes('ram') || q.includes('cpu')) {
      command = 'free -m && echo "--- Top Processos CPU/RAM ---" && ps aux --sort=-%mem | head -n 10';
      explanation = 'Exibe uso de memória RAM e Swap em Megabytes e os 10 processos que mais consomem memória no sistema.';
      risk = 'safe';
    } else if (q.includes('nginx') && (q.includes('reini') || q.includes('reload'))) {
      command = 'nginx -t && systemctl reload nginx';
      explanation = 'Primeiro testa rigorosamente a sintaxe dos arquivos de configuração do Nginx. Somente se o teste passar sem erros (0), recarrega a configuração sem derrubar conexões ativas.';
      risk = 'medium';
    } else if (q.includes('compactar') || q.includes('zip') || q.includes('backup')) {
      command = 'tar -czvf backup_$(date +%Y%m%d_%H%M%S).tar.gz --exclude="*.log" --exclude="node_modules" .';
      explanation = 'Cria um arquivo compactado tar.gz da pasta atual incluindo timestamp no nome, excluindo logs e node_modules para economia de tempo e espaço.';
      risk = 'safe';
    } else if (q.includes('buscar') || q.includes('modificado') || q.includes('24h')) {
      command = 'find . -type f -mtime -1 -ls';
      explanation = 'Localiza recursivamente todos os arquivos normais modificados nas últimas 24 horas (-mtime -1) com permissões, tamanho e data.';
      risk = 'safe';
    } else {
      command = `ls -la --color=auto ${currentPath}`;
      explanation = 'Lista todos os arquivos detalhados com permissões, proprietário, tamanho e timestamps de forma colorida.';
      risk = 'safe';
    }

    setGeneratedCommand({ command, explanation, risk });
    setCopiedCmd(false);
    setCmdExecutionOutput(null);
  };

  // --- Command Execution in Remote Terminal ---
  const handleExecuteGeneratedCmd = async () => {
    if (!generatedCommand || !onExecuteRemoteCommand) return;
    setIsExecutingCmd(true);
    setCmdExecutionOutput(null);

    try {
      const res = await onExecuteRemoteCommand(generatedCommand.command);
      setCmdExecutionOutput({
        stdout: res.stdout,
        stderr: res.stderr,
        code: res.exit_code,
      });
    } catch (err: any) {
      setCmdExecutionOutput({
        stdout: '',
        stderr: String(err),
        code: 1,
      });
    } finally {
      setIsExecutingCmd(false);
    }
  };

  // --- Security Audit Logic ---
  const securityReport = useMemo(() => {
    const issues: {
      severity: 'critical' | 'warning' | 'info';
      title: string;
      description: string;
      item: FileEntry;
      suggestedChmod: number;
    }[] = [];

    safeFiles.forEach((f) => {
      const mode = f.permissions?.mode || 0;
      const permOctal = mode ? (mode & 0o777).toString(8) : '';
      const name = f.name.toLowerCase();

      // Check 777 or world-writable
      if (mode && (mode & 0o002) !== 0) {
        issues.push({
          severity: 'critical',
          title: `Permissões Excessivas: Aberto para Escrita por Qualquer Usuário (${permOctal || '777'})`,
          description: `O item "${f.name}" permite escrita pública. Qualquer usuário local pode alterar ou injetar código malicioso.`,
          item: f,
          suggestedChmod: f.file_type === 'directory' ? 0o755 : 0o644,
        });
      }

      // Check sensitive credential files
      if (name === '.env' || name.startsWith('.env.') || name.includes('id_rsa') || name.includes('id_ed25519')) {
        if (mode && (mode & 0o077) !== 0) {
          issues.push({
            severity: 'critical',
            title: `Credencial / Chave Privada Exposta (${f.name})`,
            description: `Arquivos contendo segredos de produção devem ser restritos estritamente ao proprietário (600). Atual: ${permOctal}.`,
            item: f,
            suggestedChmod: 0o600,
          });
        }
      }

      // Check orphaned database dumps or backups
      if (name.endsWith('.sql') || name.endsWith('.bak') || name.endsWith('.old')) {
        issues.push({
          severity: 'warning',
          title: `Arquivo de Backup / Dump Público Encontrado (${f.name})`,
          description: `Backups em diretórios públicos podem ser baixados diretamente por scanners se o servidor web estiver mal configurado.`,
          item: f,
          suggestedChmod: 0o600,
        });
      }
    });

    let score = 100;
    const critCount = issues.filter((i) => i.severity === 'critical').length;
    const warnCount = issues.filter((i) => i.severity === 'warning').length;

    score = Math.max(0, 100 - critCount * 25 - warnCount * 10);

    return {
      score,
      issues,
      critCount,
      warnCount,
    };
  }, [safeFiles]);

  // --- Auto-Fix Permissions ---
  const handleAutoFixPermissions = async () => {
    if (securityReport.issues.length === 0) return;
    setIsFixingPermissions(true);
    setAuditSuccessMsg(null);

    let fixedCount = 0;
    try {
      for (const issue of securityReport.issues) {
        const separator = currentPath.endsWith('/') ? '' : '/';
        const fullPath = `${currentPath}${separator}${issue.item.name}`;

        await invoke('change_permissions', {
          sessionId: activeSessionId,
          path: fullPath,
          mode: issue.suggestedChmod,
        });
        fixedCount++;
      }
      setAuditSuccessMsg(`Segurança Fortalecida! ${fixedCount} itens foram corrigidos para permissões seguras (644/755/600).`);
      if (onRefreshFiles) onRefreshFiles();
    } catch (err: any) {
      setAuditSuccessMsg(`Erro ao aplicar permissões: ${err}`);
    } finally {
      setIsFixingPermissions(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-dark-900 border border-slate-300 dark:border-slate-700/80 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-tr from-sky-500/20 to-purple-500/20 text-sky-500 dark:text-sky-400 rounded-xl border border-sky-500/30 shadow-inner">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900 dark:text-white tracking-wide">Assistente de Inteligência RustSCP</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-500/20 text-sky-700 dark:text-sky-300 border border-sky-500/30">
                  AI v2.0
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Operando em <span className="text-slate-800 dark:text-slate-200 font-mono">{activeSessionName}</span> ({currentPath})
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-1 px-6 pt-3 bg-slate-50 dark:bg-slate-950/30 border-b border-slate-200 dark:border-slate-800/80 overflow-x-auto text-xs font-medium">
          <button
            onClick={() => setActiveTab('nl_filter')}
            className={`flex items-center gap-2 px-3.5 py-2.5 border-b-2 transition-all ${
              activeTab === 'nl_filter'
                ? 'border-sky-500 text-sky-600 dark:text-sky-300 bg-sky-500/10 rounded-t-lg'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Search className="w-3.5 h-3.5" />
            <span>Filtro em Linguagem Natural</span>
          </button>

          <button
            onClick={() => setActiveTab('batch_rename')}
            className={`flex items-center gap-2 px-3.5 py-2.5 border-b-2 transition-all ${
              activeTab === 'batch_rename'
                ? 'border-sky-500 text-sky-600 dark:text-sky-300 bg-sky-500/10 rounded-t-lg'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Renomeador em Lote Inteligente</span>
          </button>

          <button
            onClick={() => setActiveTab('explainer')}
            className={`flex items-center gap-2 px-3.5 py-2.5 border-b-2 transition-all ${
              activeTab === 'explainer'
                ? 'border-sky-500 text-sky-600 dark:text-sky-300 bg-sky-500/10 rounded-t-lg'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Explicador de Arquivos & Código</span>
          </button>

          <button
            onClick={() => setActiveTab('cmd_generator')}
            className={`flex items-center gap-2 px-3.5 py-2.5 border-b-2 transition-all ${
              activeTab === 'cmd_generator'
                ? 'border-sky-500 text-sky-600 dark:text-sky-300 bg-sky-500/10 rounded-t-lg'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Gerador de Comandos Bash</span>
          </button>

          <button
            onClick={() => setActiveTab('security_audit')}
            className={`flex items-center gap-2 px-3.5 py-2.5 border-b-2 transition-all ${
              activeTab === 'security_audit'
                ? 'border-sky-500 text-sky-600 dark:text-sky-300 bg-sky-500/10 rounded-t-lg'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Auditor de Segurança</span>
            {securityReport.critCount > 0 && (
              <span className="px-1.5 py-0.2 bg-red-500/30 text-red-600 dark:text-red-300 rounded-full text-[10px]">
                {securityReport.critCount}
              </span>
            )}
          </button>
        </div>

        {/* Tab Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-white dark:bg-dark-900">
          {/* TAB 1: Natural Language Filter */}
          {activeTab === 'nl_filter' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Descreva o que procura no diretório atual em português claro:
                </label>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    value={nlQuery}
                    onChange={(e) => setNlQuery(e.target.value)}
                    placeholder="Ex: arquivos maiores que 5MB, fotos png, configs .env ou .yaml..."
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 shadow-sm"
                  />
                  {nlQuery && (
                    <button
                      onClick={() => setNlQuery('')}
                      className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Quick Pills */}
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="text-slate-500 self-center">Sugestões:</span>
                {[
                  'Arquivos > 5MB',
                  'Imagens (.png, .jpg)',
                  'Configurações (.env, .yaml)',
                  'Scripts (.sh, .py, .rs)',
                  'Compactados (.zip, .tar)',
                  'Apenas Pastas',
                ].map((sug) => (
                  <button
                    key={sug}
                    onClick={() => setNlQuery(sug)}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-slate-900 dark:bg-slate-800/80 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg dark:text-slate-300 dark:hover:text-white transition-colors shadow-sm"
                  >
                    {sug}
                  </button>
                ))}
              </div>

              {/* Filter Results Summary */}
              <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Encontrados <strong className="text-sky-600 dark:text-sky-400">{filteredFiles.length}</strong> de{' '}
                  <strong className="text-slate-700 dark:text-slate-300">{safeFiles.length}</strong> itens
                </span>
                {onApplyFilter && (
                  <button
                    onClick={() => {
                      onApplyFilter(nlQuery);
                      onClose();
                    }}
                    className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Aplicar Filtro no Painel Principal</span>
                  </button>
                )}
              </div>

              {/* File List Preview */}
              <div className="max-h-60 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/50 divide-y divide-slate-200 dark:divide-slate-800/60 font-mono text-xs shadow-sm">
                {filteredFiles.map((file) => (
                  <div key={file.name} className="px-3 py-2 flex items-center justify-between hover:bg-slate-100/60 dark:hover:bg-slate-900/60">
                    <div className="flex items-center gap-2 truncate">
                      <span className={file.file_type === 'directory' ? 'text-sky-500 dark:text-sky-400' : 'text-slate-600 dark:text-slate-300'}>
                        {file.file_type === 'directory' ? '📁' : '📄'}
                      </span>
                      <span className="text-slate-800 dark:text-slate-200 truncate">{file.name}</span>
                    </div>
                    <span className="text-slate-400 dark:text-slate-500 text-[11px] shrink-0">
                      {file.file_type === 'directory' ? 'Pasta' : `${(file.size / 1024).toFixed(1)} KB`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 2: Batch Renamer */}
          {activeTab === 'batch_rename' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 block">
                    Padrão de Transformação:
                  </label>
                  <select
                    value={renamePattern}
                    onChange={(e) => setRenamePattern(e.target.value as any)}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-sky-500 shadow-sm"
                  >
                    <option value="kebab">kebab-case (meu-arquivo.txt)</option>
                    <option value="snake">snake_case (meu_arquivo.txt)</option>
                    <option value="lower">minúsculas (lowercase)</option>
                    <option value="upper">MAIÚSCULAS (UPPERCASE)</option>
                    <option value="prefix">Adicionar Prefixo</option>
                    <option value="suffix">Adicionar Sufixo</option>
                    <option value="replace">Localizar e Substituir Texto</option>
                  </select>
                </div>

                {renamePattern === 'prefix' && (
                  <div>
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 block">Prefixo a Inserir:</label>
                    <input
                      type="text"
                      value={renamePrefix}
                      onChange={(e) => setRenamePrefix(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-sky-500 shadow-sm"
                      placeholder="backup_"
                    />
                  </div>
                )}

                {renamePattern === 'suffix' && (
                  <div>
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 block">Sufixo a Inserir:</label>
                    <input
                      type="text"
                      value={renameSuffix}
                      onChange={(e) => setRenameSuffix(e.target.value)}
                      className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-sky-500 shadow-sm"
                      placeholder="_v2"
                    />
                  </div>
                )}

                {renamePattern === 'replace' && (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 block">Localizar:</label>
                      <input
                        type="text"
                        value={findText}
                        onChange={(e) => setFindText(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-sky-500 shadow-sm"
                        placeholder="antigo"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 block">Substituir:</label>
                      <input
                        type="text"
                        value={replaceWith}
                        onChange={(e) => setReplaceWith(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-sky-500 shadow-sm"
                        placeholder="novo"
                      />
                    </div>
                  </div>
                )}
              </div>

              {renameSuccess && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>{renameSuccess}</span>
                </div>
              )}

              {/* Preview Table */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                  <span>Pré-visualização das Modificações ({renamePreviews.filter((p) => p.changed).length} a alterar)</span>
                  <button
                    onClick={handleExecuteBatchRename}
                    disabled={isRenaming || renamePreviews.filter((p) => p.changed).length === 0}
                    className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-lg font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                  >
                    {isRenaming ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    <span>Executar Renomeação em Lote</span>
                  </button>
                </div>

                <div className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/50 divide-y divide-slate-200 dark:divide-slate-800/60 font-mono text-xs shadow-sm">
                  {renamePreviews.map((p) => (
                    <div key={p.original} className="px-3 py-2 flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400 truncate max-w-[45%]">{p.original}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-slate-400 dark:text-slate-600 shrink-0 mx-2" />
                      <span className={`truncate max-w-[45%] ${p.changed ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-slate-400 dark:text-slate-500'}`}>
                        {p.newName}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Explainer */}
          {activeTab === 'explainer' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 block">
                    Selecione o arquivo a analisar:
                  </label>
                  <select
                    value={selectedFileForExplain}
                    onChange={(e) => setSelectedFileForExplain(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-sky-500 shadow-sm"
                  >
                    {safeFiles.length === 0 && (
                      <option value="">(Nenhum arquivo disponível)</option>
                    )}
                    {safeFiles.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.file_type === 'directory' ? '📁' : '📄'} {f.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="self-end">
                  <button
                    onClick={handleExplainFile}
                    disabled={isExplaining || !selectedFileForExplain}
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold flex items-center gap-2 transition-colors shadow-sm"
                  >
                    {isExplaining ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    <span>Analisar Arquivo com IA</span>
                  </button>
                </div>
              </div>

              {fileExplanation && (
                <div className="p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl space-y-3 text-xs shadow-sm">
                  <div className="flex items-center gap-2 text-sky-600 dark:text-sky-400 font-semibold border-b border-slate-200 dark:border-slate-800/80 pb-2">
                    <FileCode className="w-4 h-4" />
                    <span>{fileExplanation.type}</span>
                  </div>

                  <div>
                    <h4 className="font-semibold text-slate-900 dark:text-slate-200 mb-1">Finalidade & Papel no Sistema:</h4>
                    <p className="text-slate-600 dark:text-slate-400 leading-relaxed">{fileExplanation.summary}</p>
                  </div>

                  <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-800 dark:text-amber-300">
                    <h4 className="font-semibold mb-1 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                      <span>Cuidados & Boas Práticas de Produção:</span>
                    </h4>
                    <p className="text-slate-700 dark:text-slate-300 leading-relaxed">{fileExplanation.bestPractices}</p>
                  </div>

                  <div className="text-[11px] text-slate-500 dark:text-slate-500 pt-1">
                    <span>{fileExplanation.details}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: Command Generator */}
          {activeTab === 'cmd_generator' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  O que você deseja executar ou investigar no servidor?
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={cmdQuery}
                    onChange={(e) => setCmdQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleGenerateCommand(cmdQuery)}
                    placeholder="Ex: ver quais pastas ocupam mais espaço, checar portas abertas, reiniciar nginx..."
                    className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-sky-500 shadow-sm"
                  />
                  <button
                    onClick={() => handleGenerateCommand(cmdQuery)}
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Gerar</span>
                  </button>
                </div>
              </div>

              {/* Quick Pills */}
              <div className="flex flex-wrap gap-1.5 text-xs">
                {[
                  'Maiores pastas no disco',
                  'Portas abertas (LISTEN)',
                  'Uso de Memória RAM & CPU',
                  'Reiniciar Nginx com teste prévio',
                  'Compactar pasta atual (backup)',
                  'Arquivos modificados hoje',
                ].map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setCmdQuery(s);
                      handleGenerateCommand(s);
                    }}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-slate-900 dark:bg-slate-800/80 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg dark:text-slate-300 dark:hover:text-white transition-colors shadow-sm"
                  >
                    {s}
                  </button>
                ))}
              </div>

              {generatedCommand && (
                <div className="space-y-3 pt-2">
                  <div className="p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl space-y-3 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">Comando Sugerido:</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                            generatedCommand.risk === 'safe'
                              ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                              : generatedCommand.risk === 'medium'
                              ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/30'
                              : 'bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/30'
                          }`}
                        >
                          {generatedCommand.risk === 'safe' ? 'Seguro (Leitura)' : 'Requer Atenção'}
                        </span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(generatedCommand.command);
                            setCopiedCmd(true);
                            setTimeout(() => setCopiedCmd(false), 2000);
                          }}
                          className="p-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:hover:text-white transition-colors shadow-sm"
                          title="Copiar comando"
                        >
                          {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    <pre className="p-3 bg-slate-950 dark:bg-dark-950 border border-slate-800 dark:border-slate-800/80 rounded-lg font-mono text-xs text-emerald-400 overflow-x-auto select-all">
                      {generatedCommand.command}
                    </pre>

                    <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{generatedCommand.explanation}</p>

                    {isRemote && onExecuteRemoteCommand && (
                      <div className="pt-2 border-t border-slate-200 dark:border-slate-800/80 flex items-center justify-end">
                        <button
                          onClick={handleExecuteGeneratedCmd}
                          disabled={isExecutingCmd}
                          className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                        >
                          {isExecutingCmd ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                          <span>Executar no Servidor Remoto</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {cmdExecutionOutput && (
                    <div className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1.5 text-xs font-mono shadow-sm">
                      <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-[11px]">
                        <span>Saída da Execução (Exit code: {cmdExecutionOutput.code})</span>
                      </div>
                      {cmdExecutionOutput.stdout && (
                        <pre className="text-slate-800 dark:text-slate-300 max-h-40 overflow-y-auto whitespace-pre-wrap">
                          {cmdExecutionOutput.stdout}
                        </pre>
                      )}
                      {cmdExecutionOutput.stderr && (
                        <pre className="text-rose-600 dark:text-rose-400 max-h-40 overflow-y-auto whitespace-pre-wrap">
                          {cmdExecutionOutput.stderr}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: Security Audit */}
          {activeTab === 'security_audit' && (
            <div className="space-y-4">
              {/* Score Banner */}
              <div className="p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-4">
                  <div
                    className={`w-14 h-14 rounded-2xl flex items-center justify-center font-bold text-xl border ${
                      securityReport.score >= 80
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                        : securityReport.score >= 50
                        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
                        : 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'
                    }`}
                  >
                    {securityReport.score}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">Pontuação de Segurança da Pasta</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {securityReport.critCount} vulnerabilidades críticas, {securityReport.warnCount} alertas detectados.
                    </p>
                  </div>
                </div>

                {securityReport.issues.length > 0 && (
                  <button
                    onClick={handleAutoFixPermissions}
                    disabled={isFixingPermissions}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold flex items-center gap-2 shadow-sm transition-colors"
                  >
                    {isFixingPermissions ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Lock className="w-3.5 h-3.5" />
                    )}
                    <span>Corrigir Permissões Automaticamente</span>
                  </button>
                )}
              </div>

              {auditSuccessMsg && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>{auditSuccessMsg}</span>
                </div>
              )}

              {/* Issue List */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">Itens Auditados:</h4>
                {securityReport.issues.length === 0 ? (
                  <div className="p-6 text-center border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/40 space-y-2">
                    <ShieldCheck className="w-8 h-8 text-emerald-500 dark:text-emerald-400 mx-auto" />
                    <p className="text-xs text-slate-800 dark:text-slate-300 font-semibold">Tudo Seguro!</p>
                    <p className="text-[11px] text-slate-500">
                      Nenhum arquivo 777 público ou chave sensível desprotegida foi encontrada nesta pasta.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {securityReport.issues.map((issue, idx) => (
                      <div
                        key={idx}
                        className={`p-3 rounded-xl border text-xs space-y-1 ${
                          issue.severity === 'critical'
                            ? 'bg-red-500/10 border-red-500/20 text-red-700 dark:text-red-300'
                            : 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        <div className="flex items-center justify-between font-semibold">
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            <span>{issue.title}</span>
                          </div>
                          <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-slate-200 dark:bg-black/40 text-slate-800 dark:text-slate-200">
                            Recomendado: 0{issue.suggestedChmod.toString(8)}
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400 text-[11px] pl-6 leading-relaxed">{issue.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950/70 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
          <span>RustSCP Smart AI Engine</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 rounded-lg transition-colors border border-slate-300 dark:border-slate-700 font-medium shadow-sm"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
