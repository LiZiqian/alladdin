/* 服务器同步协调入口。
 * 协调增量写入 FIFO 队列与读取版本屏障；
 * 业务查询、基线、缓存、写入分别位于 js/server/。
 * 所有业务写入必须使用对应的增量提交方法。
 */
app.registerModule("app.server", {

  async readCurrentServerData(read, isRelevant = () => true, apply = value => value) {
    const epoch = this._dataSnapshotEpoch || 0;
    // A successful write advances revision without invalidating queued writes or
    // rollback snapshots. Retry reads once so an unrelated save cannot strand a
    // newly selected project on its summary-only loading screen.
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = Number(this.serverRevision) || 0;
      let value, failure;
      try { value = await read(); } catch (error) { failure = error; }
      const pendingWrite = this._serverMutationQueue;
      if (pendingWrite) await pendingWrite;
      if ((this._dataSnapshotEpoch || 0) !== epoch) return null;
      // An older read may finish before the write ACK advances revision. Wait
      // for that write, then re-read even on failure so its caller can roll back.
      // A newly queued write also prevents applying between two FIFO entries.
      if (pendingWrite || this._serverMutationQueue || (Number(this.serverRevision) || 0) !== revision) {
        if (!isRelevant()) return null;
        continue;
      }
      if (failure) throw failure;
      // Apply before yielding again: a write could otherwise finish between a
      // validated helper result and the caller's next promise continuation.
      return apply(value);
    }
    return null;
  },

  serverReadHasLocalEdits(current, baseline) {
    const derived = new Set(["samplePersonCounts", "stageCount", "taskCount", "statusCounts", "progressTaskCounts", "testedItemNames", "ownerNames", "borrowerNames",
      "usedSampleRuns", "runningSampleCount", "sampleCount", "problemCounts", "photoCount", "testHistoryCount",
      "photosLoaded", "eventsLoaded", "historyLoaded", "samplesLoaded"]);
    const comparable = value => {
      if (Array.isArray(value)) return value.map(comparable);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.keys(value).sort()
        .filter(key => !key.startsWith("_") && !derived.has(key))
        .map(key => [key, comparable(value[key])]));
    };
    return JSON.stringify(comparable(current)) !== JSON.stringify(comparable(baseline));
  },

  async resolveServerVersion(bootstrapObj = {}) {
    if (bootstrapObj?.version) return String(bootstrapObj.version);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const obj = await res.json().catch(() => ({}));
      if (res.ok && obj?.version) return String(obj.version);
    } catch (e) {
      console.warn("服务器版本检查失败：", e);
    }
    return "";
  },

  updateServerStatus(extraText = "") {
    const el = document.getElementById("saveState");
    if (!el) return;
    if (this.serverOnline) {
      const t = this.serverUpdatedAt ? new Date(this.serverUpdatedAt).toLocaleString("zh-CN") : "-";
      const full = `已连接 · rev ${this.serverRevision} · ${t}${extraText ? " · " + extraText : ""}`;
      el.innerText = extraText || "同步正常";
      el.title = full;
    } else {
      el.innerText = extraText || "未连接服务器";
      el.title = `未连接 · 数据无法保存${extraText ? " · " + extraText : ""}`;
    }
  },

  async beginServerMutation() {
    const epoch = this._dataSnapshotEpoch || 0;
    const previous = this._serverMutationQueue;
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this._serverMutationQueue = current;
    if (previous) await previous;
    const finish = () => {
      release();
      if (this._serverMutationQueue === current) this._serverMutationQueue = null;
    };
    if ((this._dataSnapshotEpoch || 0) !== epoch) {
      finish();
      return null;
    }
    return finish;
  },

  hasLocalUnsavedChanges() {
    return JSON.stringify(this.data || {}) !== JSON.stringify(this._baseData || {});
  },

  markDataSynced() {
    this._baseData = this.cloneData(this.data || this.emptyData());
    return this._baseData;
  },

  async prepareBeforeDirectMutation(remark = "直接变更前同步") {
    // 等待已排队的增量提交确认后再检查本地编辑，避免用旧基线误判。
    if (this._serverMutationQueue) await this._serverMutationQueue;
    if (this.hasLocalUnsavedChanges()) {
      alert(`${remark}失败：当前还有未保存的本地编辑。请先完成当前编辑，再重试。`);
      this.updateServerStatus("有未保存编辑");
      return false;
    }
    return true;
  },

  async clearBrowserCache() {
    this.showConfirm("清除当前浏览器对本平台的缓存，并重新载入页面？", async () => {
      this.updateServerStatus("清理缓存");
      const clientTasks = [];
      if (typeof caches !== "undefined" && caches?.keys) {
        clientTasks.push(caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key)))));
      }
      if (typeof navigator !== "undefined" && navigator.serviceWorker?.getRegistrations) {
        clientTasks.push(navigator.serviceWorker.getRegistrations().then(registrations => (
          Promise.all(registrations
            .filter(registration => String(registration.scope || "").startsWith(location.origin))
            .map(registration => registration.unregister()))
        )));
      }
      try {
        sessionStorage.clear();
        localStorage.removeItem("digital_governance_sidebar_collapsed");
      } catch (e) {
        console.warn("清理本地浏览器状态失败：", e);
      }
      await Promise.all(clientTasks);
      try {
        const healthRes = await fetch("/api/health", { cache: "no-store" });
        const health = await healthRes.json().catch(() => ({}));
        if (healthRes.ok) {
          if (health.version !== this.version) {
            console.warn("服务端版本与前端不一致，仍继续请求服务端缓存清理头。", {
              server: health.version,
              client: this.version
            });
          }
          const res = await fetch("/api/browser-cache/clear", { method: "POST", cache: "no-store" });
          const obj = await res.json().catch(() => ({}));
          if (!res.ok || obj.ok === false) {
            console.warn("服务端缓存清理接口不可用，继续执行前端刷新：", obj.error || `HTTP ${res.status}`);
          }
        } else {
          console.warn("服务端版本与前端不一致，跳过服务端缓存清理头，继续执行前端刷新。");
        }
      } catch (e) {
        console.warn("服务端缓存清理请求失败，继续执行前端刷新：", e);
      }
      const url = new URL(location.href);
      url.searchParams.set("_platformCacheReset", String(Date.now()));
      location.replace(url.toString());
    }, {
      title: "清除浏览器缓存",
      description: "只影响当前浏览器中的本平台缓存，不会删除服务器业务数据。",
      okText: "清除并刷新",
      okClass: "btn btn-purple"
    });
  },

});
