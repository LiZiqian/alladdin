const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const escapeHtml = vm.runInNewContext(`${fs.readFileSync(path.join(root, 'frontend/js/utils.js'), 'utf8')}\nUtils.esc;`);
const app = { registerModule(_name, members) { Object.assign(this, members); } };
let rows = [];
let finishImport;
let input;
const context = vm.createContext({
  app, console, setTimeout, URLSearchParams, CSS: { escape: String },
  alert(message) { throw new Error(message); },
  Utils: { toast() {}, id: (() => { let id = 0; return () => `id${++id}`; })(),
    parseSampleImportCsv: () => ({ rows, invalidPersonCount: 0 }), parseSampleIssueText: () => [], esc: escapeHtml },
  document: { createElement() {
    input = { addEventListener(_event, handler) { this.change = handler; }, click() {} };
    return input;
  } },
  FileReader: class {
    addEventListener(_event, handler) { this.load = handler; }
    readAsText() { Promise.resolve(this.load()).then(finishImport.resolve, finishImport.reject); }
  },
});
for (const file of ['frontend/js/samples/02-import-export.js', 'frontend/js/import-export-bundle.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
}

async function importRows(nextRows, serverConflicts = []) {
  rows = nextRows;
  const category = { id: 'pool', samples: [] };
  let saved = [];
  Object.assign(app, {
    sampleCategoryRecords: () => [category], dataSnapshot: () => ({}), sampleIsReassembled: row => !!row.isReassembled,
    normalizeSampleStatusValue: () => '闲置', constants: { sampleStatuses: ['闲置'] },
    checkSampleIdentityConflicts: async () => ({ results: serverConflicts }),
    newSample: (_cat, _no, sn, imei, extra) => ({ sn, imei, ...extra }),
    commitSampleCategoryMutation: async (_category, options) => { saved = options.samples; return true; },
  });
  const completion = new Promise((resolve, reject) => { finishImport = { resolve, reject }; });
  await app.importSampleBatch('pool');
  input.change({ target: { files: [{ name: 'rows.csv' }] } });
  await completion;
  return saved;
}

(async () => {
  const nested = { sample: { notes: '<img src=x onerror="alert(1)">', enabled: false, count: 0 } };
  const objectValue = app._renderImportConflictValue(nested);
  assert.ok(objectValue.includes('&quot;notes&quot;: &quot;&lt;img'), 'nested conflict values must be readable JSON and HTML escaped');
  assert.ok(!objectValue.includes('<img') && !objectValue.includes('[object Object]'));
  assert.equal(new Set([false, 0, null, undefined, '', [], {}].map(value => app._renderImportConflictValue(value))).size, 7,
    'zero, false, null, missing, empty text, empty arrays and objects must remain distinguishable');
  const longValue = app._renderImportConflictValue([{ notes: 'x'.repeat(20000) }, { notes: 'difference-at-the-end' }]);
  assert.ok(longValue.includes('difference-at-the-end'), 'large values retain differences at the end');
  assert.ok(longValue.includes('max-height:9em') && longValue.includes('overflow:auto'), 'large values use bounded scrollable display');
  const fieldHtml = app._renderFieldConflictBody({ conflictId: 'c1', entity: 'task',
    diffFields: ['sampleSnapshots', 'archived', 'count'], current: { sampleSnapshots: nested, archived: false, count: 0 },
    incoming: { sampleSnapshots: [{ notes: 'imported' }], archived: true, count: 1 } });
  assert.ok(fieldHtml.includes(objectValue) && fieldHtml.includes('value="incoming"'));
  assert.ok(!fieldHtml.includes('[object Object]') && !fieldHtml.includes('<img'));
  const identityHtml = app._renderSampleIdentityConflictBody({ conflictId: 'c2', current: { nested }, incoming: { nested: [] }, mergeableFields: ['nested'] });
  assert.ok(identityHtml.includes(objectValue) && !identityHtml.includes('[object Object]') && !identityHtml.includes('<img'));

  let exportRequests = 0;
  context.fetch = async () => { exportRequests += 1; throw new Error('unexpected export'); };
  await app.exportBundle({ projectIds: [] });
  assert.equal(exportRequests, 0, 'an explicit empty scope must never become a full-library export');
  let saved = await importRows([{ sn: 'A', imei: 'B' }, { sn: 'C', imei: 'A' }, { sn: 'C', imei: 'D' }]);
  assert.deepEqual(Array.from(saved, row => row.sn), ['A', 'C'], 'a skipped row must not reserve its unused identifiers');
  saved = await importRows([{ sn: 'A', imei: 'B' }, { sn: 'B', imei: 'C' }], [
    { index: 0, hasConflict: true, conflict: { scope: 'global' } },
  ]);
  assert.deepEqual(Array.from(saved, row => row.sn), ['B'], 'server-rejected rows must not hide later valid rows');

  let revision = 1;
  const previews = new Map([['stale-one', 1], ['stale-two', 1]]);
  const applied = [];
  Object.assign(app, {
    _sampleArchiveBatchState: { phase: 'selection', targetCategoryId: 'pool', rows: [
      { file: { name: 'one.zip' }, selected: true, status: 'valid', preview: { previewId: 'stale-one' } },
      { file: { name: 'two.zip' }, selected: true, status: 'valid', preview: { previewId: 'stale-two' } },
    ] },
    _refreshSampleArchiveBatchModal() {},
    importSampleArchivePreview: async file => {
      const previewId = `${file.name}-${revision}`;
      previews.set(previewId, revision);
      return { previewId, blockers: [] };
    },
    importSampleArchiveCommit: async previewId => {
      assert.equal(previews.get(previewId), revision, 'batch commits must use fresh previews');
      return { revision: ++revision, stats: { samplesAdded: 1 }, mutationSummary: {} };
    },
    applyImportBundleMutationResult: async (result, options) => { applied.push([result.revision, options.render]); },
  });
  await app._commitSampleArchiveBatch();
  assert.deepEqual(Array.from(app._sampleArchiveBatchState.rows, row => row.status), ['imported', 'imported']);
  assert.deepEqual(applied, [[2, false], [3, false], [3, true]], 'each result must invalidate its own caches');
  app._importState = {
    selection: { taskIds: ['task'] },
    preview: { selectionTree: { projects: [{ id: 'project', defaultSampleCategoryId: 'pool', stages: [
      { id: 'stage', tasks: [{ id: 'task', sampleIds: ['linked'] }, { id: 'other-task', sampleIds: [] }] },
    ] }], sampleCategories: [{ id: 'pool', samples: [{ id: 'pool-sample' }] }] } },
  };
  for (const [entity, incomingId] of [['project', 'project'], ['stage', 'stage'], ['task', 'task'], ['sample', 'linked'], ['sample', 'pool-sample']]) {
    assert.equal(app._conflictInCurrentSelection({ entity, incomingId }), true, `selected tasks include their ${entity} dependency`);
  }
  assert.equal(app._conflictInCurrentSelection({ entity: 'task', incomingId: 'other-task' }), false);
  app._importState.selection = { sampleIds: ['linked'] };
  assert.equal(app._conflictInCurrentSelection({ type: 'task_occupancy_conflict', entity: 'sample', sampleId: 'linked', incomingTaskId: 'task' }), false,
    'sample-only imports must not require decisions about excluded tasks');
  app._importState.selection = { sampleIds: [] };
  assert.equal(app._conflictInCurrentSelection({ entity: 'sample', incomingId: 'linked' }), false);

  const pending = new Map(), shown = [];
  let currentModule = 'samples', currentCategory = 'pool';
  Object.assign(app, {
    viewModule: () => currentModule, selectedCategoryId: () => currentCategory,
    importBundlePreview: file => new Promise(resolve => pending.set(file.name, resolve)),
    importSampleArchivePreview: (file, categoryId) => new Promise(resolve => pending.set(file.name, result => {
      assert.equal(categoryId, 'pool', 'archive destination is bound before file selection');
      resolve(result);
    })),
    _showImportPreviewModal: preview => shown.push(preview.previewId),
    _showSampleArchivePreviewModal: preview => shown.push(preview.previewId),
  });
  app.importBundle(); input.files = [{ name: 'slow.zip' }]; const slow = input.change();
  app.importSampleArchive(); input.files = [{ name: 'fast.zip' }]; const fast = input.change();
  pending.get('fast.zip')({ previewId: 'fast' }); await fast;
  pending.get('slow.zip')({ previewId: 'slow' }); await slow;
  assert.deepEqual(shown, ['fast'], 'a slower older import must not replace the latest preview');
  app.importBundle(); input.files = [{ name: 'navigation.zip' }]; const navigation = input.change();
  currentModule = 'projects'; pending.get('navigation.zip')({ previewId: 'navigation' }); await navigation;
  assert.deepEqual(shown, ['fast'], 'a preview must not open over a different workspace');
  currentModule = 'samples';
  app.importSampleArchive(); input.files = [{ name: 'modal.zip' }]; const replacedModal = input.change();
  app._modalSequence = 1; app._currentModalId = 'unrelated';
  pending.get('modal.zip')({ previewId: 'modal' }); await replacedModal;
  assert.deepEqual(shown, ['fast'], 'a preview must not replace a newer unrelated modal');
  app.importSampleArchive(); currentCategory = 'other'; input.files = [{ name: 'changed-pool.zip' }]; await input.change();
  assert.equal(pending.has('changed-pool.zip'), false, 'changing pools while choosing a file cancels the old request');

  let finishPreview, commits = 0;
  app._sampleArchiveBatchState = { phase: 'selection', rows: [{ file: {}, selected: true, status: 'valid', preview: { previewId: 'old' } }] };
  app.importSampleArchivePreview = () => new Promise(resolve => { finishPreview = resolve; });
  app.importSampleArchiveCommit = async () => { commits += 1; return {}; };
  const oldBatch = app._commitSampleArchiveBatch();
  app._sampleArchiveBatchState = { rows: [], phase: 'ready' };
  finishPreview({ previewId: 'late', blockers: [] }); await oldBatch;
  assert.equal(commits, 0, 'an abandoned batch must not start committing after its late preview');
  console.log('Transfer frontend regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
