import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Fixed-height list virtualization (the FilePanel pattern, no dependency).
 *
 * Render rows as `position:absolute; top: i * rowHeight` inside a spacer of `totalHeight`, only for
 * `range.first <= i < range.last`. When `isPinnedOutside`, also render row `pinIndex` (the active
 * row, so `aria-activedescendant` always points at a node in the DOM).
 *
 * `topInset` is the height of an overlay on top of the scroller (the sticky breadcrumb): rows
 * scrolled into view land below it, and `firstVisible` is the first row it does not cover.
 */
export interface VirtualRowsOptions {
  count: number;
  rowHeight: number;
  /** Extra rows rendered above and below the viewport (default 8) */
  overscan?: number;
  /** Row that must stay rendered (the active row) */
  pinIndex?: number;
  topInset?: number;
}

export type ScrollAlign = 'nearest' | 'start' | 'center';

export interface VirtualRows {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** rAF-throttled; pass to the scroller's `onScroll` */
  onScroll: () => void;
  /** `[first, last)` */
  range: { first: number; last: number };
  totalHeight: number;
  isPinnedOutside: boolean;
  /** Arithmetic only, no DOM measuring */
  scrollToIndex: (i: number, align?: ScrollAlign) => void;
  /** First row not covered by `topInset` (drives the sticky breadcrumb) */
  firstVisible: number;
  /** Rows that fit in the viewport (PageUp / PageDown) */
  pageSize: number;
  /** The scroller's scrollTop as last measured (drives an overlay that depends on the scroll position) */
  viewportTop: number;
}

/** Viewport height assumed before the first measurement */
const FALLBACK_HEIGHT = 600;

export function useVirtualRows(opts: VirtualRowsOptions): VirtualRows {
  const { count, rowHeight, overscan = 8, pinIndex, topInset = 0 } = opts;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const rafRef = useRef<number | null>(null);
  const observed = useRef<{ el: HTMLDivElement; ro: ResizeObserver } | null>(null);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
  }, []);

  // The scroller may mount after the hook (or be replaced): watch whichever element the ref holds
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (observed.current?.el === el) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observed.current = { el, ro };
    measure();
  });

  useEffect(
    () => () => {
      observed.current?.ro.disconnect();
      observed.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  const onScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      measure();
    });
  }, [measure]);

  const totalHeight = count * rowHeight;
  const height = viewport.height || FALLBACK_HEIGHT;

  const range = useMemo(() => {
    // Clamp to the real scroll range: when the list shrinks, the browser clamps scrollTop a frame later
    const top = Math.max(0, Math.min(viewport.top, totalHeight - height));
    const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const last = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
    return { first, last: Math.max(first, last) };
  }, [viewport.top, height, totalHeight, rowHeight, overscan, count]);

  const firstVisible = useMemo(() => {
    if (count === 0) return 0;
    const top = Math.max(0, Math.min(viewport.top, totalHeight - height));
    return Math.min(count - 1, Math.floor((top + topInset) / rowHeight));
  }, [viewport.top, height, totalHeight, topInset, rowHeight, count]);

  const scrollToIndex = useCallback(
    (i: number, align: ScrollAlign = 'nearest') => {
      const el = scrollRef.current;
      if (!el || i < 0 || i >= count) return;
      const h = el.clientHeight || FALLBACK_HEIGHT;
      const rowTop = i * rowHeight;
      const rowBottom = rowTop + rowHeight;
      let next = el.scrollTop;
      if (align === 'start') next = rowTop - topInset;
      else if (align === 'center') next = rowTop - topInset - (h - topInset - rowHeight) / 2;
      else if (rowTop < el.scrollTop + topInset) next = rowTop - topInset;
      else if (rowBottom > el.scrollTop + h) next = rowBottom - h;
      next = Math.round(Math.max(0, Math.min(next, count * rowHeight - h)));
      if (next !== el.scrollTop) el.scrollTop = next;
      // Update the range now instead of waiting for the scroll event
      setViewport((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    },
    [count, rowHeight, topInset]
  );

  const isPinnedOutside = pinIndex !== undefined && pinIndex >= 0 && pinIndex < count && (pinIndex < range.first || pinIndex >= range.last);
  const pageSize = Math.max(1, Math.floor((height - topInset) / rowHeight));

  const viewportTop = Math.max(0, Math.min(viewport.top, totalHeight - height));

  return { scrollRef, onScroll, range, totalHeight, isPinnedOutside, scrollToIndex, firstVisible, pageSize, viewportTop };
}
