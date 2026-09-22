const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => JSON.parse(JSON.stringify(value));
let formRows = [];
const context = {
  console, setTimeout, clearTimeout,
  document: {
    getElementById: () => ({ querySelectorAll: () => formRows }),
    createElement: () => ({ dataset: {}, children: [], append(...items) { this.children.push(...items); } }),
  },
  app: { registerModule(_name, members) { Object.assign(this, members); } },
};
vm.createContext(context);
for (const file of ['utils', 'app.data', 'samples/05-problems', 'samples/05-problem-photos', 'workspace/09-task-result']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js', `${file}.js`), 'utf8')
    + (file === 'utils' ? '\nglobalThis.Utils = Utils;' : ''), context);
}
const { app } = context;
app.version = 'test';
app.constants = { sampleStatuses: ['闲置', '在位等待', '测试中', '已退库', '取走分析'] };
const state = sample => ({ projects: [], sampleLibrary: { categories: [{ id: 'pool', samples: [{ id: 'sample', status: '闲置', ...sample }] }], logs: [] } });
const record = { id: 'stable-problem', description: 'BOOK 页面异常', source: '测试任务', taskLabel: '原任务',
  taskId: 'task_OK', recordedAt: '2026-09-20', provenance: { importedFrom: 'foreign' } };

function decoded(text) { return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function rowFromHtml(html, prefix = 'sample-problem') {
  const dataset = {};
  for (const [, key, value] of html.matchAll(/data-(problem-id|problem-record)="([^"]*)"/g)) {
    dataset[key === 'problem-id' ? 'problemId' : 'problemRecord'] = decoded(value);
  }
  const fields = {};
  for (const field of ['desc', 'source', 'task']) {
    const match = html.match(new RegExp(`class="${prefix}-${field}" value="([^"]*)"`));
    fields[`.${prefix}-${field}`] = { value: decoded(match?.[1] || '') };
  }
  return { dataset, querySelector: selector => fields[selector], querySelectorAll: () => Object.values(fields) };
}

const cases = [
  ['current enums reject aliases and preserve ordinary text', () => {
    assert.throws(() => app.normalizeTaskFlowStatus('Testing'));
    assert.throws(() => app.normalizeSampleStatusValue('借出'));
    assert.throws(() => app.normalizeTaskResultValue('Pass'));
    app.data = state({ notes: '检查 OK；Pass / Fail / 待执行', problemRecords: [] });
    app.normalize();
    assert.equal(app.data.sampleLibrary.categories[0].samples[0].notes, '检查 OK；Pass / Fail / 待执行');
  }],
  ['nested photo URL and path fields remain byte-for-byte intact', () => {
    const photo = { id: 'photo_OK', url: '/api/sample_OK/待执行.jpg', thumbUrl: '/api/sample_OK/已借出.jpg',
      thumbnailUrl: '/api/photo_OK/故障.jpg', thumbRelativePath: 'samples/sample_OK/失败.jpg',
      preview_path: 'samples/待启动/OK.jpg', fallbackUrls: ['https://example/故障'] };
    app.data = state({ notes: 'BOOK 文档与 TOKEN 字段' });
    app.data.eventSchema = 'sample_events_v2';
    app.data.sampleLibrary.logs = [{ id: 'event', sampleId: 'sample', resultPhotos: [photo] }];
    const before = clone(photo);
    app.normalize();
    assert.deepEqual(clone(app.data.sampleLibrary.logs[0].resultPhotos[0]), before);
    assert.equal(app.data.sampleLibrary.categories[0].samples[0].notes, 'BOOK 文档与 TOKEN 字段');
  }],
  ['problem normalization preserves metadata and tolerates invalid old entries', () => {
    app.data = state({ problemRecords: [clone(record), null, 42, '接口异常'] });
    app.normalize();
    const sample = app.data.sampleLibrary.categories[0].samples[0];
    assert.deepEqual(clone(sample.problemRecords[0]), record);
    const first = clone(sample.problemRecords);
    assert.equal(first.length, 1);
    app.sampleProblemRecords(sample);
    assert.deepEqual(clone(sample.problemRecords), first);
  }],
  ['sample problem form preserves IDs and metadata across unchanged and edited saves', () => {
    const html = app.sampleProblemRowHtml('problems', record);
    assert.ok(!html.includes('data-problem-record="{"'), 'metadata must be HTML escaped');
    const row = rowFromHtml(html);
    formRows = [row];
    assert.deepEqual(clone(app.collectSampleProblems('problems')), [record]);
    row.querySelector('.sample-problem-desc').value = '修改后的说明';
    const edited = app.collectSampleProblems('problems')[0];
    assert.equal(edited.id, record.id);
    assert.equal(edited.taskId, record.taskId);
    assert.equal(edited.recordedAt, record.recordedAt);
    const node = app.sampleProblemRowNode('problems', record);
    assert.deepEqual(JSON.parse(node.dataset.problemRecord), record);
  }],
  ['deleting final problem row discards old identity before adding replacement', () => {
    const row = rowFromHtml(app.sampleProblemRowHtml('problems', record));
    const wrap = { querySelectorAll: () => [row] };
    app.removeSampleProblemRow({ closest: selector => selector === '.sample-initial-result-row' ? row : wrap });
    row.querySelector('.sample-problem-desc').value = '新问题';
    formRows = [row];
    const collected = app.collectSampleProblems('problems')[0];
    assert.notEqual(collected.id, record.id);
    assert.equal(collected.taskId, undefined);
    assert.equal(app.collectSampleProblems('problems')[0].id, collected.id);
  }],
  ['task result history form and synchronization retain original provenance', () => {
    const row = rowFromHtml(app.taskResultProblemRowHtml(record), 'task-result-existing-problem');
    const sampleRow = { dataset: { sid: 'sample' }, querySelector: () => null, querySelectorAll: () => [row] };
    context.document.querySelectorAll = () => [sampleRow];
    context.document.getElementById = () => null;
    app.taskResultMemberField = () => null;
    app.taskResultRowPhotos = () => [];
    app.normalizeTaskResultFinishPayload = payload => payload;
    const collected = app.collectTaskResultForm().samples[0].problemRecords;
    assert.deepEqual(clone(collected), [record]);
    app.sampleTaskLabelFromCtx = () => 'task';
    const sample = {};
    const synced = app.syncTaskResultSampleProblems(sample, { problemRecords: collected }, {});
    assert.deepEqual(clone(synced), [record]);
    assert.deepEqual(clone(sample.problemRecords), [record]);
  }],
];
let failures = 0;
for (const [name, test] of cases) {
  try { test(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}
if (failures) process.exitCode = 1;
else console.log(`${cases.length} normalization integrity cases passed`);
