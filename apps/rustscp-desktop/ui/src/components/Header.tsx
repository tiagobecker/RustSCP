import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  Server,
  RefreshCw,
  TerminalSquare,
  Search,
  Code,
  HardDrive,
  GitCompare,
  Link,
  Zap,
  Bot,
  Disc,
  ChevronDown,
  Terminal,
  Layers,
  Sparkles,
  Sun,
  Moon,
  Monitor,
  ShoppingBag,
  Trash2,
  Settings,
  Globe,
  Info
} from 'lucide-react';
import { McpStatusInfo } from '../types.ts';
import { ThemeMode } from '../theme.ts';

interface HeaderProps {
  onOpenSiteManager: () => void;
  onOpenSync: () => void;
  onOpenRemoteCommand: () => void;
  onOpenActions: () => void;
  onOpenMcp: () => void;
  onOpenAiAssistant?: () => void;
  onOpenFindFiles: () => void;
  onOpenScriptConsole: () => void;
  onOpenGenerateCode: () => void;
  onOpenServerInfo: () => void;
  onOpenVirtualDisk: () => void;
  onOpenMarketplace: () => void;
  onOpenTrash: () => void;
  onOpenNativeTerminal: () => void;
  onOpenSettings?: () => void;
  remoteTrashEnabled?: boolean;
  onCompareDirectories: () => void;
  syncBrowsing: boolean;
  onToggleSyncBrowsing: () => void;
  continuousSync: boolean;
  onToggleContinuousSync: () => void;
  mcpStatus?: McpStatusInfo | null;
  activeTransferCount?: number;
  totalSpeedBps?: number;
  onToggleTransferDrawer?: () => void;
  themeMode?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
  onOpenAbout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ 
  onOpenSiteManager,
  onOpenSync,
  onOpenRemoteCommand,
  onOpenActions, 
  onOpenMcp,
  onOpenAiAssistant,
  onOpenFindFiles,
  onOpenScriptConsole,
  onOpenGenerateCode,
  onOpenServerInfo,
  onOpenVirtualDisk,
  onOpenMarketplace,
  onOpenTrash,
  onOpenNativeTerminal,
  onOpenSettings,
  remoteTrashEnabled,
  onCompareDirectories,
  syncBrowsing,
  onToggleSyncBrowsing,
  continuousSync,
  onToggleContinuousSync,
  mcpStatus,
  activeTransferCount: _activeTransferCount = 0,
  totalSpeedBps: _totalSpeedBps = 0,
  onToggleTransferDrawer: _onToggleTransferDrawer,
  themeMode = 'system',
  onThemeChange,
  onOpenAbout,
}) => {
  const { t, i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [openDropdown, setOpenDropdown] = useState<'sync' | 'tools' | 'terminals' | 'ai' | 'theme' | 'language' | null>(null);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header ref={headerRef} className="h-12 bg-dark-800 border-b border-dark-700 px-3 flex items-center justify-between select-none relative z-30">
      {/* Left: Brand & Connection */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-2">
          <img src="/icon.png" alt="RustSCP" className="w-7 h-7 object-contain drop-shadow" />
          <span className="font-extrabold tracking-tight text-sm">
            <span className="text-slate-900 dark:text-slate-100">Rust</span>
            <span className="text-rust-500 font-black ml-0.5">SCP</span>
          </span>
        </div>

        {/* Site Manager Button (Corten Rust Accent) */}
        <button
          onClick={onOpenSiteManager}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-rust-600 hover:bg-rust-500 text-white text-xs font-semibold transition-all shadow-sm border border-rust-500/40"
        >
          <Server className="w-3.5 h-3.5" />
          <span>Site Manager</span>
        </button>
      </div>

      {/* Center: Segmented Categorized Dropdowns */}
      <div className="flex items-center space-x-1.5">
        {/* Dropdown: Sincronização */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'sync' ? null : 'sync')}
            className={`flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              openDropdown === 'sync' || syncBrowsing || continuousSync
                ? 'bg-sky-500/20 border-sky-500/50 text-sky-800 dark:text-sky-300 font-semibold shadow-sm'
                : 'bg-dark-700/80 border-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-dark-650 dark:hover:bg-dark-600'
            }`}
          >
            <RefreshCw className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            <span>{isPt ? 'Sincronização' : 'Sync'}</span>
            {(syncBrowsing || continuousSync) && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-0.5" />
            )}
            <ChevronDown className="w-3 h-3 text-slate-500 dark:text-slate-400 ml-0.5" />
          </button>

          {openDropdown === 'sync' && (
            <div className="absolute left-0 mt-1.5 w-60 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1.5 z-40 text-xs animate-in fade-in zoom-in-95 duration-100">
              <button
                onClick={() => {
                  onCompareDirectories();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <GitCompare className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                  <span>{isPt ? 'Comparar Pastas' : 'Compare Directories'}</span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Shift+F2</span>
              </button>

              <button
                onClick={() => {
                  onOpenSync();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <RefreshCw className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                <span>{isPt ? 'Assistente de Sincronização' : 'Sync Assistant'}</span>
              </button>

              <div className="h-px bg-dark-600/60 dark:bg-dark-700 my-1" />

              <div
                onClick={onToggleSyncBrowsing}
                className="px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center justify-between cursor-pointer text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <Link className="w-4 h-4 text-sky-500 dark:text-sky-400" />
                  <span>{isPt ? 'Navegação Sincronizada' : 'Synchronize Browsing'}</span>
                </div>
                <div className={`w-8 h-4 rounded-full transition-colors relative ${syncBrowsing ? 'bg-sky-600' : 'bg-dark-600'}`}>
                  <div className={`w-3 h-3 rounded-full bg-white transition-transform absolute top-0.5 ${syncBrowsing ? 'right-0.5' : 'left-0.5'}`} />
                </div>
              </div>

              <div
                onClick={onToggleContinuousSync}
                className="px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center justify-between cursor-pointer text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <Zap className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                  <span>{isPt ? 'Manter Remoto Atualizado' : 'Keep Up to Date (Live)'}</span>
                </div>
                <div className={`w-8 h-4 rounded-full transition-colors relative ${continuousSync ? 'bg-emerald-600' : 'bg-dark-600'}`}>
                  <div className={`w-3 h-3 rounded-full bg-white transition-transform absolute top-0.5 ${continuousSync ? 'right-0.5' : 'left-0.5'}`} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Dropdown: Ferramentas */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'tools' ? null : 'tools')}
            className={`flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              openDropdown === 'tools'
                ? 'bg-purple-500/20 border-purple-500/50 text-purple-800 dark:text-purple-300 font-semibold shadow-sm'
                : 'bg-dark-700/80 border-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-dark-650 dark:hover:bg-dark-600'
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
            <span>{isPt ? 'Ferramentas' : 'Tools'}</span>
            <ChevronDown className="w-3 h-3 text-slate-500 dark:text-slate-400 ml-0.5" />
          </button>

          {openDropdown === 'tools' && (
            <div className="absolute left-0 mt-1.5 w-56 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1.5 z-40 text-xs animate-in fade-in zoom-in-95 duration-100">
              {onOpenMarketplace && (
                <button
                  onClick={() => {
                    onOpenMarketplace();
                    setOpenDropdown(null);
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors group"
                >
                  <div className="flex items-center space-x-2">
                    <ShoppingBag className="w-4 h-4 text-amber-500 dark:text-amber-400 group-hover:scale-110 transition-transform" />
                    <span className="font-semibold text-amber-700 dark:text-amber-300">{isPt ? 'SysAdmin Marketplace' : 'SysAdmin Marketplace'}</span>
                  </div>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-800 dark:text-amber-300 font-mono font-bold">1-CLICK</span>
                </button>
              )}

              {onOpenTrash && (
                <button
                  onClick={() => {
                    onOpenTrash();
                    setOpenDropdown(null);
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
                >
                  <div className="flex items-center space-x-2">
                    <Trash2 className="w-4 h-4 text-rose-500 dark:text-rose-400" />
                    <span>{isPt ? 'Lixeira Remota' : 'Remote Trash'}</span>
                  </div>
                  {remoteTrashEnabled && (
                    <span className="w-2 h-2 rounded-full bg-emerald-400" title="Ativo" />
                  )}
                </button>
              )}

              <button
                onClick={() => {
                  onOpenFindFiles();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <Search className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                  <span>{isPt ? 'Localizar Arquivos' : 'Find Files'}</span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Shift+F7</span>
              </button>

              <button
                onClick={() => {
                  onOpenServerInfo();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <HardDrive className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                <span>{isPt ? 'Espaço em Disco & Servidor' : 'Disk & Server Info'}</span>
              </button>

              <button
                onClick={() => {
                  onOpenGenerateCode();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <Code className="w-4 h-4 text-blue-500 dark:text-blue-400" />
                <span>{isPt ? 'Gerar Código & URL' : 'Generate Code & URL'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Dropdown: Terminais */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'terminals' ? null : 'terminals')}
            className={`flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              openDropdown === 'terminals'
                ? 'bg-pink-500/20 border-pink-500/50 text-pink-800 dark:text-pink-300 font-semibold shadow-sm'
                : 'bg-dark-700/80 border-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-dark-650 dark:hover:bg-dark-600'
            }`}
          >
            <Terminal className="w-3.5 h-3.5 text-pink-500 dark:text-pink-400" />
            <span>{isPt ? 'Terminais' : 'Terminals'}</span>
            <ChevronDown className="w-3 h-3 text-slate-500 dark:text-slate-400 ml-0.5" />
          </button>

          {openDropdown === 'terminals' && (
            <div className="absolute left-0 mt-1.5 w-60 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1.5 z-40 text-xs animate-in fade-in zoom-in-95 duration-100">
              {onOpenNativeTerminal && (
                <button
                  onClick={() => {
                    onOpenNativeTerminal();
                    setOpenDropdown(null);
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 text-emerald-700 dark:text-emerald-400 font-semibold hover:text-emerald-900 dark:hover:text-emerald-300 transition-colors"
                >
                  <Terminal className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                  <span>{isPt ? 'Terminal Nativo do Sistema' : 'Native OS Terminal'}</span>
                </button>
              )}

              <button
                onClick={() => {
                  onOpenRemoteCommand();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <TerminalSquare className="w-4 h-4 text-pink-500 dark:text-pink-400" />
                  <span>{isPt ? 'Terminal Shell Remoto' : 'Remote SSH Shell'}</span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Ctrl+R</span>
              </button>

              <button
                onClick={() => {
                  onOpenScriptConsole();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <Terminal className="w-4 h-4 text-purple-500 dark:text-purple-400" />
                <span>{isPt ? 'Console de Scripts & Automação' : 'Scripting & Automation Console'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Feature Highlight: Disco Virtual */}
        <button
          onClick={onOpenVirtualDisk}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-800 dark:text-emerald-300 text-xs font-semibold transition-all shadow-sm"
        >
          <Disc className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
          <span>{isPt ? 'Disco Virtual' : 'Virtual Disk'}</span>
        </button>

        {/* Dropdown: IA & Automação */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'ai' ? null : 'ai')}
            className={`flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              openDropdown === 'ai'
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-800 dark:text-amber-300 font-semibold shadow-sm'
                : 'bg-dark-700/80 border-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-dark-650 dark:hover:bg-dark-600'
            }`}
          >
            <Bot className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
            <span>{isPt ? 'IA & Ações' : 'AI & Actions'}</span>
            <ChevronDown className="w-3 h-3 text-slate-500 dark:text-slate-400 ml-0.5" />
          </button>

          {openDropdown === 'ai' && (
            <div className="absolute right-0 mt-1.5 w-60 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1.5 z-40 text-xs animate-in fade-in zoom-in-95 duration-100">
              {onOpenAiAssistant && (
                <button
                  onClick={() => {
                    onOpenAiAssistant();
                    setOpenDropdown(null);
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 text-amber-700 dark:text-amber-300 font-semibold hover:text-amber-900 dark:hover:text-amber-200 transition-colors"
                >
                  <Sparkles className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                  <span>{isPt ? 'Assistente Inteligente (IA)' : 'Smart AI Assistant'}</span>
                </button>
              )}

              <button
                onClick={() => {
                  onOpenActions();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <Zap className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                <span>{isPt ? 'Smart Command Studio' : 'Smart Command Studio'}</span>
              </button>

              <button
                onClick={() => {
                  onOpenMcp();
                  setOpenDropdown(null);
                }}
                className="w-full text-left px-3.5 py-2 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <Bot className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                  <span>{isPt ? 'MCP AI Gateway' : 'MCP AI Gateway'}</span>
                </div>
                {mcpStatus && (
                  <span className="text-[10px] bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 px-1.5 py-0.2 rounded-full font-mono font-bold">
                    {mcpStatus.total_audit_events}
                  </span>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right: Language, Theme Selector & Settings */}
      <div className="flex items-center space-x-2">

        {/* Native Language Selector (PT / EN) */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'language' ? null : 'language')}
            title={t('header.language', 'Idioma / Language')}
            className="flex items-center space-x-1 px-2 py-1 rounded-lg bg-dark-700 hover:bg-dark-650 dark:hover:bg-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 text-xs font-semibold border border-dark-600 transition-colors"
          >
            <Globe className="w-3.5 h-3.5 text-sky-500" />
            <span className="font-mono text-[11px] uppercase font-bold">{isPt ? 'PT' : 'EN'}</span>
            <ChevronDown className="w-2.5 h-2.5 text-slate-500 dark:text-slate-400" />
          </button>

          {openDropdown === 'language' && (
            <div className="absolute right-0 mt-1.5 w-36 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1 z-40 text-xs animate-in fade-in zoom-in-95 duration-100">
              <button
                onClick={() => {
                  i18n.changeLanguage('pt-BR');
                  setOpenDropdown(null);
                }}
                className={`w-full text-left px-3 py-1.5 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 transition-colors ${
                  isPt 
                    ? 'text-sky-700 dark:text-sky-400 font-bold bg-dark-650/80 dark:bg-dark-700/50' 
                    : 'text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                <span className="text-xs">🇧🇷</span>
                <span>Português</span>
              </button>
              <button
                onClick={() => {
                  i18n.changeLanguage('en-US');
                  setOpenDropdown(null);
                }}
                className={`w-full text-left px-3 py-1.5 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 transition-colors ${
                  !isPt 
                    ? 'text-sky-700 dark:text-sky-400 font-bold bg-dark-650/80 dark:bg-dark-700/50' 
                    : 'text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                <span className="text-xs">🇺🇸</span>
                <span>English</span>
              </button>
            </div>
          )}
        </div>

        {/* Theme Selector (Light / Dark / System) */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'theme' ? null : 'theme')}
            title={
              themeMode === 'light' 
                ? (isPt ? 'Tema: Claro' : 'Theme: Light')
                : themeMode === 'dark'
                ? (isPt ? 'Tema: Escuro' : 'Theme: Dark')
                : (isPt ? 'Tema: Sistema' : 'Theme: System')
            }
            className="flex items-center space-x-1 px-2 py-1 rounded-lg bg-dark-700 hover:bg-dark-650 dark:hover:bg-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 text-xs font-semibold border border-dark-600 transition-colors"
          >
            {themeMode === 'light' ? (
              <Sun className="w-3.5 h-3.5 text-amber-500" />
            ) : themeMode === 'dark' ? (
              <Moon className="w-3.5 h-3.5 text-mcp-cyan" />
            ) : (
              <Monitor className="w-3.5 h-3.5 text-rust-500" />
            )}
            <ChevronDown className="w-2.5 h-2.5 text-slate-500 dark:text-slate-400" />
          </button>

          {openDropdown === 'theme' && (
            <div className="absolute right-0 mt-1.5 w-36 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1 z-40 text-xs animate-in fade-in zoom-in-95 duration-100">
              <button
                onClick={() => {
                  onThemeChange?.('system');
                  setOpenDropdown(null);
                }}
                className={`w-full text-left px-3 py-1.5 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 transition-colors ${
                  themeMode === 'system' 
                    ? 'text-rust-700 dark:text-rust-400 font-bold bg-dark-650/80 dark:bg-dark-700/50' 
                    : 'text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                <Monitor className="w-3.5 h-3.5 text-rust-500" />
                <span>{isPt ? 'Sistema' : 'System'}</span>
              </button>
              <button
                onClick={() => {
                  onThemeChange?.('dark');
                  setOpenDropdown(null);
                }}
                className={`w-full text-left px-3 py-1.5 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 transition-colors ${
                  themeMode === 'dark' 
                    ? 'text-sky-700 dark:text-mcp-cyan font-bold bg-dark-650/80 dark:bg-dark-700/50' 
                    : 'text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                <Moon className="w-3.5 h-3.5 text-mcp-cyan" />
                <span>{isPt ? 'Escuro' : 'Dark'}</span>
              </button>
              <button
                onClick={() => {
                  onThemeChange?.('light');
                  setOpenDropdown(null);
                }}
                className={`w-full text-left px-3 py-1.5 hover:bg-dark-650 dark:hover:bg-dark-700 flex items-center space-x-2 transition-colors ${
                  themeMode === 'light' 
                    ? 'text-amber-700 dark:text-amber-400 font-bold bg-dark-650/80 dark:bg-dark-700/50' 
                    : 'text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                <Sun className="w-3.5 h-3.5 text-amber-500" />
                <span>{isPt ? 'Claro' : 'Light'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Settings button */}
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            title={isPt ? 'Configurações do RustSCP' : 'RustSCP Settings'}
            className="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-650 dark:hover:bg-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 border border-dark-600 transition-colors"
          >
            <Settings className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100" />
          </button>
        )}

        {/* About / Versioner button */}
        {onOpenAbout && (
          <button
            onClick={onOpenAbout}
            title={isPt ? 'Sobre o RustSCP (Versionador & Diagnóstico)' : 'About RustSCP (Versioner & Diagnostics)'}
            className="p-1.5 rounded-lg bg-dark-700 hover:bg-dark-650 dark:hover:bg-dark-600 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 border border-dark-600 transition-colors"
          >
            <Info className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100" />
          </button>
        )}
      </div>
    </header>
  );
};
