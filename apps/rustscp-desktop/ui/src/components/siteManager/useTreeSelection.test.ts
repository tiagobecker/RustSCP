import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../../types.ts';
import { buildTree, flattenRows } from './siteTreeModel.ts';
import { canonicalItems, canonicalKey, firstChildIndex, moveIndex, parentIndex, rangeKeys, sectionBounds } from './useTreeSelection.ts';

const site = (id: string, group: string | null): ConnectionConfig => ({
  id,
  name: id,
  protocol: 'sftp',
  host: `${id}.example.test`,
  port: 22,
  username: 'u',
  auth: { type: 'Password', value: 'x' },
  remote_root: '',
  group,
});

const local: ConnectionConfig = { id: 'local', name: 'Local', protocol: 'local', host: 'localhost', port: 0, username: '', auth: { type: 'None', value: null }, remote_root: '' };

const rowsFor = (collapsed: string[] = []) => {
  const model = buildTree([local, site('a', 'Prod'), site('b', 'Prod/Web'), site('c', null)], null);
  return flattenRows(model, { collapsed: new Set(collapsed) }).rows;
};

describe('tree selection helpers', () => {
  it('maps row keys to canonical items', () => {
    assert.equal(canonicalKey('s:a'), 's:a');
    assert.equal(canonicalKey('fav:s:a'), 's:a');
    assert.equal(canonicalKey('fav:f:Prod/Web'), 'f:Prod/Web');
    assert.equal(canonicalKey('rec:a'), 's:a');
    assert.equal(canonicalKey('fav:f:Prod\u001fs:b'), 's:b');
    assert.equal(canonicalKey('sec:all'), 'sec:all');
    assert.deepEqual(canonicalItems(['s:a', 'fav:s:a', 'rec:a', 'f:Prod']), ['s:a', 'f:Prod']);
  });

  it('moves within bounds', () => {
    assert.equal(moveIndex(5, 2, 1), 3);
    assert.equal(moveIndex(5, 4, 1), 4);
    assert.equal(moveIndex(5, 0, -1), 0);
    assert.equal(moveIndex(5, -1, 1), 0);
    assert.equal(moveIndex(5, -1, -1), 4);
    assert.equal(moveIndex(5, 1, 10), 4);
    assert.equal(moveIndex(0, 0, 1), -1);
  });

  it('finds parents and first children', () => {
    const rows = rowsFor();
    const keys = rows.map((r) => r.key);
    assert.deepEqual(keys, ['sec:all', 's:local', 'f:Prod', 'f:Prod/Web', 's:b', 's:a', 's:c']);
    const at = (k: string) => keys.indexOf(k);
    assert.equal(parentIndex(rows, at('s:b')), at('f:Prod/Web'));
    assert.equal(parentIndex(rows, at('s:a')), at('f:Prod'));
    assert.equal(parentIndex(rows, at('f:Prod')), at('sec:all'));
    assert.equal(parentIndex(rows, at('s:c')), at('sec:all'));
    assert.equal(parentIndex(rows, at('sec:all')), -1);
    assert.equal(firstChildIndex(rows, at('sec:all')), at('s:local'));
    assert.equal(firstChildIndex(rows, at('f:Prod')), at('f:Prod/Web'));
    assert.equal(firstChildIndex(rows, at('s:a')), -1);
    const collapsed = rowsFor(['Prod']);
    assert.equal(firstChildIndex(collapsed, collapsed.findIndex((r) => r.key === 'f:Prod')), -1);
  });

  it('keeps ranges inside one section and leaves headers out', () => {
    const rows = rowsFor();
    assert.deepEqual(sectionBounds(rows, 3), [0, rows.length]);
    assert.deepEqual(rangeKeys(rows, 4, 2), ['f:Prod', 'f:Prod/Web', 's:b']);
    assert.deepEqual(rangeKeys(rows, 1, 0), ['s:local']);
    assert.deepEqual(rangeKeys(rows, 9, 0), []);
  });
});

describe('multi-selection helpers', () => {
  it('derives the right pane from the selection', async () => {
    const { paneFor, selectedItems } = await import('./useTreeSelection.ts');
    assert.deepEqual(paneFor([]), { kind: 'form' });
    assert.deepEqual(paneFor(['draft']), { kind: 'form' });
    assert.deepEqual(paneFor(['s:a']), { kind: 'form' });
    assert.deepEqual(paneFor(['f:Prod']), { kind: 'folder', path: 'Prod' });
    assert.deepEqual(paneFor(['sec:all']), { kind: 'root' });
    assert.deepEqual(paneFor(['s:a', 'fav:s:a']), { kind: 'form' });
    assert.deepEqual(paneFor(['s:a', 'f:Prod', 'draft']), { kind: 'selection', items: ['s:a', 'f:Prod'] });
    assert.deepEqual(selectedItems(['rec:a', 's:a', 'sec:all', 'f:X', 'addr']), ['s:a', 'f:X']);
  });

  it('ranges hold sites and folders only', () => {
    const model = buildTree([local, site('a', 'Prod'), site('b', 'Empty/Inner'), site('c', null)], { ...defaultLayoutForTest(), folders: ['Void'] });
    const rows = flattenRows(model, { collapsed: new Set(), draft: { folder: '', name: '' } }).rows;
    const keys = rows.map((r) => r.key);
    assert.ok(keys.includes('draft'));
    assert.ok(keys.includes('ph:Void'));
    const range = rangeKeys(rows, keys.indexOf('s:local'), rows.length - 1);
    assert.ok(!range.includes('draft'));
    assert.ok(!range.includes('ph:Void'));
    assert.ok(range.includes('f:Void') && range.includes('s:c'));
  });
});

function defaultLayoutForTest() {
  return { version: 1, folders: [], favorites: [], recents: [], labels: [], site_labels: {}, folder_labels: {}, collapsed: [], migrated_local_storage: false, large_library_collapsed: false };
}
