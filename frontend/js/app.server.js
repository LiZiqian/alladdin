/* ========================================
   数字治理平台 V7 - 服务器通信模块
   ======================================== */

app.registerModule("app.server", {

  // ---- 服务器通信 ----
  async fetchBootstrapState() {
    const res = await fetch("/api/bootstrap", { cache: "no-store" });
    const obj = await res.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!res.ok || !obj.ok) throw new Error(obj.error || ("HTTP " + res.status));
    return obj;
  },

  async resolveServerVersion(bootstrapObj = {}) {
    if (bootstrapObj?.version) return String(bootstrapObj.version);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const obj = await res.json().catch(() => ({}));
      if (res.ok && obj?.version) return String(obj.version);
    } catch (e) {
      console.warn("服务器版本检查失败：", e);
    }
    return "";
  },

  updateServerStatus(extraText = "") {
    const el = document.getElementById("saveState");
    if (!el) return;
    if (this.serverOnline) {
      const t = this.serverUpdatedAt ? new Date(this.serverUpdatedAt).toLocaleString("zh-CN") : "-";
      const full = `已连接 · rev ${this.serverRevision} · ${t}${extraText ? " · " + extraText : ""}`;
      el.innerText = extraText || "同步正常";
      el.title = full;
    } else {
      el.innerText = extraText || "未连接服务器";
      el.title = `未连接 · 数据无法保存${extraText ? " · " + extraText : ""}`;
    }
  },

  fullStateUrl(reason = "manual-full-reload") {
    const query = new URLSearchParams();
    query.set("reason", String(reason || "unspecified"));
    return `/api/state?${query.toString()}`;
  },

  async reloadFromServer({ render = true, reason = "manual-full-reload" } = {}) {
    const res = await fetch(this.fullStateUrl(reason), { cache: "no-store" });
    const obj = await res.json();
    if (!res.ok || !obj.ok) throw new Error(obj.error || ("HTTP " + res.status));
    this.data = obj.data || this.emptyData();
    this.serverRevision = obj.revision || 0;
    this.serverUpdatedAt = obj.updated_at || null;
    this.serverOnline = true;
    this._statePartial = false;
    this.normalize();
    this._baseData = this.cloneData(this.data);
    this.view.selectedProjectId = this.data.currentProjectId || this.data.projects[0]?.id || null;
    this.view.selectedStageId = this.data.currentStageId || this.currentProject()?.stages?.[0]?.id || null;
    if (render) this.render();
    this.updateServerStatus("已刷新");
    if (this._normalizedChanged) {
      this._normalizedChanged = false;
      this.updateServerStatus("已刷新，需检查");
    }
  },

  scheduleSave({ delay = 450, remark = "" } = {}) {
    clearTimeout(this._saveTimer);
    this._queuedRemark = remark || this._queuedRemark || "";
    this.updateServerStatus("待同步");
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      const queuedRemark = this._queuedRemark;
      this._queuedRemark = "";
      this.save({ silent: true, remark: queuedRemark });
    }, delay);
  },

  async save({ silent = false, remark = "", retryOnConflict = true } = {}) {
    if (this._statePartial) {
      if (!silent) alert("当前仍处于摘要加载模式，此入口需要先加载完整数据。请稍后重试或刷新页面。");
      this.updateServerStatus("需完整加载");
      return false;
    }
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._saveInFlight) {
      this._saveQueued = true;
      this._queuedRemark = remark || this._queuedRemark || "";
      this.updateServerStatus("待同步");
      return true;
    }
    this.data.currentProjectId = this.view.selectedProjectId;
    this.data.currentStageId = this.view.selectedStageId;
    if (!this.serverOnline && !silent) {
      this.updateServerStatus("保存失败");
      return false;
    }
    this._saveInFlight = true;
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: this.serverRevision,
          baseData: this._baseData || this.data,
          appVersion: this.version,
          remark,
          data: this.data
        })
      });
      const obj = await res.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (res.status === 409 && obj.error_code === "SAMPLE_OCCUPANCY_CONFLICT") {
        // C1：样机占用冲突——服务器拒绝保存，不能静默 reload（会丢弃本地编辑）
        this.updateServerStatus("样机占用冲突");
        this._saveQueued = false;
        this._queuedRemark = "";
        const conflicts = Array.isArray(obj.conflicts) ? obj.conflicts : [];
        const detail = conflicts.slice(0, 5).map(c => {
          const sample = this.findSample?.(c.sampleId);
          const sampleName = sample?.sample?.sampleNo || sample?.sample?.sn || c.sampleId;
          const items = (c.tasks || []).map(t => t.testItem || "未命名任务").join("、");
          return `· 样机 ${sampleName}：被「${items}」同时占用`;
        }).join("\n");
        alert(`保存被拒绝：样机占用冲突。\n\n同一样机不能被多个未完成任务同时占用：\n${detail}\n\n请先释放或结束其中一个任务的样机后再保存。`);
        return false;
      }
      if (res.status === 409) {
        this.updateServerStatus("保存冲突");
        this._saveQueued = false;
        this._queuedRemark = "";
        if (!silent) alert("保存冲突：服务器上的数据已被其他人更新。\n\n请刷新页面后再继续操作。");
        return false;
      }
      if (!res.ok || !obj.ok) throw new Error(obj.error || ("HTTP " + res.status));
      this.serverRevision = obj.revision || this.serverRevision;
      this.serverUpdatedAt = obj.updated_at || new Date().toISOString();
      this.serverOnline = true;
      this._baseData = this.cloneData(this.data);
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("保存到服务器失败：", e);
      this.serverOnline = false;
      this.updateServerStatus("保存失败");
      if (!silent) alert("保存失败：" + e.message);
      return false;
    } finally {
      this._saveInFlight = false;
      if (this._saveQueued && this.serverOnline) {
        this._saveQueued = false;
        const queuedRemark = this._queuedRemark;
        this._queuedRemark = "";
        setTimeout(() => this.save({ silent: true, remark: queuedRemark, retryOnConflict: false }), 0);
      }
    }
  },

  // ---- 直接变更辅助（照片上传/删除等绕过 save() 的接口） ----

  hasLocalUnsavedChanges() {
    return JSON.stringify(this.data || {}) !== JSON.stringify(this._baseData || {});
  },

  markDataSynced() {
    this._baseData = this.cloneData(this.data || this.emptyData());
    return this._baseData;
  },

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

  async prepareBeforeDirectMutation(remark = "直接变更前同步") {
    // 1. 清掉待执行的 debounce 保存
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    // 2. 等待当前正在进行的保存完成（最多等 3 秒）
    if (this._saveInFlight) {
      let waited = 0;
      while (this._saveInFlight && waited < 3000) {
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      if (this._saveInFlight) {
        alert("正在保存中，请稍后重试。");
        return false;
      }
    }
    // 3. 如果本地有未保存编辑，先保存再继续
    if (this.hasLocalUnsavedChanges()) {
      alert(`${remark}失败：当前还有未保存的本地编辑。请先完成当前编辑，再重试。`);
      this.updateServerStatus("有未保存编辑");
      return false;
    }
    return true;
  },

  async syncAfterDirectMutation({ render = false, statusText = "已保存" } = {}) {
    if (render && typeof this.render === "function") this.render();
    this.updateServerStatus(statusText);
  },

  async clearBrowserCache() {
    this.showConfirm("清除当前浏览器对本平台的缓存，并重新载入页面？", async () => {
      this.updateServerStatus("清理缓存");
      const clientTasks = [];
      if (typeof caches !== "undefined" && caches?.keys) {
        clientTasks.push(caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key)))));
      }
      if (typeof navigator !== "undefined" && navigator.serviceWorker?.getRegistrations) {
        clientTasks.push(navigator.serviceWorker.getRegistrations().then(registrations => (
          Promise.all(registrations
            .filter(registration => String(registration.scope || "").startsWith(location.origin))
            .map(registration => registration.unregister()))
        )));
      }
      try {
        sessionStorage.clear();
        localStorage.removeItem("digital_governance_sidebar_collapsed");
      } catch (e) {
        console.warn("清理本地浏览器状态失败：", e);
      }
      await Promise.all(clientTasks);
      try {
        const healthRes = await fetch("/api/health", { cache: "no-store" });
        const health = await healthRes.json().catch(() => ({}));
        if (healthRes.ok) {
          if (health.version !== this.version) {
            console.warn("服务端版本与前端不一致，仍继续请求服务端缓存清理头。", {
              server: health.version,
              client: this.version
            });
          }
          const res = await fetch("/api/browser-cache/clear", { method: "POST", cache: "no-store" });
          const obj = await res.json().catch(() => ({}));
          if (!res.ok || obj.ok === false) {
            console.warn("服务端缓存清理接口不可用，继续执行前端刷新：", obj.error || `HTTP ${res.status}`);
          }
        } else {
          console.warn("服务端版本与前端不一致，跳过服务端缓存清理头，继续执行前端刷新。");
        }
      } catch (e) {
        console.warn("服务端缓存清理请求失败，继续执行前端刷新：", e);
      }
      const url = new URL(location.href);
      url.searchParams.set("_platformCacheReset", String(Date.now()));
      location.replace(url.toString());
    }, {
      title: "清除浏览器缓存",
      description: "只影响当前浏览器中的本平台缓存，不会删除服务器业务数据。",
      okText: "清除并刷新",
      okClass: "btn btn-purple"
    });
  },

  applySamplePhotosMutationResult(sampleId, json = {}, { renderPanel = false, statusText = "已保存" } = {}) {
    const found = this.findSample(sampleId);
    const accessProjectId = this.sampleAccessProjectId();
    this.serverRevision = json.revision || json.newRevision || this.serverRevision;
    this.serverUpdatedAt = json.updated_at || json.updatedAt || new Date().toISOString();
    this.serverOnline = true;

    if (found?.sample && Array.isArray(json.photos)) {
      this.invalidateSampleDetailAccessCache?.(sampleId, { photos: true, events: false });
      found.sample.photos = json.photos;
      found.sample.photoCount = json.photos.length;
      found.sample.photosLoaded = true;
      found.sample.photosAccessProjectId = accessProjectId;
      found.sample.updatedAt = json.updated_at || json.updatedAt || Utils.now();
      const detailCache = this.sampleDetailAccessCache?.();
      if (detailCache) {
        detailCache[this.sampleAccessScopeKey(sampleId, accessProjectId)] = {
          ...(detailCache[this.sampleAccessScopeKey(sampleId, accessProjectId)] || {}),
          photos: json.photos,
          photosLoaded: true,
        };
      }
    }

    if (found?.category?.id) this.invalidatePagedCaches({ categoryId: found.category.id });
    this.invalidateSampleHistoryCache(sampleId);
    this._baseData = this.cloneData(this.data);

    if (renderPanel) {
      const panel = document.querySelector('[data-sample-archive-panel="photos"]');
      if (panel && found?.sample) this.replaceHtml(panel, this.samplePhotosHtml(found.sample));
    }

    this.updateServerStatus(statusText);
    return found?.sample || null;
  },

  invalidateSampleHistoryCache(sampleIds = []) {
    const ids = Array.isArray(sampleIds) ? sampleIds : [sampleIds];
    ids.map(id => String(id || "")).filter(Boolean).forEach(id => {
      if (this._sampleHistoryCache) {
        delete this._sampleHistoryCache[id];
        Object.keys(this._sampleHistoryCache).forEach(key => {
          if (this.sampleAccessScopeKeyMatchesSample?.(key, id)) delete this._sampleHistoryCache[key];
        });
      }
      this.invalidateSampleDetailAccessCache?.(id, { photos: false, events: true });
      const sample = this.findSample(id)?.sample;
      if (sample) {
        sample.historyLoaded = false;
        delete sample.historyAccessProjectId;
      }
    });
  },

  taskFlowQueryHasFilters(params = {}) {
    return ["sku", "flowStatus", "ownerName", "categoryKeyword", "caseKeyword", "dtsKeyword", "resultKeyword"]
      .some(key => String(params?.[key] || "").trim());
  },

  samplePageQueryHasFilters(params = {}) {
    return ["keyword", "status", "problemState", "reassembled", "owner", "borrower"]
      .some(key => String(params?.[key] || "").trim());
  },

  applyTaskStatusCountDelta(target, changes = []) {
    if (!target || !changes.length) return;
    const counts = { ...(target.statusCounts || {}) };
    changes.forEach(change => {
      const before = String(change.beforeStatus || "").trim();
      const after = String(change.afterStatus || "").trim();
      if (!before || !after || before === after) return;
      counts[before] = Math.max(0, Number(counts[before] || 0) - 1);
      counts[after] = Number(counts[after] || 0) + 1;
    });
    target.statusCounts = counts;
  },

  tryPatchCurrentTaskFlowPage(project, stage, affected = {}) {
    if (!stage?.id || !affected || affected.tasksTruncated) return false;
    if (!this._taskFlowPageCache || typeof this.taskFlowQueryParams !== "function" || typeof this.taskFlowCacheKey !== "function") return false;
    const isCurrentTaskFlow = this.view?.module === "projectWorkspace"
      && String(this.view?.selectedStageId || "") === String(stage.id || "");
    if (!isCurrentTaskFlow) return false;
    const params = this.taskFlowQueryParams(stage);
    if (this.taskFlowQueryHasFilters(params)) return false;
    const key = this.taskFlowCacheKey(stage, params);
    const cache = this._taskFlowPageCache?.key === key ? this._taskFlowPageCache : null;
    if (!cache || !Array.isArray(cache.rows)) return false;

    const affectedTasks = (affected.tasks || []).filter(task => String(task?.stageId || "") === String(stage.id || ""));
    const affectedTaskIds = (affected.taskIds || []).filter(Boolean).map(id => String(id));
    if (!affectedTaskIds.length || affectedTasks.length !== affectedTaskIds.length) return false;

    const rowByTaskId = new Map(cache.rows.map(row => [String(row?.task?.id || ""), row]));
    if (!affectedTaskIds.every(id => rowByTaskId.has(id))) return false;

    const stageTasksById = new Map((stage.tasks || []).map(task => [String(task.id || ""), task]));
    affectedTasks.forEach(task => {
      const id = String(task.id || "");
      const row = rowByTaskId.get(id);
      const mergedTask = stageTasksById.get(id) || task;
      if (row) row.task = mergedTask;
    });

    const statusChanges = (this._lastMutationAffectedChanges?.taskStatus || [])
      .filter(change => String(change.stageId || "") === String(stage.id || "") && affectedTaskIds.includes(String(change.taskId || "")));
    if (cache.stats) this.applyTaskStatusCountDelta(cache.stats, statusChanges);
    this.applyTaskStatusCountDelta(stage, statusChanges);

    if (cache.stats) {
      const ownerNames = new Set(cache.stats.ownerNames || stage.ownerNames || []);
      affectedTasks.forEach(task => {
        const ownerName = this.taskOwnerName?.(task.owner || "") || "";
        if (ownerName) ownerNames.add(ownerName);
      });
      cache.stats.ownerNames = [...ownerNames].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
      stage.ownerNames = cache.stats.ownerNames;
    }

    this.refreshTaskFlowRegion(project, stage);
    return true;
  },

  async refreshTaskListAfterMutation(project, stage, { render = true, affected = null } = {}) {
    if (!stage?.id) return false;
    const isCurrentTaskFlow = this.view?.module === "projectWorkspace"
      && String(this.view?.selectedStageId || "") === String(stage.id || "");
    if (render && isCurrentTaskFlow && typeof this.refreshCurrentTaskFlowPage === "function") {
      if (this.tryPatchCurrentTaskFlowPage(project, stage, affected)) return true;
      this.invalidatePagedCaches({ stageId: stage.id });
      await this.refreshCurrentTaskFlowPage(project, stage);
      return true;
    }
    this.invalidatePagedCaches({ stageId: stage.id });
    if (render) this.render();
    return false;
  },

  tryPatchCurrentSamplePage(category, affected = {}) {
    if (!category?.id || !affected || affected.samplesTruncated) return false;
    if (typeof this.samplePageQueryParams !== "function" || typeof this.samplePageCacheKey !== "function") return false;
    const isCurrentSamplePage = this.view?.module === "samples"
      && String(this.view?.selectedCategoryId || "") === String(category.id || "");
    if (!isCurrentSamplePage) return false;
    const params = this.samplePageQueryParams(category);
    if (this.samplePageQueryHasFilters(params)) return false;
    const key = this.samplePageCacheKey(category, params);
    const cache = this.getSamplePageCache?.(key) || (this._samplePageCache?.key === key ? this._samplePageCache : null);
    if (!cache || !Array.isArray(cache.items)) return false;

    const affectedSamples = (affected.samples || []).filter(sample => String(sample?.categoryId || "") === String(category.id || ""));
    const affectedSampleIds = (affected.sampleIds || []).filter(Boolean).map(id => String(id));
    if (!affectedSampleIds.length || affectedSamples.length !== affectedSampleIds.length) return false;

    const itemById = new Map(cache.items.map(sample => [String(sample?.id || ""), sample]));
    if (!affectedSampleIds.every(id => itemById.has(id))) return false;

    const categorySamplesById = new Map((category.samples || []).map(sample => [String(sample.id || ""), sample]));
    cache.items = cache.items.map(sample => {
      const id = String(sample?.id || "");
      return affectedSampleIds.includes(id) ? (categorySamplesById.get(id) || sample) : sample;
    });
    if (cache.stats) {
      cache.stats.statusCounts = category.statusCounts || cache.stats.statusCounts || {};
      cache.stats.problemCounts = category.problemCounts || cache.stats.problemCounts || {};
      cache.stats.totalInCategory = category.sampleCount ?? cache.stats.totalInCategory;
    }
    this.setSamplePageCache?.(cache);
    this.refreshSamplePageRegion(category);
    return true;
  },

  async refreshSampleListAfterMutation(sampleOrCategory, { render = true, affected = null } = {}) {
    const categoryId = sampleOrCategory?.categoryId || sampleOrCategory?.id || "";
    if (!categoryId) return false;
    const category = this.data?.sampleLibrary?.categories?.find(c => String(c.id || "") === String(categoryId));
    const isCurrentSamplePage = category
      && this.view?.module === "samples"
      && String(this.view?.selectedCategoryId || "") === String(category.id || "");
    if (render && isCurrentSamplePage && typeof this.refreshCurrentSamplePage === "function") {
      if (this.tryPatchCurrentSamplePage(category, affected)) return true;
      this.invalidatePagedCaches({ categoryId });
      await this.refreshCurrentSamplePage(category);
      return true;
    }
    this.invalidatePagedCaches({ categoryId });
    if (render) this.render();
    return false;
  },

  sampleAccessProjectId(explicitProjectId = "") {
    if (explicitProjectId) return String(explicitProjectId);
    const moduleName = this.viewModule?.() || this.view?.module || "";
    return moduleName === "projectWorkspace" ? String(this.view?.selectedProjectId || "") : "";
  },

  sampleAccessScopeKey(sampleId, explicitProjectId = "") {
    return JSON.stringify([
      String(sampleId || ""),
      this.sampleAccessProjectId(explicitProjectId),
    ]);
  },

  sampleHistoryCacheKey(sampleId, explicitProjectId = "") {
    return this.sampleAccessScopeKey(sampleId, explicitProjectId);
  },

  sampleAccessScopeKeyMatchesSample(key, sampleId) {
    try {
      const value = JSON.parse(String(key || ""));
      return Array.isArray(value) && String(value[0] || "") === String(sampleId || "");
    } catch (_error) {
      return String(key || "") === String(sampleId || "");
    }
  },

  sampleAccessScopeIsCurrent(projectId = "") {
    return this.sampleAccessProjectId() === String(projectId || "");
  },

  sampleDetailAccessCache() {
    if (!this._sampleDetailAccessCache || typeof this._sampleDetailAccessCache !== "object") {
      this._sampleDetailAccessCache = {};
    }
    return this._sampleDetailAccessCache;
  },

  invalidateSampleDetailAccessCache(sampleIds = [], { photos = true, events = true } = {}) {
    const ids = (Array.isArray(sampleIds) ? sampleIds : [sampleIds])
      .map(id => String(id || ""))
      .filter(Boolean);
    if (!ids.length) return;
    const cache = this.sampleDetailAccessCache();
    Object.keys(cache).forEach(key => {
      if (!ids.some(id => this.sampleAccessScopeKeyMatchesSample(key, id))) return;
      if (photos) {
        delete cache[key].photos;
        delete cache[key].photosLoaded;
      }
      if (events) {
        delete cache[key].events;
        delete cache[key].eventsLoaded;
      }
      if (!cache[key].photosLoaded && !cache[key].eventsLoaded) delete cache[key];
    });
    ids.forEach(id => {
      const sample = this.findSample?.(id)?.sample;
      if (!sample) return;
      if (photos) {
        sample.photosLoaded = false;
        delete sample.photosAccessProjectId;
      }
      if (events) {
        sample.eventsLoaded = false;
        delete sample.eventsAccessProjectId;
      }
    });
  },

  async fetchSamplePhotos(sampleId, { projectId = "" } = {}) {
    const pid = this.sampleAccessProjectId(projectId);
    const suffix = pid ? `?projectId=${encodeURIComponent(pid)}` : "";
    const resp = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/photos${suffix}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json.photos || [];
  },

  async fetchSampleEvents(sampleId, { projectId = "" } = {}) {
    const pid = this.sampleAccessProjectId(projectId);
    const suffix = pid ? `?projectId=${encodeURIComponent(pid)}` : "";
    const resp = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/events${suffix}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json.logs || [];
  },

  async fetchSampleHistory(sampleId, { page = 1, pageSize = 20, projectId = "" } = {}) {
    const params = new URLSearchParams();
    params.set("page", String(page || 1));
    params.set("pageSize", String(pageSize || 20));
    const pid = this.sampleAccessProjectId(projectId);
    if (pid) params.set("projectId", pid);
    const resp = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/history?${params.toString()}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json;
  },

  async checkSampleIdentityConflicts(samples = [], { categoryId = "" } = {}) {
    const list = Array.isArray(samples) ? samples : [samples];
    const resp = await fetch("/api/sample-identity-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId, samples: list }),
    });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json;
  },

  async fetchProjectSummary() {
    const resp = await fetch("/api/projects/summary", { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json.projects || [];
  },

  async fetchStageTasksPage(stageId, params = {}) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== "" && value !== null && value !== undefined) query.set(key, value);
    });
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const resp = await fetch(`/api/stages/${encodeURIComponent(stageId)}/tasks${suffix}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json;
  },

  async fetchSampleCategoriesSummary() {
    const resp = await fetch("/api/sample-categories", { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json.categories || [];
  },

  async fetchSamplePage(categoryId, params = {}) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== "" && value !== null && value !== undefined) query.set(key, value);
    });
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const resp = await fetch(`/api/sample-categories/${encodeURIComponent(categoryId)}/samples${suffix}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json;
  },

  async fetchTaskSampleCandidates(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length) query.set(key, value.join(","));
      } else if (value !== "" && value !== null && value !== undefined) {
        query.set(key, value);
      }
    });
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const resp = await fetch(`/api/task-sample-candidates${suffix}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json;
  },

  sampleLookupRefKeys(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    const keys = new Set();
    const add = text => {
      const item = String(text || "").trim();
      if (!item) return;
      const lower = item.toLowerCase();
      keys.add(lower);
      keys.add(lower.replace(/\s+/g, ""));
      keys.add(lower.replace(/[\s#：:._-]+/g, ""));
    };
    add(raw);
    if (typeof this.normalizeLogSampleRefCode === "function") add(this.normalizeLogSampleRefCode(raw));
    add(raw.replace(/^(?:SN|IMEI|主板SN)\s*[#：:]\s*/i, ""));
    const hashIdx = raw.indexOf("#");
    if (hashIdx >= 0) add(raw.slice(hashIdx + 1));
    return [...keys].filter(Boolean);
  },

  sampleLookupIdentityValues(sampleId = "", snapshot = null) {
    const values = [];
    const add = value => {
      const text = String(value || "").trim();
      if (text && !values.includes(text)) values.push(text);
    };
    add(sampleId);
    add(snapshot?.id);
    add(snapshot?.code);
    add(snapshot?.sampleNo);
    add(snapshot?.sample_no);
    add(snapshot?.sn);
    add(snapshot?.imei);
    add(snapshot?.boardSn);
    add(snapshot?.board_sn);
    return values;
  },

  sampleMatchesLookupValues(sample = {}, values = []) {
    const sampleValues = [
      sample?.id,
      sample?.sampleNo,
      sample?.sample_no,
      sample?.code,
      sample?.sn,
      sample?.imei,
      sample?.boardSn,
      sample?.board_sn,
      typeof this.sampleDisplayCode === "function" ? this.sampleDisplayCode(sample) : "",
    ];
    const sampleKeys = new Set(sampleValues.flatMap(value => this.sampleLookupRefKeys(value)));
    return values.some(value => this.sampleLookupRefKeys(value).some(key => sampleKeys.has(key)));
  },

  findSampleByLookupValues(values = []) {
    const list = Array.isArray(values) ? values : [values];
    const directId = list.map(value => String(value || "").trim()).filter(Boolean);
    for (const id of directId) {
      const found = this.findSample?.(id);
      if (found) return found;
    }
    const categories = this.sampleCategoryRecords?.() || this.data?.sampleLibrary?.categories || [];
    for (const category of categories) {
      for (const sample of (category.samples || [])) {
        if (this.sampleMatchesLookupValues(sample, list)) return { category, sample };
      }
    }
    return null;
  },

  mergeSampleLookupResult(result = {}) {
    const categories = this.sampleCategoryRecords?.() || this.data?.sampleLibrary?.categories || [];
    const summaryById = new Map((result.categories || []).map(category => [String(category.id || ""), category]));
    const existingById = new Map(categories.map(category => [String(category.id || ""), category]));
    (result.categories || []).forEach(summary => {
      const id = String(summary?.id || "");
      if (!id) return;
      const existing = existingById.get(id);
      if (existing) {
        Object.assign(existing, summary);
        if (!Array.isArray(existing.samples)) existing.samples = [];
      } else {
        const created = { ...summary, samples: [], samplesLoaded: false, _summaryOnly: true };
        categories.push(created);
        existingById.set(id, created);
      }
      this.syncHydratedCategoryBaseline?.(existingById.get(id), { includeSamples: false });
    });
    [...(result.items || []), ...(result.selectedItems || [])].forEach(sample => {
      const sampleId = String(sample?.id || "");
      const categoryId = String(sample?.categoryId || "");
      if (!sampleId || !categoryId) return;
      let category = existingById.get(categoryId);
      if (!category) {
        const summary = summaryById.get(categoryId) || {};
        category = {
          id: categoryId,
          name: sample.categoryName || summary.name || "未分类",
          sampleCount: summary.sampleCount || 0,
          samples: [],
          samplesLoaded: false,
          _summaryOnly: true,
        };
        categories.push(category);
        existingById.set(categoryId, category);
      }
      if (!Array.isArray(category.samples)) category.samples = [];
      const idx = category.samples.findIndex(item => String(item.id || "") === sampleId);
      const merged = idx >= 0 ? { ...category.samples[idx], ...sample } : sample;
      if (idx >= 0) category.samples[idx] = merged;
      else category.samples.push(merged);
      this.syncHydratedSampleBaseline?.(categoryId, merged);
    });
    return result;
  },

  async ensureSampleLoaded(sampleId, { render = false, snapshot = null } = {}) {
    const id = String(sampleId || "");
    if (!id) return null;
    const lookupValues = this.sampleLookupIdentityValues(id, snapshot);
    const current = this.findSampleByLookupValues?.(lookupValues) || this.findSample?.(id);
    if (current) return current;
    const projectId = String(snapshot?.projectId || snapshot?.sourceProjectId || this.selectedProjectId?.() || "").trim();
    const accessEpoch = Number(this._accessEpoch || 0);
    if (!projectId && this.isLocalAdminAccess && !this.isLocalAdminAccess()) {
      this._lastSampleLookupError = new Error("缺少项目上下文，不能执行全局样机查询");
      return null;
    }
    this._lastSampleLookupError = null;
    this._lastSampleLookupMissingIds = [];
    if (!this._sampleLookupPromises) this._sampleLookupPromises = {};
    const lookupKey = JSON.stringify(lookupValues);
    if (!this._sampleLookupPromises[lookupKey]) {
      this.updateServerStatus?.("加载样机");
      const hadLocalUnsavedChanges = this.hasLocalUnsavedChanges?.() === true;
      this._sampleLookupPromises[lookupKey] = (async () => {
        try {
          const selectedResult = await this.fetchTaskSampleCandidates({
            selectedIds: [id],
            ...(projectId ? { projectId } : {}),
            page: 1,
            pageSize: 20,
          });
          if (accessEpoch !== Number(this._accessEpoch || 0)) return null;
          this.mergeSampleLookupResult(selectedResult);
          this._lastSampleLookupMissingIds = selectedResult.selectedMissingIds || [];
          let found = this.findSampleByLookupValues?.(lookupValues) || this.findSample?.(id) || null;
          if (!found) {
            const searchValues = lookupValues.filter(value => !String(value || "").startsWith("sample_"));
            for (const value of searchValues) {
              const keyword = String(value || "").trim();
              if (!keyword) continue;
              const result = await this.fetchTaskSampleCandidates({ keyword, ...(projectId ? { projectId } : {}), page: 1, pageSize: 20 });
              if (accessEpoch !== Number(this._accessEpoch || 0)) return null;
              this.mergeSampleLookupResult(result);
              found = this.findSampleByLookupValues?.(lookupValues) || null;
              if (found) break;
            }
          }
          if (!hadLocalUnsavedChanges) this.markDataSynced?.();
          this.updateServerStatus?.("已加载");
          if (render) this.render?.();
          return found;
        } catch (e) {
          this._lastSampleLookupError = e;
          this.updateServerStatus?.("加载失败");
          console.error("样机档案加载失败：", e);
          return null;
        } finally {
          delete this._sampleLookupPromises[lookupKey];
        }
      })();
    }
    return this._sampleLookupPromises[lookupKey];
  },

  ensureTaskReferenceSamplesLoaded(task) {
    if (!task || typeof this.ensureSampleLoaded !== "function") return [];
    const ids = new Set();
    const add = value => {
      const id = String(value || "").trim();
      if (id) ids.add(id);
    };
    if (typeof this.taskMutationSampleIds === "function") {
      this.taskMutationSampleIds(task).forEach(add);
    } else {
      const entries = typeof this.taskResultSampleEntries === "function"
        ? this.taskResultSampleEntries(task)
        : (task.sampleIds || []).map(sampleId => ({ sampleId }));
      entries.forEach(entry => add(entry.sampleId));
    }
    (task.logs || []).forEach(log => (log?.sampleRefs || []).forEach(ref => add(ref?.sampleId || ref?.sid)));
    const missing = [...ids].filter(id => !this.findSampleByLookupValues?.(this.sampleLookupIdentityValues(id, task.sampleSnapshots?.[id] || null)));
    if (!missing.length) return [];
    return Promise.all(missing.map(id => this.ensureSampleLoaded(id, { snapshot: task.sampleSnapshots?.[id] || null })));
  },

  async requireTaskMutationSamplesLoaded(task, sampleIds = [], actionLabel = "任务操作") {
    const ids = [...new Set((sampleIds || []).map(id => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return true;
    const missing = ids.filter(id => !this.findSample?.(id)?.sample);
    if (!missing.length) return true;

    this.updateServerStatus?.("加载任务样机");
    if (typeof this.ensureSampleLoaded === "function") {
      await Promise.all(missing.map(id => this.ensureSampleLoaded(id, {
        snapshot: task?.sampleSnapshots?.[id] || null
      })));
    }

    // 任务写入和样机状态变更都按 sampleId 精确寻址。即使历史快照中的
    // SN/IMEI 能命中另一条档案，也不能用它替代当前任务真正引用的样机。
    const unresolved = ids.filter(id => !this.findSample?.(id)?.sample);
    if (!unresolved.length) {
      this.updateServerStatus?.("已加载");
      return true;
    }

    const labels = unresolved.slice(0, 5).map(id => {
      const snapshot = task?.sampleSnapshots?.[id] || {};
      return snapshot.code || snapshot.sampleNo || snapshot.sn || snapshot.imei || snapshot.boardSn || id;
    });
    const remaining = unresolved.length > labels.length ? ` 等 ${unresolved.length} 台` : "";
    const reason = this._lastSampleLookupError
      ? "样机档案加载失败，请检查服务连接后重试。"
      : "样机档案可能已被销毁、迁移或尚未同步，请刷新后核对任务与样机池。";
    this.updateServerStatus?.("任务样机未就绪");
    alert(`${actionLabel}未执行：无法取得样机 ${labels.join("、")}${remaining} 的完整档案。\n${reason}`);
    return false;
  },

  prepareTaskActionSamples(task, sampleIds = [], actionLabel = "任务操作") {
    const ids = [...new Set((sampleIds || []).map(id => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return true;
    if (ids.every(id => this.findSample?.(id)?.sample)) return true;
    if (!this._taskActionPreparationInFlight) this._taskActionPreparationInFlight = {};
    const key = `${String(task?.id || "task")}:${actionLabel}:${ids.slice().sort().join(",")}`;
    if (this._taskActionPreparationInFlight[key]) {
      Utils.toast(`${actionLabel}正在加载样机，请稍候`);
      return false;
    }
    this._taskActionPreparationInFlight[key] = true;
    return this.requireTaskMutationSamplesLoaded(task, ids, actionLabel).finally(() => {
      delete this._taskActionPreparationInFlight[key];
    });
  },

  async fetchSampleDestroyImpactScope(params = {}) {
    const query = new URLSearchParams();
    ["sampleId", "categoryId"].forEach(key => {
      const value = String(params?.[key] || "").trim();
      if (value) query.set(key, value);
    });
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const resp = await fetch(`/api/sample-destroy-impact${suffix}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
    return json;
  },

  async fetchProjectDetail(projectId, { includeTasks = false } = {}) {
    const suffix = includeTasks ? "?includeTasks=1" : "";
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}${suffix}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) {
      if (resp.status === 403 && this.accessDeniedError) throw this.accessDeniedError(json.error || "当前 IP 无权访问该项目");
      const error = new Error(json.error || ("HTTP " + resp.status));
      error.status = resp.status;
      throw error;
    }
    return json.project || null;
  },

  async fetchSampleCategoryDetail(categoryId, { includePhotos = false } = {}) {
    const suffix = includePhotos ? "?includePhotos=1" : "";
    const resp = await fetch(`/api/sample-categories/${encodeURIComponent(categoryId)}${suffix}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!resp.ok || !json.ok) {
      if (resp.status === 403 && this.accessDeniedError) throw this.accessDeniedError(json.error || "当前 IP 无权访问该样机池");
      const error = new Error(json.error || ("HTTP " + resp.status));
      error.status = resp.status;
      throw error;
    }
    return json.category || null;
  },

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
    project._tasksFullyLoaded = !!includeTasks;
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

  importMutationIdSets(mutationSummary = {}) {
    const toSet = values => new Set((values || []).map(value => String(value || "")).filter(Boolean));
    return {
      projectIds: toSet(mutationSummary.projectIds),
      stageIds: toSet(mutationSummary.stageIds),
      sampleCategoryIds: toSet(mutationSummary.sampleCategoryIds),
      sampleIds: toSet(mutationSummary.sampleIds),
    };
  },

  mergeProjectSummaryRows(projects = []) {
    if (!Array.isArray(this.data.projects)) this.data.projects = [];
    const byId = new Map(this.data.projects.map(project => [String(project.id || ""), project]));
    (projects || []).forEach(summary => {
      const id = String(summary?.id || "");
      if (!id) return;
      const existing = byId.get(id);
      if (existing) {
        Object.assign(existing, summary, {
          stages: Array.isArray(existing.stages) ? existing.stages : [],
          _summaryOnly: !existing._detailLoaded,
        });
      } else {
        const created = { ...summary, stages: [], _summaryOnly: true, _detailLoaded: false };
        this.data.projects.push(created);
        byId.set(id, created);
      }
    });
    return this.data.projects;
  },

  mergeSampleCategorySummaryRows(categories = []) {
    if (!this.data.sampleLibrary) this.data.sampleLibrary = { categories: [], logs: [] };
    if (!Array.isArray(this.data.sampleLibrary.categories)) this.data.sampleLibrary.categories = [];
    const byId = new Map(this.data.sampleLibrary.categories.map(category => [String(category.id || ""), category]));
    (categories || []).forEach(summary => {
      const id = String(summary?.id || "");
      if (!id) return;
      const existing = byId.get(id);
      if (existing) {
        Object.assign(existing, summary, {
          samples: Array.isArray(existing.samples) ? existing.samples : [],
          _summaryOnly: !existing.samplesLoaded,
        });
      } else {
        const created = { ...summary, samples: [], _summaryOnly: true, samplesLoaded: false };
        this.data.sampleLibrary.categories.push(created);
        byId.set(id, created);
      }
    });
    return this.data.sampleLibrary.categories;
  },

  applyMutationAffected(affected = {}) {
    if (!affected || typeof affected !== "object") return false;
    const changes = { taskStatus: [], sampleStatus: [] };
    this.mergeProjectSummaryRows(affected.projectSummaries || []);
    this.mergeSampleCategorySummaryRows(affected.sampleCategorySummaries || []);

    (affected.tasks || []).forEach(task => {
      const project = (this.data.projects || []).find(item => String(item.id || "") === String(task?.projectId || ""));
      const stage = (project?.stages || []).find(item => String(item.id || "") === String(task?.stageId || ""));
      if (!stage) return;
      if (!Array.isArray(stage.tasks)) stage.tasks = [];
      const existing = stage.tasks.find(item => String(item.id || "") === String(task.id || ""));
      const beforeStatus = existing && typeof this.taskFlowStatus === "function" ? this.taskFlowStatus(existing) : "";
      if (existing) Object.assign(existing, task);
      else stage.tasks.push(task);
      const merged = existing || task;
      const afterStatus = typeof this.taskFlowStatus === "function" ? this.taskFlowStatus(merged) : "";
      if (beforeStatus || afterStatus) {
        changes.taskStatus.push({
          projectId: task.projectId || project.id || "",
          stageId: task.stageId || stage.id || "",
          taskId: task.id || "",
          beforeStatus,
          afterStatus,
        });
      }
    });

    (affected.samples || []).forEach(sample => {
      const category = (this.data.sampleLibrary?.categories || []).find(item => String(item.id || "") === String(sample?.categoryId || ""));
      if (!category) return;
      if (!Array.isArray(category.samples)) category.samples = [];
      const existing = category.samples.find(item => String(item.id || "") === String(sample.id || ""));
      const beforeStatus = existing && typeof this.sampleEffectiveStatus === "function" ? this.sampleEffectiveStatus(existing) : "";
      if (existing) Object.assign(existing, sample);
      else category.samples.push(sample);
      const merged = existing || sample;
      const afterStatus = typeof this.sampleEffectiveStatus === "function" ? this.sampleEffectiveStatus(merged) : "";
      if (beforeStatus || afterStatus) {
        changes.sampleStatus.push({
          categoryId: sample.categoryId || category.id || "",
          sampleId: sample.id || "",
          beforeStatus,
          afterStatus,
        });
      }
    });
    this._lastMutationAffectedChanges = changes;
    return true;
  },

  async applyImportBundleMutationResult(result = {}, { render = true } = {}) {
    const mutationSummary = result.mutationSummary || null;
    this.serverRevision = result.revision || result.newRevision || this.serverRevision;
    this.serverUpdatedAt = result.updated_at || result.updatedAt || new Date().toISOString();
    this.serverOnline = true;

    if (!mutationSummary || mutationSummary.requiresFullState) {
      console.error("导入提交缺少局部同步摘要，拒绝自动拉取完整 state。");
      this.updateServerStatus("导入已写入，同步失败");
      return false;
    }

    this.updateServerStatus("同步导入");
    this.invalidatePagedCaches();
    const { projectIds, stageIds, sampleCategoryIds } = this.importMutationIdSets(mutationSummary);

    try {
      const [projectSummaries, categorySummaries] = await Promise.all([
        this.fetchProjectSummary(),
        this.fetchSampleCategoriesSummary(),
      ]);
      this.mergeProjectSummaries(projectSummaries);
      this.mergeSampleCategorySummaries(categorySummaries);

      await Promise.all([...projectIds].map(async projectId => {
        const detail = await this.fetchProjectDetail(projectId, { includeTasks: false });
        if (detail) this.mergeProjectDetail(detail, { includeTasks: false });
      }));

      if (!this.view.selectedProjectId || !(this.data.projects || []).some(project => String(project.id || "") === String(this.view.selectedProjectId))) {
        this.view.selectedProjectId = [...projectIds][0] || this.data.projects[0]?.id || null;
      }
      const currentProject = this.currentProject();
      if (currentProject && (!this.view.selectedStageId || !(currentProject.stages || []).some(stage => String(stage.id || "") === String(this.view.selectedStageId)))) {
        this.view.selectedStageId = currentProject.stages?.[0]?.id || null;
      }

      if (render) {
        this.renderNav?.();
        this.renderHeader?.();
        let contentRefreshed = false;
        if (this.view.module === "projectWorkspace") {
          const project = this.currentProject();
          const stage = this.currentStage();
          const selectedProjectAffected = projectIds.has(String(project?.id || ""));
          const selectedStageAffected = stageIds.has(String(stage?.id || "")) || selectedProjectAffected;
          if (project && stage && selectedStageAffected && typeof this.refreshCurrentTaskFlowPage === "function") {
            contentRefreshed = await this.refreshCurrentTaskFlowPage(project, stage);
          }
          if (!contentRefreshed && selectedProjectAffected && typeof this.renderContent === "function") {
            this.renderContent();
            contentRefreshed = true;
          }
        } else if (this.view.module === "samples") {
          const category = (this.data.sampleLibrary.categories || [])
            .find(cat => String(cat.id || "") === String(this.view.selectedCategoryId || ""));
          if (category && sampleCategoryIds.has(String(category.id || "")) && typeof this.refreshCurrentSamplePage === "function") {
            contentRefreshed = await this.refreshCurrentSamplePage(category);
          }
          if (!contentRefreshed && typeof this.renderContent === "function") {
            this.renderContent();
            contentRefreshed = true;
          }
        } else if ((this.view.module === "home" || this.view.module === "projects") && typeof this.renderContent === "function") {
          this.renderContent();
        }
      }

      this._baseData = this.cloneData(this.data);
      this.updateServerStatus("已导入");
      return true;
    } catch (e) {
      console.error("导入后局部同步失败：", e);
      this.updateServerStatus("导入同步失败");
      return false;
    }
  },

  async ensureProjectLoaded(projectId, { includeTasks = false, render = false } = {}) {
    const id = String(projectId || "");
    if (!id) return null;
    const current = (this.data.projects || []).find(project => String(project.id || "") === id);
    if (current?._detailLoaded && (!includeTasks || current._tasksFullyLoaded)) return current;
    const key = `${id}:${includeTasks ? "tasks" : "detail"}`;
    const accessEpoch = Number(this._accessEpoch || 0);
    if (!this._projectDetailPromises) this._projectDetailPromises = {};
    if (!this._projectDetailPromises[key]) {
      this.updateServerStatus("加载项目");
      this._projectDetailPromises[key] = this.fetchProjectDetail(id, { includeTasks })
        .then(project => {
          if (accessEpoch !== Number(this._accessEpoch || 0)) return null;
          const merged = this.mergeProjectDetail(project, { includeTasks });
          this._baseData = this.cloneData(this.data);
          this.updateServerStatus("已加载");
          if (render) this.render();
          return merged;
        })
        .catch(e => {
          this.updateServerStatus("加载失败");
          console.error("项目详情加载失败：", e);
          if (!this.isAccessDeniedError?.(e)) alert("项目详情加载失败：" + e.message);
          return null;
        })
        .finally(() => { delete this._projectDetailPromises[key]; });
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
    const accessEpoch = Number(this._accessEpoch || 0);
    if (!this._sampleCategoryDetailPromises) this._sampleCategoryDetailPromises = {};
    if (!this._sampleCategoryDetailPromises[key]) {
      this.updateServerStatus("加载样机池");
      this._sampleCategoryDetailPromises[key] = this.fetchSampleCategoryDetail(id, { includePhotos })
        .then(category => {
          if (accessEpoch !== Number(this._accessEpoch || 0)) return null;
          const merged = this.mergeSampleCategoryDetail(category);
          this._baseData = this.cloneData(this.data);
          this.updateServerStatus("已加载");
          if (render) this.render();
          return merged;
        })
        .catch(e => {
          this.updateServerStatus("加载失败");
          console.error("样机池详情加载失败：", e);
          if (!this.isAccessDeniedError?.(e)) alert("样机池详情加载失败：" + e.message);
          return null;
        })
        .finally(() => { delete this._sampleCategoryDetailPromises[key]; });
    }
    return this._sampleCategoryDetailPromises[key];
  },

  async ensureSampleDestroyImpactScope({ sampleId = "", categoryId = "" } = {}) {
    try {
      this.updateServerStatus("加载影响范围");
      const scope = await this.fetchSampleDestroyImpactScope({ sampleId, categoryId });
      const localAdmin = typeof this.isLocalAdminAccess !== "function" || this.isLocalAdminAccess();
      const categoryIds = new Set((scope.sampleCategoryIds || []).map(id => String(id || "")).filter(Boolean));
      if (categoryId) categoryIds.add(String(categoryId));
      if (scope.categoryId) categoryIds.add(String(scope.categoryId));
      const projectIds = new Set((scope.projectIds || []).map(id => String(id || "")).filter(Boolean));
      const categoryList = [...categoryIds];
      const projectList = [...projectIds];

      const categories = await Promise.all(categoryList.map(id => this.ensureSampleCategoryLoaded(id, { render: false })));
      if (categories.some((item, idx) => !item && categoryList[idx])) return null;
      if (localAdmin) {
        const projects = await Promise.all(projectList.map(id => this.ensureProjectLoaded(id, { includeTasks: true, render: false })));
        if (projects.some((item, idx) => !item && projectList[idx])) return null;
      }

      this._lastSampleDestroyImpactScope = scope;
      this.updateServerStatus("已加载");
      return scope;
    } catch (e) {
      console.error("销毁影响范围加载失败：", e);
      this.updateServerStatus("加载失败");
      alert("销毁影响范围加载失败：" + e.message);
      return null;
    }
  },

  taskMutationSampleIds(task) {
    const ids = new Set();
    const add = value => {
      const id = String(value || "").trim();
      if (id) ids.add(id);
    };
    (task?.sampleIds || []).forEach(add);
    (task?.removedSampleRecords || []).forEach(item => add(item?.sampleId || item?.sid));
    (task?.sampleFaultRecords || []).forEach(item => add(item?.sampleId || item?.sid));
    (task?.resultDraft?.samples || []).forEach(item => add(item?.sampleId || item?.sid));
    (task?.resultUploads || []).forEach(upload => (upload?.samples || []).forEach(item => add(item?.sampleId || item?.sid)));
    return [...ids];
  },

  compactStageForMutation(stage) {
    if (!stage) return null;
    const copy = { ...stage };
    delete copy.tasks;
    return copy;
  },

  compactProjectForMutation(project) {
    if (!project) return null;
    const copy = { ...project };
    delete copy.stages;
    return copy;
  },

  compactSampleForMutation(sample) {
    if (!sample) return null;
    const copy = { ...sample };
    delete copy.photos;
    delete copy.logs;
    return copy;
  },

  compactSampleCategoryForMutation(category) {
    if (!category) return null;
    const copy = { ...category };
    delete copy.samples;
    return copy;
  },

  invalidatePagedCaches({ stageId = "", categoryId = "" } = {}) {
    this.cancelTaskFlowPageRequestState?.(stageId);
    if (stageId && this._taskFlowPageCache?.stageId === stageId) this._taskFlowPageCache = null;
    if (!stageId && this._taskFlowPageCache) this._taskFlowPageCache = null;
    const clearSampleCacheStore = (store) => {
      if (!(store instanceof Map)) return;
      if (!categoryId) {
        store.clear();
        return;
      }
      [...store.entries()].forEach(([key, value]) => {
        if (String(value?.categoryId || "") === String(categoryId)) store.delete(key);
      });
    };
    clearSampleCacheStore(this._samplePageCaches);
    clearSampleCacheStore(this._samplePageMetaCaches);
    if (categoryId && this._samplePageCache?.categoryId === categoryId) this._samplePageCache = null;
    if (!categoryId && this._samplePageCache) this._samplePageCache = null;
    if (this._samplePageLoadingKeys instanceof Set) this._samplePageLoadingKeys.clear();
    this._sampleCategorySummaryLoaded = false;
  },

  sampleEventsForTaskMutation(task, sampleIds = []) {
    const sampleSet = new Set((sampleIds || []).map(id => String(id || "")).filter(Boolean));
    if (!sampleSet.size) return [];
    return (this.data?.sampleLibrary?.logs || []).filter(log => {
      if (!log) return false;
      return sampleSet.has(String(log.sampleId || ""));
    });
  },

  taskSampleStatusBlockerMessage(json = {}) {
    return (json.samples || []).slice(0, 8).map(item => {
      const found = this.findSample?.(item.sampleId);
      const sampleName = found?.sample?.sampleNo || item.sampleNo || found?.sample?.sn || item.sn || item.imei || item.sampleId;
      const status = item.status || "未知状态";
      const taskNames = (item.tasks || []).map(t => t.testItem || t.taskId || "未命名任务").join("、");
      return `· 样机 ${sampleName}：当前状态「${status}」${taskNames ? `，目标任务「${taskNames}」` : ""}`;
    }).join("\n");
  },

  async refreshAfterTaskStateConflict(projectId, stageId) {
    try {
      this.updateServerStatus("刷新任务状态");
      const project = await this.fetchProjectDetail(projectId, { includeTasks: true });
      if (project) {
        this.mergeProjectDetail(project, { includeTasks: true });
        this._baseData = this.dataSnapshot();
        this.invalidatePagedCaches({ stageId });
        if (Array.isArray(this._modalStack)) this._modalStack.length = 0;
        this.closeModal?.();
        this.closeConfirm?.();
        this.render();
      }
      this.updateServerStatus("已同步");
      return true;
    } catch (e) {
      console.error("任务状态冲突后刷新失败：", e);
      this.updateServerStatus("刷新失败");
      alert("任务状态已被其他操作修改，但刷新最新状态失败：" + e.message);
      return false;
    }
  },

  taskMutationSnapshot() {
    return {
      data: this.dataSnapshot(),
      baseData: this.cloneData(this._baseData || this.dataSnapshot())
    };
  },

  restoreFailedTaskMutation(snapshot, { render = true } = {}) {
    if (!snapshot) return false;
    const stateConflictWasRefreshed = this._lastTaskMutationError?.error_code === "TASK_STATE_CONFLICT"
      && this._lastTaskMutationError?._refreshSucceeded === true;
    if (stateConflictWasRefreshed) return false;
    this.restoreDataSnapshot(snapshot.data);
    this._baseData = this.cloneData(snapshot.baseData || snapshot.data);
    this.invalidatePagedCaches();
    if (render) this.render();
    return true;
  },

  async commitTaskMutation(project, stage, task, { action = "task_mutation", remark = "任务增量变更", user = "", render = true, createIfMissing = false, deleteMode = "", sampleIdsForMutation = null } = {}) {
    if (!project || !stage || !task) return false;
    this._lastTaskMutationError = null;
    const sampleIds = this.taskMutationSampleIds(task);
    this.ensureTaskSampleSnapshots?.(task, sampleIds);
    const mutationSampleIds = Array.isArray(sampleIdsForMutation)
      ? [...new Set(sampleIdsForMutation.map(id => String(id || "").trim()).filter(Boolean))]
      : sampleIds;
    const samples = mutationSampleIds
      .map(id => this.compactSampleForMutation(this.findSample(id)?.sample))
      .filter(Boolean);
    const payload = {
      revision: this.serverRevision,
      projectId: project.id,
      stageId: stage.id,
      taskId: task.id,
      action,
      remark,
      user,
      stage: this.compactStageForMutation(stage),
      task,
      samples,
      sampleEvents: this.sampleEventsForTaskMutation(task, mutationSampleIds),
      createIfMissing,
      deleteMode,
    };
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (resp.status === 409 && json.error_code === "SAMPLE_OCCUPANCY_CONFLICT") {
        const detail = (json.conflicts || []).slice(0, 5).map(c => {
          const sample = this.findSample?.(c.sampleId);
          const sampleName = sample?.sample?.sampleNo || sample?.sample?.sn || c.sampleId;
          const items = (c.tasks || []).map(t => t.testItem || "未命名任务").join("、");
          return `· 样机 ${sampleName}：被「${items}」同时占用`;
        }).join("\n");
        this.updateServerStatus("样机占用冲突");
        alert(`保存被拒绝：样机占用冲突。\n\n同一样机不能被多个未完成任务同时占用：\n${detail}`);
        return false;
      }
      if (resp.status === 409 && json.error_code === "SAMPLE_CURRENT_STATE_LOCKED") {
        this._lastTaskMutationError = json;
        const detail = (json.conflicts || []).slice(0, 5).map(c => {
          const sample = this.findSample?.(c.sampleId);
          const sampleName = sample?.sample?.sampleNo || sample?.sample?.sn || c.sampleId;
          const items = (c.tasks || []).map(t => t.testItem || t.taskId || "未命名任务").join("、");
          return `· 样机 ${sampleName}：正在「${items}」中使用`;
        }).join("\n");
        this.updateServerStatus("样机当前信息已锁定");
        alert(`保存被拒绝：样机正在其他未完成任务中，不能通过已完成任务覆盖当前信息。\n${detail}`);
        return false;
      }
      if (resp.status === 409 && json.error_code === "SAMPLE_STATUS_NOT_SELECTABLE") {
        this._lastTaskMutationError = json;
        this.updateServerStatus("样机状态不可选");
        alert(`保存被拒绝：样机状态不可选。\n\n只有「闲置」样机可以加入测试任务：\n${this.taskSampleStatusBlockerMessage(json)}`);
        return false;
      }
      if (resp.status === 409 && json.error_code === "TASK_ALREADY_FINISHED") {
        this._lastTaskMutationError = json;
        this.updateServerStatus("任务已结束");
        Utils.toast("任务已经结束，已同步服务器状态。");
        return false;
      }
      if (resp.status === 409 && json.error_code === "TASK_STATE_CONFLICT") {
        this._lastTaskMutationError = json;
        this.updateServerStatus("任务状态已变化");
        alert(`操作已取消：任务当前状态已变为「${json.taskStatus || "未知"}」。\n\n平台将刷新最新任务和样机状态，请重新确认后再操作。`);
        json._refreshSucceeded = await this.refreshAfterTaskStateConflict(project.id, stage.id);
        return false;
      }
      if (resp.status === 409 && json.error_code === "TASK_REVISION_CONFLICT") {
        this._lastTaskMutationError = json;
        this.updateServerStatus("页面数据已过期");
        alert("操作已取消：平台数据已被其他页面更新。\n\n为避免旧页面覆盖新数据，平台将刷新当前项目；请核对最新任务和样机状态后重新操作。");
        json._refreshSucceeded = await this.refreshAfterTaskStateConflict(project.id, stage.id);
        return false;
      }
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.serverRevision = json.revision || this.serverRevision;
      this.serverUpdatedAt = json.updated_at || new Date().toISOString();
      this.serverOnline = true;
      this.applyMutationAffected(json.affected);
      this.invalidateSampleHistoryCache(mutationSampleIds);
      await this.refreshTaskListAfterMutation(project, stage, { render, affected: json.affected });
      this.markDataSynced();
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("任务增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("任务增量保存失败：" + e.message);
      return false;
    }
  },

  async commitTaskBatchMutation(project, stage, tasks, { action = "task_batch_mutation", remark = "批量任务增量变更", user = "", render = true, createIfMissing = true } = {}) {
    if (!project || !stage || !Array.isArray(tasks) || !tasks.length) return false;
    tasks.forEach(task => this.ensureTaskSampleSnapshots?.(task, this.taskMutationSampleIds(task)));
    const payload = {
      revision: this.serverRevision,
      projectId: project.id,
      stageId: stage.id,
      action,
      remark,
      user,
      stage: this.compactStageForMutation(stage),
      tasks,
      createIfMissing,
    };
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/stages/${encodeURIComponent(stage.id)}/tasks/batch`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (resp.status === 409 && json.error_code === "SAMPLE_STATUS_NOT_SELECTABLE") {
        this.updateServerStatus("样机状态不可选");
        alert(`保存被拒绝：样机状态不可选。\n\n只有「闲置」样机可以加入测试任务：\n${this.taskSampleStatusBlockerMessage(json)}`);
        return false;
      }
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.serverRevision = json.revision || this.serverRevision;
      this.serverUpdatedAt = json.updated_at || new Date().toISOString();
      this.serverOnline = true;
      this.applyMutationAffected(json.affected);
      this.invalidateSampleHistoryCache([...new Set(tasks.flatMap(task => this.taskMutationSampleIds(task)))]);
      await this.refreshTaskListAfterMutation(project, stage, { render, affected: json.affected });
      this.markDataSynced();
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("批量任务增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("批量任务增量保存失败：" + e.message);
      return false;
    }
  },

  taskMutationPayloadFor(project, stage, task, { createIfMissing = false } = {}) {
    this.ensureTaskSampleSnapshots?.(task, this.taskMutationSampleIds(task));
    return {
      projectId: project?.id,
      stageId: stage?.id,
      taskId: task?.id,
      stage: this.compactStageForMutation(stage),
      task,
      createIfMissing
    };
  },

  async commitProjectMutation(project, { action = "project_mutation", remark = "项目增量变更", user = "", createIfMissing = false, deleteProject = false, samples = [], sampleEvents = [], render = true } = {}) {
    if (!project?.id) return false;
    const payload = {
      revision: this.serverRevision,
      projectId: project.id,
      project: deleteProject ? null : this.compactProjectForMutation(project),
      samples: (samples || []).map(s => this.compactSampleForMutation(s)).filter(Boolean),
      sampleEvents: sampleEvents || [],
      action,
      remark,
      user,
      createIfMissing,
      deleteProject,
    };
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(project.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.serverRevision = json.revision || this.serverRevision;
      this.serverUpdatedAt = json.updated_at || new Date().toISOString();
      this.serverOnline = true;
      this.applyMutationAffected(json.affected);
      this.invalidateSampleHistoryCache([...(samples || []).map(s => s?.id), ...(sampleEvents || []).map(log => log?.sampleId)]);
      this.invalidatePagedCaches();
      if (render) this.render();
      this.markDataSynced();
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("项目增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("项目增量保存失败：" + e.message);
      return false;
    }
  },

  async commitStageMutation(project, stage, { action = "stage_mutation", remark = "阶段增量变更", user = "", createIfMissing = false, deleteStage = false, samples = [], sampleEvents = [], render = true } = {}) {
    if (!project?.id || !stage?.id) return false;
    const payload = {
      revision: this.serverRevision,
      projectId: project.id,
      stageId: stage.id,
      project: this.compactProjectForMutation(project),
      stage: deleteStage ? null : this.compactStageForMutation(stage),
      stages: (project.stages || []).map(st => this.compactStageForMutation(st)).filter(Boolean),
      samples: (samples || []).map(s => this.compactSampleForMutation(s)).filter(Boolean),
      sampleEvents: sampleEvents || [],
      action,
      remark,
      user,
      createIfMissing,
      deleteStage,
    };
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/stages/${encodeURIComponent(stage.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.serverRevision = json.revision || this.serverRevision;
      this.serverUpdatedAt = json.updated_at || new Date().toISOString();
      this.serverOnline = true;
      this.applyMutationAffected(json.affected);
      this.invalidateSampleHistoryCache([...(samples || []).map(s => s?.id), ...(sampleEvents || []).map(log => log?.sampleId)]);
      this.invalidatePagedCaches({ stageId: stage.id });
      if (render) this.render();
      this.markDataSynced();
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("阶段增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("阶段增量保存失败：" + e.message);
      return false;
    }
  },

  async commitSampleMutation(sample, { action = "sample_mutation", remark = "样机增量变更", user = "", deleteSample = false, taskMutations = [], samples = [], sampleEvents = null, render = true } = {}) {
    if (!sample?.id) return false;
    const serverManagedDestroy = action === "destroy_sample"
      && typeof this.isLocalAdminAccess === "function"
      && !this.isLocalAdminAccess();
    const events = serverManagedDestroy
      ? []
      : (sampleEvents || (this.data?.sampleLibrary?.logs || []).filter(log => String(log?.sampleId || "") === String(sample.id)));
    const payload = {
      revision: this.serverRevision,
      sampleId: sample.id,
      sample: deleteSample ? null : this.compactSampleForMutation(sample),
      action,
      remark,
      user,
      deleteSample,
    };
    if (!serverManagedDestroy) {
      payload.samples = (samples || []).map(s => this.compactSampleForMutation(s)).filter(Boolean);
      payload.sampleEvents = events;
      payload.taskMutations = taskMutations;
    }
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/samples/${encodeURIComponent(sample.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.serverRevision = json.revision || this.serverRevision;
      this.serverUpdatedAt = json.updated_at || new Date().toISOString();
      this.serverOnline = true;
      this.applyMutationAffected(json.affected);
      this.invalidateSampleHistoryCache([sample.id, ...(samples || []).map(s => s?.id), ...(events || []).map(log => log?.sampleId)]);
      if (deleteSample) this.invalidateSampleDetailAccessCache(sample.id);
      await this.refreshSampleListAfterMutation(sample, { render, affected: json.affected });
      this.markDataSynced();
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("样机增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("样机增量保存失败：" + e.message);
      return false;
    }
  },

  async commitSampleCategoryMutation(category, { action = "sample_category_mutation", remark = "样机池增量变更", user = "", createIfMissing = false, createSamples = false, deleteCategory = false, taskMutations = [], samples = [], sampleEvents = [], render = true } = {}) {
    if (!category?.id) return false;
    const categorySampleIds = deleteCategory
      ? (category.samples || []).map(sample => String(sample?.id || "")).filter(Boolean)
      : [];
    const serverManagedDestroy = action === "destroy_sample_category"
      && typeof this.isLocalAdminAccess === "function"
      && !this.isLocalAdminAccess();
    const payload = {
      revision: this.serverRevision,
      categoryId: category.id,
      category: this.compactSampleCategoryForMutation(category),
      action,
      remark,
      user,
      createIfMissing,
      createSamples,
      deleteCategory,
    };
    if (!serverManagedDestroy) {
      payload.samples = (samples || []).map(s => this.compactSampleForMutation(s)).filter(Boolean);
      payload.sampleEvents = sampleEvents || [];
      payload.taskMutations = taskMutations;
    }
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/sample-categories/${encodeURIComponent(category.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.serverRevision = json.revision || this.serverRevision;
      this.serverUpdatedAt = json.updated_at || new Date().toISOString();
      this.serverOnline = true;
      this.applyMutationAffected(json.affected);
      this.invalidateSampleHistoryCache([...categorySampleIds, ...(samples || []).map(s => s?.id), ...(sampleEvents || []).map(log => log?.sampleId)]);
      if (deleteCategory && categorySampleIds.length) this.invalidateSampleDetailAccessCache(categorySampleIds);
      if (createSamples && !deleteCategory) {
        await this.refreshSampleListAfterMutation(category, { render, affected: json.affected });
      } else {
        this.invalidatePagedCaches({ categoryId: category.id });
        if (render) this.render();
      }
      this.markDataSynced();
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("样机池增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("样机池增量保存失败：" + e.message);
      return false;
    }
  },

  async ensureSampleDetailsLoaded(sampleId, { photos = true, events = true, renderPanels = true, projectId = "" } = {}) {
    const found = this.findSample(sampleId);
    if (!found) return null;
    const sample = found.sample;
    const tasks = [];
    const accessProjectId = this.sampleAccessProjectId(projectId);
    const cache = this.sampleDetailAccessCache();
    const cacheKey = this.sampleAccessScopeKey(sampleId, accessProjectId);
    const cached = cache[cacheKey] || (cache[cacheKey] = {});
    const applyPhotos = list => {
      cached.photos = Array.isArray(list) ? list : [];
      cached.photosLoaded = true;
      if (this.sampleAccessScopeIsCurrent(accessProjectId)) {
        const hydratedPhotos = cached.photos;
        sample.photos = hydratedPhotos;
        sample.photoCount = hydratedPhotos.length;
        sample.photosLoaded = true;
        sample.photosAccessProjectId = accessProjectId;
        this.syncHydratedSamplePatchBaseline(sampleId, {
          photos: hydratedPhotos,
          photoCount: hydratedPhotos.length,
          photosLoaded: true,
          photosAccessProjectId: accessProjectId,
        });
      }
      return cached.photos;
    };
    const applyEvents = list => {
      cached.events = Array.isArray(list) ? list : [];
      cached.eventsLoaded = true;
      if (this.sampleAccessScopeIsCurrent(accessProjectId)) {
        if (!accessProjectId) {
          if (!Array.isArray(this.data.sampleLibrary.logs)) this.data.sampleLibrary.logs = [];
          const byId = new Map(this.data.sampleLibrary.logs.filter(log => log?.id).map(log => [log.id, log]));
          cached.events.forEach(log => {
            if (log?.id && !byId.has(log.id)) {
              this.data.sampleLibrary.logs.push(log);
              byId.set(log.id, log);
            }
          });
          this.syncHydratedSampleLogsBaseline(cached.events);
        }
        sample.eventsLoaded = true;
        sample.eventsAccessProjectId = accessProjectId;
        this.syncHydratedSamplePatchBaseline(sampleId, {
          eventsLoaded: true,
          eventsAccessProjectId: accessProjectId,
        });
      }
      return cached.events;
    };
    if (photos) {
      if (cached.photosLoaded === true) applyPhotos(cached.photos);
      else if (sample.photosLoaded === true && String(sample.photosAccessProjectId || "") === accessProjectId) {
        applyPhotos(sample.photos || []);
      } else {
        tasks.push(this.fetchSamplePhotos(sampleId, { projectId: accessProjectId }).then(applyPhotos));
      }
    }
    if (events) {
      if (cached.eventsLoaded === true) applyEvents(cached.events);
      else if (!accessProjectId && sample.eventsLoaded === true && String(sample.eventsAccessProjectId || "") === accessProjectId) {
        const existing = (this.data?.sampleLibrary?.logs || [])
          .filter(log => String(log?.sampleId || "") === String(sampleId));
        applyEvents(existing);
      } else {
        tasks.push(this.fetchSampleEvents(sampleId, { projectId: accessProjectId }).then(applyEvents));
      }
    }
    if (tasks.length) {
      await Promise.all(tasks);
    }
    if (renderPanels && this.sampleAccessScopeIsCurrent(accessProjectId)) this.refreshSampleArchivePanels(sampleId);
    return sample;
  },

  async ensureSampleHistoryLoaded(sampleId, { page = 1, pageSize = 20, renderPanels = true, force = false, projectId = "" } = {}) {
    const found = this.findSample(sampleId);
    if (!found) return null;
    if (!this._sampleHistoryCache) this._sampleHistoryCache = {};
    const accessProjectId = this.sampleAccessProjectId(projectId);
    const key = this.sampleHistoryCacheKey(sampleId, accessProjectId);
    const accessEpoch = Number(this._accessEpoch || 0);
    const cached = this._sampleHistoryCache[key];
    if (!force && cached && cached.page === page && cached.pageSize === pageSize && String(cached.projectId || "") === accessProjectId) return cached;
    this._sampleHistoryCache[key] = { loading: true, page, pageSize, projectId: accessProjectId, items: [], total: 0, totalPages: 1 };
    if (renderPanels && this.sampleAccessScopeIsCurrent(accessProjectId)) this.refreshSampleArchivePanels(sampleId);
    try {
      const result = await this.fetchSampleHistory(sampleId, { page, pageSize, projectId: accessProjectId });
      if (accessEpoch !== Number(this._accessEpoch || 0)) return null;
      this._sampleHistoryCache[key] = { ...result, projectId: accessProjectId };
      if (this.sampleAccessScopeIsCurrent(accessProjectId)) {
        found.sample.historyLoaded = true;
        found.sample.historyAccessProjectId = accessProjectId;
        this.syncHydratedSamplePatchBaseline(sampleId, {
          historyLoaded: true,
          historyAccessProjectId: accessProjectId,
        });
        if (renderPanels) this.refreshSampleArchivePanels(sampleId);
      }
      return result;
    } catch (e) {
      this._sampleHistoryCache[key] = { error: e.message || String(e), page, pageSize, projectId: accessProjectId, items: [], total: 0, totalPages: 1 };
      if (renderPanels && this.sampleAccessScopeIsCurrent(accessProjectId)) this.refreshSampleArchivePanels(sampleId);
      throw e;
    }
  },

  // ── 数据包导入导出 ──

  async importBundlePreview(file) {
    const form = new FormData();
    form.append("bundle", file);
    const resp = await fetch("/api/import-bundle/preview", { method: "POST", body: form });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "预览分析失败");
    return json;
  },

  async importBundleCommit(previewId, decisions) {
    const resp = await fetch("/api/import-bundle/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        previewId,
        decisions,
        selection: this._importState?.selection || null,
        accessPolicyMode: this._importState?.accessPolicyMode || "skip",
      }),
    });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "导入失败");
    return json;
  },

  async importSampleArchivePreview(file, targetCategoryId = "") {
    const form = new FormData();
    form.append("bundle", file);
    if (targetCategoryId) form.append("targetCategoryId", targetCategoryId);
    const resp = await fetch("/api/samples/archive/preview", { method: "POST", body: form });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "样机档案预览失败");
    return json;
  },

  async importSampleArchiveCommit(previewId, decisions = {}) {
    const resp = await fetch("/api/samples/archive/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previewId, decisions }),
    });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "样机档案导入失败");
    return json;
  },

});
