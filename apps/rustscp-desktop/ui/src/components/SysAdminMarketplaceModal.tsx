import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Check, Download, Package, RefreshCw } from 'lucide-react';
import { MarketplaceTool, RemoteSystemInfo } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Select } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';
import { CommandOutput, CommandResult } from './automation/CommandOutput.tsx';

interface SysAdminMarketplaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  sessionName: string;
  isRemote: boolean;
  systemInfo: RemoteSystemInfo | null;
  onRefreshSystemInfo: () => Promise<void>;
  onCheckTool: (checkCmd: string) => Promise<boolean>;
  onInstallTool: (toolId: string) => Promise<{ stdout: string; stderr: string; exit_code: number }>;
}

const MARKETPLACE_TOOLS: MarketplaceTool[] = [
  {
    id: 'ncdu',
    name: 'ncdu',
    category: 'disk',
    icon: 'hard-drive',
    description: {
      'pt-BR': 'Analisador interativo de uso de disco: mostra onde estão os arquivos grandes.',
      'en-US': 'Interactive disk usage analyzer that shows where the large files are.',
    },
    checkCommand: 'command -v ncdu',
    isEssential: true,
  },
  {
    id: 'dust',
    name: 'dust',
    category: 'disk',
    icon: 'hard-drive',
    description: {
      'pt-BR': 'Árvore de uso de disco no terminal, escrita em Rust.',
      'en-US': 'Disk usage tree for the terminal, written in Rust.',
    },
    checkCommand: 'command -v dust',
    isEssential: false,
  },
  {
    id: 'ripgrep',
    name: 'ripgrep (rg)',
    category: 'search',
    icon: 'search',
    description: {
      'pt-BR': 'Busca de texto rápida em arquivos e pastas.',
      'en-US': 'Fast text search across files and folders.',
    },
    checkCommand: 'command -v rg',
    isEssential: true,
  },
  {
    id: 'fd',
    name: 'fd',
    category: 'search',
    icon: 'search',
    description: {
      'pt-BR': 'Alternativa simples e rápida ao find; respeita o .gitignore.',
      'en-US': 'Simple, fast alternative to find that respects .gitignore.',
    },
    checkCommand: 'command -v fd || command -v fdfind',
    isEssential: true,
  },
  {
    id: 'zip',
    name: 'zip & unzip',
    category: 'compression',
    icon: 'archive',
    description: {
      'pt-BR': 'Criar e extrair arquivos .zip; usado pela compactação do RustSCP.',
      'en-US': 'Create and extract .zip archives; used by RustSCP compression.',
    },
    checkCommand: 'command -v zip && command -v unzip',
    isEssential: true,
  },
  {
    id: 'pigz',
    name: 'pigz',
    category: 'compression',
    icon: 'archive',
    description: {
      'pt-BR': 'gzip paralelo: usa todos os núcleos para compactar .tar.gz mais rápido.',
      'en-US': 'Parallel gzip that uses every core to compress .tar.gz faster.',
    },
    checkCommand: 'command -v pigz',
    isEssential: false,
  },
  {
    id: 'htop',
    name: 'htop',
    category: 'monitor',
    icon: 'cpu',
    description: {
      'pt-BR': 'Monitor interativo de processos, CPU e memória.',
      'en-US': 'Interactive process, CPU and memory monitor.',
    },
    checkCommand: 'command -v htop',
    isEssential: true,
  },
  {
    id: 'btop',
    name: 'btop',
    category: 'monitor',
    icon: 'cpu',
    description: {
      'pt-BR': 'Monitor de recursos com gráficos de CPU, memória, disco e rede.',
      'en-US': 'Resource monitor with CPU, memory, disk and network graphs.',
    },
    checkCommand: 'command -v btop',
    isEssential: false,
  },
  {
    id: 'jq',
    name: 'jq',
    category: 'utility',
    icon: 'sparkles',
    description: {
      'pt-BR': 'Processador de JSON na linha de comando: formatar, filtrar e extrair dados.',
      'en-US': 'Command-line JSON processor to format, filter and extract data.',
    },
    checkCommand: 'command -v jq',
    isEssential: false,
  },
  {
    id: 'rsync',
    name: 'rsync',
    category: 'transfer',
    icon: 'network',
    description: {
      'pt-BR': 'Sincronização incremental: envia apenas o que mudou.',
      'en-US': 'Incremental sync that only sends what changed.',
    },
    checkCommand: 'command -v rsync',
    isEssential: true,
  },
  {
    id: 'tree',
    name: 'tree',
    category: 'utility',
    icon: 'layers',
    description: {
      'pt-BR': 'Lista pastas em forma de árvore.',
      'en-US': 'Lists folders as a tree.',
    },
    checkCommand: 'command -v tree',
    isEssential: false,
  },
];

type ToolState = 'installed' | 'missing' | 'unknown';

/** Last known status per session, so reopening shows results right away while re-checking. */
const statusCache = new Map<string, Record<string, ToolState>>();

/** One shell round trip that reports every tool as `id=1` / `id=0`. */
const BATCH_CHECK = MARKETPLACE_TOOLS.map(
  (t) => `if { ${t.checkCommand}; } >/dev/null 2>&1; then echo ${t.id}=1; else echo ${t.id}=0; fi`
).join('; ');

export const SysAdminMarketplaceModal: React.FC<SysAdminMarketplaceModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  sessionName,
  isRemote,
  systemInfo,
  onRefreshSystemInfo,
  onCheckTool,
  onInstallTool,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const lang = isPt ? 'pt-BR' : 'en-US';

  const [toolStatus, setToolStatus] = useState<Record<string, ToolState>>(() => statusCache.get(sessionId) || {});
  const [checkingAll, setCheckingAll] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<(CommandResult & { tool: string }) | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const checkIdRef = useRef(0);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const categories = [
    { id: 'all', label: isPt ? 'Todas' : 'All' },
    { id: 'disk', label: isPt ? 'Disco e pastas' : 'Disk & folders' },
    { id: 'search', label: isPt ? 'Busca' : 'Search' },
    { id: 'compression', label: isPt ? 'Compressão' : 'Compression' },
    { id: 'monitor', label: isPt ? 'Monitoramento' : 'Monitoring' },
    { id: 'transfer', label: isPt ? 'Rede e transferência' : 'Network & transfer' },
    { id: 'utility', label: isPt ? 'Utilitários' : 'Utilities' },
  ];

  const checkTools = async () => {
    const id = ++checkIdRef.current;
    const sid = sessionId;
    setCheckingAll(true);
    const results: Record<string, ToolState> = {};
    let parsed = false;
    try {
      const res = await invoke<{ exit_code: number; stdout: string; stderr: string }>('execute_remote_command', {
        sessionId: sid,
        command: BATCH_CHECK,
      });
      for (const line of (res.stdout || '').split(/\r?\n/)) {
        const m = /^([A-Za-z0-9_-]+)=([01])$/.exec(line.trim());
        if (m) {
          results[m[1]] = m[2] === '1' ? 'installed' : 'missing';
          parsed = true;
        }
      }
    } catch {
      parsed = false;
    }
    if (!parsed && isRemote) {
      // Fallback: one check per tool through the app's handler
      for (const tool of MARKETPLACE_TOOLS) {
        if (id !== checkIdRef.current || sessionRef.current !== sid) return;
        try {
          results[tool.id] = (await onCheckTool(tool.checkCommand)) ? 'installed' : 'missing';
        } catch {
          results[tool.id] = 'unknown';
        }
      }
    }
    if (id !== checkIdRef.current || sessionRef.current !== sid) return;
    for (const tool of MARKETPLACE_TOOLS) if (!results[tool.id]) results[tool.id] = 'unknown';
    statusCache.set(sid, results);
    setToolStatus(results);
    setCheckingAll(false);
  };

  useEffect(() => {
    if (!isOpen) return;
    setToolStatus(statusCache.get(sessionId) || {});
    setInstallLog(null);
    void checkTools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sessionId]);

  const handleInstall = async (tool: MarketplaceTool) => {
    if (installingId || !isRemote) return;
    const sid = sessionId;
    setInstallingId(tool.id);
    setInstallLog(null);
    try {
      const result = await onInstallTool(tool.id);
      if (sessionRef.current !== sid) return;
      setInstallLog({ tool: tool.name, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.exit_code });
      let installed = false;
      try {
        installed = await onCheckTool(tool.checkCommand);
      } catch {
        installed = false;
      }
      if (sessionRef.current !== sid) return;
      setToolStatus((prev) => {
        const next: Record<string, ToolState> = { ...prev, [tool.id]: installed ? 'installed' : 'missing' };
        statusCache.set(sid, next);
        return next;
      });
      if (result.exit_code === 0 && installed) {
        notify.success(isPt ? `${tool.name} instalado` : `${tool.name} installed`);
      } else {
        notify.error(
          isPt ? `Não foi possível instalar ${tool.name}` : `Could not install ${tool.name}`,
          isPt ? 'Veja o registro da instalação.' : 'See the installation log.'
        );
      }
    } catch (e) {
      if (sessionRef.current !== sid) return;
      setInstallLog({ tool: tool.name, stdout: '', stderr: String(e), exitCode: -1 });
      notify.error(isPt ? `Não foi possível instalar ${tool.name}` : `Could not install ${tool.name}`, e);
    } finally {
      setInstallingId(null);
    }
  };

  if (!isOpen) return null;

  const filteredTools = MARKETPLACE_TOOLS.filter((tool) => selectedCategory === 'all' || tool.category === selectedCategory);

  const profile = systemInfo
    ? [
        systemInfo.os_name || systemInfo.distro_id,
        systemInfo.default_shell,
        systemInfo.package_manager && `${isPt ? 'pacotes' : 'packages'}: ${systemInfo.package_manager}`,
        systemInfo.is_root ? 'root' : systemInfo.has_sudo ? 'sudo' : isPt ? 'sem root' : 'no root',
      ]
        .filter(Boolean)
        .join(' · ')
    : isRemote
      ? isPt
        ? 'Detalhes do servidor ainda não detectados'
        : 'Server details not detected yet'
      : isPt
        ? 'Desconhecido'
        : 'Unknown';

  const statusText = (state: ToolState | undefined) => {
    if (checkingAll && !state) return isPt ? 'Verificando…' : 'Checking…';
    switch (state) {
      case 'installed':
        return isPt ? 'Instalado' : 'Installed';
      case 'missing':
        return isPt ? 'Não instalado' : 'Not installed';
      default:
        return isPt ? 'Desconhecido' : 'Unknown';
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      icon={<Package className="w-5 h-5" />}
      title={isPt ? 'Ferramentas do servidor' : 'Server tools'}
      subtitle={
        <span>
          <span className="text-ink-muted">{sessionName}</span> · {profile}
        </span>
      }
      headerActions={
        <Button
          size="sm"
          variant="secondary"
          data-autofocus=""
          onClick={async () => {
            await onRefreshSystemInfo();
            await checkTools();
          }}
          disabled={checkingAll}
          icon={<RefreshCw className={`w-3.5 h-3.5 ${checkingAll ? 'animate-spin' : ''}`} />}
        >
          {isPt ? 'Verificar' : 'Check'}
        </Button>
      }
      footer={
        <Button variant="secondary" onClick={onClose}>
          {isPt ? 'Fechar' : 'Close'}
        </Button>
      }
    >
      <div className="space-y-4">
        {!isRemote && (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-300">
            {isPt
              ? 'A instalação só funciona em servidores SSH. Abra um servidor SSH no painel para instalar ferramentas.'
              : 'Installing only works on SSH servers. Open an SSH server in the pane to install tools.'}
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-ink-muted">
            {isPt
              ? 'Instale utilitários usados para medir pastas, buscar texto e compactar mais rápido.'
              : 'Install utilities for sizing folders, searching text and compressing faster.'}
          </p>
          <Select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="w-44 shrink-0"
            aria-label={isPt ? 'Categoria' : 'Category'}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="ui-card divide-y divide-line">
          {filteredTools.map((tool) => {
            const state = toolStatus[tool.id];
            const isInstalled = state === 'installed';
            const isBusy = installingId === tool.id;
            return (
              <div key={tool.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-ink">{tool.name}</span>
                    {tool.isEssential && (
                      <span className="text-[11px] text-ink-faint">{isPt ? 'Essencial' : 'Essential'}</span>
                    )}
                  </div>
                  <p className="text-[12px] text-ink-muted leading-snug">{tool.description[lang]}</p>
                </div>
                {isInstalled ? (
                  <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[12px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-500/10">
                    <Check className="w-3.5 h-3.5" />
                    {statusText(state)}
                  </span>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[12px] text-ink-faint whitespace-nowrap">{statusText(state)}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleInstall(tool)}
                      disabled={!isRemote || installingId !== null || (checkingAll && !state)}
                      loading={isBusy}
                      icon={<Download className="w-3.5 h-3.5" />}
                      title={!isRemote ? (isPt ? 'Disponível apenas em servidores SSH' : 'Only available on SSH servers') : undefined}
                    >
                      {isBusy ? (isPt ? 'Instalando…' : 'Installing…') : isPt ? 'Instalar' : 'Install'}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {installLog && (
          <div className="space-y-1.5">
            <span className="text-[12px] font-medium text-ink-faint">
              {isPt ? `Registro da instalação: ${installLog.tool}` : `Installation log: ${installLog.tool}`}
            </span>
            <CommandOutput result={installLog} isPt={isPt} onClear={() => setInstallLog(null)} bodyClassName="max-h-56" />
          </div>
        )}

        <Disclosure label={isPt ? 'Detalhes' : 'Details'}>
          <div className="space-y-2">
            <p className="text-[12px] text-ink-faint">
              {isPt
                ? 'Comandos usados para verificar cada ferramenta. A instalação usa o gerenciador de pacotes do servidor (apt, apk, dnf ou pacman) com sudo sem senha quando disponível.'
                : 'Commands used to check each tool. Installing uses the server package manager (apt, apk, dnf or pacman) with passwordless sudo when available.'}
            </p>
            <div className="ui-card divide-y divide-line">
              {MARKETPLACE_TOOLS.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-28 shrink-0 text-[12px] text-ink">{t.name}</span>
                  <code className="font-mono text-[11.5px] text-ink-muted truncate">{t.checkCommand}</code>
                </div>
              ))}
            </div>
          </div>
        </Disclosure>
      </div>
    </Modal>
  );
};
