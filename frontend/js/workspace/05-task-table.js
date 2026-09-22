/* ========================================
   数字治理平台 V7 - 任务表格展示模块
   ======================================== */

app.registerModule("workspace.taskTable", {

  taskRowsForStage(stage) {
    const progress = stage.progress || [];
    const tasks = this.activeStageTasks(stage);
    const progressById = new Map(progress.map(p => [p.id, p]));
    return tasks.map((t, idx) => ({
      key: t.id || `${t.progressId || "task"}_${idx}`,
      progress: progressById.get(t.progressId) || null,
      task: t
    }));
  },

  taskInfoForRow(stage, row) {
    const p = row.progress || {};
    const t = row.task || {};
    const skuIndex = t.skuIndex || p.skuIndex || 1;
    const category = t.category || p.category || "";
    const testItem = t.testItem || p.testItem || "";
    const owner = t.owner || "";
    const sampleIds = t.sampleIds || [];
    const flowStatus = row.task ? this.taskFlowStatus(t) : "待下发";
    const planStartDate = t.planStartDate || t.planDate || "";
    const planEndDate = t.planEndDate || "";
    return {
      sku: stage.skuNames[skuIndex - 1] || `SKU${skuIndex}`,
      skuIndex,
      category,
      testItem,
      categoryItem: this.taskCategoryItemText(category, testItem),
      owner,
      ownerName: this.taskOwnerName(owner),
      ownerId: this.taskOwnerId(owner),
      planStartDate,
      planEndDate,
      startDate: t.startDate || "",
      endDate: t.endDate || "",
      sampleIds,
      flowStatus
    };
  },

  boundedListPageSize(value, fallback = 100) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(500, Math.max(20, n));
  },

  taskFlowPagerHtml(page, totalPages, total, pageSize, { loading = false } = {}) {
    const pageBtn = (label, target, disabled = false) => `
      <button type="button" class="btn btn-sm btn-outline" ${disabled || loading ? "disabled" : `data-app-action="task-flow-page" data-value="${target}"`}>${label}</button>`;
    return `
      <div class="list-pager task-flow-pager ${loading ? "is-loading" : ""}">
        <div class="list-pager-controls">
          ${pageBtn("上一页", page - 1, page <= 1)}
          <span class="path">第 ${page} / ${totalPages} 页</span>
          ${pageBtn("下一页", page + 1, page >= totalPages)}
          <select data-app-action="task-flow-page-size" data-app-events="change">
            ${[25, 50, 100, 200, 500].map(size => `<option value="${size}" ${pageSize === size ? "selected" : ""}>每页 ${size}</option>`).join("")}
          </select>
          ${loading ? `<span class="path list-pager-loading">加载中...</span>` : ""}
        </div>
      </div>`;
  },

  setTaskFlowPage(page) {
    this.setTaskFlowPageState(page);
    this.renderPreserveScroll();
  },

  setTaskFlowPageSize(size) {
    this.setTaskFlowPageSizeState(size, 25);
    this.renderPreserveScroll();
  },

  taskFlowQueryParams(stage) {
    const state = this.taskFlowPageState(25);
    const f = state.filters || {};
    const params = {
      page: state.page,
      pageSize: state.pageSize
    };
    ["sku", "flowStatus", "ownerName", "categoryKeyword", "caseKeyword", "dtsKeyword", "resultKeyword"].forEach(key => {
      const value = String(f[key] || "").trim();
      if (value) params[key] = value;
    });
    params.stageId = stage?.id || "";
    return params;
  },

  taskFlowCacheKey(stage, params) {
    return JSON.stringify({ stageId: stage?.id || "", ...params });
  },

  beginTaskFlowPageRequest(stage, key) {
    const request = {
      sequence: (Number(this._taskFlowRequestSequence) || 0) + 1,
      stageId: String(stage?.id || ""),
      key
    };
    this._taskFlowRequestSequence = request.sequence;
    this._taskFlowActiveRequest = request;
    this._taskFlowLoadingKey = key;
    return request;
  },

  isCurrentTaskFlowPageRequest(request, stage) {
    if (!request || this._taskFlowActiveRequest?.sequence !== request.sequence) return false;
    if (String(stage?.id || "") !== request.stageId) return false;
    return this.taskFlowCacheKey(stage, this.taskFlowQueryParams(stage)) === request.key;
  },

  finishTaskFlowPageRequest(request) {
    if (!request || this._taskFlowActiveRequest?.sequence !== request.sequence) return false;
    this._taskFlowActiveRequest = null;
    this._taskFlowLoadingKey = "";
    return true;
  },

  storeTaskFlowPageResult(project, stage, key, result = {}) {
    const currentProject = this.findProjectRecord?.(project?.id);
    if (currentProject) {
      project = currentProject;
      stage = project.stages?.find(item => item.id === stage?.id);
      if (!stage) return null;
    }
    const rows = result.rows || [];
    const byId = new Map((stage.tasks || []).map(task => [String(task.id || ""), task]));
    const baseStage = this._baseData?.projects?.find(item => item.id === project?.id)?.stages?.find(item => item.id === stage.id);
    const baselineById = new Map((baseStage?.tasks || []).map(task => [String(task.id), task]));
    const baselineTasks = [];
    rows.forEach(row => {
      const task = row.task;
      if (!task?.id) return;
      baselineTasks.push(task);
      const existing = byId.get(String(task.id));
      if (existing) {
        const baseline = baselineById.get(String(task.id));
        Object.entries(task).forEach(([field, value]) => {
          if (!baseline || JSON.stringify(existing[field]) === JSON.stringify(baseline[field])) existing[field] = value;
        });
        row.task = existing;
      } else {
        if (!Array.isArray(stage.tasks)) stage.tasks = [];
        stage.tasks.push(task);
      }
    });
    // Page statistics respect owner/keyword/SKU filters. Keep them in the page
    // cache; only an unfiltered read can replace the whole-stage summary.
    const summaryQuery = { ...this.taskFlowQueryParams(stage), flowStatus: "" };
    const hasSummaryFilters = this.taskFlowQueryHasFilters?.(summaryQuery);
    if (result.stats && !hasSummaryFilters) {
      stage.taskCount = Number(result.stats.totalInStage ?? result.total ?? stage.taskCount ?? 0);
      stage.statusCounts = result.stats.statusCounts || stage.statusCounts || {};
      stage.ownerNames = result.stats.ownerNames || stage.ownerNames || [];
    }
    this.syncHydratedStageBaseline?.(project?.id, {
      id: stage.id,
      taskCount: stage.taskCount,
      statusCounts: stage.statusCounts || {},
      ownerNames: stage.ownerNames || [],
    });
    baselineTasks.forEach(task => {
      this.syncHydratedTaskBaseline?.(project?.id, stage.id, task);
    });
    this._taskFlowPageCache = { key, stageId: stage.id, ...result, rows };
    this.hydrateTaskFlowReferenceSamples(project, stage, rows, key);
    return this._taskFlowPageCache;
  },

  hydrateTaskFlowReferenceSamples(project, stage, rows = [], key = "") {
    if (typeof this.ensureTaskReferenceSamplesLoaded !== "function") return null;
    const pending = (rows || [])
      .map(row => row?.task)
      .filter(Boolean)
      .map(task => this.ensureTaskReferenceSamplesLoaded(task))
      .filter(item => item?.then);
    if (!pending.length) return null;
    const refreshKey = key;
    const cache = this._taskFlowPageCache;
    return Promise.allSettled(pending).then(() => {
      if (
        refreshKey
        && this._taskFlowPageCache === cache
        && this._taskFlowPageCache?.key === refreshKey
        && this.isCurrentProjectWorkspaceStage?.(stage?.id)
      ) {
        this.refreshTaskFlowRegion(project, stage);
      }
    });
  },

  refreshTaskFlowRegion(project, stage) {
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return false;
    const currentProject = this.findProjectRecord?.(project?.id);
    if (currentProject) {
      project = currentProject;
      stage = project.stages?.find(item => item.id === stage?.id);
      if (!stage) return false;
    }
    const shell = document.getElementById("taskFlowShell");
    if (!shell || shell.dataset.stageId !== String(stage?.id || "")) return false;
    shell.dataset.pageKey = this.taskFlowCacheKey(stage, this.taskFlowQueryParams(stage));
    this.replaceHtml(shell, this.workspaceTaskFlowContentHtml(project, stage));
    this.updateSelectPlaceholderState?.(shell);
    this.refreshStageSummaryMetrics?.(stage);
    return true;
  },

  async refreshCurrentTaskFlowPage(project, stage) {
    if (!stage?.id || typeof this.fetchStageTasksPage !== "function") return false;
    const params = this.taskFlowQueryParams(stage);
    const key = this.taskFlowCacheKey(stage, params);
    const request = this.beginTaskFlowPageRequest(stage, key);
    try {
      const result = await this.fetchStageTasksPage(stage.id, params);
      if (!this.isCurrentTaskFlowPageRequest(request, stage)) return false;
      this.finishTaskFlowPageRequest(request);
      this.storeTaskFlowPageResult(project, stage, key, result);
      if (this.isCurrentProjectWorkspaceStage(stage.id)) {
        if (!this.refreshTaskFlowRegion(project, stage)) {
          if (typeof this.renderContent === "function") this.renderContent();
          else this.renderPreserveScroll();
        }
      }
      return true;
    } catch (e) {
      if (!this.isCurrentTaskFlowPageRequest(request, stage)) return false;
      this.finishTaskFlowPageRequest(request);
      this._taskFlowPageCache = { key, stageId: stage.id, error: e.message, rows: [], page: params.page, pageSize: params.pageSize, total: 0, totalPages: 1 };
      console.error("任务分页刷新失败：", e);
      if (this.isCurrentProjectWorkspaceStage(stage.id)) {
        if (!this.refreshTaskFlowRegion(project, stage)) {
          if (typeof this.renderContent === "function") this.renderContent();
          else this.renderPreserveScroll();
        }
      }
      return false;
    }
  },

  loadTaskFlowPage(project, stage, key, params) {
    if (!stage?.id || (this._taskFlowActiveRequest?.key === key && this._taskFlowActiveRequest?.stageId === String(stage.id))) return;
    const request = this.beginTaskFlowPageRequest(stage, key);
    this.fetchStageTasksPage(stage.id, params)
      .then(result => {
        if (!this.isCurrentTaskFlowPageRequest(request, stage)) return;
        this.finishTaskFlowPageRequest(request);
        this.storeTaskFlowPageResult(project, stage, key, result);
        if (this.isCurrentProjectWorkspaceStage(stage.id)) {
          this.refreshTaskFlowRegion(project, stage) || this.renderPreserveScroll();
        }
      })
      .catch(e => {
        if (!this.isCurrentTaskFlowPageRequest(request, stage)) return;
        this.finishTaskFlowPageRequest(request);
        this._taskFlowPageCache = { key, stageId: stage.id, error: e.message, rows: [] };
        console.error("任务分页加载失败：", e);
        if (this.isCurrentProjectWorkspaceStage(stage.id)) {
          this.refreshTaskFlowRegion(project, stage) || this.renderPreserveScroll();
        }
      });
  },

  retryTaskFlowPage() {
    const project = this.currentProject();
    const stage = this.currentStage();
    if (!project || !stage?.id) return false;
    const params = this.taskFlowQueryParams(stage);
    const key = this.taskFlowCacheKey(stage, params);
    this._taskFlowPageCache = null;
    this.cancelTaskFlowPageRequestState?.(stage.id);
    this.loadTaskFlowPage(project, stage, key, params);
    this.refreshTaskFlowRegion(project, stage) || this.renderPreserveScroll();
    return true;
  },

  workspaceTaskFlowHtml(project, stage) {
    const params = this.taskFlowQueryParams(stage);
    return `<div id="taskFlowShell" class="task-flow-shell" data-stage-id="${Utils.esc(stage?.id || "")}" data-page-key="${Utils.esc(this.taskFlowCacheKey(stage, params))}">
      ${this.workspaceTaskFlowContentHtml(project, stage)}
    </div>`;
  },

  workspaceTaskFlowContentHtml(project, stage) {
    const f = this.taskFlowPageState(25).filters || {};
    const filterDrafts = this.ensureViewMap("taskFlowFilterDrafts");
    const textFilterValue = field => Object.prototype.hasOwnProperty.call(filterDrafts, field)
      ? filterDrafts[field]
      : (f[field] || "");
    const params = this.taskFlowQueryParams(stage);
    const cacheKey = this.taskFlowCacheKey(stage, params);
    const cached = this._taskFlowPageCache?.key === cacheKey ? this._taskFlowPageCache : null;
    if (!cached) this.loadTaskFlowPage(project, stage, cacheKey, params);
    const localRows = cached ? [] : (this._statePartial ? [] : this.taskRowsForStage(stage));
    const stageTaskTotal = Number(stage.taskCount ?? localRows.length) || 0;
    const pageSize = params.pageSize;
    const total = cached?.total ?? stageTaskTotal;
    const totalPages = cached?.totalPages ?? Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, cached?.page || params.page), totalPages);
    this.setTaskFlowPageState(page);
    const rows = cached?.rows || [];
    const pagerHtml = this.taskFlowPagerHtml(page, totalPages, total, pageSize, { loading: !cached });

    const statusCounts = cached?.stats?.statusCounts || stage.statusCounts || {};
    const ownerNames = cached?.stats?.ownerNames || stage.ownerNames || [];
    const hasServerCounts = cached || Object.keys(statusCounts).length > 0 || typeof stage.taskCount !== "undefined";
    const infos = (cached ? rows : localRows).map(row => this.taskInfoForRow(stage, row));
    const localStatusCounts = cached ? {} : infos.reduce((acc, i) => {
      acc[i.flowStatus] = (acc[i.flowStatus] || 0) + 1;
      return acc;
    }, {});
    const pendingTasks = hasServerCounts ? (statusCounts["待下发"] || 0) : (localStatusCounts["待下发"] || 0);
    const runningTasks = hasServerCounts ? (statusCounts["进行中"] || 0) : (localStatusCounts["进行中"] || 0);
    const blockedTasks = hasServerCounts ? (statusCounts["阻塞中"] || 0) : (localStatusCounts["阻塞中"] || 0);
    const abnormalTasks = hasServerCounts ? (statusCounts["异常终止"] || 0) : (localStatusCounts["异常终止"] || 0);
    const finishedTasks = hasServerCounts ? (statusCounts["正常完成"] || 0) : (localStatusCounts["正常完成"] || 0);
    const totalTasks = cached?.stats?.totalInStage ?? stageTaskTotal;

    const optHtml = (values, cur) => {
      const arr = [...new Set((values || []).map(v => String(v ?? "").trim()).filter(v => v))].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
      return `<option value="">全部</option>` + arr.map(v => `<option value="${Utils.esc(v)}" ${String(cur || "") === v ? 'selected' : ''}>${Utils.esc(v)}</option>`).join("");
    };
    const skuOptions = `<option value="">全部</option>` + (stage.skuNames || []).map((name, idx) => {
      const value = String(idx + 1);
      return `<option value="${value}" ${String(f.sku || "") === value ? "selected" : ""}>${Utils.esc(name || `SKU${idx + 1}`)}</option>`;
    }).join("");
    const loadingRow = !cached
      ? `<tr><td colspan="10" class="empty">正在加载服务器分页数据...</td></tr>`
      : (cached.error ? `<tr><td colspan="10" class="empty">任务分页加载失败：${Utils.esc(cached.error)} <button type="button" class="btn btn-sm btn-outline" data-app-action="task-flow-retry">重新加载</button></td></tr>` : "");

    return `
      <div class="section-head">
        <div class="task-workbench-title">
          <h2 style="margin:0">任务管理工作台 <span>阶段 - ${Utils.esc(stage.name || "-")}</span></h2>
        </div>
        <button type="button" class="task-add-main task-add-header" data-app-action="task-add">
          <span class="row-action-btn row-add-btn" aria-hidden="true"></span>
          <span>新增任务</span>
        </button>
      </div>
      <div class="section-body">
        <div class="task-flow-summary">
          <div class="task-flow-stat stat-total"><b>${totalTasks}</b><span>总任务数</span></div>
          <div class="task-flow-stat stat-pending"><b>${pendingTasks}</b><span>待下发</span></div>
          <div class="task-flow-stat stat-running"><b>${runningTasks}</b><span>进行中</span></div>
          <div class="task-flow-stat stat-blocked"><b>${blockedTasks}</b><span>阻塞中</span></div>
          <div class="task-flow-stat stat-bad"><b>${abnormalTasks}</b><span>异常终止</span></div>
          <div class="task-flow-stat stat-done"><b>${finishedTasks}</b><span>正常完成</span></div>
        </div>
        <div class="task-filter-bar">
          <div class="task-filter-item filter-sku">
            <label for="taskFlowFilterSku">方案筛选</label>
            <select id="taskFlowFilterSku" data-app-action="task-flow-filter" data-app-events="change" data-field="sku">${skuOptions}</select>
          </div>
          <div class="task-filter-item filter-keyword">
            <label for="taskFlowFilterCategory">测试类别搜索</label>
            <input id="taskFlowFilterCategory" type="text" value="${Utils.esc(textFilterValue("categoryKeyword"))}" placeholder="回车搜索" data-app-action="task-flow-text-filter" data-app-events="input keydown" data-field="categoryKeyword">
          </div>
          <div class="task-filter-item filter-keyword">
            <label for="taskFlowFilterCase">测试用例搜索</label>
            <input id="taskFlowFilterCase" type="text" value="${Utils.esc(textFilterValue("caseKeyword"))}" placeholder="回车搜索" data-app-action="task-flow-text-filter" data-app-events="input keydown" data-field="caseKeyword">
          </div>
          <div class="task-filter-item filter-person">
            <label for="taskFlowFilterOwner">执行人筛选</label>
            <select id="taskFlowFilterOwner" data-app-action="task-flow-filter" data-app-events="change" data-field="ownerName">${optHtml(ownerNames.length ? ownerNames : infos.map(i => i.ownerName), f.ownerName)}</select>
          </div>
          <div class="task-filter-item filter-status">
            <label for="taskFlowFilterStatus">状态筛选</label>
            <select id="taskFlowFilterStatus" data-app-action="task-flow-filter" data-app-events="change" data-field="flowStatus">${optHtml(["待下发", "进行中", "阻塞中", "异常终止", "正常完成"], f.flowStatus)}</select>
          </div>
          <div class="task-filter-item filter-short">
            <label for="taskFlowFilterDts">DTS单号搜索</label>
            <input id="taskFlowFilterDts" type="text" value="${Utils.esc(textFilterValue("dtsKeyword"))}" placeholder="回车搜索" data-app-action="task-flow-text-filter" data-app-events="input keydown" data-field="dtsKeyword">
          </div>
          <div class="task-filter-item filter-result">
            <label for="taskFlowFilterResult">测试结果搜索</label>
            <input id="taskFlowFilterResult" type="text" value="${Utils.esc(textFilterValue("resultKeyword"))}" placeholder="回车搜索" data-app-action="task-flow-text-filter" data-app-events="input keydown" data-field="resultKeyword">
          </div>
          <div class="task-filter-actions">
            <button class="btn btn-sm btn-outline" data-app-action="task-flow-clear">清空筛选</button>
          </div>
        </div>
        ${pagerHtml}
        <div class="table-wrap task-flow-table"><table>
          <thead>
<tr><th>序号</th><th>方案</th><th>类别/用例</th><th>执行人</th><th>启动/完成时间</th><th>样机</th><th>测试结果</th><th>问题单</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>${loadingRow || rows.map((row, rowIndex) => {
      const t = row.task;
      const progressId = row.progress?.id || t?.progressId || "";
      const taskId = t?.id || "";
      const sequence = (page - 1) * pageSize + rowIndex + 1;
      const i = this.taskInfoForRow(stage, row);
      const skuDisplay = `${stage.name || "-"}-${i.sku || "-"}`;
      const pending = i.flowStatus === "待下发";
      const running = i.flowStatus === "进行中";
      const blocked = i.flowStatus === "阻塞中";
      const sampleCount = i.sampleIds.length;
      const flowStatus = i.flowStatus;
      const logs = t ? this.ensureTaskLogs(t) : [];
      const timeLine = (label, v) => {
        const t = this.taskDateText(v);
        const isSet = !!t && t !== "-";
        return `<span${isSet ? ' class="task-time-set"' : ""}>${label}：${Utils.esc(isSet ? t : "待设置")}</span>`;
      };
      const timeHtml = pending
        ? timeLine("计划开始", i.planStartDate) + timeLine("计划终止", i.planEndDate)
        : timeLine("开始", i.startDate) + timeLine("结束", i.endDate);
      const actionsHtml = this.taskFlowActionsHtml(project, stage, row);
      const catHtml = `<div class="task-type-cell"><span class="task-type-cat">${Utils.esc(i.category || "-")}</span><span class="task-type-item">${Utils.esc(i.testItem || "-")}</span></div>`;
      const execHtml = i.ownerName
        ? `<div class="task-executor-cell"><span class="task-executor-name">${Utils.esc(i.ownerName)}</span>${i.ownerId ? `<span class="task-executor-id">${Utils.esc(i.ownerId)}</span>` : ""}</div>`
        : `<span class="muted">-</span>`;
      const sampleHtml = `<div class="task-sample-cell">${sampleCount && taskId
        ? `<button type="button" class="task-sample-link" aria-label="查看样机：${sampleCount} pcs" title="查看此任务的样机：${sampleCount} pcs" data-app-action="task-show-samples" data-project-id="${Utils.esc(project.id)}" data-stage-id="${Utils.esc(stage.id)}" data-task-id="${Utils.esc(taskId)}"><span><span class="task-sample-count-num">${sampleCount}</span> pcs</span></button>`
        : `<span class="task-sample-count">${sampleCount} pcs</span>`}</div>`;
      return `
              <tr>
                <td class="task-seq-cell">${sequence}</td>
                <td class="task-sku-cell">${Utils.esc(skuDisplay)}</td>
                <td class="compact-cell">${catHtml}</td>
                <td>${execHtml}</td>
                <td class="task-time-cell">${timeHtml}</td>
                <td>${sampleHtml}</td>
                <td class="task-issue-cell">${t ? this.taskIssueSummaryHtml(project, stage, t) : "-"}</td>
                <td class="task-issue-record-cell" ${taskId ? `data-app-action="task-issue-record" data-project-id="${Utils.esc(project.id)}" data-stage-id="${Utils.esc(stage.id)}" data-task-id="${Utils.esc(taskId)}" style="cursor:pointer"` : ""}>${t ? this.taskIssueRecordHtml(t, project, stage) : '<span class="path">-</span>'}</td>
                <td><span class="badge ${this.taskStatusBadgeClass(flowStatus)}">${Utils.esc(flowStatus)}</span></td>
                <td class="op-cell task-op-cell-new">${actionsHtml}</td>
              </tr>`;
    }).join("") || `<tr><td colspan="10" class="empty">暂无任务。请点击"新增任务"，从阶段配置的测试池中选择测试项。</td></tr>`}
      ${rows.length ? `<tr class="task-flow-buffer-row" aria-hidden="true"><td colspan="10"></td></tr>` : ""}</tbody>
        </table></div>
        ${total > pageSize ? pagerHtml : ""}
        <div class="task-add-footer">
          <button type="button" class="task-add-main" data-app-action="task-add">
            <span class="row-action-btn row-add-btn" aria-hidden="true"></span>
            <span>新增任务</span>
          </button>
        </div>
      </div>`;
  },

  taskMoreMenuHtml(projectId, stageId, taskId, logs) {
    if (!taskId) return "";
    const logText = `日志${(logs || []).length ? `(${logs.length})` : ""}`;
    const panelId = `taskMorePanel_${String(taskId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    return `
      <div class="task-more-menu">
        <button type="button" class="btn btn-sm btn-outline task-more-trigger" data-app-action="task-more-toggle" data-stop-propagation="1" title="更多操作" aria-label="更多任务操作" aria-haspopup="menu" aria-expanded="false" aria-controls="${Utils.esc(panelId)}">...</button>
        <div id="${Utils.esc(panelId)}" class="task-more-panel" role="menu" aria-hidden="true">
          <button type="button" class="task-more-item" role="menuitem" data-app-action="task-show-logs" data-project-id="${Utils.esc(projectId)}" data-stage-id="${Utils.esc(stageId)}" data-task-id="${Utils.esc(taskId)}" data-stop-propagation="1">${logText}</button>
          <button type="button" class="task-more-item danger" role="menuitem" data-app-action="task-delete" data-task-id="${Utils.esc(taskId)}" data-stop-propagation="1">${Utils.iconHtml("trash")} 删除</button>
        </div>
      </div>`;
  },

  taskDeleteImpactHtml(project, stage, task) {
    if (!project || !stage || !task) return "";
    const executed = this.isTaskExecuted(task);
    const flowStatus = this.taskFlowStatus(task);
    const sampleCount = (task.sampleIds || []).length;
    const removedCount = (task.removedSampleRecords || []).length;
    const logCount = (task.logs || []).length;
    const totalSampleRefs = sampleCount + removedCount;

    const execBadge = executed
      ? `<span class="badge status-running">已执行</span>`
      : `<span class="badge status-pending">未执行</span>`;

    let impactDesc = "";
    if (!executed) {
      impactDesc = `<li><b>未执行任务</b><span>会从任务管理中物理删除，不会保留在归档中。</span></li>
        ${sampleCount ? `<li><b>已分配样机</b><span>${sampleCount} 台样机会被释放为闲置状态，不会删除样机档案。</span></li>` : ""}
        <li><b>任务日志</b><span>${logCount} 条日志会随任务记录一起删除。</span></li>`;
    } else if (flowStatus === "进行中" || flowStatus === "阻塞中") {
      impactDesc = `<li><b>进行中/阻塞中任务</b><span>会从任务管理中隐藏并归档，历史数据继续保留。</span></li>
        ${totalSampleRefs ? `<li><b>关联样机（含退出样机）</b><span>共 ${totalSampleRefs} 台，会按其他未完成任务占用情况自动释放，样机履历继续保留。</span></li>` : ""}
        <li><b>任务日志和样机快照</b><span>${logCount} 条日志继续保留。</span></li>
        <li><b>不会删除样机档案</b><span>样机的外观照片、CT 数据、问题表不受影响。</span></li>`;
    } else {
      impactDesc = `<li><b>已完成任务</b><span>会从任务管理中隐藏并归档，历史数据继续保留。</span></li>
        ${totalSampleRefs ? `<li><b>关联样机（含退出样机）</b><span>共 ${totalSampleRefs} 台，会按其他未完成任务占用情况自动释放。</span></li>` : ""}
        <li><b>任务日志、样机履历、样机快照</b><span>继续保留，不会丢失历史。</span></li>
        <li><b>不会删除样机档案</b><span>样机的外观照片、CT 数据、问题表不受影响。</span></li>`;
    }

    return `<div class="destroy-impact">
      <div class="destroy-impact-title">危险影响确认</div>
      <ul>
        <li><b>任务</b><span>${Utils.esc(project.name || "-")} / ${Utils.esc(stage.name || "-")} / ${Utils.esc(task.testItem || "-")}</span></li>
        <li><b>当前状态</b>${execBadge} <span>${Utils.esc(flowStatus)}</span></li>
        <li><b>涉及样机</b><span>${totalSampleRefs} 台（当前分配 ${sampleCount} 台${removedCount ? `，历史退出 ${removedCount} 台` : ""}）</span></li>
        <li><b>任务日志</b><span>${logCount} 条</span></li>
        ${impactDesc}
      </ul>
    </div>`;
  },

  confirmTaskDeleteKeyword(title, message, onConfirm, detailsHtml) {
    this.showModal(title, `
      <div class="delete-confirm">
        <p>${Utils.esc(message)}</p>
        ${detailsHtml || ""}
        <label>请输入 <strong>DELETE</strong> 确认删除：</label>
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
    }, "确认删除", { okClass: "btn btn-danger" });
    document.getElementById("deleteKeywordInput")?.focus();
  },

  taskFlowActionsHtml(project, stage, row) {
    const t = row.task;
    const taskId = t?.id || "";
    const progressId = row.progress?.id || t?.progressId || "";
    const i = this.taskInfoForRow(stage, row);
    const flowStatus = i.flowStatus;
    const sampleCount = i.sampleIds.length;
    const canStart = taskId && sampleCount > 0 && t?.owner && t?.planStartDate && t?.planEndDate;
    const logs = t ? this.ensureTaskLogs(t) : [];
    const pid = project.id;
    const sid = stage.id;

    const btn = (label, cls, action, disabled = false, title = "") =>
      `<button class="btn btn-sm ${cls}" ${disabled ? "disabled" : `data-app-action="${action}" data-project-id="${Utils.esc(pid)}" data-stage-id="${Utils.esc(sid)}" data-task-id="${Utils.esc(taskId)}"`} ${title ? `title="${Utils.esc(title)}"` : ""}>${label}</button>`;

    const configBtn = taskId
      ? `<button class="btn btn-sm btn-outline task-op-config" type="button"
           data-app-action="task-config" data-project-id="${Utils.esc(pid)}" data-stage-id="${Utils.esc(sid)}" data-progress-id="${Utils.esc(progressId)}" data-task-id="${Utils.esc(taskId)}" data-stop-propagation="1">配置</button>`
      : "";

    const moreMenuHtml = this.taskMoreMenuHtml(pid, sid, taskId, logs);

    let visibleHtml = "";

    if (flowStatus === "待下发") {
      visibleHtml = (canStart
        ? btn("启动", "btn-start", "task-start")
        : `<span class="task-start-disabled-tip" data-tooltip="先配置后启动">${btn("启动", "btn-start", "", true)}</span>`)
        + configBtn;
    }

    if (flowStatus === "进行中") {
      visibleHtml = btn("结果", "task-result-btn", "task-result")
        + btn("阻塞", "btn-warn", "task-block")
        + btn("变更", "btn-outline", "task-change");
    }

    if (flowStatus === "阻塞中") {
      visibleHtml = btn("结果", "task-result-btn", "task-result")
        + btn("重启", "btn-start", "task-start")
        + btn("变更", "btn-outline", "task-change");
    }

    if (flowStatus === "正常完成" || flowStatus === "异常终止") {
      visibleHtml = btn("结果", "task-result-btn", "task-result");
    }

    return `<div class="task-op-group"><div class="task-op-actions">${visibleHtml}${moreMenuHtml}</div></div>`;
  },

  taskSampleTaskFlowStatus(task, sampleId, entry) {
    const flow = this.taskFlowStatus(task);

    // 未结束任务的 resultDraft.destination 只是“结束后的计划去向”，不能冒充
    // 样机当前状态。当前状态必须继续跟随任务状态，否则任务样机清单会显示
    // “闲置/取走分析”，而打开同一档案又显示“测试中”。
    if (!this.isTaskCompleted(task)) {
      if (entry?.state === "removed") return "退出测试";
      if (flow === "进行中") return "测试中";
      if (flow === "阻塞中" || flow === "待下发") return "在位等待";
      return "待确认";
    }

    // 已结束任务读取最终保存的样机去向。
    const uploads = Array.isArray(task.resultUploads) ? task.resultUploads : [];
    for (let i = uploads.length - 1; i >= 0; i--) {
      const item = (uploads[i].samples || []).find(x => (x.sampleId || x.sid) === sampleId);
      if (item?.destination) return item.destination;
    }

    // 已退出样机在没有最终结果记录时仍保留明确关系状态。
    if (entry?.state === "removed") return "退出测试";

    return "待确认";
  },

  async showTaskSamples(projectId, stageId, taskId) {
    const request = this.beginDialogRequest?.();
    let { p, s, t } = this.getProjectStageTask(projectId, stageId, taskId);
    if (!t) return;
    let entries = this.taskResultSampleEntries(t);
    const loadingSamples = this.ensureTaskReferenceSamplesLoaded?.(t);
    if (loadingSamples?.then) await loadingSamples;
    if (this.isDialogRequestCurrent?.(request) === false) return;
    let currentSamples = null;
    if (typeof this.refreshSampleTestedItemNames === "function") {
      try {
        if (!await this.refreshSampleTestedItemNames(entries.map(entry => entry.sampleId).filter(Boolean),
          () => this.isDialogRequestCurrent?.(request) !== false,
          samples => { currentSamples = new Map(samples.map(sample => [sample.id, sample])); })) return;
      } catch (error) {
        if (this.isDialogRequestCurrent?.(request) !== false) alert("任务样机信息加载失败：" + error.message);
        return;
      }
    }
    ({ p, s, t } = this.getProjectStageTask(projectId, stageId, taskId));
    if (!t || this.isDialogRequestCurrent?.(request) === false) return;
    entries = this.taskResultSampleEntries(t);
    const activeCount = entries.filter(x => x.state !== "removed").length;
    const removedCount = entries.length - activeCount;
    const taskProblems = this.taskFailureProblemsBySample(p, s, t);
    const rows = entries.map(entry => {
      const id = entry.sampleId;
      const found = this.findSample(id);
      const snapshot = t.sampleSnapshots?.[id] || null;
      const sample = currentSamples ? currentSamples.get(id) : found?.sample;
      const info = this.taskSampleIdentityInfo(id, snapshot);
      const displayName = this.taskSampleArchiveName(id, snapshot);
      const hasProblem = sample ? this.sampleHasProblem(sample) : false;
      // 身份号优先级：SN > IMEI > 主板SN
      const identity = info.sn !== "-" ? `SN:${Utils.esc(info.sn)}`
        : info.imei !== "-" ? `IMEI:${Utils.esc(info.imei)}`
        : info.boardSn !== "-" ? `主板SN:${Utils.esc(info.boardSn)}`
        : "身份号未录入";
      // 已测项目
      const testedItems = this.sampleTestedItemNames(id, sample);
      const testedHtml = testedItems.length
        ? testedItems.map(item => `<span class="task-sample-tested-item">${Utils.esc(item)}</span>`).join("")
        : `<span>-</span>`;
      // 问题：合并档案问题 + 任务范围内问题，去重
      const archiveProblems = sample ? this.sampleProblemRecords(sample).map(r => r.description) : [];
      const taskProblemsForSample = [...(taskProblems.get(id) || [])];
      const allProblems = [...new Set([...archiveProblems, ...taskProblemsForSample])];
      const problemHtml = allProblems.length === 0
        ? `<span class="task-sample-problem-none">-</span>`
        : allProblems.map(problem => `<span class="task-sample-problem-text">${Utils.esc(problem)}</span>`).join("");
      // 状态徽章
      const faultBadge = !sample
        ? `<span class="badge s-待确认">故障待确认</span>`
        : hasProblem
        ? `<span class="badge sample-fault-badge has-fault">有故障</span>`
        : `<span class="badge sample-fault-badge no-fault">无故障</span>`;
      const taskFlowStatus = sample ? this.sampleEffectiveStatus(sample) : "待确认";
      const flowBadge = `<span class="badge s-${Utils.esc(taskFlowStatus)}">${Utils.esc(taskFlowStatus)}</span>`;
      // 在测 / 已退出
      const relationBadge = entry.state === "removed"
        ? `<span class="task-result-sample-state removed">变更样机</span>`
        : `<span class="task-result-sample-state active">正式样机</span>`;
      // 退出详情行
      const removedDetail = entry.state === "removed"
        ? `<div class="task-sample-removed-detail"><span>退出：${Utils.esc(Utils.dateTimeLabel(entry.removedAt))}</span>${entry.reason ? `<span> · ${Utils.esc(entry.reason)}</span>` : ""}</div>`
        : "";
      // 身份标识（可点击 / 已销毁不可点）
      const isDestroyedSnapshot = !found && !!snapshot?.destroyedAt;
      const identityEl = id && !isDestroyedSnapshot
        ? `<button type="button" class="task-sample-row-id" data-app-action="sample-readonly" data-id="${Utils.esc(id)}" data-stop-propagation="1" title="查看样机详情" aria-label="查看样机详情 ${Utils.esc(displayName)}">${identity}</button>`
        : `<span class="task-sample-row-id disabled" title="样机档案已销毁">${identity}</span>`;
      return `<div class="task-sample-row ${entry.state === "removed" ? "is-removed" : ""}">
        <div class="task-sample-row-info">
          ${identityEl}
          <span class="task-sample-row-archive">${Utils.esc(displayName)}</span>
        </div>
        <div class="task-sample-row-tested">
          <span class="task-sample-row-label">已测</span>
          ${testedHtml}
        </div>
        <div class="task-sample-row-problems">
          <span class="task-sample-row-label">问题</span>
          ${problemHtml}
        </div>
        <div class="task-sample-row-status">
          ${faultBadge}
          ${flowBadge}
          ${relationBadge}
        </div>
        ${removedDetail}
      </div>`;
    }).join("");
    this.showModal("任务样机清单", `
      <div class="task-sample-context">
        <div class="task-sample-context-line"><span><b>项目：</b>${Utils.esc(p?.name || "-")}</span><span><b>阶段：</b>${Utils.esc(s?.name || "-")}</span><span>当前 ${activeCount} 台${removedCount ? `；退出测试 ${removedCount} 台` : ""}</span></div>
        <div><b>任务：</b>${Utils.esc(t.testItem || "-")}</div>
      </div>
      <div class="task-sample-row-list">${rows || `<div class="empty">暂无关联样机。</div>`}</div>
    `, () => false, "关闭", { className: "task-sample-modal", hideCancel: true });
  },


  sampleTestedItemNames(sampleId, sample = null) {
    const source = sample || this.findSample?.(sampleId)?.sample;
    if (Array.isArray(source?.testedItemNames)) return source.testedItemNames;
    const names = new Set();
    this.projectRecords().forEach(project => {
      (project.stages || []).forEach(stage => {
        (stage.tasks || []).forEach(task => {
          if (!task.sampleIds || !task.sampleIds.includes(sampleId)) return;
          if (task.status === "待下发") return;
          const name = String(task.testItem || "").trim();
          if (name) names.add(name);
        });
      });
    });
    return [...names];
  },

});
