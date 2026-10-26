/**
 * Browser-only stand-ins for the connections-tree commands, used by `devFallback.ts` when the UI
 * runs in vite dev / preview instead of Tauri. Never loaded inside the desktop app.
 *
 * - `?demoSites=N` makes `get_saved_sites` return Local plus N deterministic demo sites
 *   (mulberry32, seed 42): folders up to 6 levels deep, every protocol, accented names,
 *   hosts under `example.test`, about 10% duplicates and 15% with no saved password.
 * - The six tree commands run against an in-memory copy of the saved sites, reusing the pure
 *   model (`applyOpsLocally`), with server-style copies, an undo stack (20 entries, 15 minutes)
 *   and a three-way undo like the backend's.
 * - `?siteLatency=ms` delays the tree commands, to watch optimistic updates.
 *
 * Contains no real hosts or credentials: secrets are the stored-secret marker.
 */
import type { ConnectionConfig, Protocol } from '../../types.ts';
import type { FavoriteRef, LabelDef, SiteLayout, SiteLayoutResponse, SiteTreeOp, SiteTreeResult, SiteTreeViewPatch } from './types.ts';
import { STORED_SECRET } from '../../utils/secrets.ts';
import {
  LOCAL_ID,
  MAX_COLLAPSED,
  MAX_RECENTS,
  applyOpsLocally,
  coerceLayout,
  defaultLayout,
  folderChain,
  normalizeGroup,
  reconcileLayout,
} from './siteTreeModel.ts';

/** The commands `site_tree.rs` registers. */
export const SITE_TREE_CMDS: ReadonlySet<string> = new Set([
  'get_site_layout',
  'apply_site_tree_ops',
  'undo_site_tree_ops',
  'forget_site_tree_undo',
  'set_site_tree_view',
  'record_site_connected',
]);

const MAX_DEMO_SITES = 20_000;
const UNDO_LIMIT = 20;
const UNDO_TTL_MS = 15 * 60 * 1000;

const queryParam = (name: string): string | null => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(name);
  } catch {
    return null;
  }
};

/** N from `?demoSites=N` (0 when absent or invalid). */
export function demoSiteCount(): number {
  const n = Number(queryParam('demoSites'));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_DEMO_SITES) : 0;
}

/* -------------------------------------------------------------------------- */
/* Demo library                                                                */
/* -------------------------------------------------------------------------- */

/** Small fast seeded PRNG (returns [0, 1)). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOP_FOLDERS = ['Produção', 'Staging', 'Clientes', 'Infra', 'São Paulo', 'Ação Social', 'Personal', 'Legacy', 'Lab'];
const SUB_FOLDERS = [
  'Web',
  'Banco de dados',
  'Região Sul',
  'Região Norte',
  'Acme',
  'Globex',
  'Initech',
  'Umbrella',
  'Edge',
  'Backups',
  'Mídia',
  'Logística',
  'Data center 1',
  'Data center 2',
  'Rack 07',
  'Rack 12',
  'Cluster A',
  'Cluster B',
  'Ação',
  'Fase 2',
  'Canary',
  'Old',
];
/** A full 6-level chain, so the deepest indentation always shows up */
const DEEP_CHAIN = 'Clientes/Acme/Região Sul/São Paulo/Data center 2/Rack 07';
const ROLES = ['web', 'db', 'api', 'cache', 'mail', 'backup', 'files', 'deploy', 'ci', 'proxy', 'vpn', 'logs', 'media', 'auth', 'queue'];
const CITIES = ['São Paulo', 'Brasília', 'Florianópolis', 'Goiânia', 'Belém', 'Curitiba', 'Zürich', 'Kraków', 'Málaga', 'Ação'];
const USERS = ['deploy', 'root', 'admin', 'ubuntu', 'www-data', 'backup', 'ops', 'joão', 'maria', 'ci'];
const REGIONS = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-south-1'];

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const localSite = (): ConnectionConfig => ({
  id: LOCAL_ID,
  name: 'Local Machine',
  protocol: 'local',
  host: 'localhost',
  port: 0,
  username: 'user',
  auth: { type: 'None', value: null },
  remote_root: '/',
  tls_fingerprint: null,
  group: null,
});

/** Folder paths for a library of `n` sites (about one folder per 23 sites, at most 6 levels). */
function demoFolders(n: number, rand: () => number): string[] {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const target = Math.max(8, Math.min(1500, Math.round(n / 23)));
  const folders: string[] = [...TOP_FOLDERS];
  const set = new Set(folders);
  for (const p of folderChain(DEEP_CHAIN)) {
    if (set.has(p)) continue;
    set.add(p);
    folders.push(p);
  }
  let guard = 0;
  while (folders.length < target && guard++ < target * 50) {
    const parent = pick(folders);
    if (parent.split('/').length >= 6) continue;
    const name = rand() < 0.15 ? `${pick(SUB_FOLDERS)} ${1 + Math.floor(rand() * 9)}` : pick(SUB_FOLDERS);
    const path = `${parent}/${name}`;
    if (set.has(path)) continue;
    set.add(path);
    folders.push(path);
  }
  return folders;
}

const pickProtocol = (r: number): Protocol => (r < 0.62 ? 'sftp' : r < 0.74 ? 'ftps' : r < 0.82 ? 'ftp' : r < 0.92 ? 's3' : 'webdav');

/**
 * Local plus `n` deterministic demo sites (the same list on every call), as `get_saved_sites`
 * returns them: saved secrets are the stored-secret marker.
 */
export function demoSites(n: number): ConnectionConfig[] {
  const count = Math.max(0, Math.min(Math.floor(n), MAX_DEMO_SITES));
  const rand = mulberry32(42);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const folders = demoFolders(count, rand);
  const sites: ConnectionConfig[] = [localSite()];
  const roleCounters = new Map<string, number>();

  for (let i = 0; i < count; i++) {
    const id = `demo-${i + 1}`;
    const group = rand() < 0.05 ? null : pick(folders);
    const env = group ? slug(group.split('/')[0]) : 'misc';

    // About 10% repeat the server of an earlier site (is:dup)
    if (i > 10 && rand() < 0.1) {
      const src = sites[1 + Math.floor(rand() * (sites.length - 1))];
      sites.push({ ...src, id, name: `${src.name} (old)`, group, auth: { ...src.auth } });
      continue;
    }

    const protocol = pickProtocol(rand());
    const role = pick(ROLES);
    const k = (roleCounters.get(role) ?? 0) + 1;
    roleCounters.set(role, k);
    const num = String(k).padStart(2, '0');
    const name =
      rand() < 0.2
        ? `Servidor ${pick(CITIES)} ${k}`
        : rand() < 0.08
          ? `Produção ${role} ${num}`
          : `${role}-${num}`;
    const noPassword = rand() < 0.15;
    const custom = rand() < 0.1;

    let site: ConnectionConfig;
    if (protocol === 's3') {
      const region = pick(REGIONS);
      site = {
        id,
        name,
        protocol,
        host: `s3.${region}.example.test`,
        port: 443,
        username: `AKIAEXAMPLE${String(i).padStart(6, '0')}`,
        auth: { type: 'Password', value: noPassword ? '' : STORED_SECRET },
        remote_root: `/${env}-${role}-${num}`,
        tls_fingerprint: null,
        group,
      };
    } else {
      const host =
        protocol === 'webdav' ? `dav-${role}${num}.${env}.example.test` : protocol === 'sftp' ? `${role}-${num}.${env}.example.test` : `ftp-${role}${num}.${env}.example.test`;
      const port =
        protocol === 'sftp' ? (custom ? pick([2222, 2200, 8022]) : 22) : protocol === 'webdav' ? (custom ? 8443 : 443) : custom ? 2121 : 21;
      const anonymous = (protocol === 'ftp' || protocol === 'ftps') && rand() < 0.1;
      const username = anonymous ? 'anonymous' : pick(USERS);
      let auth: ConnectionConfig['auth'];
      if (noPassword) auth = { type: 'Password', value: '' };
      else if (protocol === 'sftp') {
        const r = rand();
        auth =
          r < 0.55
            ? { type: 'Password', value: STORED_SECRET }
            : r < 0.85
              ? { type: 'PrivateKey', value: { path: pick(['~/.ssh/id_ed25519', '~/.ssh/id_rsa', '~/.ssh/deploy_key']), passphrase: rand() < 0.3 ? STORED_SECRET : null } }
              : { type: 'None', value: null };
      } else auth = anonymous ? { type: 'None', value: null } : { type: 'Password', value: STORED_SECRET };
      site = {
        id,
        name,
        protocol,
        host,
        port,
        username,
        auth,
        remote_root: protocol === 'sftp' && rand() < 0.4 ? pick(['/var/www', '/srv/app', '/home/deploy']) : '',
        tls_fingerprint: null,
        group,
      };
    }
    sites.push(site);
  }
  return sites;
}

/** A layout that exercises every row kind: empty folders, favorites, recents and labels. */
function demoLayout(sites: ConnectionConfig[]): SiteLayout {
  const rand = mulberry32(7);
  const saved = sites.filter((s) => s.id !== LOCAL_ID);
  const pickSite = () => saved[Math.floor(rand() * saved.length)];
  const layout = defaultLayout();
  layout.folders = ['Arquivo/2019', 'Staging/Novos projetos', 'Lab/Vazia'];
  if (saved.length === 0) return layout;

  const favorites: FavoriteRef[] = [];
  for (let i = 0; i < 4; i++) favorites.push({ kind: 'site', id: pickSite().id });
  favorites.push({ kind: 'folder', path: 'Infra' });
  layout.favorites = favorites;

  const nowSecs = Math.floor(Date.now() / 1000);
  const ages = [40, 600, 5_400, 26_000, 90_000, 200_000, 400_000, 700_000, 1_500_000, 3_000_000];
  layout.recents = ages.map((age, i) => ({ id: pickSite().id, at: nowSecs - age, count: 10 - i }));

  const labels: LabelDef[] = [
    { id: 'label-demo-prod', name: 'Production', color: 'red' },
    { id: 'label-demo-staging', name: 'Staging', color: 'yellow' },
    { id: 'label-demo-dev', name: 'Development', color: 'green' },
  ];
  layout.labels = labels;
  layout.folder_labels = { Produção: 'label-demo-prod', Staging: 'label-demo-staging' };
  for (let i = 0; i < 6; i++) layout.site_labels[pickSite().id] = 'label-demo-dev';
  return layout;
}

/* -------------------------------------------------------------------------- */
/* In-memory backend                                                           */
/* -------------------------------------------------------------------------- */

interface UndoEntry {
  token: string;
  label: string | null;
  created: number;
  /** Touched site id → the site before (`null`: did not exist) */
  sitesBefore: Map<string, ConnectionConfig | null>;
  /** Touched site id → stable JSON after (`null`: did not exist) */
  sitesAfter: Map<string, string | null>;
  layoutBefore: SiteLayout;
  layoutAfter: SiteLayout;
}

interface Store {
  sites: ConnectionConfig[];
  layout: SiteLayout;
  undo: UndoEntry[];
}

let store: Store | null = null;

const clone = <T,>(v: T): T => structuredClone(v);

/** JSON with sorted object keys, so equal values compare equal (like `serde_json::to_value`). */
const stableJson = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  );

const randomHex = (): string => {
  try {
    return globalThis.crypto.randomUUID().replace(/-/g, '');
  } catch {
    return Math.random().toString(16).slice(2).padEnd(32, '0');
  }
};

function ensureStore(seed: () => unknown): Store {
  if (store) return store;
  const raw = seed();
  const sites = Array.isArray(raw) ? (raw as ConnectionConfig[]).map(clone) : [];
  const layout = demoSiteCount() > 0 ? demoLayout(sites) : defaultLayout();
  store = { sites, layout: reconcileLayout(layout, sites), undo: [] };
  return store;
}

const treeResult = (s: Store, extra: Partial<SiteTreeResult>): SiteTreeResult => ({
  sites: clone(s.sites),
  layout: clone(s.layout),
  undo_token: null,
  created: [],
  undo_report: null,
  warnings: [],
  ...extra,
});

/** Error text exactly as Tauri delivers it: a `"[code] message"` string. */
const rejectWith = (code: string, message: string): never => {
  throw `[${code}] ${message}`;
};

const runOps = (s: Store, ops: SiteTreeOp[]) => {
  try {
    return applyOpsLocally(s.sites, s.layout, Array.isArray(ops) ? ops : [], { newId: () => `site-${randomHex()}` });
  } catch (e) {
    throw e instanceof Error ? e.message : String(e);
  }
};

function applyOps(s: Store, ops: SiteTreeOp[], label: string | null): SiteTreeResult {
  const outcome = runOps(s, ops);
  // Like the backend: a batch that changes nothing gets no undo entry
  if (!outcome.sitesChanged && !outcome.layoutChanged) return treeResult(s, {});
  const before = new Map(s.sites.map((x) => [x.id, x]));
  const after = new Map(outcome.sites.map((x) => [x.id, x]));
  const sitesBefore = new Map<string, ConnectionConfig | null>();
  const sitesAfter = new Map<string, string | null>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(id) ?? null;
    const a = after.get(id) ?? null;
    if (b && a && stableJson(b) === stableJson(a)) continue;
    sitesBefore.set(id, b ? clone(b) : null);
    sitesAfter.set(id, a ? stableJson(a) : null);
  }
  const token = `undo-${randomHex()}`;
  const now = Date.now();
  s.undo = s.undo.filter((u) => now - u.created < UNDO_TTL_MS);
  s.undo.push({ token, label, created: now, sitesBefore, sitesAfter, layoutBefore: clone(s.layout), layoutAfter: clone(outcome.layout) });
  if (s.undo.length > UNDO_LIMIT) s.undo.splice(0, s.undo.length - UNDO_LIMIT);
  s.sites = outcome.sites;
  s.layout = outcome.layout;
  return treeResult(s, { undo_token: token, created: outcome.created });
}

/** Puts back presence (`before`) wherever the current state still matches what the op left. */
const restorePresence = (cur: string[], before: string[], after: string[]): string[] => {
  const b = new Set(before);
  const a = new Set(after);
  const out = new Set(cur);
  for (const key of new Set([...b, ...a])) {
    if (out.has(key) !== a.has(key)) continue;
    if (b.has(key)) out.add(key);
    else out.delete(key);
  }
  return [...out];
};

const restoreValues = (cur: Record<string, string>, before: Record<string, string>, after: Record<string, string>): Record<string, string> => {
  const out = { ...cur };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (out[key] !== after[key]) continue;
    if (key in before) out[key] = before[key];
    else delete out[key];
  }
  return out;
};

const favKey = (f: FavoriteRef) => (f.kind === 'site' ? `s:${f.id}` : `f:${f.path}`);

/**
 * Rust `restore_list`: the whole list when it is still exactly as the batch left it (so a reorder
 * is undone too), else entry presence by `key`, re-inserting at the old index.
 */
function restoreList<T>(cur: T[], before: T[], after: T[], key: (item: T) => string): T[] {
  const same = (a: T | undefined, b: T | undefined) => stableJson(a ?? null) === stableJson(b ?? null);
  if (cur.length === after.length && cur.every((c, i) => same(c, after[i]))) return clone(before);
  let out = [...cur];
  // Entries the batch added or changed: drop them if they are still as it left them
  for (const item of after) {
    const inBefore = before.find((b) => key(b) === key(item));
    if (!same(inBefore, item)) out = out.filter((c) => !same(c, item));
  }
  // Entries the batch removed or changed: put them back if the key is free
  before.forEach((item, i) => {
    const inAfter = after.find((a) => key(a) === key(item));
    if (!same(inAfter, item) && !out.some((c) => key(c) === key(item))) out.splice(Math.min(i, out.length), 0, clone(item));
  });
  return out;
}

/** Rust `undo`'s layout part: per-key three-way restore. */
function restoreLayout(cur: SiteLayout, before: SiteLayout, after: SiteLayout): SiteLayout {
  const next = clone(cur);
  next.folders = restorePresence(cur.folders, before.folders, after.folders);
  next.collapsed = restorePresence(cur.collapsed, before.collapsed, after.collapsed);
  next.favorites = restoreList(cur.favorites, before.favorites, after.favorites, favKey);
  next.recents = restoreList(cur.recents, before.recents, after.recents, (r) => r.id);
  next.site_labels = restoreValues(cur.site_labels, before.site_labels, after.site_labels);
  next.folder_labels = restoreValues(cur.folder_labels, before.folder_labels, after.folder_labels);
  next.labels = restoreList(cur.labels, before.labels, after.labels, (l) => l.id);
  return next;
}

function undo(s: Store, token: string): SiteTreeResult {
  const now = Date.now();
  const i = s.undo.findIndex((u) => u.token === token);
  const entry = i >= 0 ? s.undo[i] : null;
  if (i >= 0) s.undo.splice(i, 1);
  if (!entry || now - entry.created >= UNDO_TTL_MS) return rejectWith('site_tree.undo_expired', 'This change can no longer be undone');

  let restored = 0;
  let skipped = 0;
  for (const [id, before] of entry.sitesBefore) {
    const idx = s.sites.findIndex((x) => x.id === id);
    const current = idx >= 0 ? stableJson(s.sites[idx]) : null;
    if (current !== (entry.sitesAfter.get(id) ?? null)) {
      skipped++;
      continue;
    }
    if (before && idx >= 0) s.sites[idx] = clone(before);
    else if (before) s.sites.push(clone(before));
    else if (idx >= 0) s.sites.splice(idx, 1);
    restored++;
  }
  s.layout = reconcileLayout(restoreLayout(s.layout, entry.layoutBefore, entry.layoutAfter), s.sites);
  return treeResult(s, { undo_report: { restored, skipped } });
}

function setView(s: Store, view: SiteTreeViewPatch): null {
  const v = view ?? {};
  const layout = clone(s.layout);
  if (Array.isArray(v.collapsed)) layout.collapsed = [...new Set(v.collapsed.map((p) => normalizeGroup(p)).filter(Boolean))].slice(0, MAX_COLLAPSED);
  if (Array.isArray(v.forget_recents)) {
    const forget = new Set(v.forget_recents);
    layout.recents = layout.recents.filter((r) => !forget.has(r.id));
  }
  if (v.clear_recents) layout.recents = [];
  if (Array.isArray(v.seed_recents) && layout.recents.length === 0) {
    const ids = new Set(s.sites.map((x) => x.id));
    const seen = new Set<string>();
    for (const id of v.seed_recents) {
      if (id === LOCAL_ID || !ids.has(id) || seen.has(id) || seen.size >= MAX_RECENTS) continue;
      seen.add(id);
      layout.recents.push({ id, at: null, count: 0 });
    }
  }
  if (typeof v.migrated_local_storage === 'boolean') layout.migrated_local_storage = v.migrated_local_storage;
  if (typeof v.large_library_collapsed === 'boolean') layout.large_library_collapsed = v.large_library_collapsed;
  s.layout = reconcileLayout(layout, s.sites);
  return null;
}

function recordConnected(s: Store, id: string): null {
  if (id === LOCAL_ID || !s.sites.some((x) => x.id === id)) return rejectWith('site_tree.not_found', 'Not a saved connection');
  const prev = s.layout.recents.find((r) => r.id === id);
  const entry = { id, at: Math.floor(Date.now() / 1000), count: (prev?.count ?? 0) + 1 };
  s.layout = { ...s.layout, recents: [entry, ...s.layout.recents.filter((r) => r.id !== id)].slice(0, MAX_RECENTS) };
  return null;
}

/** Keeps the in-memory copy in step with the existing site commands (their mocks return `{}`). */
function noteSiteWrite(s: Store, cmd: string, args: Record<string, unknown> | undefined) {
  if (cmd === 'save_site') {
    const cfg = args?.config as ConnectionConfig | undefined;
    if (!cfg || typeof cfg.id !== 'string') return;
    const i = s.sites.findIndex((x) => x.id === cfg.id);
    if (i >= 0) s.sites[i] = clone(cfg);
    else s.sites.push(clone(cfg));
    s.layout = reconcileLayout(s.layout, s.sites);
  } else if (cmd === 'delete_site') {
    const id = args?.id;
    if (typeof id !== 'string' || id === LOCAL_ID) return;
    s.sites = s.sites.filter((x) => x.id !== id);
    s.layout = reconcileLayout(s.layout, s.sites);
  }
}

function runCommand(s: Store, cmd: string, args: Record<string, unknown> | undefined): unknown {
  switch (cmd) {
    case 'get_site_layout': {
      s.layout = reconcileLayout(coerceLayout(s.layout), s.sites);
      const res: SiteLayoutResponse = { layout: clone(s.layout), read_only: false, warning: null };
      return res;
    }
    case 'apply_site_tree_ops':
      return applyOps(s, args?.ops as SiteTreeOp[], typeof args?.label === 'string' ? args.label : null);
    case 'undo_site_tree_ops':
      return undo(s, String(args?.token ?? ''));
    case 'forget_site_tree_undo':
      s.undo = [];
      return null;
    case 'set_site_tree_view':
      return setView(s, args?.view as SiteTreeViewPatch);
    case 'record_site_connected':
      return recordConnected(s, String(args?.id ?? ''));
    default:
      return null;
  }
}

const latencyMs = (): number => {
  const n = Number(queryParam('siteLatency'));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 0;
};

export type SiteFallbackResult = { handled: true; value: unknown } | { handled: false };

/**
 * Entry point for `devFallback.ts`. Handles the six tree commands and, once the in-memory copy
 * exists, `get_saved_sites`; mirrors `save_site` / `delete_site` into it without handling them.
 * `savedSites` returns the default site list (it is called once, to seed the copy).
 */
export function siteFallback(cmd: string, args: Record<string, unknown> | undefined, savedSites: () => unknown): SiteFallbackResult {
  if (cmd === 'get_saved_sites') return store ? { handled: true, value: clone(store.sites) } : { handled: false };
  if (cmd === 'save_site' || cmd === 'delete_site') {
    noteSiteWrite(ensureStore(savedSites), cmd, args);
    return { handled: false };
  }
  if (!SITE_TREE_CMDS.has(cmd)) return { handled: false };

  const s = ensureStore(savedSites);
  const delay = latencyMs();
  if (delay === 0) return { handled: true, value: runCommand(s, cmd, args) };
  // A promise is fine here: callers await the fallback's value
  return {
    handled: true,
    value: new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(runCommand(s, cmd, args));
        } catch (e) {
          reject(e);
        }
      }, delay);
    }),
  };
}

/** Test hook: forgets the in-memory copy. */
export function resetSiteFallback(): void {
  store = null;
}
