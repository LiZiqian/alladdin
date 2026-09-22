const { readFrontendScript } = require('./frontend_source.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const cat = { id: 'pool', samples: [{ id: 's', notes: 'original', owner: 'owner' }] };
  const app = {
    registerModule(_, members) { Object.assign(this, members); },
    _baseData: { sampleLibrary: { categories: [JSON.parse(JSON.stringify(cat))] } },
    samplePoolPageState: () => ({ page: 1, pageSize: 100, filters: {} }),
    isCurrentSampleCategoryPage: () => false,
    hasLocalUnsavedChanges: () => true,
    _samplePagePrefetchDisabled: true,
    sampleCategoryRecords: () => [cat],
  };
  const context = vm.createContext({ app, console, setTimeout });
  vm.runInContext(readFrontendScript(path.join(__dirname, '../frontend/js/samples/01-pool.js')), context);
  return { app, cat };
}
const result = notes => ({ page: 1, pageSize: 100, total: 1, totalPages: 1, items: [{ id: 's', notes, owner: 'remote-owner' }] });
(async () => {
  {
    const { app, cat } = fixture(); const pending = deferred();
    app.fetchSamplePage = () => pending.promise;
    const params = app.samplePageQueryParams(cat); const key = app.samplePageCacheKey(cat, params);
    const loading = app.loadSamplePage(cat, key, params);
    app._samplePageCacheGeneration = 1;
    pending.resolve(result('stale'));
    await loading;
    assert.equal(cat.samples[0].notes, 'original', 'invalidated responses cannot overwrite samples');
    assert.equal(app.getSamplePageCache(key), null, 'invalidated responses cannot refill caches');
  }
  {
    const { app, cat } = fixture(); const first = deferred(), second = deferred(); let calls = 0;
    app.hasLocalUnsavedChanges = () => false;
    app.fetchSamplePage = () => (++calls === 1 ? first.promise : second.promise);
    const loadingFirst = app.refreshCurrentSamplePage(cat);
    const loadingSecond = app.refreshCurrentSamplePage(cat);
    second.resolve(result('newer')); assert.equal(await loadingSecond, true);
    first.resolve(result('older')); assert.equal(await loadingFirst, false);
    assert.equal(cat.samples[0].notes, 'newer', 'latest refresh wins for the same page');
  }
  {
    const { app, cat } = fixture(); cat.samples[0].notes = 'draft';
    const params = app.samplePageQueryParams(cat), key = app.samplePageCacheKey(cat, params);
    const entry = app.storeSamplePageResult(cat, key, params, result('server'));
    assert.equal(cat.samples[0].notes, 'draft', 'loading must not discard local edits');
    assert.equal(cat.samples[0].owner, 'remote-owner', 'unchanged fields still hydrate');
    assert.equal(entry.items[0].notes, 'draft', 'visible page uses the preserved record');
  }
  {
    const { app, cat } = fixture();
    const state = { cached: { stats: { ownerNames: ['未加载页人员', 'owner'], borrowerNames: [] } } };
    assert.deepEqual(Array.from(app.samplePersonFilterOptions(cat, state, 'owner')), ['owner', '未加载页人员']);
    assert.deepEqual(Array.from(app.samplePersonFilterOptions(cat, state, 'borrower', '当前筛选')), ['当前筛选']);
  }
  {
    const { app, cat } = fixture(); const pending = deferred();
    app.fetchSamplePage = () => pending.promise;
    const params = app.samplePageQueryParams(cat), key = app.samplePageCacheKey(cat, params);
    const loading = app.loadSamplePage(cat, key, params);
    const restored = JSON.parse(JSON.stringify(cat));
    app.sampleCategoryRecords = () => [restored];
    pending.resolve(result('after rollback'));
    await loading;
    assert.equal(restored.samples[0].notes, 'after rollback');
    assert.equal(cat.samples[0].notes, 'original', 'detached records must not enter cache after rollback');
    assert.equal(app.getSamplePageCache(key).items[0], restored.samples[0]);
  }
  console.log('Sample paging invalidation, ordering and draft preservation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
