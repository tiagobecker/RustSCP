import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleDot, Copy, CornerDownLeft, Play, Search, Trash2, X, XCircle, CheckCircle2 } from 'lucide-react';
import { copyText } from '../copyToClipboard.ts';
import { notify } from '../ui/toast.tsx';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { CATEGORIES, CategoryId, dangerOf, firstPlaceholder, localizeCommand, PackageManager, searchSnippets, SNIPPETS, snippetCommand } from './commandCatalog.ts';
import { bumpHistory, call, errText, formatDuration, HistoryEntry, useTerminalStore } from './terminalStore.ts';

interface Props {
  isPt: boolean;
  pm: PackageManager;
  side: 'shortcuts' | 'history';
  onSideChange: (side: 'shortcuts' | 'history') => void;
  /** Server of the terminal shown (`user@host:port`). */
  siteKey?: string;
  siteTitle?: string;
  /** Puts a command in the assistant for review. */
  onInsert: (command: string) => void;
  /** Runs a command in the terminal shown. */
  onRun: (command: string) => void;
  onClose: () => void;
}

function timeAgo(iso: string, isPt: boolean): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return isPt ? 'agora' : 'now';
  const m = Math.round(s / 60);
  if (m < 60) return isPt ? `há ${m} min` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return isPt ? `há ${h} h` : `${h} h ago`;
  return new Date(t).toLocaleDateString(isPt ? 'pt-BR' : 'en-US', { day: '2-digit', month: 'short' });
}

/** Ready-made commands by task, and the local history of commands run in terminals. */
export const TerminalSidePanel: React.FC<Props> = ({ isPt, pm, side, onSideChange, siteKey, siteTitle, onInsert, onRun, onClose }) => {
  const tr = (pt: string, en: string) => (isPt ? pt : en);
  const historyVersion = useTerminalStore((s) => s.historyVersion);
  const [query, setQuery] = useState('');
  const [openCats, setOpenCats] = useState<Set<CategoryId>>(() => new Set<CategoryId>(['system', 'disk']));
  const [scope, setScope] = useState<'site' | 'all'>('site');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (side !== 'history') return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      call<HistoryEntry[]>('terminal_history', { query, siteKey: scope === 'site' ? siteKey : undefined, limit: 400 })
        .then((list) => !cancelled && setEntries(list))
        .catch(() => !cancelled && setEntries([]))
        .finally(() => !cancelled && setLoading(false));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [side, query, scope, siteKey, historyVersion]);

  /** Runs right away unless the command needs a value filled in or deserves a second look. */
  const runOrReview = (command: string) => {
    if (firstPlaceholder(command) || dangerOf(command, isPt)) onInsert(command);
    else onRun(command);
  };

  const snippetsByCategory = useMemo(() => {
    const matching = query.trim() ? new Set(searchSnippets(query, isPt, pm, 100).map((s) => s.id)) : null;
    return CATEGORIES.map((c) => ({
      ...c,
      items: SNIPPETS.filter((s) => s.category === c.id && (!matching || matching.has(s.id))),
    })).filter((c) => c.items.length > 0);
  }, [query, isPt, pm]);

  const removeEntry = async (id: string) => {
    try {
      await call('terminal_history_delete', { ids: [id] });
      setEntries((list) => list.filter((e) => e.id !== id));
    } catch (e) {
      notify.error(tr('Não foi possível apagar', 'Could not delete'), errText(e));
    }
  };

  const clearHistory = async () => {
    setConfirmClear(false);
    try {
      await call('terminal_history_clear', { siteKey: scope === 'site' ? siteKey : undefined });
      setEntries([]);
      bumpHistory();
    } catch (e) {
      notify.error(tr('Não foi possível limpar o histórico', 'Could not clear the history'), errText(e));
    }
  };

  const segment = (id: 'shortcuts' | 'history', label: string) => (
    <button
      type="button"
      onClick={() => {
        onSideChange(id);
        setQuery('');
      }}
      className={`flex-1 h-6 rounded-md text-[12px] font-medium transition-colors ${side === id ? 'bg-surface-raised text-ink shadow-xs' : 'text-ink-muted hover:text-ink'}`}
      aria-pressed={side === id}
    >
      {label}
    </button>
  );

  return (
    <aside className="w-[300px] shrink-0 border-l border-line bg-surface flex flex-col min-h-0" aria-label={tr('Ajuda do terminal', 'Terminal help')}>
      <div className="shrink-0 p-2 space-y-2 border-b border-line">
        <div className="flex items-center gap-1">
          <div className="flex-1 flex items-center gap-0.5 rounded-lg bg-dark-650/60 p-0.5">
            {segment('shortcuts', tr('Atalhos', 'Shortcuts'))}
            {segment('history', tr('Histórico', 'History'))}
          </div>
          <button type="button" className="ui-icon-btn ui-icon-btn-sm" onClick={onClose} aria-label={tr('Fechar painel', 'Close panel')}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            {...plainTextInputProps}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={side === 'shortcuts' ? tr('O que você quer fazer?', 'What do you want to do?') : tr('Buscar no histórico', 'Search the history')}
            className="ui-input h-7 pl-8 text-[12.5px]"
          />
        </div>
        {side === 'history' && (
          <div className="flex items-center gap-2 text-[11.5px] text-ink-muted">
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input type="radio" className="accent-rust-500" checked={scope === 'site'} onChange={() => setScope('site')} />
              <span className="truncate max-w-[9rem]" title={siteTitle}>
                {siteTitle || tr('Este servidor', 'This server')}
              </span>
            </label>
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input type="radio" className="accent-rust-500" checked={scope === 'all'} onChange={() => setScope('all')} />
              {tr('Todos', 'All')}
            </label>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {side === 'shortcuts' ? (
          <>
            {snippetsByCategory.length === 0 && (
              <div className="px-3 py-6 text-center text-[12.5px] text-ink-faint">{tr('Nada encontrado. Tente outras palavras.', 'Nothing found. Try other words.')}</div>
            )}
            {snippetsByCategory.map((cat) => {
              const expanded = !!query.trim() || openCats.has(cat.id);
              return (
                <div key={cat.id} className="mb-1">
                  <button
                    type="button"
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-ink-muted hover:text-ink hover:bg-dark-650/50"
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpenCats((prev) => {
                        const next = new Set(prev);
                        if (next.has(cat.id)) next.delete(cat.id);
                        else next.add(cat.id);
                        return next;
                      })
                    }
                  >
                    {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    {isPt ? cat.label[0] : cat.label[1]}
                    <span className="ml-auto text-ink-faint tabular-nums">{cat.items.length}</span>
                  </button>
                  {expanded &&
                    cat.items.map((s) => {
                      const command = localizeCommand(snippetCommand(s, pm), isPt);
                      const reviewFirst = !!firstPlaceholder(command) || !!dangerOf(command, isPt);
                      return (
                        <div key={s.id} className="group flex items-start gap-1 rounded-md px-2 py-1.5 hover:bg-dark-650/50">
                          <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onInsert(command)} title={tr('Colocar no assistente para revisar', 'Put in the assistant to review')}>
                            <span className="block text-[12.5px] text-ink leading-snug">{isPt ? s.title[0] : s.title[1]}</span>
                            <span className="block font-mono text-[11px] text-ink-faint truncate">{command}</span>
                          </button>
                          <button
                            type="button"
                            className="ui-icon-btn ui-icon-btn-sm w-6 h-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                            onClick={() => runOrReview(command)}
                            title={reviewFirst ? tr('Revisar antes de executar', 'Review before running') : tr('Executar agora', 'Run now')}
                          >
                            {reviewFirst ? <CornerDownLeft className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      );
                    })}
                </div>
              );
            })}
            <p className="px-2 pt-2 pb-1 text-[11px] leading-snug text-ink-faint">
              {tr(
                'Clique para levar o comando ao assistente, revisar e preencher o que estiver entre < >. O ▶ executa na hora.',
                'Click to send the command to the assistant, review it and fill in what is between < >. ▶ runs it right away.'
              )}
            </p>
          </>
        ) : (
          <>
            {!loading && entries.length === 0 && (
              <div className="px-3 py-6 text-center text-[12.5px] text-ink-faint">
                {query ? tr('Nenhum comando encontrado.', 'No command found.') : tr('Os comandos que você rodar aparecem aqui.', 'Commands you run show up here.')}
              </div>
            )}
            {entries.map((e) => (
              <div key={e.id} className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-dark-650/50">
                <span className="mt-0.5 shrink-0" title={e.exit_code == null ? tr('Resultado desconhecido', 'Unknown result') : tr(`Código ${e.exit_code}`, `Code ${e.exit_code}`)}>
                  {e.exit_code == null ? (
                    <CircleDot className="w-3.5 h-3.5 text-ink-faint" />
                  ) : e.exit_code === 0 ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-500" />
                  )}
                </span>
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onInsert(e.command)} title={tr('Colocar no assistente', 'Put in the assistant')}>
                  <span className="block font-mono text-[12px] text-ink break-all line-clamp-2">{e.command}</span>
                  <span className="block text-[11px] text-ink-faint truncate">
                    {[scope === 'all' ? e.site_name : null, timeAgo(e.finished_at, isPt), e.duration_ms != null ? formatDuration(e.duration_ms, isPt) : null, e.cwd]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
                <div className="flex items-center shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <button type="button" className="ui-icon-btn ui-icon-btn-sm w-6 h-6" onClick={() => runOrReview(e.command)} title={tr('Executar de novo', 'Run again')}>
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="ui-icon-btn ui-icon-btn-sm w-6 h-6"
                    onClick={() => void copyText(e.command).then((ok) => ok && notify.success(tr('Comando copiado', 'Command copied')))}
                    title={tr('Copiar', 'Copy')}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className="ui-icon-btn ui-icon-btn-sm w-6 h-6" onClick={() => void removeEntry(e.id)} title={tr('Apagar do histórico', 'Delete from history')}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {side === 'history' && (
        <div className="shrink-0 border-t border-line px-2.5 py-2 text-[11px] leading-snug text-ink-faint">
          <p>
            {tr(
              'Salvo neste computador, mesmo depois de sair do servidor. Comandos digitados começando com espaço não são salvos.',
              'Kept on this computer, even after you log out of the server. Commands typed with a leading space are not saved.'
            )}
          </p>
          {entries.length > 0 &&
            (confirmClear ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="text-ink-muted">{scope === 'site' ? tr('Limpar deste servidor?', 'Clear for this server?') : tr('Limpar tudo?', 'Clear everything?')}</span>
                <button type="button" className="ui-btn ui-btn-danger ui-btn-sm h-6" onClick={() => void clearHistory()}>
                  {tr('Limpar', 'Clear')}
                </button>
                <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm h-6" onClick={() => setConfirmClear(false)}>
                  {tr('Cancelar', 'Cancel')}
                </button>
              </div>
            ) : (
              <button type="button" className="mt-1 text-ink-muted hover:text-red-600 dark:hover:text-red-400 underline decoration-dotted" onClick={() => setConfirmClear(true)}>
                {scope === 'site' ? tr('Limpar o histórico deste servidor', "Clear this server's history") : tr('Limpar todo o histórico', 'Clear all history')}
              </button>
            ))}
        </div>
      )}
    </aside>
  );
};

/** Unique commands of a history list, newest first. */
export function uniqueCommands(entries: HistoryEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    if (seen.has(e.command)) continue;
    seen.add(e.command);
    out.push(e.command);
  }
  return out;
}
