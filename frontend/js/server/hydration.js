/* 项目、样机池及样机详情按需加载。复用进行中的请求；使用 epoch/revision 与视图序号拒绝迟到响应。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.hydration", {

  mergeProjectDetail(project, { includeTasks = false } = {}) {
    if (!project?.id) return null;
    if (!Array.isArray(project.stages)) project.stages = [];
    const idx = (this.data.projects || []).findIndex(item => String(item.id || "") === String(project.id));
    const existing = idx >= 0 ? this.data.projects[idx] : null;
    if (existing && !includeTasks) {
      const existingStages = new Map((existing.stages || []).map(stage => [String(stage.id || ""), stage]));
      project.stages.forEach(stage => {
        const oldStage = existingStages.get(String(stage.id || ""));
        if (oldStage?.tasks?.length) stage.tasks = oldStage.tasks;
        else if (!Array.isArray(stage.tasks)) stage.tasks = [];
      });
    }
    project._summaryOnly = false;
    project._detailLoaded = true;
    project._tasksFullyLoaded = !!includeTasks || !!existing?._tasksFullyLoaded;
    if (idx >= 0) this.data.projects[idx] = { ...existing, ...project };
    else this.data.projects.push(project);
    return this.data.projects.find(item => String(item.id || "") === String(project.id)) || project;
  },

  mergeSampleCategoryDetail(category) {
    if (!category?.id) return null;
    if (!Array.isArray(category.samples)) category.samples = [];
    const idx = (this.data.sampleLibrary.categories || []).findIndex(item => String(item.id || "") === String(category.id));
    const existing = idx >= 0 ? this.data.sampleLibrary.categories[idx] : null;
    if (existing) {
      const existingSamples = new Map((existing.samples || []).map(sample => [String(sample.id || ""), sample]));
      category.samples = category.samples.map(sample => {
        const oldSample = existingSamples.get(String(sample.id || ""));
        if (oldSample?.photosLoaded && !sample.photosLoaded) {
          sample.photos = oldSample.photos || [];
          sample.photoCount = sample.photos.length;
          sample.photosLoaded = true;
        }
        if (oldSample?.eventsLoaded) sample.eventsLoaded = true;
        return oldSample ? { ...oldSample, ...sample } : sample;
      });
    }
    category._summaryOnly = false;
    category.samplesLoaded = true;
    if (idx >= 0) this.data.sampleLibrary.categories[idx] = { ...existing, ...category };
    else this.data.sampleLibrary.categories.push(category);
    return this.data.sampleLibrary.categories.find(item => String(item.id || "") === String(category.id)) || category;
  },

  mergeProjectSummaries(projects = []) {
    const existingById = new Map((this.data.projects || []).map(project => [String(project.id || ""), project]));
    this.data.projects = (projects || []).map(summary => {
      const existing = existingById.get(String(summary.id || "")) || null;
      const detailLoaded = !!existing?._detailLoaded;
      return {
        ...(existing || {}),
        ...summary,
        stages: Array.isArray(existing?.stages) ? existing.stages : [],
        _summaryOnly: !detailLoaded,
        _detailLoaded: detailLoaded,
        _tasksFullyLoaded: !!existing?._tasksFullyLoaded,
      };
    });
    return this.data.projects;
  },

  mergeSampleCategorySummaries(categories = []) {
    if (!this.data.sampleLibrary) this.data.sampleLibrary = { categories: [], logs: [] };
    const existingById = new Map((this.data.sampleLibrary.categories || []).map(category => [String(category.id || ""), category]));
    this.data.sampleLibrary.categories = (categories || []).map(summary => {
      const existing = existingById.get(String(summary.id || "")) || null;
      const samplesLoaded = !!existing?.samplesLoaded;
      return {
        ...(existing || {}),
        ...summary,
        samples: Array.isArray(existing?.samples) ? existing.samples : [],
        _summaryOnly: !samplesLoaded,
        samplesLoaded,
      };
    });
    this._sampleCategorySummaryLoaded = true;
    return this.data.sampleLibrary.categories;
  },

  async ensureProjectLoaded(projectId, { includeTasks = false, render = false } = {}) {
    const id = String(projectId || "");
    if (!id) return null;
    const current = (this.data.projects || []).find(project => String(project.id || "") === id);
    if (current?._detailLoaded && (!includeTasks || current._tasksFullyLoaded)) return current;
    const key = `${id}:${includeTasks ? "tasks" : "detail"}`;
    if (!this._projectDetailPromises) this._projectDetailPromises = {};
    if (!this._projectDetailPromises[key]) {
      const epoch = this._dataSnapshotEpoch || 0;
      this.updateServerStatus("加载项目");
      this._projectDetailPromises[key] = this.readCurrentServerData(
        () => this.fetchProjectDetail(id, { includeTasks }),
        () => (this.data.projects || []).some(project => String(project.id) === id),
        project => {
          if ((this._dataSnapshotEpoch || 0) !== epoch || !project) return null;
          const current = (this.data.projects || []).find(project => String(project.id) === id);
          const baseline = (this._baseData?.projects || []).find(project => String(project.id) === id);
          if (this.serverReadHasLocalEdits(current, baseline)) return null;
          const merged = this.mergeProjectDetail(project, { includeTasks });
          this.syncHydratedProjectBaseline(merged, { includeTasks });
          this.updateServerStatus("已加载");
          if (render) this.render();
          return merged;
        })
        .catch(e => {
          if ((this._dataSnapshotEpoch || 0) !== epoch) return null;
          this.updateServerStatus("加载失败");
          console.error("项目详情加载失败：", e);
          alert("项目详情加载失败：" + e.message);
          return null;
        })
        .finally(() => { if ((this._dataSnapshotEpoch || 0) === epoch) delete this._projectDetailPromises[key]; });
    }
    return this._projectDetailPromises[key];
  },

  async ensureSampleCategoryLoaded(categoryId, { includePhotos = false, render = false } = {}) {
    const id = String(categoryId || "");
    if (!id) return null;
    const current = (this.data.sampleLibrary.categories || []).find(category => String(category.id || "") === id);
    const expectedCount = Number(current?.sampleCount || 0);
    const currentCount = Array.isArray(current?.samples) ? current.samples.length : 0;
    if (current?.samplesLoaded && !includePhotos && (!expectedCount || currentCount >= expectedCount)) return current;
    const key = `${id}:${includePhotos ? "photos" : "detail"}`;
    if (!this._sampleCategoryDetailPromises) this._sampleCategoryDetailPromises = {};
    if (!this._sampleCategoryDetailPromises[key]) {
      const epoch = this._dataSnapshotEpoch || 0;
      this.updateServerStatus("加载样机池");
      this._sampleCategoryDetailPromises[key] = this.readCurrentServerData(
        () => this.fetchSampleCategoryDetail(id, { includePhotos }),
        () => (this.data.sampleLibrary.categories || []).some(category => String(category.id) === id),
        category => {
          if ((this._dataSnapshotEpoch || 0) !== epoch || !category) return null;
          const current = (this.data.sampleLibrary.categories || []).find(category => String(category.id) === id);
          const baseline = (this._baseData?.sampleLibrary?.categories || []).find(category => String(category.id) === id);
          if (this.serverReadHasLocalEdits(current, baseline)) return null;
          const merged = this.mergeSampleCategoryDetail(category);
          this.syncHydratedCategoryBaseline(merged, { includeSamples: true });
          this.updateServerStatus("已加载");
          if (render) this.render();
          return merged;
        })
        .catch(e => {
          if ((this._dataSnapshotEpoch || 0) !== epoch) return null;
          this.updateServerStatus("加载失败");
          console.error("样机池详情加载失败：", e);
          alert("样机池详情加载失败：" + e.message);
          return null;
        })
        .finally(() => { if ((this._dataSnapshotEpoch || 0) === epoch) delete this._sampleCategoryDetailPromises[key]; });
    }
    return this._sampleCategoryDetailPromises[key];
  },

  async ensureSampleDestroyImpactScope({ sampleId = "", categoryId = "" } = {}) {
    try {
      this.updateServerStatus("加载影响范围");
      const scope = await this.fetchSampleDestroyImpactScope({ sampleId, categoryId });
      const categoryIds = new Set((scope.sampleCategoryIds || []).map(id => String(id || "")).filter(Boolean));
      if (categoryId) categoryIds.add(String(categoryId));
      const projectIds = new Set((scope.projectIds || []).map(id => String(id || "")).filter(Boolean));
      const categoryList = [...categoryIds];
      const projectList = [...projectIds];

      const categories = await Promise.all(categoryList.map(id => this.ensureSampleCategoryLoaded(id, { render: false })));
      if (categories.some((item, idx) => !item && categoryList[idx])) return null;
      const projects = await Promise.all(projectList.map(id => this.ensureProjectLoaded(id, { includeTasks: true, render: false })));
      if (projects.some((item, idx) => !item && projectList[idx])) return null;

      this.updateServerStatus("已加载");
      return scope;
    } catch (e) {
      console.error("销毁影响范围加载失败：", e);
      this.updateServerStatus("加载失败");
      alert("销毁影响范围加载失败：" + e.message);
      return null;
    }
  },

  async ensureSampleDetailsLoaded(sampleId, { photos = true, events = true, renderPanels = true } = {}) {
    const found = this.findSample(sampleId);
    if (!found) return null;
    const sample = found.sample;
    const epoch = this._dataSnapshotEpoch || 0;
    const tasks = [];
    this._sampleDetailPromises ||= {};
    if (photos && sample.photosLoaded !== true) {
      const key = `${sampleId}:photos`;
      if (!this._sampleDetailPromises[key]) {
        const version = this._samplePhotoLoadVersions?.[sampleId] || 0;
        this._sampleDetailPromises[key] = this.fetchSamplePhotos(sampleId).then(list => {
          if ((this._dataSnapshotEpoch || 0) !== epoch) return;
          if ((this._samplePhotoLoadVersions?.[sampleId] || 0) !== version) return;
          const current = this.findSample(sampleId)?.sample;
          if (!current) return;
          const patch = { photos: list, photoCount: list.length, photosLoaded: true };
          Object.assign(current, patch);
          this.syncHydratedSamplePatchBaseline(sampleId, patch);
        }).finally(() => { if ((this._dataSnapshotEpoch || 0) === epoch) delete this._sampleDetailPromises[key]; });
      }
      tasks.push(this._sampleDetailPromises[key]);
    }
    if (events && sample.eventsLoaded !== true) {
      const key = `${sampleId}:events`;
      if (!this._sampleDetailPromises[key]) {
        this._sampleDetailPromises[key] = this.fetchSampleEvents(sampleId).then(list => {
          if ((this._dataSnapshotEpoch || 0) !== epoch) return;
          const current = this.findSample(sampleId)?.sample;
          if (!current) return;
          if (!Array.isArray(this.data.sampleLibrary.logs)) this.data.sampleLibrary.logs = [];
          const byId = new Map(this.data.sampleLibrary.logs.filter(log => log?.id).map(log => [log.id, log]));
          list.forEach(log => {
            if (log?.id && !byId.has(log.id)) {
              this.data.sampleLibrary.logs.push(log);
              byId.set(log.id, log);
            }
          });
          current.eventsLoaded = true;
          this.syncHydratedSamplePatchBaseline(sampleId, { eventsLoaded: true });
          this.syncHydratedSampleLogsBaseline(list);
        }).finally(() => { if ((this._dataSnapshotEpoch || 0) === epoch) delete this._sampleDetailPromises[key]; });
      }
      tasks.push(this._sampleDetailPromises[key]);
    }
    if (tasks.length) {
      const results = await Promise.allSettled(tasks);
      if (renderPanels) this.refreshSampleArchivePanels(sampleId);
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    }
    if (renderPanels) this.refreshSampleArchivePanels(sampleId);
    return this.findSample(sampleId)?.sample || null;
  },

  async ensureSampleHistoryLoaded(sampleId, { page = 1, pageSize = 20, renderPanels = true, force = false } = {}) {
    const found = this.findSample(sampleId);
    if (!found) return null;
    if (!this._sampleHistoryCache) this._sampleHistoryCache = {};
    const key = String(sampleId || "");
    const cached = this._sampleHistoryCache[key];
    this._sampleHistoryRequests ||= {};
    const pending = this._sampleHistoryRequests[key];
    if (pending && pending.page === page && pending.pageSize === pageSize) return pending.promise;
    if (!force && cached && !cached.loading && !cached.error && cached.page === page && cached.pageSize === pageSize) return cached;
    const request = { page, pageSize };
    this._sampleHistoryRequests[key] = request;
    this._sampleHistoryCache[key] = { loading: true, page, pageSize, items: [], total: 0, totalPages: 1 };
    if (renderPanels) this.refreshSampleArchivePanels(sampleId);
    request.promise = (async () => {
      try {
        const result = await this.fetchSampleHistory(sampleId, { page, pageSize });
        if (this._sampleHistoryRequests[key] !== request) return null;
        this._sampleHistoryCache[key] = result;
        const current = this.findSample(sampleId)?.sample;
        if (current) current.historyLoaded = true;
        this.syncHydratedSamplePatchBaseline(sampleId, { historyLoaded: true });
        if (renderPanels) this.refreshSampleArchivePanels(sampleId);
        return result;
      } catch (e) {
        if (this._sampleHistoryRequests[key] !== request) return null;
        this._sampleHistoryCache[key] = { error: e.message || String(e), page, pageSize, items: [], total: 0, totalPages: 1 };
        if (renderPanels) this.refreshSampleArchivePanels(sampleId);
        throw e;
      } finally {
        if (this._sampleHistoryRequests[key] === request) delete this._sampleHistoryRequests[key];
      }
    })();
    return request.promise;
  },

  // ── 数据包导入导出 ──

});
