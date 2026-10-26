import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../../types.ts';
import type { SiteLayoutResponse, SiteTreeResult } from './types.ts';
import { SITE_TREE_CMDS, demoSites, mulberry32, resetSiteFallback, siteFallback } from './siteDevFallback.ts';
import { duplicateKey, needsPassword, normalizeGroup } from './siteTreeModel.ts';

const seedSites = (): ConnectionConfig[] => [
  { id: 'local', name: 'Local Machine', protocol: 'local', host: 'localhost', port: 0, username: 'user', auth: { type: 'None', value: null }, remote_root: '/' },
  { id: 'a', name: 'a', protocol: 'sftp', host: 'a.example.test', port: 22, username: 'u', auth: { type: 'Password', value: 'x' }, remote_root: '', group: 'Clients/Acme' },
  { id: 'b', name: 'b', protocol: 'sftp', host: 'b.example.test', port: 22, username: 'u', auth: { type: 'Password', value: 'x' }, remote_root: '', group: null },
];

/** Calls the mock like devFallback does (synchronously; no `?siteLatency`). */
const call = <T,>(cmd: string, args?: Record<string, unknown>): T => {
  const r = siteFallback(cmd, args, seedSites);
  assert.equal(r.handled, true, cmd);
  return (r as { value: T }).value;
};

const rejects = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    // Tauri rejects with the "[code] message" string itself
    assert.equal(typeof e, 'string');
    assert.match(e as string, new RegExp(`^\\[${code.replace('.', '\\.')}\\] `));
    return;
  }
  assert.fail('expected a rejection');
};

describe('demo library', () => {
  it('is deterministic', () => {
    assert.deepEqual(demoSites(500), demoSites(500));
    const r = mulberry32(42);
    assert.equal(typeof r(), 'number');
  });

  it('has realistic variety', () => {
    const sites = demoSites(2000);
    assert.equal(sites.length, 2001);
    assert.equal(sites[0].id, 'local');
    const saved = sites.slice(1);
    assert.equal(new Set(saved.map((s) => s.id)).size, 2000, 'unique ids');
    const protocols = new Set(saved.map((s) => s.protocol));
    for (const p of ['sftp', 'ftps', 'ftp', 's3', 'webdav']) assert.ok(protocols.has(p as ConnectionConfig['protocol']), p);
    const depth = Math.max(...saved.map((s) => (normalizeGroup(s.group) ? normalizeGroup(s.group).split('/').length : 0)));
    assert.equal(depth, 6);
    assert.ok(saved.every((s) => s.host.endsWith('.example.test')));
    assert.ok(saved.some((s) => /[ãçé]/.test(`${s.name} ${s.group ?? ''}`)), 'accents');
    const keys = new Map<string, number>();
    for (const s of saved) keys.set(duplicateKey(s)!, (keys.get(duplicateKey(s)!) ?? 0) + 1);
    const dups = saved.filter((s) => (keys.get(duplicateKey(s)!) ?? 0) > 1).length / saved.length;
    assert.ok(dups > 0.1 && dups < 0.3, `duplicates ${dups}`);
    const noPass = saved.filter(needsPassword).length / saved.length;
    assert.ok(noPass > 0.1 && noPass < 0.25, `no password ${noPass}`);
    // Secrets are only ever the stored marker
    assert.ok(saved.every((s) => s.auth.type !== 'Password' || s.auth.value === '' || s.auth.value === '__RUSTSCP_STORED_SECRET__'));
  });
});

describe('mock commands', () => {
  beforeEach(() => resetSiteFallback());

  it('handles only the tree commands', () => {
    assert.equal(SITE_TREE_CMDS.size, 6);
    assert.equal(siteFallback('list_directory', {}, seedSites).handled, false);
    assert.equal(siteFallback('get_saved_sites', {}, seedSites).handled, false, 'until the copy exists');
  });

  it('loads a reconciled layout', () => {
    const res = call<SiteLayoutResponse>('get_site_layout');
    assert.deepEqual(res.layout.folders, ['Clients', 'Clients/Acme']);
    assert.equal(res.read_only, false);
    // From now on get_saved_sites answers from the in-memory copy
    assert.equal(siteFallback('get_saved_sites', {}, seedSites).handled, true);
  });

  it('applies ops, then undoes them', () => {
    const res = call<SiteTreeResult>('apply_site_tree_ops', {
      ops: [
        { op: 'create_folder', path: 'Staging' },
        { op: 'move_sites', ids: ['b'], to: 'Staging' },
        { op: 'copy_sites', items: [{ id: 'a', name: 'a copy', group: null }] },
      ],
      label: 'test',
    });
    assert.match(res.undo_token ?? '', /^undo-[0-9a-f]+$/);
    assert.equal(res.created.length, 1);
    assert.match(res.created[0].id, /^site-[0-9a-f]+$/);
    assert.equal(res.sites.find((s) => s.id === 'b')?.group, 'Staging');
    assert.equal(res.sites.length, 4);

    const undone = call<SiteTreeResult>('undo_site_tree_ops', { token: res.undo_token });
    assert.deepEqual(undone.undo_report, { restored: 2, skipped: 0 });
    assert.deepEqual(undone.sites.map((s) => [s.id, s.group ?? null]), [
      ['local', null],
      ['a', 'Clients/Acme'],
      ['b', null],
    ]);
    assert.ok(!undone.layout.folders.includes('Staging'));
    rejects(() => call('undo_site_tree_ops', { token: res.undo_token }), 'site_tree.undo_expired');
  });

  it('skips a site changed after the op and counts it', () => {
    const res = call<SiteTreeResult>('apply_site_tree_ops', { ops: [{ op: 'move_sites', ids: ['a', 'b'], to: 'Moved' }] });
    // The form saves "a" again (like App's save_site)
    const saved = { ...res.sites.find((s) => s.id === 'a')!, name: 'renamed' };
    assert.equal(siteFallback('save_site', { config: saved }, seedSites).handled, false);
    const undone = call<SiteTreeResult>('undo_site_tree_ops', { token: res.undo_token });
    assert.deepEqual(undone.undo_report, { restored: 1, skipped: 1 });
    assert.equal(undone.sites.find((s) => s.id === 'a')?.group, 'Moved');
    assert.equal(undone.sites.find((s) => s.id === 'b')?.group ?? null, null);
  });

  it('undo puts back the recent entry and favorite of a deleted site, at their old place', () => {
    call('record_site_connected', { id: 'b' });
    call('record_site_connected', { id: 'a' });
    call('apply_site_tree_ops', { ops: [{ op: 'set_favorites', items: [{ kind: 'site', id: 'a' }, { kind: 'site', id: 'b' }] }] });
    const res = call<SiteTreeResult>('apply_site_tree_ops', { ops: [{ op: 'delete_sites', ids: ['a'] }] });
    assert.deepEqual(res.layout.recents.map((r) => r.id), ['b']);
    assert.deepEqual(res.layout.favorites, [{ kind: 'site', id: 'b' }]);
    const undone = call<SiteTreeResult>('undo_site_tree_ops', { token: res.undo_token });
    assert.deepEqual(undone.undo_report, { restored: 1, skipped: 0 });
    assert.deepEqual(undone.layout.recents.map((r) => r.id), ['a', 'b']);
    assert.deepEqual(undone.layout.favorites, [{ kind: 'site', id: 'a' }, { kind: 'site', id: 'b' }]);
  });

  it('gives no undo token when nothing changed (like the backend)', () => {
    const res = call<SiteTreeResult>('apply_site_tree_ops', { ops: [{ op: 'move_sites', ids: ['b'], to: null }] });
    assert.equal(res.undo_token, null);
  });

  it('rejects invalid ops with the backend error text and changes nothing', () => {
    rejects(() => call('apply_site_tree_ops', { ops: [{ op: 'delete_sites', ids: ['local'] }] }), 'site_tree.local_immutable');
    const res = call<SiteLayoutResponse>('get_site_layout');
    assert.deepEqual(res.layout.folders, ['Clients', 'Clients/Acme']);
  });

  it('forgets the undo stack', () => {
    const res = call<SiteTreeResult>('apply_site_tree_ops', { ops: [{ op: 'create_folder', path: 'X' }] });
    assert.equal(call('forget_site_tree_undo'), null);
    rejects(() => call('undo_site_tree_ops', { token: res.undo_token }), 'site_tree.undo_expired');
  });

  it('records connections and applies view patches', () => {
    call('record_site_connected', { id: 'b' });
    call('record_site_connected', { id: 'b' });
    rejects(() => call('record_site_connected', { id: 'local' }), 'site_tree.not_found');
    let layout = call<SiteLayoutResponse>('get_site_layout').layout;
    assert.equal(layout.recents.length, 1);
    assert.equal(layout.recents[0].count, 2);
    assert.equal(typeof layout.recents[0].at, 'number');

    // Seeding only applies while recents is empty
    call('set_site_tree_view', { view: { seed_recents: ['a'] } });
    assert.deepEqual(call<SiteLayoutResponse>('get_site_layout').layout.recents.map((r) => r.id), ['b']);
    call('set_site_tree_view', { view: { clear_recents: true } });
    call('set_site_tree_view', { view: { seed_recents: ['local', 'a', 'gone', 'a'], collapsed: ['Clients', 'Nope'], migrated_local_storage: true } });
    layout = call<SiteLayoutResponse>('get_site_layout').layout;
    assert.deepEqual(layout.recents, [{ id: 'a', at: null, count: 0 }]);
    assert.deepEqual(layout.collapsed, ['Clients']);
    assert.equal(layout.migrated_local_storage, true);
    call('set_site_tree_view', { view: { forget_recents: ['a'] } });
    assert.deepEqual(call<SiteLayoutResponse>('get_site_layout').layout.recents, []);
  });

  it('mirrors delete_site into the copy', () => {
    siteFallback('delete_site', { id: 'a' }, seedSites);
    const layout = call<SiteLayoutResponse>('get_site_layout').layout;
    assert.deepEqual(layout.folders, ['Clients', 'Clients/Acme'], 'folders stay when emptied');
    const sites = siteFallback('get_saved_sites', {}, seedSites) as { value: ConnectionConfig[] };
    assert.deepEqual(sites.value.map((s) => s.id), ['local', 'b']);
  });
});
