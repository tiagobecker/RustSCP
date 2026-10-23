import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  CornerDownLeft,
  FileDown,
  FolderOpen,
  Lightbulb,
  Loader2,
  Minus,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  TextSelect,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { copyText } from '../copyToClipboard.ts';
import { notify } from '../ui/toast.tsx';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { CommandBar, CommandBarHandle } from './CommandBar.tsx';
import { errorHint, ErrorHint, PackageManager } from './commandCatalog.ts';
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from './terminalSettings.ts';
import {
  call,
  closeTerminal,
  errText,
  formatDuration,
  markSeen,
  reconnect,
  registerView,
  resizeTerminal,
  runInTerminal,
  TermTab,
  updateTerminalSettings,
  useTerminalStore,
  writeBinary,
  writeToTerminal,
} from './terminalStore.ts';
import { DARK_TERMINAL_THEME, isAppDark, LIGHT_TERMINAL_THEME } from './xtermTheme.ts';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl+';
const COPY_KEY = isMac ? '⌘C' : 'Ctrl+Shift+C';
const PASTE_KEY = isMac ? '⌘V' : 'Ctrl+V';
const FIND_KEY = isMac ? '⌘F' : 'Ctrl+Shift+F';

export interface TerminalViewHandle {
  insert: (text: string) => void;
  focus: () => void;
}

interface Props {
  tab: TermTab;
  /** The dock shows this terminal. */
  active: boolean;
  isPt: boolean;
  pm: PackageManager;
  isRoot?: boolean;
  osName?: string;
  /** Commands run on this server, newest first (suggestions, ↑ in the assistant). */
  history: string[];
  onOpenFolder?: (sessionId: string, path: string) => void;
}

interface MenuState {
  x: number;
  y: number;
}

/** The rendered text of buffer lines [start, end), wrapped rows joined back into lines. */
function bufferText(term: XTerm, start: number, end: number): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = Math.max(0, start); i < Math.min(end, buf.length); i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').replace(/\s+$/, '');
}

export const TerminalView = forwardRef<TerminalViewHandle, Props>(({ tab, active, isPt, pm, isRoot, osName, history, onOpenFolder }, ref) => {
  const settings = useTerminalStore((s) => s.settings);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const markersRef = useRef<IMarker[]>([]);
  const barRef = useRef<CommandBarHandle>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const [hasSelection, setHasSelection] = useState(false);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [pasteConfirm, setPasteConfirm] = useState<string | null>(null);
  const [hint, setHint] = useState<ErrorHint | null>(null);
  const [printed, setPrinted] = useState(false);
  const [, setTick] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tr = useCallback((pt: string, en: string) => (isPt ? pt : en), [isPt]);

  // ------------------------------------------------------------------ clipboard

  const flashCopied = () => {
    setCopiedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setCopiedFlash(false), 1400);
  };

  const copySelection = useCallback(async () => {
    const term = termRef.current;
    if (!term || !term.hasSelection()) return false;
    const ok = await copyText(term.getSelection());
    if (ok) flashCopied();
    return ok;
  }, []);

  /** Pastes like a terminal should, with two safety nets for people new to the shell. */
  const paste = useCallback((raw: string, opts?: { skipConfirm?: boolean }) => {
    const term = termRef.current;
    if (!term || !raw) return;
    let text = raw.replace(/\r\n?/g, '\n');
    // One line copied with its line break would run immediately: keep it on the prompt.
    if (/^[^\n]*\n$/.test(text)) text = text.slice(0, -1);
    if (!opts?.skipConfirm && text.includes('\n') && settingsRef.current.confirmMultiline) {
      setPasteConfirm(text);
      return;
    }
    term.paste(text);
    term.focus();
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    try {
      paste(await call<string>('clipboard_read_text'));
    } catch (e) {
      notify.info(tr('Não foi possível ler a área de transferência', 'Could not read the clipboard'), tr(`Use ${PASTE_KEY} para colar.`, `Use ${PASTE_KEY} to paste.`));
      console.warn(e);
    }
  }, [paste, tr]);

  // ------------------------------------------------------------------ command output

  /** Text printed by the last finished command (between the last two prompts). */
  const lastOutput = useCallback((): string | null => {
    const term = termRef.current;
    if (!term) return null;
    const marks = markersRef.current.filter((m) => !m.isDisposed && m.line >= 0);
    if (marks.length < 2) return null;
    const end = marks[marks.length - 1].line;
    let start = marks[marks.length - 2].line + 1;
    // Skip the rest of a long command line wrapped onto the next rows.
    while (start < end && term.buffer.active.getLine(start)?.isWrapped) start++;
    return bufferText(term, start, end);
  }, []);

  const copyLastOutput = async () => {
    const text = lastOutput();
    if (text == null) {
      notify.info(tr('Nada para copiar ainda', 'Nothing to copy yet'), tr('Rode um comando primeiro.', 'Run a command first.'));
      return;
    }
    if (await copyText(text)) flashCopied();
  };

  const saveOutput = async () => {
    const term = termRef.current;
    if (!term) return;
    const text = bufferText(term, 0, term.buffer.active.length);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    try {
      const path = await call<string | null>('save_text_file_dialog', { contents: `${text}\n`, suggestedName: `terminal-${tab.title}-${stamp}.txt` });
      if (path) notify.success(tr('Saída salva', 'Output saved'), path);
    } catch (e) {
      notify.error(tr('Não foi possível salvar', 'Could not save'), errText(e));
    }
  };

  // ------------------------------------------------------------------ xterm setup

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const dark = settingsRef.current.theme === 'dark' || isAppDark();
    const term = new XTerm({
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: settingsRef.current.fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 20000,
      allowProposedApi: true,
      theme: dark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME,
      minimumContrastRatio: dark ? 1 : 3,
      drawBoldTextInBrightColors: true,
      rightClickSelectsWord: false,
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        void call('open_external_url', { url: uri }).catch((err) => notify.error(isPt ? 'Não foi possível abrir o link' : 'Could not open the link', errText(err)));
      })
    );
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // The prompt hook reports each new prompt: mark it, to find a command's output later.
    term.parser.registerOscHandler(6973, (data) => {
      if (data.startsWith('done;')) {
        const m = term.registerMarker(0);
        if (m) {
          markersRef.current.push(m);
          if (markersRef.current.length > 400) markersRef.current.shift()?.dispose();
        }
      }
      return true;
    });

    const id = tabRef.current.id;
    const unregister = registerView(id, {
      write: (data) => {
        term.write(data);
        setPrinted(true);
      },
    });
    const subs = [
      term.onData((d) => writeToTerminal(id, d)),
      term.onBinary((d) => writeBinary(id, d)),
      term.onSelectionChange(() => setHasSelection(term.hasSelection())),
      term.onBell(() => {
        if (!document.hasFocus()) notify.info(isPt ? `O terminal chamou sua atenção · ${tabRef.current.title}` : `The terminal wants your attention · ${tabRef.current.title}`);
      }),
    ];

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const cmd = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      // Copy: ⌘C on macOS; Ctrl+Shift+C, or Ctrl+C with a selection, elsewhere.
      if (key === 'c' && cmd && (isMac || e.shiftKey || term.hasSelection()) && !e.altKey) {
        if (term.hasSelection()) {
          e.preventDefault();
          void copySelection();
          if (!isMac) term.clearSelection();
          return false;
        }
        if (isMac || e.shiftKey) return false;
      }
      // Paste: the browser's own paste event does the work (handled below).
      if ((key === 'v' && cmd && !e.altKey) || (e.shiftKey && e.key === 'Insert')) return false;
      if (key === 'a' && cmd && (isMac || e.shiftKey)) {
        e.preventDefault();
        term.selectAll();
        return false;
      }
      if (key === 'f' && cmd && (isMac || e.shiftKey)) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.select());
        return false;
      }
      if (cmd && (key === '=' || key === '+' || key === '-' || key === '0')) {
        e.preventDefault();
        const size = settingsRef.current.fontSize;
        updateTerminalSettings({
          fontSize: key === '0' ? 13 : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size + (key === '-' ? -1 : 1))),
        });
        return false;
      }
      // Other ⌘ shortcuts belong to the app, not the shell.
      if (isMac && e.metaKey) return false;
      return true;
    });

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      paste(e.clipboardData?.getData('text/plain') ?? '');
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 || !settingsRef.current.copyOnSelect) return;
      // After xterm finished the selection.
      setTimeout(() => {
        if (term.hasSelection() && term.getSelection().trim()) void copySelection();
      }, 0);
    };
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('mouseup', onMouseUp);

    // Follow the panel's size; the server's terminal follows ours.
    let raf = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!host.offsetWidth || !host.offsetHeight) return;
        const before = `${term.cols}x${term.rows}`;
        try {
          fit.fit();
        } catch {
          return;
        }
        if (`${term.cols}x${term.rows}` !== before || !resizeTimer) {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            resizeTerminal(id, term.cols, term.rows);
          }, 80);
        }
      });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    refit();

    // Light/dark theme changes of the app.
    const themeObserver = new MutationObserver(() => {
      const d = settingsRef.current.theme === 'dark' || isAppDark();
      term.options.theme = d ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
      term.options.minimumContrastRatio = d ? 1 : 3;
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      unregister();
      subs.forEach((s) => s.dispose());
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('mouseup', onMouseUp);
      observer.disconnect();
      themeObserver.disconnect();
      cancelAnimationFrame(raf);
      if (resizeTimer) clearTimeout(resizeTimer);
      markersRef.current = [];
      term.dispose();
      termRef.current = null;
    };
    // The terminal is created once per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Settings that apply live.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const dark = settings.theme === 'dark' || isAppDark();
    term.options.fontSize = settings.fontSize;
    term.options.theme = dark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
    term.options.minimumContrastRatio = dark ? 1 : 3;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* hidden */
      }
    });
  }, [settings.fontSize, settings.theme]);

  // Shown: fit to the panel and take the keyboard.
  useEffect(() => {
    if (!active) return;
    markSeen(tab.id);
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* not laid out yet */
      }
      if (!document.activeElement || document.activeElement === document.body || hostRef.current?.contains(document.activeElement)) {
        termRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active, tab.id]);

  // The running time ticks while a command runs.
  useEffect(() => {
    if (!tab.busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [tab.busy]);

  // A failed command gets a plain-language hint.
  useEffect(() => {
    const last = tab.last;
    setHint(last ? errorHint(last.command, last.exitCode, last.outputTail, pm, isPt) : null);
  }, [tab.last, pm, isPt]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  useImperativeHandle(ref, () => ({
    insert: (text: string) => {
      if (settingsRef.current.assistant) barRef.current?.insert(text);
      else {
        termRef.current?.paste(text);
        termRef.current?.focus();
      }
    },
    focus: () => termRef.current?.focus(),
  }));

  const runCommand = (command: string) => {
    setHint(null);
    void runInTerminal(tab.id, command);
    termRef.current?.scrollToBottom();
    termRef.current?.focus();
  };

  const find = (direction: 'next' | 'prev') => {
    const s = searchRef.current;
    if (!s || !searchText) return;
    const opts = { caseSensitive: false, incremental: direction === 'next' };
    if (direction === 'next') s.findNext(searchText, opts);
    else s.findPrevious(searchText, opts);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (settings.rightClickPaste) {
      if (termRef.current?.hasSelection()) void copySelection().then(() => termRef.current?.clearSelection());
      else void pasteFromClipboard();
      return;
    }
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // Keep the menu inside the window (the panel may be short).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const maxX = window.innerWidth - el.offsetWidth - 8;
    const maxY = window.innerHeight - el.offsetHeight - 8;
    el.style.left = `${Math.max(8, Math.min(menu.x, maxX))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, maxY))}px`;
  }, [menu]);

  const connected = tab.status === 'running';
  const ended = tab.status === 'exited' || tab.status === 'lost' || tab.status === 'failed';
  const dest = tab.username && tab.host ? `${tab.username}@${tab.host}` : tab.title;

  const statusDot =
    tab.status === 'running'
      ? 'bg-emerald-500'
      : tab.status === 'connecting'
        ? 'bg-amber-400 animate-pulse'
        : tab.status === 'exited'
          ? 'bg-slate-400'
          : 'bg-red-500';

  const lastResult = useMemo(() => {
    const last = tab.last;
    if (!last) return null;
    const took = last.durationMs != null ? formatDuration(last.durationMs, isPt) : '';
    if (last.exitCode === 0)
      return (
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400" title={last.command ?? undefined}>
          <CheckCircle2 className="w-3.5 h-3.5" />
          {took ? tr(`concluído em ${took}`, `done in ${took}`) : tr('concluído', 'done')}
        </span>
      );
    if (last.exitCode === 130) return <span className="text-ink-faint">{tr('interrompido (Ctrl+C)', 'interrupted (Ctrl+C)')}</span>;
    return (
      <span
        className="inline-flex items-center gap-1 text-red-600 dark:text-red-400"
        title={tr('Um código diferente de 0 significa que o comando falhou.', 'A code other than 0 means the command failed.')}
      >
        <XCircle className="w-3.5 h-3.5" />
        {tr(`falhou (código ${last.exitCode})`, `failed (code ${last.exitCode})`)}
      </span>
    );
  }, [tab.last, isPt, tr]);

  const menuItem = (icon: React.ReactNode, label: string, onSelect: () => void, opts?: { shortcut?: string; disabled?: boolean; danger?: boolean }) => (
    <button
      type="button"
      role="menuitem"
      disabled={opts?.disabled}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        setMenu(null);
        onSelect();
      }}
      className={`ui-menu-item disabled:opacity-40 ${opts?.danger ? 'text-red-600 dark:text-red-400' : ''}`}
    >
      <span className="w-4 h-4 shrink-0 text-ink-muted flex items-center justify-center">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {opts?.shortcut && <span className="ui-kbd">{opts.shortcut}</span>}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0" style={{ display: active ? 'flex' : 'none' }}>
      <div className="relative flex-1 min-h-0 rustscp-terminal" onContextMenu={onContextMenu}>
        <div ref={hostRef} className="absolute inset-0 pl-2.5 pt-1.5 pr-0.5 pb-0.5" />

        {/* Waiting for the first output */}
        {tab.status === 'connecting' && !printed && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex items-center gap-2 text-[13px] text-ink-muted bg-surface-raised/90 rounded-lg px-3 py-2 shadow-pop">
              <Loader2 className="w-4 h-4 animate-spin" />
              {tr(`Conectando a ${dest}…`, `Connecting to ${dest}…`)}
            </div>
          </div>
        )}

        {/* Selection actions */}
        {(hasSelection || copiedFlash) && !menu && (
          <div className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg border border-line bg-surface-raised/95 shadow-pop p-1 text-[12px] animate-pop">
            {copiedFlash ? (
              <span className="inline-flex items-center gap-1 px-2 h-6 text-emerald-700 dark:text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {tr('Copiado', 'Copied')}
              </span>
            ) : (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm h-6" onMouseDown={(e) => e.preventDefault()} onClick={() => void copySelection()} title={COPY_KEY}>
                <Copy className="w-3.5 h-3.5" />
                {tr('Copiar', 'Copy')}
              </button>
            )}
            {hasSelection && (
              <>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm h-6"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const text = termRef.current?.getSelection() ?? '';
                    termRef.current?.clearSelection();
                    paste(text);
                  }}
                  title={tr('Escreve o texto selecionado no prompt (sem executar)', 'Types the selection at the prompt (without running it)')}
                >
                  <CornerDownLeft className="w-3.5 h-3.5" />
                  {tr('Colar no prompt', 'Paste at prompt')}
                </button>
                {settings.assistant && (
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm h-6"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      const text = (termRef.current?.getSelection() ?? '').replace(/\s*\n\s*/g, ' ').trim();
                      termRef.current?.clearSelection();
                      barRef.current?.insert(text);
                    }}
                    title={tr('Leva para o assistente, que explica o comando', 'Sends it to the assistant, which explains the command')}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {tr('Explicar', 'Explain')}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* Search */}
        {searchOpen && (
          <div className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border border-line bg-surface-raised shadow-pop p-1 animate-pop">
            <Search className="w-3.5 h-3.5 text-ink-faint ml-1.5" />
            <input
              ref={searchInputRef}
              {...plainTextInputProps}
              autoFocus
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  find(e.shiftKey ? 'prev' : 'next');
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setSearchOpen(false);
                  searchRef.current?.clearDecorations();
                  termRef.current?.focus();
                }
              }}
              placeholder={tr('Buscar no terminal', 'Find in terminal')}
              className="h-6 w-48 bg-transparent text-[12.5px] text-ink placeholder:text-ink-faint outline-none px-1"
            />
            <button type="button" className="ui-icon-btn ui-icon-btn-sm w-6 h-6" onClick={() => find('prev')} title={tr('Anterior (Shift+Enter)', 'Previous (Shift+Enter)')}>
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button type="button" className="ui-icon-btn ui-icon-btn-sm w-6 h-6" onClick={() => find('next')} title={tr('Próximo (Enter)', 'Next (Enter)')}>
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="ui-icon-btn ui-icon-btn-sm w-6 h-6"
              onClick={() => {
                setSearchOpen(false);
                searchRef.current?.clearDecorations();
                termRef.current?.focus();
              }}
              title={tr('Fechar (Esc)', 'Close (Esc)')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Context menu */}
        {menu && (
          <div ref={menuRef} role="menu" className="fixed z-[60] ui-menu w-64 animate-pop" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            {menuItem(<Copy className="w-4 h-4" />, tr('Copiar', 'Copy'), () => void copySelection(), { shortcut: COPY_KEY, disabled: !hasSelection })}
            {menuItem(<ClipboardPaste className="w-4 h-4" />, tr('Colar', 'Paste'), () => void pasteFromClipboard(), { shortcut: PASTE_KEY, disabled: !connected })}
            {menuItem(<TextSelect className="w-4 h-4" />, tr('Selecionar tudo', 'Select all'), () => termRef.current?.selectAll(), { shortcut: `${MOD}A` })}
            <div className="ui-menu-sep" role="separator" />
            {menuItem(<ClipboardCopy className="w-4 h-4" />, tr('Copiar saída do último comando', 'Copy output of last command'), () => void copyLastOutput(), { disabled: !tab.integration })}
            {menuItem(<Copy className="w-4 h-4" />, tr('Copiar último comando', 'Copy last command'), () => void copyText(tab.last?.command ?? '').then((ok) => ok && flashCopied()), { disabled: !tab.last?.command })}
            {menuItem(<Search className="w-4 h-4" />, tr('Buscar…', 'Find…'), () => {
              setSearchOpen(true);
              requestAnimationFrame(() => searchInputRef.current?.select());
            }, { shortcut: FIND_KEY })}
            {menuItem(<FileDown className="w-4 h-4" />, tr('Salvar saída em arquivo…', 'Save output to file…'), () => void saveOutput())}
            {menuItem(<Trash2 className="w-4 h-4" />, tr('Limpar tela', 'Clear screen'), () => termRef.current?.clear())}
            {tab.cwd && onOpenFolder && (
              <>
                <div className="ui-menu-sep" role="separator" />
                {menuItem(<FolderOpen className="w-4 h-4" />, tr('Mostrar esta pasta nos arquivos', 'Show this folder in files'), () => onOpenFolder(tab.sessionId, tab.cwd!))}
              </>
            )}
            <div className="ui-menu-sep" role="separator" />
            <div className="flex items-center gap-1 px-2.5 py-1 text-[12.5px] text-ink-muted">
              <span className="flex-1">{tr('Tamanho do texto', 'Text size')}</span>
              <button type="button" className="ui-icon-btn ui-icon-btn-sm w-6 h-6" onMouseDown={(e) => e.stopPropagation()} onClick={() => updateTerminalSettings({ fontSize: Math.max(MIN_FONT_SIZE, settings.fontSize - 1) })} aria-label={tr('Diminuir', 'Smaller')}>
                <Minus className="w-3.5 h-3.5" />
              </button>
              <span className="w-6 text-center tabular-nums">{settings.fontSize}</span>
              <button type="button" className="ui-icon-btn ui-icon-btn-sm w-6 h-6" onMouseDown={(e) => e.stopPropagation()} onClick={() => updateTerminalSettings({ fontSize: Math.min(MAX_FONT_SIZE, settings.fontSize + 1) })} aria-label={tr('Aumentar', 'Larger')}>
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Multi-line paste */}
        {pasteConfirm != null && (
          <div className="absolute inset-x-4 bottom-3 z-30 ui-card shadow-pop p-3 animate-pop" role="alertdialog" aria-label={tr('Colar várias linhas', 'Paste several lines')}>
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink">
                  {tr(`Colar ${pasteConfirm.split('\n').length} linhas?`, `Paste ${pasteConfirm.split('\n').length} lines?`)}
                </div>
                <div className="text-[12px] text-ink-muted mt-0.5">
                  {tr('Cada linha pode rodar como um comando assim que for colada.', 'Each line may run as a command as soon as it is pasted.')}
                </div>
                <pre className="mt-2 max-h-28 overflow-auto rounded-md bg-surface-sunken px-2.5 py-1.5 font-mono text-[11.5px] text-ink whitespace-pre-wrap break-all">
                  {pasteConfirm.split('\n').slice(0, 12).join('\n')}
                  {pasteConfirm.split('\n').length > 12 ? '\n…' : ''}
                </pre>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary ui-btn-sm"
                    autoFocus
                    onClick={() => {
                      const text = pasteConfirm;
                      setPasteConfirm(null);
                      paste(text, { skipConfirm: true });
                    }}
                  >
                    {tr('Colar tudo', 'Paste all')}
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    onClick={() => {
                      const text = pasteConfirm
                        .split('\n')
                        .map((l) => l.trim())
                        .filter(Boolean)
                        .join(' ');
                      setPasteConfirm(null);
                      paste(text, { skipConfirm: true });
                    }}
                    title={tr('Junta as linhas com espaços, sem executar', 'Joins the lines with spaces, without running')}
                  >
                    {tr('Colar como uma linha', 'Paste as one line')}
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    onClick={() => {
                      setPasteConfirm(null);
                      termRef.current?.focus();
                    }}
                  >
                    {tr('Cancelar', 'Cancel')}
                  </button>
                  <label className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-ink-muted cursor-pointer select-none">
                    <input type="checkbox" className="accent-rust-500" onChange={(e) => updateTerminalSettings({ confirmMultiline: !e.target.checked })} />
                    {tr('Não perguntar de novo', "Don't ask again")}
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* The shell ended or the connection dropped */}
        {ended && (
          <div className="absolute inset-x-4 bottom-3 z-20 flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-surface-raised/95 shadow-pop px-3 py-2 animate-pop">
            {tab.status === 'exited' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-ink-muted" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 text-red-600 dark:text-red-400" />
            )}
            <div className="flex-1 min-w-[12rem] text-[12.5px]">
              <div className="font-medium text-ink">
                {tab.status === 'exited'
                  ? tr('A sessão terminou', 'The session ended') + (tab.exitCode != null && tab.exitCode !== 0 ? tr(` (código ${tab.exitCode})`, ` (code ${tab.exitCode})`) : '')
                  : tab.status === 'lost'
                    ? tr('A conexão caiu', 'The connection dropped')
                    : tr('Não foi possível abrir o terminal', 'Could not open the terminal')}
              </div>
              {tab.error && <div className="text-ink-muted break-words select-text">{tab.error}</div>}
              {tab.status === 'lost' && (
                <div className="text-ink-faint">
                  {tr('Comandos que estavam rodando foram encerrados pelo servidor.', 'Commands that were running were ended by the server.')}
                </div>
              )}
            </div>
            <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void reconnect(tab.id)}>
              <RotateCw className="w-3.5 h-3.5" />
              {tab.status === 'exited' ? tr('Abrir de novo', 'Open again') : tab.status === 'lost' ? tr('Reconectar', 'Reconnect') : tr('Tentar de novo', 'Try again')}
            </button>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => closeTerminal(tab.id)}>
              {tr('Fechar aba', 'Close tab')}
            </button>
          </div>
        )}
      </div>

      {/* Why the last command failed, in plain words */}
      {hint && connected && (
        <div className="shrink-0 flex items-center gap-2.5 border-t border-line bg-amber-500/[0.07] px-3 py-1.5 text-[12.5px]">
          <Lightbulb className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="flex-1 min-w-0 text-ink">{hint.text}</span>
          {hint.fix && (
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm shrink-0"
              onClick={() => {
                const fix = hint.fix!;
                setHint(null);
                if (fix.run) runCommand(fix.command);
                else if (settings.assistant) barRef.current?.insert(fix.command);
                else {
                  termRef.current?.paste(fix.command);
                  termRef.current?.focus();
                }
              }}
              title={hint.fix.command}
            >
              {hint.fix.label}
              <code className="font-mono text-[11px] text-ink-faint max-w-[16rem] truncate">{hint.fix.command}</code>
            </button>
          )}
          <button type="button" className="ui-icon-btn ui-icon-btn-sm shrink-0" onClick={() => setHint(null)} aria-label={tr('Dispensar', 'Dismiss')}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Status */}
      <div className="shrink-0 flex items-center gap-3 border-t border-line bg-surface-sunken px-3 h-7 text-[11.5px] text-ink-muted select-none min-w-0">
        <span className="inline-flex items-center gap-1.5 shrink-0" title={tab.status}>
          <span className={`w-2 h-2 rounded-full ${statusDot}`} />
          <span className="text-ink">{dest}</span>
        </span>
        {tab.cwd && (
          <button
            type="button"
            className="font-mono truncate min-w-0 hover:text-ink hover:underline decoration-dotted text-left"
            title={onOpenFolder ? tr(`${tab.cwd} — mostrar nos arquivos`, `${tab.cwd} — show in files`) : tab.cwd}
            onClick={() => onOpenFolder?.(tab.sessionId, tab.cwd!)}
          >
            {tab.cwd}
          </button>
        )}
        <span className="flex-1" />
        {tab.busy ? (
          <span className="inline-flex items-center gap-1.5 shrink-0 text-ink">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-rust-500" />
            {tr('Executando', 'Running')} {tab.busySince ? formatDuration(Date.now() - tab.busySince, isPt) : ''}
          </span>
        ) : (
          lastResult
        )}
        {osName && <span className="hidden lg:inline shrink-0 text-ink-faint">{osName}</span>}
        {connected && (
          <span
            className="shrink-0 text-ink-faint"
            title={
              tab.integration
                ? tr('Os comandos deste terminal entram no histórico local e você é avisado quando terminam.', 'Commands in this terminal go to the local history, and you are told when they finish.')
                : tr(
                    'Este shell não informa os comandos que roda: o histórico guarda só o que você executar pelo assistente. Os avisos de conclusão funcionam com bash.',
                    'This shell does not report the commands it runs: the history keeps only what you run from the assistant. Finish notices need bash.'
                  )
            }
          >
            {tab.integration ? tr('histórico ativo', 'history on') : tr('histórico limitado', 'limited history')}
          </span>
        )}
      </div>

      {settings.assistant && (
        <CommandBar
          ref={barRef}
          isPt={isPt}
          pm={pm}
          history={history}
          isRoot={isRoot}
          disabled={!connected}
          onRun={runCommand}
          onEscape={() => termRef.current?.focus()}
        />
      )}
    </div>
  );
});
TerminalView.displayName = 'TerminalView';

export default TerminalView;
