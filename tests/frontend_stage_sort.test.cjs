const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const cards = [];
const listeners = {};
const document = {
  querySelector: () => null,
  querySelectorAll: () => cards,
  addEventListener: (type, handler) => { listeners[type] = handler; }
};
const context = vm.createContext({document, console});
vm.runInContext(fs.readFileSync('frontend/js/app.core.js', 'utf8') + '\nglobalThis.app = app;', context);
vm.runInContext(fs.readFileSync('frontend/js/workspace/02-home.js', 'utf8'), context);
const app = context.app;
let project = {id: 'project', stages: [{id: 'a'}, {id: 'b'}, {id: 'c'}]};
let sorting = true;
let saveSucceeds = true;
const saves = [];
app.stageSortMode = () => sorting;
app.currentProject = () => project;
app.dataSnapshot = () => structuredClone(project);
app.restoreDataSnapshot = snapshot => { project = snapshot; };
app.render = () => {};
app.commitStageMutation = async (p, stage, options) => {
  saves.push({order: p.stages.map(s => s.id), id: stage.id, action: options.action});
  return saveSucceeds;
};
app.bindDelegatedEvents();
for (const id of ['a', 'b', 'c']) {
  const classes = new Set();
  const card = {
    dataset: {appAction: 'stage-drag', id, appEvents: 'dragstart dragover dragleave drop dragend'},
    classList: {add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n)},
    getBoundingClientRect: () => ({left: 100, width: 200}),
    contains: node => node === card.child
  };
  card.child = {closest: () => card};
  cards.push(card);
}
const [a, b, c] = cards;
const transfer = {setData(_type, value) { this.value = value; }, getData() { return this.value; }};
function fire(type, card, extra = {}) {
  const event = {target: card.child, currentTarget: document, dataTransfer: transfer, clientX: 250,
    preventDefault() { this.prevented = true; }, ...extra};
  listeners[type](event);
  return event;
}
const order = () => project.stages.map(s => s.id).join(',');
(async () => {
  fire('dragstart', a);
  assert.equal(a.classList.contains('dragging'), true);
  assert.equal(fire('dragover', c).prevented, true);
  assert.equal(c.classList.contains('drag-over'), true);
  fire('dragleave', c, {relatedTarget: c.child});
  assert.equal(c.classList.contains('drag-over'), true, 'moving within the card keeps the drop highlight');
  fire('dragleave', c, {relatedTarget: null});
  assert.equal(c.classList.contains('drag-over'), false);
  fire('drop', c);
  assert.equal(order(), 'b,c,a', 'drop after the target uses the card bounds, not document');
  assert.deepEqual(saves[0], {order: ['b', 'c', 'a'], id: 'a', action: 'reorder_stages'});
  fire('dragend', a);
  assert.equal(a.classList.contains('dragging'), false);
  fire('dragstart', a);
  fire('drop', b, {clientX: 110});
  assert.equal(order(), 'a,b,c', 'drop before target supports reverse movement');
  await Promise.resolve();
  saveSucceeds = false;
  fire('dragstart', a);
  fire('drop', c);
  await Promise.resolve();
  assert.equal(order(), 'a,b,c', 'failed save restores the original order');
  const count = saves.length;
  fire('dragstart', b);
  fire('drop', b);
  assert.equal(saves.length, count, 'dropping onto self does not save');
  sorting = false;
  assert.equal(fire('dragstart', a).prevented, true);
  fire('drop', c);
  assert.equal(saves.length, count, 'disabled sorting cannot reorder stages');
  console.log('stage sorting delegated drag and rollback tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
