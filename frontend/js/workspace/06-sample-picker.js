/* ========================================
   数字治理平台 V7 - 样机选择器模块
   ======================================== */

app.registerModule("workspace.samplePicker", {

  getSelectedTaskSampleIds(inputName) {
    const state = this._taskSamplePickerStates?.[inputName];
    if (state?.selectedIds instanceof Set) return [...state.selectedIds];
    const query = `input[name='${inputName}']:checked`;
    return [...(document.querySelectorAll?.(query) || [])].map(x => x.value);
  },

  async ensureTaskSamplePickerDataLoaded() {
    return true;
  },

  taskSamplePickerSafeKey(inputName) {
    return String(inputName || "samplePick").replace(/[^a-zA-Z0-9_]/g, "_");
  },

  taskSamplePickerDomId(inputName) {
    return `taskSamplePicker_${this.taskSamplePickerSafeKey(inputName)}`;
  },

  taskSamplePickerControlId(inputName, suffix) {
    return `${this.taskSamplePickerDomId(inputName)}_${suffix}`;
  },

  resetTaskSamplePickerState(inputName, { selectedIds = [], progressSelectId = "", hintId = "", excludeTaskId = "", progressId = "", requiredSampleCount = null, categoryId = null, planStartInputId = "", planEndInputId = "", showScheduleHint = true, selectedHeaderHtml = "" } = {}) {
    if (!this._taskSamplePickerStates) this._taskSamplePickerStates = {};
    const uniqueSelected = [...new Set((selectedIds || []).map(id => String(id || "").trim()).filter(Boolean))];
    const initialCategoryId = categoryId === null || typeof categoryId === "undefined"
      ? this.projectDefaultSampleCategoryId?.()
      : String(categoryId || "").trim();
    this._taskSamplePickerStates[inputName] = {
      inputName,
      progressSelectId,
      hintId,
      excludeTaskId,
      progressId,
      requiredSampleCount,
      planStartInputId,
      planEndInputId,
      showScheduleHint,
      selectedHeaderHtml,
      selectedIds: new Set(uniqueSelected),
      page: 1,
      pageSize: 50,
      categoryId: initialCategoryId || "",
      status: "",
      problemState: "",
      reassembled: "",
      keyword: "",
      excludeKeyword: "",
      keywordDraft: "",
      excludeKeywordDraft: "",
      categories: [],
      lastResult: null,
      sampleCache: new Map(),
      selectedSampleCache: new Map(),
      loadSeq: 0,
      loading: true,
      error: "",
      selectionError: "",
      initialized: false,
    };
    return this._taskSamplePickerStates[inputName];
  },

  taskSamplePickerState(inputName) {
    return this._taskSamplePickerStates?.[inputName] || null;
  },

  buildTaskSamplePickerHtml(selectedIds = [], inputName = "samplePick", progressSelectId = "", hintId = "", excludeTaskId = "", options = {}) {
    const state = this.resetTaskSamplePickerState(inputName, { selectedIds, progressSelectId, hintId, excludeTaskId, ...options });
    return `<div id="${this.taskSamplePickerDomId(inputName)}" class="task-sample-picker" data-task-sample-picker="${Utils.esc(inputName)}">
      ${this.taskSamplePickerContentHtml(state)}
    </div>`;
  },

  initTaskSamplePicker(inputName) {
    const state = this.taskSamplePickerState(inputName);
    if (!state || state.initialized) return;
    state.initialized = true;
    this.loadTaskSamplePickerPage(inputName, { page: 1 });
  },

  taskSamplePickerFetchParams(state, overrides = {}) {
    const params = {
      taskId: state.excludeTaskId || "",
      selectedIds: [...state.selectedIds],
      page: overrides.page || state.page || 1,
      pageSize: state.pageSize || 50,
      categoryId: state.categoryId || "",
      status: state.status || "",
      problemState: state.problemState || "",
      reassembled: state.reassembled || "",
      keyword: state.keyword || "",
      excludeKeyword: state.excludeKeyword || "",
    };
    const start = state.planStartInputId ? document.getElementById(state.planStartInputId) : null;
    const end = state.planEndInputId ? document.getElementById(state.planEndInputId) : null;
    if (start) params.planStartDate = start.value || "";
    if (end) params.planEndDate = end.value || "";
    return params;
  },

  async loadTaskSamplePickerPage(inputName, overrides = {}) {
    const state = this.taskSamplePickerState(inputName);
    if (!state) return false;
    if (overrides.page) state.page = Math.max(1, Number(overrides.page) || 1);
    const loadSeq = (state.loadSeq || 0) + 1;
    state.loadSeq = loadSeq;
    state.loading = true;
    state.error = "";
    this.renderTaskSamplePicker(inputName);
    const epoch = this._dataSnapshotEpoch || 0;
    const ownsRequest = () => this.taskSamplePickerState(inputName) === state && state.loadSeq === loadSeq;
    const isCurrent = () => ownsRequest() && (this._dataSnapshotEpoch || 0) === epoch;
    try {
      const read = () => this.fetchTaskSampleCandidates(this.taskSamplePickerFetchParams(state, overrides));
      const apply = result => {
        if (!isCurrent()) return false;
        state.loading = false;
        state.error = "";
        state.page = result.page || state.page || 1;
        state.pageSize = result.pageSize || state.pageSize || 50;
        state.categories = result.categories || [];
        state.lastResult = result;
        this.cacheTaskSamplePickerResult(state, result);
        this.mergeTaskSampleCandidateResult(result);
        this.renderTaskSamplePicker(inputName);
        return true;
      };
      const applied = typeof this.readCurrentServerData === "function"
        ? await this.readCurrentServerData(read, isCurrent, apply)
        : apply(await read());
      if (!applied && ownsRequest()) {
        state.loading = false;
        state.error = "数据已更新，请重试加载样机列表";
        if (isCurrent()) this.renderTaskSamplePicker(inputName);
      }
      return !!applied;
    } catch (e) {
      if (!isCurrent()) { if (ownsRequest()) state.loading = false; return false; }
      console.error("任务样机候选加载失败：", e);
      state.loading = false;
      state.error = e.message || String(e);
      this.renderTaskSamplePicker(inputName);
      return false;
    }
  },

  cacheTaskSamplePickerResult(state, result = {}) {
    if (!state) return;
    if (!(state.sampleCache instanceof Map)) state.sampleCache = new Map();
    if (!(state.selectedSampleCache instanceof Map)) state.selectedSampleCache = new Map();
    const remember = (sample, selected = false) => {
      const id = String(sample?.id || "");
      if (!id) return;
      const cached = state.sampleCache.get(id) || {};
      const merged = { ...cached, ...sample, _missing: false };
      state.sampleCache.set(id, merged);
      if (selected || state.selectedIds?.has?.(id)) {
        const selectedCached = state.selectedSampleCache.get(id) || {};
        state.selectedSampleCache.set(id, { ...selectedCached, ...merged });
      }
    };
    (result.items || []).forEach(sample => remember(sample, false));
    (result.selectedItems || []).forEach(sample => remember(sample, true));
    (result.selectedMissingIds || []).forEach(id => {
      const sid = String(id || "");
      if (sid) {
        const fallback = { ...state.sampleCache.get(sid), id: sid, _missing: true, status: "" };
        state.sampleCache.set(sid, fallback);
        state.selectedSampleCache.set(sid, fallback);
      }
    });
  },

  taskSamplePickerCandidateItems(state, result = {}) {
    const selectedIds = state?.selectedIds instanceof Set ? state.selectedIds : new Set();
    return (result.items || []).filter(sample => {
      const id = String(sample?.id || "");
      return id && !selectedIds.has(id);
    });
  },

  taskSamplePickerCategoryLabel(state, result = {}) {
    const categoryId = String(state?.categoryId || "");
    if (!categoryId) return "全部样机池";
    const categories = [
      ...(state?.categories || []),
      ...(result?.categories || []),
      ...(typeof this.sampleCategoryRecords === "function" ? this.sampleCategoryRecords() : []),
    ];
    const category = categories.find(item => String(item?.id || "") === categoryId);
    return String(category?.name || categoryId || "未知样机池").trim() || "未知样机池";
  },

  mergeTaskSampleCandidateResult(result = {}) {
    const summaryById = new Map((result.categories || []).map(category => [String(category.id || ""), category]));
    const categories = this.sampleCategoryRecords();
    const existingById = new Map(categories.map(category => [String(category.id || ""), category]));
    const baseById = new Map((this._baseData?.sampleLibrary?.categories || []).map(category => [String(category.id || ""), category]));
    // Candidate hydration can run while another editor has an unsent draft.
    // Refresh untouched fields and acknowledge only the server values read.
    const mergeFields = (current, source, baseline) => {
      Object.entries(source).forEach(([field, value]) => {
        if (!baseline || JSON.stringify(current[field]) === JSON.stringify(baseline[field])) current[field] = value;
      });
      return current;
    };
    (result.categories || []).forEach(summary => {
      const id = String(summary.id || "");
      if (!id) return;
      if (!existingById.has(id)) {
        const category = { ...summary, samples: [], samplesLoaded: false, _summaryOnly: true };
        categories.push(category);
        existingById.set(id, category);
        this.syncHydratedCategoryBaseline?.(category);
      } else {
        const existing = existingById.get(id);
        mergeFields(existing, summary, baseById.get(id));
        if (!Array.isArray(existing.samples)) existing.samples = [];
        this.syncHydratedCategoryBaseline?.(summary);
      }
    });
    [...(result.items || []), ...(result.selectedItems || [])].forEach(sample => {
      const categoryId = String(sample.categoryId || "");
      if (!categoryId) return;
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
        this.syncHydratedCategoryBaseline?.(category);
      }
      if (!Array.isArray(category.samples)) category.samples = [];
      const idx = category.samples.findIndex(item => String(item.id || "") === String(sample.id || ""));
      const baseline = baseById.get(categoryId)?.samples?.find(item => String(item.id || "") === String(sample.id || ""));
      const merged = idx >= 0 ? mergeFields(category.samples[idx], sample, baseline) : sample;
      if (idx >= 0) category.samples[idx] = merged;
      else category.samples.push(merged);
      this.syncHydratedSampleBaseline?.(categoryId, sample);
    });
  },

  captureTaskSamplePickerScroll(el) {
    if (!el) return null;
    const snapshot = {
      ancestors: [],
      bodies: {},
    };
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = window.getComputedStyle?.(parent);
      const overflowY = style?.overflowY || "";
      if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) {
        snapshot.ancestors.push({ el: parent, scrollTop: parent.scrollTop });
      }
      parent = parent.parentElement;
    }
    const selectedBody = el.querySelector(".task-sample-selected-group .dispatch-sample-body");
    const candidateBody = el.querySelector(".task-sample-candidate-group .dispatch-sample-body");
    if (selectedBody) snapshot.bodies.selected = selectedBody.scrollTop;
    if (candidateBody) snapshot.bodies.candidate = candidateBody.scrollTop;
    return snapshot;
  },

  restoreTaskSamplePickerScroll(el, snapshot) {
    if (!el || !snapshot) return;
    const apply = () => {
      (snapshot.ancestors || []).forEach(item => {
        if (item?.el) item.el.scrollTop = item.scrollTop || 0;
      });
      const bodyMap = {
        selected: el.querySelector(".task-sample-selected-group .dispatch-sample-body"),
        candidate: el.querySelector(".task-sample-candidate-group .dispatch-sample-body"),
      };
      Object.entries(snapshot.bodies || {}).forEach(([key, scrollTop]) => {
        if (bodyMap[key]) bodyMap[key].scrollTop = scrollTop || 0;
      });
    };
    apply();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
    else if (typeof setTimeout === "function") setTimeout(apply, 0);
  },

  renderTaskSamplePicker(inputName, { preserveScroll = false } = {}) {
    const state = this.taskSamplePickerState(inputName);
    const el = document.getElementById?.(this.taskSamplePickerDomId(inputName));
    if (!state || !el) return;
    const scrollSnapshot = preserveScroll ? this.captureTaskSamplePickerScroll(el) : null;
    this.replaceHtml(el, this.taskSamplePickerContentHtml(state));
    if (state.progressSelectId && state.hintId) {
      this.updateTaskSampleLimitUI(state.progressSelectId, inputName, state.hintId);
    } else {
      this.updateDispatchSamplePoolCounts(inputName);
    }
    if (scrollSnapshot) this.restoreTaskSamplePickerScroll(el, scrollSnapshot);
  },

  taskSampleScheduleHintHtml() {
    return '<span class="task-sample-schedule-hint">计划时间不重叠可复用样机（含开始日和结束日）；启动时再次检查实际占用。</span>';
  },

  taskSamplePickerContentHtml(state) {
    const result = state.lastResult || {};
    const page = result.page || state.page || 1;
    const totalPages = result.totalPages || 1;
    const total = Number(result.total || 0);
    const selectedCount = state.selectedIds.size;
    const categoryMap = new Map();
    [
      ...(typeof this.sampleCategoryRecords === "function" ? this.sampleCategoryRecords() : []),
      ...(result.categories || []),
      ...(state.categories || []),
    ].forEach(category => {
      const id = String(category?.id || "");
      if (id) categoryMap.set(id, { ...(categoryMap.get(id) || {}), ...category });
    });
    const categoryOptions = [`<option value="" ${state.categoryId ? "" : "selected"}>全部样机池</option>`]
      .concat([...categoryMap.values()].map(category => {
        const id = String(category.id || "");
        const selected = id === String(state.categoryId || "") ? "selected" : "";
        const count = Number(category.sampleCount || 0);
        return `<option value="${Utils.esc(id)}" ${selected}>${Utils.esc(category.name || id)}${count ? ` (${count})` : ""}</option>`;
      })).join("");
    const statusOptions = ["", "闲置", "在位等待", "测试中", "已退库", "取走分析"].map(status => {
      const selected = status === String(state.status || "") ? "selected" : "";
      return `<option value="${Utils.esc(status)}" ${selected}>${status || "测试状态"}</option>`;
    }).join("");
    const problemOptions = [["", "故障不限"], ["ok", "无故障"], ["fault", "有故障"]]
      .map(([value, label]) => `<option value="${value}" ${value === state.problemState ? "selected" : ""}>${label}</option>`).join("");
    const reassemblyOptions = [["", "重组不限"], ["normal", "非重组"], ["reassembled", "重组"]]
      .map(([value, label]) => `<option value="${value}" ${value === state.reassembled ? "selected" : ""}>${label}</option>`).join("");
    const keywordId = this.taskSamplePickerControlId(state.inputName, "keyword");
    const excludeId = this.taskSamplePickerControlId(state.inputName, "exclude");
    const categoryId = this.taskSamplePickerControlId(state.inputName, "category");
    const statusId = this.taskSamplePickerControlId(state.inputName, "status");
    const problemId = this.taskSamplePickerControlId(state.inputName, "problem");
    const reassemblyId = this.taskSamplePickerControlId(state.inputName, "reassembly");
    const selectedItems = this.taskSamplePickerSelectedItems(state);
    const candidateItems = this.taskSamplePickerCandidateItems(state, result);
    const candidateCategoryLabel = this.taskSamplePickerCategoryLabel(state, result);
    const candidateTitle = `候选样机 - ${candidateCategoryLabel}`;
    const candidateHtml = state.loading
      ? `<div class="empty">正在加载候选样机...</div>`
      : state.error
        ? `<div class="empty">候选样机加载失败：${Utils.esc(state.error)} <button type="button" class="btn btn-sm btn-outline" data-app-action="task-sample-picker-page" data-id="${Utils.esc(state.inputName)}" data-value="${page}">重试</button></div>`
        : candidateItems.map(sample => this.taskSamplePickerSampleRowHtml(sample, state)).join("") || `<div class="empty">没有匹配的候选样机。</div>`;
    return `
      ${state.showScheduleHint ? this.taskSampleScheduleHintHtml() : ""}
      <div class="dispatch-sample-group task-sample-selected-group" role="group" aria-label="已选样机" data-sample-input-name="${Utils.esc(state.inputName)}">
        ${state.selectedHeaderHtml || `<div class="dispatch-sample-head">
          <div class="dispatch-sample-title-wrap">
            <div class="dispatch-sample-title">已选样机</div>
            <span class="dispatch-selected-count ${selectedCount ? "has-selected" : ""}" data-total="${selectedCount}">${selectedCount}</span>
          </div>
        </div>`}
        ${state.selectionError ? `<div class="field-error" role="alert">${Utils.esc(state.selectionError)}</div>` : ""}
        <div class="dispatch-sample-body open task-sample-candidate-grid">
          ${selectedItems.length ? selectedItems.map(sample => this.taskSamplePickerSampleRowHtml(sample, state, { selected: true })).join("") : `<div class="empty">尚未选择样机。</div>`}
        </div>
      </div>
      <div class="dispatch-sample-group task-sample-candidate-group" data-sample-input-name="${Utils.esc(state.inputName)}">
        <div class="task-sample-picker-toolbar">
          <div class="dispatch-sample-title task-sample-candidate-title" title="${Utils.esc(candidateTitle)}">候选样机</div>
          <select id="${categoryId}" class="task-sample-pool-filter" aria-label="候选样机池" data-app-action="task-sample-picker-filter" data-app-events="change" data-id="${Utils.esc(state.inputName)}" data-field="categoryId">${categoryOptions}</select>
          <select id="${problemId}" class="task-sample-problem-filter" aria-label="候选样机故障" data-app-action="task-sample-picker-filter" data-app-events="change" data-id="${Utils.esc(state.inputName)}" data-field="problemState">${problemOptions}</select>
          <select id="${reassemblyId}" class="task-sample-reassembly-filter" aria-label="候选样机重组" data-app-action="task-sample-picker-filter" data-app-events="change" data-id="${Utils.esc(state.inputName)}" data-field="reassembled">${reassemblyOptions}</select>
          <select id="${statusId}" class="task-sample-status-filter" aria-label="候选样机测试状态" data-app-action="task-sample-picker-filter" data-app-events="change" data-id="${Utils.esc(state.inputName)}" data-field="status">${statusOptions}</select>
          <input id="${keywordId}" class="dispatch-search-input task-sample-picker-search" value="${Utils.esc(state.keywordDraft || "")}" placeholder="包含搜索" aria-label="包含搜索" data-app-action="task-sample-picker-search" data-app-events="input keydown" data-id="${Utils.esc(state.inputName)}" data-field="keyword">
          <input id="${excludeId}" class="dispatch-search-input dispatch-search-exclude task-sample-picker-search" value="${Utils.esc(state.excludeKeywordDraft || "")}" placeholder="排除搜索" aria-label="排除搜索" data-app-action="task-sample-picker-search" data-app-events="input keydown" data-id="${Utils.esc(state.inputName)}" data-field="excludeKeyword">
          <button type="button" class="dispatch-search-btn" data-app-action="task-sample-picker-search" data-id="${Utils.esc(state.inputName)}" title="搜索">🔍</button>
          <span class="dispatch-match-count">${state.loading ? "加载中" : `候选 ${total} 台`}</span>
          <div class="task-sample-picker-pagination" role="group" aria-label="候选样机分页">
            <span class="dispatch-selected-count" aria-label="第 ${page} 页，共 ${totalPages} 页">${page}/${totalPages}</span>
            <button type="button" class="btn btn-sm btn-outline" ${page <= 1 || state.loading ? "disabled" : `data-app-action="task-sample-picker-page" data-id="${Utils.esc(state.inputName)}" data-value="${Math.max(1, page - 1)}"`}>上一页</button>
            <button type="button" class="btn btn-sm btn-outline" ${page >= totalPages || state.loading ? "disabled" : `data-app-action="task-sample-picker-page" data-id="${Utils.esc(state.inputName)}" data-value="${page + 1}"`}>下一页</button>
          </div>
        </div>
        <div class="dispatch-sample-body open task-sample-candidate-grid">
          ${candidateHtml}
        </div>
      </div>`;
  },

  taskSamplePickerSelectedItems(state) {
    const result = state.lastResult || {};
    const byId = new Map();
    if (state.sampleCache instanceof Map) {
      state.sampleCache.forEach((sample, id) => {
        if (id && sample) byId.set(String(id), sample);
      });
    }
    if (state.selectedSampleCache instanceof Map) {
      state.selectedSampleCache.forEach((sample, id) => {
        if (id && sample) byId.set(String(id), sample);
      });
    }
    [...(result.selectedItems || []), ...(result.items || [])].forEach(sample => {
      const id = String(sample?.id || "");
      if (id) byId.set(id, sample);
    });
    this.sampleCategoryRecords().forEach(category => {
      (category.samples || []).forEach(sample => {
        const id = String(sample?.id || "");
        if (id && !byId.has(id)) byId.set(id, { ...sample, categoryName: category.name || "" });
      });
    });
    return [...state.selectedIds].map(id => byId.get(id) || { id, _missing: true, status: "" });
  },

  taskSamplePickerSampleRowHtml(sample, state, { selected = false } = {}) {
    const sid = String(sample?.id || "");
    const isSelected = selected || state.selectedIds.has(sid);
    const status = sample?._missing ? "资料缺失" : this.normalizeSampleStatusValue(sample?.effectiveStatus || sample?.status);
    const isReassembled = this.sampleIsReassembled(sample);
    const reassemblyText = sample?._missing ? "待确认" : isReassembled ? "重组" : "非重组";
    const reassemblyClass = sample?._missing ? "s-待确认" : `task-sample-reassembly ${isReassembled ? "is-reassembled" : ""}`;
    const required = this.taskSamplePickerRequiredSampleCount(state.progressSelectId, state.inputName);
    const blockedByLimit = !isSelected && required !== null && state.selectedIds.size >= required;
    const selectable = isSelected || (!blockedByLimit && !sample?.selectionConflict && sample?.selectable !== false);
    const disabledReason = blockedByLimit
      ? `样机已选满：需 ${required} 台。`
      : isSelected ? (state.loading ? "" : sample?.selectionConflict || "") : selectable ? "" : (sample?.selectionConflict || sample?.disabledReason || "");
    const missingReason = sample?._missing ? "样机资料未加载或已不存在，请取消后重新选择。" : "";
    const availabilityReason = disabledReason || missingReason || (!selectable ? "当前状态不可用" : "");
    const availabilityText = availabilityReason || (state.loading ? "正在核验可用性…" : "可用");
    const availabilityTitle = availabilityReason || sample?.reservationHint || availabilityText;
    const availabilityClass = availabilityReason ? "task-sample-disabled-reason"
      : state.loading ? "task-sample-availability-pending" : "task-sample-available";
    const identity = this.taskSamplePickerIdentityText(sample);
    const controlKey = `${this.taskSamplePickerSafeKey(state.inputName)}_${String(sid).replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const checkboxId = `taskSampleCheck_${controlKey}`;
    const reasonId = `taskSampleReason_${controlKey}`;
    const checkboxLabel = selectable
      ? `${isSelected ? "取消选择" : "选择"}样机 ${identity}，当前状态 ${status}`
      : `样机 ${identity} 不可选择：${disabledReason || missingReason || "当前状态不可用"}`;
    const stageName = String(sample?.sourceStageName || "").trim();
    const skuName = String(sample?.sourceSkuName || "").trim();
    const stageSku = stageName && skuName ? `${Utils.esc(stageName)}-${Utils.esc(skuName)}`
      : stageName ? Utils.esc(stageName)
      : skuName ? Utils.esc(skuName)
      : "未配置";
    const testedItems = typeof this.sampleTestedItemNames === "function" ? this.sampleTestedItemNames(sid, sample) : [];
    const testedText = testedItems.length === 0
      ? "无"
      : testedItems.length <= 3
        ? Utils.esc(testedItems.join("、"))
        : `${Utils.esc(testedItems.slice(0, 3).join("、"))} 等 ${testedItems.length} 项`;
    return `
      <div class="dispatch-sample-row ${selectable ? "" : "is-disabled"} ${sample?._missing ? "task-sample-missing-row" : ""} ${isSelected && availabilityReason ? "has-selection-conflict" : ""}" data-app-action="task-sample-picker-row" data-id="${Utils.esc(state.inputName)}" data-progress-id="${Utils.esc(state.progressSelectId || "")}" data-hint-id="${Utils.esc(state.hintId || "")}" title="${Utils.esc(availabilityTitle)}">
        <div class="dispatch-sample-info">
          <div class="dispatch-sample-title-line">
            <button type="button" class="dispatch-sample-id" data-app-action="sample-readonly" data-id="${Utils.esc(sid)}" data-stop-propagation="1" title="查看样机详情" aria-label="查看样机详情 ${Utils.esc(identity)}">${Utils.esc(identity)}</button>
            <label class="dispatch-sample-check" for="${Utils.esc(checkboxId)}"><input id="${Utils.esc(checkboxId)}" type="checkbox" name="${state.inputName}" value="${Utils.esc(sid)}" data-sample-pick="${state.inputName}" aria-label="${Utils.esc(checkboxLabel)}" aria-describedby="${Utils.esc(reasonId)}" ${isSelected ? "checked" : ""} ${selectable ? "" : "disabled"} ${selectable ? `data-app-action="task-sample-picker-checkbox" data-app-events="change" data-id="${Utils.esc(state.inputName)}" data-progress-id="${Utils.esc(state.progressSelectId || "")}" data-hint-id="${Utils.esc(state.hintId || "")}"` : ""}></label>
            ${isSelected && availabilityReason ? `<span class="task-sample-selection-warning" aria-hidden="true" title="${Utils.esc(availabilityReason)}">!</span>` : ""}
          </div>
          <span class="dispatch-sample-stage">${stageSku}</span>
          <span class="dispatch-sample-tested">已测：${testedText}</span>
        </div>
        <div class="dispatch-sample-status">
          <span class="badge ${this.sampleHasProblem(sample) ? 's-有故障' : 's-无故障'}" title="故障状态">${this.sampleHasProblem(sample) ? '有故障' : '无故障'}</span>
          <span class="badge s-${Utils.esc(status)}" title="使用状态">${Utils.esc(status)}</span>
          <span class="badge ${reassemblyClass}" title="重组状态">${reassemblyText}</span>
        </div>
        <span id="${Utils.esc(reasonId)}" class="task-sample-availability ${availabilityClass}" title="${Utils.esc(availabilityTitle)}">${Utils.esc(availabilityText)}</span>
      </div>`;
  },

  taskSamplePickerIdentityText(sample) {
    if (typeof this.sampleDisplayCode === "function") {
      const code = this.sampleDisplayCode(sample);
      if (code) return code;
    }
    if (sample?.sampleNo) return `档案号: ${sample.sampleNo}`;
    if (sample?.sn) return `SN: ${sample.sn}`;
    if (sample?.imei) return `IMEI: ${sample.imei}`;
    if (sample?.boardSn) return `主板SN: ${sample.boardSn}`;
    return sample?.id || "身份号未录入";
  },

  onTaskSamplePickerFilterChange(inputName, key, value) {
    const state = this.taskSamplePickerState(inputName);
    if (!state) return;
    state[key] = value || "";
    state.page = 1;
    this.loadTaskSamplePickerPage(inputName, { page: 1 });
  },

  updateTaskSamplePickerSearchDraft(inputName, key, value) {
    const state = this.taskSamplePickerState(inputName);
    if (!state) return;
    if (key === "excludeKeyword") state.excludeKeywordDraft = String(value || "");
    else state.keywordDraft = String(value || "");
  },

  applyTaskSamplePickerSearch(inputName) {
    const state = this.taskSamplePickerState(inputName);
    if (!state) return;
    const keywordInput = document.getElementById?.(this.taskSamplePickerControlId(inputName, "keyword"));
    const excludeInput = document.getElementById?.(this.taskSamplePickerControlId(inputName, "exclude"));
    if (keywordInput) state.keywordDraft = keywordInput.value;
    if (excludeInput) state.excludeKeywordDraft = excludeInput.value;
    state.keyword = String(state.keywordDraft || "").trim();
    state.excludeKeyword = String(state.excludeKeywordDraft || "").trim();
    state.page = 1;
    this.loadTaskSamplePickerPage(inputName, { page: 1 });
  },

  validateTaskSampleSelection(progress, sampleIds, contextLabel = "任务") {
    const s = this.currentStage();
    const required = this.getProgressRequiredSampleCount(s, progress);
    if (required === null) return { ok: false, required: null, count: sampleIds.length, msg: `${contextLabel}无法读取样机数配置。` };
    if (sampleIds.length !== required) return { ok: false, required, count: sampleIds.length, msg: `${contextLabel}需要 ${required} 台样机，当前选择 ${sampleIds.length} 台。` };
    return { ok: true, required, count: sampleIds.length, msg: "" };
  },

  taskSamplePickerLimitProgress(progressSelectId, inputName) {
    const state = this.taskSamplePickerState(inputName);
    const stage = this.currentStage();
    const required = Utils.parsePositiveInt(state?.requiredSampleCount);
    const progressId = String((progressSelectId ? document.getElementById?.(progressSelectId)?.value : "") || state?.progressId || "").trim();
    let progress = (stage?.progress || []).find(item => String(item?.id || "") === progressId) || null;
    if (!progress && required !== null) {
      progress = { id: progressId, sampleSize: required };
    }
    return { stage, progress, required };
  },

  taskSamplePickerRequiredSampleCount(progressSelectId, inputName) {
    const { stage, progress, required } = this.taskSamplePickerLimitProgress(progressSelectId, inputName);
    if (required !== null) return required;
    return this.getProgressRequiredSampleCount(stage, progress);
  },

  setTaskSampleLimitHintContent(hint, text, countText) {
    if (!hint) return;
    hint.textContent = "";
    if (text) hint.append(text);
    const count = document.createElement("span");
    count.className = "sample-limit-count";
    count.textContent = countText || "";
    hint.append(count);
  },

  updateTaskSampleLimitUI(progressSelectId, inputName, hintId) {
    this.updateDispatchSamplePoolCounts(inputName);
    const hint = document.getElementById?.(hintId);
    if (!hint) return;
    const sampleIds = this.getSelectedTaskSampleIds(inputName);
    const required = this.taskSamplePickerRequiredSampleCount(progressSelectId, inputName);
    const isGlobalCompact = hint.classList.contains('sample-limit-global');
    hint.classList.remove('warn', 'bad', 'full');
    if (required === null) {
      hint.classList.add('bad');
      if (isGlobalCompact) {
        hint.title = `无法读取样机数配置。当前已选 ${sampleIds.length} 台。`;
        this.setTaskSampleLimitHintContent(hint, "", `${sampleIds.length}/?`);
      } else {
        this.setTaskSampleLimitHintContent(hint, "无法读取样机数配置。", `已选 ${sampleIds.length}`);
      }
      return;
    }
    const countText = `${sampleIds.length}/${required}`;
    if (sampleIds.length === required) {
      if (isGlobalCompact) {
        hint.classList.add('full');
        hint.title = `样机已选满：需 ${required} 台，已选 ${sampleIds.length} 台。未勾选的样机已禁用。`;
        this.setTaskSampleLimitHintContent(hint, "", `${countText} 已选满`);
      } else {
        this.setTaskSampleLimitHintContent(hint, `样机已满足：需 ${required} 台，已选 ${sampleIds.length} 台。`, "已满足");
      }
    } else if (sampleIds.length < required) {
      hint.classList.add('warn');
      if (isGlobalCompact) {
        hint.title = `不足：需 ${required} 台，已选 ${sampleIds.length} 台。`;
        this.setTaskSampleLimitHintContent(hint, "", countText);
      } else {
        this.setTaskSampleLimitHintContent(hint, `不足：需 ${required} 台，已选 ${sampleIds.length} 台。`, countText);
      }
    } else {
      hint.classList.add('bad');
      if (isGlobalCompact) {
        hint.title = `超出：需 ${required} 台，已选 ${sampleIds.length} 台。`;
        this.setTaskSampleLimitHintContent(hint, "", countText);
      } else {
        this.setTaskSampleLimitHintContent(hint, `超出：需 ${required} 台，已选 ${sampleIds.length} 台。`, countText);
      }
    }
  },

  onTaskSampleCheckboxChange(progressSelectId, inputName, hintId, checkboxEl) {
    const state = this.taskSamplePickerState(inputName);
    if (state && checkboxEl?.value) {
      state.selectionError = "";
      const sid = String(checkboxEl.value);
      if (checkboxEl.checked) {
        state.selectedIds.add(sid);
        if (!(state.selectedSampleCache instanceof Map)) state.selectedSampleCache = new Map();
        const sample = this.taskSamplePickerSelectedItems({ ...state, selectedIds: new Set([sid]) })[0] || { id: sid, _missing: true, status: "" };
        state.selectedSampleCache.set(sid, sample);
      } else {
        state.selectedIds.delete(sid);
        if (state.selectedSampleCache instanceof Map) state.selectedSampleCache.delete(sid);
      }
    }
    const required = this.taskSamplePickerRequiredSampleCount(progressSelectId, inputName);
    let sampleIds = this.getSelectedTaskSampleIds(inputName);
    if (required !== null && sampleIds.length > required && checkboxEl?.checked) {
      checkboxEl.checked = false;
      if (state && checkboxEl.value) {
        state.selectedIds.delete(String(checkboxEl.value));
        if (state.selectedSampleCache instanceof Map) state.selectedSampleCache.delete(String(checkboxEl.value));
      }
      sampleIds = this.getSelectedTaskSampleIds(inputName);
    }
    if (state) {
      this.renderTaskSamplePicker(inputName, { preserveScroll: true });
      // The server excludes selected IDs from candidates. Requery after changing
      // selection so an unchecked sample returns with current filters and totals.
      this.loadTaskSamplePickerPage(inputName, { page: state.page || 1 });
      return;
    }
    const allCheckboxes = [...(document.querySelectorAll?.(`input[name='${inputName}']`) || [])];
    if (required !== null) {
      if (sampleIds.length >= required) {
        allCheckboxes.forEach(cb => { if (!cb.checked) cb.disabled = true; });
      } else {
        allCheckboxes.forEach(cb => {
          const row = cb.closest('.dispatch-sample-row');
          if (row && !row.classList.contains('is-disabled')) cb.disabled = false;
        });
      }
    }
    this.updateTaskSampleLimitUI(progressSelectId, inputName, hintId);
  },

  onTaskSampleRowClick(event, inputName, progressSelectId = "", hintId = "", rowEl = null) {
    const target = event?.target;
    if (target?.closest?.("input, label, button, select, textarea, .dispatch-sample-id")) return;
    const row = rowEl?.classList?.contains?.("dispatch-sample-row")
      ? rowEl
      : target?.closest?.(".dispatch-sample-row");
    const checkbox = row?.querySelector?.(`input[type="checkbox"][name="${inputName}"]`);
    if (!checkbox || checkbox.disabled) return;
    checkbox.checked = !checkbox.checked;
    this.onTaskSampleCheckboxChange(progressSelectId, inputName, hintId, checkbox);
  },

  getAssignSampleSearchText(sample) {
    if (!sample) return "";
    const parts = [
      sample.sn || "",
      sample.imei || "",
      sample.boardSn || "",
      sample.sourceStageName || "",
      sample.sourceSkuName || "",
      sample.status || "",
      ...((typeof this.sampleTestedItemNames === "function" && this.sampleTestedItemNames(sample.id || "")) || []),
      ...(sample.problemRecords || []).map(r => r.description || "").filter(Boolean)
    ];
    return parts.map(v => String(v || "").trim()).filter(Boolean).join(" ").toLowerCase();
  },

  updateDispatchSamplePoolCounts(inputName) {
    document.querySelectorAll?.(`.dispatch-sample-group[data-sample-input-name="${inputName}"]`).forEach(group => {
      if (group.closest?.(".task-sample-picker")) return;
      const boxes = [...group.querySelectorAll(`input[type="checkbox"][name="${inputName}"]`)];
      const checked = boxes.filter(cb => cb.checked).length;
      const counter = group.querySelector(".dispatch-selected-count");
      if (counter) {
        const total = Number(counter.dataset.total || boxes.length);
        counter.textContent = total ? `${checked}/${total}` : `${checked}`;
        counter.classList.toggle("has-selected", checked > 0);
      }
    });
  },

  toggleDispatchGroup(groupId, btn) {
    const el = document.getElementById?.(groupId); if (!el) return;
    const isOpen = el.classList.toggle("open");
    if (btn) btn.innerText = isOpen ? "折叠" : "展开";
  },

  filterDispatchGroup(groupId, keyword, excludeKw, countId) {
    const body = document.getElementById?.(groupId); if (!body) return;
    body.classList.add("open");
    const kw = String(keyword || "").trim().toLowerCase();
    const ex = String(excludeKw || "").trim().toLowerCase();
    let visible = 0;
    body.querySelectorAll(".dispatch-sample-row").forEach(row => {
      const text = (row.dataset.searchText || "").toLowerCase();
      const matchInclude = !kw || text.includes(kw);
      const matchExclude = ex && text.includes(ex);
      const show = matchInclude && !matchExclude;
      row.style.display = show ? "flex" : "none";
      if (show) visible++;
    });
    const counter = document.getElementById?.(countId);
    if (counter) counter.innerText = (kw || ex) ? `${visible} 台` : "";
  },

  taskSampleIdListKey(sampleIds = []) {
    const list = Array.isArray(sampleIds) ? sampleIds : [];
    return [...new Set(list.map(id => String(id || "").trim()).filter(Boolean))].sort().join(",");
  },

  isTaskChangePayloadChanged(t, after = {}) {
    if (!t) return false;
    const norm = (v) => String(v || "").trim();
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(after, key);
    if (hasOwn("owner") && norm(t.owner) !== norm(after.owner)) return true;
    if (hasOwn("planStartDate") && norm(t.planStartDate || t.planDate || "") !== norm(after.planStartDate || "")) return true;
    if (hasOwn("planEndDate") && norm(t.planEndDate || t.endDate || "") !== norm(after.planEndDate || "")) return true;
    if (hasOwn("sampleIds")) {
      const beforeIds = this.taskSampleIdListKey(t.sampleIds || []);
      const afterIds = this.taskSampleIdListKey(after.sampleIds || []);
      if (beforeIds !== afterIds) return true;
    }
    return false;
  },

});
