import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../../types.ts';
import type { LabelDef, SiteLayout, SiteRow, FolderRow } from './types.ts';
import {
  LABEL_PRESETS,
  labelChoiceState,
  labelDefsProblems,
  labelSourceFolder,
  labelUsage,
  newLabelId,
  nextNewLabel,
  planSetLabel,
  sameLabelDefs,
  layoutSiteLabel,
  siteLabelInfo,
  unusedPresets,
} from './labelsModel.ts';
import { applyOpsLocally, buildTree, defaultLayout, flattenRows, sitesOfItems } from './siteTreeModel.ts';
import { matchContext, parseQuery, searchTree } from './siteQuery.ts';

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

const PROD: LabelDef = { id: 'label-prod', name: 'Production', color: 'red' };
const STG: LabelDef = { id: 'label-stg', name: 'Staging', color: 'yellow' };

const SITES = [LOCAL, site('web-01', 'Clients/Acme'), site('web-02', 'Clients/Acme'), site('db-01', 'Clients/Acme/DB'), site('own', 'Clients/Acme'), site('solo')];

const layout = (over: Partial<SiteLayout> = {}): SiteLayout => ({
  ...defaultLayout(),
  labels: [PROD, STG],
  folder_labels: { Clients: 'label-prod' },
  site_labels: { own: 'label-stg' },
  ...over,
});

let counter = 0;
const fakeId = () => `label-new${++counter}`;

describe('labels: inheritance and the dot rule', () => {
  it('a folder label applies inside unless a nearer item has its own', () => {
    const model = buildTree(SITES, layout());
    assert.equal(model.siteLabel.get('web-01'), 'label-prod');
    assert.equal(model.siteLabel.get('db-01'), 'label-prod');
    assert.equal(model.siteLabel.get('own'), 'label-stg');
    assert.equal(model.siteLabel.get('solo'), undefined);
    assert.equal(model.siteOwnLabel.get('own'), 'label-stg');
    assert.equal(model.siteOwnLabel.get('web-01'), undefined);
    assert.equal(labelSourceFolder(model, 'Clients/Acme/DB'), 'Clients');
    assert.equal(labelSourceFolder(model, ''), null);
  });

  it('the tree shows a dot only where the label changes; lists always show it', () => {
    const model = buildTree(SITES, layout({ favorites: [{ kind: 'site', id: 'web-01' }] }));
    const { rows } = flattenRows(model, { collapsed: new Set(), showRecent: false });
    const row = (key: string) => rows.find((r) => r.key === key) as SiteRow | FolderRow;
    assert.equal(row('f:Clients').labelDot, true, 'the labelled folder shows its dot');
    assert.equal(row('f:Clients').labelDef?.name, 'Production');
    assert.equal(row('f:Clients/Acme').labelDot, false, 'inherited: no repeat');
    assert.equal(row('f:Clients/Acme').label, 'label-prod');
    assert.equal(row('s:web-01').labelDot, false);
    assert.equal(row('s:own').labelDot, true, 'its own label differs from the folder');
    assert.equal(row('s:solo').labelDot, false);
    assert.equal(row('fav:s:web-01').labelDot, true, 'Favorites show the effective dot');

    const asList = searchTree(model, parseQuery('web'), matchContext(model), { asList: true });
    const listed = flattenRows(model, { collapsed: new Set(), search: asList }).rows.find((r) => r.key === 's:web-01') as SiteRow;
    assert.equal(listed.labelDot, true, 'list results show the effective dot');
  });

  it('a site whose own label equals the folder one shows no dot', () => {
    const model = buildTree(SITES, layout({ site_labels: { 'web-01': 'label-prod' } }));
    const { rows } = flattenRows(model, { collapsed: new Set() });
    assert.equal((rows.find((r) => r.key === 's:web-01') as SiteRow).labelDot, false);
  });

  it('label: matches inherited labels by prefix', () => {
    const model = buildTree(SITES, layout());
    const res = searchTree(model, parseQuery('label:prod'), matchContext(model));
    assert.deepEqual([...res.siteIds].sort(), ['db-01', 'web-01', 'web-02']);
  });

  it('is:open matches sites with an open tab', () => {
    const model = buildTree(SITES, layout());
    const res = searchTree(model, parseQuery('is:open'), matchContext(model, { openSiteIds: new Set(['web-02']) }));
    assert.deepEqual([...res.siteIds], ['web-02']);
  });
});

describe('labels: the Label submenu', () => {
  it('reports own and inherited labels', () => {
    const model = buildTree(SITES, layout());
    assert.deepEqual(labelChoiceState(model, ['s:web-01']), { count: 1, own: null, inherited: PROD, inheritedFrom: 'Clients' });
    assert.deepEqual(labelChoiceState(model, ['s:own']), { count: 1, own: 'label-stg', inherited: PROD, inheritedFrom: 'Clients' });
    assert.deepEqual(labelChoiceState(model, ['f:Clients']), { count: 1, own: 'label-prod', inherited: null, inheritedFrom: null });
    assert.equal(labelChoiceState(model, ['s:web-01', 's:own']).own, 'mixed');
    assert.equal(labelChoiceState(model, ['s:web-01', 's:solo']).inherited, null, 'different inheritance: none shown');
    assert.equal(labelChoiceState(model, ['sec:all', 'draft']).count, 0);
  });

  it('plans one batch, defining a preset first', () => {
    const model = buildTree(SITES, layout({ labels: [], folder_labels: {}, site_labels: {} }));
    const plan = planSetLabel(model, ['s:web-01', 'f:Clients/Acme'], { kind: 'preset', name: 'Produção', color: 'red' }, fakeId);
    assert.ok(plan && plan !== 'too_many');
    assert.equal(plan.ops.length, 2);
    assert.deepEqual(plan.ops[0], { op: 'set_label_defs', labels: [{ id: plan.labelId, name: 'Produção', color: 'red' }] });
    assert.deepEqual(plan.ops[1], { op: 'set_label', label: plan.labelId, sites: ['web-01'], folders: ['Clients/Acme'] });
    // The local copy of the backend accepts the batch
    const res = applyOpsLocally(SITES, defaultLayout(), plan.ops);
    assert.equal(res.layout.site_labels['web-01'], plan.labelId);
    assert.equal(res.layout.folder_labels['Clients/Acme'], plan.labelId);
  });

  it('reuses a label with the preset name, clears with none, refuses a 13th', () => {
    const model = buildTree(SITES, layout());
    const again = planSetLabel(model, ['s:solo'], { kind: 'preset', name: 'PRODUCTION', color: 'blue' }, fakeId);
    assert.ok(again && again !== 'too_many');
    assert.deepEqual(again.ops, [{ op: 'set_label', label: 'label-prod', sites: ['solo'] }]);
    assert.deepEqual(planSetLabel(model, ['s:own'], { kind: 'none' }), { ops: [{ op: 'set_label', label: null, sites: ['own'] }], labelId: null, created: null });
    assert.equal(planSetLabel(model, ['s:own'], { kind: 'label', id: 'label-gone' }), null);
    assert.equal(planSetLabel(model, ['sec:all'], { kind: 'none' }), null);
    const twelve = Array.from({ length: 12 }, (_, i): LabelDef => ({ id: `label-${i}`, name: `L${i}`, color: 'gray' }));
    const full = buildTree(SITES, layout({ labels: twelve, folder_labels: {}, site_labels: {} }));
    assert.equal(planSetLabel(full, ['s:solo'], { kind: 'preset', name: 'Testing', color: 'blue' }, fakeId), 'too_many');
  });

  it('offers only presets that are not labels yet', () => {
    const model = buildTree(SITES, layout());
    assert.deepEqual(
      unusedPresets(model, LABEL_PRESETS).map((p) => p.name),
      ['Development', 'Testing', 'Personal']
    );
    // Labels made in English still count once the presets are in Portuguese
    const pt = [
      { name: 'Produção', alt: 'Production' },
      { name: 'Homologação', alt: 'Staging' },
      { name: 'Testes', alt: 'Testing' },
    ];
    assert.deepEqual(unusedPresets(model, pt).map((p) => p.name), ['Testes']);
  });
});

describe('labels: the Labels dialog', () => {
  it('counts own assignments', () => {
    const model = buildTree(SITES, layout({ site_labels: { own: 'label-stg', solo: 'label-stg' } }));
    const usage = labelUsage(model);
    assert.deepEqual(usage.get('label-stg'), { sites: 2, folders: 0 });
    assert.deepEqual(usage.get('label-prod'), { sites: 0, folders: 1 });
  });

  it('finds empty, long and repeated names', () => {
    const problems = labelDefsProblems([{ name: 'Prod' }, { name: ' ' }, { name: 'prod ' }, { name: 'x'.repeat(41) }, { name: 'São' }, { name: 'sao' }]);
    assert.deepEqual([...problems], [
      [1, 'empty'],
      [2, 'duplicate'],
      [3, 'too_long'],
      [5, 'duplicate'],
    ]);
    assert.equal(labelDefsProblems([PROD, STG]).size, 0);
  });

  it('compares lists and proposes the next label', () => {
    assert.equal(sameLabelDefs([PROD], [{ ...PROD, name: 'Production ' }]), true);
    assert.equal(sameLabelDefs([PROD], [{ ...PROD, color: 'blue' }]), false);
    assert.deepEqual(nextNewLabel([PROD, STG], LABEL_PRESETS), { name: 'Development', color: 'green' });
    const all = LABEL_PRESETS.map((p, i) => ({ id: `l${i}`, name: p.name, color: p.color }));
    assert.deepEqual(nextNewLabel(all, LABEL_PRESETS), { name: '', color: 'orange' });
  });

  it('makes ids the backend accepts', () => {
    const id = newLabelId();
    assert.match(id, /^label-[0-9a-f]{32}$/);
    assert.notEqual(newLabelId(), id);
  });
});

describe('labels: the form pill and export', () => {
  it('names the label and where it comes from', () => {
    const model = buildTree(SITES, layout());
    assert.deepEqual(siteLabelInfo(model, { id: 'db-01' }), { def: PROD, from: 'Clients' });
    assert.deepEqual(siteLabelInfo(model, { id: 'own' }), { def: STG, from: null });
    assert.equal(siteLabelInfo(model, { id: 'solo' }), null);
    // The form reads the same answer from the layout alone
    const l = layout();
    for (const s of SITES) assert.deepEqual(layoutSiteLabel(l, s.id, s.group), siteLabelInfo(model, s), s.id);
    assert.deepEqual(layoutSiteLabel(l, 'web-01', 'Clients/New'), { def: PROD, from: 'Clients' }, 'a folder typed in the form');
  });

  it('exports a selection: sites and everything inside folders, never Local, no repeats', () => {
    const model = buildTree(SITES, layout());
    assert.deepEqual(
      sitesOfItems(model, ['s:local', 's:web-01', 'f:Clients/Acme', 's:solo']).map((s) => s.id),
      ['web-01', 'solo', 'own', 'web-02', 'db-01']
    );
  });
});
