import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../../types.ts';
import type { TreeRow } from './types.ts';
import { applyOpsLocally, buildTree, defaultLayout, flattenRows, planMove } from './siteTreeModel.ts';
import { checkDrop, commonParent, dragPayload, dropSpotForRow, inDropBlock, planCopies } from './treeDragModel.ts';

const site = (id: string, group: string | null = null, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: id,
  protocol: 'sftp',
  host: `${id}.example.test`,
  port: 22,
  username: 'deploy',
  auth: { type: 'Password', value: '__RUSTSCP_STORED_SECRET__' },
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

const library = (): ConnectionConfig[] => [
  LOCAL,
  site('web-01', 'Clients/Acme/Web'),
  site('db-01', 'Clients/Acme'),
  site('solo'),
  site('stg', 'Staging'),
  site('stg-2', 'Staging', { name: 'db-01' }),
];

const names = {
  first: (name: string) => `${name} copy`,
  nth: (name: string, n: number) => `${name} copy ${n}`,
};

const rowsOf = (sites: ConnectionConfig[]) => flattenRows(buildTree(sites, defaultLayout()), { collapsed: new Set() }).rows;
const rowByKey = (rows: TreeRow[], key: string) => {
  const row = rows.find((r) => r.key === key);
  assert.ok(row, `row ${key}`);
  return row;
};

describe('dragPayload', () => {
  it('leaves out Local and sites inside a carried folder', () => {
    const model = buildTree(library(), defaultLayout());
    const p = dragPayload(model, ['s:local', 's:web-01', 'f:Clients/Acme', 's:solo']);
    assert.ok(p);
    assert.deepEqual(p.keys, ['s:solo', 'f:Clients/Acme']);
    assert.deepEqual(p.folders, ['Clients/Acme']);
    assert.deepEqual(new Set(p.parents), new Set(['', 'Clients']));
    assert.equal(p.count, 2);
    // solo + web-01 + db-01
    assert.equal(p.connections, 3);
    assert.equal(p.first.kind, 'site');
  });

  it('is null for Local alone', () => {
    assert.equal(dragPayload(buildTree(library(), defaultLayout()), ['s:local']), null);
  });
});

describe('drop spots', () => {
  const rows = rowsOf(library());

  it('a folder row takes the items; a site row sends them to its folder', () => {
    assert.deepEqual(dropSpotForRow(rowByKey(rows, 'f:Clients/Acme')), { folder: 'Clients/Acme', highlightKey: 'f:Clients/Acme', block: 'Clients/Acme' });
    assert.deepEqual(dropSpotForRow(rowByKey(rows, 's:web-01')), { folder: 'Clients/Acme/Web', highlightKey: 'f:Clients/Acme/Web', block: 'Clients/Acme/Web' });
  });

  it('top-level rows, the header and the empty space go to the top level', () => {
    for (const spot of [dropSpotForRow(rowByKey(rows, 's:solo')), dropSpotForRow(rowByKey(rows, 's:local')), dropSpotForRow(rowByKey(rows, 'sec:all')), dropSpotForRow(null)]) {
      assert.deepEqual(spot, { folder: '', highlightKey: 'sec:all', block: null });
    }
  });

  it('the block holds the folder contents, not the folder row', () => {
    const acme = rowByKey(rows, 'f:Clients/Acme');
    assert.equal(inDropBlock(acme, 'Clients/Acme'), false);
    assert.equal(inDropBlock(rowByKey(rows, 'f:Clients/Acme/Web'), 'Clients/Acme'), true);
    assert.equal(inDropBlock(rowByKey(rows, 's:web-01'), 'Clients/Acme'), true);
    assert.equal(inDropBlock(rowByKey(rows, 's:stg'), 'Clients/Acme'), false);
    assert.equal(inDropBlock(rowByKey(rows, 's:solo'), null), false);
  });
});

describe('checkDrop', () => {
  const model = buildTree(library(), defaultLayout());

  it('refuses a folder into itself or a folder inside it', () => {
    const p = dragPayload(model, ['f:Clients'])!;
    assert.equal(checkDrop(p, 'Clients', false), 'into_self');
    assert.equal(checkDrop(p, 'Clients/Acme/Web', true), 'into_self');
    assert.equal(checkDrop(p, 'Staging', false), 'ok');
  });

  it('refuses moving items where they already are, but copying there duplicates', () => {
    const p = dragPayload(model, ['s:stg', 's:stg-2'])!;
    assert.equal(checkDrop(p, 'Staging', false), 'same_place');
    assert.equal(checkDrop(p, 'Staging', true), 'ok');
    // Mixed places: the move still has something to do
    const mixed = dragPayload(model, ['s:stg', 's:solo'])!;
    assert.equal(checkDrop(mixed, 'Staging', false), 'ok');
  });
});

describe('planCopies', () => {
  it('duplicates in place with "copy" names (folders and sites)', () => {
    const sites = library();
    const model = buildTree(sites, defaultLayout());
    const plan = planCopies(model, ['f:Clients/Acme', 's:stg', 's:stg-2'], null, names);
    assert.deepEqual(plan.siteItems, [
      { id: 'stg', name: 'stg copy', group: 'Staging' },
      { id: 'stg-2', name: 'db-01 copy', group: 'Staging' },
    ]);
    assert.deepEqual(plan.folders, [{ from: 'Clients/Acme', to: 'Clients/Acme copy' }]);
    assert.equal(plan.connections, 4);
    assert.equal(plan.intoSelf, false);
    assert.equal(plan.tooLong, false);
    // The batch the backend gets is valid and makes the copies
    let n = 0;
    const res = applyOpsLocally(sites, defaultLayout(), plan.ops, { newId: () => `copy-${++n}` });
    assert.equal(res.sites.length, sites.length + 4);
    assert.ok(res.layout.folders.includes('Clients/Acme copy/Web'));
    assert.deepEqual(res.created.slice(0, 2).map((c) => c.source_id), ['stg', 'stg-2']);
  });

  it('keeps names that are free in another folder, and picks free ones otherwise', () => {
    const model = buildTree(library(), defaultLayout());
    const plan = planCopies(model, ['s:db-01', 's:solo', 'f:Clients/Acme/Web'], 'Staging', names);
    // "db-01" is taken in Staging (stg-2's name), "solo" is free
    assert.deepEqual(plan.siteItems, [
      { id: 'db-01', name: 'db-01 copy', group: 'Staging' },
      { id: 'solo', name: 'solo', group: 'Staging' },
    ]);
    assert.deepEqual(plan.folders, [{ from: 'Clients/Acme/Web', to: 'Staging/Web' }]);
    assert.deepEqual(plan.ops[1], { op: 'copy_folder', path: 'Clients/Acme/Web', to: 'Staging', name: 'Web' });
  });

  it('copies to the top level with a null group', () => {
    const model = buildTree(library(), defaultLayout());
    // stg goes with its folder; solo is already at the top level, so its copy is renamed
    const plan = planCopies(model, ['s:web-01', 's:stg', 's:solo', 'f:Staging'], '', names);
    assert.deepEqual(plan.siteItems, [
      { id: 'web-01', name: 'web-01', group: null },
      { id: 'solo', name: 'solo copy', group: null },
    ]);
    assert.deepEqual(plan.folders, [{ from: 'Staging', to: 'Staging copy' }]);
    assert.deepEqual(plan.ops[1], { op: 'copy_folder', path: 'Staging', to: null, name: 'Staging copy' });
  });

  it('flags a folder copied into itself and paths over 255 characters', () => {
    const model = buildTree(library(), defaultLayout());
    assert.equal(planCopies(model, ['f:Clients'], 'Clients/Acme', names).intoSelf, true);
    const long = 'x'.repeat(250);
    const deep = buildTree([LOCAL, site('a', `${long}/Web`)], defaultLayout());
    assert.equal(planCopies(deep, [`f:${long}`], null, names).tooLong, true);
  });
});

describe('commonParent', () => {
  const model = buildTree(library(), defaultLayout());
  it('is the deepest folder that holds every item', () => {
    assert.equal(commonParent(model, ['s:web-01', 's:db-01']), 'Clients/Acme');
    assert.equal(commonParent(model, ['f:Clients/Acme/Web', 's:db-01']), 'Clients/Acme');
    assert.equal(commonParent(model, ['s:web-01', 's:stg']), '');
    assert.equal(commonParent(model, ['s:solo']), '');
    assert.equal(commonParent(model, ['s:stg', 's:stg-2']), 'Staging');
  });

  it('a new folder there takes the items in one batch', () => {
    const sites = library();
    const model = buildTree(sites, defaultLayout());
    const plan = planMove(model, ['s:stg', 's:stg-2'], 'Staging/New folder', { createTarget: true });
    assert.deepEqual(plan.ops[0], { op: 'create_folder', path: 'Staging/New folder' });
    const res = applyOpsLocally(sites, defaultLayout(), plan.ops);
    assert.deepEqual(res.sites.filter((s) => s.group === 'Staging/New folder').map((s) => s.id), ['stg', 'stg-2']);
  });
});
