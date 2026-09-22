/* ========================================
   TestChamber V7 - Sample photos and thumbnails
   Split from the previous monolithic module.
   ======================================== */

app.registerModule("samples.photos", {

  photoThumbUrl(photo) {
    return photo?.thumbUrl || photo?.url || "";
  },

  async createPhotoThumbnail(file, { maxSize = 360, quality = 0.72 } = {}) {
    if (!file || !String(file.type || "").startsWith("image/")) return null;
    let bitmap = null;
    let objectUrl = "";
    try {
      if ("createImageBitmap" in window) {
        bitmap = await createImageBitmap(file);
      } else {
        objectUrl = URL.createObjectURL(file);
        bitmap = await new Promise((resolve, reject) => {
          const img = new Image();
          img.addEventListener("load", () => resolve(img), { once: true });
          img.addEventListener("error", reject, { once: true });
          img.src = objectUrl;
        });
      }
      const scale = Math.min(1, maxSize / Math.max(bitmap.width || 1, bitmap.height || 1));
      const width = Math.max(1, Math.round((bitmap.width || 1) * scale));
      const height = Math.max(1, Math.round((bitmap.height || 1) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) return null;
      const base = String(file.name || "photo").replace(/\.[^.]+$/, "") || "photo";
      return new File([blob], `${base}.thumb.jpg`, { type: "image/jpeg" });
    } catch (e) {
      console.warn("生成缩略图失败：", e);
      return null;
    } finally {
      if (bitmap?.close) bitmap.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  },

  async appendPhotoUploadFiles(form, files) {
    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      form.append("photos", file, file.name);
      const thumb = await this.createPhotoThumbnail(file);
      if (thumb) form.append(`thumb_${idx}`, thumb, thumb.name);
    }
  },

  samplePhotosHtml(sample) {
    const photos = Array.isArray(sample?.photos) ? sample.photos : [];
    if (sample?.photosLoaded !== true && Number(sample?.photoCount || 0) > 0) {
      return `<div class="sample-photo-grid">
        <div class="sample-photo-card sample-photo-add" role="button" tabindex="0" data-app-action="sample-photo-upload" data-id="${Utils.esc(sample.id)}">
          <div class="add-card-plus" style="font-size:28px;margin-bottom:6px">+</div>
          <div class="add-card-label">添加图片</div>
        </div>
        <div class="empty" style="grid-column:1 / -1">正在加载 ${Number(sample.photoCount || 0)} 张图片...</div>
      </div>`;
    }
    return `<div class="sample-photo-grid">
      <div class="sample-photo-card sample-photo-add" role="button" tabindex="0" data-app-action="sample-photo-upload" data-id="${Utils.esc(sample.id)}">
        <div class="add-card-plus" style="font-size:28px;margin-bottom:6px">+</div>
        <div class="add-card-label">添加图片</div>
      </div>
      ${photos.length ? photos.map(photo => `
        <div class="sample-photo-card">
          <div class="sample-photo-thumb-wrap">
            <button type="button" class="sample-photo-thumb" data-app-action="sample-photo-preview" data-id="${Utils.esc(sample.id)}" data-photo-id="${Utils.esc(photo.id)}" title="查看大图">
              <img src="${Utils.esc(this.photoThumbUrl(photo))}" alt="${Utils.esc(photo.name || "图片数据")}">
            </button>
            <button type="button" class="sample-photo-delete-btn" data-app-action="sample-photo-delete" data-id="${Utils.esc(sample.id)}" data-photo-id="${Utils.esc(photo.id)}" data-stop-propagation="1" title="删除照片">${Utils.iconHtml("trash")}</button>
          </div>
          <div class="sample-photo-meta">
            <div class="sample-photo-name-row">
              <b title="${Utils.esc(photo.name || "")}">${Utils.esc(photo.name || "图片数据")}</b>
              <button type="button" class="sample-photo-rename-icon" data-app-action="sample-photo-rename" data-id="${Utils.esc(sample.id)}" data-photo-id="${Utils.esc(photo.id)}" data-stop-propagation="1" title="重命名">✎</button>
            </div>
          </div>
        </div>`).join("") : ""}
    </div>`;
  },

  async previewSamplePhoto(sampleId, photoId) {
    const dialogRequest = this.beginDialogRequest?.();
    const request = this._samplePhotoPreviewSequence = (this._samplePhotoPreviewSequence || 0) + 1;
    const modalId = this._currentModalId;
    const viewKey = JSON.stringify(this.view || {});
    let sample = this.findSample(sampleId)?.sample;
    if (sample && sample.photosLoaded !== true) {
      try {
        sample = await this.ensureSampleDetailsLoaded(sampleId, { photos: true, events: false, renderPanels: true });
      } catch (e) {
        if (request === this._samplePhotoPreviewSequence && modalId === this._currentModalId
          && this.isDialogRequestCurrent?.(dialogRequest) !== false) alert("照片加载失败：" + (e.message || e));
        return;
      }
    }
    if (request !== this._samplePhotoPreviewSequence || modalId !== this._currentModalId || viewKey !== JSON.stringify(this.view || {})) return;
    if (this.isDialogRequestCurrent?.(dialogRequest) === false) return;
    const photo = (sample?.photos || []).find(x => x.id === photoId);
    if (!photo) return;
    const src = photo.url || "";
    if (!src) return;
    const existing = document.querySelector(".sample-photo-preview-mask");
    if (existing) existing.remove();
    document.body.append(this.samplePhotoPreviewNode(photo, src));
    // 鼠标滚轮缩放 + 左键拖动平移
    const mask = document.querySelector(".sample-photo-preview-mask");
    mask?.querySelector(".sample-photo-preview-head button")?.focus();
    const img = mask?.querySelector(".sample-photo-preview-body img");
    if (img) {
      let scale = 1, tx = 0, ty = 0, dragging = false, startX = 0, startY = 0;
      const maxScale = 5;
      const updateTransform = () => {
        img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
      };
      const clampTranslate = () => {
        if (scale <= 1) { tx = 0; ty = 0; return; }
        const rect = img.getBoundingClientRect();
        const cw = body.clientWidth, ch = body.clientHeight;
        const iw = rect.width / scale, ih = rect.height / scale;
        const vw = iw * scale, vh = ih * scale;
        const maxX = Math.max(0, (vw - cw) / 2);
        const maxY = Math.max(0, (vh - ch) / 2);
        tx = Math.max(-maxX, Math.min(maxX, tx));
        ty = Math.max(-maxY, Math.min(maxY, ty));
      };
      const body = mask.querySelector(".sample-photo-preview-body");
      body.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = img.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const oldScale = scale;
        scale *= e.deltaY < 0 ? 1.02 : 1 / 1.02;
        if (scale < 1) { scale = 1; tx = 0; ty = 0; }
        else if (scale > maxScale) scale = maxScale;
        else { tx = mx - (mx - tx) * (scale / oldScale); ty = my - (my - ty) * (scale / oldScale); }
        clampTranslate();
        updateTransform();
        body.style.cursor = scale > 1 ? "grab" : "zoom-in";
      }, { passive: false });
      img.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        dragging = true; startX = e.clientX - tx; startY = e.clientY - ty;
        img.style.cursor = "grabbing";
        e.preventDefault();
      });
      const movePreview = (e) => {
        if (!dragging) return;
        tx = e.clientX - startX; ty = e.clientY - startY;
        clampTranslate();
        updateTransform();
      };
      const releasePreview = () => {
        if (!dragging) return;
        dragging = false;
        img.style.cursor = scale > 1 ? "grab" : "zoom-in";
      };
      window.addEventListener("mousemove", movePreview);
      window.addEventListener("mouseup", releasePreview);
      const observer = new MutationObserver(() => {
        if (!document.body.contains(mask)) {
          window.removeEventListener("mousemove", movePreview);
          window.removeEventListener("mouseup", releasePreview);
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true });
    }
  },

  samplePhotoPreviewNode(photo, src) {
    const name = photo?.name || "外观照片";
    const mask = document.createElement("div");
    mask.className = "sample-photo-preview-mask";
    mask.dataset.appAction = "sample-photo-preview-close";
    mask.dataset.selfOnly = "1";
    mask.role = "dialog";
    mask.ariaModal = "true";
    mask.ariaLabel = name;

    const preview = document.createElement("div");
    preview.className = "sample-photo-preview";

    const head = document.createElement("div");
    head.className = "sample-photo-preview-head";
    const title = document.createElement("b");
    title.textContent = name;
    const hint = document.createElement("span");
    hint.className = "path";
    hint.style.fontSize = "12px";
    hint.textContent = "滚轮缩放 · 点击背景关闭";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-sm btn-outline";
    close.dataset.appAction = "sample-photo-preview-close";
    close.textContent = "关闭";
    head.append(title, hint, close);

    const body = document.createElement("div");
    body.className = "sample-photo-preview-body";
    const img = document.createElement("img");
    img.src = src;
    img.alt = name;
    img.style.transformOrigin = "center center";
    img.style.transition = "transform 0.15s";
    body.append(img);

    preview.append(head, body);
    mask.append(preview);
    return mask;
  },

  samplePhotoRenameInputNode(originalName) {
    const input = document.createElement("input");
    input.className = "sample-photo-name-input";
    input.value = originalName || "";
    return input;
  },

  samplePhotoNameRowNodes(sampleId, photoId, name) {
    const label = document.createElement("b");
    label.title = name || "";
    label.textContent = name || "";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sample-photo-rename-icon";
    button.dataset.appAction = "sample-photo-rename";
    button.dataset.id = sampleId || "";
    button.dataset.photoId = photoId || "";
    button.dataset.stopPropagation = "1";
    button.title = "重命名";
    button.textContent = "✎";

    return [label, button];
  },

  uploadSamplePhotos(sampleId) {
    const found = this.findSample(sampleId);
    if (!found) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.addEventListener("change", async () => {
      const files = [...(input.files || [])];
      if (!files.length) return;
      const modalId = this._currentModalId;
      this.setModalBusy(modalId, true);
      try {
        if (found.sample?.photosLoaded !== true && typeof this.ensureSampleDetailsLoaded === "function") {
          await this.ensureSampleDetailsLoaded(sampleId, { photos: true, events: false, renderPanels: true });
        }
        const uploaded = await this.uploadSamplePhotoFiles(sampleId, files);
        this.refreshSampleArchivePanels(sampleId);
        Utils.toast(`已添加 ${uploaded.length} 张图片。`);
      } catch (e) {
        alert("照片上传失败：" + (e.message || e));
      } finally {
        this.setModalBusy(modalId, false);
      }
    }, { once: true });
    input.click();
  },

  startPhotoRename(btn, sampleId, photoId) {
    const nameRow = btn.closest(".sample-photo-name-row");
    if (!nameRow) return;
    const nameB = nameRow.querySelector("b");
    if (!nameB) return;
    const originalName = nameB.textContent.trim();

    // Replace display with inline input
    nameRow.textContent = "";
    const input = this.samplePhotoRenameInputNode(originalName);
    nameRow.append(input);
    input.focus();
    input.select();

    let committed = false;

    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      // Empty or unchanged -> restore original, no save
      if (!newName || newName === originalName) {
        this.finishPhotoRename(nameRow, sampleId, photoId, originalName);
        return;
      }
      // Persist to data
      const found = this.findSample(sampleId);
      const photo = found?.sample?.photos?.find(x => x.id === photoId);
      if (found && photo) {
        let release = null;
        try {
          release = await this.beginServerMutation();
          if (!release) return;
          this.updateServerStatus("同步中");
          const resp = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/photos/${encodeURIComponent(photoId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newName, user: "管理员" })
          });
          const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
          if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
          this.applySamplePhotosMutationResult(sampleId, json, { statusText: "已保存" });
        } catch (e) {
          this.updateServerStatus("保存失败");
          alert("照片重命名失败：" + (e.message || e));
          this.finishPhotoRename(nameRow, sampleId, photoId, originalName);
          return;
        } finally {
          release?.();
        }
      }
      this.finishPhotoRename(nameRow, sampleId, photoId, photo ? newName : originalName);
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      this.finishPhotoRename(nameRow, sampleId, photoId, originalName);
    };

    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => commit(), 100);
    });
  },

  finishPhotoRename(nameRow, sampleId, photoId, name) {
    nameRow.textContent = "";
    nameRow.append(...this.samplePhotoNameRowNodes(sampleId, photoId, name));
  },

  deleteSamplePhoto(sampleId, photoId) {
    const found = this.findSample(sampleId);
    if (!found || !Array.isArray(found.sample.photos)) return;
    const shell = document.querySelector(".sample-archive-shell");
    const records = shell?.dataset.sampleDetailId === sampleId
      ? this.archiveProblemRows(shell).map(row => this.problemRecordFromElement(row)) : this.sampleProblemRecords(found.sample);
    if (records.some(record => this.problemPhotoIds(record).includes(photoId))) {
      Utils.toast("此图片已关联问题，请先到问题表移除关联并保存样机详情。");
      return;
    }
    this.showConfirm("确认删除这张外观照片？", async () => {
      let release = null;
      try {
        if (!(await this.prepareBeforeDirectMutation("删除样机外观照片前同步"))) return;
        release = await this.beginServerMutation();
        if (!release) return;
        const res = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/photos/${encodeURIComponent(photoId)}`, { method: "DELETE" });
        const obj = await res.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
        if (!res.ok || !obj.ok) throw new Error(obj.error || ("HTTP " + res.status));
        this.applySamplePhotosMutationResult(sampleId, obj, { renderPanel: true, statusText: "已保存" });
      } catch (e) {
        alert("删除照片失败：" + (e.message || e));
      } finally {
        release?.();
      }
    }, { title: "删除照片", okText: "删除", okClass: "btn btn-danger" });
  },

});
