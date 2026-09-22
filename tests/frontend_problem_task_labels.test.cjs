const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { console, app: { registerModule(_, methods) { Object.assign(this, methods); } } };
vm.createContext(context);
for (const file of ['utils', 'app.data', 'samples/05-problems', 'samples/05-problem-photos', 'workspace/08-task-actions', 'workspace/09-task-result']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js', file + '.js'), 'utf8')
    + (file === 'utils' ? '\nglobalThis.Utils=Utils;' : ''), context);
}
const app = context.app;
const taskA = { id: 'a', testItem: '弯折 - 随机批次', skuIndex: 1 };
const taskB = { id: 'b', testItem: taskA.testItem, skuIndex: 2 };
const stage = { id: 'stage', name: 'V3', skuNames: ['A', 'B'], tasks: [taskA, taskB] };
const project = { id: 'project', name: '项目', stages: [stage] };
app.data = { projects: [project] };
const ids = { projectId: project.id, stageId: stage.id, taskId: taskB.id };
const full = '项目 - V3 - B - 弯折 - 随机批次';
assert.equal(app.sampleTaskLabelFromCtx(ids), full);
assert.equal(app.sampleTaskLabelFromCtx({ project, stage, task: taskA }), '项目 - V3 - A - 弯折 - 随机批次');
const legacy = { id: 'problem', description: '黑斑', source: '测试任务', taskLabel: '历史项目 - V3 - 弯折 - 随机批次', ...ids, photoIds: ['photo'] };
assert.equal(app.sampleProblemTaskLabel(legacy), legacy.taskLabel, 'does not convert old labels');
assert.equal(app.sampleProblemTaskLabel({ ...legacy, taskId: undefined }), legacy.taskLabel, 'does not infer missing label segments');
assert.equal(app.sampleProblemTaskLabel({ source: '初检', taskLabel: '' }), '');
assert.ok(app.taskResultProblemRowHtml(legacy).includes(legacy.taskLabel));
assert.ok(app.sampleProblemRowHtml('rows', legacy).includes(legacy.taskLabel));

const fields = { desc: legacy.description, source: legacy.source, task: app.sampleProblemTaskLabel(legacy) };
const row = { dataset: { problemId: legacy.id, problemRecord: JSON.stringify(legacy) },
  querySelector: selector => ({ value: fields[selector.split('-').at(-1)] }) };
assert.equal(app.sampleProblemRecordFromRow(row).taskLabel, legacy.taskLabel, 'display enrichment must not overwrite historical provenance');
fields.task = '手工项目 - V4 - C - 新任务';
const edited = app.sampleProblemRecordFromRow(row);
const merged = app.mergeProblemPhotoRecords([legacy], [edited], [legacy])[0];
assert.equal(edited.taskLabel, legacy.taskLabel, 'read-only display must never replace saved task provenance');
assert.equal(merged.taskLabel, legacy.taskLabel);
const staleEdit = { ...legacy, taskLabel: fields.task, taskLabelFormat: 'project-stage-scheme-task' };
assert.equal(app.mergeProblemPhotoRecords([legacy], [staleEdit], [legacy])[0].taskLabel, legacy.taskLabel,
  'a draft created before the read-only change cannot overwrite the task association');
assert.match(app.sampleProblemRowHtml('rows', legacy), /class="sample-problem-task"[^>]* readonly/);
assert.match(app.taskResultProblemRowHtml(legacy), /class="task-result-existing-problem-task"[^>]* readonly/);
assert.match(app.sampleProblemRowHtml('rows', { source: '初检', taskLabel: '' }), /class="sample-problem-task" value="\/"/);
assert.match(app.taskResultProblemRowHtml({ source: '初检', taskLabel: '' }), /class="task-result-existing-problem-task" value="\/"/);

const sample = { id: 'sample', problemRecords: [] };
app.findSample = () => ({ sample });
app.saveTaskResultDraft(project, stage, taskB, { samples: [{ sid: sample.id, problem: '新问题', problemRecords: [], photos: [] }] });
const saved = taskB.resultDraft.samples[0].problemRecords[0];
assert.equal(saved.taskLabel, full);
assert.equal(saved.taskLabelFormat, 'project-stage-scheme-task');
assert.equal(saved.taskId, taskB.id);
app.data.projects = [];
assert.equal(app.sampleProblemTaskLabel(saved), full, 'saved labels work in a pool without project tasks loaded');
assert.equal(saved.taskId, taskB.id, 'task deletion does not remove the saved task identity');
app.data.projects = [project];
app.taskResultSampleEntries = () => [{ sampleId: sample.id }];
sample.problemRecords = [{ ...legacy, taskLabel: '项目 - V3 - 弯折 - 随机批次' }];
assert.equal(app.taskFailureProblemsBySample(project, stage, taskA).size, 0, 'stable references keep same-name tasks separate');
assert.ok(app.taskFailureProblemsBySample(project, stage, taskB).get(sample.id).has('黑斑'));
delete sample.problemRecords[0].taskId;
assert.ok(!app.taskFailureProblemsBySample(project, stage, taskB).get(sample.id)?.has('黑斑'), 'labels alone cannot attribute a problem to a task');
console.log('PASS four-part task labels, historical provenance, save/reopen, pool display and task failure attribution');
