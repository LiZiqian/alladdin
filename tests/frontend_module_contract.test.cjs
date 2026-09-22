// Exercise the production script list, not a hand-maintained imitation of it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { scriptPaths } = require('./frontend_source.cjs');
const root = path.resolve(__dirname, '..');
const scripts = scriptPaths();
assert.equal(new Set(scripts).size, scripts.length, 'a script must load exactly once');
const warnings = [];
const context = vm.createContext({ console: { ...console, warn: message => warnings.push(message) },
  document: { querySelector: () => null }, URLSearchParams, setTimeout, clearTimeout });
for (const script of scripts) {
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend', script), 'utf8'), context, { filename: script });
}
const app = vm.runInContext('app', context);
for (const name of ['save', 'scheduleSave', 'reloadFromServer', 'fullStateUrl', 'normalizeStatusText', 'normalizeBusinessStatusValue']) {
  assert.equal(typeof app[name], 'undefined', `retired member must not be registered: ${name}`);
}
assert.deepEqual(warnings, [], 'module registration must not override another module');
const registered = new Set(scripts);
function checkTree(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) checkTree(full);
    else if (entry.name.endsWith('.js')) assert.ok(registered.has(path.relative(path.join(root, 'frontend'), full).replaceAll('\\', '/')), `unloaded script: ${full}`);
  }
}
checkTree(path.join(root, 'frontend/js'));

async function main() {
  let request;
  context.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ ok: true, items: [], revision: 9 }) };
  };
  await app.fetchStageTasksPage('a /中', { page: 0, flag: false, empty: '', nil: null, absent: undefined, text: 'a&b' });
  assert.equal(request.url, '/api/stages/a%20%2F%E4%B8%AD/tasks?page=0&flag=false&text=a%26b');
  assert.equal(request.options.cache, 'no-store');
  await app.fetchTaskSampleCandidates({ planStartDate: '', planEndDate: '', ids: ['a', 'b'], empty: '', none: [] });
  assert.equal(request.url, '/api/task-sample-candidates?planStartDate=&planEndDate=&ids=a%2Cb');
  await app.checkSampleIdentityConflicts({ id: 's' }, { categoryId: 'c' });
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { categoryId: 'c', samples: [{ id: 's' }] });

  for (const [response, expected] of [
    [{ ok: false, status: 409, json: async () => ({ ok: false, error: '业务冲突' }) }, /业务冲突/],
    [{ ok: true, status: 200, json: async () => ({ ok: false, error: '业务拒绝' }) }, /业务拒绝/],
    [{ ok: false, status: 500, json: async () => ({}) }, /HTTP 500/],
    [{ ok: true, status: 200, json: async () => { throw Error('bad json'); } }, /服务器返回不是 JSON/],
  ]) {
    context.fetch = async () => response;
    await assert.rejects(app.fetchBootstrapState(), expected);
  }
  let calls = 0;
  context.fetch = async () => { calls++; throw Error('offline'); };
  await assert.rejects(app.checkSampleIdentityConflicts([]), /offline/);
  assert.equal(calls, 1, 'transport must not replay a request on failure');

  const steps = [];
  const payload = { sampleId: 's' }, affected = { samples: [] };
  app.serverRevision = 10;
  app.applyMutationAffected = value => { assert.equal(value, affected); steps.push('apply'); };
  app.syncMutationPayloadBaseline = (value, result) => {
    assert.equal(value, payload); assert.equal(result, affected); steps.push('baseline');
  };
  app.acceptMutationResult(payload, { revision: 9, updated_at: 'fixed', affected });
  assert.equal(app.serverRevision, 10, 'late acknowledgement cannot lower revision');
  assert.equal(app.serverUpdatedAt, 'fixed');
  assert.equal(app.serverOnline, true);
  assert.deepEqual(steps, ['apply', 'baseline']);
  console.log('Production module loading, query/error contracts and mutation acknowledgement passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
