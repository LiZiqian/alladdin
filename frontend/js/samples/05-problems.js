/* ========================================
   TestChamber V7 - Sample problem table helpers
   Split from the previous monolithic module.
   ======================================== */

app.registerModule("samples.problems", {

  problemTableColumns() {
    return [
      { key: "source", label: "来源" },
      { key: "date", label: "时间" },
      { key: "description", label: "问题描述" },
      { key: "task", label: "关联测试任务" },
      { key: "photos", label: "图片" },
      { key: "actions", label: "操作" }
    ];
  },

  problemTableHeadHtml() {
    const columns = this.problemTableColumns();
    return `<colgroup>${columns.map(column => `<col class="problem-${column.key}-col">`).join("")}</colgroup>
      <thead><tr>${columns.map(column => `<th scope="col">${column.label}</th>`).join("")}</tr></thead>`;
  },

  problemTableCellsHtml(cells) {
    return this.problemTableColumns().map(column => `<td>${cells[column.key] || ""}</td>`).join("");
  },

  problemTaskFieldHtml(record, prefix = "sample-problem", ariaLabel = "关联任务") {
    const label = this.sampleProblemTaskLabel(record) || "/";
    return `<input class="${prefix}-task" value="${Utils.esc(label)}" title="${Utils.esc(label)}" aria-label="${ariaLabel}" readonly>`;
  },

  problemCreatedDate(record = {}) {
    const value = String(record.createdAt || "");
    if (!value) return "—";
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  },

  problemDateHtml(record) {
    const date = this.problemCreatedDate(record);
    return `<span class="problem-created-date" title="${date === "—" ? "创建时间未记录" : "创建时间（不可修改）"}">${date}</span>`;
  },

  sampleProblemsHtml(containerId, records = []) {
    const rows = records.length ? records : [{ description: "", source: "初检", taskLabel: "", createdAt: Utils.now() }];
    return `<div class="sample-problem-table-scroll"><table class="sample-problem-table" aria-label="样机问题表">
      ${this.problemTableHeadHtml()}
      <tbody id="${Utils.esc(containerId)}" class="sample-initial-results">
      ${rows.map(v => this.sampleProblemRowHtml(containerId, v)).join("")}
      </tbody></table></div>
      <div class="sample-problem-toolbar"><button type="button" class="btn btn-sm btn-outline" data-app-action="sample-problem-add" data-id="${Utils.esc(containerId)}">新增问题</button></div>`;
  },

  sampleProblemRowHtml(containerId, record = {}) {
    const item = this.normalizeSampleProblemRecord(record) || this.normalizeSampleProblemRecord({});
    return `<tr class="sample-initial-result-row" data-problem-id="${Utils.esc(item.id)}" data-problem-record="${Utils.esc(JSON.stringify(item))}">
      ${this.problemTableCellsHtml({
        description: `<input class="sample-problem-desc" value="${Utils.esc(item.description || "")}" placeholder="问题描述，如 有碎亮点" aria-label="问题描述">`,
        source: `<input class="sample-problem-source" value="${Utils.esc(item.source || "初检")}" title="${Utils.esc(item.source || "初检")}" placeholder="来源" aria-label="来源">`,
        date: this.problemDateHtml(item),
        task: this.problemTaskFieldHtml(item),
        photos: this.problemPhotoButtonHtml(item),
        actions: `<div class="sample-problem-actions"><button type="button" class="sample-result-btn remove" title="删除此行" data-app-action="sample-problem-remove">${Utils.iconHtml("trash")}</button></div>`
      })}
    </tr>`;
  },

  sampleProblemRowNode(containerId, record = {}) {
    const item = this.normalizeSampleProblemRecord(record) || this.normalizeSampleProblemRecord({});
    const row = document.createElement("tr");
    row.className = "sample-initial-result-row";
    row.dataset.problemId = item.id;
    row.dataset.problemRecord = JSON.stringify(item);

    const desc = document.createElement("input");
    desc.className = "sample-problem-desc";
    desc.value = item.description || "";
    desc.placeholder = "问题描述，如 有碎亮点";
    desc.ariaLabel = "问题描述";

    const source = document.createElement("input");
    source.className = "sample-problem-source";
    source.value = item.source || "初检";
    source.title = source.value;
    source.placeholder = "来源";
    source.ariaLabel = "来源";

    const task = document.createElement("input");
    task.className = "sample-problem-task";
    task.value = this.sampleProblemTaskLabel(item) || "/";
    task.title = task.value;
    task.readOnly = true;
    task.ariaLabel = "关联任务";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "sample-result-btn remove";
    remove.title = "删除此行";
    remove.dataset.appAction = "sample-problem-remove";
    remove.innerHTML = Utils.iconHtml("trash");

    const photoCell = document.createElement("td");
    photoCell.innerHTML = this.problemPhotoButtonHtml(item);
    const actions = document.createElement("div");
    actions.className = "sample-problem-actions";
    actions.append(remove);
    const cell = document.createElement("td");
    cell.append(actions);
    const dateCell = document.createElement("td");
    dateCell.innerHTML = this.problemDateHtml(item);
    const cells = { photos: photoCell, actions: cell, date: dateCell };
    for (const [key, input] of Object.entries({ description: desc, source, task })) {
      cells[key] = document.createElement("td");
      cells[key].append(input);
    }
    this.problemTableColumns().forEach(column => row.append(cells[column.key]));
    return row;
  },

  addSampleProblemRow(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const row = this.sampleProblemRowNode(containerId, { description: "", source: "手动补录", taskLabel: "", createdAt: Utils.now() });
    container.append(row);
    row.querySelector(".sample-problem-desc")?.focus();
  },

  removeSampleProblemRow(btn) {
    const row = btn.closest(".sample-initial-result-row");
    const wrap = btn.closest(".sample-initial-results");
    if (!row || !wrap) return;
    const allRows = wrap.querySelectorAll(".sample-initial-result-row");
    if (allRows.length <= 1) {
      row.querySelectorAll("input").forEach(input => input.value = "");
      const task = row.querySelector(".sample-problem-task");
      if (task) { task.value = "/"; task.title = "/"; }
      const fresh = { id: Utils.id("problem_"), createdAt: Utils.now() };
      row.dataset.problemId = fresh.id;
      row.dataset.problemRecord = JSON.stringify(fresh);
      const date = row.querySelector(".problem-created-date");
      if (date) { date.textContent = this.problemCreatedDate(fresh); date.title = "创建时间（不可修改）"; }
      this.refreshProblemPhotoButton(row);
      return;
    }
    row.remove();
  },

  sampleProblemRecordFromRow(row, prefix = "sample-problem") {
    let original = {};
    try {
      const parsed = JSON.parse(row.dataset?.problemRecord || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) original = parsed;
    } catch (_) { /* Ignore invalid row metadata. */ }
    const id = row.dataset?.problemId || original.id || Utils.id("problem_");
    if (row.dataset) row.dataset.problemId = id;
    return {
      ...original,
      id,
      description: row.querySelector(`.${prefix}-desc`)?.value.trim() || "",
      source: row.querySelector(`.${prefix}-source`)?.value.trim() || "手动补录",
      // Task provenance is an immutable snapshot, independent of the source
      // task's continued existence and of the read-only display field.
      taskLabel: String(original.taskLabel || "").trim()
    };
  },

  collectSampleProblems(containerId) {
    return [...(document.getElementById(containerId)?.querySelectorAll(".sample-initial-result-row") || [])]
      .map(row => this.sampleProblemRecordFromRow(row))
      .filter(item => item.description && !Utils.isNoSampleIssueText(item.description));
  },

  sampleInitialResultsHtml(containerId, values = []) {
    return this.sampleProblemsHtml(containerId, values.map(v => ({ description: v, source: "初检", taskLabel: "" })));
  },

  addSampleInitialResultRow(containerId) {
    this.addSampleProblemRow(containerId);
  },

  removeSampleInitialResultRow(btn) {
    this.removeSampleProblemRow(btn);
  },

  collectSampleInitialResults(containerId) {
    return this.collectSampleProblems(containerId).map(x => x.description);
  },

});
