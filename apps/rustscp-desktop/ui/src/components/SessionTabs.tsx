import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { 
  Plus, 
  X, 
  HardDrive, 
  Lock, 
  Cloud, 
  LayoutGrid, 
  Columns2,
  ArrowLeftRight
} from 'lucide-react';
import { ConnectionConfig } from '../types.ts';
import { tabDragManager, DraggingTabState } from '../utils/tabDragManager.ts';

export interface ActiveSession {
  id: string;
  config: ConnectionConfig;
  currentPath: string;
}

interface SessionTabsProps {
  sessions: ActiveSession[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onCloseSession?: (id: string) => void;
  onNewSession?: () => void;
  isDualPane?: boolean;
  onToggleDualPane?: () => void;
  variant?: 'global' | 'pane';
  paneLabel?: string;
  paneId?: 'left' | 'right';
  onMoveTab?: (sessionId: string, sourcePane: 'left' | 'right', targetPane: 'left' | 'right', targetIndex?: number) => void;
  onReorderTabs?: (pane: 'left' | 'right', fromIndex: number, toIndex: number) => void;
}

export const SessionTabs: React.FC<SessionTabsProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
  isDualPane = true,
  onToggleDualPane,
  variant = 'global',
  paneLabel,
  paneId,
  onMoveTab,
  onReorderTabs,
}) => {
  const { t } = useTranslation();
  const [dragState, setDragState] = useState<DraggingTabState | null>(tabDragManager.getState());
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const pendingDragRef = useRef<{
    startX: number;
    startY: number;
    sessionId: string;
    sessionName: string;
    protocol?: string;
    fromIndex: number;
    sourcePane: 'left' | 'right';
  } | null>(null);

  // Register handlers and subscribe to drag manager updates
  useEffect(() => {
    if (onMoveTab) {
      tabDragManager.registerMoveHandler(onMoveTab);
    }
    if (onReorderTabs) {
      tabDragManager.registerReorderHandler(onReorderTabs);
    }
    return tabDragManager.subscribe((state) => {
      setDragState(state);
    });
  }, [onMoveTab, onReorderTabs]);

  // Calculate target insertion index based on mouse X coordinate
  const calculateInsertionIndex = (clientX: number): number => {
    if (!tabsContainerRef.current) return sessions.length;
    const tabEls = Array.from(tabsContainerRef.current.querySelectorAll<HTMLElement>('[data-tab-index]'));
    if (tabEls.length === 0) return 0;

    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      const midPoint = rect.left + rect.width / 2;
      if (clientX < midPoint) {
        return i;
      }
    }
    return tabEls.length;
  };

  // Pointer Down on a tab
  const handleTabPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    sess: ActiveSession,
    index: number
  ) => {
    // Only primary mouse button
    if (e.button !== 0) return;
    // Don't drag if clicking buttons inside tab (close, transfer)
    if ((e.target as HTMLElement).closest('button')) return;

    const sourcePane: 'left' | 'right' = paneId || 'left';
    pendingDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      sessionId: sess.id,
      sessionName: sess.config.name,
      protocol: sess.config.protocol,
      fromIndex: index,
      sourcePane,
    };

    const handleWindowPointerMove = (moveEv: PointerEvent) => {
      if (pendingDragRef.current) {
        const dist = Math.hypot(
          moveEv.clientX - pendingDragRef.current.startX,
          moveEv.clientY - pendingDragRef.current.startY
        );

        if (dist > 4) {
          // Threshold passed: initiate drag session
          tabDragManager.startDrag({
            sessionId: pendingDragRef.current.sessionId,
            sourcePane: pendingDragRef.current.sourcePane,
            sessionName: pendingDragRef.current.sessionName,
            protocol: pendingDragRef.current.protocol,
            fromIndex: pendingDragRef.current.fromIndex,
            cursorX: moveEv.clientX,
            cursorY: moveEv.clientY,
          });
          pendingDragRef.current = null;
        }
      }

      if (tabDragManager.isDragging()) {
        // Calculate split point
        const ratioStr = localStorage.getItem('rustscp_commander_split_ratio') || '50';
        const ratio = Math.min(Math.max(parseFloat(ratioStr) || 50, 20), 80) / 100;
        const splitX = window.innerWidth * ratio;
        const currentTargetPane: 'left' | 'right' = moveEv.clientX < splitX ? 'left' : 'right';

        // Check if cursor is over this pane's tab strip
        let targetIdx: number | null = null;
        if (paneId === currentTargetPane && tabsContainerRef.current) {
          targetIdx = calculateInsertionIndex(moveEv.clientX);
        }

        tabDragManager.updatePointer(moveEv.clientX, moveEv.clientY, currentTargetPane, targetIdx);
      }
    };

    const handleWindowPointerUp = () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);

      if (tabDragManager.isDragging()) {
        tabDragManager.finishDrag();
      } else if (pendingDragRef.current) {
        // Click without drag: select tab
        onSelectSession(pendingDragRef.current.sessionId);
        pendingDragRef.current = null;
      }
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
  };

  const getIcon = (proto: string) => {
    switch (proto) {
      case 's3':
        return <Cloud className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />;
      case 'local':
        return <HardDrive className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />;
      case 'sftp':
      case 'scp':
      default:
        return <Lock className="w-3.5 h-3.5 text-rust-500 shrink-0" />;
    }
  };

  // State calculations
  const isDraggingAnyTab = !!dragState;
  const isTargetPane = dragState?.targetPane === paneId;
  const isSourcePane = dragState?.sourcePane === paneId;
  const isCrossPaneHover = isDraggingAnyTab && !isSourcePane && isTargetPane;
  const targetInsertionIndex = isTargetPane ? dragState?.targetIndex : null;

  if (variant === 'pane') {
    const defaultPaneName = paneId === 'left' 
      ? t('sessionTabs.paneLeft', 'Painel E') 
      : t('sessionTabs.paneRight', 'Painel D');

    return (
      <div 
        data-pane-tabs-id={paneId}
        className={`h-9 px-2 flex items-center justify-between select-none overflow-hidden transition-all duration-150 relative ${
          isCrossPaneHover
            ? 'bg-sky-50/80 dark:bg-sky-950/50 border-2 border-dashed border-sky-500/80 dark:border-sky-400 shadow-sm'
            : 'bg-slate-100 dark:bg-dark-900 border-b border-slate-300 dark:border-dark-700/80'
        }`}
      >
        {/* Pane Tabs & Insertion Indicators */}
        <div 
          ref={tabsContainerRef}
          className="flex items-center space-x-1 overflow-x-auto no-scrollbar flex-1 mr-2 relative min-h-[32px]"
        >
          <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mr-1 tracking-wider shrink-0">
            {paneLabel || defaultPaneName}
          </span>

          {sessions.length === 0 && (
            <div className="flex items-center space-x-1 text-slate-400 text-[11px] italic px-2 py-0.5">
              {isCrossPaneHover ? (
                <div className="flex items-center space-x-1 text-sky-600 dark:text-sky-300 font-bold animate-pulse">
                  <ArrowLeftRight className="w-3 h-3" />
                  <span>{t('sessionTabs.dropTabPrompt', 'Solte a aba aqui')}</span>
                </div>
              ) : (
                <span>{t('dualPane.emptyPane', 'Painel Vazio')}</span>
              )}
            </div>
          )}

          {sessions.map((sess, idx) => {
            const isActive = sess.id === activeSessionId;
            const isThisTabDragging = isSourcePane && dragState?.sessionId === sess.id;
            const showInsertionBefore = isTargetPane && targetInsertionIndex === idx;

            return (
              <React.Fragment key={sess.id}>
                {/* Vertical Insertion Line Indicator Before Tab */}
                {showInsertionBefore && (
                  <div className="w-1 h-6 rounded-full bg-rust-500 ring-2 ring-rust-400 shadow-[0_0_8px_rgba(234,88,12,0.8)] -mx-0.5 z-30 self-center animate-pulse shrink-0" />
                )}

                <div
                  data-tab-index={idx}
                  data-tab-session-id={sess.id}
                  onPointerDown={(e) => handleTabPointerDown(e, sess, idx)}
                  title={`${sess.config.name} — ${t('sessionTabs.dragTabTip', 'Arraste para reordenar ou mover para o outro painel')}`}
                  className={`group flex items-center space-x-1.5 px-2.5 py-1 rounded-t text-xs font-medium cursor-grab active:cursor-grabbing transition-all border-t-2 shrink-0 ${
                    isThisTabDragging
                      ? 'opacity-30 border-dashed border-rust-500 scale-95 pointer-events-none'
                      : isActive
                      ? 'bg-white dark:bg-dark-800 text-slate-950 dark:text-slate-100 border-rust-500 shadow-sm font-semibold'
                      : 'bg-slate-200/60 dark:bg-dark-900/50 text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-dark-850 border-transparent'
                  }`}
                >
                  {getIcon(sess.config.protocol)}
                  <span className="truncate max-w-[120px]">{sess.config.name}</span>
                  
                  {/* Quick 1-Click Transfer Button */}
                  {onMoveTab && paneId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const target = paneId === 'left' ? 'right' : 'left';
                        onMoveTab(sess.id, paneId, target);
                      }}
                      title={paneId === 'left' 
                        ? t('sessionTabs.moveToRight', 'Mover para o Painel Direito (D)') 
                        : t('sessionTabs.moveToLeft', 'Mover para o Painel Esquerdo (E)')}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-sky-200 dark:hover:bg-sky-900/60 text-slate-400 hover:text-sky-600 dark:hover:text-sky-300 transition-all cursor-pointer"
                    >
                      <ArrowLeftRight className="w-2.5 h-2.5" />
                    </button>
                  )}

                  {sess.id !== 'local' && onCloseSession && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseSession(sess.id);
                      }}
                      className="p-0.5 rounded hover:bg-slate-300 dark:hover:bg-dark-700 text-slate-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
              </React.Fragment>
            );
          })}

          {/* Vertical Insertion Line Indicator After Last Tab */}
          {isTargetPane && targetInsertionIndex === sessions.length && (
            <div className="w-1 h-6 rounded-full bg-rust-500 ring-2 ring-rust-400 shadow-[0_0_8px_rgba(234,88,12,0.8)] -mx-0.5 z-30 self-center animate-pulse shrink-0" />
          )}

          {/* New Session in this Pane */}
          {onNewSession && (
            <button
              onClick={onNewSession}
              title={t('sessionTabs.newConnectionInPane', 'Nova Conexão neste Painel')}
              className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white bg-slate-200 hover:bg-slate-300 dark:bg-dark-800 dark:hover:bg-dark-700 border border-slate-300 dark:border-dark-700 transition-colors shrink-0 ml-0.5"
            >
              <Plus className="w-3 h-3 text-rust-500" />
              <span>{t('sessionTabs.connect', 'Conectar')}</span>
            </button>
          )}
        </div>

        {/* View Mode Segmented Control: Commander vs Explorer */}
        {onToggleDualPane && (
          <div className="flex items-center bg-slate-200/70 dark:bg-dark-900/80 p-0.5 rounded-lg border border-slate-300 dark:border-dark-700/80 text-xs shrink-0 ml-2">
            <button
              onClick={() => !isDualPane && onToggleDualPane()}
              title={t('sessionTabs.commanderMode', 'Modo Commander: Dois painéis lado a lado')}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded-md font-medium text-[11px] transition-all ${
                isDualPane
                  ? 'bg-white dark:bg-rust-500/20 border border-slate-300 dark:border-rust-500/40 text-rust-700 dark:text-rust-300 shadow-sm font-bold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200'
              }`}
            >
              <Columns2 className="w-3 h-3" />
              <span>Commander</span>
            </button>
            <button
              onClick={() => isDualPane && onToggleDualPane()}
              title={t('sessionTabs.explorerMode', 'Modo Explorer: Gerenciador de arquivos único estilo Finder')}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded-md font-medium text-[11px] transition-all ${
                !isDualPane
                  ? 'bg-white dark:bg-rust-500/20 border border-slate-300 dark:border-rust-500/40 text-rust-700 dark:text-rust-300 shadow-sm font-bold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200'
              }`}
            >
              <LayoutGrid className="w-3 h-3" />
              <span>Explorer</span>
            </button>
          </div>
        )}

        {/* Floating Drag Ghost Portal (Rendered once per active drag) */}
        {isSourcePane && dragState && createPortal(
          <div 
            style={{ 
              position: 'fixed',
              left: `${dragState.cursorX + 12}px`, 
              top: `${dragState.cursorY + 12}px`,
              pointerEvents: 'none',
              zIndex: 9999,
            }}
            className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-dark-900/95 text-white border border-rust-500 shadow-2xl backdrop-blur-md scale-105 font-semibold text-xs select-none"
          >
            {getIcon(dragState.protocol || 'sftp')}
            <span className="truncate max-w-[140px]">{dragState.sessionName}</span>
            <span className="text-[10px] bg-rust-500/30 text-rust-300 px-1.5 py-0.5 rounded border border-rust-500/40 font-mono">
              {dragState.targetPane === dragState.sourcePane 
                ? (t('sessionTabs.reorder', 'Reordenar'))
                : (t('sessionTabs.move', 'Mover'))}
            </span>
          </div>,
          document.body
        )}
      </div>
    );
  }

  // --- Global Variant (Explorer Mode) ---
  return (
    <div className="h-9 bg-slate-100 dark:bg-dark-900 border-b border-slate-300 dark:border-dark-700/80 px-2 flex items-center justify-between select-none">
      <div 
        ref={tabsContainerRef}
        className="flex items-center space-x-1 overflow-x-auto max-w-4xl no-scrollbar"
      >
        {sessions.map((sess, idx) => {
          const isActive = sess.id === activeSessionId;
          const showInsertionBefore = dragState && dragState.targetIndex === idx;

          return (
            <React.Fragment key={sess.id}>
              {showInsertionBefore && (
                <div className="w-1 h-6 rounded-full bg-rust-500 ring-2 ring-rust-400 shadow-[0_0_8px_rgba(234,88,12,0.8)] -mx-0.5 z-30 self-center animate-pulse shrink-0" />
              )}

              <div
                data-tab-index={idx}
                data-tab-session-id={sess.id}
                onPointerDown={(e) => handleTabPointerDown(e, sess, idx)}
                className={`group flex items-center space-x-2 px-3 py-1.5 rounded-t text-xs font-medium cursor-grab active:cursor-grabbing transition-all border-t-2 ${
                  isActive
                    ? 'bg-white dark:bg-dark-800 text-slate-950 dark:text-slate-100 border-rust-500 shadow-sm font-semibold'
                    : 'bg-slate-200/60 dark:bg-dark-900/50 text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-dark-850 border-transparent'
                }`}
              >
                {getIcon(sess.config.protocol)}
                <span className="truncate max-w-[140px]">{sess.config.name}</span>
                {sess.id !== 'local' && onCloseSession && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseSession(sess.id);
                    }}
                    className="p-0.5 rounded hover:bg-slate-300 dark:hover:bg-dark-700 text-slate-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </React.Fragment>
          );
        })}

        {/* Insertion Line after last tab in global mode */}
        {dragState && dragState.targetIndex === sessions.length && (
          <div className="w-1 h-6 rounded-full bg-rust-500 ring-2 ring-rust-400 shadow-[0_0_8px_rgba(234,88,12,0.8)] -mx-0.5 z-30 self-center animate-pulse shrink-0" />
        )}

        {/* New Session Button */}
        {onNewSession && (
          <button
            onClick={onNewSession}
            title={t('loginDialog.newConnection', 'Nova Conexão')}
            className="flex items-center space-x-1 px-2.5 py-1 rounded text-xs font-semibold text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white bg-slate-200 hover:bg-slate-300 dark:bg-dark-800 dark:hover:bg-dark-700 border border-slate-300 dark:border-dark-700 transition-colors ml-1"
          >
            <Plus className="w-3.5 h-3.5 text-rust-500" />
            <span>{t('loginDialog.newConnection', 'Nova Conexão')}</span>
          </button>
        )}
      </div>

      {/* View Mode Segmented Control: Commander vs Explorer */}
      {onToggleDualPane && (
        <div className="flex items-center bg-slate-200/70 dark:bg-dark-900/80 p-0.5 rounded-lg border border-slate-300 dark:border-dark-700/80 text-xs">
          <button
            onClick={() => !isDualPane && onToggleDualPane()}
            title={t('sessionTabs.commanderMode', 'Modo Commander: Dois painéis lado a lado para transferências rápidas')}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-md font-medium transition-all ${
              isDualPane
                ? 'bg-white dark:bg-rust-500/20 border border-slate-300 dark:border-rust-500/40 text-rust-700 dark:text-rust-300 shadow-sm font-bold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200'
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" />
            <span>Commander</span>
          </button>
          <button
            onClick={() => isDualPane && onToggleDualPane()}
            title={t('sessionTabs.explorerMode', 'Modo Explorer: Gerenciador de arquivos intuitivo estilo macOS Finder')}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-md font-medium transition-all ${
              !isDualPane
                ? 'bg-white dark:bg-rust-500/20 border border-slate-300 dark:border-rust-500/40 text-rust-700 dark:text-rust-300 shadow-sm font-bold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Explorer</span>
          </button>
        </div>
      )}
    </div>
  );
};
