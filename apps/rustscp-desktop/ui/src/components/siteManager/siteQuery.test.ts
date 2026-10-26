import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../../types.ts';
import type { SiteLayout } from './types.ts';
import { buildTree, defaultLayout, flattenRows } from './siteTreeModel.ts';
import {
  ADDRESS_RE,
  activeValues,
  addressFromQuery,
  clearQualifiers,
  describeTokens,
  highlightTerms,
  looksLikeAddress,
  matchContext,
  matchRanges,
  matchSite,
  parseAddressInput,
  parseQuery,
  rankSite,
  removeToken,
  searchTree,
  toggleQualifier,
} from './siteQuery.ts';
import { demoSites } from './siteDevFallback.ts';

const STORED = '__RUSTSCP_STORED_SECRET__';

const site = (id: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: id,
  protocol: 'sftp',
  host: `${id}.example.test`,
  port: 22,
  username: 'deploy',
  auth: { type: 'Password', value: STORED },
  remote_root: '',
  tls_fingerprint: null,
  group: null,
  ...over,
});

const LOCAL = site('local', { name: 'Local Machine', protocol: 'local', host: 'localhost', port: 0, username: 'user', auth: { type: 'None', value: null } });

const library = (): ConnectionConfig[] => [
  LOCAL,
  site('web-01', { group: 'Produção/Web', host: 'web-01.prod.example.test' }),
  site('web-02', { group: 'Produção/Web', host: 'web-02.prod.example.test', username: 'root' }),
  site('db', { name: 'Banco São Paulo', group: 'Produção/Banco de dados', host: 'db.prod.example.test', auth: { type: 'Password', value: '' } }),
  site('ftp-old', { name: 'Legacy FTP', protocol: 'ftp', port: 21, host: 'ftp.example.test', group: 'Legacy' }),
  site('ftp-anon', { name: 'Mirror', protocol: 'ftp', port: 21, host: 'mirror.example.test', username: 'anonymous', auth: { type: 'None', value: null } }),
  site('files', { name: 'Files', protocol: 'ftps', port: 990, host: 'files.example.test', group: 'Clientes/Acme' }),
  site('bucket', { name: 'Backups', protocol: 's3', port: 443, host: 's3.example.test', username: 'AKIAEXAMPLE', remote_root: '/backups', group: 'Clientes/Acme/Storage' }),
  site('dav', { name: 'Docs', protocol: 'webdav', port: 443, host: 'dav.example.test', group: 'Clientes/Globex' }),
  site('key', { name: 'Bastion', host: 'bastion.example.test', auth: { type: 'PrivateKey', value: { path: '~/.ssh/id_ed25519', passphrase: null } } }),
  site('agent', { name: 'Agent box', host: 'agent.example.test', auth: { type: 'None', value: null } }),
  // A duplicate of web-01's server, filed elsewhere
  site('web-01-copy', { name: 'web-01 (old)', group: 'Legacy', host: 'WEB-01.prod.example.test' }),
];

const layoutWith = (over: Partial<SiteLayout>): SiteLayout => ({ ...defaultLayout(), ...over });

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

const setup = (layout: SiteLayout = defaultLayout()) => {
  const model = buildTree(library(), layout);
  const ctx = matchContext(model, { nowMs: NOW });
  const ids = (text: string) => [...searchTree(model, parseQuery(text), ctx).siteIds].sort();
  return { model, ctx, ids };
};

describe('parseQuery', () => {
  it('splits words and keeps quoted phrases together', () => {
    const q = parseQuery('  web   "São Paulo"  db ');
    assert.deepEqual(
      q.words.map((t) => t.values[0]),
      ['web', 'São Paulo', 'db']
    );
    assert.deepEqual(q.words[1].folded, ['sao paulo']);
    assert.equal(q.hasQualifiers, false);
  });

  it('reads negation on words and qualifiers', () => {
    const q = parseQuery('-web -p:ftp');
    assert.equal(q.tokens[0].negated, true);
    assert.equal(q.tokens[0].key, null);
    assert.equal(q.tokens[1].negated, true);
    assert.equal(q.tokens[1].key, 'p');
    assert.deepEqual(q.tokens[1].folded, ['ftp']);
  });

  it('treats keys case-insensitively, with aliases', () => {
    const q = parseQuery('P:SSH Proto:scp PROTOCOL:Ftpes IN:Clientes Is:Favorites AUTH:Pw');
    assert.deepEqual(
      q.qualifiers.map((t) => [t.key, t.folded]),
      [
        ['p', ['sftp']],
        ['p', ['sftp']],
        ['p', ['ftps']],
        ['in', ['clientes']],
        ['is', ['fav']],
        ['auth', ['password']],
      ]
    );
  });

  it('splits commas into OR values, also inside quotes when unquoted', () => {
    const q = parseQuery('p:sftp,ftps in:"Banco de dados","São Paulo"');
    assert.deepEqual(q.qualifiers[0].values, ['sftp', 'ftps']);
    assert.deepEqual(q.qualifiers[1].values, ['Banco de dados', 'São Paulo']);
    assert.deepEqual(q.qualifiers[1].folded, ['banco de dados', 'sao paulo']);
  });

  it('treats an unknown key as a plain word', () => {
    const q = parseQuery('foo:bar sftp://root@host');
    assert.equal(q.hasQualifiers, false);
    assert.deepEqual(
      q.words.map((t) => t.values[0]),
      ['foo:bar', 'sftp://root@host']
    );
  });

  it('ignores an unfinished qualifier and a lone dash', () => {
    const q = parseQuery('web p: -');
    assert.equal(q.hasQualifiers, false);
    assert.equal(q.words.length, 1);
    assert.equal(q.tokens.length, 2);
    assert.equal(parseQuery('   ').isEmpty, true);
  });

  it('folds accents and case', () => {
    assert.deepEqual(parseQuery('AÇÃO').words[0].folded, ['acao']);
  });
});

describe('editing the query text', () => {
  const roundTrip = (text: string, key: Parameters<typeof toggleQualifier>[1], value: string) => {
    const on = toggleQualifier(text, key, value, true);
    return { on, off: toggleQualifier(on, key, value, false) };
  };

  it('toggles a value on and off again (round trip)', () => {
    assert.deepEqual(roundTrip('web', 'p', 'sftp'), { on: 'web p:sftp', off: 'web' });
    assert.deepEqual(roundTrip('', 'is', 'fav'), { on: 'is:fav', off: '' });
    assert.deepEqual(roundTrip('web p:ftp', 'p', 'sftp'), { on: 'web p:ftp,sftp', off: 'web p:ftp' });
    assert.deepEqual(roundTrip('web is:fav', 'is', 'dup'), { on: 'web is:fav is:dup', off: 'web is:fav' });
    assert.deepEqual(roundTrip('a in:x b', 'auth', 'key'), { on: 'a in:x b auth:key', off: 'a in:x b' });
  });

  it('keeps the rest of the text untouched when removing from the middle', () => {
    assert.equal(toggleQualifier('web p:sftp db', 'p', 'sftp', false), 'web db');
    assert.equal(toggleQualifier('web proto:ftp,sftp db', 'p', 'ssh', false), 'web proto:ftp db');
  });

  it('does not add a value twice (aliases included)', () => {
    assert.equal(toggleQualifier('p:ssh', 'p', 'sftp', true), 'p:ssh');
    assert.equal(toggleQualifier('is:favorites', 'is', 'fav', true), 'is:favorites');
  });

  it('fills an unfinished qualifier instead of adding another', () => {
    assert.equal(toggleQualifier('web p:', 'p', 'ftps', true), 'web p:ftps');
  });

  it('quotes values with spaces or commas', () => {
    assert.equal(toggleQualifier('', 'label', 'Big client', true), 'label:"Big client"');
    assert.equal(toggleQualifier('label:"Big client"', 'label', 'Big client', false), '');
  });

  it('leaves negated tokens alone', () => {
    assert.equal(toggleQualifier('-p:ftp', 'p', 'ftp', false), '-p:ftp');
    assert.deepEqual([...activeValues(parseQuery('-p:ftp p:sftp,ssh'), 'p')], ['sftp']);
  });

  it('removes a token by index and clears every qualifier', () => {
    assert.equal(removeToken('web p:sftp is:fav', 1), 'web is:fav');
    assert.equal(removeToken('web', 5), 'web');
    assert.equal(clearQualifiers('web p:sftp "a b" -is:dup in:x'), 'web "a b"');
  });

  it('describes qualifiers as pills (canonical protocol, is and auth values)', () => {
    assert.deepEqual(describeTokens(parseQuery('web p:ssh,ftps -p:ftp in:Clientes is:favorites auth:pw p:')), [
      { index: 1, key: 'p', negated: false, values: ['sftp', 'ftps'] },
      { index: 2, key: 'p', negated: true, values: ['ftp'] },
      { index: 3, key: 'in', negated: false, values: ['Clientes'] },
      { index: 4, key: 'is', negated: false, values: ['fav'] },
      { index: 5, key: 'auth', negated: false, values: ['password'] },
    ]);
  });
});

describe('addresses', () => {
  /** LoginDialog's splitHostInput before the regex moved, applied to a blank form. */
  const legacySplit = (raw: string) => {
    const form = { protocol: 'sftp', host: '', username: '', port: '22', remoteRoot: '' };
    const value = raw.trim();
    const m = value.match(/^(?:(sftp|scp|ftps|ftpes|ftp|s3|https?):\/\/)?(?:([^@\s/]+)@)?([^:/\s]+)(?::(\d{1,5}))?(\/[^\s]*)?$/i);
    if (!m || !(m[1] || m[2] || m[4] || m[5])) return null;
    const [, scheme, user, h, p, path] = m;
    if (scheme && !/^https?$/i.test(scheme)) form.protocol = /^ftpes$/i.test(scheme) ? 'ftps' : scheme.toLowerCase();
    if (/^https?$/i.test(scheme || '')) return form;
    form.host = h;
    if (user) form.username = user;
    if (p) form.port = p;
    if (path && path !== '/') form.remoteRoot = path;
    return form;
  };

  /** The same steps written against parseAddressInput. */
  const newSplit = (raw: string) => {
    const a = parseAddressInput(raw);
    if (!a) return null;
    const form = { protocol: 'sftp', host: '', username: '', port: '22', remoteRoot: '' };
    if (a.protocol) form.protocol = a.protocol;
    if (a.httpEndpoint) return form;
    form.host = a.host;
    if (a.user) form.username = a.user;
    if (a.port) form.port = a.port;
    if (a.path && a.path !== '/') form.remoteRoot = a.path;
    return form;
  };

  const samples = [
    'root@10.0.0.5',
    'sftp://deploy@web-01.example.test:2222/var/www',
    'SFTP://Deploy@Host',
    'scp://h',
    'ftpes://user@ftp.example.test',
    'ftps://ftp.example.test:990',
    'ftp://anonymous@mirror.example.test/pub',
    's3://s3.example.test/bucket',
    'https://minio.example.test:9000',
    'http://x',
    'host:22',
    'host/path',
    'host/',
    'example.test',
    'web01',
    'user@',
    '@host',
    'a b',
    'sftp://',
    'host:99999',
    '  root@h:22  ',
    'webdav://dav.example.test',
    '',
  ];

  it('ADDRESS_RE gives the same results as splitHostInput', () => {
    for (const s of samples) assert.deepEqual(newSplit(s), legacySplit(s), s);
    assert.equal(ADDRESS_RE.test('user@host:22'), true);
  });

  it('offers the address row only for address-like text without qualifiers', () => {
    assert.equal(looksLikeAddress('root@10.0.0.5'), true);
    assert.equal(looksLikeAddress('example.test'), true);
    assert.equal(looksLikeAddress('sftp://h'), true);
    assert.equal(looksLikeAddress('web01'), false);
    assert.equal(looksLikeAddress('host/path'), false);
    assert.equal(addressFromQuery(parseQuery(' root@10.0.0.5 ')), 'root@10.0.0.5');
    assert.equal(addressFromQuery(parseQuery('web p:sftp')), null);
    assert.equal(addressFromQuery(parseQuery('p:sftp')), null);
    assert.equal(addressFromQuery(parseQuery('-x.example.test')), null);
    assert.equal(addressFromQuery(parseQuery('two words.test')), null);
  });
});

describe('matching', () => {
  it('matches words against name, host, user, folder, protocol and port, ignoring accents', () => {
    const { ids } = setup();
    assert.deepEqual(ids('sao paulo'), ['db']);
    assert.deepEqual(ids('produção web'), ['web-01', 'web-02']);
    assert.deepEqual(ids('root@web-02'), ['web-02']);
    assert.deepEqual(ids('files.example.test:990'), ['files']);
    assert.deepEqual(ids('webdav'), ['dav']);
    // A word that matches a folder name matches everything inside it
    assert.deepEqual(ids('acme'), ['bucket', 'files']);
  });

  it('negates words and qualifiers', () => {
    const { ids } = setup();
    // "web" also matches the WebDAV tag
    assert.deepEqual(ids('web -legacy'), ['dav', 'web-01', 'web-02']);
    assert.deepEqual(ids('web -legacy -p:webdav'), ['web-01', 'web-02']);
    assert.deepEqual(ids('p:ftp,ftps -user:anonymous'), ['files', 'ftp-old']);
  });

  it('p: matches canonical protocols, with local', () => {
    const { ids } = setup();
    assert.deepEqual(ids('p:local'), ['local']);
    assert.deepEqual(ids('p:s3,webdav'), ['bucket', 'dav']);
    assert.deepEqual(ids('p:nope'), []);
  });

  it('in: matches a folder segment prefix, or a path prefix when it has a slash; subfolders included', () => {
    const { ids } = setup();
    assert.deepEqual(ids('in:acme'), ['bucket', 'files']);
    assert.deepEqual(ids('in:clientes/ac'), ['bucket', 'files']);
    assert.deepEqual(ids('in:storage'), ['bucket']);
    assert.deepEqual(ids('in:"banco de"'), ['db']);
    assert.deepEqual(ids('in:dados'), []);
  });

  it('host:, user: and port:', () => {
    const { ids } = setup();
    assert.deepEqual(ids('host:prod user:root'), ['web-02']);
    assert.deepEqual(ids('port:990'), ['files']);
  });

  it('is:dup finds the same server (case-insensitive host) and never Local', () => {
    const { ids } = setup();
    assert.deepEqual(ids('is:dup'), ['web-01', 'web-01-copy']);
  });

  it('is:nopass uses the password gate (anonymous FTP and keys pass)', () => {
    const { ids } = setup();
    assert.deepEqual(ids('is:nopass'), ['db']);
  });

  it('auth: password, key, agent, none', () => {
    const { ids } = setup();
    assert.deepEqual(ids('auth:key'), ['key']);
    assert.deepEqual(ids('auth:agent'), ['agent']);
    assert.deepEqual(ids('auth:none'), ['db', 'ftp-anon']);
  });

  it('is:unfiled, is:fav (folders included), is:recent and is:open', () => {
    const layout = layoutWith({
      favorites: [
        { kind: 'site', id: 'key' },
        { kind: 'folder', path: 'Clientes/Acme' },
      ],
      recents: [
        { id: 'web-01', at: NOW / 1000 - 3600, count: 2 },
        { id: 'db', at: NOW / 1000 - 40 * 86_400, count: 1 },
        { id: 'dav', at: null, count: 0 },
      ],
    });
    const { model, ids } = setup(layout);
    assert.deepEqual(ids('is:unfiled'), ['agent', 'ftp-anon', 'key']);
    assert.deepEqual(ids('is:fav'), ['bucket', 'files', 'key']);
    assert.deepEqual(ids('is:recent'), ['dav', 'web-01']);
    const ctx = matchContext(model, { nowMs: NOW, openSiteIds: new Set(['dav']) });
    assert.deepEqual([...searchTree(model, parseQuery('is:open'), ctx).siteIds], ['dav']);
  });

  it('label: matches the effective (inherited) label name by prefix', () => {
    const layout = layoutWith({
      labels: [
        { id: 'label-a', name: 'Produção', color: 'red' },
        { id: 'label-b', name: 'Staging', color: 'yellow' },
      ],
      folder_labels: { Produção: 'label-a' },
      site_labels: { 'web-02': 'label-b' },
    });
    const { ids } = setup(layout);
    assert.deepEqual(ids('label:prod'), ['db', 'web-01']);
    assert.deepEqual(ids('label:staging'), ['web-02']);
  });

  it('finds empty folders with is:empty and by name, never with site-only qualifiers', () => {
    const layout = layoutWith({ folders: ['Arquivo/2019', 'Clientes/Initech'] });
    const { model, ctx } = setup(layout);
    const folders = (text: string) => [...searchTree(model, parseQuery(text), ctx).folderPaths].sort();
    assert.deepEqual(folders('is:empty'), ['Arquivo', 'Arquivo/2019', 'Clientes/Initech']);
    assert.deepEqual(folders('initech'), ['Clientes/Initech']);
    assert.deepEqual(folders('p:sftp'), []);
    assert.equal(searchTree(model, parseQuery('is:empty'), ctx).siteIds.size, 0);
  });

  it('matchSite agrees with searchTree', () => {
    const { model, ctx } = setup();
    const q = parseQuery('web -p:ftp');
    const viaMatch = [...model.sitesById.values()].filter((s) => matchSite(s, q, ctx)).map((s) => s.id);
    assert.deepEqual(new Set(viaMatch), searchTree(model, q, ctx).siteIds);
  });
});

describe('ranking', () => {
  it('scores name before host before user before folder, with recent and favorite bonuses', () => {
    const layout = layoutWith({ favorites: [{ kind: 'site', id: 'web-02' }], recents: [{ id: 'web-01', at: NOW / 1000 - 60, count: 1 }] });
    const { model, ctx } = setup(layout);
    const score = (id: string, text: string) => rankSite(model.sitesById.get(id) as ConnectionConfig, parseQuery(text), ctx);
    assert.equal(score('files', 'files'), 100);
    assert.equal(score('bucket', 'back'), 80);
    assert.equal(score('agent', 'box'), 60);
    assert.equal(score('ftp-old', 'acy'), 40);
    assert.equal(score('dav', 'dav'), 35);
    assert.equal(score('dav', 'example'), 25);
    assert.equal(score('web-02', 'root'), 15 + 5);
    assert.equal(score('bucket', 'storage'), 10);
    assert.equal(score('web-01', 'web-01'), 100 + 10);
  });

  it('ranks a flat list, ties in natural name order', () => {
    const { model, ctx } = setup();
    const res = searchTree(model, parseQuery('web'), ctx, { asList: true });
    // Three names start with "web" (80, natural order); Docs matches only through its WebDAV tag (0)
    assert.deepEqual(res.ranked, ['s:web-01', 's:web-01-copy', 's:web-02', 's:dav']);
  });
});

describe('search rows', () => {
  it('shows matches with the folders above them, expanded, counting matches; address row last', () => {
    const { model, ctx } = setup();
    const q = parseQuery('files.example.test');
    const res = searchTree(model, q, ctx);
    const { rows } = flattenRows(model, { collapsed: new Set(['Clientes']), search: res, address: addressFromQuery(q) });
    assert.deepEqual(
      rows.map((r) => r.key),
      ['sec:all', 'f:Clientes', 'f:Clientes/Acme', 's:files', 'addr']
    );
    const folder = rows[1];
    assert.equal(folder.kind === 'folder' && folder.expanded && folder.count, 1);
  });

  it('puts the address row first when nothing matches', () => {
    const { model, ctx } = setup();
    const q = parseQuery('root@10.0.0.5');
    const { rows } = flattenRows(model, { collapsed: new Set(), search: searchTree(model, q, ctx), address: addressFromQuery(q) });
    assert.deepEqual(
      rows.map((r) => [r.key, r.posinset, r.setsize]),
      [
        ['addr', 1, 2],
        ['sec:all', 2, 2],
      ]
    );
  });
});

describe('highlighting', () => {
  it('maps folded matches back to the original text', () => {
    assert.deepEqual(matchRanges('Banco São Paulo', ['sao']), [[6, 9]]);
    assert.deepEqual(matchRanges('web-01 WEB', ['web']), [
      [0, 3],
      [7, 10],
    ]);
    // Decomposed input: the combining mark belongs to the highlighted letter
    assert.deepEqual(matchRanges('São', ['sao']), [[0, 4]]);
    // Overlapping terms merge
    assert.deepEqual(matchRanges('abcdef', ['abc', 'cde']), [[0, 5]]);
    assert.deepEqual(matchRanges('abc', []), []);
  });

  it('collects terms per field', () => {
    const q = parseQuery('web -db host:prod user:root in:acme');
    assert.deepEqual(highlightTerms(q, 'name'), ['web']);
    assert.deepEqual(highlightTerms(q, 'address'), ['web', 'prod', 'root']);
    assert.deepEqual(highlightTerms(q, 'path'), ['web', 'acme']);
  });
});

describe('performance', () => {
  it('filters 3,000 sites well within a keystroke', () => {
    const model = buildTree(demoSites(3000), null);
    const ctx = matchContext(model, { nowMs: NOW });
    searchTree(model, parseQuery('warm up'), ctx); // builds the cached search records
    const queries = ['w', 'we', 'web', 'web-0', 'sao', 'p:sftp,ftps in:clientes', 'is:dup -p:s3'];
    const start = performance.now();
    for (const text of queries) searchTree(model, parseQuery(text), ctx);
    const perQuery = (performance.now() - start) / queries.length;
    // The UI target is 8 ms; leave room for slow CI machines
    assert.ok(perQuery < 40, `${perQuery.toFixed(2)} ms per query`);
  });
});
