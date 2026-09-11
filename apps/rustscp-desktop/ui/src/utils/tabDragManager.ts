/**
 * Tab Drag Manager for RustSCP
 * Pointer-based Tab Drag & Reorder Architecture:
 * 1. Supports reordering tabs within the same pane with exact insertion index.
 * 2. Supports cross-pane tab dragging (Left <-> Right) with insertion index or pane drop.
 * 3. Notifies subscribers on every pointer movement for smooth 60fps ghost & insertion line rendering.
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
const listeners = new Set<DragListener>();

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
    currentState = {
      ...info,
      targetPane: info.sourcePane,
      targetIndex: info.fromIndex,
    };
    (window as any).__rustscpDraggingTab = currentState;
    listeners.forEach((fn) => fn(currentState));
  },

  updatePointer(cursorX: number, cursorY: number, targetPane?: 'left' | 'right' | null, targetIndex?: number | null) {
    if (!currentState) return;

    let derivedPane = targetPane;
    if (derivedPane === undefined) {
      // Calculate from split ratio if not explicitly specified
      const ratioStr = localStorage.getItem('rustscp_commander_split_ratio') || '50';
      const ratio = Math.min(Math.max(parseFloat(ratioStr) || 50, 20), 80) / 100;
      const splitX = window.innerWidth * ratio;
      derivedPane = cursorX < splitX ? 'left' : 'right';
    }

    currentState = {
      ...currentState,
      cursorX,
      cursorY,
      targetPane: derivedPane ?? currentState.targetPane,
      targetIndex: targetIndex !== undefined ? targetIndex : currentState.targetIndex,
    };
    (window as any).__rustscpDraggingTab = currentState;
    listeners.forEach((fn) => fn(currentState));
  },

  setHoverTarget(targetPane: 'left' | 'right' | null, targetIndex: number | null = null) {
    if (!currentState) return;
    currentState = {
      ...currentState,
      targetPane,
      targetIndex,
    };
    (window as any).__rustscpDraggingTab = currentState;
    listeners.forEach((fn) => fn(currentState));
  },

  finishDrag(): boolean {
    if (!currentState) return false;

    const { sessionId, sourcePane, fromIndex, targetPane, targetIndex, cursorX } = currentState;
    console.log('[tabDragManager finishDrag]', { sessionId, sourcePane, fromIndex, targetPane, targetIndex, cursorX });

    let finalTargetPane = targetPane;
    if (!finalTargetPane) {
      const ratioStr = localStorage.getItem('rustscp_commander_split_ratio') || '50';
      const ratio = Math.min(Math.max(parseFloat(ratioStr) || 50, 20), 80) / 100;
      const splitX = window.innerWidth * ratio;
      finalTargetPane = cursorX < splitX ? 'left' : 'right';
    }

    let executed = false;

    if (finalTargetPane === sourcePane) {
      // Reorder within the same pane
      if (targetIndex !== null && targetIndex !== undefined && targetIndex !== fromIndex) {
        if (reorderHandler) {
          console.log('[tabDragManager] Reordering within pane:', { pane: sourcePane, fromIndex, targetIndex });
          reorderHandler(sourcePane, fromIndex, targetIndex);
          executed = true;
        }
      }
    } else {
      // Cross-pane transfer
      if (moveHandler) {
        console.log('[tabDragManager] Moving across panes:', { sessionId, sourcePane, targetPane: finalTargetPane, targetIndex });
        moveHandler(sessionId, sourcePane, finalTargetPane, targetIndex ?? undefined);
        executed = true;
      }
    }

    this.cancelDrag();
    return executed;
  },

  cancelDrag() {
    currentState = null;
    (window as any).__rustscpDraggingTab = null;
    listeners.forEach((fn) => fn(null));
  },

  registerMoveHandler(fn: TabMoveCallback) {
    moveHandler = fn;
  },

  registerReorderHandler(fn: TabReorderCallback) {
    reorderHandler = fn;
  },

  clearHoverTarget(pane: 'left' | 'right') {
    if (currentState && currentState.targetPane === pane) {
      currentState.targetPane = null;
      (window as any).__rustscpDraggingTab = currentState;
      listeners.forEach((fn) => fn(currentState));
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
