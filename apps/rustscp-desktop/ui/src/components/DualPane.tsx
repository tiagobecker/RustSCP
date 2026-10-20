import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ArrowLeft, HardDrive, Home, Download, FileText, Monitor, Folder, Sparkles, Plus } from 'lucide-react';
import { FilePanel } from './FilePanel.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { SessionTabs, ActiveSession, ProtocolIcon } from './SessionTabs.tsx';
import { FileEntry, ActionDefinition, ClipboardState, PaneId } from '../types.ts';
import { tabDragManager } from '../utils/tabDragManager.ts';
import { joinPath } from '../utils/paths.ts';

export interface DualPaneProps {
  isDualPane?: boolean;
  onToggleDualPane?: () => void;
  /** Called with the pane the request came from (toolbar button in a pane, or the Explorer sidebar). */
  onOpenAiAssistant?: (pane?: PaneId) => void;
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
  /** Per-pane diff badges (preferred over `diffMap` when given). */
  leftDiffMap?: Record<string, string>;
  rightDiffMap?: Record<string, string>;
  onLeftNavigate: (p: string) => void;
  onLeftRefresh: () => void;
  onSelectLeft: (p: string, multi: boolean) => void;
  /** Replaces the left selection in one update (⌘A, range select). Falls back to onSelectLeft calls. */
  onSetLeftSelection?: (paths: string[]) => void;
  onLeftNewFolder: () => void;
  onLeftDelete?: (paths?: string[], forcePermanent?: boolean) => void;
  onLeftGoHome?: () => void;
  leftFilterText?: string;

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
  /** Replaces the right selection in one update (⌘A, range select). Falls back to onSelectRight calls. */
  onSetRightSelection?: (paths: string[]) => void;
  onRightNewFolder: () => void;
  onRightDelete?: (paths?: string[], forcePermanent?: boolean) => void;
  onRightGoHome?: () => void;
  rightFilterText?: string;

  // Focus
  focusedPane: 'left' | 'right';
  onFocusPane: (pane: 'left' | 'right') => void;

  // Actions & Modals. The trailing session id / pane identify where the file came from.
  onEditFile?: (file: FileEntry, sessionId?: string, pane?: PaneId) => void;
  /** Rename (F2 / context menu); `currentDir` is the folder the pane shows. */
  onRenameFile?: (file: FileEntry, sessionId: string, pane?: PaneId, currentDir?: string) => void;
  /**
   * Rename in place in the file list (F2, context menu, slow second click). Resolves false when
   * the name must be fixed (the field stays open). `onRenameFile` stays the dialog fallback.
   */
  onRenameInline?: (file: FileEntry, newName: string, sessionId: string, pane?: PaneId, currentDir?: string) => Promise<boolean>;
  onShowProperties?: (file: FileEntry, sessionId?: string, pane?: PaneId) => void;
  onCalculateChecksum?: (file: FileEntry, sessionId?: string, pane?: PaneId) => void;
  onCalculateSize?: (file: FileEntry, sessionId?: string, pane?: PaneId) => void;
  onOpenSymlink?: (file?: FileEntry, sessionId?: string, pane?: PaneId, currentDir?: string) => void;
  onOpenFindFiles?: (pane?: PaneId) => void;
  onOpenGenerateCode?: (pane?: PaneId) => void;

  // Transfers
  onTransferLeftToRight: () => void;
  onTransferRightToLeft: () => void;
  /** F6 "move to other pane" (a real move: the source is removed after copying). F6 is off when omitted. */
  onMoveLeftToRight?: () => void;
  onMoveRightToLeft?: () => void;
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
  onOpenTerminalHere?: (path: string, isRemote: boolean, sessionId?: string, pane?: PaneId) => void;
  onOpenNativeTerminalHere?: (path: string, isRemote: boolean, sessionId?: string, pane?: PaneId) => void;
  onMoveToTrash?: (sessionId: string, paths: string[]) => void;
  remoteTrashEnabled?: boolean;
  onExecuteSmartAction?: (action: ActionDefinition, targetPath: string, sessionId?: string, pane?: PaneId) => void;

  // Explorer mode
  /** Shows a session in Explorer mode (App decides which pane holds it). */
  onSelectExplorerSession?: (sessionId: string) => void;
  /** Home folder of this computer, used by the Explorer favorites. */
  localHomePath?: string;
  /** Opens a folder of this computer in the visible pane. */
  onOpenLocalFolder?: (path: string) => void;
}

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

const SPLIT_KEY = 'rustscp_commander_split_ratio';
const clampRatio = (r: number) => Math.min(Math.max(r, 20), 80);

function readInitialSplit(): number {
  try {
    const saved = localStorage.getItem(SPLIT_KEY);
    if (saved) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed >= 20 && parsed <= 80) return parsed;
    }
  } catch {
    // storage unavailable
  }
  return 50;
}

type LatestProps = React.MutableRefObject<DualPaneProps>;

/**
 * Builds the per-pane callbacks handed to FilePanel once per pane. They read the latest props at
 * call time, so their identities never change (FilePanel/rows can skip re-renders) and each action
 * carries the session id and directory of the pane it came from.
 */
function usePaneHandlers(pane: PaneId, latest: LatestProps) {
  return useMemo(() => {
    const p = () => latest.current;
    const L = pane === 'left';
    const sid = () => (L ? p().leftActiveSessionId : p().rightActiveSessionId);
    const dir = () => (L ? p().leftPath : p().rightPath);
    const remote = () => (L ? p().leftIsRemote : p().rightIsRemote);
    const selected = () => (L ? p().selectedLeft : p().selectedRight);
    return {
      navigate: (np: string) => (L ? p().onLeftNavigate : p().onRightNavigate)(np),
      refresh: () => (L ? p().onLeftRefresh : p().onRightRefresh)(),
      select: (fp: string, multi: boolean) => (L ? p().onSelectLeft : p().onSelectRight)(fp, multi),
      setSelection: (paths: string[]) => (L ? p().onSetLeftSelection : p().onSetRightSelection)?.(paths),
      newFolder: () => (L ? p().onLeftNewFolder : p().onRightNewFolder)(),
      remove: (paths?: string[], forcePermanent?: boolean) => {
        const targets = Array.isArray(paths) && paths.length > 0 ? paths : selected();
        (L ? p().onLeftDelete : p().onRightDelete)?.(targets, forcePermanent);
      },
      newSession: () => (L ? p().onNewLeftSession : p().onNewRightSession)?.(),
      goHome: () => (L ? p().onLeftGoHome : p().onRightGoHome)?.(),
      editFile: (f: FileEntry) => p().onEditFile?.(f, sid(), pane),
      rename: (f: FileEntry) => p().onRenameFile?.(f, sid(), pane, dir()),
      renameInline: (f: FileEntry, name: string) => p().onRenameInline?.(f, name, sid(), pane, dir()) ?? Promise.resolve(true),
      showProperties: (f: FileEntry) => p().onShowProperties?.(f, sid(), pane),
      checksum: (f: FileEntry) => p().onCalculateChecksum?.(f, sid(), pane),
      size: (f: FileEntry) => p().onCalculateSize?.(f, sid(), pane),
      symlink: (f?: FileEntry) => p().onOpenSymlink?.(f, sid(), pane, dir()),
      findFiles: () => p().onOpenFindFiles?.(pane),
      generateCode: () => p().onOpenGenerateCode?.(pane),
      copy: (paths: string[]) => p().onCopy?.(sid(), paths),
      cut: (paths: string[]) => p().onCut?.(sid(), paths),
      paste: () => p().onPaste?.(sid(), dir()),
      duplicate: (fp: string) => p().onDuplicate?.(sid(), fp),
      compress: (items: string[], fmt: string, out: string) => p().onCompress?.(sid(), dir(), items, fmt, out),
      extract: (arch: string, sub?: string) => p().onExtract?.(sid(), dir(), arch, sub),
      requestCompress: (items: string[]) => p().onRequestCompress?.(sid(), dir(), items),
      requestExtract: (arch: string) => p().onRequestExtract?.(sid(), dir(), arch),
      terminalHere: (tp: string) => p().onOpenTerminalHere?.(tp, remote(), sid(), pane),
      nativeTerminalHere: (tp: string) => p().onOpenNativeTerminalHere?.(tp, remote(), sid(), pane),
      moveToTrash: (paths: string[]) => p().onMoveToTrash?.(sid(), paths),
      smartAction: (a: ActionDefinition, tp: string) => p().onExecuteSmartAction?.(a, tp, sid(), pane),
      aiAssistant: () => p().onOpenAiAssistant?.(pane),
      dropItems: (srcSid: string, paths: string[], dstSid: string, destDir: string, isCopy: boolean) =>
        p().onDropItems?.(srcSid, paths, dstSid, destDir, isCopy),
      transferToOther: () => (L ? p().onTransferLeftToRight : p().onTransferRightToLeft)(),
      moveToOther: () => (L ? p().onMoveLeftToRight : p().onMoveRightToLeft)?.(),
      focus: () => p().onFocusPane(pane),
      dropTab: (sessId: string, srcPane: 'left' | 'right') => p().onMoveTabBetweenPanes?.(sessId, srcPane, pane),
    };
  }, [pane, latest]);
}

const EmptyPane: React.FC<{ onConnect?: () => void; highlight?: boolean; onFocus?: () => void }> = ({ onConnect, highlight, onFocus }) => {
  const { t } = useTranslation();
  return (
    <div
      onMouseDown={onFocus}
      className={cx(
        'flex-1 flex flex-col items-center justify-center text-center px-8 m-1 rounded-lg border border-dashed transition-colors select-none',
        highlight ? 'border-rust-500/50 bg-rust-500/[0.04]' : 'border-line bg-transparent'
      )}
    >
      <div className="w-10 h-10 rounded-xl bg-surface-sunken border border-line flex items-center justify-center mb-3">
        <HardDrive className="w-[18px] h-[18px] text-ink-faint" strokeWidth={1.5} />
      </div>
      <div className="text-[13px] font-medium text-ink">
        {highlight ? t('dualPane.dropTabHere', 'Drop the tab to open it here') : t('dualPane.emptyPaneTitle', 'No connection in this pane')}
      </div>
      {!highlight && (
        <p className="text-[12px] text-ink-muted mt-1 max-w-[280px] leading-relaxed">
          {t('dualPane.emptyPaneDesc', 'Connect to a server or drag a tab here.')}
        </p>
      )}
      {onConnect && !highlight && (
        <button type="button" onClick={onConnect} className="ui-btn ui-btn-primary ui-btn-sm mt-4">
          <Plus className="w-3.5 h-3.5" />
          <span>{t('sessionTabs.connect', 'Connect')}</span>
        </button>
      )}
    </div>
  );
};

const DualPaneImpl: React.FC<DualPaneProps> = (props) => {
  const { t } = useTranslation();
  const isDualPane = props.isDualPane ?? true;

  const latest = useRef(props);
  latest.current = props;
  const leftH = usePaneHandlers('left', latest);
  const rightH = usePaneHandlers('right', latest);

  // ---- Resizable split (20%..80%). Dragging updates the DOM directly and commits on release,
  // so both file lists are not re-rendered on every pointer move.
  const [splitRatio, setSplitRatio] = useState<number>(readInitialSplit);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftColRef = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);
  const ratioBadgeRef = useRef<HTMLDivElement>(null);
  const dragRatioRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  const paintRatio = (r: number) => {
    if (leftColRef.current) leftColRef.current.style.width = `${r}%`;
    if (rightColRef.current) rightColRef.current.style.width = `${100 - r}%`;
    if (ratioBadgeRef.current) ratioBadgeRef.current.textContent = `${r.toFixed(0)}% / ${(100 - r).toFixed(0)}%`;
  };

  const commitRatio = (r: number) => {
    setSplitRatio(r);
    try {
      localStorage.setItem(SPLIT_KEY, r.toFixed(1));
    } catch {
      // storage unavailable
    }
  };

  const handleSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture is best-effort
    }
    dragRatioRef.current = splitRatio;
    setIsResizing(true);
  };

  const handleSplitterPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRatioRef.current === null || !containerRef.current) return;
    if (e.buttons === 0) {
      endResize();
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    const next = clampRatio(((e.clientX - rect.left) / rect.width) * 100);
    dragRatioRef.current = next;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (dragRatioRef.current !== null) paintRatio(dragRatioRef.current);
      });
    }
  };

  const endResize = () => {
    const r = dragRatioRef.current;
    dragRatioRef.current = null;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setIsResizing(false);
    if (r !== null) {
      paintRatio(r);
      commitRatio(r);
    }
  };

  const handleSplitterDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    paintRatio(50);
    commitRatio(50);
  };

  // ---- Highlight an empty pane while a session tab is dragged over it
  const [tabDropPane, setTabDropPane] = useState<PaneId | null>(null);
  useEffect(
    () =>
      tabDragManager.subscribe((s) => {
        const target = s && s.targetPane && s.targetPane !== s.sourcePane ? s.targetPane : null;
        setTabDropPane((prev) => (prev === target ? prev : target));
      }),
    []
  );

  const renderPanel = (pane: PaneId, fullWidth: boolean) => {
    const L = pane === 'left';
    const h = L ? leftH : rightH;
    const sessionId = L ? props.leftActiveSessionId : props.rightActiveSessionId;
    const onNewSession = L ? props.onNewLeftSession : props.onNewRightSession;

    if (!sessionId) {
      return <EmptyPane onConnect={onNewSession} highlight={tabDropPane === pane} onFocus={h.focus} />;
    }

    const isRemote = L ? props.leftIsRemote : props.rightIsRemote;
    const name = L ? props.leftSessionName : props.rightSessionName;
    const paneDiff = (L ? props.leftDiffMap : props.rightDiffMap) ?? props.diffMap;
    const currentPath = L ? props.leftPath : props.rightPath;
    const title = name || (isRemote ? t('dualPane.remoteServer', 'Remote server') : t('dualPane.localMachine', 'This computer'));

    // F5/F6 target: the other pane, only in Commander mode and only when it shows a connection
    const otherSessionId = L ? props.rightActiveSessionId : props.leftActiveSessionId;
    const canTransfer = !fullWidth && isDualPane && !!otherSessionId;
    const otherName =
      (L ? props.rightSessionName : props.leftSessionName) ||
      ((L ? props.rightIsRemote : props.leftIsRemote) ? t('dualPane.remoteServer', 'Remote server') : t('dualPane.localMachine', 'This computer'));
    const otherPath = L ? props.rightPath : props.leftPath;
    const otherPaneLabel = canTransfer ? (otherPath ? `${otherName} · ${otherPath}` : otherName) : undefined;
    const canMove = !!(L ? props.onMoveLeftToRight : props.onMoveRightToLeft);

    return (
      // One broken pane shows a small card instead of taking the window down; it recovers when the
      // pane switches session or folder.
      <ErrorBoundary scope="section" fallbackTitle={title} resetKeys={[sessionId, currentPath]}>
        <FilePanel
          paneId={pane}
          title={title}
          isRemote={isRemote}
          sessionId={sessionId}
          currentPath={currentPath}
          files={L ? props.leftFiles : props.rightFiles}
          loading={L ? props.leftLoading : props.rightLoading}
          selectedFiles={L ? props.selectedLeft : props.selectedRight}
          diffMap={paneDiff}
          clipboard={props.clipboard}
          actionsCatalog={props.actionsCatalog}
          externalFilterText={L ? props.leftFilterText : props.rightFilterText}
          onNavigate={h.navigate}
          onRefresh={h.refresh}
          onSelectFile={h.select}
          onSetSelection={(L ? props.onSetLeftSelection : props.onSetRightSelection) ? h.setSelection : undefined}
          onNewFolder={h.newFolder}
          onDelete={h.remove}
          onNewSession={onNewSession ? h.newSession : undefined}
          onEditFile={props.onEditFile ? h.editFile : undefined}
          onRename={props.onRenameFile ? h.rename : undefined}
          onRenameInline={props.onRenameInline ? h.renameInline : undefined}
          onShowProperties={props.onShowProperties ? h.showProperties : undefined}
          onCalculateChecksum={props.onCalculateChecksum ? h.checksum : undefined}
          onCalculateSize={props.onCalculateSize ? h.size : undefined}
          onOpenSymlink={props.onOpenSymlink ? h.symlink : undefined}
          onOpenFindFiles={props.onOpenFindFiles ? h.findFiles : undefined}
          onOpenGenerateCode={props.onOpenGenerateCode ? h.generateCode : undefined}
          onCopy={props.onCopy ? h.copy : undefined}
          onCut={props.onCut ? h.cut : undefined}
          onPaste={props.onPaste ? h.paste : undefined}
          onDuplicate={props.onDuplicate ? h.duplicate : undefined}
          onCompress={props.onCompress ? h.compress : undefined}
          onExtract={props.onExtract ? h.extract : undefined}
          onRequestCompress={props.onRequestCompress ? h.requestCompress : undefined}
          onRequestExtract={props.onRequestExtract ? h.requestExtract : undefined}
          onOpenTerminalHere={props.onOpenTerminalHere ? h.terminalHere : undefined}
          onOpenNativeTerminalHere={props.onOpenNativeTerminalHere ? h.nativeTerminalHere : undefined}
          onMoveToTrash={props.onMoveToTrash ? h.moveToTrash : undefined}
          remoteTrashEnabled={props.remoteTrashEnabled}
          onExecuteSmartAction={props.onExecuteSmartAction ? h.smartAction : undefined}
          onGoHome={(L ? props.onLeftGoHome : props.onRightGoHome) ? h.goHome : undefined}
          onOpenAiAssistant={props.onOpenAiAssistant ? h.aiAssistant : undefined}
          onDropItems={props.onDropItems ? h.dropItems : undefined}
          onTransferToOtherPane={fullWidth ? undefined : h.transferToOther}
          onMoveToOtherPane={fullWidth || !canMove ? undefined : h.moveToOther}
          canTransferToOtherPane={canTransfer}
          otherPaneLabel={otherPaneLabel}
          onFocusPanel={h.focus}
          isFocused={!fullWidth && props.focusedPane === pane}
          onDropTab={props.onMoveTabBetweenPanes ? h.dropTab : undefined}
        />
      </ErrorBoundary>
    );
  };

  // --- Commander mode: two panes, each with its own tab strip, and a resizable splitter ---
  if (isDualPane) {
    const canSendRight = props.selectedLeft.length > 0 && !!props.leftActiveSessionId && !!props.rightActiveSessionId;
    const canSendLeft = props.selectedRight.length > 0 && !!props.rightActiveSessionId && !!props.leftActiveSessionId;
    const arrowBtn =
      'w-6 h-6 inline-flex items-center justify-center rounded-md text-ink-muted transition-colors enabled:hover:text-ink enabled:hover:bg-dark-650/80 disabled:opacity-35 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rust-500/40';

    return (
      <div ref={containerRef} className={cx('flex-1 flex overflow-hidden relative select-none', isResizing && 'cursor-col-resize')}>
        {/* Left column */}
        <div
          ref={leftColRef}
          data-pane-column="left"
          style={{ width: `${splitRatio}%`, minWidth: '220px' }}
          className="flex flex-col min-w-0"
        >
          <SessionTabs
            variant="pane"
            paneId="left"
            sessions={props.leftSessions}
            activeSessionId={props.leftActiveSessionId}
            onSelectSession={props.onSelectLeftSession}
            onCloseSession={props.onCloseLeftSession}
            onNewSession={props.onNewLeftSession}
            onMoveTab={props.onMoveTabBetweenPanes}
            onReorderTabs={props.onReorderTabs}
            isFocused={props.focusedPane === 'left'}
          />
          <div className="flex-1 flex flex-col min-h-0">{renderPanel('left', false)}</div>
        </div>

        {/* Splitter: a hairline with a wider invisible grab area and the copy arrows */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(splitRatio)}
          onPointerDown={handleSplitterPointerDown}
          onPointerMove={handleSplitterPointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={() => dragRatioRef.current !== null && endResize()}
          onDoubleClick={handleSplitterDoubleClick}
          title={t('dualPane.splitterTip', 'Drag to resize · double-click to reset')}
          className="group relative w-8 shrink-0 flex flex-col cursor-col-resize touch-none"
        >
          {/* continues the tab strips' bottom border */}
          <div className="h-9 shrink-0 border-b border-line" />
          <div
            className={cx(
              'absolute top-9 bottom-0 left-1/2 -translate-x-1/2 w-px transition-colors',
              isResizing ? 'bg-rust-500/70' : 'bg-line group-hover:bg-line-strong'
            )}
            aria-hidden
          />
          <div className="flex-1 flex items-center justify-center">
            <div
              className="relative flex flex-col items-center gap-1 py-1 rounded-lg bg-dark-900 cursor-default"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={props.onTransferLeftToRight}
                disabled={!canSendRight}
                aria-label={t('dualPane.transferToRight', 'Copy to right pane (F5)')}
                title={t('dualPane.transferToRight', 'Copy to right pane (F5)')}
                className={arrowBtn}
              >
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={props.onTransferRightToLeft}
                disabled={!canSendLeft}
                aria-label={t('dualPane.transferToLeft', 'Copy to left pane (F5)')}
                title={t('dualPane.transferToLeft', 'Copy to left pane (F5)')}
                className={arrowBtn}
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Ratio badge, only while dragging */}
          <div
            ref={ratioBadgeRef}
            className={cx(
              'absolute bottom-3 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded-md bg-surface-overlay border border-line shadow-pop text-[11px] text-ink-muted tabular-nums whitespace-nowrap pointer-events-none z-20 transition-opacity',
              isResizing ? 'opacity-100' : 'opacity-0'
            )}
          >
            {splitRatio.toFixed(0)}% / {(100 - splitRatio).toFixed(0)}%
          </div>
        </div>

        {/* Right column */}
        <div
          ref={rightColRef}
          data-pane-column="right"
          style={{ width: `${100 - splitRatio}%`, minWidth: '220px' }}
          className="flex flex-col min-w-0"
        >
          <SessionTabs
            variant="pane"
            paneId="right"
            sessions={props.rightSessions}
            activeSessionId={props.rightActiveSessionId}
            onSelectSession={props.onSelectRightSession}
            onCloseSession={props.onCloseRightSession}
            onNewSession={props.onNewRightSession}
            onMoveTab={props.onMoveTabBetweenPanes}
            onReorderTabs={props.onReorderTabs}
            isDualPane={isDualPane}
            onToggleDualPane={props.onToggleDualPane}
            isFocused={props.focusedPane === 'right'}
          />
          <div className="flex-1 flex flex-col min-h-0">{renderPanel('right', false)}</div>
        </div>
      </div>
    );
  }

  // --- Explorer mode: a Finder-style sidebar and the focused pane ---
  const visiblePane: PaneId = props.focusedPane;
  const visibleSessionId = visiblePane === 'left' ? props.leftActiveSessionId : props.rightActiveSessionId;
  const visibleIsLocal = !(visiblePane === 'left' ? props.leftIsRemote : props.rightIsRemote);
  const visiblePath = visiblePane === 'left' ? props.leftPath : props.rightPath;
  const home = props.localHomePath || '';

  const selectSession = (id: string) => {
    if (props.onSelectExplorerSession) {
      props.onSelectExplorerSession(id);
    } else if (props.leftSessions.some((s) => s.id === id)) {
      props.onSelectLeftSession(id);
    } else {
      props.onSelectRightSession(id);
    }
  };

  const openLocal = (path: string) => {
    if (!path) return;
    if (props.onOpenLocalFolder) props.onOpenLocalFolder(path);
    else (visiblePane === 'left' ? props.onLeftNavigate : props.onRightNavigate)(path);
  };

  const sideRow = (active: boolean) =>
    cx(
      'w-full flex items-center gap-2 h-7 px-2 rounded-md text-[13px] text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-rust-500/40',
      active ? 'bg-rust-500/10 text-ink' : 'text-ink-muted hover:text-ink hover:bg-dark-650/60'
    );

  const localPlaces: Array<{ key: string; label: string; icon: React.ReactNode; path: string }> = home
    ? [
        { key: 'downloads', label: t('dualPane.downloads', 'Downloads'), icon: <Download className="w-4 h-4" strokeWidth={1.75} />, path: joinPath(home, 'Downloads') },
        { key: 'documents', label: t('dualPane.documents', 'Documents'), icon: <FileText className="w-4 h-4" strokeWidth={1.75} />, path: joinPath(home, 'Documents') },
        { key: 'desktop', label: t('dualPane.desktop', 'Desktop'), icon: <Monitor className="w-4 h-4" strokeWidth={1.75} />, path: joinPath(home, 'Desktop') },
      ]
    : [];

  return (
    <div className="flex-1 flex overflow-hidden relative select-none">
      <aside className="w-56 shrink-0 bg-dark-850 border-r border-line flex flex-col" aria-label={t('dualPane.sidebar', 'Sidebar')}>
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-5">
          <section>
            <div className="flex items-center justify-between px-2 mb-1">
              <span className="text-[12px] font-medium text-ink-faint">{t('dualPane.connectedEnvironments', 'Locations')}</span>
              <span className="text-[11px] text-ink-faint tabular-nums">{props.allSessions.length}</span>
            </div>
            <div className="space-y-px">
              {props.allSessions.map((sess) => {
                const active = sess.id === visibleSessionId;
                return (
                  <button
                    key={sess.id}
                    type="button"
                    onClick={() => selectSession(sess.id)}
                    aria-current={active ? 'true' : undefined}
                    title={sess.config.host && sess.config.protocol !== 'local' ? `${sess.config.username ? `${sess.config.username}@` : ''}${sess.config.host}` : sess.config.name}
                    className={sideRow(active)}
                  >
                    <span className={active ? 'text-ink-muted' : 'text-ink-faint'}>
                      <ProtocolIcon protocol={sess.config.protocol} className="w-4 h-4" />
                    </span>
                    <span className="flex-1 truncate">{sess.config.name}</span>
                    <span className="text-[11px] text-ink-faint shrink-0">{sess.config.protocol === 'local' ? '' : sess.config.protocol.toUpperCase()}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="px-2 mb-1 text-[12px] font-medium text-ink-faint">{t('dualPane.favorites', 'Favorites')}</div>
            <div className="space-y-px">
              {(visiblePane === 'left' ? props.onLeftGoHome : props.onRightGoHome) && (
                <button
                  type="button"
                  onClick={() => (visiblePane === 'left' ? props.onLeftGoHome : props.onRightGoHome)?.()}
                  className={sideRow(false)}
                  disabled={!visibleSessionId}
                >
                  <Home className="w-4 h-4 text-ink-faint" strokeWidth={1.75} />
                  <span className="truncate">{t('dualPane.home', 'Home')}</span>
                </button>
              )}
              {localPlaces.map((place) => (
                <button
                  key={place.key}
                  type="button"
                  onClick={() => openLocal(place.path)}
                  className={sideRow(visibleIsLocal && !!visiblePath && visiblePath === place.path)}
                >
                  <span className="text-ink-faint">{place.icon}</span>
                  <span className="truncate">{place.label}</span>
                </button>
              ))}
              <button type="button" onClick={() => openLocal('/')} className={sideRow(visibleIsLocal && visiblePath === '/')}>
                <Folder className="w-4 h-4 text-ink-faint" strokeWidth={1.75} />
                <span className="truncate">{t('dualPane.localRoot', 'Computer (/)')}</span>
              </button>
            </div>
          </section>
        </div>

        {props.onOpenAiAssistant && (
          <div className="p-2 border-t border-line">
            <button type="button" onClick={() => props.onOpenAiAssistant?.(visiblePane)} className={sideRow(false)}>
              <Sparkles className="w-4 h-4 text-ink-faint" strokeWidth={1.75} />
              <span className="truncate">{t('dualPane.aiAssistant', 'AI assistant')}</span>
            </button>
          </div>
        )}
      </aside>

      <div className="flex-1 flex min-w-0 overflow-hidden" data-pane-column={visiblePane}>
        {renderPanel(visiblePane, true)}
      </div>
    </div>
  );
};

/** Memoized: App passes stable handlers, so unrelated App updates (queue polling, modals) skip both panes. */
export const DualPane = React.memo(DualPaneImpl);
DualPane.displayName = 'DualPane';
