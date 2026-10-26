import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../../types.ts';
import type { FlattenState, SiteLayout, SiteTreeOp, TreeRow } from './types.ts';
import {
  SiteTreeOpError,
  applyOpsLocally,
  authKind,
  baseName,
  buildTree,
  coerceLayout,
  copyAddress,
  defaultLayout,
  duplicateKey,
  effectiveDensity,
  flattenRows,
  folderChain,
  folderChildren,
  folderNameProblem,
  needsPassword,
  normalizeFolderPathStrict,
  normalizeGroup,
  opsAreOptimistic,
  parentOf,
  parseViewPrefs,
  pickFreeName,
  reconcileLayout,
  recentAge,
  rowFolderPath,
  siteAddress,
  sitesInside,
} from './siteTreeModel.ts';

const STORED = '__RUSTSCP_STORED_SECRET__';

const site = (id: string, group: string | null = null, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: id,
  protocol: 'sftp',
  host: `${id}.example.test`,
  port: 22,
  username: 'deploy',
  auth: { type: 'Password', value: STORED },
  remote_root: '',
  tls_fingerprint: null,
  group,
  ...over,
});

const LOCAL: ConnectionConfig = {
  id: 'local',
  name: 'Local Machine',
  protocol: 'local',
  host: 'localhost',
  port: 0,
  username: 'user',
  auth: { type: 'None', value: null },
  remote_root: '/',
  tls_fingerprint: null,
  group: null,
};

/** Same fixture as the Rust tests in site_layout.rs */
const library = (): ConnectionConfig[] => [LOCAL, site('web-01', 'Clients/Acme/Web'), site('db-01', 'Clients/Acme'), site('solo'), site('stg', 'Staging')];

const layoutWith = (over: Partial<SiteLayout>): SiteLayout => ({ ...defaultLayout(), ...over });
const groupOf = (sites: ConnectionConfig[], id: string) => sites.find((s) => s.id === id)?.group ?? null;
const keys = (rows: TreeRow[]) => rows.map((r) => r.key);

const counter = () => {
  let n = 0;
  return () => `copy-${++n}`;
};

const run = (sites: ConnectionConfig[], layout: SiteLayout, ops: SiteTreeOp[], newId?: () => string) => applyOpsLocally(sites, layout, ops, { newId });

const errCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SiteTreeOpError, String(e));
    assert.match(e.message, /^\[site_tree\.[a-z_]+\] /);
    return e.code;
  }
  assert.fail('expected an error');
};

describe('paths', () => {
  it('normalizes folder paths', () => {
    assert.equal(normalizeGroup(' A // B/ '), 'A/B');
    assert.equal(normalizeGroup('A/\u0007B'), 'A/B');
    assert.equal(normalizeGroup(null), '');
    assert.deepEqual(folderChain('A/B/C'), ['A', 'A/B', 'A/B/C']);
    assert.deepEqual(folderChain(''), []);
    assert.equal(parentOf('A/B/C'), 'A/B');
    assert.equal(parentOf('A'), '');
    assert.equal(baseName('A/B/C'), 'C');
  });

  it('strict paths error instead of cutting', () => {
    assert.equal(normalizeFolderPathStrict(' A // B/ '), 'A/B');
    assert.equal(normalizeFolderPathStrict(''), null);
    assert.equal(errCode(() => normalizeFolderPathStrict('A/\u0007B')), 'site_tree.invalid_name');
    assert.equal(errCode(() => normalizeFolderPathStrict('x'.repeat(256))), 'site_tree.path_too_long');
    assert.equal(normalizeFolderPathStrict('é'.repeat(255)), 'é'.repeat(255));
  });
});

describe('sites', () => {
  it('formats addresses (default ports hidden, S3 bucket, never the access key)', () => {
    assert.equal(siteAddress(site('a')), 'deploy@a.example.test');
    assert.equal(siteAddress(site('a', null, { port: 2222 })), 'deploy@a.example.test:2222');
    assert.equal(siteAddress(site('a', null, { host: '::1', port: 2222 })), 'deploy@[::1]:2222');
    assert.equal(siteAddress(site('a', null, { protocol: 's3', port: 443, username: 'AKIA', host: 's3.example.test', remote_root: '/bucket/' })), 's3.example.test/bucket');
    assert.equal(siteAddress(site('a', null, { protocol: 'ftp', port: 21, username: '' })), 'a.example.test');
    assert.equal(siteAddress(LOCAL), '');
    assert.equal(copyAddress(site('a', null, { port: 2222 })), 'sftp://deploy@a.example.test:2222');
    assert.equal(copyAddress(site('a', null, { protocol: 'scp' })), 'sftp://deploy@a.example.test');
    assert.equal(copyAddress(site('a', null, { protocol: 'ftps', port: 21, username: 'me@corp' })), 'ftps://me%40corp@a.example.test');
    assert.equal(copyAddress(site('a', null, { protocol: 's3', host: 's3.example.test', remote_root: 'b' })), 's3://s3.example.test/b');
    assert.equal(copyAddress(site('a', null, { protocol: 'webdav', port: 443 })), 'webdav://deploy@a.example.test');
    assert.equal(copyAddress(LOCAL), '');
  });

  it('needsPassword follows the password gate (the stored marker counts as a value)', () => {
    assert.equal(needsPassword(site('a')), false);
    assert.equal(needsPassword(site('a', null, { auth: { type: 'Password', value: '' } })), true);
    assert.equal(needsPassword(site('a', null, { auth: { type: 'None', value: null } })), false, 'SFTP agent');
    assert.equal(needsPassword(site('a', null, { auth: { type: 'PrivateKey', value: { path: 'k' } } })), false);
    assert.equal(needsPassword(site('a', null, { protocol: 's3', auth: { type: 'None', value: null } })), true);
    assert.equal(needsPassword(site('a', null, { protocol: 'ftp', auth: { type: 'None', value: null } })), true);
    assert.equal(needsPassword(site('a', null, { protocol: 'ftp', username: 'Anonymous', auth: { type: 'None', value: null } })), false);
    assert.equal(needsPassword(site('a', null, { protocol: 'webdav', auth: { type: 'KeyringRef', value: 'x' } })), false);
    assert.equal(needsPassword(LOCAL), false);
  });

  it('authKind and duplicateKey', () => {
    assert.equal(authKind(site('a')), 'password');
    assert.equal(authKind(site('a', null, { auth: { type: 'PrivateKey', value: { path: 'k' } } })), 'key');
    assert.equal(authKind(site('a', null, { auth: { type: 'None', value: null } })), 'agent');
    assert.equal(authKind(site('a', null, { protocol: 'ftp', auth: { type: 'None', value: null } })), 'none');
    assert.equal(authKind(site('a', null, { auth: { type: 'Password', value: '' } })), 'none');
    assert.equal(duplicateKey(site('a', null, { host: 'H.example' })), duplicateKey(site('b', null, { host: 'h.example', protocol: 'scp' })));
    assert.notEqual(duplicateKey(site('a')), duplicateKey(site('a', null, { port: 2222 })));
    assert.equal(duplicateKey(LOCAL), null);
  });
});

describe('buildTree', () => {
  it('keeps explicit empty folders, puts Local first and counts all levels', () => {
    const model = buildTree(library(), layoutWith({ folders: ['Archive/2019'] }));
    assert.deepEqual([...model.folders.keys()].sort(), ['', 'Archive', 'Archive/2019', 'Clients', 'Clients/Acme', 'Clients/Acme/Web', 'Staging']);
    const top = folderChildren(model.root).map((c) => (c.kind === 'site' ? `s:${c.site.id}` : `f:${c.folder.path}`));
    assert.deepEqual(top, ['s:local', 'f:Archive', 'f:Clients', 'f:Staging', 's:solo']);
    assert.equal(model.totalSites, 4, 'Local is not counted');
    assert.equal(model.totalFolders, 6);
    assert.equal(model.folders.get('Clients')?.count, 2);
    assert.equal(model.folders.get('Clients')?.folderCount, 2);
    assert.equal(model.folders.get('Archive')?.count, 0);
    assert.equal(model.folders.get('Archive/2019')?.explicit, true);
    assert.equal(model.folders.get('Clients')?.explicit, false);
  });

  it('sorts naturally, ignoring case and accents', () => {
    const sites = [site('a', 'F', { name: 'web-10' }), site('b', 'F', { name: 'Web-2' }), site('c', 'F', { name: 'éclair' }), site('d', 'F', { name: 'alpha' })];
    const model = buildTree(sites, layoutWith({ folders: ['F/node-10', 'F/Node-9'] }));
    const names = folderChildren(model.folders.get('F')!).map((c) => (c.kind === 'site' ? c.site.name : c.folder.name));
    assert.deepEqual(names, ['Node-9', 'node-10', 'alpha', 'éclair', 'Web-2', 'web-10']);
  });

  it('sorts by address, protocol and last connected; folders can mix in', () => {
    const sites = [
      LOCAL,
      site('a', null, { name: 'a', host: 'z.example', protocol: 'ftp', port: 21 }),
      site('b', null, { name: 'b', host: 'a.example', port: 2222 }),
      site('c', null, { name: 'c', host: 'a.example', port: 22 }),
    ];
    const layout = layoutWith({ folders: ['M'], recents: [{ id: 'a', at: 100, count: 1 }, { id: 'c', at: 50, count: 1 }] });
    const order = (prefs: Parameters<typeof buildTree>[2]) =>
      folderChildren(buildTree(sites, layout, prefs).root).map((c) => (c.kind === 'site' ? c.site.id : `f:${c.folder.path}`));
    assert.deepEqual(order({ sort: 'address' }), ['local', 'f:M', 'c', 'b', 'a']);
    assert.deepEqual(order({ sort: 'protocol' }), ['local', 'f:M', 'b', 'c', 'a']);
    assert.deepEqual(order({ sort: 'last' }), ['local', 'f:M', 'a', 'c', 'b']);
    assert.deepEqual(order({ sort: 'name', foldersOnTop: false }), ['local', 'a', 'b', 'c', 'f:M']);
    assert.deepEqual(order({ sort: 'address', foldersOnTop: false }), ['local', 'c', 'b', 'a', 'f:M']);
  });

  it('resolves favorites, recents and inherited labels', () => {
    const layout = layoutWith({
      favorites: [{ kind: 'site', id: 'solo' }, { kind: 'folder', path: 'Clients' }, { kind: 'site', id: 'gone' }],
      recents: [{ id: 'stg', at: 10, count: 1 }, { id: 'local', at: 9, count: 1 }, { id: 'gone', at: 8, count: 1 }],
      labels: [
        { id: 'label-a', name: 'A', color: 'red' },
        { id: 'label-b', name: 'B', color: 'blue' },
      ],
      folder_labels: { Clients: 'label-a', 'Clients/Acme/Web': 'label-missing' },
      site_labels: { 'db-01': 'label-b' },
    });
    const model = buildTree(library(), layout);
    assert.deepEqual(model.favorites, [{ kind: 'site', id: 'solo' }, { kind: 'folder', path: 'Clients' }]);
    assert.deepEqual(model.recents.map((r) => r.id), ['stg']);
    assert.equal(model.siteLabel.get('web-01'), 'label-a');
    assert.equal(model.siteLabel.get('db-01'), 'label-b');
    assert.equal(model.siteLabel.get('solo'), undefined);
    assert.equal(model.folders.get('Clients/Acme/Web')?.effectiveLabel, 'label-a');
    assert.deepEqual(sitesInside(model, 'Clients').map((s) => s.id).sort(), ['db-01', 'web-01']);
  });
});

describe('flattenRows', () => {
  const model = () => buildTree(library(), layoutWith({ folders: ['Archive'] }));
  const flat = (state: Partial<FlattenState>, m = model()) => flattenRows(m, { collapsed: new Set(), ...state });

  it('lists every row with ARIA level, setsize and posinset', () => {
    const { rows, indexByKey } = flat({});
    assert.deepEqual(keys(rows), ['sec:all', 's:local', 'f:Archive', 'ph:Archive', 'f:Clients', 'f:Clients/Acme', 'f:Clients/Acme/Web', 's:web-01', 's:db-01', 'f:Staging', 's:stg', 's:solo']);
    const aria = (key: string) => {
      const r = rows[indexByKey.get(key)!];
      return [r.depth, r.level, r.posinset, r.setsize];
    };
    assert.deepEqual(aria('sec:all'), [0, 1, 1, 1]);
    assert.deepEqual(aria('s:local'), [0, 2, 1, 5]);
    assert.deepEqual(aria('f:Clients'), [0, 2, 3, 5]);
    assert.deepEqual(aria('s:solo'), [0, 2, 5, 5]);
    assert.deepEqual(aria('f:Clients/Acme'), [1, 3, 1, 1]);
    assert.deepEqual(aria('f:Clients/Acme/Web'), [2, 4, 1, 2]);
    assert.deepEqual(aria('s:db-01'), [2, 4, 2, 2]);
    assert.deepEqual(aria('ph:Archive'), [1, 3, 1, 1]);
    const archive = rows[indexByKey.get('f:Archive')!];
    assert.equal(archive.kind === 'folder' && archive.empty, true);
  });

  it('hides the children of collapsed folders and sections', () => {
    assert.deepEqual(keys(flat({ collapsed: new Set(['Clients', 'Archive', 'Staging']) }).rows), ['sec:all', 's:local', 'f:Archive', 'f:Clients', 'f:Staging', 's:solo']);
    assert.deepEqual(keys(flat({ collapsedSections: new Set(['all']) }).rows), ['sec:all']);
  });

  it('places the draft row in its folder, forcing the chain open', () => {
    const rows = flat({ collapsed: new Set(['Clients', 'Clients/Acme']), draft: { folder: 'Clients/Acme', name: 'New connection' } }).rows;
    assert.deepEqual(keys(rows).slice(4, 8), ['f:Clients', 'f:Clients/Acme', 'draft', 'f:Clients/Acme/Web']);
    const draft = rows.find((r) => r.key === 'draft')!;
    assert.deepEqual([draft.depth, draft.posinset, draft.setsize], [2, 1, 3]);
    // A folder that does not exist yet: the deepest existing one
    const deep = flat({ draft: { folder: 'Staging/New/Deeper', name: 'x' } }).rows;
    assert.equal(rowFolderPath(deep.find((r) => r.key === 'draft')), 'Staging');
    // Top level: right after Local
    assert.deepEqual(keys(flat({ draft: { folder: '', name: 'x' } }).rows).slice(0, 3), ['sec:all', 's:local', 'draft']);
  });

  it('places a new-folder row first in its parent', () => {
    const rows = flat({ collapsed: new Set(['Staging']), newFolder: { parent: 'Staging', name: 'New folder' } }).rows;
    const i = keys(rows).indexOf('f:Staging');
    assert.deepEqual(keys(rows).slice(i, i + 3), ['f:Staging', 'newfolder', 's:stg']);
  });

  it('shows favorites and recent sections, a favorite folder expanding in place', () => {
    const m = buildTree(
      library(),
      layoutWith({
        favorites: [{ kind: 'folder', path: 'Clients/Acme' }, { kind: 'site', id: 'stg' }],
        recents: [{ id: 'stg', at: 5, count: 1 }, { id: 'solo', at: 4, count: 1 }],
      })
    );
    const rows = flat({ collapsed: new Set(['Clients']), favoriteExpanded: new Set(['Clients/Acme']) }, m).rows;
    assert.deepEqual(keys(rows).slice(0, 9), [
      'sec:fav',
      'fav:f:Clients/Acme',
      'fav:f:Clients/Acme\u001ff:Clients/Acme/Web',
      'fav:f:Clients/Acme\u001fs:web-01',
      'fav:f:Clients/Acme\u001fs:db-01',
      'fav:s:stg',
      'sec:rec',
      'rec:solo',
      'sec:all',
    ]);
    const nested = rows[3];
    assert.deepEqual([nested.depth, nested.level, nested.section], [2, 4, 'fav']);
    const rec = rows[7];
    assert.equal(rec.kind === 'site' && rec.recentAt, 4);
    assert.equal(rec.kind === 'site' && rec.showPath, true);
    assert.deepEqual([rows[0].posinset, rows[6].posinset, rows[8].posinset, rows[8].setsize], [1, 2, 3, 3]);
    // Turned off, they go
    assert.deepEqual(keys(flat({ showFavorites: false, showRecent: false }, m).rows)[0], 'sec:all');
  });

  it('search rows show matches with their folders expanded, minus folders collapsed during the search', () => {
    const m = model();
    const search = { siteIds: new Set(['web-01', 'stg']), folderPaths: new Set(['Archive']) };
    const rows = flat({ collapsed: new Set(['Clients']), search }, m).rows;
    assert.deepEqual(keys(rows), ['sec:all', 'f:Archive', 'f:Clients', 'f:Clients/Acme', 'f:Clients/Acme/Web', 's:web-01', 'f:Staging', 's:stg']);
    const clients = rows[2];
    assert.equal(clients.kind === 'folder' && clients.count, 1);
    assert.equal(rows[0].kind === 'section' && rows[0].count, 2);
    assert.deepEqual(keys(flat({ search, searchCollapsed: new Set(['Clients/Acme']) }, m).rows), ['sec:all', 'f:Archive', 'f:Clients', 'f:Clients/Acme', 'f:Staging', 's:stg']);
  });

  it('search results as a list are one flat level', () => {
    const rows = flat({ search: { siteIds: new Set(['web-01', 'stg']), folderPaths: new Set(), ranked: ['s:stg', 's:web-01'] }, address: 'root@h.example' }).rows;
    assert.deepEqual(keys(rows), ['s:stg', 's:web-01', 'addr']);
    assert.deepEqual(
      rows.map((r) => [r.level, r.posinset, r.setsize]),
      [
        [1, 1, 3],
        [1, 2, 3],
        [1, 3, 3],
      ]
    );
  });
});

describe('applyOpsLocally (same cases as site_layout.rs)', () => {
  it('reconcile adds implied folders and ancestors and drops dangling refs', () => {
    const layout = reconcileLayout(
      layoutWith({
        folders: ['Empty/Inner', ' Bad\u0007/x'],
        favorites: [{ kind: 'site', id: 'gone' }, { kind: 'folder', path: 'Nope' }, { kind: 'site', id: 'solo' }, { kind: 'site', id: 'solo' }],
        recents: [{ id: 'local', at: 1, count: 1 }, { id: 'stg', at: 2, count: 1 }, { id: 'stg', at: 1, count: 1 }],
        labels: [
          { id: 'label-a', name: '  A  ', color: 'red' },
          { id: 'bad id!', name: 'B', color: 'red' },
        ],
        site_labels: { solo: 'label-a', gone: 'label-a', stg: 'label-x' },
        folder_labels: { 'Clients/': 'label-a' },
        collapsed: ['Clients', 'Nope'],
      }),
      library()
    );
    assert.deepEqual(layout.folders, ['Clients', 'Clients/Acme', 'Clients/Acme/Web', 'Empty', 'Empty/Inner', 'Staging']);
    assert.deepEqual(layout.favorites, [{ kind: 'site', id: 'solo' }]);
    assert.deepEqual(layout.recents, [{ id: 'stg', at: 2, count: 1 }]);
    assert.deepEqual(layout.labels, [{ id: 'label-a', name: 'A', color: 'red' }]);
    assert.deepEqual(layout.site_labels, { solo: 'label-a' });
    assert.deepEqual(layout.folder_labels, { Clients: 'label-a' });
    assert.deepEqual(layout.collapsed, ['Clients']);
  });

  it('an empty folder persists', () => {
    const out = run(library(), defaultLayout(), [{ op: 'move_sites', ids: ['stg'], to: null }]);
    assert.equal(groupOf(out.sites, 'stg'), null);
    assert.ok(out.layout.folders.includes('Staging'));
    assert.equal(out.sitesChanged, true);
  });

  it('a deep rename rewrites groups, folders, favorites, labels and collapsed', () => {
    const layout = layoutWith({
      labels: [{ id: 'label-a', name: 'A', color: 'red' }],
      favorites: [{ kind: 'folder', path: 'Clients/Acme/Web' }],
      folder_labels: { 'Clients/Acme': 'label-a' },
      collapsed: ['Clients/Acme/Web', 'Clients'],
    });
    const out = run(library(), layout, [{ op: 'rename_folder', path: 'Clients/Acme', name: 'Acme Corp' }]);
    assert.equal(groupOf(out.sites, 'web-01'), 'Clients/Acme Corp/Web');
    assert.equal(groupOf(out.sites, 'db-01'), 'Clients/Acme Corp');
    assert.equal(groupOf(out.sites, 'stg'), 'Staging');
    assert.deepEqual(out.layout.folders, ['Clients', 'Clients/Acme Corp', 'Clients/Acme Corp/Web', 'Staging']);
    assert.deepEqual(out.layout.favorites, [{ kind: 'folder', path: 'Clients/Acme Corp/Web' }]);
    assert.deepEqual(out.layout.folder_labels, { 'Clients/Acme Corp': 'label-a' });
    assert.deepEqual(out.layout.collapsed, ['Clients', 'Clients/Acme Corp/Web']);
    assert.ok(out.sitesChanged && out.layoutChanged);
  });

  it('a case-only rename is not a clash', () => {
    const out = run(library(), defaultLayout(), [{ op: 'rename_folder', path: 'Staging', name: 'staging' }]);
    assert.equal(groupOf(out.sites, 'stg'), 'staging');
    assert.ok(!out.layout.folders.includes('Staging'));
  });

  it('a rename clash needs merge, and merge keeps the existing spelling', () => {
    const sites = [...library(), site('prod-web', 'Clients/web')];
    const layout = layoutWith({ folders: ['Clients/web/Old'] });
    const rename = (merge: boolean): SiteTreeOp => ({ op: 'rename_folder', path: 'Clients/web', name: 'acme', merge });
    assert.equal(errCode(() => run(sites, layout, [rename(false)])), 'site_tree.folder_exists');
    const out = run(sites, layout, [rename(true)]);
    assert.equal(groupOf(out.sites, 'prod-web'), 'Clients/Acme');
    assert.ok(out.layout.folders.includes('Clients/Acme/Old'));
    assert.ok(!out.layout.folders.some((f) => f.startsWith('Clients/web')));
    assert.ok(!out.layout.folders.includes('Clients/acme'));
  });

  it('a move clash needs merge', () => {
    const sites = [...library(), site('x', 'Old/Web')];
    const mv = (merge: boolean): SiteTreeOp => ({ op: 'move_folder', path: 'Old/Web', to: 'Clients/Acme', merge });
    assert.equal(errCode(() => run(sites, defaultLayout(), [mv(false)])), 'site_tree.folder_exists');
    const out = run(sites, defaultLayout(), [mv(true)]);
    assert.equal(groupOf(out.sites, 'x'), 'Clients/Acme/Web');
    assert.equal(groupOf(out.sites, 'web-01'), 'Clients/Acme/Web');
    assert.ok(out.layout.folders.includes('Old'));
    assert.ok(!out.layout.folders.includes('Old/Web'));
  });

  it('a folder cannot move or be copied into itself', () => {
    for (const to of ['Clients', 'Clients/Acme', 'Clients/Acme/Web']) {
      assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'move_folder', path: 'Clients', to, merge: true }])), 'site_tree.into_self', to);
    }
    assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'copy_folder', path: 'Clients', to: 'Clients/Acme', name: 'Copy' }], counter())), 'site_tree.into_self');
    // A sibling whose name starts the same way is not inside it
    const out = run(library(), defaultLayout(), [
      { op: 'create_folder', path: 'Clients2' },
      { op: 'move_folder', path: 'Clients2', to: 'Clients' },
    ]);
    assert.ok(out.layout.folders.includes('Clients/Clients2'));
  });

  it('delete_folder keeping contents lifts them and merges clashes', () => {
    const sites = [LOCAL, site('a', 'Production'), site('b', 'Production/Web/Edge'), site('c', 'Production/db'), site('d', 'DB'), site('e', 'Production/Production')];
    const layout = layoutWith({
      folders: ['Production/Empty'],
      favorites: [
        { kind: 'folder', path: 'Production' },
        { kind: 'folder', path: 'Production/Web' },
      ],
    });
    const out = run(sites, layout, [{ op: 'delete_folder', path: 'Production', keep_contents: true }]);
    assert.equal(groupOf(out.sites, 'a'), null);
    assert.equal(groupOf(out.sites, 'b'), 'Web/Edge');
    assert.equal(groupOf(out.sites, 'c'), 'DB');
    assert.equal(groupOf(out.sites, 'd'), 'DB');
    assert.equal(groupOf(out.sites, 'e'), 'Production');
    assert.deepEqual(out.layout.folders, ['DB', 'Empty', 'Production', 'Web', 'Web/Edge']);
    assert.deepEqual(out.layout.favorites, [{ kind: 'folder', path: 'Web' }]);
    assert.equal(out.sites.length, 6);
  });

  it('delete_folder with contents removes its sites and folders', () => {
    const out = run(library(), layoutWith({ favorites: [{ kind: 'site', id: 'web-01' }] }), [{ op: 'delete_folder', path: 'Clients/Acme', keep_contents: false }]);
    assert.deepEqual(out.sites.map((s) => s.id), ['local', 'solo', 'stg']);
    assert.deepEqual(out.layout.folders, ['Clients', 'Staging']);
    assert.deepEqual(out.layout.favorites, []);
  });

  it('copies clone every field (only with newId; the UI waits for the server otherwise)', () => {
    const src = site('web-01', 'Clients/Acme/Web', { auth: { type: 'PrivateKey', value: { path: '', passphrase: STORED, key_data: STORED } }, remote_root: '/srv' });
    const sites = [LOCAL, src];
    const layout = layoutWith({ labels: [{ id: 'label-a', name: 'A', color: 'red' }], site_labels: { 'web-01': 'label-a' }, favorites: [{ kind: 'site', id: 'web-01' }] });
    const ops: SiteTreeOp[] = [{ op: 'copy_sites', items: [{ id: 'web-01', name: 'web-01 copy', group: 'Staging' }] }];
    assert.equal(opsAreOptimistic(ops), false);
    const skipped = run(sites, layout, ops);
    assert.equal(skipped.sites.length, 2);
    const out = run(sites, layout, ops, counter());
    assert.deepEqual(out.created, [{ source_id: 'web-01', id: 'copy-1' }]);
    const copy = out.sites.find((s) => s.id === 'copy-1')!;
    assert.deepEqual({ ...copy, id: src.id, name: src.name, group: src.group }, src);
    assert.equal(copy.group, 'Staging');
    assert.notEqual(copy.auth, src.auth, 'deep copy');
    assert.equal(out.layout.site_labels['copy-1'], 'label-a');
    assert.deepEqual(out.layout.favorites, [{ kind: 'site', id: 'web-01' }], 'favorites are not copied');

    const folder = run(library(), defaultLayout(), [{ op: 'copy_folder', path: 'Clients/Acme', to: 'Clients', name: 'Acme copy' }], counter());
    assert.deepEqual(folder.created.map((c) => c.source_id).sort(), ['db-01', 'web-01']);
    assert.ok(folder.layout.folders.includes('Clients/Acme copy/Web'));
    assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'copy_folder', path: 'Clients/Acme', to: 'Clients', name: 'ACME' }], counter())), 'site_tree.folder_exists');
  });

  it('Local cannot be moved, copied or deleted, but can be renamed', () => {
    assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'move_sites', ids: ['local'], to: 'X' }])), 'site_tree.local_immutable');
    assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'delete_sites', ids: ['local'] }])), 'site_tree.local_immutable');
    assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'copy_sites', items: [{ id: 'local', name: 'x', group: null }] }], counter())), 'site_tree.local_immutable');
    const out = run(library(), defaultLayout(), [{ op: 'rename_site', id: 'local', name: '  This Mac ' }]);
    assert.equal(out.sites[0].name, 'This Mac');
  });

  it('a path longer than 255 characters is rejected, never cut', () => {
    const long = 'x'.repeat(250);
    const sites = [LOCAL, site('a', `${long}/abc`)];
    assert.equal(errCode(() => run(sites, defaultLayout(), [{ op: 'rename_folder', path: long, name: 'y'.repeat(253) }])), 'site_tree.path_too_long');
    assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'move_sites', ids: ['solo'], to: 'z'.repeat(256) }])), 'site_tree.path_too_long');
  });

  it('create_folder refuses clashes ignoring case', () => {
    for (const path of ['Staging', 'staging', 'clients/New', 'Clients/ACME']) {
      assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'create_folder', path }])), 'site_tree.folder_exists', path);
    }
    assert.ok(run(library(), defaultLayout(), [{ op: 'create_folder', path: 'Clients/New' }]).layout.folders.includes('Clients/New'));
  });

  it('a batch is all or nothing and never mutates its inputs', () => {
    const sites = library();
    const layout = layoutWith({ folders: ['Empty'] });
    const before = JSON.stringify({ sites, layout });
    assert.equal(
      errCode(() =>
        run(sites, layout, [
          { op: 'move_sites', ids: ['solo'], to: 'Empty' },
          { op: 'rename_folder', path: 'Nope', name: 'x' },
        ])
      ),
      'site_tree.not_found'
    );
    run(sites, layout, [{ op: 'rename_folder', path: 'Clients', name: 'Customers' }]);
    assert.equal(JSON.stringify({ sites, layout }), before);
  });

  it('limits ops and ids per call', () => {
    const many: SiteTreeOp[] = Array.from({ length: 101 }, (_, i) => ({ op: 'create_folder', path: `F${i}` }));
    assert.equal(errCode(() => run(library(), defaultLayout(), many)), 'site_tree.too_many');
    const ids = Array.from({ length: 5001 }, () => 'solo');
    assert.equal(errCode(() => run(library(), defaultLayout(), [{ op: 'move_sites', ids, to: null }])), 'site_tree.too_many');
  });

  it('favorites and labels', () => {
    const layout = layoutWith({});
    const out = run(library(), layout, [
      { op: 'set_label_defs', labels: [{ id: 'label-a', name: ' Prod ', color: 'red' }] },
      { op: 'set_label', sites: ['solo'], folders: ['Clients'], label: 'label-a' },
      { op: 'set_favorites', items: [{ kind: 'folder', path: ' Clients/ ' }, { kind: 'site', id: 'gone' }, { kind: 'site', id: 'stg' }] },
    ]);
    assert.deepEqual(out.layout.labels, [{ id: 'label-a', name: 'Prod', color: 'red' }]);
    assert.deepEqual(out.layout.site_labels, { solo: 'label-a' });
    assert.deepEqual(out.layout.folder_labels, { Clients: 'label-a' });
    assert.deepEqual(out.layout.favorites, [{ kind: 'folder', path: 'Clients' }, { kind: 'site', id: 'stg' }]);
    assert.equal(out.sitesChanged, false);
    assert.equal(errCode(() => run(library(), layout, [{ op: 'set_label', sites: ['solo'], label: 'label-x' }])), 'site_tree.not_found');
    assert.equal(errCode(() => run(library(), layout, [{ op: 'set_label_defs', labels: [{ id: 'bad id', name: 'x', color: 'red' }] }])), 'site_tree.invalid_name');
  });
});

describe('helpers', () => {
  it('pickFreeName skips taken names ignoring case', () => {
    const nth = (n: number) => `New folder ${n}`;
    assert.equal(pickFreeName('New folder', ['Web'], nth), 'New folder');
    assert.equal(pickFreeName('New folder', ['new FOLDER', 'New folder 2'], nth), 'New folder 3');
  });

  it('folderNameProblem mirrors the backend checks', () => {
    const folders = ['Clients', 'Clients/Acme', 'Clients/Acme/Web', 'Staging'];
    assert.deepEqual(folderNameProblem('  ', '', folders), { code: 'empty' });
    assert.deepEqual(folderNameProblem('a/b', '', folders), { code: 'slash' });
    assert.deepEqual(folderNameProblem('a\u0001', '', folders), { code: 'control' });
    assert.deepEqual(folderNameProblem('staging', '', folders), { code: 'exists', existing: 'Staging' });
    assert.equal(folderNameProblem('acme', 'Clients', folders, 'Clients/Acme'), null, 'case-only rename');
    assert.equal(folderNameProblem('New', 'Clients', folders), null);
    assert.deepEqual(folderNameProblem('y'.repeat(250), 'Clients', folders, 'Clients/Acme'), { code: 'too_long' }, 'the subtree counts');
  });

  it('view prefs parse defensively and pick a density by library size', () => {
    assert.deepEqual(parseViewPrefs('not json'), parseViewPrefs(null));
    const prefs = parseViewPrefs(JSON.stringify({ sort: 'address', density: 'compact', showRecent: false, bogus: 1, foldersOnTop: 'yes' }));
    assert.equal(prefs.sort, 'address');
    assert.equal(prefs.density, 'compact');
    assert.equal(prefs.showRecent, false);
    assert.equal(prefs.foldersOnTop, true);
    assert.equal(effectiveDensity({ density: null }, 40), 'comfortable');
    assert.equal(effectiveDensity({ density: null }, 41), 'compact');
    assert.equal(effectiveDensity({ density: 'comfortable' }, 3000), 'comfortable');
  });

  it('coerceLayout fills in missing fields', () => {
    const l = coerceLayout({ folders: ['A', 3], favorites: [{ kind: 'site', id: 'x' }, { kind: 'nope' }], recents: [{ id: 'x' }], labels: [{ id: 'l', name: 'L', color: 'pink' }] });
    assert.deepEqual(l.folders, ['A']);
    assert.deepEqual(l.favorites, [{ kind: 'site', id: 'x' }]);
    assert.deepEqual(l.recents, [{ id: 'x', at: null, count: 0 }]);
    assert.deepEqual(l.labels, [{ id: 'l', name: 'L', color: 'gray' }]);
    assert.deepEqual(coerceLayout(undefined), defaultLayout());
  });

  it('recentAge buckets', () => {
    const now = 1_000_000_000_000;
    const at = (secsAgo: number) => now / 1000 - secsAgo;
    assert.deepEqual(recentAge(at(10), now), { unit: 'now' });
    assert.deepEqual(recentAge(at(5 * 60), now), { unit: 'min', count: 5 });
    assert.deepEqual(recentAge(at(2 * 3600), now), { unit: 'h', count: 2 });
    assert.deepEqual(recentAge(at(3 * 86_400), now), { unit: 'd', count: 3 });
    assert.equal(recentAge(at(30 * 86_400), now).unit, 'date');
  });
});
