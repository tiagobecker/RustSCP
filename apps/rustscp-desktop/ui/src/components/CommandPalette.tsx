import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { plainTextInputProps } from '../utils/inputHardening.ts';

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  icon?: React.ReactNode;
  shortcut?: string;
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** Fuzzy-ish scorer: every query token must appear; earlier/word-start matches rank higher. */
function score(cmd: PaletteCommand, tokens: string[]): number {
  const hay = normalize(`${cmd.label} ${cmd.group} ${cmd.keywords || ''}`);
  const label = normalize(cmd.label);
  let total = 0;
  for (const t of tokens) {
    const i = hay.indexOf(t);
    if (i === -1) return -1;
    total += label.startsWith(t) ? 30 : label.includes(` ${t}`) ? 20 : label.includes(t) ? 10 : 2;
  }
  return total;
}

/** ⌘K command palette — every feature in the app is reachable from here. */
export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, commands }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [isOpen]);

  const results = useMemo(() => {
    const available = commands.filter((c) => !c.disabled);
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return available;
    return available
      .map((c) => ({ c, s: score(c, tokens) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.c);
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!isOpen) return null;

  const run = (cmd?: PaletteCommand) => {
    if (!cmd) return;
    onClose();
    // Let the palette unmount before opening the next dialog
    setTimeout(cmd.run, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  // Group while preserving rank order when searching
  const grouped: Array<{ group: string; items: Array<{ cmd: PaletteCommand; idx: number }> }> = [];
  results.forEach((cmd, idx) => {
    const key = query ? '' : cmd.group;
    let g = grouped.find((x) => x.group === key);
    if (!g) {
      g = { group: key, items: [] };
      grouped.push(g);
    }
    g.items.push({ cmd, idx });
  });

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4 bg-black/30 dark:bg-black/50 animate-in"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title', 'Command palette')}
        className="w-full max-w-xl rounded-2xl bg-surface-raised shadow-modal overflow-hidden animate-pop"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line">
          <Search className="w-4 h-4 text-ink-faint shrink-0" />
          <input
            ref={inputRef}
            {...plainTextInputProps}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder', 'Search commands, tools and settings…')}
            className="flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-faint outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
          <span className="text-[11px] text-ink-faint">esc</span>
        </div>
        <div ref={listRef} id="palette-list" role="listbox" className="max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-ink-faint">{t('palette.empty', 'No matching commands')}</div>
          )}
          {grouped.map((g) => (
            <div key={g.group || 'results'} className="mb-1 last:mb-0">
              {g.group && <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-ink-faint">{g.group}</div>}
              {g.items.map(({ cmd, idx }) => (
                <button
                  key={cmd.id}
                  type="button"
                  role="option"
                  aria-selected={idx === active}
                  data-idx={idx}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => run(cmd)}
                  className={`w-full flex items-center gap-3 px-2.5 h-9 rounded-lg text-left text-[13px] transition-colors ${
                    idx === active ? 'bg-dark-650/80 text-ink' : 'text-ink'
                  }`}
                >
                  <span className="w-4 h-4 flex items-center justify-center text-ink-muted shrink-0">{cmd.icon}</span>
                  <span className="flex-1 truncate">{cmd.label}</span>
                  {query && <span className="text-[11px] text-ink-faint truncate max-w-[30%]">{cmd.group}</span>}
                  {cmd.shortcut && <span className="text-[11px] text-ink-faint tabular-nums">{cmd.shortcut}</span>}
                  {idx === active && <CornerDownLeft className="w-3.5 h-3.5 text-ink-faint" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
