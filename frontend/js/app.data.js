/* ========================================
   数字治理平台 V7 - 数据工具模块
   ======================================== */

app.registerModule("app.data", {

  emptyData() {
    return {
      version: this.version,
      currentProjectId: null,
      currentStageId: null,
      eventSchema: "sample_events_v2",
      users: [],
      projects: [],
      sampleLibrary: { categories: [], logs: [] }
    };
  },

  cloneData(data) {
    return JSON.parse(JSON.stringify(data || this.emptyData()));
  },

  normalizePersonText(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    const p = Utils.personIdentityFromText(raw);
    return p.name && p.employeeNo ? Utils.personText(p.name, p.employeeNo) : raw;
  },

  normalizeStatusText(text) {
    if (typeof text !== "string" || !text) return text;
    const replacements = [
      ["进入测试任务", "测试中"],
      ["异常完成", "异常终止"],
      ["待执行", "待下发"],
      ["待启动", "待下发"],
      ["已分配", "在位等待"],
      ["已借出", "取走分析"],
      ["借出", "取走分析"],
      ["已归还", "闲置"],
      ["待维修", "闲置"],
      ["报废", "闲置"],
      ["变更退出", "退出测试"],
      ["未设置", "待确认"],
      ["失败", "不通过"],
      ["OK", "无故障"]
    ];
    let result = text;
    replacements.forEach(([oldValue, newValue]) => {
      result = result.split(oldValue).join(newValue);
    });
    result = result.replace(/(?<![无有])故障/g, "有故障");
    return result.replace(/\b(Pass|PASS|pass|Fail|FAIL|fail|Testing|testing)\b/g, token => ({
      Pass: "通过",
      PASS: "通过",
      pass: "通过",
      Fail: "不通过",
      FAIL: "不通过",
      fail: "不通过",
      Testing: "进行中",
      testing: "进行中"
    }[token] || token));
  },

  shouldSkipStatusTextNormalization(key, skipKeys = new Set()) {
    const raw = String(key || "");
    const lowered = raw.replace(/-/g, "_").toLowerCase();
    const compact = lowered.replace(/_/g, "");
    const staticSkip = new Set([
      "id", "ids", "uuid", "key", "code", "name", "filename", "file_name", "originalname", "original_name",
      "relativepath", "relative_path", "path", "url", "sampleid", "sampleids", "sample_id", "sample_ids",
      "taskid", "taskids", "task_id", "task_ids", "projectid", "projectids", "project_id", "project_ids",
      "stageid", "stageids", "stage_id", "stage_ids", "categoryid", "categoryids", "category_id", "category_ids",
      "progressid", "progressids", "progress_id", "progress_ids", "assetid", "assetids", "asset_id", "asset_ids",
      "photoid", "photoids", "photo_id", "photo_ids", "eventid", "eventids", "event_id", "event_ids",
      "sn", "imei", "boardsn", "board_sn", "sampleno", "sample_no", "serial", "serialno", "serial_no"
    ]);
    return skipKeys.has(raw) || skipKeys.has(lowered) || staticSkip.has(compact) || compact.endsWith("id") || compact.endsWith("ids");
  },

  normalizeBusinessStatusValue(value, skipKeys = new Set(["photos", "name", "fileName", "file_name", "originalName", "original_name", "relativePath", "path", "url"])) {
    if (Array.isArray(value)) return value.map(item => this.normalizeBusinessStatusValue(item, skipKeys));
    if (value && typeof value === "object") {
      Object.keys(value).forEach(key => {
        if (!this.shouldSkipStatusTextNormalization(key, skipKeys)) value[key] = this.normalizeBusinessStatusValue(value[key], skipKeys);
      });
      return value;
    }
    return this.normalizeStatusText(value);
  },

  normalizeTaskFlowStatus(input) {
    const isTask = input && typeof input === "object";
    const status = String((isTask ? input.status : input) || "").trim();
    if (["异常完成", "异常终止", "失败", "Fail", "FAIL", "fail"].includes(status)) return "异常终止";
    if (isTask && input.completed && !["异常终止", "异常完成", "失败", "Fail", "FAIL", "fail"].includes(status)) return "正常完成";
    const map = {
      "": "待下发",
      "待下发": "待下发",
      "待执行": "待下发",
      "待启动": "待下发",
      "进行中": "进行中",
      "Testing": "进行中",
      "testing": "进行中",
      "阻塞": "阻塞中",
      "阻塞中": "阻塞中",
      "正常完成": "正常完成",
      "已完成": "正常完成",
      "完成": "正常完成",
      "通过": "正常完成",
      "Pass": "正常完成",
      "PASS": "正常完成",
      "pass": "正常完成",
      "异常完成": "异常终止",
      "异常终止": "异常终止",
      "失败": "异常终止",
      "Fail": "异常终止",
      "FAIL": "异常终止",
      "fail": "异常终止"
    };
    return map[status] || "待下发";
  },

  normalizeTaskStoredStatus(value) {
    return this.normalizeTaskFlowStatus(value);
  },

  normalizeTaskResultValue(value) {
    const raw = String(value || "").trim();
    const map = {
      "通过": "通过",
      "Pass": "通过",
      "PASS": "通过",
      "pass": "通过",
      "OK": "通过",
      "ok": "通过",
      "正常": "通过",
      "不通过": "不通过",
      "失败": "不通过",
      "Fail": "不通过",
      "FAIL": "不通过",
      "fail": "不通过",
      "NG": "不通过",
      "ng": "不通过",
      "异常": "不通过"
    };
    return map[raw] || (["通过", "不通过"].includes(raw) ? raw : "");
  },

  normalizeSampleQualityValue(value, hasProblem = null) {
    if (hasProblem !== null && typeof hasProblem !== "undefined") return hasProblem ? "有故障" : "无故障";
    const raw = String(value || "").trim();
    const map = {
      "无故障": "无故障",
      "OK": "无故障",
      "ok": "无故障",
      "通过": "无故障",
      "正常": "无故障",
      "有故障": "有故障",
      "故障": "有故障",
      "Fail": "有故障",
      "FAIL": "有故障",
      "fail": "有故障",
      "失败": "有故障",
      "不通过": "有故障"
    };
    return map[raw] || (["无故障", "有故障"].includes(raw) ? raw : "无故障");
  },

  normalizeDisplayFallbackValue(value) {
    const raw = String(value || "").trim();
    if (raw === "变更退出") return "退出测试";
    if (raw === "未设置") return "待确认";
    return raw;
  },

  cleanProgressPlanItem(progress) {
    if (!progress || typeof progress !== "object") return progress;
    const allowed = ["id", "strategyId", "category", "testItem", "skuIndex", "sampleSize"];
    const clean = {};
    allowed.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(progress, key)) clean[key] = progress[key];
    });
    const originalKeys = Object.keys(progress);
    const hasExtraKey = originalKeys.some(key => !allowed.includes(key));
    const hasMissingOrChangedKey = allowed.some(key => (
      Object.prototype.hasOwnProperty.call(progress, key) !== Object.prototype.hasOwnProperty.call(clean, key)
      || progress[key] !== clean[key]
    ));
    if (hasExtraKey || hasMissingOrChangedKey) this._normalizedChanged = true;
    return clean;
  },

  memberRoleValue(role) {
    return Utils.memberRoleValue(role);
  },

  memberRoleLabel(role) {
    return Utils.memberRoleLabel(role);
  },

  memberRoleList() {
    return ["tester", "developer", "other"];
  },

  memberScopeRole(scope = "all") {
    const value = String(scope || "all").trim();
    return ["tester", "developer", "other"].includes(value) ? value : "all";
  },

  memberMatchesScope(member, scope = "all") {
    const role = this.memberScopeRole(scope);
    if (role === "all") return true;
    return this.memberRoleValue(member?.role) === role;
  },

  projectActiveMembers(project, scope = "all") {
    const role = this.memberScopeRole(scope);
    return (project?.members || [])
      .filter(m => m.active !== false && String(m.name || "").trim() && String(m.employeeNo || "").trim())
      .filter(m => role === "all" || this.memberRoleValue(m.role) === role);
  },

  findActiveProjectMemberByPersonText(project, personText) {
    const identity = Utils.personIdentityFromText(personText);
    if (!identity.name || !identity.employeeNo) return null;
    const key = Utils.memberIdentityKey(identity.name, identity.employeeNo);
    return this.projectActiveMembers(project).find(m => Utils.memberIdentityKey(m.name, m.employeeNo) === key) || null;
  },

  validatePersonForScope(value, scope = "all", label = "人员", options = {}) {
    const text = String(value || "").trim();
    const optional = !!options.optional;
    if (!text) {
      return optional ? { ok: true, value: "" } : { ok: false, msg: `请选择${label}。` };
    }
    const parsed = Utils.parsePersonField(text);
    if (!parsed.ok) return { ok: false, msg: parsed.msg || `${label}格式必须为「姓名/工号」。` };
    const normalizedText = Utils.personText(parsed.name, parsed.employeeNo);
    const project = options.project || (typeof this.currentProject === "function" ? this.currentProject() : null);
    const requireProjectMember = options.requireProjectMember !== false;
    if (project && requireProjectMember) {
      const member = this.findActiveProjectMemberByPersonText(project, normalizedText);
      if (!member) return { ok: false, msg: `${label}必须从当前项目人员配置中选择。` };
      if (!this.memberMatchesScope(member, scope)) {
        const scopeText = this.memberScopeRole(scope) === "all" ? "项目人员" : this.memberRoleLabel(scope);
        return { ok: false, msg: `${label}只能选择${scopeText}。` };
      }
    }
    return { ok: true, value: normalizedText };
  },

  normalize() {
    this.data.version = this.version;
    if (this.data.eventSchema !== "sample_events_v2") {
      this.data.eventSchema = "sample_events_v2";
      if (this.data.sampleLibrary) this.data.sampleLibrary.logs = [];
      this._normalizedChanged = true;
    }
    if (!this.data.sampleLibrary) this.data.sampleLibrary = { categories: [], logs: [] };
    if (!Array.isArray(this.data.sampleLibrary.categories)) this.data.sampleLibrary.categories = [];
    if (!Array.isArray(this.data.sampleLibrary.logs)) this.data.sampleLibrary.logs = [];
    if (!Array.isArray(this.data.users)) this.data.users = [];
    if (!Array.isArray(this.data.projects)) this.data.projects = [];
    if ("peoplePool" in this.data) { delete this.data.peoplePool; this._normalizedChanged = true; }
    if ("locationPool" in this.data) { delete this.data.locationPool; this._normalizedChanged = true; }
    this.data.projects.forEach(p => {
      if (!Array.isArray(p.stages)) p.stages = [];
      if (!Array.isArray(p.members)) p.members = [];
      if (!Array.isArray(p.locations)) { p.locations = []; this._normalizedChanged = true; }
      if (!Array.isArray(p.testCaseMaster)) p.testCaseMaster = [];
      const cleanLocations = [];
      p.locations.forEach(loc => {
        const clean = String(loc || "").trim();
        if (clean && !cleanLocations.includes(clean)) cleanLocations.push(clean);
      });
      if (cleanLocations.length !== p.locations.length || cleanLocations.some((v, i) => v !== p.locations[i])) {
        p.locations = cleanLocations;
        this._normalizedChanged = true;
      }
      const memberKeys = new Set();
      p.members = p.members.map(m => {
        if (typeof m !== "string") return m || {};
        const identity = Utils.personIdentityFromText(m);
        this._normalizedChanged = true;
        return { id: Utils.id("member_"), name: identity.name, employeeNo: identity.employeeNo, active: !!(identity.name && identity.employeeNo), role: "tester" };
      });
      p.members.forEach(m => {
        if (!m.id) { m.id = Utils.id("member_"); this._normalizedChanged = true; }
        if (typeof m.active === "undefined") { m.active = true; this._normalizedChanged = true; }
        const role = Utils.memberRoleValue(m.role, "tester");
        if (m.role !== role) { m.role = role; this._normalizedChanged = true; }
        const legacyIdentity = Utils.personIdentityFromText(m.name);
        if ((!m.employeeNo || !String(m.employeeNo).trim()) && legacyIdentity.name && legacyIdentity.employeeNo) {
          m.name = legacyIdentity.name;
          m.employeeNo = legacyIdentity.employeeNo;
          this._normalizedChanged = true;
        }
        m.name = String(m.name || "").trim();
        m.employeeNo = Utils.normalizeDigits(m.employeeNo || "");
        const key = Utils.memberIdentityKey(m.name, m.employeeNo);
        if (m.active !== false && (!m.name || !m.employeeNo)) {
          m.active = false;
          this._normalizedChanged = true;
        }
        if (m.active !== false && key !== "||") {
          if (memberKeys.has(key)) {
            m.active = false;
            this._normalizedChanged = true;
          } else {
            memberKeys.add(key);
          }
        }
      });
      const memberCountBefore = p.members.length;
      p.members = p.members.filter(m => !(m.active === false && memberKeys.has(Utils.memberIdentityKey(m.name, m.employeeNo))));
      if (p.members.length !== memberCountBefore) this._normalizedChanged = true;
      p.stages.forEach(s => {
        if (!Array.isArray(s.skuNames)) s.skuNames = ["SKU1"];
        if (!Array.isArray(s.bom)) s.bom = [];
        if (!Array.isArray(s.strategy)) s.strategy = [];
        if (!Array.isArray(s.progress)) s.progress = [];
        if (!Array.isArray(s.tasks)) s.tasks = [];
        s.progress = s.progress
          .filter(progress => progress && typeof progress === "object")
          .map(progress => this.cleanProgressPlanItem(progress));
        s.tasks.forEach(t => {
          if (!t.id) t.id = Utils.id("task_");
          if (!Array.isArray(t.sampleIds)) t.sampleIds = [];
          if (!Array.isArray(t.removedSampleRecords)) {
            const legacyIds = Array.isArray(t.removedSampleIds) ? t.removedSampleIds : [];
            t.removedSampleRecords = legacyIds.map(sampleId => ({
              id: Utils.id("removed_"),
              sampleId,
              sampleNo: sampleId,
              removedAt: "",
              user: "",
              reason: "历史退出记录"
            }));
            this._normalizedChanged = true;
          } else {
            t.removedSampleRecords = t.removedSampleRecords.map(item => {
              if (typeof item === "string") {
                this._normalizedChanged = true;
                return { id: Utils.id("removed_"), sampleId: item, sampleNo: item, removedAt: "", user: "", reason: "历史退出记录" };
              }
              if (!item || typeof item !== "object") { this._normalizedChanged = true; return null; }
              if (!item.id) { item.id = Utils.id("removed_"); this._normalizedChanged = true; }
              return item;
            }).filter(item => item && item.sampleId);
          }
          if (!Array.isArray(t.sampleFaultRecords)) t.sampleFaultRecords = [];
          if (!Array.isArray(t.resultUploads)) t.resultUploads = [];
          if (!Array.isArray(t.logs)) t.logs = [];
          t.owner = this.normalizePersonText(t.owner);
          if (typeof t.archived === "undefined") t.archived = false;
          const originalTaskStatus = t.status;
          this.normalizeBusinessStatusValue(t);
          let normalizedTaskStatus = this.normalizeTaskStoredStatus({ ...t, status: originalTaskStatus });
          if (normalizedTaskStatus !== t.status) this._normalizedChanged = true;
          this.repairTaskStatus(t, this.taskFlowStatus({ ...t, status: normalizedTaskStatus }), { markChanged: true });
          if (t.latestResult) {
            const normalizedLatest = this.normalizeTaskResultValue(t.latestResult);
            if (normalizedLatest && t.latestResult !== normalizedLatest) { t.latestResult = normalizedLatest; this._normalizedChanged = true; }
          }
          if (t.result) {
            const normalizedResult = this.normalizeTaskResultValue(t.result);
            if (normalizedResult && t.result !== normalizedResult) { t.result = normalizedResult; this._normalizedChanged = true; }
          }
          (t.resultUploads || []).forEach(upload => {
            if (!upload || typeof upload !== "object") return;
            const normalized = this.normalizeTaskResultValue(upload.result);
            if (normalized && upload.result !== normalized) { upload.result = normalized; this._normalizedChanged = true; }
            (upload.samples || []).forEach(item => {
              if (!item || typeof item !== "object") return;
              const quality = this.normalizeSampleQualityValue(item.fault);
              if (item.fault !== quality) { item.fault = quality; this._normalizedChanged = true; }
              if (item.destination) {
                const dest = this.normalizeSampleStatusValue(item.destination);
                if (item.destination !== dest) { item.destination = dest; this._normalizedChanged = true; }
              }
            });
          });
          if (t.resultDraft && typeof t.resultDraft === "object") {
            const normalized = this.normalizeTaskResultValue(t.resultDraft.result);
            if (normalized && t.resultDraft.result !== normalized) { t.resultDraft.result = normalized; this._normalizedChanged = true; }
            (t.resultDraft.samples || []).forEach(item => {
              if (!item || typeof item !== "object") return;
              const quality = this.normalizeSampleQualityValue(item.fault);
              if (item.fault !== quality) { item.fault = quality; this._normalizedChanged = true; }
            });
          }
          (t.sampleFaultRecords || []).forEach(record => {
            if (!record || typeof record !== "object") return;
            if (typeof record.fault !== "boolean") {
              record.fault = this.normalizeSampleQualityValue(record.fault) === "有故障";
              this._normalizedChanged = true;
            }
            if (record.result) {
              const result = this.normalizeTaskResultValue(record.result);
              if (result && record.result !== result) { record.result = result; this._normalizedChanged = true; }
            }
          });
          const progress = t.progressId ? s.progress.find(x => x.id === t.progressId) : null;
          if (progress) {
            if (!t.strategyId && progress.strategyId) t.strategyId = progress.strategyId;
            if (!t.category && progress.category) t.category = progress.category;
            if (!t.testItem && progress.testItem) t.testItem = progress.testItem;
            if (!t.skuIndex && progress.skuIndex) t.skuIndex = progress.skuIndex;
            if (!t.requiredSampleCount) t.requiredSampleCount = Utils.parsePositiveInt(progress.sampleSize) || t.requiredSampleCount;
          }
          if (typeof t.remark === "undefined") t.remark = "";
          if (!t.issueRecord) t.issueRecord = { dtsNo: "", isIssue: "", issueNote: "" };
        });
      });
    });
    this.data.sampleLibrary.logs = this.normalizeBusinessStatusValue(this.data.sampleLibrary.logs);
    this.data.sampleLibrary.categories.forEach(c => (c.samples || []).forEach(s => {
      if (typeof s.boardSn === "undefined") {
        s.boardSn = "";
        this._normalizedChanged = true;
      }
    }));
    this.eachSample(s => {
      if (Array.isArray(s.logs)) {
        delete s.logs;
        this._normalizedChanged = true;
      }
      this.normalizeBusinessStatusValue(s);
      this.repairSampleStatus(s, s.status || "闲置", { markChanged: true });
      if (typeof s.imei === "undefined") s.imei = "";
      if (typeof s.boardSn === "undefined") s.boardSn = "";
      const normalizedReassembled = Utils.parseSampleReassembledFlag(s.isReassembled);
      if (s.isReassembled !== normalizedReassembled) {
        s.isReassembled = normalizedReassembled;
        this._normalizedChanged = true;
      }
      if (typeof s.schemeNo === "undefined") s.schemeNo = "";
      if (typeof s.initialResult === "undefined") s.initialResult = "";
      if (!Array.isArray(s.initialResults)) {
        s.initialResults = Utils.parseSampleIssueText(s.initialResult || "");
        if (s.initialResults.length) this._normalizedChanged = true;
      }
      if (!Array.isArray(s.problemRecords)) {
        s.problemRecords = (s.initialResults || []).map(desc => ({
          id: Utils.id("problem_"),
          description: String(desc || "").trim(),
          source: "初检",
          taskLabel: ""
        })).filter(x => x.description && !Utils.isNoSampleIssueText(x.description));
        if (s.problemRecords.length) this._normalizedChanged = true;
      } else {
        const beforeProblemCount = s.problemRecords.length;
        s.problemRecords = s.problemRecords.map(item => {
          if (typeof item === "string") {
            return { id: Utils.id("problem_"), description: item.trim(), source: "初检", taskLabel: "" };
          }
          return {
            id: item.id || Utils.id("problem_"),
            description: this.normalizeStatusText(String(item.description || item.problem || "").trim()),
            source: this.normalizeStatusText(String(item.source || "手动补录").trim()),
            taskLabel: this.normalizeStatusText(String(item.taskLabel || item.task || "").trim())
          };
        }).filter(x => x.description && !Utils.isNoSampleIssueText(x.description));
        if (s.problemRecords.length !== beforeProblemCount) this._normalizedChanged = true;
      }
      s.initialResults = s.problemRecords.map(item => item.description);
      s.initialResult = s.initialResults.join("\n");
      if (typeof s.borrower === "undefined") s.borrower = "";
      if (typeof s.borrowDate === "undefined") s.borrowDate = "";
      if (typeof s.importDate === "undefined") s.importDate = "";
      if (typeof s.location === "undefined") s.location = "";
      if (!Array.isArray(s.photos)) s.photos = [];
    });
    this.reconcileSampleTaskOccupancy();
  },

  // ---- 数据访问 ----
  dataSnapshot() {
    return this.cloneData(this.data);
  },

  restoreDataSnapshot(snapshot) {
    this.data = this.cloneData(snapshot);
    return this.data;
  },

  patchViewState(values = {}) {
    this.view = { ...(this.view || {}), ...(values || {}) };
    return this.view;
  },

  viewModule() {
    return this.view?.module || "home";
  },

  selectedProjectId() {
    return this.view?.selectedProjectId || null;
  },

  selectedStageId() {
    return this.view?.selectedStageId || null;
  },

  selectedCategoryId() {
    return this.view?.selectedCategoryId || null;
  },

  stageStrategyId() {
    return this.view?.stageStrategyId || null;
  },

  sampleCategoryRecords() {
    if (!this.data) this.data = this.emptyData();
    if (!this.data.sampleLibrary) this.data.sampleLibrary = { categories: [], logs: [] };
    if (!Array.isArray(this.data.sampleLibrary.categories)) this.data.sampleLibrary.categories = [];
    return this.data.sampleLibrary.categories;
  },

  currentSampleCategory() {
    const id = String(this.selectedCategoryId() || "");
    return this.sampleCategoryRecords().find(category => String(category.id || "") === id) || null;
  },

  findSampleCategoryRecord(categoryId) {
    const id = String(categoryId || "");
    if (!id) return null;
    return this.sampleCategoryRecords().find(category => String(category.id || "") === id) || null;
  },

  projectDefaultSampleCategoryId(project = null) {
    const p = project || this.currentProject();
    const id = String(p?.defaultSampleCategoryId || "").trim();
    return id && this.findSampleCategoryRecord(id) ? id : "";
  },

  projectDefaultSampleCategoryName(project = null) {
    const category = this.findSampleCategoryRecord(this.projectDefaultSampleCategoryId(project));
    return category?.name || "";
  },

  samplePoolPageState(fallbackPageSize = 100) {
    return {
      page: Math.max(1, Number.parseInt(this.view?.samplePage, 10) || 1),
      pageSize: this.boundedViewPageSize(this.view?.samplePageSize, fallbackPageSize),
      filters: {
        keyword: this.view?.sampleKeyword || "",
        status: this.view?.sampleStatusFilter || "",
        problemState: this.view?.sampleProblemFilter || "",
        reassembled: this.view?.sampleReassemblyFilter || "",
        owner: this.view?.sampleOwnerFilter || "",
        borrower: this.view?.sampleBorrowerFilter || ""
      }
    };
  },

  setSamplePoolPageState(page) {
    return this.patchViewState({ samplePage: Math.max(1, Number.parseInt(page, 10) || 1) });
  },

  setSamplePoolPageSizeState(size, fallback = 100) {
    return this.patchViewState({
      samplePageSize: this.boundedViewPageSize(size, fallback),
      samplePage: 1
    });
  },

  setSamplePoolFilterState(name, value, { resetPage = true } = {}) {
    const map = {
      keyword: "sampleKeyword",
      status: "sampleStatusFilter",
      problemState: "sampleProblemFilter",
      reassembled: "sampleReassemblyFilter",
      owner: "sampleOwnerFilter",
      borrower: "sampleBorrowerFilter"
    };
    const key = map[name];
    if (!key) return null;
    return this.patchViewState({
      [key]: value || "",
      ...(resetPage ? { samplePage: 1 } : {})
    });
  },

  resetSamplePoolFiltersState() {
    return this.patchViewState({
      sampleKeyword: "",
      sampleStatusFilter: "",
      sampleProblemFilter: "",
      sampleReassemblyFilter: "",
      sampleOwnerFilter: "",
      sampleBorrowerFilter: "",
      samplePage: 1
    });
  },

  isCurrentSampleCategoryPage(categoryId) {
    return this.viewModule() === "samples"
      && String(this.selectedCategoryId() || "") === String(categoryId || "");
  },

  homeMetrics() {
    const projects = this.projectRecords();
    const categories = this.sampleCategoryRecords();
    return {
      projectCount: projects.length,
      samplePoolCount: categories.length,
      sampleCount: categories.reduce((sum, category) => (
        sum + (Number(category.sampleCount) || (category.samples || []).length || 0)
      ), 0),
    };
  },

  navExpandedState() {
    if (!this.view) this.view = {};
    if (!this.view._navExpanded) this.view._navExpanded = { projects: true, samples: true };
    return this.view._navExpanded;
  },

  toggleNavExpanded(id) {
    const expanded = this.navExpandedState();
    expanded[id] = !expanded[id];
    return expanded;
  },

  isNavItemActive(id) {
    const module = this.viewModule();
    if (id === "projects" && module === "projectWorkspace") return true;
    return module === id;
  },

  isProjectNavActive(projectId) {
    return this.viewModule() === "projectWorkspace"
      && String(this.selectedProjectId() || "") === String(projectId || "");
  },

  isSampleCategoryNavActive(categoryId) {
    return this.viewModule() === "samples"
      && String(this.selectedCategoryId() || "") === String(categoryId || "");
  },

  navFingerprintData() {
    const expanded = this.navExpandedState();
    return [
      this.viewModule(),
      this.selectedProjectId(),
      this.selectedCategoryId(),
      !!expanded.projects,
      !!expanded.samples,
      this.projectRecords().map(project => [project.id, project.name]),
      this.projectRecords().map(project => [project.id, project.accessRole, project.canOpen, project.canManage]),
      this.sampleCategoryRecords().map(category => [category.id, category.name, category.accessRole, category.canOpen, category.canManage]),
    ];
  },

  projectRecords() {
    if (!this.data) this.data = this.emptyData();
    if (!Array.isArray(this.data.projects)) this.data.projects = [];
    return this.data.projects;
  },

  findProjectRecord(projectId) {
    const id = String(projectId || "");
    return this.projectRecords().find(project => String(project.id || "") === id) || null;
  },

  projectInitialStageId(project) {
    return project?.stages?.[0]?.id || null;
  },

  isProjectSelected(projectId) {
    return String(projectId || "") === String(this.view?.selectedProjectId || "");
  },

  projectStateNameExists(name, excludeId = "") {
    const normalized = String(name || "").trim().toLowerCase();
    if (!normalized) return false;
    return this.projectRecords().some(project =>
      String(project.id || "") !== String(excludeId || "")
      && String(project.name || "").trim().toLowerCase() === normalized
    );
  },

  appendProjectRecord(project) {
    if (!project?.id) return null;
    this.projectRecords().push(project);
    return project;
  },

  removeProjectRecord(projectId) {
    const id = String(projectId || "");
    this.data.projects = this.projectRecords().filter(project => String(project.id || "") !== id);
    return this.data.projects;
  },

  selectFirstProjectState(overrides = {}) {
    const project = this.projectRecords()[0] || null;
    return this.patchViewState({
      selectedProjectId: project?.id || null,
      selectedStageId: this.projectInitialStageId(project),
      ...overrides,
    });
  },

  selectProjectState(projectId, overrides = {}) {
    return this.patchViewState({
      selectedProjectId: projectId || null,
      selectedStageId: Object.prototype.hasOwnProperty.call(overrides, "selectedStageId") ? overrides.selectedStageId : this.view?.selectedStageId,
      ...overrides,
    });
  },

  selectProjectWorkspaceState(projectId, { selectedStageId = null } = {}) {
    const contextChanged = this.viewModule() !== "projectWorkspace"
      || String(this.selectedProjectId() || "") !== String(projectId || "");
    if (contextChanged) this.resetTaskFlowContextState();
    return this.patchViewState({
      selectedProjectId: projectId || null,
      selectedStageId,
      stageStrategyId: null,
      module: "projectWorkspace",
    });
  },

  selectSampleCategoryState(categoryId) {
    return this.patchViewState({
      selectedCategoryId: categoryId || null,
      samplePage: 1,
      module: "samples",
    });
  },

  navigateModuleState(module) {
    const next = { module: module || "home" };
    if (next.module !== "projectWorkspace") next.stageStrategyId = null;
    if (next.module === "samples") {
      next.selectedCategoryId = null;
      next.samplePage = 1;
    }
    if (next.module === "home") next.selectedCategoryId = null;
    return this.patchViewState(next);
  },

  clearStageStrategyState() {
    return this.patchViewState({ stageStrategyId: null });
  },

  sidebarCollapsed() {
    return !!this.view?.sidebarCollapsed;
  },

  setSidebarCollapsed(collapsed) {
    return this.patchViewState({ sidebarCollapsed: !!collapsed });
  },

  toggleSidebarCollapsed() {
    return this.setSidebarCollapsed(!this.sidebarCollapsed());
  },

  isSectionCollapsed(sectionId) {
    return !!(this.view?.collapsed && this.view.collapsed[sectionId]);
  },

  toggleSectionState(sectionId) {
    if (!this.view) this.view = {};
    if (!this.view.collapsed) this.view.collapsed = {};
    this.view.collapsed[sectionId] = !this.view.collapsed[sectionId];
    return this.view.collapsed[sectionId];
  },

  ensureViewMap(key, fallback = {}) {
    if (!this.view) this.view = {};
    if (!this.view[key] || typeof this.view[key] !== "object") this.view[key] = { ...fallback };
    return this.view[key];
  },

  setViewMapValue(key, field, value, { removeEmpty = true, fallback = {} } = {}) {
    const target = this.ensureViewMap(key, fallback);
    if (removeEmpty && (value === "" || value === null || value === undefined)) {
      delete target[field];
    } else {
      target[field] = value;
    }
    return target;
  },

  resetViewMap(key, value = {}) {
    if (!this.view) this.view = {};
    this.view[key] = { ...value };
    return this.view[key];
  },

  resetTaskFlowPage() {
    return this.patchViewState({ taskFlowPage: 1 });
  },

  resetTaskFlowContextState() {
    if (typeof clearTimeout === "function") clearTimeout(this._taskFlowTextFilterTimer);
    this._taskFlowTextFilterTimer = null;
    this._taskFlowPageCache = null;
    this.cancelTaskFlowPageRequestState();
    return this.patchViewState({ taskFlowFilters: {}, taskFlowFilterDrafts: {}, taskFlowPage: 1 });
  },

  cancelTaskFlowPageRequestState(stageId = "") {
    const activeStageId = String(this._taskFlowActiveRequest?.stageId || "");
    if (stageId && activeStageId && activeStageId !== String(stageId)) return false;
    this._taskFlowRequestSequence = (Number(this._taskFlowRequestSequence) || 0) + 1;
    this._taskFlowActiveRequest = null;
    this._taskFlowLoadingKey = "";
    return true;
  },

  selectWorkspaceStageState(stageId) {
    const changed = String(this.selectedStageId() || "") !== String(stageId || "");
    if (changed) this.resetTaskFlowContextState();
    return this.patchViewState({ selectedStageId: stageId || null });
  },

  boundedViewPageSize(value, fallback = 100) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(500, Math.max(20, n));
  },

  taskFlowPageState(fallbackPageSize = 25) {
    return {
      page: Math.max(1, Number.parseInt(this.view?.taskFlowPage, 10) || 1),
      pageSize: this.boundedViewPageSize(this.view?.taskFlowPageSize, fallbackPageSize),
      filters: this.ensureViewMap("taskFlowFilters")
    };
  },

  setTaskFlowPageState(page) {
    return this.patchViewState({ taskFlowPage: Math.max(1, Number.parseInt(page, 10) || 1) });
  },

  setTaskFlowPageSizeState(size, fallback = 25) {
    return this.patchViewState({
      taskFlowPageSize: this.boundedViewPageSize(size, fallback),
      taskFlowPage: 1
    });
  },

  isCurrentProjectWorkspaceStage(stageId) {
    return this.viewModule() === "projectWorkspace"
      && String(this.selectedStageId() || "") === String(stageId || "");
  },

  ensureWorkspaceStageSelection(project) {
    if (!project?.stages?.length) return null;
    const selectedId = this.selectedStageId();
    if (!selectedId || !project.stages.some(stage => String(stage.id || "") === String(selectedId))) {
      this.selectWorkspaceStageState(project.stages[0].id);
    }
    return this.selectedStageId();
  },

  stageSortMode() {
    return !!this.view?.stageSortMode;
  },

  setStageSortModeState(enabled) {
    return this.patchViewState({ stageSortMode: !!enabled });
  },

  projectMemberUiState() {
    const detailRole = String(this.view?.memberDetailRole || "");
    return {
      memberSearch: String(this.view?.memberSearch || ""),
      memberDetailRole: this.memberRoleList().includes(detailRole) ? detailRole : ""
    };
  },

  sampleEventRecords() {
    if (!this.data) this.data = this.emptyData();
    if (!this.data.sampleLibrary) this.data.sampleLibrary = { categories: [], logs: [] };
    if (!Array.isArray(this.data.sampleLibrary.logs)) this.data.sampleLibrary.logs = [];
    return this.data.sampleLibrary.logs;
  },

  currentProject() {
    return this.findProjectRecord(this.view?.selectedProjectId) || this.projectRecords()[0] || null;
  },
  currentStage() {
    const p = this.currentProject();
    return p ? (p.stages.find(s => s.id === this.view.selectedStageId) || p.stages[0] || null) : null;
  },
  allSamples() {
    return this.data.sampleLibrary.categories.flatMap(c => (c.samples || []).map(s => ({ ...s, categoryName: c.name })));
  },
  /** 遍历所有样机的真实引用（可安全写入）。仅 normalize / reconcile 等修复逻辑使用。 */
  eachSample(fn) {
    this.data.sampleLibrary.categories.forEach(c => {
      (c.samples || []).forEach(s => fn(s, c));
    });
  },
  findSample(sampleId) {
    for (const c of this.data.sampleLibrary.categories) {
      const s = (c.samples || []).find(x => x.id === sampleId);
      if (s) return { category: c, sample: s };
    }
    return null;
  },
  projectName(id) { return this.data.projects.find(p => p.id === id)?.name || "-"; },
  stageName(projectId, stageId) {
    const p = this.data.projects.find(p => p.id === projectId);
    return p?.stages?.find(s => s.id === stageId)?.name || "-";
  },

  activeStageTasks(stage) {
    return (stage?.tasks || []).filter(t => !t.archived);
  },

  sampleProblemRecords(sample) {
    if (!sample) return [];
    if (!Array.isArray(sample.problemRecords)) sample.problemRecords = [];
    sample.problemRecords = sample.problemRecords.map(item => {
      if (typeof item === "string") {
        return { id: Utils.id("problem_"), description: this.normalizeStatusText(item.trim()), source: "初检", taskLabel: "" };
      }
      return {
        id: item.id || Utils.id("problem_"),
        description: this.normalizeStatusText(String(item.description || item.problem || "").trim()),
        source: this.normalizeStatusText(String(item.source || "手动补录").trim()),
        taskLabel: this.normalizeStatusText(String(item.taskLabel || item.task || "").trim())
      };
    }).filter(x => x.description && !Utils.isNoSampleIssueText(x.description));
    return sample.problemRecords;
  },

  sampleHasProblem(sample) {
    if (!sample) return false;
    if (sample.hasProblem === true || sample.hasProblem === 1 || sample.hasProblem === "1") return true;
    return this.sampleProblemRecords(sample).length > 0;
  },

  sampleIsReassembled(sample) {
    return Utils.parseSampleReassembledFlag(sample?.isReassembled);
  },

  sampleEffectiveStatus(sample) {
    return this.normalizeSampleStatusValue(sample?.status);
  },

  normalizeSampleStatusValue(status) {
    const raw = String(status || "").trim();
    const statusMap = {
      "已分配": "在位等待",
      "进入测试任务": "测试中",
      "已归还": "闲置",
      "借出": "取走分析",
      "已借出": "取走分析",
      "待维修": "闲置",
      "报废": "闲置",
      "故障": "闲置"
    };
    const normalized = statusMap[raw] || raw || "闲置";
    return this.constants.sampleStatuses.includes(normalized) ? normalized : "闲置";
  },

  repairSampleStatus(sample, nextStatus, ctx = {}) {
    if (!sample) return "";
    const normalized = this.normalizeSampleStatusValue(nextStatus);
    if (sample.status !== normalized) {
      sample.status = normalized;
      if (ctx.markChanged !== false) this._normalizedChanged = true;
    }
    return normalized;
  },

  clearSampleOccupancy(sample, ctx = {}) {
    if (!sample) return false;
    const changed = !!(sample.currentProjectId || sample.currentStageId || sample.currentTaskId || sample.currentTestItem);
    sample.currentProjectId = null;
    sample.currentStageId = null;
    sample.currentTaskId = null;
    sample.currentTestItem = "";
    if (changed && ctx.markChanged !== false) this._normalizedChanged = true;
    return changed;
  },

  sampleTaskLabelFromCtx(ctx = {}) {
    const project = ctx.projectName || this.projectName(ctx.projectId);
    const stage = ctx.stageName || this.stageName(ctx.projectId, ctx.stageId);
    const item = ctx.testItem || "";
    return [project, stage, item].filter(v => v && v !== "-").join(" - ");
  },

  addSampleProblem(sample, description, ctx = {}) {
    const text = this.normalizeStatusText(String(description || "").trim());
    if (!sample || !text) return null;
    const source = String(ctx.problemSource || ctx.source || "测试任务").trim();
    const taskLabel = String(ctx.taskLabel || this.sampleTaskLabelFromCtx(ctx)).trim();
    const records = this.sampleProblemRecords(sample);
    const exists = records.some(item =>
      item.description === text && item.source === source && item.taskLabel === taskLabel
    );
    if (exists) return null;
    const record = { id: Utils.id("problem_"), description: text, source, taskLabel };
    records.push(record);
    sample.initialResults = records.map(x => x.description);
    sample.initialResult = sample.initialResults.join("\n");
    return record;
  },

  // ---- 样机状态 ----
  createSampleEventLog(sample, fromStatus, toStatus, flowStatus, ctx = {}) {
    return {
      id: Utils.id("event_"),
      time: Utils.now(),
      eventType: "sample_status",
      sampleId: sample.id,
      sampleNo: sample.sampleNo,
      action: ctx.source || "未知入口",
      source: ctx.source || "未知入口",
      user: ctx.user || "未填写",
      from: fromStatus,
      to: toStatus,
      flowStatus,
      reason: ctx.reason || "",
      detail: ctx.detail || "",
      destination: ctx.destination || flowStatus,
      destLocation: ctx.destLocation || sample.location || "",
      receiver: ctx.receiver || sample.borrower || "",
      accountOwner: ctx.accountOwner || sample.owner || "",
      projectId: ctx.projectId || sample.currentProjectId,
      stageId: ctx.stageId || sample.currentStageId,
      projectName: ctx.projectName || this.projectName(ctx.projectId || sample.currentProjectId),
      stageName: ctx.stageName || this.stageName(ctx.projectId || sample.currentProjectId, ctx.stageId || sample.currentStageId),
      taskId: ctx.taskId || sample.currentTaskId,
      testItem: ctx.testItem || sample.currentTestItem,
      faultMarked: !!ctx.faultMarked,
      problemDescription: String(ctx.problemDescription || "").trim(),
      photoIds: Array.isArray(ctx.photoIds) ? ctx.photoIds : [],
      photos: Array.isArray(ctx.photos) ? ctx.photos : []
    };
  },

  changeSampleStatus(sampleId, newStatus, ctx = {}) {
    newStatus = this.normalizeSampleStatusValue(newStatus);
    const found = this.findSample(sampleId);
    if (!found) return;
    const s = found.sample, old = this.sampleEffectiveStatus(s);
    if (old === newStatus && !ctx.forceLog && !ctx.taskId && !ctx.receiver) return;
    const previous = {
      location: String(s.location || "").trim(),
      owner: this.normalizePersonText(s.owner || ""),
      borrower: this.normalizePersonText(s.borrower || "")
    };
    this.repairSampleStatus(s, newStatus, { markChanged: false });
    s.updatedAt = Utils.now();
    const isFault = !!ctx.faultMarked;
    const problemDescription = String(ctx.problemDescription || "").trim();
    if (isFault && problemDescription) {
      this.addSampleProblem(s, problemDescription, { ...ctx, problemSource: ctx.problemSource || "测试任务" });
    }
    // 仅当传入了非空去向位置时才覆盖样机当前位置，避免保存草稿/释放等空值清空原位置
    if (ctx.destLocation !== undefined && String(ctx.destLocation).trim()) {
      s.location = String(ctx.destLocation).trim();
    }
    const dest = ctx.destination || newStatus;
    if (dest === "取走分析") {
      s.borrower = this.normalizePersonText(ctx.receiver || "");
      s.borrowDate = ctx.receiverDate || Utils.today();
    } else {
      // 闲置 / 已退库：统一清空 borrower，不动 owner
      s.borrower = "";
      s.borrowDate = "";
    }
    // accountOwner 最后写入 — 表单值永远胜出，不会被 destination 分支覆盖
    if (ctx.accountOwner !== undefined) {
      s.owner = this.normalizePersonText(ctx.accountOwner);
    }
    const freeStatus = ["闲置", "已退库", "取走分析"].includes(newStatus);
    s.currentProjectId = freeStatus ? null : (ctx.projectId ?? s.currentProjectId);
    s.currentStageId = freeStatus ? null : (ctx.stageId ?? s.currentStageId);
    s.currentTaskId = freeStatus ? null : (ctx.taskId ?? s.currentTaskId);
    s.currentTestItem = freeStatus ? "" : (ctx.testItem ?? s.currentTestItem);
    const displayStatus = this.sampleEffectiveStatus(s);
    const next = {
      location: String(s.location || "").trim(),
      owner: this.normalizePersonText(s.owner || ""),
      borrower: this.normalizePersonText(s.borrower || "")
    };
    const valueText = value => String(value || "").trim() || "空";
    const detailParts = [];
    if (old !== displayStatus) detailParts.push(`状态：${valueText(old)} → ${valueText(displayStatus)}`);
    if (previous.location !== next.location) detailParts.push(`位置：${valueText(previous.location)} → ${valueText(next.location)}`);
    if (previous.owner !== next.owner) detailParts.push(`挂账人：${valueText(previous.owner)} → ${valueText(next.owner)}`);
    if (previous.borrower !== next.borrower) detailParts.push(`取走人：${valueText(previous.borrower)} → ${valueText(next.borrower)}`);
    const detail = ctx.detail || detailParts.join("；");
    const log = this.createSampleEventLog(s, old, displayStatus, newStatus, { ...ctx, detail, faultMarked: isFault, problemDescription });
    if (!Array.isArray(this.data.sampleLibrary.logs)) this.data.sampleLibrary.logs = [];
    this.data.sampleLibrary.logs.push(log);
  },

  activeTaskUsagesForSample(sampleId, excludeTaskId = "") {
    const excluded = excludeTaskId instanceof Set
      ? excludeTaskId
      : new Set(Array.isArray(excludeTaskId) ? excludeTaskId : [excludeTaskId].filter(Boolean));
    const usages = [];
    (this.data.projects || []).forEach(project => (project.stages || []).forEach(stage => (stage.tasks || []).forEach(task => {
      if (!task || task.archived || excluded.has(task.id)) return;
      if (this.isTaskCompleted(task)) return;
      if ((task.sampleIds || []).includes(sampleId)) usages.push({ project, stage, task });
    })));
    return usages;
  },

  reconcileSampleTaskOccupancy() {
    if (!this.data?.sampleLibrary?.categories) return;
    this.eachSample(sample => {
      const activeUsages = this.activeTaskUsagesForSample(sample.id);
      if (activeUsages.length) return;
      if (sample.currentTaskId || ["测试中", "在位等待"].includes(sample.status)) {
        this.clearSampleOccupancy(sample, { markChanged: true });
        if (["测试中", "在位等待"].includes(sample.status)) {
          this.repairSampleStatus(sample, "闲置", { markChanged: true });
        }
      }
    });
  },

  // ---- 通用查找与判断 ----
  getProjectStageTask(projectId, stageId, taskId) {
    const p = this.data.projects.find(x => x.id === projectId);
    const s = p?.stages?.find(x => x.id === stageId);
    const t = s?.tasks?.find(x => x.id === taskId);
    return { p, s, t };
  },

  isTaskCompleted(task) {
    if (!task) return false;
    if (task.archived) return true;
    const flow = this.taskFlowStatus(task);
    return flow === "正常完成" || flow === "异常终止";
  },

  isTaskExecuted(task) {
    if (!task) return false;
    const flow = this.taskFlowStatus(task);
    if (flow === "正常完成" || flow === "异常终止") return true;
    return flow === "进行中" || flow === "阻塞中";
  },

  isSampleUsedByAnotherOpenTask(sampleId, excludeTaskId = "") {
    const usages = this.activeTaskUsagesForSample(sampleId, excludeTaskId);
    return usages.length > 0;
  }

});
