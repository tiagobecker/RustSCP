import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMoveRows, firstMatch, initialPick, isPickable, nextPickable } from './moveToModel.ts';
import type { MoveRow, MoveRowsInput } from './moveToModel.ts';

const FOLDERS = ['Clients/Acme/Web', 'Clients/Beta', 'Staging', 'São Paulo/Produção', 'Arquivo'];

const rows = (over: Partial<MoveRowsInput> = {}) =>
  buildMoveRows({ folders: FOLDERS, query: '', recents: [], current: null, disableCurrent: true, moving: [], newFolderParent: null, ...over });

const view = (rs: MoveRow[]) =>
  rs.map((r) => {
    if (r.kind === 'top') return `top${r.disabled ? '!' : ''}${r.current ? '*' : ''}`;
    if (r.kind === 'label') return `[${r.label}]`;
    if (r.kind === 'new') return `+${r.parent}@${r.depth}`;
    return `${'  '.repeat(r.depth)}${r.name}${r.disabled ? '!' : ''}${r.current ? '*' : ''}${r.match ? '~' : ''}`;
  });

describe('Move to… rows', () => {
  it('lists the top level, then every folder fully expanded in natural order', () => {
    assert.deepEqual(view(rows()), ['top', 'Arquivo', 'Clients', '  Acme', '    Web', '  Beta', 'São Paulo', '  Produção', 'Staging']);
  });

  it('disables the shared parent (move mode only) and the moved folders with their insides', () => {
    assert.deepEqual(view(rows({ current: 'Clients', moving: ['Clients/Acme'] })), ['top', 'Arquivo', 'Clients!*', '  Acme!', '    Web!', '  Beta', 'São Paulo', '  Produção', 'Staging']);
    assert.deepEqual(view(rows({ current: '' })).slice(0, 1), ['top!*']);
    // Pick mode: the current folder is tagged but can be chosen
    assert.deepEqual(view(rows({ current: 'Staging', disableCurrent: false })).at(-1), 'Staging*');
  });

  it('shows up to three recent targets that still exist, not while searching', () => {
    const r = rows({ recents: ['Staging', 'Gone', 'Clients/Acme', 'Arquivo', 'Clients/Beta'] });
    assert.deepEqual(view(r).slice(0, 6), ['top', '[recent]', 'Staging', 'Clients / Acme', 'Arquivo', '[all]']);
    assert.deepEqual(view(rows({ recents: ['Staging'], query: 'sta' })), ['top', 'Staging~']);
  });

  it('filters by name ignoring accents, keeping parents for context', () => {
    assert.deepEqual(view(rows({ query: 'producao' })), ['top', 'São Paulo', '  Produção~']);
    assert.deepEqual(view(rows({ query: 'clients/acme' })), ['top', 'Clients', '  Acme~', '    Web~']);
  });

  it('places the inline new-folder row as the first child of its parent', () => {
    assert.deepEqual(view(rows({ newFolderParent: 'Clients' })).slice(0, 5), ['top', 'Arquivo', 'Clients', '+Clients@1', '  Acme']);
    assert.deepEqual(view(rows({ newFolderParent: '' })).slice(0, 2), ['top', '+@0']);
  });

  it('moves the highlight over pickable rows only', () => {
    const r = rows({ current: 'Clients', moving: ['Clients/Acme'], recents: ['Staging'] });
    assert.equal(r[initialPick(r)].key, 'r:Staging');
    const clients = r.findIndex((x) => x.key === 'f:Clients');
    assert.equal(isPickable(r[clients]), false);
    const arquivo = r.findIndex((x) => x.key === 'f:Arquivo');
    assert.equal(r[nextPickable(r, arquivo, 1)].key, 'f:Clients/Beta');
    assert.equal(nextPickable(r, 0, -1), 0);
    assert.equal(r[initialPick(r, 'Staging')].key, 'f:Staging');
    const beta = rows({ query: 'beta' });
    assert.equal(beta[firstMatch(beta)].key, 'f:Clients/Beta');
  });
});
