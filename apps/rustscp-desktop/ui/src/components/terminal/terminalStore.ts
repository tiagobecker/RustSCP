/**
 * State of the built-in terminals, shared by the dock, the header badge and App.
 *
 * Terminals run in the backend and keep running while the dock is hidden. This store
 * receives their output as it arrives (Tauri events), hands it to the xterm view of each
 * terminal, and tells the user (a toast with a "Show" button, a badge on the tab) when a
 * command finishes, fails or waits for an answer while its terminal is out of sight.
 */
import { useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import i18n from '../../i18n.ts';
import { notify } from '../ui/toast.tsx';
import { WAITING_FOR_INPUT } from './commandCatalog.ts';
import { loadTerminalSettings, saveTerminalSettings, TerminalSettings } from './terminalSettings.ts';

export type TermStatus = 'connecting' | 'running' | 'exited' | 'lost' | 'failed';

export interface FinishedCommand {
  command: string | null;
  exitCode: number;
  durationMs: number | null;
  cwd: string | null;
  outputTail: string;
  at: number;
}

export interface TermTab {
  id: string;
  sessionId: string;
  title: string;
  host: string;
  username: string;
  siteKey: string;
  startPath: string;
  status: TermStatus;
  exitCode: number | null;
  error: string | null;
  cwd: string | null;
  /** bash prompt hook active: commands are reported (history, notifications). */
  integration: boolean;
  busy: boolean;
  busySince: number | null;
  last: FinishedCommand | null;
  /** Output arrived while the user was not looking. */
  unread: boolean;
  attention: 'done' | 'failed' | 'input' | 'ended' | null;
}

export interface TerminalInfo {
  id: string;
  session_id: string;
  title: string;
  host: string;
  username: string;
  site_key: string;
  status: 'connecting' | 'running' | 'exited' | 'lost';
  exit_code: number | null;
  error: string | null;
  cwd: string | null;
  integration: boolean;
  busy: boolean;
  created_at: string;
}

export interface HistoryEntry {
  id: string;
  command: string;
  site_key: string;
  site_name: string;
  cwd: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  finished_at: string;
}

interface State {
  tabs: TermTab[];
  activeId: string | null;
  open: boolean;
  height: number;
  maximized: boolean;
  side: 'none' | 'shortcuts' | 'history';
  settings: TerminalSettings;
  /** Bumped when the local history changed. */
  historyVersion: number;
}

export interface TerminalView {
  write: (data: string) => void;
}

const DOCK_KEY = 'rustscp_terminal_dock';
const DEFAULT_HEIGHT = 320;

function loadDock(): Pick<State, 'height' | 'side'> {
  try {
    const raw = JSON.parse(localStorage.getItem(DOCK_KEY) || '{}');
    const height = Number(raw.height);
    const side = raw.side === 'shortcuts' || raw.side === 'history' ? raw.side : 'none';
    return { height: Number.isFinite(height) && height >= 160 ? height : DEFAULT_HEIGHT, side };
  } catch {
    return { height: DEFAULT_HEIGHT, side: 'none' };
  }
}

let state: State = {
  tabs: [],
  activeId: null,
  open: false,
  maximized: false,
  ...loadDock(),
  settings: loadTerminalSettings(),
  historyVersion: 0,
};
const listeners = new Set<() => void>();

function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  if ('height' in next || 'side' in next) {
    try {
      localStorage.setItem(DOCK_KEY, JSON.stringify({ height: state.height, side: state.side }));
    } catch {
      /* storage unavailable */
    }
  }
  listeners.forEach((l) => l());
}

function updateTab(id: string, patch: Partial<TermTab> | ((t: TermTab) => Partial<TermTab>)) {
  setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)),
  }));
}

const tabById = (id: string) => state.tabs.find((t) => t.id === id);
const isPt = () => (i18n.language || '').startsWith('pt');
const tr = (pt: string, en: string) => (isPt() ? pt : en);

export function errText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && 'message' in (err as any)) return String((err as any).message);
  return String(err);
}

/** Backend call; in a plain browser (UI preview) a simulated shell answers instead. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args);
  const dev = await import('./terminalDevShell.ts');
  return dev.devCall<T>(cmd, args, dispatchTerminalEvent);
}

export function formatDuration(ms: number | null | undefined, pt = isPt()): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return pt ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// ---------------------------------------------------------------------------
// Output routing
// ---------------------------------------------------------------------------

const views = new Map<string, TerminalView>();
/** Output that arrived before the terminal's view was ready (with its event number). */
const pending = new Map<string, Array<{ seq: number; data: string }>>();
/** Terminals whose view was shown at least once: a new view of them redraws from the backend. */
const viewedOnce = new Set<string>();
/** Views waiting for that redraw; output meanwhile is queued. */
const restoring = new Set<string>();
/** Last output event shown per terminal (events at or below it are already on screen). */
const lastSeq = new Map<string, number>();
/** Events of terminals this window does not know yet (restored after a reload). */
const orphans = new Map<string, Array<{ seq: number; data: string }>>();
/** Plain text of each terminal's latest output, to spot a question waiting for an answer. */
const recentText = new Map<string, string>();
const waitTimers = new Map<string, ReturnType<typeof setTimeout>>();
const waitNotified = new Set<string>();

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+][0-9A-Za-z]|\x1b[=>78DEHM]|\r/g;

function deliver(id: string, data: string, seq = lastSeq.get(id) ?? 0) {
  const view = views.get(id);
  if (view && !restoring.has(id)) view.write(data);
  else {
    const list = pending.get(id) ?? [];
    list.push({ seq, data });
    pending.set(id, list);
  }
}

function flushPending(id: string, view: TerminalView, after = -1) {
  const queued = pending.get(id) ?? [];
  pending.delete(id);
  for (const p of queued) if (p.seq > after) view.write(p.data);
}

export function registerView(id: string, view: TerminalView): () => void {
  views.set(id, view);
  const remount = viewedOnce.has(id);
  viewedOnce.add(id);
  if (remount && isTauri()) {
    // A view created again (after an error, say) starts blank: redraw what the backend kept.
    restoring.add(id);
    call<{ data: string; seq: number }>('terminal_snapshot', { id })
      .then((snap) => {
        if (views.get(id) !== view) return;
        restoring.delete(id);
        view.write(snap.data);
        flushPending(id, view, snap.seq);
      })
      .catch(() => {
        restoring.delete(id);
        if (views.get(id) === view) flushPending(id, view);
      });
  } else {
    flushPending(id, view);
  }
  return () => {
    if (views.get(id) === view) views.delete(id);
  };
}

export function isVisible(id: string) {
  return (
    state.open &&
    state.activeId === id &&
    typeof document !== 'undefined' &&
    !document.hidden &&
    document.hasFocus()
  );
}

/** The dock shows this terminal (the app window itself may be in the background). */
const shownInApp = (id: string) => state.open && state.activeId === id;

function showTerminal(id: string) {
  setState({ open: true, activeId: id });
  markSeen(id);
}

export function markSeen(id: string) {
  const t = tabById(id);
  if (t && (t.unread || t.attention)) updateTab(id, { unread: false, attention: null });
}

function watchForQuestion(id: string, data: string) {
  const text = ((recentText.get(id) ?? '') + data.replace(ANSI_RE, '')).slice(-400);
  recentText.set(id, text);
  const old = waitTimers.get(id);
  if (old) clearTimeout(old);
  if (shownInApp(id) || waitNotified.has(id) || !WAITING_FOR_INPUT.test(text)) return;
  // Only once the program has gone quiet: the question is still the last thing on screen.
  waitTimers.set(
    id,
    setTimeout(() => {
      waitTimers.delete(id);
      const t = tabById(id);
      const now = recentText.get(id) ?? '';
      if (!t || shownInApp(id) || waitNotified.has(id) || !WAITING_FOR_INPUT.test(now)) return;
      waitNotified.add(id);
      updateTab(id, { attention: 'input' });
      const lastLine = now.trimEnd().split('\n').pop()?.trim() ?? '';
      notify.warning(tr(`Aguardando sua resposta · ${t.title}`, `Waiting for your answer · ${t.title}`), lastLine.slice(0, 160), {
        sticky: true,
        action: { label: tr('Responder', 'Answer'), onClick: () => showTerminal(id) },
      });
    }, 1200)
  );
}

/** A question already on screen counts once its terminal goes out of sight. */
function recheckQuestions() {
  for (const t of state.tabs) if (!shownInApp(t.id) && recentText.has(t.id)) watchForQuestion(t.id, '');
}

// ---------------------------------------------------------------------------
// Backend events
// ---------------------------------------------------------------------------

interface OutputPayload {
  id: string;
  seq: number;
  data: string;
}
interface ExitPayload {
  id: string;
  exit_code: number | null;
  error: string | null;
}
interface CommandPayload {
  id: string;
  command: string | null;
  exit_code: number;
  duration_ms: number | null;
  cwd: string | null;
  output_tail: string;
}
interface StatePayload {
  id: string;
  busy: boolean;
  integration: boolean;
  cwd: string | null;
}

function onOutput(p: OutputPayload) {
  const t = tabById(p.id);
  if (!t) {
    const list = orphans.get(p.id) ?? [];
    list.push({ seq: p.seq, data: p.data });
    if (list.length > 2000) list.shift();
    orphans.set(p.id, list);
    return;
  }
  if (p.seq <= (lastSeq.get(p.id) ?? 0)) return;
  lastSeq.set(p.id, p.seq);
  deliver(p.id, p.data, p.seq);
  if (t.status === 'connecting') updateTab(p.id, { status: 'running' });
  if (!isVisible(p.id) && !t.unread) updateTab(p.id, { unread: true });
  watchForQuestion(p.id, p.data);
}

function onExit(p: ExitPayload) {
  const t = tabById(p.id);
  if (!t) return;
  const lost = !!p.error;
  updateTab(p.id, {
    status: lost ? 'lost' : 'exited',
    exitCode: p.exit_code,
    error: p.error,
    busy: false,
    busySince: null,
    attention: shownInApp(p.id) ? null : 'ended',
  });
  if (!isVisible(p.id)) {
    const action = { label: lost ? tr('Reconectar', 'Reconnect') : tr('Ver', 'Show'), onClick: () => (lost ? reconnect(p.id) : showTerminal(p.id)) };
    if (lost) notify.error(tr(`Conexão do terminal caiu · ${t.title}`, `Terminal connection lost · ${t.title}`), p.error ?? undefined, { action });
    else notify.info(tr(`Terminal encerrado · ${t.title}`, `Terminal ended · ${t.title}`), undefined, { action });
  }
}

function onCommand(p: CommandPayload) {
  const t = tabById(p.id);
  if (!t) return;
  const finished: FinishedCommand = {
    command: p.command,
    exitCode: p.exit_code,
    durationMs: p.duration_ms,
    cwd: p.cwd,
    outputTail: p.output_tail,
    at: Date.now(),
  };
  waitNotified.delete(p.id);
  recentText.delete(p.id);
  const away = !isVisible(p.id);
  const long = (p.duration_ms ?? 0) >= 10_000;
  // Out of sight in the app, or the app in the background during a long command.
  const tell = (!shownInApp(p.id) && (p.command || (p.duration_ms ?? 0) >= 2000)) || (away && long);
  updateTab(p.id, {
    last: finished,
    busy: false,
    busySince: null,
    attention: tell ? (p.exit_code === 0 ? 'done' : p.exit_code === 130 ? null : 'failed') : t.attention,
  });
  if (p.command && state.settings.keepHistory) setState((s) => ({ historyVersion: s.historyVersion + 1 }));
  if (!tell) return;
  const what = p.command ? `“${p.command.length > 80 ? `${p.command.slice(0, 77)}…` : p.command}”` : tr('O comando', 'The command');
  const took = p.duration_ms != null ? formatDuration(p.duration_ms) : '';
  const action = { label: tr('Ver', 'Show'), onClick: () => showTerminal(p.id) };
  if (p.exit_code === 0) {
    notify.success(
      tr(`Comando concluído · ${t.title}`, `Command finished · ${t.title}`),
      took ? tr(`${what} terminou em ${took}.`, `${what} finished in ${took}.`) : what,
      { action }
    );
  } else if (p.exit_code === 130) {
    notify.info(tr(`Comando interrompido · ${t.title}`, `Command interrupted · ${t.title}`), what, { action });
  } else {
    notify.error(
      tr(`Comando falhou · ${t.title}`, `Command failed · ${t.title}`),
      tr(`${what} terminou com o código ${p.exit_code}.`, `${what} ended with code ${p.exit_code}.`),
      { action, sticky: long }
    );
  }
}

function onState(p: StatePayload) {
  const t = tabById(p.id);
  if (!t) return;
  updateTab(p.id, {
    busy: p.busy,
    busySince: p.busy ? (t.busy ? t.busySince : Date.now()) : null,
    integration: p.integration,
    cwd: p.cwd ?? t.cwd,
  });
}

export function dispatchTerminalEvent(name: string, payload: any) {
  switch (name) {
    case 'terminal-output':
      return onOutput(payload);
    case 'terminal-exit':
      return onExit(payload);
    case 'terminal-command':
      return onCommand(payload);
    case 'terminal-state':
      return onState(payload);
  }
}

function tabFromInfo(info: TerminalInfo, startPath: string): TermTab {
  return {
    id: info.id,
    sessionId: info.session_id,
    title: info.title,
    host: info.host,
    username: info.username,
    siteKey: info.site_key,
    startPath,
    status: info.status,
    exitCode: info.exit_code,
    error: info.error,
    cwd: info.cwd,
    integration: info.integration,
    busy: info.busy,
    busySince: info.busy ? Date.now() : null,
    last: null,
    unread: false,
    attention: null,
  };
}

let initialized = false;

/** Listens to the backend once and brings back terminals that outlived a window reload. */
export async function initTerminalStore() {
  if (initialized) return;
  initialized = true;
  if (isTauri()) {
    for (const name of ['terminal-output', 'terminal-exit', 'terminal-command', 'terminal-state']) {
      await listen(name, (e) => dispatchTerminalEvent(name, e.payload));
    }
  }
  try {
    const existing = await call<TerminalInfo[]>('terminal_list');
    for (const info of existing) {
      if (tabById(info.id)) continue;
      const snap = await call<{ data: string; seq: number }>('terminal_snapshot', { id: info.id }).catch(() => ({ data: '', seq: 0 }));
      setState((s) => ({ tabs: [...s.tabs, tabFromInfo(info, info.cwd ?? '~')], activeId: s.activeId ?? info.id }));
      lastSeq.set(info.id, snap.seq);
      if (snap.data) deliver(info.id, snap.data, snap.seq);
      for (const o of orphans.get(info.id) ?? []) if (o.seq > snap.seq) onOutput({ id: info.id, seq: o.seq, data: o.data });
      orphans.delete(info.id);
    }
  } catch {
    /* no terminals to restore */
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Keystrokes are sent one request at a time, so they reach the shell in order. */
const writeQueues = new Map<string, { text: string; inflight: boolean }>();

async function flushWrites(id: string) {
  const q = writeQueues.get(id);
  if (!q || q.inflight || !q.text) return;
  const data = q.text;
  q.text = '';
  q.inflight = true;
  try {
    await call('terminal_write', { id, data });
  } catch (e) {
    const t = tabById(id);
    if (t && (t.status === 'running' || t.status === 'connecting')) console.warn('terminal write failed', e);
  } finally {
    q.inflight = false;
    if (q.text) void flushWrites(id);
  }
}

export function writeToTerminal(id: string, data: string) {
  const t = tabById(id);
  if (!t || t.status !== 'running') return;
  const q = writeQueues.get(id) ?? { text: '', inflight: false };
  q.text += data;
  writeQueues.set(id, q);
  void flushWrites(id);
}

/** Mouse reports and other raw bytes (one byte per character). */
export function writeBinary(id: string, data: string) {
  void call('terminal_write', { id, data, binary: true }).catch(() => {});
}

export async function runInTerminal(id: string, command: string) {
  const t = tabById(id);
  if (!t) return;
  if (t.status !== 'running') {
    notify.info(tr('O terminal não está conectado', 'The terminal is not connected'), tr('Reconecte-o para rodar comandos.', 'Reconnect it to run commands.'));
    return;
  }
  // Keystrokes typed just before must arrive first.
  const q = writeQueues.get(id);
  while (q && (q.inflight || q.text)) {
    await new Promise((r) => setTimeout(r, 5));
    if (!q.inflight && q.text) void flushWrites(id);
  }
  try {
    await call('terminal_run', { id, command });
    if (!t.integration && state.settings.keepHistory) setState((s) => ({ historyVersion: s.historyVersion + 1 }));
  } catch (e) {
    notify.error(tr('Não foi possível enviar o comando', 'Could not send the command'), errText(e));
  }
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  lastSize = { cols, rows };
  const t = tabById(id);
  if (!t || (t.status !== 'running' && t.status !== 'connecting')) return;
  void call('terminal_resize', { id, cols, rows }).catch(() => {});
}

let lastSize = { cols: 100, rows: 28 };

function newId() {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `t-${rnd}`;
}

export async function openTerminal(opts: { sessionId: string; path: string; title: string; host?: string; username?: string }) {
  const id = newId();
  const tab: TermTab = {
    id,
    sessionId: opts.sessionId,
    title: opts.title,
    host: opts.host ?? '',
    username: opts.username ?? '',
    siteKey: '',
    startPath: opts.path,
    status: 'connecting',
    exitCode: null,
    error: null,
    cwd: null,
    integration: false,
    busy: false,
    busySince: null,
    last: null,
    unread: false,
    attention: null,
  };
  setState((s) => ({ tabs: [...s.tabs, tab], activeId: id, open: true }));
  try {
    const info = await call<TerminalInfo>('terminal_open', {
      id,
      sessionId: opts.sessionId,
      path: opts.path,
      cols: lastSize.cols,
      rows: lastSize.rows,
      keepHistory: state.settings.keepHistory,
    });
    const current = tabById(id);
    if (!current) {
      // Closed while connecting.
      void call('terminal_close', { id }).catch(() => {});
      return;
    }
    updateTab(id, (t) => ({
      title: info.title,
      host: info.host,
      username: info.username,
      siteKey: info.site_key,
      status: t.status === 'connecting' ? (info.status === 'connecting' ? 'running' : info.status) : t.status,
      integration: t.integration || info.integration,
      cwd: t.cwd ?? info.cwd,
    }));
  } catch (e) {
    updateTab(id, { status: 'failed', error: errText(e) });
  }
}

export async function reconnect(id: string) {
  const t = tabById(id);
  if (!t) return;
  updateTab(id, { status: 'connecting', error: null, exitCode: null, attention: null, busy: false, busySince: null });
  setState({ open: true, activeId: id });
  deliver(id, `\r\n\x1b[2m── ${tr('reconectando', 'reconnecting')} ──\x1b[0m\r\n`);
  try {
    if (t.status === 'failed') {
      // The first connection never came up: open it as new under the same tab.
      const info = await call<TerminalInfo>('terminal_open', {
        id,
        sessionId: t.sessionId,
        path: t.startPath,
        cols: lastSize.cols,
        rows: lastSize.rows,
        keepHistory: state.settings.keepHistory,
      });
      updateTab(id, { title: info.title, host: info.host, username: info.username, siteKey: info.site_key, status: 'running' });
    } else {
      await call<TerminalInfo>('terminal_reconnect', { id, cols: lastSize.cols, rows: lastSize.rows });
      updateTab(id, (cur) => ({ status: cur.status === 'connecting' ? 'running' : cur.status }));
    }
  } catch (e) {
    updateTab(id, { status: t.status === 'failed' ? 'failed' : 'lost', error: errText(e) });
  }
}

export function closeTerminal(id: string) {
  void call('terminal_close', { id }).catch(() => {});
  views.delete(id);
  pending.delete(id);
  viewedOnce.delete(id);
  restoring.delete(id);
  lastSeq.delete(id);
  writeQueues.delete(id);
  recentText.delete(id);
  waitNotified.delete(id);
  const timer = waitTimers.get(id);
  if (timer) clearTimeout(timer);
  waitTimers.delete(id);
  setState((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    let activeId = s.activeId;
    if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
    return { tabs, activeId, open: tabs.length > 0 && s.open };
  });
}

export function activateTerminal(id: string) {
  setState({ activeId: id });
  markSeen(id);
  recheckQuestions();
}

export function setDockOpen(open: boolean) {
  setState({ open: open && state.tabs.length > 0 });
  if (open && state.activeId) markSeen(state.activeId);
  else recheckQuestions();
}

export const toggleDock = () => setDockOpen(!state.open);
export const setDockHeight = (height: number) => setState({ height: Math.max(160, Math.round(height)) });
export const setDockMaximized = (maximized: boolean) => setState({ maximized });
export const setSidePanel = (side: State['side']) => setState({ side });

export function updateTerminalSettings(patch: Partial<TerminalSettings>) {
  const settings = { ...state.settings, ...patch };
  saveTerminalSettings(settings);
  setState({ settings });
}

export const bumpHistory = () => setState((s) => ({ historyVersion: s.historyVersion + 1 }));
export const getTerminalState = () => state;

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTerminalStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

/** Header badge: terminals running a command, and terminals that want attention. */
export function useTerminalBadge(): { running: number; attention: boolean; count: number } {
  const tabs = useTerminalStore((s) => s.tabs);
  return {
    count: tabs.length,
    running: tabs.filter((t) => t.busy).length,
    attention: tabs.some((t) => t.attention === 'failed' || t.attention === 'input' || t.attention === 'ended'),
  };
}
