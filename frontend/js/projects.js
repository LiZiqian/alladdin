/* ========================================
   数字治理平台 V7 - 项目管理模块
   ======================================== */

app.registerModule("projects", {

  renderProjectLoading(project) {
    const name = project?.name || "项目";
    const content = document.getElementById("content");
    if (!content) return;
    const card = document.createElement("div");
    card.className = "card empty";
    const title = document.createElement("b");
    title.textContent = `正在加载 ${name}...`;
    const hint = document.createElement("span");
    hint.className = "path";
    hint.textContent = "阶段、人员和任务分页数据正在按需读取。";
    card.append(title, hint);
    content.replaceChildren(card);
  },

  projectCard(project) {
    const canOpen = this.resourceCanOpen ? this.resourceCanOpen(project) : project.canOpen !== false;
    const canManage = this.resourceCanManage ? this.resourceCanManage(project) : project.canManage !== false;
    const localAdmin = this.isLocalAdminAccess ? this.isLocalAdminAccess() : true;
    const card = document.createElement("div");
    card.className = `card project-entry-card access-resource-card${canOpen ? "" : " access-resource-locked"}`;
    if (!canOpen) {
      card.dataset.appAction = "access-denied";
      card.dataset.resourceType = "project";
      card.dataset.id = project.id || "";
      card.title = "当前 IP 未获授权，点击查看说明";
    }
    if (this.isProjectSelected(project.id)) {
      card.style.borderColor = "var(--primary)";
      card.style.borderWidth = "2px";
    }

    const head = document.createElement("div");
    head.className = "project-card-heading";

    const identity = document.createElement("div");
    identity.className = "project-card-identity";

    const title = document.createElement("h3");
    title.className = "project-card-title";
    title.textContent = project.name || "未命名项目";

    const meta = document.createElement("div");
    meta.className = "project-card-meta";
    if (canOpen) {
      const code = document.createElement("span");
      code.textContent = `编号：${project.code || "-"}`;
      const owner = document.createElement("span");
      owner.textContent = `负责人：${project.owner || "-"}`;
      meta.append(code, owner);
    } else {
      meta.className += " project-card-meta-locked";
      meta.textContent = "详细信息需授权";
    }
    identity.append(title, meta);

    const editControls = document.createElement("span");
    editControls.className = "project-card-edit-controls";
    if (canManage) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "sample-card-edit-btn";
      editButton.dataset.appAction = "project-edit";
      editButton.dataset.id = project.id || "";
      editButton.dataset.stopPropagation = "1";
      editButton.title = "编辑项目";
      editButton.ariaLabel = "编辑项目";
      editButton.textContent = "✎";
      editControls.append(editButton);
    }
    head.append(identity, editControls);

    const enterRow = document.createElement("div");
    enterRow.className = "project-card-enter-row";

    const enterButton = document.createElement("button");
    enterButton.type = "button";
    enterButton.className = "btn project-card-enter-btn";
    enterButton.dataset.appAction = canOpen ? "project-select" : "access-denied";
    enterButton.dataset.resourceType = "project";
    enterButton.dataset.id = project.id || "";
    enterButton.append(document.createTextNode(canOpen ? "进入项目" : "未授权"));
    const arrow = document.createElement("b");
    arrow.textContent = canOpen ? "▶" : "🔒";
    enterButton.append(arrow);
    enterRow.append(enterButton);

    const footer = document.createElement("div");
    footer.className = "project-card-footer";

    const roleBadge = document.createElement("span");
    roleBadge.className = `access-role-badge role-${project.accessRole || (localAdmin ? "local_admin" : "none")}`;
    roleBadge.textContent = this.accessRoleLabel ? this.accessRoleLabel(project.accessRole || (localAdmin ? "local_admin" : "none")) : (canOpen ? "可访问" : "未授权");

    const controls = document.createElement("span");
    controls.className = "access-card-controls project-card-footer-controls";
    if (canManage) {
      const aclButton = document.createElement("button");
      aclButton.type = "button";
      aclButton.className = "access-card-acl-btn";
      aclButton.dataset.appAction = "access-rules-open";
      aclButton.dataset.resourceType = "project";
      aclButton.dataset.id = project.id || "";
      aclButton.dataset.stopPropagation = "1";
      aclButton.title = "管理项目 IP 访问名单";
      aclButton.ariaLabel = "管理项目 IP 访问名单";
      aclButton.textContent = "🛡️";
      controls.append(aclButton);

      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "access-card-export-btn";
      exportButton.dataset.appAction = "project-export-scope";
      exportButton.dataset.id = project.id || "";
      exportButton.dataset.stopPropagation = "1";
      exportButton.title = "导出此项目范围数据包";
      exportButton.ariaLabel = "导出此项目范围数据包";
      exportButton.textContent = "⇩";
      controls.append(exportButton);
    }
    if (localAdmin) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "sample-card-destroy-btn";
      deleteButton.dataset.appAction = "project-delete";
      deleteButton.dataset.id = project.id || "";
      deleteButton.dataset.stopPropagation = "1";
      deleteButton.title = "删除项目";
      deleteButton.ariaLabel = "删除项目";
      deleteButton.textContent = "🗑";
      controls.append(deleteButton);
    }
    footer.append(roleBadge, controls);
    card.append(head, enterRow, footer);
    return card;
  },

  projectAddCard() {
    const card = document.createElement("div");
    card.className = "card add-card";
    card.dataset.appAction = "project-add";
    const plus = document.createElement("div");
    plus.className = "add-card-plus";
    plus.textContent = "+";
    const label = document.createElement("div");
    label.className = "add-card-label";
    label.textContent = "新建项目";
    card.append(plus, label);
    return card;
  },

  renderProjects() {
    const content = document.getElementById("content");
    const projects = this.projectRecords();
    if (!content) return;
    const grid = document.createElement("div");
    grid.className = "grid project-grid";
    projects.forEach(project => grid.append(this.projectCard(project)));
    if (this.isLocalAdminAccess ? this.isLocalAdminAccess() : true) grid.append(this.projectAddCard());
    content.replaceChildren(grid);
  },

  projectNameExists(name, excludeId = "") {
    return this.projectStateNameExists(name, excludeId);
  },

  addProject() {
    this.showModal("新建项目", `
      <div style="display:flex;flex-direction:column;gap:20px">
        <div class="form-row" style="gap:16px">
          <div class="form-group" style="margin-bottom:0"><label>项目名称</label><input id="pName" placeholder="请输入项目名称"></div>
          <div class="form-group" style="margin-bottom:0"><label>项目编号</label><input id="pCode" placeholder="请输入项目编号"></div>
        </div>
        <div class="form-group" style="margin-bottom:0"><label>负责人</label><input id="pOwner" placeholder="姓名/工号"></div>
      </div>
    `, async () => {
      this.clearFieldValidationMarks();
      const nameEl = document.getElementById("pName");
      const name = nameEl.value.trim();
      if (!name) { this.markFieldInvalid(nameEl, "项目名称不能为空"); return true; }
      if (this.projectNameExists(name)) { this.markFieldInvalid(nameEl, `项目名称"${name}"已存在，不能重复创建。`); return true; }
      const ownerEl = document.getElementById("pOwner");
      const ownerRaw = ownerEl.value.trim();
      let ownerText = "";
      let ownerParsed = null;
      if (ownerRaw) {
        ownerParsed = Utils.parsePersonField(ownerRaw);
        if (!ownerParsed.ok) { this.markFieldInvalid(ownerEl, ownerParsed.msg); return true; }
        ownerText = Utils.personText(ownerParsed.name, ownerParsed.employeeNo);
      }
      const p = {
        id: Utils.id("proj_"), name,
        code: document.getElementById("pCode").value.trim(),
        owner: ownerText,
        createdAt: Utils.now(), stages: [], members: []
      };
      // 项目负责人自动加入人员配置
      if (ownerParsed && ownerParsed.ok) {
        p.members.push({ id: Utils.id("member_"), name: ownerParsed.name, employeeNo: ownerParsed.employeeNo, role: "other", active: true });
      }
      this.appendProjectRecord(p);
      this.selectProjectState(p.id, { selectedStageId: null });
      const saved = await this.commitProjectMutation(p, {
        action: "create_project",
        remark: "新建项目",
        user: ownerText || "管理员",
        createIfMissing: true
      });
      if (!saved) {
        this.removeProjectRecord(p.id);
        this.selectFirstProjectState();
        return true;
      }
      Utils.toast("项目已新建");
      return false;
    }, "确认", { className: "modal-sm" });
  },

  editProject(id) {
    const p = this.findProjectRecord(id);
    if (!p) return;
    this.showModal("编辑项目", `
      <div class="form-group"><label>项目名称</label><input id="pName" value="${Utils.esc(p.name)}"></div>
      <div class="form-group"><label>项目编号</label><input id="pCode" value="${Utils.esc(p.code || "")}"></div>
      <div class="form-group"><label>负责人</label><input id="pOwner" value="${Utils.esc(p.owner || "")}"></div>
    `, async () => {
      this.clearFieldValidationMarks();
      const snapshot = this.dataSnapshot();
      const nameEl = document.getElementById("pName");
      const name = nameEl.value.trim();
      if (!name) { this.markFieldInvalid(nameEl, "项目名称不能为空"); return true; }
      if (this.projectNameExists(name, p.id)) { this.markFieldInvalid(nameEl, `项目名称"${name}"已存在，不能重复命名。`); return true; }
      const ownerEl = document.getElementById("pOwner");
      const ownerRaw = ownerEl.value.trim();
      let ownerText = "";
      let ownerParsed = null;
      if (ownerRaw) {
        ownerParsed = Utils.parsePersonField(ownerRaw);
        if (!ownerParsed.ok) { this.markFieldInvalid(ownerEl, ownerParsed.msg); return true; }
        ownerText = Utils.personText(ownerParsed.name, ownerParsed.employeeNo);
      }
      p.name = name;
      p.code = document.getElementById("pCode").value.trim();
      p.owner = ownerText;
      // 项目负责人自动加入人员配置（如尚未在名单中）
      if (ownerParsed && ownerParsed.ok) {
        if (!Array.isArray(p.members)) p.members = [];
        const key = Utils.memberIdentityKey(ownerParsed.name, ownerParsed.employeeNo);
        if (!p.members.some(m => Utils.memberIdentityKey(m.name, m.employeeNo) === key)) {
          p.members.push({ id: Utils.id("member_"), name: ownerParsed.name, employeeNo: ownerParsed.employeeNo, role: "other", active: true });
        }
      }
      const saved = await this.commitProjectMutation(p, {
        action: "update_project",
        remark: "编辑项目",
        user: ownerText || "管理员"
      });
      if (!saved) {
        this.restoreDataSnapshot(snapshot);
        return true;
      }
      Utils.toast("项目已保存");
      return false;
    }, "确认", { className: "modal-sm" });
  },

  collectProjectDeleteImpact(project) {
    const stages = project?.stages || [];
    const allTasks = stages.flatMap(st => (st.tasks || []).filter(t => t && !t.archived));
    const completedTasks = allTasks.filter(t => this.isTaskCompleted(t));
    const activeTasks = allTasks.filter(t => !this.isTaskCompleted(t));
    const runningOrBlocked = activeTasks.filter(t => ["进行中", "阻塞中"].includes(this.taskFlowStatus(t)));
    const pending = activeTasks.filter(t => !["进行中", "阻塞中"].includes(this.taskFlowStatus(t)));

    // 收集该项目所有任务中涉及的样机ID（去重）
    const sampleIds = new Set();
    allTasks.forEach(t => (t.sampleIds || []).forEach(sid => sampleIds.add(sid)));

    // 按样机状态分组
    const sampleStatusCounts = {};
    sampleIds.forEach(sid => {
      const found = this.findSample(sid);
      if (!found) return;
      const status = this.sampleEffectiveStatus(found.sample);
      sampleStatusCounts[status] = (sampleStatusCounts[status] || 0) + 1;
    });

    return {
      projectName: project.name,
      stageCount: stages.length,
      taskCount: allTasks.length,
      runningOrBlockedCount: runningOrBlocked.length,
      pendingCount: pending.length,
      completedCount: completedTasks.length,
      sampleCount: sampleIds.size,
      sampleStatusCounts
    };
  },

  projectDeleteImpactHtml(impact) {
    const statusLabels = {
      "测试中": "测试中",
      "在位等待": "在位等待",
      "闲置": "闲置",
      "已退库": "已退库",
      "取走分析": "取走分析"
    };
    const statusLines = Object.entries(impact.sampleStatusCounts)
      .filter(([status, count]) => count > 0)
      .map(([status, count]) => {
        if (status === "测试中" || status === "在位等待") {
          return `<li><b>${Utils.esc(statusLabels[status] || status)}：</b>${count} 台，删除项目后将释放样机，任务异常终止。</li>`;
        }
        return `<li><b>${Utils.esc(statusLabels[status] || status)}：</b>${count} 台，不受项目删除影响。</li>`;
      })
      .join("");

    return `<div class="destroy-impact">
      <div class="destroy-impact-title">⚠️ 删除影响确认</div>
      <ul>
        <li><b>项目：</b>「${Utils.esc(impact.projectName)}」将被永久删除。</li>
        <li><b>阶段数：</b>${impact.stageCount} 个阶段，${impact.taskCount} 个任务全部删除。</li>
        ${impact.sampleCount > 0 ? `<li><b>关联样机：</b>共 ${impact.sampleCount} 台样机与此项目有关联。</li>` : ""}
      </ul>
      ${impact.sampleCount > 0 ? `<div class="destroy-impact-subtitle">样机影响明细</div><ul>${statusLines}</ul>` : ""}
      <div class="destroy-impact-subtitle">任务影响</div>
      <ul>
        <li><b>进行中/阻塞中任务：</b>${impact.runningOrBlockedCount} 个任务将被异常终止，样机释放。</li>
        <li><b>未启动/待下发任务：</b>${impact.pendingCount} 个任务将被删除。</li>
        <li><b>已完成任务：</b>${impact.completedCount} 个已完成任务不受影响，测试履历保留。</li>
      </ul>
      <p style="margin-top:12px;color:var(--muted);font-size:13px">
        ※ 样机库中的样机不会被删除，只会释放任务占用关系。<br>
        ※ 已完成任务的样机测试记录会保留在样机履历中。
      </p>
      <p style="color:var(--danger);font-weight:600">此操作不可撤销！</p>
    </div>`;
  },

  async deleteProject(id) {
    let p = this.findProjectRecord(id);
    if (!p) return;
    p = await this.ensureProjectLoaded(id, { includeTasks: true, render: false }) || p;
    let html;
    try {
      const impact = this.collectProjectDeleteImpact(p);
      html = this.projectDeleteImpactHtml(impact);
    } catch (e) {
      console.error("收集项目删除影响数据失败：", e);
      // 降级：使用基本信息构造简单说明
      const basicImpact = {
        projectName: p.name,
        stageCount: (p.stages || []).length,
        taskCount: (p.stages || []).reduce((sum, st) => sum + (st.tasks || []).filter(t => t && !t.archived).length, 0),
        runningOrBlockedCount: 0,
        pendingCount: 0,
        completedCount: 0,
        sampleCount: 0,
        sampleStatusCounts: {}
      };
      html = this.projectDeleteImpactHtml(basicImpact);
    }
    this.showDangerConfirm(
      html,
      async () => {
        const snapshot = this.dataSnapshot();
        const projectTaskIds = (p.stages || []).flatMap(st => (st.tasks || []).map(t => t.id).filter(Boolean));
        const affectedSampleIds = new Set();
        (p.stages || []).forEach(st => (st.tasks || []).forEach(t => {
          if (!t || t.archived || this.isTaskCompleted(t)) return;
          (t.sampleIds || []).forEach(id => affectedSampleIds.add(String(id || "")));
        }));
        (p.stages || []).forEach(st => (st.tasks || []).forEach(t => {
          if (!t || t.archived || this.isTaskCompleted(t)) return;
          this.releaseTaskSamples(t, {
            user: "管理员",
            source: "项目删除",
            reason: "项目被删除，释放未完成任务占用样机",
            projectId: p.id,
            stageId: st.id,
            forceLog: true
          }, projectTaskIds);
        }));
        const affectedSamples = [...affectedSampleIds]
          .map(sampleId => this.findSample(sampleId)?.sample)
          .filter(Boolean);
        const sampleEvents = this.sampleEventRecords().filter(log => affectedSampleIds.has(String(log?.sampleId || "")));
        this.removeProjectRecord(id);
        this.selectFirstProjectState();
        const saved = await this.commitProjectMutation(p, {
          action: "delete_project",
          remark: "删除项目",
          user: "管理员",
          deleteProject: true,
          samples: affectedSamples,
          sampleEvents,
          render: false
        });
        if (!saved) {
          this.restoreDataSnapshot(snapshot);
          return true;
        }
        this.render();
        Utils.toast("项目已删除，关联样机占用已释放。");
        return false;
      },
      {
        title: `删除项目「${Utils.esc(p.name)}」`,
        okText: "删除",
        okClass: "btn btn-danger",
        confirmCode: "DELETE"
      }
    );
  },

  async selectProject(id) {
    const requested = this.findProjectRecord(id);
    if (requested && this.resourceCanOpen && !this.resourceCanOpen(requested)) {
      this.showResourceAccessDenied?.("project", id);
      return;
    }
    const selectionSequence = ++this._projectSelectionSequence;
    this.selectProjectWorkspaceState(id, { selectedStageId: null });
    const current = this.findProjectRecord(id);
    if (current?._detailLoaded) {
      this.selectProjectWorkspaceState(id, { selectedStageId: this.projectInitialStageId(current) });
      this.render();
    } else {
      this.renderNav();
      this.renderHeader();
      this.renderProjectLoading(current);
    }
    const p = await this.ensureProjectLoaded(id, { includeTasks: false, render: false });
    // 详情请求可能晚于下一次项目/样机池导航返回；过期响应只进入缓存，不得改写当前页面。
    if (selectionSequence !== this._projectSelectionSequence || !this.isProjectNavActive(id)) return;
    if (!p) {
      this.patchViewState({ module: "projects" });
      this.render();
      return;
    }
    this.selectProjectWorkspaceState(id, { selectedStageId: this.projectInitialStageId(p) });
    this.render();
  }
});
