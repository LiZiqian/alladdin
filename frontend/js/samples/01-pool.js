/* ========================================
   TestChamber V7 - Sample pool cards, CRUD, destroy impact
   Split from the previous monolithic module.
   ======================================== */

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
    summary.textContent = `显示 ${start}-${end} / ${total} 台`;
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

  setSamplePage(page) {
    this.setSamplePoolPageState(page);
    const cat = this.currentSampleCategory();
    if (cat && this.isCurrentSampleCategoryPage(cat.id)) this.refreshSamplePageRegion(cat);
    else this.renderSamples();
  },

  setSamplePageSize(size) {
    this.setSamplePoolPageSizeState(size, 100);
    this.renderSamples();
  },

  updateSamplePoolFilter(name, value, { render = true } = {}) {
    if (!this.setSamplePoolFilterState(name, value, { resetPage: render })) return;
    if (render) {
      this.renderSamples();
    }
  },

  clearSamplePoolFilters() {
    this.resetSamplePoolFiltersState();
    this.renderSamples();
  },

  samplePageQueryParams(cat) {
    const state = this.samplePoolPageState(100);
    const params = {
      page: state.page,
      pageSize: state.pageSize
    };
    Object.entries(state.filters).forEach(([key, value]) => {
      const text = String(value || "").trim();
      if (text) params[key] = text;
    });
    params.categoryId = cat?.id || "";
    return params;
  },

  samplePageCacheKey(cat, params) {
    return JSON.stringify({ categoryId: cat?.id || "", ...params });
  },

  samplePageFilterKey(cat, params) {
    const copy = { ...(params || {}) };
    delete copy.page;
    return JSON.stringify({ categoryId: cat?.id || "", ...copy });
  },

  samplePageCacheStore() {
    if (!(this._samplePageCaches instanceof Map)) this._samplePageCaches = new Map();
    return this._samplePageCaches;
  },

  samplePageMetaStore() {
    if (!(this._samplePageMetaCaches instanceof Map)) this._samplePageMetaCaches = new Map();
    return this._samplePageMetaCaches;
  },

  samplePageLoadingSet() {
    if (!(this._samplePageLoadingKeys instanceof Set)) this._samplePageLoadingKeys = new Set();
    return this._samplePageLoadingKeys;
  },

  getSamplePageCache(key) {
    return this.samplePageCacheStore().get(key) || (this._samplePageCache?.key === key ? this._samplePageCache : null);
  },

  setSamplePageCache(entry) {
    if (!entry?.key) return;
    const store = this.samplePageCacheStore();
    store.set(entry.key, entry);
    while (store.size > 24) store.delete(store.keys().next().value);
    this._samplePageCache = entry;
  },

  setSamplePageMeta(filterKey, entry) {
    if (!filterKey || !entry) return;
    const store = this.samplePageMetaStore();
    store.set(filterKey, {
      categoryId: entry.categoryId,
      total: Number(entry.total || 0),
      totalPages: Number(entry.totalPages || 1),
      pageSize: Number(entry.pageSize || 100),
      stats: entry.stats || {},
      category: entry.category || {}
    });
    while (store.size > 24) store.delete(store.keys().next().value);
  },

  storeSamplePageResult(cat, key, params, result = {}) {
    const items = result.items || [];
    const hadLocalUnsavedChanges = this.hasLocalUnsavedChanges?.() === true;
    const byId = new Map((cat.samples || []).map(sample => [String(sample.id || ""), sample]));
    const baselineItems = [];
    items.forEach(sample => {
      if (!sample?.id) return;
      const existing = byId.get(String(sample.id));
      if (existing) {
        Object.assign(existing, sample);
        if (!hadLocalUnsavedChanges) this.sampleProblemRecords?.(existing);
        baselineItems.push({ source: sample, merged: existing });
      } else {
        if (!Array.isArray(cat.samples)) cat.samples = [];
        if (!hadLocalUnsavedChanges) this.sampleProblemRecords?.(sample);
        cat.samples.push(sample);
        baselineItems.push({ source: sample, merged: sample });
      }
    });
    Object.assign(cat, result.category || {});
    cat.sampleCount = result.stats?.totalInCategory ?? result.total ?? cat.sampleCount;
    cat.statusCounts = result.stats?.statusCounts || cat.statusCounts || {};
    cat.problemCounts = result.stats?.problemCounts || cat.problemCounts || {};
    this.syncHydratedCategoryBaseline?.({
      id: cat.id,
      ...(result.category || {}),
      sampleCount: result.stats?.totalInCategory ?? result.total ?? cat.sampleCount,
      statusCounts: result.stats?.statusCounts || cat.statusCounts || {},
      problemCounts: result.stats?.problemCounts || cat.problemCounts || {},
    });
    baselineItems.forEach(({ source, merged }) => {
      this.syncHydratedSampleBaseline?.(cat.id, hadLocalUnsavedChanges ? source : merged);
    });
    const entry = { key, filterKey: this.samplePageFilterKey(cat, params), categoryId: cat.id, ...result, items };
    this.setSamplePageCache(entry);
    this.setSamplePageMeta(entry.filterKey, entry);
    return entry;
  },

  storeSamplePageError(cat, key, params, message) {
    const entry = {
      key,
      filterKey: this.samplePageFilterKey(cat, params),
      categoryId: cat.id,
      error: message,
      items: [],
      page: params.page,
      pageSize: params.pageSize,
      total: 0,
      totalPages: 1
    };
    this.setSamplePageCache(entry);
    return entry;
  },

  async refreshCurrentSamplePage(cat) {
    if (!cat?.id || typeof this.fetchSamplePage !== "function") return false;
    const params = this.samplePageQueryParams(cat);
    const key = this.samplePageCacheKey(cat, params);
    const loadingSet = this.samplePageLoadingSet();
    loadingSet.add(key);
    this._samplePageLoadingKey = key;
    try {
      const result = await this.fetchSamplePage(cat.id, params);
      loadingSet.delete(key);
      if (this._samplePageLoadingKey === key) this._samplePageLoadingKey = "";
      const entry = this.storeSamplePageResult(cat, key, params, result);
      if (this.isCurrentSampleCategoryPage(cat.id)) {
        this.refreshSamplePageRegion(cat);
        this.prefetchAdjacentSamplePages(cat, entry, params);
      }
      return true;
    } catch (e) {
      loadingSet.delete(key);
      if (this._samplePageLoadingKey === key) this._samplePageLoadingKey = "";
      this.storeSamplePageError(cat, key, params, e.message);
      console.error("样机分页刷新失败：", e);
      if (this.isCurrentSampleCategoryPage(cat.id)) this.refreshSamplePageRegion(cat);
      return false;
    }
  },

  loadSampleCategorySummary() {
    if (this._sampleCategorySummaryLoaded || this._sampleCategorySummaryLoading) return;
    this._sampleCategorySummaryLoading = true;
    this.fetchSampleCategoriesSummary()
      .then(categories => {
        this._sampleCategorySummaryLoading = false;
        const categoryRecords = this.sampleCategoryRecords();
        const byId = new Map(categoryRecords.map(cat => [String(cat.id || ""), cat]));
        categories.forEach(summary => {
          const cat = byId.get(String(summary.id || ""));
          if (cat) Object.assign(cat, summary);
          else categoryRecords.push({ ...summary, samples: [] });
          this.syncHydratedCategoryBaseline?.(summary);
        });
        this._sampleCategorySummaryLoaded = true;
        if (this.viewModule() === "samples" && !this.selectedCategoryId()) this.renderSamples();
      })
      .catch(e => {
        this._sampleCategorySummaryLoading = false;
        console.error("样机池摘要加载失败：", e);
      });
  },

  loadSamplePage(cat, key, params, { prefetch = false } = {}) {
    if (!cat?.id || this.getSamplePageCache(key)) return;
    const loadingSet = this.samplePageLoadingSet();
    if (loadingSet.has(key)) return;
    loadingSet.add(key);
    this._samplePageLoadingKey = key;
    this.fetchSamplePage(cat.id, params)
      .then(result => {
        loadingSet.delete(key);
        if (this._samplePageLoadingKey === key) this._samplePageLoadingKey = "";
        const entry = this.storeSamplePageResult(cat, key, params, result);
        if (!prefetch && this.isCurrentSampleCategoryPage(cat.id)) {
          this.refreshSamplePageRegion(cat);
          this.prefetchAdjacentSamplePages(cat, entry, params);
        }
      })
      .catch(e => {
        loadingSet.delete(key);
        if (this._samplePageLoadingKey === key) this._samplePageLoadingKey = "";
        this.storeSamplePageError(cat, key, params, e.message);
        console.error("样机分页加载失败：", e);
        if (!prefetch && this.isCurrentSampleCategoryPage(cat.id)) this.refreshSamplePageRegion(cat);
      });
  },

  prefetchAdjacentSamplePages(cat, entry, params) {
    if (this._samplePagePrefetchDisabled || !entry || entry.error) return;
    const page = Number.parseInt(entry.page || params.page, 10) || 1;
    const totalPages = Number.parseInt(entry.totalPages || 1, 10) || 1;
    const candidates = [page + 1, page - 1].filter(p => p >= 1 && p <= totalPages);
    if (!candidates.length) return;
    const run = () => candidates.forEach(targetPage => {
      const nextParams = { ...params, page: targetPage };
      const key = this.samplePageCacheKey(cat, nextParams);
      if (!this.getSamplePageCache(key) && !this.samplePageLoadingSet().has(key)) {
        this.loadSamplePage(cat, key, nextParams, { prefetch: true });
      }
    });
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 600 });
    } else if (typeof setTimeout === "function") {
      setTimeout(run, 80);
    } else {
      run();
    }
  },

  samplePageState(cat, { startLoad = true } = {}) {
    const params = this.samplePageQueryParams(cat);
    const key = this.samplePageCacheKey(cat, params);
    const filterKey = this.samplePageFilterKey(cat, params);
    const cached = this.getSamplePageCache(key);
    const meta = cached || this.samplePageMetaStore().get(filterKey) || null;
    if (!cached && startLoad) this.loadSamplePage(cat, key, params);
    const loading = !cached && this.samplePageLoadingSet().has(key);
    const pageSize = Number.parseInt(cached?.pageSize || meta?.pageSize || params.pageSize, 10) || params.pageSize;
    const fallbackTotal = Number(cat.sampleCount ?? (Array.isArray(cat.samples) ? cat.samples.length : 0)) || 0;
    const total = Number(cached?.total ?? meta?.total ?? fallbackTotal) || 0;
    const totalPages = Number(cached?.totalPages ?? meta?.totalPages ?? Math.max(1, Math.ceil(total / pageSize))) || 1;
    const rawPage = Number.parseInt(cached?.page || params.page, 10) || 1;
    const page = Math.min(Math.max(1, rawPage), totalPages);
    this.setSamplePoolPageState(page);
    return { cat, params, key, filterKey, cached, meta, loading, page, pageSize, total, totalPages, items: cached?.items || [] };
  },

  samplePoolCountText(cat, state) {
    const totalInCategory = state.cached?.stats?.totalInCategory
      ?? state.meta?.stats?.totalInCategory
      ?? cat.sampleCount
      ?? (cat.samples || []).length;
    return state.loading && !state.cached
      ? `加载第 ${state.page} 页 / ${totalInCategory} 台`
      : `显示 ${state.total} / ${totalInCategory} 台`;
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
    const role = this.samplePoolAccessRole ? this.samplePoolAccessRole(cat) : "local_admin";
    const nodes = ["local_admin", "pool_maintainer", "pool_admin"].includes(role) ? [this.sampleAddCardNode(cat)] : [];
    if (state.loading && !state.cached) {
      nodes.push(this.sampleEmptyHintNode(`正在加载第 ${state.page} 页样机...`, "sample-page-loading"));
    } else if (state.cached?.error) {
      nodes.push(this.sampleEmptyHintNode(`样机分页加载失败：${state.cached.error}`));
    } else if (state.items.length) {
      state.items.forEach(sample => {
        const holder = document.createDocumentFragment ? document.createDocumentFragment() : document.createElement("div");
        this.appendHtmlFragment(holder, this.sampleCardHtml(sample));
        nodes.push(...Array.from(holder.childNodes || holder.children || []));
      });
    } else {
      nodes.push(this.sampleEmptyHintNode("暂无样机"));
    }
    return nodes;
  },

  refreshSamplePageRegion(cat) {
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
    search.placeholder = "样机详情 / 问题 / 履历搜索（回车搜索）";
    search.setAttribute("aria-label", "搜索样机详情、问题和履历");
    search.value = filters.keyword || "";
    search.dataset.appAction = "sample-filter-search";
    search.dataset.appEvents = "input keydown";
    filterBar.append(search);
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-status", "status", "全部使用状态", this.constants.sampleStatuses, filters.status, "使用状态筛选"));
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-result", "problemState", "全部故障状态", [
      { value: "fault", label: "有故障" },
      { value: "ok", label: "无故障" }
    ], filters.problemState, "故障状态筛选"));
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-reassembly", "reassembled", "全部重组状态", [
      { value: "normal", label: "非重组" },
      { value: "reassembled", label: "重组" }
    ], filters.reassembled, "重组状态筛选"));
    const owners = [...new Set((cat.samples || []).map(s => s.owner).filter(Boolean))].sort();
    const borrowers = [...new Set((cat.samples || []).map(s => s.borrower).filter(Boolean))].sort();
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-person", "owner", "全部挂账人", owners, filters.owner, "挂账人筛选"));
    filterBar.append(this.sampleFilterSelectNode("sample-pool-filter-person", "borrower", "全部持有人", borrowers, filters.borrower, "持有人筛选"));
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
    batch.className = "btn btn-purple sample-pool-main-btn";
    batch.dataset.appAction = "sample-batch-import";
    batch.dataset.id = cat.id || "";
    batch.textContent = "批量新增";
    const role = this.samplePoolAccessRole ? this.samplePoolAccessRole(cat) : "local_admin";
    if (["local_admin", "pool_maintainer", "pool_admin"].includes(role)) {
      actions.append(template, batch);
      toolbar.append(actions);
    }
    return toolbar;
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
    if (this.isLocalAdminAccess ? this.isLocalAdminAccess() : true) grid.append(this.addSampleCategoryCardNode());
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
    const canOpen = this.resourceCanOpen ? this.resourceCanOpen(category) : category.canOpen !== false;
    const canManage = this.resourceCanManage ? this.resourceCanManage(category) : category.canManage !== false;
    const localAdmin = this.isLocalAdminAccess ? this.isLocalAdminAccess() : true;
    const card = document.createElement("div");
    card.className = `card sample-card access-resource-card${canOpen ? "" : " access-resource-locked"}`;
    card.dataset.resourceType = "pool";
    card.dataset.id = category.id || "";
    if (!canOpen) card.title = "当前 IP 未获授权，请点击下方按钮查看说明";

    const header = document.createElement("div");
    header.className = "sample-pool-card-header";
    const name = document.createElement("span");
    name.className = "sample-pool-card-name";
    name.textContent = category.name || "";
    header.append(name);
    if (canManage) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "sample-card-edit-btn";
      edit.dataset.appAction = "sample-category-edit";
      edit.dataset.id = category.id || "";
      edit.dataset.stopPropagation = "1";
      edit.title = "编辑样机池";
      edit.textContent = "✎";
      header.append(edit);
    }
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
    enterRow.className = "project-card-enter-row sample-pool-card-enter-row";
    const enterButton = document.createElement("button");
    enterButton.type = "button";
    enterButton.className = "btn project-card-enter-btn sample-pool-card-enter-btn";
    enterButton.dataset.appAction = canOpen ? "sample-category-open" : "access-denied";
    enterButton.dataset.resourceType = "pool";
    enterButton.dataset.id = category.id || "";
    enterButton.append(document.createTextNode(canOpen ? "进入样机池" : "未授权"));
    const arrow = document.createElement("b");
    arrow.textContent = canOpen ? "▶" : "🔒";
    enterButton.append(arrow);
    enterRow.append(enterButton);
    card.append(enterRow);

    const divider = document.createElement("div");
    divider.className = "sample-pool-card-divider";
    card.append(divider);

    card.append(this.sampleCategoryStatsNode(category));

    const footer = document.createElement("div");
    footer.className = "project-card-footer sample-pool-card-footer";

    const roleBadge = document.createElement("span");
    roleBadge.className = `access-role-badge role-${category.accessRole || (localAdmin ? "local_admin" : "none")}`;
    roleBadge.textContent = this.accessRoleLabel ? this.accessRoleLabel(category.accessRole || (localAdmin ? "local_admin" : "none")) : (canOpen ? "可访问" : "未授权");

    const controls = document.createElement("span");
    controls.className = "access-card-controls project-card-footer-controls sample-pool-card-footer-controls";
    if (canManage) {
      const acl = document.createElement("button");
      acl.type = "button";
      acl.className = "access-card-acl-btn";
      acl.dataset.appAction = "access-rules-open";
      acl.dataset.resourceType = "pool";
      acl.dataset.id = category.id || "";
      acl.dataset.stopPropagation = "1";
      acl.title = "管理样机池 IP 访问名单";
      acl.ariaLabel = "管理样机池 IP 访问名单";
      acl.textContent = "🛡️";
      controls.append(acl);

      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "access-card-export-btn";
      exportButton.dataset.appAction = "sample-pool-export-scope";
      exportButton.dataset.id = category.id || "";
      exportButton.dataset.stopPropagation = "1";
      exportButton.title = "导出此样机池范围数据包";
      exportButton.ariaLabel = "导出此样机池范围数据包";
      exportButton.textContent = "⇩";
      controls.append(exportButton);

      const destroy = document.createElement("button");
      destroy.type = "button";
      destroy.className = "sample-card-destroy-btn";
      destroy.dataset.appAction = "sample-category-delete";
      destroy.dataset.id = category.id || "";
      destroy.dataset.stopPropagation = "1";
      destroy.title = "档案销毁";
      destroy.ariaLabel = "档案销毁";
      destroy.textContent = "🗑";
      controls.append(destroy);
    }
    footer.append(roleBadge, controls);
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
    const canDestroy = ["local_admin", "pool_admin"].includes(this.samplePoolAccessRole ? this.samplePoolAccessRole() : "local_admin");
    return `<div class="card sample-card sample-archive-card status-${usageClass} ${hasProblem ? "has-problem" : "is-ok"}" data-usage-status="${Utils.esc(usageStatus)}" data-quality-status="${hasProblem ? "fault" : "ok"}" data-reassembly-status="${isReassembled ? "reassembled" : "normal"}" data-app-action="sample-open" data-id="${Utils.esc(s.id)}">
      <div class="sample-card-top">
        <button type="button" class="sample-card-code sample-card-open-btn" data-app-action="sample-open" data-id="${Utils.esc(s.id)}" aria-label="查看样机 ${Utils.esc(displayCode)}">${Utils.esc(displayCode)}</button>
        ${canDestroy ? `<button type="button" class="sample-card-destroy-btn" data-app-action="sample-destroy" data-id="${Utils.esc(s.id)}" data-stop-propagation="1" title="档案销毁" aria-label="档案销毁">🗑</button>` : ""}
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
    const c = this.sampleCategoryRecords().find(x => x.id === id);
    if (!c) return;
    this.showModal("编辑样机池", `
      <div class="form-group"><label class="req">代号</label><input id="catName" value="${Utils.esc(c.name)}"></div>
      <div class="form-group"><label>说明</label><textarea id="catDesc" placeholder="如 新一代小内折手机 / TSE是张三 / 此为特稿保密项目">${Utils.esc(c.description || "")}</textarea></div>
    `, async () => {
      this.clearFieldValidationMarks();
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

  async deleteSampleCategory(id) {
    const destroyScope = await this.ensureSampleDestroyImpactScope({ categoryId: id });
    if (!destroyScope) return;
    const c = this.sampleCategoryRecords().find(x => x.id === id);
    if (!c) return;
    const impact = this.collectSampleCategoryDestroyImpact(c);
    const localAdmin = typeof this.isLocalAdminAccess !== "function" || this.isLocalAdminAccess();
    if (!localAdmin && destroyScope.serverManagedLinkage) impact.serverScope = destroyScope;
    this.confirmDeleteKeyword(
      "档案销毁",
      "档案销毁会物理删除该样机池、池内样机、照片/CT文件、问题表和样机事件数据。此操作不可恢复。",
      async () => {
        const dataSnapshot = this.dataSnapshot();
        const destroyedIds = new Set((c.samples || []).map(sample => String(sample?.id || "")).filter(Boolean));
        const impactedItems = [
          ...(impact.runningOrBlocked || []),
          ...(impact.pending || [])
        ];
        const affectedSampleIds = new Set();
        if (localAdmin) {
          impactedItems.forEach(item => {
            (item.allSampleIds || item.task?.sampleIds || []).forEach(id => {
              const sid = String(id || "");
              if (sid && !destroyedIds.has(sid)) affectedSampleIds.add(sid);
            });
          });
          this.applySampleCategoryDestroyImpact(c, impact);
        }
        const taskMutations = localAdmin
          ? impactedItems.map(item => this.taskMutationPayloadFor(item.project, item.stage, item.task)).filter(item => item?.taskId)
          : [];
        const affectedSamples = localAdmin
          ? [...affectedSampleIds].map(id => this.findSample(id)?.sample).filter(Boolean)
          : [];
        const eventSampleIds = new Set([...destroyedIds, ...affectedSampleIds]);
        const sampleEvents = localAdmin
          ? this.sampleEventRecords().filter(log => eventSampleIds.has(String(log?.sampleId || "")))
          : [];
        const categoryRecords = this.sampleCategoryRecords();
        const categoryIndex = categoryRecords.findIndex(x => x.id === id);
        if (categoryIndex >= 0) categoryRecords.splice(categoryIndex, 1);
        this.patchViewState({ selectedCategoryId: null });
        const mutationOptions = {
          action: "destroy_sample_category",
          remark: "样机池档案销毁",
          user: "管理员",
          deleteCategory: true,
          render: false
        };
        if (localAdmin) Object.assign(mutationOptions, { taskMutations, samples: affectedSamples, sampleEvents });
        const saved = await this.commitSampleCategoryMutation(c, mutationOptions);
        if (!saved) {
          this.restoreDataSnapshot(dataSnapshot);
          return true;
        }
        this.renderSamples();
        Utils.toast(localAdmin ? "样机池档案已销毁，关联任务已处理。" : "样机池档案已销毁，关联关系已由服务器处理。");
        return false;
      },
      this.sampleCategoryDestroyImpactHtml(impact)
    );
  },

  collectSampleCategoryDestroyImpact(category) {
    const samples = category?.samples || [];
    const sampleIds = new Set(samples.map(s => s.id).filter(Boolean));
    const sampleName = id => {
      const sample = samples.find(s => s.id === id) || this.findSample(id)?.sample;
      return sample ? this.sampleDisplayCode(sample) : id;
    };
    const hasArchive = samples.filter(s =>
      this.sampleHasArchiveData(s) ||
      (s.problemRecords || []).length ||
      (s.initialResults || []).length ||
      String(s.initialResult || "").trim()
    ).length;
    const runningOrBlocked = [];
    const pending = [];
    const defaultProjects = this.projectRecords().filter(project => String(project?.defaultSampleCategoryId || "") === String(category?.id || ""));
    this.projectRecords().forEach(project => (project.stages || []).forEach(stage => (stage.tasks || []).forEach(task => {
      if (!task || task.archived || this.isTaskCompleted(task)) return;
      const matchedIds = (task.sampleIds || []).filter(id => sampleIds.has(id));
      if (!matchedIds.length) return;
      const flow = this.taskFlowStatus(task);
      const item = {
        project, stage, task, flow,
        matchedIds,
        matchedNames: matchedIds.map(sampleName),
        allSampleIds: [...(task.sampleIds || [])],
        allSampleNames: (task.sampleIds || []).map(sampleName)
      };
      if (["进行中", "阻塞中"].includes(flow)) runningOrBlocked.push(item);
      else pending.push(item);
    })));
    return {
      categoryName: category?.name || "未命名样机池",
      sampleCount: samples.length,
      archiveCount: hasArchive,
      defaultProjects,
      runningOrBlocked,
      pending
    };
  },

  sampleCategoryDestroyImpactHtml(impact) {
    if (impact?.serverScope?.serverManagedLinkage) {
      const scope = impact.serverScope;
      const statuses = Object.entries(scope.taskStatusCounts || {})
        .map(([status, count]) => `${Utils.esc(status)} ${Number(count || 0)} 个`)
        .join("；") || "无关联任务";
      return `<div class="destroy-impact">
        <div class="destroy-impact-title">危险影响确认</div>
        <ul>
          <li><b>将删除样机池：</b><span>${Utils.esc(impact.categoryName)}，共 ${Number(scope.sampleCount ?? impact.sampleCount ?? 0)} 台样机。</span></li>
          <li><b>脱敏关联范围：</b><span>${Number(scope.projectCount || 0)} 个项目、${Number(scope.stageCount || 0)} 个阶段、${Number(scope.taskCount || 0)} 个任务；${statuses}。</span></li>
          <li><b>服务器处理：</b><span>关联项目名称和任务内容不会向当前 IP 展示；确认后由服务器在同一事务内重建关联状态。</span></li>
        </ul>
      </div>`;
    }
    const taskLine = item => `
      <li>
        <b>${Utils.esc(item.project.name)} / ${Utils.esc(item.stage.name)} / ${Utils.esc(item.task.testItem || "-")}</b>
        <span>${Utils.esc(item.flow)}；涉及 ${item.matchedNames.map(x => Utils.esc(x)).join("、")}</span>
      </li>`;
    return `<div class="destroy-impact">
      <div class="destroy-impact-title">危险影响确认</div>
      <ul>
        <li><b>将删除样机池：</b><span>${Utils.esc(impact.categoryName)}，共 ${impact.sampleCount} 台样机。</span></li>
        <li><b>档案数据：</b><span>${impact.archiveCount} 台样机含履历/照片/CT/问题表，销毁后会一起物理删除。</span></li>
        <li><b>进行中/阻塞中任务：</b><span>${impact.runningOrBlocked.length} 个任务会被自动设置为"异常终止"，任务样机列表会被清空。</span></li>
        <li><b>未启动任务：</b><span>${impact.pending.length} 个未启动任务会移除被销毁样机，并保留任务等待重新分配。</span></li>
        <li><b>项目默认样机池：</b><span>${(impact.defaultProjects || []).length} 个项目会清除该默认设置，后续分配前需重新选择默认样机池。</span></li>
      </ul>
      ${impact.runningOrBlocked.length ? `<div class="destroy-impact-subtitle">会异常终止的任务</div><ul>${impact.runningOrBlocked.map(taskLine).join("")}</ul>` : ""}
      ${impact.pending.length ? `<div class="destroy-impact-subtitle">会移除样机的未启动任务</div><ul>${impact.pending.map(taskLine).join("")}</ul>` : ""}
    </div>`;
  },

  applySampleCategoryDestroyImpact(category, impact) {
    const samples = category?.samples || [];
    const destroyedIds = new Set(samples.map(s => s.id).filter(Boolean));
    const sampleName = id => {
      const sample = samples.find(s => s.id === id) || this.findSample(id)?.sample;
      return sample ? this.sampleDisplayCode(sample) : id;
    };
    const today = Utils.today();
    const now = Utils.now();
    (impact.runningOrBlocked || []).forEach(item => {
      const task = item.task;
      const oldFlow = item.flow;
      const originalSampleIds = [...(task.sampleIds || [])];
      this.ensureTaskSampleSnapshots?.(task, originalSampleIds, { capturedAt: now, destroyedAt: now });
      const destroyedNames = item.matchedNames.join("、") || "样机";
      const reason = `${destroyedNames} 样机档案被销毁，任务无法继续。`;
      originalSampleIds.filter(id => !destroyedIds.has(id)).forEach(id => {
        if (this.findSample(id)) {
          const otherUsage = this.activeTaskUsagesForSample(id, task.id)[0];
          this.changeSampleStatus(id, otherUsage ? this.statusForOpenTaskUsage(otherUsage.task) : "闲置", {
            user: "管理员",
            source: "样机池档案销毁",
            reason: otherUsage ? `关联任务异常终止，样机仍被其他任务占用；${reason}` : `关联任务异常终止，释放样机；${reason}`,
            projectId: otherUsage?.project?.id || item.project.id,
            stageId: otherUsage?.stage?.id || item.stage.id,
            taskId: otherUsage?.task?.id || task.id,
            testItem: otherUsage?.task?.testItem || task.testItem,
            forceLog: true
          });
        }
      });
      task.sampleIds = [];
      this.transitionTaskStatus(item.stage, task, "异常终止", {
        completedAt: now,
        endDate: today,
        issue: reason
      });
      task.resultDate = today;
      task.latestResult = "不通过";
      this.addTaskLog(task, "样机池档案销毁", {
        user: "管理员",
        reason,
        fromStatus: oldFlow,
        toStatus: "异常终止",
        detail: `已清空任务样机：${originalSampleIds.map(sampleName).join("、") || "-"}`
      });
    });
    (impact.pending || []).forEach(item => {
      const task = item.task;
      const before = [...(task.sampleIds || [])];
      this.ensureTaskSampleSnapshots?.(task, before, { capturedAt: now, destroyedAt: now });
      task.sampleIds = before.filter(id => !destroyedIds.has(id));
      this.addTaskLog(task, "样机池档案销毁", {
        user: "管理员",
        reason: `${item.matchedNames.join("、")} 样机档案被销毁，已从未启动任务中移除。`,
        fromStatus: item.flow,
        toStatus: this.taskFlowStatus(task),
        detail: `任务样机：${before.map(sampleName).join("、") || "-"} → ${(task.sampleIds || []).map(sampleName).join("、") || "空"}`
      });
    });
    (impact.defaultProjects || []).forEach(project => {
      if (String(project?.defaultSampleCategoryId || "") === String(category?.id || "")) {
        project.defaultSampleCategoryId = "";
      }
    });
  },

  sampleHasArchiveData(sample) {
    return !!(
      (sample?.logs || []).length ||
      (sample?.photos || []).length ||
      (sample?.ctData || []).length ||
      (sample?.ctFiles || []).length
    );
  },

  canDestroySample(sample) {
    if (!sample) return { ok: false, reason: "样机不存在。" };
    return { ok: true, reason: "" };
  },

  collectSingleSampleDestroyImpact(sample) {
    const sampleId = sample?.id;
    if (!sampleId) return { runningOrBlocked: [], pending: [], completed: [], sample };
    const runningOrBlocked = [];
    const pending = [];
    const completedTaskRefs = [];
    this.projectRecords().forEach(project => (project.stages || []).forEach(stage => (stage.tasks || []).forEach(task => {
      if (!task || task.archived) return;
      if (!(task.sampleIds || []).includes(sampleId) && !(task.removedSampleRecords || []).some(item => item?.sampleId === sampleId)) return;
      const flow = this.taskFlowStatus(task);
      const item = { project, stage, task, flow };
      if (this.isTaskCompleted(task)) completedTaskRefs.push(item);
      else if (["进行中", "阻塞中"].includes(flow)) runningOrBlocked.push(item);
      else pending.push(item);
    })));
    return { runningOrBlocked, pending, completed: completedTaskRefs, sample };
  },

  singleSampleDestroyImpactHtml(impact) {
    const name = impact.sample ? this.sampleDisplayCode(impact.sample) : "样机";
    if (impact?.serverScope?.serverManagedLinkage) {
      const scope = impact.serverScope;
      const statuses = Object.entries(scope.taskStatusCounts || {})
        .map(([status, count]) => `${Utils.esc(status)} ${Number(count || 0)} 个`)
        .join("；") || "无关联任务";
      return `<div class="destroy-impact">
        <div class="destroy-impact-title">危险影响确认</div>
        <ul>
          <li><b>将销毁样机：</b><span>${Utils.esc(name)}。</span></li>
          <li><b>脱敏关联范围：</b><span>${Number(scope.projectCount || 0)} 个项目、${Number(scope.stageCount || 0)} 个阶段、${Number(scope.taskCount || 0)} 个任务；${statuses}。</span></li>
          <li><b>服务器处理：</b><span>关联项目名称和任务内容不会向当前 IP 展示；确认后由服务器在同一事务内重建关联状态。</span></li>
        </ul>
      </div>`;
    }
    const archiveCount = impact.sample && this.sampleHasArchiveData(impact.sample) ? 1 : 0;
    const runningCount = (impact.runningOrBlocked || []).length;
    const pendingCount = (impact.pending || []).length;
    const completedCount = (impact.completed || []).length;
    const taskLine = item => `<li><b>${Utils.esc(item.project.name)} / ${Utils.esc(item.stage.name)} / ${Utils.esc(item.task.testItem || "-")}</b><span>${Utils.esc(item.flow)}</span></li>`;
    return `<div class="destroy-impact">
      <div class="destroy-impact-title">危险影响确认</div>
      <ul>
        <li><b>将销毁样机：</b><span>${Utils.esc(name)}${archiveCount ? "，含履历/照片/CT/问题表" : ""}。</span></li>
        ${runningCount ? `<li><b>进行中/阻塞中任务：</b><span>${runningCount} 个任务会被自动设置为"异常终止"，任务样机列表会被清空。</span></li>` : ""}
        ${pendingCount ? `<li><b>未启动任务：</b><span>${pendingCount} 个未启动任务会移除该样机，并保留任务等待重新分配。</span></li>` : ""}
        ${completedCount ? `<li><b>已完成任务：</b><span>${completedCount} 个已完成任务不受影响，依赖样机快照继续展示历史。</span></li>` : ""}
        ${!runningCount && !pendingCount && !completedCount ? `<li><b>无关联任务</b><span>该样机未关联任何任务。</span></li>` : ""}
      </ul>
      ${runningCount ? `<div class="destroy-impact-subtitle">会异常终止的任务</div><ul>${(impact.runningOrBlocked || []).map(taskLine).join("")}</ul>` : ""}
      ${pendingCount ? `<div class="destroy-impact-subtitle">会移除样机的未启动任务</div><ul>${(impact.pending || []).map(taskLine).join("")}</ul>` : ""}
      ${completedCount ? `<div class="destroy-impact-subtitle">已有快照的已完成任务</div><ul>${(impact.completed || []).map(taskLine).join("")}</ul>` : ""}
    </div>`;
  },

  applySingleSampleDestroyImpact(sample, impact) {
    const sampleId = sample.id;
    const destroyedName = this.sampleDisplayCode(sample);
    const today = Utils.today();
    const now = Utils.now();
    // 处理进行中/阻塞中任务 → 异常终止
    (impact.runningOrBlocked || []).forEach(item => {
      const task = item.task;
      const oldFlow = item.flow;
      const originalSampleIds = [...(task.sampleIds || [])];
      const reason = `${destroyedName} 样机档案被销毁，任务无法继续。`;
      // 释放该任务下其它样机
      originalSampleIds.filter(id => id !== sampleId).forEach(id => {
        if (this.findSample(id)) {
          const otherUsage = this.activeTaskUsagesForSample(id, task.id)[0];
          this.changeSampleStatus(id, otherUsage ? this.statusForOpenTaskUsage(otherUsage.task) : "闲置", {
            user: "管理员",
            source: "样机档案销毁",
            reason: otherUsage ? `关联任务异常终止，样机仍被其他任务占用；${reason}` : `关联任务异常终止，释放样机；${reason}`,
            projectId: otherUsage?.project?.id || item.project.id,
            stageId: otherUsage?.stage?.id || item.stage.id,
            taskId: otherUsage?.task?.id || task.id,
            testItem: otherUsage?.task?.testItem || task.testItem,
            forceLog: true
          });
        }
      });
      // 记录退出样机
      this.recordTaskRemovedSamples(task, [sampleId], { user: "管理员", reason, removedAt: now, destroyedAt: now });
      task.sampleIds = [];
      this.transitionTaskStatus(item.stage, task, "异常终止", {
        completedAt: now,
        endDate: today,
        issue: reason
      });
      task.resultDate = today;
      task.latestResult = "不通过";
      this.addTaskLog(task, "样机档案销毁", {
        user: "管理员",
        reason,
        fromStatus: oldFlow,
        toStatus: "异常终止",
        detail: `已清空任务样机：${originalSampleIds.map(id => this.taskSampleDisplayName(id)).join("、") || "-"}`
      });
    });
    // 处理待下发任务 → 仅移除样机，不终止任务
    (impact.pending || []).forEach(item => {
      const task = item.task;
      const before = [...(task.sampleIds || [])];
      const reason = `${destroyedName} 样机档案被销毁，已从未启动任务中移除。`;
      this.recordTaskRemovedSamples(task, [sampleId], { user: "管理员", reason, removedAt: now, destroyedAt: now });
      task.sampleIds = before.filter(id => id !== sampleId);
      this.addTaskLog(task, "样机档案销毁", {
        user: "管理员",
        reason,
        fromStatus: item.flow,
        toStatus: this.taskFlowStatus(task),
        detail: `任务样机：${before.map(id => this.taskSampleDisplayName(id)).join("、") || "-"} → ${(task.sampleIds || []).map(id => this.taskSampleDisplayName(id)).join("、") || "空"}`
      });
    });
    // 已完成任务：不做任何修改，快照已在 attachSampleSnapshotToTasks 中保存
  },

  async destroySample(sampleId) {
    const destroyScope = await this.ensureSampleDestroyImpactScope({ sampleId });
    if (!destroyScope) return;
    const found = this.findSample(sampleId);
    if (!found) return;
    const check = this.canDestroySample(found.sample);
    if (!check.ok) { alert(check.reason); return; }
    const impact = this.collectSingleSampleDestroyImpact(found.sample);
    const localAdmin = typeof this.isLocalAdminAccess !== "function" || this.isLocalAdminAccess();
    if (!localAdmin && destroyScope.serverManagedLinkage) impact.serverScope = destroyScope;
    this.confirmDeleteKeyword(
      "档案销毁",
      `档案销毁会物理删除 ${this.sampleDisplayCode(found.sample)} 的样机档案、照片/CT文件和样机事件数据。此操作不可恢复。`,
      async () => {
        const dataSnapshot = this.dataSnapshot();
        const impactedItems = [
          ...(impact.runningOrBlocked || []),
          ...(impact.pending || [])
        ];
        const affectedSampleIds = new Set();
        if (localAdmin) {
          impactedItems.forEach(item => {
            (item.task?.sampleIds || []).forEach(id => {
              const sid = String(id || "");
              if (sid && sid !== sampleId) affectedSampleIds.add(sid);
            });
          });
          // 本机管理员保留原有的完整本地联动预览与提交路径。
          this.applySingleSampleDestroyImpact(found.sample, impact);
          this.changeSampleStatus(sampleId, "已退库", {
            user: "管理员",
            source: "样机档案销毁",
            reason: "样机档案被销毁，物理删除前记录最终状态",
            forceLog: true
          });
        }
        const taskMutations = localAdmin
          ? impactedItems.map(item => this.taskMutationPayloadFor(item.project, item.stage, item.task)).filter(item => item?.taskId)
          : [];
        const affectedSamples = localAdmin
          ? [...affectedSampleIds].map(id => this.findSample(id)?.sample).filter(Boolean)
          : [];
        const eventSampleIds = new Set([sampleId, ...affectedSampleIds]);
        const sampleEvents = localAdmin
          ? this.sampleEventRecords().filter(log => eventSampleIds.has(String(log?.sampleId || "")))
          : [];
        // 物理删除
        found.category.samples = (found.category.samples || []).filter(s => s.id !== sampleId);
        const mutationOptions = {
          action: "destroy_sample",
          remark: "样机档案销毁",
          user: "管理员",
          deleteSample: true,
        };
        if (localAdmin) Object.assign(mutationOptions, { taskMutations, samples: affectedSamples, sampleEvents });
        const saved = await this.commitSampleMutation(found.sample, mutationOptions);
        if (!saved) {
          this.restoreDataSnapshot(dataSnapshot);
          return true;
        }
        Utils.toast(localAdmin ? "样机档案已销毁，关联任务已处理。" : "样机档案已销毁，关联关系已由服务器处理。");
        return false;
      },
      this.singleSampleDestroyImpactHtml(impact)
    );
  },

  confirmDeleteKeyword(title, message, onConfirm, detailsHtml = "") {
    this.showModal(title, `
      <div class="delete-confirm">
        <p>${Utils.esc(message)}</p>
        ${detailsHtml || ""}
        <label>请输入 <strong>DELETE</strong> 确认销毁：</label>
        <input id="deleteKeywordInput" autocomplete="off" autofocus>
        <div id="deleteKeywordError" class="delete-confirm-error" style="display:none">请输入 DELETE 后才能继续。</div>
      </div>
    `, () => {
      const input = document.getElementById("deleteKeywordInput");
      const error = document.getElementById("deleteKeywordError");
      if ((input?.value || "") !== "DELETE") {
        if (error) error.style.display = "block";
        input?.focus();
        return true;
      }
      return onConfirm?.();
    }, "确认销毁");
    document.getElementById("deleteKeywordInput")?.focus();
  },

  openCategory(id) {
    const category = this.findSampleCategoryRecord?.(id);
    if (category && this.resourceCanOpen && !this.resourceCanOpen(category)) {
      this.showResourceAccessDenied?.("pool", id);
      return;
    }
    this.selectSampleCategoryState(id);
    this.render();
  },

  // ---- 新建样机（简化：不强制项目/阶段/SKU）----,

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
      initialResult: sourceInfo.initialResult || "",
      initialResults: Array.isArray(sourceInfo.initialResults)
        ? sourceInfo.initialResults.filter(x => !Utils.isNoSampleIssueText(x))
        : Utils.parseSampleIssueText(sourceInfo.initialResult || ""),
      problemRecords: Array.isArray(sourceInfo.problemRecords)
        ? sourceInfo.problemRecords.filter(x => !Utils.isNoSampleIssueText(x?.description || x))
        : (Array.isArray(sourceInfo.initialResults)
          ? sourceInfo.initialResults
          : Utils.parseSampleIssueText(sourceInfo.initialResult || "")
        ).filter(x => !Utils.isNoSampleIssueText(x)).map(desc => ({ id: Utils.id("problem_"), description: desc, source: "初检", taskLabel: "" })),
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
      const snapshot = this.dataSnapshot();
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
      const initialResults = problemRecords.map(x => x.description);
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

      try {
        const duplicate = await this._checkServerIdentityDuplicate(sn, imei, boardSn, isReassembled, catId, "", "sample");
        if (duplicate) { this.markFieldInvalid(document.getElementById(duplicate.fieldId), duplicate.msg); return true; }
      } catch (e) {
        alert("样机身份查重失败：" + (e.message || e));
        return true;
      }
      const sample = this.newSample(catId, sn || imei || boardSn, sn, imei, {
        stage,
        boardSn,
        isReassembled,
        standard: config,
        schemeNo: document.getElementById("sampleSchemeNo").value.trim(),
        initialResult: initialResults.join("\n"),
        initialResults,
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
