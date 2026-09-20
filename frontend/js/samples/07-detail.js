/* ========================================
   TestChamber V7 - Sample detail modal
   Split from the previous monolithic module.
   ======================================== */

app.registerModule("samples.detail", {

  openSampleDetail(sampleId, options = {}) {
    const found = this.findSample(sampleId);
    if (!found) return;
    const hadLocalUnsavedChanges = this.hasLocalUnsavedChanges?.() === true;
    this._activeSampleDetailId = sampleId;
    const readonly = !!options.readonly;
    const s = found.sample;
    const summaryStatus = this.sampleEffectiveStatus(s) || "—";
    const summaryStatusClass = summaryStatus === "—" ? "待确认" : summaryStatus;
    this.showModal("样机详情 · " + this.sampleDisplayCode(s), `
      <div class="sample-summary-bar">
        <div class="sample-summary-card"><span class="sample-summary-label">档案编号</span><b class="sample-summary-value">${Utils.esc(this.sampleDisplayCode(s))}</b></div>
        <div class="sample-summary-card"><span class="sample-summary-label">质量</span><b class="sample-summary-value" style="color:var(--status-sample-quality-${this.sampleHasProblem(s) ? 'fault' : 'ok'}-text)">${this.sampleHasProblem(s) ? '有故障' : '无故障'}</b></div>
        <div class="sample-summary-card"><span class="sample-summary-label">重组样机</span><b class="sample-summary-value" style="color:var(--status-sample-reassembly-${this.sampleIsReassembled(s) ? 'reassembled' : 'normal'}-text)">${this.sampleIsReassembled(s) ? '是' : '否'}</b></div>
        <div class="sample-summary-card"><span class="sample-summary-label">当前状态</span><b class="sample-summary-value sample-summary-status s-${Utils.esc(summaryStatusClass)}">${Utils.esc(summaryStatus)}</b></div>
        <div class="sample-summary-card"><span class="sample-summary-label">当前任务</span><b class="sample-summary-value">${Utils.esc(s.currentTestItem || "—")}</b></div>
      </div>
      <div class="sample-archive-shell">
        <aside class="sample-archive-nav">
          <button type="button" class="active" data-sample-archive-tab="info" data-app-action="sample-archive-tab" data-tab="info">样机信息</button>
          <button type="button" data-sample-archive-tab="history" data-app-action="sample-archive-tab" data-tab="history">测试履历</button>
          <button type="button" data-sample-archive-tab="photos" data-app-action="sample-archive-tab" data-tab="photos">图片数据</button>
          <button type="button" data-sample-archive-tab="ct" data-app-action="sample-archive-tab" data-tab="ct">CT三维数据</button>
          <button type="button" data-sample-archive-tab="other" data-app-action="sample-archive-tab" data-tab="other">其他</button>
          <button type="button" class="sample-archive-export-nav" id="sampleArchiveExportBtn" data-app-action="sample-archive-export" data-id="${Utils.esc(sampleId)}">导出样机档案</button>
        </aside>
        <div class="sample-archive-content">
          <section class="sample-archive-panel active" data-sample-archive-panel="info">
            <div style="display:flex;flex-direction:column;gap:16px">
              <div class="form-row sample-id-row">
                <div class="form-group" style="margin-bottom:0"><label>SN</label><input id="sdSn" value="${Utils.esc(s.sn || "")}" placeholder="序列号"></div>
                <div class="form-group" style="margin-bottom:0"><label>IMEI</label><input id="sdImei" value="${Utils.esc(s.imei || "")}" placeholder="IMEI号"></div>
                <div class="form-group" style="margin-bottom:0"><label>主板SN</label><input id="sdBoardSn" value="${Utils.esc(s.boardSn || "")}" placeholder="主板序列号"></div>
              </div>
              ${this.sampleReassemblySourcesHtml(s)}
              <div class="form-row form-row-three">
                <div class="form-group" style="margin-bottom:0"><label>阶段</label><input id="sdStage" value="${Utils.esc(s.sourceStageName || "")}" placeholder="如 V3-1"></div>
                <div class="form-group" style="margin-bottom:0"><label>方案</label><input id="sdConfig" value="${Utils.esc(s.config || s.model || "")}" placeholder="制式/配置/型号/SKU"></div>
                <div class="form-group" style="margin-bottom:0"><label>方案编号</label><input id="sdSchemeNo" value="${Utils.esc(s.schemeNo || "")}" placeholder="如 B1"></div>
              </div>
              <div class="form-row form-row-three">
                <div class="form-group" style="margin-bottom:0"><label>样机状态</label><select id="sdStatus">${this.constants.sampleStatuses.map(x => `<option ${s.status === x ? 'selected' : ''}>${x}</option>`).join("")}</select></div>
                <div class="form-group" style="margin-bottom:0"><label>重组样机</label><select id="sdReassembled"><option value="否" ${!this.sampleIsReassembled(s) ? 'selected' : ''}>否</option><option value="是" ${this.sampleIsReassembled(s) ? 'selected' : ''}>是</option></select></div>
                <div class="form-group" style="margin-bottom:0"><label>当前位置</label>${this.sampleLocationInputHtml("sdLocation", s.location || "")}</div>
              </div>
              <div class="form-row">
                <div class="form-group" style="margin-bottom:0"><label>挂账人</label>${this.samplePersonInputHtml("sdOwner", s.owner || "", "姓名/工号", { scope: "all", sample: s })}</div>
                <div class="form-group" style="margin-bottom:0"><label>持有人/取走人</label>${this.samplePersonInputHtml("sdBorrower", s.borrower || "", "姓名/工号", { scope: "developer", sample: s })}</div>
              </div>
              <div class="form-group" style="margin-bottom:0"><label>其他备注信息</label><textarea id="sdNotes" rows="2" style="min-height:56px">${Utils.esc(s.notes || "")}</textarea></div>
              <div class="sample-info-divider"></div>
              <div class="form-group" style="margin-bottom:0"><label>样机问题表</label>${this.sampleProblemsHtml("sdInitialResults", this.sampleProblemRecords(s))}</div>
            </div>
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="photos">
            ${this.samplePhotosHtml(s)}
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="history">
            ${this.sampleTestHistoryHtml(s.id)}
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="ct">
            ${this.sampleArchivePlaceholder("暂无CT数据", "后续可在这里归档CT图像、扫描批次、结构分析结论等数据。")}
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="other">
            ${this.sampleArchivePlaceholder("暂无内容", "其他功能模块尚未定义，后续可在此处扩展。")}
          </section>
        </div>
      </div>
    `, async () => {
      if (readonly) return false;
      this.clearFieldValidationMarks();
      const newSn = document.getElementById("sdSn").value.trim();
      const newImei = document.getElementById("sdImei").value.trim();
      const newBoardSn = document.getElementById("sdBoardSn").value.trim();
      const nextReassembled = document.getElementById("sdReassembled").value === "是";
      if (!newSn && !newImei && !newBoardSn) {
        this.markFieldInvalid(document.getElementById("sdSn"), "SN、IMEI 和主板SN至少需要填写一个。");
        this.markFieldInvalid(document.getElementById("sdImei"), "SN、IMEI 和主板SN至少需要填写一个。");
        this.markFieldInvalid(document.getElementById("sdBoardSn"), "SN、IMEI 和主板SN至少需要填写一个。");
        return true;
      }

      const newIdentity = { sn: newSn, imei: newImei, boardSn: newBoardSn };
      const identityChanged = this.sampleIdentifierSignature(s) !== this.sampleIdentifierSignature(newIdentity);
      const reassembledChanged = this.sampleIsReassembled(s) !== nextReassembled;
      // 自校验：同一台样机的 SN/IMEI/主板SN 互不相同
      const selfDup = this.validateSampleSelfDuplicate(newSn, newImei, newBoardSn, "sd");
      if (selfDup) { this.markFieldInvalid(document.getElementById(selfDup.field), selfDup.msg); return true; }

      if (identityChanged || reassembledChanged) {
        try {
          const duplicate = await this._checkServerIdentityDuplicate(newSn, newImei, newBoardSn, nextReassembled, found.category.id, s.id, "sd");
          if (duplicate) { this.markFieldInvalid(document.getElementById(duplicate.fieldId), duplicate.msg); return true; }
        } catch (e) {
          alert("样机身份查重失败：" + (e.message || e));
          return true;
        }
      }
      const location = document.getElementById("sdLocation").value.trim();

      // 人员字段校验（复用全局 parsePersonField）
      const sdOwnerEl = document.getElementById("sdOwner");
      const sdBorrowerEl = document.getElementById("sdBorrower");
      const sdOwnerRaw = sdOwnerEl.value.trim();
      const sdBorrowerRaw = sdBorrowerEl?.value.trim() || "";
      if (sdOwnerRaw) {
        const check = this.collectSamplePersonValue(sdOwnerEl, "all", "挂账人");
        if (!check.ok) { this.markFieldInvalid(sdOwnerEl, check.msg); return true; }
      }
      if (sdBorrowerRaw) {
        const check = this.collectSamplePersonValue(sdBorrowerEl, "developer", "持有人/取走人");
        if (!check.ok) { this.markFieldInvalid(sdBorrowerEl, check.msg); return true; }
      }

      const snapshot = this.dataSnapshot();
      const previousRoute = {
        status: this.sampleEffectiveStatus(s),
        location: String(s.location || "").trim(),
        owner: this.normalizePersonText(s.owner || ""),
        borrower: this.normalizePersonText(s.borrower || "")
      };
      s.sn = newSn;
      s.imei = newImei;
      s.boardSn = newBoardSn;
      s.isReassembled = nextReassembled;
      s.sampleNo = newSn || newImei || newBoardSn || s.sampleNo;
      s.model = "";
      s.config = document.getElementById("sdConfig").value.trim();
      s.schemeNo = document.getElementById("sdSchemeNo").value.trim();
      s.problemRecords = this.collectSampleProblems("sdInitialResults");
      s.initialResults = s.problemRecords.map(x => x.description);
      s.initialResult = s.initialResults.join("\n");
      s.sourceStageName = document.getElementById("sdStage").value.trim();
      s.sourceSkuName = s.config || "Unknown";
      // 人员字段已在上面校验通过，此处规范化为 姓名/工号
      const ownerText = sdOwnerRaw ? this.collectSamplePersonValue(sdOwnerEl, "all", "挂账人").value : "";
      const borrowerText = sdBorrowerRaw ? this.collectSamplePersonValue(sdBorrowerEl, "developer", "持有人/取走人").value : "";
      const nextStatus = document.getElementById("sdStatus").value;
      if (s.status !== nextStatus) {
        this.changeSampleStatus(s.id, nextStatus, {
          user: "管理员",
          source: "样机详情编辑",
          reason: "手动编辑样机详情",
          receiver: borrowerText,
          accountOwner: ownerText,
          destLocation: location,
          forceLog: true
        });
      } else {
        s.owner = ownerText;
        s.borrower = borrowerText;
        s.location = location;
        const nextRoute = {
          status: this.sampleEffectiveStatus(s),
          location: String(s.location || "").trim(),
          owner: this.normalizePersonText(s.owner || ""),
          borrower: this.normalizePersonText(s.borrower || "")
        };
        const valueText = value => String(value || "").trim() || "空";
        const detailParts = [];
        if (previousRoute.location !== nextRoute.location) detailParts.push(`位置：${valueText(previousRoute.location)} → ${valueText(nextRoute.location)}`);
        if (previousRoute.owner !== nextRoute.owner) detailParts.push(`挂账人：${valueText(previousRoute.owner)} → ${valueText(nextRoute.owner)}`);
        if (previousRoute.borrower !== nextRoute.borrower) detailParts.push(`取走人：${valueText(previousRoute.borrower)} → ${valueText(nextRoute.borrower)}`);
        if (detailParts.length) {
          this.sampleEventRecords().push(this.createSampleEventLog(s, previousRoute.status, nextRoute.status, nextRoute.status, {
            user: "管理员",
            source: "样机详情编辑",
            reason: "手动编辑样机详情",
            detail: detailParts.join("；"),
            destination: nextRoute.status,
            destLocation: nextRoute.location,
            receiver: nextRoute.borrower,
            accountOwner: nextRoute.owner
          }));
        }
      }
      s.location = location;
      s.notes = document.getElementById("sdNotes").value.trim();
      s.updatedAt = Utils.now();
      const saved = await this.commitSampleMutation(s, {
        action: "sample_detail_update",
        remark: "样机详情编辑",
        user: "管理员"
      });
      if (!saved) {
        this.restoreDataSnapshot(snapshot);
        return true;
      }
      Utils.toast("样机详情已保存");
      return false;
    }, readonly ? (options.readonlyOkText || "关闭") : "确认", { hideCancel: readonly, headerHint: readonly ? "只读查看，不能编辑" : "" });
    // 在 footer 最左边注入 tab 说明文字
    const footer = document.querySelector(".modal-footer");
    if (footer && !document.getElementById("sampleArchiveFooterHint")) {
      const hint = document.createElement("span");
      hint.className = "modal-extra-action";
      hint.id = "sampleArchiveFooterHint";
      hint.textContent = "查看与编辑样机的基本档案，包括身份标识、当前状态、存放位置、人员归属及初检问题记录。";
      footer.insertBefore(hint, footer.firstChild);
    }
    document.querySelector(".modal")?.classList.add("sample-archive-modal");
    if (!hadLocalUnsavedChanges) this.markDataSynced?.();
    if (readonly) {
      const body = document.getElementById("modalBody");
      body?.querySelectorAll(".sample-archive-content input, .sample-archive-content select, .sample-archive-content textarea").forEach(el => { el.disabled = true; });
      body?.querySelectorAll(".sample-archive-content button:not(.sample-history-photo):not(.sample-photo-thumb):not(.sample-history-summary):not(.sample-reassembly-link):not(.sample-history-page-btn)").forEach(el => { el.disabled = true; });
    }
  },

  refreshSampleArchivePanels(sampleId) {
    if (this._activeSampleDetailId !== sampleId) return;
    const sample = this.findSample(sampleId)?.sample;
    if (!sample) return;
    const photosPanel = document.querySelector('[data-sample-archive-panel="photos"]');
    if (photosPanel) this.replaceHtml(photosPanel, this.samplePhotosHtml(sample));
    const historyPanel = document.querySelector('[data-sample-archive-panel="history"]');
    if (historyPanel) this.replaceHtml(historyPanel, this.sampleTestHistoryHtml(sampleId));
  },

});
