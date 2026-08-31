/* ========================================
   TestChamber V7 — 数据包导出/导入
   混入全局 app
   ======================================== */

app.registerModule("import-export-bundle", {

  // ── 导出 ──

  _downloadFilenameSegment(value, fallback = "-") {
    let text = String(value || "").trim() || fallback;
    text = text.replace(/[<>:"/\\|?*\r\n\t]/g, "-");
    text = text.replace(/\s+/g, "-").replace(/^[ ._-]+|[ ._-]+$/g, "");
    return (text || fallback).slice(0, 80);
  },

  _sampleArchiveDownloadName(sampleId) {
    const found = this.findSample?.(sampleId);
    const sample = found?.sample || {};
    const category = found?.category || {};
    const categoryName = this._downloadFilenameSegment(category.name, "未命名样机池");
    const archiveCode = this._downloadFilenameSegment(this.sampleDisplayCode?.(sample) || sample.sampleNo || sampleId, "未录入身份");
    const stableId = this._downloadFilenameSegment(sample.id || sampleId, "sample-id");
    const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    return `${categoryName}-${archiveCode}-${stableId}-${ts}.zip`;
  },

  async _downloadZipResponse(resp, fallbackName, successText, options = {}) {
    if (!resp.ok) {
      let serverMsg = "";
      try {
        const err = await resp.json();
        if (err && err.error) serverMsg = err.error;
      } catch (_) { /* response not JSON */ }
      throw new Error(serverMsg ? `${serverMsg} (HTTP ${resp.status})` : `HTTP ${resp.status}`);
    }
    const blob = await resp.blob();
    if (!blob || blob.size === 0) throw new Error("数据包为空");
    let filename = fallbackName;
    if (!options.preferFallback) {
      const cd = resp.headers.get("Content-Disposition") || "";
      const utf8Match = cd.match(/filename\*\s*=\s*UTF-8''([^;\r\n]+)/i);
      const fnMatch = cd.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
      if (utf8Match && utf8Match[1]) {
        try { filename = decodeURIComponent(utf8Match[1]); }
        catch (_) { filename = utf8Match[1]; }
      } else if (fnMatch && fnMatch[1]) {
        filename = fnMatch[1];
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (successText) Utils.toast(successText);
  },

  async exportBundle() {
    Utils.toast("正在生成数据包…");
    try {
      const resp = await fetch("/api/export-bundle");
      const contentType = resp.headers.get("Content-Type") || "";
      if (resp.ok && !contentType.includes("application/zip") && !contentType.includes("application/octet-stream")) {
        console.error("[EXPORT] 非预期的 Content-Type:", contentType);
        Utils.toast("导出失败：服务器返回了非 zip 内容 (HTTP " + resp.status + ")");
        return;
      }
      await this._downloadZipResponse(resp, "testchamber_export.zip", "数据包导出完成");
    } catch (e) {
      console.error("[EXPORT] 请求异常:", e);
      Utils.toast("导出失败：" + (e.message || "网络错误"));
    }
  },

  async exportScopedBundle(resourceType, resourceId, resourceName = "") {
    const id = String(resourceId || "").trim();
    if (!id) return;
    const isProject = resourceType === "project";
    const query = new URLSearchParams({
      [isProject ? "projectIds" : "sampleCategoryIds"]: id,
    });
    const label = isProject ? "项目" : "样机池";
    const safeName = this._downloadFilenameSegment(resourceName || id, label);
    Utils.toast(`正在生成${label}范围数据包…`);
    try {
      const resp = await fetch(`/api/export-bundle?${query.toString()}`);
      await this._downloadZipResponse(
        resp,
        `${isProject ? "project" : "sample-pool"}-${safeName}.zip`,
        `${label}范围数据包导出完成`,
      );
    } catch (e) {
      console.error("[SCOPED EXPORT] 请求异常:", e);
      Utils.toast(`${label}范围导出失败：${e.message || "网络错误"}`);
    }
  },

  async exportSampleArchive(sampleId) {
    if (!sampleId) return;
    Utils.toast("正在生成样机档案包…");
    try {
      const resp = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/archive`);
      await this._downloadZipResponse(resp, this._sampleArchiveDownloadName(sampleId), "样机档案包导出完成", { preferFallback: true });
    } catch (e) {
      Utils.toast("样机档案导出失败：" + (e.message || e));
    }
  },

  // ── 导入（入口） ──

  importBundle() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      Utils.toast("正在分析导入包…");
      try {
        const preview = await this.importBundlePreview(file);
        this._showImportPreviewModal(preview, file);
      } catch (e) {
        Utils.toast("导入分析失败: " + (e.message || e));
      }
    }, { once: true });
    input.click();
  },

  importSampleArchive(categoryId = "") {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.multiple = true;
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []).filter(Boolean);
      if (!files.length) return;
      const targetCategoryId = categoryId || this.selectedCategoryId?.() || "";
      Utils.toast(files.length > 1 ? `已选择 ${files.length} 个样机档案包` : "正在分析样机档案包…");
      try {
        if (files.length > 1) {
          this._showSampleArchiveBatchModal(files, targetCategoryId);
          return;
        }
        const preview = await this.importSampleArchivePreview(files[0], targetCategoryId);
        this._showSampleArchivePreviewModal(preview);
      } catch (e) {
        Utils.toast("样机档案分析失败: " + (e.message || e));
      }
    }, { once: true });
    input.click();
  },

  // ── 预览弹窗 ──

  _showImportPreviewModal(preview, file) {
    // 存储当前预览状态
    this._importState = {
      preview,
      file,
      decisions: {},        // {conflictId: decision}
      selection: this._defaultImportSelection(preview.selectionTree),
      processedConflicts: new Set(),
      accessPolicyMode: preview.accessPolicy?.available ? "merge" : "skip",
    };

    const body = this._renderImportPreviewBody(preview);
    this.showModal("导入数据包", body, () => this._onImportCommit(), "确认导入已处理项目", {
      className: "import-bundle-modal",
      cancelText: "取消",
      onCancel: () => {
        this._importState = null;
        return false;
      },
    });

    // 插入「仅导入无冲突数据」按钮
    this._injectQuickImportButton();
    // 初始化按钮状态
    this._updateImportCommitButton();
    // 绑定冲突处理事件
    this._bindConflictHandlers();
    this._bindImportSelectionHandlers();
    this._bindAccessPolicyModeHandlers();
  },

  // ── 渲染预览主体 ──

  _renderImportPreviewBody(preview) {
    const src = preview.source || {};
    const summary = preview.summary || {};
    const conflicts = preview.conflicts || [];
    const blockers = preview.blockers || [];
    const autoApply = preview.autoApply || [];

    // 统计
    const newProjects = autoApply.filter(a => a.type === "new_project").length;
    const newStages = autoApply.filter(a => a.type === "new_stage").length;
    const newTasks = autoApply.filter(a => a.type === "new_task").length;
    const newSamples = autoApply.filter(a => a.type === "new_sample").length;
    const totalConflicts = conflicts.length;
    const unprocessedCount = totalConflicts - this._importState.processedConflicts.size;
    const packageCounts = this._importSelectionTreeCounts(preview.selectionTree);

    let html = "";

    // 1) 来源与包内资源总量。总量和“本次新增”分开显示，避免同 Host 回导时误以为数据包为空。
    html += `<div class="import-overview-grid">
      <div class="import-section import-overview-card import-source">
        <div class="import-section-title">📦 数据包来源</div>
        <div class="import-source-grid">
          <div class="import-source-item"><span>来源部署</span><code title="${Utils.esc(src.deploymentId || src.sourceDeploymentId || "未知")}">${Utils.esc(src.deploymentId || src.sourceDeploymentId || "未知")}</code></div>
          <div class="import-source-item"><span>导出时间</span><b>${Utils.esc(src.exportedAt || "—")}</b></div>
          <div class="import-source-item"><span>数据版本</span><b>${Utils.esc(src.appVersion || "—")} / Rev ${src.revision || 0}</b></div>
        </div>
      </div>
      <div class="import-section import-overview-card import-package-summary">
        <div class="import-section-title">📊 数据包内容</div>
        <div class="import-summary-group">
          <span class="import-summary-label">包内资源</span>
          <div class="import-stats import-stat-pills">
            <span>项目 ${packageCounts.projects}</span><span>阶段 ${packageCounts.stages}</span><span>任务 ${packageCounts.tasks}</span>
            <span>样机池 ${packageCounts.sampleCategories}</span><span>样机 ${packageCounts.samples}</span>
          </div>
        </div>
        <div class="import-summary-group">
          <span class="import-summary-label">本次新增</span>
          <div class="import-stats import-stat-pills import-stat-pills-muted">
            <span>项目 ${newProjects}</span><span>阶段 ${newStages}</span><span>任务 ${newTasks}</span><span>样机 ${newSamples}</span>
          </div>
        </div>
      </div>
    </div>`;

    // 2) 选择范围与权限策略
    html += this._renderImportSelectionTree(preview.selectionTree);
    html += this._renderAccessPolicyImportOptions(preview.accessPolicy);

    // 3) 冲突区
    html += `<div class="import-section import-conflicts">
      <div class="import-section-title">⚠️ 需要处理（<span id="importConflictCount">${totalConflicts}</span> 项，<span id="importUnprocessedCount">${unprocessedCount}</span> 项未处理）</div>`;

    if (blockers.length > 0) {
      html += `<div class="import-blockers">
        <strong>⛔ 阻断项：</strong>
        ${Utils.esc(this._sampleArchiveBatchReasonFromBlockers(blockers))}
        <br><small>存在阻断项时无法提交导入</small>
      </div>`;
    }

    if (conflicts.length === 0) {
      html += `<div class="import-no-conflicts">无冲突，可直接导入</div>`;
    } else {
      html += `<div class="import-conflict-list" id="importConflictList">`;
      conflicts.forEach((c, idx) => {
        html += this._renderConflictCard(c, idx);
      });
      html += `</div>`;
    }
    html += `</div>`;

    return html;
  },

  _accessPolicyPreviewCounts(policy = {}) {
    const summary = policy.summary || {};
    const projectRules = Number(
      policy.projectRuleCount ?? summary.projectRuleCount ?? summary.projectRules ?? policy.projectRules?.length ?? 0
    ) || 0;
    const poolRules = Number(
      policy.samplePoolRuleCount ?? policy.poolRuleCount ?? summary.samplePoolRuleCount ?? summary.poolRuleCount ?? summary.poolRules ?? policy.poolRules?.length ?? 0
    ) || 0;
    const conflicts = Number(
      policy.conflictCount ?? summary.conflictCount ?? policy.conflicts?.length ?? 0
    ) || 0;
    const projects = Number(policy.projectCount ?? summary.projectCount ?? 0) || 0;
    const samplePools = Number(policy.samplePoolCount ?? policy.poolCount ?? summary.samplePoolCount ?? summary.poolCount ?? 0) || 0;
    return {
      projectRules,
      poolRules,
      conflicts,
      projects,
      samplePools,
      total: projectRules + poolRules,
      resourceTotal: projects + samplePools,
    };
  },

  _importSelectionTreeCounts(tree = {}) {
    const projects = tree.projects || [];
    const categories = tree.sampleCategories || [];
    return {
      projects: projects.length,
      stages: projects.reduce((count, project) => count + (project.stages || []).length, 0),
      tasks: projects.reduce((count, project) => count + (project.stages || [])
        .reduce((stageCount, stage) => stageCount + (stage.tasks || []).length, 0), 0),
      sampleCategories: categories.length,
      samples: categories.reduce((count, category) => count + (category.samples || []).length, 0),
    };
  },

  _accessPolicyCommitSummary(policy = {}, fallbackMode = "skip") {
    const supportedModes = ["merge", "replace_selected", "skip"];
    const reportedMode = String(policy?.mode || fallbackMode || "skip");
    const mode = supportedModes.includes(reportedMode) ? reportedMode : "skip";
    const count = value => {
      if (Array.isArray(value)) return value.length;
      const numeric = Number(value || 0);
      return Number.isFinite(numeric) ? numeric : 0;
    };
    const outcome = ({
      merge: "权限已自动合并",
      replace_selected: "权限已替换所选范围",
      skip: "权限已跳过",
    })[mode];
    return `${outcome}（${mode}）：新增 ${count(policy?.added)}、` +
      `去重 ${count(policy?.deduplicated)}、替换 ${count(policy?.replaced)}、` +
      `冲突 ${count(policy?.conflicts)}`;
  },

  _renderAccessPolicyImportOptions(policy = {}) {
    if (!policy?.available) return "";
    const counts = this._accessPolicyPreviewCounts(policy);
    return `<div class="import-section access-policy-import-section">
      <div class="import-section-heading">
        <div class="import-section-title">🛡 固定 IP 访问权限</div>
        <div class="import-stats import-stat-pills">
          <span>覆盖项目 ${counts.projects}</span>
          <span>覆盖样机池 ${counts.samplePools}</span>
          <span>项目规则 ${counts.projectRules}</span>
          <span>样机池规则 ${counts.poolRules}</span>
          <span>角色冲突 ${counts.conflicts}</span>
        </div>
      </div>
      ${counts.total === 0 ? `<div class="access-policy-empty-hint">此数据包没有显式 IP 名单规则；localhost 本机管理员由 Host 动态识别，本来就不会写入或导出。</div>` : ""}
      <div class="access-policy-mode-options" role="radiogroup" aria-label="权限策略导入方式">
        <label class="access-policy-mode-card recommended">
          <input type="radio" name="accessPolicyMode" value="merge" checked>
          <span class="access-policy-mode-copy"><b>合并（推荐）</b><small>新增 Host B 没有的规则；冲突时保留 Host B 并报告。</small></span>
        </label>
        <label class="access-policy-mode-card">
          <input type="radio" name="accessPolicyMode" value="replace_selected">
          <span class="access-policy-mode-copy"><b>替换所选范围</b><small>仅替换本次勾选资源的访问规则，其他资源不变。</small></span>
        </label>
        <label class="access-policy-mode-card">
          <input type="radio" name="accessPolicyMode" value="skip">
          <span class="access-policy-mode-copy"><b>不导入权限</b><small>只导入业务数据，保留 Host B 当前全部访问规则。</small></span>
        </label>
      </div>
      <div class="access-policy-replace-warning" hidden>⚠ 替换会先清空所选资源在 Host B 的现有名单，再写入包内规则；包内规则为 0 的资源将变为空名单。</div>
      <p class="import-section-note">权限与资源 ID 映射由 Host 服务端在同一事务中提交。</p>
    </div>`;
  },

  _bindAccessPolicyModeHandlers() {
    const modal = this._importModalRoot();
    if (!modal || !this._importState?.preview?.accessPolicy?.available) return;
    modal.querySelectorAll('input[name="accessPolicyMode"]').forEach(input => {
      input.addEventListener("change", () => {
        if (input.checked && ["merge", "replace_selected", "skip"].includes(input.value)) {
          this._importState.accessPolicyMode = input.value;
          this._updateAccessPolicyReplaceWarning(modal, input.value);
        }
      });
    });
    this._updateAccessPolicyReplaceWarning(modal, this._importState.accessPolicyMode);
  },

  _updateAccessPolicyReplaceWarning(modal, mode) {
    const warning = modal?.querySelector?.(".access-policy-replace-warning");
    if (warning) warning.hidden = mode !== "replace_selected";
  },

  _collectAccessPolicyMode() {
    if (!this._importState) return "skip";
    if (!this._importState.preview?.accessPolicy?.available) {
      this._importState.accessPolicyMode = "skip";
      return "skip";
    }
    const selected = this._importModalRoot()?.querySelector?.('input[name="accessPolicyMode"]:checked')?.value;
    this._importState.accessPolicyMode = ["merge", "replace_selected", "skip"].includes(selected)
      ? selected
      : ["merge", "replace_selected", "skip"].includes(this._importState.accessPolicyMode)
        ? this._importState.accessPolicyMode
        : "merge";
    return this._importState.accessPolicyMode;
  },

  _defaultImportSelection(tree = {}) {
    const selection = { projectIds: [], stageIds: [], taskIds: [], sampleCategoryIds: [], sampleIds: [] };
    (tree.projects || []).forEach(project => {
      if (project.id) selection.projectIds.push(project.id);
      (project.stages || []).forEach(stage => {
        if (stage.id) selection.stageIds.push(stage.id);
        (stage.tasks || []).forEach(task => { if (task.id) selection.taskIds.push(task.id); });
      });
    });
    (tree.sampleCategories || []).forEach(category => {
      if (category.id) selection.sampleCategoryIds.push(category.id);
      (category.samples || []).forEach(sample => { if (sample.id) selection.sampleIds.push(sample.id); });
    });
    return selection;
  },

  _renderImportSelectionTree(tree = {}) {
    const hasProjects = (tree.projects || []).length > 0;
    const hasSamples = (tree.sampleCategories || []).length > 0;
    if (!hasProjects && !hasSamples) return "";
    const counts = this._importSelectionTreeCounts(tree);
    let html = `<div class="import-section import-selection">
      <div class="import-section-heading">
        <div class="import-section-title">🎯 选择导入范围</div>
        <div class="import-stats import-stat-pills">
          ${hasProjects ? `<span>项目 ${counts.projects}</span><span>任务 ${counts.tasks}</span>` : ""}
          ${hasSamples ? `<span>样机池 ${counts.sampleCategories}</span><span>样机 ${counts.samples}</span>` : ""}
        </div>
      </div>
      <div class="import-selection-grid">`;
    if (hasProjects) {
      html += `<div class="import-selection-col"><div class="import-selection-col-title"><strong>项目 / 阶段 / 任务</strong><span>${counts.projects} 个项目 · ${counts.tasks} 个任务</span></div><div class="import-tree-list">`;
      (tree.projects || []).forEach(project => {
        html += `<label class="import-tree-row import-tree-project" title="${Utils.esc(project.label)}"><input type="checkbox" checked data-import-select="projectIds" data-project-id="${Utils.esc(project.id)}" value="${Utils.esc(project.id)}"><span class="import-tree-label">${Utils.esc(project.label)}</span></label>`;
        (project.stages || []).forEach(stage => {
          html += `<label class="import-tree-row import-tree-stage" title="${Utils.esc(stage.label)}"><input type="checkbox" checked data-import-select="stageIds" data-project-id="${Utils.esc(project.id)}" data-stage-id="${Utils.esc(stage.id)}" value="${Utils.esc(stage.id)}"><span class="import-tree-label">${Utils.esc(stage.label)}</span></label>`;
          (stage.tasks || []).forEach(task => {
            html += `<label class="import-tree-row import-tree-task" title="${Utils.esc(task.label)}"><input type="checkbox" checked data-import-select="taskIds" data-project-id="${Utils.esc(project.id)}" data-stage-id="${Utils.esc(stage.id)}" value="${Utils.esc(task.id)}"><span class="import-tree-label">${Utils.esc(task.label)}</span></label>`;
          });
        });
      });
      html += `</div></div>`;
    }
    if (hasSamples) {
      html += `<div class="import-selection-col"><div class="import-selection-col-title"><strong>样机池 / 样机</strong><span>${counts.sampleCategories} 个样机池 · ${counts.samples} 台样机</span></div><div class="import-tree-list">`;
      (tree.sampleCategories || []).forEach(category => {
        html += `<label class="import-tree-row import-tree-category" title="${Utils.esc(category.label)}"><input type="checkbox" checked data-import-select="sampleCategoryIds" data-category-id="${Utils.esc(category.id)}" value="${Utils.esc(category.id)}"><span class="import-tree-label">${Utils.esc(category.label)}</span></label>`;
        (category.samples || []).forEach(sample => {
          html += `<label class="import-tree-row import-tree-sample" title="${Utils.esc(sample.label)}"><input type="checkbox" checked data-import-select="sampleIds" data-category-id="${Utils.esc(category.id)}" value="${Utils.esc(sample.id)}"><span class="import-tree-label">${Utils.esc(sample.label)}</span></label>`;
        });
      });
      html += `</div></div>`;
    }
    html += `</div></div>`;
    return html;
  },

  _bindImportSelectionHandlers() {
    const modal = this._importModalRoot();
    if (!modal) return;
    modal.querySelectorAll("[data-import-select]").forEach(box => {
      box.addEventListener("change", () => {
        this._syncImportSelectionTree(box);
        this._collectImportSelection();
        this._updateImportCommitButton();
      });
    });
    this._collectImportSelection();
  },

  _cssIdent(value) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(String(value));
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  },

  _syncImportSelectionTree(box) {
    const modal = this._importModalRoot();
    if (!modal) return;
    const key = box.dataset.importSelect;
    if (key === "projectIds") {
      modal.querySelectorAll(`[data-project-id="${this._cssIdent(box.value)}"]`).forEach(child => { child.checked = box.checked; });
    } else if (key === "stageIds") {
      modal.querySelectorAll(`[data-stage-id="${this._cssIdent(box.value)}"]`).forEach(child => { child.checked = box.checked; });
    } else if (key === "sampleCategoryIds") {
      modal.querySelectorAll(`[data-category-id="${this._cssIdent(box.value)}"]`).forEach(child => { child.checked = box.checked; });
    }
    const updateParent = (parentSelector, childSelector) => {
      modal.querySelectorAll(parentSelector).forEach(parent => {
        const children = [...modal.querySelectorAll(childSelector(parent.value))];
        if (children.length) parent.checked = children.every(child => child.checked);
      });
    };
    updateParent('[data-import-select="stageIds"]', value => `[data-import-select="taskIds"][data-stage-id="${this._cssIdent(value)}"]`);
    updateParent('[data-import-select="projectIds"]', value => `[data-import-select="stageIds"][data-project-id="${this._cssIdent(value)}"]`);
    updateParent('[data-import-select="sampleCategoryIds"]', value => `[data-import-select="sampleIds"][data-category-id="${this._cssIdent(value)}"]`);
  },

  _collectImportSelection() {
    if (!this._importState) return;
    const modal = this._importModalRoot();
    // A real preview always has a modal.  Keeping an absent selection distinct
    // from an explicitly empty selection preserves older programmatic callers
    // while still preventing the UI from turning "unchecked all" into full import.
    if (!modal) return;
    const selection = { projectIds: [], stageIds: [], taskIds: [], sampleCategoryIds: [], sampleIds: [] };
    modal.querySelectorAll("[data-import-select]:checked").forEach(box => {
      const key = box.dataset.importSelect;
      if (selection[key]) selection[key].push(box.value);
    });
    this._importState.selection = selection;
  },

  _conflictInCurrentSelection(conflict) {
    const selection = this._importState?.selection;
    if (!selection) return true;
    const hasAny = ["projectIds", "stageIds", "taskIds", "sampleCategoryIds", "sampleIds"]
      .some(key => (selection[key] || []).length > 0);
    if (!hasAny) return false;
    const has = (key, ...ids) => (selection[key] || []).some(value => ids.includes(String(value)));
    const incomingId = String(conflict.incomingId || "");
    const currentId = String(conflict.currentId || "");
    const tree = this._importState?.preview?.selectionTree || {};
    const projectNode = (tree.projects || []).find(project => String(project.id || "") === incomingId);
    const stageNode = (projectNode?.stages || []).find(stage => String(stage.id || "") === incomingId)
      || (tree.projects || []).flatMap(project => project.stages || []).find(stage => String(stage.id || "") === incomingId);
    const categoryNode = (tree.sampleCategories || []).find(category => String(category.id || "") === incomingId);
    if (conflict.entity === "project") {
      return has("projectIds", incomingId, currentId)
        || (projectNode?.stages || []).some(stage => has("stageIds", String(stage.id || ""))
          || (stage.tasks || []).some(task => has("taskIds", String(task.id || ""))));
    }
    if (conflict.entity === "stage") {
      return has("stageIds", incomingId, currentId)
        || (stageNode?.tasks || []).some(task => has("taskIds", String(task.id || "")));
    }
    if (conflict.entity === "task") return has("taskIds", incomingId, currentId, String(conflict.incomingTaskId || ""));
    if (conflict.entity === "sample") return has("sampleIds", incomingId, currentId, String(conflict.sampleId || ""));
    if (conflict.entity === "sampleCategory") {
      return has("sampleCategoryIds", incomingId, currentId)
        || (categoryNode?.samples || []).some(sample => has("sampleIds", String(sample.id || "")));
    }
    return true;
  },

  // ── 渲染单条冲突卡片 ──

  _renderConflictCard(c, idx) {
    const cid = c.conflictId;
    const ctype = c.type;
    const label = Utils.esc(c.label || cid);
    const isProcessed = this._importState.processedConflicts.has(cid);

    let cardClass = "conflict-card";
    if (isProcessed) cardClass += " conflict-processed";

    let typeLabel = "";
    switch (ctype) {
      case "project_name_conflict": typeLabel = "项目名称冲突"; break;
      case "stage_name_conflict": typeLabel = "阶段名称冲突"; break;
      case "task_name_conflict": typeLabel = "任务冲突"; break;
      case "sample_identity_conflict": typeLabel = "样机身份冲突"; break;
      case "field_conflict": typeLabel = "字段冲突"; break;
      case "task_occupancy_conflict": typeLabel = "任务占用冲突"; break;
      default: typeLabel = ctype;
    }

    let html = `<div class="${cardClass}" id="conflict_${cid}" data-conflict-id="${cid}">
      <div class="conflict-card-header">
        <span class="conflict-index">${idx + 1}/${this._importState.preview.conflicts.length}</span>
        <span class="conflict-type-badge">${typeLabel}</span>
        <span class="conflict-label">${label}</span>
        <span class="conflict-status" id="conflict_status_${cid}">${isProcessed ? "✅ 已处理" : "⏳ 待处理"}</span>
      </div>`;

    // 主体：根据类型渲染
    html += `<div class="conflict-card-body" id="conflict_body_${cid}">`;
    html += this._renderConflictBody(c);
    html += `</div>`;

    html += `</div>`;
    return html;
  },

  // ── 冲突主体内容 ──

  _renderConflictBody(c) {
    switch (c.type) {
      case "project_name_conflict":
      case "stage_name_conflict":
        return this._renderNameConflictBody(c);
      case "task_name_conflict":
        return this._renderTaskNameConflictBody(c);
      case "sample_identity_conflict":
        return this._renderSampleIdentityConflictBody(c);
      case "field_conflict":
        return this._renderFieldConflictBody(c);
      case "task_occupancy_conflict":
        return this._renderOccupancyConflictBody(c);
      default:
        return `<p>未知冲突类型: ${Utils.esc(c.type)}</p>`;
    }
  },

  // 项目/阶段名称冲突
  _renderNameConflictBody(c) {
    const cid = c.conflictId;
    const curr = c.current || {};
    const inc = c.incoming || {};
    let html = `<div class="conflict-compare">
      <div class="conflict-col"><strong>主库：</strong>${Utils.esc(curr.name || "")}</div>
      <div class="conflict-col"><strong>导入：</strong>${Utils.esc(inc.name || "")}</div>
    </div>`;
    html += `<div class="conflict-actions" data-cid="${cid}">
      <label><input type="radio" name="action_${cid}" value="merge_into_existing"> 合并到主库现有项目</label>
      <label><input type="radio" name="action_${cid}" value="rename_import"> 改名后作为新项目导入</label>
      <div class="conflict-rename-row" id="rename_row_${cid}" style="display:none">
        新名称：<input type="text" id="rename_input_${cid}" placeholder="[来源] 项目名称" style="width:260px">
      </div>
      <label><input type="radio" name="action_${cid}" value="skip"> 跳过不导入</label>
    </div>`;
    return html;
  },

  // 任务名称冲突
  _renderTaskNameConflictBody(c) {
    const cid = c.conflictId;
    const curr = c.current || {};
    const inc = c.incoming || {};
    let html = `<div class="conflict-compare">
      <div class="conflict-col"><strong>主库：</strong>${Utils.esc(curr.category || "")} - ${Utils.esc(curr.testItem || "")} (${Utils.esc(curr.status || "")})</div>
      <div class="conflict-col"><strong>导入：</strong>${Utils.esc(inc.category || "")} - ${Utils.esc(inc.testItem || "")} (${Utils.esc(inc.status || "")})</div>
    </div>`;
    html += `<div class="conflict-actions" data-cid="${cid}">
      <label><input type="radio" name="action_${cid}" value="merge_into_existing"> 合并日志/结果到现有任务</label>
      <label><input type="radio" name="action_${cid}" value="rename_import"> 改名后作为新任务导入</label>
      <div class="conflict-rename-row" id="rename_row_${cid}" style="display:none">
        新任务名称：<input type="text" id="rename_input_${cid}" placeholder="[来源] 任务名称" style="width:260px">
      </div>
      <label><input type="radio" name="action_${cid}" value="skip"> 跳过</label>
    </div>`;
    return html;
  },

  // 样机身份冲突
  _renderSampleIdentityConflictBody(c) {
    const cid = c.conflictId;
    const curr = c.current || {};
    const inc = c.incoming || {};
    const mergeableFields = c.mergeableFields || [];
    const matchBy = c.matchBy || "sn";

    let html = `<div class="conflict-compare">
      <div class="conflict-col"><strong>主库：</strong>`;
    for (const [k, v] of Object.entries(curr)) {
      html += `${Utils.esc(k)}: ${Utils.esc(String(v))}<br>`;
    }
    html += `</div><div class="conflict-col"><strong>导入：</strong>`;
    for (const [k, v] of Object.entries(inc)) {
      html += `${Utils.esc(k)}: ${Utils.esc(String(v))}<br>`;
    }
    html += `</div></div>`;

    html += `<div class="conflict-actions" data-cid="${cid}">
      <label><input type="radio" name="action_${cid}" value="merge_into_existing"> 视为同一台样机，合并日志/照片/问题记录</label>`;

    if (mergeableFields.length > 0) {
      html += `<div class="conflict-field-choices" id="field_choices_${cid}" style="display:none; margin-left:24px">`;
      for (const f of mergeableFields) {
        html += `<div class="field-choice-row">
          <span>${Utils.esc(f)}：</span>
          <label><input type="radio" name="field_${cid}_${f}" value="current"> 保留主库：${Utils.esc(String(curr[f] || ""))}</label>
          <label><input type="radio" name="field_${cid}_${f}" value="incoming"> 使用导入：${Utils.esc(String(inc[f] || ""))}</label>
        </div>`;
      }
      html += `</div>`;
    }

    html += `<label><input type="radio" name="action_${cid}" value="import_as_new_with_identity_edit"> 作为新样机导入，修改标识：</label>
      <div class="conflict-rename-row" id="rename_row_${cid}" style="display:none; margin-left:24px">
        SN：<input type="text" id="rename_sn_${cid}" placeholder="修改 SN" style="width:160px">
        IMEI：<input type="text" id="rename_imei_${cid}" placeholder="修改 IMEI" style="width:160px">
        主板SN：<input type="text" id="rename_board_sn_${cid}" placeholder="修改主板SN" style="width:160px">
        编号：<input type="text" id="rename_sno_${cid}" placeholder="修改编号" style="width:160px">
      </div>
      <label><input type="radio" name="action_${cid}" value="skip"> 跳过</label>
    </div>`;
    return html;
  },

  // 字段冲突
  _renderFieldConflictBody(c) {
    const cid = c.conflictId;
    const entityLabel = c.entity === "sample" ? "样机" : c.entity === "project" ? "项目" : c.entity === "sampleCategory" ? "样机池" : c.entity;
    const diffFields = c.diffFields || [];
    const curr = c.current || {};
    const inc = c.incoming || {};

    let html = `<p>${Utils.esc(entityLabel)} ID 相同，以下字段不同：</p>`;
    html += `<div class="conflict-actions" data-cid="${cid}">
      <button class="btn btn-sm" data-action="all_current" data-cid="${cid}">全部保留主库</button>
      <button class="btn btn-sm" data-action="all_incoming" data-cid="${cid}">全部使用导入</button>`;

    for (const f of diffFields) {
      html += `<div class="field-choice-row">
        <span><strong>${Utils.esc(f)}：</strong></span>
        <label><input type="radio" name="field_${cid}_${f}" value="current"> 保留主库：${Utils.esc(String(curr[f] || ""))}</label>
        <label><input type="radio" name="field_${cid}_${f}" value="incoming"> 使用导入：${Utils.esc(String(inc[f] || ""))}</label>
      </div>`;
    }

    html += `<label style="margin-top:8px"><input type="radio" name="action_${cid}" value="apply_field_choices"> 应用以上字段选择到主库</label>
      <label><input type="radio" name="action_${cid}" value="skip"> 跳过此项</label>
    </div>`;
    return html;
  },

  // 任务占用冲突
  _renderOccupancyConflictBody(c) {
    const cid = c.conflictId;
    let html = `<p>样机 <strong>${Utils.esc(c.label || "")}</strong> 在两边都被占用：</p>`;
    html += `<div class="conflict-compare">
      <div class="conflict-col">主库任务：${Utils.esc(c.currentTaskId || "")} ${Utils.esc(c.incomingTaskLabel || "")}</div>
      <div class="conflict-col">导入任务：${Utils.esc(c.incomingTaskId || "")}</div>
    </div>`;
    html += `<div class="conflict-actions" data-cid="${cid}">
      <label><input type="radio" name="action_${cid}" value="skip_occupancy"> 跳过导入占用关系</label>
      <label><input type="radio" name="action_${cid}" value="import_no_occupy"> 导入记录但不改变样机占用</label>
    </div>`;
    return html;
  },

  // ── 绑定冲突处理事件 ──

  _importModalRoot() {
    return document.getElementById?.("modalBody") || document.querySelector?.(".modal") || null;
  },

  _bindConflictHandlers() {
    // Radio 切换显示/隐藏子选项
    const modal = this._importModalRoot();
    if (!modal) return;

    modal.querySelectorAll(".conflict-actions").forEach(actionsDiv => {
      const cid = actionsDiv.dataset.cid;
      const refreshDecisions = () => this._collectImportDecisions();
      actionsDiv.querySelectorAll(`input[name="action_${cid}"]`).forEach(radio => {
        radio.addEventListener("change", () => {
          // 显示/隐藏 rename row
          const renameRow = document.getElementById(`rename_row_${cid}`);
          if (renameRow) {
            renameRow.style.display =
              (radio.value === "rename_import" || radio.value === "import_as_new_with_identity_edit")
                ? "block"
                : "none";
          }
          // 显示/隐藏 field choices（merge_into_existing 时）
          const fieldChoices = document.getElementById(`field_choices_${cid}`);
          if (fieldChoices) {
            fieldChoices.style.display = radio.value === "merge_into_existing" ? "block" : "none";
          }
          refreshDecisions();
        });
      });
      actionsDiv.querySelectorAll("input[type=radio]").forEach(radio => {
        if (radio.name !== `action_${cid}`) {
          radio.addEventListener("change", refreshDecisions);
        }
      });

      actionsDiv.querySelectorAll("input[type=text]").forEach(input => {
        input.addEventListener("input", refreshDecisions);
      });

      // "全部保留/使用" 按钮
      actionsDiv.querySelectorAll("[data-action]").forEach(btn => {
        btn.addEventListener("click", () => {
          const action = btn.dataset.action;
          const targetCid = btn.dataset.cid;
          const desired = action === "all_current" ? "current" : "incoming";
          actionsDiv.querySelectorAll(`input[name^="field_${targetCid}_"][value="${desired}"]`).forEach(r => {
            r.checked = true;
          });
          const applyAction = actionsDiv.querySelector(`input[name="action_${targetCid}"][value="apply_field_choices"]`);
          if (applyAction) applyAction.checked = true;
          refreshDecisions();
        });
      });
    });
  },

  // ── 收集决策 → 更新状态 ──

  _collectImportDecisions() {
    if (!this._importState) return;
    const modal = this._importModalRoot();
    if (!modal) return;

    const conflicts = this._importState.preview.conflicts || [];
    this._importState.processedConflicts = new Set();
    const nextDecisions = {};

    for (const c of conflicts) {
      const cid = c.conflictId;
      const statusEl = document.getElementById(`conflict_status_${cid}`);
      if (statusEl) statusEl.textContent = "⏳ 待处理";
      const cardEl = document.getElementById(`conflict_${cid}`);
      if (cardEl) cardEl.classList.remove("conflict-processed");

      // 查找选中的 action radio
      const actionRadio = modal.querySelector(`input[name="action_${cid}"]:checked`);
      if (!actionRadio) continue;

      const action = actionRadio.value;
      const decision = { action };

      if (action === "rename_import") {
        // 项目/阶段/任务改名导入
        decision.newName = (document.getElementById(`rename_input_${cid}`) || {}).value || "";
        if (!decision.newName) continue;
      }

      if (action === "import_as_new_with_identity_edit") {
        // 样机标识编辑导入
        decision.newSN = (document.getElementById(`rename_sn_${cid}`) || {}).value || "";
        decision.newIMEI = (document.getElementById(`rename_imei_${cid}`) || {}).value || "";
        decision.newBoardSn = (document.getElementById(`rename_board_sn_${cid}`) || {}).value || "";
        decision.newSampleNo = (document.getElementById(`rename_sno_${cid}`) || {}).value || "";
        if (!decision.newSN && !decision.newIMEI && !decision.newBoardSn && !decision.newSampleNo) continue;
      }

      if (action === "merge_into_existing") {
        decision.targetId = c.preferredMergeTarget || c.currentId;
        // 收集逐字段选择
        const mergeableFields = c.mergeableFields || c.diffFields || [];
        const fieldChoices = {};
        for (const f of mergeableFields) {
          const fr = modal.querySelector(`input[name="field_${cid}_${f}"]:checked`);
          if (fr) fieldChoices[f] = fr.value;
        }
        decision.fieldChoices = fieldChoices;
      }

      if (action === "apply_field_choices") {
        // field_conflict：逐字段选择写入
        const diffFields = c.diffFields || c.mergeableFields || [];
        const fieldChoices = {};
        for (const f of diffFields) {
          const fr = modal.querySelector(`input[name="field_${cid}_${f}"]:checked`);
          if (fr) fieldChoices[f] = fr.value;
        }
        decision.fieldChoices = fieldChoices;
        if (diffFields.length > 0 && Object.keys(fieldChoices).length < diffFields.length) {
          continue;
        }
      }

      nextDecisions[cid] = decision;
      this._importState.processedConflicts.add(cid);

      // 更新状态标记
      if (statusEl) statusEl.textContent = "✅ 已处理";
      if (cardEl) cardEl.classList.add("conflict-processed");
    }

    this._importState.decisions = nextDecisions;
    this._updateImportCommitButton();
  },

  // ── 更新确认按钮状态 ──

  _updateImportCommitButton() {
    if (!this._importState) return;
    const relevantConflicts = (this._importState.preview.conflicts || []).filter(c => this._conflictInCurrentSelection(c));
    const totalConflicts = relevantConflicts.length;
    const processed = relevantConflicts.filter(c => this._importState.processedConflicts.has(c.conflictId)).length;
    const unprocessedEl = document.getElementById("importUnprocessedCount");
    if (unprocessedEl) unprocessedEl.textContent = String(Math.max(0, totalConflicts - processed));
    const okBtn = document.getElementById("modalOk");
    if (!okBtn) return;
    const selectedCount = ["projectIds", "stageIds", "taskIds", "sampleCategoryIds", "sampleIds"]
      .reduce((sum, key) => sum + (this._importState.selection?.[key] || []).length, 0);
    if (this._importState.selection && selectedCount === 0) {
      okBtn.disabled = true;
      okBtn.textContent = "请先选择导入内容";
      okBtn.title = "空选择不会执行导入";
      return;
    }

    if (totalConflicts === 0) {
      okBtn.disabled = false;
      okBtn.textContent = "确认导入";
      okBtn.title = "";
      return;
    }

    if (processed < totalConflicts) {
      okBtn.disabled = true;
      okBtn.textContent = `确认导入（${processed}/${totalConflicts}）`;
      okBtn.title = "还有未处理的冲突项";
    } else {
      okBtn.disabled = false;
      okBtn.textContent = "确认导入已处理项目";
      okBtn.title = "";
    }
  },

  // ── 仅导入无冲突数据 ──

  _injectQuickImportButton() {
    // 在弹窗 footer 插入第三个按钮
    setTimeout(() => {
      const footer = document.querySelector(".modal-footer");
      if (!footer) return;
      document.getElementById("quickImportBtn")?.remove();
      const conflicts = (this._importState?.preview?.conflicts || []).filter(c => this._conflictInCurrentSelection(c));
      if (conflicts.length === 0) return;
      const btn = document.createElement("button");
      btn.className = "btn btn-outline";
      btn.textContent = "跳过冲突并导入其余数据";
      btn.id = "quickImportBtn";
      btn.addEventListener("click", () => this._onQuickImport());
      // 插入到 cancel 和 ok 之间
      const okBtn = document.getElementById("modalOk");
      if (okBtn) {
        footer.insertBefore(btn, okBtn);
      } else {
        footer.appendChild(btn);
      }
    }, 50);
  },

  async _onQuickImport() {
    // 跳过所有冲突项，只提交 autoApply
    if (!this._importState) return;
    this._collectImportSelection();
    const selectedCount = ["projectIds", "stageIds", "taskIds", "sampleCategoryIds", "sampleIds"]
      .reduce((sum, key) => sum + (this._importState.selection?.[key] || []).length, 0);
    if (this._importState.selection && !selectedCount) {
      Utils.toast("请至少选择一项要导入的内容");
      return;
    }
    const modalId = this._currentModalId;
    if (modalId) this.setModalBusy?.(modalId, true);
    const conflicts = this._importState.preview.conflicts || [];
    this._importState.decisions = {};
    this._importState.processedConflicts = new Set();
    for (const c of conflicts) {
      this._importState.decisions[c.conflictId] = { action: "skip" };
      this._importState.processedConflicts.add(c.conflictId);
    }
    // 直接提交，跳过 DOM 重新收集
    try {
      const shouldClose = await this._onImportCommit({ skipCollect: true, modalId });
      if (shouldClose === false || shouldClose === undefined) {
        // 弹窗已关闭
      }
    } finally {
      if (modalId && this._currentModalId === modalId) this.setModalBusy?.(modalId, false);
    }
  },

  // ── 提交导入 ──

  async _onImportCommit({ skipCollect = false, modalId = this._currentModalId } = {}) {
    if (!this._importState) return true;
    // 先收集决策（quick import 可跳过）
    if (!skipCollect) this._collectImportDecisions();
    this._collectImportSelection();
    this._collectAccessPolicyMode();
    const selectedCount = ["projectIds", "stageIds", "taskIds", "sampleCategoryIds", "sampleIds"]
      .reduce((sum, key) => sum + (this._importState.selection?.[key] || []).length, 0);
    if (this._importState.selection && !selectedCount) {
      Utils.toast("请至少选择一项要导入的内容");
      return true;
    }

    const relevantConflicts = (this._importState.preview.conflicts || []).filter(c => this._conflictInCurrentSelection(c));
    const totalConflicts = relevantConflicts.length;
    const relevantProcessed = relevantConflicts.filter(c => this._importState.processedConflicts.has(c.conflictId)).length;
    const processed = relevantProcessed;
    if (totalConflicts > 0 && processed < totalConflicts) {
      Utils.toast(`还有 ${totalConflicts - processed} 项冲突未处理`);
      return true; // 保持弹窗打开
    }

    try {
      Utils.toast("正在导入数据…");
      const result = await this.importBundleCommit(
        this._importState.preview.previewId,
        this._importState.decisions
      );
      const accessPolicySummary = this._accessPolicyCommitSummary(
        result.accessPolicy,
        this._importState.accessPolicyMode
      );
      Utils.toast(
        `导入完成：新增 ${result.stats?.projectsAdded || 0} 项目、` +
        `${result.stats?.samplesAdded || 0} 样机，` +
        `合并 ${result.stats?.samplesMerged || 0} 样机，` +
        `事件 ${result.stats?.sampleEventsAdded || 0} 条，` +
        `跳过 ${result.stats?.skipped || 0} 项；${accessPolicySummary}`
      );
      await this.applyImportBundleMutationResult(result, { render: true });
    } catch (e) {
      const msg = e.message || e;
      if (msg.includes("修改") || msg.includes("revision")) {
        Utils.toast("导入失败：服务器数据已被修改，请重新选择文件导入");
      } else {
        Utils.toast("导入失败: " + msg);
      }
      return true; // 保持弹窗打开
    }

    this._importState = null;
    this.closeModal(modalId || null);
    return false;
  },

  _showSampleArchivePreviewModal(preview) {
    const conflicts = preview.conflicts || [];
    const blockers = preview.blockers || [];
    const target = preview.targetCategory || {};
    const summary = preview.summary || {};
    const body = `<div class="import-section">
      <div class="import-section-title">样机档案包</div>
      <div class="import-source-grid">
        <span>来源部署：</span><code>${Utils.esc(preview.source?.deploymentId || "未知")}</code>
        <span>导出时间：</span><span>${Utils.esc(preview.source?.exportedAt || "")}</span>
        <span>目标样机池：</span><span>${Utils.esc(target.name || "外部导入样机")}</span>
      </div>
    </div>
    <div class="import-section">
      <div class="import-section-title">预计导入</div>
      <div class="import-stats">
        <span>新增样机：${summary.samples?.new || 0}</span>
        <span>身份冲突：${summary.sampleIdentityConflicts || 0}</span>
        <span>字段冲突：${summary.fieldConflicts || 0}</span>
      </div>
      ${conflicts.length ? `<p class="path">身份冲突会默认合并到已有样机；字段冲突默认保留目标库字段并追加照片/履历。</p>` : `<p class="path">无冲突，可直接导入。</p>`}
      ${blockers.length ? `<div class="import-blockers">存在阻断项，无法提交：${blockers.map(b => Utils.esc(b.type || "") + " " + (b.count || 0)).join("；")}</div>` : ""}
    </div>`;
    this.showModal("导入样机档案", body, async () => {
      if (blockers.length) return true;
      try {
        Utils.toast("正在导入样机档案…");
        const result = await this.importSampleArchiveCommit(preview.previewId);
        Utils.toast(`样机档案导入完成：新增 ${result.stats?.samplesAdded || 0}，合并 ${result.stats?.samplesMerged || 0}，事件 ${result.stats?.sampleEventsAdded || 0}`);
        await this.applyImportBundleMutationResult(result, { render: true });
        return false;
      } catch (e) {
        Utils.toast("样机档案导入失败：" + (e.message || e));
        return true;
      }
    }, "确认导入", { cancelText: "取消" });
  },

  _sampleArchiveBatchFileSize(file) {
    return `${Math.ceil((file?.size || 0) / 1024).toLocaleString()} KB`;
  },

  _sampleArchiveBatchReasonFromBlockers(blockers = []) {
    if (!blockers.length) return "";
    return blockers.map(blocker => {
      const type = String(blocker.type || "");
      const count = Number(blocker.count || 0);
      const ids = (blocker.assetIds || []).slice(0, 3).filter(Boolean).join("、");
      const suffix = ids ? `：${ids}${count > 3 ? " 等" : ""}` : "";
      if (type === "missing_photos") return `缺失照片资源 ${count} 项${suffix}`;
      if (type === "asset_integrity_mismatch") return `照片/资源校验失败 ${count} 项${suffix}`;
      if (type === "duplicate_sample_identities") return `导入包内样机身份标识重复 ${count} 项`;
      if (type === "entity_id_ownership_collision") return `阶段/任务 ID 与主库归属冲突 ${count} 项`;
      return `${type || "阻断项"} ${count} 项${suffix}`;
    }).join("；");
  },

  _sampleArchiveBatchPreviewSummary(preview = {}) {
    const summary = preview.summary || {};
    const samples = summary.samples || {};
    return [
      `新增 ${Number(samples.new || 0)}`,
      `合并 ${Number(summary.sampleIdentityConflicts || 0)}`,
      `字段冲突 ${Number(summary.fieldConflicts || 0)}`,
    ].join(" / ");
  },

  _sampleArchiveBatchCommitSummary(result = {}) {
    const stats = result.stats || {};
    return [
      `新增 ${Number(stats.samplesAdded || 0)}`,
      `合并 ${Number(stats.samplesMerged || 0)}`,
      `事件 ${Number(stats.sampleEventsAdded || 0)}`,
    ].join(" / ");
  },

  _sampleArchiveBatchCounts() {
    const state = this._sampleArchiveBatchState || {};
    const rows = state.rows || [];
    return {
      total: rows.length,
      pending: rows.filter(row => row.status === "pending").length,
      checking: rows.filter(row => row.status === "checking").length,
      valid: rows.filter(row => row.status === "valid").length,
      invalid: rows.filter(row => row.status === "invalid").length,
      selected: rows.filter(row => row.status === "valid" && row.selected).length,
      importing: rows.filter(row => row.status === "importing").length,
      imported: rows.filter(row => row.status === "imported").length,
      failed: rows.filter(row => row.status === "failed").length,
    };
  },

  _sampleArchiveBatchRowIcon(status) {
    if (status === "valid" || status === "imported") return "✓";
    if (status === "invalid" || status === "failed") return "✕";
    if (status === "checking" || status === "importing") return "…";
    return "○";
  },

  _sampleArchiveBatchRowText(row) {
    if (row.status === "pending") return "待检查";
    if (row.status === "checking") return "正在检查档案内容…";
    if (row.status === "valid") return `可导入：${row.summary || ""}`;
    if (row.status === "invalid") return `无法导入原因：${row.reason || "未知错误"}`;
    if (row.status === "importing") return "正在导入到样机池…";
    if (row.status === "imported") return `已导入：${row.summary || ""}`;
    if (row.status === "failed") return `导入失败原因：${row.reason || "未知错误"}`;
    return "";
  },

  _sampleArchiveBatchStatusText(counts) {
    const state = this._sampleArchiveBatchState || {};
    if (state.phase === "checking") {
      return `待检查 ${counts.pending} / 正在检查 ${counts.checking} / 可导入 ${counts.valid} / 不可导入 ${counts.invalid}`;
    }
    if (state.phase === "selection") {
      return `可导入 ${counts.valid} 个 / 不可导入 ${counts.invalid} 个 / 已选择 ${counts.selected} 个`;
    }
    if (state.phase === "importing" || state.phase === "done") {
      return `导入成功 ${counts.imported} 个 / 导入失败 ${counts.failed} 个 / 未导入 ${counts.valid} 个`;
    }
    return `待检查 ${counts.total} 个`;
  },

  _renderSampleArchiveBatchBody() {
    const state = this._sampleArchiveBatchState || {};
    const rows = state.rows || [];
    const counts = this._sampleArchiveBatchCounts();
    const helperText = state.phase === "ready"
      ? "先检查档案，不会写入样机池；检查通过后可勾选要导入的档案。"
      : state.phase === "selection"
        ? "请勾选需要导入的档案；红色叉叉的档案不可导入。"
        : state.phase === "done"
          ? "导入流程已完成，可查看每个档案的成功或失败结果。"
          : "请等待当前批量任务完成。";
    const fileRows = rows.map((row, idx) => {
      const canSelect = state.phase === "selection" && row.status === "valid";
      const showCheckbox = state.phase === "selection" || state.phase === "importing" || state.phase === "done";
      const checked = row.selected ? "checked" : "";
      const disabled = canSelect ? "" : "disabled";
      return `
        <div class="sample-archive-batch-row sample-archive-batch-row-${Utils.esc(row.status)}">
          <label class="sample-archive-batch-check">
            ${showCheckbox ? `<input type="checkbox" data-sample-archive-batch-select="${idx}" ${checked} ${disabled}>` : ""}
          </label>
          <span class="sample-archive-batch-status">${this._sampleArchiveBatchRowIcon(row.status)}</span>
          <div class="sample-archive-batch-main">
            <b>${idx + 1}. ${Utils.esc(row.file?.name || "未命名档案.zip")}</b>
            <div class="sample-archive-batch-detail">${Utils.esc(this._sampleArchiveBatchRowText(row))}</div>
          </div>
          <span class="sample-archive-batch-size">${Utils.esc(this._sampleArchiveBatchFileSize(row.file))}</span>
        </div>
      `;
    }).join("");
    return `<div class="import-section">
      <div class="import-section-title">批量导入样机档案</div>
      <div class="import-source-grid">
        <span>目标样机池：</span><span>${Utils.esc(state.targetName || "当前样机池")}</span>
        <span>已选择：</span><span>${counts.total} 个 ZIP 档案</span>
        <span>当前状态：</span><span>${Utils.esc(this._sampleArchiveBatchStatusText(counts))}</span>
      </div>
      <p class="path">${helperText}</p>
    </div>
    <div class="import-section">
      <div class="import-section-title">文件清单</div>
      <div class="sample-archive-batch-list">${fileRows}</div>
    </div>`;
  },

  _refreshSampleArchiveBatchModal() {
    const body = document.getElementById("modalBody");
    if (body) this.replaceHtml(body, this._renderSampleArchiveBatchBody());
    this._bindSampleArchiveBatchSelectionHandlers();
    this._updateSampleArchiveBatchOkButton();
  },

  _updateSampleArchiveBatchOkButton() {
    const state = this._sampleArchiveBatchState;
    const ok = document.getElementById("modalOk");
    const cancel = document.getElementById("modalCancel");
    if (!state || !ok) return;
    const counts = this._sampleArchiveBatchCounts();
    const busy = state.phase === "checking" || state.phase === "importing";
    ok.disabled = busy;
    if (cancel) {
      cancel.disabled = busy;
      cancel.innerText = state.phase === "done" ? "关闭" : "取消";
    }
    if (state.phase === "ready") {
      ok.innerText = "检查档案";
    } else if (state.phase === "checking") {
      ok.innerText = "检查中…";
    } else if (state.phase === "selection") {
      ok.innerText = `确认导入 ${counts.selected} 个档案`;
    } else if (state.phase === "importing") {
      ok.innerText = "导入中…";
    } else if (state.phase === "done") {
      ok.innerText = "完成";
    }
  },

  _bindSampleArchiveBatchSelectionHandlers() {
    const state = this._sampleArchiveBatchState;
    if (!state) return;
    document.querySelectorAll("[data-sample-archive-batch-select]").forEach(input => {
      input.addEventListener("change", () => {
        const idx = Number(input.dataset.sampleArchiveBatchSelect);
        const row = state.rows?.[idx];
        if (!row || row.status !== "valid") return;
        row.selected = !!input.checked;
        this._refreshSampleArchiveBatchModal();
      });
    });
  },

  async _checkSampleArchiveBatch() {
    const state = this._sampleArchiveBatchState;
    if (!state) return true;
    state.phase = "checking";
    this._refreshSampleArchiveBatchModal();
    for (let idx = 0; idx < state.rows.length; idx += 1) {
      const row = state.rows[idx];
      row.status = "checking";
      row.selected = false;
      row.reason = "";
      row.summary = "";
      this._refreshSampleArchiveBatchModal();
      try {
        Utils.toast(`正在检查样机档案 ${idx + 1}/${state.rows.length}：${row.file?.name || ""}`);
        const preview = await this.importSampleArchivePreview(row.file, state.targetCategoryId);
        const blockers = preview.blockers || [];
        if (blockers.length) {
          row.status = "invalid";
          row.reason = this._sampleArchiveBatchReasonFromBlockers(blockers);
          row.preview = null;
        } else {
          row.status = "valid";
          row.preview = preview;
          row.selected = true;
          row.summary = this._sampleArchiveBatchPreviewSummary(preview);
        }
      } catch (e) {
        row.status = "invalid";
        row.reason = e.message || String(e || "预览失败");
        row.preview = null;
      }
      this._refreshSampleArchiveBatchModal();
    }
    state.phase = "selection";
    this._refreshSampleArchiveBatchModal();
    const counts = this._sampleArchiveBatchCounts();
    Utils.toast(`检查完成：可导入 ${counts.valid} 个，不可导入 ${counts.invalid} 个。`);
    return true;
  },

  async _commitSampleArchiveBatch() {
    const state = this._sampleArchiveBatchState;
    if (!state) return true;
    const selectedRows = (state.rows || []).filter(row => row.status === "valid" && row.selected && row.preview?.previewId);
    if (!selectedRows.length) {
      Utils.toast("请至少勾选 1 个可导入的样机档案。");
      return true;
    }
    state.phase = "importing";
    this._refreshSampleArchiveBatchModal();
    const totals = { samplesAdded: 0, samplesMerged: 0, sampleEventsAdded: 0, skipped: 0 };
    let successCount = 0;
    let failCount = 0;
    const successfulResults = [];
    for (let idx = 0; idx < selectedRows.length; idx += 1) {
      const row = selectedRows[idx];
      row.status = "importing";
      this._refreshSampleArchiveBatchModal();
      try {
        Utils.toast(`正在导入样机档案 ${idx + 1}/${selectedRows.length}：${row.file?.name || ""}`);
        // 每次提交前重新预览：前一档案提交会推进 revision，初检 preview 随即过期。
        const freshPreview = await this.importSampleArchivePreview(row.file, state.targetCategoryId);
        const freshBlockers = freshPreview.blockers || [];
        if (freshBlockers.length) throw new Error(this._sampleArchiveBatchReasonFromBlockers(freshBlockers));
        const result = await this.importSampleArchiveCommit(freshPreview.previewId);
        const stats = result.stats || {};
        totals.samplesAdded += Number(stats.samplesAdded || 0);
        totals.samplesMerged += Number(stats.samplesMerged || 0);
        totals.sampleEventsAdded += Number(stats.sampleEventsAdded || 0);
        totals.skipped += Number(stats.skipped || 0);
        successCount += 1;
        successfulResults.push(result);
        row.status = "imported";
        row.summary = this._sampleArchiveBatchCommitSummary(result);
      } catch (e) {
        failCount += 1;
        row.status = "failed";
        row.reason = e.message || String(e || "提交失败");
      }
      this._refreshSampleArchiveBatchModal();
    }
    if (successfulResults.length) {
      const lastResult = successfulResults[successfulResults.length - 1];
      const idKeys = ["projectIds", "stageIds", "taskIds", "sampleCategoryIds", "sampleIds"];
      const mutationSummary = { summaryVersion: 1, requiresFullState: false };
      idKeys.forEach(key => {
        mutationSummary[key] = [...new Set(successfulResults.flatMap(result => result.mutationSummary?.[key] || []))];
      });
      mutationSummary.requiresFullState = successfulResults.some(result => result.mutationSummary?.requiresFullState);
      await this.applyImportBundleMutationResult({ ...lastResult, mutationSummary }, { render: true });
    }
    state.phase = "done";
    this._refreshSampleArchiveBatchModal();
    Utils.toast(`样机档案批量导入完成：成功 ${successCount} 个，失败 ${failCount} 个，新增 ${totals.samplesAdded}，合并 ${totals.samplesMerged}，事件 ${totals.sampleEventsAdded}`);
    return true;
  },

  async _onSampleArchiveBatchOk() {
    const state = this._sampleArchiveBatchState;
    if (!state) return false;
    if (state.phase === "ready") return this._checkSampleArchiveBatch();
    if (state.phase === "selection") return this._commitSampleArchiveBatch();
    if (state.phase === "done") {
      this._sampleArchiveBatchState = null;
      return false;
    }
    return true;
  },

  _showSampleArchiveBatchModal(files, targetCategoryId = "") {
    const targetName = this.sampleCategoryRecords?.()
      ?.find(cat => String(cat.id || "") === String(targetCategoryId || ""))
      ?.name || "当前样机池";
    this._sampleArchiveBatchState = {
      phase: "ready",
      targetCategoryId,
      targetName,
      rows: files.map(file => ({
        file,
        status: "pending",
        selected: false,
        preview: null,
        summary: "",
        reason: "",
      })),
    };
    this.showModal("批量导入样机档案", this._renderSampleArchiveBatchBody(), async () => {
      return this._onSampleArchiveBatchOk();
    }, "检查档案", { cancelText: "取消", className: "import-bundle-modal" });
    this._bindSampleArchiveBatchSelectionHandlers();
    this._updateSampleArchiveBatchOkButton();
  },

});
