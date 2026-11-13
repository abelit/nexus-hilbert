# Edge 构建、组件分发与安装布局

> 状态：事实记录（2026-11-13），基于 `feat/windows-edge-installation`（HEAD `3c81ba4a` + 部署期间的两个本地修复）。
> 目的：把 Linux 与 Windows 的编译、组件获取、附件发布、静态分发树和安装落盘位置集中在一处，便于后续查看和补齐能力。
> 本文只描述现状，不替代 [Edge 安装指南](../install/edge.md)、[Windows 安装指南](../install/windows.md) 和 [Windows 支持设计](windows-edge-installation.md)。

## 1. 端到端链路

```
源码 ──make build──▶ bin/<target> ──make build-*-attachments──▶ CNB Release 附件
                                                                    │
                          Manager 安装：deploy/install/edge/fetch-edge-assets.sh
                                                                    ▼
                                       /usr/share/nginx/html/edge/（nginx /edge/）
                                                                    │
                              节点脚本（install.sh / ongrid-edge-installer.exe）
                                                                    ▼
                                          /usr/local/... 或 C:\Program Files\...
```

关键点：**节点安装脚本拉取的组件与版本，取决于 Manager 静态树里有什么**；升级 Manager 后必须重新跑 `fetch-edge-assets.sh`，否则节点装到旧版本。

## 2. 编译矩阵

| 平台 / 变体 | Make 入口 | 工具链 | 产物 |
| --- | --- | --- | --- |
| linux/amd64 | `make build-edge-linux-amd64` | `go 1.25.0`（go.mod），`CGO_ENABLED=0` | `bin/linux-amd64/ongrid-edge` |
| linux/arm64 | `make build-edge-linux-arm64` | 同上 | `bin/linux-arm64/ongrid-edge` |
| windows modern | `make build-edge-windows-amd64` | 同上 | `bin/windows-amd64/ongrid-edge-supervisor.exe`、`ongrid-edge-worker.exe` |
| windows legacy（2008 R2） | `make build-edge-windows-legacy-amd64` | `GOTOOLCHAIN=go1.20.14` + 兼容层 | `bin/legacy-windows-amd64/*.exe`（PE 子系统 6.01） |
| windows 安装器 | `make build-edge-windows-installer` | 独立模块 `tools/windows-installer`（`go 1.20`） | `bin/windows-amd64/ongrid-edge-installer.exe` |
| darwin | `make build-edge-darwin-*` | 同上 | 不进入发布附件 |

公共参数：`-trimpath -ldflags "-s -w -X main.version=$VERSION"`，版本来自仓库根 `VERSION`。

- Linux 是单进程 agent；Windows 拆成 supervisor（SCM 服务）+ worker（隧道与插件）。
- legacy 变体不是简单交叉编译：`tools/build-legacy-windows.sh` 复制源码树，挂 `internal/compat/{slog,slices,maps,minmax,rand,clear}`、替换打过补丁的 `third_party/geminio`、裁剪依赖闭包；Go 1.21+ 的产物无法在 2008 R2 加载。

## 3. 插件组件：版本与获取

插件全部是上游预编译二进制，本项目只下载、不改源码。版本在 `Makefile` 顶部钉死。

| 组件 | 版本变量 | Linux | Windows |
| --- | --- | --- | --- |
| node_exporter | `NODE_EXPORTER_VERSION=1.8.2` | `fetch-node-exporter` → `bin/<os>-<arch>/node_exporter` | — |
| process_exporter | `PROCESS_EXPORTER_VERSION=0.8.4` | `fetch-process-exporter` → 同上 | —（`procmetrics` 在 Windows 不注册） |
| otelcol-contrib | `OTELCOL_VERSION=0.157.0` | `fetch-otelcol` → 同上 | `fetch-otelcol-windows` → `bin/windows-amd64/otelcol-contrib.exe` |
| windows_exporter | `WINDOWS_EXPORTER_VERSION=0.29.2` | — | `fetch-windows-exporter` → `bin/windows-amd64/windows_exporter.exe` |
| mysqld_exporter | `MYSQLD_EXPORTER_VERSION=0.19.0` | `fetch-db-exporters` | `fetch-db-exporters-windows` |
| postgres_exporter | `POSTGRES_EXPORTER_VERSION=0.19.1` | 同上 | 同上 |
| redis_exporter | `REDIS_EXPORTER_VERSION=1.86.0` | 同上 | 同上 |
| mongodb_exporter | `MONGODB_EXPORTER_VERSION=0.51.0` | 同上 | —（上游无 Windows amd64 资产） |
| obi / obi.NOTICES | `OBI_VERSION=0.14.0-ongrid.5` | `fetch-obi` | — |

- Linux 默认 `EDGE_PLUGIN_ARCHES ?= linux-amd64`；出 arm64 插件必须显式覆盖。
- Windows 聚合入口：`make fetch-edge-plugins-windows`。

## 4. 发布附件

| 指令 | 产物 |
| --- | --- |
| `make build-edge-version-attachments` | 版本化附件（见下表） |
| `make build-edge-deps-attachments` | `edge-deps-linux-{amd64,arm64}.tar.xz` + `.sha256`（**不可变 tag**，由各上游版本拼成 `EDGE_DEPS_TAG`） |
| `make build-edge-attachments` | 以上两类 |
| `make publish-edge-*-attachments` | 上传到 CNB Release |

版本化附件名（`EDGE_VERSION_ATTACHMENT_NAMES`，单一事实来源）：

| 类别 | 文件名 |
| --- | --- |
| Linux 主程序 | `ongrid-edge-linux-amd64-<VERSION>`、`ongrid-edge-linux-arm64-<VERSION>` |
| Windows modern | `ongrid-edge-windows-amd64-<VERSION>-{supervisor,worker,installer}.exe` 及同前缀的 `windows_exporter.exe`、`otelcol-contrib.exe`、`mysqld_exporter.exe`、`postgres_exporter.exe`、`redis_exporter.exe` |
| Windows legacy | `ongrid-edge-legacy-windows-amd64-<VERSION>-{supervisor,worker}.exe` |

每个附件生成 `.sha256` sidecar。

**发布目的地：** CNB 仓库 `ongridio/ongrid-edge` 的 Release。

- 页面：`https://cnb.cool/ongridio/ongrid-edge/-/releases`
- 下载基址：`https://cnb.cool/ongridio/ongrid-edge/-/releases/download/<tag>/<asset>`
- 版本化附件 tag = `VERSION`；依赖归档 tag = 不可变 `EDGE_DEPS_TAG`
- 上传需要 `CNB_TOKEN`（Release 读/写 + repo-contents 读/写），实现见 `scripts/ensure-cnb-release.sh` 与 `scripts/publish-cnb-release-attachments.sh`

操作步骤与验证命令见 [Edge 编译、打包与目录落盘指南 §6.1](../guides/edge-build-and-packaging.md)。

## 5. Manager 分发树

`deploy/install/edge/fetch-edge-assets.sh <dest> <version> [targets]` 从 CNB 下载、校验 sha256、解包后铺成：

```
edge/
├── install.sh  uninstall.sh  apply-pending-upgrade.sh
├── ongrid-edge-linux-{amd64,arm64}
├── node_exporter-linux-<arch>
├── process_exporter-linux-<arch>
├── otelcol-contrib-linux-<arch>
├── mysqld_exporter / postgres_exporter / redis_exporter / mongodb_exporter-linux-<arch>
├── obi-linux-<arch>  obi.NOTICES-linux-<arch>
├── edge-assets-linux-<arch>.ref
└── windows/                           # 扁平命名，与 Linux 的 <component>-<os>-<arch> 一致
    ├── ongrid-edge-installer.exe
    ├── manifest.json                  # 由 dist/build-windows-manifest.sh 生成
    ├── ongrid-edge-supervisor-windows-amd64.exe
    ├── ongrid-edge-worker-windows-amd64.exe
    ├── ongrid-edge-supervisor-legacy-windows-amd64.exe
    ├── ongrid-edge-worker-legacy-windows-amd64.exe
    ├── windows_exporter-windows-amd64.exe
    ├── otelcol-contrib-windows-amd64.exe
    ├── mysqld_exporter-windows-amd64.exe
    ├── postgres_exporter-windows-amd64.exe
    └── redis_exporter-windows-amd64.exe
```

manifest 的每个条目用 `path`（扁平文件名）下载、用 `install_as`（如 `ongrid-edge-supervisor.exe`）落盘；插件文件由两个变体共用。

nginx 路由（`deploy/install/nginx.conf`）：

```nginx
location = /edge/install.sh   { alias /usr/share/nginx/html/edge/install.sh; }
location = /edge/uninstall.sh { alias /usr/share/nginx/html/edge/uninstall.sh; }
location /edge/               { alias /usr/share/nginx/html/edge/; }
location /edge/windows/       { alias /usr/share/nginx/html/edge/windows/; }
```

## 6. 安装落盘

### Linux

| 内容 | 路径 |
| --- | --- |
| 主程序 | `/usr/local/bin/ongrid-edge` |
| 插件二进制 | `/usr/local/lib/ongrid-edge/<name>`（含 `apply-pending-upgrade.sh`） |
| 凭据 / 配置 | `/etc/ongrid-edge/ongrid-edge.env`（0640，secret 明文） |
| 状态 / 升级暂存 | `/var/lib/ongrid-edge/`、`.upgrade/incoming` + `MANIFEST.txt` |
| 日志 | `/var/log/ongrid-edge/` + journald |
| systemd | `/etc/systemd/system/ongrid-edge.service`、`ongrid-edge-upgrade.service` |

在线安装（`install.sh`）：主程序、升级钩子、9 个插件逐个从 `/edge/` 下载；插件是 best-effort，缺失只告警。
离线安装（`build-edge-bundle.sh` → `install-edge.sh`）：按 `MANIFEST.txt`（`sha256 mode src dest`）安装到相同路径。

### Windows

| 内容 | 路径 |
| --- | --- |
| 主程序 | `C:\Program Files\ongrid-edge\bin\{ongrid-edge-supervisor.exe, ongrid-edge-worker.exe}` |
| 插件 | `C:\Program Files\ongrid-edge\plugins\*.exe` |
| 凭据 | `C:\ProgramData\ongrid-edge\secrets.enc`（DPAPI 机器作用域）+ 服务 Environment |
| 状态 / 升级暂存 | `C:\ProgramData\ongrid-edge\{plugins,upgrade,health.json,*.log}` |
| SCM | 服务名 `ongrid-edge`，LocalSystem，auto start |

安装器（`ongrid-edge-installer.exe`）按 `manifest.json` 校验 SHA-256 后落盘，再调 `supervisor.exe --install --config-file` 完成服务注册；没有离线包。

## 7. 脚本安装入口

Linux（Enrollment token 模式，推荐批量场景）：

```bash
curl -k -sSL https://<manager>/edge/install.sh | bash -s -- \
  --enrollment-token=<token> \
  --server-edge-addr=<host>:40012 \
  --server-http-addr=<manager-host> \
  --tls-insecure
```

Windows：

```powershell
.\ongrid-edge-installer.exe --manager-url https://<manager> `
  --enrollment-token <token> --server-edge-addr <host>:40012 `
  --tls-insecure --variant auto
```

单独拉取组件（自定义脚本时）：

```bash
curl -kfL -o /usr/local/lib/ongrid-edge/node_exporter \
  https://<manager>/edge/node_exporter-linux-amd64
chmod 0755 /usr/local/lib/ongrid-edge/node_exporter
```

### 7.1 内网 / 外网安装地址（UI 配置）

安装命令不再只能使用浏览器当前地址。管理员可在 **设置 → 全局配置 → Edge 安装地址** 配置两个基地址，对应 `system_settings` 的两行：

| category | key | 含义 |
| --- | --- | --- |
| `edge` | `install_internal_url` | 内网主机使用的基地址，例如 `https://ongrid.intra` |
| `edge` | `install_external_url` | 外网主机使用的基地址，例如 `https://ongrid.example.com` |

- 值必须是 `http(s)://host[:port]`，不允许路径、凭据、query、fragment；空值表示未配置。
- 两个都配置时，设备页与集群接入弹窗的安装命令会出现“内网 / 外网”切换；只配置一个时直接使用它；都不配置时回退到浏览器当前地址（历史行为）。
- 选中的基地址同时用于 `install.sh` URL、`--server-http-addr`、Windows 安装器的下载 URL 与 `--manager-url`；`--server-edge-addr` 由基地址的 hostname 派生为 `<hostname>:40012`。
- enrollment token 模式仍会请求 `<基地址>/internal/edge/enroll`，因此无论内网还是外网地址，都必须能到达 Manager（或在其前面做反向代理）。

**方案 A：镜像域名反代整个 Manager。** 内网镜像如果只托管 `/edge` 静态文件，enrollment 会失败。正确做法是让镜像域名作为 Manager 的反向代理，仅把 `/edge/` 指向镜像目录（或让 Manager 自己托管该目录）：

```nginx
server {
    listen 443 ssl;
    server_name ongrid.intra;          # 内网镜像域名
    # ssl_certificate / ssl_certificate_key ...

    location /edge/ {
        alias /srv/ongrid-edge/edge/;  # 方案 A 准备的制品树
    }
    location / {
        proxy_pass https://ongrid.internal;   # Manager 前端
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置完成后把 `install_internal_url` 设为 `https://ongrid.intra`，用该域名打开控制台时安装命令会自动选中“内网”。

## 8. 已知差异与约束

| 项 | Linux | Windows |
| --- | --- | --- |
| 安装入口 | shell 脚本（在线 / 离线 bundle） | 独立 exe + manifest |
| 完整性校验 | 在线安装无逐文件哈希；升级包有 SHA-256 | 安装与升级都校验 manifest SHA-256 |
| 签名 | 无 | 无 Authenticode（仅哈希） |
| 凭据保护 | 明文 env + 文件权限 | DPAPI + ACL |
| 进程模型 | systemd 直接托管 | supervisor 监管 worker |
| 插件缺失 | 逐项告警，其余继续 | 发布清单强制齐全（构建期失败） |
| arm64 | 需显式构建插件 | 不适用 |
| 重装 | `systemctl restart` 覆盖 | 需先停服务并结束 worker，否则文件锁导致 `Access is denied` |

## 9. 待补全能力清单

状态取自最终评审、部署验证和本文核对结果；完成一项后更新状态与依据。

| ID | 能力 | 状态 | 依据 / 备注 |
| --- | --- | --- | --- |
| E-01 | legacy（2008 R2）插件二进制兼容 | ❌ 未完成 | 评审 Critical 1：legacy 变体复用 modern 插件，windows_exporter 0.29.2 / otelcol 0.157.0 / DB exporter 均不支持 2008 R2。需构建兼容版本或收窄 Legacy 插件能力 |
| E-02 | Windows 安装器清理预置显式 ACE | ⚠️ 部分 | 评审 Critical 2；`EnsureSecureDir` 会归档重建，但 `ApplyDirACL` 的 `/inheritance:r` 不清除显式 ACE，需补充验证/清理 |
| E-03 | Windows Authenticode 签名 | ❌ 未完成 | 安装器只校验 SHA-256 |
| E-04 | Windows 离线安装包 / MSI | ❌ 未完成 | 当前只有在线安装器 |
| E-05 | Linux 在线安装逐文件哈希校验 | ❌ 未完成 | `install.sh` 仅 `curl -k`，无清单校验 |
| E-06 | arm64 插件默认构建 | ⚠️ 需显式 | `EDGE_PLUGIN_ARCHES` 默认仅 linux-amd64 |
| E-07 | 2008 R2 实机验收 | ❌ 未完成 | 目前只有 Server 2016 虚拟机验证 |
| E-08 | Windows CI（legacy 构建 / Windows 单测） | ⚠️ 部分 | 已有 `ci-windows-legacy.yml`，覆盖范围待补 |
| E-09 | Windows 安装器提权预检 | ❌ 未完成 | 评审 Important |
| E-10 | 自签名证书下的 UI 引导 / sidecar | ❌ 未完成 | 评审 Important |
| E-11 | Windows 指标 target 与指标名对齐 | ❌ 未完成 | 默认仍指向 9100 / `node_*` 命名，评审 Important |
| E-12 | Manager 升级/重装能力文档对齐 | ⚠️ 部分 | 文档描述强于实现，评审 Important |
| E-13 | 部署验证覆盖插件链路 | ⚠️ 部分 | 2026-11-13 的 VM 安装使用最小清单，只验证了 supervisor/worker 与注册上线 |
| E-14 | legacy 产物随源码修复重建 | ✅ 已完成 | 2026-11-13 用 Go 1.20.14 重建 `bin/legacy-windows-amd64`（PE 6.01），含 ACL/DPAPI 修复 |

## 10. 验证状态（2026-11-13）

在 GNOME Boxes `win2k25`（实际为 Windows Server 2016，10.0.14393）用 modern 变体验证：

- 安装器退出码 0，服务 `ongrid-edge` RUNNING；
- worker 从 `secrets.enc` 成功加载 token；
- Frontier `edge online, edgeID 8`，Manager `edges` 表 `status=online`、`agent_version=v0.20.0`；
- 安装过程发现并修复两个代码缺陷：ACL 校验误读 `DACL()` 返回值、DPAPI 机器作用域 flag 写成 `0x1`（应为 `0x4`）。

## 11. 相关文件

- 构建与依赖：`Makefile`（`build-edge-*`、`fetch-*`、`EDGE_*` 变量）、`tools/build-legacy-windows.sh`、`tools/windows-installer/`
- 打包：`dist/build-edge-attachments.sh`、`dist/build-windows-manifest.sh`
- 分发：`deploy/install/edge/{fetch-edge-assets.sh,install.sh,install-edge.sh,build-edge-bundle.sh,uninstall.sh}`、`deploy/install/nginx.conf`
- 运行期布局：`internal/edgeagent/edgedirs/edgedirs_{linux,windows}.go`
- 升级：`bin/apply-pending-upgrade.sh`、`internal/edgeagent/upgrademachine/`
- 相关文档：[Edge 编译、打包与目录落盘指南](../guides/edge-build-and-packaging.md)、[Edge 安装指南](../install/edge.md)、[Windows 安装指南](../install/windows.md)、[Windows 支持设计](windows-edge-installation.md)、[Edge 运行时与安装](edge-runtime-and-installation.md)
- 实施记录：`.superpowers/sdd/2026-11-12-windows-edge-installation/progress.md`
