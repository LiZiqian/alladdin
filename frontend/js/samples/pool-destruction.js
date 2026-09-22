/* 样机/样机池销毁和关联任务调整。先请求完整影响范围、确认，再提交增量事务；客户端回滚必须尊重新快照。
 * 通过 app.registerModule 暴露方法；页面结构与业务规则沿用原实现。
 */
app.registerModule("samples.pool-destruction", {

  async deleteSampleCategory(id) {
    const request = this.beginDialogRequest?.();
    if (!await this.ensureSampleDestroyImpactScope({ categoryId: id })) return;
    if (this.isDialogRequestCurrent?.(request) === false) return;
    const c = this.sampleCategoryRecords().find(x => x.id === id);
    if (!c) return;
    const impact = this.collectSampleCategoryDestroyImpact(c);
    this.confirmDeleteKeyword(
      "档案销毁",
      "档案销毁会物理删除该样机池、池内样机、照片/CT文件、问题表和样机事件数据。此操作不可恢复。",
      async () => {
        const dataSnapshot = this.dataSnapshot();
        const destroyedIds = new Set((c.samples || []).map(sample => String(sample?.id || "")).filter(Boolean));
        const impactedItems = [
          ...(impact.runningOrBlocked || []),
          ...(impact.pending || [])
        ];
        const affectedSampleIds = new Set();
        impactedItems.forEach(item => {
          (item.allSampleIds || item.task?.sampleIds || []).forEach(id => {
            const sid = String(id || "");
            if (sid && !destroyedIds.has(sid)) affectedSampleIds.add(sid);
          });
        });
        this.applySampleCategoryDestroyImpact(c, impact);
        const taskMutations = impactedItems
          .map(item => this.taskMutationPayloadFor(item.project, item.stage, item.task))
          .filter(item => item?.taskId);
        const affectedSamples = [...affectedSampleIds]
          .map(id => this.findSample(id)?.sample)
          .filter(Boolean);
        const eventSampleIds = new Set([...destroyedIds, ...affectedSampleIds]);
        const sampleEvents = this.sampleEventRecords().filter(log => eventSampleIds.has(String(log?.sampleId || "")));
        const categoryRecords = this.sampleCategoryRecords();
        const categoryIndex = categoryRecords.findIndex(x => x.id === id);
        if (categoryIndex >= 0) categoryRecords.splice(categoryIndex, 1);
        this.patchViewState({ selectedCategoryId: null });
        const saved = await this.commitSampleCategoryMutation(c, {
          action: "destroy_sample_category",
          remark: "样机池档案销毁",
          user: "管理员",
          deleteCategory: true,
          taskMutations,
          samples: affectedSamples,
          sampleEvents,
          render: false
        });
        if (!saved) {
          this.restoreDataSnapshot(dataSnapshot);
          return true;
        }
        this.renderSamples();
        Utils.toast("样机池档案已销毁，关联任务已处理。");
        return false;
      },
      this.sampleCategoryDestroyImpactHtml(impact)
    );
  },

  collectSampleCategoryDestroyImpact(category) {
    const samples = category?.samples || [];
    const sampleIds = new Set(samples.map(s => s.id).filter(Boolean));
    const sampleName = id => {
      const sample = samples.find(s => s.id === id) || this.findSample(id)?.sample;
      return sample ? this.sampleDisplayCode(sample) : id;
    };
    const hasArchive = samples.filter(s =>
      this.sampleHasArchiveData(s) ||
      (s.problemRecords || []).length
    ).length;
    const runningOrBlocked = [];
    const pending = [];
    const defaultProjects = this.projectRecords().filter(project => String(project?.defaultSampleCategoryId || "") === String(category?.id || ""));
    this.projectRecords().forEach(project => (project.stages || []).forEach(stage => (stage.tasks || []).forEach(task => {
      if (!task || task.archived || this.isTaskCompleted(task)) return;
      const matchedIds = (task.sampleIds || []).filter(id => sampleIds.has(id));
      if (!matchedIds.length) return;
      const flow = this.taskFlowStatus(task);
      const item = {
        project, stage, task, flow,
        matchedIds,
        matchedNames: matchedIds.map(sampleName),
        allSampleIds: [...(task.sampleIds || [])],
        allSampleNames: (task.sampleIds || []).map(sampleName)
      };
      if (["进行中", "阻塞中"].includes(flow)) runningOrBlocked.push(item);
      else pending.push(item);
    })));
    return {
      categoryName: category?.name || "未命名样机池",
      sampleCount: samples.length,
      archiveCount: hasArchive,
      defaultProjects,
      runningOrBlocked,
      pending
    };
  },

  sampleCategoryDestroyImpactHtml(impact) {
    const taskLine = item => `
      <li>
        <b>${Utils.esc(item.project.name)} / ${Utils.esc(item.stage.name)} / ${Utils.esc(item.task.testItem || "-")}</b>
        <span>${Utils.esc(item.flow)}；涉及 ${item.matchedNames.map(x => Utils.esc(x)).join("、")}</span>
      </li>`;
    return `<div class="destroy-impact">
      <div class="destroy-impact-title">危险影响确认</div>
      <ul>
        <li><b>将删除样机池：</b><span>${Utils.esc(impact.categoryName)}，共 ${impact.sampleCount} 台样机。</span></li>
        <li><b>档案数据：</b><span>${impact.archiveCount} 台样机含履历/照片/CT/问题表，销毁后会一起物理删除。</span></li>
        <li><b>进行中/阻塞中任务：</b><span>${impact.runningOrBlocked.length} 个任务会被自动设置为"异常终止"，任务样机列表会被清空。</span></li>
        <li><b>未启动任务：</b><span>${impact.pending.length} 个未启动任务会移除被销毁样机，并保留任务等待重新分配。</span></li>
        <li><b>项目默认样机池：</b><span>${(impact.defaultProjects || []).length} 个项目会清除该默认设置，后续分配前需重新选择默认样机池。</span></li>
      </ul>
      ${impact.runningOrBlocked.length ? `<div class="destroy-impact-subtitle">会异常终止的任务</div><ul>${impact.runningOrBlocked.map(taskLine).join("")}</ul>` : ""}
      ${impact.pending.length ? `<div class="destroy-impact-subtitle">会移除样机的未启动任务</div><ul>${impact.pending.map(taskLine).join("")}</ul>` : ""}
    </div>`;
  },

  applySampleCategoryDestroyImpact(category, impact) {
    const samples = category?.samples || [];
    const destroyedIds = new Set(samples.map(s => s.id).filter(Boolean));
    const sampleName = id => {
      const sample = samples.find(s => s.id === id) || this.findSample(id)?.sample;
      return sample ? this.sampleDisplayCode(sample) : id;
    };
    const today = Utils.today();
    const now = Utils.now();
    (impact.runningOrBlocked || []).forEach(item => {
      const task = item.task;
      const oldFlow = item.flow;
      const originalSampleIds = [...(task.sampleIds || [])];
      this.ensureTaskSampleSnapshots?.(task, originalSampleIds, { capturedAt: now, destroyedAt: now });
      const destroyedNames = item.matchedNames.join("、") || "样机";
      const reason = `${destroyedNames} 样机档案被销毁，任务无法继续。`;
      originalSampleIds.filter(id => !destroyedIds.has(id)).forEach(id => {
        if (this.findSample(id)) {
          const otherUsage = this.activeTaskUsagesForSample(id, task.id)[0];
          this.changeSampleStatus(id, otherUsage ? this.statusForOpenTaskUsage(otherUsage.task) : "闲置", {
            user: "管理员",
            source: "样机池档案销毁",
            reason: otherUsage ? `关联任务异常终止，样机仍被其他任务占用；${reason}` : `关联任务异常终止，释放样机；${reason}`,
            projectId: otherUsage?.project?.id || item.project.id,
            stageId: otherUsage?.stage?.id || item.stage.id,
            taskId: otherUsage?.task?.id || task.id,
            testItem: otherUsage?.task?.testItem || task.testItem,
            forceLog: true
          });
        }
      });
      task.sampleIds = [];
      this.transitionTaskStatus(item.stage, task, "异常终止", {
        completedAt: now,
        endDate: today,
        issue: reason
      });
      task.resultDate = today;
      task.latestResult = "不通过";
      this.addTaskLog(task, "样机池档案销毁", {
        user: "管理员",
        reason,
        fromStatus: oldFlow,
        toStatus: "异常终止",
        detail: `已清空任务样机：${originalSampleIds.map(sampleName).join("、") || "-"}`
      });
    });
    (impact.pending || []).forEach(item => {
      const task = item.task;
      const before = [...(task.sampleIds || [])];
      this.ensureTaskSampleSnapshots?.(task, before, { capturedAt: now, destroyedAt: now });
      task.sampleIds = before.filter(id => !destroyedIds.has(id));
      this.addTaskLog(task, "样机池档案销毁", {
        user: "管理员",
        reason: `${item.matchedNames.join("、")} 样机档案被销毁，已从未启动任务中移除。`,
        fromStatus: item.flow,
        toStatus: this.taskFlowStatus(task),
        detail: `任务样机：${before.map(sampleName).join("、") || "-"} → ${(task.sampleIds || []).map(sampleName).join("、") || "空"}`
      });
    });
    (impact.defaultProjects || []).forEach(project => {
      if (String(project?.defaultSampleCategoryId || "") === String(category?.id || "")) {
        project.defaultSampleCategoryId = "";
      }
    });
  },

  sampleHasArchiveData(sample) {
    return !!(
      (sample?.logs || []).length ||
      (sample?.photos || []).length ||
      (sample?.ctData || []).length ||
      (sample?.ctFiles || []).length
    );
  },

  canDestroySample(sample) {
    if (!sample) return { ok: false, reason: "样机不存在。" };
    return { ok: true, reason: "" };
  },

  collectSingleSampleDestroyImpact(sample) {
    const sampleId = sample?.id;
    if (!sampleId) return { runningOrBlocked: [], pending: [], completed: [], sample };
    const runningOrBlocked = [];
    const pending = [];
    const completedTaskRefs = [];
    this.projectRecords().forEach(project => (project.stages || []).forEach(stage => (stage.tasks || []).forEach(task => {
      if (!task || task.archived) return;
      if (!(task.sampleIds || []).includes(sampleId) && !(task.removedSampleRecords || []).some(item => item?.sampleId === sampleId)) return;
      const flow = this.taskFlowStatus(task);
      const item = { project, stage, task, flow };
      if (this.isTaskCompleted(task)) completedTaskRefs.push(item);
      else if (["进行中", "阻塞中"].includes(flow)) runningOrBlocked.push(item);
      else pending.push(item);
    })));
    return { runningOrBlocked, pending, completed: completedTaskRefs, sample };
  },

  singleSampleDestroyImpactHtml(impact) {
    const name = impact.sample ? this.sampleDisplayCode(impact.sample) : "样机";
    const archiveCount = impact.sample && this.sampleHasArchiveData(impact.sample) ? 1 : 0;
    const runningCount = (impact.runningOrBlocked || []).length;
    const pendingCount = (impact.pending || []).length;
    const completedCount = (impact.completed || []).length;
    const taskLine = item => `<li><b>${Utils.esc(item.project.name)} / ${Utils.esc(item.stage.name)} / ${Utils.esc(item.task.testItem || "-")}</b><span>${Utils.esc(item.flow)}</span></li>`;
    return `<div class="destroy-impact">
      <div class="destroy-impact-title">危险影响确认</div>
      <ul>
        <li><b>将销毁样机：</b><span>${Utils.esc(name)}${archiveCount ? "，含履历/照片/CT/问题表" : ""}。</span></li>
        ${runningCount ? `<li><b>进行中/阻塞中任务：</b><span>${runningCount} 个任务会被自动设置为"异常终止"，任务样机列表会被清空。</span></li>` : ""}
        ${pendingCount ? `<li><b>未启动任务：</b><span>${pendingCount} 个未启动任务会移除该样机，并保留任务等待重新分配。</span></li>` : ""}
        ${completedCount ? `<li><b>已完成任务：</b><span>${completedCount} 个已完成任务不受影响，依赖样机快照继续展示历史。</span></li>` : ""}
        ${!runningCount && !pendingCount && !completedCount ? `<li><b>无关联任务</b><span>该样机未关联任何任务。</span></li>` : ""}
      </ul>
      ${runningCount ? `<div class="destroy-impact-subtitle">会异常终止的任务</div><ul>${(impact.runningOrBlocked || []).map(taskLine).join("")}</ul>` : ""}
      ${pendingCount ? `<div class="destroy-impact-subtitle">会移除样机的未启动任务</div><ul>${(impact.pending || []).map(taskLine).join("")}</ul>` : ""}
      ${completedCount ? `<div class="destroy-impact-subtitle">已有快照的已完成任务</div><ul>${(impact.completed || []).map(taskLine).join("")}</ul>` : ""}
    </div>`;
  },

  applySingleSampleDestroyImpact(sample, impact) {
    const sampleId = sample.id;
    const destroyedName = this.sampleDisplayCode(sample);
    const today = Utils.today();
    const now = Utils.now();
    // 处理进行中/阻塞中任务 → 异常终止
    (impact.runningOrBlocked || []).forEach(item => {
      const task = item.task;
      const oldFlow = item.flow;
      const originalSampleIds = [...(task.sampleIds || [])];
      const reason = `${destroyedName} 样机档案被销毁，任务无法继续。`;
      // 释放该任务下其它样机
      originalSampleIds.filter(id => id !== sampleId).forEach(id => {
        if (this.findSample(id)) {
          const otherUsage = this.activeTaskUsagesForSample(id, task.id)[0];
          this.changeSampleStatus(id, otherUsage ? this.statusForOpenTaskUsage(otherUsage.task) : "闲置", {
            user: "管理员",
            source: "样机档案销毁",
            reason: otherUsage ? `关联任务异常终止，样机仍被其他任务占用；${reason}` : `关联任务异常终止，释放样机；${reason}`,
            projectId: otherUsage?.project?.id || item.project.id,
            stageId: otherUsage?.stage?.id || item.stage.id,
            taskId: otherUsage?.task?.id || task.id,
            testItem: otherUsage?.task?.testItem || task.testItem,
            forceLog: true
          });
        }
      });
      // 记录退出样机
      this.recordTaskRemovedSamples(task, [sampleId], { user: "管理员", reason, removedAt: now, destroyedAt: now });
      task.sampleIds = [];
      this.transitionTaskStatus(item.stage, task, "异常终止", {
        completedAt: now,
        endDate: today,
        issue: reason
      });
      task.resultDate = today;
      task.latestResult = "不通过";
      this.addTaskLog(task, "样机档案销毁", {
        user: "管理员",
        reason,
        fromStatus: oldFlow,
        toStatus: "异常终止",
        detail: `已清空任务样机：${originalSampleIds.map(id => this.taskSampleDisplayName(id)).join("、") || "-"}`
      });
    });
    // 处理待下发任务 → 仅移除样机，不终止任务
    (impact.pending || []).forEach(item => {
      const task = item.task;
      const before = [...(task.sampleIds || [])];
      const reason = `${destroyedName} 样机档案被销毁，已从未启动任务中移除。`;
      this.recordTaskRemovedSamples(task, [sampleId], { user: "管理员", reason, removedAt: now, destroyedAt: now });
      task.sampleIds = before.filter(id => id !== sampleId);
      this.addTaskLog(task, "样机档案销毁", {
        user: "管理员",
        reason,
        fromStatus: item.flow,
        toStatus: this.taskFlowStatus(task),
        detail: `任务样机：${before.map(id => this.taskSampleDisplayName(id)).join("、") || "-"} → ${(task.sampleIds || []).map(id => this.taskSampleDisplayName(id)).join("、") || "空"}`
      });
    });
    // 已完成任务：不做任何修改，快照已在 attachSampleSnapshotToTasks 中保存
  },

  async destroySample(sampleId) {
    const request = this.beginDialogRequest?.();
    if (!await this.ensureSampleDestroyImpactScope({ sampleId })) return;
    if (this.isDialogRequestCurrent?.(request) === false) return;
    const found = this.findSample(sampleId);
    if (!found) return;
    const check = this.canDestroySample(found.sample);
    if (!check.ok) { alert(check.reason); return; }
    const impact = this.collectSingleSampleDestroyImpact(found.sample);
    this.confirmDeleteKeyword(
      "档案销毁",
      `档案销毁会物理删除 ${this.sampleDisplayCode(found.sample)} 的样机档案、照片/CT文件和样机事件数据。此操作不可恢复。`,
      async () => {
        const dataSnapshot = this.dataSnapshot();
        const impactedItems = [
          ...(impact.runningOrBlocked || []),
          ...(impact.pending || [])
        ];
        const affectedSampleIds = new Set();
        impactedItems.forEach(item => {
          (item.task?.sampleIds || []).forEach(id => {
            const sid = String(id || "");
            if (sid && sid !== sampleId) affectedSampleIds.add(sid);
          });
        });
        // 处理任务影响
        this.applySingleSampleDestroyImpact(found.sample, impact);
        // 写入样机销毁日志（在物理删除前）
        this.changeSampleStatus(sampleId, "已退库", {
          user: "管理员",
          source: "样机档案销毁",
          reason: "样机档案被销毁，物理删除前记录最终状态",
          forceLog: true
        });
        const taskMutations = impactedItems
          .map(item => this.taskMutationPayloadFor(item.project, item.stage, item.task))
          .filter(item => item?.taskId);
        const affectedSamples = [...affectedSampleIds]
          .map(id => this.findSample(id)?.sample)
          .filter(Boolean);
        const eventSampleIds = new Set([sampleId, ...affectedSampleIds]);
        const sampleEvents = this.sampleEventRecords().filter(log => eventSampleIds.has(String(log?.sampleId || "")));
        // 物理删除
        found.category.samples = (found.category.samples || []).filter(s => s.id !== sampleId);
        const saved = await this.commitSampleMutation(found.sample, {
          action: "destroy_sample",
          remark: "样机档案销毁",
          user: "管理员",
          deleteSample: true,
          taskMutations,
          samples: affectedSamples,
          sampleEvents
        });
        if (!saved) {
          this.restoreDataSnapshot(dataSnapshot);
          return true;
        }
        Utils.toast("样机档案已销毁，关联任务已处理。");
        return false;
      },
      this.singleSampleDestroyImpactHtml(impact)
    );
  },

  confirmDeleteKeyword(title, message, onConfirm, detailsHtml = "") {
    this.showModal(title, `
      <div class="delete-confirm">
        <p>${Utils.esc(message)}</p>
        ${detailsHtml || ""}
        <label>请输入 <strong>DELETE</strong> 确认销毁：</label>
        <input id="deleteKeywordInput" autocomplete="off" autofocus>
        <div id="deleteKeywordError" class="delete-confirm-error" style="display:none">请输入 DELETE 后才能继续。</div>
      </div>
    `, () => {
      const input = document.getElementById("deleteKeywordInput");
      const error = document.getElementById("deleteKeywordError");
      if ((input?.value || "") !== "DELETE") {
        if (error) error.style.display = "block";
        input?.focus();
        return true;
      }
      return onConfirm?.();
    }, "确认销毁");
    document.getElementById("deleteKeywordInput")?.focus();
  },

});
