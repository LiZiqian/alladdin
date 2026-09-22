/* CT models/videos and point-cloud files share one archive workflow. */
app.registerModule("samples.files", {
  sampleFileConfig(category) {
    return category === "pointcloud"
      ? { title: "D点云数据", accept: ".ply", hint: "支持 PLY 点云文件。" }
      : { title: "CT三维数据", accept: ".stl,.mp4,.webm,.mov,.m4v,.avi,.mkv", hint: "支持 STL 三维模型和 CT 切片视频（MP4、WebM、MOV、M4V、AVI、MKV）。" };
  },

  sampleFilesPanelHtml(sampleId, category, readonly, files = null, error = "") {
    const config = this.sampleFileConfig(category);
    const rows = (files || []).filter(file => category === "pointcloud" ? file.kind === "point_cloud" : file.kind === "ct_model" || file.kind === "ct_video");
    const action = (name, text, id = "") => `<button type="button" class="btn btn-sm btn-outline sample-file-control" data-app-action="sample-file-${name}" data-category="${category}" data-file-id="${Utils.esc(id)}">${text}</button>`;
    const esc = Utils.esc;
    return `<div class="sample-files-heading"><h3>${config.title}</h3>${readonly ? "" : action("upload", "添加文件")}</div>
      <p class="sample-files-hint">${config.hint}${readonly ? "" : " 每个文件不超过 75 MB，可多选、分次添加。添加和删除立即保存。"}</p>
      <div class="sample-files-status" role="status">${esc(error)}</div>
      ${error ? action("reload", "重新加载") : files === null ? '<p class="path">打开后加载文件列表</p>' : rows.length ? `<div class="sample-files-list">${rows.map(file => {
        const url = `/api/samples/${encodeURIComponent(sampleId)}/files/${encodeURIComponent(file.id)}`;
        const size = file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
        const type = file.kind === "ct_video" ? "CT 视频" : file.kind === "ct_model" ? "STL 模型" : "PLY 点云";
        return `<article class="sample-file-card"><div class="sample-file-info"><strong title="${esc(file.name)}">${esc(file.name)}</strong><span>${type} · ${size}</span><small>${esc(file.uploadedAt || "")}</small></div>
          <div class="sample-file-actions">${file.kind === "ct_video" ? action("preview", "播放视频", file.id) : ""}<a class="btn btn-sm btn-outline" href="${esc(url)}?download=1" download="${esc(file.name)}">下载</a>${readonly ? "" : action("delete", "删除", file.id)}</div>
          ${file.kind === "ct_video" ? `<div class="sample-file-video" data-file-video="${esc(file.id)}" hidden><video controls playsinline preload="none" src="${esc(url)}" aria-label="${esc(file.name)}"></video><p class="sample-files-hint">若当前浏览器不支持此视频编码，可下载后播放。</p></div>` : ""}</article>`;
      }).join("")}</div>` : '<div class="sample-files-empty">暂无文件</div>'}`;
  },

  async loadSampleArchiveFiles(shell, category) {
    const panel = shell?.querySelector(`[data-sample-archive-panel="${category}"]`);
    if (!panel || panel.dataset.busy === "1") return;
    const request = String((Number(panel.dataset.request) || 0) + 1);
    panel.dataset.request = request;
    const sampleId = shell.dataset.sampleDetailId;
    const readonly = shell.dataset.readonly === "1";
    this.replaceHtml(panel, '<p class="path">正在加载文件…</p>');
    try {
      const response = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/files`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (panel.isConnected && panel.dataset.request === request) this.replaceHtml(panel, this.sampleFilesPanelHtml(sampleId, category, readonly, result.files));
    } catch (error) {
      if (panel.isConnected && panel.dataset.request === request) this.replaceHtml(panel, this.sampleFilesPanelHtml(sampleId, category, readonly, null, `文件加载失败：${error.message}`));
    }
  },

  async mutateSampleFiles(shell, panel, category, operation) {
    if (shell.dataset.readonly === "1" || panel.dataset.busy === "1") return;
    const modalId = this._currentModalId;
    let release = null;
    panel.dataset.busy = "1";
    panel.querySelectorAll("button").forEach(button => { button.disabled = true; });
    this.setModalBusy(modalId, true);
    try {
      if (!(await this.prepareBeforeDirectMutation("样机文件操作前同步"))) throw new Error("请先完成数据同步。");
      release = await this.beginServerMutation();
      if (!release) throw new Error("其他保存操作正在进行，请稍后重试。");
      await operation();
    } catch (error) {
      Utils.toast(error.message || "文件操作失败");
    } finally {
      release?.();
      panel.dataset.busy = "0";
      this.setModalBusy(modalId, false);
      if (panel.isConnected) await this.loadSampleArchiveFiles(shell, category);
    }
  },

  handleSampleFileAction(button, action) {
    const shell = button.closest(".sample-archive-shell");
    if (!shell) return;
    const category = button.dataset.category;
    const panel = button.closest(".sample-archive-panel");
    const sampleId = shell.dataset.sampleDetailId;
    if (action === "reload") return this.loadSampleArchiveFiles(shell, category);
    if (action === "preview") {
      const container = button.closest(".sample-file-card").querySelector(".sample-file-video");
      container.hidden = !container.hidden;
      button.textContent = container.hidden ? "播放视频" : "收起视频";
      const video = container.querySelector("video");
      if (container.hidden) video.pause(); else video.play().catch(() => {});
      return;
    }
    if (shell.dataset.readonly === "1") return;
    const apply = async (url, options) => {
      const response = await fetch(url, options);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      this.applySamplePhotosMutationResult(sampleId, result);
    };
    const url = `/api/samples/${encodeURIComponent(sampleId)}/files`;
    if (action === "delete") {
      if (!confirm("删除这个文件？删除后无法恢复。")) return;
      return this.mutateSampleFiles(shell, panel, category, async () => {
        await apply(`${url}/${encodeURIComponent(button.dataset.fileId)}`, { method: "DELETE" });
        Utils.toast("文件已删除");
      });
    }
    if (action !== "upload") return;
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = this.sampleFileConfig(category).accept;
    picker.multiple = true;
    picker.addEventListener("change", () => {
      const files = Array.from(picker.files || []);
      if (!files.length || !panel.isConnected) return;
      const extensions = picker.accept.split(",");
      if (files.some(file => !extensions.includes("." + file.name.split(".").pop().toLowerCase()))) return Utils.toast("文件格式不支持，请按页面说明选择。");
      if (files.some(file => file.size === 0 || file.size > 75 * 1024 * 1024)) return Utils.toast("请选择非空且不超过 75 MB 的文件。");
      return this.mutateSampleFiles(shell, panel, category, async () => {
        let done = 0;
        for (const file of files) {
          panel.querySelector(".sample-files-status").textContent = `正在添加 ${done + 1}/${files.length}：${file.name}`;
          const form = new FormData();
          form.append("category", category);
          form.append("files", file);
          try { await apply(url, { method: "POST", body: form }); }
          catch (error) { throw new Error(`已添加 ${done}/${files.length} 个文件；${file.name} 添加失败：${error.message}`); }
          done++;
        }
        Utils.toast(`已添加 ${done} 个文件，可继续添加。`);
      });
    }, { once: true });
    picker.click();
  },
});
