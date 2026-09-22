const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { console, app: { registerModule(_name, methods) { Object.assign(this, methods); } } };
vm.createContext(context);
for (const file of ['utils', 'app.data', 'samples/03-detail-fields', 'samples/08-files', 'samples/07-detail', 'workspace/09-task-result']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js', `${file}.js`), 'utf8')
    + (file === 'utils' ? '\nglobalThis.Utils = Utils;' : ''), context);
}
const { app, Utils } = context;
Utils.today = () => '2026-09-21';
Utils.now = () => '2026-09-21T12:00:00';
Utils.toast = () => {};
app.constants = { sampleStatuses: ['闲置', '测试中', '在位等待', '取走分析', '已退库'] };
app.projectName = () => '项目';
app.stageName = () => '阶段';
app.sampleDisplayCode = record => record.sn;
app.taskFlowStatus = task => task.status;
app.dataSnapshot = () => JSON.parse(JSON.stringify(app.data));
app.view = { module: 'samples' };
const sample = { id: 'sample', sn: 'SN001', status: '闲置', owner: '挂账人/001', borrower: '', location: '库房' };
app.data = { projects: [], sampleLibrary: { categories: [{ id: 'pool', samples: [sample] }], logs: [] } };

// Reassembly previews follow unsaved identity edits without modifying the archive.
const source = { id: 'source', sn: 'SOURCE', imei: 'MATCH' };
app.data.sampleLibrary.categories[0].name = '来源池';
app.data.sampleLibrary.categories[0].samples.push(source);
const previewFields = {
  sdReassemblySources: { innerHTML: '' }, sdReassembled: { value: '是' },
  sdSn: { value: 'MATCH' }, sdImei: { value: '' }, sdBoardSn: { value: 'UNMATCHED' },
};
context.document = { getElementById: id => previewFields[id] };
app._activeSampleDetailId = sample.id;
app.replaceHtml = (element, html) => { element.innerHTML = html; };
const originalSample = JSON.stringify(sample);
app.refreshSampleReassemblySources();
assert.match(previewFields.sdReassemblySources.innerHTML, /SN 匹配来源的 IMEI/);
assert.match(previewFields.sdReassemblySources.innerHTML, /来源池/);
assert.equal((previewFields.sdReassemblySources.innerHTML.match(/class="sample-reassembly-group"/g) || []).length, 3);
assert.match(previewFields.sdReassemblySources.innerHTML, /未匹配/);
assert.match(previewFields.sdReassemblySources.innerHTML, /未填写/);
previewFields.sdReassembled.value = '否';
app.refreshSampleReassemblySources();
assert.equal((previewFields.sdReassemblySources.innerHTML.match(/不适用/g) || []).length, 3);
assert.equal(JSON.stringify(sample), originalSample);

// A workflow receiver is separate from the executor and archive owner.
app.changeSampleStatus(sample.id, '取走分析', {
  taskId: 'task', user: '执行人/002', receiver: '分析人/003', receiverDate: '2026-09-19',
});
assert.equal(sample.borrower, '分析人/003');
assert.equal(sample.borrowDate, '2026-09-19');
assert.equal(sample.owner, '挂账人/001');
assert.equal(sample.currentTaskId, null);
assert.equal(app.data.sampleLibrary.logs.at(-1).taskId, 'task');

for (const destination of ['闲置', '已退库', '测试中', '在位等待']) {
  sample.status = '取走分析'; sample.borrower = '分析人/003'; sample.borrowDate = '2026-09-19';
  app.changeSampleStatus(sample.id, destination, { taskId: 'task', user: '执行人/002' });
  assert.equal(sample.borrower, '', `${destination} clears the prior external receiver`);
  assert.equal(sample.borrowDate, '');
  assert.equal(sample.owner, '挂账人/001');
}

// Archive edits preserve the explicitly entered holder, irrespective of whether
// status changes in the same submission. Clearing a holder clears the loan date.
sample.status = '取走分析'; sample.borrower = '分析人/003'; sample.borrowDate = '2026-09-19';
app.changeSampleStatus(sample.id, '取走分析', { borrower: '分析人/003', destLocation: '新库房' });
assert.equal(sample.borrowDate, '2026-09-19', 'location-only edits retain the existing loan date');
app.changeSampleStatus(sample.id, '取走分析', { borrower: '新分析人/004' });
assert.equal(sample.borrowDate, '2026-09-21');
app.changeSampleStatus(sample.id, '取走分析', { borrower: '' });
assert.equal(sample.borrowDate, '');
app.changeSampleStatus(sample.id, '闲置', { borrower: '保管人/005', destLocation: '' });
assert.equal(sample.borrower, '保管人/005');
assert.equal(sample.borrowDate, '');
assert.equal(sample.location, '');
assert.match(app.data.sampleLibrary.logs.at(-1).detail, /位置：新库房 → 空/);

// Pagination may omit the other task, but the sample's current reference still
// protects it. A future reservation must not prevent the current task finishing.
sample.currentTaskId = 'new-task'; sample.currentTestItem = '新任务'; sample.status = '测试中';
app.activeTaskUsagesForSample = () => [];
assert.equal(app.taskResultCurrentEditLock({ id: 'old-task', status: '进行中', sampleIds: [] }, sample.id).locked, true);
assert.equal(app.taskResultCurrentEditLock({ id: 'old-task', status: '正常完成', sampleIds: [sample.id] }, sample.id).locked, true);
app.activeTaskUsagesForSample = () => [{ project: { name: '项目' }, stage: { name: '阶段' }, task: { id: 'future', testItem: '后续任务' } }];
assert.equal(app.taskResultCurrentEditLock({ id: 'new-task', status: '进行中', sampleIds: [sample.id] }, sample.id).locked, false);

async function verifyDetailSave() {
  sample.status = '闲置'; sample.borrower = ''; sample.currentTaskId = null;
  const fields = Object.fromEntries(['sdSn', 'sdImei', 'sdBoardSn', 'sdReassembled', 'sdConfig', 'sdSchemeNo',
    'sdStage', 'sdStatus', 'sdLocation', 'sdOwner', 'sdBorrower', 'sdNotes'].map(id => [id, { value: '' }]));
  Object.assign(fields.sdSn, { value: 'SN001' });
  fields.sdStatus.value = '取走分析';
  fields.sdOwner.value = '挂账人/001';
  fields.sdBorrower.value = '新分析人/004';
  context.document = { getElementById: id => fields[id], querySelector: () => null };
  app.samplePersonInputHtml = app.sampleLocationInputHtml = app.sampleReassemblySourcesHtml = () => '';
  app.samplePhotosHtml = app.sampleTestHistoryHtml = app.sampleProblemsHtml = () => '';
  app.collectSampleProblems = () => [{ id: 'problem', description: '独立问题页编辑', source: '初检', taskLabel: '' }];
  app.sampleIdentifierSignature = record => record.sn;
  app.validateSampleSelfDuplicate = () => null;
  app.clearFieldValidationMarks = () => {};
  app.collectSamplePersonValue = input => ({ ok: true, value: input.value });
  app.markFieldInvalid = (_input, message) => { throw new Error(message); };
  let save, submissions = 0;
  app.showModal = (_title, html, callback) => {
    save = callback;
    assert.match(html, /data-sample-archive-panel="problems"/);
    assert.doesNotMatch(html, /sampleArchiveFooterHint/);
  };
  app.commitSampleMutation = async () => { submissions++; return true; };
  await app.openSampleDetail(sample.id);
  assert.equal(await save(), false);
  assert.equal(sample.borrower, '新分析人/004');
  assert.equal(sample.borrowDate, '2026-09-21');
  assert.equal(sample.problemRecords[0].description, '独立问题页编辑');
  fields.sdBorrower.value = '';
  assert.equal(await save(), false);
  assert.equal(sample.borrower, '');
  assert.equal(sample.borrowDate, '');
  fields.sdStatus.value = '闲置'; fields.sdBorrower.value = '保管人/005';
  assert.equal(await save(), false);
  assert.equal(sample.borrower, '保管人/005', 'simultaneous status and holder edits retain the entered holder');
  assert.equal(submissions, 3);
}
verifyDetailSave().then(() => console.log('sample archive ownership and save regression tests passed')).catch(error => {
  console.error(error); process.exitCode = 1;
});
