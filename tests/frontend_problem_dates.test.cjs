const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { console, document: {}, app: { registerModule(_, methods) { Object.assign(this, methods); } } };
vm.createContext(context);
for (const file of ['utils', 'app.data', 'samples/05-problems', 'samples/05-problem-photos', 'workspace/09-task-result']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js', file + '.js'), 'utf8')
    + (file === 'utils' ? '\nglobalThis.Utils=Utils;' : ''), context);
}
const app = context.app;
const first = '2026-09-20T10:30:00.000Z';
const later = '2026-09-21T10:30:00.000Z';
context.Utils.now = () => first;
assert.deepEqual(Array.from(app.problemTableColumns(), x => x.label), ['来源', '时间', '问题描述', '关联测试任务', '图片', '操作']);
assert.equal(app.problemCreatedDate({ createdAt: '2026-09-20' }), '2026-09-20');
assert.equal(app.problemCreatedDate({}), '—');
assert.equal(app.problemCreatedDate({ createdAt: 'invalid' }), '—');
const initial = app.sampleProblemsHtml('rows');
assert.ok(initial.includes('2026-09-20'), 'initial inspection row receives its date immediately');
const sample = { id: 's', problemRecords: [] };
app.findSample = () => ({ sample });
app.sampleTaskLabelFromCtx = () => '项目 - V3 - A - 测试';
app.addSampleProblem(sample, '初检问题', { problemSource: '初检' });
assert.equal(sample.problemRecords[0].createdAt, first);
const task = { id: 't' };
app.saveTaskResultDraft({ id: 'p' }, { id: 'stage' }, task, { samples: [{ sid: 's', problem: '新问题', problemRecords: [], photos: [] }] });
const draft = task.resultDraft.samples[0];
assert.equal(draft.problemRecords[0].createdAt, first, 'task problem is dated at draft creation');
context.Utils.now = () => later;
app.syncTaskResultSampleProblems(sample, draft, { taskId: 't' });
assert.equal(sample.problemRecords[0].createdAt, first, 'promotion must not reset creation time');
app.syncTaskResultSampleProblems(sample, { ...draft, problem: '新问题', photos: [] }, { taskId: 't' });
assert.equal(sample.problemRecords.length, 1);
assert.equal(sample.problemRecords[0].createdAt, first, 'duplicate evidence must keep the original date');
const record = sample.problemRecords[0];
for (const html of [app.sampleProblemRowHtml('rows', record), app.taskResultProblemRowHtml(record)]) {
  const cells = [...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(m => m[1]);
  assert.equal(cells.length, 6);
  assert.match(cells[1], /<span class="problem-created-date"/);
  assert.ok(!cells[1].includes('<input'), 'creation date is not an editable field');
}
const row = { dataset: { problemId: record.id, problemRecord: JSON.stringify(record) },
  querySelector: selector => ({ value: selector.endsWith('-desc') ? '编辑后的描述' : '测试任务' }) };
const edited = app.sampleProblemRecordFromRow(row);
assert.equal(edited.createdAt, first);
assert.equal(app.mergeProblemPhotoRecords([record], [{ ...edited, createdAt: later }], [record])[0].createdAt, first);
const legacy = { id: 'old', description: '旧问题', source: '初检' };
assert.equal(app.normalizeSampleProblemRecord(legacy).createdAt, undefined);
let added;
context.document.getElementById = () => ({ append(node) { added = node; } });
app.sampleProblemRowNode = (_, value) => ({ value, querySelector: () => null });
app.addSampleProblemRow('rows');
assert.equal(added.value.createdAt, later, 'manual row gets its own addition time');
console.log('PASS problem dates: shared columns, automatic creation, immutable edits, draft promotion and legacy dates');
