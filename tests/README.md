# 回归测试

从项目根目录运行 `python scripts/check.py`。每套测试独立运行；Python 使用调用脚本的同一解释器，前端使用 PATH 中的 Node.js。无需 pip/npm 安装。

| 测试组 | 主要覆盖 |
| --- | --- |
| `test_backend_*`、`test_mutation_sequence_integrity.py` | 增量写入、关联数据和失败原子性。 |
| `test_mutation_modules.py` | 稳定服务入口、拆分后未声明的全局依赖。 |
| `test_*reservations.py`、`test_task_candidate_filters.py` | 时间预约、占用、样机候选筛选。 |
| `test_transfer_*`、`test_asset_transaction_integrity.py` | 包往返、冲突决策、资产事务。 |
| `test_http_*`、`test_json_integrity.py` | HTTP/JSON 输入和错误协议。 |
| `test_device_warehouse.py`、`test_sample_files.py`、`test_problem_*` | 设备、样机附件、问题记录和照片。 |
| `frontend_module_contract.test.cjs` | 真实 index 脚本加载、重名覆盖、HTTP 查询/错误语义、成功应答顺序。 |
| `frontend_async_integrity.test.cjs`、`frontend_followup_integrity.test.cjs` | 迟到响应、版本冲突、未保存编辑、弹窗上下文。 |
| `frontend_pool_async.test.cjs`、`frontend_strategy_navigation.test.cjs` | 分页缓存代次、快速切换阶段。 |
| 其他 `frontend_*.test.cjs` | 导入、归档、预约、问题、卡片动作等领域专项。 |

`backend_fixture.py` 提供内存数据库。新增后端测试应使用它，或显式设置并清理临时数据目录；不能以真实 `data/` 为 fixture。

`frontend_source.cjs` 的 `readFrontendScript(path)` 为需要通信/样机池特性的 VM 测试加载对应模块组，其顺序来自生产 `index.html`；普通文件仍原样读取。依赖其他特性（例如档案附件）的测试应明确加载真实模块，不给缺失方法塞空实现来掩盖生产依赖。

`test_current_contract.py` 覆盖已退役接口不可用、V1 拒绝、旧库不回填、旧目录不迁移、内嵌照片拒绝和自由文本保真。

`backend_fixture.seed_state()` 只用于临时测试库，明确拒绝正式数据库；它不是产品全量写入接口。原三方合并测试随服务删除，当前任务并发与回滚测试继续保留。本机忽略的 `dev/tests` 是历史开发资料，不属于当前交付测试入口。
