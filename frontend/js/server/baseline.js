/* 维护服务器基线与局部水合。只确认本次读取/写入涉及的字段，不能把其他未保存编辑标成已同步。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.baseline", {

  ensureHydrationBaseline() {
    if (!this._baseData) this._baseData = this.cloneData(this.emptyData());
    if (!this._baseData.sampleLibrary) this._baseData.sampleLibrary = { categories: [], logs: [] };
    if (!Array.isArray(this._baseData.sampleLibrary.categories)) this._baseData.sampleLibrary.categories = [];
    if (!Array.isArray(this._baseData.sampleLibrary.logs)) this._baseData.sampleLibrary.logs = [];
    if (!Array.isArray(this._baseData.projects)) this._baseData.projects = [];
    return this._baseData;
  },

  baselineSampleCategory(categoryId, seed = {}) {
    const id = String(categoryId || seed?.id || "");
    if (!id) return null;
    const base = this.ensureHydrationBaseline();
    const categories = base.sampleLibrary.categories;
    let category = categories.find(item => String(item?.id || "") === id);
    if (!category) {
      category = { ...this.cloneData(seed || {}), id, samples: [] };
      if (!Array.isArray(category.samples)) category.samples = [];
      categories.push(category);
    } else if (!Array.isArray(category.samples)) {
      category.samples = [];
    }
    return category;
  },

  syncHydratedCategoryBaseline(category = {}, { includeSamples = false } = {}) {
    const id = String(category?.id || "");
    if (!id) return null;
    const baseline = this.baselineSampleCategory(id, category);
    if (!baseline) return null;
    const existingSamples = Array.isArray(baseline.samples) ? baseline.samples : [];
    const clone = this.cloneData(category);
    if (!includeSamples) clone.samples = existingSamples;
    else if (!Array.isArray(clone.samples)) clone.samples = existingSamples;
    Object.assign(baseline, clone);
    baseline.samples = clone.samples;
    return baseline;
  },

  syncHydratedSampleBaseline(categoryId, sample = {}) {
    const sampleId = String(sample?.id || "");
    if (!sampleId) return null;
    const baseline = this.baselineSampleCategory(categoryId || sample?.categoryId, {
      id: categoryId || sample?.categoryId || "",
      name: sample?.categoryName || "",
    });
    if (!baseline) return null;
    const samples = baseline.samples;
    const clone = this.cloneData(sample);
    const index = samples.findIndex(item => String(item?.id || "") === sampleId);
    if (index >= 0) samples[index] = { ...samples[index], ...clone };
    else samples.push(clone);
    return samples.find(item => String(item?.id || "") === sampleId) || null;
  },

  syncHydratedSamplePatchBaseline(sampleId, patch = {}) {
    const found = this.findSample?.(sampleId);
    const categoryId = found?.category?.id || patch?.categoryId || "";
    return this.syncHydratedSampleBaseline(categoryId, { id: sampleId, ...patch });
  },

  syncHydratedSampleLogsBaseline(logs = []) {
    const list = Array.isArray(logs) ? logs : [logs];
    if (!list.length) return;
    const base = this.ensureHydrationBaseline();
    const target = base.sampleLibrary.logs;
    const byId = new Map(target.filter(log => log?.id).map(log => [String(log.id), log]));
    list.forEach(log => {
      if (!log || typeof log !== "object") return;
      const clone = this.cloneData(log);
      const id = String(clone.id || "");
      if (id && byId.has(id)) Object.assign(byId.get(id), clone);
      else {
        target.push(clone);
        if (id) byId.set(id, clone);
      }
    });
  },

  baselineProject(projectId, seed = {}) {
    const id = String(projectId || seed?.id || "");
    if (!id) return null;
    const base = this.ensureHydrationBaseline();
    let project = base.projects.find(item => String(item?.id || "") === id);
    if (!project) {
      project = { ...this.cloneData(seed || {}), id, stages: [] };
      if (!Array.isArray(project.stages)) project.stages = [];
      base.projects.push(project);
    } else if (!Array.isArray(project.stages)) {
      project.stages = [];
    }
    return project;
  },

  syncHydratedProjectBaseline(project = {}, { includeTasks = false } = {}) {
    if (!project?.id) return null;
    const baseline = this.baselineProject(project.id);
    const previousStages = new Map((baseline.stages || []).map(stage => [String(stage.id), stage]));
    const clone = this.cloneData(project);
    clone.stages = (clone.stages || []).map(stage => ({
      ...stage,
      tasks: includeTasks ? (stage.tasks || []) : (previousStages.get(String(stage.id))?.tasks || []),
    }));
    Object.assign(baseline, clone);
    return baseline;
  },

  syncHydratedStageBaseline(projectId, stagePatch = {}) {
    const stageId = String(stagePatch?.id || "");
    if (!stageId) return null;
    const project = this.baselineProject(projectId || stagePatch?.projectId, { id: projectId || stagePatch?.projectId || "" });
    if (!project) return null;
    let stage = (project.stages || []).find(item => String(item?.id || "") === stageId);
    if (!stage) {
      stage = { id: stageId, tasks: [] };
      project.stages.push(stage);
    }
    const existingTasks = Array.isArray(stage.tasks) ? stage.tasks : [];
    const clone = this.cloneData(stagePatch);
    clone.tasks = existingTasks;
    Object.assign(stage, clone);
    stage.tasks = existingTasks;
    return stage;
  },

  syncHydratedTaskBaseline(projectId, stageId, task = {}) {
    const taskId = String(task?.id || "");
    if (!taskId) return null;
    const project = this.baselineProject(projectId || task?.projectId, { id: projectId || task?.projectId || "" });
    if (!project) return null;
    const sid = String(stageId || task?.stageId || "");
    let stage = (project.stages || []).find(item => String(item?.id || "") === sid);
    if (!stage) {
      stage = { id: sid, tasks: [] };
      project.stages.push(stage);
    }
    if (!Array.isArray(stage.tasks)) stage.tasks = [];
    const clone = this.cloneData(task);
    const index = stage.tasks.findIndex(item => String(item?.id || "") === taskId);
    if (index >= 0) stage.tasks[index] = { ...stage.tasks[index], ...clone };
    else stage.tasks.push(clone);
    return stage.tasks.find(item => String(item?.id || "") === taskId) || null;
  },

  syncMutationPayloadBaseline(payload = {}, affected = {}) {
    const base = this.ensureHydrationBaseline();
    if (payload.projectId && payload.deleteProject) {
      base.projects = base.projects.filter(project => project.id !== payload.projectId);
    } else if (payload.projectId) {
      const project = this.baselineProject(payload.projectId);
      if (payload.project) Object.assign(project, this.cloneData(payload.project));
      if (Array.isArray(payload.stages)) {
        const oldStages = new Map((project.stages || []).map(stage => [stage.id, stage]));
        project.stages = payload.stages.map(stage => {
          const previous = oldStages.get(stage.id);
          const next = { ...this.cloneData(stage), tasks: previous?.tasks || [] };
          // The mutation omits these read-only aggregates. Preserve the loaded
          // baseline for other stages; affected summaries refresh changed ones.
          ["usedSampleRuns", "runningSampleCount", "progressTaskCounts"].forEach(field => {
            if (previous && Object.prototype.hasOwnProperty.call(previous, field)) next[field] = this.cloneData(previous[field]);
          });
          return next;
        });
      } else if (payload.stage) {
        this.syncHydratedStageBaseline(payload.projectId, payload.stage);
      }
      if (payload.deleteStage) project.stages = (project.stages || []).filter(stage => stage.id !== payload.stageId);
      const tasks = payload.tasks || (payload.task ? [payload.task] : []);
      tasks.forEach(task => this.syncHydratedTaskBaseline(payload.projectId, payload.stageId, task));
      if (payload.deleteMode === "delete") {
        const stage = project.stages.find(stage => stage.id === payload.stageId);
        if (stage) stage.tasks = (stage.tasks || []).filter(task => task.id !== payload.taskId);
      }
    }
    if (payload.category) this.syncHydratedCategoryBaseline(payload.category);
    const samples = [...(payload.samples || []), ...(payload.sample ? [payload.sample] : [])];
    samples.forEach(sample => this.syncHydratedSampleBaseline(sample.categoryId || payload.categoryId, sample));
    this.syncHydratedSampleLogsBaseline(payload.sampleEvents || []);
    (payload.taskMutations || []).forEach(mutation => {
      if (mutation.stage) this.syncHydratedStageBaseline(mutation.projectId, mutation.stage);
      if (mutation.task) this.syncHydratedTaskBaseline(mutation.projectId, mutation.stageId, mutation.task);
    });
    if (payload.deleteSample) {
      base.sampleLibrary.categories.forEach(category => {
        category.samples = (category.samples || []).filter(sample => sample.id !== payload.sampleId);
      });
      base.sampleLibrary.logs = base.sampleLibrary.logs.filter(log => log.sampleId !== payload.sampleId);
    }
    if (payload.deleteCategory) {
      const removed = base.sampleLibrary.categories.find(category => category.id === payload.categoryId);
      const ids = new Set((removed?.samples || []).map(sample => sample.id));
      base.sampleLibrary.categories = base.sampleLibrary.categories.filter(category => category.id !== payload.categoryId);
      base.sampleLibrary.logs = base.sampleLibrary.logs.filter(log => !ids.has(log.sampleId));
    }
    (affected.projectSummaries || []).forEach(summary => {
      const project = base.projects.find(project => project.id === summary.id);
      if (project) Object.assign(project, this.cloneData(summary));
    });
    (affected.stageSummaries || []).forEach(summary => {
      base.projects.forEach(project => {
        const stage = (project.stages || []).find(stage => stage.id === summary.id);
        if (stage) Object.assign(stage, this.cloneData(summary));
      });
    });
    (affected.sampleCategorySummaries || []).forEach(summary => this.syncHydratedCategoryBaseline(summary));
    (affected.tasks || []).forEach(task => this.syncHydratedTaskBaseline(task.projectId, task.stageId, task));
    (affected.samples || []).forEach(sample => this.syncHydratedSampleBaseline(sample.categoryId, sample));
    if (affected.samplePersonCounts) base.projects.forEach(project => {
      if (project._detailLoaded || project.samplePersonCounts) project.samplePersonCounts = this.cloneData(affected.samplePersonCounts);
    });
    return base;
  },

  syncSampleReadMetadataBaseline(sampleIds = []) {
    const fields = ["photoCount", "testHistoryCount", "photosLoaded", "eventsLoaded", "historyLoaded", "hasProblem", "effectiveStatus"];
    sampleIds.forEach(id => {
      const sample = this.findSample(id)?.sample;
      if (!sample) return;
      const patch = {};
      fields.forEach(field => { if (Object.prototype.hasOwnProperty.call(sample, field)) patch[field] = sample[field]; });
      this.syncHydratedSamplePatchBaseline(id, patch);
    });
  },

});
