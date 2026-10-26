/**
 * Rows of the folder overview's contents table (spec §12): a folder's subfolders and sites, or
 * every site underneath ("Include subfolders"), sorted by name, address, protocol or last use.
 * Subfolders always come first, Local first among the sites. Pure (unit-tested under node).
 */
import type { ConnectionConfig } from '../../types.ts';
import type { FolderNode, TreeModel } from './types.ts';
import { folderKey, isLocalSite, naturalCompare, protocolRank, siteKey, sitesInside } from './siteTreeModel.ts';

export type TableSort = 'name' | 'address' | 'protocol' | 'last';
export type SortDir = 'asc' | 'desc';

export type TableRow = { kind: 'folder'; key: string; node: FolderNode } | { kind: 'site'; key: string; site: ConnectionConfig; folder: string };

export interface TableOptions {
  /** Every site underneath, without folders */
  flat: boolean;
  sort: TableSort;
  dir: SortDir;
}

/** The direction a column starts in: newest first for "Last connected", A→Z otherwise. */
export const defaultDir = (sort: TableSort): SortDir => (sort === 'last' ? 'desc' : 'asc');

const byName = (a: string, b: string) => naturalCompare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** Last use as a sortable number: a time, then entries with no time (seeded), then never used. */
const lastRank = (model: TreeModel, id: string): number => {
  if (!model.recentAt.has(id)) return -2;
  return model.recentAt.get(id) ?? -1;
};

export function folderTableRows(model: TreeModel, path: string, opts: TableOptions): TableRow[] {
  const node = model.folders.get(path);
  if (!node) return [];
  const sign = opts.dir === 'desc' ? -1 : 1;

  let sites: ConnectionConfig[];
  if (opts.flat) {
    sites = sitesInside(model, path);
    if (!path && model.local) sites.unshift(model.local);
  } else {
    sites = [...node.sites];
  }
  const folders = opts.flat ? [] : [...node.folders];

  const siteCompare = (a: ConnectionConfig, b: ConnectionConfig): number => {
    const name = byName(a.name || '', b.name || '') || byName(a.id, b.id);
    switch (opts.sort) {
      case 'address':
        // Server, then port, then user (like the tree's "Server address" sort)
        return sign * (byName(a.host || '', b.host || '') || (a.port || 0) - (b.port || 0) || byName(a.username || '', b.username || '') || name);
      case 'protocol':
        return sign * (protocolRank(a.protocol) - protocolRank(b.protocol) || name);
      case 'last':
        // Ties (never used) stay A→Z whatever the direction
        return sign * (lastRank(model, a.id) - lastRank(model, b.id)) || name;
      default:
        return sign * name;
    }
  };
  const folderCompare = (a: FolderNode, b: FolderNode): number => {
    const name = byName(a.name, b.name);
    if (opts.sort === 'last') return sign * ((a.lastAt ?? -1) - (b.lastAt ?? -1)) || name;
    // Folders have no address or protocol: they keep their name order then
    return opts.sort === 'name' ? sign * name : name;
  };

  const local = sites.filter(isLocalSite);
  const rest = sites.filter((s) => !isLocalSite(s)).sort(siteCompare);
  folders.sort(folderCompare);
  return [
    ...folders.map((f): TableRow => ({ kind: 'folder', key: folderKey(f.path), node: f })),
    ...[...local, ...rest].map((s): TableRow => ({ kind: 'site', key: siteKey(s.id), site: s, folder: model.siteFolder.get(s.id) ?? '' })),
  ];
}
