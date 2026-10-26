import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderInput, FolderPlus, Plus, TextCursorInput, Trash2 } from 'lucide-react';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { Button } from '../ui/controls.tsx';
import { folderChain, formatCount, protocolBreakdown, sitesInside } from './siteTreeModel.ts';
import type { FolderNode, TreeModel } from './types.ts';

interface Props {
  /** The folder; null for the root overview ("All connections") */
  node: FolderNode | null;
  model: TreeModel;
  /** Renames the folder: an error text, or null when the rename went ahead (or the merge prompt opened) */
  onRename: (path: string, name: string) => string | null;
  onMove: () => void;
  onDelete: () => void;
  onNewFolder: () => void;
  onNewConnection: () => void;
  /** A breadcrumb segment: selects that folder ('' = the root overview) */
  onReveal: (path: string) => void;
  /** Closes the Connect dialog */
  onClose: () => void;
  /** Escape layer of the dialog: reverts an edited name */
  escapeRef: MutableRefObject<(() => boolean) | null>;
}

/** "34 connections in 3 folders · 28 SFTP · 4 FTPS · 2 S3" */
const useFolderStats = (model: TreeModel, node: FolderNode | null): string => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return useMemo(() => {
    const sites = sitesInside(model, node?.path ?? '');
    const folders = node ? node.folderCount : model.totalFolders;
    const nf = (n: number) => formatCount(lang, n);
    let head = t('siteTree.statsConnections', {
      count: sites.length,
      formatted: nf(sites.length),
      defaultValue_zero: 'No connections',
      defaultValue_one: '1 connection',
      defaultValue_other: '{{formatted}} connections',
    });
    if (folders > 0) {
      head += ` ${t('siteTree.statsInFolders', { count: folders, formatted: nf(folders), defaultValue_one: 'in 1 folder', defaultValue_other: 'in {{formatted}} folders' })}`;
    }
    return [head, ...protocolBreakdown(sites).map((p) => `${nf(p.count)} ${p.tag}`)].join(' · ');
  }, [model, node, t, lang]);
};

/**
 * The right pane while one folder (or the "All connections" header) is selected: its name (edit to
 * rename), what it holds, and its actions. The form comes back as soon as a site is selected.
 */
export const FolderPane: React.FC<Props> = ({ node, model, onRename, onMove, onDelete, onNewFolder, onNewConnection, onReveal, onClose, escapeRef }) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(node?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const stats = useFolderStats(model, node);

  // Another folder (or the same one renamed): show its name
  useEffect(() => {
    setName(node?.name ?? '');
    setError(null);
  }, [node?.path, node?.name]);

  escapeRef.current = () => {
    if (!node || document.activeElement !== inputRef.current || name === node.name) return false;
    setName(node.name);
    setError(null);
    return true;
  };
  useEffect(
    () => () => {
      escapeRef.current = null;
    },
    [escapeRef]
  );

  const commit = (fromBlur: boolean) => {
    if (!node) return;
    const value = name.trim();
    if (!value || value === node.name) {
      setName(node.name);
      setError(null);
      return;
    }
    const problem = onRename(node.path, value);
    if (!problem) setError(null);
    else if (fromBlur) {
      // Leaving the field with an invalid name reverts it
      setName(node.name);
      setError(null);
    } else setError(problem);
  };

  const ancestors = node ? folderChain(node.path).slice(0, -1) : [];
  const errorId = 'folder-pane-name-error';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 overflow-y-auto px-7 pt-5 pb-6">
        <nav className="h-[18px] text-[12px] text-ink-faint flex items-center min-w-0 whitespace-nowrap overflow-hidden" aria-label={t('siteTree.breadcrumb', 'Folder path')}>
          {node && (
            <>
              <button type="button" className="shrink-0 hover:text-ink hover:underline underline-offset-2" onClick={() => onReveal('')}>
                {t('siteTree.sectionAll', 'All connections')}
              </button>
              {ancestors.map((path) => (
                <React.Fragment key={path}>
                  <span className="shrink-0" aria-hidden>
                    {' / '}
                  </span>
                  <button type="button" className="min-w-0 truncate hover:text-ink hover:underline underline-offset-2" onClick={() => onReveal(path)}>
                    {path.slice(path.lastIndexOf('/') + 1)}
                  </button>
                </React.Fragment>
              ))}
            </>
          )}
        </nav>
        {node ? (
          <input
            {...plainTextInputProps}
            ref={inputRef}
            value={name}
            maxLength={300}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(false);
              }
            }}
            onBlur={() => commit(true)}
            aria-label={t('siteTree.folderName', 'Folder name')}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="w-full h-9 bg-transparent text-[17px] font-semibold text-ink placeholder:text-ink-faint outline-none rounded-md -ml-1 px-1 hover:bg-dark-650/40 focus:bg-dark-650/40 transition-colors"
          />
        ) : (
          <h2 className="h-9 flex items-center text-[17px] font-semibold text-ink">{t('siteTree.sectionAll', 'All connections')}</h2>
        )}
        {error && (
          <p id={errorId} role="alert" className="mt-0.5 text-[12px] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <p className="mt-1 text-[12.5px] text-ink-muted leading-relaxed">{stats}</p>

        {node && (
          <div className="mt-6 flex flex-col gap-2 w-64 max-w-full">
            <Button
              className="justify-start"
              icon={<TextCursorInput className="w-3.5 h-3.5 text-ink-muted" />}
              onClick={() => {
                inputRef.current?.focus();
                inputRef.current?.select();
              }}
            >
              {t('siteTree.rename', 'Rename')}
            </Button>
            <Button className="justify-start" icon={<FolderInput className="w-3.5 h-3.5 text-ink-muted" />} onClick={onMove}>
              {t('siteTree.moveTo', 'Move to…')}
            </Button>
            <Button className="justify-start !text-red-600 dark:!text-red-400" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onDelete}>
              {t('siteTree.deleteFolder', 'Delete folder…')}
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-5 py-3.5 border-t border-line shrink-0 select-none">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('siteTree.close', 'Close')}
        </Button>
        <Button variant="secondary" icon={<FolderPlus className="w-3.5 h-3.5" />} onClick={onNewFolder}>
          {t('siteTree.newFolder', 'New folder')}
        </Button>
        <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={onNewConnection}>
          {node ? t('siteTree.newConnectionHere', 'New connection here') : t('loginDialog.newConnection', 'New connection')}
        </Button>
      </div>
    </div>
  );
};
