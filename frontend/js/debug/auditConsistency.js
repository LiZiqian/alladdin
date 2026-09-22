/* ========================================
   数字治理平台 V7 - 只读一致性审计脚本
   ----------------------------------------
   用途：在浏览器控制台执行 app.auditConsistency()，
        对当前内存数据快照做只读一致性检查。
   严格只读：本脚本不修改任何数据、不触发 save / render。
   覆盖检查：
     1. 同一样机预约时间重叠或同时执行（与服务端规则对齐）
     2. 任务引用了已删除的策略池 progress（任务快照独立性 B2 影响面）
     3. 任务引用了不存在的样机档案
     4. 样机当前 status 与任务占用关系不一致
     5. 问题单记录缺失 projectId/stageId（taskIssueRecordHtml 空态隐患）
     6. 重复的任务 id / 样机 id
   ======================================== */

app.registerModule("debug.auditConsistency", {

  // 与 taskFlowStatus() 返回的标准完成状态对齐
  _auditFinishedStatuses: ["正常完成", "异常终止"],

  _auditIsTaskActive(task) {
    if (!task) return false;
    if (task.archived || task.completed) return false;
    const status = String(task.status || "").trim();
    if (this._auditFinishedStatuses.includes(status)) return false;
    return true;
  },

  _auditReservationsConflict(a, b) {
    if ([a, b].every(task => ["进行中", "阻塞中"].includes(task.status))) return true;
    const range = task => {
      const dates = [task.planStartDate || task.planDate || "", task.planEndDate || task.endDate || ""];
      if (!dates.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)) return null;
      return dates[0] <= dates[1] ? dates : null;
    };
    const left = range(a), right = range(b);
    return !left || !right || (left[0] <= right[1] && right[0] <= left[1]);
  },

  /**
   * 只读一致性审计。返回结构化报告对象，并在控制台分组打印。
   * 不修改任何状态。
   */
  auditConsistency({ log = true } = {}) {
    const data = typeof this.dataSnapshot === "function" ? this.dataSnapshot() : {};
    const projects = data.projects || [];
    const report = {
      generatedAt: new Date().toISOString(),
      summary: {},
      sampleOccupancyConflicts: [],
      orphanProgressTasks: [],
      missingSampleRefs: [],
      sampleStatusMismatch: [],
      issueRecordMissingContext: [],
      duplicateTaskIds: [],
      duplicateSampleIds: [],
    };

    // 样机档案索引
    const sampleIndex = new Map();
    (data.sampleLibrary?.categories || []).forEach(cat => {
      (cat.samples || []).forEach(s => {
        if (!s || !s.id) return;
        if (sampleIndex.has(s.id)) {
          report.duplicateSampleIds.push(String(s.id));
        } else {
          sampleIndex.set(s.id, s);
        }
      });
    });

    // 遍历任务
    const occupancy = new Map(); // sampleId -> [{taskId, testItem, projectId, stageId}]
    const seenTaskIds = new Set();

    projects.forEach(project => {
      (project.stages || []).forEach(stage => {
        const progressIds = new Set((stage.progress || []).map(p => p.id));
        (stage.tasks || []).forEach(task => {
          if (!task) return;
          // 重复任务 id
          if (task.id) {
            if (seenTaskIds.has(task.id)) report.duplicateTaskIds.push(String(task.id));
            else seenTaskIds.add(task.id);
          }
          // 引用已删除 progress
          if (task.progressId && !progressIds.has(task.progressId) && !task.archived) {
            report.orphanProgressTasks.push({
              taskId: task.id,
              progressId: task.progressId,
              projectId: project.id,
              stageId: stage.id,
              testItem: task.testItem || "",
              hasSnapshot: !!(task.category || task.testItem),
            });
          }
          // 样机引用 + 占用
          const sampleIds = task.sampleIds || [];
          sampleIds.forEach(sid => {
            if (!sampleIndex.has(sid)) {
              report.missingSampleRefs.push({
                taskId: task.id,
                sampleId: sid,
                projectId: project.id,
                stageId: stage.id,
              });
            }
            if (this._auditIsTaskActive(task)) {
              if (!occupancy.has(sid)) occupancy.set(sid, []);
              occupancy.get(sid).push({
                taskId: task.id,
                testItem: task.testItem || "",
                projectId: project.id,
                stageId: stage.id,
                status: task.status || "",
                planStartDate: task.planStartDate || task.planDate || "",
                planEndDate: task.planEndDate || task.endDate || "",
              });
            }
          });
          // 问题单上下文缺失
          const r = task.issueRecord;
          if (r && (r.dtsNo || r.isIssue) && (!task.projectId || !task.stageId)) {
            report.issueRecordMissingContext.push({
              taskId: task.id,
              projectId: task.projectId || "",
              stageId: task.stageId || "",
            });
          }
        });
      });
    });

    // 占用冲突
    occupancy.forEach((tasks, sid) => {
      if (tasks.some((task, index) => tasks.slice(index + 1).some(other => this._auditReservationsConflict(task, other)))) {
        const sample = sampleIndex.get(sid);
        report.sampleOccupancyConflicts.push({
          sampleId: sid,
          sampleNo: sample?.sampleNo || sample?.sn || "",
          tasks,
        });
      }
    });

    // 样机状态与占用一致性（只读对比，不修正）
    sampleIndex.forEach((sample, sid) => {
      const active = occupancy.get(sid) || [];
      const status = String(sample.status || "").trim();
      const occupiedStatuses = ["在位等待", "测试中"];
      if (active.length && status && !occupiedStatuses.includes(status) && status === "闲置") {
        report.sampleStatusMismatch.push({
          sampleId: sid,
          sampleNo: sample.sampleNo || sample.sn || "",
          status,
          activeTaskCount: active.length,
          note: "样机标记为闲置，但仍被未完成任务占用",
        });
      }
    });

    report.summary = {
      projects: projects.length,
      samples: sampleIndex.size,
      sampleOccupancyConflicts: report.sampleOccupancyConflicts.length,
      orphanProgressTasks: report.orphanProgressTasks.length,
      missingSampleRefs: report.missingSampleRefs.length,
      sampleStatusMismatch: report.sampleStatusMismatch.length,
      issueRecordMissingContext: report.issueRecordMissingContext.length,
      duplicateTaskIds: report.duplicateTaskIds.length,
      duplicateSampleIds: report.duplicateSampleIds.length,
    };

    if (log && typeof console !== "undefined") {
      const c = console;
      c.group?.("%c[一致性审计] 只读报告", "color:#2563eb;font-weight:700");
      c.table?.(report.summary);
      if (report.sampleOccupancyConflicts.length) {
        c.warn("样机预约时间重叠或同时执行：", report.sampleOccupancyConflicts);
      }
      if (report.orphanProgressTasks.length) {
        c.warn("任务引用已删除的策略池 progress（依赖任务快照继续执行）：", report.orphanProgressTasks);
      }
      if (report.missingSampleRefs.length) {
        c.warn("任务引用了不存在的样机档案：", report.missingSampleRefs);
      }
      if (report.sampleStatusMismatch.length) {
        c.warn("样机状态与占用关系不一致：", report.sampleStatusMismatch);
      }
      if (report.issueRecordMissingContext.length) {
        c.warn("问题单记录缺失 projectId/stageId：", report.issueRecordMissingContext);
      }
      if (report.duplicateTaskIds.length) c.warn("重复任务 id：", report.duplicateTaskIds);
      if (report.duplicateSampleIds.length) c.warn("重复样机 id：", report.duplicateSampleIds);
      const total = Object.values(report.summary).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0)
        - report.summary.projects - report.summary.samples;
      c.log(total === 0 ? "%c未发现一致性问题。" : `%c共发现 ${total} 类问题项，详见上方分组。`,
        total === 0 ? "color:#16a34a;font-weight:700" : "color:#d97706;font-weight:700");
      c.groupEnd?.();
    }

    return report;
  },

});
