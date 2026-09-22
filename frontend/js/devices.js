/* Test equipment warehouse: region/department groups and equipment cards. */
app.registerModule("devices", {
  currentDeviceGroup() {
    return this._deviceWarehouse?.groups?.find(group => group.id === this.view.selectedDeviceGroupId) || null;
  },

  async loadDeviceWarehouse() {
    const request = this._deviceWarehouseRequest = (this._deviceWarehouseRequest || 0) + 1;
    this._deviceWarehouseLoading = true;
    this._deviceWarehouseError = "";
    if (this.viewModule() === "devices") this.renderDevices();
    try {
      const res = await fetch("/api/device-warehouse", { cache: "no-store" });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || "设备仓库加载失败");
      if (request !== this._deviceWarehouseRequest) return;
      this._deviceWarehouse = result.warehouse;
    } catch (error) {
      if (request !== this._deviceWarehouseRequest) return;
      this._deviceWarehouseError = error.message;
    } finally {
      if (request === this._deviceWarehouseRequest) {
        this._deviceWarehouseLoading = false;
        if (this.viewModule() === "devices") this.render();
      }
    }
  },

  renderDevices() {
    const content = document.getElementById("content");
    if (!content) return;
    if (!this._deviceWarehouse && !this._deviceWarehouseLoading && !this._deviceWarehouseError) {
      this.loadDeviceWarehouse();
      return;
    }
    const group = this.currentDeviceGroup();
    const groups = this._deviceWarehouse?.groups || [];
    const disabled = this._deviceWarehouseLoading || !!this._deviceWarehouseError;
    const header = `<div class="device-warehouse-head"><div><h2>${group ? Utils.esc(group.region + "－" + group.department) : "测试设备仓库"}</h2><p>${group ? "设备列表 · " + (group.devices || []).length + " 台设备" : "地域－部门 · " + groups.length + " 张卡片"}</p></div>
      <div class="device-warehouse-actions">${group ? '<button class="btn btn-outline" data-app-action="go" data-module="devices">返回地域－部门</button>' : ""}<button class="btn btn-outline" data-app-action="device-warehouse-refresh" ${this._deviceWarehouseLoading ? "disabled" : ""}>刷新列表</button></div></div>`;
    if (this._deviceWarehouseError) {
      this.replaceHtml(content, `<section class="device-warehouse">${header}<div class="card device-warehouse-message" role="alert">${Utils.esc(this._deviceWarehouseError)}，请点击刷新列表重试。</div></section>`);
      return;
    }
    if (!this._deviceWarehouse) {
      this.replaceHtml(content, `<section class="device-warehouse">${header}<p role="status">正在加载设备仓库…</p></section>`);
      return;
    }
    const cards = groups.map(item => `<article class="card device-group-card">
      <div class="device-group-heading"><h3>${Utils.esc(item.region)}－${Utils.esc(item.department)}</h3><button class="btn btn-sm btn-outline" data-app-action="device-group-edit" data-id="${Utils.esc(item.id)}" aria-label="编辑 ${Utils.esc(item.region)}－${Utils.esc(item.department)}" ${disabled ? "disabled" : ""}>编辑</button></div>
      <dl><div><dt>地域</dt><dd>${Utils.esc(item.region)}</dd></div><div><dt>部门</dt><dd>${Utils.esc(item.department)}</dd></div></dl>
      <button class="btn device-group-enter" data-app-action="device-group-open" data-id="${Utils.esc(item.id)}">进入设备列表 <span aria-hidden="true">→</span></button>
    </article>`).join("");
    const body = group
      ? `<div class="grid device-card-grid">${(group.devices || []).map(device => this.deviceCardHtml(device, disabled)).join("")}
          <button type="button" class="card add-card device-add-card" data-app-action="device-add" ${disabled ? "disabled" : ""}><span class="add-card-plus" aria-hidden="true">+</span><span class="add-card-label">新增设备</span></button></div>`
      : `<div class="device-group-grid">${cards}<button class="card add-card device-group-add" data-app-action="device-group-add" ${disabled ? "disabled" : ""}><span class="device-group-plus" aria-hidden="true">＋</span><strong>新增地域－部门</strong><span>填写地域和部门，建立设备分组</span></button></div>`;
    this.replaceHtml(content, `<section class="device-warehouse">${header}${body}</section>`);
  },

  deviceStatusHtml(status = "闲置") {
    const tones = { "闲置": "idle", "使用中": "active", "维护中": "maintenance", "停用": "inactive" };
    return `<span class="device-status ${tones[status] || "inactive"}">${Utils.esc(status)}</span>`;
  },

  deviceCardHtml(device, disabled = false) {
    return `<article class="card device-entry-card">
      <div class="device-card-heading"><h3>${Utils.esc(device.name)}</h3><button type="button" class="sample-card-edit-btn" data-app-action="device-edit" data-id="${Utils.esc(device.id)}" title="编辑设备" aria-label="编辑设备 ${Utils.esc(device.name)}" ${disabled ? "disabled" : ""}>✎</button></div>
      <dl class="device-card-meta">${[["编号", device.code], ["型号", device.model], ["位置", device.location], ["负责人", device.owner]].map(([label, value]) => `<div><dt>${label}</dt><dd title="${Utils.esc(value || "")}">${Utils.esc(value || "—")}</dd></div>`).join("")}</dl>
      <div class="device-card-footer">${this.deviceStatusHtml(device.status)}<button type="button" class="btn device-card-open" data-app-action="device-open" data-id="${Utils.esc(device.id)}" aria-label="查看设备 ${Utils.esc(device.name)}">设备详情 <span aria-hidden="true">▶</span></button></div>
    </article>`;
  },

  openDevice(id) {
    const group = this.currentDeviceGroup();
    const device = group?.devices?.find(item => item.id === id);
    if (!device) return;
    this.showModal(`设备详情 · ${device.name}`, `<div class="device-detail">
      <div class="device-detail-status">${this.deviceStatusHtml(device.status)}</div>
      <dl>${[["设备编号", device.code], ["设备名称", device.name], ["型号", device.model], ["制造商", device.manufacturer], ["地域－部门", group.region + "－" + group.department], ["存放位置", device.location], ["负责人", device.owner], ["备注", device.notes]].map(([label, value]) => `<div><dt>${label}</dt><dd>${Utils.esc(value || "—")}</dd></div>`).join("")}</dl>
      </div>`, null, "关闭", { hideCancel: true, className: "device-detail-modal" });
  },

  applyDeviceWarehouseSave(result) {
    // Invalidate any list read that started before this successful save.
    this._deviceWarehouseRequest = (this._deviceWarehouseRequest || 0) + 1;
    this._deviceWarehouseLoading = false;
    this._deviceWarehouseError = "";
    this._deviceWarehouse = result.warehouse;
    if (Number.isInteger(result.previousRevision) && this.serverRevision === result.previousRevision) {
      this.serverRevision = result.revision;
      this.serverUpdatedAt = result.updated_at;
      this.updateServerStatus?.("已保存");
    }
    if (this.viewModule() === "devices") this.render();
  },

  editDevice(id = "") {
    const group = this.currentDeviceGroup();
    if (!group || this._deviceWarehouseLoading || this._deviceWarehouseError) return;
    const existing = group.devices?.find(item => item.id === id);
    if (id && !existing) return;
    const deviceId = existing?.id || Utils.id("device_");
    const expectedRevision = this._deviceWarehouse.revision;
    const fields = [["name", "设备名称", 100, "例如：恒温恒湿试验箱"], ["code", "设备编号", 80, "填写唯一设备编号"], ["model", "型号", 100, "填写设备型号"], ["manufacturer", "制造商", 100, "填写制造商"], ["location", "存放位置", 120, "例如：D1B 一楼实验室"], ["owner", "负责人", 80, "填写负责人"]];
    this.showModal(existing ? "编辑设备" : "新增设备", `<p class="device-form-group">${Utils.esc(group.region)}－${Utils.esc(group.department)}</p><div class="device-form-grid">
      ${fields.map(([key, label, limit, placeholder]) => `<div class="form-group"><label for="deviceField_${key}">${label}${["name", "code"].includes(key) ? ' <span class="device-required">*</span>' : ""}</label><input id="deviceField_${key}" maxlength="${limit}" ${["name", "code"].includes(key) ? "required" : ""} placeholder="${placeholder}" value="${Utils.esc(existing?.[key] || "")}"></div>`).join("")}
      <div class="form-group"><label for="deviceField_status">设备状态</label><select id="deviceField_status">${["闲置", "使用中", "维护中", "停用"].map(status => `<option ${status === (existing?.status || "闲置") ? "selected" : ""}>${status}</option>`).join("")}</select></div>
      <div class="form-group device-form-notes"><label for="deviceField_notes">备注</label><textarea id="deviceField_notes" rows="3" maxlength="2000" placeholder="可填写使用说明或补充信息">${Utils.esc(existing?.notes || "")}</textarea></div>
      <p class="device-group-error device-form-notes" id="deviceFormError" role="alert"></p></div>`, async () => {
      this.clearFieldValidationMarks();
      const device = { id: deviceId };
      for (const [key, label, limit] of fields) {
        const input = document.getElementById(`deviceField_${key}`);
        device[key] = input.value.trim();
        if ((["name", "code"].includes(key) && !device[key]) || device[key].length > limit) {
          this.markFieldInvalid(input, `请填写${label}（最多 ${limit} 个字符）`);
          return true;
        }
      }
      device.status = document.getElementById("deviceField_status").value;
      device.notes = document.getElementById("deviceField_notes").value.trim();
      const errorEl = document.getElementById("deviceFormError");
      errorEl.textContent = "";
      try {
        const res = await fetch("/api/device-warehouse", { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision, groupId: group.id, device }) });
        const result = await res.json();
        if (!res.ok || !result.ok) throw new Error(result.error || "设备保存失败，请重试");
        this.applyDeviceWarehouseSave(result);
        return false;
      } catch (error) {
        errorEl.textContent = error.message;
        return true;
      }
    }, "保存", { className: "device-detail-modal" });
  },

  openDeviceGroup(id) {
    if (!this._deviceWarehouse?.groups?.some(group => group.id === id)) return;
    this.view.selectedDeviceGroupId = id;
    this.render();
  },

  editDeviceGroup(id = "") {
    if (!this._deviceWarehouse || this._deviceWarehouseLoading || this._deviceWarehouseError) return;
    const existing = this._deviceWarehouse.groups.find(group => group.id === id);
    if (id && !existing) return;
    const groupId = existing?.id || Utils.id("device_group_");
    const expectedRevision = this._deviceWarehouse.revision;
    this.showModal(existing ? "编辑地域－部门" : "新增地域－部门", `
      <div class="device-group-form">
        <div class="form-group"><label for="deviceRegion">地域</label><input id="deviceRegion" maxlength="80" required placeholder="例如：深圳" value="${Utils.esc(existing?.region || "")}"></div>
        <div class="form-group"><label for="deviceDepartment">部门</label><input id="deviceDepartment" maxlength="80" required placeholder="例如：可靠性实验室" value="${Utils.esc(existing?.department || "")}"></div>
        <p class="device-group-error" id="deviceGroupError" role="alert"></p>
      </div>`, async () => {
      this.clearFieldValidationMarks();
      const regionEl = document.getElementById("deviceRegion");
      const departmentEl = document.getElementById("deviceDepartment");
      const region = regionEl.value.trim(), department = departmentEl.value.trim();
      if (!region || region.length > 80) { this.markFieldInvalid(regionEl, "请填写地域（1–80 个字符）"); return true; }
      if (!department || department.length > 80) { this.markFieldInvalid(departmentEl, "请填写部门（1–80 个字符）"); return true; }
      const errorEl = document.getElementById("deviceGroupError");
      errorEl.textContent = "";
      try {
        const res = await fetch("/api/device-warehouse", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision, group: { id: groupId, region, department } })
        });
        const result = await res.json();
        if (!res.ok || !result.ok) throw new Error(result.error || "保存失败，请重试");
        this.applyDeviceWarehouseSave(result);
        return false;
      } catch (error) {
        errorEl.textContent = error.message;
        return true;
      }
    }, "保存", { className: "device-group-modal" });
  }
});
