import React, { useState, useEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Plus, X, HardDrive, Lock, Cloud, Server, LayoutGrid, Columns2, ArrowLeftRight } from 'lucide-react';
import { ConnectionConfig } from '../types.ts';
import {
  tabDragManager,
  DraggingTabState,
  fileDragTabs,
  TabSpringState,
  SPRING_DELAY_MS,
  osDragPointToCss,
  osFileDrag,
  overlayBlocksDrop,
} from '../utils/tabDragManager.ts';
import { notify } from './ui/toast.tsx';

export interface ActiveSession {
  id: string;
  config: ConnectionConfig;
  currentPath: string;
  /** SFTP compatibility mode: the sftp-server started as a command (get_session_compat). Shown as a badge. */
  compat?: string;
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
  /** @deprecated pane labels are no longer shown; kept for compatibility. */
  paneLabel?: string;
  paneId?: 'left' | 'right';
  onMoveTab?: (sessionId: string, sourcePane: 'left' | 'right', targetPane: 'left' | 'right', targetIndex?: number) => void;
  onReorderTabs?: (pane: 'left' | 'right', fromIndex: number, toIndex: number) => void;
  /** The pane this strip belongs to has keyboard focus: its active tab gets the accent hairline. */
  isFocused?: boolean;
}

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function ProtocolIcon({ protocol, className = 'w-3.5 h-3.5' }: { protocol?: string; className?: string }) {
  const cls = `${className} shrink-0`;
  switch (protocol) {
    case 's3':
      return <Cloud className={cls} strokeWidth={1.75} />;
    case 'local':
      return <HardDrive className={cls} strokeWidth={1.75} />;
    case 'ftp':
      return <Server className={cls} strokeWidth={1.75} />;
    case 'sftp':
    case 'scp':
    default:
      return <Lock className={cls} strokeWidth={1.75} />;
  }
}

/** Finds the insertion index for `clientX` among the tabs of a strip. */
function insertionIndexIn(container: Element | null, clientX: number): number | null {
  if (!container) return null;
  const tabEls = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-index]'));
  if (tabEls.length === 0) return 0;
  for (let i = 0; i < tabEls.length; i++) {
    const rect = tabEls[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return tabEls.length;
}

/** Which pane column (rendered by DualPane with data-pane-column) is under the pointer. */
function paneUnderPointer(x: number, y: number): 'left' | 'right' | undefined {
  const cols = document.querySelectorAll<HTMLElement>('[data-pane-column]');
  for (const col of Array.from(cols)) {
    const r = col.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const id = col.dataset.paneColumn;
      if (id === 'left' || id === 'right') return id;
    }
  }
  return undefined;
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
  paneId,
  onMoveTab,
  onReorderTabs,
  isFocused = false,
}) => {
  const { t, i18n } = useTranslation();
  const [dragState, setDragState] = useState<DraggingTabState | null>(tabDragManager.getState());
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const stripId = useId();
  const pendingDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    sessionId: string;
    sessionName: string;
    protocol?: string;
    fromIndex: number;
    sourcePane: 'left' | 'right';
  } | null>(null);
  const draggingPointerRef = useRef<number | null>(null);

  // Register handlers (unregistered on cleanup so stale closures are never called)
  useEffect(() => {
    const offMove = onMoveTab ? tabDragManager.registerMoveHandler(onMoveTab) : undefined;
    const offReorder = onReorderTabs ? tabDragManager.registerReorderHandler(onReorderTabs) : undefined;
    return () => {
      offMove?.();
      offReorder?.();
    };
  }, [onMoveTab, onReorderTabs]);

  useEffect(() => tabDragManager.subscribe(setDragState), []);

  // ---- Spring-loaded tabs: files dragged onto a tab open it after a short rest; a drop on a tab
  // sends the files to that session's folder (see fileDragTabs in tabDragManager.ts).
  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;
  const onSelectRef = useRef(onSelectSession);
  onSelectRef.current = onSelectSession;
  const stripPane = variant === 'pane' ? paneId : undefined;

  useEffect(
    () =>
      fileDragTabs.register(stripId, {
        paneId: stripPane,
        isActive: (sid) => sid === activeIdRef.current,
        activate: (sid) => onSelectRef.current(sid),
      }),
    [stripId, stripPane]
  );

  const [spring, setSpring] = useState<TabSpringState | null>(null);
  useEffect(
    () =>
      fileDragTabs.subscribe((s) => {
        const mine = s && s.stripId === stripId ? s : null;
        setSpring((prev) => (prev === mine ? prev : mine));
      }),
    [stripId]
  );

  // Files from Finder/Explorer over this strip's tabs (each strip handles its own tabs)
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const tabAt = (pos: { x: number; y: number }) => {
      const { x, y } = osDragPointToCss(pos);
      const r = stripRef.current?.getBoundingClientRect();
      if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom || overlayBlocksDrop()) return null;
      const hit = fileDragTabs.hitTest(document.elementFromPoint(x, y));
      return hit && hit.stripId === stripId ? hit : null;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        // Shared drag state: a strip mounted mid-drag never sees the drag's single 'enter'
        const carriesFiles = osFileDrag.track(p);
        if (p.type === 'leave') {
          fileDragTabs.clearFrom(stripId);
          return;
        }
        if (!carriesFiles) return;
        const hit = tabAt(p.position);
        if (p.type === 'drop') {
          fileDragTabs.clearFrom(stripId);
          if (!hit || !p.paths?.length) return;
          const pt = (i18n.language || '').startsWith('pt');
          void fileDragTabs.deliver(hit, 'local', p.paths, 'ask', { sourceLabel: pt ? 'Este computador' : 'This computer' }).then((r) => {
            if (r === 'timeout') {
              notify.info(
                pt ? 'A pasta ainda está abrindo' : 'The folder is still opening',
                pt ? 'Solte de novo quando a lista aparecer.' : 'Drop again when the list appears.'
              );
            }
          });
          return;
        }
        if (hit) fileDragTabs.hover(hit);
        else fileDragTabs.clearFrom(stripId);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* drag-drop events unavailable (web preview) */
      });

    return () => {
      disposed = true;
      unlisten?.();
      fileDragTabs.clearFrom(stripId);
    };
  }, [stripId, i18n]);

  // Escape cancels an in-progress drag (listener added once per drag, not on every pointer move)
  const isDraggingFromHere = !!dragState && dragState.sourcePane === paneId;
  useEffect(() => {
    if (!isDraggingFromHere) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        pendingDragRef.current = null;
        draggingPointerRef.current = null;
        tabDragManager.cancelDrag();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isDraggingFromHere]);

  const canDrag = variant === 'pane' && !!paneId;

  const endPointer = () => {
    pendingDragRef.current = null;
    draggingPointerRef.current = null;
  };

  const handleTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, sess: ActiveSession, index: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    if (!canDrag) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    pendingDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      sessionId: sess.id,
      sessionName: sess.config.name,
      protocol: sess.config.protocol,
      fromIndex: index,
      sourcePane: paneId!,
    };
  };

  const handleTabPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Released outside the window without a pointerup: abort instead of a phantom drag
    if (e.buttons === 0 && (pendingDragRef.current || draggingPointerRef.current !== null)) {
      endPointer();
      tabDragManager.cancelDrag();
      return;
    }
    const pending = pendingDragRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      if (Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) > 4) {
        tabDragManager.startDrag({
          sessionId: pending.sessionId,
          sourcePane: pending.sourcePane,
          sessionName: pending.sessionName,
          protocol: pending.protocol,
          fromIndex: pending.fromIndex,
          cursorX: e.clientX,
          cursorY: e.clientY,
        });
        draggingPointerRef.current = e.pointerId;
        pendingDragRef.current = null;
      }
    }
    if (draggingPointerRef.current === e.pointerId && tabDragManager.isDragging()) {
      const target = paneUnderPointer(e.clientX, e.clientY);
      let idx: number | null = null;
      if (target) {
        const strip = document.querySelector(`[data-pane-tabs-id="${target}"]`);
        const r = strip?.getBoundingClientRect();
        if (strip && r && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8) {
          idx = insertionIndexIn(strip.querySelector('[data-tabs-scroller]'), e.clientX);
        }
      }
      tabDragManager.updatePointer(e.clientX, e.clientY, target, idx);
    }
  };

  const handleTabPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const pending = pendingDragRef.current;
    if (draggingPointerRef.current === e.pointerId && tabDragManager.isDragging()) {
      endPointer();
      tabDragManager.finishDrag();
      return;
    }
    if (pending && pending.pointerId === e.pointerId) {
      endPointer();
      onSelectSession(pending.sessionId);
      focusFileList();
    }
  };

  const handleTabPointerCancel = () => {
    if (pendingDragRef.current || draggingPointerRef.current !== null) {
      endPointer();
      tabDragManager.cancelDrag();
    }
  };

  const focusTabAt = (i: number) => {
    const el = tabsContainerRef.current?.querySelector<HTMLElement>(`[data-tab-index="${i}"]`);
    el?.focus();
  };

  /**
   * After a pointer selection, keyboard focus goes to the file list the tab now shows, so ⌫ (go up)
   * and Delete keep acting on files. A tab never closes from the keyboard: Backspace/Delete there
   * would disconnect the server by accident; the close button (reachable with Tab) does it.
   */
  const focusFileList = () => {
    requestAnimationFrame(() => {
      const column = variant === 'pane' && paneId ? `[data-pane-column="${paneId}"]` : '[data-pane-column]';
      document.querySelector<HTMLElement>(`${column} [role="region"][tabindex="0"]`)?.focus({ preventScroll: true });
    });
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, sess: ActiveSession, index: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectSession(sess.id);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusTabAt(Math.min(sessions.length - 1, index + 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusTabAt(Math.max(0, index - 1));
    }
  };

  // Drag state derived for this strip
  const isTargetPane = !!dragState && dragState.targetPane === paneId;
  const isSourcePane = !!dragState && dragState.sourcePane === paneId;
  const isCrossPaneHover = !!dragState && !isSourcePane && isTargetPane;
  const targetInsertionIndex = isTargetPane ? dragState?.targetIndex : null;

  const insertionLine = <div className="w-0.5 h-5 rounded-full bg-rust-500 self-center shrink-0 -mx-px" aria-hidden />;

  const viewToggle = onToggleDualPane ? (
    <div
      role="radiogroup"
      aria-label={t('sessionTabs.layout', 'Layout')}
      className="inline-flex items-center p-0.5 rounded-lg bg-dark-700 dark:bg-dark-950 border border-line shrink-0 ml-2"
    >
      {[
        { on: isDualPane, icon: <Columns2 className="w-3.5 h-3.5" />, label: t('sessionTabs.commander', 'Commander'), tip: t('sessionTabs.commanderMode', 'Commander: two panes side by side'), act: () => !isDualPane && onToggleDualPane() },
        { on: !isDualPane, icon: <LayoutGrid className="w-3.5 h-3.5" />, label: t('sessionTabs.explorer', 'Explorer'), tip: t('sessionTabs.explorerMode', 'Explorer: one pane with a sidebar'), act: () => isDualPane && onToggleDualPane() },
      ].map((o) => (
        <button
          key={o.label}
          type="button"
          role="radio"
          aria-checked={o.on}
          aria-label={o.label}
          title={o.tip}
          onClick={o.act}
          className={cx(
            'inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] font-medium transition-colors',
            o.on ? 'bg-surface-raised dark:bg-dark-650 text-ink shadow-xs' : 'text-ink-muted hover:text-ink'
          )}
        >
          {o.icon}
          <span className="hidden 2xl:inline">{o.label}</span>
        </button>
      ))}
    </div>
  ) : null;

  const renderTab = (sess: ActiveSession, idx: number) => {
    const isActive = sess.id === activeSessionId;
    const isThisTabDragging = isSourcePane && dragState?.sessionId === sess.id;
    // Files dragged over this tab: tinted; a bar fills while it is about to open
    const springHere = spring?.sessionId === sess.id ? spring : null;
    const closable = sess.id !== 'local' && !!onCloseSession;
    const otherPane = paneId === 'left' ? 'right' : 'left';

    return (
      <React.Fragment key={sess.id}>
        {isTargetPane && targetInsertionIndex === idx && insertionLine}
        <div
          role="tab"
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          data-tab-index={idx}
          data-tab-session-id={sess.id}
          onPointerDown={(e) => handleTabPointerDown(e, sess, idx)}
          onPointerMove={canDrag ? handleTabPointerMove : undefined}
          onPointerUp={canDrag ? handleTabPointerUp : undefined}
          onPointerCancel={canDrag ? handleTabPointerCancel : undefined}
          onLostPointerCapture={canDrag ? handleTabPointerCancel : undefined}
          // A click never moves focus onto the tab itself (its buttons still take focus)
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest('button')) e.preventDefault();
          }}
          onClick={
            canDrag
              ? undefined
              : () => {
                  onSelectSession(sess.id);
                  focusFileList();
                }
          }
          onKeyDown={(e) => handleTabKeyDown(e, sess, idx)}
          title={sess.config.host && sess.config.protocol !== 'local' ? `${sess.config.name} — ${sess.config.username ? `${sess.config.username}@` : ''}${sess.config.host}` : sess.config.name}
          className={cx(
            'group relative flex items-center gap-1.5 h-7 pl-2.5 rounded-md text-[12.5px] shrink-0 max-w-[220px] transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-rust-500/40',
            closable || (onMoveTab && paneId) ? 'pr-1' : 'pr-2.5',
            springHere
              ? 'bg-rust-500/10 text-ink ring-1 ring-rust-500/50'
              : isActive
              ? 'bg-surface-raised text-ink shadow-xs ring-1 ring-line dark:bg-dark-700'
              : 'text-ink-muted hover:text-ink hover:bg-dark-650/60',
            isThisTabDragging && 'opacity-40',
            canDrag ? 'cursor-default' : 'cursor-pointer'
          )}
        >
          <span className={isActive ? 'text-ink-muted' : 'text-ink-faint'}>
            <ProtocolIcon protocol={sess.config.protocol} />
          </span>
          <span className="truncate">{sess.config.name}</span>
          {sess.compat && (
            <span
              className="shrink-0 text-[10.5px] leading-4 px-1.5 rounded-full bg-surface-sunken text-ink-faint ring-1 ring-inset ring-line"
              title={t(
                'sessionTabs.compatTip',
                "This server refuses the standard SFTP subsystem, so RustSCP started {{path}} as a command. Everything works; ask the server admin to fix the 'Subsystem sftp' line in sshd_config.",
                { path: sess.compat }
              )}
            >
              {t('sessionTabs.compat', 'Compatibility')}
            </span>
          )}

          {onMoveTab && paneId && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMoveTab(sess.id, paneId, otherPane);
              }}
              aria-label={paneId === 'left' ? t('sessionTabs.moveToRight', 'Move to right pane') : t('sessionTabs.moveToLeft', 'Move to left pane')}
              title={paneId === 'left' ? t('sessionTabs.moveToRight', 'Move to right pane') : t('sessionTabs.moveToLeft', 'Move to left pane')}
              className="w-5 h-5 inline-flex items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-dark-650/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            >
              <ArrowLeftRight className="w-3 h-3" />
            </button>
          )}

          {closable && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCloseSession!(sess.id);
              }}
              aria-label={t('sessionTabs.closeTab', 'Close {{name}}', { name: sess.config.name })}
              title={t('sessionTabs.close', 'Close')}
              className={cx(
                'w-5 h-5 inline-flex items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-dark-650/80 transition-opacity focus-visible:opacity-100',
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <X className="w-3 h-3" />
            </button>
          )}

          {springHere?.springing ? (
            <span
              key={springHere.token}
              className="absolute left-2 right-2 bottom-0 h-[2px] rounded-full bg-rust-500 animate-spring-fill"
              style={{ animationDuration: `${SPRING_DELAY_MS}ms` }}
              aria-hidden
            />
          ) : (
            isActive &&
            isFocused && <span className="absolute left-2 right-2 bottom-0 h-[2px] rounded-full bg-rust-500" aria-hidden />
          )}
        </div>
      </React.Fragment>
    );
  };

  if (variant === 'pane') {
    return (
      <div
        ref={stripRef}
        data-pane-tabs-id={paneId}
        data-tab-strip-id={stripId /* TAB_STRIP_ATTR: file drags find this strip's tabs */}
        className={cx(
          'h-9 shrink-0 pl-1.5 pr-1.5 flex items-center justify-between select-none overflow-hidden relative border-b transition-colors',
          isCrossPaneHover ? 'bg-rust-500/[0.06] border-rust-500/40' : 'bg-dark-900 border-line'
        )}
      >
        <div
          ref={tabsContainerRef}
          data-tabs-scroller
          role="tablist"
          aria-label={paneId === 'left' ? t('sessionTabs.paneLeft', 'Left pane') : t('sessionTabs.paneRight', 'Right pane')}
          className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1 min-w-0 h-full"
        >
          {sessions.length === 0 && (
            <span className="px-2 text-[12px] text-ink-faint whitespace-nowrap">
              {isCrossPaneHover ? t('sessionTabs.dropTabPrompt', 'Drop the tab here') : t('sessionTabs.noTabs', 'No connection')}
            </span>
          )}

          {sessions.map(renderTab)}

          {isTargetPane && targetInsertionIndex === sessions.length && sessions.length > 0 && insertionLine}

          {onNewSession && (
            <button
              type="button"
              onClick={onNewSession}
              aria-label={t('sessionTabs.newConnectionInPane', 'New connection in this pane')}
              title={t('sessionTabs.newConnectionInPane', 'New connection in this pane')}
              className="ui-icon-btn ui-icon-btn-sm shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {viewToggle}

        {isSourcePane &&
          dragState &&
          createPortal(
            <div
              style={{
                position: 'fixed',
                left: `${dragState.cursorX + 12}px`,
                top: `${dragState.cursorY + 12}px`,
                pointerEvents: 'none',
                zIndex: 9999,
              }}
              className="flex items-center gap-2 h-7 px-2.5 rounded-lg bg-surface-raised border border-line shadow-pop text-[12px] text-ink select-none"
            >
              <span className="text-ink-faint">
                <ProtocolIcon protocol={dragState.protocol || 'sftp'} />
              </span>
              <span className="truncate max-w-[160px]">{dragState.sessionName}</span>
              <span className="text-[11px] text-ink-faint">
                {dragState.targetPane === dragState.sourcePane ? t('sessionTabs.reorder', 'Reorder') : t('sessionTabs.move', 'Move')}
              </span>
            </div>,
            document.body
          )}
      </div>
    );
  }

  // --- Global Variant (Explorer Mode) ---
  return (
    <div
      ref={stripRef}
      data-tab-strip-id={stripId /* TAB_STRIP_ATTR: file drags find this strip's tabs */}
      className="h-9 shrink-0 bg-dark-900 border-b border-line px-1.5 flex items-center justify-between select-none"
    >
      <div
        ref={tabsContainerRef}
        role="tablist"
        aria-label={t('sessionTabs.connections', 'Connections')}
        className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1 min-w-0 h-full"
      >
        {sessions.map(renderTab)}

        {onNewSession && (
          <button type="button" onClick={onNewSession} className="ui-btn ui-btn-ghost ui-btn-sm shrink-0 ml-0.5">
            <Plus className="w-3.5 h-3.5" />
            <span>{t('sessionTabs.newConnection', 'New connection')}</span>
          </button>
        )}
      </div>

      {viewToggle}
    </div>
  );
};
