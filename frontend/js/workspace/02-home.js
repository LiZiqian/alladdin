/* ========================================
   数字治理平台 V7 - 项目工作台主页模块
   ======================================== */

app.registerModule("workspace.home", {

  stageProgressPercent(executedTasks, plannedItems) {
    const executed = Math.max(0, Number(executedTasks) || 0);
    const planned = Math.max(0, Number(plannedItems) || 0);
    if (!planned) return 0;
    return Math.min(100, Math.max(0, Math.round((executed / planned) * 100)));
  },

  refreshStageSummaryMetrics(stage) {
    if (!stage?.id || typeof document.querySelectorAll !== "function") return;
    const counts = stage.statusCounts || {};
    const executed = Number(counts["正常完成"] || 0) + Number(counts["异常终止"] || 0);
    const running = Number(counts["进行中"] || 0);
    const pct = this.stageProgressPercent(executed, (stage.progress || []).length);
    const values = { executedTasks: `${executed} 项`, runningTasks: `${running} 项`, progressPercent: `${pct}%` };
    if (stage.usedSampleRuns != null) values.usedSampleRuns = `${stage.usedSampleRuns} 台次`;
    if (stage.runningSampleCount != null) values.runningSampleCount = `${stage.runningSampleCount} 台`;
    document.querySelectorAll(".stage-summary-card[data-stage-summary-id]").forEach(card => {
      if (card.dataset.stageSummaryId !== String(stage.id)) return;
      card.querySelectorAll("[data-stage-stat]").forEach(node => {
        if (Object.prototype.hasOwnProperty.call(values, node.dataset.stageStat)) node.textContent = values[node.dataset.stageStat];
      });
      const fill = card.querySelector(".progress-bar-fill");
      if (fill) {
        fill.style.width = `${pct}%`;
      }
    });
  },

  // ==================== 项目工作台主页 ====================
  renderProjectWorkspace() {
    const p = this.currentProject();
    if (!p) { this.renderEmpty("请先在项目管理中新建项目"); return; }
    if (this.stageStrategyId()) { this.renderStageStrategyPage(); return; }

    this.ensureWorkspaceStageSelection(p);
    const s = p.stages.length ? this.currentStage() : null;

    // 各阶段统计
    const stageStats = p.stages.map(st => {
      const progress = st.progress || [];
      const tasks = this.activeStageTasks(st);
      const statusCounts = st.statusCounts || {};
      const hasServerTaskStats = typeof st.taskCount !== "undefined" || Object.keys(statusCounts).length > 0;
      const countStatus = status => hasServerTaskStats
        ? Number(statusCounts[status] || 0)
        : tasks.filter(t => this.taskFlowStatus(t) === status).length;
      const total = progress.length;
      const plannedSampleCount = progress.reduce((sum, item) => sum + (this.getProgressRequiredSampleCount(st, item) || 0), 0);
      const pass = countStatus("正常完成");
      const fail = countStatus("异常终止");
      const testing = countStatus("进行中");
      const pending = countStatus("待下发");
      const blocked = countStatus("阻塞中");
      const executedTasks = pass + fail;
      const usedSampleRuns = st.usedSampleRuns ?? (this._statePartial && !p._tasksFullyLoaded ? null : tasks
        .filter(t => this.taskFlowStatus(t) !== "待下发")
        .reduce((sum, t) => sum + new Set([
          ...(t.sampleIds || []),
          ...(t.removedSampleRecords || []).map(record => record?.sampleId || record?.sid),
        ].map(id => String(id || "").trim()).filter(Boolean)).size, 0));
      const runningTasks = tasks.filter(t => this.taskFlowStatus(t) === "进行中");
      const runningSampleCount = st.runningSampleCount ?? (this._statePartial && !p._tasksFullyLoaded ? null : new Set(runningTasks.flatMap(t => t.sampleIds || [])).size);
      const passRate = (pass + fail) ? ((pass / (pass + fail)) * 100).toFixed(1) : "0.0";
      const sampleIds = [...new Set(tasks.flatMap(t => t.sampleIds || []))];
      const taskCount = Number(st.taskCount ?? tasks.length) || 0;
      return {
        stage: st, total, plannedSampleCount, executedTasks, usedSampleRuns, runningTasks: hasServerTaskStats ? testing : runningTasks.length,
        runningSampleCount, pass, fail, testing, pending, blocked, passRate, tasks: taskCount, sampleCount: sampleIds.length
      };
    });

    // 项目总计
    const projectTotal = stageStats.reduce((a, x) => a + x.total, 0);
    const projectDispatchedTasks = stageStats.reduce((a, x) => a + x.tasks, 0);
    const projectPass = stageStats.reduce((a, x) => a + x.pass, 0);
    const projectFail = stageStats.reduce((a, x) => a + x.fail, 0);
    const projectTesting = stageStats.reduce((a, x) => a + x.testing, 0);
    const projectPassRate = (projectPass + projectFail) ? ((projectPass / (projectPass + projectFail)) * 100).toFixed(1) : "0.0";
    const sortMode = this.stageSortMode();

    // 阶段卡片（融合进度看板信息）
    const stageCards = stageStats.map(x => {
      const pct = this.stageProgressPercent(x.executedTasks, x.total);
      const cardAttrs = sortMode
        ? `data-stage-id="${Utils.esc(x.stage.id)}" draggable="true" data-app-action="stage-drag" data-app-events="dragstart dragover dragleave drop dragend" data-id="${Utils.esc(x.stage.id)}"`
        : `data-app-action="stage-select" data-id="${Utils.esc(x.stage.id)}"`;
      return `
      <div class="stage-summary-card ${x.stage.id === s?.id ? 'active' : ''} ${sortMode ? 'is-sorting' : ''}" data-stage-summary-id="${Utils.esc(x.stage.id)}" ${cardAttrs}>
        <div class="stage-summary-title">
          <div class="stage-summary-name-row">
            <span title="${Utils.esc(x.stage.name)} 阶段">${Utils.esc(x.stage.name)} 阶段</span>
          </div>
          <div class="path stage-summary-skus" title="方案：${(x.stage.skuNames || []).map(n => Utils.esc(n)).join('/') || '-'}">方案：${(x.stage.skuNames || []).map(n => Utils.esc(n)).join('/') || '-'}</div>
        </div>
        <div class="stage-summary-progress">
          <div class="progress-bar-wrap">
            <div class="progress-bar-fill" style="width:${pct}%"></div>
          </div>
          <span data-stage-stat="progressPercent">${pct}%</span>
        </div>
        <div class="stage-summary-metrics">
          <div class="stage-metric-card">
            <b>测试项</b>
            <span title="当前配置的测试用例与方案组合数">计划执行<em>${x.total} 项</em></span>
            <span title="正常完成与异常终止的任务数；同一用例重复执行分别计数">已执行<em data-stage-stat="executedTasks">${x.executedTasks} 项</em></span>
          </div>
          <div class="stage-metric-card">
            <b>样机数</b>
            <span title="各计划用例所需样机数量之和">计划使用<em>${x.plannedSampleCount} 台</em></span>
            <span title="已启动任务使用过的样机台次，含临时退出样机；同一任务内去重">已使用<em data-stage-stat="usedSampleRuns">${x.usedSampleRuns == null ? "—" : `${x.usedSampleRuns} 台次`}</em></span>
          </div>
          <div class="stage-metric-card">
            <b>进行中</b>
            <span>任务<em data-stage-stat="runningTasks">${x.runningTasks} 项</em></span>
            <span title="进行中任务当前关联的样机数，跨任务去重">占用样机<em data-stage-stat="runningSampleCount">${x.runningSampleCount == null ? "—" : `${x.runningSampleCount} 台`}</em></span>
          </div>
        </div>
        <div class="stage-summary-footer">
          ${sortMode
            ? '<span class="stage-sort-hint">拖动排序</span>'
            : `<button type="button" class="btn btn-sm btn-purple stage-config-btn" data-app-action="stage-strategy-open" data-stop-propagation="1" data-id="${Utils.esc(x.stage.id)}">配置测试用例集</button>
              <div class="stage-summary-actions">
                <button type="button" class="sample-card-destroy-btn" style="position:static" data-app-action="stage-delete" data-stop-propagation="1" data-id="${Utils.esc(x.stage.id)}" title="删除此阶段" aria-label="删除此阶段">${Utils.iconHtml("trash")}</button>
                <button type="button" class="stage-summary-copy-btn" title="复制为一个新阶段" aria-label="复制为一个新阶段" data-app-action="stage-copy" data-stop-propagation="1" data-id="${Utils.esc(x.stage.id)}">${Utils.iconHtml("copy")}</button>
              </div>`}
        </div>
      </div>`;
    }).join("");
    const addStageCard = `
      <div class="card add-card" data-app-action="stage-add" title="新增阶段">
        <div class="add-card-plus">+</div>
        <div class="add-card-label">新增阶段</div>
      </div>`;

    const sampleOwnerCounts = this.sampleOwnerCountsByMemberKey();
    const sampleBorrowerCounts = this.sampleBorrowerCountsByMemberKey();
    this.replaceWorkspaceContentNodes(
      document.getElementById("content"),
      this.projectWorkspacePageNodes(p, s, {
        stageCards,
        addStageCard,
        sampleOwnerCounts,
        sampleBorrowerCounts,
        sortMode,
      })
    );
  },

  replaceWorkspaceContentNodes(target, nodes = []) {
    if (!target) return null;
    if (typeof target.replaceChildren === "function") target.replaceChildren(...nodes);
    else {
      target.textContent = "";
      nodes.forEach(node => target.append?.(node));
    }
    return target;
  },

  appendWorkspaceHtml(parent, html) {
    const fragment = typeof this.htmlFragment === "function" ? this.htmlFragment(html) : null;
    if (fragment) parent.append(fragment);
    else {
      const holder = document.createElement("div");
      holder.textContent = String(html || "");
      parent.append(holder);
    }
  },

  projectWorkspacePageNodes(project, stage, { stageCards, addStageCard, sampleOwnerCounts, sampleBorrowerCounts, sortMode }) {
    const nodes = [];
    const configCard = document.createElement("div");
    configCard.className = "card project-config-card";

    const intro = document.createElement("div");
    intro.className = "project-config-intro";
    const title = document.createElement("h2");
    title.textContent = "项目配置工作台";
    intro.append(title);
    this.appendWorkspaceHtml(intro, this.projectConfigHelpHtml("overview", "项目配置说明", "项目需首先完成人员配置、位置配置与阶段方案配置。"));
    configCard.append(intro);

    this.appendWorkspaceHtml(configCard, this.workspaceMembersHtml(project, { sampleOwnerCounts, sampleBorrowerCounts }));
    this.appendWorkspaceHtml(configCard, this.workspaceLocationsHtml(project));
    this.appendWorkspaceHtml(configCard, this.workspaceDefaultSampleCategoryHtml(project));
    configCard.append(this.projectStageConfigSectionNode(stageCards, addStageCard, sortMode));
    nodes.push(configCard);

    if (stage) {
      const taskFlow = document.createElement("div");
      taskFlow.className = "card workspace-section section-green";
      this.appendWorkspaceHtml(taskFlow, this.workspaceTaskFlowHtml(project, stage));
      nodes.push(taskFlow);
    }
    return nodes;
  },

  projectConfigHelpHtml(key, label, text) {
    const id = `project-config-help-${key}`;
    return `<span class="project-config-help"><button type="button" class="project-config-help-button" aria-label="${Utils.esc(label)}" aria-describedby="${Utils.esc(id)}">?</button><span class="project-config-help-text" id="${Utils.esc(id)}" role="tooltip">${Utils.esc(text)}</span></span>`;
  },

  projectStageConfigSectionNode(stageCards, addStageCard, sortMode) {
    const section = document.createElement("div");
    section.className = "project-config-section";

    const head = document.createElement("div");
    head.className = "stage-summary-section-head";
    const title = document.createElement("div");
    title.className = "stage-summary-section-title";
    title.textContent = "项目阶段与方案配置";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `btn btn-sm ${sortMode ? "stage-sort-done" : "btn-outline"} stage-sort-toggle stage-sort-toggle-right`;
    toggle.dataset.appAction = "stage-sort-toggle";
    toggle.textContent = sortMode ? "完成排序" : "手动拖动排序";
    head.append(title);
    this.appendWorkspaceHtml(head, this.projectConfigHelpHtml("stages", "阶段与方案配置说明", "点击「配置测试用例集」可为该阶段配置测试用例池，并在「任务管理」中下发用例任务。"));
    head.append(toggle);
    section.append(head);

    const body = document.createElement("div");
    body.className = "project-config-body";
    const row = document.createElement("div");
    row.className = "stage-cards-row";
    const grid = document.createElement("div");
    grid.className = "stage-summary-grid";
    this.appendWorkspaceHtml(grid, `${stageCards}${addStageCard}`);
    row.append(grid);
    body.append(row);
    section.append(body);
    return section;
  },

  sampleOwnerCountsByMemberKey() {
    return this.samplePersonCountsByMemberKey("owner");
  },

  sampleBorrowerCountsByMemberKey() {
    return this.samplePersonCountsByMemberKey("borrower");
  },

  samplePersonCountsByMemberKey(field) {
    const counts = new Map();
    const totals = this.currentProject()?.samplePersonCounts?.[field];
    counts.complete = !!totals || !this._statePartial;
    if (totals && typeof totals === "object") {
      Object.entries(totals).forEach(([person, count]) => {
        const identity = Utils.personIdentityFromText(person);
        const key = Utils.memberIdentityKey(identity.name, identity.employeeNo);
        if (key !== "||") counts.set(key, (counts.get(key) || 0) + Number(count || 0));
      });
      return counts;
    }
    this.sampleCategoryRecords().forEach(category => {
      (category.samples || []).forEach(sample => {
        const identity = Utils.personIdentityFromText(sample?.[field] || "");
        const key = Utils.memberIdentityKey(identity.name, identity.employeeNo);
        if (key === "||") return;
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    });
    return counts;
  },

  workspaceMembersHtml(project, counts = {}) {
    if (!Array.isArray(project.members)) project.members = [];
    const activeMembers = this.projectActiveMembers(project);
    const memberUiState = this.projectMemberUiState();
    const memberSearch = String(memberUiState.memberSearch || "");
    const memberKw = memberSearch.trim().toLowerCase();
    const detailRoleValue = String(memberUiState.memberDetailRole || "");
    const detailRole = this.memberRoleList().includes(detailRoleValue) ? detailRoleValue : "tester";
    const roleData = this.memberRoleList().map(role => {
      const members = activeMembers.filter(m => this.memberRoleValue(m.role) === role);
      const rows = members.map(m => {
        const hidden = !this.projectMemberMatchesSearch(m, role, memberKw);
        return this.projectMemberRowHtml(project, m, counts, { hidden });
      }).join("");
      const visibleCount = members.filter(m => this.projectMemberMatchesSearch(m, role, memberKw)).length;
      return { role, members, rows, visibleCount, activeDetail: role === detailRole };
    });
    const detailItem = roleData.find(item => item.activeDetail);
    const visibleTotal = detailItem ? detailItem.visibleCount : 0;
    const roleButtons = roleData.map(item => `
      <button type="button" class="project-member-role-filter role-${Utils.esc(item.role)}" aria-pressed="${item.activeDetail}" data-app-action="project-members-role-toggle" data-value="${Utils.esc(item.role)}">
        ${Utils.esc(this.memberRoleLabel(item.role))}<span>${item.members.length}</span>
      </button>
    `).join("");
    const bulkDisabled = "disabled aria-disabled=\"true\"";
    const detailPanel = detailItem ? `
          <div class="project-members-detail-panel" data-member-role="${Utils.esc(detailItem.role)}">
            <div class="project-members-toolbar">
              <div class="project-member-role-filters" role="group" aria-label="人员分类">${roleButtons}</div>
              <label class="project-members-search">
                <input type="search" aria-label="搜索当前分类人员" value="${Utils.esc(memberSearch)}" placeholder="姓名 / 工号" data-app-action="project-member-search" data-app-events="input">
              </label>
              <span class="project-members-search-count" ${memberKw ? '' : 'hidden'} aria-live="polite">找到 ${visibleTotal} 人</span>
            </div>
              <div class="project-members-bulk-actions">
                <span class="project-members-selected-count">已选 0 人</span>
                ${this.memberRoleList().filter(role => role !== detailRole).map(role => `<button class="btn btn-sm btn-outline" data-app-action="project-members-bulk-role" data-value="${Utils.esc(role)}" ${bulkDisabled}>移到${Utils.esc(this.memberRoleLabel(role))}</button>`).join('')}
                <button class="btn btn-sm btn-danger" data-app-action="project-members-bulk-remove" ${bulkDisabled}>移除</button>
                <button class="btn btn-sm btn-outline" data-app-action="project-members-clear-selection" ${bulkDisabled}>清空选择</button>
              </div>
            <section class="project-member-role-group project-member-role-detail" data-member-role="${Utils.esc(detailItem.role)}">
              <div class="project-member-table-shell">
                <div class="project-member-table-body">
                  ${detailItem.rows}
                  <div class="project-member-empty ${detailItem.visibleCount ? 'is-hidden' : ''}">${detailItem.members.length ? '无匹配人员' : `暂无${Utils.esc(this.memberRoleLabel(detailItem.role))}`}</div>
                </div>
              </div>
            </section>
          </div>` : '';

    return `
      <div class="project-config-section project-members-section">
        <div class="stage-summary-section-head">
          <div class="stage-summary-section-title">人员配置</div>
          ${this.projectConfigHelpHtml("members", "人员配置说明", `测试人员用于任务下发和操作记录；开发人员用于样机取走；挂账人可从全部人员中选择。共 ${activeMembers.length} 人`)}
          <div class="project-members-head-actions">
            <button class="btn btn-sm btn-outline" data-app-action="project-members-template">下载导入模板</button>
            <button class="btn btn-sm" data-app-action="project-members-import">批量导入人员名单</button>
            <button class="btn btn-sm btn-add" data-app-action="project-member-add" data-value="${Utils.esc(detailRole)}">新增人员</button>
          </div>
        </div>
        <div class="project-members-body">
          ${detailPanel}
        </div>
      </div>`;
  },

  projectMemberMatchesSearch(member, role, keyword = "") {
    const kw = String(keyword || "").trim().toLowerCase();
    if (!kw) return true;
    const roleValue = this.memberRoleValue(role || member?.role);
    const identity = Utils.personText(member?.name, member?.employeeNo);
    const searchKey = `${identity} ${member?.name || ""} ${member?.employeeNo || ""} ${roleValue} ${this.memberRoleLabel(roleValue)}`.toLowerCase();
    return searchKey.includes(kw);
  },

  projectMemberRowHtml(project, member, counts = {}, options = {}) {
    const stat = this.memberSampleStats(member, counts);
    const identity = Utils.personText(member.name, member.employeeNo);
    const role = this.memberRoleValue(member.role);
    const searchKey = `${identity} ${member.name || ""} ${member.employeeNo || ""} ${role} ${this.memberRoleLabel(role)}`.toLowerCase();
    return `
      <div class="project-member-row project-member-card ${options.hidden ? 'is-search-hidden' : ''}" data-member-role="${Utils.esc(role)}" data-member-key="${Utils.esc(searchKey)}" data-app-action="project-member-edit" data-app-events="dblclick" data-id="${Utils.esc(member.id)}" role="button" tabindex="0" title="双击或按回车编辑人员" aria-label="编辑人员 ${Utils.esc(identity || "-")}">
        <label class="project-member-check" title="选择用于批量改分类" data-stop-propagation="1">
          <input type="checkbox" class="project-member-bulk-check" aria-label="选择 ${Utils.esc(identity)}" value="${Utils.esc(member.id)}" data-app-action="project-member-selection" data-app-events="change">
        </label>
        <div class="project-member-identity">
          <b title="${Utils.esc(member.name || "-")}">${Utils.esc(member.name || "-")}</b>
          <span title="${Utils.esc(member.employeeNo || "-")}">${Utils.esc(member.employeeNo || "-")}</span>
        </div>
        <div class="project-member-stat"><b>${counts.sampleOwnerCounts?.complete === false ? "—" : stat.ownedSamples}</b><span>挂账</span></div>
        <div class="project-member-stat"><b>${counts.sampleBorrowerCounts?.complete === false ? "—" : stat.borrowedSamples}</b><span>持有</span></div>
      </div>`;
  },

  projectMemberCardHtml(project, member, counts = {}) {
    return this.projectMemberRowHtml(project, member, counts);
  },

  workspaceLocationsHtml(project) {
    if (!Array.isArray(project.locations)) project.locations = [];
    const cards = project.locations.map((loc, idx) => loc ? `
      <div class="project-location-card" data-app-action="project-location-edit" data-app-events="dblclick" data-value="${idx}" role="button" tabindex="0" title="双击或按回车编辑位置" aria-label="编辑位置 ${Utils.esc(loc)}">
        <b>${Utils.esc(loc)}</b>
        <span class="project-location-remove" data-app-action="project-location-remove" data-stop-propagation="1" data-value="${idx}" role="button" tabindex="0" title="删除位置" aria-label="删除位置 ${Utils.esc(loc)}">${Utils.iconHtml("trash")}</span>
      </div>` : "").join("");
    return `
      <div class="project-config-section project-locations-section">
        <div class="stage-summary-section-head">
          <div class="stage-summary-section-title">位置配置</div>
          ${this.projectConfigHelpHtml("locations", "位置配置说明", "配置项目相关位置信息，用于记录样机实时存放地点，后续可在样机档案中选填。")}
        </div>
        <div class="project-locations-body">
          <div class="project-locations-grid">
            ${cards || ''}
            <div class="card add-card" data-app-action="project-location-add" role="button" tabindex="0" aria-label="新增位置">
              <div class="add-card-plus">+</div>
              <div class="add-card-label">新增位置</div>
            </div>
          </div>
        </div>
      </div>`;
  },

  workspaceDefaultSampleCategoryHtml(project) {
    const categories = this.sampleCategoryRecords();
    const selectedId = this.projectDefaultSampleCategoryId(project);
    const options = [
      `<option value="" ${selectedId ? "" : "selected"}>全部样机池</option>`,
      ...categories.map(category => {
        const id = String(category.id || "");
        const selected = id === selectedId ? "selected" : "";
        const count = Number(category.sampleCount ?? (category.samples || []).length) || 0;
        const suffix = count ? ` (${count})` : "";
        return `<option value="${Utils.esc(id)}" ${selected}>${Utils.esc(category.name || id)}${suffix}</option>`;
      })
    ].join("");
    return `
      <div class="project-config-section project-default-sample-section">
        <div class="stage-summary-section-head">
          <div class="stage-summary-section-title">样机池配置</div>
          ${this.projectConfigHelpHtml("samples", "样机池配置说明", "设置本项目任务配置、临时变更等样机选择入口的默认候选池。")}
        </div>
        <div class="project-default-sample-body project-config-body">
          <select id="projectDefaultSampleCategory" class="project-default-sample-select" aria-label="默认样机池" data-app-action="project-default-sample-category" data-app-events="change">${options}</select>
        </div>
      </div>`;
  },

  async setProjectDefaultSampleCategory(categoryId) {
    const p = this.currentProject();
    if (!p) return;
    const nextId = String(categoryId || "").trim();
    if (nextId && !this.findSampleCategoryRecord(nextId)) {
      alert("所选样机池不存在或已被删除。");
      this.render();
      return;
    }
    const before = String(p.defaultSampleCategoryId || "");
    if (before === nextId) return;
    const snapshot = this.dataSnapshot();
    p.defaultSampleCategoryId = nextId;
    const saved = await this.commitProjectMutation(p, {
      action: "set_project_default_sample_category",
      remark: nextId ? "设置项目默认样机池" : "清除项目默认样机池",
      user: "管理员"
    });
    if (!saved) {
      this.restoreDataSnapshot(snapshot);
      this.render();
      return;
    }
    Utils.toast(nextId ? "默认样机池已保存" : "已恢复为全部样机池");
  },

  addProjectLocation() {
    this.showModal("新增项目位置", `
      <div class="form-group"><label class="req modal-field-title">位置名称</label><input id="projectLocationName" placeholder="如：溪村-D8-B1F-A08 / 武汉-A3-1F-03R"></div>
    `, async () => {
      this.clearFieldValidationMarks();
      const p = this.currentProject();
      if (!p) return;
      const snapshot = this.dataSnapshot();
      if (!Array.isArray(p.locations)) p.locations = [];
      const el = document.getElementById("projectLocationName");
      const name = el.value.trim();
      if (!name) { this.markFieldInvalid(el, "位置名称不能为空"); return true; }
      if (p.locations.some(x => String(x).trim() === name)) { this.markFieldInvalid(el, "该位置已存在。"); return true; }
      p.locations.push(name);
      const saved = await this.commitProjectMutation(p, { action: "add_project_location", remark: "新增项目位置", user: "管理员" });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("位置已新增");
      return false;
    }, "确认", { className: "modal-sm" });
  },

  editProjectLocation(index) {
    const p = this.currentProject();
    if (!p || !Array.isArray(p.locations) || !p.locations[index]) return;
    const currentName = p.locations[index];
    const projectId = p.id;
    this.showModal("编辑项目位置", `
      <div class="form-group"><label class="req modal-field-title">位置名称</label><input id="projectLocationName" value="${Utils.esc(currentName)}" placeholder="如：溪村-D8-B1F-A08 / 武汉-A3-1F-03R"></div>
    `, async () => {
      const p = this.findProjectRecord(projectId);
      if (!p?.locations?.[index]) { alert("位置已不存在，请关闭后刷新。"); return true; }
      this.clearFieldValidationMarks();
      const snapshot = this.dataSnapshot();
      const el = document.getElementById("projectLocationName");
      const name = el.value.trim();
      if (!name) { this.markFieldInvalid(el, "位置名称不能为空"); return true; }
      if (name !== currentName && p.locations.some((x, i) => i !== index && String(x).trim() === name)) {
        this.markFieldInvalid(el, "该位置已存在。"); return true;
      }
      p.locations[index] = name;
      const saved = await this.commitProjectMutation(p, { action: "update_project_location", remark: "编辑项目位置", user: "管理员" });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("位置已保存");
      return false;
    }, "确认", { className: "modal-sm" });
  },
  removeProjectLocation(index) {
    const p = this.currentProject();
    if (!p || !Array.isArray(p.locations) || !p.locations[index]) return;
    this.showConfirm(`确认删除位置 ${p.locations[index]}？`, async () => {
      const snapshot = this.dataSnapshot();
      p.locations.splice(index, 1);
      const saved = await this.commitProjectMutation(p, { action: "remove_project_location", remark: "删除项目位置", user: "管理员" });
      if (!saved) { this.restoreDataSnapshot(snapshot); return; }
      this.render();
      Utils.toast("位置已删除");
    }, { title: "删除位置", okText: "删除", okClass: "btn btn-danger" });
  },

  setProjectMemberSearch(value) {
    this.patchViewState({ memberSearch: value });
    const kw = String(value || "").trim().toLowerCase();
    document.querySelectorAll(".project-member-row[data-member-key]").forEach(row => {
      const hidden = !!kw && !row.dataset.memberKey.includes(kw);
      row.classList.toggle("is-search-hidden", hidden);
      if (hidden) {
        const check = row.querySelector(".project-member-bulk-check");
        if (check) check.checked = false;
      }
    });
    this.refreshProjectMemberVisibleCounts();
  },
  refreshProjectMemberVisibleCounts() {
    const rows = [...document.querySelectorAll(".project-member-row[data-member-role]")];
    const visibleRows = rows.filter(row => !row.classList.contains("is-search-hidden"));
    document.querySelectorAll(".project-member-role-group[data-member-role]").forEach(group => {
      const role = group.dataset.memberRole || "";
      const roleRows = rows.filter(row => row.dataset.memberRole === role);
      const visibleCount = roleRows.filter(row => !row.classList.contains("is-search-hidden")).length;
      const emptyEl = group.querySelector(".project-member-empty");
      if (emptyEl) {
        emptyEl.textContent = roleRows.length ? "无匹配人员" : `暂无${this.memberRoleLabel(role)}`;
        emptyEl.classList.toggle("is-hidden", visibleCount > 0);
      }
    });
    const searchCount = document.querySelector(".project-members-search-count");
    if (searchCount) {
      searchCount.textContent = `找到 ${visibleRows.length} 人`;
      searchCount.hidden = !String(this.projectMemberUiState().memberSearch || "").trim();
    }
    this.updateProjectMemberSelectionCount();
  },
  updateProjectMemberSelectionCount() {
    const selectedCount = document.querySelectorAll(".project-member-bulk-check:checked").length;
    this.patchViewState({ memberSelectedCount: selectedCount });
    const countEl = document.querySelector(".project-members-selected-count");
    if (countEl) countEl.textContent = `已选 ${selectedCount} 人`;
    document.querySelectorAll('.project-members-bulk-actions button').forEach(button => {
      button.disabled = selectedCount === 0;
      button.setAttribute("aria-disabled", selectedCount === 0 ? "true" : "false");
    });
    document.querySelector(".project-members-bulk-actions")?.classList.toggle("has-selection", selectedCount > 0);
  },
  clearProjectMemberSelection() {
    document.querySelectorAll(".project-member-bulk-check:checked").forEach(input => {
      input.checked = false;
    });
    this.updateProjectMemberSelectionCount();
  },
  toggleProjectMemberRoleGroup(role) {
    const value = this.memberRoleValue(role);
    this.patchViewState({ memberDetailRole: value, memberSearch: "", memberSelectedCount: 0 });
    this.render();
  },
  validateProjectMember(name, employeeNo = "") {
    const text = String(employeeNo || "").trim() ? Utils.personText(name, employeeNo) : String(name || "").trim();
    const parsed = Utils.parsePersonField(text);
    return { ok: parsed.ok, name: parsed.name, employeeNo: parsed.employeeNo, msg: parsed.msg };
  },
  findProjectMemberByIdentity(project, name, employeeNo) {
    const key = Utils.memberIdentityKey(name, employeeNo);
    return (project?.members || []).find(m => Utils.memberIdentityKey(m.name, m.employeeNo) === key);
  },
  hasProjectMemberNameConflict(project, name, employeeNo, excludeId = "") {
    const cleanName = String(name || "").trim();
    const cleanNo = Utils.normalizeEmployeeNoKey(employeeNo || "");
    return (project?.members || []).some(m => {
      if (m.active === false || m.id === excludeId) return false;
      if (String(m.name || "").trim() !== cleanName) return false;
      const otherNo = Utils.normalizeEmployeeNoKey(m.employeeNo || "");
      return !cleanNo || !otherNo;
    });
  },
  projectMemberRoleSelectHtml(selected = "tester") {
    const value = this.memberRoleValue(selected);
    return `<select id="memberRole">${this.memberRoleList().map(role =>
      `<option value="${Utils.esc(role)}" ${role === value ? "selected" : ""}>${Utils.esc(this.memberRoleLabel(role))}</option>`
    ).join("")}</select>`;
  },

  addProjectMember(defaultRole = "tester", { afterSave = null } = {}) {
    const role = this.memberRoleValue(defaultRole);
    this.showModal("新增项目人员", `
      <div class="form-group"><label class="req modal-field-title">人员</label><input id="memberText" placeholder="姓名/工号，如：张三/00609513"></div>
      <div class="form-group"><label class="req modal-field-title">人员类型</label>${this.projectMemberRoleSelectHtml(role)}</div>
      <div class="form-hint">人员必须按「姓名/工号」填写，姓名和工号都不能为空。</div>
    `, async () => {
      this.clearFieldValidationMarks();
      const p = this.currentProject();
      if (!p) return;
      const snapshot = this.dataSnapshot();
      if (!Array.isArray(p.members)) p.members = [];
      const memberEl = document.getElementById("memberText");
      const nextRole = this.memberRoleValue(document.getElementById("memberRole")?.value || "tester");
      const check = this.validateProjectMember(memberEl.value);
      if (!check.ok) { this.markFieldInvalid(memberEl, check.msg); return true; }
      if (this.hasProjectMemberNameConflict(p, check.name, check.employeeNo)) {
        this.markFieldInvalid(memberEl, "项目中已存在同名人员。请为同名人员填写不同工号以区分。");
        return true;
      }
      const existing = this.findProjectMemberByIdentity(p, check.name, check.employeeNo);
      if (existing && existing.active !== false) { this.markFieldInvalid(memberEl, "该人员已在项目人员名单中，不能重复新增。"); return true; }
      let savedMember = existing;
      if (existing) {
        existing.name = check.name;
        existing.employeeNo = check.employeeNo;
        existing.active = true;
        existing.role = nextRole;
      } else {
        savedMember = { id: Utils.id("member_"), name: check.name, employeeNo: check.employeeNo, role: nextRole, active: true };
        p.members.push(savedMember);
      }
      const saved = await this.commitProjectMutation(p, { action: "add_project_member", remark: "新增项目人员", user: Utils.personText(check.name, check.employeeNo) });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("人员已新增");
      if (typeof afterSave === "function") {
        const identity = Utils.personText(savedMember.name, savedMember.employeeNo);
        setTimeout(() => afterSave({ member: savedMember, identity }), 0);
      }
      return false;
    }, "确认", { className: "modal-sm" });
  },
  editProjectMember(memberId) {
    const p = this.currentProject();
    const m = p?.members?.find(x => x.id === memberId);
    if (!m) return;
    const currentIdentity = Utils.personText(m.name, m.employeeNo);
    const projectId = p.id;
    this.showModal("编辑项目人员", `
      <div class="form-group"><label class="req modal-field-title">人员</label><input id="memberText" value="${Utils.esc(currentIdentity)}" placeholder="姓名/工号，如：张三/00609513"></div>
      <div class="form-group"><label class="req modal-field-title">人员类型</label>${this.projectMemberRoleSelectHtml(m.role)}</div>
      <div class="form-hint">人员必须按「姓名/工号」填写，姓名和工号都不能为空。</div>
      <button type="button" class="btn btn-sm btn-danger project-member-dialog-remove" data-app-action="project-member-remove" data-id="${Utils.esc(m.id)}">移出项目人员</button>
    `, async () => {
      const p = this.findProjectRecord(projectId);
      const m = p?.members?.find(member => member.id === memberId);
      if (!m) { alert("人员已不存在，请关闭后刷新。"); return true; }
      this.clearFieldValidationMarks();
      const snapshot = this.dataSnapshot();
      const memberEl = document.getElementById("memberText");
      const nextRole = this.memberRoleValue(document.getElementById("memberRole")?.value || m.role || "tester");
      const check = this.validateProjectMember(memberEl.value);
      if (!check.ok) { this.markFieldInvalid(memberEl, check.msg); return true; }
      if (this.hasProjectMemberNameConflict(p, check.name, check.employeeNo, m.id)) {
        this.markFieldInvalid(memberEl, "项目中已存在同名人员。请为同名人员填写不同工号以区分。");
        return true;
      }
      const existingOther = this.findProjectMemberByIdentity(p, check.name, check.employeeNo);
      if (existingOther && existingOther.id !== m.id && existingOther.active !== false) {
        this.markFieldInvalid(memberEl, "该人员已在项目人员名单中，不能重复。");
        return true;
      }
      m.name = check.name;
      m.employeeNo = check.employeeNo;
      m.role = nextRole;
      const saved = await this.commitProjectMutation(p, { action: "update_project_member", remark: "编辑项目人员", user: Utils.personText(check.name, check.employeeNo) });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("人员已保存");
      return false;
    }, "确认", { className: "modal-sm" });
  },
  downloadProjectMembersTemplate() {
    Utils.downloadCsv([
      ["姓名/工号", "人员类型"],
      ["张三/00609513", "测试人员"],
      ["李四/wx517815", "开发人员"],
      ["王五/00609515", "其他人员"]
    ], "项目人员导入模板.csv");
  },
  importProjectMembersCsv() {
    const projectId = this.currentProject()?.id;
    if (!projectId) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.addEventListener("change", () => {
      const file = input.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.addEventListener("load", async () => {
        const result = Utils.parseProjectMembersCsv(reader.result);
        if (result.error) { alert("人员名单导入失败：" + result.error); return; }
        const p = this.findProjectRecord(projectId);
        if (!p) return;
        if (!Array.isArray(p.members)) p.members = [];
        let added = 0, restored = 0, skippedDup = 0, roleUpdated = 0;
        let skippedNameConflict = 0;
        const snapshot = this.dataSnapshot();
        result.rows.forEach(row => {
          const check = this.validateProjectMember(Utils.personText(row.name, row.employeeNo));
          if (!check.ok) { skippedNameConflict++; return; }
          const existing = this.findProjectMemberByIdentity(p, check.name, check.employeeNo);
          if (existing) {
            if (existing.active !== false) {
              const nextRole = this.memberRoleValue(row.role || "tester");
              if (this.memberRoleValue(existing.role) !== nextRole) {
                existing.role = nextRole;
                roleUpdated++;
              } else {
                skippedDup++;
              }
            } else {
              existing.name = check.name;
              existing.employeeNo = check.employeeNo;
              existing.role = this.memberRoleValue(row.role || "tester");
              existing.active = true;
              restored++;
            }
          } else {
            if (this.hasProjectMemberNameConflict(p, check.name, check.employeeNo)) {
              skippedNameConflict++;
              return;
            }
            p.members.push({ id: Utils.id("member_"), name: check.name, employeeNo: check.employeeNo, role: this.memberRoleValue(row.role || "tester"), active: true });
            added++;
          }
        });
        const saved = await this.commitProjectMutation(p, { action: "import_project_members", remark: "批量导入项目人员", user: "管理员" });
        if (!saved) { this.restoreDataSnapshot(snapshot); return; }
        this.render();
        Utils.toast(`人员名单导入完成：新增 ${added} 人，恢复 ${restored} 人，更新分类 ${roleUpdated} 人，重复跳过 ${skippedDup} 人，格式错误跳过 ${skippedNameConflict + (result.skipped || 0)} 行。`);
      }, { once: true });
      reader.readAsText(file, "utf-8");
    }, { once: true });
    input.click();
  },
  removeProjectMember(memberId) {
    const p = this.currentProject();
    const m = p?.members?.find(x => x.id === memberId);
    if (!m) return;
    const editingModalId = document.getElementById("memberText") ? this._currentModalId : null;
    this.showConfirm(`确认将 ${Utils.personText(m.name, m.employeeNo)} 移出项目人员名单？`, async () => {
      const snapshot = this.dataSnapshot();
      m.active = false;
      const saved = await this.commitProjectMutation(p, { action: "remove_project_member", remark: "移出项目人员", user: "管理员" });
      if (!saved) { this.restoreDataSnapshot(snapshot); return; }
      if (editingModalId != null) this.closeModal(editingModalId);
      this.render();
      Utils.toast("人员已移出");
    }, { title: "移出人员", okText: "移出", okClass: "btn btn-danger" });
  },
  memberSampleStats(member, sampleOwnerCounts = null) {
    const memberKey = Utils.memberIdentityKey(member.name, member.employeeNo);
    const ownerCounts = sampleOwnerCounts?.sampleOwnerCounts instanceof Map ? sampleOwnerCounts.sampleOwnerCounts : sampleOwnerCounts;
    const borrowerCounts = sampleOwnerCounts?.sampleBorrowerCounts instanceof Map ? sampleOwnerCounts.sampleBorrowerCounts : null;
    const ownedSamples = ownerCounts instanceof Map
      ? (ownerCounts.get(memberKey) || 0)
      : this.allSamples().filter(sample => Utils.personMatchesMember(sample.owner, member)).length;
    const borrowedSamples = borrowerCounts instanceof Map
      ? (borrowerCounts.get(memberKey) || 0)
      : this.allSamples().filter(sample => Utils.personMatchesMember(sample.borrower, member)).length;
    return { ownedSamples, borrowedSamples };
  },

  bulkRemoveProjectMembers() {
    const project = this.currentProject();
    if (!project) return;
    const selectedIds = new Set([...document.querySelectorAll(".project-member-bulk-check:checked")]
      .map(el => String(el.value || "").trim()).filter(Boolean));
    const members = (project.members || []).filter(member => member.active !== false && selectedIds.has(String(member.id)));
    if (!members.length) { Utils.toast("请先勾选需要移出的人员。"); return; }
    const projectId = project.id;
    const memberIds = new Set(members.map(member => String(member.id)));
    this.showConfirm(`确认将选中的 ${members.length} 人移出项目人员名单？`, async () => {
      const current = this.findProjectRecord(projectId);
      if (!current) { Utils.toast("项目已不存在，请刷新后重试。"); return; }
      const targets = (current.members || []).filter(member => member.active !== false && memberIds.has(String(member.id)));
      if (!targets.length) { Utils.toast("所选人员已移出。"); return; }
      const snapshot = this.dataSnapshot();
      targets.forEach(member => { member.active = false; });
      try {
        const saved = await this.commitProjectMutation(current, { action: "bulk_remove_project_members", remark: `批量移出 ${targets.length} 名项目人员`, user: "管理员" });
        if (!saved) { this.restoreDataSnapshot(snapshot); this.render(); return; }
      } catch (error) {
        this.restoreDataSnapshot(snapshot);
        this.render();
        throw error;
      }
      this.patchViewState({ memberSelectedCount: 0 });
      this.render();
      Utils.toast(`已移出 ${targets.length} 人。`);
    }, { title: "批量移出人员", description: "仅移出项目人员名单，已有任务和样机记录保留。", okText: "移出", okClass: "btn btn-danger" });
  },

  async bulkUpdateProjectMembersRole(role) {
    const p = this.currentProject();
    if (!p) return;
    const nextRole = this.memberRoleValue(role);
    const ids = [...document.querySelectorAll(".project-member-bulk-check:checked")]
      .map(el => String(el.value || "").trim())
      .filter(Boolean);
    if (!ids.length) { alert("请先勾选需要改分类的人员。"); return; }
    const selected = new Set(ids);
    const snapshot = this.dataSnapshot();
    let changed = 0;
    (p.members || []).forEach(member => {
      if (!selected.has(String(member.id || "")) || member.active === false) return;
      if (this.memberRoleValue(member.role) === nextRole) return;
      member.role = nextRole;
      changed++;
    });
    if (!changed) { Utils.toast("所选人员已在目标分类中。"); return; }
    const saved = await this.commitProjectMutation(p, { action: "bulk_update_project_member_roles", remark: "批量调整人员分类", user: "管理员" });
    if (!saved) { this.restoreDataSnapshot(snapshot); this.render(); return; }
    this.render();
    Utils.toast(`已将 ${changed} 人移到${this.memberRoleLabel(nextRole)}。`);
  },

  toggleStageSortMode() {
    this.setStageSortModeState(!this.stageSortMode());
    this.render();
  },
  onStageDragStart(ev, stageId, card) {
    if (!this.stageSortMode()) {
      ev.preventDefault();
      return;
    }
    this._dragStageId = stageId;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", stageId);
    card.classList.add("dragging");
  },
  onStageDragOver(ev, targetStageId, card) {
    if (!this.stageSortMode() || !this._dragStageId || this._dragStageId === targetStageId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".stage-summary-card.drag-over")
      .forEach(el => { if (el !== card) el.classList.remove("drag-over"); });
    card.classList.add("drag-over");
  },
  onStageDragLeave(ev, card) {
    if (!card.contains(ev.relatedTarget)) card.classList.remove("drag-over");
  },
  onStageDrop(ev, targetStageId, card) {
    ev.preventDefault();
    if (!this.stageSortMode()) return;
    const p = this.currentProject();
    const sourceStageId = this._dragStageId || ev.dataTransfer.getData("text/plain");
    if (!p || !sourceStageId || sourceStageId === targetStageId) return;

    const fromIdx = p.stages.findIndex(st => st.id === sourceStageId);
    const targetIdx = p.stages.findIndex(st => st.id === targetStageId);
    if (fromIdx < 0 || targetIdx < 0) return;

    const dataSnapshot = this.dataSnapshot();
    const rect = card.getBoundingClientRect();
    const insertAfter = ev.clientX > rect.left + rect.width / 2;
    const [moved] = p.stages.splice(fromIdx, 1);
    let insertIdx = targetIdx + (insertAfter ? 1 : 0);
    if (fromIdx < insertIdx) insertIdx -= 1;
    p.stages.splice(insertIdx, 0, moved);
    this._dragStageId = null;
    this.commitStageMutation(p, moved, {
      action: "reorder_stages",
      remark: "阶段排序",
      user: "管理员",
      render: false
    }).then(saved => {
      if (!saved) {
        this.restoreDataSnapshot(dataSnapshot);
        this.render();
      }
    });
    this.render();
  },
  onStageDragEnd() {
    this._dragStageId = null;
    document.querySelectorAll(".stage-summary-card.dragging,.stage-summary-card.drag-over")
      .forEach(el => el.classList.remove("dragging", "drag-over"));
  }

});
