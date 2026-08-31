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

## 内网访问与权限

- 本机管理员只按请求来源是否为 loopback 判断：必须在 Host 上通过 `http://localhost:9398/`、`http://127.0.0.1:9398/`（或服务监听 IPv6 时的 `http://[::1]:9398/`）访问。即使人在 Host 本机，通过 `http://Host内网IP:9398/` 打开也按远程 IP 权限处理。
- 能连接 Host 的内网电脑都可以进入主页，未授权 IP 只能看到脱敏的项目和样机池总览；卡片会保持显示，但不能进入详情或执行写操作。
- 本机管理员可在网页中的项目、样机池访问名单入口配置权限；项目管理员和池管理员只能管理各自资源范围内的名单，任何远程角色都不能授予本机管理员权限。
- 第一版只按服务器从 TCP 连接取得的固定 IPv4 做精确匹配，不支持 IP 段，也不读取客户端提交的 IP、`X-Forwarded-For` 等代理头。
- ChamberData 完整数据包可携带所选资源的权限策略。导入预览可选择 `merge`（新增并保留本机冲突规则）、`replace_selected`（替换本次所选资源规则）或 `skip`（只导入业务数据）。Host 自己的部署标识和 localhost 本机管理员身份不会从数据包迁移。
- 业务写入会在同一 SQLite 事务中追加一条安全审计基线；权限变更、拒绝访问、导入导出和删除销毁还会记录资源范围明细。

第一版定位为固定 IP、小规模可信内网中的轻量隔离，不包含账号密码、MAC、CIDR、AD、HTTPS 或反向代理部署能力。它不能替代操作系统防火墙、可信网络分区和正式身份认证；不要将服务暴露到公网，也不要把代理转发后的来源地址当作本方案的安全凭据。

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
- 权限迁移：完整 ChamberData 包包含已选项目/样机池的权限策略，导入时按预览选择 `merge`、`replace_selected` 或 `skip`，不要手工编辑 Host SQLite 权限表。
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

- 后端：Python 标准库 `ThreadingHTTPServer`
- 数据库：SQLite WAL
- 前端：Vanilla JavaScript SPA
- 健康检查：`GET /api/health`
