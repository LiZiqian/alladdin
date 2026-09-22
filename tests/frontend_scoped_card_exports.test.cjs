const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const requests = [];
const context = vm.createContext({
  console, URLSearchParams,
  document: { querySelector: () => null },
  Utils: { toast() {} },
  fetch: async url => {
    requests.push(url);
    return { ok: true, headers: { get: () => "application/zip" } };
  },
});
for (const file of ["app.core.js", "import-export-bundle.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/js", file), "utf8"), context);
}
const app = vm.runInContext("app", context);
let downloads = 0;
app._downloadZipResponse = async () => { downloads += 1; };

async function main() {
  for (const [action, method, queryKey] of [
    ["sample-pool-export-scope", "exportSamplePoolBundle", "sampleCategoryId"],
    ["project-export-scope", "exportProjectBundle", "projectId"],
  ]) {
    const id = "scope /测试&one";
    const original = app[method].bind(app);
    let pending;
    app[method] = value => (pending = original(value));
    app.dispatchAppAction(action, { tagName: "BUTTON", dataset: { id } }, { preventDefault() {} }, "click");
    await pending;
    const request = new URL(requests.at(-1), "http://localhost");
    assert.equal(request.pathname, "/api/export-bundle");
    assert.deepEqual([...request.searchParams], [[queryKey, id]], "card export must select only the clicked resource");
    const before = requests.length;
    await original("");
    assert.equal(requests.length, before, "missing card identity must not trigger a full export");
  }
  await app.exportBundle();
  assert.equal(requests.at(-1), "/api/export-bundle", "sidebar export must remain complete");
  assert.equal(requests.length, 3);
  assert.equal(downloads, 3);
  console.log("scoped card export action tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
