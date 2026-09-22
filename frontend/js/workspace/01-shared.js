/* ========================================
   数字治理平台 V7 - workspace 共享工具模块
   ======================================== */

app.registerModule("workspace.shared", {

  // ==================== 任务下发与执行管理 ====================
  taskOwnerName(owner) {
    const text = String(owner || "").trim();
    if (!text) return "";
    const idx = text.indexOf("/");
    if (idx >= 0) return text.slice(0, idx).replace(/（[^）]*）|\([^)]*\)/g, "").trim() || text.slice(0, idx).trim();
    return text.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  },

  taskOwnerId(owner) {
    const text = String(owner || "").trim();
    if (!text) return "";
    const idx = text.indexOf("/");
    if (idx >= 0) {
      const after = text.slice(idx + 1).trim();
      const parenClean = after.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
      return parenClean;
    }
    return "";
  },

  taskDateText(value) {
    const text = String(value || "").trim();
    if (!text) return "-";
    const datePart = text.includes("T") ? text.split("T")[0] : text.slice(0, 10);
    return datePart.replace(/-/g, "/");
  },

  taskCategoryItemText(category, testItem) {
    const cat = String(category || "").trim();
    const item = String(testItem || "").trim();
    if (cat && item) return `${cat} - ${item}`;
    return cat || item || "-";
  },

  taskFlowStatus(t) {
    return this.normalizeTaskFlowStatus(t);
  },

  taskStoredStatus(flowStatus) {
    return this.normalizeTaskStoredStatus(flowStatus);
  },

  repairTaskStatus(task, nextStatus, ctx = {}) {
    if (!task) return { status: "", flow: "" };
    const storedStatus = this.taskStoredStatus(nextStatus);
    const flowStatus = this.taskFlowStatus({ ...task, status: storedStatus, completed: ["正常完成", "异常终止"].includes(storedStatus) });
    const changed = task.status !== storedStatus;
    task.status = storedStatus;

    if (flowStatus === "进行中") {
      task.completed = false;
      if (ctx.startDate !== undefined && (!task.startDate || ctx.resetStartDate)) task.startDate = ctx.startDate;
    } else if (flowStatus === "阻塞中") {
      task.completed = false;
      if (ctx.reason !== undefined) task.blockReason = ctx.reason || "";
    } else if (["正常完成", "异常终止"].includes(flowStatus)) {
      task.completed = true;
      task.completionType = flowStatus;
      if (ctx.completedAt !== undefined) task.completedAt = ctx.completedAt;
      if (ctx.endDate !== undefined) task.endDate = ctx.endDate;
    } else {
      task.completed = false;
      if (ctx.clearCompletion) {
        task.completionType = "";
        task.completedAt = "";
      }
    }
    if (changed && ctx.markChanged) this._normalizedChanged = true;
    return { status: task.status, flow: flowStatus };
  },

  createProgressRecord(values = {}) {
    return {
      id: values.id || Utils.id("prog_"),
      strategyId: values.strategyId || "",
      category: values.category || "",
      testItem: values.testItem || "",
      skuIndex: values.skuIndex || 1,
      sampleSize: values.sampleSize || ""
    };
  },

  taskResultStatus(task) {
    if (!task) return "";
    const direct = this.normalizeTaskResultValue(task.latestResult || task.result || "");
    if (direct) return direct;
    const uploads = Array.isArray(task.resultUploads) ? task.resultUploads : [];
    for (let i = uploads.length - 1; i >= 0; i--) {
      const result = this.normalizeTaskResultValue(uploads[i]?.result || "");
      if (result) return result;
    }
    return "";
  },

  progressDisplayStatus(stage, progress) {
    if (!stage || !progress?.id) return "待下发";
    const tasks = (stage.tasks || []).filter(task => !task?.archived && task.progressId === progress.id);
    if (!tasks.length) return "待下发";
    const statuses = new Set();
    tasks.forEach(task => {
      const flow = this.taskFlowStatus(task);
      if (flow === "进行中" || flow === "阻塞中" || flow === "待下发") {
        statuses.add(flow);
        return;
      }
      const result = this.taskResultStatus(task);
      if (flow === "异常终止") statuses.add("不通过");
      else statuses.add(result || "通过");
    });
    const priority = ["进行中", "阻塞中", "不通过", "待下发", "通过"];
    return priority.find(status => statuses.has(status)) || "待下发";
  },

  transitionTaskStatus(stage, task, nextStatus, ctx = {}) {
    if (!task) return { fromStatus: "", toStatus: "", fromFlow: "", toFlow: "" };
    const fromStatus = task.status || "";
    const fromFlow = this.taskFlowStatus(task);
    const repaired = this.repairTaskStatus(task, nextStatus, {
      ...ctx,
      startDate: ctx.startDate || Utils.today(),
      completedAt: ctx.completedAt || Utils.now(),
      endDate: ctx.endDate || task.endDate || Utils.today()
    });
    const toFlow = repaired.flow;

    return { fromStatus, toStatus: task.status, fromFlow, toFlow };
  },

  taskStatusBadgeClass(status) {
    if (status === "进行中") return "status-running";
    if (status === "阻塞中") return "status-blocked";
    if (status === "正常完成") return "status-done";
    if (status === "异常终止") return "status-bad";
    return "status-pending";
  },

  getProgressRequiredSampleCount(stage, progress) {
    if (!stage || !progress) return null;
    let n = Utils.parsePositiveInt(progress.sampleSize);
    if (n !== null) return n;
    const strategy = (stage.strategy || []).find(r => r.id === progress.strategyId || r.item === progress.testItem);
    return Utils.parsePositiveInt(strategy?.sampleSize);
  },

  getProgressDisplayName(stage, progress) {
    if (!stage || !progress) return "未知测试项";
    const sku = stage.skuNames?.[progress.skuIndex - 1] || `SKU${progress.skuIndex}`;
    return `${sku} · ${progress.category || ""} · ${progress.testItem || ""}`;
  },

  projectMemberSelectHtml(id, selected = "", placeholder = "请选择人员", disabledOrOptions = false, extraOptions = {}) {
    const optionsArg = (disabledOrOptions && typeof disabledOrOptions === "object")
      ? disabledOrOptions
      : { ...(extraOptions || {}), disabled: !!disabledOrOptions };
    const disabled = !!optionsArg.disabled;
    const scope = this.memberScopeRole(optionsArg.scope || "all");
    const explicitProjectId = optionsArg.projectId || optionsArg.project?.id || "";
    const p = optionsArg.project
      || (explicitProjectId && typeof this.findProjectRecord === "function" ? this.findProjectRecord(explicitProjectId) : null)
      || this.currentProject();
    const members = this.projectActiveMembers(p, scope);
    const allMembers = this.projectActiveMembers(p);
    const selectedText = String(selected || "");
    const roleText = scope === "all" ? "项目人员" : this.memberRoleLabel(scope);
    const selectedIdentity = Utils.personIdentityFromText(selectedText);
    const selectedKey = selectedIdentity.name && selectedIdentity.employeeNo
      ? Utils.memberIdentityKey(selectedIdentity.name, selectedIdentity.employeeNo)
      : "";
    const disabledAttr = disabled ? " disabled" : "";
    const menuId = `${id}MemberOptions`;
    const inputAttrs = [
      `id="${Utils.esc(id)}"`,
      `class="project-member-select project-member-combobox-input"`,
      `value="${Utils.esc(selectedText)}"`,
      `placeholder="${Utils.esc(placeholder)}"`,
      `data-member-scope="${Utils.esc(scope)}"`,
      `data-member-project-id="${Utils.esc(p?.id || "")}"`,
      `data-member-menu-id="${Utils.esc(menuId)}"`,
      `data-app-action="project-member-combobox"`,
      `data-app-events="focusin click input keydown"`,
      `role="combobox"`,
      `aria-autocomplete="list"`,
      `aria-expanded="false"`,
      `aria-controls="${Utils.esc(menuId)}"`,
      `autocomplete="off"`,
      disabledAttr
    ].filter(Boolean).join(" ");
    const selectedMember = selectedKey
      ? allMembers.find(m => Utils.memberIdentityKey(m.name, m.employeeNo) === selectedKey)
      : null;
    const selectedAllowed = selectedMember && this.memberMatchesScope(selectedMember, scope);
    if (!members.length) {
      return `<input ${inputAttrs} disabled title="请先在项目人员配置中新增${Utils.esc(roleText)}">`;
    }
    const compactRoleLabel = role => this.memberRoleLabel(role).replace(/人员$/, "");
    const selectedValue = selectedAllowed ? Utils.personText(selectedMember.name, selectedMember.employeeNo) : "";
    const optionHtml = list => list.map(m => {
      const value = Utils.personText(m.name, m.employeeNo);
      const role = this.memberRoleValue(m.role);
      const searchKey = `${m.name || ""} ${m.employeeNo || ""} ${value} ${this.memberRoleLabel(role)} ${role}`.toLowerCase();
      return `<button type="button" class="project-member-combobox-option ${value === selectedValue ? "is-selected" : ""}"
        data-app-action="project-member-combobox-option" data-stop-propagation="1" data-member-target="${Utils.esc(id)}"
        data-member-value="${Utils.esc(value)}" data-member-role="${Utils.esc(role)}" data-member-search-key="${Utils.esc(searchKey)}">
        <span class="project-member-combobox-name">${Utils.esc(m.name || "-")}</span>
        <span class="project-member-combobox-no">${Utils.esc(m.employeeNo || "-")}</span>
        ${scope === "all" || optionsArg.showRole ? `<span class="project-member-combobox-role">${Utils.esc(compactRoleLabel(role))}</span>` : ""}
      </button>`;
    }).join("");
    const optionGroups = scope === "all"
      ? this.memberRoleList().map(role => {
        const roleMembers = members.filter(m => this.memberRoleValue(m.role) === role);
        if (!roleMembers.length) return "";
        return `<div class="project-member-combobox-group" data-member-role-group="${Utils.esc(role)}">
          <div class="project-member-combobox-group-label">${Utils.esc(compactRoleLabel(role))}</div>
          ${optionHtml(roleMembers)}
        </div>`;
      }).join("")
      : optionHtml(members);
    const invalidHint = selectedText && selectedKey && !selectedAllowed
      ? `<div class="project-member-select-hint is-invalid">当前：${Utils.esc(selectedText)}（不符合${Utils.esc(scope === "all" ? "项目人员" : this.memberRoleLabel(scope))}）</div>`
      : "";
    return `<div class="project-member-picker project-member-combobox">
      <input type="text" ${inputAttrs}>
      <div id="${Utils.esc(menuId)}" class="project-member-combobox-menu" role="listbox">
        ${optionGroups}
        <div class="project-member-combobox-empty" hidden>没有匹配人员</div>
      </div>
      ${invalidHint}
    </div>`;
  },

  projectMemberComboboxMenu(input) {
    if (!input || typeof document === "undefined") return null;
    const menuId = input.dataset?.memberMenuId || "";
    return menuId ? document.getElementById(menuId) : input.closest?.(".project-member-picker")?.querySelector?.(".project-member-combobox-menu");
  },

  openProjectMemberCombobox(input, options = {}) {
    if (!input || input.disabled) return;
    const picker = input.closest?.(".project-member-picker");
    const menu = this.projectMemberComboboxMenu(input);
    if (!picker || !menu) return;
    this.closeProjectMemberComboboxes(input);
    this.closeTaskResultLocationComboboxes?.();
    picker.classList.add("is-open");
    input.setAttribute?.("aria-expanded", "true");
    if (options.reset !== false) this.filterProjectMemberCombobox(input, "");
    this.positionTaskResultMenu?.(input, menu);
  },

  closeProjectMemberComboboxes(exceptInput = null) {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
    document.querySelectorAll(".project-member-picker.is-open").forEach(picker => {
      const input = picker.querySelector?.(".project-member-combobox-input");
      if (exceptInput && input === exceptInput) return;
      picker.classList.remove("is-open");
      input?.setAttribute?.("aria-expanded", "false");
      picker.querySelectorAll?.(".project-member-combobox-option.is-active").forEach(option => option.classList.remove("is-active"));
    });
  },

  scheduleProjectMemberComboboxFilter(input) {
    if (!input) return;
    if (!this._projectMemberComboboxTimers) this._projectMemberComboboxTimers = {};
    const key = input.id || input.dataset?.memberMenuId || "default";
    if (this._projectMemberComboboxTimers[key]) clearTimeout(this._projectMemberComboboxTimers[key]);
    this._projectMemberComboboxTimers[key] = setTimeout(() => {
      delete this._projectMemberComboboxTimers[key];
      this.filterProjectMemberCombobox(input);
    }, 500);
  },

  filterProjectMemberCombobox(input, forcedKeyword = null) {
    const menu = this.projectMemberComboboxMenu(input);
    if (!menu) return 0;
    const keyword = String(forcedKeyword === null ? input?.value || "" : forcedKeyword).trim().toLowerCase();
    let visibleCount = 0;
    const options = Array.from(menu.querySelectorAll?.(".project-member-combobox-option") || []);
    options.forEach(option => {
      const haystack = String(option.dataset?.memberSearchKey || option.textContent || "").toLowerCase();
      const visible = !keyword || haystack.includes(keyword);
      option.hidden = !visible;
      option.classList.remove("is-active");
      if (visible) visibleCount += 1;
    });
    menu.querySelectorAll?.(".project-member-combobox-group").forEach(group => {
      group.hidden = !Array.from(group.querySelectorAll(".project-member-combobox-option")).some(option => !option.hidden);
    });
    const empty = menu.querySelector?.(".project-member-combobox-empty");
    if (empty) empty.hidden = visibleCount > 0;
    return visibleCount;
  },

  handleProjectMemberCombobox(input, event, eventType) {
    if (!input || input.disabled) return;
    if (eventType === "focusin" || eventType === "click") {
      this.openProjectMemberCombobox(input, { reset: true });
      return;
    }
    if (eventType === "input") {
      this.openProjectMemberCombobox(input, { reset: false });
      this.scheduleProjectMemberComboboxFilter(input);
      return;
    }
    if (eventType === "keydown") {
      this.handleProjectMemberComboboxKey(input, event);
    }
  },

  visibleProjectMemberComboboxOptions(input) {
    const menu = this.projectMemberComboboxMenu(input);
    return Array.from(menu?.querySelectorAll?.(".project-member-combobox-option") || []).filter(option => !option.hidden);
  },

  handleProjectMemberComboboxKey(input, event) {
    if (!input || !event) return;
    if (this.isImeCompositionEvent?.(event)) return;
    if (event.key === "Escape") {
      if (input.closest?.(".project-member-picker")?.classList.contains("is-open")) event.preventDefault();
      this.closeProjectMemberComboboxes();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    const options = this.visibleProjectMemberComboboxOptions(input);
    if (!options.length) return;
    const activeIndex = options.findIndex(option => option.classList.contains("is-active"));
    if (event.key === "Enter") {
      if (activeIndex >= 0) {
        event.preventDefault();
        this.selectProjectMemberComboboxOption(options[activeIndex]);
      }
      return;
    }
    event.preventDefault();
    this.openProjectMemberCombobox(input, { reset: false });
    const nextIndex = event.key === "ArrowDown"
      ? (activeIndex + 1) % options.length
      : (activeIndex <= 0 ? options.length - 1 : activeIndex - 1);
    options.forEach(option => option.classList.remove("is-active"));
    options[nextIndex].classList.add("is-active");
    options[nextIndex].scrollIntoView?.({ block: "nearest" });
  },

  selectProjectMemberComboboxOption(option) {
    if (!option || typeof document === "undefined") return;
    const targetId = option.dataset?.memberTarget || "";
    const input = targetId ? document.getElementById(targetId) : null;
    if (!input || input.disabled) return;
    input.value = option.dataset?.memberValue || "";
    const menu = this.projectMemberComboboxMenu(input);
    menu?.querySelectorAll?.(".project-member-combobox-option").forEach(item => {
      item.classList.toggle("is-selected", item === option);
      item.classList.remove("is-active");
      item.hidden = false;
    });
    menu?.querySelectorAll?.(".project-member-combobox-group").forEach(group => { group.hidden = false; });
    const empty = menu?.querySelector?.(".project-member-combobox-empty");
    if (empty) empty.hidden = true;
    input.dispatchEvent?.(new Event("change", { bubbles: true }));
    this.closeProjectMemberComboboxes();
  },

  filterProjectMemberSelect(input) {
    return this.filterProjectMemberCombobox(input);
  },

  statusForOpenTaskUsage(task) {
    const flow = this.taskFlowStatus(task);
    if (flow === "进行中") return "测试中";
    if (flow === "阻塞中") return "在位等待";
    return "在位等待";
  },

  releaseTaskSamples(task, ctx = {}, excludeTaskIds = []) {
    const excluded = new Set([task?.id, ...(Array.isArray(excludeTaskIds) ? excludeTaskIds : [excludeTaskIds])].filter(Boolean));
    (task?.sampleIds || []).forEach(id => {
      const otherUsages = this.activeTaskUsagesForSample(id, excluded);
      if (otherUsages.length) {
        const usage = otherUsages[0];
        this.changeSampleStatus(id, this.statusForOpenTaskUsage(usage.task), {
          user: ctx.user || "管理员",
          source: ctx.source || "任务释放",
          reason: ctx.reason || "任务释放后仍被其他任务占用",
          projectId: usage.project.id,
          stageId: usage.stage.id,
          taskId: usage.task.id,
          testItem: usage.task.testItem
        });
      } else {
        this.changeSampleStatus(id, "闲置", {
          user: ctx.user || "管理员",
          source: ctx.source || "任务释放",
          reason: ctx.reason || "任务释放样机",
          projectId: ctx.projectId,
          stageId: ctx.stageId,
          forceLog: !!ctx.forceLog
        });
      }
    });
  },

  taskSampleDisplayName(sampleId) {
    const found = this.findSample(sampleId);
    const sample = found?.sample;
    return sample?.sampleNo || sample?.imei || sample?.sn || sample?.boardSn || sampleId;
  },

  sampleSnapshotForTask(sampleId, seed = {}) {
    const sid = String(sampleId || seed.sampleId || seed.id || "").trim();
    if (!sid) return null;
    const found = this.findSample(sid);
    const sample = found?.sample || {};
    const code = found?.sample
      ? this.sampleDisplayCode(sample)
      : (seed.code || seed.sampleNo || seed.sample_no || seed.sn || seed.imei || seed.boardSn || sid);
    return {
      id: sid,
      categoryId: found?.category?.id || sample.categoryId || seed.categoryId || "",
      categoryName: found?.category?.name || seed.categoryName || "",
      code,
      sampleNo: sample.sampleNo || seed.sampleNo || seed.code || code || sid,
      sn: sample.sn || seed.sn || "",
      imei: sample.imei || seed.imei || "",
      boardSn: sample.boardSn || seed.boardSn || "",
      capturedAt: seed.capturedAt || Utils.now(),
      destroyedAt: seed.destroyedAt || ""
    };
  },

  ensureTaskSampleSnapshots(task, sampleIds = null, options = {}) {
    if (!task) return {};
    if (!task.sampleSnapshots || typeof task.sampleSnapshots !== "object" || Array.isArray(task.sampleSnapshots)) {
      task.sampleSnapshots = {};
    }
    const ids = [];
    const seen = new Set();
    const add = value => {
      const sid = String(value || "").trim();
      if (sid && !seen.has(sid)) {
        seen.add(sid);
        ids.push(sid);
      }
    };
    const seedById = new Map();
    const rememberSeed = item => {
      if (!item || typeof item !== "object") return;
      const sid = String(item.sampleId || item.sid || item.id || "").trim();
      if (!sid) return;
      seedById.set(sid, { ...(seedById.get(sid) || {}), ...item });
      add(sid);
    };
    if (Array.isArray(sampleIds)) sampleIds.forEach(add);
    (task.sampleIds || []).forEach(add);
    (task.removedSampleRecords || []).forEach(rememberSeed);
    (task.sampleFaultRecords || []).forEach(rememberSeed);
    (task.resultDraft?.samples || []).forEach(rememberSeed);
    (task.resultUploads || []).forEach(upload => (upload?.samples || []).forEach(rememberSeed));

    ids.forEach(sid => {
      const existing = task.sampleSnapshots[sid] || {};
      const snapshot = this.sampleSnapshotForTask(sid, {
        ...seedById.get(sid),
        capturedAt: options.capturedAt || existing.capturedAt,
        destroyedAt: options.destroyedAt || existing.destroyedAt
      });
      if (!snapshot && !existing) return;
      task.sampleSnapshots[sid] = { ...existing, ...(snapshot || {}) };
      if (existing.destroyedAt && !options.destroyedAt) task.sampleSnapshots[sid].destroyedAt = existing.destroyedAt;
    });
    return task.sampleSnapshots;
  },

  attachSampleSnapshotToTasks(tasks = [], sampleIds = null, options = {}) {
    const list = Array.isArray(tasks) ? tasks : [tasks];
    list.forEach(task => this.ensureTaskSampleSnapshots(task, sampleIds, options));
  },

  taskSampleArchiveName(sampleId, snapshot = null) {
    const found = this.findSample(sampleId);
    const sample = found?.sample || null;
    const pool = found?.category?.name || snapshot?.categoryName || "未知样机池";
    const code = sample ? this.sampleDisplayCode(sample) : (snapshot?.code || snapshot?.sampleNo || sampleId);
    return `${pool}-${code}`;
  },

  taskSampleIdentityInfo(sampleId, snapshot = null) {
    const found = this.findSample(sampleId);
    const sample = found?.sample || {};
    return {
      pool: found?.category?.name || snapshot?.categoryName || "未知样机池",
      code: found ? this.sampleDisplayCode(sample) : (snapshot?.code || snapshot?.sampleNo || sampleId),
      sn: sample.sn || snapshot?.sn || "-",
      imei: sample.imei || snapshot?.imei || "-",
      boardSn: sample.boardSn || snapshot?.boardSn || "-"
    };
  },

});
