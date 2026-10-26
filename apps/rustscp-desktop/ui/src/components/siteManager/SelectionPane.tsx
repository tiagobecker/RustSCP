import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, FolderInput, Star, StarOff, Trash2 } from 'lucide-react';
import type { ConnectionConfig } from '../../types.ts';
import { Button } from '../ui/controls.tsx';
import { ProtocolGlyph } from './SiteTreeRow.tsx';
import { formatCount, isLocalSite, protocolBreakdown } from './siteTreeModel.ts';
import type { FolderNode } from './types.ts';

export type SelectedItem = { kind: 'site'; site: ConnectionConfig } | { kind: 'folder'; node: FolderNode };

interface Props {
  /** The selected items, in tree order */
  items: SelectedItem[];
  onMove: () => void;
  onDelete: () => void;
  /** Every selected item is a favorite already (the button removes them) */
  allFavorite: boolean;
  onFavorite: () => void;
  /** Reduces the selection to the focused row */
  onClose: () => void;
}

/** Names listed before "and N more" */
const LISTED = 8;

/** The right pane while 2 or more items are selected: what they are, and what can be done to all of them. */
export const SelectionPane: React.FC<Props> = ({ items, onMove, onDelete, allFavorite, onFavorite, onClose }) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const nf = (n: number) => formatCount(lang, n);

  const { sites, folders, movable } = useMemo(() => {
    const s: ConnectionConfig[] = [];
    let f = 0;
    for (const item of items) {
      if (item.kind === 'site') {
        if (!isLocalSite(item.site)) s.push(item.site);
      } else f++;
    }
    return { sites: s, folders: f, movable: s.length + f };
  }, [items]);

  const breakdown = useMemo(() => {
    const parts: string[] = [];
    if (sites.length > 0) {
      parts.push(t('siteTree.statsConnections', { count: sites.length, formatted: nf(sites.length), defaultValue_one: '1 connection', defaultValue_other: '{{formatted}} connections' }));
    }
    if (folders > 0) parts.push(t('siteTree.statusFolders', { count: folders, formatted: nf(folders), defaultValue_one: '1 folder', defaultValue_other: '{{formatted}} folders' }));
    for (const p of protocolBreakdown(sites)) parts.push(`${nf(p.count)} ${p.tag}`);
    return parts.join(' · ');
    // nf depends on lang only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites, folders, t, lang]);

  const listed = items.slice(0, LISTED);
  const more = items.length - listed.length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 overflow-y-auto px-7 pt-5 pb-6">
        <div className="h-[18px]" aria-hidden />
        <h2 className="h-9 flex items-center text-[17px] font-semibold text-ink" aria-live="polite">
          {t('siteTree.itemsSelected', { count: items.length, formatted: nf(items.length), defaultValue_one: '1 item selected', defaultValue_other: '{{formatted}} items selected' })}
        </h2>
        <p className="mt-1 text-[12.5px] text-ink-muted leading-relaxed">{breakdown}</p>

        <ul className="mt-4 flex flex-col gap-0.5 max-w-[420px]">
          {listed.map((item) => (
            <li key={item.kind === 'site' ? `s:${item.site.id}` : `f:${item.node.path}`} className="h-7 flex items-center gap-2 min-w-0 text-[13px] text-ink">
              {item.kind === 'site' ? <ProtocolGlyph site={item.site} /> : <Folder aria-hidden className="w-4 h-4 shrink-0 text-ink-faint" />}
              <span className="truncate" title={item.kind === 'folder' ? item.node.path : item.site.name}>
                {item.kind === 'site' ? item.site.name : item.node.name}
              </span>
            </li>
          ))}
        </ul>
        {more > 0 && <p className="mt-1 text-[12.5px] text-ink-faint">{t('siteTree.andMore', { formatted: nf(more), defaultValue: 'and {{formatted}} more' })}</p>}

        <div className="mt-6 flex flex-col gap-2 w-64 max-w-full">
          <Button className="justify-start" icon={<FolderInput className="w-3.5 h-3.5 text-ink-muted" />} onClick={onMove} disabled={movable === 0}>
            {t('siteTree.moveTo', 'Move to…')}
          </Button>
          <Button
            className="justify-start"
            icon={allFavorite ? <StarOff className="w-3.5 h-3.5 text-ink-muted" /> : <Star className="w-3.5 h-3.5 text-ink-muted" />}
            onClick={onFavorite}
          >
            {allFavorite
              ? t('siteTree.removeFavoritesN', { count: items.length, formatted: nf(items.length), defaultValue_one: 'Remove 1 from favorites', defaultValue_other: 'Remove {{formatted}} from favorites' })
              : t('siteTree.addFavoritesN', { count: items.length, formatted: nf(items.length), defaultValue_one: 'Add 1 to favorites', defaultValue_other: 'Add {{formatted}} to favorites' })}
          </Button>
          <Button className="justify-start !text-red-600 dark:!text-red-400" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onDelete} disabled={movable === 0}>
            {t('siteTree.deleteN', { count: movable, formatted: nf(movable), defaultValue_one: 'Delete 1 item', defaultValue_other: 'Delete {{formatted}} items' })}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-5 py-3.5 border-t border-line shrink-0 select-none">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t('siteTree.close', 'Close')}
        </Button>
        <Button variant="primary" icon={<FolderInput className="w-3.5 h-3.5" />} onClick={onMove} disabled={movable === 0}>
          {t('siteTree.moveTo', 'Move to…')}
        </Button>
      </div>
    </div>
  );
};
