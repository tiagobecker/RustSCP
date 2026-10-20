import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Save, 
  FileCode, 
  Check, 
  Search, 
  Replace, 
  ChevronDown, 
  ChevronUp, 
  ExternalLink, 
  ZoomIn, 
  ZoomOut, 
  WrapText, 
  Maximize2, 
  Minimize2,
  Code,
  Hash,
  Keyboard
} from 'lucide-react';
import Prism from 'prismjs';
// Base languages & dependencies
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-markup-templating'; // CRITICAL for PHP highlighting
// C-family & Compiled
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-dart';
// Web & Scripting
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-perl';
// Styles & Markup
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-sass';
import 'prismjs/components/prism-less';
import 'prismjs/components/prism-markdown';
// Config, Shell & Data
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-apacheconf';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-diff';

import { EditorTab } from '../types.ts';

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
  onOpenExternal?: (path: string) => Promise<void>;
}

const isMac = typeof navigator !== 'undefined' && (
  /Mac|iPod|iPhone|iPad/.test(navigator.platform || '') ||
  /Macintosh|Mac OS X/.test(navigator.userAgent || '')
);
const saveShortcutLabel = isMac ? '⌘S' : 'Ctrl+S';
const editorFontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const EXT_TO_LANG: Record<string, string> = {
  // PHP
  php: 'php',
  phtml: 'php',
  php3: 'php',
  php4: 'php',
  php5: 'php',
  php7: 'php',
  php8: 'php',
  phps: 'php',
  inc: 'php',
  // Rust & Go
  rs: 'rust',
  go: 'go',
  // Python
  py: 'python',
  pyw: 'python',
  // JavaScript & TypeScript
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  // Java & JVM & Mobile
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  cs: 'csharp',
  csx: 'csharp',
  // C / C++
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  // Ruby, Lua, Perl
  rb: 'ruby',
  erb: 'ruby',
  gemspec: 'ruby',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  // Data & Config
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  conf: 'ini',
  ini: 'ini',
  cfg: 'ini',
  properties: 'ini',
  env: 'bash',
  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  // Web Markup & Styling
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  // Docs & Database
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  // Infrastructure & Servers
  dockerfile: 'docker',
  nginx: 'nginx',
  apacheconf: 'apacheconf',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
};

const SUPPORTED_LANGUAGES = [
  { id: 'plain', name: 'Plain Text' },
  { id: 'php', name: 'PHP' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'typescript', name: 'TypeScript' },
  { id: 'jsx', name: 'React JSX' },
  { id: 'tsx', name: 'React TSX' },
  { id: 'markup', name: 'HTML / XML' },
  { id: 'css', name: 'CSS' },
  { id: 'scss', name: 'SCSS' },
  { id: 'sass', name: 'Sass' },
  { id: 'less', name: 'Less' },
  { id: 'python', name: 'Python' },
  { id: 'rust', name: 'Rust' },
  { id: 'go', name: 'Go' },
  { id: 'c', name: 'C' },
  { id: 'cpp', name: 'C++' },
  { id: 'csharp', name: 'C#' },
  { id: 'java', name: 'Java' },
  { id: 'kotlin', name: 'Kotlin' },
  { id: 'swift', name: 'Swift' },
  { id: 'ruby', name: 'Ruby' },
  { id: 'sql', name: 'SQL' },
  { id: 'bash', name: 'Bash / Shell' },
  { id: 'powershell', name: 'PowerShell' },
  { id: 'json', name: 'JSON' },
  { id: 'yaml', name: 'YAML' },
  { id: 'toml', name: 'TOML' },
  { id: 'ini', name: 'INI / Config' },
  { id: 'docker', name: 'Dockerfile' },
  { id: 'nginx', name: 'Nginx' },
  { id: 'apacheconf', name: 'Apache Config' },
  { id: 'markdown', name: 'Markdown' },
  { id: 'graphql', name: 'GraphQL' },
  { id: 'lua', name: 'Lua' },
  { id: 'dart', name: 'Dart' },
  { id: 'perl', name: 'Perl' },
  { id: 'diff', name: 'Diff / Patch' },
];

function detectLanguage(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'docker';
  if (lower === 'nginx.conf' || lower.endsWith('.nginx') || lower.includes('nginx')) return 'nginx';
  if (lower === '.htaccess' || lower.includes('apache')) return 'apacheconf';
  if (lower === '.env' || lower.startsWith('.env.')) return 'bash';
  const ext = lower.split('.').pop() || '';
  return EXT_TO_LANG[ext] || 'plain';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const RustScpEditor: React.FC<RustScpEditorProps> = ({
  isOpen,
  onClose,
  initialFile,
  onSave,
  onOpenExternal,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  // Multi-tab state
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');

  // Editor appearance state
  const [fontSize, setFontSize] = useState<number>(13);
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Search & Replace state
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [replaceTerm, setReplaceTerm] = useState<string>('');
  const [matchCase, setMatchCase] = useState<boolean>(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);

  // Saving state feedback
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [dirtyTabToClose, setDirtyTabToClose] = useState<string | null>(null);

  // References
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  // Go to Line state
  const [showGoToLine, setShowGoToLine] = useState<boolean>(false);
  const [targetLineInput, setTargetLineInput] = useState<string>('');

  // Keyboard Shortcuts modal state
  const [showShortcutsModal, setShowShortcutsModal] = useState<boolean>(false);

  // Initialize or add tab when initialFile changes
  useEffect(() => {
    if (!initialFile) return;

    setTabs((prev) => {
      const existing = prev.find((t) => t.path === initialFile.path && t.sessionId === initialFile.sessionId);
      if (existing) {
        setActiveTabId(existing.id);
        if (!existing.isDirty) {
          return prev.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  content: initialFile.content,
                  initialContent: initialFile.content,
                  language: detectLanguage(initialFile.name),
                }
              : t
          );
        }
        return prev;
      }
      const newTab: EditorTab = {
        id: `${initialFile.sessionId}:${initialFile.path}:${Date.now()}`,
        name: initialFile.name,
        path: initialFile.path,
        content: initialFile.content,
        initialContent: initialFile.content,
        isDirty: false,
        isRemote: initialFile.isRemote,
        sessionId: initialFile.sessionId,
        language: detectLanguage(initialFile.name),
        cursorLine: 1,
        cursorCol: 1,
      };
      setActiveTabId(newTab.id);
      return [...prev, newTab];
    });
  }, [initialFile]);

  const activeTab = useMemo(() => {
    return tabs.find((t) => t.id === activeTabId) || tabs[0] || null;
  }, [tabs, activeTabId]);

  // Synchronized scrolling between textarea, highlighted mirror, active line marker, and line numbers
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = target.scrollTop;
      preRef.current.scrollLeft = target.scrollLeft;
    }
    if (activeLineRef.current) {
      activeLineRef.current.scrollTop = target.scrollTop;
      activeLineRef.current.scrollLeft = target.scrollLeft;
    }
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = target.scrollTop;
    }
  };

  // Cursor position tracking
  const updateCursorPosition = () => {
    if (!textareaRef.current || !activeTab) return;
    const selStart = textareaRef.current.selectionStart;
    const textBefore = activeTab.content.substring(0, selStart);
    const lines = textBefore.split('\n');
    const lineNum = lines.length;
    const colNum = (lines[lines.length - 1]?.length || 0) + 1;

    setTabs((prev) =>
      prev.map((t) => (t.id === activeTab.id ? { ...t, cursorLine: lineNum, cursorCol: colNum } : t))
    );
  };

  const handleContentChange = (newVal: string) => {
    if (!activeTab) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTab.id
          ? {
              ...t,
              content: newVal,
              isDirty: newVal !== t.initialContent,
            }
          : t
      )
    );
  };

  // Go to line jump
  const handleJumpToLine = (targetLine: number) => {
    if (!textareaRef.current || !activeTab) return;
    const lines = (activeTab.content || '').split('\n');
    const clampedLine = Math.max(1, Math.min(targetLine, lines.length));
    let charPos = 0;
    for (let i = 0; i < clampedLine - 1; i++) {
      charPos += lines[i].length + 1;
    }
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(charPos, charPos);
    const lineHeight = Math.round(fontSize * 1.55);
    textareaRef.current.scrollTop = Math.max(0, (clampedLine - 5) * lineHeight);
    updateCursorPosition();
    setShowGoToLine(false);
  };

  // Toggle Comment (language-aware)
  const handleToggleComment = () => {
    if (!textareaRef.current || !activeTab) return;
    const textarea = textareaRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const content = activeTab.content;
    const lang = activeTab.language;

    let prefix = '// ';
    if (['python', 'bash', 'powershell', 'ruby', 'perl', 'yaml', 'toml', 'ini', 'docker', 'nginx', 'apacheconf'].includes(lang)) {
      prefix = '# ';
    } else if (['sql', 'lua'].includes(lang)) {
      prefix = '-- ';
    }

    const lines = content.split('\n');
    const lineStartIdx = content.substring(0, start).split('\n').length - 1;
    const lineEndIdx = content.substring(0, end).split('\n').length - 1;

    const areAllCommented = lines
      .slice(lineStartIdx, lineEndIdx + 1)
      .filter((l) => l.trim().length > 0)
      .every((l) => l.trimStart().startsWith(prefix.trim()));

    let delta = 0;
    for (let i = lineStartIdx; i <= lineEndIdx; i++) {
      if (areAllCommented) {
        const trimmed = lines[i].trimStart();
        const leadingSpaces = lines[i].substring(0, lines[i].length - trimmed.length);
        if (trimmed.startsWith(prefix)) {
          lines[i] = leadingSpaces + trimmed.substring(prefix.length);
          delta -= prefix.length;
        } else if (trimmed.startsWith(prefix.trim())) {
          lines[i] = leadingSpaces + trimmed.substring(prefix.trim().length);
          delta -= prefix.trim().length;
        }
      } else {
        lines[i] = prefix + lines[i];
        delta += prefix.length;
      }
    }

    const updated = lines.join('\n');
    handleContentChange(updated);
    setTimeout(() => {
      textarea.selectionStart = start;
      textarea.selectionEnd = Math.max(start, end + delta);
    }, 0);
  };

  // Duplicate line or selection
  const handleDuplicateLine = () => {
    if (!textareaRef.current || !activeTab) return;
    const textarea = textareaRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const content = activeTab.content;
    const lines = content.split('\n');
    const lineStartIdx = content.substring(0, start).split('\n').length - 1;
    const lineEndIdx = content.substring(0, end).split('\n').length - 1;

    const targetBlock = lines.slice(lineStartIdx, lineEndIdx + 1).join('\n');
    lines.splice(lineEndIdx + 1, 0, targetBlock);

    const updated = lines.join('\n');
    handleContentChange(updated);
    setTimeout(() => {
      const newStart = start + targetBlock.length + 1;
      textarea.selectionStart = newStart;
      textarea.selectionEnd = newStart + (end - start);
    }, 0);
  };

  // Delete line
  const handleDeleteLine = () => {
    if (!textareaRef.current || !activeTab) return;
    const textarea = textareaRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const content = activeTab.content;
    const lines = content.split('\n');
    const lineStartIdx = content.substring(0, start).split('\n').length - 1;
    const lineEndIdx = content.substring(0, end).split('\n').length - 1;

    lines.splice(lineStartIdx, lineEndIdx - lineStartIdx + 1);
    const updated = lines.join('\n');
    handleContentChange(updated);
    setTimeout(() => {
      const charPos = lines.slice(0, lineStartIdx).join('\n').length + (lineStartIdx > 0 ? 1 : 0);
      textarea.selectionStart = textarea.selectionEnd = Math.min(charPos, updated.length);
    }, 0);
  };

  // Move line up or down
  const handleMoveLine = (direction: 'up' | 'down') => {
    if (!textareaRef.current || !activeTab) return;
    const textarea = textareaRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const content = activeTab.content;
    const lines = content.split('\n');
    const lineStartIdx = content.substring(0, start).split('\n').length - 1;
    const lineEndIdx = content.substring(0, end).split('\n').length - 1;

    if (direction === 'up' && lineStartIdx > 0) {
      const prevLine = lines[lineStartIdx - 1];
      lines.splice(lineStartIdx - 1, 1);
      lines.splice(lineEndIdx, 0, prevLine);
      const updated = lines.join('\n');
      handleContentChange(updated);
      setTimeout(() => {
        textarea.selectionStart = Math.max(0, start - prevLine.length - 1);
        textarea.selectionEnd = Math.max(0, end - prevLine.length - 1);
      }, 0);
    } else if (direction === 'down' && lineEndIdx < lines.length - 1) {
      const nextLine = lines[lineEndIdx + 1];
      lines.splice(lineEndIdx + 1, 1);
      lines.splice(lineStartIdx, 0, nextLine);
      const updated = lines.join('\n');
      handleContentChange(updated);
      setTimeout(() => {
        textarea.selectionStart = start + nextLine.length + 1;
        textarea.selectionEnd = end + nextLine.length + 1;
      }, 0);
    }
  };

  // Keyboard handlers on textarea (Tab indentation, comments, duplicates, navigation)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Multi-line and single-line Tab Indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = activeTab?.content || '';

      if (start !== end) {
        const startLineIdx = val.substring(0, start).split('\n').length - 1;
        const endLineIdx = val.substring(0, end).split('\n').length - 1;
        const lines = val.split('\n');
        let charsChangedBeforeStart = 0;
        let totalCharsChanged = 0;

        for (let i = startLineIdx; i <= endLineIdx; i++) {
          if (e.shiftKey) {
            if (lines[i].startsWith('  ')) {
              lines[i] = lines[i].substring(2);
              totalCharsChanged -= 2;
              if (i === startLineIdx) charsChangedBeforeStart -= 2;
            } else if (lines[i].startsWith(' ')) {
              lines[i] = lines[i].substring(1);
              totalCharsChanged -= 1;
              if (i === startLineIdx) charsChangedBeforeStart -= 1;
            }
          } else {
            lines[i] = '  ' + lines[i];
            totalCharsChanged += 2;
            if (i === startLineIdx) charsChangedBeforeStart += 2;
          }
        }
        const updated = lines.join('\n');
        handleContentChange(updated);
        setTimeout(() => {
          textarea.selectionStart = Math.max(0, start + charsChangedBeforeStart);
          textarea.selectionEnd = Math.max(0, end + totalCharsChanged);
        }, 0);
        return;
      }

      if (e.shiftKey) {
        if (val.substring(start - 2, start) === '  ') {
          const updated = val.substring(0, start - 2) + val.substring(start);
          handleContentChange(updated);
          setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = Math.max(0, start - 2);
          }, 0);
        }
      } else {
        const updated = val.substring(0, start) + '  ' + val.substring(end);
        handleContentChange(updated);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
      return;
    }

    // Toggle Comment (Cmd+/ or Ctrl+/)
    if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.key === ';')) {
      e.preventDefault();
      e.stopPropagation();
      handleToggleComment();
      return;
    }

    // Duplicate line (Cmd+Shift+D or Ctrl+Shift+D)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key.toLowerCase() === 'd')) {
      e.preventDefault();
      e.stopPropagation();
      handleDuplicateLine();
      return;
    }

    // Delete line (Cmd+Shift+K or Ctrl+Shift+K)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      e.stopPropagation();
      handleDeleteLine();
      return;
    }

    // Move line (Alt+Up or Alt+Down)
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      handleMoveLine('up');
      return;
    }
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      handleMoveLine('down');
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      handleSaveActive();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      setShowSearch(true);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      e.stopPropagation();
      setShowGoToLine(true);
      setTargetLineInput(String(activeTab?.cursorLine || 1));
      return;
    }
  };

  const handleSaveActive = async () => {
    if (!activeTab || isSaving) return;
    setIsSaving(true);
    try {
      // 1. Save to remote or local environment
      await onSave(activeTab.path, activeTab.content, activeTab.sessionId);

      // 2. Also send content to system clipboard ("área de transferência")
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(activeTab.content);
        }
      } catch (clipErr) {
        console.warn('[RustScpEditor] System clipboard write skipped:', clipErr);
      }

      setTabs((prev) =>
        prev.map((t) => (t.id === activeTab.id ? { ...t, initialContent: t.content, isDirty: false } : t))
      );
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      alert(`Erro ao salvar: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

  // Global shortcut handling (Command+S on macOS, Ctrl+S on Windows/Linux, Zoom, Go to line, etc.)
  useEffect(() => {
    if (!isOpen) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (isCmdOrCtrl && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        handleSaveActive();
      } else if (isCmdOrCtrl && key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(true);
      } else if (isCmdOrCtrl && key === 'g') {
        e.preventDefault();
        e.stopPropagation();
        setShowGoToLine(true);
        setTargetLineInput(String(activeTab?.cursorLine || 1));
      } else if (isCmdOrCtrl && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setFontSize((s) => Math.min(24, s + 1));
      } else if (isCmdOrCtrl && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        setFontSize((s) => Math.max(10, s - 1));
      } else if (isCmdOrCtrl && e.key === '0') {
        e.preventDefault();
        setFontSize(13);
      } else if (e.altKey && key === 'z') {
        e.preventDefault();
        setWordWrap((w) => !w);
      } else if (e.key === 'Escape') {
        if (showGoToLine) {
          setShowGoToLine(false);
        } else if (showSearch) {
          setShowSearch(false);
        } else if (showShortcutsModal) {
          setShowShortcutsModal(false);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
    };
  }, [isOpen, activeTab, isSaving, showSearch, showGoToLine, showShortcutsModal]);

  const forceCloseTab = (id: string) => {
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) {
      setActiveTabId(remaining[remaining.length - 1]?.id || '');
    }
    if (remaining.length === 0) {
      onClose();
    }
    setDirtyTabToClose(null);
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const tabToClose = tabs.find((t) => t.id === id);
    if (tabToClose?.isDirty) {
      setDirtyTabToClose(id);
      return;
    }
    forceCloseTab(id);
  };

  // Search matches computation
  const matches = useMemo(() => {
    if (!searchTerm || !activeTab?.content) return [];
    const content = activeTab.content;
    const term = matchCase ? searchTerm : searchTerm.toLowerCase();
    const target = matchCase ? content : content.toLowerCase();
    const indices: number[] = [];
    let pos = 0;
    while ((pos = target.indexOf(term, pos)) !== -1) {
      indices.push(pos);
      pos += term.length;
    }
    return indices;
  }, [searchTerm, activeTab?.content, matchCase]);

  const handleNextMatch = () => {
    if (matches.length === 0 || !textareaRef.current) return;
    const nextIdx = (currentMatchIndex + 1) % matches.length;
    setCurrentMatchIndex(nextIdx);
    const pos = matches[nextIdx];
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(pos, pos + searchTerm.length);
  };

  const handlePrevMatch = () => {
    if (matches.length === 0 || !textareaRef.current) return;
    const prevIdx = (currentMatchIndex - 1 + matches.length) % matches.length;
    setCurrentMatchIndex(prevIdx);
    const pos = matches[prevIdx];
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(pos, pos + searchTerm.length);
  };

  const handleReplaceCurrent = () => {
    if (matches.length === 0 || !activeTab) return;
    const pos = matches[currentMatchIndex];
    const before = activeTab.content.substring(0, pos);
    const after = activeTab.content.substring(pos + searchTerm.length);
    handleContentChange(before + replaceTerm + after);
  };

  const handleReplaceAll = () => {
    if (!searchTerm || !activeTab) return;
    const regex = new RegExp(
      searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      matchCase ? 'g' : 'gi'
    );
    const updated = activeTab.content.replace(regex, replaceTerm);
    handleContentChange(updated);
  };

  // Highlighted code rendering
  const highlightedCode = useMemo(() => {
    if (!activeTab) return '';
    const code = activeTab.content;
    const lang = activeTab.language;
    if (lang && lang !== 'plain' && Prism.languages[lang]) {
      try {
        return Prism.highlight(code, Prism.languages[lang], lang);
      } catch (_e) {
        console.warn(`[RustScpEditor] Highlighting failed for language ${lang}:`, _e);
        return escapeHtml(code);
      }
    }
    return escapeHtml(code);
  }, [activeTab?.content, activeTab?.language]);

  if (!isOpen || !activeTab) return null;

  const lines = (activeTab.content || '').split('\n');
  const lineCount = lines.length;

  return (
    <div className={`fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-150`}>
      <div 
        className={`bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl flex flex-col overflow-hidden transition-all text-slate-900 dark:text-slate-100 ${
          isFullscreen ? 'w-full h-full rounded-none' : 'max-w-6xl w-full h-[88vh]'
        }`}
      >
        {/* Editor Titlebar & Tab Bar */}
        <div className="bg-slate-100 dark:bg-dark-750 border-b border-slate-200 dark:border-dark-600 flex items-center justify-between px-2 pt-1.5 select-none shrink-0">
          {/* Tabs */}
          <div className="flex items-center space-x-1 overflow-x-auto max-w-[70%] scrollbar-none">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTab.id;
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  className={`flex items-center space-x-2 px-3 py-1.5 rounded-t-lg text-xs cursor-pointer border-t border-x transition-colors ${
                    isActive
                      ? 'bg-white dark:bg-dark-800 border-slate-300 dark:border-dark-600 text-slate-900 dark:text-slate-100 font-semibold shadow-sm -mb-px'
                      : 'bg-slate-200/70 dark:bg-dark-700/60 border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-dark-700'
                  }`}
                >
                  <FileCode className={`w-3.5 h-3.5 ${tab.isRemote ? 'text-purple-600 dark:text-purple-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
                  <span className="truncate max-w-[140px]">{tab.name}</span>
                  {tab.isDirty && (
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" title="Alterações não salvas" />
                  )}
                  <button
                    onClick={(e) => handleCloseTab(tab.id, e)}
                    className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 ml-1"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Right Header Controls */}
          <div className="flex items-center space-x-1.5 pb-1">
            {onOpenExternal && (
              <button
                onClick={() => onOpenExternal(activeTab.path)}
                title={isPt ? 'Abrir no Editor Externo (VS Code / Configurado)' : 'Open in External Editor'}
                className="flex items-center space-x-1 px-2.5 py-1 rounded bg-white hover:bg-slate-50 dark:bg-dark-700 dark:hover:bg-dark-600 text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100 text-xs border border-slate-300 dark:border-dark-600 transition-colors shadow-sm"
              >
                <ExternalLink className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                <span className="hidden sm:inline">{isPt ? 'Editor Externo' : 'External Editor'}</span>
              </button>
            )}

            <button
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={isFullscreen ? 'Restaurar' : 'Tela Cheia'}
              className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
            >
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>

            <button
              onClick={onClose}
              title={isPt ? 'Fechar Editor' : 'Close Editor'}
              className="p-1.5 rounded hover:bg-red-500/10 dark:hover:bg-red-500/20 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Unsaved Changes Confirmation Banner */}
        {dirtyTabToClose && (
          <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between text-xs text-amber-800 dark:text-amber-200">
            <span>
              {isPt
                ? `O arquivo '${tabs.find((t) => t.id === dirtyTabToClose)?.name}' possui alterações não salvas. Fechar mesmo assim?`
                : `File '${tabs.find((t) => t.id === dirtyTabToClose)?.name}' has unsaved changes. Close anyway?`}
            </span>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => forceCloseTab(dirtyTabToClose)}
                className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-semibold"
              >
                {isPt ? 'Descartar e Fechar' : 'Discard & Close'}
              </button>
              <button
                onClick={() => setDirtyTabToClose(null)}
                className="px-2 py-0.5 rounded bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 text-xs"
              >
                {isPt ? 'Cancelar' : 'Cancel'}
              </button>
            </div>
          </div>
        )}

        {/* Secondary Toolbar (Controls, Search, Language, Save) */}
        <div className="bg-slate-50 dark:bg-dark-800 border-b border-slate-200 dark:border-dark-600 px-3 py-1.5 flex items-center justify-between gap-2 text-xs shrink-0 select-none">
          {/* Path & Status Info */}
          <div className="flex items-center space-x-2 truncate">
            <span className="text-[11px] font-mono text-slate-600 dark:text-slate-400 truncate max-w-md" title={activeTab.path}>
              {activeTab.path}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
              activeTab.isRemote 
                ? 'bg-purple-500/10 border-purple-500/30 text-purple-700 dark:text-purple-300' 
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
            }`}>
              {activeTab.isRemote ? 'Remoto' : 'Local'}
            </span>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center space-x-1.5">
            {/* Search Toggle */}
            <button
              onClick={() => setShowSearch(!showSearch)}
              title={isPt ? `Localizar e Substituir (${isMac ? '⌘F' : 'Ctrl+F'})` : `Find & Replace (${isMac ? '⌘F' : 'Ctrl+F'})`}
              className={`p-1.5 rounded border transition-colors ${
                showSearch
                  ? 'bg-sky-500/20 border-sky-500/40 text-sky-700 dark:text-sky-300'
                  : 'bg-white dark:bg-dark-700/60 border-slate-300 dark:border-dark-600 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Search className="w-3.5 h-3.5" />
            </button>

            {/* Go to Line */}
            <button
              onClick={() => {
                setShowGoToLine(!showGoToLine);
                setTargetLineInput(String(activeTab.cursorLine));
              }}
              title={isPt ? `Ir para a Linha (${isMac ? '⌘G' : 'Ctrl+G'})` : `Go to Line (${isMac ? '⌘G' : 'Ctrl+G'})`}
              className={`p-1.5 rounded border transition-colors ${
                showGoToLine
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300'
                  : 'bg-white dark:bg-dark-700/60 border-slate-300 dark:border-dark-600 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Hash className="w-3.5 h-3.5" />
            </button>

            {/* Word Wrap Toggle */}
            <button
              onClick={() => setWordWrap(!wordWrap)}
              title={isPt ? `Quebra de Linha Suave (${isMac ? '⌥Z' : 'Alt+Z'})` : `Toggle Word Wrap (${isMac ? '⌥Z' : 'Alt+Z'})`}
              className={`p-1.5 rounded border transition-colors ${
                wordWrap
                  ? 'bg-rust-500/20 border-rust-500/40 text-rust-700 dark:text-rust-400'
                  : 'bg-white dark:bg-dark-700/60 border-slate-300 dark:border-dark-600 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <WrapText className="w-3.5 h-3.5" />
            </button>

            {/* Keyboard Shortcuts Cheatsheet */}
            <button
              onClick={() => setShowShortcutsModal(true)}
              title={isPt ? 'Atalhos de Teclado do Editor' : 'Editor Keyboard Shortcuts'}
              className="p-1.5 rounded border transition-colors bg-white dark:bg-dark-700/60 border-slate-300 dark:border-dark-600 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            >
              <Keyboard className="w-3.5 h-3.5" />
            </button>

            {/* Font Size Zoom Controls */}
            <div className="flex items-center bg-white dark:bg-dark-700/60 border border-slate-300 dark:border-dark-600 rounded">
              <button
                onClick={() => setFontSize((s) => Math.max(10, s - 1))}
                title={isPt ? 'Diminuir Fonte' : 'Decrease Font'}
                className="p-1 hover:bg-slate-100 dark:hover:bg-dark-600 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] font-mono px-1.5 text-slate-700 dark:text-slate-300">{fontSize}px</span>
              <button
                onClick={() => setFontSize((s) => Math.min(22, s + 1))}
                title={isPt ? 'Aumentar Fonte' : 'Increase Font'}
                className="p-1 hover:bg-slate-100 dark:hover:bg-dark-600 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Language Selector */}
            <div className="relative">
              <select
                value={activeTab.language}
                onChange={(e) => {
                  const newLang = e.target.value;
                  setTabs((prev) =>
                    prev.map((t) => (t.id === activeTab.id ? { ...t, language: newLang } : t))
                  );
                }}
                className="bg-white dark:bg-dark-700/60 border border-slate-300 dark:border-dark-600 rounded px-2 py-1 text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:border-rust-500 shadow-sm"
              >
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <option key={lang.id} value={lang.id} className="bg-white dark:bg-dark-800 text-slate-900 dark:text-slate-100">
                    {lang.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Save Button */}
            <button
              onClick={handleSaveActive}
              disabled={isSaving || !activeTab.isDirty}
              title={isPt ? `Salvar arquivo (${saveShortcutLabel}) e enviar para área de transferência` : `Save file (${saveShortcutLabel}) and copy to clipboard`}
              className="flex items-center space-x-1.5 px-3 py-1 rounded bg-rust-600 hover:bg-rust-500 disabled:opacity-40 text-white font-semibold transition-all shadow-sm border border-rust-500/40"
            >
              {saveSuccess ? (
                <Check className="w-3.5 h-3.5 text-white" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>
                {saveSuccess
                  ? (isPt ? 'Salvo no Remoto e Copiado!' : 'Saved to Remote & Copied!')
                  : isSaving
                  ? (isPt ? 'Salvando...' : 'Saving...')
                  : (isPt ? `Salvar (${saveShortcutLabel})` : `Save (${saveShortcutLabel})`)}
              </span>
            </button>
          </div>
        </div>

        {/* Go to Line Bar */}
        {showGoToLine && (
          <div className="bg-slate-100 dark:bg-dark-750 border-b border-slate-200 dark:border-dark-600 px-4 py-2 flex items-center space-x-2 text-xs shrink-0 animate-in slide-in-from-top-1 duration-150">
            <span className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1">
              <Hash className="w-3.5 h-3.5 text-rust-500" />
              {isPt ? 'Ir para a linha:' : 'Go to line:'}
            </span>
            <input
              type="number"
              min={1}
              max={lineCount}
              autoFocus
              value={targetLineInput}
              onChange={(e) => setTargetLineInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const num = parseInt(targetLineInput, 10);
                  if (!isNaN(num)) handleJumpToLine(num);
                } else if (e.key === 'Escape') {
                  setShowGoToLine(false);
                }
              }}
              placeholder={`1 - ${lineCount}`}
              className="bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2 py-0.5 w-28 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-rust-500"
            />
            <button
              onClick={() => {
                const num = parseInt(targetLineInput, 10);
                if (!isNaN(num)) handleJumpToLine(num);
              }}
              className="px-2.5 py-0.5 rounded bg-rust-600 hover:bg-rust-500 text-white font-medium text-xs shadow-sm"
            >
              {isPt ? 'Navegar' : 'Jump'}
            </button>
            <button
              onClick={() => setShowGoToLine(false)}
              className="p-1 rounded hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-500"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Find & Replace Bar */}
        {showSearch && (
          <div className="bg-slate-100 dark:bg-dark-750 border-b border-slate-200 dark:border-dark-600 px-4 py-2 flex flex-wrap items-center gap-2 select-none shrink-0 animate-in slide-in-from-top-1 duration-150">
            <div className="flex items-center space-x-1 bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2 py-0.5 shadow-sm">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={isPt ? 'Localizar...' : 'Find...'}
                className="bg-transparent text-xs text-slate-900 dark:text-slate-100 focus:outline-none w-44 placeholder:text-slate-400"
              />
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                {matches.length > 0 ? `${currentMatchIndex + 1}/${matches.length}` : '0'}
              </span>
            </div>

            <button
              onClick={handlePrevMatch}
              title={isPt ? 'Anterior' : 'Previous'}
              className="p-1 rounded bg-white hover:bg-slate-50 dark:bg-dark-700 dark:hover:bg-dark-600 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-dark-600 shadow-sm"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleNextMatch}
              title={isPt ? 'Próximo' : 'Next'}
              className="p-1 rounded bg-white hover:bg-slate-50 dark:bg-dark-700 dark:hover:bg-dark-600 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-dark-600 shadow-sm"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => setMatchCase(!matchCase)}
              title={isPt ? 'Diferenciar Maiúsculas/Minúsculas' : 'Match Case'}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                matchCase ? 'bg-sky-500/20 border-sky-500/40 text-sky-700 dark:text-sky-300 font-bold' : 'bg-white dark:bg-dark-700 border-slate-300 dark:border-dark-600 text-slate-600 dark:text-slate-400'
              }`}
            >
              Aa
            </button>

            <div className="flex items-center space-x-1 bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2 py-0.5 shadow-sm">
              <Replace className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                value={replaceTerm}
                onChange={(e) => setReplaceTerm(e.target.value)}
                placeholder={isPt ? 'Substituir por...' : 'Replace with...'}
                className="bg-transparent text-xs text-slate-900 dark:text-slate-100 focus:outline-none w-44 placeholder:text-slate-400"
              />
            </div>

            <button
              onClick={handleReplaceCurrent}
              disabled={matches.length === 0}
              className="px-2.5 py-1 rounded bg-white hover:bg-slate-50 dark:bg-dark-700 dark:hover:bg-dark-600 disabled:opacity-30 text-xs text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-dark-600 shadow-sm font-medium"
            >
              {isPt ? 'Substituir' : 'Replace'}
            </button>

            <button
              onClick={handleReplaceAll}
              disabled={matches.length === 0}
              className="px-2.5 py-1 rounded bg-white hover:bg-slate-50 dark:bg-dark-700 dark:hover:bg-dark-600 disabled:opacity-30 text-xs text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-dark-600 shadow-sm font-medium"
            >
              {isPt ? 'Substituir Tudo' : 'Replace All'}
            </button>
          </div>
        )}

        {/* Core Editor Body (Gutter + Highlight Mirror + Textarea) */}
        <div className="flex-1 flex overflow-hidden relative bg-slate-900 dark:bg-dark-950 font-mono text-xs">
          {/* Gutter Line Numbers */}
          <div
            ref={lineNumbersRef}
            style={{ fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.55)}px` }}
            className="w-14 bg-slate-950/80 dark:bg-dark-900 text-slate-400 dark:text-slate-500 text-right pr-2 pt-3 select-none border-r border-slate-800 dark:border-dark-700/80 font-mono overflow-hidden shrink-0"
          >
            {lines.map((_, i) => {
              const isCurrent = activeTab.cursorLine === i + 1;
              return (
                <div
                  key={i}
                  onClick={() => handleJumpToLine(i + 1)}
                  className={`cursor-pointer transition-colors px-1 ${
                    isCurrent
                      ? 'text-rust-400 dark:text-rust-300 font-bold bg-slate-800/80 dark:bg-slate-700/60 rounded-sm'
                      : 'hover:text-slate-200 hover:bg-slate-800/30'
                  }`}
                  title={isPt ? `Linha ${i + 1} (Clique para ir)` : `Line ${i + 1} (Click to jump)`}
                >
                  {i + 1}
                </div>
              );
            })}
          </div>

          {/* Editor Container with Overlaid Highlighted Pre and Input Textarea */}
          <div className="flex-1 relative overflow-hidden">
            {/* Active Line Position Marker Overlay */}
            <div
              ref={activeLineRef}
              className="absolute inset-0 overflow-hidden pointer-events-none z-0 select-none"
            >
              <div
                style={{
                  top: `${12 + (activeTab.cursorLine - 1) * Math.round(fontSize * 1.55)}px`,
                  height: `${Math.round(fontSize * 1.55)}px`,
                }}
                className="absolute inset-x-0 bg-slate-800/40 dark:bg-slate-700/25 border-y border-slate-700/40 dark:border-slate-600/30 transition-all duration-75"
              />
            </div>

            {/* Syntax Highlighted Mirror Layer */}
            <pre
              ref={preRef}
              style={{
                fontSize: `${fontSize}px`,
                lineHeight: `${Math.round(fontSize * 1.55)}px`,
                whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                wordBreak: wordWrap ? 'break-word' : 'normal',
                fontFamily: editorFontFamily,
                tabSize: 2,
                MozTabSize: 2,
                padding: '12px',
                border: 0,
                outline: 'none',
              }}
              className="absolute inset-0 m-0 overflow-hidden pointer-events-none text-slate-100 dark:text-slate-200 bg-transparent select-none z-0"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightedCode + '\n' }}
            />

            {/* Editable Textarea Layer with High-Visibility Caret & Text Cursor */}
            <textarea
              ref={textareaRef}
              value={activeTab.content}
              onChange={(e) => handleContentChange(e.target.value)}
              onScroll={handleScroll}
              onClick={updateCursorPosition}
              onKeyUp={updateCursorPosition}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              role="textbox"
              aria-multiline="true"
              aria-label={isPt ? `Editor de código para ${activeTab.name}` : `Code editor for ${activeTab.name}`}
              aria-describedby="editor-status-bar"
              style={{
                fontSize: `${fontSize}px`,
                lineHeight: `${Math.round(fontSize * 1.55)}px`,
                whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                wordBreak: wordWrap ? 'break-word' : 'normal',
                fontFamily: editorFontFamily,
                tabSize: 2,
                MozTabSize: 2,
                padding: '12px',
                border: 0,
                outline: 'none',
                caretColor: '#f97316',
                cursor: 'text',
              }}
              className="absolute inset-0 m-0 w-full h-full resize-none bg-transparent text-transparent focus:outline-none overflow-auto z-10 selection:bg-rust-500/40 selection:text-white dark:selection:bg-rust-500/50 cursor-text"
            />
          </div>
        </div>

        {/* Status Bar */}
        <div id="editor-status-bar" className="h-6 bg-slate-100 dark:bg-dark-900 border-t border-slate-200 dark:border-dark-600 px-3 flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400 font-mono select-none shrink-0">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => {
                setShowGoToLine(true);
                setTargetLineInput(String(activeTab.cursorLine));
              }}
              title={isPt ? `Ir para a Linha (${isMac ? '⌘G' : 'Ctrl+G'})` : `Go to Line (${isMac ? '⌘G' : 'Ctrl+G'})`}
              className="hover:underline flex items-center space-x-1 cursor-pointer hover:text-rust-500 dark:hover:text-rust-400 transition-colors"
            >
              <span>
                {isPt ? 'Linha' : 'Ln'} {activeTab.cursorLine}, {isPt ? 'Coluna' : 'Col'} {activeTab.cursorCol}
              </span>
            </button>
            <span>{lineCount} {isPt ? 'linhas' : 'lines'}</span>
            <span>{activeTab.content.length.toLocaleString()} bytes</span>
            <span>UTF-8</span>
            <span>LF</span>
          </div>

          <div className="flex items-center space-x-3">
            <span className="flex items-center space-x-1 text-slate-700 dark:text-slate-300">
              <Code className="w-3 h-3 text-rust-600 dark:text-rust-400" />
              <span>{SUPPORTED_LANGUAGES.find((l) => l.id === activeTab.language)?.name || activeTab.language}</span>
            </span>
            <span className="text-[10px] text-slate-500 dark:text-slate-500">RustSCP Editor v1.0</span>
          </div>
        </div>

        {/* Keyboard Shortcuts Cheatsheet Modal */}
        {showShortcutsModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-60 flex items-center justify-center p-4 animate-in fade-in duration-100">
            <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl p-5 max-w-lg w-full text-slate-900 dark:text-slate-100 select-none animate-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-dark-700 pb-3 mb-4">
                <div className="flex items-center space-x-2">
                  <Keyboard className="w-4 h-4 text-rust-500" />
                  <h3 className="font-bold text-sm">
                    {isPt ? 'Atalhos de Teclado do RustSCP Editor' : 'RustSCP Editor Keyboard Shortcuts'}
                  </h3>
                </div>
                <button
                  onClick={() => setShowShortcutsModal(false)}
                  className="p-1 rounded hover:bg-slate-100 dark:hover:bg-dark-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Salvar Remoto & Clipboard' : 'Save Remote & Clipboard'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌘S' : 'Ctrl+S'}</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Localizar e Substituir' : 'Find and Replace'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌘F' : 'Ctrl+F'}</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Ir para a Linha' : 'Go to Line'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌘G' : 'Ctrl+G'}</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Comentar Linha' : 'Toggle Comment'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌘/' : 'Ctrl+/'}</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Duplicar Linha' : 'Duplicate Line'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌘⇧D' : 'Ctrl+Shift+D'}</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Excluir Linha' : 'Delete Line'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌘⇧K' : 'Ctrl+Shift+K'}</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Mover Linha Acima/Abaixo' : 'Move Line Up/Down'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌥↑ / ⌥↓' : 'Alt+↑ / Alt+↓'}</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Indentar / Desindentar' : 'Indent / Dedent'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">Tab / ⇧Tab</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Ajustar Quebra de Linha' : 'Toggle Word Wrap'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌥Z' : 'Alt+Z'}</kbd>
                </div>
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700">
                  <span className="text-slate-600 dark:text-slate-400">{isPt ? 'Zoom da Fonte (+/-)' : 'Font Zoom (+/-)'}</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 font-mono font-semibold">{isMac ? '⌘+ / ⌘-' : 'Ctrl+ / Ctrl-'}</kbd>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-200 dark:border-dark-700 flex justify-end">
                <button
                  onClick={() => setShowShortcutsModal(false)}
                  className="px-4 py-1.5 rounded bg-rust-600 hover:bg-rust-500 text-white font-medium text-xs shadow-sm"
                >
                  {isPt ? 'Entendido' : 'Close'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
