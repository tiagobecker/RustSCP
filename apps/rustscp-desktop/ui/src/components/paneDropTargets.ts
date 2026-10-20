/**
 * Shared state for moving files between file panes.
 *
 * Row drags use pointer events, not HTML5 drag and drop. Tauri's native drag-drop handler
 * (`dragDropEnabled`, needed so Finder/Explorer drops carry absolute paths) consumes every
 * dragover/drop inside the webview, so HTML5 drops never reach the page in the desktop app.
 * Each mounted FilePanel registers itself here; a drag that starts in one pane finds the pane and
 * folder under the pointer through `fromElement`, and F5/F6 read the other pane's listing through
 * `byPaneId` to warn about name collisions before replacing anything.
 */

/** Attribute on a pane's scroll container; its value is the id passed to `register`. */
export const PANE_DROP_ATTR = 'data-file-pane-id';

export interface PaneDropHit {
  /** Folder that receives the drop. */
  destDir: string;
  /** Key of the folder row/card under the pointer; null means the pane's current folder. */
  key: string | null;
}

export interface PaneListing {
  sessionId: string;
  path: string;
  /** Names in `path`; null while the pane is loading (callers then list the folder themselves). */
  names: Set<string> | null;
}

export interface PaneDropTarget {
  paneId?: 'left' | 'right';
  sessionId: () => string;
  /** The scroll container of the file list (used for edge auto-scroll). */
  listEl: () => HTMLElement | null;
  /** Folder for the element under the pointer, or null when the element is not in this list. */
  hitTest: (el: Element) => PaneDropHit | null;
  /** Shows (or clears, with null) the drop highlight. */
  setHover: (hit: PaneDropHit | null) => void;
  /** Queues the transfer with the pane's own safety checks (self-target, Replace/Skip). */
  drop: (sourceSessionId: string, paths: string[], destDir: string, isCopy: boolean) => void;
  listing: () => PaneListing;
}

const targets = new Map<string, PaneDropTarget>();

export const paneDropTargets = {
  /** Registers a pane; returns the function that removes it. */
  register(id: string, target: PaneDropTarget): () => void {
    targets.set(id, target);
    return () => {
      if (targets.get(id) === target) targets.delete(id);
    };
  },

  get(id: string): PaneDropTarget | undefined {
    return targets.get(id);
  },

  /** The registered pane whose file list contains `el`. */
  fromElement(el: Element | null): { id: string; target: PaneDropTarget } | null {
    const host = el?.closest?.(`[${PANE_DROP_ATTR}]`);
    const id = host?.getAttribute(PANE_DROP_ATTR);
    const target = id ? targets.get(id) : undefined;
    return id && target ? { id, target } : null;
  },

  byPaneId(paneId: 'left' | 'right'): PaneDropTarget | undefined {
    for (const t of targets.values()) if (t.paneId === paneId) return t;
    return undefined;
  },
};

/* ------------------------------ Drag cursor ------------------------------ */

const CURSOR_ATTR = 'data-rustscp-file-drag';
let cursorStyle: HTMLStyleElement | null = null;

/**
 * Cursor (and no text selection) for the whole window while a row drag runs: rows set their own
 * cursor, so a cursor on <body> alone would not show. Pass null when the drag ends.
 */
export function setFileDragCursor(effect: 'copy' | 'move' | 'none' | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!effect) {
    root.removeAttribute(CURSOR_ATTR);
    return;
  }
  if (!cursorStyle) {
    cursorStyle = document.createElement('style');
    cursorStyle.textContent =
      `html[${CURSOR_ATTR}], html[${CURSOR_ATTR}] * { cursor: grabbing !important; user-select: none !important; -webkit-user-select: none !important; }` +
      `html[${CURSOR_ATTR}="copy"], html[${CURSOR_ATTR}="copy"] * { cursor: copy !important; }` +
      `html[${CURSOR_ATTR}="none"], html[${CURSOR_ATTR}="none"] * { cursor: no-drop !important; }`;
    document.head.appendChild(cursorStyle);
  }
  root.setAttribute(CURSOR_ATTR, effect);
}
