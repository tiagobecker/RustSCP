import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Download, 
  Check, 
  ShieldCheck, 
  RefreshCw, 
  Terminal, 
  Zap,
  Layers,
  Server
} from 'lucide-react';
import { MarketplaceTool, RemoteSystemInfo } from '../types.ts';

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
    name: 'ncdu (NCurses Disk Usage)',
    category: 'disk',
    icon: 'hard-drive',
    description: {
      'pt-BR': 'Analisador interativo ultrarrápido de uso de disco. Permite navegar e descobrir imediatamente onde estão os gigabytes ocupados no servidor.',
      'en-US': 'Blazing fast ncurses disk usage analyzer. Navigate and locate large folders instantly on the server.',
    },
    checkCommand: 'command -v ncdu',
    isEssential: true,
  },
  {
    id: 'dust',
    name: 'dust (du + rust)',
    category: 'disk',
    icon: 'hard-drive',
    description: {
      'pt-BR': 'Visualizador moderno em árvore do uso de disco escrito em Rust. Mostra graficamente quais pastas consomem mais espaço.',
      'en-US': 'Modern graphical disk usage tree viewer written in Rust. Displays a clean visual representation of disk consumption.',
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
      'pt-BR': 'A ferramenta de busca de texto mais rápida do mundo (feita em Rust). Localiza strings em milhões de linhas de código em milissegundos.',
      'en-US': 'The fastest line-oriented text search tool in the world. Searches across millions of lines of code in milliseconds.',
    },
    checkCommand: 'command -v rg',
    isEssential: true,
  },
  {
    id: 'fd',
    name: 'fd / fdfind',
    category: 'search',
    icon: 'search',
    description: {
      'pt-BR': 'Alternativa moderna e intuitiva ao comando find tradicional. Muito mais rápida, ignora padrões do .gitignore e suporta cores.',
      'en-US': 'Simple, fast and user-friendly alternative to find. Traverses directories in parallel and respects gitignore.',
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
      'pt-BR': 'Utilitários fundamentais para empacotar e descompactar arquivos .zip no Linux. Indispensável para o recurso de compactação do RustSCP.',
      'en-US': 'Standard utilities to create and extract .zip archives. Essential for RustSCP compression features.',
    },
    checkCommand: 'command -v zip && command -v unzip',
    isEssential: true,
  },
  {
    id: 'pigz',
    name: 'pigz (Parallel Gzip)',
    category: 'compression',
    icon: 'archive',
    description: {
      'pt-BR': 'Implementação de gzip totalmente paralela. Usa todos os núcleos da CPU do servidor para compactar e descompactar arquivos .tar.gz até 8x mais rápido.',
      'en-US': 'Parallel implementation of gzip. Uses all CPU cores to compress and decompress tar.gz files up to 8x faster.',
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
      'pt-BR': 'Monitor interativo de processos e recursos do sistema. Visualização em tempo real de CPU, memória RAM e processos ativos.',
      'en-US': 'Interactive system-monitor and process-viewer. Real-time visual meters for CPU, memory, and running tasks.',
    },
    checkCommand: 'command -v htop',
    isEssential: true,
  },
  {
    id: 'btop',
    name: 'btop++',
    category: 'monitor',
    icon: 'cpu',
    description: {
      'pt-BR': 'Monitor de recursos com estética cyberpunk avançada. Gráficos de CPU, memória, discos, rede e processos com alta fidelidade visual.',
      'en-US': 'Modern resource monitor with advanced visual graphs for CPU, memory, disks, network, and processes.',
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
      'pt-BR': 'Processador de JSON leve e flexível para linha de comando. Permite formatar, filtrar e extrair dados de logs e APIs.',
      'en-US': 'Lightweight and flexible command-line JSON processor. Transform, filter, and extract data easily.',
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
      'pt-BR': 'Utilitário clássico de sincronização e transferência incremental com algoritmo delta. Otimiza transferências enviando apenas os bytes alterados.',
      'en-US': 'Fast and versatile file-copying and incremental synchronization utility. Uses delta algorithm to minimize data transfer.',
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
      'pt-BR': 'Exibe a estrutura de diretórios em forma de árvore recursiva identada no terminal.',
      'en-US': 'Recursive directory listing command that produces a depth-indented listing of files.',
    },
    checkCommand: 'command -v tree',
    isEssential: false,
  },
];

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

  const [toolStatus, setToolStatus] = useState<Record<string, boolean>>({});
  const [checkingAll, setCheckingAll] = useState<boolean>(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installConsole, setInstallConsole] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Check installed status of tools
  const checkTools = async () => {
    setCheckingAll(true);
    const results: Record<string, boolean> = {};
    for (const tool of MARKETPLACE_TOOLS) {
      try {
        const installed = await onCheckTool(tool.checkCommand);
        results[tool.id] = installed;
      } catch (_e) {
        results[tool.id] = false;
      }
    }
    setToolStatus(results);
    setCheckingAll(false);
  };

  useEffect(() => {
    if (isOpen) {
      checkTools();
    }
  }, [isOpen, sessionId]);

  const handleInstall = async (tool: MarketplaceTool) => {
    setInstallingId(tool.id);
    setInstallConsole(
      isPt 
        ? `Iniciando instalação de '${tool.name}' via gerenciador ${systemInfo?.package_manager || 'do sistema'}...\n` 
        : `Installing '${tool.name}' via ${systemInfo?.package_manager || 'system'} package manager...\n`
    );
    try {
      const result = await onInstallTool(tool.id);
      let out = '';
      if (result.stdout) out += result.stdout;
      if (result.stderr) out += (out ? '\n--- STDERR ---\n' : '') + result.stderr;
      setInstallConsole(out || (isPt ? 'Instalação concluída com sucesso.' : 'Installation completed successfully.'));
      // Re-check tool
      const installed = await onCheckTool(tool.checkCommand);
      setToolStatus((prev) => ({ ...prev, [tool.id]: installed }));
    } catch (e: any) {
      setInstallConsole(`Erro na instalação: ${e}`);
    } finally {
      setInstallingId(null);
    }
  };

  if (!isOpen) return null;

  const filteredTools = MARKETPLACE_TOOLS.filter((tool) => {
    return selectedCategory === 'all' || tool.category === selectedCategory;
  });

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-3 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl max-w-5xl w-full h-[88vh] flex flex-col overflow-hidden text-slate-900 dark:text-slate-100">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-dark-600 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none shrink-0">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-rust-500/15 text-rust-500 dark:text-rust-400 border border-rust-500/30">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <span>{isPt ? 'Marketplace SysAdmin & Ferramentas Linux' : 'SysAdmin Marketplace & Linux Tools'}</span>
                <span className="text-[10px] bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 font-mono px-2 py-0.5 rounded border border-slate-300 dark:border-dark-600">
                  {sessionName}
                </span>
                {isRemote && (
                  <span className="text-[10px] bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium px-2 py-0.5 rounded border border-sky-500/20">
                    SSH Remote
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isPt 
                  ? 'Instale com 1 clique utilitários essenciais para medições ultrarrápidas de pastas, busca em alta velocidade e compressão paralela.'
                  : '1-Click install essential utilities for fast directory sizing, multi-threaded compression, and lightning-fast search.'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Server System Profile Banner */}
        <div className="bg-slate-50 dark:bg-dark-850 border-b border-slate-200 dark:border-dark-600 px-5 py-3 flex flex-wrap items-center justify-between gap-3 select-none shrink-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 shadow-sm">
              <Server className="w-3.5 h-3.5 text-rust-500 dark:text-rust-400" />
              <span className="font-semibold text-slate-800 dark:text-slate-200">{systemInfo?.os_name || 'Linux'}</span>
            </div>

            <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 shadow-sm">
              <Terminal className="w-3.5 h-3.5 text-sky-500 dark:text-sky-400" />
              <span className="text-slate-700 dark:text-slate-300 font-mono">{systemInfo?.default_shell || 'bash'}</span>
            </div>

            <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 shadow-sm">
              <Layers className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
              <span className="text-slate-700 dark:text-slate-300 font-mono">pkg: {systemInfo?.package_manager || 'apt'}</span>
            </div>

            <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 shadow-sm">
              <ShieldCheck className={`w-3.5 h-3.5 ${systemInfo?.is_root ? 'text-emerald-500 dark:text-emerald-400' : 'text-amber-500 dark:text-amber-400'}`} />
              <span className="text-slate-700 dark:text-slate-300">
                {systemInfo?.is_root ? 'Root (UID 0)' : systemInfo?.has_sudo ? 'Sudo Disponível' : 'Usuário Sem Root'}
              </span>
            </div>
          </div>

          <button
            onClick={async () => {
              await onRefreshSystemInfo();
              await checkTools();
            }}
            disabled={checkingAll}
            className="flex items-center space-x-1 px-3 py-1 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 hover:text-slate-900 dark:bg-dark-700 dark:hover:bg-dark-600 dark:text-slate-300 dark:hover:text-slate-100 text-xs font-medium border border-slate-300 dark:border-dark-600 transition-colors shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checkingAll ? 'animate-spin' : ''}`} />
            <span>{isPt ? 'Verificar Status' : 'Check Status'}</span>
          </button>
        </div>

        {/* Category Filter Pills */}
        <div className="px-5 py-2.5 bg-slate-100 dark:bg-dark-800 border-b border-slate-200 dark:border-dark-600 flex items-center space-x-1.5 select-none shrink-0 overflow-x-auto scrollbar-none">
          {[
            { id: 'all', label: isPt ? 'Todos os Utilitários' : 'All Tools' },
            { id: 'disk', label: isPt ? 'Disco & Pastas' : 'Disk & Folders' },
            { id: 'search', label: isPt ? 'Busca Rápida' : 'Search' },
            { id: 'compression', label: isPt ? 'Compressão Avançada' : 'Compression' },
            { id: 'monitor', label: isPt ? 'Processos & Monitoramento' : 'Monitoring' },
            { id: 'transfer', label: isPt ? 'Rede & Transferência' : 'Network' },
            { id: 'utility', label: isPt ? 'Utilitários' : 'Utilities' },
          ].map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCategory(c.id)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                selectedCategory === c.id
                  ? 'bg-rust-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-dark-700'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Tools Cards Grid */}
        <div className="flex-1 overflow-y-auto p-5 bg-slate-50 dark:bg-dark-900 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {filteredTools.map((tool) => {
              const isInstalled = toolStatus[tool.id];
              const isBusy = installingId === tool.id;

              return (
                <div
                  key={tool.id}
                  className="bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-4 flex flex-col justify-between space-y-3 hover:border-slate-300 dark:hover:border-dark-500 transition-colors shadow-sm"
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-xs text-slate-900 dark:text-slate-100">{tool.name}</span>
                        {tool.isEssential && (
                          <span className="text-[10px] bg-rust-500/15 text-rust-600 dark:text-rust-400 font-semibold px-1.5 py-0.2 rounded border border-rust-500/30">
                            {isPt ? 'Essencial' : 'Essential'}
                          </span>
                        )}
                      </div>

                      {checkingAll ? (
                        <span className="text-[10px] text-slate-500 animate-pulse">
                          {isPt ? 'Verificando...' : 'Checking...'}
                        </span>
                      ) : isInstalled ? (
                        <span className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                          <Check className="w-3 h-3" />
                          <span>{isPt ? 'Instalado' : 'Installed'}</span>
                        </span>
                      ) : (
                        <span className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 dark:bg-dark-700 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-dark-600">
                          <span>{isPt ? 'Não Instalado' : 'Not Installed'}</span>
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                      {tool.description[lang]}
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-200 dark:border-dark-700/60 flex items-center justify-between">
                    <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 truncate max-w-[200px]">
                      {tool.checkCommand}
                    </span>

                    <button
                      onClick={() => handleInstall(tool)}
                      disabled={isBusy || isInstalled}
                      className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shadow-sm ${
                        isInstalled
                          ? 'bg-slate-100 dark:bg-dark-700 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-dark-600 cursor-default opacity-80'
                          : 'bg-rust-600 hover:bg-rust-500 text-white border border-rust-500/40'
                      }`}
                    >
                      {isBusy ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>{isPt ? 'Instalando...' : 'Installing...'}</span>
                        </>
                      ) : isInstalled ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span>{isPt ? 'Pronto para Uso' : 'Ready to Use'}</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-3.5 h-3.5" />
                          <span>{isPt ? 'Instalar (1-Clique)' : 'Install (1-Click)'}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Installation Terminal Output */}
          {installConsole && (
            <div className="bg-white dark:bg-dark-950 border border-slate-300 dark:border-dark-600 rounded-xl overflow-hidden mt-4 shadow-sm">
              <div className="bg-slate-100 dark:bg-dark-900 border-b border-slate-200 dark:border-dark-700 px-3.5 py-1.5 flex items-center justify-between text-xs font-mono text-slate-600 dark:text-slate-400">
                <span>{isPt ? 'Console de Instalação' : 'Installation Console'}</span>
                <button onClick={() => setInstallConsole('')} className="text-[10px] hover:text-slate-900 dark:hover:text-slate-200">
                  {isPt ? 'Limpar' : 'Clear'}
                </button>
              </div>
              <pre className="p-3.5 text-xs font-mono text-slate-100 bg-black/90 dark:bg-black/90 overflow-x-auto max-h-48 selection:bg-rust-500/30">
                {installConsole}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
