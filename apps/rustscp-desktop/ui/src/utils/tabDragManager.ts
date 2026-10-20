/**
 * Tab Drag Manager for RustSCP
 * Pointer-based Tab Drag & Reorder Architecture:
 * 1. Supports reordering tabs within the same pane with exact insertion index.
 * 2. Supports cross-pane tab dragging (Left <-> Right) with insertion index or pane drop.
 * 3. Notifies subscribers on every pointer movement for smooth ghost & insertion line rendering.
 * 4. Resilient fallback that calculates pane from split ratio if released outside tab bar.
 *
 * The second half of this file serves file drags (not tab drags): spring-loaded tabs and the
 * mode-aware drop entry points of the file panes.
 */

export interface DraggingTabState {
  sessionId: string;
  sourcePane: 'left' | 'right';
  sessionName: string;
  protocol?: string;
  fromIndex: number;
  cursorX: number;
  cursorY: number;
  targetPane: 'left' | 'right' | null;
  targetIndex: number | null;
}

export type DragListener = (state: DraggingTabState | null) => void;
export type TabMoveCallback = (
  sessionId: string,
  sourcePane: 'left' | 'right',
  targetPane: 'left' | 'right',
  targetIndex?: number
) => void;
export type TabReorderCallback = (
  pane: 'left' | 'right',
  fromIndex: number,
  toIndex: number
) => void;

let currentState: DraggingTabState | null = null;
let moveHandler: TabMoveCallback | null = null;
let reorderHandler: TabReorderCallback | null = null;
// Split ratio captured once per drag (avoids a localStorage read on every pointer move)
let dragSplitRatio = 0.5;
const listeners = new Set<DragListener>();

/** Reads the persisted commander split ratio (0.2 .. 0.8). */
export function readSplitRatio(): number {
  try {
    const raw = localStorage.getItem('rustscp_commander_split_ratio') || '50';
    return Math.min(Math.max(parseFloat(raw) || 50, 20), 80) / 100;
  } catch {
    return 0.5;
  }
}

function paneFromRatio(cursorX: number): 'left' | 'right' {
  return cursorX < window.innerWidth * dragSplitRatio ? 'left' : 'right';
}

function emit() {
  (window as any).__rustscpDraggingTab = currentState;
  listeners.forEach((fn) => fn(currentState));
}

export const tabDragManager = {
  startDrag(info: {
    sessionId: string;
    sourcePane: 'left' | 'right';
    sessionName: string;
    protocol?: string;
    fromIndex: number;
    cursorX: number;
    cursorY: number;
  }) {
    dragSplitRatio = readSplitRatio();
    currentState = {
      ...info,
      targetPane: info.sourcePane,
      targetIndex: info.fromIndex,
    };
    emit();
  },

  updatePointer(cursorX: number, cursorY: number, targetPane?: 'left' | 'right' | null, targetIndex?: number | null) {
    if (!currentState) return;

    const derivedPane = targetPane === undefined ? paneFromRatio(cursorX) : targetPane;

    currentState = {
      ...currentState,
      cursorX,
      cursorY,
      targetPane: derivedPane ?? currentState.targetPane,
      targetIndex: targetIndex !== undefined ? targetIndex : currentState.targetIndex,
    };
    emit();
  },

  setHoverTarget(targetPane: 'left' | 'right' | null, targetIndex: number | null = null) {
    if (!currentState) return;
    currentState = {
      ...currentState,
      targetPane,
      targetIndex,
    };
    emit();
  },

  finishDrag(): boolean {
    if (!currentState) return false;

    const { sessionId, sourcePane, fromIndex, targetPane, targetIndex, cursorX } = currentState;
    const finalTargetPane = targetPane || paneFromRatio(cursorX);

    let executed = false;

    if (finalTargetPane === sourcePane) {
      // Reorder within the same pane
      if (targetIndex !== null && targetIndex !== undefined && targetIndex !== fromIndex) {
        if (reorderHandler) {
          reorderHandler(sourcePane, fromIndex, targetIndex);
          executed = true;
        }
      }
    } else if (moveHandler) {
      // Cross-pane transfer
      moveHandler(sessionId, sourcePane, finalTargetPane, targetIndex ?? undefined);
      executed = true;
    }

    this.cancelDrag();
    return executed;
  },

  cancelDrag() {
    if (!currentState) return;
    currentState = null;
    emit();
  },

  /** Registers the cross-pane move handler; returns a function that unregisters it. */
  registerMoveHandler(fn: TabMoveCallback): () => void {
    moveHandler = fn;
    return () => {
      if (moveHandler === fn) moveHandler = null;
    };
  },

  /** Registers the reorder handler; returns a function that unregisters it. */
  registerReorderHandler(fn: TabReorderCallback): () => void {
    reorderHandler = fn;
    return () => {
      if (reorderHandler === fn) reorderHandler = null;
    };
  },

  clearHoverTarget(pane: 'left' | 'right') {
    if (currentState && currentState.targetPane === pane) {
      currentState = { ...currentState, targetPane: null };
      emit();
    }
  },

  getDraggingTab() {
    if (!currentState) return null;
    return {
      sessionId: currentState.sessionId,
      sourcePane: currentState.sourcePane,
      sessionName: currentState.sessionName,
      protocol: currentState.protocol,
      fromIndex: currentState.fromIndex,
    };
  },

  executeDrop(sessionId: string, sourcePane: 'left' | 'right', targetPane: 'left' | 'right', targetIndex?: number) {
    if (sourcePane === targetPane) return;
    if (moveHandler) {
      moveHandler(sessionId, sourcePane, targetPane, targetIndex);
    }
    this.cancelDrag();
  },

  clearImmediately() {
    this.cancelDrag();
  },

  getState(): DraggingTabState | null {
    return currentState;
  },

  isDragging(): boolean {
    return !!currentState;
  },

  subscribe(listener: DragListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/* ========================================================================== */
/* File drags over session tabs (spring-loaded tabs)                           */
/* ========================================================================== */
//
// While files are dragged (a row drag inside the app, or files from Finder/Explorer), resting on
// a session tab for SPRING_DELAY_MS opens that tab, and dropping on a tab sends the files to the
// folder that tab's session shows. Each tab strip registers here; FilePanel row drags hit-test
// tabs through `fileDragTabs.hitTest`, and each strip handles OS drops on its own tabs.
// Drops land in a pane through `filePaneSinks`, so every guard of the pane applies (self-target,
// Replace/Skip, the copy-or-move chooser).

/** Hover time on a tab before it opens during a file drag. */
export const SPRING_DELAY_MS = 700;

/** How a drop picks copy or move: fixed, or 'ask' (the drop action chooser). */
export type FileDropMode = 'copy' | 'move' | 'ask';

export interface FileDropOptions {
  /** List the destination again instead of trusting the pane's listing (drops on a tab). */
  verifyDest?: boolean;
  /** Where the files come from, for the chooser ("This computer", a pane's title). */
  sourceLabel?: string;
}

/** A mounted file pane, as a destination for drops that carry a FileDropMode. */
export interface FilePaneSink {
  paneId?: 'left' | 'right';
  /** Session and folder the pane shows, or null while its listing is loading. */
  shown: () => { sessionId: string; path: string } | null;
  drop: (sourceSessionId: string, paths: string[], destDir: string, mode: FileDropMode, opts?: FileDropOptions) => void;
}

const sinks = new Map<string, FilePaneSink>();

export const filePaneSinks = {
  /** Registers a pane under the same id it uses in paneDropTargets; returns the unregister function. */
  register(id: string, sink: FilePaneSink): () => void {
    sinks.set(id, sink);
    return () => {
      if (sinks.get(id) === sink) sinks.delete(id);
    };
  },

  get(id: string): FilePaneSink | undefined {
    return sinks.get(id);
  },
};

/** A tab strip (one per pane in Commander mode, one shared strip in Explorer mode). */
export interface TabStripTarget {
  /** Pane the strip belongs to; undefined for the Explorer-mode strip (App picks the pane). */
  paneId?: 'left' | 'right';
  isActive: (sessionId: string) => boolean;
  /** Opens the tab (spring-loading, or right before a drop on it). */
  activate: (sessionId: string) => void;
}

export interface FileTabHit {
  stripId: string;
  sessionId: string;
}

export interface TabSpringState extends FileTabHit {
  /** True while the timer runs (the tab is not open yet). */
  springing: boolean;
  /** Changes for every new hover, so the progress bar restarts. */
  token: number;
}

/** Attribute on a tab strip; its value is the id passed to `fileDragTabs.register`. */
export const TAB_STRIP_ATTR = 'data-tab-strip-id';

const strips = new Map<string, TabStripTarget>();
const springListeners = new Set<(s: TabSpringState | null) => void>();
let spring: TabSpringState | null = null;
let springTimer: ReturnType<typeof setTimeout> | null = null;
let springToken = 0;
let deliveryToken = 0;

function emitSpring() {
  springListeners.forEach((fn) => fn(spring));
}

function clearSpringTimer() {
  if (springTimer !== null) {
    clearTimeout(springTimer);
    springTimer = null;
  }
}

/** First mounted pane matching `paneId` (any pane when undefined) that shows `sessionId` and is not loading. */
function readySink(paneId: 'left' | 'right' | undefined, sessionId: string) {
  for (const sink of sinks.values()) {
    if (paneId && sink.paneId !== paneId) continue;
    const shown = sink.shown();
    if (shown && shown.sessionId === sessionId && shown.path) return { sink, path: shown.path };
  }
  return null;
}

/**
 * Tauri drag-drop positions: wry reports AppKit points on macOS and GTK logical pixels on Linux
 * (both already CSS pixels), but physical pixels on Windows (WebView2 + ScreenToClient).
 */
const IS_WINDOWS =
  typeof navigator !== 'undefined' && (/^Win/i.test(navigator.platform || '') || /Windows NT/i.test(navigator.userAgent || ''));

/** Converts a Tauri drag-drop position to CSS pixels of the page. */
export function osDragPointToCss(pos: { x: number; y: number }): { x: number; y: number } {
  const scale = IS_WINDOWS ? (typeof window !== 'undefined' && window.devicePixelRatio) || 1 : 1;
  return { x: pos.x / scale, y: pos.y / scale };
}

/** True while a dialog or menu covers the window: OS drops never land "through" an overlay. */
export function overlayBlocksDrop(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"], [role="menu"]');
}

/**
 * Whether a Finder/Explorer drag that carries files is over the window. Tauri sends 'enter' once
 * per drag, so this lives outside the listeners: one registered later (a pane whose tab sprang
 * open, a pane mounted mid-drag) still treats the following 'over' events as part of the drag.
 */
let osDragCarriesFiles = false;

export const osFileDrag = {
  /**
   * Feeds one Tauri drag-drop payload (every listener calls it for every event; the result is the
   * same for all of them). True when the event belongs to a file drag the listener should handle:
   * 'enter'/'over' while files are dragged, and every 'drop' that carries paths, also when this
   * listener never saw the 'enter'.
   */
  track(p: { type: string; paths?: string[] }): boolean {
    switch (p.type) {
      case 'enter':
        osDragCarriesFiles = !!p.paths?.length;
        return osDragCarriesFiles;
      case 'over':
        return osDragCarriesFiles;
      case 'drop':
        osDragCarriesFiles = false;
        return !!p.paths?.length;
      default:
        osDragCarriesFiles = false;
        return false;
    }
  },
};

export const fileDragTabs = {
  /** Registers a strip; returns the unregister function. */
  register(id: string, target: TabStripTarget): () => void {
    strips.set(id, target);
    return () => {
      if (strips.get(id) !== target) return;
      strips.delete(id);
      if (spring?.stripId === id) fileDragTabs.hover(null);
    };
  },

  /** The registered tab under `el`, or null. */
  hitTest(el: Element | null): FileTabHit | null {
    const tab = el?.closest?.('[data-tab-session-id]') as HTMLElement | null;
    const stripEl = tab?.closest(`[${TAB_STRIP_ATTR}]`);
    const stripId = stripEl?.getAttribute(TAB_STRIP_ATTR);
    const sessionId = tab?.getAttribute('data-tab-session-id');
    if (!stripId || !sessionId || !strips.has(stripId)) return null;
    return { stripId, sessionId };
  },

  /**
   * Updates the tab under a file drag (null: none). Resting on a tab that is not open starts the
   * spring timer; moving to another tab restarts it.
   */
  hover(hit: FileTabHit | null) {
    if (hit && spring && spring.stripId === hit.stripId && spring.sessionId === hit.sessionId) return;
    if (!hit && !spring) return;
    clearSpringTimer();
    if (!hit) {
      spring = null;
      emitSpring();
      return;
    }
    const strip = strips.get(hit.stripId);
    const springing = !!strip && !strip.isActive(hit.sessionId);
    const token = ++springToken;
    spring = { ...hit, springing, token };
    if (springing) {
      springTimer = setTimeout(() => {
        springTimer = null;
        if (!spring || spring.token !== token) return;
        strips.get(hit.stripId)?.activate(hit.sessionId);
        spring = { ...spring, springing: false };
        emitSpring();
      }, SPRING_DELAY_MS);
    }
    emitSpring();
  },

  /** Clears the hover only when it is on a tab of `stripId` (OS drags: each strip clears its own). */
  clearFrom(stripId: string) {
    if (spring?.stripId === stripId) fileDragTabs.hover(null);
  },

  getSpring(): TabSpringState | null {
    return spring;
  },

  subscribe(fn: (s: TabSpringState | null) => void): () => void {
    springListeners.add(fn);
    return () => {
      springListeners.delete(fn);
    };
  },

  /**
   * Files dropped on a tab: opens it if needed, waits until its pane shows that session's folder,
   * then hands the drop to that pane. 'timeout' means the folder did not open in time; 'cancelled'
   * that a newer drop replaced this one or the strip went away.
   */
  async deliver(
    hit: FileTabHit,
    sourceSessionId: string,
    paths: string[],
    mode: FileDropMode,
    opts?: FileDropOptions,
    timeoutMs = 15000
  ): Promise<'done' | 'timeout' | 'cancelled'> {
    fileDragTabs.hover(null);
    const strip = strips.get(hit.stripId);
    if (!strip || paths.length === 0) return 'cancelled';
    const token = ++deliveryToken;
    if (!strip.isActive(hit.sessionId)) strip.activate(hit.sessionId);
    const started = Date.now();
    for (;;) {
      const ready = readySink(strip.paneId, hit.sessionId);
      if (ready) {
        ready.sink.drop(sourceSessionId, paths, ready.path, mode, { ...opts, verifyDest: true });
        return 'done';
      }
      if (Date.now() - started > timeoutMs) return 'timeout';
      await new Promise((r) => setTimeout(r, 60));
      if (token !== deliveryToken || !strips.has(hit.stripId)) return 'cancelled';
    }
  },
};
