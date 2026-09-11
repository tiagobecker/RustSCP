import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  ArrowLeftRight, 
  ArrowRight, 
  ArrowLeft, 
  HardDrive, 
  Home, 
  Download, 
  FileText, 
  Monitor, 
  Folder,
  Sparkles,
  Lock,
  Cloud
} from 'lucide-react';
import { FilePanel } from './FilePanel.tsx';
import { SessionTabs, ActiveSession } from './SessionTabs.tsx';
import { FileEntry, ActionDefinition, ClipboardState } from '../types.ts';

export interface DualPaneProps {
  isDualPane?: boolean;
  onToggleDualPane?: () => void;
  onOpenAiAssistant?: () => void;
  onMoveTabBetweenPanes?: (sessionId: string, sourcePane: 'left' | 'right', targetPane: 'left' | 'right', targetIndex?: number) => void;
  onReorderTabs?: (pane: 'left' | 'right', fromIndex: number, toIndex: number) => void;

  // All Sessions across app
  allSessions: ActiveSession[];

  // Left Pane Sessions & State
  leftSessions: ActiveSession[];
  leftActiveSessionId: string;
  onSelectLeftSession: (id: string) => void;
  onCloseLeftSession?: (id: string) => void;
  onNewLeftSession?: () => void;

  leftSessionName?: string;
  leftIsRemote: boolean;
  leftPath: string;
  leftFiles: FileEntry[];
  leftLoading: boolean;
  selectedLeft: string[];
  diffMap?: Record<string, string>;
  onLeftNavigate: (p: string) => void;
  onLeftRefresh: () => void;
  onSelectLeft: (p: string, multi: boolean) => void;
  onLeftNewFolder: () => void;
  onLeftDelete?: (paths?: string[], forcePermanent?: boolean) => void;
  onLeftGoHome?: () => void;

  // Right Pane Sessions & State
  rightSessions: ActiveSession[];
  rightActiveSessionId: string;
  onSelectRightSession: (id: string) => void;
  onCloseRightSession?: (id: string) => void;
  onNewRightSession?: () => void;

  rightSessionName?: string;
  rightIsRemote: boolean;
  rightPath: string;
  rightFiles: FileEntry[];
  rightLoading: boolean;
  selectedRight: string[];
  onRightNavigate: (p: string) => void;
  onRightRefresh: () => void;
  onSelectRight: (p: string, multi: boolean) => void;
  onRightNewFolder: () => void;
  onRightDelete?: (paths?: string[], forcePermanent?: boolean) => void;
  onRightGoHome?: () => void;

  // Focus
  focusedPane: 'left' | 'right';
  onFocusPane: (pane: 'left' | 'right') => void;

  // Actions & Modals
  onEditFile?: (file: FileEntry) => void;
  onShowProperties?: (file: FileEntry) => void;
  onCalculateChecksum?: (file: FileEntry) => void;
  onCalculateSize?: (file: FileEntry) => void;
  onOpenSymlink?: (file?: FileEntry) => void;
  onOpenFindFiles?: () => void;
  onOpenGenerateCode?: () => void;

  // Transfers
  onTransferLeftToRight: () => void;
  onTransferRightToLeft: () => void;
  onDropItems?: (sourceSessionId: string, paths: string[], destSessionId: string, destDir: string, isCopy: boolean) => void;

  // Clipboard & Context Menu Props
  clipboard?: ClipboardState | null;
  actionsCatalog?: ActionDefinition[];
  onCopy?: (sessionId: string, paths: string[]) => void;
  onCut?: (sessionId: string, paths: string[]) => void;
  onPaste?: (destSessionId: string, destDir: string) => void;
  onDuplicate?: (sessionId: string, path: string) => void;
  onCompress?: (sessionId: string, currentDir: string, items: string[], format: string, outputName: string) => void;
  onExtract?: (sessionId: string, currentDir: string, archivePath: string, destSubfolder?: string) => void;
  onRequestCompress?: (sessionId: string, currentDir: string, items: string[]) => void;
  onRequestExtract?: (sessionId: string, currentDir: string, archivePath: string) => void;
  onOpenTerminalHere?: (path: string, isRemote: boolean) => void;
  onOpenNativeTerminalHere?: (path: string, isRemote: boolean) => void;
  onMoveToTrash?: (sessionId: string, paths: string[]) => void;
  remoteTrashEnabled?: boolean;
  onExecuteSmartAction?: (action: ActionDefinition, targetPath: string) => void;
}

export const DualPane: React.FC<DualPaneProps> = (props) => {
  const { t } = useTranslation();
  const isDualPane = props.isDualPane ?? true;

  // In Explorer mode, selected session id
  const [explorerSessionId, setExplorerSessionId] = useState<string>(
    props.rightActiveSessionId || props.leftActiveSessionId || 'local'
  );

  // Resizable Commander Split Ratio (20% to 80%, default 50%)
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('rustscp_commander_split_ratio');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 20 && parsed <= 80) return parsed;
      }
    } catch (e) {}
    return 50;
  });
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem('rustscp_commander_split_ratio', splitRatio.toFixed(1));
    } catch (e) {}
  }, [splitRatio]);

  const handleSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const relativeX = moveEvent.clientX - rect.left;
      const newRatio = (relativeX / rect.width) * 100;
      const clamped = Math.min(Math.max(newRatio, 20), 80);
      setSplitRatio(clamped);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleSplitterDoubleClick = () => {
    setSplitRatio(50);
  };

  const getProtocolIcon = (proto: string) => {
    switch (proto) {
      case 's3':
        return <Cloud className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />;
      case 'local':
        return <HardDrive className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />;
      case 'sftp':
      case 'scp':
      default:
        return <Lock className="w-3.5 h-3.5 text-rust-600 dark:text-rust-500 shrink-0" />;
    }
  };

  const renderLeftPanel = (fullWidth = false) => (
    <FilePanel
      paneId="left"
      title={
        !props.leftActiveSessionId
          ? t('dualPane.emptyPane', 'Painel Vazio')
          : props.leftSessionName || (props.leftIsRemote ? t('dualPane.remoteServer', 'Servidor Remoto') : t('dualPane.localMachine', 'Meu Computador'))
      }
      isRemote={props.leftIsRemote}
      sessionId={props.leftActiveSessionId}
      currentPath={props.leftPath}
      files={props.leftFiles}
      loading={props.leftLoading}
      selectedFiles={props.selectedLeft}
      diffMap={props.diffMap}
      clipboard={props.clipboard}
      actionsCatalog={props.actionsCatalog}
      onNavigate={props.onLeftNavigate}
      onRefresh={props.onLeftRefresh}
      onSelectFile={props.onSelectLeft}
      onNewFolder={props.onLeftNewFolder}
      onDelete={(paths, forcePermanent) => {
        const targets = Array.isArray(paths) && paths.length > 0 ? paths : props.selectedLeft;
        props.onLeftDelete?.(targets, forcePermanent);
      }}
      onNewSession={props.onNewLeftSession}
      onEditFile={props.onEditFile}
      onShowProperties={props.onShowProperties}
      onCalculateChecksum={props.onCalculateChecksum}
      onCalculateSize={props.onCalculateSize}
      onOpenSymlink={props.onOpenSymlink}
      onOpenFindFiles={props.onOpenFindFiles}
      onOpenGenerateCode={props.onOpenGenerateCode}
      onCopy={(paths) => props.onCopy && props.onCopy(props.leftActiveSessionId, paths)}
      onCut={(paths) => props.onCut && props.onCut(props.leftActiveSessionId, paths)}
      onPaste={() => props.onPaste && props.onPaste(props.leftActiveSessionId, props.leftPath)}
      onDuplicate={(p) => props.onDuplicate && props.onDuplicate(props.leftActiveSessionId, p)}
      onCompress={(items, fmt, out) => props.onCompress && props.onCompress(props.leftActiveSessionId, props.leftPath, items, fmt, out)}
      onExtract={(arch, sub) => props.onExtract && props.onExtract(props.leftActiveSessionId, props.leftPath, arch, sub)}
      onRequestCompress={(items) => props.onRequestCompress && props.onRequestCompress(props.leftActiveSessionId, props.leftPath, items)}
      onRequestExtract={(arch) => props.onRequestExtract && props.onRequestExtract(props.leftActiveSessionId, props.leftPath, arch)}
      onOpenTerminalHere={(p) => props.onOpenTerminalHere && props.onOpenTerminalHere(p, props.leftIsRemote)}
      onOpenNativeTerminalHere={(p) => props.onOpenNativeTerminalHere && props.onOpenNativeTerminalHere(p, props.leftIsRemote)}
      onMoveToTrash={(paths) => props.onMoveToTrash && props.onMoveToTrash(props.leftActiveSessionId, paths)}
      remoteTrashEnabled={props.remoteTrashEnabled}
      onExecuteSmartAction={props.onExecuteSmartAction}
      onGoHome={props.onLeftGoHome}
      onOpenAiAssistant={props.onOpenAiAssistant}
      onDropItems={props.onDropItems}
      onTransferToOtherPane={props.onTransferLeftToRight}
      onMoveToOtherPane={props.onTransferLeftToRight}
      onFocusPanel={() => props.onFocusPane('left')}
      isFocused={!fullWidth && props.focusedPane === 'left'}
      onDropTab={(sessId, srcPane) => props.onMoveTabBetweenPanes?.(sessId, srcPane, 'left')}
    />
  );

  const renderRightPanel = (fullWidth = false) => (
    <FilePanel
      paneId="right"
      title={
        !props.rightActiveSessionId
          ? t('dualPane.emptyPane', 'Painel Vazio')
          : props.rightSessionName || (props.rightIsRemote ? t('dualPane.remoteServer', 'Servidor Remoto') : t('dualPane.localMachine', 'Meu Computador'))
      }
      isRemote={props.rightIsRemote}
      sessionId={props.rightActiveSessionId}
      currentPath={props.rightPath}
      files={props.rightFiles}
      loading={props.rightLoading}
      selectedFiles={props.selectedRight}
      diffMap={props.diffMap}
      clipboard={props.clipboard}
      actionsCatalog={props.actionsCatalog}
      onNavigate={props.onRightNavigate}
      onRefresh={props.onRightRefresh}
      onSelectFile={props.onSelectRight}
      onNewFolder={props.onRightNewFolder}
      onDelete={(paths, forcePermanent) => {
        const targets = Array.isArray(paths) && paths.length > 0 ? paths : props.selectedRight;
        props.onRightDelete?.(targets, forcePermanent);
      }}
      onNewSession={props.onNewRightSession}
      onEditFile={props.onEditFile}
      onShowProperties={props.onShowProperties}
      onCalculateChecksum={props.onCalculateChecksum}
      onCalculateSize={props.onCalculateSize}
      onOpenSymlink={props.onOpenSymlink}
      onOpenFindFiles={props.onOpenFindFiles}
      onOpenGenerateCode={props.onOpenGenerateCode}
      onCopy={(paths) => props.onCopy && props.onCopy(props.rightActiveSessionId, paths)}
      onCut={(paths) => props.onCut && props.onCut(props.rightActiveSessionId, paths)}
      onPaste={() => props.onPaste && props.onPaste(props.rightActiveSessionId, props.rightPath)}
      onDuplicate={(p) => props.onDuplicate && props.onDuplicate(props.rightActiveSessionId, p)}
      onCompress={(items, fmt, out) => props.onCompress && props.onCompress(props.rightActiveSessionId, props.rightPath, items, fmt, out)}
      onExtract={(arch, sub) => props.onExtract && props.onExtract(props.rightActiveSessionId, props.rightPath, arch, sub)}
      onRequestCompress={(items) => props.onRequestCompress && props.onRequestCompress(props.rightActiveSessionId, props.rightPath, items)}
      onRequestExtract={(arch) => props.onRequestExtract && props.onRequestExtract(props.rightActiveSessionId, props.rightPath, arch)}
      onOpenTerminalHere={(p) => props.onOpenTerminalHere && props.onOpenTerminalHere(p, props.rightIsRemote)}
      onOpenNativeTerminalHere={(p) => props.onOpenNativeTerminalHere && props.onOpenNativeTerminalHere(p, props.rightIsRemote)}
      onMoveToTrash={(paths) => props.onMoveToTrash && props.onMoveToTrash(props.rightActiveSessionId, paths)}
      remoteTrashEnabled={props.remoteTrashEnabled}
      onExecuteSmartAction={props.onExecuteSmartAction}
      onGoHome={props.onRightGoHome}
      onOpenAiAssistant={props.onOpenAiAssistant}
      onDropItems={props.onDropItems}
      onTransferToOtherPane={props.onTransferRightToLeft}
      onMoveToOtherPane={props.onTransferRightToLeft}
      onFocusPanel={() => props.onFocusPane('right')}
      isFocused={!fullWidth && props.focusedPane === 'right'}
      onDropTab={(sessId, srcPane) => props.onMoveTabBetweenPanes?.(sessId, srcPane, 'right')}
    />
  );

  // --- Commander Mode (Dual-Pane with per-pane tabs & resizable splitter) ---
  if (isDualPane) {
    return (
      <div 
        ref={containerRef}
        className={`flex-1 flex overflow-hidden relative ${isResizing ? 'select-none cursor-col-resize' : ''}`}
      >
        {/* Left Pane Column with its own dedicated Tab Bar directly above */}
        <div 
          style={{ width: `${splitRatio}%`, minWidth: '220px' }}
          className="flex flex-col min-w-0 transition-[width] duration-75"
        >
          <SessionTabs
            variant="pane"
            paneId="left"
            paneLabel={t('sessionTabs.paneLeft', 'Painel E')}
            sessions={props.leftSessions}
            activeSessionId={props.leftActiveSessionId}
            onSelectSession={props.onSelectLeftSession}
            onCloseSession={props.onCloseLeftSession}
            onNewSession={props.onNewLeftSession}
            onMoveTab={props.onMoveTabBetweenPanes}
            onReorderTabs={props.onReorderTabs}
          />
          <div className="flex-1 flex flex-col min-h-0">
            {renderLeftPanel(false)}
          </div>
        </div>

        {/* Center Draggable Splitter & Transfer Bridge */}
        <div 
          onMouseDown={handleSplitterMouseDown}
          onDoubleClick={handleSplitterDoubleClick}
          title={t('dualPane.splitterTip', 'Arraste para redimensionar os painéis (Duplo clique para 50/50)')}
          className={`group flex flex-col justify-center items-center space-y-2 px-1 z-10 shrink-0 bg-slate-100 dark:bg-dark-900 border-x border-slate-200 dark:border-dark-800 py-4 cursor-col-resize select-none relative transition-colors ${
            isResizing 
              ? 'bg-rust-500/15 border-rust-500 ring-1 ring-rust-500/50' 
              : 'hover:bg-slate-200/80 dark:hover:bg-dark-800'
          }`}
        >
          {/* Top grip indicator */}
          <div className="w-1.5 h-6 rounded-full bg-slate-300 dark:bg-dark-600 group-hover:bg-rust-500 transition-colors" />

          {/* Transfer buttons (with stopPropagation so clicks transfer rather than resize) */}
          <div 
            className="flex flex-col space-y-2 pointer-events-auto"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={props.onTransferLeftToRight}
              disabled={props.selectedLeft.length === 0 || !props.rightActiveSessionId}
              title={t('dualPane.transferToRight', 'Transferir para o Painel Direito (F5)')}
              className="p-2 rounded-full bg-white hover:bg-rust-600 dark:bg-dark-700 dark:hover:bg-rust-600 text-slate-700 dark:text-slate-300 hover:text-white dark:hover:text-white disabled:opacity-30 disabled:hover:bg-white dark:disabled:hover:bg-dark-700 transition-all shadow-md border border-slate-300 dark:border-dark-600 hover:border-rust-500 cursor-pointer"
            >
              <ArrowRight className="w-4 h-4" />
            </button>

            <div className="p-1 rounded-full bg-slate-200 dark:bg-dark-800 border border-slate-300 dark:border-dark-700 text-rust-600 dark:text-mcp-cyan shadow-xs flex items-center justify-center">
              <ArrowLeftRight className="w-3.5 h-3.5" />
            </div>

            <button
              onClick={props.onTransferRightToLeft}
              disabled={props.selectedRight.length === 0 || !props.leftActiveSessionId}
              title={t('dualPane.transferToLeft', 'Transferir para o Painel Esquerdo (F5)')}
              className="p-2 rounded-full bg-white hover:bg-rust-600 dark:bg-dark-700 dark:hover:bg-rust-600 text-slate-700 dark:text-slate-300 hover:text-white dark:hover:text-white disabled:opacity-30 disabled:hover:bg-white dark:disabled:hover:bg-dark-700 transition-all shadow-md border border-slate-300 dark:border-dark-600 hover:border-rust-500 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          </div>

          {/* Bottom grip indicator */}
          <div className="w-1.5 h-6 rounded-full bg-slate-300 dark:bg-dark-600 group-hover:bg-rust-500 transition-colors" />

          {/* Split ratio pill badge on hover/resize */}
          <div className={`absolute bottom-2 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-dark-950 text-white text-[9px] font-mono whitespace-nowrap z-20 shadow-md transition-opacity pointer-events-none ${
            isResizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}>
            {splitRatio.toFixed(0)}% / {(100 - splitRatio).toFixed(0)}%
          </div>
        </div>

        {/* Right Pane Column with its own dedicated Tab Bar directly above */}
        <div 
          style={{ width: `${100 - splitRatio}%`, minWidth: '220px' }}
          className="flex flex-col min-w-0 transition-[width] duration-75"
        >
          <SessionTabs
            variant="pane"
            paneId="right"
            paneLabel={t('sessionTabs.paneRight', 'Painel D')}
            sessions={props.rightSessions}
            activeSessionId={props.rightActiveSessionId}
            onSelectSession={props.onSelectRightSession}
            onCloseSession={props.onCloseRightSession}
            onNewSession={props.onNewRightSession}
            onMoveTab={props.onMoveTabBetweenPanes}
            onReorderTabs={props.onReorderTabs}
            isDualPane={isDualPane}
            onToggleDualPane={props.onToggleDualPane}
          />
          <div className="flex-1 flex flex-col min-h-0">
            {renderRightPanel(false)}
          </div>
        </div>
      </div>
    );
  }

  // --- Explorer Mode (Finder style single view with environments sidebar) ---
  return (
    <div className="flex-1 flex overflow-hidden relative">
      {/* macOS-style Sidebar */}
      <aside className="w-60 bg-slate-50 dark:bg-dark-950/70 border-r border-slate-200 dark:border-dark-700/80 flex flex-col justify-between select-none shrink-0 text-xs">
        <div className="p-3 space-y-4 overflow-y-auto">
          {/* Connected Environments / Sessions Guide */}
          <div className="space-y-1">
            <div className="flex items-center justify-between px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <span>{t('dualPane.connectedEnvironments', 'Ambientes Conectados')}</span>
              <span className="font-mono">{props.allSessions.length}</span>
            </div>

            <div className="space-y-1">
              {props.allSessions.map((sess) => {
                const isSelected = explorerSessionId === sess.id;
                return (
                  <button
                    key={sess.id}
                    onClick={() => {
                      setExplorerSessionId(sess.id);
                      if (sess.id === props.leftActiveSessionId) {
                        props.onFocusPane('left');
                      } else {
                        props.onSelectRightSession(sess.id);
                        props.onFocusPane('right');
                      }
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg transition-colors text-left ${
                      isSelected
                        ? 'bg-sky-500/15 dark:bg-sky-600/25 border border-sky-500/30 text-sky-950 dark:text-sky-200 font-bold shadow-sm'
                        : 'text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-dark-700/60'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      {getProtocolIcon(sess.config.protocol)}
                      <span className="truncate font-medium">{sess.config.name}</span>
                    </div>
                    <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-200 dark:bg-dark-800 text-slate-600 dark:text-slate-400 shrink-0">
                      {sess.config.protocol}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quick Access / Favoritos */}
          <div className="space-y-1 pt-2 border-t border-slate-200 dark:border-dark-700/60">
            <span className="px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {t('dualPane.favorites', 'Favoritos')}
            </span>
            <button
              onClick={() => {
                if (props.onLeftGoHome) props.onLeftGoHome();
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-dark-800/80 transition-colors font-medium"
            >
              <Home className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
              <span>{t('dualPane.home', 'Início (Home)')}</span>
            </button>
            <button
              onClick={() => {
                props.onLeftNavigate('~/Downloads');
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-dark-800/80 transition-colors font-medium"
            >
              <Download className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>{t('dualPane.downloads', 'Downloads')}</span>
            </button>
            <button
              onClick={() => {
                props.onLeftNavigate('~/Documents');
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-dark-800/80 transition-colors font-medium"
            >
              <FileText className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <span>{t('dualPane.documents', 'Documentos')}</span>
            </button>
            <button
              onClick={() => {
                props.onLeftNavigate('~/Desktop');
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-dark-800/80 transition-colors font-medium"
            >
              <Monitor className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{t('dualPane.desktop', 'Mesa (Desktop)')}</span>
            </button>
            <button
              onClick={() => {
                props.onLeftNavigate('/');
              }}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-dark-800/80 transition-colors font-medium"
            >
              <Folder className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
              <span>{t('dualPane.localRoot', 'Raiz Local (/)')}</span>
            </button>
          </div>
        </div>

        {/* Sidebar Footer */}
        <div className="p-3 border-t border-slate-200 dark:border-dark-700/80">
          {props.onOpenAiAssistant && (
            <button
              onClick={props.onOpenAiAssistant}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-gradient-to-r from-sky-500/15 to-purple-500/15 border border-sky-500/40 text-sky-950 dark:text-sky-200 hover:text-sky-950 dark:hover:text-white hover:from-sky-500/25 hover:to-purple-500/25 transition-all text-xs font-bold shadow-sm"
            >
              <Sparkles className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 animate-pulse" />
              <span>{t('dualPane.aiAssistant', 'Assistente IA')}</span>
            </button>
          )}
        </div>
      </aside>

      {/* Main Single-Pane Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {explorerSessionId === props.leftActiveSessionId ? renderLeftPanel(true) : renderRightPanel(true)}
      </div>
    </div>
  );
};
