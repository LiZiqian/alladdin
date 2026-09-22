const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const input = field => ({value:'',classList:{remove(name){this.removed=name;}}});
const fields = {category:input(),item:input(),sampleSize:input()};
let upload, changeHandler, matrix, writes=0, savedProject, shouldSave=true;
const alerts=[];
const row = {id:'strategy-1',category:'旧类别',item:'旧用例',sampleSize:7,skuMap:{1:true}};
const stage = {strategy:[row],skuNames:['A'],progress:[]};
const project = {id:'project-1',testCaseMaster:[],stages:[stage]};
const app = {
  registerModule(_name,members){Object.assign(this,members);},
  currentStage:()=>stage,
  currentProject:()=>project,
  scheduleStageStrategySave(){writes++;},
  createProgressRecord:value=>({...value}),
  dataSnapshot:()=>JSON.parse(JSON.stringify(project)),
  restoreDataSnapshot:snapshot=>Object.assign(project,snapshot),
  commitProjectMutation:async value=>{writes++;savedProject=JSON.parse(JSON.stringify(value));return shouldSave;},
  render(){},
};
const tr={dataset:{strategyRow:'0'},querySelector:selector=>fields[selector.match(/data-field="(.*?)"/)[1]]};
const context={console,app,setTimeout,clearTimeout,alert:msg=>alerts.push(msg),document:{
  getElementById:()=>null,
  querySelector:()=>tr,
  querySelectorAll:selector=>selector==='tr[data-strategy-row]'?[tr]:[],
  createElement(){upload={files:[{arrayBuffer:async()=>new ArrayBuffer(0)}],addEventListener(_type,fn){changeHandler=fn;},click(){}};return upload;},
}};
vm.createContext(context);
for(const file of ['utils.js','workspace/03-strategy.js','workspace/10-dropdown-issue.js']){
  vm.runInContext(fs.readFileSync(path.join(root,'frontend/js',file),'utf8')+(file==='utils.js'?'\nglobalThis.Utils=Utils;':''),context);
}
context.Utils.toast=()=>{};
app.scheduleStageStrategySave=()=>{writes++;};
const header=['测试大类','测试名称','基线数量'];
const plain=value=>JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(app.parseTestCaseImportRows([header,['可靠性','跌落',4],['性能','启动',''],['性能','待机']])) ,[
  {category:'可靠性',item:'跌落',baselineCount:4},
  {category:'性能',item:'启动',baselineCount:null},
  {category:'性能',item:'待机',baselineCount:null},
]);
assert.equal(app.parseTestCaseImportRows([header,['类别','用例',' １２ ']])[0].baselineCount,12);
for(const invalid of [0,-1,1.5,'abc','1.5','1e3','Infinity','9007199254740992']){
  assert.throws(()=>app.parseTestCaseImportRows([header,['类别','用例',invalid]]),/第 2 行.*基线数量/);
}
assert.throws(()=>app.parseTestCaseImportRows([header.slice(0,2),['类别','用例',4]]),/新版三列模板/);
assert.throws(()=>app.parseTestCaseImportRows([header,['如：跌落','六面四角',4]]),/没有可导入/);
assert.throws(()=>app.parseTestCaseImportRows([header,['类别','',3]]),/不能为空/);

fields.sampleSize.value='7';
app.selectCaseSuggestion(0,'item','可靠性','跌落',4);
assert.equal(row.sampleSize,4);
assert.equal(fields.sampleSize.value,'4');
assert.equal(fields.sampleSize.classList.removed,'invalid');
assert.equal(stage.progress[0].sampleSize,4,'subsequent task configuration uses the selected baseline');
assert.equal(stage.progress[0].testItem,'跌落');
fields.sampleSize.value='9';row.sampleSize=9;
app.selectCaseSuggestion(0,'item','性能','启动',null);
assert.equal(Number(row.sampleSize),9,'blank baseline preserves manually entered sample count');
assert.equal(fields.sampleSize.value,'9');
assert.equal(stage.progress[0].sampleSize,9);
fields.sampleSize.value='';row.sampleSize=null;
app.selectCaseSuggestion(0,'item','性能','待机',null);
assert.equal(fields.sampleSize.value,'','blank baseline never inserts a fallback of one');
assert.equal(stage.progress.length,0,'an empty quantity does not generate a valid task plan');
fields.sampleSize.value='6';row.sampleSize=6;
app.selectCaseSuggestion(0,'category','可靠性','',4);
assert.equal(row.sampleSize,6,'choosing only a category must not populate a baseline');

async function importMatrix(value){
  matrix=value;
  context.Utils.unzipXlsxFiles=async()=>({'xl/worksheets/sheet1.xml':'sheet'});
  context.Utils.parseXlsxSharedStrings=()=>[];
  context.Utils.parseXlsxSheet=()=>matrix;
  await app.importTestCaseXlsx();
  await changeHandler();
}
(async()=>{
  await importMatrix([header,['可靠性','跌落',4],['性能','待机','']]);
  assert.equal(savedProject.testCaseMaster[0].baselineCount,4);
  assert.equal(savedProject.testCaseMaster[1].baselineCount,null);
  const before=plain(project.testCaseMaster),previousWrites=writes;
  await importMatrix([header,['可靠性','有效行',5],['性能','无效行',0]]);
  assert.deepEqual(plain(project.testCaseMaster),before,'bad rows must not partially replace the case library');
  assert.equal(writes,previousWrites);
  assert.match(alerts.at(-1),/第 3 行.*基线数量/);
  shouldSave=false;
  await importMatrix([header,['可靠性','新用例',12]]);
  assert.deepEqual(plain(project.testCaseMaster),before,'failed persistence restores imported baseline values');
  console.log('case baseline import, optional values, selection, progress and rollback tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
