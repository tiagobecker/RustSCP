/**
 * Drag and drop in the connections tree (spec §11), with pointer events only: HTML5 drag and drop
 * never reaches the page inside Tauri's webviews (see paneDropTargets.ts).
 *
 * - A press on a site or folder row turns into a drag after DRAG_THRESHOLD px. The tree captures
 *   the pointer; window listeners follow it, so leaving the tree never loses the drag.
 * - Hit testing is arithmetic (rows have a fixed height), so it also works while the list scrolls.
 * - Resting on a collapsed folder for SPRING_DELAY_MS opens it (its bar fills meanwhile). Folders
 *   opened this way fold back after the drag unless they received the drop.
 * - Near the top or bottom edge the list scrolls, faster closer to the edge (up to 16px a frame).
 * - ⌥/Alt held at the drop copies instead of moving. Escape cancels.
 * - Invalid targets get no highlight and a not-allowed cursor.
 *
 * The owner (SiteSidebar, through SiteTree) decides what a drag carries and runs the drop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { isMacPlatform } from '../fileListUtils.ts';
import { SPRING_DELAY_MS } from '../../utils/tabDragManager.ts';
import { checkDrop, dropSpotForRow } from './treeDragModel.ts';
import type { DragPayload, DropSpot } from './treeDragModel.ts';
import type { TreeRow } from './types.ts';

/** Pointer travel before a press becomes a drag (FilePanel uses the same) */
export const DRAG_THRESHOLD = 4;
/** Auto-scroll zone at the list's top and bottom edges */
export const DRAG_SCROLL_EDGE = 32;
/** Fastest auto-scroll step, in px per frame */
export const DRAG_SCROLL_MAX = 16;
/** Ghost offset from the pointer */
const GHOST_DX = 12;
const GHOST_DY = 8;
/** Attribute on <html> that sets the cursor everywhere while a drag runs (index.css) */
const CURSOR_ATTR = 'data-stree-drag';

/** What the tree asks its owner during a drag. */
export interface TreeDragHost {
  /** What a drag from this row carries; null when the row cannot be dragged */
  payload: (row: TreeRow) => DragPayload | null;
  /** Spring-loading opens folders; folding back closes them again */
  setExpanded: (paths: string[], expanded: boolean) => void;
  /** The target under the pointer changed (for the live region); null when there is none */
  hover: (spot: DropSpot | null, valid: boolean, copy: boolean) => void;
  /** A valid drop: move (or copy) the items into `folder`; `springOpened` lists folders spring-loading opened */
  drop: (payload: DragPayload, folder: string, copy: boolean, springOpened: string[]) => void;
}

/** What the rows show while a drag runs. */
export interface TreeDragView {
  payload: DragPayload | null;
  copy: boolean;
  /** Highlighted drop row (valid targets only) */
  targetKey: string | null;
  /** Folder whose rows get the block tint */
  block: string | null;
  /** Folder row whose spring bar is filling */
  springKey: string | null;
}

const IDLE: TreeDragView = { payload: null, copy: false, targetKey: null, block: null, springKey: null };

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  alt: boolean;
  row: TreeRow;
  captureEl: HTMLElement;
  active: boolean;
  payload: DragPayload | null;
  spot: DropSpot | null;
  valid: boolean;
  springPath: string | null;
  springTimer: number | null;
  springOpened: string[];
  raf: number | null;
}

export interface TreeDrag {
  view: TreeDragView;
  /** On the tree scroller */
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  /** Cancels a running drag (Escape); true when one was running */
  cancel: () => boolean;
  /** True once for the click that follows a drop (it must not select or open anything) */
  consumeClick: () => boolean;
  /** Callback ref for the ghost element (positioned outside React, so pointer moves do not re-render) */
  ghostRef: (el: HTMLElement | null) => void;
}

const setCursor = (effect: 'move' | 'copy' | 'none' | null) => {
  if (typeof document === 'undefined') return;
  if (effect) document.documentElement.setAttribute(CURSOR_ATTR, effect);
  else document.documentElement.removeAttribute(CURSOR_ATTR);
};

/** Auto-scroll step for a pointer `d` px from an edge: faster closer to it, capped. */
const scrollStep = (d: number): number => Math.min(DRAG_SCROLL_MAX, Math.max(1, Math.ceil(((DRAG_SCROLL_EDGE - d) * DRAG_SCROLL_MAX) / DRAG_SCROLL_EDGE)));

export function useTreeDrag(opts: {
  scrollRef: RefObject<HTMLDivElement | null>;
  rows: readonly TreeRow[];
  rowHeight: number;
  hostRef: MutableRefObject<TreeDragHost>;
}): TreeDrag {
  const { scrollRef, hostRef } = opts;
  const rowsRef = useRef(opts.rows);
  rowsRef.current = opts.rows;
  const rowHeightRef = useRef(opts.rowHeight);
  rowHeightRef.current = opts.rowHeight;

  const [view, setView] = useState<TreeDragView>(IDLE);
  const viewRef = useRef(view);
  const stRef = useRef<DragState | null>(null);
  const ghostEl = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false);
  const mac = useRef(isMacPlatform()).current;

  const publish = (next: TreeDragView) => {
    const v = viewRef.current;
    if (v.payload === next.payload && v.copy === next.copy && v.targetKey === next.targetKey && v.block === next.block && v.springKey === next.springKey) return;
    viewRef.current = next;
    setView(next);
  };

  const placeGhost = (st: DragState) => {
    if (ghostEl.current) ghostEl.current.style.transform = `translate(${Math.round(st.x + GHOST_DX)}px, ${Math.round(st.y + GHOST_DY)}px)`;
  };

  /** The row under a point: `inside` false when the point is outside the list; row null below the last row. */
  const hitTest = (x: number, y: number): { inside: boolean; row: TreeRow | null } => {
    const el = scrollRef.current;
    if (!el) return { inside: false, row: null };
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return { inside: false, row: null };
    const i = Math.floor((y - r.top + el.scrollTop) / rowHeightRef.current);
    return { inside: true, row: rowsRef.current[i] ?? null };
  };

  const clearSpring = (st: DragState) => {
    if (st.springTimer !== null) window.clearTimeout(st.springTimer);
    st.springTimer = null;
    st.springPath = null;
  };

  /** Re-reads the target under the pointer (after a move, a scroll, a modifier change or a spring). */
  const update = () => {
    const st = stRef.current;
    if (!st || !st.active || !st.payload) return;
    placeGhost(st);
    const hit = hitTest(st.x, st.y);
    const spot = hit.inside ? dropSpotForRow(hit.row) : null;
    const valid = !!spot && checkDrop(st.payload, spot.folder, st.alt) === 'ok';

    // Spring-loading: only a collapsed folder row that would take the drop, and only once per folder
    const row = hit.row;
    const springPath = valid && row?.kind === 'folder' && !row.expanded && !st.springOpened.includes(row.path) ? row.path : null;
    if (springPath !== st.springPath) {
      clearSpring(st);
      if (springPath !== null) {
        st.springPath = springPath;
        st.springTimer = window.setTimeout(() => {
          const cur = stRef.current;
          if (cur !== st || !st.active) return;
          st.springTimer = null;
          st.springPath = null;
          st.springOpened.push(springPath);
          hostRef.current.setExpanded([springPath], true);
          update();
        }, SPRING_DELAY_MS);
      }
    }

    setCursor(valid ? (st.alt ? 'copy' : 'move') : 'none');
    const changed = st.valid !== valid || st.spot?.highlightKey !== spot?.highlightKey || st.spot?.folder !== spot?.folder;
    const copyChanged = viewRef.current.copy !== st.alt;
    st.spot = spot;
    st.valid = valid;
    if (changed || copyChanged) hostRef.current.hover(spot, valid, st.alt);
    publish({
      payload: st.payload,
      copy: st.alt,
      targetKey: valid && spot ? spot.highlightKey : null,
      block: valid && spot ? spot.block : null,
      springKey: st.springPath !== null ? `f:${st.springPath}` : null,
    });
  };

  /** One auto-scroll frame; keeps running while the drag does. */
  const tick = () => {
    const st = stRef.current;
    if (!st || !st.active) return;
    st.raf = requestAnimationFrame(tick);
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (st.x < r.left || st.x > r.right) return;
    const fromTop = st.y - r.top;
    const fromBottom = r.bottom - st.y;
    // A little past the edge still scrolls (at full speed), so a fast flick does not stop it
    let dy = 0;
    if (fromTop < DRAG_SCROLL_EDGE && fromTop > -DRAG_SCROLL_EDGE * 1.5) dy = -scrollStep(fromTop);
    else if (fromBottom < DRAG_SCROLL_EDGE && fromBottom > -DRAG_SCROLL_EDGE * 1.5) dy = scrollStep(fromBottom);
    if (!dy) return;
    const before = el.scrollTop;
    el.scrollTop = before + dy;
    if (el.scrollTop !== before) update();
  };

  const listeners = useRef({
    move: (e: PointerEvent) => impl.current.move(e),
    up: (e: PointerEvent) => impl.current.up(e),
    cancel: () => impl.current.abort(),
    key: (e: KeyboardEvent) => impl.current.key(e),
  }).current;

  /** Ends the drag (no drop). Returns the folders spring-loading opened, for the caller to fold back. */
  const end = (): { wasActive: boolean; springOpened: string[] } => {
    const st = stRef.current;
    stRef.current = null;
    window.removeEventListener('pointermove', listeners.move, true);
    window.removeEventListener('pointerup', listeners.up, true);
    window.removeEventListener('pointercancel', listeners.cancel, true);
    window.removeEventListener('keydown', listeners.key, true);
    window.removeEventListener('keyup', listeners.key, true);
    window.removeEventListener('blur', listeners.cancel);
    if (!st) return { wasActive: false, springOpened: [] };
    clearSpring(st);
    if (st.raf !== null) cancelAnimationFrame(st.raf);
    if (!st.active) return { wasActive: false, springOpened: [] };
    try {
      if (st.captureEl.hasPointerCapture(st.pointerId)) st.captureEl.releasePointerCapture(st.pointerId);
    } catch {
      /* the element is gone */
    }
    setCursor(null);
    publish(IDLE);
    hostRef.current.hover(null, false, false);
    return { wasActive: true, springOpened: st.springOpened };
  };

  /** Cancels: nothing moves, spring-opened folders fold back. */
  const abort = (): boolean => {
    const { wasActive, springOpened } = end();
    if (springOpened.length) hostRef.current.setExpanded(springOpened, false);
    return wasActive;
  };

  const begin = (st: DragState): boolean => {
    const payload = hostRef.current.payload(st.row);
    if (!payload) return false;
    st.active = true;
    st.payload = payload;
    try {
      st.captureEl.setPointerCapture(st.pointerId);
    } catch {
      /* capture is best effort: the window listeners still see the pointer */
    }
    st.raf = requestAnimationFrame(tick);
    return true;
  };

  const impl = useRef({
    move: (_e: PointerEvent) => {},
    up: (_e: PointerEvent) => {},
    abort: () => {},
    key: (_e: KeyboardEvent) => {},
  });
  impl.current = {
    move: (e) => {
      const st = stRef.current;
      if (!st || e.pointerId !== st.pointerId) return;
      if (e.buttons === 0) {
        // Released outside the window without a pointerup: cancel instead of a phantom drag
        abort();
        return;
      }
      st.x = e.clientX;
      st.y = e.clientY;
      st.alt = e.altKey;
      if (!st.active) {
        if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) <= DRAG_THRESHOLD) return;
        if (!begin(st)) {
          end();
          return;
        }
      }
      e.preventDefault();
      update();
    },
    up: (e) => {
      const st = stRef.current;
      if (!st || e.pointerId !== st.pointerId) return;
      if (!st.active || !st.payload) {
        // A plain click: the tree's click handlers select and open as usual
        end();
        return;
      }
      st.x = e.clientX;
      st.y = e.clientY;
      st.alt = e.altKey;
      const hit = hitTest(st.x, st.y);
      const spot = hit.inside ? dropSpotForRow(hit.row) : null;
      const copy = st.alt;
      const payload = st.payload;
      const valid = !!spot && checkDrop(payload, spot.folder, copy) === 'ok';
      const { springOpened } = end();
      // The click that follows this pointerup must not select or open anything
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (valid && spot) hostRef.current.drop(payload, spot.folder, copy, springOpened);
      else if (springOpened.length) hostRef.current.setExpanded(springOpened, false);
    },
    abort: () => {
      abort();
    },
    key: (e) => {
      const st = stRef.current;
      if (!st) return;
      if (e.key === 'Escape') {
        if (e.type !== 'keydown') return;
        // The Connect dialog routes Escape to the sidebar first (which cancels through `cancel`);
        // this catches it when nothing else did
        if (st.active) {
          e.preventDefault();
          e.stopPropagation();
        }
        abort();
        return;
      }
      if (e.key === 'Alt' && st.active) {
        // Alt alone must not reach the window menu (Windows) mid-drag
        e.preventDefault();
        st.alt = e.type === 'keydown';
        update();
      }
    },
  };

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      // Control-click opens the context menu on macOS
      if (mac && e.ctrlKey) return;
      const target = e.target as HTMLElement;
      // Never from the rename input or a row's buttons (⋯, links)
      if (target.closest('input, button, textarea')) return;
      const rowEl = target.closest<HTMLElement>('[data-row-key]');
      if (!rowEl || !e.currentTarget.contains(rowEl)) return;
      const row = rowsRef.current[Number(rowEl.dataset.rowIndex)];
      if (!row || row.key !== rowEl.dataset.rowKey || (row.kind !== 'site' && row.kind !== 'folder')) return;
      impl.current.abort();
      stRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        alt: e.altKey,
        row,
        captureEl: e.currentTarget,
        active: false,
        payload: null,
        spot: null,
        valid: false,
        springPath: null,
        springTimer: null,
        springOpened: [],
        raf: null,
      };
      window.addEventListener('pointermove', listeners.move, true);
      window.addEventListener('pointerup', listeners.up, true);
      window.addEventListener('pointercancel', listeners.cancel, true);
      window.addEventListener('keydown', listeners.key, true);
      window.addEventListener('keyup', listeners.key, true);
      window.addEventListener('blur', listeners.cancel);
    },
    [mac, listeners]
  );

  const cancel = useCallback(() => {
    const st = stRef.current;
    if (!st?.active) return false;
    impl.current.abort();
    return true;
  }, []);

  const consumeClick = useCallback(() => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  }, []);

  const ghostRef = useCallback((el: HTMLElement | null) => {
    ghostEl.current = el;
    const st = stRef.current;
    if (el && st) el.style.transform = `translate(${Math.round(st.x + GHOST_DX)}px, ${Math.round(st.y + GHOST_DY)}px)`;
  }, []);

  // The tree unmounting mid-drag (the dialog closed) cleans up after itself
  useEffect(() => () => void impl.current.abort(), []);

  return { view, onPointerDown, cancel, consumeClick, ghostRef };
}
