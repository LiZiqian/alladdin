/* 样机身份解析与任务操作前置读取。解析档案快照身份；迟到响应不得覆盖新版本和未保存编辑。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.sample-lookup", {

  sampleLookupRefKeys(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    const keys = new Set();
    const add = text => {
      const item = String(text || "").trim();
      if (!item) return;
      const lower = item.toLowerCase();
      keys.add(lower);
      keys.add(lower.replace(/\s+/g, ""));
      keys.add(lower.replace(/[\s#：:._-]+/g, ""));
    };
    add(raw);
    if (typeof this.normalizeLogSampleRefCode === "function") add(this.normalizeLogSampleRefCode(raw));
    add(raw.replace(/^(?:SN|IMEI|主板SN)\s*[#：:]\s*/i, ""));
    const hashIdx = raw.indexOf("#");
    if (hashIdx >= 0) add(raw.slice(hashIdx + 1));
    return [...keys].filter(Boolean);
  },

  sampleLookupIdentityValues(sampleId = "", snapshot = null) {
    const values = [];
    const add = value => {
      const text = String(value || "").trim();
      if (text && !values.includes(text)) values.push(text);
    };
    add(sampleId);
    add(snapshot?.id);
    add(snapshot?.code);
    add(snapshot?.sampleNo);
    add(snapshot?.sample_no);
    add(snapshot?.sn);
    add(snapshot?.imei);
    add(snapshot?.boardSn);
    add(snapshot?.board_sn);
    return values;
  },

  sampleMatchesLookupValues(sample = {}, values = []) {
    const sampleValues = [
      sample?.id,
      sample?.sampleNo,
      sample?.sample_no,
      sample?.code,
      sample?.sn,
      sample?.imei,
      sample?.boardSn,
      sample?.board_sn,
      typeof this.sampleDisplayCode === "function" ? this.sampleDisplayCode(sample) : "",
    ];
    const sampleKeys = new Set(sampleValues.flatMap(value => this.sampleLookupRefKeys(value)));
    return values.some(value => this.sampleLookupRefKeys(value).some(key => sampleKeys.has(key)));
  },

  findSampleByLookupValues(values = []) {
    const list = Array.isArray(values) ? values : [values];
    const directId = list.map(value => String(value || "").trim()).filter(Boolean);
    for (const id of directId) {
      const found = this.findSample?.(id);
      if (found) return found;
    }
    const categories = this.sampleCategoryRecords?.() || this.data?.sampleLibrary?.categories || [];
    for (const category of categories) {
      for (const sample of (category.samples || [])) {
        if (this.sampleMatchesLookupValues(sample, list)) return { category, sample };
      }
    }
    return null;
  },

  mergeSampleLookupResult(result = {}) {
    const categories = this.sampleCategoryRecords?.() || this.data?.sampleLibrary?.categories || [];
    const summaryById = new Map((result.categories || []).map(category => [String(category.id || ""), category]));
    const existingById = new Map(categories.map(category => [String(category.id || ""), category]));
    (result.categories || []).forEach(summary => {
      const id = String(summary?.id || "");
      if (!id) return;
      const existing = existingById.get(id);
      if (existing) {
        Object.assign(existing, summary);
        if (!Array.isArray(existing.samples)) existing.samples = [];
      } else {
        const created = { ...summary, samples: [], samplesLoaded: false, _summaryOnly: true };
        categories.push(created);
        existingById.set(id, created);
      }
      this.syncHydratedCategoryBaseline?.(existingById.get(id), { includeSamples: false });
    });
    [...(result.items || []), ...(result.selectedItems || [])].forEach(sample => {
      const sampleId = String(sample?.id || "");
      const categoryId = String(sample?.categoryId || "");
      if (!sampleId || !categoryId) return;
      let category = existingById.get(categoryId);
      if (!category) {
        const summary = summaryById.get(categoryId) || {};
        category = {
          id: categoryId,
          name: sample.categoryName || summary.name || "未分类",
          sampleCount: summary.sampleCount || 0,
          samples: [],
          samplesLoaded: false,
          _summaryOnly: true,
        };
        categories.push(category);
        existingById.set(categoryId, category);
      }
      if (!Array.isArray(category.samples)) category.samples = [];
      const idx = category.samples.findIndex(item => String(item.id || "") === sampleId);
      const merged = idx >= 0 ? { ...category.samples[idx], ...sample } : sample;
      if (idx >= 0) category.samples[idx] = merged;
      else category.samples.push(merged);
      this.syncHydratedSampleBaseline?.(categoryId, merged);
    });
    return result;
  },

  async ensureSampleLoaded(sampleId, { render = false, snapshot = null } = {}) {
    const id = String(sampleId || "");
    if (!id) return null;
    const lookupValues = this.sampleLookupIdentityValues(id, snapshot);
    const current = this.findSampleByLookupValues?.(lookupValues) || this.findSample?.(id);
    if (current) return current;
    this._lastSampleLookupError = null;
    this._lastSampleLookupMissingIds = [];
    if (!this._sampleLookupPromises) this._sampleLookupPromises = {};
    const lookupKey = JSON.stringify(lookupValues);
    if (!this._sampleLookupPromises[lookupKey]) {
      const epoch = this._dataSnapshotEpoch || 0;
      this.updateServerStatus?.("加载样机");
      this._sampleLookupPromises[lookupKey] = (async () => {
        try {
          const mergeLookup = result => {
            if (!result) return result;
            const categories = this.data.sampleLibrary?.categories || [];
            const baselineCategories = this._baseData?.sampleLibrary?.categories || [];
            const categoryChanged = (result.categories || []).some(summary => {
              const current = categories.find(category => category.id === summary.id);
              const baseline = baselineCategories.find(category => category.id === summary.id);
              return this.serverReadHasLocalEdits(this.compactSampleCategoryForMutation(current), this.compactSampleCategoryForMutation(baseline));
            });
            const sampleChanged = [...(result.items || []), ...(result.selectedItems || [])].some(sample => {
              const current = categories.find(category => category.id === sample.categoryId)?.samples?.find(item => item.id === sample.id);
              const baseline = baselineCategories.find(category => category.id === sample.categoryId)?.samples?.find(item => item.id === sample.id);
              return this.serverReadHasLocalEdits(current, baseline);
            });
            if (categoryChanged || sampleChanged) return null;
            this.mergeSampleLookupResult(result);
            return result;
          };
          const selectedResult = await this.readCurrentServerData(() => this.fetchTaskSampleCandidates({ selectedIds: [id], page: 1, pageSize: 20 }), undefined, mergeLookup);
          if ((this._dataSnapshotEpoch || 0) !== epoch || !selectedResult) return null;
          this._lastSampleLookupMissingIds = selectedResult.selectedMissingIds || [];
          let found = this.findSampleByLookupValues?.(lookupValues) || this.findSample?.(id) || null;
          if (!found) {
            const searchValues = lookupValues.filter(value => !String(value || "").startsWith("sample_"));
            for (const value of searchValues) {
              const keyword = String(value || "").trim();
              if (!keyword) continue;
              const result = await this.readCurrentServerData(() => this.fetchTaskSampleCandidates({ keyword, page: 1, pageSize: 20 }), undefined, mergeLookup);
              if ((this._dataSnapshotEpoch || 0) !== epoch || !result) return null;
              found = this.findSampleByLookupValues?.(lookupValues) || null;
              if (found) break;
            }
          }
          this.updateServerStatus?.("已加载");
          if (render) this.render?.();
          return found;
        } catch (e) {
          if ((this._dataSnapshotEpoch || 0) !== epoch) return null;
          this._lastSampleLookupError = e;
          this.updateServerStatus?.("加载失败");
          console.error("样机档案加载失败：", e);
          return null;
        } finally {
          if ((this._dataSnapshotEpoch || 0) === epoch) delete this._sampleLookupPromises[lookupKey];
        }
      })();
    }
    return this._sampleLookupPromises[lookupKey];
  },

  ensureTaskReferenceSamplesLoaded(task) {
    if (!task || typeof this.ensureSampleLoaded !== "function") return [];
    const ids = new Set();
    const add = value => {
      const id = String(value || "").trim();
      if (id) ids.add(id);
    };
    if (typeof this.taskMutationSampleIds === "function") {
      this.taskMutationSampleIds(task).forEach(add);
    } else {
      const entries = typeof this.taskResultSampleEntries === "function"
        ? this.taskResultSampleEntries(task)
        : (task.sampleIds || []).map(sampleId => ({ sampleId }));
      entries.forEach(entry => add(entry.sampleId));
    }
    (task.logs || []).forEach(log => (log?.sampleRefs || []).forEach(ref => add(ref?.sampleId || ref?.sid)));
    const missing = [...ids].filter(id => !this.findSampleByLookupValues?.(this.sampleLookupIdentityValues(id, task.sampleSnapshots?.[id] || null)));
    if (!missing.length) return [];
    return Promise.all(missing.map(id => this.ensureSampleLoaded(id, { snapshot: task.sampleSnapshots?.[id] || null })));
  },

  async requireTaskMutationSamplesLoaded(task, sampleIds = [], actionLabel = "任务操作") {
    const ids = [...new Set((sampleIds || []).map(id => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return true;
    const missing = ids.filter(id => !this.findSample?.(id)?.sample);
    if (!missing.length) return true;

    this.updateServerStatus?.("加载任务样机");
    if (typeof this.ensureSampleLoaded === "function") {
      await Promise.all(missing.map(id => this.ensureSampleLoaded(id, {
        snapshot: task?.sampleSnapshots?.[id] || null
      })));
    }

    // 任务写入和样机状态变更都按 sampleId 精确寻址。即使历史快照中的
    // SN/IMEI 能命中另一条档案，也不能用它替代当前任务真正引用的样机。
    const unresolved = ids.filter(id => !this.findSample?.(id)?.sample);
    if (!unresolved.length) {
      this.updateServerStatus?.("已加载");
      return true;
    }

    const labels = unresolved.slice(0, 5).map(id => {
      const snapshot = task?.sampleSnapshots?.[id] || {};
      return snapshot.code || snapshot.sampleNo || snapshot.sn || snapshot.imei || snapshot.boardSn || id;
    });
    const remaining = unresolved.length > labels.length ? ` 等 ${unresolved.length} 台` : "";
    const reason = this._lastSampleLookupError
      ? "样机档案加载失败，请检查服务连接后重试。"
      : "样机档案可能已被销毁、迁移或尚未同步，请刷新后核对任务与样机池。";
    this.updateServerStatus?.("任务样机未就绪");
    alert(`${actionLabel}未执行：无法取得样机 ${labels.join("、")}${remaining} 的完整档案。\n${reason}`);
    return false;
  },

  async refreshSampleTestedItemNames(sampleIds = [], isCurrent = () => true, onSamples = null) {
    const ids = [...new Set(sampleIds.map(id => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return true;
    // The candidate endpoint accepts at most 500 selected IDs per request.
    const chunks = [];
    for (let offset = 0; offset < ids.length; offset += 500) chunks.push(ids.slice(offset, offset + 500));
    return this.readCurrentServerData(
      () => Promise.all(chunks.map(selectedIds => this.fetchTaskSampleCandidates({ selectedIds, page: 1, pageSize: 1 }))),
      isCurrent,
      results => {
        if (!isCurrent()) return false;
        results.forEach(result => (result.selectedItems || []).forEach(sample => {
          if (!Array.isArray(sample.testedItemNames)) return;
          const current = this.findSample(sample.id)?.sample;
          if (!current) return;
          const patch = { testedItemNames: sample.testedItemNames };
          Object.assign(current, patch);
          this.syncHydratedSamplePatchBaseline(sample.id, patch);
        }));
        // Give read-only lists fresh archive data without overwriting local sample drafts.
        onSamples?.(results.flatMap(result => result.selectedItems || []));
        return true;
      });
  },

  prepareTaskActionSamples(task, sampleIds = [], actionLabel = "任务操作") {
    const ids = [...new Set((sampleIds || []).map(id => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return true;
    if (ids.every(id => this.findSample?.(id)?.sample)) return true;
    if (!this._taskActionPreparationInFlight) this._taskActionPreparationInFlight = {};
    const key = `${String(task?.id || "task")}:${actionLabel}:${ids.slice().sort().join(",")}`;
    if (this._taskActionPreparationInFlight[key]) {
      Utils.toast(`${actionLabel}正在加载样机，请稍候`);
      return false;
    }
    this._taskActionPreparationInFlight[key] = true;
    return this.requireTaskMutationSamplesLoaded(task, ids, actionLabel).finally(() => {
      delete this._taskActionPreparationInFlight[key];
    });
  },

});
