import React, { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
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
  Star,
} from 'lucide-react';
import type { ConnectionConfig } from '../../types.ts';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { SPRING_DELAY_MS } from '../../utils/tabDragManager.ts';
import { matchRanges } from './siteQuery.ts';
import { LABEL_DOT_CLASS } from './labelsModel.ts';
import { fullDateText, recentText } from './siteFormat.ts';
import { RECENT_SHOWN_FEW, canonicalProtocol, formatCount, isLocalSite, protocolTag, rowIndent, siteAddress } from './siteTreeModel.ts';
import type { LabelDef, TreeRow } from './types.ts';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Left of the indent guide for ancestor level `k` (the middle of that level's twisty). */
const guideLeft = (k: number): number => rowIndent(k) + 7.5;

/**
 * Text with `<mark>` around the search matches (accents and case ignored). `slice` renders only
 * that part of `text`, with the matches found in the whole text (a name split for middle truncation).
 */
export const Highlight: React.FC<{ text: string; terms: readonly string[]; slice?: readonly [number, number] }> = ({ text, terms, slice }) => {
  const from = slice ? slice[0] : 0;
  const to = slice ? slice[1] : text.length;
  const part = text.slice(from, to);
  if (!terms.length || !part) return <>{part}</>;
  const ranges = matchRanges(text, terms)
    .map(([s, e]): [number, number] => [Math.max(s, from), Math.min(e, to)])
    .filter(([s, e]) => e > s);
  if (!ranges.length) return <>{part}</>;
  const out: React.ReactNode[] = [];
  let at = from;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <mark key={i} className="stree-match">
        {text.slice(s, e)}
      </mark>
    );
    at = e;
  });
  if (at < to) out.push(text.slice(at, to));
  return <>{out}</>;
};

/** A trailing number ("web-01", "Servidor Curitiba 38", "db 2b"): kept visible when a name is cut. */
const NAME_TAIL_RE = /\s*[-_.#]?\d[\p{L}\p{N}._-]{0,7}$/u;
/** A port at the end of an address (":2222"), or a port and a short path */
const PORT_TAIL_RE = /:\d{1,5}(?:\/\S{0,16})?$/;

/** Splits `text` before the part that must stay visible when the rest is cut (["Servidor Florianópolis", " 38"]). */
export const splitTail = (text: string, re: RegExp): [string, string] => {
  const m = re.exec(text);
  if (!m || m.index === 0) return [text, ''];
  return [text.slice(0, m.index), text.slice(m.index)];
};

/** A name cut in the middle when it does not fit: the start gives way, a trailing number stays. */
const MiddleText: React.FC<{ text: string; terms: readonly string[]; className?: string }> = ({ text, terms, className }) => {
  const [head, tail] = splitTail(text, NAME_TAIL_RE);
  return (
    <span className={cx('flex min-w-0', className)}>
      <span className="truncate">
        <Highlight text={text} terms={terms} slice={[0, head.length]} />
      </span>
      {tail && (
        <span className="shrink-0 whitespace-pre">
          <Highlight text={text} terms={terms} slice={[head.length, text.length]} />
        </span>
      )}
    </span>
  );
};

/** A folder path as "Clients › Acme" (deeper: "… › Acme"), for rows listed outside their folder. */
const shortPath = (folder: string): string => {
  if (!folder) return '';
  const parts = folder.split('/');
  return parts.length <= 2 ? parts.join(' › ') : `… › ${parts[parts.length - 1]}`;
};

/** Monochrome protocol icon; only plain FTP is amber (it is not encrypted). */
export const ProtocolGlyph: React.FC<{ site: ConnectionConfig; selected?: boolean; className?: string }> = ({ site, selected, className = 'w-4 h-4' }) => {
  const p = isLocalSite(site) ? 'local' : canonicalProtocol(site.protocol);
  // Selection shows in the row's background and weight; the icon stays monochrome
  const tone = p === 'ftp' ? 'text-amber-700 dark:text-amber-400' : selected ? 'text-ink-muted' : 'text-ink-faint';
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
  /** The field lost focus to `next` (null: to nothing, e.g. a click on the background) */
  onBlur: (next: Element | null) => void;
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
  /** The ⋯ button shows without hover: the selected row (only the focused one in a multi-selection) */
  showActions: boolean;
  nameTerms: readonly string[];
  addressTerms: readonly string[];
  /** For the "All connections" header: whether any folder is expanded (its collapse/expand-all button) */
  anyExpanded: boolean;
  /** Set only on the row being renamed or named (new folder) */
  edit: RowEditState | null;
  /** Marked by ⌘X (50% opacity until pasted or Escape) */
  cut?: boolean;
  /** The drop target under a drag */
  dropTarget?: boolean;
  /** Inside the drop target folder (a lighter tint) */
  dropBlock?: boolean;
  /** A collapsed folder about to spring open during a drag (its bar fills) */
  springing?: boolean;
  /** A drag over Favorites: the insertion line above or below this row */
  dropLine?: 'before' | 'after' | null;
  /** A site with an open tab (a green dot on its icon) */
  open?: boolean;
  /** A search runs: a folder's count is its matches */
  countIsMatches?: boolean;
}

/**
 * The 6px label mark after a name (its name is in the row's tooltip and accessible name). A rounded
 * square, so it never reads as the round open-session dot on the icon.
 */
const LabelDot: React.FC<{ def: LabelDef }> = ({ def }) => (
  <span aria-hidden className={cx('ml-1.5 w-1.5 h-1.5 shrink-0 self-center rounded-[1.5px]', LABEL_DOT_CLASS[def.color])} />
);

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
        onBlur={(e) => edit.onBlur(e.relatedTarget as Element | null)}
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
  showActions,
  nameTerms,
  addressTerms,
  anyExpanded,
  edit,
  cut,
  dropTarget,
  dropBlock,
  springing,
  dropLine,
  open,
  countIsMatches,
}: SiteTreeRowProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const depth = row.kind === 'section' ? 0 : row.depth;
  const cutA11y = cut ? `, ${t('siteTree.a11yCutMark', 'cut')}` : '';

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
    'data-cut': cut ? '' : undefined,
    'data-drop-target': dropTarget ? '' : undefined,
    'data-drop-block': dropBlock && !dropTarget ? '' : undefined,
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
        showActions || edit ? 'flex' : 'hidden group-hover:flex'
      )}
    >
      <Ellipsis className="w-3.5 h-3.5" />
    </button>
  );

  // Where items dragged over Favorites will land
  const lineEl = dropLine ? (
    <span
      aria-hidden
      className={cx('absolute right-2 z-[1] h-0.5 rounded-full bg-rust-500 pointer-events-none', dropLine === 'before' ? '-top-px' : '-bottom-px')}
      style={{ left: rowIndent(depth) }}
    />
  ) : null;

  /* ------------------------ favorites drop zone --------------------------- */
  if (row.kind === 'favDrop') {
    return (
      <div role="none" data-row-key={row.key} data-row-index={index} className="absolute inset-x-0 py-1 flex" style={{ top, height }}>
        <div
          className={cx(
            'flex-1 min-w-0 flex items-center justify-center gap-1.5 rounded-md border border-dashed text-[12px] px-2',
            dropTarget ? 'border-rust-500/60 bg-rust-500/10 text-ink' : 'border-line-strong text-ink-faint'
          )}
        >
          <Star aria-hidden className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{t('siteTree.favoritesDropZone', 'Drop here to add to favorites')}</span>
        </div>
      </div>
    );
  }

  /* ------------------------------- section -------------------------------- */
  if (row.kind === 'section') {
    const name =
      row.sectionId === 'fav' ? t('siteTree.sectionFavorites', 'Favorites') : row.sectionId === 'rec' ? t('siteTree.sectionRecent', 'Recent') : t('siteTree.sectionAll', 'All connections');
    const toggleLabel = anyExpanded ? t('loginDialog.collapseFolders', 'Collapse all folders') : t('loginDialog.expandFolders', 'Expand all folders');
    // Recent lists its first few rows until "Show all" (the folder tree stays in view)
    const recentTotal = row.sectionId === 'rec' ? row.total ?? row.count : 0;
    const recentMore = row.sectionId === 'rec' && row.expanded && recentTotal > row.count;
    const recentFewer = row.sectionId === 'rec' && row.expanded && !recentMore && recentTotal > RECENT_SHOWN_FEW;
    const moreText = recentMore
      ? t('siteTree.showAllRecent', { formatted: formatCount(lang, recentTotal), defaultValue: 'Show all ({{formatted}})' })
      : t('siteTree.showFewerRecent', 'Show fewer');
    return (
      <div {...base} aria-expanded={row.expanded} aria-label={name} className={rowClass} style={style}>
        <span className="text-[11.5px] font-medium text-ink-muted truncate">{name}</span>
        {/* Always shown, so folding a section is discoverable */}
        <ChevronRight
          aria-hidden
          className={cx('w-3 h-3 ml-1 shrink-0 text-ink-muted transition-transform duration-[120ms] motion-reduce:transition-none', row.expanded && 'rotate-90')}
        />
        <span className="flex-1" />
        {(recentMore || recentFewer) && (
          <button
            type="button"
            tabIndex={-1}
            data-action="recent-more"
            className="shrink-0 text-[11px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
          >
            {moreText}
          </button>
        )}
        {row.sectionId === 'rec' && (
          <button
            type="button"
            tabIndex={-1}
            data-action="clear-recent"
            title={t('siteTree.clearRecent', 'Clear recent')}
            className="hidden group-hover:block ml-2 shrink-0 text-[11px] text-ink-muted hover:text-ink hover:underline underline-offset-2"
          >
            {t('siteTree.clear', 'Clear')}
          </button>
        )}
        {row.sectionId === 'all' && (
          <>
            <span className="text-[11px] tabular-nums text-ink-muted">{formatCount(lang, row.count)}</span>
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
    const label = countIsMatches
      ? t('siteTree.a11yFolderMatches', {
          name: row.name,
          count: row.count,
          formatted,
          defaultValue_one: '{{name}}, folder, 1 result',
          defaultValue_other: '{{name}}, folder, {{formatted}} results',
        })
      : !row.empty && row.count === 0
        ? t('siteTree.a11yFolder_other', { name: row.name, formatted, defaultValue: '{{name}}, folder, {{formatted}} connections' })
        : t('siteTree.a11yFolder', {
            name: row.name,
            count: row.empty ? 0 : row.count,
            formatted,
            defaultValue_zero: '{{name}}, folder, empty',
            defaultValue_one: '{{name}}, folder, 1 connection',
            defaultValue_other: '{{name}}, folder, {{formatted}} connections',
          });
    const labelName = row.labelDef?.name ?? null;
    const folderLabel = (labelName ? `${label}, ${t('siteTree.a11yLabel', { name: labelName, defaultValue: 'label {{name}}' })}` : label) + cutA11y;
    const folderTitle = labelName ? `${row.path}\n${t('siteTree.pillLabel', { value: labelName, defaultValue: 'Label: {{value}}' })}` : row.path;
    return (
      <div {...base} aria-expanded={row.expanded} aria-label={folderLabel} className={rowClass} style={style} title={folderTitle}>
        {guides}
        <span data-action="twisty" className="w-4 h-4 shrink-0 flex items-center justify-center text-ink-faint hover:text-ink">
          <ChevronRight aria-hidden className={cx('w-3 h-3 transition-transform duration-[120ms] motion-reduce:transition-none', row.expanded && 'rotate-90')} />
        </span>
        {/* Selected: the same icon treatment as a selected site */}
        {row.expanded ? (
          <FolderOpen aria-hidden className={cx('w-4 h-4 shrink-0', selected ? 'text-ink-muted' : 'text-ink-faint')} />
        ) : (
          <Folder aria-hidden className={cx('w-4 h-4 shrink-0', selected ? 'text-ink-muted' : 'text-ink-faint')} />
        )}
        {edit ? (
          <span className="ml-2 flex-1 min-w-0 flex">
            <NameInput edit={edit} domId={domId} />
          </span>
        ) : (
          <>
            <span className={cx('ml-2 min-w-0 truncate text-[13px] font-medium text-ink', !(row.labelDot && row.labelDef) && 'flex-1')}>
              <Highlight text={row.name} terms={nameTerms} />
            </span>
            {row.labelDot && row.labelDef && (
              <>
                <LabelDot def={row.labelDef} />
                <span className="flex-1" />
              </>
            )}
            {row.count > 0 && (
              <span className={cx('ml-2 shrink-0 text-[11px] tabular-nums text-ink-muted', showActions ? 'hidden' : 'group-hover:hidden')}>{formatted}</span>
            )}
            <span className="ml-1 flex">{moreButton}</span>
          </>
        )}
        {springing && (
          <span
            aria-hidden
            className="absolute left-1.5 right-1.5 bottom-0 h-0.5 rounded-full bg-rust-500 animate-spring-fill pointer-events-none"
            style={{ animationDuration: `${SPRING_DELAY_MS}ms` }}
          />
        )}
        {lineEl}
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
    // Favorites, Recent and list results sit outside their folder: the folder shows before the address
    const pathText = row.showPath ? shortPath(row.folder) : '';
    const userAt =
      !local && site.protocol !== 's3' && site.username
        ? t('siteTree.a11yUserAt', { user: site.username, host: address.slice(address.indexOf('@') + 1), defaultValue: '{{user}} at {{host}}' })
        : address;
    const favLabel = row.favorite ? t('siteTree.a11yFavorite', 'favorite') : null;
    const labelName = row.labelDef?.name ?? null;
    const labelA11y = labelName ? t('siteTree.a11yLabel', { name: labelName, defaultValue: 'label {{name}}' }) : null;
    const openA11y = open ? t('siteTree.a11yConnected', 'connected') : null;
    const a11y =
      (local
        ? [site.name, tag, favLabel, labelA11y, openA11y].filter(Boolean).join(', ')
        : [site.name, tag, userAt, ftp ? t('siteTree.notEncrypted', 'not encrypted') : null, favLabel, labelA11y, openA11y].filter(Boolean).join(', ')) + cutA11y;
    // The filled star after the name marks a favorite (not needed inside the Favorites list itself)
    const favMark = row.favorite && !(row.section === 'fav' && row.depth === 0) && !edit;
    const favTitle = row.favorite ? t('siteTree.removeFavorite', 'Remove from favorites') : t('siteTree.addFavorite', 'Add to favorites');
    const starButton = (
      <button
        type="button"
        tabIndex={-1}
        data-action="star"
        aria-label={favTitle}
        aria-pressed={row.favorite}
        title={favTitle}
        className={cx(
          'w-[22px] h-[22px] shrink-0 items-center justify-center rounded-md hover:bg-dark-600/60',
          'text-ink-muted hover:text-ink',
          showActions ? 'flex' : 'hidden group-hover:flex'
        )}
      >
        <Star className="w-3.5 h-3.5" fill={row.favorite ? 'currentColor' : 'none'} />
      </button>
    );
    const recentAt = row.section === 'rec' && typeof row.recentAt === 'number' ? row.recentAt : null;
    const tooltip = [
      site.name,
      address,
      row.folder,
      labelName ? t('siteTree.pillLabel', { value: labelName, defaultValue: 'Label: {{value}}' }) : null,
      open ? t('siteTree.openInTab', 'Open in a tab') : null,
      t('loginDialog.doubleClickHint', 'Double-click to connect'),
    ]
      .filter(Boolean)
      .join('\n');
    const tagEl = (
      <span
        className={cx('text-[10.5px] font-medium', ftp && 'text-amber-800 dark:text-amber-400')}
        title={ftp ? `FTP · ${t('siteTree.notEncrypted', 'not encrypted')}` : undefined}
      >
        {tag}
      </span>
    );
    // The name gives way last; when it must be cut, a trailing number stays readable
    const nameText = <MiddleText text={site.name} terms={nameTerms} className={cx('text-[13px] text-ink', selected && 'font-medium')} />;
    const favMarkEl = favMark ? <Star aria-hidden className="ml-1 w-[11px] h-[11px] shrink-0 self-center text-ink-muted" fill="currentColor" /> : null;
    const labelDotEl = row.labelDot && row.labelDef && !edit ? <LabelDot def={row.labelDef} /> : null;
    // The open-session dot sits on the icon's corner (top-right for FTP, whose lock badge is bottom-right)
    const glyph = open ? (
      <span className="relative inline-flex shrink-0">
        <ProtocolGlyph site={site} selected={selected} />
        <span
          aria-hidden
          className={cx('absolute w-1.5 h-1.5 rounded-full bg-emerald-500 ring-[1.5px] ring-dark-850', ftp ? '-right-0.5 -top-0.5' : '-right-0.5 -bottom-0.5')}
        />
      </span>
    ) : (
      <ProtocolGlyph site={site} selected={selected} />
    );
    let body: React.ReactNode;
    if (edit) {
      // The field takes the whole row
      body = (
        <span className="ml-2 flex-1 min-w-0 flex">
          <NameInput edit={edit} domId={domId} />
        </span>
      );
    } else if (compact) {
      // One line: the name (with its marks) first; the address shares what is left and drops to
      // the clipped second line once less than 60px would remain, instead of leaving a stub
      body = (
        <span className="ml-2 flex-1 min-w-0 h-[18px] overflow-hidden flex flex-wrap items-center gap-x-2">
          <span className="flex items-center min-w-0 max-w-full">
            {nameText}
            {favMarkEl}
            {labelDotEl}
          </span>
          {showAddress && (
            <span className="flex-1 basis-[60px] min-w-[60px] truncate text-[12px] text-ink-muted">
              {pathText && `${pathText} · `}
              {local ? tag : <Highlight text={address} terms={addressTerms} />}
            </span>
          )}
        </span>
      );
    } else {
      body = (
        <span className="ml-2 flex-1 min-w-0 flex flex-col justify-center leading-tight">
          <span className="flex items-center min-w-0">
            {nameText}
            {favMarkEl}
            {labelDotEl}
          </span>
          <span className="truncate text-[11.5px] text-ink-muted mt-px">
            {tagEl}
            {pathText && ` · ${pathText}`}
            {!local && address && (
              <>
                {' · '}
                <Highlight text={address} terms={addressTerms} />
              </>
            )}
          </span>
        </span>
      );
    }
    return (
      <div {...base} aria-label={a11y} className={rowClass} style={style} title={edit ? undefined : tooltip}>
        {guides}
        <span className="w-4 h-4 shrink-0" aria-hidden />
        {glyph}
        {body}
        {recentAt !== null && !edit && (
          <span
            className={cx('ml-2 shrink-0 text-[11px] tabular-nums text-ink-muted', showActions ? 'hidden' : 'group-hover:hidden')}
            title={fullDateText(recentAt, lang)}
          >
            {recentText(recentAt, lang, t)}
          </span>
        )}
        {!edit && (
          <span className="ml-1 flex">
            {starButton}
            {moreButton}
          </span>
        )}
        {lineEl}
      </div>
    );
  }

  /* ------------------------- draft (unsaved new) -------------------------- */
  if (row.kind === 'draft') {
    const name = row.name || t('loginDialog.newConnection', 'New connection');
    // An unnamed draft is read once ("New connection, not saved yet"), not "New connection, new connection…"
    const draftLabel = row.name
      ? t('siteTree.a11yDraft', { name, defaultValue: '{{name}}, new connection, not saved yet' })
      : t('siteTree.a11yDraftUnnamed', 'New connection, not saved yet');
    return (
      <div {...base} aria-label={draftLabel} className={rowClass} style={style}>
        {guides}
        <span className="w-4 h-4 shrink-0" aria-hidden />
        <Plus aria-hidden className={cx('w-4 h-4 shrink-0', selected ? 'text-ink-muted' : 'text-ink-faint')} />
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
  // Cut in the middle of the address, so its port (and the closing "…") stays visible
  const MARK = '\u0000';
  const [before, after = ''] = t('siteTree.newConnectionTo', { address: MARK, defaultValue: 'New connection to {{address}}…' }).split(MARK);
  const [addrHead, addrTail] = splitTail(row.address, PORT_TAIL_RE);
  return (
    <div
      {...base}
      aria-label={t('siteTree.newConnectionTo', { address: row.address, defaultValue: 'New connection to {{address}}…' })}
      className={rowClass}
      style={style}
    >
      <span className="w-4 h-4 shrink-0" aria-hidden />
      <ArrowRight aria-hidden className={cx('w-4 h-4 shrink-0', selected || active ? 'text-rust-500' : 'text-ink-faint')} />
      <span className="ml-2 flex-1 min-w-0 flex text-[13px] text-ink" title={row.address}>
        <span className="truncate">{`${before}${addrHead}`}</span>
        <span className="shrink-0 whitespace-pre">{`${addrTail}${after}`}</span>
      </span>
    </div>
  );
});
