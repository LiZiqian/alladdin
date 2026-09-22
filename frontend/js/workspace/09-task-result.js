/* ========================================
   数字治理平台 V7 - 任务结果录入模块
   含结果上传·样机去向·问题记录·图片·完成
   ======================================== */

app.registerModule("workspace.taskResult", {

  defaultSampleReceiver(sample, task) {
    return sample?.borrower || "";
  },

  sampleStatusOptionsHtml(selected = "") {
    const selectedStatus = this.normalizeSampleStatusValue(selected);
    return this.constants.sampleStatuses.map(status =>
      `<option value="${Utils.esc(status)}" ${status === selectedStatus ? "selected" : ""}>${Utils.esc(status)}</option>`
    ).join("");
  },

  taskSampleFaultOptionsHtml(hasProblem = false, selected = "") {
    const value = this.normalizeSampleQualityValue(selected || "", hasProblem);
    return `<option value="无故障" ${value === "无故障" ? "selected" : ""}>无故障</option><option value="有故障" ${value === "有故障" ? "selected" : ""}>有故障</option>`;
  },

  taskSampleDestinationOptionsHtml(selected = "", options = {}) {
    const base = ["闲置", "取走分析", "已退库"];
    const normalizedSelected = this.normalizeSampleStatusValue(selected || "");
    const values = options.includeCurrent && normalizedSelected && !base.includes(normalizedSelected)
      ? [normalizedSelected, ...base]
      : base;
    const value = values.includes(normalizedSelected) ? normalizedSelected : "闲置";
    return values.map(dest =>
      `<option value="${Utils.esc(dest)}" ${dest === value ? "selected" : ""}>${Utils.esc(dest)}</option>`
    ).join("");
  },

  taskResultCurrentEditLock(task, sampleId) {
    if (!task || !sampleId) return { locked: false, hint: "" };
    // Removed samples may already belong to another task before this one ends.
    // Current samples can still finish normally despite a future reservation.
    if (!this.isTaskCompleted(task) && (task.sampleIds || []).includes(sampleId)) return { locked: false, hint: "" };
    const usages = typeof this.activeTaskUsagesForSample === "function"
      ? this.activeTaskUsagesForSample(sampleId, task.id)
      : [];
    const sample = this.findSample(sampleId)?.sample;
    const currentOtherTask = sample?.currentTaskId && sample.currentTaskId !== task.id
      && ["测试中", "在位等待"].includes(this.sampleEffectiveStatus(sample));
    if (!usages.length && !currentOtherTask) return { locked: false, hint: "" };
    const names = usages.map(usage => {
      const projectName = usage.project?.name || "未知项目";
      const stageName = usage.stage?.name || "未知阶段";
      const taskName = usage.task?.testItem || usage.task?.id || "未命名任务";
      return `${projectName} / ${stageName} / ${taskName}`;
    }).join("；") || sample.currentTestItem || "其他任务";
    return {
      locked: true,
      hint: `该样机正在其他任务中：${names}。不可再次变更样机信息。`
    };
  },

  normalizeTaskResultFinishPayload(payload = {}) {
    const finishType = payload.finishType === "异常终止" ? "异常终止" : "正常完成";
    const result = finishType === "异常终止"
      ? "不通过"
      : this.normalizeTaskResultValue(payload.result || "");
    return { ...payload, result, finishType };
  },

  syncTaskResultFinishType(selectEl = null) {
    const finishTypeEl = selectEl || document.getElementById("taskFinishType");
    const resultEl = document.getElementById("taskResultValue");
    if (!finishTypeEl || !resultEl) return;
    const previousResult = resultEl.value;
    if (finishTypeEl.value === "异常终止") {
      if (resultEl.value !== "不通过") {
        resultEl.value = "不通过";
        if (selectEl && previousResult) Utils.toast("未完成计划、异常结束时，结果已自动设为不通过。");
      }
      resultEl.dataset.forcedByFinishType = "1";
      resultEl.title = "未完成计划、异常结束时，结果固定为不通过";
    } else {
      delete resultEl.dataset.forcedByFinishType;
      resultEl.title = "";
    }
    this.clearTaskResultValidationMarks?.();
    this.updateSelectPlaceholderState?.(resultEl.closest(".task-result-modal") || document.getElementById("modalBody"));
  },

  onTaskResultValueChange(selectEl) {
    const finishType = document.getElementById("taskFinishType")?.value || "";
    if (finishType === "异常终止" && selectEl?.value !== "不通过") {
      selectEl.value = "不通过";
      Utils.toast("未完成计划、异常结束时，结果固定为不通过。");
    }
    this.clearTaskResultValidationMarks?.();
    this.updateSelectPlaceholderState?.(selectEl?.closest?.(".task-result-modal") || document.getElementById("modalBody"));
  },

  onTaskResultDestinationChange(selectEl) {
    const row = selectEl.closest(".task-result-sample-row");
    if (!row) return;
    const dest = selectEl.value;
    const takerSel = this.taskResultMemberField(row, "taskResultTaker_");
    if (dest === "取走分析") {
      if (takerSel) {
        takerSel.disabled = false;
        takerSel.required = true;
        takerSel.placeholder = "请选择取走人";
      }
    } else {
      if (takerSel) {
        takerSel.disabled = true;
        takerSel.value = "";
        takerSel.required = false;
        takerSel.placeholder = "无需填写";
        this.closeProjectMemberComboboxes?.(takerSel);
      }
    }
    // 更新取走人标签上的必填星号
    const takerLabel = row.querySelector(".task-result-taker-group > label");
    if (takerLabel) {
      const star = takerLabel.querySelector(".req-star");
      if (dest === "取走分析") {
        if (!star) {
          const node = document.createElement("span");
          node.className = "req-star";
          node.textContent = "*";
          takerLabel.append(node);
        }
      } else {
        if (star) star.remove();
      }
    }
  },

  taskResultMemberField(row, prefix) {
    if (!row || !prefix) return null;
    return row.querySelector(`input[id^='${prefix}']`)
      || row.querySelector(`select[id^='${prefix}']`);
  },

  taskResultLocationMenu(input) {
    if (!input || typeof document === "undefined") return null;
    const menuId = input.dataset?.locationMenuId || "";
    return menuId ? document.getElementById(menuId) : input.closest?.(".task-result-location-combobox")?.querySelector?.(".task-result-location-menu");
  },

  positionTaskResultMenu(input, menu) {
    const modal = input?.closest?.(".task-result-modal");
    const body = modal?.querySelector?.(".modal-body");
    const picker = input?.closest?.(".project-member-picker");
    if (!body?.getBoundingClientRect || !picker?.getBoundingClientRect || !menu?.style) return;
    const bounds = body.getBoundingClientRect();
    const field = picker.getBoundingClientRect();
    const below = Math.max(0, bounds.bottom - field.bottom - 8);
    const above = Math.max(0, field.top - bounds.top - 8);
    const openAbove = below < Math.min(menu.scrollHeight || 240, 200) && above > below;
    picker.classList.toggle("task-result-menu-above", openAbove);
    menu.style.maxHeight = `${Math.max(40, Math.min(240, openAbove ? above : below))}px`;
  },

  openTaskResultLocationCombobox(input, options = {}) {
    if (!input || input.disabled) return;
    const picker = input.closest?.(".task-result-location-combobox");
    const menu = this.taskResultLocationMenu(input);
    if (!picker || !menu) return;
    this.closeTaskResultLocationComboboxes(input);
    this.closeProjectMemberComboboxes?.();
    picker.classList.add("is-open");
    input.setAttribute?.("aria-expanded", "true");
    if (options.reset !== false) this.filterTaskResultLocationCombobox(input, "");
    this.positionTaskResultMenu(input, menu);
  },

  closeTaskResultLocationComboboxes(exceptInput = null) {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
    document.querySelectorAll(".task-result-location-combobox.is-open").forEach(picker => {
      const input = picker.querySelector?.(".task-result-sample-location");
      if (exceptInput && input === exceptInput) return;
      picker.classList.remove("is-open");
      input?.setAttribute?.("aria-expanded", "false");
      picker.querySelectorAll?.(".task-result-location-option.is-active").forEach(option => option.classList.remove("is-active"));
    });
  },

  scheduleTaskResultLocationFilter(input) {
    if (!input) return;
    if (!this._taskResultLocationTimers) this._taskResultLocationTimers = {};
    const key = input.id || input.dataset?.locationMenuId || "default";
    if (this._taskResultLocationTimers[key]) clearTimeout(this._taskResultLocationTimers[key]);
    this._taskResultLocationTimers[key] = setTimeout(() => {
      delete this._taskResultLocationTimers[key];
      this.filterTaskResultLocationCombobox(input);
    }, 500);
  },

  filterTaskResultLocationCombobox(input, forcedKeyword = null) {
    const menu = this.taskResultLocationMenu(input);
    if (!menu) return 0;
    const keyword = String(forcedKeyword === null ? input?.value || "" : forcedKeyword).trim().toLowerCase();
    let visibleCount = 0;
    const options = Array.from(menu.querySelectorAll?.(".task-result-location-option") || []);
    options.forEach(option => {
      const haystack = String(option.dataset?.locationSearchKey || option.textContent || "").toLowerCase();
      const visible = !keyword || haystack.includes(keyword);
      option.hidden = !visible;
      option.classList.remove("is-active");
      if (visible) visibleCount += 1;
    });
    const empty = menu.querySelector?.(".project-member-combobox-empty");
    if (empty) {
      if (options.length) {
        empty.hidden = visibleCount > 0;
        empty.textContent = "没有匹配位置";
      } else {
        empty.hidden = false;
        empty.textContent = "暂无项目位置，可直接输入";
      }
    }
    return visibleCount;
  },

  handleTaskResultLocationCombobox(input, event, eventType) {
    if (!input || input.disabled) return;
    if (eventType === "focusin" || eventType === "click") {
      this.openTaskResultLocationCombobox(input, { reset: true });
      return;
    }
    if (eventType === "input") {
      this.openTaskResultLocationCombobox(input, { reset: false });
      this.scheduleTaskResultLocationFilter(input);
      return;
    }
    if (eventType === "keydown") this.handleTaskResultLocationKey(input, event);
  },

  visibleTaskResultLocationOptions(input) {
    const menu = this.taskResultLocationMenu(input);
    return Array.from(menu?.querySelectorAll?.(".task-result-location-option") || []).filter(option => !option.hidden);
  },

  handleTaskResultLocationKey(input, event) {
    if (!input || !event) return;
    if (this.isImeCompositionEvent?.(event)) return;
    if (event.key === "Escape") {
      if (input.closest?.(".task-result-location-combobox")?.classList.contains("is-open")) event.preventDefault();
      this.closeTaskResultLocationComboboxes();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    const options = this.visibleTaskResultLocationOptions(input);
    if (!options.length) return;
    const activeIndex = options.findIndex(option => option.classList.contains("is-active"));
    if (event.key === "Enter") {
      if (activeIndex >= 0) {
        event.preventDefault();
        this.selectTaskResultLocationOption(options[activeIndex]);
      }
      return;
    }
    event.preventDefault();
    this.openTaskResultLocationCombobox(input, { reset: false });
    const nextIndex = event.key === "ArrowDown"
      ? (activeIndex + 1) % options.length
      : (activeIndex <= 0 ? options.length - 1 : activeIndex - 1);
    options.forEach(option => option.classList.remove("is-active"));
    options[nextIndex].classList.add("is-active");
    options[nextIndex].scrollIntoView?.({ block: "nearest" });
  },

  selectTaskResultLocationOption(option) {
    if (!option || typeof document === "undefined") return;
    const targetId = option.dataset?.locationTarget || "";
    const input = targetId ? document.getElementById(targetId) : null;
    if (!input || input.disabled) return;
    input.value = option.dataset?.locationValue || "";
    const menu = this.taskResultLocationMenu(input);
    menu?.querySelectorAll?.(".task-result-location-option").forEach(item => {
      item.classList.toggle("is-selected", item === option);
      item.classList.remove("is-active");
      item.hidden = false;
    });
    const empty = menu?.querySelector?.(".project-member-combobox-empty");
    if (empty) empty.hidden = true;
    input.dispatchEvent?.(new Event("change", { bubbles: true }));
    this.closeTaskResultLocationComboboxes();
  },


  ensureTaskRemovedSampleRecords(task) {
    if (!task) return [];
    if (!Array.isArray(task.removedSampleRecords)) task.removedSampleRecords = [];
    task.removedSampleRecords = task.removedSampleRecords.map(item => {
      if (typeof item === "string") {
        return { id: Utils.id("removed_"), sampleId: item, sampleNo: item, removedAt: "", user: "", reason: "历史退出记录" };
      }
      if (!item || typeof item !== "object") return null;
      return {
        id: item.id || Utils.id("removed_"),
        sampleId: item.sampleId || "",
        sampleNo: item.sampleNo || item.code || item.sampleId || "",
        removedAt: item.removedAt || item.time || "",
        user: item.user || "",
        reason: item.reason || "",
        fromStatus: item.fromStatus || "",
        receiver: item.receiver || ""
      };
    }).filter(item => item?.sampleId);
    return task.removedSampleRecords;
  },

  recordTaskRemovedSamples(task, sampleIds = [], ctx = {}) {
    if (!task || !sampleIds.length) return;
    this.ensureTaskSampleSnapshots?.(task, sampleIds, { capturedAt: ctx.removedAt || Utils.now(), destroyedAt: ctx.destroyedAt || "" });
    const records = this.ensureTaskRemovedSampleRecords(task);
    const removedAt = ctx.removedAt || Utils.now();
    sampleIds.forEach(sampleId => {
      const found = this.findSample(sampleId);
      const sample = found?.sample || {};
      records.push({
        id: Utils.id("removed_"),
        sampleId,
        sampleNo: this.taskSampleDisplayName(sampleId),
        sn: sample.sn || "",
        imei: sample.imei || "",
        boardSn: sample.boardSn || "",
        removedAt,
        user: ctx.user || "",
        reason: ctx.reason || "",
        fromStatus: found ? this.sampleEffectiveStatus(sample) : "",
        receiver: ctx.receiver || ""
      });
    });
  },

  taskResultSampleEntries(task) {
    if (!task) return [];
    const activeIds = [...new Set(task.sampleIds || [])];
    const activeSet = new Set(activeIds);
    const removedBySample = new Map();
    this.ensureTaskRemovedSampleRecords(task).forEach(record => {
      if (!record.sampleId || activeSet.has(record.sampleId)) return;
      removedBySample.set(record.sampleId, { ...record, state: "removed" });
    });
    return [
      ...activeIds.map(sampleId => ({ sampleId, state: "active" })),
      ...[...removedBySample.values()]
    ];
  },

  taskResultProblemTableHtml(sample, rowIdx, draftItem = null) {
    const baseline = sample ? this.sampleProblemRecords(sample) : [];
    const problems = Array.isArray(draftItem?.problemRecords)
      ? this.mergeProblemPhotoRecords(baseline, draftItem.problemRecords, draftItem.problemRecordsBaseline)
      : baseline;
    const rows = problems.map(item => this.taskResultProblemRowHtml(item)).join("");
    const photos = Array.isArray(draftItem?.photos) ? draftItem.photos : [];
    return `
      <div class="task-result-new-problem">
        <label for="taskResultProblem_${rowIdx}">本次新增问题</label>
        <div class="task-result-problem-line">
          <input id="taskResultProblem_${rowIdx}" class="task-result-sample-problem" value="${Utils.esc(draftItem?.problem || "")}" placeholder="填写本次失效或问题；没有新增可留空">
          <button type="button" class="btn btn-outline task-result-photo-btn" ${sample ? "" : "disabled"} data-app-action="problem-photos-open">添加图片</button>
        </div>
        <input type="hidden" class="task-result-sample-photos" value="${Utils.esc(JSON.stringify(photos))}">
        <div class="task-result-photo-list"></div>
      </div>
      <div class="task-result-problem-board">
        <input type="hidden" class="task-result-problem-baseline" value="${Utils.esc(JSON.stringify(baseline))}">
        <div class="task-result-problem-head">
          <b>已有问题</b>
        </div>
        <div class="sample-problem-table-scroll"><table class="sample-problem-table task-result-problem-table" aria-label="已有问题表">
          ${this.problemTableHeadHtml()}
          <tbody class="task-result-existing-problems">
            ${rows || `<tr class="task-result-problem-empty"><td colspan="${this.problemTableColumns().length}">当前档案暂无问题记录。</td></tr>`}
          </tbody>
        </table></div>
      </div>`;
  },

  taskResultProblemRowHtml(record = {}) {
    const item = this.normalizeSampleProblemRecord(record) || this.normalizeSampleProblemRecord({});
    return `<tr class="task-result-existing-problem-row" data-problem-id="${Utils.esc(item.id)}" data-problem-record="${Utils.esc(JSON.stringify(item))}">
      ${this.problemTableCellsHtml({
        description: `<input class="task-result-existing-problem-desc" value="${Utils.esc(item.description || "")}" title="${Utils.esc(item.description || "")}" placeholder="问题描述" aria-label="已有问题描述">`,
        source: `<input class="task-result-existing-problem-source" value="${Utils.esc(item.source || "手动补录")}" title="${Utils.esc(item.source || "手动补录")}" placeholder="来源" aria-label="已有问题来源">`,
        date: this.problemDateHtml(item),
        task: this.problemTaskFieldHtml(item, "task-result-existing-problem", "已有问题关联任务"),
        photos: this.problemPhotoButtonHtml(item),
        actions: `<div class="sample-problem-actions"><button type="button" class="sample-result-btn remove" title="从样机问题表删除" aria-label="删除此条已有问题" data-app-action="task-result-problem-remove">${Utils.iconHtml("trash")}</button></div>`
      })}
    </tr>`;
  },

  taskResultProblemEmptyNode() {
    const node = document.createElement("tr");
    node.className = "task-result-problem-empty";
    const cell = document.createElement("td");
    cell.colSpan = this.problemTableColumns().length;
    cell.textContent = "当前档案暂无问题记录。";
    node.appendChild(cell);
    return node;
  },

  removeTaskResultProblemRow(btn) {
    const row = btn?.closest?.(".task-result-existing-problem-row");
    const wrap = btn?.closest?.(".task-result-existing-problems");
    if (!row || !wrap) return;
    row.remove();
    if (!wrap.querySelector(".task-result-existing-problem-row")) {
      wrap.textContent = "";
      wrap.append(this.taskResultProblemEmptyNode());
    }
  },

  taskResultSampleRowsHtml(task, draft = null) {
    const entries = this.taskResultSampleEntries(task);
    const draftBySample = new Map((draft?.samples || []).map(item => [item.sampleId || item.sid, item]));
    const taskCompleted = this.isTaskCompleted(task);
    return entries.map((entry, idx) => {
      const id = entry.sampleId;
      const draftItem = draftBySample.get(id) || null;
      const found = this.findSample(id);
      const sample = found?.sample || {};
      const snapshot = task.sampleSnapshots?.[id] || null;
      const status = found ? this.sampleEffectiveStatus(sample) : (draftItem?.destination || "闲置");
      const editLock = this.taskResultCurrentEditLock(task, id);
      const currentDestination = status === "取走分析" || status === "已退库" ? status : "闲置";
      const preferDraft = !!draftItem && !taskCompleted && !editLock.locked;
      const draftField = (key, fallback = "") => {
        if (!preferDraft) return fallback;
        return Object.prototype.hasOwnProperty.call(draftItem, key) ? draftItem[key] : fallback;
      };
      const destination = editLock.locked
        ? status
        : String(draftField("destination", found ? currentDestination : (draftItem?.destination || currentDestination)) || currentDestination);
      const accountOwner = String(draftField("accountOwner", found ? (sample.owner || "") : (draftItem?.accountOwner || "")) || "");
      const destLocation = String(draftField("destLocation", found ? (sample.location || "") : (draftItem?.destLocation || snapshot?.location || "")) || "");
      const currentReceiver = found
        ? (editLock.locked ? (sample.borrower || "") : (destination === "取走分析" ? this.defaultSampleReceiver(sample, task) : ""))
        : (draftItem?.receiver || "");
      const receiver = String(draftField("receiver", currentReceiver) || "");
      const isTakerDisabled = editLock.locked || destination !== "取走分析";
      const takerPlaceholder = editLock.locked ? "当前无取走人" : (isTakerDisabled ? "无需填写" : "请选择取走人");
      const lockedAttr = editLock.locked ? " disabled" : "";
      const lockedHint = editLock.locked ? `<div class="task-result-current-lock">${Utils.esc(editLock.hint)}</div>` : "";
      const removedInfo = entry.state === "removed"
        ? `<span class="task-result-sample-state removed">变更样机</span><span>退出时间：${Utils.esc(Utils.dateTimeLabel(entry.removedAt))}</span>${entry.reason ? `<span>退出原因：${Utils.esc(entry.reason)}</span>` : ""}`
        : `<span class="task-result-sample-state active">正式样机</span>`;
      const archiveName = this.taskSampleArchiveName(id, snapshot);
      const sampleCodeHtml = id && !snapshot?.destroyedAt
        ? `<button type="button" class="task-result-sample-link" data-app-action="sample-readonly" data-id="${Utils.esc(id)}" data-stop-propagation="1" title="查看样机详情：${Utils.esc(archiveName)}" aria-label="查看样机详情 ${Utils.esc(archiveName)}">${Utils.esc(archiveName)}</button>`
        : `<b>${Utils.esc(archiveName)}</b>`;
      // 项目位置列表（供去向位置自定义下拉使用）
      const p = this.currentProject();
      const locations = (p?.locations || []).map(loc => String(loc || "").trim()).filter(Boolean);
      return `<div class="task-result-sample-row ${entry.state === "removed" ? "is-removed" : ""}" data-sid="${Utils.esc(id)}" data-sample-state="${Utils.esc(entry.state)}" data-current-edit-locked="${editLock.locked ? "1" : "0"}">
        <div class="task-result-sample-index">${idx + 1}</div>
        <div class="task-result-sample-code">
          ${sampleCodeHtml}
          ${removedInfo}
          ${lockedHint}
        </div>
        <div class="task-result-route-grid">
          <div class="form-group">
            <label class="req" for="taskResultDestination_${idx}">样机去向</label>
            <select id="taskResultDestination_${idx}" class="task-result-sample-destination" data-app-action="task-result-destination" data-app-events="change"${lockedAttr}>${this.taskSampleDestinationOptionsHtml(destination, { includeCurrent: editLock.locked })}</select>
          </div>
          <div class="form-group">
            <label class="req" for="taskResultLocation_${idx}">去向位置</label>
            ${this.taskResultLocationComboboxHtml(`taskResultLocation_${idx}`, destLocation, locations, editLock.locked)}
          </div>
          <div class="form-group task-result-taker-group">
            <label for="taskResultTaker_${idx}">${editLock.locked ? "当前持有人" : "取走人"}${!editLock.locked && destination === '取走分析' ? '<span class="req-star">*</span>' : ''}</label>
            ${this.projectMemberSelectHtml(`taskResultTaker_${idx}`, receiver, takerPlaceholder, { scope: editLock.locked ? "all" : "developer", showRole: true, disabled: isTakerDisabled })}
          </div>
          <div class="form-group task-result-account-group">
            <label for="taskResultAccountOwner_${idx}">挂账人</label>
            ${this.projectMemberSelectHtml(`taskResultAccountOwner_${idx}`, accountOwner, "请选择挂账人", { scope: "all", disabled: editLock.locked })}
          </div>
        </div>
        <div class="form-group task-result-problem-field">
          ${this.taskResultProblemTableHtml(found ? sample : null, idx, draftItem)}
        </div>
      </div>`;
    }).join("") || `<div class="empty">该任务暂无样机。</div>`;
  },

  taskResultLocationComboboxHtml(id, selected = "", locations = [], disabled = false) {
    const cleanLocations = [];
    const seen = new Set();
    (locations || []).forEach(loc => {
      const value = String(loc || "").trim();
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return;
      seen.add(key);
      cleanLocations.push(value);
    });
    const menuId = `${id}Options`;
    const disabledAttr = disabled ? " disabled" : "";
    const optionsHtml = cleanLocations.map(loc => `<button type="button" class="project-member-combobox-option task-result-location-option ${loc === selected ? "is-selected" : ""}"
        data-app-action="task-result-location-option" data-stop-propagation="1" data-location-target="${Utils.esc(id)}"
        data-location-value="${Utils.esc(loc)}" data-location-search-key="${Utils.esc(loc.toLowerCase())}">
        <span class="project-member-combobox-name task-result-location-name">${Utils.esc(loc)}</span>
      </button>`).join("");
    return `<div class="project-member-picker task-result-location-combobox">
      <input id="${Utils.esc(id)}" class="task-result-sample-location project-member-combobox-input" value="${Utils.esc(selected || "")}" placeholder="请选择或输入位置"
        data-location-menu-id="${Utils.esc(menuId)}" data-app-action="task-result-location-combobox"
        data-app-events="focusin click input keydown" role="combobox" aria-autocomplete="list"
        aria-expanded="false" aria-controls="${Utils.esc(menuId)}" autocomplete="off"${disabledAttr}>
      <div id="${Utils.esc(menuId)}" class="project-member-combobox-menu task-result-location-menu" role="listbox">
        ${optionsHtml}
        <div class="project-member-combobox-empty" ${cleanLocations.length ? "hidden" : ""}>${cleanLocations.length ? "没有匹配位置" : "暂无项目位置，可直接输入"}</div>
      </div>
    </div>`;
  },

  taskResultRowPhotos(row) {
    const input = row?.querySelector(".task-result-sample-photos");
    if (!input) return [];
    try {
      const parsed = JSON.parse(input.value || "[]");
      return Array.isArray(parsed) ? parsed.filter(x => x && x.id) : [];
    } catch {
      return [];
    }
  },

  setTaskResultRowPhotos(row, photos) {
    const input = row?.querySelector(".task-result-sample-photos");
    if (!input) return;
    const byId = new Map((photos || []).filter(x => x && x.id).map(x => [x.id, x]));
    input.value = JSON.stringify([...byId.values()]);
    this.renderTaskResultPhotoList(row);
  },

  taskResultPhotoChipNode(sampleId, photo = {}) {
    const name = photo.name || "结果图片";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-result-photo-chip";
    button.dataset.appAction = "task-result-photo-preview";
    button.dataset.id = sampleId || "";
    button.dataset.photoId = photo.id || "";
    button.title = name;

    const thumbUrl = this.photoThumbUrl(photo);
    if (thumbUrl) {
      const img = document.createElement("img");
      img.src = thumbUrl;
      img.alt = name;
      button.append(img);
    }

    const label = document.createElement("span");
    label.textContent = name;
    button.append(label);
    const chip = document.createElement("div");
    chip.className = "task-result-photo-item";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "task-result-photo-remove";
    remove.dataset.appAction = "task-result-photo-remove";
    remove.dataset.photoId = photo.id || "";
    remove.title = `移除图片：${name}`;
    remove.ariaLabel = remove.title;
    remove.textContent = "×";
    chip.append(button, remove);
    return chip;
  },

  renderTaskResultPhotoList(row) {
    const list = row?.querySelector(".task-result-photo-list");
    if (!list) return;
    const sampleId = row.dataset.sid || "";
    const photos = this.taskResultRowPhotos(row);
    list.textContent = "";
    photos.forEach(photo => list.append(this.taskResultPhotoChipNode(sampleId, photo)));
  },

  removeTaskResultPhoto(btn) {
    const row = btn.closest(".task-result-sample-row");
    this.setTaskResultRowPhotos(row, this.taskResultRowPhotos(row).filter(photo => photo.id !== btn.dataset.photoId));
  },

  appendTaskSampleFault(task, sampleId, record) {
    if (!task || !sampleId || !record) return;
    if (!Array.isArray(task.sampleFaultRecords)) task.sampleFaultRecords = [];
    const item = { id: Utils.id("fault_"), sampleId, ...record };
    task.sampleFaultRecords.push(item);
    if (!task.sampleFaults || typeof task.sampleFaults !== "object" || Array.isArray(task.sampleFaults)) task.sampleFaults = {};
    task.sampleFaults[sampleId] = {
      fault: !!record.fault,
      problem: record.problem || "",
      source: record.source || "结果上传",
      time: record.time || Utils.now(),
      result: record.result || ""
    };
  },

  collectTaskResultForm() {
    const result = document.getElementById("taskResultValue")?.value || "";
    const user = document.getElementById("taskResultUser")?.value.trim() || "";
    const resultDate = document.getElementById("taskResultDate")?.value || Utils.today();
    const finishType = document.getElementById("taskFinishType")?.value || "正常完成";
    const samples = [...document.querySelectorAll(".task-result-sample-row")].map(row => {
      const sid = row.dataset.sid;
      const state = row.dataset.sampleState || "active";
      const currentEditLocked = row.dataset.currentEditLocked === "1";
      const destination = row.querySelector(".task-result-sample-destination")?.value || "闲置";
      const destLocation = row.querySelector(".task-result-sample-location")?.value.trim() || "";
      const accountOwner = this.taskResultMemberField(row, "taskResultAccountOwner_")?.value.trim() || "";
      const receiver = this.taskResultMemberField(row, "taskResultTaker_")?.value.trim() || "";
      const problem = row.querySelector(".task-result-sample-problem")?.value.trim() || "";
      const problemRecords = [...row.querySelectorAll(".task-result-existing-problem-row")]
        .map(problemRow => this.sampleProblemRecordFromRow(problemRow, "task-result-existing-problem"))
        .filter(item => item.description && !Utils.isNoSampleIssueText(item.description));
      let problemRecordsBaseline;
      try { problemRecordsBaseline = JSON.parse(row.querySelector(".task-result-problem-baseline")?.value || "null"); } catch (_) { /* Invalid form baseline cannot be trusted. */ }
      // 自动判断：只有本次填写了新增失效才算故障，已有问题表不参与故障判定
      const hasNewProblem = !!problem && !Utils.isNoSampleIssueText(problem);
      const fault = hasNewProblem ? "有故障" : "无故障";
      const photos = this.taskResultRowPhotos(row).map(photo => ({
        id: photo.id,
        name: photo.name || "结果图片",
        url: photo.url || "",
        thumbUrl: photo.thumbUrl || "",
        uploadedAt: photo.uploadedAt || "",
        type: photo.type || "",
        size: photo.size || 0
      }));
      return { sid, state, currentEditLocked, fault, destination, destLocation, accountOwner, receiver, problem, problemRecords, problemRecordsBaseline, photos };
    });
    return this.normalizeTaskResultFinishPayload({ result, user, resultDate, finishType, samples });
  },

  validateTaskResultPayload(payload, finishTask = false) {
    payload = this.normalizeTaskResultFinishPayload(payload);
    if (!payload.result) return "请选择通过 / 不通过。";
    if (!payload.user) return "请选择结果录入人。请先在项目人员配置中新增测试人员。";
    const userCheck = this.validatePersonForScope(payload.user, "tester", "结果录入人");
    if (!userCheck.ok) return userCheck.msg;
    if (finishTask && payload.finishType === "异常终止" && payload.result !== "不通过") {
      return "没有完成预定计划时，结果必须选择不通过。";
    }
    const editableSamples = payload.samples.filter(x => !x.currentEditLocked);
    const missingLocation = editableSamples.find(x => !x.destLocation);
    if (missingLocation) return `样机 ${this.taskSampleDisplayName(missingLocation.sid)} 必须填写去向位置。`;
    const missingTaker = editableSamples.find(x => x.destination === "取走分析" && !x.receiver);
    if (missingTaker) return `样机 ${this.taskSampleDisplayName(missingTaker.sid)} 去向为"取走分析"时，必须选择取走人。`;
    const invalidTaker = editableSamples.find(x => x.destination === "取走分析" && !this.validatePersonForScope(x.receiver, "developer", "取走人").ok);
    if (invalidTaker) return `样机 ${this.taskSampleDisplayName(invalidTaker.sid)} 的取走人只能选择开发人员。`;
    const invalidAccountOwner = editableSamples.find(x => x.accountOwner && !this.validatePersonForScope(x.accountOwner, "all", "挂账人", { optional: true }).ok);
    if (invalidAccountOwner) return `样机 ${this.taskSampleDisplayName(invalidAccountOwner.sid)} 的挂账人必须从项目人员配置中选择。`;
    const missingProblem = payload.samples.find(x => x.fault === "有故障" && !x.problem && !(x.problemRecords || []).length);
    if (missingProblem) return `样机 ${this.taskSampleDisplayName(missingProblem.sid)} 标记为有故障时，必须填写本次失效/问题。`;
    return "";
  },

  validateTaskResultMemberFields(payload) {
    payload = this.normalizeTaskResultFinishPayload(payload);
    if (payload.user) {
      const userCheck = this.validatePersonForScope(payload.user, "tester", "结果录入人");
      if (!userCheck.ok) return userCheck.msg;
    }
    const editableSamples = (payload.samples || []).filter(x => !x.currentEditLocked);
    const missingTaker = editableSamples.find(x => x.destination === "取走分析" && !x.receiver);
    if (missingTaker) return `样机 ${this.taskSampleDisplayName(missingTaker.sid)} 去向为"取走分析"时，必须选择取走人。`;
    const invalidTaker = editableSamples.find(x => x.destination === "取走分析" && !this.validatePersonForScope(x.receiver, "developer", "取走人").ok);
    if (invalidTaker) return `样机 ${this.taskSampleDisplayName(invalidTaker.sid)} 的取走人只能选择开发人员。`;
    const invalidAccountOwner = editableSamples.find(x => x.accountOwner && !this.validatePersonForScope(x.accountOwner, "all", "挂账人", { optional: true }).ok);
    if (invalidAccountOwner) return `样机 ${this.taskSampleDisplayName(invalidAccountOwner.sid)} 的挂账人必须从项目人员配置中选择。`;
    return "";
  },

  clearTaskResultValidationMarks() {
    this.clearFieldValidationMarks();
    document.querySelectorAll(".task-result-modal .task-result-sample-row.has-error").forEach(el => el.classList.remove("has-error"));
  },

  markTaskResultInvalid(el, message) {
    this.markFieldInvalid(el, message);
    el?.closest(".task-result-sample-row")?.classList.add("has-error");
  },

  markTaskResultValidation(payload, finishTask = false) {
    this.clearTaskResultValidationMarks();
    if (!finishTask) return;
    if (!payload.result) this.markTaskResultInvalid(document.getElementById("taskResultValue"), "结束任务前必须选择通过 / 不通过");
    if (!payload.user || !this.validatePersonForScope(payload.user, "tester", "结果录入人").ok) this.markTaskResultInvalid(document.getElementById("taskResultUser"), "结束任务前必须选择测试人员作为结果录入人");
    document.querySelectorAll(".task-result-sample-row").forEach((row, idx) => {
      const item = payload.samples[idx];
      if (!item) return;
      if (!item.currentEditLocked && !item.destLocation) {
        this.markTaskResultInvalid(row.querySelector(".task-result-sample-location"), "必须填写去向位置");
      }
      if (!item.currentEditLocked && item.destination === "取走分析" && !item.receiver) {
        this.markTaskResultInvalid(this.taskResultMemberField(row, "taskResultTaker_"), "必须选择取走人");
      }
      if (!item.currentEditLocked && item.destination === "取走分析" && item.receiver && !this.validatePersonForScope(item.receiver, "developer", "取走人").ok) {
        this.markTaskResultInvalid(this.taskResultMemberField(row, "taskResultTaker_"), "取走人只能选择开发人员");
      }
      if (!item.currentEditLocked && item.accountOwner && !this.validatePersonForScope(item.accountOwner, "all", "挂账人", { optional: true }).ok) {
        this.markTaskResultInvalid(this.taskResultMemberField(row, "taskResultAccountOwner_"), "挂账人必须从项目人员配置中选择");
      }
      if (item.fault === "有故障" && !item.problem && !(item.problemRecords || []).length) {
        this.markTaskResultInvalid(row.querySelector(".task-result-sample-problem"), "标记有故障时必须填写或保留问题记录");
      }
    });
    document.querySelector(".task-result-modal .is-invalid")?.scrollIntoView({ block: "center", behavior: "smooth" });
  },

  markTaskResultMemberValidation(payload) {
    this.clearTaskResultValidationMarks();
    if (payload.user && !this.validatePersonForScope(payload.user, "tester", "结果录入人").ok) {
      this.markTaskResultInvalid(document.getElementById("taskResultUser"), "结果录入人必须选择测试人员");
    }
    document.querySelectorAll(".task-result-sample-row").forEach((row, idx) => {
      const item = payload.samples?.[idx];
      if (!item || item.currentEditLocked) return;
      if (item.destination === "取走分析" && !item.receiver) {
        this.markTaskResultInvalid(this.taskResultMemberField(row, "taskResultTaker_"), "必须选择取走人");
      } else if (item.destination === "取走分析" && !this.validatePersonForScope(item.receiver, "developer", "取走人").ok) {
        this.markTaskResultInvalid(this.taskResultMemberField(row, "taskResultTaker_"), "取走人只能选择开发人员");
      }
      if (item.accountOwner && !this.validatePersonForScope(item.accountOwner, "all", "挂账人", { optional: true }).ok) {
        this.markTaskResultInvalid(this.taskResultMemberField(row, "taskResultAccountOwner_"), "挂账人必须从项目人员配置中选择");
      }
    });
    document.querySelector(".task-result-modal .is-invalid")?.scrollIntoView({ block: "center", behavior: "smooth" });
  },

  /**
   * 任务结果摘要（仅用于任务日志和样机履历 reason 字段）
   * 只保留核心信息：测试结果 + 失效比例 + 新增失效（不再输出 OK 台数/去向/上传图片数等无用统计）。
   * 注意：本字符串不应再被作为 problemDescription 落入样机 problemRecords。
   */
  taskResultAutoReason(payload, finishTask = false, ctx = {}) {
    const samples = payload.samples || [];
    const removedCount = samples.filter(x => x.state === "removed").length;
    const activeCount = samples.length - removedCount;
    // 失效判定：只统计本次在「本次新增失效/问题」输入框中填写的内容
    const sampleFailureText = (x) => {
      const newProblem = String(x.problem || "").trim();
      if (newProblem && !Utils.isNoSampleIssueText(newProblem)) return newProblem;
      return "";
    };
    const failed = samples.map(x => ({ x, problem: sampleFailureText(x) })).filter(o => o.problem);
    const activeFail = failed.filter(o => o.x.state !== "removed").length;
    const removedFail = failed.filter(o => o.x.state === "removed").length;
    const ratio = `正式 ${activeFail}F/${activeCount}`
      + (removedCount ? `，变更 ${removedFail}F/${removedCount}` : "");
    const allProblems = failed.map(o => `${this.taskSampleDisplayName(o.x.sid)}：${o.problem}${o.x.state === "removed" ? "（变更）" : ""}`);
    const maxProblemItems = 5;
    const truncatedProblems = allProblems.length > maxProblemItems
      ? allProblems.slice(0, maxProblemItems).concat(`等 ${allProblems.length} 项`)
      : allProblems;
    const finishText = finishTask
      ? `；${payload.finishType === "异常终止" ? "未完成计划，异常结束" : "完成计划，正常结束"}`
      : "";
    const prefix = `测试结果：${payload.result}（${ratio}）`;
    const suffix = truncatedProblems.length ? `；新增失效：${truncatedProblems.join("；")}` : "";
    let reason = `${prefix}${suffix}${finishText}`;
    if (reason.length > 500) {
      reason = reason.slice(0, 497) + "...";
    }
    return reason;
  },


  syncTaskResultSampleProblems(sample, item, ctx = {}) {
    if (!sample) return item.problemRecords || [];
    const taskLabel = this.sampleTaskLabelFromCtx(ctx);
    const records = this.mergeProblemPhotoRecords(sample.problemRecords || [], item.problemRecords || [], item.problemRecordsBaseline).map(record => ({
      ...record,
      id: record.id || Utils.id("problem_"),
      description: String(record.description || "").trim(),
      source: String(record.source || "手动补录").trim(),
      taskLabel: String(record.taskLabel || "").trim()
    })).filter(record => record.description && !Utils.isNoSampleIssueText(record.description));
    const newProblem = String(item.problem || "").trim();
    if (newProblem && !Utils.isNoSampleIssueText(newProblem)) {
      const newRecord = {
        id: Utils.id("problem_"),
        createdAt: Utils.now(),
        description: newProblem,
        source: "测试任务",
        taskLabel,
        taskLabelFormat: "project-stage-scheme-task",
        taskId: ctx.taskId || "",
        projectId: ctx.projectId || "",
        stageId: ctx.stageId || "",
        photoIds: [...new Set((item.photos || []).map(photo => photo.id).filter(Boolean))]
      };
      const exists = records.find(record =>
        record.description === newRecord.description &&
        record.source === newRecord.source &&
        (ctx.taskId && record.taskId === ctx.taskId || this.sampleProblemTaskLabel(record) === newRecord.taskLabel)
      );
      if (!exists) records.push(newRecord);
      else exists.photoIds = [...new Set([...(exists.photoIds || []), ...newRecord.photoIds])];
    }
    if (ctx.mutateSample !== false) {
      this.replaceSampleProblemRecords(sample, records);
    }
    return records;
  },

  saveTaskResultDraft(project, stage, task, payload) {
    const ctx = {
      project, stage, task,
      projectId: project.id,
      stageId: stage.id,
      taskId: task.id,
      testItem: task.testItem
    };
    const samples = (payload.samples || []).map(item => {
      const found = this.findSample(item.sid);
      const problemRecords = this.syncTaskResultSampleProblems(found?.sample, item, {
        ...ctx,
        mutateSample: false
      });
      return {
        ...item,
        problem: "",
        // Once a new problem is promoted to the table, its images belong to that
        // record. Do not attach them to the next new problem on reopening.
        photos: item.problem && !Utils.isNoSampleIssueText(item.problem) ? [] : (item.photos || []),
        problemRecords
      };
    });
    task.resultDraft = {
      ...payload,
      samples,
      savedAt: Utils.now()
    };
  },

  applyTaskResult(project, stage, task, payload, finishTask = false) {
    const from = task.status;
    const now = Utils.now();
    const result = finishTask && payload.finishType === "异常终止" ? "不通过" : this.normalizeTaskResultValue(payload.result);
    const reason = this.taskResultAutoReason({ ...payload, result }, finishTask, { projectId: project.id, stageId: stage.id, testItem: task.testItem });
    task.latestResult = result;
    task.resultDate = payload.resultDate;
    // 只有结束任务或已完成任务追加结果时，才会同步样机档案。

    const sampleIdsForMutation = new Set();
    payload.samples.forEach(item => {
      const found = this.findSample(item.sid);
      item.problemRecords = this.syncTaskResultSampleProblems(found?.sample, item, {
        project, stage, task,
        projectId: project.id,
        stageId: stage.id,
        taskId: task.id,
        testItem: task.testItem,
        mutateSample: !item.currentEditLocked
      });
      const isFault = item.fault === "有故障";
      const status = item.destination || "闲置";
      if (item.problem) {
        this.appendTaskSampleFault(task, item.sid, {
          fault: true,
          problem: item.problem,
          source: finishTask ? "任务结束" : "结果上传",
          time: now,
          result,
          sampleState: item.state || "active",
          removedFromTask: item.state === "removed",
          photos: item.photos || []
        });
      }
      if (item.currentEditLocked) return;
      sampleIdsForMutation.add(item.sid);
      if (!finishTask && !this.isTaskCompleted(task)) return;
      const photoIds = (item.photos || []).map(photo => photo.id).filter(Boolean);
      this.changeSampleStatus(item.sid, status, {
        user: payload.user,
        receiver: item.receiver,
        accountOwner: item.accountOwner || "",
        destination: item.destination,
        destLocation: item.destLocation || "",
        receiverDate: payload.resultDate,
        source: finishTask ? "任务结束" : "结果上传",
        reason,
        projectId: project.id,
        stageId: stage.id,
        taskId: task.id,
        testItem: task.testItem,
        faultMarked: isFault,
        problemDescription: item.problem,
        photoIds,
        photos: item.photos || []
      });
    });

    if (!Array.isArray(task.resultUploads)) task.resultUploads = [];
    task.resultUploads.push({
      id: Utils.id("result_"),
      result,
      user: payload.user,
      resultDate: payload.resultDate,
      reason,
      time: now,
      finishTask,
      finishType: finishTask ? payload.finishType : "",
      samples: payload.samples.map(item => ({
        sampleId: item.sid,
        state: item.state || "active",
        currentEditLocked: !!item.currentEditLocked,
        fault: item.fault,
        destination: item.destination,
        destLocation: item.destLocation || "",
        receiver: item.receiver,
        accountOwner: item.accountOwner || "",
        problem: item.problem || "",
        problemRecords: item.problemRecords || [],
        photos: item.photos || []
      }))
    });

    if (finishTask) {
      const completionType = payload.finishType;
      const transition = this.transitionTaskStatus(stage, task, completionType, {
        completedAt: now,
        endDate: payload.resultDate || Utils.today(),
        issue: result === "不通过" ? reason : ""
      });
      this.addTaskLog(task, "结束任务", {
        user: payload.user,
        reason,
        fromStatus: from,
        toStatus: transition.toStatus,
        detail: `结果：${result}；结束方式：${completionType}`
      });
    } else {
      this.addTaskLog(task, "上传结果", {
        user: payload.user,
        reason,
        fromStatus: from,
        toStatus: task.status,
        detail: `结果：${result}`
      });
    }
    return [...sampleIdsForMutation].filter(Boolean);
  },

  isTaskResultSamplesEqual(a, b) {
    if (!a || !b) return false;
    const sa = a.samples || [], sb = b.samples || [];
    if (sa.length !== sb.length) return false;
    return sa.every((item, i) => {
      const o = sb[i];
      if (!o) return false;
      if ((item.sid || item.sampleId || "") !== (o.sid || o.sampleId || "")) return false;
      if (!!item.currentEditLocked !== !!o.currentEditLocked) return false;
      if (item.state !== o.state || item.fault !== o.fault || item.destination !== o.destination) return false;
      if (item.destLocation !== o.destLocation || item.accountOwner !== o.accountOwner || item.receiver !== o.receiver || item.problem !== o.problem) return false;
      const problemKey = records => JSON.stringify((records || []).filter(r => r.description).map(r =>
        JSON.stringify([r.id || "", r.description, r.source || "手动补录", r.taskLabel || "", [...new Set(r.photoIds || [])].sort()])).sort());
      const photoKey = photos => JSON.stringify((photos || []).map(photo => String(photo.id || photo.url || "")).filter(Boolean).sort());
      return problemKey(item.problemRecords) === problemKey(o.problemRecords) && photoKey(item.photos) === photoKey(o.photos);
    });
  },

  isTaskResultPayloadEqual(a, b) {
    if (!a || !b) return false;
    if ((a.result || "") !== (b.result || "")) return false;
    if ((a.user || "") !== (b.user || "")) return false;
    if ((a.resultDate || "") !== (b.resultDate || "")) return false;
    if ((a.finishType || "") !== (b.finishType || "")) return false;
    return this.isTaskResultSamplesEqual(a, b);
  },

  restoreTaskResultSaveSnapshot(snapshot) {
    if (!snapshot) return;
    if (this.isDataSnapshotCurrent?.(snapshot.data) === false) return;
    this.restoreDataSnapshot(snapshot.data);
    this._baseData = snapshot.baseData;
    this._lastTaskMutationError = null;
  },

  async refreshTaskAfterAlreadyFinished(projectId, stageId) {
    if (typeof this.refreshAfterMutationRevisionConflict === "function") {
      return this.refreshAfterMutationRevisionConflict();
    }
    if (!this.fetchProjectDetail || !this.mergeProjectDetail) return;
    try {
      this.updateServerStatus?.("刷新任务");
      const project = await this.fetchProjectDetail(projectId, { includeTasks: true });
      if (project) {
        this.mergeProjectDetail(project, { includeTasks: true });
        this._baseData = this.dataSnapshot();
        this.invalidatePagedCaches?.({ stageId });
        this.render?.();
      }
      this.updateServerStatus?.("已同步");
    } catch (e) {
      console.error("重复结束任务后刷新服务器状态失败：", e);
      this.updateServerStatus?.("刷新失败");
      alert("任务已在服务器结束，但刷新本地状态失败：" + (e.message || e));
    }
  },

  async saveTaskResult(projectId, stageId, taskId, finishTask = false) {
    if (this._taskResultPhotoUploads > 0) {
      Utils.toast("结果图片仍在上传，请等待上传完成后保存。");
      return true;
    }
    const { p, s, t } = this.getProjectStageTask(projectId, stageId, taskId);
    if (!p || !s || !t) return false;
    if (finishTask && this.isTaskCompleted(t)) return false;
    const payload = this.collectTaskResultForm();
    if (!finishTask) {
      const baselineUnchanged =
        this._taskResultBaselineTaskId === taskId &&
        this.isTaskResultPayloadEqual(this._taskResultBaseline, payload);

      if (baselineUnchanged) {
        Utils.toast("未检测到结果变更，未写入日志。");
        return false;
      }

      // An unfinished draft is a private task record, not an assignment to the archive.
      // Required people and destinations are validated only when synchronizing results.
      const memberError = this.isTaskCompleted(t) ? this.validateTaskResultMemberFields(payload) : "";
      if (memberError) {
        this.markTaskResultMemberValidation(payload);
        Utils.toast(memberError);
        return true;
      }

      if (!this.isTaskCompleted(t)) {
        const mutationSnapshot = this.taskMutationSnapshot();
        this.saveTaskResultDraft(p, s, t, payload);
        const saved = await this.commitTaskMutation(p, s, t, {
          action: "save_task_result_draft",
          remark: "保存测试结果草稿",
          user: payload.user,
          sampleIdsForMutation: []
        });
        if (!saved) {
          this.restoreFailedTaskMutation(mutationSnapshot, { render: false });
          return this._lastTaskMutationError?._refreshSucceeded !== true;
        }
        Utils.toast("结果草稿已保存；点击结束任务时会同步到样机档案。");
        return false;
      }
      const mutationSnapshot = this.taskMutationSnapshot();
      const sampleIdsForMutation = this.applyTaskResult(p, s, t, payload, false);
      const saved = await this.commitTaskMutation(p, s, t, {
        action: "upload_task_result",
        remark: "保存测试结果",
        user: payload.user,
        sampleIdsForMutation
      });
      if (!saved) {
        this.restoreFailedTaskMutation(mutationSnapshot, { render: false });
        return this._lastTaskMutationError?._refreshSucceeded !== true;
      }
      Utils.toast("本次结果已保存，样机档案已同步。");
      return false;
    }
    const error = this.validateTaskResultPayload(payload, finishTask);
    if (error) {
      this.markTaskResultValidation(payload, finishTask);
      Utils.toast(error);
      return true;
    }
    const finishKey = String(taskId || "");
    if (finishTask) {
      if (!this._taskFinishInFlight) this._taskFinishInFlight = {};
      if (this._taskFinishInFlight[finishKey]) return true;
      this._taskFinishInFlight[finishKey] = true;
    }
    const snapshot = finishTask ? this.taskMutationSnapshot() : null;
    try {
      const sampleIdsForMutation = this.applyTaskResult(p, s, t, payload, finishTask);
      if (finishTask) delete t.resultDraft;
      const saved = await this.commitTaskMutation(p, s, t, {
        action: finishTask ? "finish_task_result" : "upload_task_result",
        remark: finishTask ? "结束任务并保存结果" : "保存测试结果",
        user: payload.user,
        sampleIdsForMutation
      });
      if (!saved) {
        const mutationError = this._lastTaskMutationError;
        const restored = finishTask
          ? this.restoreFailedTaskMutation(snapshot, { render: false })
          : false;
        if (finishTask && mutationError?.error_code === "TASK_ALREADY_FINISHED") {
          await this.refreshTaskAfterAlreadyFinished(projectId, stageId);
          return false;
        }
        return finishTask ? restored : true;
      }
      Utils.toast(finishTask ? "任务已结束，结果和样机档案已同步。" : "本次结果已保存，样机档案已同步。");
      return false;
    } finally {
      if (finishTask && this._taskFinishInFlight) delete this._taskFinishInFlight[finishKey];
    }
  },


  // 上传结果（完成前后均可）
  async uploadResult(projectId, stageId, taskId) {
    const dialogRequest = this.beginDialogRequest?.();
    let { p, s, t } = this.getProjectStageTask(projectId, stageId, taskId);
    if (!t) return;
    if (this.taskFlowStatus(t) === "待下发") { alert("任务尚未启动。"); return; }
    const request = this._taskResultOpenSequence = (this._taskResultOpenSequence || 0) + 1;
    const modalId = this._currentModalId;
    const viewKey = JSON.stringify(this.view || {});
    const entries = this.taskResultSampleEntries(t);
    const resultSampleIds = entries.map(item => item.sampleId || item.sid).filter(Boolean);
    if (typeof this.prepareTaskActionSamples === "function") {
      const preparation = this.prepareTaskActionSamples(t, resultSampleIds, "打开结果录入");
      if (preparation?.then ? !await preparation : preparation === false) return;
    } else {
      const loadingSamples = this.ensureTaskReferenceSamplesLoaded?.(t);
      if (loadingSamples?.then) await loadingSamples;
    }
    if (request !== this._taskResultOpenSequence || modalId !== this._currentModalId || viewKey !== JSON.stringify(this.view || {})) return;
    if (this.isDialogRequestCurrent?.(dialogRequest) === false) return;
    ({ p, s, t } = this.getProjectStageTask(projectId, stageId, taskId));
    if (!t || this.taskFlowStatus(t) === "待下发") return;
    const addOnly = this.isTaskCompleted(t);
    const draft = addOnly ? null : (t.resultDraft || {});
    const resultValue = this.normalizeTaskResultValue(draft?.result || "");
    const resultOptions = ["通过", "不通过"].map(value => `<option value="${value}" ${resultValue === value ? "selected" : ""}>${value}</option>`).join("");
    const resultDate = draft?.resultDate || Utils.today();
    const finishType = draft?.finishType || "正常完成";
    this._taskResultUploadContext = {
      projectId,
      stageId,
      taskId,
      taskLabel: this.sampleTaskLabelFromCtx({ project: p, stage: s, task: t })
    };

    const resultTitle = addOnly ? "追加测试结果" : "测试结果录入";
    const resultTitleNode = document.createElement("span");
    resultTitleNode.className = "task-result-title";
    resultTitleNode.textContent = resultTitle;
    const resultHelp = document.createElement("button");
    resultHelp.type = "button";
    resultHelp.className = "project-config-help-button";
    resultHelp.textContent = "?";
    resultHelp.title = addOnly
      ? "任务已结束。追加结果会同步样机档案，不改变任务结束状态。"
      : "保存草稿允许暂缺人员或去向，仅记录本次填写；结束任务时须补全并校验，成功后才同步到样机档案。";
    resultHelp.setAttribute("aria-label", resultHelp.title);
    resultTitleNode.appendChild(resultHelp);
    const resultModalId = this.showModal(resultTitle, `
      <div class="task-result-layout">
        <section class="task-result-fixed-panel">
          <div class="task-result-form-grid ${addOnly ? "is-completed" : ""}">
            <div class="form-group"><label class="req" for="taskResultValue">测试结果</label><select id="taskResultValue" data-app-action="task-result-value" data-app-events="change"><option value="">请选择结果</option>${resultOptions}</select></div>
            <div class="form-group"><label class="req" for="taskResultUser">结果录入人</label>${this.projectMemberSelectHtml("taskResultUser", draft?.user || "", "请选择结果录入人", { scope: "tester", showRole: true })}</div>
            ${addOnly
              ? `<div class="form-group"><label for="taskResultDate">结果日期</label><input type="date" id="taskResultDate" value="${Utils.today()}"><input type="hidden" id="taskFinishType" value="正常完成"></div>`
              : `<div class="form-group"><label for="taskResultDate">结果日期</label><input type="date" id="taskResultDate" value="${Utils.esc(resultDate)}"></div>
                <div class="form-group"><label for="taskFinishType">结束任务方式</label><select id="taskFinishType" class="hint-select" data-app-action="task-result-finish-type" data-app-events="change"><option value="正常完成" ${finishType === "正常完成" ? "selected" : ""}>完成计划，正常结束</option><option value="异常终止" ${finishType === "异常终止" ? "selected" : ""}>未完成计划，异常结束</option></select></div>`}
          </div>
        </section>
        <section class="task-result-scroll-panel">
          <div class="task-result-section-title">
            <b>样机结果与去向</b>
            <span>${entries.length} 台样机</span>
          </div>
          <div class="task-result-sample-list">${this.taskResultSampleRowsHtml(t, draft)}</div>
        </section>
      </div>
    `, () => this.saveTaskResult(projectId, stageId, taskId, false), addOnly ? "保存并同步" : "保存草稿", {
      className: "task-result-modal",
      titleNodes: [resultTitleNode],
      headerHint: t.testItem || "未命名测试任务"
    });
    document.querySelectorAll(".task-result-sample-row").forEach(row => this.renderTaskResultPhotoList(row));
    this.syncTaskResultFinishType();

    // 记录弹窗打开时的基线快照，用于保存时判断是否有变更
    this._taskResultBaselineTaskId = taskId;
    this._taskResultBaseline = this.collectTaskResultForm();

    if (!addOnly) {
      const endBtn = document.createElement("button");
      endBtn.type = "button";
      endBtn.className = "btn btn-purple modal-extra-action";
      endBtn.innerText = "结束任务并同步";
      endBtn.addEventListener("click", async () => {
        // 父弹窗从样机详情返回时，基础 OK 按钮会按当前 modal 实例重建；点击时再取，避免持有旧节点。
        const ok = document.getElementById("modalOk");
        if (endBtn.disabled || ok?.disabled) return;
        const oldText = endBtn.innerText;
        const okWasDisabled = !!ok?.disabled;
        let keepOpen = true;
        const ownsModalInstance = !!resultModalId && typeof this.setModalBusy === "function";
        if (ownsModalInstance) this.setModalBusy(resultModalId, true);
        endBtn.disabled = true;
        endBtn.innerText = "结束并同步中...";
        if (ok) ok.disabled = true;
        try {
          keepOpen = await this.saveTaskResult(projectId, stageId, taskId, true);
          if (!keepOpen) {
            this.closeModal(resultModalId || null);
            return;
          }
        } finally {
          if (keepOpen) {
            if (ownsModalInstance) this.setModalBusy(resultModalId, false);
            endBtn.disabled = false;
            endBtn.innerText = oldText;
            if (ok) ok.disabled = okWasDisabled;
          }
        }
      });
      const ok = document.getElementById("modalOk");
      ok?.insertAdjacentElement("afterend", endBtn);
    }
  },

  // 完成任务（正常完成/异常终止）
  completeTask(projectId, stageId, taskId) {
    this.uploadResult(projectId, stageId, taskId);
  },

});
