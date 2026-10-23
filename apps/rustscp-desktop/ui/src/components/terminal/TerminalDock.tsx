import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  History,
  Loader2,
  Maximize2,
  MessageCircleQuestion,
  Minimize2,
  Plus,
  Settings2,
  Terminal as TerminalIcon,
  X,
  XCircle,
  ExternalLink,
} from 'lucide-react';
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuToggleItem } from '../ui/Menu.tsx';
import type { RemoteSystemInfo } from '../../types.ts';
import { normalizePackageManager } from './commandCatalog.ts';
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from './terminalSettings.ts';
import {
  activateTerminal,
  call,
  closeTerminal,
  HistoryEntry,
  runInTerminal,
  setDockHeight,
  setDockMaximized,
  setDockOpen,
  setSidePanel,
  TermTab,
  updateTerminalSettings,
  useTerminalStore,
} from './terminalStore.ts';
import { TerminalSidePanel, uniqueCommands } from './TerminalSidePanel.tsx';
import type { TerminalViewHandle } from './TerminalView.tsx';

const TerminalView = lazy(() => import('./TerminalView.tsx'));

interface Props {
  isPt: boolean;
  /** Opens a terminal on the focused SSH session (`null` when none can run one). */
  onNewTerminal: (() => void) | null;
  onOpenFolder?: (sessionId: string, path: string) => void;
  /** "Open in system terminal" for the session of the terminal shown. */
  onOpenNative?: (sessionId: string, path: string) => void;
}

function TabIcon({ tab }: { tab: TermTab }) {
  if (tab.status === 'connecting') return <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-faint" />;
  if (tab.attention === 'input') return <MessageCircleQuestion className="w-3.5 h-3.5 text-amber-500" />;
  if (tab.busy) return <Loader2 className="w-3.5 h-3.5 animate-spin text-rust-500" />;
  if (tab.attention === 'failed') return <XCircle className="w-3.5 h-3.5 text-red-500" />;
  if (tab.attention === 'done') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />;
  const dot =
    tab.status === 'running' ? 'bg-emerald-500' : tab.status === 'exited' ? 'bg-slate-400' : 'bg-red-500';
  return <span className={`w-2 h-2 rounded-full ${dot}`} />;
}

/**
 * The terminal panel under the file panes. Terminals keep running when it is hidden; a slim
 * bar then shows each one's state, so a finished or stuck command is never missed.
 */
export const TerminalDock: React.FC<Props> = ({ isPt, onNewTerminal, onOpenFolder, onOpenNative }) => {
  const tr = (pt: string, en: string) => (isPt ? pt : en);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeId = useTerminalStore((s) => s.activeId);
  const open = useTerminalStore((s) => s.open);
  const height = useTerminalStore((s) => s.height);
  const maximized = useTerminalStore((s) => s.maximized);
  const side = useTerminalStore((s) => s.side);
  const settings = useTerminalStore((s) => s.settings);
  const historyVersion = useTerminalStore((s) => s.historyVersion);
  const viewRefs = useRef<Record<string, TerminalViewHandle | null>>({});
  const [systems, setSystems] = useState<Record<string, RemoteSystemInfo | null>>({});
  const [history, setHistory] = useState<string[]>([]);
  const [closing, setClosing] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // What the server is (package manager for suggestions, root or not), once per session.
  useEffect(() => {
    const sid = active?.sessionId;
    if (!sid || sid in systems || active.status !== 'running') return;
    setSystems((s) => ({ ...s, [sid]: null }));
    call<RemoteSystemInfo>('detect_remote_system', { sessionId: sid })
      .then((info) => setSystems((s) => ({ ...s, [sid]: info })))
      .catch(() => {});
  }, [active?.sessionId, active?.status, systems]);

  // Commands already run on this server, for the assistant's suggestions.
  useEffect(() => {
    const siteKey = active?.siteKey;
    if (!siteKey) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    call<HistoryEntry[]>('terminal_history', { siteKey, limit: 300 })
      .then((list) => !cancelled && setHistory(uniqueCommands(list)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active?.siteKey, historyVersion]);

  // Busy times in the slim bar tick.
  const anyBusy = tabs.some((t) => t.busy);
  useEffect(() => {
    if (open || !anyBusy) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open, anyBusy]);

  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(null), 3000);
    return () => clearTimeout(t);
  }, [closing]);

  if (tabs.length === 0 || !active) return null;

  const requestClose = (tab: TermTab) => {
    if (tab.busy && closing !== tab.id) {
      setClosing(tab.id);
      return;
    }
    setClosing(null);
    closeTerminal(tab.id);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => {
      const max = window.innerHeight - 160;
      setDockHeight(Math.min(max, Math.max(160, startH + (startY - ev.clientY))));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'row-resize';
    if (maximized) setDockMaximized(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const system = systems[active.sessionId] ?? null;
  const pm = normalizePackageManager(system?.package_manager);

  // ------------------------------------------------------------------ hidden: slim bar
  const slimBar = !open && (
      <div className="shrink-0 h-8 flex items-center gap-1 px-2 border-t border-line bg-surface-raised select-none min-w-0">
        <button
          type="button"
          onClick={() => setDockOpen(true)}
          className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[12.5px] font-medium text-ink hover:bg-dark-650/60 shrink-0"
          title={tr('Mostrar terminais (Ctrl+`)', 'Show terminals (Ctrl+`)')}
        >
          <TerminalIcon className="w-3.5 h-3.5" />
          {tr('Terminais', 'Terminals')}
        </button>
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                activateTerminal(t.id);
                setDockOpen(true);
              }}
              className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] text-ink-muted hover:text-ink hover:bg-dark-650/60 shrink-0 max-w-[16rem]"
              title={t.busy ? tr('Executando um comando', 'Running a command') : t.title}
            >
              <TabIcon tab={t} />
              <span className="truncate">{t.title}</span>
              {t.busy && t.busySince && <span className="tabular-nums text-ink-faint">{Math.floor((Date.now() - t.busySince) / 1000)}s</span>}
              {t.unread && !t.busy && !t.attention && <span className="w-1.5 h-1.5 rounded-full bg-rust-500" aria-label={tr('Nova saída', 'New output')} />}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button type="button" className="ui-icon-btn ui-icon-btn-sm" onClick={() => setDockOpen(true)} aria-label={tr('Mostrar terminais', 'Show terminals')}>
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>
  );

  // ------------------------------------------------------------------ open panel
  const panelHeight = maximized ? 'calc(100vh - 7rem)' : `${height}px`;

  // While hidden the panel stays mounted (display: none), so every terminal keeps its screen.
  return (
    <>
    {slimBar}
    <section
      className="shrink-0 flex flex-col border-t border-line bg-surface min-h-0 relative"
      style={{ height: panelHeight, display: open ? 'flex' : 'none' }}
      aria-label={tr('Terminais', 'Terminals')}
      aria-hidden={!open}
    >
      <div
        className="absolute -top-1 inset-x-0 h-2 cursor-row-resize z-10"
        onMouseDown={startResize}
        onDoubleClick={() => setDockMaximized(!maximized)}
        title={tr('Arraste para mudar a altura · clique duplo maximiza', 'Drag to resize · double-click to maximize')}
      />

      {/* Tabs and tools */}
      <div className="shrink-0 h-9 flex items-center gap-1 px-1.5 border-b border-line bg-surface-raised select-none min-w-0">
        <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto" role="tablist">
          {tabs.map((t) => {
            const isActive = t.id === active.id;
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                onClick={() => activateTerminal(t.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && activateTerminal(t.id)}
                onAuxClick={(e) => e.button === 1 && requestClose(t)}
                className={`group inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-md text-[12.5px] cursor-pointer shrink-0 max-w-[15rem] ${
                  isActive ? 'bg-dark-650/80 text-ink' : 'text-ink-muted hover:text-ink hover:bg-dark-650/50'
                }`}
                title={t.cwd ? `${t.title} — ${t.cwd}` : t.title}
              >
                <TabIcon tab={t} />
                <span className="truncate">{t.title}</span>
                {t.unread && !isActive && !t.attention && <span className="w-1.5 h-1.5 rounded-full bg-rust-500 shrink-0" />}
                {closing === t.id ? (
                  <button
                    type="button"
                    className="ml-0.5 h-5 px-1.5 rounded bg-red-600 text-white text-[11px] font-medium shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(t);
                    }}
                  >
                    {tr('Encerrar?', 'End it?')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`ui-icon-btn w-5 h-5 rounded shrink-0 ${isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'} hover:!opacity-100`}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(t);
                    }}
                    aria-label={tr('Fechar terminal', 'Close terminal')}
                    title={t.busy ? tr('Um comando ainda está rodando', 'A command is still running') : tr('Fechar terminal', 'Close terminal')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {onNewTerminal && (
          <button type="button" className="ui-icon-btn ui-icon-btn-sm shrink-0" onClick={onNewTerminal} title={tr('Novo terminal (Ctrl+Shift+`)', 'New terminal (Ctrl+Shift+`)')}>
            <Plus className="w-4 h-4" />
          </button>
        )}
        <span className="flex-1" />

        <button
          type="button"
          className={`ui-btn ui-btn-sm shrink-0 ${side === 'shortcuts' ? 'bg-dark-650/80 text-ink' : 'ui-btn-ghost'}`}
          onClick={() => setSidePanel(side === 'shortcuts' ? 'none' : 'shortcuts')}
          aria-pressed={side === 'shortcuts'}
          title={tr('Comandos prontos para tarefas comuns', 'Ready-made commands for common tasks')}
        >
          <BookOpen className="w-3.5 h-3.5" />
          <span className="hidden md:inline">{tr('Atalhos', 'Shortcuts')}</span>
        </button>
        <button
          type="button"
          className={`ui-btn ui-btn-sm shrink-0 ${side === 'history' ? 'bg-dark-650/80 text-ink' : 'ui-btn-ghost'}`}
          onClick={() => setSidePanel(side === 'history' ? 'none' : 'history')}
          aria-pressed={side === 'history'}
          title={tr('Comandos que você já rodou', 'Commands you ran before')}
        >
          <History className="w-3.5 h-3.5" />
          <span className="hidden md:inline">{tr('Histórico', 'History')}</span>
        </button>

        <Menu
          align="right"
          width="w-72"
          trigger={({ open: menuOpen, toggle, ref }) => (
            <button ref={ref} type="button" className={`ui-icon-btn ui-icon-btn-sm shrink-0 ${menuOpen ? 'bg-dark-650/80 text-ink' : ''}`} onClick={toggle} aria-label={tr('Opções do terminal', 'Terminal options')} aria-haspopup="menu" aria-expanded={menuOpen}>
              <Settings2 className="w-4 h-4" />
            </button>
          )}
        >
          {(close) => (
            <div className="max-h-[70vh] overflow-y-auto">
              <MenuLabel>{tr('Ajuda', 'Help')}</MenuLabel>
              <MenuToggleItem label={tr('Assistente de comandos', 'Command assistant')} checked={settings.assistant} onToggle={() => updateTerminalSettings({ assistant: !settings.assistant })} />
              <MenuToggleItem label={tr('Salvar histórico de comandos', 'Keep command history')} checked={settings.keepHistory} onToggle={() => updateTerminalSettings({ keepHistory: !settings.keepHistory })} />
              <MenuSeparator />
              <MenuLabel>{tr('Copiar e colar', 'Copy & paste')}</MenuLabel>
              <MenuToggleItem label={tr('Copiar ao selecionar', 'Copy on select')} checked={settings.copyOnSelect} onToggle={() => updateTerminalSettings({ copyOnSelect: !settings.copyOnSelect })} />
              <MenuToggleItem label={tr('Clique direito cola (estilo PuTTY)', 'Right click pastes (PuTTY style)')} checked={settings.rightClickPaste} onToggle={() => updateTerminalSettings({ rightClickPaste: !settings.rightClickPaste })} />
              <MenuToggleItem label={tr('Confirmar colagem de várias linhas', 'Confirm multi-line paste')} checked={settings.confirmMultiline} onToggle={() => updateTerminalSettings({ confirmMultiline: !settings.confirmMultiline })} />
              <MenuSeparator />
              <MenuLabel>{tr('Aparência', 'Appearance')}</MenuLabel>
              <MenuToggleItem label={tr('Terminal sempre escuro', 'Always dark terminal')} checked={settings.theme === 'dark'} onToggle={() => updateTerminalSettings({ theme: settings.theme === 'dark' ? 'app' : 'dark' })} />
              <div className="flex items-center gap-1 px-2.5 py-1.5 text-[13px] text-ink">
                <span className="flex-1">{tr('Tamanho do texto', 'Text size')}</span>
                <button type="button" className="ui-icon-btn ui-icon-btn-sm w-6 h-6" onClick={() => updateTerminalSettings({ fontSize: Math.max(MIN_FONT_SIZE, settings.fontSize - 1) })} aria-label={tr('Diminuir', 'Smaller')}>
                  −
                </button>
                <span className="w-6 text-center tabular-nums text-ink-muted">{settings.fontSize}</span>
                <button type="button" className="ui-icon-btn ui-icon-btn-sm w-6 h-6" onClick={() => updateTerminalSettings({ fontSize: Math.min(MAX_FONT_SIZE, settings.fontSize + 1) })} aria-label={tr('Aumentar', 'Larger')}>
                  +
                </button>
              </div>
              {onOpenNative && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<ExternalLink className="w-4 h-4" />}
                    label={tr('Abrir no terminal do sistema', 'Open in system terminal')}
                    onSelect={() => onOpenNative(active.sessionId, active.cwd ?? active.startPath)}
                    close={close}
                  />
                </>
              )}
            </div>
          )}
        </Menu>

        <button type="button" className="ui-icon-btn ui-icon-btn-sm shrink-0" onClick={() => setDockMaximized(!maximized)} aria-label={maximized ? tr('Restaurar', 'Restore') : tr('Maximizar', 'Maximize')}>
          {maximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          className="ui-icon-btn ui-icon-btn-sm shrink-0"
          onClick={() => setDockOpen(false)}
          aria-label={tr('Ocultar terminais (continuam rodando)', 'Hide terminals (they keep running)')}
          title={tr('Ocultar (os terminais continuam rodando) · Ctrl+`', 'Hide (terminals keep running) · Ctrl+`')}
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className={`flex-1 min-w-0 min-h-0 relative ${settings.theme === 'dark' ? 'term-dark' : ''}`}>
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center text-ink-faint">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            }
          >
            {tabs.map((t) => (
              <TerminalView
                key={t.id}
                ref={(h) => {
                  viewRefs.current[t.id] = h;
                }}
                tab={t}
                active={open && t.id === active.id}
                isPt={isPt}
                pm={t.sessionId === active.sessionId ? pm : 'unknown'}
                isRoot={t.sessionId === active.sessionId ? system?.is_root : undefined}
                osName={t.sessionId === active.sessionId ? system?.os_name : undefined}
                history={t.siteKey === active.siteKey ? history : []}
                onOpenFolder={onOpenFolder}
              />
            ))}
          </Suspense>
        </div>
        {side !== 'none' && (
          <TerminalSidePanel
            isPt={isPt}
            pm={pm}
            side={side}
            onSideChange={setSidePanel}
            siteKey={active.siteKey || undefined}
            siteTitle={active.title}
            onInsert={(command) => viewRefs.current[active.id]?.insert(command)}
            onRun={(command) => {
              void runInTerminal(active.id, command);
              viewRefs.current[active.id]?.focus();
            }}
            onClose={() => setSidePanel('none')}
          />
        )}
      </div>
    </section>
    </>
  );
};
