/* 样机池列表与卡片视图、池信息编辑。
 * 分页读取见 pool-pagination.js，销毁见 pool-destruction.js，
 * 新增样机见 sample-create.js。DOM、样式类名和事件动作保持稳定。
 */
app.registerModule("samples.pool", {

  samplePagerNode(page, totalPages, total, pageSize, { loading = false } = {}) {
    const start = total ? (page - 1) * pageSize + 1 : 0;
    const end = total ? Math.min(total, page * pageSize) : 0;
    const pager = document.createElement("div");
    pager.className = `list-pager sample-pager${loading ? " is-loading" : ""}`;
    const row = document.createElement("div");
    row.className = "sample-pager-row";

    const summary = document.createElement("span");
    summary.className = "path";
    summary.textContent = `筛选结果 ${total} 台，本页显示 ${start}-${end} 台`;
    row.append(summary);

    const pageBtn = (label, target, disabled = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-sm btn-outline";
      button.textContent = label;
      if (disabled || loading) button.disabled = true;
      else {
        button.dataset.appAction = "sample-page";
        button.dataset.value = String(target);
      }
      return button;
    };
    row.append(pageBtn("上一页", page - 1, page <= 1));

    const pageText = document.createElement("span");
    pageText.className = "path";
    pageText.textContent = `第 ${page} / ${totalPages} 页`;
    row.append(pageText);
    row.append(pageBtn("下一页", page + 1, page >= totalPages));

    const select = document.createElement("select");
    select.className = "sample-page-size-select";
    select.dataset.appAction = "sample-page-size";
    select.dataset.appEvents = "change";
    [50, 100, 200, 500].forEach(size => {
      const option = document.createElement("option");
      option.value = String(size);
      option.textContent = `每页 ${size}`;
      option.selected = pageSize === size;
      select.append(option);
    });
    row.append(select);

    if (loading) {
      const loadingText = document.createElement("span");
      loadingText.className = "path sample-pager-loading";
      loadingText.textContent = "加载中...";
      row.append(loadingText);
    }
    pager.append(row);
    return pager;
  },

  samplePoolCountText(cat, state) {
    const totalInCategory = state.cached?.stats?.totalInCategory
      ?? state.meta?.stats?.totalInCategory
      ?? cat.sampleCount
      ?? (cat.samples || []).length;
    return state.loading && !state.cached
      ? `加载第 ${state.page} 页 / ${totalInCategory} 台`
      : `筛选结果 ${state.total} 台 / 池内共 ${totalInCategory} 台`;
  },

  appendHtmlFragment(target, html) {
    const fragment = typeof this.htmlFragment === "function" ? this.htmlFragment(html) : null;
    if (fragment) target.append(fragment);
    else {
      const fallback = document.createElement("div");
      fallback.textContent = String(html || "");
      target.append(fallback);
    }
  },

  sampleAddCardNode(cat) {
    const card = document.createElement("div");
    card.className = "card add-card";
    card.dataset.appAction = "sample-add";
    card.dataset.id = cat.id || "";
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    const plus = document.createElement("div");
    plus.className = "add-card-plus";
    plus.textContent = "+";
    const label = document.createElement("div");
    label.className = "add-card-label";
    label.textContent = "新增样机";
    card.append(plus, label);
    return card;
  },

  sampleEmptyHintNode(text, extraClass = "") {
    const empty = document.createElement("div");
    empty.className = `empty sample-empty-hint${extraClass ? " " + extraClass : ""}`;
    empty.textContent = text;
    return empty;
  },

  samplePageGridNodes(cat, state) {
    const nodes = [this.sampleAddCardNode(cat)];
    if (state.loading && !state.cached) {
      nodes.push(this.sampleEmptyHintNode(`正在加载第 ${state.page} 页样机...`, "sample-page-loading"));
    } else if (state.cached?.error) {
      const error = this.sampleEmptyHintNode(`样机分页加载失败：${state.cached.error}`);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn-sm btn-outline";
      retry.textContent = "重试";
      retry.dataset.appAction = "sample-page-retry";
      error.append(retry);
      nodes.push(error);
    } else if (state.items.length) {
      state.items.forEach(sample => {
        const holder = document.createDocumentFragment ? document.createDocumentFragment() : document.createElement("div");
        this.appendHtmlFragment(holder, this.sampleCardHtml(sample));
        nodes.push(...Array.from(holder.childNodes || holder.children || []));
      });
    } else {
      nodes.push(this.sampleEmptyHintNode(Number(cat.sampleCount ?? cat.samples?.length) > 0
        ? "没有符合筛选条件的样机，请调整或清空筛选。" : "暂无样机"));
    }
    return nodes;
  },

  refreshSamplePageRegion(cat) {
    if (typeof this.sampleCategoryRecords === "function") {
      cat = this.sampleCategoryRecords().find(category => category.id === cat?.id);
      if (!cat) return;
    }
    const shell = document.getElementById("samplePageShell");
    if (!shell || shell.dataset.categoryId !== String(cat.id || "")) {
      this.renderSamples();
      return;
    }
    const hadLocalUnsavedChanges = this.hasLocalUnsavedChanges?.() === true;
    const state = this.samplePageState(cat);
    const pagerNode = () => this.samplePagerNode(state.page, state.totalPages, state.total, state.pageSize, { loading: state.loading && !state.cached });
    shell.dataset.pageKey = state.key;
    const topPager = document.getElementById("samplePagerTop");
    const bottomPager = document.getElementById("samplePagerBottom");
    const count = document.getElementById("samplePoolCount");
    const grid = document.getElementById("samplePoolGrid");
    this.replaceContentNodes(topPager, [pagerNode()]);
    this.replaceContentNodes(bottomPager, state.total > state.pageSize ? [pagerNode()] : []);
    if (count) count.innerText = this.samplePoolCountText(cat, state);
    this.replaceContentNodes(grid, this.samplePageGridNodes(cat, state));
    const filters = this.samplePoolPageState(100).filters;
    for (const field of ["owner", "borrower"]) {
      const select = shell.querySelector?.(`[data-sample-filter="${field}"]`);
      if (!select) continue;
      const placeholder = field === "owner" ? "挂账人" : "持有人";
      const options = this.samplePersonFilterOptions(cat, state, field, filters[field]);
      const replacement = this.sampleFilterSelectNode(select.className, field, placeholder, options, filters[field]);
      select.replaceChildren(...Array.from(replacement.childNodes || replacement.children || []));
      select.value = filters[field] || "";
    }
    if (!hadLocalUnsavedChanges) this.markDataSynced?.();
  },

  renderSamples() {
    const hadLocalUnsavedChanges = this.hasLocalUnsavedChanges?.() === true;
    const content = document.getElementById("content");
    const cat = this.currentSampleCategory();
    const categories = this.sampleCategoryRecords();
    const filters = this.samplePoolPageState(100).filters;

    if (!cat) {
      this.loadSampleCategorySummary();
      this.replaceContentNode(content, this.sampleCategoryOverviewNode(categories));
        // 页脚说明
        const ft = document.getElementById("pageFooter");
        if (ft) {
          ft.style.display = "";
          this.replaceContentNode(ft, this.sampleCategoryFooterNode());
        }
      return;
    }

    const state = this.samplePageState(cat);
    // 进入样机池内部时隐藏页脚
    const ft2 = document.getElementById("pageFooter");
    if (ft2) ft2.style.display = "none";

    this.replaceContentNode(content, this.samplePageShellNode(cat, state, filters));
    if (!hadLocalUnsavedChanges) this.markDataSynced?.();
  },

  replaceContentNode(target, node) {
    return this.replaceContentNodes(target, node ? [node] : []);
  },

  replaceContentNodes(target, nodes = []) {
    if (!target) return null;
    const items = (nodes || []).filter(Boolean);
    if (typeof target.replaceChildren === "function") target.replaceChildren(...items);
    else {
      target.textContent = "";
      items.forEach(node => target.append?.(node));
    }
    return target;
  },

  samplePageShellNode(cat, state, filters) {
    const shell = document.createElement("div");
    shell.id = "samplePageShell";
    shell.className = "sample-page-shell";
    shell.dataset.categoryId = cat.id || "";
    shell.dataset.pageKey = state.key || "";
    shell.append(this.samplePageToolbarNode(cat, state, filters));

    const topPager = document.createElement("div");
    topPager.id = "samplePagerTop";
    topPager.dataset.samplePager = "top";
    topPager.append(this.samplePagerNode(state.page, state.totalPages, state.total, state.pageSize, { loading: state.loading && !state.cached }));
    shell.append(topPager);

    const grid = document.createElement("div");
    grid.id = "samplePoolGrid";
    grid.className = "grid-small sample-pool-grid";
    grid.append(...this.samplePageGridNodes(cat, state));
    shell.append(grid);

    const bottomPager = document.createElement("div");
    bottomPager.id = "samplePagerBottom";
    bottomPager.dataset.samplePager = "bottom";
    if (state.total > state.pageSize) {
      bottomPager.append(this.samplePagerNode(state.page, state.totalPages, state.total, state.pageSize, { loading: state.loading && !state.cached }));
    }
    shell.append(bottomPager);
    return shell;
  },

  samplePageToolbarNode(cat, state, filters) {
    const toolbar = document.createElement("div");
    toolbar.className = "card sample-pool-toolbar";

    const title = document.createElement("div");
    title.className = "sample-pool-toolbar-title";
    const code = document.createElement("b");
    code.className = "sample-pool-code";
    code.textContent = cat.name || "";
    title.append(code);
    if (cat.description) {
      const desc = document.createElement("span");
      desc.className = "path sample-pool-desc";
      desc.textContent = cat.description;
      title.append(desc);
    }
    toolbar.append(title);

    const filterBar = document.createElement("div");
    filterBar.className = "sample-pool-toolbar-filters";
    const search = document.createElement("input");
    search.className = "sample-pool-search";
    search.placeholder = "详情 / 问题 / 履历（回车）";
    search.setAttribute("aria-label", "搜索样机详情、问题和履历");
    search.value = filters.keyword || "";
    search.dataset.appAction = "sample-filter-search";
    search.dataset.appEvents = "input keydown";
    filterBar.append(search);
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-status", "status", "使用状态", this.constants.sampleStatuses, filters.status, "使用状态筛选"));
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-result", "problemState", "故障状态", [
      { value: "fault", label: "有故障" },
      { value: "ok", label: "无故障" }
    ], filters.problemState, "故障状态筛选"));
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-reassembly", "reassembled", "重组状态", [
      { value: "normal", label: "非重组" },
      { value: "reassembled", label: "重组" }
    ], filters.reassembled, "重组状态筛选"));
    const owners = this.samplePersonFilterOptions(cat, state, "owner", filters.owner);
    const borrowers = this.samplePersonFilterOptions(cat, state, "borrower", filters.borrower);
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-person", "owner", "挂账人", owners, filters.owner, "挂账人筛选"));
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-person", "borrower", "持有人", borrowers, filters.borrower, "持有人筛选"));
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn btn-sm btn-outline sample-pool-clear-btn";
    clear.dataset.appAction = "sample-filters-clear";
    clear.textContent = "清空";
    filterBar.append(clear);
    const count = document.createElement("span");
    count.id = "samplePoolCount";
    count.className = "path sample-pool-count";
    count.textContent = this.samplePoolCountText(cat, state);
    filterBar.append(count);
    toolbar.append(filterBar);

    const actions = document.createElement("div");
    actions.className = "sample-pool-toolbar-actions";
    const template = document.createElement("button");
    template.type = "button";
    template.className = "btn sample-pool-main-btn";
    template.dataset.appAction = "sample-template-download";
    template.textContent = "下载批量导入模板";
    const batch = document.createElement("button");
    batch.type = "button";
    batch.className = "btn btn-add sample-pool-main-btn";
    batch.dataset.appAction = "sample-batch-import";
    batch.dataset.id = cat.id || "";
    batch.textContent = "批量新增";
    actions.append(template, batch);
    toolbar.append(actions);
    return toolbar;
  },

  samplePersonFilterOptions(cat, state, field, currentValue = "") {
    const names = state.cached?.stats?.[`${field}Names`] ?? state.meta?.stats?.[`${field}Names`];
    const values = Array.isArray(names) ? names : (cat.samples || []).map(sample => sample[field]);
    return [...new Set([...values, currentValue].filter(Boolean))].sort();
  },

  sampleFilterSelectNode(className, filterName, placeholder, options, currentValue, accessibleLabel = placeholder) {
    const select = document.createElement("select");
    select.className = className;
    select.setAttribute("aria-label", accessibleLabel);
    select.dataset.appAction = "sample-filter";
    select.dataset.appEvents = "change";
    select.dataset.sampleFilter = filterName;
    const first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.append(first);
    (options || []).forEach(option => {
      const value = typeof option === "string" ? option : option.value;
      const label = typeof option === "string" ? option : option.label;
      const node = document.createElement("option");
      node.value = value || "";
      node.textContent = label || "";
      node.selected = String(currentValue || "") === String(value || "");
      select.append(node);
    });
    return select;
  },

  sampleCategoryOverviewNode(categories = []) {
    const grid = document.createElement("div");
    grid.className = "grid sample-category-grid";
    (categories || []).forEach(category => grid.append(this.sampleCategoryCardNode(category)));
    grid.append(this.addSampleCategoryCardNode());
    this.scheduleSamplePoolDescriptionTooltipMeasure(grid);
    return grid;
  },

  scheduleSamplePoolDescriptionTooltipMeasure(root) {
    const measure = () => this.updateSamplePoolDescriptionTooltips(root);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(measure));
    } else {
      setTimeout(measure, 0);
    }
  },

  updateSamplePoolDescriptionTooltips(root = document) {
    root?.querySelectorAll?.(".sample-pool-card-desc").forEach(desc => {
      const text = desc.querySelector(".sample-pool-card-desc-text");
      if (!text) return;
      const tooltip = desc.dataset.tooltipSource || text.textContent || "";
      const truncated = text.scrollWidth > text.clientWidth + 1;
      desc.classList.toggle("is-truncated", truncated);
      if (truncated) {
        desc.dataset.tooltip = tooltip;
        desc.setAttribute("aria-label", tooltip);
      } else {
        delete desc.dataset.tooltip;
        desc.removeAttribute("aria-label");
      }
    });
  },

  sampleCategoryCardNode(category) {
    const card = document.createElement("div");
    card.className = "card sample-card";
    card.dataset.id = category.id || "";

    const header = document.createElement("div");
    header.className = "sample-pool-card-header";
    const name = document.createElement("span");
    name.className = "sample-pool-card-name";
    name.textContent = category.name || "";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "sample-card-edit-btn";
    edit.dataset.appAction = "sample-category-edit";
    edit.dataset.id = category.id || "";
    edit.dataset.stopPropagation = "1";
    edit.title = "编辑样机池";
    edit.ariaLabel = "编辑样机池";
    edit.textContent = "✎";
    header.append(name, edit);
    card.append(header);

    const desc = document.createElement("div");
    desc.className = "sample-pool-card-desc";
    const descText = `说明：${category.description || "—"}`;
    desc.dataset.tooltipSource = descText;
    const descValue = document.createElement("span");
    descValue.className = "sample-pool-card-desc-text";
    descValue.textContent = descText;
    desc.append(descValue);
    card.append(desc);

    const enterRow = document.createElement("div");
    enterRow.className = "sample-pool-card-enter-row";
    const enterButton = document.createElement("button");
    enterButton.type = "button";
    enterButton.className = "btn sample-pool-card-enter-btn";
    enterButton.dataset.appAction = "sample-category-open";
    enterButton.dataset.id = category.id || "";
    enterButton.append(document.createTextNode("进入样机池"));
    const arrow = document.createElement("b");
    arrow.textContent = "▶";
    enterButton.append(arrow);
    enterRow.append(enterButton);
    card.append(enterRow);

    const divider = document.createElement("div");
    divider.className = "sample-pool-card-divider";
    card.append(divider);

    card.append(this.sampleCategoryStatsNode(category));

    const footer = document.createElement("div");
    footer.className = "sample-pool-card-footer";

    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "sample-pool-card-export-btn";
    exportButton.dataset.appAction = "sample-pool-export-scope";
    exportButton.dataset.id = category.id || "";
    exportButton.dataset.stopPropagation = "1";
    exportButton.title = "导出此样机池范围数据包";
    exportButton.ariaLabel = "导出此样机池范围数据包";
    exportButton.innerHTML = Utils.iconHtml("download");

    const destroy = document.createElement("button");
    destroy.type = "button";
    destroy.className = "sample-card-destroy-btn";
    destroy.dataset.appAction = "sample-category-delete";
    destroy.dataset.id = category.id || "";
    destroy.dataset.stopPropagation = "1";
    destroy.title = "档案销毁";
    destroy.ariaLabel = "档案销毁";
    destroy.innerHTML = Utils.iconHtml("trash");
    footer.append(destroy, exportButton);
    card.append(footer);
    return card;
  },

  sampleCategoryStatsNode(category) {
    const body = document.createElement("div");
    body.className = "sample-pool-card-body";
    const samples = category.samples || [];
    const serverCounts = category.statusCounts || {};
    const problemCounts = category.problemCounts || {};
    const count = status => serverCounts[status] ?? samples.filter(s => this.sampleEffectiveStatus(s) === status).length;
    const totalCount = category.sampleCount ?? samples.length;

    const total = document.createElement("div");
    total.className = "sample-pool-card-total";
    const totalNumber = document.createElement("b");
    totalNumber.textContent = String(totalCount);
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "台样机";
    total.append(totalNumber, totalLabel);

    const left = document.createElement("div");
    left.className = "sample-pool-card-left";
    left.append(total);

    const faultN = problemCounts.fault ?? samples.filter(s => this.sampleHasProblem(s)).length;
    const okN = problemCounts.ok ?? Math.max(Number(totalCount || 0) - Number(faultN || 0), 0);
    const reassembledN = category.reassemblyCounts?.reassembled
      ?? category.reassembledCount
      ?? samples.filter(s => this.sampleIsReassembled(s)).length;

    const qualityList = document.createElement("div");
    qualityList.className = "sample-pool-quality-list";
    [
      { label: "无故障", count: okN, cls: "ok" },
      { label: "有故障", count: faultN, cls: "fault" },
      { label: "重组", count: reassembledN, cls: "reassembly", wrapCount: true }
    ].forEach(item => {
      const chip = document.createElement("span");
      chip.className = `sample-pool-quality-chip ${item.cls}`;
      const n = document.createElement("b");
      n.textContent = item.wrapCount ? `(${item.count})` : String(item.count);
      chip.append(item.label, n);
      qualityList.append(chip);
    });
    left.append(qualityList);

    const chipClass = {
      "测试中": "testing", "闲置": "idle", "在位等待": "waiting",
      "已退库": "retired", "取走分析": "analysis"
    };
    const statusList = document.createElement("div");
    statusList.className = "sample-pool-status-list";
    ["闲置", "在位等待", "测试中", "取走分析", "已退库"].forEach(status => {
      const row = document.createElement("div");
      row.className = `sample-pool-status-row ${chipClass[status] || ""}`.trim();
      const dot = document.createElement("span");
      dot.className = "sample-pool-status-dot";
      const label = document.createElement("span");
      label.className = "sample-pool-status-name";
      label.textContent = status;
      const value = document.createElement("b");
      value.className = "sample-pool-status-count";
      value.textContent = String(count(status));
      row.append(dot, label, value);
      statusList.append(row);
    });

    body.append(left, statusList);
    return body;
  },

  addSampleCategoryCardNode() {
    const card = document.createElement("div");
    card.className = "card add-card";
    card.dataset.appAction = "sample-category-add";
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    const plus = document.createElement("div");
    plus.className = "add-card-plus";
    plus.textContent = "+";
    const label = document.createElement("div");
    label.className = "add-card-label";
    label.textContent = "新增样机池";
    card.append(plus, label);
    return card;
  },

  sampleCategoryFooterNode() {
    const p = document.createElement("p");
    p.className = "page-footer-text";
    p.textContent = "📦 可创建多个样机池   |   普通样机的 SN / IMEI / 主板SN 保持唯一，重组样机允许关联重复标识   |   项目管理中的测试任务可自由地在多个样机池内选取";
    return p;
  },

  sampleUsageStatusClass(status) {
    if (status === "闲置") return "idle";
    if (status === "测试中") return "testing";
    if (status === "在位等待") return "waiting";
    if (status === "已退库") return "retired";
    if (status === "取走分析") return "analysis";
    return "unknown";
  },

  sampleProblemSummaryText(sample) {
    const records = this.sampleProblemRecords(sample);
    const text = records.map(record => record.description || record).filter(Boolean).join(" / ");
    return text || (this.sampleHasProblem(sample) ? "有历史问题" : "无");
  },

  sampleCardHtml(s) {
    const usageStatus = this.normalizeSampleStatusValue(s.status || s.effectiveStatus);
    const usageClass = this.sampleUsageStatusClass(usageStatus);
    const hasProblem = this.sampleHasProblem(s);
    const qualityText = hasProblem ? "有故障" : "无故障";
    const isReassembled = this.sampleIsReassembled(s);
    const reassemblyText = isReassembled ? "重组" : "非重组";
    const problemText = this.sampleProblemSummaryText(s);
    const stageText = [s.sourceStageName || "-", s.sourceSkuName || "-"].filter(Boolean).join(" · ");
    const displayCode = this.sampleDisplayCode(s);
    return `<div class="card sample-card sample-archive-card status-${usageClass} ${hasProblem ? "has-problem" : "is-ok"}" data-usage-status="${Utils.esc(usageStatus)}" data-quality-status="${hasProblem ? "fault" : "ok"}" data-reassembly-status="${isReassembled ? "reassembled" : "normal"}" data-app-action="sample-open" data-id="${Utils.esc(s.id)}">
      <div class="sample-card-top">
        <button type="button" class="sample-card-code sample-card-open-btn" data-app-action="sample-open" data-id="${Utils.esc(s.id)}" aria-label="查看样机 ${Utils.esc(displayCode)}">${Utils.esc(displayCode)}</button>
        <button type="button" class="sample-card-destroy-btn" data-app-action="sample-destroy" data-id="${Utils.esc(s.id)}" data-stop-propagation="1" title="档案销毁" aria-label="档案销毁">${Utils.iconHtml("trash")}</button>
      </div>
      <div class="sample-card-content">
        <div class="sample-card-main">
          <div class="sample-card-ident">
            <div class="sample-card-line"><span>SN:</span><b>${Utils.esc(s.sn || "NA")}</b></div>
            <div class="sample-card-line"><span>IMEI:</span><b>${Utils.esc(s.imei || "NA")}</b></div>
            <div class="sample-card-line"><span>主板SN:</span><b>${Utils.esc(s.boardSn || "NA")}</b></div>
          </div>
          <div class="sample-card-detail">
            <div class="sample-card-line wide"><span>阶段:</span><b>${Utils.esc(stageText)}</b></div>
            <div class="sample-card-line issue ${hasProblem ? "has-issue" : ""}"><span>问题:</span><b>${Utils.esc(problemText)}</b></div>
            <div class="sample-card-line history"><span>测试履历：</span><b>${Number.isInteger(s.testHistoryCount) && s.testHistoryCount >= 0 ? s.testHistoryCount + "项" : "—"}</b></div>
          </div>
        </div>
        <div class="sample-card-statuses">
          <span class="sample-state-badge reassembly ${isReassembled ? "reassembled" : "normal"}" title="重组状态">${Utils.esc(reassemblyText)}</span>
          <span class="sample-state-badge usage s-${Utils.esc(usageStatus)}" title="使用状态">${Utils.esc(usageStatus)}</span>
          <span class="sample-state-badge quality ${hasProblem ? "fault" : "ok"}" title="故障状态">${Utils.esc(qualityText)}</span>
        </div>
      </div>
    </div>`;
  },

  sampleDisplayCode(s) {
    const sn = String(s?.sn || "").trim();
    const imei = String(s?.imei || "").trim();
    const boardSn = String(s?.boardSn || "").trim();
    // 末 8 位足够避免大多数串号重码；同时仍保持简洁，不足 8 位前面补 0
    if (sn) return `SN #${sn.slice(-8).padStart(8, "0")}`;
    if (imei) return `IMEI #${imei.slice(-8).padStart(8, "0")}`;
    if (boardSn) return `主板SN #${boardSn.slice(-8).padStart(8, "0")}`;
    return "未录入SN/IMEI/主板SN";
  },

  sampleStatusStatClass(status) {
    if (status === "闲置") return "stat-done";
    if (status === "测试中") return "stat-running";
    if (status === "在位等待") return "stat-pending";
    if (["已退库", "取走分析"].includes(status)) return "stat-blocked";
    return "stat-total";
  },

  // ---- 类别 CRUD ----,

  sampleCategoryNameExists(name, excludeId = "") {
    const normalized = String(name || "").trim().toLowerCase();
    if (!normalized) return false;
    return this.sampleCategoryRecords().some(c =>
      c.id !== excludeId && String(c.name || "").trim().toLowerCase() === normalized
    );
  },

  addSampleCategory() {
    this.showModal("新建样机池", `
      <div class="form-group"><label class="req">代号</label><input id="catName"></div>
      <div class="form-group"><label>说明</label><textarea id="catDesc" placeholder="如 新一代小内折手机 / TSE是张三 / 此为特稿保密项目"></textarea></div>
    `, async () => {
      this.clearFieldValidationMarks();
      const snapshot = this.dataSnapshot();
      const nameEl = document.getElementById("catName");
      const name = nameEl.value.trim();
      if (!name) { this.markFieldInvalid(nameEl, "代号不能为空"); return true; }
      if (this.sampleCategoryNameExists(name)) { this.markFieldInvalid(nameEl, `样机池名称"${name}"已存在，不能重复创建。`); return true; }
      const c = { id: Utils.id("cat_"), name, description: document.getElementById("catDesc").value.trim(), createdAt: Utils.now(), samples: [] };
      this.sampleCategoryRecords().push(c);
      this.patchViewState({ selectedCategoryId: null });
      const saved = await this.commitSampleCategoryMutation(c, {
        action: "create_sample_category",
        remark: "新建样机池",
        user: "管理员",
        createIfMissing: true
      });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("样机池已新建");
      return false;
    });
  },

  editSampleCategory(id) {
    let c = this.sampleCategoryRecords().find(x => x.id === id);
    if (!c) return;
    this.showModal("编辑样机池", `
      <div class="form-group"><label class="req">代号</label><input id="catName" value="${Utils.esc(c.name)}"></div>
      <div class="form-group"><label>说明</label><textarea id="catDesc" placeholder="如 新一代小内折手机 / TSE是张三 / 此为特稿保密项目">${Utils.esc(c.description || "")}</textarea></div>
    `, async () => {
      this.clearFieldValidationMarks();
      c = this.sampleCategoryRecords().find(x => x.id === id);
      if (!c) { Utils.toast("样机池已不存在，请重新选择"); return false; }
      const snapshot = this.dataSnapshot();
      const nameEl = document.getElementById("catName");
      const name = nameEl.value.trim();
      if (!name) { this.markFieldInvalid(nameEl, "代号不能为空"); return true; }
      if (this.sampleCategoryNameExists(name, c.id)) { this.markFieldInvalid(nameEl, `样机池名称"${name}"已存在，不能重复命名。`); return true; }
      c.name = name;
      c.description = document.getElementById("catDesc").value.trim();
      const saved = await this.commitSampleCategoryMutation(c, {
        action: "update_sample_category",
        remark: "编辑样机池",
        user: "管理员"
      });
      if (!saved) { this.restoreDataSnapshot(snapshot); return true; }
      Utils.toast("样机池已保存");
      return false;
    });
  },

  openCategory(id) { this.selectSampleCategoryState(id); this.render(); },

  // ---- 新建样机（简化：不强制项目/阶段/SKU）----,

});
