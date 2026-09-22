const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const context = vm.createContext({ console, TextDecoder, Uint8Array, DataView, Blob, DecompressionStream });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/utils.js'), 'utf8') + '\nglobalThis.Utils = Utils;', context);
const utils = context.Utils;

function zip(entries) {
  const locals = [], directories = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text || '');
    const method = entry.method ?? 8;
    const compressed = method === 0 ? raw : zlib.deflateRawSync(raw);
    const checksum = entry.checksum ?? utils.xlsxCrc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags || 0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.size ?? raw.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags || 0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.size ?? raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directories.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(directories), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

(async () => {
  assert.equal(utils.xlsxCrc32(Buffer.from('123456789')), 0xcbf43926);
  for (const method of [0, 8]) {
    const files = await utils.unzipXlsxFiles(zip([{ name: 'xl/worksheets/sheet1.xml', text: '<worksheet/>', method }]));
    assert.equal(files['xl/worksheets/sheet1.xml'], '<worksheet/>');
  }
  for (const entries of [
    [{ name: 'xl/a.xml', text: 'text', checksum: 0 }],
    [{ name: 'xl/a.xml', text: 'text', size: 1 }],
    [{ name: 'xl/a.xml', text: 'text', size: 100 }],
    [{ name: 'xl/a.xml', text: 'text', method: 9 }],
    [{ name: 'xl/a.xml', text: 'text', flags: 1 }],
    [{ name: 'xl/a.xml' }, { name: 'xl/A.xml' }],
    [{ name: '../xl/a.xml' }],
    [{ name: 'xl\\a.xml' }],
    [{ name: 'xl/a.xml', text: 'x', size: 65 * 1024 * 1024 }],
  ]) await assert.rejects(utils.unzipXlsxFiles(zip(entries)), /XLSX/);
  const valid = zip([{ name: 'xl/a.xml', text: 'hello' }]);
  for (const length of [0, 1, 5, 21, valid.length - 1]) await assert.rejects(utils.unzipXlsxFiles(valid.subarray(0, length)), /XLSX/);
  const forged = Buffer.from(valid);
  forged.writeUInt32LE(0xfffffff0, forged.length - 6);
  await assert.rejects(utils.unzipXlsxFiles(forged), /XLSX/);

  let seed = 777;
  for (const length of [0, 1, 513, 30000, 200000]) {
    const raw = Buffer.from(Array.from({ length }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; }));
    for (const options of [{ level: 0 }, { level: 9 }, { strategy: zlib.constants.Z_FIXED }]) {
      const compressed = zlib.deflateRawSync(raw, options);
      assert.deepEqual(Buffer.from(utils.inflateRawBytesFallback(compressed, length)), raw);
    }
  }
  const repeated = Buffer.from('测试 XLSX '.repeat(20000));
  const compressed = zlib.deflateRawSync(repeated);
  assert.deepEqual(Buffer.from(utils.inflateRawBytesFallback(compressed)), repeated);
  assert.throws(() => utils.inflateRawBytesFallback(compressed, 1024), /上限/);
  await assert.rejects(utils.inflateRawBytes(compressed, 1024), /上限/);
  context.DecompressionStream = class { constructor() { throw new TypeError('deflate-raw unsupported'); } };
  assert.deepEqual(Buffer.from(await utils.inflateRawBytes(compressed)), repeated, 'older native API falls back safely');
  assert.equal(utils.excelSerialToDate(1), '1900-01-01');
  assert.equal(utils.excelSerialToDate(59), '1900-02-28');
  assert.equal(utils.excelSerialToDate(61), '1900-03-01');
  assert.equal(utils.excelSerialToDate(0, true), '1904-01-01');
  assert.equal(utils.excelSerialToDate(1462), utils.excelSerialToDate(0, true));
  for (const value of [60, NaN, Infinity, -1, 2958466]) assert.throws(() => utils.excelSerialToDate(value), /XLSX/);
  console.log('XLSX ZIP bounds, CRC, native/fallback decompression and date-system checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
