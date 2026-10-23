import React, { useSyncExternalStore } from 'react';
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** Stays until the user dismisses it */
  sticky?: boolean;
  action?: ToastAction;
}

/** A button on the toast (e.g. "Show"); clicking it also dismisses the toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface NotifyOptions {
  /** Override the auto-dismiss delay (ms) */
  durationMs?: number;
  /** Never auto-dismiss: for notices the user must not miss (e.g. where a file was moved) */
  sticky?: boolean;
  action?: ToastAction;
}

/** Why a toast's countdown is on hold: pointer over it, keyboard focus in it, or the app window not focused */
type HoldReason = 'hover' | 'focus' | 'window';

interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null;
  deadline: number;
  remaining: number;
  holds: Set<HoldReason>;
}

const MAX_TOASTS = 4;
/** Time left on the clock after a hold ends, so the toast does not vanish the instant the pointer leaves */
const MIN_AFTER_HOLD_MS = 2000;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ToastTimer>();

function emit() {
  listeners.forEach((l) => l());
}

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t?.handle) clearTimeout(t.handle);
  timers.delete(id);
}

function dismiss(id: number) {
  clearTimer(id);
  items = items.filter((i) => i.id !== id);
  emit();
}

function startTimer(id: number, t: ToastTimer) {
  t.deadline = Date.now() + t.remaining;
  t.handle = setTimeout(() => dismiss(id), t.remaining);
}

/** Pause a toast's countdown (no-op for sticky toasts) */
function hold(id: number, reason: HoldReason) {
  const t = timers.get(id);
  if (!t) return;
  t.holds.add(reason);
  if (t.handle) {
    clearTimeout(t.handle);
    t.handle = null;
    t.remaining = Math.max(0, t.deadline - Date.now());
  }
}

/** Resume a toast's countdown once nothing holds it any more */
function release(id: number, reason: HoldReason) {
  const t = timers.get(id);
  if (!t) return;
  t.holds.delete(reason);
  if (t.holds.size === 0 && !t.handle) {
    t.remaining = Math.max(t.remaining, MIN_AFTER_HOLD_MS);
    startTimer(id, t);
  }
}

const windowFocused = () => typeof document === 'undefined' || document.hasFocus();

// Toasts raised while the app window is in the background (e.g. during startup) wait for the user to come back
if (typeof window !== 'undefined') {
  window.addEventListener('blur', () => timers.forEach((_, id) => hold(id, 'window')));
  window.addEventListener('focus', () => timers.forEach((_, id) => release(id, 'window')));
}

function defaultDuration(kind: ToastKind, title: string, message?: string): number {
  const base = kind === 'error' ? 8000 : kind === 'warning' ? 6000 : 3500;
  // Longer text gets reading time (~25 characters per second), capped
  const extraChars = Math.max(0, title.length + (message?.length ?? 0) - 60);
  return base + Math.min(10000, extraChars * 40);
}

function push(kind: ToastKind, title: string, message?: string, opts?: NotifyOptions): number {
  const id = nextId++;
  const sticky = !!opts?.sticky;
  // Collapse identical consecutive toasts instead of stacking duplicates
  const dup = items.find((i) => i.kind === kind && i.title === title && i.message === message);
  if (dup) clearTimer(dup.id);
  let next = [...items.filter((i) => i !== dup), { id, kind, title, message, sticky, action: opts?.action }];
  // Over the limit: drop the oldest auto-dismissing toast first, so sticky notices survive a burst
  while (next.length > MAX_TOASTS) {
    const victim = next.find((i) => !i.sticky && i.id !== id) ?? next[0];
    clearTimer(victim.id);
    next = next.filter((i) => i !== victim);
  }
  items = next;
  emit();
  if (!sticky) {
    const t: ToastTimer = {
      handle: null,
      deadline: 0,
      remaining: opts?.durationMs ?? defaultDuration(kind, title, message),
      holds: new Set(),
    };
    timers.set(id, t);
    if (windowFocused()) startTimer(id, t);
    else t.holds.add('window');
  }
  return id;
}

function errorText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && 'message' in (err as any)) return String((err as any).message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Non-blocking notifications that replace window.alert() (which WKWebView may ignore). */
export const notify = {
  success: (title: string, message?: string, opts?: NotifyOptions) => push('success', title, message, opts),
  info: (title: string, message?: string, opts?: NotifyOptions) => push('info', title, message, opts),
  warning: (title: string, message?: string, opts?: NotifyOptions) => push('warning', title, message, opts),
  error: (title: string, err?: unknown, opts?: NotifyOptions) =>
    push('error', title, err === undefined ? undefined : errorText(err), opts),
  dismiss,
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const ICON_COLORS: Record<ToastKind, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-red-600 dark:text-red-400',
  info: 'text-ink-muted',
  warning: 'text-amber-600 dark:text-amber-400',
};

export const Toaster: React.FC = () => {
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  if (list.length === 0) return null;
  return (
    <div
      className="fixed bottom-14 right-4 z-[100] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)] pointer-events-none"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      {list.map((t) => {
        const Icon = ICONS[t.kind];
        // Reading, selecting or tabbing into a toast keeps it on screen (hold/release below)
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto animate-pop ui-card shadow-pop flex items-start gap-2.5 px-3.5 py-3 select-text"
            onMouseEnter={() => hold(t.id, 'hover')}
            onMouseLeave={() => release(t.id, 'hover')}
            onFocus={() => hold(t.id, 'focus')}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release(t.id, 'focus');
            }}
          >
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${ICON_COLORS[t.kind]}`} />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-ink leading-snug">{t.title}</div>
              {t.message && (
                <div className="text-[12px] text-ink-muted mt-0.5 leading-snug break-words whitespace-pre-line max-h-40 overflow-y-auto">
                  {t.message}
                </div>
              )}
              {t.action && (
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm mt-2"
                  onClick={() => {
                    dismiss(t.id);
                    t.action?.onClick();
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="ui-icon-btn ui-icon-btn-sm -mr-1.5 -mt-1 shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
