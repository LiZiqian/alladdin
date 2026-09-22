/* HTTP 查询边界。负责 URL、请求与响应解码，不修改 app.data；写入冲突由各 mutation 方法处理。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.api", {

  // Preserve the API envelope and the existing Chinese error text. This helper
  // deliberately does not retry: repeating a POST may duplicate a write.
  async requestServerJson(url, options = { cache: "no-store" }) {
    const response = await fetch(url, options);
    const result = await response.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
    if (!response.ok || !result.ok) throw new Error(result.error || ("HTTP " + response.status));
    return result;
  },

  // General list filters omit empty values but must retain numeric 0 and false.
  // Candidate dates use their own rules: an explicit empty date clears a plan.
  serverQuerySuffix(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== "" && value !== null && value !== undefined) query.set(key, value);
    });
    return query.toString() ? `?${query.toString()}` : "";
  },

  async fetchBootstrapState() {
    const obj = await this.requestServerJson("/api/bootstrap", { cache: "no-store" });
    return obj;
  },

  async fetchSamplePhotos(sampleId) {
    const json = await this.requestServerJson(`/api/samples/${encodeURIComponent(sampleId)}/photos`, { cache: "no-store" });
    return json.photos || [];
  },

  async fetchSampleEvents(sampleId) {
    const json = await this.requestServerJson(`/api/samples/${encodeURIComponent(sampleId)}/events`, { cache: "no-store" });
    return json.logs || [];
  },

  async fetchSampleHistory(sampleId, { page = 1, pageSize = 20 } = {}) {
    const params = new URLSearchParams();
    params.set("page", String(page || 1));
    params.set("pageSize", String(pageSize || 20));
    const json = await this.requestServerJson(`/api/samples/${encodeURIComponent(sampleId)}/history?${params.toString()}`, { cache: "no-store" });
    return json;
  },

  async checkSampleIdentityConflicts(samples = [], { categoryId = "" } = {}) {
    const list = Array.isArray(samples) ? samples : [samples];
    const json = await this.requestServerJson("/api/sample-identity-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId, samples: list }),
    });
    return json;
  },

  async fetchProjectSummary() {
    const json = await this.requestServerJson("/api/projects/summary", { cache: "no-store" });
    return json.projects || [];
  },

  async fetchStageTasksPage(stageId, params = {}) {
    const suffix = this.serverQuerySuffix(params);
    const json = await this.requestServerJson(`/api/stages/${encodeURIComponent(stageId)}/tasks${suffix}`, { cache: "no-store" });
    return json;
  },

  async fetchSampleCategoriesSummary() {
    const json = await this.requestServerJson("/api/sample-categories", { cache: "no-store" });
    return json.categories || [];
  },

  async fetchSamplePage(categoryId, params = {}) {
    const suffix = this.serverQuerySuffix(params);
    const json = await this.requestServerJson(`/api/sample-categories/${encodeURIComponent(categoryId)}/samples${suffix}`, { cache: "no-store" });
    return json;
  },

  async fetchTaskSampleCandidates(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length) query.set(key, value.join(","));
      } else if (value !== null && value !== undefined && (value !== "" || key === "planStartDate" || key === "planEndDate")) {
        query.set(key, value);
      }
    });
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const json = await this.requestServerJson(`/api/task-sample-candidates${suffix}`, { cache: "no-store" });
    return json;
  },

  async fetchSampleDestroyImpactScope(params = {}) {
    const query = new URLSearchParams();
    ["sampleId", "categoryId"].forEach(key => {
      const value = String(params?.[key] || "").trim();
      if (value) query.set(key, value);
    });
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const json = await this.requestServerJson(`/api/sample-destroy-impact${suffix}`, { cache: "no-store" });
    return json;
  },

  async fetchProjectDetail(projectId, { includeTasks = false } = {}) {
    const suffix = includeTasks ? "?includeTasks=1" : "";
    const json = await this.requestServerJson(`/api/projects/${encodeURIComponent(projectId)}${suffix}`, { cache: "no-store" });
    return json.project || null;
  },

  async fetchSampleCategoryDetail(categoryId, { includePhotos = false } = {}) {
    const suffix = includePhotos ? "?includePhotos=1" : "";
    const json = await this.requestServerJson(`/api/sample-categories/${encodeURIComponent(categoryId)}${suffix}`, { cache: "no-store" });
    return json.category || null;
  },

});
