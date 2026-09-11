import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Search, X, Folder, FileText, Edit3, ExternalLink } from 'lucide-react';

interface FileEntry {
  name: string;
  path: string;
  file_type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modified_at: string | null;
  permissions: {
    mode: number;
    readonly: boolean;
    owner: string | null;
    group: string | null;
  };
  is_hidden: boolean;
}

interface FindFileMatch {
  entry: FileEntry;
  matched_lines: string[];
}

interface FindFilesModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  initialPath: string;
  onNavigateToPath?: (path: string) => void;
  onOpenFileEditor?: (path: string) => void;
}

export const FindFilesModal: React.FC<FindFilesModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  initialPath,
  onNavigateToPath,
  onOpenFileEditor,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [basePath, setBasePath] = useState(initialPath || '/');
  const [mask, setMask] = useState('*');
  const [containsText, setContainsText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<FindFileMatch[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<FindFileMatch | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSearch = async () => {
    setIsSearching(true);
    setErrorMessage(null);
    setResults([]);
    setSelectedMatch(null);

    try {
      const matches = await invoke<FindFileMatch[]>('find_files_advanced', {
        sessionId,
        query: {
          base_path: basePath,
          mask: mask || '*',
          contains_text: containsText.trim() ? containsText.trim() : null,
          case_sensitive: caseSensitive,
          max_depth: 10,
          max_results: 200,
        },
      });
      setResults(matches);
    } catch (err: any) {
      setErrorMessage(err.toString());
    } finally {
      setIsSearching(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl w-full max-w-4xl flex flex-col max-h-[90vh] overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-800 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-lg border border-emerald-500/20">
              <Search className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 tracking-wide">
                {isPt ? 'Localizar Arquivos no Servidor (Shift+F7)' : 'Find Files on Server (Shift+F7)'}
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {isPt
                  ? 'Busca recursiva por máscara de arquivo (*.log; !*.tmp) e conteúdo de texto'
                  : 'Recursive search by file mask (*.log; !*.tmp) and text content'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Filter Controls */}
        <div className="p-6 border-b border-slate-200 dark:border-dark-800 bg-slate-50 dark:bg-dark-900/50 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {isPt ? 'Diretório Inicial' : 'Search Directory'}
              </label>
              <input
                type="text"
                value={basePath}
                onChange={(e) => setBasePath(e.target.value)}
                className="w-full bg-white dark:bg-dark-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-slate-200 focus:outline-none focus:border-emerald-500 shadow-sm"
                placeholder="/"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {isPt ? 'Máscara de Arquivo (ex: *.log; !*.tmp)' : 'File Mask (e.g. *.log; !*.tmp)'}
              </label>
              <input
                type="text"
                value={mask}
                onChange={(e) => setMask(e.target.value)}
                className="w-full bg-white dark:bg-dark-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-emerald-600 dark:text-emerald-400 focus:outline-none focus:border-emerald-500 shadow-sm"
                placeholder="*.log; *.conf; !*.bak"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {isPt ? 'Contendo o Texto (Grep)' : 'Containing Text (Grep)'}
              </label>
              <input
                type="text"
                value={containsText}
                onChange={(e) => setContainsText(e.target.value)}
                className="w-full bg-white dark:bg-dark-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-slate-200 focus:outline-none focus:border-emerald-500 shadow-sm"
                placeholder={isPt ? 'Palavra ou termo a buscar dentro dos arquivos...' : 'Text or word to search inside files...'}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={caseSensitive}
                  onChange={(e) => setCaseSensitive(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-emerald-500 focus:ring-0"
                />
                {isPt ? 'Diferenciar maiúsculas/minúsculas' : 'Case sensitive'}
              </label>

              <button
                onClick={handleSearch}
                disabled={isSearching}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors shadow-md"
              >
                <Search className={`w-4 h-4 ${isSearching ? 'animate-spin' : ''}`} />
                {isSearching ? (isPt ? 'Buscando...' : 'Searching...') : (isPt ? 'Iniciar Busca' : 'Start Search')}
              </button>
            </div>
          </div>

          {errorMessage && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-300 text-xs rounded-lg">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Results Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-[220px] bg-white dark:bg-dark-900">
          {results.length === 0 && !isSearching ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 py-12">
              <Search className="w-10 h-10 mb-2 opacity-30" />
              <p className="text-sm font-medium">{isPt ? 'Nenhum resultado encontrado ou busca ainda não iniciada.' : 'No results found or search has not started.'}</p>
              <p className="text-xs text-slate-500 dark:text-slate-600 mt-1">{isPt ? 'Especifique o diretório e clique em Iniciar Busca.' : 'Specify the folder and click Start Search.'}</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800/60">
              <div className="flex items-center justify-between pb-2 text-xs text-slate-600 dark:text-slate-400 font-semibold px-2">
                <span>{results.length} {isPt ? 'arquivos encontrados' : 'files found'}</span>
              </div>
              {results.map((match, idx) => (
                <div
                  key={idx}
                  onClick={() => setSelectedMatch(match)}
                  className={`p-3 rounded-lg cursor-pointer transition-colors flex flex-col gap-1.5 ${
                    selectedMatch?.entry.path === match.entry.path
                      ? 'bg-emerald-500/15 border border-emerald-500/30'
                      : 'hover:bg-slate-100 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 truncate">
                      {match.entry.file_type === 'directory' ? (
                        <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                      ) : (
                        <FileText className="w-4 h-4 text-cyan-600 dark:text-cyan-400 shrink-0" />
                      )}
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{match.entry.name}</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400 truncate font-mono">{match.entry.path}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-600 dark:text-slate-400 font-mono shrink-0">
                      <span>{formatBytes(match.entry.size)}</span>
                      {match.entry.permissions && <span>{match.entry.permissions.mode.toString(8)}</span>}
                    </div>
                  </div>

                  {/* Matched Lines Snippet */}
                  {match.matched_lines && match.matched_lines.length > 0 && (
                    <div className="bg-slate-950 p-2 rounded border border-slate-800 text-xs font-mono text-emerald-300/90 space-y-1">
                      {match.matched_lines.map((line, lIdx) => (
                        <div key={lIdx} className="truncate">
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none">
          <div className="text-xs text-slate-600 dark:text-slate-400">
            {selectedMatch ? (
              <span className="font-mono text-slate-900 dark:text-slate-300 truncate max-w-md inline-block font-medium">
                {selectedMatch.entry.path}
              </span>
            ) : (
              <span>{isPt ? 'Selecione um arquivo para opções' : 'Select a file for options'}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {selectedMatch && selectedMatch.entry.file_type === 'file' && onOpenFileEditor && (
              <button
                onClick={() => {
                  onOpenFileEditor(selectedMatch.entry.path);
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 text-xs font-semibold border border-slate-300 dark:border-slate-700 transition-colors"
              >
                <Edit3 className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
                {isPt ? 'Editar (F4)' : 'Edit (F4)'}
              </button>
            )}

            {selectedMatch && onNavigateToPath && (
              <button
                onClick={() => {
                  const parentDir = selectedMatch.entry.path.substring(0, selectedMatch.entry.path.lastIndexOf('/')) || '/';
                  onNavigateToPath(parentDir);
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 text-xs font-semibold border border-slate-300 dark:border-slate-700 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                {isPt ? 'Ir para a Pasta' : 'Go to Folder'}
              </button>
            )}

            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-semibold border border-slate-300 dark:border-slate-700 transition-colors"
            >
              {isPt ? 'Fechar' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
