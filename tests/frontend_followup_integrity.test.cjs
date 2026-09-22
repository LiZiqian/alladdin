const { readFrontendScript } = require('./frontend_source.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(...modules) {
  const notices = [], dialogs = [];
  const context = {
    console, setTimeout, clearTimeout,
    alert: text => notices.push(text),
    document: { getElementById: () => null },
    Utils: { esc: value => String(value || ''), toast: text => notices.push(text) },
    app: { registerModule(_name, members) { Object.assign(this, members); } },
  };
  vm.createContext(context);
  for (const module of ['app.modal', ...modules]) {
    vm.runInContext(readFrontendScript(path.join(__dirname, '../frontend/js', `${module}.js`))
      + (module === 'utils' ? '\nglobalThis.Utils = Utils;' : ''), context);
  }
  const app = context.app;
  app.view = { module: 'projectWorkspace', selectedProjectId: 'p', selectedStageId: 'stage' };
  app.showModal = app.showConfirm = app.showDangerConfirm = (...args) => dialogs.push(args);
  return { app, context, notices, dialogs };
}

async function staleDialogTests() {
  for (const outcome of ['navigate', 'replace-modal', 'refresh', 'same-context']) {
    const { app, dialogs } = fixture('samples/06-history');
    const read = deferred();
    app.findSampleSnapshot = () => null;
    app.findSample = () => null;
    app.ensureSampleLoaded = () => read.promise;
    app.openSampleDetail = (...args) => dialogs.push(args);
    const opening = app.openTaskSampleReadonly('sample');
    if (outcome === 'navigate') app.view.module = 'samples';
    if (outcome === 'replace-modal') app._currentModalId = 'new-modal';
    if (outcome === 'refresh') app._dataSnapshotEpoch = 1;
    read.resolve({ sample: { id: 'sample' } });
    await opening;
    assert.equal(dialogs.length, outcome === 'same-context' ? 1 : 0, `sample lookup must honor ${outcome}`);
  }
  {
    const { app, dialogs } = fixture('workspace/05-task-table');
    const read = deferred();
    app.getProjectStageTask = () => ({ p: { id: 'p' }, s: { id: 'stage' }, t: { id: 'task' } });
    app.taskResultSampleEntries = () => [];
    app.ensureTaskReferenceSamplesLoaded = () => read.promise;
    app.taskFailureProblemsBySample = () => new Map();
    const opening = app.showTaskSamples('p', 'stage', 'task');
    app.view.module = 'home';
    read.resolve();
    await opening;
    assert.equal(dialogs.length, 0, 'late task sample lists must not replace another page');
  }
  {
    const { app, dialogs } = fixture('projects');
    const project = { id: 'p', stages: [] };
    app.findProjectRecord = () => project;
    app.ensureProjectLoaded = async () => null;
    app.collectProjectDeleteImpact = () => ({});
    app.projectDeleteImpactHtml = () => '';
    await app.deleteProject('p');
    assert.equal(dialogs.length, 0, 'failed project hydration must not offer deletion with incomplete impact');
  }
  {
    const { app, dialogs } = fixture('workspace/08-task-actions');
    const read = deferred();
    const task = { id: 'task', owner: 'Tester/001', status: '待下发', sampleIds: ['sample'], planStartDate: '2026-09-01', planEndDate: '2026-09-30' };
    app.getProjectStageTask = () => ({ p: { id: 'p' }, s: { id: 'stage' }, t: task });
    app.isTaskCompleted = () => false;
    app.taskFlowStatus = item => item.status;
    app.validatePersonForScope = () => ({ ok: true });
    app.prepareTaskActionSamples = () => read.promise;
    const opening = app.startTask('p', 'stage', 'task');
    app.view.selectedProjectId = 'other';
    read.resolve(true);
    await opening;
    assert.equal(dialogs.length, 0, 'late preparation must not offer to start a task after navigation');
  }
}

function pickerFixture() {
  const env = fixture('app.data', 'app.server', 'workspace/06-sample-picker');
  const { app } = env;
  app.data = { projects: [], sampleLibrary: { categories: [{ id: 'c', name: 'Pool', samples: [{ id: 's', categoryId: 'c', status: '闲置', remark: '' }] }], logs: [] } };
  app._baseData = app.cloneData(app.data);
  app.serverRevision = 1;
  app.renderTaskSamplePicker = () => {};
  app.resetTaskSamplePickerState('pick', { categoryId: 'c' });
  return env;
}

async function pickerReadTests() {
  {
    const { app } = pickerFixture();
    const state = app.taskSamplePickerState('pick');
    state.selectedIds.add('s');
    app.cacheTaskSamplePickerResult(state, { selectedItems: [{ id: 's', status: '闲置' }] });
    app.cacheTaskSamplePickerResult(state, { selectedMissingIds: ['s'] });
    assert.equal(app.taskSamplePickerSelectedItems(state)[0]._missing, true, 'server-confirmed missing samples must invalidate an older selected cache');
    app.cacheTaskSamplePickerResult(state, { selectedItems: [{ id: 's', status: '闲置' }] });
    assert.equal(app.taskSamplePickerSelectedItems(state)[0]._missing, false, 'a newly available selected record clears its missing marker');
  }
  {
    const { app } = pickerFixture();
    const read = deferred();
    let reads = 0;
    app.fetchTaskSampleCandidates = () => ++reads === 1 ? read.promise : Promise.resolve({ items: [{ id: 's', categoryId: 'c', status: '测试中' }] });
    const loading = app.loadTaskSamplePickerPage('pick');
    app.data.sampleLibrary.categories[0].samples[0].status = '测试中';
    app.syncHydratedSampleBaseline('c', app.data.sampleLibrary.categories[0].samples[0]);
    app.serverRevision = 2;
    read.resolve({ items: [{ id: 's', categoryId: 'c', status: '闲置' }] });
    await loading;
    assert.equal(app.findSample('s').sample.status, '测试中', 'a late picker read must not undo a successful sample mutation');
    assert.equal(app.taskSamplePickerState('pick').lastResult.items[0].status, '测试中');
    assert.equal(reads, 2, 'the current picker retries a stale read once');
  }
  {
    const { app } = pickerFixture();
    app.data.sampleLibrary.categories[0].samples[0].remark = 'unsaved draft';
    app.fetchTaskSampleCandidates = async () => ({ items: [{ id: 's', categoryId: 'c', status: '借出', remark: 'server value' }, { id: 'new', categoryId: 'c', status: '闲置' }] });
    await app.loadTaskSamplePickerPage('pick');
    assert.equal(app.findSample('s').sample.remark, 'unsaved draft', 'picker hydration must preserve a local field draft');
    assert.equal(app.findSample('s').sample.status, '借出');
    assert.equal(app._baseData.sampleLibrary.categories[0].samples[0].remark, 'server value');
    assert.ok(app._baseData.sampleLibrary.categories[0].samples.some(sample => sample.id === 'new'), 'read-only candidate hydration is added to the baseline');
  }
  {
    const { app } = pickerFixture();
    const read = deferred();
    app.fetchTaskSampleCandidates = () => read.promise;
    const loading = app.loadTaskSamplePickerPage('pick');
    app._dataSnapshotEpoch = 1;
    app.data.sampleLibrary.categories[0].samples = [];
    read.resolve({ items: [{ id: 's', categoryId: 'c', status: '闲置' }] });
    await loading;
    assert.equal(app.findSample('s'), null, 'a picker read from before conflict refresh cannot resurrect removed samples');
    assert.equal(app.taskSamplePickerState('pick').loading, false);
  }
  {
    const { app } = pickerFixture();
    const read = deferred();
    let reads = 0;
    app.fetchTaskSampleCandidates = () => ++reads === 1 ? read.promise : Promise.resolve({ items: [{ id: 's', categoryId: 'c', status: '测试中' }] });
    const loading = app.loadTaskSamplePickerPage('pick');
    const release = await app.beginServerMutation();
    app.findSample('s').sample.status = '测试中';
    read.resolve({ items: [{ id: 's', categoryId: 'c', status: '闲置' }] });
    await Promise.resolve();
    assert.equal(app.findSample('s').sample.status, '测试中', 'a read finishing before the write ACK cannot overwrite the optimistic change');
    app.syncHydratedSampleBaseline('c', app.findSample('s').sample);
    app.serverRevision = 2;
    release();
    await loading;
    assert.equal(app.findSample('s').sample.status, '测试中');
    assert.equal(app.hasLocalUnsavedChanges(), false);
  }
}

async function taskConfigContextTests() {
  {
    const { app, context } = fixture('workspace/07-task-config');
    const timers = [];
    context.setTimeout = callback => timers.push(callback);
    const title = { textContent: 'Replacement dialog', append() {} };
    context.document.getElementById = id => id === 'modalTitle' ? title : null;
    app.findProjectRecord = () => ({ id: 'p', stages: [{ id: 'stage', progress: [{ id: 'progress' }], tasks: [] }] });
    app.taskConfigPanelHtml = () => '';
    app.taskConfigTitlebarNode = () => ({});
    let initialized = 0;
    app.initTaskSamplePicker = () => initialized++;
    app.showModal = () => { app._currentModalId = 1; return 1; };
    await app.openTaskConfigPanel('p', 'stage', 'progress');
    app._currentModalId = 2;
    timers.forEach(callback => callback());
    assert.equal(title.textContent, 'Replacement dialog', 'a deferred config title update cannot rewrite a replacement dialog');
    assert.equal(initialized, 0, 'a closed config panel cannot initialize its picker later');
  }
  for (const transition of ['rebase', 'completed']) {
    const { app, context } = fixture('workspace/07-task-config');
    const read = deferred();
    const task = { id: 'task', status: '待下发', owner: 'Old/001', sampleIds: [] };
    let project = { id: 'p', stages: [{ id: 'stage', progress: [{ id: 'progress' }], tasks: [task] }] };
    app.findProjectRecord = () => project;
    context.document.getElementById = id => ({ value: { tcPlanOwner: 'New/002', tcPlanStartDate: '2026-09-01', tcPlanEndDate: '2026-09-30' }[id] || '' });
    app.getSelectedTaskSampleIds = () => [];
    app.validateTaskSampleSelection = () => ({ ok: true });
    app.clearFieldValidationMarks = () => {};
    app.validatePersonForScope = () => ({ ok: true });
    app.isTaskChangePayloadChanged = () => true;
    app.prepareTaskActionSamples = () => read.promise;
    app.taskMutationSnapshot = () => ({});
    app.taskSampleIdListKey = items => JSON.stringify(items);
    app.addTaskLog = () => {};
    app.taskFlowStatus = item => item.status;
    let commits = 0;
    app.commitTaskMutation = async () => { commits++; return true; };
    const saving = app.saveTaskConfigAll('p', 'stage', 'progress', 'task');
    if (transition === 'rebase') { project = JSON.parse(JSON.stringify(project)); app._dataSnapshotEpoch = 1; }
    else task.status = '已完成';
    read.resolve(true);
    await saving;
    assert.equal(commits, 0, `task config must stop if ${transition} changes its target while samples load`);
    assert.equal(task.owner, 'Old/001');
  }
}

async function sampleFormTests() {
  for (const mode of ['add', 'detail']) {
    const { app, context } = fixture('utils', 'app.data', 'app.server', 'samples/03-detail-fields', 'samples/01-pool', 'samples/08-files', 'samples/07-detail');
    app.data = { projects: [], sampleLibrary: { categories: [{ id: 'c', samples: [{ id: 's', categoryId: 'c', sn: 'Old', status: '闲置' }] }], logs: [] } };
    app._baseData = app.cloneData(app.data);
    app.constants = { sampleStatuses: ['闲置'] };
    app.ensureSamplePersonContextLoaded = () => true;
    app.samplePersonInputHtml = app.sampleLocationInputHtml = app.sampleProblemsHtml = app.samplePhotosHtml = app.sampleTestHistoryHtml = () => '';
    app.sampleReassemblySourcesHtml = () => '';
    app.sampleDisplayCode = sample => sample.sn;
    app.clearFieldValidationMarks = () => {};
    app.collectSampleProblems = () => [];
    app.validateSampleSelfDuplicate = () => null;
    app.sampleIdentifierSignature = sample => sample.sn;
    app.markFieldInvalid = () => {};
    context.document.querySelector = () => null;
    context.Utils.toast = () => {};
    let onSave;
    app.showModal = (_title, _html, callback) => { onSave = callback; };
    if (mode === 'add') await app.addSample('c');
    else await app.openSampleDetail('s');
    const prefix = mode === 'add' ? 'sample' : 'sd';
    const values = { [`${prefix}Sn`]: 'New', [`${prefix}Reassembled`]: '否', [`${prefix}Status`]: '闲置' };
    context.document.getElementById = id => ({ value: values[id] || '' });
    const read = deferred();
    app._checkServerIdentityDuplicate = () => read.promise;
    let commits = 0;
    app.commitSampleCategoryMutation = app.commitSampleMutation = async () => { commits++; return true; };
    const saving = onSave();
    app.data = app.cloneData(app.data);
    app._dataSnapshotEpoch = 1;
    read.resolve(null);
    await saving;
    assert.equal(commits, 0, `${mode} sample cannot submit detached pre-refresh data after identity lookup`);
    assert.equal(app.findSample('s').sample.sn, 'Old');
  }
  for (const method of ['destroySample', 'deleteSampleCategory']) {
    const { app, dialogs } = fixture('samples/01-pool');
    const read = deferred();
    app.ensureSampleDestroyImpactScope = () => read.promise;
    const opening = app[method]('id');
    app.view.module = 'home';
    read.resolve(true);
    await opening;
    assert.equal(dialogs.length, 0, `${method} impact read cannot open a stale destructive dialog`);
  }
}

function progressCountTests() {
  const { app, context, dialogs } = fixture('app.data', 'app.server', 'workspace/07-task-config');
  context.setTimeout = () => {};
  const stage = { id: 'stage', progress: [{ id: 'progress', testItem: 'Case', skuIndex: 1 }], tasks: [{ id: 'task', progressId: 'progress' }], progressTaskCounts: { progress: 125 } };
  const project = { id: 'p', stages: [stage] };
  app.data = { projects: [project], sampleLibrary: { categories: [], logs: [] } };
  app._baseData = app.cloneData(app.data);
  app.currentProject = () => project;
  app.currentStage = () => stage;
  app.getProgressRequiredSampleCount = () => 1;
  app.taskCategoryItemText = () => 'Case';
  app.openAddTasksFromPoolModal();
  assert.match(dialogs.at(-1)[1], /125 个/, 'existing task counts include unloaded pages');
  const affected = { stageSummaries: [{ id: 'stage', progressTaskCounts: { progress: 126 } }] };
  app.applyMutationAffected(affected);
  app.syncMutationPayloadBaseline({}, affected);
  app.openAddTasksFromPoolModal();
  assert.match(dialogs.at(-1)[1], /126 个/, 'mutation summary updates the authoritative count');
  assert.equal(app._baseData.projects[0].stages[0].progressTaskCounts.progress, 126);
  assert.equal(app.compactStageForMutation(stage).progressTaskCounts, undefined);
  const untouched = { id: 'other-stage', name: 'Other', tasks: [], usedSampleRuns: 15, runningSampleCount: 2, progressTaskCounts: { other: 20 } };
  project.stages.push(untouched);
  app._baseData = app.cloneData(app.data);
  app.syncMutationPayloadBaseline({ projectId: 'p', stages: project.stages.map(item => app.compactStageForMutation(item)) }, affected);
  assert.equal(app.hasLocalUnsavedChanges(), false, 'saving one stage must retain other stages read-only baseline metrics');
}

async function testedItemSummaryTests() {
  const { app, context } = pickerFixture();
  vm.runInContext(readFrontendScript(path.join(__dirname, '../frontend/js/workspace/05-task-table.js')), context);
  const sample = app.findSample('s').sample;
  app.data.projects.push({ id: 'p', stages: [{ id: 'stage', tasks: [{ id: 'task', status: '进行中', testItem: 'Only loaded task', sampleIds: ['s'] }] }] });
  sample.testedItemNames = ['Remote A', 'Remote B', 'Remote C'];
  assert.deepEqual([...app.sampleTestedItemNames('s')], ['Remote A', 'Remote B', 'Remote C']);
  sample.testedItemNames = [];
  assert.deepEqual([...app.sampleTestedItemNames('s')], [], 'an authoritative empty summary cannot fall back to stale loaded tasks');
  delete sample.testedItemNames;
  assert.deepEqual([...app.sampleTestedItemNames('s')], ['Only loaded task'], 'legacy complete-state input still supports the existing fallback');
  const read = deferred();
  app.fetchTaskSampleCandidates = () => read.promise;
  const loading = app.refreshSampleTestedItemNames(['s']);
  sample.remark = 'unsaved';
  read.resolve({ selectedItems: [{ id: 's', testedItemNames: ['Across pages'], remark: 'old server remark' }] });
  await loading;
  assert.equal(sample.remark, 'unsaved', 'history-summary hydration touches no other sample fields');
  assert.deepEqual([...app.sampleTestedItemNames('s')], ['Across pages']);
  assert.deepEqual([...app._baseData.sampleLibrary.categories[0].samples[0].testedItemNames], ['Across pages']);
  assert.equal(app.compactSampleForMutation(sample).testedItemNames, undefined);
  const sizes = [];
  app.fetchTaskSampleCandidates = async ({ selectedIds }) => { sizes.push(selectedIds.length); return { selectedItems: [] }; };
  await app.refreshSampleTestedItemNames(Array.from({ length: 1001 }, (_, index) => `sample_${index}`));
  assert.deepEqual(sizes, [500, 500, 1], 'large task sample lists obey the candidate API selected-ID limit');
}

async function taskSampleCurrentStatusTests() {
  const { app, context, dialogs } = pickerFixture();
  vm.runInContext(readFrontendScript(path.join(__dirname, '../frontend/js/workspace/05-task-table.js')), context);
  context.Utils.esc = value => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  app.constants = { sampleStatuses: ['闲置', '测试中', '取走分析', '在位等待'] };
  const task = { id: 'task', status: '正常完成', sampleIds: ['s'], testItem: 'Historical task' };
  app.getProjectStageTask = () => ({ p: { name: 'Project' }, s: { name: 'V3' }, t: task });
  app.taskResultSampleEntries = () => [{ sampleId: 's', state: 'active' }];
  app.ensureTaskReferenceSamplesLoaded = () => [];
  app.taskSampleIdentityInfo = () => ({ sn: 'SN-1', imei: '-', boardSn: '-' });
  app.taskSampleArchiveName = () => 'Sample';
  app.sampleProblemRecords = sample => sample.problemRecords || [];
  app.taskFailureProblemsBySample = () => new Map([['s', new Set(['历史问题'])]]);
  app.taskSampleTaskFlowStatus = () => { throw new Error('Historical task destinations must not drive current sample badges'); };
  const longProblem = '完整问题描述'.repeat(15) + '<detail>';
  let serverSample = { id: 's', status: '取走分析', hasProblem: true, testedItemNames: [], problemRecords: [{ description: longProblem }, { description: '另一项问题' }] };
  let reads = 0;
  app.fetchTaskSampleCandidates = async () => { reads++; return { selectedItems: serverSample ? [serverSample] : [] }; };
  app.findSample('s').sample.remark = 'unsaved draft';
  await app.showTaskSamples('p', 'stage', 'task');
  let html = dialogs.at(-1)[1];
  assert.ok(html.includes(context.Utils.esc(longProblem)), 'long problems render in full and remain escaped');
  assert.match(html, /另一项问题/);
  assert.match(html, /历史问题/);
  assert.doesNotMatch(html, /task-sample-problem-count|cursor:help/);
  assert.match(html, /has-fault">有故障/);
  assert.match(html, /s-取走分析">取走分析/);
  serverSample = { id: 's', status: '闲置', hasProblem: false, testedItemNames: [], problemRecords: [] };
  await app.showTaskSamples('p', 'stage', 'task');
  html = dialogs.at(-1)[1];
  assert.match(html, /no-fault">无故障/);
  assert.match(html, /s-闲置">闲置/);
  assert.match(html, /task-result-sample-state active">正式样机/);
  assert.doesNotMatch(html, /取走分析|另一项问题/);
  assert.equal(reads, 2, 'each opening refreshes even a previously loaded sample');
  assert.equal(app.findSample('s').sample.remark, 'unsaved draft', 'read-only rendering preserves local drafts');
  app.taskResultSampleEntries = () => [{ sampleId: 's', state: 'removed' }];
  serverSample.status = '测试中';
  await app.showTaskSamples('p', 'stage', 'task');
  html = dialogs.at(-1)[1];
  assert.match(html, /s-测试中">测试中/);
  assert.match(html, /task-result-sample-state removed">变更样机/, 'historical membership remains separate from the current archive status');
  serverSample = null;
  await app.showTaskSamples('p', 'stage', 'task');
  assert.match(dialogs.at(-1)[1], /故障待确认/, 'a missing archive must not report a healthy sample from stale cache');
}

Promise.resolve().then(staleDialogTests).then(pickerReadTests).then(taskConfigContextTests).then(sampleFormTests).then(progressCountTests).then(testedItemSummaryTests).then(taskSampleCurrentStatusTests).then(() => console.log('frontend follow-up integrity tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
