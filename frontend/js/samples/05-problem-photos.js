/* Shared problem/image editor for task results and sample archives.
   The asset belongs to the sample; a problem stores stable photo IDs only. */
app.registerModule("samples.problemPhotos", {
  mergeProblemPhotoRecords(current = [], edited = [], baseline = null) {
    if (!Array.isArray(baseline)) return edited;
    const base = new Map(baseline.map(record => [record.id, record]));
    const changes = new Map(edited.map(record => [record.id, record]));
    const merged = new Map(current.map(record => [record.id, { ...record }]));
    for (const id of base.keys()) if (!changes.has(id)) merged.delete(id);
    for (const [id, record] of changes) {
      const prior = base.get(id);
      const latest = merged.get(id);
      if (!prior) { merged.set(id, { ...record }); continue; }
      const changedFields = ["description", "source"].filter(key => record[key] !== prior[key]);
      const beforeIds = this.problemPhotoIds(prior);
      const editedIds = this.problemPhotoIds(record);
      const removed = new Set(beforeIds.filter(pid => !editedIds.includes(pid)));
      const added = editedIds.filter(pid => !beforeIds.includes(pid));
      if (!latest && !changedFields.length && !removed.size && !added.length) continue;
      const next = { ...(latest || record) };
      changedFields.forEach(key => { next[key] = record[key]; });
      if (removed.size || added.length) next.photoIds = [...new Set([...this.problemPhotoIds(next).filter(pid => !removed.has(pid)), ...added])];
      merged.set(id, next);
    }
    return [...merged.values()];
  },

  problemPhotoIds(record = {}) {
    return [...new Set((Array.isArray(record.photoIds) ? record.photoIds : [])
      .filter(id => typeof id === "string" && id))];
  },

  problemPhotoButtonHtml(record = {}) {
    const count = this.problemPhotoIds(record).length;
    return `<button type="button" class="problem-photo-link" data-app-action="problem-photos-open">${count ? `查看图片（${count}）` : "添加图片"}</button>`;
  },

  problemRecordFromElement(row) {
    const prefix = row?.classList.contains("task-result-existing-problem-row")
      ? "task-result-existing-problem" : "sample-problem";
    return this.sampleProblemRecordFromRow(row, prefix);
  },

  refreshProblemPhotoButton(row) {
    const button = row?.querySelector('[data-app-action="problem-photos-open"]');
    if (!button) return;
    let record = {};
    try { record = JSON.parse(row.dataset.problemRecord || "{}"); } catch (_) { /* Invalid row metadata is ignored. */ }
    const count = this.problemPhotoIds(record).length;
    const readonly = row.closest('.sample-archive-shell')?.dataset.readonly === '1';
    button.textContent = count ? `查看图片（${count}）` : readonly ? "暂无图片" : "添加图片";
    button.disabled = readonly && !count;
  },

  setProblemRowPhotoIds(row, ids) {
    const record = this.problemRecordFromElement(row);
    record.photoIds = this.problemPhotoIds({ photoIds: ids });
    row.dataset.problemRecord = JSON.stringify(record);
    this.refreshProblemPhotoButton(row);
  },

  async openProblemPhotos(button) {
    const row = button?.closest(".sample-initial-result-row, .task-result-existing-problem-row, .task-result-new-problem");
    if (!row) return;
    const taskRow = row.closest(".task-result-sample-row");
    const shell = row.closest(".sample-archive-shell");
    const sampleId = taskRow?.dataset.sid || shell?.dataset.sampleDetailId;
    if (!sampleId) { Utils.toast("请先保存样机，再添加问题图片。"); return; }
    const isNew = row.classList.contains("task-result-new-problem");
    const record = isNew ? { description: row.querySelector(".task-result-sample-problem")?.value || "本次新增问题",
      photoIds: this.taskResultRowPhotos(taskRow).map(photo => photo.id) } : this.problemRecordFromElement(row);
    const readonly = shell?.dataset.readonly === "1";
    const request = this.beginDialogRequest();
    let sample;
    try {
      sample = await this.ensureSampleDetailsLoaded(sampleId, { photos: true, events: false, renderPanels: false });
    } catch (error) {
      if (this.isDialogRequestCurrent(request)) alert("图片加载失败：" + error.message);
      return;
    }
    if (!this.isDialogRequestCurrent(request)) return;
    sample = this.findSample(sampleId)?.sample || sample;
    if (!sample) return;
    const selected = new Set(this.problemPhotoIds(record));
    const initial = [...selected].sort().join("\n");
    let galleryId;
    const render = () => {
      if (this._currentModalId !== galleryId) return;
      const current = this.findSample(sampleId)?.sample || sample;
      const gallery = document.getElementById("problemPhotoGallery");
      const otherPhotosOpen = gallery.querySelector(".problem-photo-others")?.open || false;
      this.replaceHtml(gallery, this.problemPhotoGalleryHtml(current, selected, readonly, otherPhotosOpen));
    };
    galleryId = this.showModal(`问题图片 · ${record.description || "未填写描述"}`, `
      <div class="problem-photo-toolbar">
        ${readonly ? "" : '<button type="button" class="btn" id="problemPhotoUpload">添加图片</button>'}
        <span>${readonly ? "只读查看此问题已关联的样机图片。" : "图片保存在样机档案；关联随当前表单保存。"}</span>
      </div><div id="problemPhotoGallery"></div>`, () => {
      if (!readonly && initial !== [...selected].sort().join("\n")) {
        if (isNew) {
          const known = new Map([...this.taskResultRowPhotos(taskRow), ...(this.findSample(sampleId)?.sample.photos || [])].map(photo => [photo.id, photo]));
          this.setTaskResultRowPhotos(taskRow, [...selected].map(id => known.get(id) || { id, name: "图片不可用" }));
        } else this.setProblemRowPhotoIds(row, [...selected]);
        if (shell) this.refreshProblemPhotoArchive(shell, sampleId);
      }
      return false;
    }, readonly ? "返回" : "完成", { className: "problem-photo-modal", hideCancel: readonly, cancelText: "取消" });
    render();
    document.getElementById("problemPhotoGallery").addEventListener("click", event => {
      const action = event.target.closest("[data-photo-choice]");
      if (!action || readonly) return;
      const id = action.dataset.photoId;
      if (action.dataset.photoChoice === "remove") selected.delete(id);
      else selected.add(id);
      render();
    });
    document.getElementById("problemPhotoUpload")?.addEventListener("click", () => {
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = "image/*";
      picker.multiple = true;
      picker.addEventListener("change", async () => {
        const files = [...(picker.files || [])];
        if (!files.length || this._currentModalId !== galleryId) return;
        this.setModalBusy(galleryId, true);
        try {
          const uploaded = await this.uploadSamplePhotoFiles(sampleId, files, "添加问题图片");
          if (this._currentModalId !== galleryId) return;
          uploaded.forEach(photo => selected.add(photo.id));
          render();
          if (shell) this.refreshProblemPhotoArchive(shell, sampleId);
          Utils.toast(`已添加 ${uploaded.length} 张图片，可继续添加。`);
        } catch (error) { alert("图片上传失败：" + error.message); }
        finally { this.setModalBusy(galleryId, false); }
      }, { once: true });
      picker.click();
    });
  },

  problemPhotoGalleryHtml(sample, selected, readonly = false, otherPhotosOpen = false) {
    const photos = Array.isArray(sample.photos) ? sample.photos : [];
    const known = new Map(photos.map(photo => [photo.id, photo]));
    const card = (photo, linked) => {
      const available = known.has(photo.id);
      return `<div class="problem-photo-card">
        <button type="button" class="problem-photo-preview" ${available ? `data-app-action="sample-photo-preview" data-id="${Utils.esc(sample.id)}" data-photo-id="${Utils.esc(photo.id)}"` : "disabled"} title="查看大图">
          ${available ? `<img src="${Utils.esc(this.photoThumbUrl(photo))}" alt="${Utils.esc(photo.name || "问题图片")}">` : "图片不可用"}
        </button><div class="problem-photo-name" title="${Utils.esc(photo.name || photo.id)}">${Utils.esc(photo.name || "图片不可用")}</div>
        ${readonly ? "" : `<button type="button" class="btn btn-sm btn-outline" data-photo-choice="${linked ? "remove" : "add"}" data-photo-id="${Utils.esc(photo.id)}">${linked ? "移除关联" : "关联此图"}</button>`}
      </div>`;
    };
    return `<h4>此问题的图片（${selected.size}）</h4>
      <div class="problem-photo-grid">${[...selected].map(id => card(known.get(id) || { id }, true)).join("") || '<p class="path">暂无关联图片</p>'}</div>
      ${readonly ? "" : `<details class="problem-photo-others"${otherPhotosOpen ? " open" : ""}><summary>样机其它图片</summary><div class="problem-photo-grid">${photos.filter(photo => !selected.has(photo.id)).map(photo => card(photo, false)).join("") || '<p class="path">暂无其他图片，可点击“添加图片”上传。</p>'}</div></details>`}`;
  },

  archiveProblemRows(shell) {
    return [...(shell?.querySelectorAll(".sample-initial-result-row") || [])];
  },

  refreshProblemPhotoArchive(shell, sampleId) {
    const panel = shell?.querySelector('[data-sample-archive-panel="photos"]');
    const sample = this.findSample(sampleId)?.sample;
    if (!panel || !sample) return;
    this.replaceHtml(panel, this.samplePhotosHtml(sample));
    if (shell.dataset.readonly === "1") {
      panel.querySelectorAll('[data-app-action="sample-photo-upload"], .sample-photo-delete-btn, .sample-photo-rename-icon').forEach(el => { el.hidden = true; });
    }
  },

  async uploadSamplePhotoFiles(sampleId, files, remark = "添加样机图片") {
    let release = null;
    try {
      if (!(await this.prepareBeforeDirectMutation("上传样机图片前同步"))) throw new Error("请先完成数据同步。");
      const form = new FormData();
      await this.appendPhotoUploadFiles(form, files);
      release = await this.beginServerMutation();
      if (!release) throw new Error("其他保存操作正在进行，请稍后重试。");
      form.append("revision", String(this.serverRevision || 0));
      form.append("remark", remark);
      const response = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/photos`, { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      this.applySamplePhotosMutationResult(sampleId, result, { statusText: "已保存" });
      return result.uploaded || [];
    } finally { release?.(); }
  },
});
