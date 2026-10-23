import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, CornerDownLeft, History, ShieldAlert, Sparkles } from 'lucide-react';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import {
  dangerOf,
  DangerWarning,
  explainCommand,
  firstPlaceholder,
  fold,
  localizeCommand,
  PackageManager,
  searchSnippets,
  snippetCommand,
} from './commandCatalog.ts';

export interface CommandBarHandle {
  /** Puts `text` in the bar (selecting its first `<…>` placeholder) and focuses it. */
  insert: (text: string) => void;
  focus: () => void;
}

interface Suggestion {
  kind: 'history' | 'snippet';
  command: string;
  label?: string;
}

interface Props {
  isPt: boolean;
  pm: PackageManager;
  /** Commands run on this server, newest first. */
  history: string[];
  disabled?: boolean;
  /** The account is root (no sudo hints). */
  isRoot?: boolean;
  onRun: (command: string) => void;
  /** Escape on an empty bar: back to the terminal. */
  onEscape: () => void;
}

/**
 * The command assistant under the terminal: type a command or describe a task in plain words
 * ("disk space", "restart nginx"), see what the command does before running it, and get a
 * second look before anything destructive runs.
 */
export const CommandBar = forwardRef<CommandBarHandle, Props>(({ isPt, pm, history, disabled, isRoot, onRun, onEscape }, ref) => {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [selIndex, setSelIndex] = useState(-1);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [confirm, setConfirm] = useState<DangerWarning | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectPlaceholder = (text: string) => {
    const range = firstPlaceholder(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (range) el.setSelectionRange(range[0], range[1]);
      else el.setSelectionRange(text.length, text.length);
    });
  };

  const put = (text: string) => {
    setValue(text);
    setConfirm(null);
    setNotice(null);
    setSelIndex(-1);
    setHistoryIndex(-1);
    setDismissedFor(text);
    selectPlaceholder(text);
  };

  useImperativeHandle(ref, () => ({ insert: put, focus: () => inputRef.current?.focus() }));

  const suggestions = useMemo<Suggestion[]>(() => {
    const q = value.trim();
    if (!focused || dismissedFor === value) return [];
    if (!q) return history.slice(0, 5).map((command) => ({ kind: 'history' as const, command }));
    const fq = fold(q);
    const seen = new Set<string>([q]);
    const out: Suggestion[] = [];
    for (const command of history) {
      if (out.length >= 4) break;
      if (!seen.has(command) && fold(command).includes(fq)) {
        seen.add(command);
        out.push({ kind: 'history', command });
      }
    }
    for (const s of searchSnippets(q, isPt, pm, 6)) {
      const command = localizeCommand(snippetCommand(s, pm), isPt);
      if (seen.has(command)) continue;
      seen.add(command);
      out.push({ kind: 'snippet', command, label: isPt ? s.title[0] : s.title[1] });
    }
    return out.slice(0, 8);
  }, [value, focused, dismissedFor, history, isPt, pm]);

  const explanation = useMemo(() => explainCommand(value, isPt), [value, isPt]);
  const needsSudo = !isRoot && explanation.some((p) => p.root) && !/^\s*sudo\b/.test(value);

  const run = (force = false) => {
    const command = value.trim();
    if (!command || disabled) return;
    const placeholder = firstPlaceholder(command);
    if (placeholder) {
      setNotice(
        isPt
          ? `Troque ${command.slice(placeholder[0], placeholder[1])} pelo valor certo antes de executar.`
          : `Replace ${command.slice(placeholder[0], placeholder[1])} with the right value first.`
      );
      selectPlaceholder(value);
      return;
    }
    const danger = dangerOf(command, isPt);
    if (danger && !force) {
      setConfirm(danger);
      return;
    }
    setConfirm(null);
    setNotice(null);
    setValue('');
    setHistoryIndex(-1);
    setSelIndex(-1);
    onRun(command);
  };

  const accept = (s: Suggestion) => put(s.command);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (confirm) return; // the warning's buttons decide
      if (selIndex >= 0 && suggestions[selIndex]) accept(suggestions[selIndex]);
      else run();
    } else if (e.key === 'Tab' && suggestions.length > 0 && !e.shiftKey) {
      e.preventDefault();
      accept(suggestions[Math.max(0, selIndex)]);
    } else if (e.key === 'ArrowDown') {
      if (suggestions.length > 0) {
        e.preventDefault();
        setSelIndex((i) => (i + 1) % suggestions.length);
      } else if (historyIndex >= 0) {
        e.preventDefault();
        const next = historyIndex - 1;
        setHistoryIndex(next);
        setValue(next >= 0 ? history[next] : '');
        setDismissedFor(next >= 0 ? history[next] : '');
      }
    } else if (e.key === 'ArrowUp') {
      if (suggestions.length > 0 && selIndex >= 0) {
        e.preventDefault();
        setSelIndex((i) => i - 1);
      } else if (history.length > 0 && (historyIndex >= 0 || !value)) {
        e.preventDefault();
        const next = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(next);
        setValue(history[next]);
        setDismissedFor(history[next]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (confirm) setConfirm(null);
      else if (suggestions.length > 0) setDismissedFor(value);
      else if (value) put('');
      else onEscape();
    }
  };

  const placeholder = isPt
    ? 'Digite um comando ou descreva o que quer fazer: “espaço em disco”, “reiniciar nginx”…'
    : 'Type a command or describe what you want: “disk space”, “restart nginx”…';

  return (
    <div className="relative shrink-0 border-t border-line bg-surface-raised px-2 pt-1.5 pb-1.5">
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-2 right-2 mb-1 z-20 ui-menu max-h-72 overflow-y-auto p-1" role="listbox" aria-label={isPt ? 'Sugestões' : 'Suggestions'}>
          {!value.trim() && (
            <div className="px-2.5 pt-1 pb-1.5 text-[11.5px] text-ink-faint">{isPt ? 'Comandos recentes neste servidor' : 'Recent commands on this server'}</div>
          )}
          {suggestions.map((s, i) => (
            <button
              key={`${s.kind}:${s.command}`}
              type="button"
              role="option"
              aria-selected={i === selIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => accept(s)}
              onMouseEnter={() => setSelIndex(i)}
              className={`w-full flex items-start gap-2.5 px-2.5 py-1.5 rounded-md text-left ${i === selIndex ? 'bg-dark-650/80' : 'hover:bg-dark-650/50'}`}
            >
              {s.kind === 'history' ? (
                <History className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-faint" aria-label={isPt ? 'Histórico' : 'History'} />
              ) : (
                <BookOpen className="w-3.5 h-3.5 mt-0.5 shrink-0 text-rust-500" aria-label={isPt ? 'Sugestão' : 'Suggestion'} />
              )}
              <span className="min-w-0 flex-1">
                {s.label && <span className="block text-[12.5px] text-ink truncate">{s.label}</span>}
                <span className={`block font-mono text-[12px] truncate ${s.label ? 'text-ink-muted' : 'text-ink'}`}>{s.command}</span>
              </span>
            </button>
          ))}
          <div className="px-2.5 pt-1.5 pb-0.5 text-[11px] text-ink-faint border-t border-line mt-1">
            {isPt ? 'Tab ou clique coloca na barra para revisar · Enter executa o que está na barra' : 'Tab or click puts it in the bar to review · Enter runs what is in the bar'}
          </div>
        </div>
      )}

      {confirm && (
        <div
          role="alertdialog"
          className={`mb-1.5 flex items-start gap-2.5 rounded-lg px-3 py-2 text-[12.5px] ${
            confirm.level === 'critical' ? 'bg-red-500/10 text-red-800 dark:text-red-300' : 'bg-amber-500/10 text-amber-900 dark:text-amber-200'
          }`}
        >
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">{isPt ? 'Confira antes de executar' : 'Check before running'}</div>
            <div className="mt-0.5">{confirm.text}</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => setConfirm(null)} autoFocus>
              {isPt ? 'Cancelar' : 'Cancel'}
            </button>
            <button type="button" className="ui-btn ui-btn-danger ui-btn-sm" onClick={() => run(true)}>
              {isPt ? 'Executar mesmo assim' : 'Run anyway'}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 shrink-0 text-rust-500" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          {...plainTextInputProps}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            setSelIndex(-1);
            setHistoryIndex(-1);
            setConfirm(null);
            setNotice(null);
            setDismissedFor(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={isPt ? 'Assistente de comandos' : 'Command assistant'}
          className="ui-input h-8 flex-1 font-mono text-[12.5px]"
        />
        <button
          type="button"
          className="ui-btn ui-btn-primary ui-btn-sm shrink-0"
          disabled={disabled || !value.trim()}
          onClick={() => run()}
          title={isPt ? 'Executar no terminal (Enter)' : 'Run in the terminal (Enter)'}
        >
          <CornerDownLeft className="w-3.5 h-3.5" />
          {isPt ? 'Executar' : 'Run'}
        </button>
      </div>

      {(notice || explanation.length > 0 || needsSudo) && (
        <div className="mt-1 ml-6 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11.5px] leading-snug text-ink-muted">
          {notice ? (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-3 h-3" />
              {notice}
            </span>
          ) : (
            explanation.slice(0, 6).map((p, i) => (
              <span key={`${p.token}-${i}`} className="min-w-0">
                <code className="font-mono text-ink bg-dark-650/60 rounded px-1 py-px">{p.token}</code> {p.text}
              </span>
            ))
          )}
          {needsSudo && !notice && (
            <span className="text-amber-700 dark:text-amber-300">
              {isPt ? 'Provavelmente precisa de sudo (administrador).' : 'Probably needs sudo (administrator).'}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
CommandBar.displayName = 'CommandBar';
