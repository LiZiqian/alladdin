const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const summary = { id: 'p', name: 'Project', _summaryOnly: true, members: [], locations: [], testCaseMaster: [] };
const complete = { id: 'p', name: 'Project', _detailLoaded: true, members: [{ name: 'Existing', employeeNo: '1' }], locations: ['Lab'], testCaseMaster: [{ item: 'Existing case' }] };
let current = summary, hydration = 0, onOk, saved;
const fields = { pName: { value: 'Updated' }, pCode: { value: 'CODE' }, pOwner: { value: '' } };
const app = {
  registerModule(_, members) { Object.assign(this, members); },
  findProjectRecord: () => current,
  viewModule: () => 'projects',
  ensureProjectLoaded: async () => { hydration++; current = complete; return complete; },
  showModal: (_title, _html, callback) => { onOk = callback; },
  clearFieldValidationMarks() {},
  dataSnapshot: () => ({}),
  projectStateNameExists: () => false,
  commitProjectMutation: async value => { saved = value; return true; },
};
const context = vm.createContext({ app, console, document: { getElementById: id => fields[id] } });
for (const file of ['utils.js', 'projects.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js', file), 'utf8') + (file === 'utils.js' ? '\nglobalThis.Utils=Utils;' : ''), context);
context.Utils.toast = () => {};
(async () => {
  await app.editProject('p');
  assert.equal(hydration, 1, 'summary must be hydrated before editing');
  assert.equal(await onOk(), false);
  assert.equal(saved.name, 'Updated');
  assert.equal(saved.members.length, 1);
  assert.equal(saved.locations[0], 'Lab');
  assert.equal(saved.testCaseMaster[0].item, 'Existing case');
  current = summary; app.ensureProjectLoaded = async () => null; onOk = null;
  await app.editProject('p');
  assert.equal(onOk, null, 'failed load must not offer a destructive summary save');
  console.log('Project card edit hydration and preservation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
