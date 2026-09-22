const { readFrontendScript } = require('./frontend_source.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const fields = { start: { value: '2026-10-04' }, end: { value: '2026-10-06' } };
const app = { registerModule(_name, members) { Object.assign(this, members); },
  data: { projects: [], sampleLibrary: { categories: [], logs: [] } } };
let lastUrl;
const ctx = { app, console, URLSearchParams, setTimeout, clearTimeout, alert() {},
  document: { getElementById: id => fields[id] || null, querySelectorAll: () => [] },
  fetch: async url => { lastUrl = url; return { ok: true, json: async () => ({ ok: true }) }; } };
vm.createContext(ctx);
for (const file of ['utils.js', 'app.data.js', 'app.server.js', 'workspace/06-sample-picker.js', 'workspace/07-task-config.js', 'debug/auditConsistency.js']) {
  vm.runInContext(readFrontendScript(path.join(root, 'frontend/js', file)) + (file === 'utils.js' ? '\nglobalThis.Utils = Utils;' : ''), ctx);
}
app.projectDefaultSampleCategoryId = () => '';
app.taskFlowStatus = task => task.status;
app.isTaskCompleted = task => task.completed || task.archived || ['正常完成', '异常终止'].includes(task.status);
app.currentStage = () => ({ progress: [] });
app.sampleCategoryRecords = () => [];
app.sampleDisplayCode = sample => sample.sn;
app.sampleHasProblem = () => false;
app.normalizeSampleStatusValue = value => value || '闲置';
app.renderTaskSamplePicker = () => {};
app.mergeTaskSampleCandidateResult = () => {};
app.updateTaskSampleLimitUI = () => {};
app.taskSamplePickerRequiredSampleCount = () => 2;

async function main() {
  const state = app.resetTaskSamplePickerState('pick', { excludeTaskId: 'task', planStartInputId: 'start', planEndInputId: 'end' });
  assert.equal(app.taskSamplePickerFetchParams(state).planStartDate, '2026-10-04');
  fields.end.value = '';
  const params = app.taskSamplePickerFetchParams(state);
  assert.equal(params.planEndDate, '');
  await app.fetchTaskSampleCandidates(params);
  assert.equal(new URL(lastUrl, 'http://localhost').searchParams.get('planEndDate'), '', 'a cleared end date must reach the server');
  assert.equal(new URL(lastUrl, 'http://localhost').searchParams.get('planStartDate'), '2026-10-04');

  // All three candidate filters apply together without dropping the selection or draft schedule.
  const filterState = app.resetTaskSamplePickerState('filterPick', {
    selectedIds: ['selected-a', 'selected-b'], excludeTaskId: 'draft-task',
    categoryId: 'pool-a', planStartInputId: 'start', planEndInputId: 'end',
  });
  assert.equal(filterState.problemState, '');
  assert.equal(filterState.reassembled, '');
  assert.equal(filterState.status, '');
  const filterLoad = app.loadTaskSamplePickerPage;
  let latestFilterLoad;
  app.loadTaskSamplePickerPage = (...args) => (latestFilterLoad = filterLoad.apply(app, args));
  const expectFilterRequest = async (field, value, expected) => {
    filterState.page = 8;
    app.onTaskSamplePickerFilterChange('filterPick', field, value);
    await latestFilterLoad;
    const query = new URL(lastUrl, 'http://localhost').searchParams;
    assert.equal(query.get('page'), '1', `${field} changes must reset server pagination`);
    assert.equal(filterState.page, 1);
    assert.equal(query.get('taskId'), 'draft-task');
    assert.equal(query.get('categoryId'), 'pool-a');
    assert.equal(query.get('selectedIds'), 'selected-a,selected-b', 'filtering must keep selections outside the result set');
    assert.deepEqual(Array.from(filterState.selectedIds), ['selected-a', 'selected-b']);
    assert.equal(query.get('planStartDate'), fields.start.value);
    assert.equal(query.get('planEndDate'), fields.end.value, 'including an explicitly cleared date');
    for (const key of ['problemState', 'reassembled', 'status']) {
      assert.equal(query.get(key), expected[key] || null, `${key} must be independently serialized or cleared`);
    }
  };
  await expectFilterRequest('problemState', 'fault', { problemState: 'fault' });
  await expectFilterRequest('reassembled', 'reassembled', { problemState: 'fault', reassembled: 'reassembled' });
  fields.end.value = '2026-10-06';
  await expectFilterRequest('status', '测试中', { problemState: 'fault', reassembled: 'reassembled', status: '测试中' });
  await expectFilterRequest('problemState', 'ok', { problemState: 'ok', reassembled: 'reassembled', status: '测试中' });
  await expectFilterRequest('reassembled', 'normal', { problemState: 'ok', reassembled: 'normal', status: '测试中' });
  await expectFilterRequest('problemState', '', { reassembled: 'normal', status: '测试中' });
  await expectFilterRequest('reassembled', '', { status: '测试中' });
  await expectFilterRequest('status', '', {});
  app.loadTaskSamplePickerPage = filterLoad;

  let loads = [];
  const originalLoad = app.loadTaskSamplePickerPage;
  app.loadTaskSamplePickerPage = name => loads.push(name);
  app.switchTaskConfigTab('sample');
  assert.deepEqual(loads, ['tcSamplePick'], 'switching from plan to samples refreshes draft availability');
  app.loadTaskSamplePickerPage = originalLoad;

  state.loading = false;
  const conflict = { id: 's', sn: 'QA-001', status: '在位等待', selectable: true, alreadySelected: true,
    selectionConflict: '计划时间重叠', reservationHint: '' };
  state.selectedIds.add('s');
  let html = app.taskSamplePickerSampleRowHtml(conflict, state);
  assert.match(html, /checked/);
  assert.match(html, /计划时间重叠/);
  assert.doesNotMatch(html, /class="dispatch-sample-row is-disabled/);
  state.selectedIds.delete('s');
  html = app.taskSamplePickerSampleRowHtml(conflict, state);
  assert.match(html, /class="dispatch-sample-row is-disabled/);
  assert.doesNotMatch(html, / checked/);
  html = app.taskSamplePickerSampleRowHtml({ ...conflict, selectionConflict: '', reservationHint: '已预约其他时段，可错峰复用' }, state);
  assert.doesNotMatch(html, /class="dispatch-sample-row is-disabled/);
  assert.match(html, /可错峰复用/);

  // The first (slower) request must not overwrite a later date change.
  const pending = [];
  app.fetchTaskSampleCandidates = () => new Promise(resolve => pending.push(resolve));
  const first = app.loadTaskSamplePickerPage('pick');
  const second = app.loadTaskSamplePickerPage('pick');
  pending[1]({ items: [{ id: 's', selectable: true }], page: 1 });
  await second;
  pending[0]({ items: [{ id: 's', selectable: false }], page: 1 });
  await first;
  assert.equal(state.lastResult.items[0].selectable, true);
  const oldModalLoad = app.loadTaskSamplePickerPage('pick');
  const newState = app.resetTaskSamplePickerState('pick');
  pending[2]({ items: [{ id: 'old-modal' }] });
  await oldModalLoad;
  assert.equal(newState.lastResult, null, 'closed/replaced modal results are discarded');

  const sample = { id: 's', sn: 'QA-001', status: '测试中', currentTaskId: 'running', borrower: '', owner: '档案员' };
  app.findSample = () => ({ sample });
  app.sampleEffectiveStatus = value => value.status;
  app.projectName = () => '项目'; app.stageName = () => '阶段';
  const before = JSON.stringify(sample);
  app.recordTaskSampleReservation('s', { taskId: 'future', projectId: 'p', stageId: 'st', source: '预约任务样机' });
  assert.equal(JSON.stringify(sample), before, 'a reservation never mutates physical usage or ownership');
  assert.equal(app.data.sampleLibrary.logs.at(-1).eventType, 'sample_reservation');
  assert.equal(app.data.sampleLibrary.logs.at(-1).taskId, 'future');

  const plan = (id, start, end, status = '待下发') => ({ id, status, sampleIds: ['s'], planStartDate: start, planEndDate: end });
  const a = plan('a', '2026-10-01', '2026-10-03');
  const b = plan('b', '2026-10-04', '2026-10-06');
  assert.equal(app._auditReservationsConflict(a, b), false);
  assert.equal(app._auditReservationsConflict(a, { ...b, planStartDate: '2026-10-03' }), true);
  assert.equal(app._auditReservationsConflict(a, { ...b, planEndDate: '' }), true);
  assert.equal(app._auditReservationsConflict({ ...a, status: '进行中' }, { ...b, status: '阻塞中' }), true);
  app.data.projects = [{ id: 'p', stages: [{ id: 'st', tasks: [b, a, { ...b, id: 'running', status: '进行中' }] }] }];
  assert.deepEqual(Array.from(app.activeTaskUsagesForSample('s'), usage => usage.task.id), ['running', 'a', 'b']);

  // A rejected save keeps the draft open, and retry must read the restored task.
  let liveProject, saveModal, attempts;
  const resetProject = () => {
    liveProject = { id: 'p', stages: [{ id: 'st', progress: [{ id: 'progress' }], tasks: [{ ...a, owner: 'tester' }] }] };
    attempts = 0;
  };
  app.findProjectRecord = () => liveProject;
  app.projectActiveMembers = () => ['tester'];
  app.projectMemberSelectHtml = () => '';
  app.getProgressDisplayName = () => '测试';
  app.showModal = (_title, _html, onSave) => { saveModal = onSave; };
  app.clearFieldValidationMarks = () => {};
  app.validatePersonForScope = () => ({ ok: true });
  app.isTaskChangePayloadChanged = (task, draft) => Object.entries(draft).some(([key, value]) => task[key] !== value);
  app.taskMutationSnapshot = () => JSON.parse(JSON.stringify(liveProject));
  app.restoreFailedTaskMutation = snapshot => { liveProject = snapshot; };
  app.commitTaskMutation = async (project, stage, task) => {
    assert.equal(project, liveProject);
    assert.equal(stage.tasks[0], task);
    return ++attempts > 1;
  };
  app.addTaskLog = () => {};
  ctx.Utils.toast = () => {};
  fields.planOwner = { value: 'tester' };
  fields.planStartDate = { value: '2026-11-01' };
  fields.planEndDate = { value: '2026-11-02' };
  resetProject();
  app.setPlanTaskSchedule('p', 'st', 'progress', 'a');
  assert.equal(await saveModal(), true);
  assert.equal(liveProject.stages[0].tasks[0].planStartDate, '2026-10-01');
  assert.equal(await saveModal(), false);
  assert.equal(attempts, 2, 'retry must save, not mistake the rejected draft for saved data');
  assert.equal(liveProject.stages[0].tasks[0].planStartDate, '2026-11-01');

  app.buildTaskSamplePickerHtml = () => '';
  app.getSelectedTaskSampleIds = () => ['other-sample'];
  app.validateTaskSampleSelection = () => ({ ok: true, required: 1 });
  app.prepareTaskActionSamples = undefined;
  app.recordTaskSampleReservation = () => {};
  ctx.setTimeout = () => {};
  resetProject();
  await app.assignPlanTaskSamples('p', 'st', 'progress', 'a');
  assert.equal(await saveModal(), true);
  assert.deepEqual(liveProject.stages[0].tasks[0].sampleIds, ['s']);
  assert.equal(await saveModal(), false);
  assert.equal(attempts, 2);
  assert.deepEqual(liveProject.stages[0].tasks[0].sampleIds, ['other-sample']);

  // The quantity error lives with the picker and survives its async refresh.
  resetProject();
  fields.tcPlanOwner = { value: 'tester' };
  fields.tcPlanStartDate = { value: '2026-11-01' };
  fields.tcPlanEndDate = { value: '2026-11-02' };
  const validationPicker = app.resetTaskSamplePickerState('tcSamplePick');
  const selectionMessage = '样机分配需要 2 台样机，当前选择 1 台。';
  app.validateTaskSampleSelection = () => ({ ok: false, msg: selectionMessage });
  const renders = [];
  app.renderTaskSamplePicker = name => renders.push(app.taskSamplePickerContentHtml(app.taskSamplePickerState(name)));
  app.fetchTaskSampleCandidates = async () => ({ items: [], selectedItems: [], page: 1 });
  assert.equal(await app.saveTaskConfigAll('p', 'st', 'progress', 'a'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(renders.length >= 2, 'checked both loading and completed picker renders');
  assert.ok(renders.every(markup => markup.includes(selectionMessage)), 'the quantity explanation must not disappear after loading');
  assert.equal(attempts, 0, 'invalid selection must not be persisted');
  validationPicker.selectedIds.add('foo');
  app.onTaskSampleCheckboxChange('', 'tcSamplePick', '', { value: 'foo', checked: false });
  assert.doesNotMatch(renders.at(-1), /class="field-error"/, 'changing the selection clears the stale quantity explanation');
  console.log('Sample reservation frontend regressions passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
