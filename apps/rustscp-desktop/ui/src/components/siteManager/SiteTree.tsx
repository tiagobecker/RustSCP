import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Folder } from 'lucide-react';
import { isMacPlatform } from '../fileListUtils.ts';
import type { MenuAnchor } from '../ui/contextMenuUtils.ts';
import { useVirtualRows } from '../../utils/useVirtualRows.ts';
import type { ScrollAlign } from '../../utils/useVirtualRows.ts';
import { ProtocolGlyph, SiteTreeRow } from './SiteTreeRow.tsx';
import type { RowEditState } from './SiteTreeRow.tsx';
import { formatCount, isInside, rowFolderPath } from './siteTreeModel.ts';
import { inDropBlock } from './treeDragModel.ts';
import type { DragPayload, DropSpot } from './treeDragModel.ts';
import type { TreeRow } from './types.ts';
import { useTreeDrag } from './useTreeDrag.ts';
import type { TreeDragHost } from './useTreeDrag.ts';
import { canonicalKey, firstChildIndex, moveIndex, parentIndex } from './useTreeSelection.ts';
import type { TreeSelection } from './useTreeSelection.ts';

/** What the tree asks its owner to do (SiteSidebar holds the state and the dialogs). */
export interface TreeActions {
  /** Click or Space: select the row (a site loads into the form, through the unsaved-changes check) */
  activate: (row: TreeRow, how: 'click' | 'space') => void;
  /** ↑/↓/Home/End/Page: focus moves, and the selection with it unless the form has unsaved edits */
  move: (row: TreeRow) => void;
  /** ⌘-click (Ctrl-click): adds the row to the selection or takes it out */
  toggleSelect: (row: TreeRow) => void;
  /** Shift-click, Shift+↑/↓/Home/End/Page: selects from the anchor to this row (one section) */
  extendSelect: (row: TreeRow) => void;
  /** ⌘A: every item row of the row's section */
  selectAll: (row: TreeRow) => void;
  /** ⇧⌘M: Move to… for the selection (or the row) */
  moveTo: (row: TreeRow) => void;
  /** Enter / ⌘↓ / double-click: connect a site, toggle a folder or section, focus the draft's Host */
  open: (row: TreeRow) => void;
  toggle: (row: TreeRow, subtree: boolean, expand?: boolean) => void;
  /** The "All connections" header's collapse/expand-all button */
  toggleAll: () => void;
  /** `*`: expand every sibling folder */
  expandSiblings: (row: TreeRow) => void;
  /** Right-click, ⋯, Shift+F10 (row null: the empty area) */
  menu: (row: TreeRow | null, at: MenuAnchor, focusFirst: boolean) => void;
  rename: (row: TreeRow) => void;
  editDetails: (row: TreeRow) => void;
  newConnection: (row: TreeRow | null) => void;
  newFolder: (row: TreeRow | null) => void;
  duplicate: (row: TreeRow) => void;
  copyAddress: (row: TreeRow) => void;
  remove: (row: TreeRow) => void;
  /** ⌘F, `/`, or a printable key (type-to-search appends it) */
  focusSearch: (append?: string) => void;
  /** ⌘X: marks the selection (or the row) as cut */
  cut: (row: TreeRow | null) => void;
  /** ⌘V: moves the cut items into the row's folder (a site's folder; the top level for none) */
  paste: (row: TreeRow | null) => void;
  /** ⌃⌘N (Ctrl+Alt+N): a new folder holding the selection (or the row), then rename */
  newFolderWith: (row: TreeRow | null) => void;
  /** Drag and drop: what a drag from this row carries (null: not draggable) */
  dragPayload: (row: TreeRow) => DragPayload | null;
  /** Spring-loading opens folders during a drag; folding back closes them */
  dragExpand: (paths: string[], expanded: boolean) => void;
  /** The drop target under the pointer changed (live region) */
  dragHover: (spot: DropSpot | null, valid: boolean, copy: boolean) => void;
  /** A valid drop: move (or copy, with ⌥/Alt) into `folder` */
  drop: (payload: DragPayload, folder: string, copy: boolean, springOpened: string[]) => void;
}

export interface SiteTreeHandle {
  focus: () => void;
  /** Scrolls a row into view, now or as soon as it exists */
  scrollToKey: (key: string, align?: ScrollAlign) => void;
  /** Screen rectangle of a rendered row */
  rowRect: (key: string) => DOMRect | null;
  /** Cancels a running drag (Escape); true when one was running */
  cancelDrag: () => boolean;
}

interface SiteTreeProps {
  rows: readonly TreeRow[];
  indexByKey: ReadonlyMap<string, number>;
  rowHeight: number;
  compact: boolean;
  showAddress: boolean;
  selection: TreeSelection;
  nameTerms: readonly string[];
  addressTerms: readonly string[];
  anyExpanded: boolean;
  /** The row being renamed or named, with its input state */
  edit: { rowKey: string; state: RowEditState } | null;
  actionsRef: MutableRefObject<TreeActions>;
  ariaLabel: string;
  /** Id of the hidden "Enter connects, F2 renames…" description */
  describedById: string;
  /** Canonical item keys marked by ⌘X (shown at 50% opacity) */
  cutKeys: ReadonlySet<string>;
}

const isPrintable = (e: React.KeyboardEvent) =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ' && e.key !== '*' && e.key !== '/';

/** The virtualized `role="tree"` list: rows, keyboard map and mouse wiring. */
export const SiteTree = forwardRef<SiteTreeHandle, SiteTreeProps>(function SiteTree(
  { rows, indexByKey, rowHeight, compact, showAddress, selection, nameTerms, addressTerms, anyExpanded, edit, actionsRef, ariaLabel, describedById, cutKeys },
  ref
) {
  const { t, i18n } = useTranslation();
  const mac = useMemo(() => isMacPlatform(), []);
  const activeKey = selection.active;
  const activeIndex = activeKey !== null ? indexByKey.get(activeKey) ?? -1 : -1;
  const editIndex = edit ? indexByKey.get(edit.rowKey) ?? -1 : -1;
  // The row being edited stays rendered like the active one (it usually is the active one)
  const pinIndex = editIndex >= 0 ? editIndex : activeIndex;
  const { scrollRef, onScroll, range, totalHeight, isPinnedOutside, scrollToIndex, pageSize } = useVirtualRows({ count: rows.length, rowHeight, pinIndex });

  // Drag and drop asks the owner through the actions (always the latest ones)
  const dragHost = useRef<TreeDragHost>({
    payload: (row) => actionsRef.current.dragPayload(row),
    setExpanded: (paths, expanded) => actionsRef.current.dragExpand(paths, expanded),
    hover: (spot, valid, copy) => actionsRef.current.dragHover(spot, valid, copy),
    drop: (payload, folder, copy, springOpened) => actionsRef.current.drop(payload, folder, copy, springOpened),
  });
  const drag = useTreeDrag({ scrollRef, rows, rowHeight, hostRef: dragHost });
  const dragCancel = drag.cancel;

  // Stable DOM ids per row key (folder paths are not valid ids)
  const ids = useRef(new Map<string, number>());
  const domId = (key: string) => {
    let n = ids.current.get(key);
    if (n === undefined) {
      n = ids.current.size + 1;
      ids.current.set(key, n);
    }
    return `stree-${n}`;
  };

  const pendingScroll = useRef<{ key: string; align: ScrollAlign } | null>(null);
  const scrollToKey = useCallback(
    (key: string, align: ScrollAlign = 'nearest') => {
      const i = indexByKey.get(key);
      if (i === undefined) {
        pendingScroll.current = { key, align };
        return;
      }
      pendingScroll.current = null;
      scrollToIndex(i, align);
    },
    [indexByKey, scrollToIndex]
  );
  // A row asked for before it existed (a reveal, a new folder): scroll once it is there
  useEffect(() => {
    const p = pendingScroll.current;
    if (!p) return;
    const i = indexByKey.get(p.key);
    if (i === undefined) return;
    pendingScroll.current = null;
    scrollToIndex(i, p.align);
  }, [indexByKey, scrollToIndex]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => scrollRef.current?.focus({ preventScroll: true }),
      scrollToKey,
      rowRect: (key: string) => {
        const n = ids.current.get(key);
        const el = n === undefined ? null : document.getElementById(`stree-${n}`);
        return el ? el.getBoundingClientRect() : null;
      },
      cancelDrag: dragCancel,
    }),
    [scrollRef, scrollToKey, dragCancel]
  );

  /* ------------------------------- keyboard -------------------------------- */

  const rowAt = (i: number): TreeRow | undefined => rows[i];
  const current = (): { row: TreeRow; index: number } | null => {
    const i = activeIndex >= 0 ? activeIndex : rows.length ? 0 : -1;
    return i >= 0 ? { row: rows[i], index: i } : null;
  };

  const goTo = (i: number) => {
    const row = rowAt(i);
    if (!row) return;
    scrollToIndex(i, 'nearest');
    actionsRef.current.move(row);
  };

  /** Shift+navigation: the range from the anchor grows or shrinks to row `i`. */
  const extendTo = (i: number) => {
    const row = rowAt(i);
    if (!row) return;
    scrollToIndex(i, 'nearest');
    actionsRef.current.extendSelect(row);
  };

  const menuAtRow = (row: TreeRow) => {
    const n = ids.current.get(row.key);
    const el = n === undefined ? null : document.getElementById(`stree-${n}`);
    const r = el?.getBoundingClientRect();
    const at: MenuAnchor = r ? { x: r.left + 24, y: r.bottom } : { x: 0, y: 0 };
    actionsRef.current.menu(row, at, true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys typed into the rename input (or a button inside a row) are theirs
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    const a = actionsRef.current;
    const mod = mac ? e.metaKey : e.ctrlKey;
    const cur = current();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    if (key === 'ArrowDown' && mod) {
      // ⌘↓ opens like Enter
      if (cur) a.open(cur.row);
      return handled();
    }
    switch (key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (e.altKey || mod) return;
        const to = moveIndex(rows.length, cur && activeIndex >= 0 ? cur.index : -1, key === 'ArrowDown' ? 1 : -1);
        if (e.shiftKey) extendTo(to);
        else goTo(to);
        return handled();
      }
      case 'Home':
      case 'End': {
        if (e.altKey || mod) return;
        const to = key === 'Home' ? 0 : rows.length - 1;
        if (e.shiftKey) extendTo(to);
        else goTo(to);
        return handled();
      }
      case 'PageUp':
      case 'PageDown': {
        if (e.altKey || mod) return;
        const to = moveIndex(rows.length, cur?.index ?? -1, (key === 'PageDown' ? 1 : -1) * pageSize);
        if (e.shiftKey) extendTo(to);
        else goTo(to);
        return handled();
      }
      case 'ArrowRight': {
        if (!cur || mod) return;
        const { row, index } = cur;
        if (e.altKey) {
          if (row.kind === 'folder') a.toggle(row, true, true);
          return handled();
        }
        if ((row.kind === 'folder' || row.kind === 'section') && !row.expanded) a.toggle(row, false, true);
        else {
          const child = firstChildIndex(rows, index);
          if (child >= 0) goTo(child);
        }
        return handled();
      }
      case 'ArrowLeft': {
        if (!cur || mod) return;
        const { row, index } = cur;
        if (e.altKey) {
          if (row.kind === 'folder') a.toggle(row, true, false);
          return handled();
        }
        if ((row.kind === 'folder' || row.kind === 'section') && row.expanded) a.toggle(row, false, false);
        else {
          const parent = parentIndex(rows, index);
          if (parent >= 0) goTo(parent);
        }
        return handled();
      }
      case 'Enter':
        if (!cur || e.altKey || e.shiftKey) return;
        a.open(cur.row);
        return handled();
      case ' ':
        if (!cur || mod) return;
        a.activate(cur.row, 'space');
        return handled();
      case 'F2':
        if (cur) a.rename(cur.row);
        return handled();
      case 'F8':
      case 'Delete':
        if (cur) a.remove(cur.row);
        return handled();
      case 'Backspace':
        // Plain Backspace never deletes
        if (!mod) return;
        if (cur) a.remove(cur.row);
        return handled();
      case 'F10':
        if (!e.shiftKey) return;
        if (cur) menuAtRow(cur.row);
        return handled();
      case 'ContextMenu':
        if (cur) menuAtRow(cur.row);
        return handled();
      case '*':
        if (cur) a.expandSiblings(cur.row);
        return handled();
      case '/':
        if (mod) return;
        a.focusSearch();
        return handled();
      default:
        break;
    }
    // ⌃⌘N (Ctrl+Alt+N elsewhere): new folder with the selection
    const withSelection = mac ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
    if (withSelection && !e.shiftKey && (lower === 'n' || e.code === 'KeyN')) {
      a.newFolderWith(cur?.row ?? null);
      return handled();
    }
    if (mod && !e.altKey) {
      if (lower === 'x' && !e.shiftKey) {
        a.cut(cur?.row ?? null);
        return handled();
      }
      if (lower === 'v' && !e.shiftKey) {
        a.paste(cur?.row ?? null);
        return handled();
      }
      if (lower === 'n') {
        if (e.shiftKey) a.newFolder(cur?.row ?? null);
        else a.newConnection(cur?.row ?? null);
        return handled();
      }
      if (lower === 'i' && !e.shiftKey) {
        if (cur) a.editDetails(cur.row);
        return handled();
      }
      if (lower === 'd' && e.shiftKey) {
        if (cur) a.duplicate(cur.row);
        return handled();
      }
      if (lower === 'c' && !e.shiftKey) {
        if (cur) a.copyAddress(cur.row);
        return handled();
      }
      if (lower === 'f' && !e.shiftKey) {
        a.focusSearch();
        return handled();
      }
      if (lower === 'a' && !e.shiftKey) {
        if (cur) a.selectAll(cur.row);
        return handled();
      }
      if (lower === 'm' && e.shiftKey) {
        if (cur) a.moveTo(cur.row);
        return handled();
      }
      return;
    }
    if (isPrintable(e)) {
      a.focusSearch(key);
      return handled();
    }
  };

  /* -------------------------------- mouse --------------------------------- */

  const rowFromEvent = (e: React.MouseEvent): { row: TreeRow; el: HTMLElement } | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-row-key]');
    if (!el || !e.currentTarget.contains(el)) return null;
    const row = rows[Number(el.dataset.rowIndex)];
    return row && row.key === el.dataset.rowKey ? { row, el } : null;
  };
  const isInInput = (e: React.SyntheticEvent) => !!(e.target as HTMLElement).closest('input');
  /** Row of the first click of a possible double-click (a click can change the rows under the pointer) */
  const firstClickKey = useRef<string | null>(null);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isInInput(e)) return;
    // Row buttons (⋯, twisty, links) leave focus on the tree, so the menu gives it back there
    if ((e.target as HTMLElement).closest('[data-action]')) {
      e.preventDefault();
      scrollRef.current?.focus({ preventScroll: true });
    }
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // The click that ends a drag selects and opens nothing
    if (drag.consumeClick() || isInInput(e)) return;
    const hit = rowFromEvent(e);
    if (e.detail <= 1) firstClickKey.current = hit?.row.key ?? null;
    if (!hit) return;
    const { row } = hit;
    const a = actionsRef.current;
    const actionEl = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    const action = actionEl?.dataset.action;
    if (action === 'more' && actionEl) {
      a.menu(row, { rect: actionEl.getBoundingClientRect(), placement: 'below' }, e.detail === 0);
      return;
    }
    if (action === 'toggle-all') {
      a.toggleAll();
      return;
    }
    if (action === 'new-here' && row.kind === 'placeholder') {
      a.newConnection(row);
      return;
    }
    if (action === 'twisty' && row.kind === 'folder') {
      selection.setActive(row.key);
      a.toggle(row, e.altKey);
      return;
    }
    // ⌘-click / Ctrl-click and Shift-click build a selection; folders do not fold then
    const toggleMod = mac ? e.metaKey : e.ctrlKey;
    if ((toggleMod || e.shiftKey) && (row.kind === 'site' || row.kind === 'folder')) {
      if (e.detail > 1) return;
      if (e.shiftKey) a.extendSelect(row);
      else a.toggleSelect(row);
      return;
    }
    if (row.kind === 'folder' || row.kind === 'section') {
      // The second click of a double-click does nothing
      if (e.detail > 1) return;
      a.activate(row, 'click');
      a.toggle(row, e.altKey && row.kind === 'folder');
      return;
    }
    if (e.detail > 1) return;
    a.activate(row, 'click');
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isInInput(e) || (e.target as HTMLElement).closest('[data-action]')) return;
    // A fast second ⌘-click or Shift-click edits the selection; it never connects
    if (e.shiftKey || (mac ? e.metaKey : e.ctrlKey)) return;
    const hit = rowFromEvent(e);
    // Both clicks must land on the same row: the first one may have opened the form or moved the list
    if (!hit || hit.row.key !== firstClickKey.current) return;
    if (hit.row.kind === 'site') actionsRef.current.open(hit.row);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isInInput(e)) return;
    e.preventDefault();
    const hit = rowFromEvent(e);
    scrollRef.current?.focus({ preventScroll: true });
    actionsRef.current.menu(hit?.row ?? null, { x: e.clientX, y: e.clientY }, false);
  };

  /* -------------------------------- render -------------------------------- */

  // The guide of the selected row's parent folder is drawn strong
  const selectedRow = useMemo(() => {
    for (const k of selection.keys) {
      const i = indexByKey.get(k);
      if (i !== undefined) return rows[i];
    }
    return undefined;
  }, [selection.keys, indexByKey, rows]);
  const strongParent = selectedRow && selectedRow.kind !== 'section' ? rowFolderPath(selectedRow) : '';
  const strongLevel = strongParent ? strongParent.split('/').length - 1 : -1;

  const indices: number[] = [];
  for (let i = range.first; i < range.last; i++) indices.push(i);
  if (isPinnedOutside && pinIndex >= 0) indices.push(pinIndex);

  const activeDomId = activeIndex >= 0 ? domId(rows[activeIndex].key) : undefined;

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable="true"
      aria-describedby={describedById}
      aria-activedescendant={activeDomId}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onPointerDown={drag.onPointerDown}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className="absolute inset-0 px-1.5 overflow-y-auto overflow-x-hidden rounded-md focus-visible:[outline-offset:-2px]"
    >
      <div role="none" className="relative" style={{ height: totalHeight }}>
        {indices.map((i) => {
          const row = rows[i];
          const folderPath = rowFolderPath(row);
          const strong = strongLevel >= 0 && row.kind !== 'section' && isInside(folderPath, strongParent) && folderPath !== '' ? strongLevel : -1;
          const dragView = drag.view;
          return (
            <SiteTreeRow
              key={row.key}
              row={row}
              index={i}
              domId={domId(row.key)}
              top={i * rowHeight}
              height={rowHeight}
              compact={compact}
              showAddress={showAddress}
              selected={selection.keys.has(row.key)}
              active={i === activeIndex}
              strongGuide={strong}
              showActions={selection.keys.has(row.key) && (selection.keys.size === 1 || i === activeIndex)}
              nameTerms={nameTerms}
              addressTerms={addressTerms}
              anyExpanded={anyExpanded}
              edit={edit && edit.rowKey === row.key ? edit.state : null}
              cut={cutKeys.size > 0 && cutKeys.has(canonicalKey(row.key))}
              dropTarget={dragView.targetKey === row.key}
              dropBlock={dragView.block !== null && inDropBlock(row, dragView.block)}
              springing={dragView.springKey === row.key}
            />
          );
        })}
      </div>
      {drag.view.payload && typeof document !== 'undefined' && createPortal(<DragGhost drag={drag.view} lang={i18n.language} t={t} ghostRef={drag.ghostRef} />, document.body)}
    </div>
  );
});

/** The card that follows the pointer during a drag: the first item's icon and name (or "3 items"), "+ Copy" with ⌥/Alt. */
const DragGhost: React.FC<{
  drag: { payload: DragPayload | null; copy: boolean };
  lang: string;
  t: ReturnType<typeof useTranslation>['t'];
  ghostRef: (el: HTMLElement | null) => void;
}> = ({ drag, lang, t, ghostRef }) => {
  const p = drag.payload;
  if (!p) return null;
  const label =
    p.count === 1
      ? p.first.kind === 'site'
        ? p.first.site.name
        : p.first.name
      : t('siteTree.dragItems', { count: p.count, formatted: formatCount(lang, p.count), defaultValue_one: '1 item', defaultValue_other: '{{formatted}} items' });
  return (
    <div
      ref={ghostRef}
      aria-hidden
      style={{ position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 200 }}
      className="ui-card shadow-pop h-7 px-2.5 max-w-[280px] flex items-center gap-2 text-[12.5px] text-ink whitespace-nowrap select-none"
    >
      {p.first.kind === 'site' ? <ProtocolGlyph site={p.first.site} className="w-3.5 h-3.5" /> : <Folder aria-hidden className="w-3.5 h-3.5 shrink-0 text-ink-faint" />}
      <span className="min-w-0 truncate">{label}</span>
      {drag.copy && <span className="shrink-0 text-[11px] font-medium text-rust-500">{t('siteTree.dragCopy', '+ Copy')}</span>}
    </div>
  );
};
