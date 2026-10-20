/**
 * Tab Drag Manager for RustSCP
 * Pointer-based Tab Drag & Reorder Architecture:
 * 1. Supports reordering tabs within the same pane with exact insertion index.
 * 2. Supports cross-pane tab dragging (Left <-> Right) with insertion index or pane drop.
 * 3. Notifies subscribers on every pointer movement for smooth ghost & insertion line rendering.
 * 4. Resilient fallback that calculates pane from split ratio if released outside tab bar.
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
