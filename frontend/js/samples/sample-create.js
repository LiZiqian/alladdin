/* 样机档案初始化、编号与新增表单。身份查重前后均需重新确认当前对象；正式写入走样机池增量 API。
 * 通过 app.registerModule 暴露方法；页面结构与业务规则沿用原实现。
 */
app.registerModule("samples.sample-create", {

  newSample(catId, sampleNo, sn, imei, sourceInfo = {}) {
    return {
      id: Utils.id("sample_"),
      categoryId: catId,
      sampleNo: sampleNo || `TMP-${Date.now()}`,
      sn: sn || "",
      imei: imei || "",
      boardSn: sourceInfo.boardSn || "",
      isReassembled: this.sampleIsReassembled(sourceInfo),
      model: sourceInfo.platform || "",
      config: sourceInfo.standard || "",
      schemeNo: sourceInfo.schemeNo || "",
      problemRecords: (sourceInfo.problemRecords || []).filter(record => !Utils.isNoSampleIssueText(record.description)),
      status: sourceInfo.status || "闲置",
      location: sourceInfo.location || "",
      owner: sourceInfo.owner || "",
      borrower: sourceInfo.borrower || "",
      borrowDate: sourceInfo.borrowDate || "",
      tag: sourceInfo.tag || "",
      sourceType: sourceInfo.sourceType || "manual",
      sourceProjectId: null,
      sourceProjectName: "",
      sourceStageId: null,
      sourceStageName: sourceInfo.stage || "Unknown",
      sourceSkuIndex: null,
      sourceSkuName: sourceInfo.skuName || sourceInfo.standard || "Unknown",
      currentProjectId: null, currentStageId: null, currentTaskId: null, currentTestItem: "",
      notes: sourceInfo.notes || "",
      importDate: sourceInfo.importDate || Utils.today(),
      photos: [],
      createdAt: Utils.now(), updatedAt: Utils.now(),
      logs: []
    };
  },

  nextSampleNo(category, prefix, offset = 0) {
    const existing = new Set((category.samples || []).map(s => String(s.sampleNo || "")));
    let n = (category.samples || []).length + 1 + offset;
    let no = `${prefix}-${String(n).padStart(3, "0")}`;
    while (existing.has(no)) { n++; no = `${prefix}-${String(n).padStart(3, "0")}`; }
    return no;
  },

  async addSample(catId) {
    const request = this.beginDialogRequest?.();
    const module = this.viewModule?.();
    const modalSequence = this._modalSequence;
    const context = this.ensureSamplePersonContextLoaded?.();
    if (context?.then && !await context) return;
    if (this.viewModule?.() !== module || this._modalSequence !== modalSequence) return;
    if (this.isDialogRequestCurrent?.(request) === false) return;
    if (!this.sampleCategoryRecords().some(category => category.id === catId)) return;
    this.showModal("新增样机", `
      <div style="display:flex;flex-direction:column;gap:18px">
        <div class="form-row sample-id-row" style="gap:14px">
          <div class="form-group" style="margin-bottom:0"><label>SN</label><input id="sampleSn" placeholder="请输入SN号"></div>
          <div class="form-group" style="margin-bottom:0"><label>IMEI</label><input id="sampleImei" placeholder="请输入IMEI号"></div>
          <div class="form-group" style="margin-bottom:0"><label>主板SN</label><input id="sampleBoardSn" placeholder="请输入主板SN"></div>
        </div>
        <div class="form-row form-row-three" style="gap:14px">
          <div class="form-group" style="margin-bottom:0"><label>阶段</label><input id="sampleStage" placeholder="如 V3-1"></div>
          <div class="form-group" style="margin-bottom:0"><label>方案（制式/配置/型号/SKU）</label><input id="sampleConfig" placeholder="如 VXN-XX 或 SKU2"></div>
          <div class="form-group" style="margin-bottom:0"><label>方案编号</label><input id="sampleSchemeNo" placeholder="如 B1 或 1"></div>
        </div>
        <div class="form-row form-row-three" style="gap:14px">
          <div class="form-group" style="margin-bottom:0"><label>样机状态</label><select id="sampleStatus">${this.constants.sampleStatuses.map(x => `<option ${x === "闲置" ? "selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="form-group" style="margin-bottom:0"><label>重组样机</label><select id="sampleReassembled"><option value="否" selected>否</option><option value="是">是</option></select></div>
          <div class="form-group" style="margin-bottom:0"><label>位置</label>${this.sampleLocationInputHtml("sampleLocation", "")}</div>
        </div>
        <div class="form-row" style="gap:14px">
          <div class="form-group" style="margin-bottom:0"><label>挂账人</label>${this.samplePersonInputHtml("sampleOwner", "", "姓名/工号", { scope: "all" })}</div>
          <div class="form-group" style="margin-bottom:0"><label>持有人/取走人</label>${this.samplePersonInputHtml("sampleBorrower", "", "姓名/工号", { scope: "developer" })}</div>
        </div>
        <div class="form-group" style="margin-bottom:0"><label>其他备注信息</label><textarea id="sampleNotes" rows="1" style="min-height:38px;height:38px"></textarea></div>
        <div class="sample-info-divider" style="margin:4px 0"></div>
        <div class="form-group" style="margin-bottom:0"><label>样机问题表</label>${this.sampleProblemsHtml("sampleInitialResults", [])}</div>
      </div>
    `, async () => {
      this.clearFieldValidationMarks();
      const category = this.sampleCategoryRecords().find(x => x.id === catId);
      if (!category) return;
      const sn = document.getElementById("sampleSn").value.trim();
      const imei = document.getElementById("sampleImei").value.trim();
      const boardSn = document.getElementById("sampleBoardSn").value.trim();
      const isReassembled = document.getElementById("sampleReassembled").value === "是";
      if (!sn && !imei && !boardSn) {
        this.markFieldInvalid(document.getElementById("sampleSn"), "SN、IMEI 和主板SN至少需要填写一个。");
        this.markFieldInvalid(document.getElementById("sampleImei"), "SN、IMEI 和主板SN至少需要填写一个。");
        this.markFieldInvalid(document.getElementById("sampleBoardSn"), "SN、IMEI 和主板SN至少需要填写一个。");
        return true;
      }
      const stage = document.getElementById("sampleStage").value.trim();
      const config = document.getElementById("sampleConfig").value.trim();
      const problemRecords = this.collectSampleProblems("sampleInitialResults");
      const location = document.getElementById("sampleLocation").value.trim();

      // 人员字段校验（复用全局 parsePersonField）
      const ownerEl = document.getElementById("sampleOwner");
      const borrowerEl = document.getElementById("sampleBorrower");
      const ownerRaw = ownerEl.value.trim();
      const borrowerRaw = borrowerEl?.value.trim() || "";
      let ownerText = "", borrowerText = "";
      if (ownerRaw) {
        const check = this.collectSamplePersonValue(ownerEl, "all", "挂账人");
        if (!check.ok) { this.markFieldInvalid(ownerEl, check.msg); return true; }
        ownerText = check.value;
      }
      if (borrowerRaw) {
        const check = this.collectSamplePersonValue(borrowerEl, "developer", "持有人/取走人");
        if (!check.ok) { this.markFieldInvalid(borrowerEl, check.msg); return true; }
        borrowerText = check.value;
      }

      if (!Array.isArray(category.samples)) category.samples = [];

      // 自校验：同一台样机的 SN/IMEI/主板SN 互不相同
      const selfDup = this.validateSampleSelfDuplicate(sn, imei, boardSn, "sample");
      if (selfDup) { this.markFieldInvalid(document.getElementById(selfDup.field), selfDup.msg); return true; }

      const epoch = this._dataSnapshotEpoch || 0;
      try {
        const duplicate = await this._checkServerIdentityDuplicate(sn, imei, boardSn, isReassembled, catId, "", "sample");
        if ((this._dataSnapshotEpoch || 0) !== epoch || this.sampleCategoryRecords().find(item => item.id === catId) !== category) return true;
        if (duplicate) { this.markFieldInvalid(document.getElementById(duplicate.fieldId), duplicate.msg); return true; }
      } catch (e) {
        alert("样机身份查重失败：" + (e.message || e));
        return true;
      }
      const snapshot = this.dataSnapshot();
      const sample = this.newSample(catId, sn || imei || boardSn, sn, imei, {
        stage,
        boardSn,
        isReassembled,
        standard: config,
        schemeNo: document.getElementById("sampleSchemeNo").value.trim(),
        problemRecords,
        status: document.getElementById("sampleStatus").value,
        location,
        owner: ownerText,
        borrower: borrowerText,
        notes: document.getElementById("sampleNotes").value.trim(),
        sourceType: "manual"
      });
      category.samples.push(sample);
      const saved = await this.commitSampleCategoryMutation(category, {
        action: "create_sample",
        remark: "新增样机",
        user: "管理员",
        createSamples: true,
        samples: [sample]
      });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("已新增 1 台样机。");
      return false;
    });
    const footer = document.querySelector(".modal-footer");
    if (footer && !document.getElementById("sampleArchiveImportFromAddBtn")) {
      const importBtn = document.createElement("button");
      importBtn.type = "button";
      importBtn.id = "sampleArchiveImportFromAddBtn";
      importBtn.className = "btn btn-outline modal-extra-action sample-add-archive-import-btn";
      importBtn.dataset.appAction = "sample-archive-import";
      importBtn.dataset.id = catId || "";
      importBtn.textContent = "导入样机档案";
      footer.insertBefore(importBtn, footer.firstChild);
    }
  },

  addSamples(catId) {
    this.addSample(catId);
  },

  // ---- 模板导入 ----,

});
