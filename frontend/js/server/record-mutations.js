/* 项目、阶段、样机与样机池提交。各方法保留独立的刷新/失效范围，不把业务差异压进通用配置对象。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.record-mutations", {

  async commitProjectMutation(project, { action = "project_mutation", remark = "项目增量变更", user = "", createIfMissing = false, deleteProject = false, samples = [], sampleEvents = [], render = true } = {}) {
    if (!project?.id) return false;
    const payload = this.cloneData({
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
    });
    const release = await this.beginServerMutation();
    if (!release) return false;
    payload.revision = this.serverRevision;
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(project.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (await this.handleMutationRevisionConflict(resp, json)) return false;
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.acceptMutationResult(payload, json);
      this.invalidateSampleHistoryCache([...(samples || []).map(s => s?.id), ...(sampleEvents || []).map(log => log?.sampleId)]);
      this.invalidatePagedCaches();
      if (render) this.render();
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("项目增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("项目增量保存失败：" + e.message);
      return false;
    } finally {
      release();
    }
  },

  async commitStageMutation(project, stage, { action = "stage_mutation", remark = "阶段增量变更", user = "", createIfMissing = false, deleteStage = false, samples = [], sampleEvents = [], render = true } = {}) {
    if (!project?.id || !stage?.id) return false;
    const payload = this.cloneData({
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
    });
    const release = await this.beginServerMutation();
    if (!release) return false;
    payload.revision = this.serverRevision;
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/stages/${encodeURIComponent(stage.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (await this.handleMutationRevisionConflict(resp, json)) return false;
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.acceptMutationResult(payload, json);
      this.invalidateSampleHistoryCache([...(samples || []).map(s => s?.id), ...(sampleEvents || []).map(log => log?.sampleId)]);
      this.invalidatePagedCaches({ stageId: stage.id });
      if (render) this.render();
      else if (!deleteStage && !this.stageStrategyId?.()
        && this.currentProject()?.id === project.id
        && this.isCurrentProjectWorkspaceStage?.(stage.id)) {
        // A strategy save can finish after breadcrumb navigation has already
        // started a task read. Replace the request invalidated above, even
        // when the editor requested a silent save.
        this.refreshCurrentTaskFlowPage?.(project, stage);
      }
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("阶段增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("阶段增量保存失败：" + e.message);
      return false;
    } finally {
      release();
    }
  },

  async commitSampleMutation(sample, { action = "sample_mutation", remark = "样机增量变更", user = "", deleteSample = false, taskMutations = [], samples = [], sampleEvents = null, render = true } = {}) {
    if (!sample?.id) return false;
    const events = sampleEvents || (this.data?.sampleLibrary?.logs || []).filter(log => String(log?.sampleId || "") === String(sample.id));
    const payload = this.cloneData({
      revision: this.serverRevision,
      sampleId: sample.id,
      sample: deleteSample ? null : this.compactSampleForMutation(sample),
      samples: (samples || []).map(s => this.compactSampleForMutation(s)).filter(Boolean),
      sampleEvents: events,
      taskMutations,
      action,
      remark,
      user,
      deleteSample,
    });
    const release = await this.beginServerMutation();
    if (!release) return false;
    payload.revision = this.serverRevision;
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/samples/${encodeURIComponent(sample.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (await this.handleMutationRevisionConflict(resp, json)) return false;
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.acceptMutationResult(payload, json);
      this.invalidateSampleHistoryCache([sample.id, ...(samples || []).map(s => s?.id), ...(events || []).map(log => log?.sampleId)]);
      await this.refreshSampleListAfterMutation(sample, { render, affected: json.affected });
      this.syncSampleReadMetadataBaseline([sample.id, ...(samples || []).map(item => item.id)]);
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("样机增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("样机增量保存失败：" + e.message);
      return false;
    } finally {
      release();
    }
  },

  async commitSampleCategoryMutation(category, { action = "sample_category_mutation", remark = "样机池增量变更", user = "", createIfMissing = false, createSamples = false, deleteCategory = false, taskMutations = [], samples = [], sampleEvents = [], render = true } = {}) {
    if (!category?.id) return false;
    const payload = this.cloneData({
      revision: this.serverRevision,
      categoryId: category.id,
      category: this.compactSampleCategoryForMutation(category),
      samples: (samples || []).map(s => this.compactSampleForMutation(s)).filter(Boolean),
      sampleEvents: sampleEvents || [],
      taskMutations,
      action,
      remark,
      user,
      createIfMissing,
      createSamples,
      deleteCategory,
    });
    const release = await this.beginServerMutation();
    if (!release) return false;
    payload.revision = this.serverRevision;
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/sample-categories/${encodeURIComponent(category.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (await this.handleMutationRevisionConflict(resp, json)) return false;
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.acceptMutationResult(payload, json);
      this.invalidateSampleHistoryCache([...(samples || []).map(s => s?.id), ...(sampleEvents || []).map(log => log?.sampleId)]);
      if (createSamples && !deleteCategory) {
        await this.refreshSampleListAfterMutation(category, { render, affected: json.affected });
        this.syncSampleReadMetadataBaseline((samples || []).map(sample => sample.id));
      } else {
        this.invalidatePagedCaches({ categoryId: category.id });
        if (render) this.render();
      }
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("样机池增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("样机池增量保存失败：" + e.message);
      return false;
    } finally {
      release();
    }
  },

});
