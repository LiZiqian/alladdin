/* ========================================
   TestChamber V7 - fixed-IP access UX

   The server remains the security boundary. This module only mirrors the
   server-provided access role so unavailable actions are not advertised.
   ======================================== */

app.registerModule("access.control", {
  applyBootstrapAccess(bootstrap = {}) {
    const context = bootstrap.accessContext || bootstrap.data?.accessContext || {};
    this.accessContext = {
      clientIp: String(context.clientIp || context.ipAddress || context.ip || "").trim(),
      role: String(context.role || context.platformRole || (context.isLocalAdmin ? "local_admin" : "")).trim(),
      isLocalAdmin: context.isLocalAdmin === true || context.role === "local_admin",
    };
    this._accessContextInitialized = true;
    return this.accessContext;
  },

  currentAccessContext() {
    return this.accessContext || { clientIp: "", role: "", isLocalAdmin: false };
  },

  accessContextIsExplicit() {
    return this._accessContextInitialized === true;
  },

  isLocalAdminAccess() {
    if (!this.accessContextIsExplicit()) return true;
    const context = this.currentAccessContext();
    return context.isLocalAdmin === true || context.role === "local_admin";
  },

  resourceHasExplicitAccess(resource) {
    if (!resource || typeof resource !== "object") return false;
    return ["accessRole", "canOpen", "canContribute", "canManage"].some(key => (
      Object.prototype.hasOwnProperty.call(resource, key)
    ));
  },

  resourceCanOpen(resource) {
    if (this.isLocalAdminAccess()) return true;
    if (!this.resourceHasExplicitAccess(resource)) return !this.accessContextIsExplicit();
    return resource?.canOpen === true || !["", "none"].includes(String(resource?.accessRole || ""));
  },

  resourceCanContribute(resource) {
    if (this.isLocalAdminAccess()) return true;
    if (!this.resourceHasExplicitAccess(resource)) return !this.accessContextIsExplicit();
    return resource?.canContribute === true;
  },

  resourceCanManage(resource) {
    if (this.isLocalAdminAccess()) return true;
    if (!this.resourceHasExplicitAccess(resource)) return !this.accessContextIsExplicit();
    return resource?.canManage === true;
  },

  projectAccessRole(project = null) {
    if (this.isLocalAdminAccess()) return "local_admin";
    return String((project || this.currentProject?.())?.accessRole || "none");
  },

  samplePoolAccessRole(category = null) {
    if (this.isLocalAdminAccess()) return "local_admin";
    return String((category || this.currentSampleCategory?.())?.accessRole || "none");
  },

  accessRoleLabel(role = "") {
    return ({
      none: "无权限",
      viewer: "可查看",
      contributor: "可编辑 / 任务执行",
      project_admin: "项目管理员",
      pool_viewer: "池查看者",
      pool_maintainer: "池维护者",
      pool_admin: "池管理员",
      local_admin: "本机管理员",
    })[String(role || "none")] || String(role || "无权限");
  },

  accessDeniedText(resourceType = "resource", resource = null) {
    const ip = this.currentAccessContext().clientIp || "当前电脑";
    const label = resourceType === "project" ? "项目" : resourceType === "pool" ? "样机池" : "内容";
    const name = resource?.name ? `“${resource.name}”` : "";
    return `当前 IP（${ip}）未获授权，无法进入${label}${name}。请联系该${label}管理员添加访问名单。`;
  },

  showResourceAccessDenied(resourceType = "resource", resourceId = "") {
    const resource = resourceType === "project"
      ? this.findProjectRecord?.(resourceId)
      : resourceType === "pool"
        ? this.findSampleCategoryRecord?.(resourceId)
        : null;
    Utils.toast(this.accessDeniedText(resourceType, resource));
    return false;
  },

  accessDeniedError(message = "访问被拒绝") {
    const error = new Error(message);
    error.name = "AccessDeniedError";
    error.status = 403;
    return error;
  },

  isAccessDeniedError(error) {
    return error?.status === 403 || error?.name === "AccessDeniedError";
  },

  accessDeniedResourceFromUrl(input) {
    const raw = typeof input === "string" ? input : String(input?.url || "");
    const projectMatch = raw.match(/\/api\/projects\/([^/?]+)/);
    if (projectMatch && projectMatch[1] !== "summary") {
      return { type: "project", id: decodeURIComponent(projectMatch[1]) };
    }
    const poolMatch = raw.match(/\/api\/sample-categories\/([^/?]+)/);
    if (poolMatch) return { type: "pool", id: decodeURIComponent(poolMatch[1]) };
    if (/\/api\/stages\//.test(raw) || /\/api\/tasks\//.test(raw)) {
      return { type: "project", id: String(this.selectedProjectId?.() || "") };
    }
    if (/\/api\/samples\//.test(raw) || /\/api\/sample-/.test(raw)) {
      return { type: "pool", id: String(this.selectedCategoryId?.() || "") };
    }
    return { type: "resource", id: "" };
  },

  installAccessDeniedFetchHandler() {
    if (this._accessFetchHandlerInstalled || typeof globalThis.fetch !== "function") return;
    const originalFetch = globalThis.fetch.bind(globalThis);
    const owner = this;
    globalThis.fetch = async function accessAwareFetch(input, options) {
      const response = await originalFetch(input, options);
      if (response?.status === 403) owner.handleAccessDeniedResponse(input);
      return response;
    };
    this._accessFetchHandlerInstalled = true;
    this._accessOriginalFetch = originalFetch;
  },

  clearProtectedDetailCaches() {
    const pick = (source, keys) => Object.fromEntries(keys
      .filter(key => Object.prototype.hasOwnProperty.call(source || {}, key))
      .map(key => [key, source[key]]));
    const accessKeys = ["accessRole", "canOpen", "canContribute", "canManage"];
    this.data.projects = this.projectRecords?.().map(project => ({
      ...pick(project, ["id", "name", "code", "stageCount", "taskCount", "aggregateStatus", "statusCounts", ...accessKeys]),
      stages: [],
      _summaryOnly: true,
      _detailLoaded: false,
      _tasksFullyLoaded: false,
    })) || [];
    if (!this.data.sampleLibrary) this.data.sampleLibrary = { categories: [], logs: [] };
    this.data.sampleLibrary.categories = this.sampleCategoryRecords?.().map(category => ({
      ...pick(category, ["id", "name", "description", "sampleCount", "statusCounts", "problemCounts", "reassemblyCounts", "reassembledCount", ...accessKeys]),
      samples: [],
      _summaryOnly: true,
      samplesLoaded: false,
    })) || [];
    this.data.sampleLibrary.logs = [];
    this.data.users = [];
    delete this.data.currentProjectId;
    delete this.data.currentStageId;
    this._projectDetailPromises = {};
    this._sampleCategoryDetailPromises = {};
    this._sampleLookupPromises = {};
    this._sampleHistoryCache = {};
    this._sampleDetailAccessCache = {};
    this.invalidatePagedCaches?.();
  },

  async refreshPublicBootstrapAfterDenied() {
    try {
      const bootstrap = await this.fetchBootstrapState();
      this.data = bootstrap.data || this.emptyData();
      this.applyBootstrapAccess(bootstrap);
      this.serverRevision = bootstrap.revision || this.serverRevision;
      this.serverUpdatedAt = bootstrap.updated_at || this.serverUpdatedAt;
      this._statePartial = bootstrap.partial !== false;
      this.normalize();
      this._baseData = this.cloneData(this.data);
      this.patchViewState({
        module: "home",
        selectedProjectId: null,
        selectedStageId: null,
        selectedCategoryId: null,
        stageStrategyId: null,
      });
      this._navFingerprint = null;
      this.render();
    } catch (error) {
      console.error("权限变化后刷新公共摘要失败：", error);
    } finally {
      this._accessDeniedRefreshInFlight = null;
    }
  },

  handleAccessDeniedResponse(input) {
    const resource = this.accessDeniedResourceFromUrl(input);
    this._accessEpoch = Number(this._accessEpoch || 0) + 1;
    this.closeModal?.();
    this.clearProtectedDetailCaches();
    this.patchViewState?.({
      module: "home",
      selectedProjectId: null,
      selectedStageId: null,
      selectedCategoryId: null,
      stageStrategyId: null,
    });
    this._navFingerprint = null;
    this.render?.();
    const now = Date.now();
    if (!this._accessDeniedNoticeAt || now - this._accessDeniedNoticeAt > 1200) {
      this._accessDeniedNoticeAt = now;
      this.showResourceAccessDenied(resource.type, resource.id);
    }
    if (!this._accessDeniedRefreshInFlight) {
      this._accessDeniedRefreshInFlight = this.refreshPublicBootstrapAfterDenied();
    }
  },

  projectActionIsMutation(action = "") {
    const exact = new Set([
      "project-add", "project-edit", "project-delete", "project-default-sample-category",
      "stage-add", "stage-delete", "stage-copy", "stage-drag", "stage-sort-toggle",
      "task-add", "task-delete", "task-config", "task-change",
      "project-members-template", "project-members-import", "project-members-bulk-role",
      "project-members-clear-selection", "project-member-selection",
      "project-member-add", "project-member-edit", "project-member-remove",
      "project-member-combobox", "project-member-combobox-option",
      "project-location-add", "test-case-import", "bom-add", "bom-update", "bom-delete",
      "strategy-input", "strategy-sku", "strategy-delete", "strategy-add",
      "inline-sku-add", "inline-sku-remove", "sku-input-add", "sku-input-remove",
    ]);
    if (exact.has(action)) return true;
    return [
      "project-location-", "task-pool-", "task-config-",
      "task-sample-picker-", "inline-stage-",
    ].some(prefix => action.startsWith(prefix));
  },

  contributorProjectActionAllowed(action = "") {
    return new Set([
      "task-start", "task-block", "task-result", "task-issue-record",
      "task-result-photo-upload", "task-result-problem-remove", "task-result-destination",
      "task-result-finish-type", "task-result-value", "task-result-photo-preview",
    ]).has(action);
  },

  poolActionRequiredRole(action = "") {
    if ([
      "sample-category-delete", "sample-category-edit", "sample-destroy", "sample-photo-delete",
      "sample-pool-export-scope", "access-rules-open",
    ].includes(action)) return "pool_admin";
    if ([
      "sample-add", "sample-batch-import", "sample-template-download", "sample-archive-import",
      "sample-photo-upload", "sample-photo-rename",
    ].includes(action)) return "pool_maintainer";
    return "";
  },

  actionAllowedByCurrentAccess(action = "", target = null) {
    if (!action || this.isLocalAdminAccess()) return true;
    if (["sample-problem-add", "sample-problem-remove"].includes(action)) return false;
    if ([
      "bundle-export", "bundle-import", "project-add", "sample-category-add", "project-delete",
      "sample-archive-export", "sample-archive-import",
    ].includes(action)) return false;

    const module = this.viewModule?.() || this.view?.module || "home";
    if (module === "projectWorkspace") {
      const role = this.projectAccessRole();
      if (this.projectActionIsMutation(action)) return role === "project_admin";
      if (this.contributorProjectActionAllowed(action)) return ["contributor", "project_admin"].includes(role);
    }
    if (module === "projects") {
      const project = this.findProjectRecord?.(target?.dataset?.id || "");
      if (["project-edit", "project-export-scope", "access-rules-open"].includes(action)) return this.resourceCanManage(project);
    }
    if (module === "samples") {
      const category = this.currentSampleCategory?.() || this.findSampleCategoryRecord?.(target?.dataset?.id || "");
      const role = this.samplePoolAccessRole(category);
      const required = this.poolActionRequiredRole(action);
      if (required === "pool_admin") return role === "pool_admin";
      if (required === "pool_maintainer") return ["pool_maintainer", "pool_admin"].includes(role);
    }
    return true;
  },

  applyAccessUiPolicy(root = document) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll("[data-app-action]").forEach(node => {
      const action = String(node.dataset?.appAction || "");
      const allowed = this.actionAllowedByCurrentAccess(action, node);
      node.classList?.toggle?.("access-ui-hidden", !allowed);
      if ("hidden" in node) node.hidden = !allowed;
      if (!allowed) node.setAttribute?.("aria-hidden", "true");
      else node.removeAttribute?.("aria-hidden");
    });
  },

  installAccessUiObserver() {
    if (this._accessUiObserver || typeof MutationObserver !== "function") return;
    const content = document.getElementById("content");
    if (!content) return;
    this._accessUiObserver = new MutationObserver(() => {
      if (this._accessUiPolicyQueued) return;
      this._accessUiPolicyQueued = true;
      Promise.resolve().then(() => {
        this._accessUiPolicyQueued = false;
        this.applyAccessUiPolicy(document);
      });
    });
    this._accessUiObserver.observe(content, { childList: true, subtree: true });
  },

  async accessApiRequest(url, options = {}) {
    const response = await fetch(url, options);
    const json = await response.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (response.status === 403) throw this.accessDeniedError(json.error || "当前 IP 无权管理访问名单");
    if (!response.ok || !json.ok) throw new Error(json.error || (`HTTP ${response.status}`));
    return json;
  },

  accessRuleEndpoint(resourceType, resourceId) {
    const base = resourceType === "project" ? "/api/projects/" : "/api/sample-categories/";
    return `${base}${encodeURIComponent(resourceId)}/access-rules`;
  },

  accessRuleResource(resourceType, resourceId) {
    return resourceType === "project"
      ? this.findProjectRecord?.(resourceId)
      : this.findSampleCategoryRecord?.(resourceId);
  },

  async fetchAccessRules(resourceType, resourceId) {
    const json = await this.accessApiRequest(this.accessRuleEndpoint(resourceType, resourceId), { cache: "no-store" });
    return Array.isArray(json.rules) ? json.rules : Array.isArray(json.accessRules) ? json.accessRules : [];
  },

  accessRuleRoles(resourceType) {
    return resourceType === "project"
      ? [
          { value: "viewer", label: "可查看" },
          { value: "contributor", label: "可编辑 / 任务执行" },
          { value: "project_admin", label: "项目管理员" },
        ]
      : [
          { value: "pool_viewer", label: "池查看者" },
          { value: "pool_maintainer", label: "池维护者" },
          { value: "pool_admin", label: "池管理员" },
        ];
  },

  accessRuleRoleOptionsHtml(resourceType, selectedRole = "") {
    return this.accessRuleRoles(resourceType)
      .map(item => `<option value="${Utils.esc(item.value)}"${item.value === selectedRole ? " selected" : ""}>${Utils.esc(item.label)}</option>`)
      .join("");
  },

  accessRuleDataRowHtml(resourceType, resourceId, rule = {}) {
    const ip = String(rule.ipAddress || rule.ip_address || "");
    const role = String(rule.role || "");
    const enabled = rule.enabled !== false && Number(rule.enabled ?? 1) !== 0;
    const deviceLabel = String(rule.deviceLabel || rule.device_label || "");
    const userNote = String(rule.userNote || rule.user_note || "");
    return `<tr class="access-rule-data-row">
      <td><code>${Utils.esc(ip)}</code></td>
      <td>${Utils.esc(this.accessRoleLabel(role))}</td>
      <td>${enabled ? "启用" : "停用"}</td>
      <td title="${Utils.esc(userNote)}">${Utils.esc(deviceLabel || "—")}</td>
      <td class="access-rule-actions">
        <button type="button" class="btn btn-sm btn-outline" data-app-action="access-rule-edit"
          data-resource-type="${Utils.esc(resourceType)}" data-id="${Utils.esc(resourceId)}"
          data-ip="${Utils.esc(ip)}" data-role="${Utils.esc(role)}" data-enabled="${enabled ? "1" : "0"}"
          data-device-label="${Utils.esc(deviceLabel)}" data-user-note="${Utils.esc(userNote)}">编辑</button>
        <button type="button" class="btn btn-sm btn-danger" data-app-action="access-rule-delete"
          data-resource-type="${Utils.esc(resourceType)}" data-id="${Utils.esc(resourceId)}" data-ip="${Utils.esc(ip)}">删除</button>
      </td>
    </tr>`;
  },

  accessRuleAddRowHtml(resourceType, resourceId) {
    return `<tr class="access-rule-add-row">
      <td class="access-rule-placeholder">待添加 IP 地址</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>
        <button type="button" class="access-rule-add-btn" data-app-action="access-rule-add"
          data-resource-type="${Utils.esc(resourceType)}" data-id="${Utils.esc(resourceId)}"
          aria-label="新增 IP 访问权限" title="新增 IP 访问权限"><span aria-hidden="true">＋</span></button>
      </td>
    </tr>`;
  },

  accessRuleModalHtml(resourceType, resource, rules = []) {
    const rows = (rules || []).map(rule => this.accessRuleDataRowHtml(resourceType, resource.id, rule)).join("");
    return `<div class="access-rule-shell">
      <div class="access-rule-list-heading">
        <strong>已配置的访问名单</strong>
      </div>
      <div class="access-rule-table-wrap">
        <table class="access-rule-table"><thead><tr><th>IP 地址</th><th>角色</th><th>状态</th><th>设备名称</th><th>操作</th></tr></thead>
          <tbody>${rows}${this.accessRuleAddRowHtml(resourceType, resource.id)}</tbody>
        </table>
      </div>
    </div>`;
  },

  validExactIpv4(value = "") {
    const parts = String(value || "").trim().split(".");
    return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  },

  validateAccessRuleInlineIp(row, { allowEmpty = true } = {}) {
    const ipEl = row?.querySelector?.('[data-access-field="ip"]');
    if (!ipEl) return true;
    const value = String(ipEl.value || "").trim();
    const group = ipEl.closest?.("td") || ipEl.parentElement;
    ipEl.classList.remove("is-invalid");
    group?.querySelector?.(".field-error")?.remove?.();
    if (!value && allowEmpty) return true;
    if (this.validExactIpv4(value)) return true;
    this.markFieldInvalid?.(ipEl, "请输入四段 0–255 的 IPv4 地址，例如 10.31.118.61");
    return false;
  },

  bindAccessRuleInlineIpValidation(row) {
    const ipEl = row?.querySelector?.('[data-access-field="ip"]');
    if (!ipEl || ipEl.dataset.validationBound === "1") return;
    ipEl.dataset.validationBound = "1";
    ipEl.addEventListener("blur", () => this.validateAccessRuleInlineIp(row, { allowEmpty: true }));
    ipEl.addEventListener("input", () => {
      if (ipEl.classList.contains("is-invalid")) this.validateAccessRuleInlineIp(row, { allowEmpty: true });
    });
  },

  restoreAccessRuleInlineEditor() {
    const row = this._accessRuleEditingRow;
    if (!row?.isConnected || !Array.isArray(row._accessRuleOriginalNodes)) {
      this._accessRuleEditingRow = null;
      return;
    }
    row.className = row._accessRuleOriginalClassName || "";
    this.replaceWithClonedNodes(row, row._accessRuleOriginalNodes);
    this._accessRuleEditingRow = null;
  },

  accessRuleInlineEditorCellsHtml(resourceType, values = {}, isNew = false) {
    const ip = String(values.ip || "");
    const role = String(values.role || this.accessRuleRoles(resourceType)[0]?.value || "");
    const enabled = values.enabled !== false && String(values.enabled ?? "1") !== "0";
    const deviceLabel = String(values.deviceLabel || "");
    return `<td><input class="access-rule-inline-control" data-access-field="ip" inputmode="decimal"
        autocomplete="off" spellcheck="false" maxlength="15" placeholder="例如 10.31.118.61"
        value="${Utils.esc(ip)}"${isNew ? "" : " readonly"}></td>
      <td><select class="access-rule-inline-control" data-access-field="role">${this.accessRuleRoleOptionsHtml(resourceType, role)}</select></td>
      <td><select class="access-rule-inline-control access-rule-status-select" data-access-field="enabled">
        <option value="1"${enabled ? " selected" : ""}>启用</option>
        <option value="0"${enabled ? "" : " selected"}>停用</option>
      </select></td>
      <td><input class="access-rule-inline-control" data-access-field="deviceLabel" maxlength="100"
        placeholder="设备名称" value="${Utils.esc(deviceLabel)}"></td>
      <td class="access-rule-actions"><button type="button" class="btn btn-sm access-rule-confirm-btn"
        data-app-action="access-rule-confirm">确认</button></td>`;
  },

  openAccessRuleInlineEditor(target, isNew = false) {
    const row = target?.closest?.("tr");
    if (!row) return;
    const values = {
      ip: target.dataset.ip || "",
      role: target.dataset.role || "",
      enabled: target.dataset.enabled ?? "1",
      deviceLabel: target.dataset.deviceLabel || "",
      userNote: target.dataset.userNote || "",
    };
    const resourceType = target.dataset.resourceType || "project";
    const resourceId = target.dataset.id || "";
    this.restoreAccessRuleInlineEditor();
    row._accessRuleOriginalNodes = this.cloneChildNodes(row);
    row._accessRuleOriginalClassName = row.className;
    row.className = `${row.className} access-rule-inline-editor`.trim();
    row.dataset.resourceType = resourceType;
    row.dataset.resourceId = resourceId;
    row.dataset.userNote = values.userNote;
    row.dataset.isNew = isNew ? "1" : "0";
    this.replaceHtml(row, this.accessRuleInlineEditorCellsHtml(resourceType, values, isNew));
    this._accessRuleEditingRow = row;
    this.bindAccessRuleInlineIpValidation(row);
    setTimeout(() => row.querySelector?.(isNew ? '[data-access-field="ip"]' : '[data-access-field="role"]')?.focus?.(), 0);
  },

  addAccessRuleForm(target) {
    this.openAccessRuleInlineEditor(target, true);
  },

  async openAccessRules(resourceType, resourceId) {
    const resource = this.accessRuleResource(resourceType, resourceId);
    if (!resource || !this.resourceCanManage(resource)) {
      this.showResourceAccessDenied(resourceType, resourceId);
      return;
    }
    let rules;
    try {
      rules = await this.fetchAccessRules(resourceType, resourceId);
    } catch (error) {
      if (!this.isAccessDeniedError(error)) Utils.toast(`访问名单加载失败：${error.message || error}`);
      return;
    }
    this.showModal(
      `${resourceType === "project" ? "项目" : "样机池"}访问名单 · ${resource.name || ""}`,
      this.accessRuleModalHtml(resourceType, resource, rules),
      () => false,
      "确定",
      { className: "access-rule-modal", cancelText: "关闭" },
    );
    const ok = document.getElementById("modalOk");
    if (ok) ok.style.display = "none";
  },

  editAccessRuleForm(target) {
    this.openAccessRuleInlineEditor(target, false);
  },

  async confirmAccessRuleInlineEdit(target) {
    const row = target?.closest?.("tr");
    if (!row) return;
    const resourceType = row.dataset.resourceType || "project";
    const resourceId = row.dataset.resourceId || "";
    const ipEl = row.querySelector('[data-access-field="ip"]');
    const roleEl = row.querySelector('[data-access-field="role"]');
    const ipAddress = String(ipEl?.value || "").trim();
    const role = String(roleEl?.value || "");
    if (!this.validateAccessRuleInlineIp(row, { allowEmpty: false })) return;
    if (!this.accessRuleRoles(resourceType).some(item => item.value === role)) {
      this.markFieldInvalid?.(roleEl, "请选择允许授予的角色");
      return;
    }
    target.disabled = true;
    try {
      const json = await this.accessApiRequest(this.accessRuleEndpoint(resourceType, resourceId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ipAddress,
          role,
          enabled: row.querySelector('[data-access-field="enabled"]')?.value !== "0",
          deviceLabel: String(row.querySelector('[data-access-field="deviceLabel"]')?.value || "").trim(),
          userNote: String(row.dataset.userNote || ""),
        }),
      });
      const savedRow = this.accessRuleDataRowHtml(resourceType, resourceId, json.rule || { ipAddress, role });
      const addRow = row.dataset.isNew === "1" ? this.accessRuleAddRowHtml(resourceType, resourceId) : "";
      const replacement = this.htmlFragment(`${savedRow}${addRow}`);
      row.replaceWith(...Array.from(replacement?.childNodes || []));
      this._accessRuleEditingRow = null;
      Utils.toast("访问权限已保存并立即生效");
    } catch (error) {
      target.disabled = false;
      if (!this.isAccessDeniedError(error)) Utils.toast(`访问权限保存失败：${error.message || error}`);
    }
  },

  deleteAccessRule(resourceType, resourceId, ipAddress) {
    this.showConfirm(`确认删除固定 IP ${ipAddress} 的访问权限？删除后下一次请求立即失效。`, async () => {
      try {
        const query = new URLSearchParams({ ipAddress });
        await this.accessApiRequest(`${this.accessRuleEndpoint(resourceType, resourceId)}?${query.toString()}`, { method: "DELETE" });
        Utils.toast("访问权限已删除");
        setTimeout(() => this.openAccessRules(resourceType, resourceId), 30);
      } catch (error) {
        if (!this.isAccessDeniedError(error)) Utils.toast(`访问权限删除失败：${error.message || error}`);
      }
    }, { title: "删除访问权限", okText: "删除", okClass: "btn btn-danger" });
  },
});
