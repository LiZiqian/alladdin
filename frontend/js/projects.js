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

  projectMetaRow(label, value) {
    const row = document.createElement("div");
    row.className = "path";
    row.style.cssText = "display:flex;gap:12px";
    const labelEl = document.createElement("span");
    labelEl.style.cssText = "color:var(--muted);min-width:48px";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.textContent = value || "-";
    row.append(labelEl, valueEl);
    return row;
  },

  projectCard(project) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "position:relative;padding-bottom:28px";
    if (this.isProjectSelected(project.id)) {
      card.style.borderColor = "var(--primary)";
      card.style.borderWidth = "2px";
    }

    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px";

    const title = document.createElement("h3");
    title.style.cssText = "margin:0;flex:1;min-width:0";
    title.append(document.createTextNode(`项目：${project.name || ""}`));

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "sample-card-edit-btn";
    editButton.style.cssText = "vertical-align:baseline;margin-left:4px";
    editButton.dataset.appAction = "project-edit";
    editButton.dataset.id = project.id || "";
    editButton.dataset.stopPropagation = "1";
    editButton.title = "编辑项目";
    editButton.textContent = "✎";
    title.append(editButton);

    const enterButton = document.createElement("button");
    enterButton.type = "button";
    enterButton.className = "btn btn-sm";
    enterButton.style.cssText = "display:inline-flex;align-items:center;gap:3px;line-height:1;flex-shrink:0;white-space:nowrap";
    enterButton.dataset.appAction = "project-select";
    enterButton.dataset.id = project.id || "";
    enterButton.append(document.createTextNode("进入项目"));
    const arrow = document.createElement("b");
    arrow.textContent = "▶";
    enterButton.append(arrow);
    head.append(title, enterButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "sample-card-destroy-btn";
    deleteButton.dataset.appAction = "project-delete";
    deleteButton.dataset.id = project.id || "";
    deleteButton.dataset.stopPropagation = "1";
    deleteButton.title = "删除项目";
    deleteButton.textContent = "🗑";

    card.append(
      head,
      this.projectMetaRow("编号", project.code || "-"),
      this.projectMetaRow("负责人", project.owner || "-"),
      this.projectMetaRow("阶段数", String(project.stageCount ?? (project.stages || []).length)),
      deleteButton
    );
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
    grid.append(this.projectAddCard());
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
