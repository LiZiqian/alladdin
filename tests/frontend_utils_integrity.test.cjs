const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ console, TextDecoder, Uint8Array, DataView });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/utils.js'), 'utf8') + '\nglobalThis.Utils=Utils;', context);
const utils = context.Utils;
const plain = value => JSON.parse(JSON.stringify(value));
const notes = '第一行,含逗号\n第二行含"引号"\r\n第三行';
const csv = [['SN', '备注', '持有人'], ['QA-001', notes, '测试员/001']].map(row => row.map(utils.csvEscape).join(',')).join('\r\n');
const parsed = utils.parseSampleImportCsv('\ufeff' + csv);
assert.equal(parsed.error, null);
assert.equal(parsed.rows.length, 1, 'quoted newlines must remain in a single sample');
assert.equal(parsed.rows[0].notes, notes);
assert.equal(parsed.rows[0].borrower, '测试员/001');
assert.deepEqual(plain(utils.parseCsv('a,b\r1,2\r')), [['a', 'b'], ['1', '2']]);
assert.deepEqual(plain(utils.parseCsv('"a","b"\n\n"c","d"')), [['a', 'b'], [''], ['c', 'd']]);
for (const malformed of ['SN,备注\nA,"未闭合', 'SN,备注\nA,"备注"trailing', 'SN,备注\nA,ab"cd']) {
  assert.match(utils.parseSampleImportCsv(malformed).error, /CSV/);
  assert.throws(() => utils.parseCsv(malformed), /CSV/);
}
assert.equal(utils.parseProjectMembersCsv('姓名/工号,人员类型\n"测试员/001"junk,tester').rows.length, 0);
assert.deepEqual(plain(utils.parseCsv('"逗号,引号" ,普通字段')[0].map(value => value.trim())), ['逗号,引号', '普通字段']);
assert.equal(utils.normalizeEmployeeNoKey('00000009007199254740993'), '9007199254740993');
assert.notEqual(utils.memberIdentityKey('测试员', '9007199254740992'), utils.memberIdentityKey('测试员', '9007199254740993'));
vm.runInContext(`Date = class extends Date {
  constructor() { super('2026-09-19T16:30:00Z'); }
  getFullYear() { return 2026; } getMonth() { return 8; } getDate() { return 20; }
};`, context);
assert.equal(utils.today(), '2026-09-20', 'date fields must use the local calendar day');
console.log('CSV roundtrip, malformed CSV, employee identity and local date checks passed');
