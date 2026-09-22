const { readFrontendScript } = require('./frontend_source.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const context = {
    console: { ...console, error() {} }, URLSearchParams, setTimeout, clearTimeout,
    alert() {}, window: {}, document: { querySelector: () => null, getElementById: () => null },
    app: { registerModule(_name, members) { Object.assign(this, members); } },
  };
  vm.createContext(context);
  for (const name of ['utils', 'app.data', 'app.server', 'app.modal']) {
    vm.runInContext(readFrontendScript(path.join(root, `frontend/js/${name}.js`))
      + (name === 'utils' ? '\nglobalThis.Utils = Utils;' : ''), context);
  }
  const app = context.app;
  app.data = { projects: [{ id: 'p', name: 'Project', stages: [] }], sampleLibrary: {
    categories: [{ id: 'c', name: 'Pool', samples: [{ id: 's', categoryId: 'c', sn: 'SN', photos: [], photosLoaded: false }] }], logs: [],
  } };
  app._baseData = app.cloneData(app.data);
  app.updateServerStatus = () => {};
  app.refreshSampleArchivePanels = () => {};
  app.invalidatePagedCaches = () => {};
  return { app, context };
}

async function run() {
  {
    const { app } = fixture();
    const pending = deferred();
    let fetchCount = 0;
    app.fetchSamplePhotos = () => { fetchCount++; return pending.promise; };
    const first = app.ensureSampleDetailsLoaded('s', { events: false });
    const second = app.ensureSampleDetailsLoaded('s', { events: false });
    app.data.projects[0].name = 'Unsent edit during hydration';
    pending.resolve([{ id: 'photo' }]);
    await Promise.all([first, second]);
    assert.equal(fetchCount, 1, 'concurrent detail visits reuse one photo request');
    assert.equal(app.findSample('s').sample.photos[0].id, 'photo');
    assert.equal(app._baseData.projects[0].name, 'Project');
    assert.equal(app.hasLocalUnsavedChanges(), true, 'hydration must not acknowledge an unrelated unsaved edit');
  }
  {
    const { app } = fixture();
    app.fetchSamplePhotos = async () => [{ id: 'photo' }];
    app.fetchSampleEvents = async () => { throw new Error('event unavailable'); };
    await assert.rejects(app.ensureSampleDetailsLoaded('s'), /event unavailable/);
    assert.equal(app.findSample('s').sample.photosLoaded, true);
    assert.equal(app.hasLocalUnsavedChanges(), false, 'successful photo hydration remains synchronized if parallel events fail');
  }
  {
    const { app } = fixture();
    const pending = deferred();
    app.fetchSamplePhotos = () => pending.promise;
    const loading = app.ensureSampleDetailsLoaded('s', { events: false });
    app.applySamplePhotosMutationResult('s', { revision: 4, photos: [{ id: 'fresh' }] });
    pending.resolve([{ id: 'deleted' }]);
    await loading;
    assert.equal(app.findSample('s').sample.photos[0].id, 'fresh', 'late photo read cannot resurrect a deleted photo');
    app.data.projects[0].name = 'pending';
    app.applySamplePhotosMutationResult('s', { revision: 5, photos: [] });
    assert.equal(app.hasLocalUnsavedChanges(), true, 'photo mutation does not acknowledge unrelated edits');
  }
  {
    const { app } = fixture();
    const older = deferred(), newer = deferred();
    app.fetchSampleHistory = (_id, { page }) => page === 1 ? older.promise : newer.promise;
    const first = app.ensureSampleHistoryLoaded('s', { page: 1 });
    const second = app.ensureSampleHistoryLoaded('s', { page: 2 });
    newer.resolve({ page: 2, pageSize: 20, items: [{ id: 'newer' }] });
    await second;
    older.resolve({ page: 1, pageSize: 20, items: [{ id: 'older' }] });
    await first;
    assert.equal(app._sampleHistoryCache.s.page, 2, 'last requested history page wins');
    const invalidated = deferred();
    app.fetchSampleHistory = () => invalidated.promise;
    const pending = app.ensureSampleHistoryLoaded('s', { force: true });
    app.invalidateSampleHistoryCache('s');
    invalidated.resolve({ page: 1, pageSize: 20, items: [{ id: 'before-mutation' }] });
    await pending;
    assert.equal(app._sampleHistoryCache.s, undefined, 'mutation invalidation cancels stale history responses');
    assert.equal(app.findSample('s').sample.historyLoaded, false);
  }
  {
    const { app } = fixture();
    let calls = 0;
    app.fetchSampleHistory = async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return { page: 1, pageSize: 20, items: [] };
    };
    await assert.rejects(app.ensureSampleHistoryLoaded('s'), /transient/);
    await app.ensureSampleHistoryLoaded('s');
    assert.equal(calls, 2, 'reopening history retries an error instead of permanently reusing it');
  }
  {
    const { app } = fixture();
    const pending = deferred();
    app.fetchProjectDetail = () => pending.promise;
    const loading = app.ensureProjectLoaded('p');
    app.findSample('s').sample.notes = 'unsent';
    pending.resolve({ id: 'p', name: 'Project', stages: [{ id: 'st', tasks: [] }] });
    await loading;
    assert.equal(app._baseData.sampleLibrary.categories[0].samples[0].notes, undefined);
    assert.equal(app.hasLocalUnsavedChanges(), true);
    app.data.projects[0]._tasksFullyLoaded = true;
    app.mergeProjectDetail({ id: 'p', stages: [{ id: 'st' }] });
    assert.equal(app.data.projects[0]._tasksFullyLoaded, true, 'a metadata response cannot downgrade full task hydration');
  }
  {
    const { app } = fixture();
    app._lastTaskMutationError = { error_code: 'TASK_REVISION_CONFLICT', _refreshSucceeded: true };
    let restored = false;
    app.restoreDataSnapshot = () => { restored = true; };
    assert.equal(app.restoreFailedTaskMutation({ data: {} }), false);
    assert.equal(restored, false, 'successful conflict refresh must survive failure rollback');
  }
  for (const kind of ['project', 'stage', 'sample', 'category']) {
    const { app, context } = fixture();
    app.view = { selectedProjectId: 'p' };
    app.normalize = () => {};
    app.render = () => {};
    app.closeModal = () => {};
    app.closeConfirm = () => {};
    app.serverRevision = 1;
    const snapshot = app.dataSnapshot();
    const oldRead = deferred();
    app.fetchProjectDetail = () => oldRead.promise;
    const hydration = app.ensureProjectLoaded('p');
    app.fetchBootstrapState = async () => ({ revision: 9, partial: true,
      data: { projects: [{ id: 'p', name: 'Latest', stages: [] }], sampleLibrary: { categories: [], logs: [] } } });
    context.fetch = async () => ({ ok: false, status: 409,
      json: async () => ({ error_code: 'MUTATION_REVISION_CONFLICT' }) });
    let result;
    if (kind === 'project') result = await app.commitProjectMutation(app.data.projects[0]);
    if (kind === 'stage') result = await app.commitStageMutation(app.data.projects[0], { id: 'st' });
    if (kind === 'sample') result = await app.commitSampleMutation(app.findSample('s').sample);
    if (kind === 'category') result = await app.commitSampleCategoryMutation(app.data.sampleLibrary.categories[0]);
    assert.equal(result, false);
    app.restoreDataSnapshot(snapshot);
    oldRead.resolve({ id: 'p', name: 'Obsolete read', stages: [] });
    await hydration;
    assert.equal(app.data.projects[0].name, 'Latest', `${kind} conflict refresh survives old reads and rollback`);
    assert.equal(app.serverRevision, 9);
  }
  {
    const { app, context } = fixture();
    vm.runInContext(readFrontendScript(path.join(root, 'frontend/js/workspace/03-strategy.js')), context);
    const project = app.data.projects[0];
    const stage = { id: 'st', name: 'A', strategy: [], tasks: [] };
    project.stages.push(stage);
    app._baseData = app.cloneData(app.data);
    app.serverRevision = 1;
    const firstResponse = deferred();
    const payloads = [];
    context.fetch = async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      if (payloads.length === 1) return firstResponse.promise;
      return { ok: true, status: 200, json: async () => ({ ok: true, revision: 3, affected: {} }) };
    };
    stage.name = 'B';
    const first = app.persistStageStrategyMutation('rename', '', { project, stage });
    stage.name = 'C';
    const second = app.persistStageStrategyMutation('rename', '', { project, stage });
    await Promise.resolve();
    assert.equal(payloads.length, 1, 'strategy autosaves serialize requests from the same stage');
    firstResponse.resolve({ ok: true, status: 200, json: async () => ({ ok: true, revision: 2, affected: {} }) });
    await Promise.all([first, second]);
    assert.equal(payloads[0].stage.name, 'B');
    assert.equal(payloads[1].stage.name, 'C');
    assert.equal(payloads[1].revision, 2, 'queued edit uses the revision acknowledged by its preceding save');
    assert.equal(app._baseData.projects[0].stages[0].name, 'C');
    assert.equal(app.hasLocalUnsavedChanges(), false);
    const pending = deferred();
    context.fetch = () => pending.promise;
    stage.name = 'D';
    const saving = app.commitStageMutation(project, stage, { render: false });
    stage.name = 'E';
    app.findSample('s').sample.notes = 'Another unsaved form';
    pending.resolve({ ok: true, status: 200, json: async () => ({ ok: true, revision: 4, affected: {} }) });
    await saving;
    assert.equal(app._baseData.projects[0].stages[0].name, 'D', 'baseline acknowledges exactly the stage sent to the server');
    assert.equal(app._baseData.sampleLibrary.categories[0].samples[0].notes, undefined);
    assert.equal(app.hasLocalUnsavedChanges(), true);
  }
  {
    const { app, context } = fixture();
    vm.runInContext(readFrontendScript(path.join(root, 'frontend/js/workspace/02-home.js')), context);
    app.view = { selectedProjectId: 'p' };
    app._statePartial = true;
    app.data.projects[0].samplePersonCounts = { owner: { '管理员/009': 125 }, borrower: { '测试员/001': 2 } };
    assert.equal(app.sampleOwnerCountsByMemberKey().get(context.Utils.memberIdentityKey('管理员', '009')), 125);
    assert.equal(app.sampleBorrowerCountsByMemberKey().get(context.Utils.memberIdentityKey('测试员', '001')), 2);
    assert.equal(app.compactProjectForMutation(app.data.projects[0]).samplePersonCounts, undefined);
    delete app.data.projects[0].samplePersonCounts;
    assert.equal(app.sampleOwnerCountsByMemberKey().complete, false, 'partial caches never masquerade as complete personnel counts');
  }
  {
    const { app, context } = fixture();
    const gate = await app.beginServerMutation();
    let calls = 0;
    app.serverRevision = 3;
    context.fetch = async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).revision, 4);
      return { ok: true, status: 200, json: async () => ({ ok: true, revision: 5 }) };
    };
    const queued = app.commitProjectMutation(app.data.projects[0], { render: false });
    await Promise.resolve();
    assert.equal(calls, 0, 'entity writes wait for an in-flight photo/import mutation');
    app.serverRevision = 4;
    gate();
    assert.equal(await queued, true);
    const blocker = await app.beginServerMutation();
    const cancelled = app.commitProjectMutation(app.data.projects[0], { render: false });
    app._dataSnapshotEpoch = (app._dataSnapshotEpoch || 0) + 1;
    blocker();
    assert.equal(await cancelled, false, 'a conflict refresh cancels queued operations from the previous data tree');
    assert.equal(calls, 1);
    app.applySamplePhotosMutationResult('s', { revision: 2, photos: [] });
    assert.equal(app.serverRevision, 5, 'delayed mutation rendering cannot decrease the known revision');
  }
  {
    const { app } = fixture();
    app.constants = { sampleStatuses: ['闲置', '测试中'] };
    const sample = app.findSample('s').sample;
    Object.assign(sample, { status: '测试中', hasProblem: true, effectiveStatus: '测试中',
      problemRecords: [{ id: 'problem', description: 'resolved defect' }], resultUploads: [{ fault: true }] });
    app.replaceSampleProblemRecords(sample, []);
    assert.equal(app.sampleHasProblem(sample), false);
    assert.equal(sample.effectiveStatus, '测试中');
    assert.equal(sample.resultUploads[0].fault, true, 'editing current quality leaves historical results intact');
    app.replaceSampleProblemRecords(sample, [{ description: 'new defect' }]);
    assert.equal(app.sampleHasProblem(sample), true);
  }
  logIdentityTests();
  await staleHydrationAfterMutationTests();
  stageSummaryTests();
  dropdownEscapeTests();
  await pageMutationTests();
  await delayedDialogTests();
  await taskResultChangeTests();
  await sampleDetailTests();
  await modalTests();
  console.log('frontend async integrity tests passed');
}

function stageSummaryTests() {
  const { app, context } = fixture();
  vm.runInContext(readFrontendScript(path.join(root, 'frontend/js/workspace/02-home.js')), context);
  const stage = { id: 'stage', tasks: [], progress: [], taskCount: 125, statusCounts: { '进行中': 1 }, usedSampleRuns: 17, runningSampleCount: 2 };
  const project = app.data.projects[0];
  project.stages = [stage];
  app.currentProject = () => project;
  app.currentStage = () => stage;
  app.stageStrategyId = () => null;
  app.ensureWorkspaceStageSelection = () => {};
  app.activeStageTasks = value => value.tasks;
  app.taskFlowStatus = task => task.status;
  app.stageSortMode = () => false;
  app.sampleOwnerCountsByMemberKey = app.sampleBorrowerCountsByMemberKey = () => ({});
  let html = '';
  app.projectWorkspacePageNodes = (_project, _stage, options) => { html = options.stageCards; };
  app.replaceWorkspaceContentNodes = () => {};
  app.renderProjectWorkspace();
  assert.match(html, /已使用<em[^>]*>17 台次/, 'stage usage is complete before any task page is hydrated');
  assert.match(html, /占用样机<em[^>]*>2 台/, 'running sample count uses the full-stage server summary');
  app.markDataSynced();
  app.view = { taskFlowFilters: { ownerName: 'Filtered/007' } };
  const affected = { stageSummaries: [{ id: 'stage', usedSampleRuns: 18, runningSampleCount: 0,
    taskCount: 126, statusCounts: { '正常完成': 125, '进行中': 1 } }] };
  app.applyMutationAffected(affected);
  app.syncMutationPayloadBaseline({}, affected);
  assert.equal(stage.runningSampleCount, 0);
  assert.equal(stage.taskCount, 126, 'filtered views consume authoritative whole-stage counts without a page patch');
  assert.equal(stage.statusCounts['正常完成'], 125);
  assert.equal(app._baseData.projects[0].stages[0].taskCount, 126);
  assert.equal(app._baseData.projects[0].stages[0].usedSampleRuns, 18);
  const usageNode = { dataset: { stageStat: 'usedSampleRuns' } }, runningNode = { dataset: { stageStat: 'runningSampleCount' } };
  const fill = { style: {} };
  context.document.querySelectorAll = () => [{ dataset: { stageSummaryId: 'stage' }, querySelectorAll: () => [usageNode, runningNode], querySelector: () => fill }];
  app.refreshStageSummaryMetrics(stage);
  assert.equal(usageNode.textContent, '18 台次', 'local task refresh updates visible stage statistics');
  assert.equal(runningNode.textContent, '0 台');
  const compact = app.compactStageForMutation(stage);
  assert.equal(Object.hasOwn(compact, 'usedSampleRuns'), false, 'derived stage usage is not sent as authored data');
  assert.equal(Object.hasOwn(compact, 'runningSampleCount'), false);
}

async function staleHydrationAfterMutationTests() {
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  for (const outcome of ['success', 'rollback', 'retained-draft', 'newer-draft']) {
    const { app, context } = fixture();
    app.serverRevision = 1;
    app.data.projects[0].members = [];
    app.markDataSynced();
    const snapshot = app.dataSnapshot(), stale = app.cloneData(app.data.projects[0]);
    const read = deferred(), write = deferred();
    let reads = 0, settled = false;
    const saved = { ...app.cloneData(stale), members: [{ id: 'member', name: 'Submitted member' }] };
    app.fetchProjectDetail = () => ++reads === 1 ? read.promise : Promise.resolve(
      app.cloneData(outcome === 'success' || outcome === 'newer-draft' ? saved : stale));
    context.fetch = () => write.promise;
    const loading = app.ensureProjectLoaded('p', { includeTasks: true }).then(value => { settled = true; return value; });
    app.data.projects[0].members = app.cloneData(saved.members);
    const writing = (async () => {
      const result = await app.commitProjectMutation(app.data.projects[0], { render: false });
      if (!result && outcome === 'rollback') app.restoreDataSnapshot(snapshot);
      return result;
    })();
    await tick();
    read.resolve(stale);
    await tick();
    assert.equal(settled, false, 'a read cannot merge while a write is waiting for its ACK');
    assert.equal(app.data.projects[0].members[0].name, 'Submitted member');
    if (outcome === 'newer-draft') app.data.projects[0].members[0].name = 'Newer unsent member';
    const success = outcome === 'success' || outcome === 'newer-draft';
    write.resolve({ ok: success, status: success ? 200 : 500, json: async () => ({ ok: success, revision: success ? 2 : 1, error: 'synthetic failure', affected: {} }) });
    assert.equal(await writing, success);
    const loaded = await loading;
    assert.equal(reads, 2, 'the read is retried once after the in-flight write finishes');
    if (outcome === 'retained-draft' || outcome === 'newer-draft') {
      assert.equal(loaded, null, 'dirty target details are not merged or acknowledged');
      assert.equal(app.data.projects[0].members[0].name, outcome === 'retained-draft' ? 'Submitted member' : 'Newer unsent member');
      assert.equal(app.hasLocalUnsavedChanges(), true);
      assert.equal(app._baseData.projects[0].members.length, success ? 1 : 0);
      if (success) assert.equal(app._baseData.projects[0].members[0].name, 'Submitted member');
    } else {
      assert.ok(loaded, 'a successful write or completed rollback allows fresh hydration');
      assert.equal(app.data.projects[0].members.length, success ? 1 : 0);
      assert.equal(app.hasLocalUnsavedChanges(), false);
    }
    assert.equal(app._serverMutationQueue, null, 'read waiting must not retain the write gate');
  }
  {
    const { app, context } = fixture();
    app.serverRevision = 1;
    const read = deferred(), write = deferred();
    let reads = 0;
    app.fetchProjectDetail = () => ++reads === 1 ? read.promise : Promise.resolve({ id: 'p', name: 'Project', stages: [] });
    const loading = app.ensureProjectLoaded('p');
    app.data.sampleLibrary.categories[0].name = 'Unsent pool name';
    context.fetch = () => write.promise;
    const writing = app.commitSampleCategoryMutation(app.data.sampleLibrary.categories[0], { render: false });
    read.resolve({ id: 'p', name: 'Project', stages: [] });
    await tick();
    write.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: 'synthetic failure' }) });
    assert.equal(await writing, false);
    assert.equal((await loading)._detailLoaded, true, 'an unrelated failed write cannot block project navigation');
    assert.equal(app.data.sampleLibrary.categories[0].name, 'Unsent pool name');
    assert.equal(app._baseData.sampleLibrary.categories[0].name, 'Pool');
  }
  {
    const { app, context } = fixture();
    app.serverRevision = 1;
    const responses = [deferred(), deferred()], writes = [deferred(), deferred()];
    let reads = 0, sends = 0, applied = 0;
    const reading = app.readCurrentServerData(() => responses[reads++].promise, undefined, value => { applied++; return value; });
    context.fetch = () => writes[sends++].promise;
    const first = app.commitProjectMutation(app.data.projects[0], { render: false });
    responses[0].resolve('old');
    await tick();
    const second = app.commitSampleCategoryMutation(app.data.sampleLibrary.categories[0], { render: false });
    writes[0].resolve({ ok: true, json: async () => ({ ok: true, revision: 2 }) });
    assert.equal(await first, true);
    await tick();
    assert.equal(applied, 0);
    assert.equal(sends, 2, 'waiting readers do not hold up the next FIFO write');
    responses[1].resolve('between writes');
    await tick();
    assert.equal(applied, 0, 'a new queue tail prevents a read from merging between two writes');
    writes[1].resolve({ ok: true, json: async () => ({ ok: true, revision: 3 }) });
    assert.equal(await second, true);
    assert.equal(await reading, null, 'continuous writes exhaust the bounded read retries without stale application');
    assert.equal(reads, 2);
    assert.equal(applied, 0);
  }
  {
    const { app } = fixture();
    const stage = { id: 'stage', tasks: [{ id: 'task', sampleIds: ['s'] }], progress: 'old' };
    const baseline = { id: 'p', stages: [stage], name: 'Project' };
    const current = { name: 'Project', stages: [app.cloneData(stage)], id: 'p', _detailLoaded: true, taskCount: 12 };
    current.stages[0].usedSampleRuns = 3;
    assert.equal(app.serverReadHasLocalEdits(current, baseline), false, 'read-only metadata and object key order are not edits');
    current.stages[0].progress = 'draft';
    assert.equal(app.serverReadHasLocalEdits(current, baseline), true, 'stage configuration is authored data');
    current.stages[0].progress = 'old';
    current.stages[0].tasks[0].sampleIds = [];
    assert.equal(app.serverReadHasLocalEdits(current, baseline), true, 'task business fields are authored data');
    assert.equal(app.serverReadHasLocalEdits({ id: 's', sn: 'new', photosLoaded: true }, { id: 's', sn: 'old' }), true);
  }
  {
    const { app } = fixture();
    app.serverRevision = 1;
    let reads = 0, applied = 0;
    const result = await app.readCurrentServerData(async () => {
      reads++;
      app.serverRevision++;
      return { stale: true };
    }, undefined, () => { applied++; });
    assert.equal(result, null);
    assert.equal(reads, 2, 'continuous writes cannot cause unbounded read retries');
    assert.equal(applied, 0);
  }
  {
    const { app, context } = fixture();
    app.serverRevision = 1;
    const project = app.data.projects[0];
    const stage = { id: 'stage', tasks: [{ id: 'old-task' }] };
    project.stages = [stage];
    app.markDataSynced();
    const stale = app.cloneData(project), response = deferred();
    let reads = 0;
    app.fetchProjectDetail = () => ++reads === 1 ? response.promise : Promise.resolve(app.cloneData(app.data.projects[0]));
    const loading = app.ensureProjectLoaded('p', { includeTasks: true });
    project.name = 'Saved';
    project.stages = [];
    context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: 2 }) });
    assert.equal(await app.commitStageMutation(project, stage, { deleteStage: true, render: false }), true);
    const epoch = app._dataSnapshotEpoch;
    response.resolve(stale);
    await loading;
    assert.equal(app.data.projects[0].name, 'Saved', 'old full-project reads cannot overwrite successful edits');
    assert.equal(app.data.projects[0].stages.length, 0, 'old full-project reads cannot resurrect a deleted stage');
    assert.equal(app._baseData.projects[0].stages.length, 0);
    assert.equal(reads, 2, 'the still-present project is re-read once after the successful write');
    assert.equal(app._dataSnapshotEpoch, epoch, 'read cancellation must not change write/rollback epochs');
    app.fetchProjectDetail = async () => app.cloneData(app.data.projects[0]);
    assert.ok(await app.ensureProjectLoaded('p', { includeTasks: true }), 'discarded detail reads can be requested again');
  }
  {
    const { app, context } = fixture();
    app.serverRevision = 1;
    const response = deferred();
    let reads = 0;
    app.fetchProjectDetail = () => ++reads === 1 ? response.promise : Promise.resolve({ id: 'p', name: 'Fresh project', stages: [] });
    const loading = app.ensureProjectLoaded('p');
    context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: 2 }) });
    assert.equal(await app.commitSampleCategoryMutation(app.data.sampleLibrary.categories[0], { render: false }), true);
    response.resolve({ id: 'p', name: 'Old project', stages: [] });
    const loaded = await loading;
    assert.equal(loaded.name, 'Fresh project', 'an unrelated pool save must not strand project navigation on its summary');
    assert.equal(loaded._detailLoaded, true);
    assert.equal(reads, 2);
  }
  {
    const { app, context } = fixture();
    app.serverRevision = 1;
    const project = app.data.projects[0], response = deferred();
    let reads = 0;
    app.fetchProjectDetail = () => { reads++; return response.promise; };
    const loading = app.ensureProjectLoaded('p', { includeTasks: true });
    app.data.projects = [];
    context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: 2 }) });
    assert.equal(await app.commitProjectMutation(project, { deleteProject: true, render: false }), true);
    response.resolve({ id: 'p', name: 'Deleted project', stages: [] });
    assert.equal(await loading, null);
    assert.equal(app.data.projects.length, 0, 'deleted resources are not recreated by older reads');
    assert.equal(reads, 1, 'a deleted project is not retried');
  }
  {
    const { app, context } = fixture();
    app.serverRevision = 1;
    const category = app.data.sampleLibrary.categories[0], sample = category.samples[0];
    const stale = app.cloneData(category), response = deferred();
    let reads = 0;
    app.fetchSampleCategoryDetail = () => ++reads === 1 ? response.promise : Promise.resolve(app.cloneData(category));
    const loading = app.ensureSampleCategoryLoaded('c', { includePhotos: true });
    category.samples = [];
    context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: 2 }) });
    assert.equal(await app.commitSampleMutation(sample, { deleteSample: true, render: false }), true);
    response.resolve(stale);
    await loading;
    assert.equal(app.data.sampleLibrary.categories[0].samples.length, 0, 'old pool detail cannot resurrect deleted samples');
    assert.equal(app._baseData.sampleLibrary.categories[0].samples.length, 0);
    app.fetchSampleCategoryDetail = async () => app.cloneData(category);
    assert.ok(await app.ensureSampleCategoryLoaded('c', { includePhotos: true }));
  }
  for (const fallback of [false, true]) {
    const { app, context } = fixture();
    app.serverRevision = 1;
    const category = app.data.sampleLibrary.categories[0];
    category.samples = [];
    app.markDataSynced();
    const response = deferred();
    let requests = 0;
    app.fetchTaskSampleCandidates = () => {
      requests++;
      if (fallback && requests === 1) return Promise.resolve({ selectedItems: [], selectedMissingIds: ['s'] });
      if (requests === (fallback ? 2 : 1)) return response.promise;
      return Promise.resolve({ items: app.cloneData(category.samples) });
    };
    const loading = app.ensureSampleLoaded('s');
    await Promise.resolve();
    const saved = { id: 's', categoryId: 'c', sn: 'Saved SN' };
    category.samples.push(saved);
    context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: 2 }) });
    assert.equal(await app.commitSampleCategoryMutation(category, { createSamples: [saved], render: false }), true);
    response.resolve({ items: [{ id: 's', categoryId: 'c', sn: 'Stale SN' }] });
    await loading;
    assert.equal(app.findSample('s').sample.sn, 'Saved SN', 'both direct and identity-fallback lookups reject pre-mutation responses');
    assert.equal(Object.keys(app._sampleLookupPromises).length, 0, 'discarded lookups release their request slot');
  }
  {
    const { app, context } = fixture();
    app.serverRevision = 1;
    app.view = { module: 'home', selectedProjectId: 'p' };
    app.currentProject = () => app.data.projects.find(project => project.id === 'p');
    app.importMutationIdSets = () => ({ projectIds: new Set(['p']), stageIds: new Set(), sampleCategoryIds: new Set() });
    app.fetchProjectSummary = async () => [{ id: 'p', name: app.data.projects[0].name }];
    app.fetchSampleCategoriesSummary = async () => [{ id: 'c', name: 'Pool', sampleCount: 1 }];
    let reads = 0;
    const response = deferred();
    app.fetchProjectDetail = () => ++reads === 1 ? response.promise : Promise.resolve(app.cloneData(app.data.projects[0]));
    const loading = app.applyImportBundleMutationResult({ revision: 1, mutationSummary: {} }, { render: false });
    app.data.projects[0].name = 'Saved after import';
    context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, revision: 2 }) });
    assert.equal(await app.commitProjectMutation(app.data.projects[0], { render: false }), true);
    response.resolve({ id: 'p', name: 'Old import detail', stages: [] });
    assert.equal(await loading, true);
    assert.equal(app.data.projects[0].name, 'Saved after import', 'post-import direct detail reads also reject stale data');
    assert.equal(app._baseData.projects[0].name, 'Saved after import');
    assert.equal(reads, 2);
  }
  {
    const { app, context } = fixture();
    const category = app.data.sampleLibrary.categories[0];
    const stale = app.cloneData(category), read = deferred(), write = deferred();
    let reads = 0;
    app.fetchSampleCategoryDetail = () => ++reads === 1 ? read.promise : Promise.resolve(app.cloneData(stale));
    const loading = app.ensureSampleCategoryLoaded('c', { includePhotos: true });
    category.samples[0].sn = 'Unsent sample edit';
    context.fetch = () => write.promise;
    const writing = app.commitSampleMutation(category.samples[0], { render: false });
    read.resolve(stale);
    await tick();
    write.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: 'synthetic failure' }) });
    assert.equal(await writing, false);
    assert.equal(await loading, null);
    assert.equal(app.findSample('s').sample.sn, 'Unsent sample edit', 'pool details cannot overwrite a failed sample save');
    assert.equal(app._baseData.sampleLibrary.categories[0].samples[0].sn, 'SN');
  }
  {
    const { app } = fixture();
    app.data.projects.push({ id: 'other', name: 'Other', stages: [{ id: 'other-stage', tasks: [], progress: 'saved' }] });
    app.markDataSynced();
    app.data.projects[1].stages[0].progress = 'unsent';
    app.view = { module: 'home', selectedProjectId: 'p' };
    app.currentProject = () => app.data.projects[0];
    app.importMutationIdSets = () => ({ projectIds: new Set(['p']), stageIds: new Set(), sampleCategoryIds: new Set() });
    app.fetchProjectSummary = async () => [{ id: 'p', name: 'Imported' }, { id: 'other', name: 'Other' }];
    app.fetchSampleCategoriesSummary = async () => [{ id: 'c', name: 'Pool', sampleCount: 1 }];
    app.fetchProjectDetail = async () => ({ id: 'p', name: 'Imported', stages: [] });
    assert.equal(await app.applyImportBundleMutationResult({ revision: 2, mutationSummary: {} }, { render: false }), true);
    assert.equal(app._baseData.projects[0].name, 'Imported', 'hydrated import fields are acknowledged');
    assert.equal(app.data.projects[1].stages[0].progress, 'unsent');
    assert.equal(app._baseData.projects[1].stages[0].progress, 'saved', 'import hydration must not acknowledge an unrelated stage draft');
    assert.equal(app.hasLocalUnsavedChanges(), true);
    app.data.projects[0].name = 'New local draft';
    assert.equal(await app.applyImportBundleMutationResult({ revision: 3, mutationSummary: {} }, { render: false }), false);
    assert.equal(app.data.projects[0].name, 'New local draft', 'import hydration refuses to overwrite a dirty target');
    assert.equal(app._baseData.projects[0].name, 'Imported');
  }
}

function dropdownEscapeTests() {
  const { app, context } = fixture();
  for (const file of ['workspace/01-shared.js', 'workspace/09-task-result.js']) {
    vm.runInContext(readFrontendScript(path.join(root, 'frontend/js', file)), context);
  }
  let open = true, closes = 0, keydown;
  const input = { closest: () => ({ classList: { contains: () => open } }) };
  app.closeProjectMemberComboboxes = app.closeTaskResultLocationComboboxes = () => { open = false; };
  context.document.addEventListener = (_type, listener) => { keydown = listener; };
  context.document.getElementById = id => id === 'modalMask' ? { style: { display: 'flex' }, querySelector: () => ({}) } : null;
  app.requestModalClose = () => { closes++; };
  app.bindDialogKeyboardEvents();
  for (const handler of ['handleProjectMemberComboboxKey', 'handleTaskResultLocationKey']) {
    open = true;
    const first = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app[handler](input, first);
    keydown(first);
    assert.equal(open, false);
    const previousCloses = closes;
    assert.equal(first.defaultPrevented, true, 'an open dropdown consumes Escape before the modal');
    const second = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app[handler](input, second);
    keydown(second);
    assert.equal(closes, previousCloses + 1, 'a second Escape can close the modal once its dropdown is closed');
  }
  assert.equal(closes, 2, 'one Escape must never close both dropdown and modal');
}

function logIdentityTests() {
  const { app, context } = fixture();
  vm.runInContext(readFrontendScript(path.join(root, 'frontend/js/app.logs.js')), context);
  const first = { id: 'first', sn: 'SN-OLD-1234', imei: '860000000001234' };
  const second = { id: 'sample_通过', sn: 'SN-NEW-1234', imei: '860000000011234' };
  app.allSamples = () => [first, second];
  app.sampleDisplayCode = sample => `IMEI#${sample.imei.slice(-4)}`;
  const task = { sampleIds: [first.id, second.id], sampleSnapshots: { first, sample_通过: second } };
  assert.equal(app.findLogSampleRefId('IMEI#1234', task), '', 'colliding abbreviations cannot link to an arbitrary sample');
  assert.equal(app.findLogSampleRefId('SN-NEW-1234', task), second.id, 'full sample identity resolves precisely');
  assert.equal(app.findLogSampleRefId('IMEI#860000000011234', task), second.id);
  const log = { sampleRefs: [{ sampleId: first.id, ref: 'IMEI#001234' }, { sampleId: second.id, ref: 'IMEI#1234' }] };
  assert.equal(app.findLogSampleRefId('IMEI#1234', task, log), second.id, 'exact recorded reference wins before an earlier suffix match');
  const html = app.linkSampleRefsInLogText('SN-NEW-1234 不通过（需复测）', task);
  assert.match(html, /data-id="sample_通过"/u, 'result highlighting must not rewrite HTML attributes');
  assert.match(html, /class="log-result-fail">不通过（需复测）<\/b>/u);
}

async function delayedDialogTests() {
  const { app, context } = fixture();
  for (const file of ['app.logs.js', 'samples/04-photos.js', 'workspace/09-task-result.js']) {
    vm.runInContext(readFrontendScript(path.join(root, 'frontend/js', file)), context);
  }
  app.view = { module: 'projectWorkspace', selectedProjectId: 'p' };
  let opened = 0;
  app.showModal = () => { opened++; };
  app.getProjectStageTask = () => ({ p: {}, s: {}, t: { id: 'task', logs: [] } });
  app.taskLogListNode = () => fakeElement();
  let pending = deferred();
  app.ensureTaskReferenceSamplesLoaded = () => pending.promise;
  const logs = app.showTaskLogs('p', 'stage', 'task');
  app._currentModalId = 'another-modal';
  pending.resolve();
  await logs;
  assert.equal(opened, 0, 'a delayed task log cannot replace a newer dialog');
  app.taskFlowStatus = () => '进行中';
  app.taskResultSampleEntries = () => [{ sampleId: 's' }];
  pending = deferred();
  app.prepareTaskActionSamples = () => pending.promise;
  const result = app.uploadResult('p', 'stage', 'task');
  app.view.module = 'home';
  pending.resolve(true);
  await result;
  assert.equal(opened, 0, 'a delayed result form cannot reopen after leaving its workspace');
  let appended = 0, alerts = 0;
  context.document.body = { append() { appended++; } };
  context.alert = () => { alerts++; };
  pending = deferred();
  app.ensureSampleDetailsLoaded = () => pending.promise;
  const preview = app.previewSamplePhoto('s', 'photo');
  app._currentModalId = 'closed';
  pending.resolve({ photos: [{ id: 'photo', url: '/photo.jpg' }] });
  await preview;
  assert.equal(appended, 0, 'a delayed photo preview cannot open over a different dialog');
  app.ensureSampleDetailsLoaded = async () => { throw new Error('offline'); };
  await app.previewSamplePhoto('s', 'photo');
  assert.equal(alerts, 1, 'photo loading failures are recoverable and visible');
}

async function pageMutationTests() {
  const { app, context } = fixture();
  for (const file of ['workspace/05-task-table.js', 'samples/01-pool.js']) {
    vm.runInContext(readFrontendScript(path.join(root, 'frontend/js', file)), context);
  }
  // Restore the real invalidator; the shared fixture suppresses it for isolated hydration tests.
  const server = {};
  context.app.registerModule = (_name, members) => Object.assign(server, members);
  vm.runInContext(readFrontendScript(path.join(root, 'frontend/js/app.server.js')), context);
  app.invalidatePagedCaches = server.invalidatePagedCaches;
  const project = app.data.projects[0];
  const task = { id: 'task', status: '进行中', owner: 'Owner/001' };
  const stage = { id: 'stage', tasks: [task], statusCounts: { '进行中': 1 }, ownerNames: ['Owner'] };
  project.stages = [stage];
  app.markDataSynced();
  app.view = { module: 'projectWorkspace', selectedStageId: 'stage' };
  app.taskFlowStatus = item => item.status;
  app.refreshTaskFlowRegion = () => {};
  const params = app.taskFlowQueryParams(stage);
  const key = app.taskFlowCacheKey(stage, params);
  app._taskFlowPageCache = { key, stageId: 'stage', rows: [{ task }], stats: { statusCounts: { '进行中': 1 } } };
  const oldRequest = app.beginTaskFlowPageRequest(stage, key);
  task.status = '正常完成';
  const affected = { taskIds: ['task'], tasks: [{ ...task, projectId: 'p', stageId: 'stage' }],
    stageSummaries: [{ id: 'stage', statusCounts: { '进行中': 0, '正常完成': 1 }, taskCount: 1 }] };
  app.applyMutationAffected(affected);
  assert.equal(app.tryPatchCurrentTaskFlowPage(project, stage, affected), true);
  assert.equal(stage.statusCounts['进行中'], 0, 'optimistic task updates still decrement the previous server status');
  assert.equal(stage.statusCounts['正常完成'], 1);
  assert.equal(app._taskFlowPageCache.stats.statusCounts['正常完成'], 1, 'server stage counts and local page counts are each advanced only once');
  assert.equal(app.isCurrentTaskFlowPageRequest(oldRequest, stage), false, 'patching a task page cancels older reads');
  app.markDataSynced();
  task.owner = 'Pending/002';
  const hydration = deferred();
  app.ensureTaskReferenceSamplesLoaded = () => hydration.promise;
  const snapshot = app.dataSnapshot();
  app.restoreDataSnapshot(snapshot);
  app.storeTaskFlowPageResult(project, stage, key, {
    rows: [{ task: { id: 'task', status: '正常完成', owner: 'Owner/001', testItem: 'Server item' } }],
  });
  const current = app.data.projects[0].stages[0].tasks[0];
  assert.equal(current.owner, 'Pending/002', 'a task read preserves a newer unsaved field');
  assert.equal(current.testItem, 'Server item', 'a task read merges into the restored live tree');
  hydration.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(app._baseData.projects[0].stages[0].tasks[0].owner, 'Owner/001', 'sample hydration must not acknowledge a newer task draft');
  const liveStage = app.data.projects[0].stages[0];
  liveStage.taskCount = 125;
  liveStage.statusCounts = { '正常完成': 124, '进行中': 1 };
  app.taskFlowQueryParams = () => ({ ownerName: 'Owner/001', page: 1, pageSize: 25 });
  app.storeTaskFlowPageResult(app.data.projects[0], liveStage, 'filtered', {
    rows: [], stats: { totalInStage: 1, statusCounts: { '进行中': 1 } },
  });
  assert.equal(liveStage.taskCount, 125, 'a filtered task page must not shrink the whole-stage count');
  assert.equal(liveStage.statusCounts['正常完成'], 124);
  assert.equal(app._taskFlowPageCache.stats.totalInStage, 1, 'filtered table statistics remain accurate');
  const category = app.data.sampleLibrary.categories[0];
  app.view = { module: 'samples', selectedCategoryId: 'c' };
  app.refreshSamplePageRegion = () => {};
  const sampleParams = app.samplePageQueryParams(category);
  const sampleKey = app.samplePageCacheKey(category, sampleParams);
  app.setSamplePageCache({ key: sampleKey, categoryId: 'c', items: category.samples, stats: {} });
  const oldSampleRequest = app.beginSamplePageRequest('prefetch');
  assert.equal(app.tryPatchCurrentSamplePage(category, { sampleIds: ['s'], samples: [{ ...category.samples[0], categoryId: 'c' }] }), true);
  assert.equal(app.finishSamplePageRequest('prefetch', oldSampleRequest), false, 'patching a sample page also invalidates stale prefetch requests');
  assert.ok(app.getSamplePageCache(sampleKey), 'the acknowledged current page remains available after invalidation');
  category.samples[0].owner = 'Original/001';
  app.sampleEffectiveStatus = sample => sample.status || '闲置';
  app.markDataSynced();
  // The editor optimistically changes the same live object before the response.
  category.samples[0].owner = 'Changed/002';
  const personAffected = { sampleIds: ['s'], samples: [{ ...category.samples[0], categoryId: 'c' }] };
  app.applyMutationAffected(personAffected);
  app.syncMutationPayloadBaseline({ samples: personAffected.samples }, personAffected);
  assert.equal(app.tryPatchCurrentSamplePage(category, personAffected), false,
    'changed person assignment must fetch fresh full-pool filter names even after baseline acknowledgement');
  category.samples[0].borrower = 'Borrower/003';
  const borrowerAffected = { sampleIds: ['s'], samples: [{ ...category.samples[0], categoryId: 'c' }] };
  app.applyMutationAffected(borrowerAffected);
  assert.equal(app.tryPatchCurrentSamplePage(category, borrowerAffected), false, 'borrower changes also refresh names');
  app.markDataSynced();
  const ordinaryAffected = { sampleIds: ['s'], samples: [{ ...category.samples[0], notes: 'updated', categoryId: 'c' }] };
  app.applyMutationAffected(ordinaryAffected);
  assert.equal(app.tryPatchCurrentSamplePage(category, ordinaryAffected), true, 'ordinary field updates retain page patch optimization');
}

async function taskResultChangeTests() {
  const { app, context } = fixture();
  vm.runInContext(readFrontendScript(path.join(root, 'frontend/js/workspace/09-task-result.js')), context);
  const initial = { result: '通过', user: 'Tester/001', samples: [{ sid: 's', photos: [], problemRecords: [{ description: 'Issue', source: 'Initial' }] }] };
  const photosOnly = app.cloneData(initial);
  photosOnly.samples[0].photos = [{ id: 'photo' }];
  assert.equal(app.isTaskResultPayloadEqual(initial, photosOnly), false, 'adding only result photos is a saveable change');
  const sourceOnly = app.cloneData(initial);
  sourceOnly.samples[0].problemRecords[0].source = 'Retest';
  assert.equal(app.isTaskResultPayloadEqual(initial, sourceOnly), false, 'problem source edits are not discarded as no-op');
  const labelOnly = app.cloneData(initial);
  labelOnly.samples[0].problemRecords[0].taskLabel = 'Another task';
  assert.equal(app.isTaskResultPayloadEqual(initial, labelOnly), false);
  const task = { id: 'task', status: '进行中' }, stage = { id: 'stage', tasks: [task] }, project = { id: 'p', stages: [stage] };
  app.getProjectStageTask = () => ({ p: project, s: stage, t: task });
  app._taskResultBaselineTaskId = 'task';
  app._taskResultBaseline = initial;
  app.collectTaskResultForm = () => photosOnly;
  app.validateTaskResultMemberFields = () => '';
  app.isTaskCompleted = () => false;
  app.saveTaskResultDraft = (_project, _stage, current, payload) => { current.resultDraft = payload; };
  context.Utils.toast = () => {};
  let committed = 0;
  app.commitTaskMutation = async () => { committed++; return true; };
  assert.equal(await app.saveTaskResult('p', 'stage', 'task'), false);
  assert.equal(committed, 1, 'a photo-only edit goes through the task mutation and retains its reference');
  assert.equal(task.resultDraft.samples[0].photos[0].id, 'photo');
}

async function sampleDetailTests() {
  const { app, context } = fixture();
  for (const file of ['samples/03-detail-fields.js', 'samples/08-files.js', 'samples/07-detail.js']) {
    vm.runInContext(readFrontendScript(path.join(root, 'frontend/js', file)), context);
  }
  app.constants = { sampleStatuses: ['闲置', '测试中'] };
  app.view = { module: 'samples', selectedCategoryId: 'c' };
  app.sampleReassemblySourcesHtml = () => '';
  app.sampleDisplayCode = sample => sample.sn;
  app.samplePhotosHtml = () => 'photos';
  app.sampleTestHistoryHtml = () => 'history';
  app.sampleProblemsHtml = () => '';
  app.clearFieldValidationMarks = () => {};
  app.projectMemberSelectHtml = () => '';
  app.collectSampleProblems = () => [];
  app.validateSampleSelfDuplicate = () => null;
  app.sampleIdentifierSignature = sample => sample.sn;
  let onSave = null, opened = 0;
  app.showModal = (_title, _html, callback) => { opened++; onSave = callback; };
  context.Utils.toast = () => {};
  const sample = app.findSample('s').sample;
  sample.currentProjectId = 'p';
  sample.status = '闲置';
  app.data.projects[0]._summaryOnly = true;
  const projectRead = deferred();
  app.fetchProjectDetail = () => projectRead.promise;
  const opening = app.openSampleDetail('s');
  assert.equal(opened, 0, 'sample personnel controls wait for their associated project metadata');
  projectRead.resolve({ id: 'p', name: 'Project', members: [{ name: '测试员', employeeNo: '001' }], locations: ['实验室'], stages: [] });
  await opening;
  assert.equal(opened, 1);
  assert.equal(app.data.projects[0].members.length, 1);
  const fields = Object.fromEntries(['sdSn', 'sdImei', 'sdBoardSn', 'sdReassembled', 'sdLocation', 'sdOwner', 'sdBorrower',
    'sdConfig', 'sdSchemeNo', 'sdStage', 'sdStatus', 'sdNotes'].map(key => [key, { value: '' }]));
  fields.sdSn.value = 'SN';
  fields.sdReassembled.value = '否';
  fields.sdStatus.value = '闲置';
  fields.sdNotes.value = 'First edit';
  sample.owner = fields.sdOwner.value = '旧挂账人/001';
  sample.borrower = fields.sdBorrower.value = '旧持有人/002';
  fields.sdBorrower.disabled = true;
  let personChecks = 0;
  app.collectSamplePersonValue = () => { personChecks++; return { ok: false, msg: 'not a current member' }; };
  app.markFieldInvalid = () => {};
  context.document.getElementById = key => fields[key] || null;
  let saves = 0;
  app.commitSampleMutation = async sample => {
    assert.equal(sample, app.findSample('s').sample, 'retry must mutate the restored live sample, not a detached object');
    return ++saves > 1;
  };
  assert.equal(await onSave(), true, 'ordinary failure retains the form for retry');
  assert.equal(app.findSample('s').sample.notes, undefined);
  fields.sdNotes.value = 'Retry edit';
  assert.equal(await onSave(), false);
  assert.equal(app.findSample('s').sample.notes, 'Retry edit');
  assert.equal(app.findSample('s').sample.borrower, '旧持有人/002');
  assert.equal(personChecks, 0, 'unchanged historical personnel do not block unrelated edits after their role changes');
  fields.sdOwner.value = '新挂账人/003';
  assert.equal(await onSave(), true, 'new assignments still require current membership validation');
  assert.equal(personChecks, 1);
  assert.equal(saves, 2, 'invalid assignment does not submit');
  const photosPanel = {}, historyPanel = {};
  const shell = { dataset: { sampleDetailId: 's', readonly: '1' } };
  context.document.querySelector = selector => selector === '.sample-archive-shell' ? shell
    : selector === '[data-sample-archive-panel="photos"]' ? photosPanel
      : selector === '[data-sample-archive-panel="history"]' ? historyPanel : null;
  app.replaceHtml = (node, html) => { node.html = html; };
  app._activeSampleDetailId = 'other-sample-child';
  let readonlyApplied = 0;
  app.applySampleArchiveReadonly = () => { readonlyApplied++; };
  app.refreshSampleArchivePanels('s');
  assert.equal(photosPanel.html, 'photos', 'returning from nested sample details refreshes the restored parent sample');
  assert.equal(readonlyApplied, 1, 'new photo controls in a readonly modal remain readonly');
}

function fakeElement(id = '') {
  return {
    id, innerText: '', className: '', style: {}, dataset: {}, disabled: false,
    children: [], childNodes: [], listeners: {}, attributes: {},
    addEventListener(event, fn) { this.listeners[event] = fn; },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; this.childNodes = nodes; },
    querySelector() { return null; },
  };
}
async function modalTests() {
  const { app, context } = fixture();
  const ids = Object.fromEntries(['confirmMask', 'confirmTitle', 'confirmMessage', 'confirmDesc', 'confirmCancel', 'confirmOk',
    'modalMask', 'modalBody', 'modalTitle', 'modalCancel', 'modalOk', 'modalHeaderHint'].map(id => [id, fakeElement(id)]));
  const confirmBox = fakeElement(), modal = fakeElement(), footer = fakeElement();
  footer.children = [ids.modalCancel, ids.modalOk];
  ids.confirmMask.querySelector = () => confirmBox;
  context.document.getElementById = id => ids[id] || null;
  context.document.querySelector = query => query === '.modal' ? modal : query === '.modal-footer' ? footer : null;
  app.resetEventTarget = el => { el.listeners = {}; return el; };
  app.replaceHtml = () => {};
  app.updateSelectPlaceholderState = () => {};
  app.bindDialogKeyboardEvents = () => {};
  app.focusDialog = () => {};
  app._modalStack = [];
  app._modalSequence = 0;
  {
    const pending = deferred();
    let calls = 0;
    app.showConfirm('first', () => { calls++; return pending.promise; });
    const click = ids.confirmOk.listeners.click;
    const saving = click();
    await click();
    assert.equal(calls, 1);
    assert.equal(app.closeConfirm(), false, 'confirmation cannot be dismissed while its action is running');
    app.showConfirm('second', () => {});
    pending.resolve();
    await saving;
    assert.equal(ids.confirmMask.style.display, 'flex', 'old completion cannot close a replacement confirmation');
    assert.equal(ids.confirmMessage.innerText, 'second');
    app.closeConfirm();
  }
  {
    const pending = deferred();
    let calls = 0;
    app.showModal('save', '', () => { calls++; return pending.promise; });
    const click = ids.modalOk.listeners.click;
    const saving = click();
    await click();
    assert.equal(calls, 1, 'modal action ignores repeated invocations while busy');
    assert.equal(app.closeModal(), false, 'header close cannot discard an in-flight form');
    pending.resolve(true);
    await saving;
    assert.equal(app._modalBusy, false);
    assert.equal(ids.modalMask.style.display, 'flex');
    app.closeModal();
  }
  {
    let cancelled = 0;
    app.showModal('unsaved', '', () => false, 'save', { onCancel: () => { cancelled++; return true; } });
    assert.equal(await app.requestModalClose(), false);
    assert.equal(cancelled, 1, 'Escape/header dismissal runs the same unsaved guard as Cancel');
    assert.equal(ids.modalMask.style.display, 'flex');
    const pending = deferred();
    app._currentModalOnCancel = () => { cancelled++; return pending.promise; };
    const closing = app.requestModalClose();
    assert.equal(await app.requestModalClose(), false);
    assert.equal(cancelled, 2, 'async dismissal cannot run twice');
    pending.resolve(false);
    assert.equal(await closing, true);
    assert.equal(ids.modalMask.style.display, 'none');
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
