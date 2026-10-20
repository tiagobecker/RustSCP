import React, { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Search, Folder, FileText, Pencil, FolderOpen, AlertTriangle } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Field, TextInput, Toggle } from './ui/controls.tsx';

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
  onOpenFileEditor?: (path: string) => void | Promise<void>;
  /** Optional protocol of the session ("sftp", "ftp", "s3", "local"…) to explain search limits. */
  protocol?: string;
}

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_RESULTS = 200;

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut <= 0) return path.startsWith('/') ? '/' : path.slice(0, cut + 1) || '/';
  // Keep "C:\" for a drive root
  if (/^[A-Za-z]:$/.test(path.slice(0, cut))) return path.slice(0, cut + 1);
  return path.slice(0, cut);
}

export const FindFilesModal: React.FC<FindFilesModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  initialPath,
  onNavigateToPath,
  onOpenFileEditor,
  protocol,
}) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || 'en').toLowerCase().startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);
  const formId = useId();

  const [basePath, setBasePath] = useState(initialPath || '/');
  const [mask, setMask] = useState('*');
  const [containsText, setContainsText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [maxDepth, setMaxDepth] = useState(String(DEFAULT_MAX_DEPTH));
  const [maxResults, setMaxResults] = useState(String(DEFAULT_MAX_RESULTS));
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [results, setResults] = useState<FindFileMatch[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const proto = (protocol || '').toLowerCase();
  const textSearchUnsupported = proto === 'ftp' || proto === 'ftps' || proto === 's3';

  // Every opening starts in the folder it was opened from, with no results from another session.
  useEffect(() => {
    requestSeq.current++;
    setBasePath(initialPath || '/');
    setResults([]);
    setSelectedIdx(-1);
    setErrorMessage(null);
    setHasSearched(false);
    setIsSearching(false);
  }, [isOpen, sessionId, initialPath]);

  const selected = selectedIdx >= 0 ? results[selectedIdx] ?? null : null;

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSearching) return;
    const seq = ++requestSeq.current;
    setIsSearching(true);
    setErrorMessage(null);
    setResults([]);
    setSelectedIdx(-1);
    const depth = Math.max(0, Math.min(64, parseInt(maxDepth, 10) || DEFAULT_MAX_DEPTH));
    const limit = Math.max(1, Math.min(5000, parseInt(maxResults, 10) || DEFAULT_MAX_RESULTS));
    try {
      const matches = await invoke<FindFileMatch[]>('find_files_advanced', {
        sessionId,
        query: {
          base_path: basePath.trim() || '/',
          mask: mask.trim() || '*',
          contains_text: !textSearchUnsupported && containsText.trim() ? containsText.trim() : null,
          case_sensitive: caseSensitive,
          max_depth: depth,
          max_results: limit,
        },
      });
      if (seq !== requestSeq.current) return;
      setResults(Array.isArray(matches) ? matches : []);
      setHasSearched(true);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setHasSearched(true);
    } finally {
      if (seq === requestSeq.current) setIsSearching(false);
    }
  };

  const openInEditor = (match: FindFileMatch) => {
    if (!onOpenFileEditor || match.entry.file_type === 'directory') return;
    onClose();
    void Promise.resolve(onOpenFileEditor(match.entry.path)).catch(() => {
      // the caller reports read errors
    });
  };

  const goToFolder = (match: FindFileMatch, into = false) => {
    if (!onNavigateToPath) return;
    onNavigateToPath(into && match.entry.file_type === 'directory' ? match.entry.path : parentDir(match.entry.path));
    onClose();
  };

  const activate = (match: FindFileMatch) => {
    if (match.entry.file_type === 'directory') goToFolder(match, true);
    else if (onOpenFileEditor) openInEditor(match);
    else goToFolder(match);
  };

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(results.length - 1, selectedIdx + 1) : Math.max(0, selectedIdx - 1);
      setSelectedIdx(next);
      listRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      activate(selected);
    } else if (e.key === 'F4' && selected) {
      e.preventDefault();
      openInEditor(selected);
    }
  };

  const resultLabel =
    results.length === 1 ? tr('1 resultado', '1 result') : tr(`${results.length.toLocaleString()} resultados`, `${results.length.toLocaleString()} results`);
  const limitReached = results.length > 0 && results.length >= (parseInt(maxResults, 10) || DEFAULT_MAX_RESULTS);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="2xl"
      icon={<Search className="w-4 h-4" />}
      title={tr('Localizar arquivos', 'Find files')}
      subtitle={tr('Busca por nome (ex.: *.log; !*.tmp) e, opcionalmente, por texto dentro dos arquivos.', 'Search by name (e.g. *.log; !*.tmp) and, optionally, by text inside files.')}
      bodyClassName="flex flex-col gap-4"
      footer={
        <>
          <span className="mr-auto min-w-0 truncate text-[12px] text-ink-faint font-mono" title={selected?.entry.path}>
            {selected ? selected.entry.path : ''}
          </span>
          {selected && selected.entry.file_type !== 'directory' && onOpenFileEditor && (
            <Button variant="secondary" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => openInEditor(selected)} title="F4">
              {tr('Editar', 'Edit')}
            </Button>
          )}
          {selected && onNavigateToPath && (
            <Button variant="secondary" icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={() => goToFolder(selected)}>
              {tr('Ir para a pasta', 'Go to folder')}
            </Button>
          )}
          <Button type="submit" form={formId} variant="primary" loading={isSearching} icon={<Search className="w-3.5 h-3.5" />}>
            {isSearching ? tr('Buscando…', 'Searching…') : tr('Buscar', 'Search')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSearch} className="space-y-3 shrink-0">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label={tr('Procurar em', 'Look in')}>
            {(id) => <TextInput id={id} mono value={basePath} onChange={(e) => setBasePath(e.target.value)} placeholder="/" />}
          </Field>
          <Field label={tr('Nome do arquivo', 'File name')} hint={tr('Separe com ; e use ! para excluir.', 'Separate with ; and use ! to exclude.')}>
            {(id) => <TextInput id={id} mono value={mask} onChange={(e) => setMask(e.target.value)} placeholder="*.log; *.conf; !*.bak" />}
          </Field>
        </div>
        <Field
          label={tr('Contendo o texto', 'Containing text')}
          hint={
            textSearchUnsupported
              ? tr('A busca por texto não está disponível em servidores FTP e S3.', 'Text search isn’t available on FTP and S3 servers.')
              : tr('Opcional. Funciona em pastas locais e servidores SFTP.', 'Optional. Works on local folders and SFTP servers.')
          }
        >
          {(id) => (
            <TextInput
              id={id}
              value={containsText}
              onChange={(e) => setContainsText(e.target.value)}
              placeholder={tr('Palavra ou frase', 'Word or phrase')}
              disabled={textSearchUnsupported}
            />
          )}
        </Field>
        <Disclosure label={tr('Avançado', 'Advanced')}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <label className="flex items-center justify-between gap-3 h-8">
              <span className="text-[13px] text-ink">{tr('Diferenciar maiúsculas', 'Match case')}</span>
              <Toggle checked={caseSensitive} onChange={setCaseSensitive} label={tr('Diferenciar maiúsculas', 'Match case')} />
            </label>
            <Field label={tr('Profundidade máxima', 'Max folder depth')}>
              {(id) => <TextInput id={id} type="number" min={0} max={64} value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} />}
            </Field>
            <Field label={tr('Máximo de resultados', 'Max results')}>
              {(id) => <TextInput id={id} type="number" min={1} max={5000} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} />}
            </Field>
          </div>
        </Disclosure>
      </form>

      {errorMessage && (
        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300" role="alert">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{errorMessage}</span>
        </div>
      )}

      <div className="ui-card flex-1 min-h-[220px] flex flex-col overflow-hidden">
        {results.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-1 px-6 py-10">
            <p className="text-[13px] text-ink-muted">
              {isSearching
                ? tr('Buscando…', 'Searching…')
                : hasSearched && !errorMessage
                ? tr('Nenhum arquivo encontrado.', 'No files found.')
                : tr('Escolha a pasta e o que procurar, depois pressione Buscar.', 'Choose a folder and what to look for, then press Search.')}
            </p>
          </div>
        ) : (
          <>
            <div className="px-3 h-8 flex items-center border-b border-line text-[12px] text-ink-faint shrink-0" aria-live="polite">
              {resultLabel}
              {limitReached && <span className="ml-1">{tr('(limite atingido)', '(limit reached)')}</span>}
            </div>
            <div
              ref={listRef}
              role="listbox"
              tabIndex={0}
              aria-label={tr('Resultados', 'Results')}
              aria-activedescendant={selectedIdx >= 0 ? `${formId}-r${selectedIdx}` : undefined}
              onKeyDown={handleListKeyDown}
              className="flex-1 overflow-y-auto max-h-[45vh] divide-y divide-line focus:outline-none"
            >
              {results.map((match, idx) => {
                const isSel = idx === selectedIdx;
                const isDir = match.entry.file_type === 'directory';
                return (
                  <div
                    key={`${match.entry.path}-${idx}`}
                    id={`${formId}-r${idx}`}
                    data-idx={idx}
                    role="option"
                    aria-selected={isSel}
                    onClick={() => setSelectedIdx(idx)}
                    onDoubleClick={() => activate(match)}
                    className={`px-3 py-2 cursor-default flex flex-col gap-1.5 ${isSel ? 'bg-rust-500/10' : 'hover:bg-dark-650/40'}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isDir ? <Folder className="w-4 h-4 text-ink-muted shrink-0" /> : <FileText className="w-4 h-4 text-ink-faint shrink-0" />}
                      <span className="text-[13px] text-ink truncate shrink-0 max-w-[40%]">{match.entry.name}</span>
                      <span className="text-[11.5px] text-ink-faint truncate font-mono min-w-0 flex-1" title={match.entry.path}>
                        {match.entry.path}
                      </span>
                      <span className="text-[11.5px] text-ink-faint font-mono tabular-nums shrink-0">{isDir ? '' : formatBytes(match.entry.size)}</span>
                      {match.entry.permissions && (
                        <span className="text-[11.5px] text-ink-faint font-mono tabular-nums shrink-0 w-10 text-right">
                          {(match.entry.permissions.mode & 0o7777).toString(8)}
                        </span>
                      )}
                    </div>
                    {match.matched_lines && match.matched_lines.length > 0 && (
                      <div className="ml-7 rounded-md bg-surface-sunken px-2 py-1.5 text-[11.5px] font-mono text-ink-muted space-y-0.5">
                        {match.matched_lines.slice(0, 5).map((line, lIdx) => (
                          <div key={lIdx} className="truncate" title={line}>
                            {line}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
