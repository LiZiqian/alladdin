const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const elements = { content: {}, deviceRegion: { value: '' }, deviceDepartment: { value: '' }, deviceGroupError: { textContent: '' } };
  for (const key of ['name', 'code', 'model', 'manufacturer', 'location', 'owner', 'status', 'notes']) elements['deviceField_' + key] = { value: key === 'status' ? '闲置' : '' };
  elements.deviceFormError = { textContent: '' };
  const context = { console, document: { getElementById: id => elements[id] },
    Utils: { id: () => 'new_group', esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;') },
    app: { registerModule(_name, members) { Object.assign(this, members); } } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/devices.js'), 'utf8'), context);
  const app = context.app;
  app.view = { module: 'devices' };
  app.viewModule = () => app.view.module;
  app.replaceHtml = (_, html) => { app.html = html; };
  app.render = () => app.renderDevices();
  app.clearFieldValidationMarks = () => {};
  app.markFieldInvalid = (el, message) => { el.error = message; };
  app.showModal = (title, html, onOk) => { app.modal = { title, html, onOk }; };
  return { app, context, elements };
}

async function main() {
  const { app, context, elements } = fixture();
  let savedPayload;
  context.fetch = async (_url, options) => {
    if (options.method === 'PATCH') savedPayload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true, warehouse: { revision: savedPayload ? 1 : 0, groups: savedPayload ? [savedPayload.group] : [] } }) };
  };
  await app.loadDeviceWarehouse();
  assert.match(app.html, /新增地域－部门/);
  app.editDeviceGroup();
  assert.equal(await app.modal.onOk(), true);
  assert.ok(elements.deviceRegion.error);
  assert.equal(savedPayload, undefined, 'empty fields must not send a write');
  elements.deviceRegion.value = ' 深圳 ';
  elements.deviceDepartment.value = '<实验室>';
  assert.equal(await app.modal.onOk(), false);
  assert.deepEqual(savedPayload, { expectedRevision: 0, group: { id: 'new_group', region: '深圳', department: '<实验室>' } });
  assert.match(app.html, /&lt;实验室>/);
  assert.doesNotMatch(app.html, /<实验室>/);
  app.openDeviceGroup('new_group');
  assert.match(app.html, /返回地域－部门/);
  assert.match(app.html, /新增设备/);
  assert.doesNotMatch(app.html, /暂无设备/);
  app.editDeviceGroup('new_group');
  assert.equal(app.modal.title, '编辑地域－部门');
  context.fetch = async () => ({ ok: false, json: async () => ({ error: '该地域下已存在同名部门' }) });
  assert.equal(await app.modal.onOk(), true, 'a failed save keeps the form open');
  assert.match(elements.deviceGroupError.textContent, /同名部门/);
  assert.equal(app._deviceWarehouse.revision, 1);

  app.editDevice();
  assert.equal(app.modal.title, '新增设备');
  assert.equal(await app.modal.onOk(), true);
  assert.ok(elements.deviceField_name.error, 'name is required');
  elements.deviceField_name.value = '<试验箱>';
  elements.deviceField_code.value = 'EQ-001';
  elements.deviceField_model.value = 'TH-800';
  const group = app.currentDeviceGroup();
  context.fetch = async (_url, options) => {
    savedPayload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true, warehouse: { revision: 2, groups: [{ ...group, devices: [savedPayload.device] }] } }) };
  };
  assert.equal(await app.modal.onOk(), false);
  assert.equal(savedPayload.groupId, group.id);
  assert.equal(savedPayload.expectedRevision, 1);
  assert.equal(savedPayload.device.code, 'EQ-001');
  assert.match(app.html, /&lt;试验箱>/);
  assert.doesNotMatch(app.html, /<试验箱>/);
  assert.match(app.html, /1 台设备/);
  assert.match(app.html, /新增设备/);
  app.openDevice(savedPayload.device.id);
  assert.match(app.modal.title, /设备详情/);
  assert.match(app.modal.html, /EQ-001/);
  app.editDevice(savedPayload.device.id);
  assert.equal(app.modal.title, '编辑设备');
  context.fetch = async () => ({ ok: false, json: async () => ({ error: '设备编号已存在' }) });
  assert.equal(await app.modal.onOk(), true);
  assert.match(elements.deviceFormError.textContent, /编号已存在/);
  assert.equal(app.currentDeviceGroup().devices[0].code, 'EQ-001', 'failed edit keeps the saved card');

  const other = fixture();
  const reads = [];
  other.context.fetch = () => new Promise(resolve => reads.push(resolve));
  const first = other.app.loadDeviceWarehouse();
  const second = other.app.loadDeviceWarehouse();
  reads[1]({ ok: true, json: async () => ({ ok: true, warehouse: { revision: 2, groups: [] } }) });
  await second;
  reads[0]({ ok: true, json: async () => ({ ok: true, warehouse: { revision: 1, groups: [] } }) });
  await first;
  assert.equal(other.app._deviceWarehouse.revision, 2, 'a late list response cannot undo a newer read');
  console.log('frontend device warehouse tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
