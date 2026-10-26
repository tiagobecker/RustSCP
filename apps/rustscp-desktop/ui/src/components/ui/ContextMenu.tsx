import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Minus } from 'lucide-react';
import { ariaKeyShortcuts, nextTypeaheadIndex, placeMenu, placeSubmenu } from './contextMenuUtils.ts';
import type { MenuAnchor, MenuPlacement } from './contextMenuUtils.ts';

// Shortcut labels for entries come from formatShortcut() in ./contextMenuUtils.ts (not re-exported
// here: a .tsx module that exports anything but components loses React Fast Refresh).
export type { MenuAnchor } from './contextMenuUtils.ts';

export type ContextMenuEntry =
  | { kind: 'item'; id: string; label: string; icon?: React.ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean; bold?: boolean; title?: string; onSelect: () => void }
  | { kind: 'check'; id: string; label: string; icon?: React.ReactNode; checked: boolean | 'mixed'; keepOpen?: boolean; detail?: string; onToggle: () => void }
  | { kind: 'radio'; id: string; label: string; icon?: React.ReactNode; checked: boolean; onSelect: () => void }
  | { kind: 'submenu'; id: string; label: string; icon?: React.ReactNode; entries: ContextMenuEntry[] }
  | { kind: 'label'; label: string }
  | { kind: 'separator' };

export type ContextMenuCloseReason = 'select' | 'escape' | 'outside' | 'tab' | 'blur';

export interface ContextMenuProps {
  at: MenuAnchor;
  entries: ContextMenuEntry[];
  ariaLabel: string;
  /** The owner unmounts the menu here. 'blur' also covers a window resize. */
  onClose: (reason: ContextMenuCloseReason) => void;
  /** Width in px of the menu and its submenus (default 240). */
  width?: number;
  /** Focus the first item at once (opened from the keyboard: Shift+F10, ContextMenu key, Enter on ⋯). */
  focusFirst?: boolean;
  /** DOM id of the top-level menu, for the opener's `aria-controls` */
  rootId?: string;
}

const SUBMENU_DELAY_MS = 150;
const TYPEAHEAD_RESET_MS = 700;
const ITEM_SELECTOR = '[data-cm-item]:not([disabled])';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

type Level = { entries: ContextMenuEntry[]; triggerId?: string };

/**
 * Right-click and ⋯ menus. Portaled to <body> (an .animate-pop ancestor would capture position:fixed).
 * While open it owns the keyboard: its root carries data-ui-modal, so Modal and every other
 * "top-most [data-ui-modal]" check step aside and one Escape closes only the menu.
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({ at, entries, ariaLabel, onClose, width = 240, focusFirst = false, rootId }) => {
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when the menu opened gets it back when the menu closes.
  const [opener] = useState(() => (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null));
  const [openPath, setOpenPath] = useState<string[]>([]);
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closedRef = useRef(false);
  const hoverTimer = useRef<number | null>(null);
  const pendingFocusLevel = useRef<number | null>(null);
  const typeahead = useRef({ text: '', at: 0 });

  // Levels on screen: the root menu, then each open submenu.
  const levels = useMemo(() => {
    const out: Level[] = [{ entries }];
    let current = entries;
    for (let depth = 0; depth < openPath.length; depth++) {
      const index = current.findIndex((e) => e.kind === 'submenu' && e.id === openPath[depth]);
      const sub = current[index];
      // The entries changed under an open submenu: show the levels that still exist
      if (!sub || sub.kind !== 'submenu') break;
      out.push({ entries: sub.entries, triggerId: itemDomId(baseId, depth, index) });
      current = sub.entries;
    }
    return out;
  }, [entries, openPath, baseId]);
  const levelsRef = useRef(levels);
  levelsRef.current = levels;

  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const scheduleHover = (fn: () => void) => {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      fn();
    }, SUBMENU_DELAY_MS);
  };

  const restoreFocus = () => {
    if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') {
      opener.focus({ preventScroll: true });
    }
  };

  const close = (reason: ContextMenuCloseReason) => {
    if (closedRef.current) return;
    closedRef.current = true;
    clearHoverTimer();
    restoreFocus();
    onCloseRef.current(reason);
  };

  const panelOf = (level: number) => rootRef.current?.querySelector<HTMLElement>(`[data-cm-level="${level}"]`) ?? null;
  const itemsOf = (level: number) => Array.from(panelOf(level)?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
  const focusItem = (el: HTMLElement | undefined) => {
    if (!el) return;
    el.focus({ preventScroll: true });
    // Scroll only the menu itself (scrollIntoView could also move the page or a dialog behind it).
    const panel = el.closest<HTMLElement>('[role="menu"]');
    if (!panel) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < panel.scrollTop) panel.scrollTop = Math.max(0, top - 4);
    else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight + 4;
  };

  /** The level holding keyboard focus (the deepest one that contains it), else the root. */
  const focusedLevel = () => {
    const active = document.activeElement;
    for (let level = levelsRef.current.length - 1; level >= 0; level--) {
      if (active && panelOf(level)?.contains(active)) return level;
    }
    return 0;
  };

  const openSubmenu = (level: number, id: string, focusFirstItem: boolean) => {
    clearHoverTimer();
    if (focusFirstItem) pendingFocusLevel.current = level + 1;
    const next = [...openPathRef.current.slice(0, level), id];
    if (next.join('\u0000') === openPathRef.current.join('\u0000')) {
      if (focusFirstItem) focusPending();
      return;
    }
    setOpenPath(next);
  };

  const focusPending = () => {
    const level = pendingFocusLevel.current;
    if (level === null || !panelOf(level)) return;
    pendingFocusLevel.current = null;
    focusItem(itemsOf(level)[0]);
  };

  // A submenu opened from the keyboard (or a click) focuses its first item once it is in the DOM.
  useEffect(focusPending, [openPath]);

  const handleKey = (e: KeyboardEvent) => {
    const level = focusedLevel();
    const items = itemsOf(level);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const consume = () => {
      e.preventDefault();
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        consume();
        if (!items.length) return;
        if (openPathRef.current.length > level) setOpenPath(openPathRef.current.slice(0, level));
        const down = e.key === 'ArrowDown';
        const next = current < 0 ? (down ? 0 : items.length - 1) : (current + (down ? 1 : -1) + items.length) % items.length;
        focusItem(items[next]);
        return;
      }
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown': {
        consume();
        if (openPathRef.current.length > level) setOpenPath(openPathRef.current.slice(0, level));
        focusItem(e.key === 'Home' || e.key === 'PageUp' ? items[0] : items[items.length - 1]);
        return;
      }
      case 'ArrowRight': {
        consume();
        const el = items[current];
        const id = el?.dataset.cmSubmenu;
        if (el && id) openSubmenu(level, id, true);
        return;
      }
      case 'ArrowLeft':
      case 'Escape': {
        consume();
        if (level > 0) {
          const trigger = levelsRef.current[level]?.triggerId;
          setOpenPath(openPathRef.current.slice(0, level - 1));
          if (trigger) document.getElementById(trigger)?.focus({ preventScroll: true });
        } else if (e.key === 'Escape') {
          close('escape');
        }
        return;
      }
      case 'Tab':
        consume();
        close('tab');
        return;
      case 'Enter':
      case ' ':
        consume();
        items[current]?.click();
        return;
      default:
        break;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.trim()) {
      consume();
      const now = Date.now();
      const ta = typeahead.current;
      ta.text = now - ta.at > TYPEAHEAD_RESET_MS ? e.key : ta.text + e.key;
      ta.at = now;
      const labels = items.map((el) => el.dataset.cmLabel ?? el.textContent ?? '');
      const next = nextTypeaheadIndex(labels, current, ta.text);
      if (next >= 0) {
        if (openPathRef.current.length > level) setOpenPath(openPathRef.current.slice(0, level));
        focusItem(items[next]);
      }
    }
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const isTopMost = () => {
      const layers = document.querySelectorAll('[data-ui-modal]');
      return layers[layers.length - 1] === rootRef.current;
    };
    // Window capture runs before the page and before Modal's own handler gives way to the top-most layer.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopMost() || e.isComposing) return;
      e.stopPropagation();
      handleKeyRef.current(e);
    };
    // Enter and Space act on keydown; their keyup must not click the focused item a second time.
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isTopMost()) return;
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
    };
    const onBlur = () => closeRef.current('blur');
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      clearHoverTimer();
    };
  }, []);

  // Keyboard users land on the first item; pointer users on the menu itself (arrows then start at the top).
  useEffect(() => {
    if (focusFirst) focusItem(itemsOf(0)[0]);
    else panelOf(0)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closed from outside (the owner unmounted the menu): don't leave focus on a removed element.
  useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      if (!active || active === document.body || rootRef.current?.contains(active)) restoreFocus();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const activate = (entry: ContextMenuEntry, level: number, viaKeyboard: boolean) => {
    switch (entry.kind) {
      case 'item':
        if (entry.disabled) return;
        close('select');
        entry.onSelect();
        return;
      case 'radio':
        close('select');
        entry.onSelect();
        return;
      case 'check':
        if (entry.keepOpen) {
          entry.onToggle();
        } else {
          close('select');
          entry.onToggle();
        }
        return;
      case 'submenu':
        if (openPathRef.current[level] === entry.id) {
          if (viaKeyboard) {
            pendingFocusLevel.current = level + 1;
            focusPending();
          }
          return;
        }
        openSubmenu(level, entry.id, viaKeyboard);
        return;
      default:
        return;
    }
  };

  const onItemPointerEnter = (entry: ContextMenuEntry, level: number, el: HTMLElement) => {
    // Truncated labels show in full on hover (pt-BR runs long in a 240px menu).
    const text = el.querySelector<HTMLElement>('[data-cm-text]');
    if (text && !el.title && text.scrollWidth > text.clientWidth) el.title = text.textContent ?? '';
    const path = openPathRef.current;
    if (entry.kind === 'submenu') {
      if (path[level] === entry.id) clearHoverTimer();
      else scheduleHover(() => setOpenPath([...openPathRef.current.slice(0, level), entry.id]));
    } else if (path.length > level) {
      scheduleHover(() => setOpenPath(openPathRef.current.slice(0, level)));
    } else {
      clearHoverTimer();
    }
  };

  const renderLevel = (level: Level, depth: number) => {
    const hasCheck = level.entries.some((e) => e.kind === 'check' || e.kind === 'radio');
    const hasIcon = level.entries.some((e) => (e.kind === 'item' || e.kind === 'submenu' || e.kind === 'check' || e.kind === 'radio') && !!e.icon);

    const renderEntry = (entry: ContextMenuEntry, index: number): React.ReactNode => {
      if (entry.kind === 'separator') return <div key={`sep-${index}`} role="separator" className="ui-menu-sep" />;
      if (entry.kind === 'label') return null; // rendered as its group's heading
      const id = itemDomId(baseId, depth, index);
      const isOpen = entry.kind === 'submenu' && openPath[depth] === entry.id && levels.length > depth + 1;
      const disabled = entry.kind === 'item' && !!entry.disabled;
      const danger = entry.kind === 'item' && !!entry.danger;
      const checked = entry.kind === 'check' || entry.kind === 'radio' ? entry.checked : undefined;
      const shortcut = entry.kind === 'item' ? entry.shortcut : undefined;
      const icon = entry.icon;
      return (
        <button
          key={entry.id}
          id={id}
          type="button"
          tabIndex={-1}
          role={entry.kind === 'check' ? 'menuitemcheckbox' : entry.kind === 'radio' ? 'menuitemradio' : 'menuitem'}
          aria-checked={checked === undefined ? undefined : checked === 'mixed' ? 'mixed' : checked}
          aria-haspopup={entry.kind === 'submenu' ? 'menu' : undefined}
          aria-expanded={entry.kind === 'submenu' ? isOpen : undefined}
          aria-controls={isOpen ? levelDomId(baseId, depth + 1) : undefined}
          aria-keyshortcuts={ariaKeyShortcuts(shortcut)}
          title={entry.kind === 'item' ? entry.title : undefined}
          disabled={disabled}
          data-cm-item=""
          data-cm-label={entry.label}
          data-cm-submenu={entry.kind === 'submenu' ? entry.id : undefined}
          onClick={(e) => activate(entry, depth, e.detail === 0)}
          onPointerMove={(e) => {
            if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
          }}
          onPointerEnter={(e) => onItemPointerEnter(entry, depth, e.currentTarget)}
          onPointerLeave={(e) => {
            // Leaving an item clears its highlight (one highlight at a time, like a native menu).
            if (document.activeElement === e.currentTarget) panelOf(depth)?.focus({ preventScroll: true });
          }}
          className={cx(
            'ui-menu-item h-7 gap-2 text-[13px] transition-none hover:bg-transparent focus:bg-dark-650/70 focus:outline-none',
            'disabled:opacity-40',
            isOpen && 'bg-dark-650/70',
            danger && 'text-red-600 dark:text-red-400',
            entry.kind === 'item' && entry.bold && 'font-semibold'
          )}
        >
          {hasCheck && (
            <span className="w-4 h-4 shrink-0 flex items-center justify-center text-ink" aria-hidden>
              {checked === 'mixed' ? <Minus className="w-3.5 h-3.5" /> : checked ? <Check className="w-3.5 h-3.5" /> : null}
            </span>
          )}
          {hasIcon && (
            <span className={cx('w-4 h-4 shrink-0 flex items-center justify-center', danger ? 'text-current' : 'text-ink-muted')} aria-hidden>
              {icon}
            </span>
          )}
          <span data-cm-text="" className="flex-1 min-w-0 truncate">
            {entry.label}
          </span>
          {entry.kind === 'check' && entry.detail && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-ink-faint">
              {entry.detail}
            </span>
          )}
          {shortcut && (
            <span className="ui-kbd shrink-0" aria-hidden>
              {shortcut}
            </span>
          )}
          {entry.kind === 'submenu' && <ChevronRight className="w-3.5 h-3.5 shrink-0 text-ink-faint" aria-hidden />}
        </button>
      );
    };

    // Entries after a label (up to the next separator or label) form a labelled group.
    const out: React.ReactNode[] = [];
    let group: { key: string; labelId: string; label: string; children: React.ReactNode[] } | null = null;
    const flush = () => {
      if (!group) return;
      const g = group;
      out.push(
        <div key={g.key} role="group" aria-labelledby={g.labelId}>
          <div id={g.labelId} role="presentation" className="ui-menu-label truncate">
            {g.label}
          </div>
          {g.children}
        </div>
      );
      group = null;
    };
    level.entries.forEach((entry, index) => {
      if (entry.kind === 'label') {
        flush();
        group = { key: `group-${index}`, labelId: `${levelDomId(baseId, depth)}-g${index}`, label: entry.label, children: [] };
      } else if (entry.kind === 'separator') {
        flush();
        out.push(renderEntry(entry, index));
      } else if (group) {
        (group as { children: React.ReactNode[] }).children.push(renderEntry(entry, index));
      } else {
        out.push(renderEntry(entry, index));
      }
    });
    flush();

    return (
      <MenuPanel
        key={depth === 0 ? 'root' : `sub-${openPath.slice(0, depth).join('/')}`}
        id={depth === 0 && rootId ? rootId : levelDomId(baseId, depth)}
        depth={depth}
        at={at}
        triggerId={level.triggerId}
        width={width}
        ariaLabel={depth === 0 ? ariaLabel : undefined}
        layoutKey={level.entries}
        onPointerEnter={depth > 0 ? clearHoverTimer : undefined}
      >
        {out}
      </MenuPanel>
    );
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div ref={rootRef} data-ui-modal="" className="contents">
      <div
        className="fixed inset-0 z-[60] cursor-default"
        aria-hidden
        // A mouse closes on mousedown, after its default is prevented: closing on pointerdown would remove the
        // backdrop first, and the mousedown that follows would then drop focus to <body>. Touch and pen close on
        // pointerdown. A right-click closes from the contextmenu event below.
        onMouseDown={(e) => {
          e.preventDefault();
          if (e.button !== 2) close('outside');
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'mouse' && e.button !== 2) close('outside');
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          close('outside');
        }}
      />
      {levels.map((level, depth) => renderLevel(level, depth))}
    </div>,
    document.body
  );
};

const itemDomId = (base: string, depth: number, index: number) => `cm${base.replace(/[^a-zA-Z0-9_-]/g, '')}-${depth}-${index}`;
const levelDomId = (base: string, depth: number) => `cm${base.replace(/[^a-zA-Z0-9_-]/g, '')}-menu-${depth}`;

interface MenuPanelProps {
  id: string;
  depth: number;
  at: MenuAnchor;
  triggerId?: string;
  width: number;
  ariaLabel?: string;
  /** Re-measures when this changes (the entries). */
  layoutKey: unknown;
  onPointerEnter?: () => void;
  children: React.ReactNode;
}

/** One menu surface (root or submenu): measures itself, then flips and clamps into the window. */
const MenuPanel: React.FC<MenuPanelProps> = ({ id, depth, at, triggerId, width, ariaLabel, layoutKey, onPointerEnter, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const anchorKey = 'rect' in at ? `r${at.rect.left},${at.rect.top},${at.rect.right},${at.rect.bottom},${at.placement ?? ''}` : `p${at.x},${at.y}`;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Natural height even while a max-height is applied: content + border.
    const size = { width, height: el.scrollHeight + (el.offsetHeight - el.clientHeight) };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    let next: MenuPlacement;
    if (depth === 0) {
      next = placeMenu(at, size, viewport);
    } else {
      const trigger = triggerId ? document.getElementById(triggerId) : null;
      const parent = trigger?.closest<HTMLElement>('[role="menu"]');
      if (!trigger || !parent) return;
      next = placeSubmenu(parent.getBoundingClientRect(), trigger.getBoundingClientRect(), size, viewport, undefined, parent.dataset.cmDir === 'left');
    }
    setPos((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight && prev.originX === next.originX && prev.originY === next.originY
        ? prev
        : next
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, depth, triggerId, width, layoutKey]);

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : triggerId}
      aria-orientation="vertical"
      tabIndex={-1}
      data-cm-level={depth}
      data-cm-dir={pos?.originX === 'right' ? 'left' : 'right'}
      onPointerEnter={onPointerEnter}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width,
        maxHeight: pos?.maxHeight,
        transformOrigin: pos ? `${pos.originY} ${pos.originX}` : undefined,
      }}
      className="z-[60] ui-menu overflow-y-auto overscroll-contain select-none animate-pop focus:outline-none"
    >
      {children}
    </div>
  );
};
