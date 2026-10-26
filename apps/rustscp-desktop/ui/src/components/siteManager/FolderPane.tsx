import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderInput, FolderPlus, Plus, TextCursorInput, Trash2 } from 'lucide-react';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { Button } from '../ui/controls.tsx';
import { FolderContentsTable } from './FolderContentsTable.tsx';
import { folderChain, formatCount, protocolBreakdown, sitesInside } from './siteTreeModel.ts';
import type { ConnectionConfig, FolderNode, TreeModel } from './types.ts';
import type { FolderRenameResult } from './SiteSidebar.tsx';

interface Props {
  /** The folder; null for the root overview ("All connections") */
  node: FolderNode | null;
  model: TreeModel;
  /** Renames the folder: what happened (renamed, the merge prompt opened, or the error to show) */
  onRename: (path: string, name: string) => FolderRenameResult;
  onMove: () => void;
  onDelete: () => void;
  onNewFolder: () => void;
  onNewConnection: () => void;
  /** A breadcrumb segment: selects that folder ('' = the root overview) */
  onReveal: (path: string) => void;
  /** Closes the Connect dialog */
  onClose: () => void;
  /** Escape layer of the dialog: reverts an edited name, or leaves the name field */
  escapeRef: MutableRefObject<(() => boolean) | null>;
  /** Escape in the unchanged name field: keyboard focus back to the tree */
  onFocusTree: () => void;
  /** Sites with an open tab (the contents table's dots) */
  openSiteIds: ReadonlySet<string>;
  /** The contents table: a click shows the item in the tree (this overview stays) */
  onRevealItem: (itemKey: string) => void;
  /** The contents table: double-click or Enter on a site */
  onConnect: (site: ConnectionConfig) => void;
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
export const FolderPane: React.FC<Props> = ({
  node,
  model,
  onRename,
  onMove,
  onDelete,
  onNewFolder,
  onNewConnection,
  onReveal,
  onClose,
  escapeRef,
  onFocusTree,
  openSiteIds,
  onRevealItem,
  onConnect,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  /** The field is left by Escape: its blur commits nothing */
  const skipBlurCommit = useRef(false);
  const [name, setName] = useState(node?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const stats = useFolderStats(model, node);

  // Another folder (or the same one renamed): show its name
  useEffect(() => {
    setName(node?.name ?? '');
    setError(null);
  }, [node?.path, node?.name]);

  // Escape in the name field is the field's: an edit is reverted, else the focus goes back to the
  // tree. Only a later Escape closes the dialog (as with F2 + Escape in the tree).
  escapeRef.current = () => {
    if (!node || document.activeElement !== inputRef.current) return false;
    if (name !== node.name) {
      setName(node.name);
      setError(null);
      return true;
    }
    skipBlurCommit.current = true;
    onFocusTree();
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
    if (fromBlur && skipBlurCommit.current) {
      skipBlurCommit.current = false;
      return;
    }
    const value = name.trim();
    if (!value || value === node.name) {
      setName(node.name);
      setError(null);
      return;
    }
    const result = onRename(node.path, value);
    if (result.kind !== 'error') {
      setError(null);
      // The merge prompt is open: the field shows the folder's name again, so leaving it does not
      // ask a second time (a Merge renames the folder, and the field follows)
      if (result.kind === 'prompt') setName(node.name);
    } else if (fromBlur) {
      // Leaving the field with an invalid name reverts it
      setName(node.name);
      setError(null);
    } else setError(result.text);
  };

  const ancestors = node ? folderChain(node.path).slice(0, -1) : [];
  const errorId = 'folder-pane-name-error';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto px-7 pt-5 pb-5 flex flex-col">
        <nav className="h-[18px] shrink-0 text-[12px] text-ink-faint flex items-center min-w-0 whitespace-nowrap overflow-hidden" aria-label={t('siteTree.breadcrumb', 'Folder path')}>
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
            className="w-full h-9 shrink-0 bg-transparent text-[17px] font-semibold text-ink placeholder:text-ink-faint outline-none rounded-md -ml-1 px-1 hover:bg-dark-650/40 focus:bg-dark-650/40 transition-colors"
          />
        ) : (
          <h2 className="h-9 shrink-0 flex items-center text-[17px] font-semibold text-ink">{t('siteTree.sectionAll', 'All connections')}</h2>
        )}
        {error && (
          <p id={errorId} role="alert" className="mt-0.5 shrink-0 text-[12px] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <p className="mt-1 shrink-0 text-[12.5px] text-ink-muted leading-relaxed">{stats}</p>

        {node && (
          // A row, not a stack: the contents table below takes the height
          <div className="mt-4 flex flex-wrap gap-2 shrink-0">
            <Button
              size="sm"
              icon={<TextCursorInput className="w-3.5 h-3.5 text-ink-muted" />}
              onClick={() => {
                inputRef.current?.focus();
                inputRef.current?.select();
              }}
            >
              {t('siteTree.rename', 'Rename')}
            </Button>
            <Button size="sm" icon={<FolderInput className="w-3.5 h-3.5 text-ink-muted" />} onClick={onMove}>
              {t('siteTree.moveTo', 'Move to…')}
            </Button>
            <Button size="sm" className="!text-red-600 dark:!text-red-400" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onDelete}>
              {t('siteTree.deleteFolder', 'Delete folder…')}
            </Button>
          </div>
        )}

        <div className="mt-5 flex-1 min-h-0 flex flex-col">
          <FolderContentsTable
            model={model}
            path={node?.path ?? ''}
            name={node?.name ?? t('siteTree.sectionAll', 'All connections')}
            openSiteIds={openSiteIds}
            onReveal={onRevealItem}
            onConnect={onConnect}
            onOpenFolder={onReveal}
          />
        </div>
      </div>

      <div data-dialog-footer="" className="flex items-center gap-2 px-5 py-3.5 border-t border-line shrink-0 select-none">
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
