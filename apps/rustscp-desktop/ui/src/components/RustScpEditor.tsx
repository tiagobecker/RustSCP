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
  Code
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
import 'prismjs/components/prism-php';

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

function detectLanguage(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'docker';
  const ext = lower.split('.').pop() || '';
  return EXT_TO_LANG[ext] || 'plain';
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
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  // Initialize or add tab when initialFile changes
  useEffect(() => {
    if (!initialFile) return;

    setTabs((prev) => {
      const existing = prev.find((t) => t.path === initialFile.path && t.sessionId === initialFile.sessionId);
      if (existing) {
        setActiveTabId(existing.id);
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

  // Synchronized scrolling between textarea, highlighted mirror, and line numbers
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = target.scrollTop;
      preRef.current.scrollLeft = target.scrollLeft;
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

  // Tab key indentation support
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = activeTab?.content || '';

      if (e.shiftKey) {
        // Dedent 2 spaces if possible
        if (val.substring(start - 2, start) === '  ') {
          const updated = val.substring(0, start - 2) + val.substring(start);
          handleContentChange(updated);
          setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = start - 2;
          }, 0);
        }
      } else {
        // Insert 2 spaces
        const updated = val.substring(0, start) + '  ' + val.substring(end);
        handleContentChange(updated);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSaveActive();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      setShowSearch(true);
    }
  };

  const handleSaveActive = async () => {
    if (!activeTab || isSaving) return;
    setIsSaving(true);
    try {
      await onSave(activeTab.path, activeTab.content, activeTab.sessionId);
      setTabs((prev) =>
        prev.map((t) => (t.id === activeTab.id ? { ...t, initialContent: t.content, isDirty: false } : t))
      );
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      alert(`Erro ao salvar: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

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
    if (lang && Prism.languages[lang]) {
      try {
        return Prism.highlight(code, Prism.languages[lang], lang);
      } catch (_e) {
        return code;
      }
    }
    return code;
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
              title={isPt ? 'Localizar e Substituir (Ctrl+F)' : 'Find & Replace (Ctrl+F)'}
              className={`p-1.5 rounded border transition-colors ${
                showSearch
                  ? 'bg-sky-500/20 border-sky-500/40 text-sky-700 dark:text-sky-300'
                  : 'bg-white dark:bg-dark-700/60 border-slate-300 dark:border-dark-600 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Search className="w-3.5 h-3.5" />
            </button>

            {/* Word Wrap Toggle */}
            <button
              onClick={() => setWordWrap(!wordWrap)}
              title={isPt ? 'Quebra de Linha Suave (Word Wrap)' : 'Toggle Word Wrap'}
              className={`p-1.5 rounded border transition-colors ${
                wordWrap
                  ? 'bg-rust-500/20 border-rust-500/40 text-rust-700 dark:text-rust-400'
                  : 'bg-white dark:bg-dark-700/60 border-slate-300 dark:border-dark-600 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <WrapText className="w-3.5 h-3.5" />
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
              className="flex items-center space-x-1.5 px-3 py-1 rounded bg-rust-600 hover:bg-rust-500 disabled:opacity-40 text-white font-semibold transition-all shadow-sm border border-rust-500/40"
            >
              {saveSuccess ? (
                <Check className="w-3.5 h-3.5 text-white" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{saveSuccess ? (isPt ? 'Salvo!' : 'Saved!') : isSaving ? (isPt ? 'Salvando...' : 'Saving...') : (isPt ? 'Salvar (Ctrl+S)' : 'Save (Ctrl+S)')}</span>
            </button>
          </div>
        </div>

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
            className="w-14 bg-slate-950/80 dark:bg-dark-900 text-slate-400 dark:text-slate-500 text-right pr-3 pt-3 select-none border-r border-slate-800 dark:border-dark-700/80 font-mono overflow-hidden shrink-0"
          >
            {lines.map((_, i) => {
              const isCurrent = activeTab.cursorLine === i + 1;
              return (
                <div key={i} className={isCurrent ? 'text-rust-400 font-bold' : ''}>
                  {i + 1}
                </div>
              );
            })}
          </div>

          {/* Editor Container with Overlaid Highlighted Pre and Input Textarea */}
          <div className="flex-1 relative overflow-hidden">
            {/* Syntax Highlighted Mirror Layer */}
            <pre
              ref={preRef}
              style={{
                fontSize: `${fontSize}px`,
                lineHeight: `${Math.round(fontSize * 1.55)}px`,
                whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                wordBreak: wordWrap ? 'break-word' : 'normal',
              }}
              className="absolute inset-0 p-3 m-0 overflow-hidden pointer-events-none font-mono text-slate-100 dark:text-slate-200 bg-transparent select-none z-0"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightedCode + '\n' }}
            />

            {/* Editable Textarea Layer */}
            <textarea
              ref={textareaRef}
              value={activeTab.content}
              onChange={(e) => handleContentChange(e.target.value)}
              onScroll={handleScroll}
              onClick={updateCursorPosition}
              onKeyUp={updateCursorPosition}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              style={{
                fontSize: `${fontSize}px`,
                lineHeight: `${Math.round(fontSize * 1.55)}px`,
                whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                wordBreak: wordWrap ? 'break-word' : 'normal',
                caretColor: 'var(--color-rust-400)',
              }}
              className="absolute inset-0 p-3 m-0 w-full h-full resize-none bg-transparent text-transparent focus:outline-none overflow-auto font-mono z-10 selection:bg-rust-500/30 selection:text-transparent"
            />
          </div>
        </div>

        {/* Status Bar */}
        <div className="h-6 bg-slate-100 dark:bg-dark-900 border-t border-slate-200 dark:border-dark-600 px-3 flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400 font-mono select-none shrink-0">
          <div className="flex items-center space-x-4">
            <span>
              {isPt ? 'Linha' : 'Ln'} {activeTab.cursorLine}, {isPt ? 'Coluna' : 'Col'} {activeTab.cursorCol}
            </span>
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
      </div>
    </div>
  );
};
