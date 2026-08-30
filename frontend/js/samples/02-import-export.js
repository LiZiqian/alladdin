/* ========================================
   TestChamber V7 - Sample import, export, and duplicate checks
   Split from the previous monolithic module.
   ======================================== */

app.registerModule("samples.importExport", {

  async importSampleBatch(catId) {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv";
    input.addEventListener("change", e => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader();
      r.addEventListener("load", async () => {
        const isXlsx = /\.xlsx$/i.test(file.name);
        const result = isXlsx ? await Utils.parseSampleImportXlsx(r.result) : Utils.parseSampleImportCsv(r.result);
        if (result.error) { alert("模板解析失败：" + result.error); return; }
        if (!result.rows.length) { alert("模板中没有有效数据行。"); return; }

        const category = this.sampleCategoryRecords().find(x => x.id === catId);
        if (!category) return;
        if (!Array.isArray(category.samples)) category.samples = [];

        const snapshot = this.dataSnapshot();
        let imported = 0, skippedDup = 0, skippedGlobal = 0;
        const importedSamples = [];
        const localDupIndexes = new Set();
        const seenIdentifiers = new Map();
        result.rows.forEach((row, idx) => {
          if (this.sampleIsReassembled(row)) return;
          const identifiers = [row.sn, row.imei, row.boardSn]
            .map(value => String(value || "").trim().toLowerCase())
            .filter(Boolean);
          if (new Set(identifiers).size !== identifiers.length) {
            localDupIndexes.add(idx);
            return;
          }
          for (const ident of identifiers) {
            if (seenIdentifiers.has(ident)) {
              localDupIndexes.add(idx);
              return;
            }
            seenIdentifiers.set(ident, idx);
          }
        });
        let serverConflicts = new Map();
        try {
          const check = await this.checkSampleIdentityConflicts(
            result.rows.map((row, idx) => ({
              index: idx,
              categoryId: catId,
              sn: row.sn,
              imei: row.imei,
              boardSn: row.boardSn,
              isReassembled: row.isReassembled
            })),
            { categoryId: catId }
          );
          serverConflicts = new Map((check.results || [])
            .filter(item => item?.hasConflict && item.conflict)
            .map(item => [Number(item.index), item.conflict]));
        } catch (e) {
          alert("样机身份查重失败：" + (e.message || e));
          return;
        }
        result.rows.forEach((row, idx) => {
          // 用 IMEI 或 SN 作为样机编号
          const sampleNo = row.sn || row.imei || row.boardSn || this.nextSampleNo(category, row.stage || "CSV", idx);
          if (localDupIndexes.has(idx)) { skippedDup++; return; }
          const serverDup = serverConflicts.get(idx);
          if (serverDup) {
            if (serverDup.scope === "category") skippedDup++;
            else skippedGlobal++;
            return;
          }
          const location = String(row.location || "").trim();
          const initialResults = Utils.parseSampleIssueText(row.initialResult);
          const normalizedStatus = this.normalizeSampleStatusValue(row.status);
          const sample = this.newSample(catId, sampleNo, row.sn, row.imei, {
            stage: row.stage,
            boardSn: row.boardSn,
            isReassembled: row.isReassembled,
            skuName: row.skuName || row.standard || "Unknown",
            standard: row.standard,
            platform: row.platform || "",
            schemeNo: row.schemeNo,
            initialResult: row.initialResult,
            initialResults,
            problemRecords: initialResults.map(desc => ({ id: Utils.id("problem_"), description: desc, source: "初检", taskLabel: "" })),
            status: this.constants.sampleStatuses.includes(normalizedStatus) ? normalizedStatus : "闲置",
            location,
            tag: row.tag,
            owner: row.owner,
            borrower: row.borrower,
            borrowDate: row.borrowDate,
            notes: row.notes,
            importDate: row.importDate,
            sourceType: isXlsx ? "xlsx_import" : "csv_import"
          });
          category.samples.push(sample);
          importedSamples.push(sample);
          imported++;
        });

        if (importedSamples.length) {
          const saved = await this.commitSampleCategoryMutation(category, {
            action: "import_samples",
            remark: "批量导入样机",
            user: "管理员",
            createSamples: true,
            samples: importedSamples
          });
          if (!saved) {
            this.restoreDataSnapshot(snapshot);
            return;
          }
        }
        const warn = result.invalidPersonCount
          ? `；其中 ${result.invalidPersonCount} 个挂账人或持有人字段格式不合法，已按空处理`
          : "";
        const globalWarn = skippedGlobal ? `，跳过 ${skippedGlobal} 条因跨池标识冲突` : "";
        Utils.toast(`已从模板导入 ${imported} 台样机${skippedDup ? `，跳过 ${skippedDup} 条重复样机` : ""}${globalWarn}${warn}。`);
      }, { once: true });
      if (/\.xlsx$/i.test(file.name)) r.readAsArrayBuffer(file);
      else r.readAsText(file, "utf-8");
    }, { once: true });
    input.click();
  },

  importSampleCsv(catId) {
    this.importSampleBatch(catId);
  },

  sampleIdentifierSet(sample = {}) {
    return new Set([sample.sn, sample.imei, sample.boardSn]
      .map(v => String(v || "").trim().toLowerCase())
      .filter(Boolean));
  },

  sampleIdentifierSignature(sample = {}) {
    return [...this.sampleIdentifierSet(sample)].sort().join("|");
  },

  findDuplicateSampleInCategory(category, row = {}, excludeSampleId = "") {
    const incoming = this.sampleIdentifierSet(row);
    if (!incoming.size) return null;
    const incomingReassembled = this.sampleIsReassembled(row);
    return (category.samples || []).find(sample => {
      if (excludeSampleId && sample.id === excludeSampleId) return false;
      if (incomingReassembled || this.sampleIsReassembled(sample)) return false;
      const existing = this.sampleIdentifierSet(sample);
      return [...incoming].some(id => existing.has(id));
    }) || null;
  },

  /** 跨所有样机池查找 SN/IMEI/主板SN 重复的样机（每个标识只能在全局存在一份） */

  findDuplicateSampleGlobally(row = {}, excludeCategoryId = "", excludeSampleId = "") {
    const incoming = this.sampleIdentifierSet(row);
    if (!incoming.size) return null;
    const incomingReassembled = this.sampleIsReassembled(row);
    for (const cat of this.sampleCategoryRecords()) {
      if (cat.id === excludeCategoryId) continue;
      for (const sample of (cat.samples || [])) {
        if (excludeSampleId && sample.id === excludeSampleId) continue;
        if (incomingReassembled || this.sampleIsReassembled(sample)) continue;
        const existing = this.sampleIdentifierSet(sample);
        const conflict = [...incoming].find(id => existing.has(id));
        if (conflict) return { category: cat, sample, conflictId: conflict };
      }
    }
    return null;
  },

  /** 根据标识值定位到对应输入框 ID（内部用，不依赖 truthy 检查空串） */

  _fieldIdByIdentifier(identValue, sn, imei, boardSn, idPrefix) {
    const v = String(identValue || "").toLowerCase();
    if (v && String(sn || "").toLowerCase() === v) return `${idPrefix}Sn`;
    if (v && String(imei || "").toLowerCase() === v) return `${idPrefix}Imei`;
    if (v && String(boardSn || "").toLowerCase() === v) return `${idPrefix}BoardSn`;
    return `${idPrefix}Sn`;
  },

  /** 标识值对应的中文标签 */

  _labelByIdentifier(identValue, sn, imei, boardSn) {
    const v = String(identValue || "").toLowerCase();
    if (v && String(sn || "").toLowerCase() === v) return "SN";
    if (v && String(imei || "").toLowerCase() === v) return "IMEI";
    if (v && String(boardSn || "").toLowerCase() === v) return "主板SN";
    return "标识";
  },

  /** 同一台样机不允许 SN=IMEI 或 SN=主板SN 或 IMEI=主板SN（均非空时） */

  validateSampleSelfDuplicate(sn, imei, boardSn, idPrefix) {
    const a = String(sn || "").trim(), b = String(imei || "").trim(), c = String(boardSn || "").trim();
    if (a && b && a.toLowerCase() === b.toLowerCase())
      return { field: `${idPrefix}Imei`, msg: `IMEI 不能与 SN 相同，每台样机的各个身份标识必须互不相同。` };
    if (a && c && a.toLowerCase() === c.toLowerCase())
      return { field: `${idPrefix}BoardSn`, msg: `主板SN 不能与 SN 相同，每台样机的各个身份标识必须互不相同。` };
    if (b && c && b.toLowerCase() === c.toLowerCase())
      return { field: `${idPrefix}BoardSn`, msg: `主板SN 不能与 IMEI 相同，每台样机的各个身份标识必须互不相同。` };
    return null;
  },

  /** 冲突值在已有样机中对应哪个标识类型（用于提示"与对方的 SN/IMEI/主板SN 相同"） */

  _existingLabelForConflict(conflictVal, existingSample) {
    return this._labelByIdentifier(conflictVal, existingSample.sn, existingSample.imei, existingSample.boardSn);
  },

  /** 池内重复：返回 { fieldId, msg } */

  _checkInCategoryDuplicate(category, sn, imei, boardSn, isReassembled, excludeSampleId, idPrefix) {
    const dupSample = this.findDuplicateSampleInCategory(category, { sn, imei, boardSn, isReassembled }, excludeSampleId);
    if (!dupSample) return null;
    const dupIds = this.sampleIdentifierSet({ sn, imei, boardSn });
    const existIds = this.sampleIdentifierSet(dupSample);
    const conflictVal = [...dupIds].find(id => existIds.has(id)) || "";
    const existingLabel = this._existingLabelForConflict(conflictVal, dupSample);
    return {
      fieldId: this._fieldIdByIdentifier(conflictVal, sn, imei, boardSn, idPrefix),
      msg: `于本样机池【${this.sampleDisplayCode(dupSample)}】的 ${existingLabel} 相同`
    };
  },

  /** 跨池重复：返回 { fieldId, msg } */

  _checkGlobalDuplicate(sn, imei, boardSn, isReassembled, excludeCategoryId, excludeSampleId, idPrefix) {
    const globalDup = this.findDuplicateSampleGlobally({ sn, imei, boardSn, isReassembled }, excludeCategoryId, excludeSampleId);
    if (!globalDup) return null;
    const existingLabel = this._existingLabelForConflict(globalDup.conflictId, globalDup.sample);
    const poolName = globalDup.category.name;
    const code = this.sampleDisplayCode(globalDup.sample);
    return {
      fieldId: this._fieldIdByIdentifier(globalDup.conflictId, sn, imei, boardSn, idPrefix),
      msg: `于「${poolName}」池【${code}】的 ${existingLabel} 相同`
    };
  },

  sampleIdentityConflictValidation(conflict, sn, imei, boardSn, idPrefix) {
    if (!conflict) return null;
    const fieldId = conflict.incomingField
      ? `${idPrefix}${conflict.incomingField === "sn" ? "Sn" : conflict.incomingField === "imei" ? "Imei" : "BoardSn"}`
      : this._fieldIdByIdentifier(conflict.conflictId, sn, imei, boardSn, idPrefix);
    const scope = conflict.scope === "category"
      ? "本样机池"
      : `「${conflict.categoryName || "-"}」池`;
    const code = conflict.sample?.code || this.sampleDisplayCode(conflict.sample || {});
    const label = conflict.existingLabel || this._existingLabelForConflict(conflict.conflictId, conflict.sample || {});
    return {
      fieldId,
      msg: `于${scope}【${code}】的 ${label} 相同`
    };
  },

  async _checkServerIdentityDuplicate(sn, imei, boardSn, isReassembled, categoryId, excludeSampleId, idPrefix) {
    const check = await this.checkSampleIdentityConflicts([{
      index: 0,
      categoryId,
      excludeSampleId,
      sn,
      imei,
      boardSn,
      isReassembled
    }], { categoryId });
    const conflict = (check.results || []).find(item => item?.hasConflict)?.conflict;
    return this.sampleIdentityConflictValidation(conflict, sn, imei, boardSn, idPrefix);
  },

  downloadSampleTemplate() {
    const a = document.createElement("a");
    a.href = "/templates/sample_import_template.xlsx";
    a.download = "样机批量导入模板.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  exportSampleCsv() {
    const rows = [["类别", "带入时间", "显示编号", "SN", "IMEI", "主板SN", "是否重组样机", "型号/方案", "配置/制式", "方案编号", "样机问题表", "阶段", "SKU/版本", "状态", "位置", "挂账人", "持有人", "借用时间", "标签", "备注"]];
    this.sampleCategoryRecords().forEach(c => (c.samples || []).forEach(s =>
      rows.push([c.name, s.importDate || "", this.sampleDisplayCode(s), s.sn, s.imei || "", s.boardSn || "", this.sampleIsReassembled(s) ? "是" : "否", s.model, s.config, s.schemeNo || "", this.sampleInitialResultsValue(s).join("\n"), s.sourceStageName, s.sourceSkuName, this.sampleEffectiveStatus(s), s.location, s.owner, s.borrower || "", s.borrowDate || "", s.tag || "", s.notes])
    ));
    Utils.downloadCsv(rows, `样机档案池_${Utils.exportTimestamp()}.csv`);
  },

});
