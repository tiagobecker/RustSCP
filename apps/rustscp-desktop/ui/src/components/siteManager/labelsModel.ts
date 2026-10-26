/**
 * Environment labels (spec §14): one optional label per site and per folder; a folder's label
 * applies to everything inside unless a nearer item has its own. Pure helpers for the Label ▸
 * submenus, the Labels dialog and the dots.
 *
 * Erasable TypeScript only: the unit tests run under `node --test` with type stripping.
 */
import type { ConnectionConfig } from '../../types.ts';
import type { LabelColor, LabelDef, SiteLayout, SiteTreeOp, TreeModel } from './types.ts';
import { LABEL_COLORS } from './types.ts';
import { LOCAL_ID, MAX_LABELS, MAX_LABEL_NAME_LEN, charLength, fold, folderChain, isLocalSite, normalizeGroup, parseItemKey } from './siteTreeModel.ts';

/** Dot colours (literal class names, so Tailwind keeps them). */
export const LABEL_DOT_CLASS: Record<LabelColor, string> = {
  red: 'bg-red-500/80',
  orange: 'bg-orange-500/80',
  yellow: 'bg-amber-400/90',
  green: 'bg-emerald-500/80',
  blue: 'bg-sky-500/80',
  purple: 'bg-violet-500/80',
  gray: 'bg-stone-400',
};

/** i18n key and English name of each colour (the swatch picker). */
export const LABEL_COLOR_NAMES: Record<LabelColor, [string, string]> = {
  red: ['siteTree.colorRed', 'Red'],
  orange: ['siteTree.colorOrange', 'Orange'],
  yellow: ['siteTree.colorYellow', 'Yellow'],
  green: ['siteTree.colorGreen', 'Green'],
  blue: ['siteTree.colorBlue', 'Blue'],
  purple: ['siteTree.colorPurple', 'Purple'],
  gray: ['siteTree.colorGray', 'Gray'],
};

export interface LabelPreset {
  /** i18n key of the name */
  key: string;
  /** English name (the i18n default) */
  name: string;
  color: LabelColor;
}

/** Offered by Label ▸ before any label exists; defined on first use (translated names). */
export const LABEL_PRESETS: readonly LabelPreset[] = [
  { key: 'siteTree.labelProduction', name: 'Production', color: 'red' },
  { key: 'siteTree.labelStaging', name: 'Staging', color: 'yellow' },
  { key: 'siteTree.labelDevelopment', name: 'Development', color: 'green' },
  { key: 'siteTree.labelTesting', name: 'Testing', color: 'blue' },
  { key: 'siteTree.labelPersonal', name: 'Personal', color: 'gray' },
];

/** A new label id the backend accepts (`label-` and 32 hex digits). */
export const newLabelId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const hex =
    typeof c?.randomUUID === 'function'
      ? c.randomUUID().replace(/-/g, '')
      : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `label-${hex}`;
};

/** Defined labels in their stored order. */
export const labelList = (model: Pick<TreeModel, 'labels'>): LabelDef[] => [...model.labels.values()];

/** The folder whose own label `path` (or a site in it) inherits: the nearest one with a label, or null. */
export const labelSourceFolder = (model: Pick<TreeModel, 'folders'>, path: string): string | null => {
  const chain = folderChain(path);
  for (let i = chain.length - 1; i >= 0; i--) if (model.folders.get(chain[i])?.label) return chain[i];
  return null;
};

/** One item's own label and what it would inherit without it. */
interface ItemLabel {
  own: string | null;
  inherited: string | null;
  from: string | null;
}

const itemLabel = (model: TreeModel, itemKey: string): ItemLabel | null => {
  const ref = parseItemKey(itemKey);
  if (ref?.kind === 'site') {
    const site = model.sitesById.get(ref.id);
    if (!site) return null;
    const folder = isLocalSite(site) ? '' : model.siteFolder.get(site.id) ?? '';
    const from = folder ? labelSourceFolder(model, folder) : null;
    return { own: model.siteOwnLabel.get(site.id) ?? null, inherited: from ? model.folders.get(from)?.label ?? null : null, from };
  }
  if (ref?.kind === 'folder') {
    const node = model.folders.get(ref.path);
    if (!node || !node.path) return null;
    const from = node.parent ? labelSourceFolder(model, node.parent) : null;
    return { own: node.label, inherited: from ? model.folders.get(from)?.label ?? null : null, from };
  }
  return null;
};

export interface LabelChoiceState {
  /** Items that can carry a label */
  count: number;
  /** Their own label: an id, null for none, 'mixed' when they differ */
  own: string | null | 'mixed';
  /** What they inherit from their folders (when it is the same for all), else null */
  inherited: LabelDef | null;
  /** The folder it comes from (when it is the same for all) */
  inheritedFrom: string | null;
}

/** State of a Label ▸ submenu for these canonical item keys (`s:<id>`, `f:<path>`). */
export function labelChoiceState(model: TreeModel, itemKeys: Iterable<string>): LabelChoiceState {
  let count = 0;
  let own: string | null | 'mixed' = null;
  let inherited: string | null | 'mixed' = null;
  let from: string | null | 'mixed' = null;
  for (const key of new Set(itemKeys)) {
    const item = itemLabel(model, key);
    if (!item) continue;
    if (count === 0) {
      own = item.own;
      inherited = item.inherited;
      from = item.from;
    } else {
      if (own !== item.own) own = 'mixed';
      if (inherited !== item.inherited) inherited = 'mixed';
      if (from !== item.from) from = 'mixed';
    }
    count++;
  }
  const def = inherited && inherited !== 'mixed' ? model.labels.get(inherited) ?? null : null;
  return { count, own, inherited: def, inheritedFrom: def && from !== 'mixed' ? from : null };
}

export type LabelChoice = { kind: 'none' } | { kind: 'label'; id: string } | { kind: 'preset'; name: string; color: LabelColor };

export interface LabelPlan {
  ops: SiteTreeOp[];
  /** The label the items end up with (null: none) */
  labelId: string | null;
  /** A preset that had to be defined first */
  created: LabelDef | null;
}

/**
 * One batch that gives the items a label (or takes their own away): a preset not defined yet is
 * added first (`set_label_defs`, then `set_label`), so one Undo removes both. A preset whose name
 * is already a label (ignoring case and accents) reuses it. Null when there is nothing to do, or
 * 'too_many' when a new label would pass the limit of 12.
 */
export function planSetLabel(model: TreeModel, itemKeys: Iterable<string>, choice: LabelChoice, newId: () => string = newLabelId): LabelPlan | 'too_many' | null {
  const sites: string[] = [];
  const folders: string[] = [];
  for (const key of new Set(itemKeys)) {
    const ref = parseItemKey(key);
    if (ref?.kind === 'site' && model.sitesById.has(ref.id)) sites.push(ref.id);
    else if (ref?.kind === 'folder' && ref.path && model.folders.has(ref.path)) folders.push(ref.path);
  }
  if (sites.length === 0 && folders.length === 0) return null;
  const ops: SiteTreeOp[] = [];
  let labelId: string | null = null;
  let created: LabelDef | null = null;
  if (choice.kind === 'label') {
    if (!model.labels.has(choice.id)) return null;
    labelId = choice.id;
  } else if (choice.kind === 'preset') {
    const list = labelList(model);
    const name = choice.name.trim();
    const same = list.find((l) => fold(l.name) === fold(name));
    if (same) labelId = same.id;
    else {
      if (list.length >= MAX_LABELS) return 'too_many';
      created = { id: newId(), name, color: choice.color };
      labelId = created.id;
      ops.push({ op: 'set_label_defs', labels: [...list, created] });
    }
  }
  const op: Extract<SiteTreeOp, { op: 'set_label' }> = { op: 'set_label', label: labelId };
  if (sites.length) op.sites = sites;
  if (folders.length) op.folders = folders;
  ops.push(op);
  return { ops, labelId, created };
}

/**
 * Presets whose name is not a label yet. `alt` is the preset's English name: a label made while
 * the app spoke English ("Production") still counts after switching to Portuguese ("Produção").
 */
export const unusedPresets = <T extends { name: string; alt?: string }>(model: Pick<TreeModel, 'labels'>, presets: readonly T[]): T[] => {
  const taken = new Set(labelList(model).map((l) => fold(l.name.trim())));
  return presets.filter((p) => !taken.has(fold(p.name.trim())) && !(p.alt && taken.has(fold(p.alt.trim()))));
};

/** Items carrying each label as their own (inherited ones not counted). */
export function labelUsage(model: TreeModel): Map<string, { sites: number; folders: number }> {
  const out = new Map<string, { sites: number; folders: number }>();
  const bump = (id: string, kind: 'sites' | 'folders') => {
    const u = out.get(id) ?? { sites: 0, folders: 0 };
    u[kind]++;
    out.set(id, u);
  };
  for (const id of model.siteOwnLabel.values()) bump(id, 'sites');
  for (const node of model.folders.values()) if (node.path && node.label) bump(node.label, 'folders');
  return out;
}

export type LabelNameProblem = 'empty' | 'too_long' | 'control' | 'duplicate';

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Problems of an edited label list, by index (the Labels dialog); an empty map when it can be saved. */
export function labelDefsProblems(defs: readonly Pick<LabelDef, 'name'>[]): Map<number, LabelNameProblem> {
  const out = new Map<number, LabelNameProblem>();
  const seen = new Map<string, number>();
  defs.forEach((d, i) => {
    const name = d.name.trim();
    if (!name) out.set(i, 'empty');
    else if (CONTROL_RE.test(name)) out.set(i, 'control');
    else if (charLength(name) > MAX_LABEL_NAME_LEN) out.set(i, 'too_long');
    else {
      const k = fold(name);
      if (seen.has(k)) out.set(i, 'duplicate');
      else seen.set(k, i);
    }
  });
  return out;
}

/** True when two label lists are the same (names compared trimmed). */
export const sameLabelDefs = (a: readonly LabelDef[], b: readonly LabelDef[]): boolean =>
  a.length === b.length && a.every((l, i) => l.id === b[i].id && l.name.trim() === b[i].name.trim() && l.color === b[i].color);

/** What "Add label" starts with: the next preset not in the list, else an empty name in an unused colour. */
export function nextNewLabel<T extends { name: string; color: LabelColor; alt?: string }>(defs: readonly Pick<LabelDef, 'name' | 'color'>[], presets: readonly T[]): { name: string; color: LabelColor } {
  const names = new Set(defs.map((d) => fold(d.name.trim())));
  const preset = presets.find((p) => !names.has(fold(p.name.trim())) && !(p.alt && names.has(fold(p.alt.trim()))));
  if (preset) return { name: preset.name, color: preset.color };
  const colors = new Set(defs.map((d) => d.color));
  return { name: '', color: LABEL_COLORS.find((c) => !colors.has(c)) ?? 'gray' };
}

/** Effective label of a site (own, else inherited), for the form's pill. */
export function siteLabelInfo(model: TreeModel, site: Pick<ConnectionConfig, 'id'>): { def: LabelDef; from: string | null } | null {
  const id = model.siteLabel.get(site.id);
  const def = id ? model.labels.get(id) : undefined;
  if (!def) return null;
  if (model.siteOwnLabel.get(site.id) === id) return { def, from: null };
  const folder = model.siteFolder.get(site.id) ?? '';
  return { def, from: folder ? labelSourceFolder(model, folder) : null };
}

/**
 * Effective label of a saved site read straight from the layout (the form's pill, outside the
 * tree): its own label, else the nearest labelled folder of `group`. Local inherits nothing.
 */
export function layoutSiteLabel(
  layout: Pick<SiteLayout, 'labels' | 'site_labels' | 'folder_labels'>,
  siteId: string,
  group: string | null | undefined
): { def: LabelDef; from: string | null } | null {
  const defs = new Map(layout.labels.map((l) => [l.id, l]));
  const own = layout.site_labels[siteId];
  const ownDef = own ? defs.get(own) : undefined;
  if (ownDef) return { def: ownDef, from: null };
  if (siteId === LOCAL_ID) return null;
  const chain = folderChain(normalizeGroup(group));
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = layout.folder_labels[chain[i]];
    const def = id ? defs.get(id) : undefined;
    if (def) return { def, from: chain[i] };
  }
  return null;
}
