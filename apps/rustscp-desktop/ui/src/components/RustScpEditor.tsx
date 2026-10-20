import React, { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  X,
  Save,
  Check,
  Search,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ExternalLink,
  WrapText,
  Maximize2,
  Minus,
  Plus,
  MoreHorizontal,
  CaseSensitive,
  AlertTriangle,
} from 'lucide-react';
import Prism from 'prismjs';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-go';
// prism-php installs a global after-tokenize hook that calls markup-templating.
// Without this import every Prism.highlight call (for every language) throws.
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';

import { EditorTab } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, IconButton } from './ui/controls.tsx';
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuToggleItem } from './ui/Menu.tsx';
import { notify } from './ui/toast.tsx';
import { plainTextInputProps } from '../utils/inputHardening.ts';

interface RustScpEditorProps {
  isOpen: boolean;
  onClose: () => void;
  initialFile?: {
    name: string;
    path: string;
    content: string;
    isRemote: boolean;
    sessionId: string;
  } | null;
  onSave: (path: string, content: string, sessionId: string) => Promise<void>;
  /** Opens the file in the configured external editor; `sessionId` is the session of the active tab. */
  onOpenExternal?: (path: string, sessionId?: string) => void | Promise<void>;
}

type Eol = 'LF' | 'CRLF' | 'CR';

interface Tab extends EditorTab {
  /** Line ending used when saving (content is always edited with \n). */
  eol: Eol;
  /** Line ending of the last saved / loaded version. */
  originalEol: Eol;
  /** Newer content read from disk/server while this tab had unsaved edits. */
  pendingReload?: string | null;
  /** Set when re-reading a tab kept from an earlier editor session failed. */
  refreshError?: string | null;
}

interface ViewState {
  start: number;
  end: number;
  top: number;
  left: number;
}

const EXT_TO_LANG: Record<string, string> = {
  rs: 'rust',
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  env: 'bash',
  sql: 'sql',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  scss: 'css',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'docker',
  conf: 'ini',
  ini: 'ini',
  cfg: 'ini',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  go: 'go',
  php: 'php',
};

const SUPPORTED_LANGUAGES = [
  { id: 'plain', name: 'Plain Text' },
  { id: 'rust', name: 'Rust' },
  { id: 'python', name: 'Python' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'typescript', name: 'TypeScript' },
  { id: 'jsx', name: 'JSX' },
  { id: 'tsx', name: 'TSX' },
  { id: 'json', name: 'JSON' },
  { id: 'yaml', name: 'YAML' },
  { id: 'toml', name: 'TOML' },
  { id: 'bash', name: 'Bash / Shell' },
  { id: 'sql', name: 'SQL' },
  { id: 'markup', name: 'HTML / XML' },
  { id: 'css', name: 'CSS' },
  { id: 'markdown', name: 'Markdown' },
  { id: 'docker', name: 'Dockerfile' },
  { id: 'ini', name: 'Config / INI' },
  { id: 'c', name: 'C' },
  { id: 'cpp', name: 'C++' },
  { id: 'go', name: 'Go' },
  { id: 'php', name: 'PHP' },
];

/** Above these sizes the editor shows plain text so typing stays responsive. */
const HIGHLIGHT_MAX_CHARS = 300_000;
const HIGHLIGHT_MAX_LINES = 10_000;
/** Up to this size highlighting runs synchronously; larger files highlight in the background. */
const SYNC_HIGHLIGHT_CHARS = 100_000;
/** Programmatic edits up to this size go through the native undo stack. */
const UNDOABLE_EDIT_CHARS = 500_000;
const MAX_MATCHES = 10_000;
const TEXT_PADDING = 12;
const FONT_MIN = 10;
const FONT_MAX = 22;
const FONT_DEFAULT = 13;

const PREF_FONT = 'rustscp_editor_font_size';
const PREF_WRAP = 'rustscp_editor_word_wrap';

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: keep the in-memory value
  }
}

function detectLanguage(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'docker';
  const ext = lower.split('.').pop() || '';
  return EXT_TO_LANG[ext] || 'plain';
}

/** Escapes text for innerHTML. Raw file content must never reach the DOM as markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prism output, or escaped text when the grammar is missing or throws. */
function highlightToHtml(code: string, lang: string): string {
  const grammar = lang && lang !== 'plain' ? Prism.languages[lang] : undefined;
  if (grammar) {
    try {
      return Prism.highlight(code, grammar, lang);
    } catch {
      // fall through to escaped plain text
    }
  }
  return escapeHtml(code);
}

/**
 * Wraps the text ranges [start, start + len) of already-escaped HTML in <mark> elements.
 * Only text runs are wrapped (marks never cross tags), and entities count as one character.
 */
function markMatches(html: string, starts: number[], len: number, current: number): string {
  if (!starts.length || len <= 0) return html;
  const parts: string[] = [];
  const n = html.length;
  let i = 0;
  let copyFrom = 0;
  let offset = 0;
  let r = 0;
  let open = false;
  const flush = (to: number) => {
    if (to > copyFrom) parts.push(html.slice(copyFrom, to));
    copyFrom = to;
  };
  while (i < n) {
    const ch = html.charCodeAt(i);
    if (ch === 60 /* < */) {
      if (open) {
        flush(i);
        parts.push('</mark>');
        open = false;
      }
      const end = html.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    while (r < starts.length && offset >= starts[r] + len) r++;
    if (r >= starts.length) break;
    if (!open && offset >= starts[r]) {
      flush(i);
      parts.push(
        r === current
          ? '<mark data-current="" class="rounded-sm bg-rust-500/40 text-inherit">'
          : '<mark class="rounded-sm bg-rust-500/15 text-inherit">'
      );
      open = true;
    }
    if (ch === 38 /* & */) {
      const semi = html.indexOf(';', i);
      i = semi === -1 ? i + 1 : semi + 1;
    } else {
      i++;
    }
    offset++;
    if (open && offset >= starts[r] + len) {
      flush(i);
      parts.push('</mark>');
      open = false;
      r++;
    }
  }
  flush(n);
  if (open) parts.push('</mark>');
  return parts.join('');
}

function detectEol(text: string): Eol {
  if (text.indexOf('\r') === -1) return 'LF';
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else {
        cr++;
      }
    } else if (c === 10) {
      lf++;
    }
  }
  if (crlf >= lf && crlf >= cr) return 'CRLF';
  if (cr > lf) return 'CR';
  return 'LF';
}

function normalizeEol(text: string): string {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

function applyEol(text: string, eol: Eol): string {
  if (eol === 'LF') return text;
  return text.replace(/\n/g, eol === 'CRLF' ? '\r\n' : '\r');
}

function countLines(text: string): number {
  let n = 1;
  let i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

let tabSeq = 0;

export const RustScpEditor: React.FC<RustScpEditorProps> = ({ isOpen, onClose, initialFile, onSave, onOpenExternal }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || 'en').toLowerCase().startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  // Tabs
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;

  // Appearance (remembered per user)
  const [fontSize, setFontSize] = useState<number>(() => {
    const v = Number(readPref(PREF_FONT));
    return Number.isFinite(v) && v >= FONT_MIN && v <= FONT_MAX ? v : FONT_DEFAULT;
  });
  const [wordWrap, setWordWrap] = useState<boolean>(() => readPref(PREF_WRAP) === 'true');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Find & replace
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [showReplace, setShowReplace] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [replaceTerm, setReplaceTerm] = useState<string>('');
  const [matchCase, setMatchCase] = useState<boolean>(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);
  const [replaceInfo, setReplaceInfo] = useState<string>('');
  /** Bumped to request "scroll the current match into view" after the next commit. */
  const [scrollTick, setScrollTick] = useState<number>(0);

  // Saving / closing
  const [savingTabId, setSavingTabId] = useState<string | null>(null);
  const [savedTabId, setSavedTabId] = useState<string | null>(null);
  const [dirtyTabToClose, setDirtyTabToClose] = useState<string | null>(null);
  const [confirmCloseAll, setConfirmCloseAll] = useState<boolean>(false);
  const [savingAll, setSavingAll] = useState<boolean>(false);

  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  /** Bumped to re-apply the stored caret/scroll of the active tab (e.g. after its content was re-read). */
  const [viewResetKey, setViewResetKey] = useState<number>(0);

  // Refs
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const confirmSaveRef = useRef<HTMLButtonElement>(null);
  const lastFileRef = useRef<RustScpEditorProps['initialFile']>(null);
  const viewStates = useRef(new Map<string, ViewState>());
  const cursorRaf = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchFromRef = useRef<number | null>(null);
  const scrollToMatchRef = useRef(false);
  const focusFindOnOpenRef = useRef(false);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) || tabs[0] || null, [tabs, activeTabId]);
  const activeTabRef = useRef<Tab | null>(activeTab);
  activeTabRef.current = activeTab;

  useEffect(
    () => () => {
      if (cursorRaf.current) cancelAnimationFrame(cursorRaf.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    []
  );

  // ---------------------------------------------------------------------------
  // View state helpers
  // ---------------------------------------------------------------------------
  const syncScroll = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  const scheduleCursorUpdate = () => {
    if (cursorRaf.current) return;
    cursorRaf.current = requestAnimationFrame(() => {
      cursorRaf.current = 0;
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const text = ta.value;
      let line = 1;
      let lastNl = -1;
      let i = text.indexOf('\n');
      while (i !== -1 && i < pos) {
        line++;
        lastNl = i;
        i = text.indexOf('\n', i + 1);
      }
      const col = pos - lastNl;
      setCursor((c) => (c.line === line && c.col === col ? c : { line, col }));
    });
  };

  const rememberViewState = () => {
    const ta = textareaRef.current;
    const current = activeTabRef.current;
    if (!ta || !current) return;
    viewStates.current.set(current.id, {
      start: ta.selectionStart,
      end: ta.selectionEnd,
      top: ta.scrollTop,
      left: ta.scrollLeft,
    });
  };

  const activateTab = (id: string) => {
    if (activeTabRef.current?.id !== id) rememberViewState();
    setActiveTabId(id);
  };

  // Restore caret and scroll position when switching tabs
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const id = activeTab?.id;
    if (!ta || !id) return;
    const v = viewStates.current.get(id);
    const max = ta.value.length;
    if (v) {
      ta.setSelectionRange(Math.min(v.start, max), Math.min(v.end, max));
      ta.scrollTop = v.top;
      ta.scrollLeft = v.left;
    } else {
      ta.setSelectionRange(0, 0);
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    }
    syncScroll();
    scheduleCursorUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, isOpen, viewResetKey]);

  // ---------------------------------------------------------------------------
  // Opening files
  // ---------------------------------------------------------------------------
  /** Shows freshly read content: replaces a clean tab, or offers a reload when the tab has edits. */
  const applyFreshContent = (id: string, raw: string) => {
    const eol = detectEol(raw);
    const fresh = normalizeEol(raw);
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (fresh === t.initialContent && eol === t.originalEol) return t.refreshError ? { ...t, refreshError: null } : t;
        if (t.isDirty) return { ...t, pendingReload: raw, refreshError: null };
        viewStates.current.delete(id);
        return { ...t, content: fresh, initialContent: fresh, eol, originalEol: eol, isDirty: false, pendingReload: null, refreshError: null };
      })
    );
  };

  /** Tabs kept from an earlier editor session are re-read so nobody edits a stale copy. */
  const refreshKeptTab = async (tab: Tab) => {
    try {
      const raw = await invoke<string>('read_file_content', { sessionId: tab.sessionId, path: tab.path });
      if (typeof raw === 'string') applyFreshContent(tab.id, raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Session '.*' not found/i.test(msg)) {
        // The connection is gone (a reconnect gets a new session id): drop the clean tab.
        setTabs((prev) => prev.filter((t) => t.id !== tab.id || t.isDirty));
      } else {
        const friendly = msg.includes('RUSTSCP_E_TOO_LARGE')
          ? tr('O arquivo ficou grande demais para o editor integrado.', 'The file is now too large for the built-in editor.')
          : msg.includes('RUSTSCP_E_BINARY')
          ? tr('O arquivo não parece mais ser texto.', 'The file no longer looks like text.')
          : msg;
        updateTab(tab.id, () => ({ refreshError: friendly }));
      }
    }
  };

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const opening = initialFile;
      tabsRef.current
        .filter((t) => !(opening && t.path === opening.path && t.sessionId === opening.sessionId))
        .forEach((t) => void refreshKeptTab(t));
    }
    wasOpenRef.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      lastFileRef.current = null;
      return;
    }
    if (!initialFile || initialFile === lastFileRef.current) return;
    lastFileRef.current = initialFile;

    const raw = typeof initialFile.content === 'string' ? initialFile.content : String(initialFile.content ?? '');
    const eol = detectEol(raw);
    const fresh = normalizeEol(raw);
    const prev = tabsRef.current;
    const existing = prev.find((t) => t.path === initialFile.path && t.sessionId === initialFile.sessionId);

    if (existing) {
      applyFreshContent(existing.id, raw);
      activateTab(existing.id);
      setViewResetKey((k) => k + 1);
      return;
    }

    const tab: Tab = {
      id: `${initialFile.sessionId}:${initialFile.path}:${Date.now()}:${++tabSeq}`,
      name: initialFile.name,
      path: initialFile.path,
      content: fresh,
      initialContent: fresh,
      isDirty: false,
      isRemote: initialFile.isRemote,
      sessionId: initialFile.sessionId,
      language: detectLanguage(initialFile.name),
      cursorLine: 1,
      cursorCol: 1,
      eol,
      originalEol: eol,
      pendingReload: null,
      refreshError: null,
    };
    setTabs([...prev, tab]);
    activateTab(tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile, isOpen]);

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------
  const updateTab = (id: string, patch: (t: Tab) => Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch(t) } : t)));
  };

  const handleContentChange = (newVal: string) => {
    const tab = activeTabRef.current;
    if (!tab) return;
    updateTab(tab.id, (t) => ({ content: newVal, isDirty: newVal !== t.initialContent || t.eol !== t.originalEol }));
  };

  /**
   * Replaces [start, end) through the native undo stack when possible, falling back to a
   * state update. `select` is the selection to apply afterwards; `keepScroll` restores the
   * scroll position (used by Replace all, which rewrites the whole text).
   */
  const replaceRange = (start: number, end: number, text: string, select?: [number, number], keepScroll = false) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const before = ta.value;
    const scroll = { top: ta.scrollTop, left: ta.scrollLeft };
    // Replacing from the find bar keeps focus there, so Enter keeps replacing instead of typing
    const prevFocus = document.activeElement instanceof HTMLElement && document.activeElement !== ta ? document.activeElement : null;
    const restoreScroll = (el: HTMLTextAreaElement) => {
      if (!keepScroll) return;
      el.scrollTop = scroll.top;
      el.scrollLeft = scroll.left;
      syncScroll();
    };
    const expected = before.slice(0, start) + text + before.slice(end);
    let applied = false;
    if (before.length <= UNDOABLE_EDIT_CHARS && text.length <= UNDOABLE_EDIT_CHARS) {
      try {
        ta.focus();
        ta.setSelectionRange(start, end);
        applied = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
      } catch {
        applied = false;
      }
    }
    const [selStart, selEnd] = select ?? [start + text.length, start + text.length];
    if (applied && ta.value === expected) {
      ta.setSelectionRange(selStart, selEnd);
      restoreScroll(ta);
      prevFocus?.focus();
    } else {
      handleContentChange(expected);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        if (!prevFocus) el.focus();
        el.setSelectionRange(selStart, selEnd);
        restoreScroll(el);
      });
    }
    scheduleCursorUpdate();
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const value = ta.value;
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    const multiLine = value.slice(s, en).includes('\n');

    if (!e.shiftKey && !multiLine) {
      replaceRange(s, en, '  ');
      return;
    }

    // Indent / dedent every line touched by the selection
    const blockStart = value.lastIndexOf('\n', s - 1) + 1;
    const lastChar = multiLine && en > s && value[en - 1] === '\n' ? en - 1 : en;
    const lineEnd = value.indexOf('\n', lastChar);
    const blockEnd = lineEnd === -1 ? value.length : lineEnd;
    const block = value.slice(blockStart, blockEnd);
    const lines = block.split('\n');
    const newBlock = e.shiftKey ? lines.map((l) => l.replace(/^(?: {1,2}|\t)/, '')).join('\n') : lines.map((l) => `  ${l}`).join('\n');
    if (newBlock === block) return;
    if (multiLine) {
      replaceRange(blockStart, blockEnd, newBlock, [blockStart, blockStart + newBlock.length]);
    } else {
      const removed = lines[0].length - newBlock.length;
      const caret = Math.max(blockStart, s - removed);
      replaceRange(blockStart, blockEnd, newBlock, [caret, caret]);
    }
  };

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------
  const saveTab = async (tab: Tab): Promise<boolean> => {
    const saved = tab.content;
    const eol = tab.eol;
    setSavingTabId(tab.id);
    try {
      await onSave(tab.path, applyEol(saved, eol), tab.sessionId);
      // Only what was actually written counts as saved; keystrokes typed meanwhile stay dirty.
      updateTab(tab.id, (t) => ({
        initialContent: saved,
        originalEol: eol,
        isDirty: t.content !== saved || t.eol !== eol,
        pendingReload: null,
      }));
      setSavedTabId(tab.id);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedTabId(null), 1800);
      return true;
    } catch (err) {
      notify.error(tr(`Não foi possível salvar ${tab.name}`, `Could not save ${tab.name}`), err);
      return false;
    } finally {
      setSavingTabId((cur) => (cur === tab.id ? null : cur));
    }
  };

  const handleSaveActive = async () => {
    const tab = activeTabRef.current;
    if (!tab || savingTabId || !tab.isDirty) return;
    await saveTab(tab);
  };

  // ---------------------------------------------------------------------------
  // Closing
  // ---------------------------------------------------------------------------
  /**
   * Hides the editor. Clean tabs stay open for the next file (they are re-read on reopen).
   * `discardDirty` closes tabs with unsaved edits and drops the edits; `savedIds` are tabs
   * that were just saved (their state update may not have rendered yet).
   */
  const finishClose = (opts: { discardDirty?: boolean; savedIds?: Set<string>; base?: Tab[] } = {}) => {
    const base = opts.base ?? tabsRef.current;
    const isClean = (t: Tab) => !t.isDirty || !!opts.savedIds?.has(t.id);
    if (!opts.discardDirty && base.some((t) => !isClean(t))) {
      setConfirmCloseAll(true);
      return;
    }
    if (opts.discardDirty) {
      base.forEach((t) => {
        if (!isClean(t)) viewStates.current.delete(t.id);
      });
      setTabs((prev) => prev.filter((t) => !t.isDirty || !!opts.savedIds?.has(t.id)));
    }
    rememberViewState();
    setShowSearch(false);
    setShowReplace(false);
    setReplaceInfo('');
    setConfirmCloseAll(false);
    setDirtyTabToClose(null);
    lastFileRef.current = null;
    onClose();
  };

  const requestClose = () => finishClose();

  const forceCloseTab = (id: string) => {
    const prev = tabsRef.current;
    const idx = prev.findIndex((t) => t.id === id);
    const remaining = prev.filter((t) => t.id !== id);
    viewStates.current.delete(id);
    setDirtyTabToClose(null);
    if (remaining.length === 0) {
      tabsRef.current = [];
      setTabs([]);
      finishClose({ base: [] });
      return;
    }
    setTabs(remaining);
    if (activeTabRef.current?.id === id) {
      setActiveTabId(remaining[Math.max(0, Math.min(idx, remaining.length) - 1)]?.id || remaining[0].id);
    }
  };

  const handleCloseTab = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab?.isDirty) {
      setDirtyTabToClose(id);
      return;
    }
    forceCloseTab(id);
  };

  const handleSaveAndCloseTab = async () => {
    const tab = tabsRef.current.find((t) => t.id === dirtyTabToClose);
    if (!tab) {
      setDirtyTabToClose(null);
      return;
    }
    if (await saveTab(tab)) forceCloseTab(tab.id);
  };

  const handleSaveAllAndClose = async () => {
    setSavingAll(true);
    let ok = true;
    const savedIds = new Set<string>();
    for (const tab of tabsRef.current.filter((t) => t.isDirty)) {
      // eslint-disable-next-line no-await-in-loop
      if (await saveTab(tab)) savedIds.add(tab.id);
      else ok = false;
    }
    setSavingAll(false);
    if (ok) finishClose({ savedIds });
    else setConfirmCloseAll(false);
  };

  // ---------------------------------------------------------------------------
  // Find & replace
  // ---------------------------------------------------------------------------
  const content = activeTab?.content ?? '';

  const matches = useMemo(() => {
    if (!showSearch || !searchTerm || !content) return [] as number[];
    const re = new RegExp(escapeRegExp(searchTerm), matchCase ? 'g' : 'gi');
    const out: number[] = [];
    let m: RegExpExecArray | null;
    while (out.length < MAX_MATCHES && (m = re.exec(content)) !== null) {
      out.push(m.index);
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  }, [showSearch, searchTerm, content, matchCase]);

  const matchIdx = matches.length ? Math.min(currentMatchIndex, matches.length - 1) : 0;

  const requestScrollToMatch = () => {
    scrollToMatchRef.current = true;
    setScrollTick((n) => n + 1);
  };

  // A new search starts at the first match
  useEffect(() => {
    setCurrentMatchIndex(0);
    setReplaceInfo('');
    if (showSearch && searchTerm) requestScrollToMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, matchCase, activeTab?.id]);

  // After a replace, continue with the first match after the replaced text
  useEffect(() => {
    if (searchFromRef.current === null) return;
    const from = searchFromRef.current;
    searchFromRef.current = null;
    if (!matches.length) return;
    const next = matches.findIndex((p) => p >= from);
    setCurrentMatchIndex(next === -1 ? 0 : next);
  }, [matches]);

  const selectMatchInTextarea = (idx: number) => {
    const ta = textareaRef.current;
    const pos = matches[idx];
    if (!ta || pos === undefined) return;
    ta.focus();
    ta.setSelectionRange(pos, pos + searchTerm.length);
    scheduleCursorUpdate();
  };

  const stepMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = (matchIdx + dir + matches.length) % matches.length;
    setCurrentMatchIndex(next);
    if (highlightOnRef.current) {
      requestScrollToMatch();
    } else {
      selectMatchInTextarea(next);
    }
  };

  const openFind = () => {
    const ta = textareaRef.current;
    if (ta && document.activeElement === ta && ta.selectionEnd > ta.selectionStart) {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel.length <= 200 && !sel.includes('\n')) setSearchTerm(sel);
    }
    if (findInputRef.current) {
      findInputRef.current.focus();
      findInputRef.current.select();
    } else {
      focusFindOnOpenRef.current = true;
      setShowSearch(true);
    }
  };

  // Focus the find field as soon as the bar is rendered (before any further keystroke lands)
  useLayoutEffect(() => {
    if (!showSearch || !focusFindOnOpenRef.current) return;
    focusFindOnOpenRef.current = false;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [showSearch]);

  const closeFind = () => {
    const pos = matches[matchIdx];
    setShowSearch(false);
    setReplaceInfo('');
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    if (pos !== undefined) ta.setSelectionRange(pos, pos + searchTerm.length);
    scheduleCursorUpdate();
  };

  const handleReplaceCurrent = () => {
    if (!activeTab || !matches.length) return;
    const pos = matches[matchIdx];
    if (pos === undefined) return;
    replaceRange(pos, pos + searchTerm.length, replaceTerm);
    searchFromRef.current = pos + replaceTerm.length;
  };

  const handleReplaceAll = () => {
    if (!searchTerm || !activeTab || !matches.length) return;
    const re = new RegExp(escapeRegExp(searchTerm), matchCase ? 'g' : 'gi');
    let count = 0;
    // Function replacer: `$&`, `$$`, `$'` in the replacement are literal text
    const next = content.replace(re, () => {
      count++;
      return replaceTerm;
    });
    if (next === content) return;
    const caret = Math.min(textareaRef.current?.selectionStart ?? 0, next.length);
    replaceRange(0, content.length, next, [caret, caret], true);
    setReplaceInfo(tr(`${count.toLocaleString()} substituídos`, `${count.toLocaleString()} replaced`));
  };

  // ---------------------------------------------------------------------------
  // Rendering data
  // ---------------------------------------------------------------------------
  const deferredContent = useDeferredValue(content);
  const lineCount = useMemo(() => countLines(content), [content]);
  const highlightOn = content.length <= HIGHLIGHT_MAX_CHARS && lineCount <= HIGHLIGHT_MAX_LINES;
  const highlightOnRef = useRef(highlightOn);
  highlightOnRef.current = highlightOn;

  const language = activeTab?.language || 'plain';
  const highlightSource = content.length <= SYNC_HIGHLIGHT_CHARS ? content : deferredContent;
  const baseHtml = useMemo(
    () => (highlightOn && highlightSource.length <= HIGHLIGHT_MAX_CHARS ? highlightToHtml(highlightSource, language) : ''),
    [highlightOn, highlightSource, language]
  );
  const htmlIsCurrent = highlightSource === content;
  const mirrorBase = useMemo(
    () => (!highlightOn ? '' : htmlIsCurrent ? baseHtml : escapeHtml(content)),
    [highlightOn, htmlIsCurrent, baseHtml, content]
  );
  const mirrorHtml = useMemo(
    () => (showSearch && matches.length ? markMatches(mirrorBase, matches, searchTerm.length, matchIdx) : mirrorBase),
    [mirrorBase, showSearch, matches, searchTerm, matchIdx]
  );

  const showGutter = !wordWrap;
  const gutterText = useMemo(() => {
    if (!showGutter) return '';
    const parts = new Array<string>(lineCount);
    for (let i = 0; i < lineCount; i++) parts[i] = String(i + 1);
    return parts.join('\n');
  }, [lineCount, showGutter]);

  const eol = activeTab?.eol ?? 'LF';
  const byteSize = useMemo(() => utf8Length(deferredContent), [deferredContent]) + (eol === 'CRLF' ? lineCount - 1 : 0);

  // Keep the mirror aligned after its content changes
  useLayoutEffect(() => {
    syncScroll();
  }, [mirrorHtml, showGutter, gutterText]);

  // Bring the current match into view without stealing focus from the find field
  useLayoutEffect(() => {
    if (!scrollToMatchRef.current) return;
    scrollToMatchRef.current = false;
    if (!highlightOn) return;
    const ta = textareaRef.current;
    const mark = preRef.current?.querySelector<HTMLElement>('mark[data-current]');
    if (!ta || !mark) return;
    const top = mark.offsetTop;
    const left = mark.offsetLeft;
    if (top < ta.scrollTop + TEXT_PADDING || top + mark.offsetHeight > ta.scrollTop + ta.clientHeight - TEXT_PADDING) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    }
    if (left < ta.scrollLeft || left + mark.offsetWidth > ta.scrollLeft + ta.clientWidth) {
      ta.scrollLeft = Math.max(0, left - ta.clientWidth / 3);
    }
    syncScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTick, mirrorHtml]);

  // Give the dialog an accessible name (the editor has no Modal title bar)
  useEffect(() => {
    const dialog = wrapperRef.current?.closest('[data-ui-modal]');
    if (dialog && activeTab) dialog.setAttribute('aria-label', `${tr('Editor', 'Editor')}: ${activeTab.name}`);
  });

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (only while the editor is the top-most dialog)
  // ---------------------------------------------------------------------------
  const shortcutHandlers = useRef({
    save: () => {},
    find: () => {},
    step: (_dir: 1 | -1) => {},
    escape: () => {},
  });
  shortcutHandlers.current = {
    save: () => void handleSaveActive(),
    find: openFind,
    step: stepMatch,
    escape: () => (showSearch ? closeFind() : requestClose()),
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const root = wrapperRef.current;
      if (!root) return;
      const dialogs = document.querySelectorAll('[data-ui-modal]');
      if (dialogs[dialogs.length - 1] !== root.closest('[data-ui-modal]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && key === 's') {
        e.preventDefault();
        shortcutHandlers.current.save();
      } else if (mod && !e.altKey && key === 'f') {
        e.preventDefault();
        shortcutHandlers.current.find();
      } else if ((mod && key === 'g') || e.key === 'F3') {
        e.preventDefault();
        shortcutHandlers.current.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        shortcutHandlers.current.escape();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  if (!isOpen || !activeTab) return null;

  const lineHeightPx = Math.round(fontSize * 1.55);
  const textStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    lineHeight: `${lineHeightPx}px`,
    whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
    overflowWrap: wordWrap ? 'break-word' : 'normal',
    wordBreak: 'normal',
    tabSize: 4,
    padding: `${TEXT_PADDING}px`,
  };
  const gutterDigits = Math.max(2, String(lineCount).length);
  const isSaving = savingTabId === activeTab.id;
  const justSaved = savedTabId === activeTab.id && !activeTab.isDirty;
  const dirtyTabs = tabs.filter((t) => t.isDirty);
  const tabToClose = dirtyTabToClose ? tabs.find((t) => t.id === dirtyTabToClose) : null;
  const languageName = SUPPORTED_LANGUAGES.find((l) => l.id === activeTab.language)?.name || activeTab.language;

  const setFont = (size: number) => {
    const v = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
    setFontSize(v);
    writePref(PREF_FONT, String(v));
  };

  const toggleWrap = () => {
    setWordWrap((w) => {
      writePref(PREF_WRAP, String(!w));
      return !w;
    });
  };

  const handleOpenExternal = async () => {
    if (!onOpenExternal) return;
    if (activeTab.isDirty) {
      notify.info(
        tr('Alterações não salvas não são incluídas', 'Unsaved changes are not included'),
        tr('O editor externo abre a versão salva do arquivo.', 'The external editor opens the saved version of the file.')
      );
    }
    try {
      await onOpenExternal(activeTab.path, activeTab.sessionId);
    } catch (err) {
      notify.error(tr('Não foi possível abrir o editor externo', 'Could not open the external editor'), err);
    }
  };

  const reloadPending = () => {
    const raw = activeTab.pendingReload;
    if (raw == null) return;
    const nextEol = detectEol(raw);
    const fresh = normalizeEol(raw);
    viewStates.current.delete(activeTab.id);
    updateTab(activeTab.id, () => ({
      content: fresh,
      initialContent: fresh,
      eol: nextEol,
      originalEol: nextEol,
      isDirty: false,
      pendingReload: null,
    }));
  };

  const findCount = matches.length
    ? `${(matchIdx + 1).toLocaleString()}/${matches.length.toLocaleString()}${matches.length >= MAX_MATCHES ? '+' : ''}`
    : searchTerm
    ? tr('Nenhum', 'No results')
    : '';

  const quietSelect =
    'bg-transparent border-0 p-0 pr-0.5 text-[11.5px] text-ink-muted hover:text-ink cursor-pointer appearance-none focus:outline-none focus-visible:ring-2 focus-visible:ring-rust-500/30 rounded';

  return (
    <>
      <Modal
        isOpen
        onClose={requestClose}
        size="full"
        padded={false}
        dismissOnBackdrop={false}
        dismissOnEscape={false}
        initialFocusRef={textareaRef}
        className={isFullscreen ? '!max-w-none !max-h-none !w-screen !h-screen !rounded-none' : ''}
        bodyClassName="!overflow-hidden"
      >
        <div ref={wrapperRef} className="h-full flex flex-col min-h-0 text-ink">
          {/* Tab strip + actions */}
          <div className="flex items-center gap-2 h-11 pl-2 pr-2 border-b border-line shrink-0 select-none">
            <div role="tablist" aria-label={tr('Arquivos abertos', 'Open files')} className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {tabs.map((tab) => {
                const isActive = tab.id === activeTab.id;
                return (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    title={tab.path}
                    onClick={() => activateTab(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        activateTab(tab.id);
                      }
                    }}
                    className={`group flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-md text-[12.5px] cursor-pointer shrink-0 max-w-[220px] transition-colors ${
                      isActive ? 'bg-dark-650 text-ink font-medium' : 'text-ink-muted hover:text-ink hover:bg-dark-650/60'
                    }`}
                  >
                    <span className="truncate">{tab.name}</span>
                    {tab.isDirty && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-rust-500 shrink-0"
                        role="img"
                        aria-label={tr('Alterações não salvas', 'Unsaved changes')}
                        title={tr('Alterações não salvas', 'Unsaved changes')}
                      />
                    )}
                    <button
                      type="button"
                      onClick={(e) => handleCloseTab(tab.id, e)}
                      className="inline-flex items-center justify-center w-5 h-5 rounded text-ink-faint hover:text-ink hover:bg-dark-600/60 shrink-0"
                      aria-label={tr(`Fechar ${tab.name}`, `Close ${tab.name}`)}
                      title={tr('Fechar aba', 'Close tab')}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <IconButton
                size="sm"
                label={`${tr('Localizar e substituir', 'Find and replace')} (${MOD}F)`}
                active={showSearch}
                onClick={() => (showSearch ? closeFind() : openFind())}
              >
                <Search className="w-4 h-4" />
              </IconButton>

              <Menu
                align="right"
                width="w-64"
                trigger={({ open, toggle, ref }) => (
                  <IconButton ref={ref} size="sm" label={tr('Opções de visualização', 'View options')} active={open} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
                    <MoreHorizontal className="w-4 h-4" />
                  </IconButton>
                )}
              >
                {(close) => (
                  <>
                    <MenuLabel>{tr('Tamanho do texto', 'Text size')}</MenuLabel>
                    <div className="flex items-center gap-1 px-2.5 pb-1.5">
                      <IconButton size="sm" label={tr('Diminuir texto', 'Smaller text')} onClick={() => setFont(fontSize - 1)} disabled={fontSize <= FONT_MIN}>
                        <Minus className="w-3.5 h-3.5" />
                      </IconButton>
                      <span className="w-12 text-center text-[12px] tabular-nums text-ink-muted">{fontSize}px</span>
                      <IconButton size="sm" label={tr('Aumentar texto', 'Larger text')} onClick={() => setFont(fontSize + 1)} disabled={fontSize >= FONT_MAX}>
                        <Plus className="w-3.5 h-3.5" />
                      </IconButton>
                      {fontSize !== FONT_DEFAULT && (
                        <button type="button" onClick={() => setFont(FONT_DEFAULT)} className="ml-auto text-[12px] text-ink-muted hover:text-ink">
                          {tr('Padrão', 'Reset')}
                        </button>
                      )}
                    </div>
                    <MenuSeparator />
                    <MenuToggleItem
                      icon={<WrapText className="w-4 h-4" />}
                      label={tr('Quebrar linhas longas', 'Wrap long lines')}
                      checked={wordWrap}
                      onToggle={toggleWrap}
                    />
                    <MenuToggleItem
                      icon={<Maximize2 className="w-4 h-4" />}
                      label={tr('Tela cheia', 'Full screen')}
                      checked={isFullscreen}
                      onToggle={() => setIsFullscreen((f) => !f)}
                    />
                    {wordWrap && (
                      <p className="px-2.5 pb-1.5 text-[11.5px] text-ink-faint leading-snug">
                        {tr('Os números de linha ficam ocultos enquanto as linhas são quebradas.', 'Line numbers are hidden while lines wrap.')}
                      </p>
                    )}
                    {onOpenExternal && (
                      <>
                        <MenuSeparator />
                        <MenuItem
                          icon={<ExternalLink className="w-4 h-4" />}
                          label={tr('Abrir no editor externo', 'Open in external editor')}
                          onSelect={() => void handleOpenExternal()}
                          close={close}
                        />
                      </>
                    )}
                  </>
                )}
              </Menu>

              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleSaveActive()}
                disabled={!activeTab.isDirty && !isSaving}
                loading={isSaving}
                icon={justSaved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                title={`${tr('Salvar', 'Save')} (${MOD}S)`}
              >
                {isSaving ? tr('Salvando…', 'Saving…') : justSaved ? tr('Salvo', 'Saved') : tr('Salvar', 'Save')}
              </Button>

              <IconButton size="sm" label={tr('Fechar editor', 'Close editor')} onClick={requestClose}>
                <X className="w-4 h-4" />
              </IconButton>
            </div>
          </div>

          {/* Path */}
          <div className="flex items-center gap-2 h-8 px-4 border-b border-line shrink-0 text-[12px] select-none">
            <span className="px-1.5 py-0.5 rounded-md bg-dark-650 text-ink-muted text-[11px] font-medium shrink-0">
              {activeTab.isRemote ? tr('Remoto', 'Remote') : tr('Local', 'Local')}
            </span>
            <span className="font-mono text-[11.5px] text-ink-faint truncate select-text" title={activeTab.path}>
              {activeTab.path}
            </span>
            {!highlightOn && (
              <span
                className="ml-auto shrink-0 text-[11.5px] text-ink-faint"
                title={tr(
                  'Arquivos com mais de 300 KB ou 10.000 linhas são mostrados como texto simples para manter a digitação rápida.',
                  'Files over 300 KB or 10,000 lines are shown as plain text to keep typing fast.'
                )}
              >
                {tr('Realce de sintaxe desativado (arquivo grande)', 'Syntax highlighting off (large file)')}
              </span>
            )}
          </div>

          {/* Newer copy read while there were unsaved edits */}
          {activeTab.pendingReload != null && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 border-b border-line bg-amber-500/10 shrink-0 text-[12.5px]" role="status">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="flex-1 min-w-[220px] text-ink">
                {tr(
                  'O arquivo foi lido de novo e é diferente da versão que você está editando. Suas alterações foram mantidas; salvar substitui a versão mais recente.',
                  'The file was read again and differs from the version you are editing. Your changes were kept; saving replaces the newer version.'
                )}
              </span>
              <Button size="sm" variant="secondary" onClick={() => updateTab(activeTab.id, () => ({ pendingReload: null }))}>
                {tr('Manter minhas alterações', 'Keep my changes')}
              </Button>
              <Button size="sm" variant="danger" onClick={reloadPending}>
                {tr('Descartar e recarregar', 'Discard and reload')}
              </Button>
            </div>
          )}

          {activeTab.refreshError && activeTab.pendingReload == null && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 border-b border-line bg-amber-500/10 shrink-0 text-[12.5px]" role="status">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="flex-1 min-w-[220px] text-ink">
                {tr('Não foi possível reler este arquivo; ele pode estar desatualizado.', 'Could not re-read this file; it may be out of date.')}{' '}
                <span className="text-ink-muted">{activeTab.refreshError}</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => void refreshKeptTab(activeTab)}>
                {tr('Tentar de novo', 'Try again')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => updateTab(activeTab.id, () => ({ refreshError: null }))}>
                {tr('Ignorar', 'Dismiss')}
              </Button>
            </div>
          )}

          {/* Find & replace */}
          {showSearch && (
            <div className="flex items-start gap-1.5 px-3 py-2 border-b border-line bg-surface shrink-0 select-none">
              <IconButton
                size="sm"
                label={showReplace ? tr('Ocultar substituir', 'Hide replace') : tr('Mostrar substituir', 'Show replace')}
                onClick={() => setShowReplace((v) => !v)}
                aria-expanded={showReplace}
              >
                <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showReplace ? 'rotate-90' : ''}`} />
              </IconButton>
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="relative w-64 max-w-full">
                    <input
                      ref={findInputRef}
                      type="text"
                      {...plainTextInputProps}
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          stepMatch(e.shiftKey ? -1 : 1);
                        }
                      }}
                      placeholder={tr('Localizar', 'Find')}
                      aria-label={tr('Localizar', 'Find')}
                      className="ui-input h-7 pr-20 text-[12.5px]"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-faint tabular-nums pointer-events-none" aria-live="polite">
                      {findCount}
                    </span>
                  </div>
                  <IconButton size="sm" label={`${tr('Anterior', 'Previous')} (⇧Enter)`} onClick={() => stepMatch(-1)} disabled={!matches.length}>
                    <ChevronUp className="w-4 h-4" />
                  </IconButton>
                  <IconButton size="sm" label={`${tr('Próximo', 'Next')} (Enter)`} onClick={() => stepMatch(1)} disabled={!matches.length}>
                    <ChevronDown className="w-4 h-4" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={tr('Diferenciar maiúsculas/minúsculas', 'Match case')}
                    active={matchCase}
                    onClick={() => setMatchCase((v) => !v)}
                  >
                    <CaseSensitive className="w-4 h-4" />
                  </IconButton>
                  {replaceInfo && <span className="text-[11.5px] text-ink-faint">{replaceInfo}</span>}
                </div>
                {showReplace && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      type="text"
                      {...plainTextInputProps}
                      value={replaceTerm}
                      onChange={(e) => setReplaceTerm(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleReplaceCurrent();
                        }
                      }}
                      placeholder={tr('Substituir por', 'Replace with')}
                      aria-label={tr('Substituir por', 'Replace with')}
                      className="ui-input h-7 w-64 max-w-full text-[12.5px]"
                    />
                    <Button size="sm" variant="secondary" onClick={handleReplaceCurrent} disabled={!matches.length}>
                      {tr('Substituir', 'Replace')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={handleReplaceAll} disabled={!matches.length}>
                      {tr('Substituir tudo', 'Replace all')}
                    </Button>
                  </div>
                )}
              </div>
              <IconButton size="sm" label={tr('Fechar busca (Esc)', 'Close find (Esc)')} onClick={closeFind}>
                <X className="w-3.5 h-3.5" />
              </IconButton>
            </div>
          )}

          {/* Editor body: gutter + highlighted mirror + textarea */}
          <div className="flex-1 min-h-0 flex bg-surface-raised">
            {showGutter && (
              <div
                ref={gutterRef}
                aria-hidden="true"
                className="relative shrink-0 overflow-hidden select-none border-r border-line bg-surface text-ink-faint text-right font-mono"
                style={{ fontSize: `${fontSize}px`, lineHeight: `${lineHeightPx}px`, width: `calc(${gutterDigits}ch + 24px)` }}
              >
                <div className="relative" style={{ paddingTop: TEXT_PADDING, paddingBottom: TEXT_PADDING * 4 }}>
                  <div
                    className="absolute left-0 right-0 pr-3 bg-dark-650 text-ink"
                    style={{ top: TEXT_PADDING + (Math.min(cursor.line, lineCount) - 1) * lineHeightPx, height: lineHeightPx }}
                  >
                    {Math.min(cursor.line, lineCount)}
                  </div>
                  <pre className="m-0 pr-3 pl-2 font-mono whitespace-pre" style={{ font: 'inherit' }}>
                    {gutterText}
                  </pre>
                </div>
              </div>
            )}

            <div className="flex-1 min-w-0 relative">
              {highlightOn && (
                <pre
                  ref={preRef}
                  aria-hidden="true"
                  style={textStyle}
                  className="absolute inset-0 m-0 overflow-scroll pointer-events-none select-none font-mono text-ink bg-transparent [&::-webkit-scrollbar-thumb]:bg-transparent"
                  dangerouslySetInnerHTML={{ __html: `${mirrorHtml}\n` }}
                />
              )}
              <textarea
                ref={textareaRef}
                {...plainTextInputProps}
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                onScroll={syncScroll}
                onSelect={scheduleCursorUpdate}
                onClick={scheduleCursorUpdate}
                onKeyUp={scheduleCursorUpdate}
                onKeyDown={handleTextareaKeyDown}
                wrap={wordWrap ? 'soft' : 'off'}
                aria-label={tr(`Conteúdo de ${activeTab.name}`, `Contents of ${activeTab.name}`)}
                style={{ ...textStyle, caretColor: 'rgb(var(--color-rust-500))' }}
                className={`absolute inset-0 w-full h-full m-0 resize-none bg-transparent focus:outline-none overflow-scroll font-mono ${
                  highlightOn ? 'text-transparent selection:bg-rust-500/25 selection:text-transparent' : 'text-ink selection:bg-rust-500/25'
                }`}
              />
            </div>
          </div>

          {/* Status bar */}
          <div className="flex items-center gap-4 h-7 px-3 border-t border-line shrink-0 text-[11.5px] text-ink-faint select-none">
            <span className="tabular-nums">
              {tr('Ln', 'Ln')} {cursor.line.toLocaleString()}, {tr('Col', 'Col')} {cursor.col.toLocaleString()}
            </span>
            <span className="tabular-nums hidden sm:inline">
              {lineCount.toLocaleString()} {lineCount === 1 ? tr('linha', 'line') : tr('linhas', 'lines')}
            </span>
            <span className="tabular-nums hidden sm:inline">{formatBytes(byteSize)}</span>
            <span className="ml-auto">UTF-8</span>
            <select
              value={activeTab.eol}
              onChange={(e) => {
                const next = e.target.value as Eol;
                updateTab(activeTab.id, (t) => ({ eol: next, isDirty: t.content !== t.initialContent || next !== t.originalEol }));
              }}
              aria-label={tr('Fim de linha', 'Line endings')}
              title={tr('Fim de linha usado ao salvar', 'Line endings used when saving')}
              className={quietSelect}
            >
              <option value="LF">LF</option>
              <option value="CRLF">CRLF</option>
              <option value="CR">CR</option>
            </select>
            <select
              value={activeTab.language}
              onChange={(e) => {
                const next = e.target.value;
                updateTab(activeTab.id, () => ({ language: next }));
              }}
              aria-label={tr('Linguagem', 'Language')}
              title={tr('Linguagem do realce de sintaxe', 'Syntax highlighting language')}
              className={quietSelect}
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.id} value={lang.id}>
                  {lang.name}
                </option>
              ))}
              {!SUPPORTED_LANGUAGES.some((l) => l.id === activeTab.language) && <option value={activeTab.language}>{languageName}</option>}
            </select>
          </div>
        </div>
      </Modal>

      {/* Close one tab with unsaved changes */}
      <Modal
        isOpen={!!tabToClose}
        onClose={() => setDirtyTabToClose(null)}
        size="sm"
        title={tabToClose ? tr(`Salvar as alterações em “${tabToClose.name}”?`, `Save changes to “${tabToClose.name}”?`) : ''}
        initialFocusRef={confirmSaveRef}
        footer={
          <>
            <Button variant="ghost" className="mr-auto text-red-600 dark:text-red-400" onClick={() => tabToClose && forceCloseTab(tabToClose.id)}>
              {tr('Não salvar', 'Don’t save')}
            </Button>
            <Button variant="secondary" onClick={() => setDirtyTabToClose(null)}>
              {tr('Cancelar', 'Cancel')}
            </Button>
            <Button ref={confirmSaveRef} variant="primary" loading={!!tabToClose && savingTabId === tabToClose.id} onClick={() => void handleSaveAndCloseTab()}>
              {tr('Salvar', 'Save')}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">{tr('Se você não salvar, as alterações serão perdidas.', 'Your changes will be lost if you don’t save them.')}</p>
      </Modal>

      {/* Close the editor with unsaved tabs */}
      <Modal
        isOpen={confirmCloseAll && dirtyTabs.length > 0}
        onClose={() => setConfirmCloseAll(false)}
        size="sm"
        title={
          dirtyTabs.length === 1
            ? tr(`Salvar as alterações em “${dirtyTabs[0].name}”?`, `Save changes to “${dirtyTabs[0].name}”?`)
            : tr(`Salvar as alterações em ${dirtyTabs.length} arquivos?`, `Save changes to ${dirtyTabs.length} files?`)
        }
        initialFocusRef={confirmSaveRef}
        footer={
          <>
            <Button variant="ghost" className="mr-auto text-red-600 dark:text-red-400" onClick={() => finishClose({ discardDirty: true })} disabled={savingAll}>
              {tr('Não salvar', 'Don’t save')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmCloseAll(false)} disabled={savingAll}>
              {tr('Cancelar', 'Cancel')}
            </Button>
            <Button ref={confirmSaveRef} variant="primary" loading={savingAll} onClick={() => void handleSaveAllAndClose()}>
              {dirtyTabs.length > 1 ? tr('Salvar tudo', 'Save all') : tr('Salvar', 'Save')}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-[13px] text-ink-muted">{tr('Se você não salvar, as alterações serão perdidas.', 'Your changes will be lost if you don’t save them.')}</p>
          {dirtyTabs.length > 1 && (
            <ul className="text-[12px] font-mono text-ink-muted space-y-0.5 max-h-32 overflow-y-auto">
              {dirtyTabs.map((t) => (
                <li key={t.id} className="truncate" title={t.path}>
                  {t.path}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </>
  );
};
