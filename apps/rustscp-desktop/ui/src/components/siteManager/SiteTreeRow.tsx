import React, { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Cloud,
  Ellipsis,
  Folder,
  FolderOpen,
  Globe,
  GlobeLock,
  HardDrive,
  LockOpen,
  Network,
  Plus,
  Server,
} from 'lucide-react';
import type { ConnectionConfig } from '../../types.ts';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { matchRanges } from './siteQuery.ts';
import { canonicalProtocol, formatCount, isLocalSite, protocolTag, rowIndent, siteAddress } from './siteTreeModel.ts';
import type { TreeRow } from './types.ts';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Left of the indent guide for ancestor level `k` (the middle of that level's twisty). */
const guideLeft = (k: number): number => rowIndent(k) + 7.5;

/** Text with `<mark>` around the search matches (accents and case ignored). */
export const Highlight: React.FC<{ text: string; terms: readonly string[] }> = ({ text, terms }) => {
  if (!terms.length || !text) return <>{text}</>;
  const ranges = matchRanges(text, terms);
  if (!ranges.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <mark key={i} className="stree-match">
        {text.slice(s, e)}
      </mark>
    );
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
};

/** Monochrome protocol icon; only plain FTP is amber (it is not encrypted). */
export const ProtocolGlyph: React.FC<{ site: ConnectionConfig; selected?: boolean; className?: string }> = ({ site, selected, className = 'w-4 h-4' }) => {
  const p = isLocalSite(site) ? 'local' : canonicalProtocol(site.protocol);
  const tone = p === 'ftp' ? 'text-amber-700 dark:text-amber-400' : selected ? 'text-rust-500' : 'text-ink-faint';
  const cls = cx(className, 'shrink-0', tone);
  switch (p) {
    case 'ftps':
      return <GlobeLock className={cls} aria-hidden />;
    case 'ftp':
      return (
        <span className={cx('relative inline-flex', tone)} aria-hidden>
          <Globe className={cx(className, 'shrink-0')} />
          <LockOpen className="absolute -right-[3px] -bottom-[3px] w-2.5 h-2.5" strokeWidth={2.5} />
        </span>
      );
    case 's3':
      return <Cloud className={cls} aria-hidden />;
    case 'webdav':
      return <Network className={cls} aria-hidden />;
    case 'local':
      return <HardDrive className={cls} aria-hidden />;
    default:
      return <Server className={cls} aria-hidden />;
  }
};

export interface RowEditState {
  value: string;
  error: string | null;
  ariaLabel: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onBlur: () => void;
}

export interface SiteTreeRowProps {
  row: TreeRow;
  index: number;
  domId: string;
  top: number;
  height: number;
  compact: boolean;
  showAddress: boolean;
  selected: boolean;
  active: boolean;
  /** Ancestor level whose guide is drawn strong (the selected row's parent), or -1 */
  strongGuide: number;
  nameTerms: readonly string[];
  addressTerms: readonly string[];
  /** For the "All connections" header: whether any folder is expanded (its collapse/expand-all button) */
  anyExpanded: boolean;
  /** Set only on the row being renamed or named (new folder) */
  edit: RowEditState | null;
}

/** Inline name editor (rename, new folder), with the error bubble under it. */
const NameInput: React.FC<{ edit: RowEditState; domId: string }> = ({ edit, domId }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);
  const errorId = `${domId}-err`;
  return (
    <div className="relative flex-1 min-w-0 mr-2">
      <input
        {...plainTextInputProps}
        ref={ref}
        value={edit.value}
        maxLength={300}
        aria-label={edit.ariaLabel}
        aria-invalid={edit.error ? true : undefined}
        aria-describedby={edit.error ? errorId : undefined}
        onChange={(e) => edit.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            // Never reaches the tree (Enter there connects)
            e.stopPropagation();
            edit.onCommit();
          }
        }}
        onBlur={edit.onBlur}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cx('ui-input h-6 px-1.5 text-[13px]', edit.error && '!border-red-500/70')}
      />
      {edit.error && (
        <div
          id={errorId}
          role="alert"
          className="absolute left-0 top-full mt-1 z-10 max-w-[260px] rounded-md bg-red-600 text-white text-[11.5px] leading-snug px-2 py-1 shadow-pop whitespace-normal"
        >
          {edit.error}
        </div>
      )}
    </div>
  );
};

/** One row of the connections tree (all kinds). Pure CSS hover; memoized on primitive props. */
export const SiteTreeRow = memo(function SiteTreeRow({
  row,
  index,
  domId,
  top,
  height,
  compact,
  showAddress,
  selected,
  active,
  strongGuide,
  nameTerms,
  addressTerms,
  anyExpanded,
  edit,
}: SiteTreeRowProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const depth = row.kind === 'section' ? 0 : row.depth;

  const guides: React.ReactNode[] = [];
  if (row.kind !== 'section' && row.kind !== 'address') {
    for (let k = 0; k < depth; k++) {
      guides.push(<span key={k} aria-hidden className="stree-guide" style={{ left: guideLeft(k) }} data-strong={k === strongGuide ? '' : undefined} />);
    }
  }

  const base = {
    role: 'treeitem' as const,
    id: domId,
    'aria-level': row.level,
    'aria-setsize': row.setsize,
    'aria-posinset': row.posinset,
    'aria-selected': selected,
    'data-row-key': row.key,
    'data-row-index': index,
    'data-active': active ? '' : undefined,
  };
  const style: React.CSSProperties = { top, height, paddingLeft: row.kind === 'section' ? 10 : rowIndent(depth) };
  const rowClass = 'stree-row group absolute inset-x-0 flex items-center pr-2 cursor-default select-none';
  const moreButton = (
    <button
      type="button"
      tabIndex={-1}
      data-action="more"
      aria-label={t('siteTree.moreActions', 'More actions')}
      title={t('siteTree.moreActions', 'More actions')}
      className={cx(
        'w-[22px] h-[22px] shrink-0 items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-dark-600/60',
        selected || edit ? 'flex' : 'hidden group-hover:flex'
      )}
    >
      <Ellipsis className="w-3.5 h-3.5" />
    </button>
  );

  /* ------------------------------- section -------------------------------- */
  if (row.kind === 'section') {
    const name =
      row.sectionId === 'fav' ? t('siteTree.sectionFavorites', 'Favorites') : row.sectionId === 'rec' ? t('siteTree.sectionRecent', 'Recent') : t('siteTree.sectionAll', 'All connections');
    const toggleLabel = anyExpanded ? t('loginDialog.collapseFolders', 'Collapse all folders') : t('loginDialog.expandFolders', 'Expand all folders');
    return (
      <div {...base} aria-expanded={row.expanded} aria-label={name} className={rowClass} style={style}>
        <span className="text-[11.5px] font-medium text-ink-faint truncate">{name}</span>
        <ChevronRight
          aria-hidden
          className={cx(
            'w-3 h-3 ml-1 shrink-0 text-ink-faint transition-transform duration-[120ms] motion-reduce:transition-none',
            row.expanded && 'rotate-90',
            row.expanded && !active && 'opacity-0 group-hover:opacity-100'
          )}
        />
        <span className="flex-1" />
        {row.sectionId === 'all' && (
          <>
            <span className="text-[11px] tabular-nums text-ink-faint">{formatCount(lang, row.count)}</span>
            <button
              type="button"
              tabIndex={-1}
              data-action="toggle-all"
              aria-label={toggleLabel}
              title={toggleLabel}
              className="ml-1 w-5 h-5 hidden group-hover:flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-dark-600/60"
            >
              {anyExpanded ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
            </button>
          </>
        )}
      </div>
    );
  }

  /* -------------------------------- folder -------------------------------- */
  if (row.kind === 'folder') {
    const formatted = formatCount(lang, row.count);
    // "empty" only for a folder with nothing inside; one holding only empty subfolders reads "0 connections"
    const label =
      !row.empty && row.count === 0
        ? t('siteTree.a11yFolder_other', { name: row.name, formatted, defaultValue: '{{name}}, folder, {{formatted}} connections' })
        : t('siteTree.a11yFolder', {
            name: row.name,
            count: row.empty ? 0 : row.count,
            formatted,
            defaultValue_zero: '{{name}}, folder, empty',
            defaultValue_one: '{{name}}, folder, 1 connection',
            defaultValue_other: '{{name}}, folder, {{formatted}} connections',
          });
    return (
      <div {...base} aria-expanded={row.expanded} aria-label={label} className={rowClass} style={style} title={row.path}>
        {guides}
        <span data-action="twisty" className="w-4 h-4 shrink-0 flex items-center justify-center text-ink-faint hover:text-ink">
          <ChevronRight aria-hidden className={cx('w-3 h-3 transition-transform duration-[120ms] motion-reduce:transition-none', row.expanded && 'rotate-90')} />
        </span>
        {row.expanded ? <FolderOpen aria-hidden className="w-4 h-4 shrink-0 text-ink-faint" /> : <Folder aria-hidden className="w-4 h-4 shrink-0 text-ink-faint" />}
        {edit ? (
          <span className="ml-2 flex-1 min-w-0 flex">
            <NameInput edit={edit} domId={domId} />
          </span>
        ) : (
          <>
            <span className="ml-2 flex-1 min-w-0 truncate text-[13px] font-medium text-ink">
              <Highlight text={row.name} terms={nameTerms} />
            </span>
            {row.count > 0 && (
              <span className={cx('ml-2 shrink-0 text-[11px] tabular-nums text-ink-faint', selected ? 'hidden' : 'group-hover:hidden')}>{formatted}</span>
            )}
            <span className="ml-1 flex">{moreButton}</span>
          </>
        )}
      </div>
    );
  }

  /* --------------------------------- site --------------------------------- */
  if (row.kind === 'site') {
    const site = row.site;
    const local = isLocalSite(site);
    const proto = canonicalProtocol(site.protocol);
    const ftp = proto === 'ftp' && !local;
    const tag = local ? t('siteTree.thisComputer', 'This computer') : protocolTag(site.protocol);
    const address = siteAddress(site);
    const path = row.folder ? row.folder.split('/').join(' › ') : '';
    const userAt =
      !local && site.protocol !== 's3' && site.username
        ? t('siteTree.a11yUserAt', { user: site.username, host: address.slice(address.indexOf('@') + 1), defaultValue: '{{user}} at {{host}}' })
        : address;
    const a11y = local
      ? `${site.name}, ${tag}`
      : [site.name, tag, userAt, ftp ? t('siteTree.notEncrypted', 'not encrypted') : null].filter(Boolean).join(', ');
    const tooltip = [site.name, address, row.folder, t('loginDialog.doubleClickHint', 'Double-click to connect')].filter(Boolean).join('\n');
    const tagEl = (
      <span
        className={cx('text-[10.5px] font-medium', ftp && 'text-amber-700 dark:text-amber-400')}
        title={ftp ? `FTP · ${t('siteTree.notEncrypted', 'not encrypted')}` : undefined}
      >
        {tag}
      </span>
    );
    const nameEl = edit ? (
      <NameInput edit={edit} domId={domId} />
    ) : (
      <span className={cx('truncate text-[13px] text-ink', selected && 'font-medium', compact ? 'shrink-0 max-w-[65%]' : 'min-w-0')}>
        <Highlight text={site.name} terms={nameTerms} />
      </span>
    );
    return (
      <div {...base} aria-label={a11y} className={rowClass} style={style} title={edit ? undefined : tooltip}>
        {guides}
        <span className="w-4 h-4 shrink-0" aria-hidden />
        <ProtocolGlyph site={site} selected={selected} />
        {compact ? (
          <span className="ml-2 flex-1 min-w-0 flex items-baseline gap-2">
            {nameEl}
            {!edit && showAddress && (
              <span className="flex-1 min-w-0 truncate text-[12px] text-ink-faint">
                {local ? tag : <Highlight text={address} terms={addressTerms} />}
              </span>
            )}
          </span>
        ) : (
          <span className="ml-2 flex-1 min-w-0 flex flex-col justify-center leading-tight">
            <span className="flex items-center min-w-0">{nameEl}</span>
            {!edit && (
              <span className="truncate text-[11.5px] text-ink-muted mt-px">
                {tagEl}
                {!local && address && (
                  <>
                    {' · '}
                    <Highlight text={address} terms={addressTerms} />
                  </>
                )}
                {row.showPath && path && <span className="text-ink-faint">{` · ${path}`}</span>}
              </span>
            )}
          </span>
        )}
        {!edit && <span className="ml-1 flex">{moreButton}</span>}
      </div>
    );
  }

  /* ------------------------- draft (unsaved new) -------------------------- */
  if (row.kind === 'draft') {
    const name = row.name || t('loginDialog.newConnection', 'New connection');
    return (
      <div
        {...base}
        aria-label={t('siteTree.a11yDraft', { name, defaultValue: '{{name}}, new connection, not saved yet' })}
        className={rowClass}
        style={style}
      >
        {guides}
        <span className="w-4 h-4 shrink-0" aria-hidden />
        <Plus aria-hidden className={cx('w-4 h-4 shrink-0', selected ? 'text-rust-500' : 'text-ink-faint')} />
        <span className={cx('ml-2 flex-1 min-w-0 truncate text-[13px] italic text-ink', selected && 'font-medium')}>{name}</span>
        <span aria-hidden className="ml-2 w-1.5 h-1.5 rounded-full bg-rust-500 shrink-0" />
      </div>
    );
  }

  /* ------------------------- empty-folder placeholder ---------------------- */
  if (row.kind === 'placeholder') {
    const empty = t('siteTree.emptyFolder', 'Empty folder');
    const here = t('siteTree.newConnectionHere', 'New connection here');
    return (
      <div {...base} aria-label={`${empty}, ${here}`} className={rowClass} style={style}>
        {guides}
        <span className="w-4 h-4 shrink-0" aria-hidden />
        <span className="ml-0.5 min-w-0 truncate text-[12px] italic text-ink-faint">
          {`${empty} · `}
          <button type="button" tabIndex={-1} data-action="new-here" className="not-italic text-ink-muted hover:text-ink hover:underline underline-offset-2">
            {here}
          </button>
        </span>
      </div>
    );
  }

  /* ---------------------------- new-folder row ----------------------------- */
  if (row.kind === 'newFolder') {
    return (
      <div {...base} aria-label={t('siteTree.a11yNewFolderName', 'New folder name')} className={rowClass} style={style}>
        {guides}
        <span className="w-4 h-4 shrink-0" aria-hidden />
        <Folder aria-hidden className="w-4 h-4 shrink-0 text-ink-faint" />
        <span className="ml-2 flex-1 min-w-0 flex">{edit && <NameInput edit={edit} domId={domId} />}</span>
      </div>
    );
  }

  /* ------------------------------ address row ------------------------------ */
  return (
    <div
      {...base}
      aria-label={t('siteTree.newConnectionTo', { address: row.address, defaultValue: 'New connection to {{address}}…' })}
      className={rowClass}
      style={style}
    >
      <span className="w-4 h-4 shrink-0" aria-hidden />
      <Plus aria-hidden className="w-4 h-4 shrink-0 text-ink-faint" />
      <span className="ml-2 flex-1 min-w-0 truncate text-[13px] text-ink">
        {t('siteTree.newConnectionTo', { address: row.address, defaultValue: 'New connection to {{address}}…' })}
      </span>
    </div>
  );
});
