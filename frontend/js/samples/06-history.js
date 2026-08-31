/* ========================================
   TestChamber V7 - Sample test history
   Split from the previous monolithic module.
   ======================================== */

app.registerModule("samples.history", {

  switchSampleArchiveTab(tab) {
    document.querySelectorAll("[data-sample-archive-tab]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.sampleArchiveTab === tab);
    });
    document.querySelectorAll("[data-sample-archive-panel]").forEach(panel => {
      panel.classList.toggle("active", panel.dataset.sampleArchivePanel === tab);
    });
    // 更新 footer 说明文字
    const hints = {
      info: "查看与编辑样机的基本档案，包括身份标识、当前状态、存放位置、人员归属及初检问题记录。",
      history: "该样机参与过的全部测试任务记录，含测试结果、故障标记与状态变更日志。",
      photos: "外观照片、失效分析图片、问题定位截图等。图片随样机档案一起保存，不随任务结束而清除。",
      ct: "归档 CT 扫描图像、扫描批次、三维结构分析结论等工业 CT 数据。",
      other: "预留扩展区。后续可在此定义更多样机维度的数据归档功能。"
    };
    const hint = document.getElementById("sampleArchiveFooterHint");
    if (hint) hint.textContent = hints[tab] || "";
    if ((tab === "photos" || tab === "history") && this._activeSampleDetailId) {
      const sample = this.findSample(this._activeSampleDetailId)?.sample;
      const projectId = this.sampleAccessProjectId?.() || "";
      if (tab === "history" && sample && (
        sample.historyLoaded !== true
        || String(sample.historyAccessProjectId || "") !== projectId
      )) {
        this.ensureSampleHistoryLoaded(this._activeSampleDetailId, {
          page: 1,
          pageSize: 20,
          renderPanels: true,
          projectId,
        }).catch(e => {
          console.error("加载样机测试履历失败：", e);
          Utils.toast("样机测试履历加载失败：" + (e.message || e));
        });
      } else if (sample && tab === "photos" && (
        sample.photosLoaded !== true
        || String(sample.photosAccessProjectId || "") !== projectId
      )) {
        this.ensureSampleDetailsLoaded(this._activeSampleDetailId, {
          photos: true,
          events: false,
          renderPanels: true,
          projectId,
        }).catch(e => {
          console.error("加载样机详情数据失败：", e);
          Utils.toast("样机详情数据加载失败：" + (e.message || e));
        });
      }
    }
  },

  sampleTaskResultPhotos(task, sampleId) {
    if (!task) return [];
    const sample = this.findSample(sampleId)?.sample || {};
    const projectId = this.sampleAccessProjectId?.() || "";
    const samplePhotos = sample.photosLoaded === true
      && String(sample.photosAccessProjectId || "") === projectId
      ? (sample.photos || [])
      : [];
    const photoById = new Map(samplePhotos.filter(p => p?.id).map(p => [p.id, p]));
    const photos = [];
    (task.resultUploads || []).forEach(upload => {
      (upload.samples || [])
        .filter(item => item?.sampleId === sampleId)
        .forEach(item => {
          (item.photos || []).forEach(ref => {
            if (!ref?.id) return;
            const full = photoById.get(ref.id) || {};
            photos.push({
              id: ref.id,
              name: ref.name || full.name || "结果图片",
              url: ref.url || full.url || "",
              thumbUrl: ref.thumbUrl || ref.thumbnailUrl || full.thumbUrl || full.thumbnailUrl || "",
              uploadedAt: ref.uploadedAt || full.uploadedAt || upload.time || "",
              result: upload.result || "",
              user: upload.user || "",
              uploadTime: upload.time || ""
            });
          });
        });
    });
    const seen = new Set();
    return photos.filter(photo => {
      const key = `${photo.uploadTime || ""}_${photo.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  sampleHistoryPhotosHtml(sampleId, photos = []) {
    if (!photos.length) return "";
    return `<div class="sample-history-photos">
      <div class="sample-history-photos-title">结果图片</div>
      <div class="sample-history-photo-grid">
        ${photos.map(photo => `
          <button type="button" class="sample-history-photo" data-app-action="sample-photo-preview" data-id="${Utils.esc(sampleId)}" data-photo-id="${Utils.esc(photo.id)}" title="${Utils.esc(photo.name || "结果图片")}">
            ${this.photoThumbUrl(photo) ? `<img src="${Utils.esc(this.photoThumbUrl(photo))}" alt="${Utils.esc(photo.name || "结果图片")}">` : ""}
            <span>${Utils.esc(photo.result || "-")} · ${Utils.esc(photo.user || "-")}</span>
          </button>
        `).join("")}
      </div>
    </div>`;
  },

  sampleEventLogsForSample(sampleId) {
    const projectId = this.sampleAccessProjectId?.() || "";
    const key = this.sampleAccessScopeKey?.(sampleId, projectId) || "";
    const scoped = key ? this._sampleDetailAccessCache?.[key] : null;
    if (scoped?.eventsLoaded === true) return Array.isArray(scoped.events) ? scoped.events : [];
    if (projectId) return [];
    return this.sampleEventRecords().filter(log => String(log?.sampleId || "") === String(sampleId));
  },

  sampleHistoryCacheForCurrentScope(sampleId) {
    const projectId = this.sampleAccessProjectId?.() || "";
    const key = this.sampleHistoryCacheKey?.(sampleId, projectId) || String(sampleId || "");
    const scoped = this._sampleHistoryCache?.[key];
    if (scoped) return scoped;
    const legacy = this._sampleHistoryCache?.[String(sampleId || "")];
    if (!legacy) return null;
    const legacyProjectId = String(legacy.projectId || "");
    return legacyProjectId === projectId ? legacy : null;
  },

  sampleTestHistoryHtml(sampleId) {
    const cache = this.sampleHistoryCacheForCurrentScope(sampleId);
    if (!cache || cache.loading) {
      return this.sampleArchivePlaceholder("正在加载测试履历", "测试履历按页从服务器读取。");
    }
    if (cache.error) {
      return this.sampleArchivePlaceholder("测试履历加载失败", cache.error);
    }
    const list = Array.isArray(cache.items) ? cache.items : [];
    if (!list.length) return this.sampleArchivePlaceholder("暂无测试履历", "该样机还没有被分配到任何测试任务。");

    const total = Number(cache.total || list.length);
    const page = Number(cache.page || 1);
    const pageSize = Number(cache.pageSize || 20);
    const offset = (page - 1) * pageSize;
    return `<div class="sample-history-list">${list.map((row, idx) => {
      const task = row.task || null;
      const logs = Array.isArray(row.logs) ? row.logs : [];
      const historySeq = Math.max(1, total - offset - idx);
      const status = row.status || (task ? this.taskFlowStatus(task) : "历史记录");
      const result = row.result || task?.latestResult || task?.result || "-";
      const date = row.date || task?.resultDate || task?.completedAt || task?.planDate || logs[logs.length - 1]?.time || "-";
      const taskSampleCount = Number(row.taskSampleCount || 0);
      const faultMarked = !!row.faultMarked;
      const problems = Array.isArray(row.problems) ? row.problems : [];
      const resultPhotos = Array.isArray(row.resultPhotos) ? row.resultPhotos : [];
      const orderedLogs = logs.slice().reverse();
      return `<div class="sample-history-item">
        <button type="button" class="sample-history-summary" aria-expanded="false" data-app-action="sample-history-toggle">
          <span class="history-seq">履历 #${historySeq}</span>
          <b>${Utils.esc(row.testItem || task?.testItem || "-")}</b>
          <span class="badge s-${Utils.esc(status)}">${Utils.esc(status)}</span>
          <span class="badge ${faultMarked ? "status-bad" : "status-done"}">${faultMarked ? "有故障" : "无故障"}</span>
          <span class="sample-history-toggle"></span>
        </button>
        <div class="sample-history-detail">
          <div class="sample-history-grid">
            <span>任务ID：<b>${Utils.esc(task?.id || logs[0]?.taskId || "-")}</b></span>
            <span>项目：<b>${Utils.esc(row.projectName || "-")}</b></span>
            <span>阶段：<b>${Utils.esc(row.stageName || "-")}</b></span>
            <span>执行人：<b>${Utils.esc(task?.owner || logs[0]?.user || "-")}</b></span>
            <span>结果：<b>${Utils.esc(result)}</b></span>
            <span>日期：<b>${Utils.esc(date)}</b></span>
            <span>样机数：<b>${taskSampleCount || "-"} 台</b></span>
          </div>
          ${problems.length ? `<div class="sample-history-problems">问题：${problems.map(x => Utils.esc(x)).join("；")}</div>` : ""}
          ${this.sampleHistoryPhotosHtml(sampleId, resultPhotos)}
          ${orderedLogs.length ? `<div class="sample-history-logs">${orderedLogs.map((log, logIdx) => this.logHtml(log, orderedLogs.length - logIdx, "日志 #", task)).join("")}</div>` : `<div class="path">暂无该任务下的样机状态记录。</div>`}
        </div>
      </div>`;
    }).join("")}</div>${this.sampleHistoryPagerHtml(sampleId, cache)}`;
  },

  sampleHistoryPagerHtml(sampleId, cache = {}) {
    const totalPages = Number(cache.totalPages || 1);
    if (totalPages <= 1) return "";
    const page = Number(cache.page || 1);
    return `<div class="pager sample-history-pager">
      <button type="button" class="btn btn-sm btn-outline sample-history-page-btn" ${page <= 1 ? "disabled" : `data-app-action="sample-history-page" data-id="${Utils.esc(sampleId)}" data-value="${page - 1}"`}>上一页</button>
      <span>${page} / ${totalPages} · 共 ${Number(cache.total || 0)} 条</span>
      <button type="button" class="btn btn-sm btn-outline sample-history-page-btn" ${page >= totalPages ? "disabled" : `data-app-action="sample-history-page" data-id="${Utils.esc(sampleId)}" data-value="${page + 1}"`}>下一页</button>
    </div>`;
  },

  async loadSampleHistoryPage(sampleId, page) {
    try {
      await this.ensureSampleHistoryLoaded(sampleId, {
        page,
        pageSize: 20,
        renderPanels: true,
        force: true,
        projectId: this.sampleAccessProjectId?.() || "",
      });
    } catch (e) {
      Utils.toast("样机测试履历加载失败：" + (e.message || e));
    }
  },

  // ---- 样机数字档案（含 IMEI）----,

  findSampleSnapshot(sampleId) {
    for (const project of this.projectRecords()) {
      for (const stage of (project.stages || [])) {
        for (const task of (stage.tasks || [])) {
          const snap = task?.sampleSnapshots?.[sampleId];
          if (snap) return { snapshot: snap, project, stage, task };
        }
      }
    }
    return null;
  },

  readonlySampleSnapshotHtml(sampleId, snap = {}) {
    const destroyed = !!snap.destroyedAt;
    const emptyText = destroyed
      ? "该样机档案已销毁，这里仅显示任务日志保留的只读快照。"
      : "未能在样机池中找到当前档案，这里仅显示任务日志保留的只读快照。";
    return `
      <div class="sample-archive-summary">
        <div><span>档案编号</span><b>${Utils.esc(snap.code || snap.sampleNo || sampleId)}</b></div>
        <div><span>所属样机池</span><b>${Utils.esc(snap.categoryName || "-")}</b></div>
        <div><span>快照时间</span><b>${Utils.esc(snap.destroyedAt || snap.capturedAt || "-")}</b></div>
      </div>
      <div class="sample-archive-summary">
        <div><span>SN</span><b>${Utils.esc(snap.sn || "-")}</b></div>
        <div><span>IMEI</span><b>${Utils.esc(snap.imei || "-")}</b></div>
        <div><span>主板SN</span><b>${Utils.esc(snap.boardSn || "-")}</b></div>
      </div>
      <div class="empty">${emptyText}</div>
    `;
  },

  async openTaskSampleReadonly(sampleId, { task = null, snapshot = null, readonlyOkText = "" } = {}) {
    const parentTitle = String((typeof document !== "undefined" && document.getElementById?.("modalTitle")?.innerText) || "");
    const okText = readonlyOkText || (parentTitle.startsWith("任务日志") ? "返回日志" : "关闭");
    const snap = snapshot || task?.sampleSnapshots?.[sampleId] || this.findSampleSnapshot(sampleId)?.snapshot || null;
    const lookupValues = typeof this.sampleLookupIdentityValues === "function"
      ? this.sampleLookupIdentityValues(sampleId, snap)
      : [sampleId];
    let found = this.findSampleByLookupValues?.(lookupValues) || this.findSample(sampleId);
    if (!found && typeof this.ensureSampleLoaded === "function") {
      found = await this.ensureSampleLoaded(sampleId, { snapshot: snap });
    }
    if (found) {
      this.openSampleDetail(found.sample.id, { readonly: true, readonlyOkText: okText });
      return;
    }
    if (this._lastSampleLookupError) {
      alert("样机档案加载失败：" + (this._lastSampleLookupError.message || this._lastSampleLookupError));
      return;
    }
    if (!snap) { alert("该样机档案不存在，且没有保留任务快照。"); return; }
    this.showModal(
      "样机档案快照：" + (snap.code || snap.sampleNo || sampleId),
      this.readonlySampleSnapshotHtml(sampleId, snap),
      () => false,
      okText,
      { hideCancel: true, className: "sample-archive-modal", headerHint: "只读快照，不能编辑" }
    );
  },

  async openSampleReadonly(sampleId) {
    return this.openTaskSampleReadonly(sampleId);
  },

});
