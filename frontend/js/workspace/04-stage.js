/* ========================================
   数字治理平台 V7 - 阶段与SKU编辑模块
   ======================================== */

app.registerModule("workspace.stage", {

  selectStageAfterMutation(stageId) {
    if (typeof this.selectWorkspaceStageState === "function") return this.selectWorkspaceStageState(stageId);
    return this.patchViewState({ selectedStageId: stageId || null });
  },

  // ==================== 阶段 CRUD ====================
  inlineStageEditorHtml(stage) {
    return `
      <div class="inline-stage-name">
        <label for="inlineStageName">阶段名称<span class="req-star">*</span></label>
        <input id="inlineStageName" value="${Utils.esc(stage.name || "")}" data-app-action="inline-stage-name" data-app-events="input focusout">
      </div>
      ${this.workspaceBomHtml(stage)}`;
  },
  renameMatrixSku(index, input) {
    const stage = this.currentStage();
    if (!stage || !stage.skuNames?.[index]) return;
    const name = input.value.trim();
    if (!name || stage.skuNames.some((other, i) => i !== index && other === name)) {
      input.value = stage.skuNames[index];
      Utils.toast(name ? "方案名称不能重复" : "方案名称不能为空");
      return;
    }
    stage.skuNames[index] = name;
    this.scheduleStageStrategySave(0, "update_stage_skus_inline", "编辑方案名称");
    // Refresh labels in the strategy table without replacing the focused matrix.
    document.querySelectorAll(".strategy-scroll-table thead th")[index]?.replaceChildren(document.createTextNode(name));
  },
  addMatrixSku() {
    const stage = this.currentStage();
    if (!stage) return;
    stage.skuNames ||= [];
    let number = stage.skuNames.length + 1;
    while (stage.skuNames.includes("方案" + number)) number++;
    stage.skuNames.push("方案" + number);
    this.scheduleStageStrategySave(0, "update_stage_skus_inline", "新增方案");
    this.render();
  },
  removeMatrixSku(index) {
    const stage = this.currentStage();
    if (!stage || !Number.isInteger(index) || index < 0 || index >= stage.skuNames.length || stage.skuNames.length <= 1) return;
    this.showConfirm(`删除方案「${stage.skuNames[index]}」及其物料明细和测试配置？`, async () => {
      if (this.currentStage() !== stage) return;
      const draft = JSON.parse(JSON.stringify(stage));
      const count = draft.skuNames.length;
      draft.skuNames.splice(index, 1);
      (draft.bom || []).forEach(material => {
        for (let i = index + 1; i < count; i++) {
          if (Object.hasOwn(material, "sku" + (i + 1))) material["sku" + i] = material["sku" + (i + 1)];
          else delete material["sku" + i];
        }
        delete material["sku" + count];
      });
      (draft.strategy || []).forEach(row => {
        if (!row.skuMap) return;
        for (let i = index + 1; i < count; i++) {
          if (Object.hasOwn(row.skuMap, i + 1)) row.skuMap[i] = row.skuMap[i + 1];
          else delete row.skuMap[i];
        }
        delete row.skuMap[count];
      });
      draft.progress = (draft.progress || []).filter(row => Number(row.skuIndex) !== index + 1).map(row => Number(row.skuIndex) > index + 1 ? { ...row, skuIndex: Number(row.skuIndex) - 1 } : row);
      clearTimeout(this._stageStrategySaveTimer);
      this._stageStrategySaveTimer = null;
      const saved = await this.persistStageStrategyMutation("remove_scheme", "删除方案", { render: false, stage: draft });
      if (saved && this.currentStage() === stage) {
        for (const key of ["skuNames", "bom", "strategy", "progress"]) stage[key] = draft[key];
      }
      this.render();
    }, { title: "删除方案", okText: "删除" });
  },
  inlineSkuRowHtml(name = "", idx = 0) {
    return `<div class="inline-sku-row">
      <div class="idx">#${idx + 1}</div>
      <input class="inline-sku-name-input" value="${Utils.esc(name || "")}" placeholder="输入方案名" data-app-action="inline-stage-skus" data-app-events="input focusout">
      <button type="button" class="icon-btn" data-app-action="inline-sku-remove">−</button>
    </div>`;
  },
  inlineSkuRowNode(name = "", idx = 0) {
    const row = document.createElement("div");
    row.className = "inline-sku-row";

    const label = document.createElement("div");
    label.className = "idx";
    label.textContent = `#${idx + 1}`;

    const input = document.createElement("input");
    input.className = "inline-sku-name-input";
    input.value = name || "";
    input.placeholder = "输入方案名";
    input.dataset.appAction = "inline-stage-skus";
    input.dataset.appEvents = "input focusout";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.dataset.appAction = "inline-sku-remove";
    remove.textContent = "−";

    row.append(label, input, remove);
    return row;
  },
  persistCurrentStageMutation(action = "update_stage_inline", remark = "阶段内联编辑", { render = false } = {}) {
    const p = this.currentProject();
    const s = this.currentStage();
    if (!p || !s) return Promise.resolve(false);
    return this.commitStageMutation(p, s, { action, remark, user: "管理员", render });
  },
  updateInlineStageName(value) {
    const s = this.currentStage();
    if (!s) return;
    s.name = String(value || "").trim();
    this.renderHeader();
  },
  normalizeInlineStageName(input) {
    const s = this.currentStage();
    if (!s || !input) return;
    const name = String(input.value || "").trim();
    if (!name) {
      input.value = s.name || "阶段";
      return;
    }
    s.name = name;
    this.persistCurrentStageMutation("update_stage_name_inline", "内联编辑阶段名称");
    this.renderHeader();
  },
  readInlineSkuInputs() {
    return [...document.querySelectorAll("#inlineSkuList .inline-sku-name-input")]
      .map(x => x.value.trim())
      .filter(Boolean);
  },
  updateInlineSkus() {
    const s = this.currentStage();
    if (!s) return;
    const names = this.readInlineSkuInputs();
    if (!names.length) return;
    s.skuNames = names;
  },
  normalizeInlineSkus() {
    const s = this.currentStage();
    if (!s) return;
    const names = this.readInlineSkuInputs();
    if (!names.length) {
      s.skuNames = ["SKU1"];
      this.render();
      return;
    }
    s.skuNames = names;
    this.persistCurrentStageMutation("update_stage_skus_inline", "内联编辑阶段 SKU", { render: true });
    this.render();
  },
  addInlineSku(value = "") {
    const s = this.currentStage();
    if (!s) return;
    const list = document.getElementById("inlineSkuList");
    if (list) {
      const idx = list.querySelectorAll(".inline-sku-row").length;
      list.appendChild(this.inlineSkuRowNode(value, idx));
      this.refreshInlineSkuIndexes();
      return;
    }
    if (!Array.isArray(s.skuNames) || !s.skuNames.length) s.skuNames = [];
    if (value) s.skuNames.push(value);
    this.persistCurrentStageMutation("update_stage_skus_inline", "内联新增阶段 SKU", { render: true });
    this.render();
  },
  removeInlineSku(btn) {
    const s = this.currentStage();
    if (!s || !Array.isArray(s.skuNames)) return;
    const row = btn.closest(".inline-sku-row");
    const rows = [...document.querySelectorAll("#inlineSkuList .inline-sku-row")];
    const idx = rows.indexOf(row);
    if (rows.length <= 1) { alert("至少保留一个 SKU"); return; }
    row?.remove();
    const names = this.readInlineSkuInputs();
    s.skuNames = names.length ? names : (s.skuNames.length ? s.skuNames : ["SKU1"]);
    this.persistCurrentStageMutation("update_stage_skus_inline", "内联删除阶段 SKU", { render: true });
    this.render();
  },
  refreshInlineSkuIndexes() {
    document.querySelectorAll("#inlineSkuList .inline-sku-row").forEach((row, idx) => {
      const label = row.querySelector(".idx");
      if (label) label.innerText = "#" + (idx + 1);
    });
  },

  skuEditorHtml(names, options = {}) {
    const placeholder = options.placeholder || "输入方案名，如：主方案、A1、B7";
    const rows = (names || ["SKU1"]).map((name, idx) => `
      <div class="sku-row">
        <div class="idx">#${idx + 1}</div>
        <input class="sku-name-input" value="${Utils.esc(name || "")}" placeholder="${Utils.esc(placeholder)}">
        <button type="button" class="icon-btn" data-app-action="sku-input-remove">−</button>
      </div>
    `).join("");
    return `<div class="sku-editor"><div id="skuList">${rows}</div>
      <button type="button" class="btn btn-sm btn-outline" data-app-action="sku-input-add">+ 增加方案</button></div>`;
  },
  skuRowNode(value = "", idx = 1) {
    const row = document.createElement("div");
    row.className = "sku-row";

    const label = document.createElement("div");
    label.className = "idx";
    label.textContent = `#${idx}`;

    const input = document.createElement("input");
    input.className = "sku-name-input";
    input.value = value || "";
    input.placeholder = "如 主方案 / A1 / B7";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.dataset.appAction = "sku-input-remove";
    remove.textContent = "−";

    row.append(label, input, remove);
    return row;
  },
  addSkuInput(value = "") {
    const list = document.getElementById("skuList"); if (!list) return;
    const idx = list.querySelectorAll(".sku-row").length + 1;
    list.appendChild(this.skuRowNode(value, idx)); this.refreshSkuIndexes();
  },
  removeSkuInput(btn) {
    const list = document.getElementById("skuList"); if (!list) return;
    if (list.querySelectorAll(".sku-row").length <= 1) { alert("至少保留一个 SKU"); return; }
    btn.closest(".sku-row").remove(); this.refreshSkuIndexes();
  },
  refreshSkuIndexes() {
    document.querySelectorAll("#skuList .sku-row").forEach((row, idx) => {
      const label = row.querySelector(".idx"); if (label) label.innerText = "#" + (idx + 1);
    });
  },
  readSkuInputs() {
    return [...document.querySelectorAll("#skuList .sku-name-input")].map(x => x.value.trim()).filter(Boolean);
  },

  addStage() {
    this.showModal("新建阶段", `
      <div class="form-group"><label class="req modal-field-title">阶段名称</label><input id="stageName" placeholder="如 V3-1 / VN1"></div>
      <div class="form-group"><label class="req modal-field-title">方案名称</label>${this.skuEditorHtml(["", ""], { placeholder: "如 主方案 / A1 / B7" })}</div>
    `, async () => {
      this.clearFieldValidationMarks();
      const p = this.currentProject();
      if (!p) return;
      const snapshot = this.dataSnapshot();
      const stageNameEl = document.getElementById("stageName");
      const name = stageNameEl.value.trim();
      if (!name) { this.markFieldInvalid(stageNameEl, "阶段名称不能为空"); return true; }
      const skuNames = this.readSkuInputs();
      if (!skuNames.length) {
        const skuInput = document.querySelector(".sku-name-input");
        this.markFieldInvalid(skuInput || stageNameEl, "请至少输入一个方案名称");
        return true;
      }
      if (new Set(skuNames).size !== skuNames.length) {
        const skuInput = document.querySelector(".sku-name-input");
        this.markFieldInvalid(skuInput || stageNameEl, "方案名称不能重复");
        return true;
      }
      const s = { id: Utils.id("stage_"), name, skuNames, bom: Array.from({ length: 4 }, () => ({ materialName: "" })), strategy: [], progress: [], tasks: [] };
      p.stages.push(s);
      this.selectStageAfterMutation(s.id);
      const saved = await this.commitStageMutation(p, s, {
        action: "create_stage",
        remark: "新建阶段",
        user: "管理员",
        createIfMissing: true
      });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("阶段已新建");
      return false;
    });
  },

  editStage(id) {
    const projectId = this.currentProject()?.id;
    const s = this.currentProject()?.stages.find(x => x.id === id);
    if (!s) return;
    this.showModal("编辑阶段与 SKU", `
      <div class="form-group"><label class="req modal-field-title">阶段名称</label><input id="stageName" value="${Utils.esc(s.name)}"></div>
      <div class="form-group"><label class="req modal-field-title">方案名称</label>${this.skuEditorHtml(s.skuNames?.length ? s.skuNames : ["SKU1"], { placeholder: "如 主方案 / A1 / B7" })}</div>
    `, async () => {
      this.clearFieldValidationMarks();
      const p = this.findProjectRecord(projectId);
      const s = p?.stages?.find(stage => stage.id === id);
      if (!p || !s) { alert("阶段已不存在，请关闭后刷新。"); return true; }
      const snapshot = this.dataSnapshot();
      const stageNameEl = document.getElementById("stageName");
      const name = stageNameEl.value.trim();
      if (!name) { this.markFieldInvalid(stageNameEl, "阶段名称不能为空"); return true; }
      const skuNames = this.readSkuInputs();
      if (!skuNames.length) {
        const skuInput = document.querySelector(".sku-name-input");
        this.markFieldInvalid(skuInput || stageNameEl, "至少保留一个 SKU");
        return true;
      }
      if (new Set(skuNames).size !== skuNames.length) {
        this.markFieldInvalid(document.querySelector(".sku-name-input") || stageNameEl, "方案名称不能重复");
        return true;
      }
      s.name = name; s.skuNames = skuNames;
      const saved = await this.commitStageMutation(p, s, {
        action: "update_stage",
        remark: "编辑阶段",
        user: "管理员"
      });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("阶段已保存");
      return false;
    });
  },

  async deleteStage(id) {
    const request = this.beginDialogRequest?.();
    let p = this.currentProject();
    if (!p) return;
    p = await this.ensureProjectLoaded(p.id, { includeTasks: true, render: false });
    if (!p || this.isDialogRequestCurrent?.(request) === false) return;
    const stage = (p.stages || []).find(s => s.id === id);
    if (!stage) return;
    // 安全机制：阶段下存在「进行中/未完成」任务且占用样机时，禁止直接删除，避免样机占用状态丢失
    const tasks = (stage.tasks || []).filter(t => !t.archived);
    const activeTasks = tasks.filter(t => !this.isTaskCompleted(t));
    const occupyingTasks = activeTasks.filter(t => (t.sampleIds || []).length > 0);
    if (occupyingTasks.length) {
      const names = occupyingTasks.map(t => t.testItem || "未命名任务").slice(0, 5).join("、");
      alert(`无法删除阶段「${stage.name}」：该阶段存在 ${occupyingTasks.length} 个未完成且占用样机的任务（${names}${occupyingTasks.length > 5 ? " 等" : ""}）。\n\n请先结束或释放这些任务的样机后再删除阶段。`);
      return;
    }
    const taskCount = tasks.length;
    const extraWarn = taskCount
      ? `\n\n该阶段含 ${taskCount} 个任务。删除后阶段将从项目工作台隐藏；已完成任务的测试履历继续保留，未完成任务数据将被清理。`
      : "";
    this.showConfirm(`确认删除阶段「${stage.name}」？${extraWarn}`, async () => {
      const snapshot = this.dataSnapshot();
      // 只释放未完成任务占用的样机；已完成任务的样机状态不变。
      const affectedSampleIds = new Set();
      activeTasks.forEach(t => (t.sampleIds || []).forEach(id => affectedSampleIds.add(id)));
      p.stages = p.stages.filter(s => s.id !== id);
      this.selectStageAfterMutation(p.stages[0]?.id || null);
      affectedSampleIds.forEach(id => {
        if (typeof this.isSampleUsedByAnotherOpenTask === "function"
            && !this.isSampleUsedByAnotherOpenTask(id, null)
            && typeof this.changeSampleStatus === "function") {
          this.changeSampleStatus(id, "闲置", { user: "管理员", source: "删除阶段", reason: `删除阶段「${stage.name}」回收样机` });
        }
      });
      const affectedSamples = [...affectedSampleIds].map(sampleId => this.findSample(sampleId)?.sample).filter(Boolean);
      const sampleEvents = this.sampleEventRecords().filter(log => affectedSampleIds.has(String(log?.sampleId || "")));
      const saved = await this.commitStageMutation(p, stage, {
        action: "delete_stage",
        remark: "删除阶段",
        user: "管理员",
        deleteStage: true,
        samples: affectedSamples,
        sampleEvents,
        render: false
      });
      if (!saved) { this.restoreDataSnapshot(snapshot); return; }
      this.render();
      Utils.toast("阶段已删除");
    }, { title: "删除阶段", okText: "删除", okClass: "btn btn-danger" });
  },
  copyStage(id) {
    const p = this.currentProject();
    const source = p?.stages?.find(s => s.id === id);
    if (!p || !source) return;
    const projectId = p.id;
    this.showModal("复制阶段", `
      <div class="form-group">
        <label class="req modal-field-title">新阶段名称</label>
        <input id="copyStageName" placeholder="如 V3 / VN1">
      </div>
    `, async () => {
      const p = this.findProjectRecord(projectId);
      const source = p?.stages?.find(stage => stage.id === id);
      if (!p || !source) { alert("来源阶段已不存在，请关闭后刷新。"); return true; }
      this.clearFieldValidationMarks();
      const snapshot = this.dataSnapshot();
      const copyNameEl = document.getElementById("copyStageName");
      const name = copyNameEl.value.trim();
      if (!name) { this.markFieldInvalid(copyNameEl, "阶段名称不能为空"); return true; }
      if (p.stages.some(s => s.name === name)) { this.markFieldInvalid(copyNameEl, "阶段名称已存在"); return true; }

      const cloned = JSON.parse(JSON.stringify(source));
      cloned.id = Utils.id("stage_");
      cloned.name = name;
      cloned.bom = (cloned.bom || []).map(row => ({ ...row }));
      const strategyIdMap = new Map();
      cloned.strategy = (cloned.strategy || []).map(row => {
        const newId = Utils.id("strat_");
        strategyIdMap.set(row.id, newId);
        return { ...row, id: newId };
      });
      cloned.progress = (cloned.progress || []).map(item => ({
        ...item,
        id: Utils.id("prog_"),
        strategyId: strategyIdMap.get(item.strategyId) || item.strategyId,
        status: "待下发",
        owner: "",
        startDate: "",
        endDate: "",
        issue: "",
        sampleIds: []
      }));
      cloned.tasks = [];

      const sourceIdx = p.stages.findIndex(s => s.id === id);
      p.stages.splice(sourceIdx + 1, 0, cloned);
      this.selectStageAfterMutation(cloned.id);
      const saved = await this.commitStageMutation(p, cloned, {
        action: "copy_stage",
        remark: "复制阶段",
        user: "管理员",
        createIfMissing: true
      });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast(`已复制阶段：${name}`);
      return false;
    });
  },

});
