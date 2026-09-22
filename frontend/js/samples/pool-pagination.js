/* 样机分页读取、筛选和预取缓存。请求序号与缓存代次共同拦截旧响应；预取不得覆盖未保存编辑。
 * 通过 app.registerModule 暴露方法；页面结构与业务规则沿用原实现。
 */
app.registerModule("samples.pool-pagination", {

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

  beginSamplePageRequest(key) {
    if (!(this._samplePageRequests instanceof Map)) this._samplePageRequests = new Map();
    const request = { generation: this._samplePageCacheGeneration || 0 };
    this._samplePageRequests.set(key, request);
    this.samplePageLoadingSet().add(key);
    this._samplePageLoadingKey = key;
    return request;
  },

  finishSamplePageRequest(key, request) {
    if (this._samplePageRequests?.get(key) !== request) return false;
    this._samplePageRequests.delete(key);
    this.samplePageLoadingSet().delete(key);
    if (this._samplePageLoadingKey === key) this._samplePageLoadingKey = "";
    return request.generation === (this._samplePageCacheGeneration || 0);
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
    if (typeof this.sampleCategoryRecords === "function") {
      cat = this.sampleCategoryRecords().find(category => category.id === cat?.id);
      if (!cat) return null;
    }
    const items = [];
    const hadLocalUnsavedChanges = this.hasLocalUnsavedChanges?.() === true;
    const byId = new Map((cat.samples || []).map(sample => [String(sample.id || ""), sample]));
    const baseSamples = this._baseData?.sampleLibrary?.categories?.find(item => item.id === cat.id)?.samples || [];
    const baseById = new Map(baseSamples.map(sample => [String(sample.id || ""), sample]));
    const baselineItems = [];
    (result.items || []).forEach(sample => {
      if (!sample?.id) return;
      const existing = byId.get(String(sample.id));
      if (existing) {
        const baseline = baseById.get(String(sample.id));
        Object.entries(sample).forEach(([field, value]) => {
          if (!hadLocalUnsavedChanges || !baseline || JSON.stringify(existing[field]) === JSON.stringify(baseline[field])) {
            existing[field] = value;
          }
        });
        if (!hadLocalUnsavedChanges) this.sampleProblemRecords?.(existing);
        baselineItems.push({ source: sample, merged: existing });
        items.push(existing);
      } else {
        if (!Array.isArray(cat.samples)) cat.samples = [];
        if (!hadLocalUnsavedChanges) this.sampleProblemRecords?.(sample);
        cat.samples.push(sample);
        baselineItems.push({ source: sample, merged: sample });
        items.push(sample);
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
    const request = this.beginSamplePageRequest(key);
    try {
      const result = await this.fetchSamplePage(cat.id, params);
      if (!this.finishSamplePageRequest(key, request)) return false;
      const entry = this.storeSamplePageResult(cat, key, params, result);
      if (!entry) return false;
      if (this.isCurrentSampleCategoryPage(cat.id)) {
        this.refreshSamplePageRegion(cat);
        this.prefetchAdjacentSamplePages(cat, entry, params);
      }
      return true;
    } catch (e) {
      if (!this.finishSamplePageRequest(key, request)) return false;
      this.storeSamplePageError(cat, key, params, e.message);
      console.error("样机分页刷新失败：", e);
      if (this.isCurrentSampleCategoryPage(cat.id)) this.refreshSamplePageRegion(cat);
      return false;
    }
  },

  loadSampleCategorySummary() {
    if (this._sampleCategorySummaryLoaded || this._sampleCategorySummaryLoading) return;
    this._sampleCategorySummaryLoading = true;
    const generation = this._samplePageCacheGeneration || 0;
    this.fetchSampleCategoriesSummary()
      .then(categories => {
        if (generation !== (this._samplePageCacheGeneration || 0)) return;
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
        if (generation !== (this._samplePageCacheGeneration || 0)) return;
        this._sampleCategorySummaryLoading = false;
        console.error("样机池摘要加载失败：", e);
      });
  },

  loadSamplePage(cat, key, params, { prefetch = false } = {}) {
    if (!cat?.id || this.getSamplePageCache(key)) return;
    const loadingSet = this.samplePageLoadingSet();
    if (loadingSet.has(key)) return;
    const request = this.beginSamplePageRequest(key);
    return this.fetchSamplePage(cat.id, params)
      .then(result => {
        if (!this.finishSamplePageRequest(key, request)) return;
        const entry = this.storeSamplePageResult(cat, key, params, result);
        if (!entry) return;
        if (!prefetch && this.isCurrentSampleCategoryPage(cat.id)) {
          this.refreshSamplePageRegion(cat);
          this.prefetchAdjacentSamplePages(cat, entry, params);
        }
      })
      .catch(e => {
        if (!this.finishSamplePageRequest(key, request)) return;
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
    const generation = this._samplePageCacheGeneration || 0;
    const run = () => {
      if (generation !== (this._samplePageCacheGeneration || 0)) return;
      candidates.forEach(targetPage => {
      const nextParams = { ...params, page: targetPage };
      const key = this.samplePageCacheKey(cat, nextParams);
      if (!this.getSamplePageCache(key) && !this.samplePageLoadingSet().has(key)) {
        this.loadSamplePage(cat, key, nextParams, { prefetch: true });
      }
      });
    };
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

});
