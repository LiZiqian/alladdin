const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ console, TextDecoder, Uint8Array, DataView });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/utils.js'), 'utf8') + '\nglobalThis.Utils=Utils;', context);
const utils = context.Utils;

for (const headers of [['SN', 'SN'], ['SN', '序列号'], ['持有人', '领用人'], ['备注', '说明']]) {
  const matrix = [['IMEI', ...headers], ['IMEI-1', 'first-value', 'second-value']];
  const parsed = utils.parseSampleImportMatrix(matrix);
  assert.ok(parsed.error && /重复/.test(parsed.error), `ambiguous ${headers.join('/')} columns must not silently overwrite data`);
  assert.equal(parsed.rows.length, 0);
}
const distinct = utils.parseSampleImportCsv('SN,主板SN,IMEI,备注\nPHONE,BOARD,IMEI,note');
assert.equal(distinct.error, null);
assert.equal(distinct.rows[0].sn, 'PHONE');
assert.equal(distinct.rows[0].boardSn, 'BOARD');

(async () => {
  let input, readDone, finishCheck, calls = 0;
  let category = { id: 'pool', description: 'old', samples: [] };
  const app = {
    registerModule(_name, members) { Object.assign(this, members); },
    sampleCategoryRecords: () => [category],
    sampleIsReassembled: () => false,
    normalizeSampleStatusValue: () => '闲置',
    constants: { sampleStatuses: ['闲置'] },
    checkSampleIdentityConflicts: () => new Promise(resolve => { finishCheck = resolve; }),
    newSample: (_cat, _number, sn) => ({ sn }),
    commitSampleCategoryMutation: async () => { calls += 1; return true; },
  };
  const testContext = vm.createContext({ app, console, alert() {}, Utils: { ...utils, toast() {} },
    document: { createElement() {
      input = { addEventListener(name, handler) { this[name] = handler; }, click() {} }; return input;
    } },
    FileReader: class {
      addEventListener(name, handler) { this[name] = handler; }
      readAsText() { this.result = 'SN\nSAMPLE'; readDone = this.load(); }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/samples/02-import-export.js'), 'utf8'), testContext);
  await app.importSampleBatch('pool');
  input.change({ target: { files: [{ name: 'samples.csv' }] } });
  category = { id: 'pool', description: 'fresh-server-state', samples: [] };
  app._dataSnapshotEpoch = 1;
  finishCheck({ results: [] });
  await readDone;
  assert.equal(calls, 0, 'a late duplicate-check response cannot submit a category from an obsolete data snapshot');
  console.log('Transfer followup parser and async import checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
