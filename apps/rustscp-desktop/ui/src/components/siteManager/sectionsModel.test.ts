import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../../types.ts';
import type { FavoriteRef } from './types.ts';
import {
  allFavorites,
  applyRecentsPatch,
  checkFavoriteDrop,
  favoriteChangeCount,
  favoriteKey,
  favoriteRefOf,
  insertFavorites,
  largeLibraryFirstRun,
  legacyMigrationPatch,
  moveFavorite,
  recentLimitFor,
  recordRecent,
  sameFavorites,
  setFavorites,
} from './sectionsModel.ts';
import { MAX_FAVORITES, RECENT_SHOWN, RECENT_SHOWN_FEW, buildTree, defaultLayout, flattenRows } from './siteTreeModel.ts';

const site = (id: string, group: string | null = null): ConnectionConfig => ({
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
});

const LOCAL: ConnectionConfig = { ...site('local'), name: 'Local Machine', protocol: 'local', host: 'localhost', port: 0, auth: { type: 'None', value: null } };

const keys = (list: FavoriteRef[]) => list.map(favoriteKey);

const FAVS: FavoriteRef[] = [
  { kind: 'site', id: 'a' },
  { kind: 'folder', path: 'Clients' },
  { kind: 'site', id: 'b' },
];

describe('favorites', () => {
  it('maps item keys to favorites and back', () => {
    assert.deepEqual(favoriteRefOf('s:web-01'), { kind: 'site', id: 'web-01' });
    assert.deepEqual(favoriteRefOf('f:Clients/Acme'), { kind: 'folder', path: 'Clients/Acme' });
    assert.equal(favoriteRefOf('f:'), null, 'the root is not a favorite');
    assert.equal(favoriteRefOf('sec:all'), null);
    assert.equal(favoriteRefOf('draft'), null);
    assert.equal(favoriteKey({ kind: 'folder', path: 'X/Y' }), 'f:X/Y');
  });

  it('adds at the end, skipping favorites already there, and removes', () => {
    assert.deepEqual(keys(setFavorites(FAVS, ['s:c', 's:a', 'f:Ops', 's:c'], true)), ['s:a', 'f:Clients', 's:b', 's:c', 'f:Ops']);
    assert.deepEqual(keys(setFavorites(FAVS, ['s:a', 'f:Clients', 's:nope'], false)), ['s:b']);
  });

  it('counts what "Add N to favorites" adds: only items not yet favorites', () => {
    const model = buildTree([LOCAL, site('a', 'Clients'), site('b'), site('c')], { ...defaultLayout(), favorites: FAVS });
    assert.equal(favoriteChangeCount(model, ['s:a', 's:b', 's:c']), 1, 'a and b are favorites already');
    assert.equal(favoriteChangeCount(model, ['s:a', 'f:Clients', 'fav:s:a']), 2, 'all favorites: removing counts them all');
    assert.equal(favoriteChangeCount(model, ['s:c', 's:local', 'sec:all']), 2);
  });

  it('knows when every item is a favorite', () => {
    const model = buildTree([LOCAL, site('a', 'Clients'), site('b')], { ...defaultLayout(), favorites: FAVS });
    assert.equal(allFavorites(model, ['s:a', 'f:Clients']), true);
    assert.equal(allFavorites(model, ['s:a', 's:local']), false);
    assert.equal(allFavorites(model, ['sec:all']), false, 'no items: nothing to remove');
  });

  it('moves one place up or down, and not past the ends', () => {
    assert.deepEqual(keys(moveFavorite(FAVS, 's:b', -1) ?? []), ['s:a', 's:b', 'f:Clients']);
    assert.deepEqual(keys(moveFavorite(FAVS, 's:a', 1) ?? []), ['f:Clients', 's:a', 's:b']);
    assert.equal(moveFavorite(FAVS, 's:a', -1), null);
    assert.equal(moveFavorite(FAVS, 's:b', 1), null);
    assert.equal(moveFavorite(FAVS, 's:zzz', 1), null);
  });

  it('inserts dropped items at a position counted before the drop', () => {
    // New items
    assert.deepEqual(keys(insertFavorites(FAVS, ['s:x', 'f:Ops'], 1)), ['s:a', 's:x', 'f:Ops', 'f:Clients', 's:b']);
    assert.deepEqual(keys(insertFavorites(FAVS, ['s:x'], 99)), ['s:a', 'f:Clients', 's:b', 's:x']);
    // Reordering: "a" dropped after "Clients" (position 2 before the drop)
    assert.deepEqual(keys(insertFavorites(FAVS, ['s:a'], 2)), ['f:Clients', 's:a', 's:b']);
    // "b" dropped first
    assert.deepEqual(keys(insertFavorites(FAVS, ['s:b'], 0)), ['s:b', 's:a', 'f:Clients']);
    // A mix: "b" moves, "x" joins, both at the top
    assert.deepEqual(keys(insertFavorites(FAVS, ['s:b', 's:x'], 0)), ['s:b', 's:x', 's:a', 'f:Clients']);
  });

  it('checks a drop: no change, too many, ok', () => {
    assert.equal(checkFavoriteDrop(FAVS, ['s:a'], 0), 'same_place');
    assert.equal(checkFavoriteDrop(FAVS, ['s:a'], 1), 'same_place', 'just after itself');
    assert.equal(checkFavoriteDrop(FAVS, ['s:a'], 2), 'ok');
    assert.equal(checkFavoriteDrop(FAVS, ['s:new'], 3), 'ok');
    const full: FavoriteRef[] = Array.from({ length: MAX_FAVORITES }, (_, i) => ({ kind: 'site', id: `s${i}` }));
    assert.equal(checkFavoriteDrop(full, ['s:one-more'], 0), 'too_many');
    assert.equal(checkFavoriteDrop(full, ['s:s5'], 0), 'ok', 'reordering a full list is fine');
    assert.equal(sameFavorites(FAVS, [...FAVS]), true);
  });
});

describe('Recent keeps the folder tree in view', () => {
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'];
  const sites = [LOCAL, ...ids.map((id) => site(id, 'Team')), site('fav1'), site('fav2')];
  const layout = {
    ...defaultLayout(),
    favorites: [{ kind: 'site', id: 'fav1' }, { kind: 'site', id: 'fav2' }, { kind: 'site', id: 'r1' }] as FavoriteRef[],
    recents: ids.map((id, i) => ({ id, at: 100 - i, count: 1 })),
  };
  const model = buildTree(sites, layout);
  const flat = (allRecent: boolean) => flattenRows(model, { collapsed: new Set(), recentLimit: recentLimitFor(allRecent) }).rows;

  it('lists the first 3 recent rows until "Show all", with the total for the header', () => {
    assert.equal(recentLimitFor(false), RECENT_SHOWN_FEW);
    assert.equal(recentLimitFor(true), RECENT_SHOWN);
    const rows = flat(false);
    const header = rows.find((r) => r.key === 'sec:rec');
    // r1 is a favorite (not repeated in Recent): r2…r9, of which 8 can show
    assert.deepEqual(rows.filter((r) => r.section === 'rec' && r.kind === 'site').map((r) => r.key), ['rec:r2', 'rec:r3', 'rec:r4']);
    assert.equal(header?.kind === 'section' && header.count, 3);
    assert.equal(header?.kind === 'section' && header.total, 8);
    // "All connections" comes right after: 1 + 3 favorites, 1 + 3 recent
    assert.equal(rows.findIndex((r) => r.key === 'sec:all'), 8);
  });

  it('shows all 8 once asked, and none of them is lost either way', () => {
    const rows = flat(true);
    assert.deepEqual(
      rows.filter((r) => r.section === 'rec' && r.kind === 'site').map((r) => r.key),
      ['rec:r2', 'rec:r3', 'rec:r4', 'rec:r5', 'rec:r6', 'rec:r7', 'rec:r8', 'rec:r9']
    );
    const header = rows.find((r) => r.key === 'sec:rec');
    assert.equal(header?.kind === 'section' && header.count, 8);
    assert.equal(header?.kind === 'section' && header.total, 8);
  });
});

describe('first run of a large library', () => {
  const folders = ['A', 'A/B', 'A/B/C', 'D', 'D/E'];

  it('collapses every folder below the top level once, above 300 sites', () => {
    const run = largeLibraryFirstRun({ folders, collapsed: [], large_library_collapsed: false }, 301);
    assert.deepEqual(run, { collapsed: ['A/B', 'A/B/C', 'D/E'] });
  });

  it('does nothing for small libraries or once done', () => {
    assert.equal(largeLibraryFirstRun({ folders, collapsed: [], large_library_collapsed: false }, 300), null);
    assert.equal(largeLibraryFirstRun({ folders, collapsed: [], large_library_collapsed: true }, 5000), null);
  });

  it('keeps a collapsed state the user already has, but sets the flag', () => {
    assert.deepEqual(largeLibraryFirstRun({ folders, collapsed: ['D'], large_library_collapsed: false }, 1000), { collapsed: null });
  });
});

describe('migration from WebView storage', () => {
  const sites = [LOCAL, site('a'), site('b'), site('c')];

  it('carries the collapsed folders and seeds Recent newest first', () => {
    const patch = legacyMigrationPatch(JSON.stringify(['Clients/ Acme ', '', 42, 'Clients/ Acme']), JSON.stringify({ a: '/x', 'sftp://host': '/y', local: '/', c: '/z' }), sites);
    assert.deepEqual(patch, { migrated_local_storage: true, collapsed: ['Clients/Acme'], seed_recents: ['c', 'a'] });
  });

  it('survives missing or broken values', () => {
    assert.deepEqual(legacyMigrationPatch(null, null, sites), { migrated_local_storage: true });
    assert.deepEqual(legacyMigrationPatch('{nope', '[1,2]', sites), { migrated_local_storage: true });
  });
});

describe('recents', () => {
  it('records a connection at the front with its count raised', () => {
    const layout = { ...defaultLayout(), recents: [{ id: 'a', at: 10, count: 2 }, { id: 'b', at: 5, count: 1 }] };
    const next = recordRecent(layout, 'b', 99, 50);
    assert.deepEqual(next.recents, [{ id: 'b', at: 99, count: 2 }, { id: 'a', at: 10, count: 2 }]);
    assert.equal(recordRecent(layout, 'local', 99, 50), layout, 'Local is never recent');
    assert.equal(recordRecent(layout, 'c', 99, 2).recents.length, 2, 'capped');
  });

  it('applies "Remove from recent" and "Clear recent" locally', () => {
    const layout = { ...defaultLayout(), recents: [{ id: 'a', at: 10, count: 2 }, { id: 'b', at: 5, count: 1 }] };
    assert.deepEqual(applyRecentsPatch(layout, { forget_recents: ['a'] }).recents.map((r) => r.id), ['b']);
    assert.deepEqual(applyRecentsPatch(layout, { clear_recents: true }).recents, []);
    assert.equal(applyRecentsPatch(layout, { collapsed: ['X'] }), layout, 'other fields leave it alone');
    assert.equal(applyRecentsPatch(layout, { large_library_collapsed: true }).large_library_collapsed, true);
  });
});
