# 架构与代码导航

本文面向接手维护的开发团队，以当前源码为准。平台保持 Python 标准库后端、SQLite、原生 JavaScript SPA；无需引入构建工具或第三方运行依赖。页面结构、样式和版本号保持不变。旧接口与旧格式已退役，运行时只支持现行协议，详见 [清理记录](current-contract-2026-09-22.md)。

## 先理解一次操作如何完成

```text
用户操作
  → app.core.js 事件委托（data-app-action）
  → projects / workspace / samples / devices 业务页面
  → js/server/* 构建请求、写入排队、应用服务端结果
  → HTTP Handler → http_api.py
  → 查询模块 或 mutation_services → mutations/*
  → record_writers / 查询模块 → SQLite
  → affected + revision → 局部基线同步 → 缓存失效/刷新页面
```

读取从 `GET /api/bootstrap` 的轻量摘要开始。进入项目、样机池、任务页、照片与履历时，再请求对应 API。没有全量状态 HTTP 接口；完整状态组装仅在服务内部供 V2 导入导出使用。

## 目录职责

| 目录/文件 | 职责与边界 |
| --- | --- |
| `backend/server.py` | 装配运行时路径、数据库连接和各服务 Context；保留稳定的对外函数入口。不要再往这里堆 SQL。 |
| `backend/server_modules/http_*` | HTTP 路由、协议解析、上传与响应，业务写入交给服务。 |
| `backend/server_modules/*_queries.py` | 查询、分页、筛选与摘要；高频字段用 SQL 索引，深层搜索按原规则兜底。 |
| `backend/server_modules/mutations/` | 增量写入，按任务、项目/阶段、样机/池分域。 |
| `backend/server_modules/record_writers.py` | 单实体数据库操作和外置字段维护；由调用方管理事务。 |
| `backend/server_modules/database_*` | 现行 schema、索引和启动只读结构校验；不自动升级旧库。 |
| `backend/server_modules/state_*` | 内部状态读取与外置存储投影；没有三方合并和全量保存服务。 |
| `backend/server_modules/*import*`、`chamber_package.py`、`migration_scope.py` | 数据包校验、选择范围、冲突预览、ID 映射与事务提交。 |
| `frontend/index.html` | 唯一生产脚本加载清单；加载完成后才调用 `app.init()`。 |
| `frontend/js/app.core.js` | 注册器、状态容器、事件分派、基础 DOM 能力。 |
| `frontend/js/app.data.js` | 状态访问器、规范化、快照与业务数据查找。 |
| `frontend/js/server/` | HTTP 查询、局部水合、基线、缓存、增量提交和导入同步。 |
| `frontend/js/workspace/`、`samples/` | 业务页面、表单、操作与展示。 |
| `frontend/css/` | 按页面划分的样式，由 `style.css` 聚合，既有顺序有层叠含义。 |
| `frontend/templates/` | 交付给用户的导入模板。 |
| `tests/`、`scripts/`、`docs/` | 随源码交付的回归、检查入口和维护文档。 |
| `data/` | 运行数据；不能提交或在普通回归中使用。 |
| `output/`、`.playwright-cli/` | 本地验证产物，已排除出源码提交。 |
| `dev/` | 本机历史工具与测试；当前机器可能通过 `.git/info/exclude` 忽略，交接不能只依赖它。 |

## 前端通信职责表

全部模块仍用 `app.registerModule(name, members)` 暴露原方法名，通过 `this` 调用其他模块。拆分的是代码归属，不是运行时数据对象；没有新增动态加载器或打包过程。

| 文件（`frontend/js/` 下） | 找什么代码 |
| --- | --- |
| `app.server.js` | FIFO 写入队列、读版本屏障、连接状态、缓存清理。 |
| `server/api.js` | 查询 URL、JSON 成功/失败处理。`requestServerJson` 不自动重试。 |
| `server/baseline.js` | `syncHydrated*`、`syncMutationPayloadBaseline`，只确认已读/已写的局部字段。 |
| `server/cache.js` | 分页缓存失效、当前页补丁、照片写入后的缓存处理。 |
| `server/sample-lookup.js` | 历史快照中的样机身份解析、任务操作前补载样机。 |
| `server/hydration.js` | 项目/池详情、照片、事件和履历的按需读取与合并。 |
| `server/mutation-results.js` | `affected` 合并、成功确认、版本冲突刷新与失败快照恢复。 |
| `server/task-mutations.js` | 任务载荷裁剪、单条/批量任务提交。裁剪函数也供其他实体写入复用。 |
| `server/record-mutations.js` | 项目、阶段、样机、样机池提交及各自刷新范围。 |
| `server/transfer.js` | 包预览/提交，按服务端 mutationSummary 合并导入结果。 |

### 三个容易误用的状态

- `serverRevision`：服务端全平台数据版本；成功应答只能让它前进。载荷在点击时克隆，但 revision 必须在拿到写入槽位之后填写，避免排队中的第二次保存拿旧版本。
- `_dataSnapshotEpoch`：整份快照替换代次；旧读取/旧弹窗不能跨代次覆盖新数据。它与 revision 的作用不同，不能合并成一个标志。
- `_baseData`：已确认的字段基线。局部读取成功不代表用户其他未保存编辑也成功写入；禁止为了消除“未保存”提示而整份覆盖基线。

`beginServerMutation()` 返回释放函数，提交方法必须在 `finally` 中释放。`acceptMutationResult()` 按原顺序同步推进版本、应用 affected、更新局部基线；页面刷新可以随后 await，但不能插到确认步骤中间。

### 样机页面职责表

| 文件（`frontend/js/samples/` 下） | 职责 |
| --- | --- |
| `01-pool.js` | 池/样机列表与卡片展示、池信息编辑、导航。 |
| `pool-pagination.js` | 筛选、分页请求、缓存、预取、请求代次。 |
| `pool-destruction.js` | 样机/池销毁影响范围、确认、关联任务更新与回滚。 |
| `sample-create.js` | 初始化样机、编号、创建表单、身份查重。 |
| `02-import-export.js` | 样机批量表格导入导出。 |
| `03-detail-fields.js` | 身份、人员、位置、重组等档案字段。 |
| `04-photos.js`、`05-problem-photos.js` | 外观照片、问题照片。 |
| `05-problems.js`、`06-history.js` | 问题记录、履历展示。 |
| `07-detail.js`、`08-files.js` | 详情弹窗、CT/点云文件。 |

## 后端增量写入职责表

外部继续从 `server_modules.mutation_services` 访问原入口。该文件仅显式导出，不含业务实现。`mutations/` 内部不反向导入 `backend.server`，也不互相调用其他业务域的提交入口来嵌套事务。

| 文件（`backend/server_modules/mutations/` 下） | 职责 |
| --- | --- |
| `common.py` | Context、版本/布尔标志校验、版本推进和审计。 |
| `task_guards.py` | 任务/阶段归属、任务样机载荷、事件来源校验。 |
| `sample_guards.py` | 销毁引用、项目删除影响、样机事件/池归属校验。 |
| `effects.py` | 销毁前快照、流程可写字段白名单、全项目占用协调。 |
| `tasks.py` | 单任务与批量任务提交。 |
| `projects.py` | 项目、阶段提交。 |
| `samples.py` | 样机、样机池提交和池记录删除入口。 |

服务函数返回 `(ok, detail)`，HTTP 层把它转换成原有 JSON 和状态码。保持以下事务边界：

1. 解析/校验载荷，开启 SQLite `BEGIN IMMEDIATE` 写事务。
2. 在同一个连接内校验当前 revision、归属与状态，不能只信任客户端当前页。
3. 写实体、关联事件、快照和占用，构造受影响记录。
4. 在同一个事务内推进 revision 和写审计，再提交。
5. 涉及物理文件清理时，在成功提交之后执行，避免数据库仍引用已删除文件。

不要用通用“CRUD 配置字典”吞掉任务、销毁、阶段重排的不同规则。共享真正相同的操作，保留不同业务路径可直接阅读的顺序。

## 当前协议边界

- 本工作树没有历史分支的固定 IPv4 ACL 实现。Origin 检查不等于身份认证；不要凭旧文档认为已经有权限隔离。
- 只接受现行状态枚举与 ChamberData V2；旧格式明确拒绝，不自动补齐或转换。
- `APP_VERSION` 以 `backend/server_modules/version.py` 为准。普通重构不自动更新版本；静态资源仍使用 `__APP_VERSION__`。
- SQLite JSON、外置表、查询列和照片文件存在同步约束，不能单独修改一份“看起来重复”的字段。
- `.github/workflows/sync-shared-release.yml` 的历史发布规则需要发布前单独核对，本次重构没有改变发布策略。
