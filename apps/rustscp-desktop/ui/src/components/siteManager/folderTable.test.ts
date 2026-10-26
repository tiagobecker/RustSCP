import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../../types.ts';
import { defaultDir, folderTableRows } from './folderTable.ts';
import type { TableRow } from './folderTable.ts';
import { buildTree, defaultLayout } from './siteTreeModel.ts';

const site = (id: string, group: string | null, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: id,
  protocol: 'sftp',
  host: `${id}.example.test`,
  port: 22,
  username: 'deploy',
  auth: { type: 'Password', value: 'pw' },
  remote_root: '',
  tls_fingerprint: null,
  group,
  ...over,
});

const LOCAL: ConnectionConfig = { ...site('local', null), name: 'Local Machine', protocol: 'local', host: 'localhost', port: 0, auth: { type: 'None', value: null } };

const NOW = 1_800_000_000;
const SITES = [
  LOCAL,
  site('web-10', 'Clients', { host: 'b.example.test', protocol: 'ftps', port: 21 }),
  site('web-2', 'Clients', { host: 'c.example.test' }),
  site('api', 'Clients', { host: 'a.example.test', protocol: 's3', port: 443 }),
  site('deep', 'Clients/Acme/Old'),
  site('acme-db', 'Clients/Acme'),
  site('top', null),
];
const model = buildTree(SITES, {
  ...defaultLayout(),
  folders: ['Clients/Empty'],
  recents: [
    { id: 'web-2', at: NOW - 10, count: 1 },
    { id: 'deep', at: NOW - 5, count: 1 },
    { id: 'api', at: null, count: 0 },
  ],
});

const keys = (rows: TableRow[]) => rows.map((r) => r.key);

describe('folder overview table', () => {
  it('lists subfolders first, then sites in natural name order', () => {
    assert.deepEqual(keys(folderTableRows(model, 'Clients', { flat: false, sort: 'name', dir: 'asc' })), ['f:Clients/Acme', 'f:Clients/Empty', 's:api', 's:web-2', 's:web-10']);
    assert.deepEqual(keys(folderTableRows(model, 'Clients', { flat: false, sort: 'name', dir: 'desc' })), ['f:Clients/Empty', 'f:Clients/Acme', 's:web-10', 's:web-2', 's:api']);
  });

  it('flattens every site underneath with "Include subfolders"', () => {
    const rows = folderTableRows(model, 'Clients', { flat: true, sort: 'name', dir: 'asc' });
    assert.deepEqual(keys(rows), ['s:acme-db', 's:api', 's:deep', 's:web-2', 's:web-10']);
    const deep = rows.find((r) => r.key === 's:deep');
    assert.equal(deep?.kind === 'site' ? deep.folder : null, 'Clients/Acme/Old');
  });

  it('sorts by address, protocol and last use', () => {
    assert.deepEqual(keys(folderTableRows(model, 'Clients', { flat: true, sort: 'address', dir: 'asc' })), ['s:api', 's:acme-db', 's:web-10', 's:web-2', 's:deep']);
    assert.deepEqual(keys(folderTableRows(model, 'Clients', { flat: true, sort: 'protocol', dir: 'asc' })), ['s:acme-db', 's:deep', 's:web-2', 's:web-10', 's:api']);
    // Newest first, then a recent entry with no time, then never used (A→Z)
    assert.equal(defaultDir('last'), 'desc');
    assert.deepEqual(keys(folderTableRows(model, 'Clients', { flat: true, sort: 'last', dir: 'desc' })), ['s:deep', 's:web-2', 's:api', 's:acme-db', 's:web-10']);
  });

  it('keeps Local first at the top level, and folders follow their newest site', () => {
    assert.deepEqual(keys(folderTableRows(model, '', { flat: false, sort: 'name', dir: 'desc' })), ['f:Clients', 's:local', 's:top']);
    assert.equal(folderTableRows(model, '', { flat: true, sort: 'name', dir: 'asc' })[0].key, 's:local');
    assert.deepEqual(keys(folderTableRows(model, 'Clients', { flat: false, sort: 'last', dir: 'desc' })).slice(0, 2), ['f:Clients/Acme', 'f:Clients/Empty']);
    assert.deepEqual(folderTableRows(model, 'Nope', { flat: false, sort: 'name', dir: 'asc' }), []);
  });
});
