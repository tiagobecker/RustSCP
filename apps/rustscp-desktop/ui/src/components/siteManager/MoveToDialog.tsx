import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderPlus, FolderRoot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/controls.tsx';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { useVirtualRows } from '../../utils/useVirtualRows.ts';
import { Highlight } from './SiteTreeRow.tsx';
import { allFolderPaths, buildMoveRows, firstMatch, isPickable, nextPickable, startPick } from './moveToModel.ts';
import type { MoveRow } from './moveToModel.ts';
import { baseName, fold, folderNameProblem, joinPath, parentOf, pickFreeName } from './siteTreeModel.ts';

/** Targets chosen in this run of the app, newest first (the dialog's "Recent" group). */
const recentTargets: string[] = [];
const rememberTarget = (path: string) => {
  if (!path) return;
  const i = recentTargets.indexOf(path);
  if (i >= 0) recentTargets.splice(i, 1);
  recentTargets.unshift(path);
  if (recentTargets.length > 10) recentTargets.length = 10;
};

const ROW_H = 28;
const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

interface Props {
  /** `move`: the button reads Move and the items' folder is not a target. `pick`: Choose, returns the path only. */
  mode: 'move' | 'pick';
  title: string;
  /** Every folder path */
  folders: Iterable<string>;
  /** The items' shared folder ('' = top level), or null when they differ */
  current: string | null;
  /** Folders being moved: they and everything inside them are not targets */
  moving?: readonly string[];
  /** '' = top level. A folder made in the dialog may not exist yet: the caller creates it. */
  onChoose: (path: string) => void;
  onCancel: () => void;
}

/**
 * "Move to…" (and the form's "Change…" in pick mode): a searchable, fully expanded folder list with
 * the top level, this session's recent targets, and a "New folder…" that names a folder inline.
 */
export const MoveToDialog: React.FC<Props> = ({ mode, title, folders, current, moving, onChoose, onCancel }) => {
  const { t } = useTranslation();
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  /** Folders named here; they exist only once the caller runs the move */
  const [extra, setExtra] = useState<string[]>([]);
  const [creating, setCreating] = useState<{ parent: string; value: string; error: string | null } | null>(null);
  /** The inline name was committed or cancelled: ignore the blur that follows */
  const createDone = useRef(false);
  const [recents] = useState(() => [...recentTargets]);
  const movingList = useMemo(() => [...(moving ?? [])], [moving]);

  const known = useMemo(() => allFolderPaths([...folders, ...extra]), [folders, extra]);
  const rows = useMemo(
    () => buildMoveRows({ folders: known, query, recents, current, disableCurrent: mode === 'move', moving: movingList, newFolderParent: creating?.parent ?? null }),
    [known, query, recents, current, mode, movingList, creating?.parent]
  );

  // Nothing is picked at first in move mode: Move waits for a folder (never the top level by default)
  const [pickKey, setPickKey] = useState<string | null>(() => {
    const i = startPick(rows, mode, current);
    return i >= 0 ? rows[i].key : null;
  });
  const pickIndex = pickKey === null ? -1 : rows.findIndex((r) => r.key === pickKey);

  // A new search highlights its first match (none when nothing matches); clearing it keeps the pick
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    if (!query.trim()) return;
    const i = firstMatch(rows);
    setPickKey(i >= 0 ? rows[i].key : null);
  }, [query, rows]);

  const { scrollRef, onScroll, range, totalHeight, isPinnedOutside, scrollToIndex } = useVirtualRows({ count: rows.length, rowHeight: ROW_H, pinIndex: pickIndex });
  useEffect(() => {
    if (pickIndex >= 0) scrollToIndex(pickIndex, 'nearest');
    // Only when the highlight moves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickKey]);

  const choose = () => {
    const row = rows[pickIndex];
    if (!isPickable(row) || creating) return;
    const path = row.kind === 'folder' ? row.path : '';
    rememberTarget(path);
    onChoose(path);
  };

  const move = (dir: 1 | -1) => {
    const i = nextPickable(rows, pickIndex, dir);
    if (i >= 0) setPickKey(rows[i].key);
  };

  /* ------------------------------- new folder ------------------------------ */

  const problemText = (code: string, name: string): string => {
    switch (code) {
      case 'empty':
        return t('siteTree.errEmptyName', 'Enter a name.');
      case 'slash':
        return t('siteTree.errSlash', "Folder names can't contain “/”. Use Move to… to nest folders.");
      case 'control':
        return t('siteTree.errControl', "Names can't contain control characters.");
      case 'too_long':
        return t('siteTree.errPathTooLong', 'This path would be longer than 255 characters.');
      default:
        return t('siteTree.errFolderExists', { name, defaultValue: 'A folder named “{{name}}” already exists here.' });
    }
  };

  const startCreate = () => {
    const row = rows[pickIndex];
    const parent = row?.kind === 'folder' && !row.disabled ? row.path : '';
    const siblings = [...known].filter((p) => parentOf(p) === parent).map(baseName);
    const value = pickFreeName(t('siteTree.newFolder', 'New folder'), siblings, (n) => t('siteTree.newFolderN', { n, defaultValue: 'New folder {{n}}' }));
    createDone.current = false;
    setCreating({ parent, value, error: null });
  };

  const endCreate = () => {
    createDone.current = true;
    setCreating(null);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const commitCreate = (fromBlur: boolean) => {
    if (!creating || createDone.current) return;
    const name = creating.value.trim();
    const problem = folderNameProblem(name, creating.parent, known, null);
    if (problem) {
      if (fromBlur) endCreate();
      else setCreating({ ...creating, error: problemText(problem.code, name) });
      return;
    }
    const path = joinPath(creating.parent, name);
    setExtra((prev) => [...prev, path]);
    setPickKey(`f:${path}`);
    // A search could hide the new folder: show everything again
    setQuery('');
    lastQuery.current = '';
    endCreate();
  };

  // Escape (routed here by the Modal) first leaves the inline name
  const onModalClose = () => {
    if (creating) endCreate();
    else onCancel();
  };

  /* -------------------------------- render -------------------------------- */

  const terms = useMemo(() => {
    const q = fold(query.trim());
    return q && !q.includes('/') ? [q] : [];
  }, [query]);

  const indices: number[] = [];
  for (let i = range.first; i < range.last; i++) indices.push(i);
  if (isPinnedOutside && pickIndex >= 0) indices.push(pickIndex);

  const optionId = (i: number) => `${listId}-o${i}`;

  const renderRow = (row: MoveRow, i: number) => {
    const style: React.CSSProperties = { top: i * ROW_H, height: ROW_H };
    if (row.kind === 'label') {
      return (
        <div key={row.key} role="presentation" className="absolute inset-x-0 flex items-end pb-1 px-2 text-[11.5px] font-medium text-ink-faint" style={style}>
          {row.label === 'recent' ? t('siteTree.recentTargets', 'Recent') : t('siteTree.allFolders', 'All folders')}
        </div>
      );
    }
    if (row.kind === 'new') {
      const errorId = `${listId}-err`;
      return (
        <div key={row.key} role="presentation" className="absolute inset-x-0 flex items-center gap-2 pr-2" style={{ ...style, paddingLeft: 8 + Math.min(row.depth, 8) * 14 }}>
          <FolderPlus aria-hidden className="w-4 h-4 shrink-0 text-ink-faint" />
          <div className="relative flex-1 min-w-0">
            <NewFolderInput
              value={creating?.value ?? ''}
              ariaLabel={t('siteTree.a11yNewFolderName', 'New folder name')}
              invalid={!!creating?.error}
              errorId={creating?.error ? errorId : undefined}
              onChange={(value) => setCreating((c) => (c ? { ...c, value, error: null } : c))}
              onCommit={() => commitCreate(false)}
              onBlur={() => commitCreate(true)}
            />
            {creating?.error && (
              <div id={errorId} role="alert" className="absolute left-0 top-full mt-1 z-10 max-w-[260px] rounded-md bg-red-600 text-white text-[11.5px] leading-snug px-2 py-1 shadow-pop whitespace-normal">
                {creating.error}
              </div>
            )}
          </div>
        </div>
      );
    }
    const picked = i === pickIndex;
    const isTop = row.kind === 'top';
    const label = isTop ? t('siteTree.topLevel', 'Top level') : row.name;
    // "Acme, in Clients, current": the badge and the parent are read as separate parts
    const parent = row.kind === 'folder' && !row.recent ? parentOf(row.path) : '';
    const optionLabel = [label, parent ? t('siteTree.inParent', { parent: parent.split('/').join(' / '), defaultValue: 'in {{parent}}' }) : null, row.current ? t('siteTree.current', 'current') : null]
      .filter(Boolean)
      .join(', ');
    return (
      <div
        key={row.key}
        id={optionId(i)}
        role="option"
        aria-label={optionLabel}
        aria-selected={picked}
        aria-disabled={row.disabled || undefined}
        title={isTop ? undefined : row.path}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (isPickable(row)) setPickKey(row.key);
        }}
        onDoubleClick={() => {
          if (isPickable(row)) choose();
        }}
        className={cx(
          'absolute inset-x-0 flex items-center gap-2 rounded-md pr-2 text-[13px] text-ink select-none',
          picked ? 'bg-dark-650' : !row.disabled && 'hover:bg-dark-650/50',
          row.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-default'
        )}
        style={{ ...style, paddingLeft: 8 + Math.min(row.depth, 8) * 14 }}
      >
        {isTop ? <FolderRoot aria-hidden className="w-4 h-4 shrink-0 text-ink-faint" /> : <Folder aria-hidden className={cx('w-4 h-4 shrink-0', picked ? 'text-rust-500' : 'text-ink-faint')} />}
        <span className="flex-1 min-w-0 truncate">{isTop ? label : <Highlight text={label} terms={row.recent ? [] : terms} />}</span>
        {row.current && <span className="shrink-0 px-1.5 rounded bg-dark-650 text-[11px] text-ink-faint">{t('siteTree.current', 'current')}</span>}
      </div>
    );
  };

  const canChoose = isPickable(rows[pickIndex]) && !creating;

  if (typeof document === 'undefined') return null;
  return createPortal(
    <Modal
      isOpen
      onClose={onModalClose}
      size="sm"
      title={title}
      padded={false}
      className="h-[min(440px,calc(100vh-2rem))]"
      bodyClassName="flex flex-col !overflow-hidden"
      footer={
        <>
          <Button variant="ghost" className="mr-auto -ml-2" icon={<FolderPlus className="w-3.5 h-3.5" />} onClick={startCreate} disabled={!!creating}>
            {t('siteTree.newFolderEllipsis', 'New folder…')}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t('loginDialog.cancel', 'Cancel')}
          </Button>
          <Button variant="primary" onClick={choose} disabled={!canChoose}>
            {mode === 'pick' ? t('siteTree.choose', 'Choose') : t('siteTree.move', 'Move')}
          </Button>
        </>
      }
    >
      <div className="px-4 pb-2 shrink-0">
        <input
          {...plainTextInputProps}
          ref={searchRef}
          data-autofocus=""
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={pickIndex >= 0 && rows[pickIndex].kind !== 'new' ? optionId(pickIndex) : undefined}
          aria-label={t('siteTree.findFolder', 'Find folder')}
          placeholder={t('siteTree.findFolder', 'Find folder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              move(e.key === 'ArrowDown' ? 1 : -1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose();
            }
          }}
          className="ui-input h-8 text-[13px]"
        />
      </div>
      <div className="flex-1 min-h-0 relative">
        <div ref={scrollRef} id={listId} role="listbox" aria-label={title} tabIndex={-1} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overflow-x-hidden px-2 pb-2">
          <div role="none" className="relative" style={{ height: totalHeight }}>
            {indices.map((i) => renderRow(rows[i], i))}
          </div>
        </div>
      </div>
    </Modal>,
    document.body
  );
};

/** The inline name field of "New folder…" (focused with its text selected). */
const NewFolderInput: React.FC<{
  value: string;
  ariaLabel: string;
  invalid: boolean;
  errorId?: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onBlur: () => void;
}> = ({ value, ariaLabel, invalid, errorId, onChange, onCommit, onBlur }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  return (
    <input
      {...plainTextInputProps}
      ref={ref}
      value={value}
      maxLength={300}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={errorId}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          onCommit();
        }
      }}
      onBlur={onBlur}
      className={cx('ui-input h-6 px-1.5 text-[13px]', invalid && '!border-red-500/70')}
    />
  );
};
