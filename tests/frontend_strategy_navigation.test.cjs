const { readFrontendScript } = require('./frontend_source.cjs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
async function scenario(pageFirst, destination = 'projectWorkspace') {
  const context = {console, setTimeout, clearTimeout, URLSearchParams, alert(message) { throw Error(message); }, app:{registerModule(_name, methods){Object.assign(this, methods);}}};
  vm.createContext(context);
  for(const file of ['utils','app.data','app.server','workspace/03-strategy','workspace/05-task-table','app.render']) {
    vm.runInContext(readFrontendScript(`frontend/js/${file}.js`) + (file==='utils'?'\nglobalThis.Utils = Utils;':''),context);
  }
  const {app} = context;
  const stage = {id:'st', skuNames:['A'], tasks:[], strategy:[], progress:[]};
  const project = {id:'p',stages:[stage]};
  app.data = {projects:[project]};
  app.view = {module:'projectWorkspace',selectedProjectId:'p',selectedStageId:'st',stageStrategyId:'st'};
  app.currentProject = () => project;
  app.currentStage = () => stage;
  app.autoSyncProgress = () => {};
  app.updateServerStatus = () => {};
  app.beginServerMutation = async () => () => {};
  app.applyMutationAffected = () => {};
  app.syncMutationPayloadBaseline = () => {};
  app.handleMutationRevisionConflict = async () => false;
  app.invalidateSampleHistoryCache = () => {};
  app.hydrateTaskFlowReferenceSamples = () => {};
  app.syncHydratedStageBaseline = () => {};
  app.syncHydratedTaskBaseline = () => {};
  app.findProjectRecord = () => project;
  const save = deferred(), pages=[];
  context.fetch = () => save.promise;
  app.fetchStageTasksPage = () => { const request=deferred(); pages.push(request); return request.promise; };
  let visible = '';
  app.render = () => {
    if(app.viewModule() !== 'projectWorkspace' || app.stageStrategyId()) return;
    const params=app.taskFlowQueryParams(stage), key=app.taskFlowCacheKey(stage,params);
    if (!app._taskFlowPageCache) { visible='loading'; app.loadTaskFlowPage(project,stage,key,params); }
    else visible=app._taskFlowPageCache.rows.map(row=>row.task.id).join(',');
  };
  app.refreshTaskFlowRegion = () => { app.render(); return true; };
  app.renderPreserveScroll = app.render;
  app.go(destination); // Real breadcrumb path flushes the strategy save without waiting.
  await flush();
  if (destination==='projectWorkspace') assert.equal(pages.length,1);
  if(pageFirst) { pages[0].resolve({rows:[{task:{id:'existing-task'}}]}); await flush(); }
  save.resolve({ok:true,json:async()=>({ok:true,revision:2,affected:{}})});
  await flush();
  if(destination!=='projectWorkspace') { assert.equal(pages.length,0,'do not reload tasks after navigating elsewhere'); return; }
  assert.equal(pages.length,2,'late strategy save must replace the task request it invalidates');
  pages[1].resolve({rows:[{task:{id:'existing-task'}}]}); await flush();
  if(!pageFirst) { pages[0].resolve({rows:[{task:{id:'stale-task'}}]}); await flush(); }
  assert.equal(visible,'existing-task','tasks appear without a browser reload and stale response cannot replace them');
  assert.equal(app._taskFlowActiveRequest,null);
}
(async()=>{
  await scenario(false);
  await scenario(true);
  await scenario(false,'home');
  console.log('strategy breadcrumb pagination race tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
