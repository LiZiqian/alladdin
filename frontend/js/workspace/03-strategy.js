/* ========================================
   数字治理平台 V7 - 阶段策略配置模块
   含策略页导航·BOM·测试策略·用例导入
   ======================================== */

app.registerModule("workspace.strategy", {

  // ==================== 阶段策略配置页 ====================
  openStageStrategy(stageId) {
    if (this.stageStrategyId() && this.stageStrategyId() !== stageId) this.prepareStageStrategyNavigation();
    this.selectWorkspaceStageState(stageId);
    this.patchViewState({
      stageStrategyId: stageId,
      module: "projectWorkspace"
    });
    this.render();
  },

  closeStageStrategy() {
    this.prepareStageStrategyNavigation();
    this.render();
  },

  leaveStageStrategy(targetModule = "projectWorkspace") {
    this.prepareStageStrategyNavigation();
    this.navigateModuleState(targetModule);
    this.render();
  },

  stageStrategyContext() {
    const project = this.currentProject();
    const strategyId = this.stageStrategyId();
    const stage = project?.stages?.find(item => String(item.id || "") === String(strategyId || "")) || this.currentStage();
    return { project, stage };
  },

  async persistStageStrategyMutation(action = "update_stage_strategy", remark = "阶段策略增量保存", { render = false, project = null, stage = null } = {}) {
    const p = project || this.currentProject();
    const s = stage || this.currentStage();
    if (!p || !s) return false;
    this._stageStrategyMutations ||= new Map();
    const key = `${p.id}:${s.id}`;
    const epoch = this._dataSnapshotEpoch || 0;
    const previous = this._stageStrategyMutations.get(key);
    const save = async () => {
      if ((this._dataSnapshotEpoch || 0) !== epoch) return false;
      return this.commitStageMutation(p, s, { action, remark, user: "管理员", render });
    };
    const pending = previous ? previous.then(save, save) : save();
    this._stageStrategyMutations.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this._stageStrategyMutations.get(key) === pending) this._stageStrategyMutations.delete(key);
    }
  },

  scheduleStageStrategySave(delay = 450, action = "update_stage_strategy", remark = "阶段策略编辑") {
    clearTimeout(this._stageStrategySaveTimer);
    const { project, stage } = this.stageStrategyContext();
    if (!project || !stage) return;
    this.updateServerStatus("待同步");
    this._stageStrategySaveTimer = setTimeout(() => {
      this._stageStrategySaveTimer = null;
      this.persistStageStrategyMutation(action, remark, { render: false, project, stage });
    }, delay);
  },

  prepareStageStrategyNavigation() {
    if (!this.stageStrategyId()) return false;
    const { project, stage } = this.stageStrategyContext();
    clearTimeout(this._stageStrategySaveTimer);
    clearTimeout(this._strategySyncTimer);
    this._stageStrategySaveTimer = null;
    this._strategySyncTimer = null;
    if (project && stage) {
      this.autoSyncProgress({ project, stage, persist: false });
      this.persistStageStrategyMutation("leave_stage_strategy", "离开阶段策略页保存", {
        render: false,
        project,
        stage
      });
    }
    this.clearStageStrategyState();
    return true;
  },

  renderStageStrategyPage() {
    const p = this.currentProject();
    const s = p?.stages.find(st => st.id === this.stageStrategyId()) || this.currentStage();
    if (!p || !s) { this.clearStageStrategyState(); this.render(); return; }
    this.selectWorkspaceStageState(s.id);
    this.replaceStageStrategyContentNodes(document.getElementById("content"), this.stageStrategyPageNodes(s));
  },

  replaceStageStrategyContentNodes(target, nodes = []) {
    if (!target) return null;
    if (typeof target.replaceChildren === "function") target.replaceChildren(...nodes);
    else {
      this.replaceHtml(target, "");
      nodes.forEach(node => target.append?.(node));
    }
    return target;
  },

  stageStrategyPageNodes(stage) {
    const editPanel = document.createElement("div");
    editPanel.className = "card stage-edit-panel";
    const intro = document.createElement("div");
    intro.className = "stage-config-title";
    const title = document.createElement("h3");
    title.style.margin = "0";
    title.textContent = "阶段与方案物料配置";
    intro.append(title);
    this.appendWorkspaceHtml(intro, this.projectConfigHelpHtml("scheme-materials", "阶段与方案物料配置说明", "每行一个方案，每列一种物料；在单元格中填写规格、版本、数量或差异说明。"));
    const editor = document.createElement("div");
    editor.className = "inline-stage-editor";
    this.replaceHtml(editor, this.inlineStageEditorHtml(stage));
    editPanel.append(intro, editor);

    const strategy = document.createElement("div");
    strategy.className = "card workspace-section section-purple";
    this.replaceHtml(strategy, this.workspaceStrategyHtml(stage));
    return [editPanel, strategy];
  },

  // Rows are schemes; columns retain the existing material/skuN storage mapping.
  workspaceBomHtml(stage) {
    const names = stage.skuNames?.length ? stage.skuNames : ["SKU1"];
    const materials = stage.bom || [];
    const columnCount = Math.max(4, materials.length);
    const emptyHeaders = '<th scope="col" class="scheme-bom-placeholder" aria-label="未使用物料列"></th>'.repeat(columnCount - materials.length);
    const emptyCells = '<td class="scheme-bom-placeholder"></td>'.repeat(columnCount - materials.length);
    return `
      <div class="scheme-bom-toolbar">
        <strong>方案与 BOM 上料清单</strong>
        <div class="scheme-bom-actions">
          <button type="button" class="btn btn-sm btn-add" data-app-action="matrix-sku-add">+ 增加方案</button>
          <button type="button" class="btn btn-sm btn-add" data-app-action="bom-add">+ 增加物料列</button>
        </div>
      </div>
      <div class="scheme-bom-scroll" tabindex="0" aria-label="方案与物料配置表，可横向滚动">
        <table class="scheme-bom-table" style="min-width:${210 + columnCount * 200}px">
          <colgroup><col style="width:210px">${'<col style="width:200px">'.repeat(columnCount)}</colgroup>
          <thead><tr><th scope="col" class="scheme-bom-name">方案名称<span class="req-star">*</span></th>
            ${materials.map((material, index) => `<th scope="col"><div class="scheme-bom-heading">
              <input value="${Utils.esc(material.materialName || "")}" aria-label="物料 ${index + 1} 名称" placeholder="物料名称" data-app-action="bom-update" data-app-events="input" data-index="${index}" data-field="materialName">
              <button type="button" class="stage-row-delete-btn" data-app-action="bom-delete" data-index="${index}" title="删除物料列" aria-label="删除物料 ${index + 1}">${Utils.iconHtml("trash")}</button>
            </div></th>`).join("")}${emptyHeaders}
          </tr></thead>
          <tbody>${names.map((name, skuIndex) => `<tr>
            <th scope="row" class="scheme-bom-name"><div class="scheme-bom-heading">
              <span class="scheme-bom-index">${skuIndex + 1}</span>
              <input value="${Utils.esc(name)}" aria-label="方案 ${skuIndex + 1} 名称" data-app-action="matrix-sku-name" data-app-events="change" data-index="${skuIndex}">
              <button type="button" class="stage-row-delete-btn" data-app-action="matrix-sku-delete" data-index="${skuIndex}" title="删除方案" aria-label="删除方案 ${Utils.esc(name)}" ${names.length === 1 ? "disabled" : ""}>${Utils.iconHtml("trash")}</button>
            </div></th>
            ${materials.map((material, index) => `<td><textarea rows="1" aria-label="方案 ${Utils.esc(name)}，物料 ${index + 1} 明细" placeholder="规格 / 版本 / 数量 / 说明" data-app-action="bom-update" data-app-events="input" data-index="${index}" data-field="sku${skuIndex + 1}">${Utils.esc(material['sku' + (skuIndex + 1)] || "")}</textarea></td>`).join("")}${emptyCells}
          </tr>`).join("")}</tbody>
        </table>
      </div>`;
  },

  addBomRow() {
    const s = this.currentStage();
    if (!s.bom) s.bom = [];
    s.bom.push({ materialName: "" });
    this.persistStageStrategyMutation("update_bom", "新增 BOM 物料", { render: false });
    this.render();
  },
  updateBom(idx, field, val) {
    const s = this.currentStage();
    if (!s || !s.bom || !s.bom[idx]) return;
    s.bom[idx][field] = val;
    this.scheduleStageStrategySave(450, "update_bom", "编辑 BOM 物料");
  },
  deleteBomRow(idx) {
    const s = this.currentStage();
    const row = s?.bom?.[idx];
    if (!s || !row) return;
    const name = String(row.materialName || "").trim() || `第 ${idx + 1} 列`;
    this.showConfirm(`确认删除 BOM 物料「${name}」？`, async () => {
      const latest = this.currentStage();
      if (!latest?.bom?.[idx]) return;
      latest.bom.splice(idx, 1);
      await this.persistStageStrategyMutation("update_bom", "删除 BOM 物料", { render: false });
      this.render();
    }, { title: "删除 BOM 物料", okText: "删除", okClass: "btn btn-danger" });
  },

  // ==================== 测试策略配置（删除"生成/同步进展"按钮）====================
  stageStrategyFilterText(row) {
    const category = String(row?.category || "").trim().toLowerCase();
    const item = String(row?.item || "").trim().toLowerCase();
    return { category, item };
  },
  stageStrategyRowMatches(row, keyword) {
    const kw = String(keyword || "").trim().toLowerCase();
    if (!kw) return true;
    const text = this.stageStrategyFilterText(row);
    return text.category.includes(kw) || text.item.includes(kw);
  },
  stageStrategyVisibleRows(stage) {
    const filters = this.ensureViewMap("stageStrategyFilters");
    const includeKw = String(filters.includeKeyword || "").trim();
    const excludeKw = String(filters.excludeKeyword || "").trim();
    return (stage.strategy || [])
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => this.stageStrategyRowMatches(row, includeKw))
      .filter(({ row }) => !excludeKw || !this.stageStrategyRowMatches(row, excludeKw));
  },
  stageStrategySearchHtml(stage, visibleRows) {
    const filters = this.ensureViewMap("stageStrategyFilters");
    const includeKeyword = filters.includeKeyword || "";
    const excludeKeyword = filters.excludeKeyword || "";
    const total = (stage.strategy || []).length;
    const visible = visibleRows.length;
    const hasFilter = String(includeKeyword || "").trim() || String(excludeKeyword || "").trim();
    return `
      <div class="strategy-search-bar">
        <label class="strategy-search-field">
          <span>正向搜索</span>
          <input type="text" value="${Utils.esc(includeKeyword)}" placeholder="类别 / 用例名称"
            data-app-action="stage-strategy-filter" data-app-events="input" data-field="includeKeyword">
        </label>
        <label class="strategy-search-field">
          <span>反向搜索</span>
          <input type="text" value="${Utils.esc(excludeKeyword)}" placeholder="排除类别 / 用例名称"
            data-app-action="stage-strategy-filter" data-app-events="input" data-field="excludeKeyword">
        </label>
        <div class="strategy-search-count">显示 ${visible} / ${total} 条</div>
        <button type="button" class="btn btn-sm btn-outline" ${hasFilter ? "" : "disabled"} data-app-action="stage-strategy-clear">清空</button>
      </div>`;
  },
  workspaceStrategyHtml(stage) {
    const p = this.currentProject();
    const caseCount = (p?.testCaseMaster || []).length;
    const visibleRows = this.stageStrategyVisibleRows(stage);
    const skuNames = Array.isArray(stage.skuNames) ? stage.skuNames : [];
    const strategyScrollMinWidth = Math.max(180, (skuNames.length * 92) + 86);
    return `
      <div class="section-head">
        <div class="stage-config-title">
          <h3 style="margin:0">测试策略配置</h3>
          ${this.projectConfigHelpHtml("test-strategy", "测试策略配置说明", "STEP1（可选）：可以手动导入一个测试用例集\nSTEP2：点击「新增测试项」，在测试项列表中新增一行测试用例\nSTEP3：搜索选择或手动输入测试项\nSTEP4：勾选需要被执行的方案")}
        </div>
        <div class="case-tools">
          <span class="case-master-badge">用例库：${caseCount} 条</span>
          <button class="btn btn-sm btn-outline" data-app-action="test-case-template-download">下载导入用例模板</button>
          <button class="btn btn-sm btn-outline" data-app-action="test-case-import">导入用例集</button>
        </div>
      </div>
      ${this.stageStrategySearchHtml(stage, visibleRows)}
      <div class="mini-table wide-table-scroll split-table strategy-table">
        <div class="split-frozen strategy-frozen">
          <table class="strategy-config-table strategy-frozen-table">
            <colgroup>
              <col class="col-row-no">
              <col class="col-test-category">
              <col class="col-test-item">
              <col class="col-sample-size">
            </colgroup>
            <thead><tr>
              <th></th>
              <th style="color:var(--primary);font-weight:900">测量类别<span class="req-star">*</span></th>
              <th style="color:var(--primary);font-weight:900">用例名称<span class="req-star">*</span></th>
              <th style="color:var(--primary);font-weight:900">样机数<span class="req-star">*</span></th>
            </tr></thead>
            <tbody>${visibleRows.map(({ row: r, index: idx }) => `
              <tr data-strategy-row="${idx}">
                <td class="row-no">${idx + 1}</td>
                <td><input data-field="category" data-index="${idx}" data-app-action="strategy-input" data-app-events="focusin click input" value="${Utils.esc(r.category || "")}" autocomplete="off"
                  placeholder="选择或输入"></td>
                <td><input data-field="item" data-index="${idx}" data-app-action="strategy-input" data-app-events="focusin click input" value="${Utils.esc(r.item || "")}" autocomplete="off"
                  placeholder="搜索/选择/输入"></td>
                <td><input data-field="sampleSize" data-index="${idx}" data-app-action="strategy-input" data-app-events="input focusout" type="number" min="1" step="1" value="${Utils.esc(r.sampleSize || "")}"
                  placeholder="正整数"></td>
              </tr>`).join("") || `<tr><td colspan="4" class="empty">${(stage.strategy || []).length ? "无匹配策略，请调整搜索条件。" : "暂无策略。先新增测试项。"}</td></tr>`}</tbody>
          </table>
        </div>
        <div class="split-scroll strategy-scroll">
          <table class="strategy-config-table strategy-scroll-table" style="min-width:${strategyScrollMinWidth}px">
            <colgroup>
              ${skuNames.map(() => `<col class="col-strategy-sku">`).join("")}
              <col class="col-action">
            </colgroup>
            <thead><tr>
              ${skuNames.map(n => `<th style="color:var(--primary);font-weight:900;text-align:center">${Utils.esc(n)}</th>`).join("")}
              <th>操作</th>
            </tr></thead>
            <tbody>${visibleRows.map(({ row: r, index: idx }) => `
              <tr>
                ${skuNames.map((n, i) => `<td style="text-align:center;vertical-align:middle"><input data-sku="${i + 1}" data-index="${idx}" data-app-action="strategy-sku" data-app-events="change" type="checkbox" style="width:auto;vertical-align:middle" ${r.skuMap?.[i + 1] ? 'checked' : ''}></td>`).join("")}
                <td><button class="stage-row-delete-btn" data-app-action="strategy-delete" data-index="${idx}" title="删除" aria-label="删除测试策略">${Utils.iconHtml("trash")}</button></td>
              </tr>`).join("") || `<tr><td colspan="${skuNames.length + 1}" class="empty"></td></tr>`}</tbody>
          </table>
        </div>
      </div>
        <div class="task-add-footer">
          <button type="button" class="task-add-main" data-app-action="strategy-add">
            <span class="row-action-btn row-add-btn"></span>
            <span>新增测试项</span>
          </button>
        </div>`;
  },

  addStrategyRow() {
    const s = this.currentStage();
    s.strategy.push({ id: Utils.id("strat_"), category: "", item: "", sampleSize: 1, skuMap: { 1: true } });
    this.persistStageStrategyMutation("update_strategy", "新增测试策略", { render: false });
    this.renderPreserveScroll();
  },
  onStrategyInput(idx, field, el) {
    const s = this.currentStage();
    if (!s || !s.strategy[idx]) return;
    // Invalid text stays in the control for correction, never in the save model.
    if (field === 'sampleSize' && !this.validateSampleSizeInput(el)) return;
    s.strategy[idx][field] = field === 'sampleSize' ? Utils.parsePositiveInt(el.value) : el.value;
    // P1.6：方案输入实时静默同步到 progress，避免折叠/关页/导航前未同步导致工作台进度丢失
    this.scheduleStrategySync();
    this.scheduleStageStrategySave(650, "update_strategy", "编辑测试策略");
  },
  validateSampleSizeInput(el) {
    const n = Utils.parsePositiveInt(el.value);
    const error = '样机数必须为大于 0 的整数；本次输入未保存。';
    el.classList.toggle('invalid', n === null);
    el.setAttribute('aria-invalid', String(n === null));
    // The strategy grid has separately rendered frozen/scrolling rows. Keep
    // validation out of row flow so an error cannot misalign the SKU checkboxes.
    el.setAttribute('title', n === null ? error : '');
    if (n === null) {
      this.updateServerStatus(error);
      return false;
    }
    el.value = String(n);
    return true;
  },
  updateStrategySku(idx, sku, val) {
    const s = this.currentStage();
    if (!s.strategy[idx].skuMap) s.strategy[idx].skuMap = {};
    s.strategy[idx].skuMap[sku] = val;
    // P1.6：SKU 勾选立刻同步到进度并保存
    this.autoSyncProgress();
    this.persistStageStrategyMutation("update_strategy", "编辑测试策略 SKU", { render: false });
  },

  /** P1.6：方案输入实时静默同步到 progress（节流），避免离开页面/关闭浏览器时丢同步。 */
  scheduleStrategySync(delay = 800) {
    clearTimeout(this._strategySyncTimer);
    const { project, stage } = this.stageStrategyContext();
    const strategyId = this.stageStrategyId();
    this._strategySyncTimer = setTimeout(() => {
      this._strategySyncTimer = null;
      if (!strategyId || this.stageStrategyId() !== strategyId || this.currentProject()?.id !== project?.id) return;
      try { this.autoSyncProgress({ project, stage }); } catch (e) { console.warn("autoSyncProgress 静默同步失败：", e); }
    }, delay);
  },
  deleteStrategyRow(idx) {
    const s = this.currentStage();
    const row = s?.strategy?.[idx];
    if (!s || !row) return;
    const name = String(row.item || row.category || "").trim() || `第 ${idx + 1} 行`;
    this.showConfirm(`确认删除测试策略「${name}」？`, async () => {
      const latest = this.currentStage();
      if (!latest?.strategy?.[idx]) return;
      latest.strategy.splice(idx, 1);
      await this.persistStageStrategyMutation("update_strategy", "删除测试策略", { render: false });
      this.render();
    }, { title: "删除测试策略", okText: "删除", okClass: "btn btn-danger" });
  },

  syncStrategyFromDom(stage = null) {
    const s = stage || this.currentStage();
    if (!s) return;
    document.querySelectorAll('tr[data-strategy-row]').forEach(tr => {
      const idx = Number(tr.dataset.strategyRow);
      const r = s.strategy[idx];
      if (!r) return;
      const category = tr.querySelector('input[data-field="category"]');
      const item = tr.querySelector('input[data-field="item"]');
      const sampleSize = tr.querySelector('input[data-field="sampleSize"]');
      if (category) r.category = category.value.trim();
      if (item) r.item = item.value.trim();
      if (sampleSize) r.sampleSize = Utils.normalizeDigits(sampleSize.value);
      if (!r.skuMap) r.skuMap = {};
    });
    document.querySelectorAll('.strategy-scroll-table input[data-sku]').forEach(cb => {
      const r = s.strategy[Number(cb.dataset.index)];
      if (!r) return;
      if (!r.skuMap) r.skuMap = {};
      r.skuMap[cb.dataset.sku] = cb.checked;
    });
  },

  /** 自动同步进展（返回工作台时调用，静默执行）*/
  autoSyncProgress({ project = null, stage = null, persist = true } = {}) {
    const p = project || this.currentProject();
    const s = stage || this.currentStage();
    if (!s) return;
    this.syncStrategyFromDom(s);

    const expected = new Map();
    s.strategy.forEach(r => {
      const n = Utils.parsePositiveInt(r.sampleSize);
      r.sampleSize = n === null ? Utils.normalizeDigits(r.sampleSize) : n;
      if (!r.item || n === null) return;
      s.skuNames.forEach((skuName, i) => {
        const sku = i + 1;
        if (r.skuMap?.[sku]) expected.set(`${r.id}_${sku}`, { strategyId: r.id, testItem: r.item, category: r.category, skuIndex: sku, sampleSize: n });
      });
    });

    let kept = [], addedCount = 0, removedCount = 0;
    (s.progress || []).forEach(p => {
      const key = `${p.strategyId}_${p.skuIndex}`;
      if (expected.has(key)) { kept.push({ ...p, ...expected.get(key) }); expected.delete(key); }
      else removedCount++;
    });
    expected.forEach(v => {
      kept.push(this.createProgressRecord(v));
      addedCount++;
    });
    s.progress = kept;

    if (addedCount || removedCount) {
      if (persist) this.persistStageStrategyMutation("sync_strategy_progress", "策略自动同步进度", { render: false, project: p, stage: s });
      Utils.toast(`进展已自动同步：新增 ${addedCount}，移除 ${removedCount}，当前 ${s.progress.length} 条。`);
    }
  },

  downloadTestCaseTemplate() {
    const a = document.createElement("a");
    a.href = "/templates/用例集导入模板.xlsx";
    a.download = "用例集导入模板.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  parseTestCaseImportRows(matrix) {
    const header = matrix[0] || [];
    const columns = ["测试大类", "测试名称", "基线数量"];
    if (!columns.every((name, index) => String(header[index] ?? "").trim() === name)) {
      throw new Error("请使用新版三列模板：测试大类、测试名称、基线数量（可留空）。");
    }
    const rows = [];
    for (let i = 1; i < matrix.length; i++) {
      const cols = matrix[i] || [];
      const category = String(cols[0] ?? "").trim();
      const item = String(cols[1] ?? "").trim();
      const baselineText = String(cols[2] ?? "").trim();
      if ((!category && !item && !baselineText) || category.startsWith("如：")) continue;
      if (!category || !item) throw new Error(`第 ${i + 1} 行：测试大类和测试名称不能为空。`);
      const baselineCount = baselineText === "" ? null : Utils.parsePositiveInt(baselineText);
      if (baselineText !== "" && baselineCount === null) {
        throw new Error(`第 ${i + 1} 行「基线数量」必须是不小于 1 的正整数，或留空。`);
      }
      rows.push({ category, item, baselineCount });
    }
    if (!rows.length) throw new Error("没有可导入的测试用例，请填写数据后重试。示例行不会导入。");
    return rows;
  },

  async importTestCaseXlsx() {
    const targetProject = this.currentProject();
    if (!targetProject) { alert("请先选择一个项目。"); return; }
    const projectId = targetProject.id;
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    input.addEventListener("change", async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        const files = await Utils.unzipXlsxFiles(buffer);
        const sharedStrings = Utils.parseXlsxSharedStrings(files["xl/sharedStrings.xml"] || "");
        const sheetPath = Utils.firstXlsxWorksheet(files).path;
        const matrix = Utils.parseXlsxSheet(files[sheetPath], sharedStrings, new Set());
        const rows = this.parseTestCaseImportRows(matrix);
        const p = typeof this.findProjectRecord === "function" ? this.findProjectRecord(projectId) : targetProject;
        if (!p) { alert("请先选择一个项目。"); return; }
        const snapshot = this.dataSnapshot();
        p.testCaseMaster = rows;
        const saved = await this.commitProjectMutation(p, {
          action: "import_test_cases",
          remark: "导入测试用例集",
          user: "管理员",
          render: false
        });
        if (!saved) {
          this.restoreDataSnapshot(snapshot);
          return;
        }
        Utils.toast(`已导入 ${rows.length} 条测试用例。`);
        this.render();
      } catch (e) {
        alert("导入用例集失败：" + (e.message || e));
      }
    }, { once: true });
    input.click();
  },

});
