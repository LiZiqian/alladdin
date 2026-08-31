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
      const usedSampleRuns = tasks
        .filter(t => this.taskFlowStatus(t) !== "待下发")
        .reduce((sum, t) => sum + (t.sampleIds || []).length, 0);
      const runningTasks = tasks.filter(t => this.taskFlowStatus(t) === "进行中");
      const runningSampleCount = new Set(runningTasks.flatMap(t => t.sampleIds || [])).size;
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
      <div class="stage-summary-card ${x.stage.id === s?.id ? 'active' : ''} ${sortMode ? 'is-sorting' : ''}" ${cardAttrs}>
        <div class="stage-summary-title">
          <div class="stage-summary-name-row">
            <span>${Utils.esc(x.stage.name)}</span>
            ${sortMode ? '' : `<button type="button" class="btn btn-sm btn-purple stage-config-btn" data-app-action="stage-strategy-open" data-stop-propagation="1" data-id="${Utils.esc(x.stage.id)}" title="配置测试用例集">配置</button>`}
          </div>
        </div>
        <div class="path stage-summary-sku">方案(SKU)：${(x.stage.skuNames || []).map(n => Utils.esc(n)).join(" / ") || "-"}</div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width:${pct}%;background:${x.passRate > 80 ? 'var(--pass)' : x.passRate > 50 ? 'var(--warn)' : 'var(--primary)'}"></div>
        </div>
        <div class="stage-summary-metrics">
          <div class="stage-metric-card">
            <b>测试项</b>
            <span>计划执行<em>${x.total} 项</em></span>
            <span>已执行<em>${x.executedTasks} 项</em></span>
            <span>进行中<em>${x.runningTasks} 项</em></span>
          </div>
          <div class="stage-metric-card">
            <b>样机数</b>
            <span>计划使用<em>${x.plannedSampleCount} 台</em></span>
            <span>已使用<em>${x.usedSampleRuns} 台次</em></span>
          </div>
          <div class="stage-metric-card">
            <b>进行中</b>
            <span>任务<em>${x.runningTasks} 项</em></span>
            <span>占用样机<em>${x.runningSampleCount} 台</em></span>
          </div>
        </div>
        <div class="stage-summary-actions stage-summary-footer-actions">
          ${sortMode
            ? '<span class="stage-sort-hint">拖动排序</span>'
            : `<button type="button" class="sample-card-destroy-btn stage-summary-delete-btn" data-app-action="stage-delete" data-stop-propagation="1" data-id="${Utils.esc(x.stage.id)}" title="删除此阶段" aria-label="删除此阶段">🗑</button>
              <button type="button" class="stage-copy-btn" title="复制为一个新阶段" aria-label="复制为一个新阶段" data-app-action="stage-copy" data-stop-propagation="1" data-id="${Utils.esc(x.stage.id)}">🗐</button>`}
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

  projectConfigHelpHtml(text) {
    const help = String(text || "").trim();
    return `<button type="button" class="project-config-help" tabindex="0" aria-label="说明：${Utils.esc(help)}" data-tooltip="${Utils.esc(help)}" data-stop-propagation="1">?</button>`;
  },

  projectWorkspacePageNodes(project, stage, { stageCards, addStageCard, sampleOwnerCounts, sampleBorrowerCounts, sortMode }) {
    const nodes = [];
    const configCard = document.createElement("div");
    configCard.className = "card project-config-card";

    const intro = document.createElement("div");
    intro.className = "project-config-intro";
    const title = document.createElement("h2");
    title.textContent = "项目配置工作台";
    const desc = document.createElement("p");
    desc.textContent = "项目需首先完成人员配置、位置配置与阶段方案配置。";
    intro.append(title, desc);
    configCard.append(intro);

    this.appendWorkspaceHtml(configCard, this.workspaceMembersHtml(project, { sampleOwnerCounts, sampleBorrowerCounts }));
    this.appendWorkspaceHtml(configCard, this.workspaceLocationsHtml(project));
    this.appendWorkspaceHtml(configCard, this.workspaceDefaultSampleCategoryHtml(project));
    configCard.append(this.projectStageConfigSectionNode(stageCards, addStageCard, sortMode));
    nodes.push(configCard);

    if (stage) {
      const taskFlow = document.createElement("div");
      taskFlow.className = `card workspace-section section-green ${this.isCollapsed("taskFlow") ? "is-collapsed" : ""}`.trim();
      this.appendWorkspaceHtml(taskFlow, this.workspaceTaskFlowHtml(project, stage));
      nodes.push(taskFlow);
    }
    return nodes;
  },

  projectStageConfigSectionNode(stageCards, addStageCard, sortMode) {
    const section = document.createElement("div");
    section.className = `project-config-section project-stage-section ${this.isCollapsed("stage") ? "is-collapsed" : ""}`.trim();

    const head = document.createElement("div");
    head.className = "stage-summary-section-head";
    this.appendWorkspaceHtml(head, this.sectionToggleTriangle("stage"));
    const title = document.createElement("div");
    title.className = "stage-summary-section-title";
    title.textContent = "项目阶段与方案配置";
    this.appendWorkspaceHtml(title, this.projectConfigHelpHtml("为每个阶段维护方案（SKU）和测试用例集；配置完成后，可在下方任务管理工作台中下发测试任务。"));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `btn btn-sm ${sortMode ? "stage-sort-done" : "btn-outline"} stage-sort-toggle stage-sort-toggle-right`;
    toggle.dataset.appAction = "stage-sort-toggle";
    toggle.textContent = sortMode ? "完成排序" : "手动拖动排序";
    head.append(title, toggle);
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
    const collapsed = this.isCollapsed('members');
    const activeMembers = this.projectActiveMembers(project);
    const memberUiState = this.projectMemberUiState();
    const memberSearch = String(memberUiState.memberSearch || "");
    const memberKw = memberSearch.trim().toLowerCase();
    const detailRoleValue = String(memberUiState.memberDetailRole || "");
    const detailRole = this.memberRoleList().includes(detailRoleValue) ? detailRoleValue : "";
    const roleData = this.memberRoleList().map(role => {
      const members = activeMembers.filter(m => this.memberRoleValue(m.role) === role);
      const rows = members.map(m => {
        const hidden = !this.projectMemberMatchesSearch(m, role, memberKw);
        return this.projectMemberRowHtml(project, m, counts, { hidden });
      }).join("");
      const totals = members.reduce((acc, member) => {
        const stat = this.memberSampleStats(member, counts);
        acc.ownedSamples += stat.ownedSamples;
        acc.borrowedSamples += stat.borrowedSamples;
        return acc;
      }, { ownedSamples: 0, borrowedSamples: 0 });
      const visibleCount = members.filter(m => this.projectMemberMatchesSearch(m, role, memberKw)).length;
      return { role, members, rows, totals, visibleCount, activeDetail: role === detailRole };
    });
    const detailItem = roleData.find(item => item.activeDetail);
    const visibleTotal = detailItem ? detailItem.visibleCount : 0;
    const summaryCards = roleData.map(item => `
      <div class="project-member-summary-card role-${Utils.esc(item.role)} ${item.activeDetail ? 'is-detail-open' : ''}" data-member-role="${Utils.esc(item.role)}">
        <div class="project-member-summary-main">
          <b>${Utils.esc(this.memberRoleLabel(item.role))}</b>
          <span><em class="project-member-summary-visible">${item.visibleCount}</em> / ${item.members.length} 人</span>
        </div>
        <div class="project-member-summary-metrics">
          <span><b>${item.totals.ownedSamples}</b> 挂账</span>
          <span><b>${item.totals.borrowedSamples}</b> 持有</span>
        </div>
        <div class="project-member-summary-actions">
          <button class="btn btn-sm btn-outline" data-app-action="project-member-add" data-value="${Utils.esc(item.role)}">新增</button>
          <button class="btn btn-sm btn-outline" data-app-action="project-members-role-toggle" data-value="${Utils.esc(item.role)}">${item.activeDetail ? '收起详情' : '查看详情'}</button>
        </div>
      </div>
    `).join("");
    const bulkDisabled = "disabled aria-disabled=\"true\"";
    const detailPanel = detailItem ? `
          <div class="project-members-detail-panel" data-member-role="${Utils.esc(detailItem.role)}">
            <div class="project-members-toolbar">
              <label class="project-members-search">
                <span>搜索人员</span>
                <input type="search" value="${Utils.esc(memberSearch)}" placeholder="姓名 / 工号 / 类型" data-app-action="project-member-search" data-app-events="input">
              </label>
              <span class="project-members-search-count">显示 ${visibleTotal} / ${detailItem.members.length} 人</span>
              <div class="project-members-bulk-actions">
                <span class="project-members-selected-count">已选 0 人</span>
                <button class="btn btn-sm btn-outline" data-app-action="project-members-bulk-role" data-value="tester" ${bulkDisabled}>移到测试</button>
                <button class="btn btn-sm btn-outline" data-app-action="project-members-bulk-role" data-value="developer" ${bulkDisabled}>移到开发</button>
                <button class="btn btn-sm btn-outline" data-app-action="project-members-bulk-role" data-value="other" ${bulkDisabled}>移到其他</button>
                <button class="btn btn-sm btn-outline" data-app-action="project-members-clear-selection" ${bulkDisabled}>清空选择</button>
              </div>
            </div>
            <section class="project-member-role-group project-member-role-detail" data-member-role="${Utils.esc(detailItem.role)}">
              <div class="project-member-role-head">
                <div class="project-member-role-title">
                  <b>${Utils.esc(this.memberRoleLabel(detailItem.role))}名单</b>
                  <span class="project-member-role-count">显示 <em class="project-member-role-visible">${detailItem.visibleCount}</em> / ${detailItem.members.length} 人</span>
                </div>
                <button class="btn btn-sm btn-outline" data-app-action="project-member-add" data-value="${Utils.esc(detailItem.role)}">新增</button>
              </div>
              <div class="project-member-table-shell">
                <div class="project-member-table-head" aria-hidden="true">
                  <span></span>
                  <span>人员</span>
                  <span>挂账</span>
                  <span>持有</span>
                  <span>操作</span>
                </div>
                <div class="project-member-table-body">
                  ${detailItem.rows}
                  <div class="project-member-empty ${detailItem.visibleCount ? 'is-hidden' : ''}">${detailItem.members.length ? '无匹配人员' : `暂无${Utils.esc(this.memberRoleLabel(detailItem.role))}`}</div>
                </div>
              </div>
            </section>
          </div>` : '';

    return `
      <div class="project-config-section project-members-section ${collapsed ? 'is-collapsed' : ''}">
        <div class="stage-summary-section-head">
          ${this.sectionToggleTriangle('members')}
          <div class="stage-summary-section-title">
            人员配置
            ${this.projectConfigHelpHtml("测试人员用于任务下发与操作留痕；开发人员用于样机领用记录；样机挂账人可从全部已配置人员中选择。")}
            <span class="project-config-section-count">${activeMembers.length} 人</span>
          </div>
          <div class="project-members-head-actions">
            <button class="btn btn-sm btn-outline" data-app-action="project-members-template">下载导入模板</button>
            <button class="btn btn-sm" data-app-action="project-members-import">批量导入人员名单</button>
          </div>
        </div>
        <div class="project-members-body">
          <div class="project-member-summary-grid">${summaryCards}</div>
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
      <div class="project-member-row project-member-card ${options.hidden ? 'is-search-hidden' : ''}" data-member-role="${Utils.esc(role)}" data-member-key="${Utils.esc(searchKey)}" data-app-action="project-member-edit" data-app-events="dblclick" data-id="${Utils.esc(member.id)}" tabindex="0" title="双击编辑人员" aria-label="双击编辑人员 ${Utils.esc(identity || "-")}">
        <label class="project-member-check" title="选择用于批量改分类" data-stop-propagation="1">
          <input type="checkbox" class="project-member-bulk-check" value="${Utils.esc(member.id)}" data-app-action="project-member-selection" data-app-events="change">
        </label>
        <div class="project-member-identity">
          <b>${Utils.esc(member.name || "-")}</b>
          <span>${Utils.esc(member.employeeNo || "-")}</span>
        </div>
        <div class="project-member-stat"><b>${stat.ownedSamples}</b><span>挂账</span></div>
        <div class="project-member-stat"><b>${stat.borrowedSamples}</b><span>持有</span></div>
        <div class="project-member-row-actions">
          <button type="button" class="btn btn-sm btn-outline" data-app-action="project-member-edit" data-stop-propagation="1" data-id="${Utils.esc(member.id)}">编辑</button>
          <button type="button" class="project-member-remove" data-app-action="project-member-remove" data-stop-propagation="1" data-id="${Utils.esc(member.id)}" title="移出人员">🗑</button>
        </div>
      </div>`;
  },

  projectMemberCardHtml(project, member, counts = {}) {
    return this.projectMemberRowHtml(project, member, counts);
  },

  workspaceLocationsHtml(project) {
    if (!Array.isArray(project.locations)) project.locations = [];
    const collapsed = this.isCollapsed('locations');
    const locations = project.locations.filter(Boolean);
    const cards = locations.map((loc, idx) => `
      <div class="project-location-card" data-app-action="project-location-edit" data-app-events="dblclick" data-value="${idx}" tabindex="0" title="双击编辑位置" aria-label="双击编辑位置 ${Utils.esc(loc)}">
        <b>${Utils.esc(loc)}</b>
        <span class="project-location-remove" data-app-action="project-location-remove" data-stop-propagation="1" data-value="${idx}" title="删除位置">🗑</span>
      </div>`).join("");
    return `
      <div class="project-config-section project-locations-section ${collapsed ? 'is-collapsed' : ''}">
        <div class="stage-summary-section-head">
          ${this.sectionToggleTriangle('locations')}
          <div class="stage-summary-section-title">
            位置配置
            ${this.projectConfigHelpHtml("维护项目可用的样机存放位置，后续可在样机档案中直接选择并记录实际存放地点。")}
            <span class="project-config-section-count">${locations.length} 个位置</span>
          </div>
        </div>
        <div class="project-locations-body">
          <div class="project-locations-grid">
            ${cards || ''}
            <div class="card add-card" data-app-action="project-location-add">
              <div class="add-card-plus">+</div>
              <div class="add-card-label">新增位置</div>
            </div>
          </div>
        </div>
      </div>`;
  },

  canConfigureProjectDefaultSampleCategory(category) {
    if (!category) return false;
    if (typeof this.isLocalAdminAccess !== "function") return true;
    if (this.isLocalAdminAccess()) return true;
    const role = typeof this.samplePoolAccessRole === "function"
      ? this.samplePoolAccessRole(category)
      : String(category.accessRole || "");
    return role === "pool_admin";
  },

  workspaceDefaultSampleCategoryHtml(project) {
    const collapsed = this.isCollapsed("sampleCategoryConfig");
    const categories = this.sampleCategoryRecords();
    const selectedId = this.projectDefaultSampleCategoryId(project);
    const options = [
      `<option value="" ${selectedId ? "" : "selected"}>不设置（默认全部样机池）</option>`,
      ...categories.map(category => {
        const id = String(category.id || "");
        const selected = id === selectedId ? "selected" : "";
        const canConfigure = this.canConfigureProjectDefaultSampleCategory(category);
        const disabled = canConfigure ? "" : "disabled";
        const count = Number(category.sampleCount ?? (category.samples || []).length) || 0;
        const suffix = count ? ` (${count})` : "";
        const permissionSuffix = canConfigure ? "" : " · 需要池管理员权限";
        return `<option value="${Utils.esc(id)}" ${selected} ${disabled}>${Utils.esc(category.name || id)}${suffix}${permissionSuffix}</option>`;
      })
    ].join("");
    return `
      <div class="project-config-section project-default-sample-section ${collapsed ? 'is-collapsed' : ''}">
        <div class="stage-summary-section-head">
          ${this.sectionToggleTriangle('sampleCategoryConfig')}
          <div class="stage-summary-section-title">
            样机池配置
            ${this.projectConfigHelpHtml("设置任务配置和临时变更时优先显示的默认样机池。远程项目管理员只能选择同时拥有池管理员权限的样机池。")}
          </div>
        </div>
        <div class="project-default-sample-body project-config-body">
          <label class="project-default-sample-label" for="projectDefaultSampleCategory">默认样机池</label>
          <select id="projectDefaultSampleCategory" class="project-default-sample-select" data-app-action="project-default-sample-category" data-app-events="change">${options}</select>
        </div>
      </div>`;
  },

  async setProjectDefaultSampleCategory(categoryId) {
    const p = this.currentProject();
    if (!p) return;
    const nextId = String(categoryId || "").trim();
    const nextCategory = nextId ? this.findSampleCategoryRecord(nextId) : null;
    if (nextId && !nextCategory) {
      alert("所选样机池不存在或已被删除。");
      this.render();
      return;
    }
    if (nextCategory && !this.canConfigureProjectDefaultSampleCategory(nextCategory)) {
      alert("只有同时拥有该样机池池管理员权限，才能将它设为项目默认样机池。");
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
    this.showModal("编辑项目位置", `
      <div class="form-group"><label class="req modal-field-title">位置名称</label><input id="projectLocationName" value="${Utils.esc(currentName)}" placeholder="如：溪村-D8-B1F-A08 / 武汉-A3-1F-03R"></div>
    `, async () => {
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
      row.classList.toggle("is-search-hidden", !!kw && !row.dataset.memberKey.includes(kw));
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
      const countEl = group.querySelector(".project-member-role-visible");
      if (countEl) countEl.textContent = String(visibleCount);
      const emptyEl = group.querySelector(".project-member-empty");
      if (emptyEl) {
        emptyEl.textContent = roleRows.length ? "无匹配人员" : `暂无${this.memberRoleLabel(role)}`;
        emptyEl.classList.toggle("is-hidden", visibleCount > 0);
      }
      const summaryEl = document.querySelector(`.project-member-summary-card[data-member-role="${role}"] .project-member-summary-visible`);
      if (summaryEl) summaryEl.textContent = String(visibleCount);
    });
    const searchCount = document.querySelector(".project-members-search-count");
    if (searchCount) searchCount.textContent = `显示 ${visibleRows.length} / ${rows.length} 人`;
    this.updateProjectMemberSelectionCount();
  },
  updateProjectMemberSelectionCount() {
    const selectedCount = document.querySelectorAll(".project-member-bulk-check:checked").length;
    this.patchViewState({ memberSelectedCount: selectedCount });
    const countEl = document.querySelector(".project-members-selected-count");
    if (countEl) countEl.textContent = `已选 ${selectedCount} 人`;
    document.querySelectorAll('.project-members-bulk-actions [data-app-action="project-members-bulk-role"], .project-members-bulk-actions [data-app-action="project-members-clear-selection"]').forEach(button => {
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
    const nextRole = this.projectMemberUiState().memberDetailRole === value ? "" : value;
    this.patchViewState({ memberDetailRole: nextRole, memberSearch: "" });
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
    this.showModal("编辑项目人员", `
      <div class="form-group"><label class="req modal-field-title">人员</label><input id="memberText" value="${Utils.esc(currentIdentity)}" placeholder="姓名/工号，如：张三/00609513"></div>
      <div class="form-group"><label class="req modal-field-title">人员类型</label>${this.projectMemberRoleSelectHtml(m.role)}</div>
      <div class="form-hint">人员必须按「姓名/工号」填写，姓名和工号都不能为空。</div>
    `, async () => {
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
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.addEventListener("change", () => {
      const file = input.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.addEventListener("load", async () => {
        const result = Utils.parseProjectMembersCsv(reader.result);
        if (result.error) { alert("人员名单导入失败：" + result.error); return; }
        const p = this.currentProject();
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
    this.showConfirm(`确认将 ${Utils.personText(m.name, m.employeeNo)} 移出项目人员名单？`, async () => {
      const snapshot = this.dataSnapshot();
      m.active = false;
      const saved = await this.commitProjectMutation(p, { action: "remove_project_member", remark: "移出项目人员", user: "管理员" });
      if (!saved) { this.restoreDataSnapshot(snapshot); return; }
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
  onStageDragStart(ev, stageId) {
    if (!this.stageSortMode()) {
      ev.preventDefault();
      return;
    }
    this._dragStageId = stageId;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", stageId);
    ev.currentTarget.classList.add("dragging");
  },
  onStageDragOver(ev, targetStageId) {
    if (!this.stageSortMode() || !this._dragStageId || this._dragStageId === targetStageId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".stage-summary-card.drag-over")
      .forEach(el => { if (el !== ev.currentTarget) el.classList.remove("drag-over"); });
    ev.currentTarget.classList.add("drag-over");
  },
  onStageDragLeave(ev) {
    ev.currentTarget.classList.remove("drag-over");
  },
  onStageDrop(ev, targetStageId) {
    ev.preventDefault();
    const p = this.currentProject();
    const sourceStageId = this._dragStageId || ev.dataTransfer.getData("text/plain");
    if (!p || !sourceStageId || sourceStageId === targetStageId) return;

    const fromIdx = p.stages.findIndex(st => st.id === sourceStageId);
    const targetIdx = p.stages.findIndex(st => st.id === targetStageId);
    if (fromIdx < 0 || targetIdx < 0) return;

    const dataSnapshot = this.dataSnapshot();
    const rect = ev.currentTarget.getBoundingClientRect();
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
