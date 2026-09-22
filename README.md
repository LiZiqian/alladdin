# TestChamber

<p align="center">
  <a href="https://github.com/LiZiqian/TestChamber/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/LiZiqian/TestChamber?label=version&color=2f80ed"></a>
  <img alt="Python 3.9+" src="https://img.shields.io/badge/python-3.9%2B-3776AB?logo=python&logoColor=white">
  <img alt="No pip or npm dependencies" src="https://img.shields.io/badge/dependencies-none-22a06b">
</p>

面向硬件测试团队的本地内网管理平台，统一管理项目、测试任务、样机、结果、照片和测试履历。

> 当前发布：`v7.3.0` · 默认端口：`9398` · 数据目录：`data/`

## 能做什么

| 模块 | 用途 |
|------|------|
| 项目与阶段 | 管理 SKU、BOM、测试策略、人员和地点 |
| 测试任务 | 配置执行人、计划、样机，跟踪启动、阻塞、变更和结束 |
| 样机档案 | 管理身份、状态、位置、持有人、照片和跨任务履历 |
| 结果录入 | 记录结论、DTS、问题、照片和样机去向 |
| 批量导入 | 导入项目人员、样机和测试用例 |
| 数据迁移 | 导出/导入完整数据包或单台样机档案包，并预览冲突 |

## 下载与启动

### Windows

1. 从 [GitHub Releases](https://github.com/LiZiqian/TestChamber/releases/latest) 下载源码并解压。
2. 安装 Python 3.9 或更高版本。
3. 双击 `start_server.bat`。
4. 浏览器打开 [http://127.0.0.1:9398/](http://127.0.0.1:9398/)。

也可以使用 Git：

```powershell
git clone --branch v7.3.0 --depth 1 https://github.com/LiZiqian/TestChamber.git
cd TestChamber
start_server.bat
```

正常运行不需要 `pip install`、`npm install` 或单独安装数据库。

### 命令行启动

仅允许本机访问：

```powershell
python -m backend.server --host 127.0.0.1 --port 9398
```

允许受信任的局域网设备访问：

```powershell
python -m backend.server --host 0.0.0.0 --port 9398
```

其他电脑访问 `http://服务器IP:9398/`。请勿把服务直接暴露到公网。

macOS 或 Linux 将命令中的 `python` 改为 `python3` 即可。

## 第一次使用

1. 创建样机池并新增或批量导入样机。
2. 创建项目和阶段。
3. 配置 SKU、BOM、测试策略、人员和地点。
4. 生成并配置测试任务。
5. 分配样机，启动任务并录入结果。
6. 结束任务后，在样机档案中查看完整履历。

## 数据与迁移

业务数据默认保存在项目内：

```text
data/
├── testchamber.sqlite   # 主数据库
├── samples/             # 照片和缩略图
├── import-previews/     # 导入预览临时文件
└── exports/             # 导出临时文件
```

- 整个平台迁移：使用系统内的“完整数据包”导出和导入。
- 单台样机迁移：在样机详情中导出和导入“样机档案包”。
- 本机备份：关闭服务后复制整个 `data/` 目录。

`data/`、真实数据库、照片和公司测试数据不会随 GitHub 源码发布，也不要手动提交到 Git。

## 更新版本

更新前先导出完整数据包，或在关闭服务后备份 `data/`。

如果使用 Git：

```powershell
git fetch --tags
git switch --detach v7.3.0
```

更新源码后重新启动服务；如果浏览器仍显示旧界面，关闭旧服务并强制刷新页面。

## 常见问题

| 问题 | 处理方式 |
|------|----------|
| 页面打不开 | 确认服务窗口仍在运行，并访问 `/api/health` 检查服务状态 |
| 找不到 Python | 运行 `python --version`；Windows 启动脚本也可手动选择 `python.exe` |
| 端口被占用 | 关闭旧服务，或启动时改用其他端口 |
| 局域网无法访问 | 使用 `0.0.0.0` 启动，并检查 Windows 防火墙和服务器 IP |

## 技术说明

维护交接请从 [架构与代码导航](docs/architecture.md) 和 [开发、验证与交接指南](docs/maintenance.md) 开始。回归测试及其加载方式见 [tests/README.md](tests/README.md)。

开发验证（需要 Python 与 Node.js，无需安装 pip/npm 依赖）：

```powershell
python scripts/check.py
```

- 后端：Python 标准库 `ThreadingHTTPServer`
- 数据库：SQLite WAL
- 前端：Vanilla JavaScript SPA
- 健康检查：`GET /api/health`

当前只支持现行增量 API、外置表数据库和 ChamberData V2 数据包。历史接口与自动迁移已删除，交接前请阅读 [协议边界与清理记录](docs/current-contract-2026-09-22.md)。
