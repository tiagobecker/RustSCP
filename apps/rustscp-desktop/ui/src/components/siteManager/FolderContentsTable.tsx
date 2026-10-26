import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Folder } from 'lucide-react';
import { useVirtualRows } from '../../utils/useVirtualRows.ts';
import { ProtocolGlyph } from './SiteTreeRow.tsx';
import { defaultDir, folderTableRows } from './folderTable.ts';
import type { SortDir, TableRow, TableSort } from './folderTable.ts';
import { LABEL_DOT_CLASS } from './labelsModel.ts';
import { fullDateText, recentText } from './siteFormat.ts';
import { canonicalProtocol, formatCount, isLocalSite, protocolTag, siteAddress } from './siteTreeModel.ts';
import type { ConnectionConfig, TreeModel } from './types.ts';

interface Props {
  model: TreeModel;
  /** The folder ('' = every top-level item) */
  path: string;
  /** Its name, for the grid's label */
  name: string;
  /** Sites with an open tab (a green dot on their icon) */
  openSiteIds: ReadonlySet<string>;
  /** A click (or Space): shows the item in the tree, which keeps this overview */
  onReveal: (itemKey: string) => void;
  /** Double-click or Enter on a site */
  onConnect: (site: ConnectionConfig) => void;
  /** Double-click or Enter on a folder: its own overview */
  onOpenFolder: (path: string) => void;
}

const ROW_H = 28;
const GRID = 'grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_60px_104px] items-center gap-x-3 px-2.5';

/** Sort, direction and "Include subfolders", kept for this run of the app (never stored). */
const session: { sort: TableSort; dir: SortDir; flat: boolean } = { sort: 'name', dir: 'asc', flat: false };

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/**
 * The folder overview's contents (spec §12): sortable columns, 28px virtualized rows, subfolders
 * first, and "Include subfolders" to list every site underneath. One `role="grid"` with an active row.
 */
export const FolderContentsTable: React.FC<Props> = ({ model, path, name, openSiteIds, onReveal, onConnect, onOpenFolder }) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [view, setViewState] = useState(() => ({ ...session }));
  const setView = (patch: Partial<typeof session>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      Object.assign(session, next);
      return next;
    });
  };
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** "Sorted by Name, ascending", read once a header button changes the sort */
  const [sortNote, setSortNote] = useState('');

  const rows = useMemo(() => folderTableRows(model, path, view), [model, path, view]);
  // Like the tree, a dot shows only where the label differs from the one this folder passes down
  const baseLabel = model.folders.get(path)?.effectiveLabel ?? null;
  const activeIndex = activeKey ? rows.findIndex((r) => r.key === activeKey) : -1;
  const { scrollRef, onScroll, range, totalHeight, isPinnedOutside, scrollToIndex, pageSize } = useVirtualRows({ count: rows.length, rowHeight: ROW_H, pinIndex: activeIndex });

  // Another folder: start at the top with nothing active
  useEffect(() => {
    setActiveKey(null);
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [path, scrollRef]);

  const sortBy = (sort: TableSort, label: string) => {
    const dir: SortDir = sort === view.sort ? (view.dir === 'asc' ? 'desc' : 'asc') : defaultDir(sort);
    setView(sort === view.sort ? { dir } : { sort, dir });
    setSortNote(
      t('siteTree.a11ySorted', {
        column: label,
        direction: dir === 'asc' ? t('siteTree.ascending', 'ascending') : t('siteTree.descending', 'descending'),
        defaultValue: 'Sorted by {{column}}, {{direction}}',
      })
    );
  };

  const open = (row: TableRow) => {
    if (row.kind === 'site') onConnect(row.site);
    else onOpenFolder(row.node.path);
  };

  const activate = (i: number, reveal: boolean) => {
    const row = rows[i];
    if (!row) return;
    setActiveKey(row.key);
    scrollToIndex(i, 'nearest');
    if (reveal) onReveal(row.key);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return;
    const n = rows.length;
    if (n === 0) return;
    const cur = activeIndex;
    let to: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        to = cur < 0 ? 0 : Math.min(n - 1, cur + 1);
        break;
      case 'ArrowUp':
        to = cur < 0 ? n - 1 : Math.max(0, cur - 1);
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = n - 1;
        break;
      case 'PageDown':
        to = Math.min(n - 1, Math.max(0, cur) + pageSize);
        break;
      case 'PageUp':
        to = Math.max(0, Math.max(0, cur) - pageSize);
        break;
      case 'Enter':
        if (cur >= 0) open(rows[cur]);
        e.preventDefault();
        return;
      case ' ':
        if (cur >= 0) onReveal(rows[cur].key);
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    activate(to, false);
  };

  const rowFromEvent = (e: React.MouseEvent): number => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-table-index]');
    return el ? Number(el.dataset.tableIndex) : -1;
  };

  const columns: Array<{ id: TableSort; label: string }> = [
    { id: 'name', label: t('siteTree.sortName', 'Name') },
    { id: 'address', label: t('siteTree.colAddress', 'Address') },
    { id: 'protocol', label: t('siteTree.sortProtocol', 'Protocol') },
    { id: 'last', label: t('siteTree.sortLastConnected', 'Last connected') },
  ];

  const indices: number[] = [];
  for (let i = range.first; i < range.last; i++) indices.push(i);
  if (isPinnedOutside && activeIndex >= 0) indices.push(activeIndex);
  const rowId = (i: number) => `${baseId}-r${i}`;

  const renderRow = (i: number) => {
    const row = rows[i];
    const active = i === activeIndex;
    let nameCell: React.ReactNode;
    let address: React.ReactNode = null;
    let proto: React.ReactNode = null;
    let at: number | null = null;
    let title: string;
    if (row.kind === 'folder') {
      const node = row.node;
      const label = node.effectiveLabel && node.effectiveLabel !== baseLabel ? model.labels.get(node.effectiveLabel) : undefined;
      nameCell = (
        <>
          <Folder aria-hidden className="w-4 h-4 shrink-0 text-ink-faint" />
          <span className="truncate font-medium">{node.name}</span>
          {label && <span aria-hidden title={label.name} className={`w-1.5 h-1.5 rounded-[1.5px] shrink-0 ${LABEL_DOT_CLASS[label.color]}`} />}
          {label && <span className="sr-only">{`, ${t('siteTree.a11yLabel', { name: label.name, defaultValue: 'label {{name}}' })}`}</span>}
        </>
      );
      address = (
        <span className="text-ink-faint">
          {t('siteTree.statsConnections', { count: node.count, formatted: formatCount(lang, node.count), defaultValue_zero: 'No connections', defaultValue_one: '1 connection', defaultValue_other: '{{formatted}} connections' })}
        </span>
      );
      at = node.lastAt;
      title = node.path;
    } else {
      const site = row.site;
      const local = isLocalSite(site);
      const labelId = model.siteLabel.get(site.id);
      const label = labelId && labelId !== baseLabel ? model.labels.get(labelId) : undefined;
      const labelName = labelId ? model.labels.get(labelId)?.name : undefined;
      const ftp = !local && canonicalProtocol(site.protocol) === 'ftp';
      nameCell = (
        <>
          <span className="relative inline-flex shrink-0">
            <ProtocolGlyph site={site} />
            {openSiteIds.has(site.id) && (
              // Same place as in the tree: bottom-right, top-right for FTP (its lock badge is bottom-right)
              <span aria-hidden className={cx('absolute -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 ring-[1.5px] ring-surface-raised', ftp ? '-top-0.5' : '-bottom-0.5')} />
            )}
          </span>
          <span className="truncate">{site.name}</span>
          {label && <span aria-hidden title={label.name} className={`w-1.5 h-1.5 rounded-[1.5px] shrink-0 ${LABEL_DOT_CLASS[label.color]}`} />}
          {/* The dots' meaning for screen readers (never colour alone) */}
          <span className="sr-only">
            {[labelName ? t('siteTree.a11yLabel', { name: labelName, defaultValue: 'label {{name}}' }) : '', openSiteIds.has(site.id) ? t('siteTree.a11yConnected', 'connected') : '']
              .filter(Boolean)
              .map((x) => `, ${x}`)
              .join('')}
          </span>
        </>
      );
      address = local ? <span className="text-ink-faint">{t('siteTree.thisComputer', 'This computer')}</span> : siteAddress(site);
      proto = local ? null : <span className={cx('text-[11px] font-medium', ftp && 'text-amber-700 dark:text-amber-400')}>{protocolTag(site.protocol)}</span>;
      at = model.recentAt.get(site.id) ?? null;
      title = [
        site.name,
        siteAddress(site),
        row.folder,
        labelName ? t('siteTree.pillLabel', { value: labelName, defaultValue: 'Label: {{value}}' }) : '',
        openSiteIds.has(site.id) ? t('siteTree.openInTab', 'Open in a tab') : '',
        t('loginDialog.doubleClickHint', 'Double-click to connect'),
      ]
        .filter(Boolean)
        .join('\n');
    }
    return (
      <div
        key={row.key}
        id={rowId(i)}
        role="row"
        aria-rowindex={i + 2}
        aria-selected={active}
        data-table-index={i}
        title={title}
        className={cx(GRID, 'absolute inset-x-0 text-[12.5px] text-ink cursor-default select-none', active ? 'bg-dark-650' : 'hover:bg-dark-650/50')}
        style={{ top: i * ROW_H, height: ROW_H }}
      >
        <div role="gridcell" className="min-w-0 flex items-center gap-2">
          {nameCell}
        </div>
        <div role="gridcell" className="min-w-0 truncate text-ink-muted">
          {address}
        </div>
        <div role="gridcell" className="min-w-0 truncate text-ink-muted">
          {proto}
        </div>
        <div role="gridcell" className="min-w-0 truncate text-right tabular-nums text-[11.5px] text-ink-faint" title={at ? fullDateText(at, lang) : undefined}>
          {at ? recentText(at, lang, t) : ''}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-[196px] flex flex-col">
      <div className="h-7 flex items-center gap-2">
        <h3 className="text-[12px] font-medium text-ink-faint">{t('siteTree.contents', 'Contents')}</h3>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-[12px] text-ink-muted select-none">
          <input type="checkbox" className="accent-rust-500" checked={view.flat} onChange={(e) => setView({ flat: e.target.checked })} />
          {t('siteTree.includeSubfolders', 'Include subfolders')}
        </label>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {sortNote}
      </span>
      <div
        role="grid"
        tabIndex={0}
        aria-label={t('siteTree.contentsOf', { name, defaultValue: 'Contents of “{{name}}”' })}
        aria-rowcount={rows.length + 1}
        aria-colcount={4}
        aria-activedescendant={activeIndex >= 0 ? rowId(activeIndex) : undefined}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          // Keyboard users land on the first row
          if (e.target === e.currentTarget && activeIndex < 0 && rows.length > 0) setActiveKey(rows[0].key);
        }}
        className="flex-1 min-h-0 flex flex-col rounded-lg border border-line overflow-hidden focus-visible:[outline-offset:-1px]"
      >
        <div role="row" aria-rowindex={1} className={cx(GRID, 'h-7 shrink-0 border-b border-line text-[11.5px] text-ink-faint')}>
          {columns.map((c, ci) => {
            const sorted = view.sort === c.id;
            return (
              <div
                key={c.id}
                role="columnheader"
                aria-sort={sorted ? (view.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={cx('min-w-0 flex', ci === 3 && 'justify-end')}
              >
                {/* Tabbable, so the sort is reachable without a pointer (a click keeps the grid's focus) */}
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => sortBy(c.id, c.label)}
                  title={t('siteTree.sortByColumn', { column: c.label, defaultValue: 'Sort by {{column}}' })}
                  className={cx('min-w-0 flex items-center gap-1 hover:text-ink', sorted && 'text-ink-muted font-medium')}
                >
                  <span className="truncate">{c.label}</span>
                  {sorted && (view.dir === 'asc' ? <ArrowUp aria-hidden className="w-3 h-3 shrink-0" /> : <ArrowDown aria-hidden className="w-3 h-3 shrink-0" />)}
                </button>
              </div>
            );
          })}
        </div>
        <div
          ref={scrollRef}
          role="rowgroup"
          tabIndex={-1}
          onScroll={onScroll}
          onMouseDown={(e) => {
            // A row click keeps keyboard focus on the grid (the scrollbar still drags)
            if (rowFromEvent(e) < 0) return;
            e.preventDefault();
            (e.currentTarget.parentElement as HTMLElement | null)?.focus({ preventScroll: true });
          }}
          onClick={(e) => {
            const i = rowFromEvent(e);
            if (i >= 0 && e.detail <= 1) activate(i, true);
          }}
          onDoubleClick={(e) => {
            const i = rowFromEvent(e);
            if (i >= 0) open(rows[i]);
          }}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden relative"
        >
          {rows.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] text-ink-faint">{t('siteTree.tableEmpty', 'Nothing here yet.')}</p>
          ) : (
            <div className="relative" style={{ height: totalHeight }}>
              {indices.map(renderRow)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
