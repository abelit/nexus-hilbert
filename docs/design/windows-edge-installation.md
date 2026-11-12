# Windows Edge 安装与 Legacy Agent 设计

## 1. 背景

Linux 已具备从 UI 生成命令、Manager 托管制品、enrollment、systemd 安装、自检和卸载的完整链路。Windows 目前只有手动构建的 `ongrid-edge-supervisor.exe --install`，没有制品发布、下载器、enrollment 和 UI 命令。

目标是为 Windows 提供同等的安装体验，并覆盖：

- **Modern**：Windows Server 2016 及以上，使用当前 Go 1.25 构建；
- **Legacy**：Windows Server 2008 R2 SP1 x64，使用 Go 1.20 兼容构建；
- Legacy Agent 保留 `restart_service` 和插件运行时，不只是一个只读探针。

非目标：

- Windows Server 2008 非 R2、x86；
- Legacy 上的 bash、WebSSH、抓包、K8s、OBI/autoapm/profiles 完整能力；
- 修改 Manager 与 Edge 之间的隧道协议。

## 2. 支持矩阵

| 变体 | 系统 | 架构 | 工具链 | 能力 |
| --- | --- | --- | --- | --- |
| Modern | Server 2016 / 2019 / 2022 / 2025 | amd64 | Go 1.25 | 当前 Windows 能力 + restart_service + 插件 |
| Legacy | Server 2008 R2 SP1 | amd64 | Go 1.20 | tunnel、注册/心跳、主机指标、host_files、restart_service、插件（见 7.2） |
| 不承诺 | Server 2008 非 R2、x86、2012/2012 R2 | - | - | 除非额外验证 |

> 2012/2012 R2 可以复用 Legacy 构建，但必须在目标机实测后再写入支持矩阵。

## 3. 关键决策

### 3.1 Legacy 变体复用主 Agent 源码

不新建一个只实现部分能力的独立 Agent，而是用 Go 1.20 兼容构建主 Agent。原因：

- 用户要求 Legacy 支持 `restart_service` 和插件；
- 主 Agent 的插件运行时约 70 个文件，重新实现会快速漂移；
- Manager、Frontier、wire 协议不需要改；
- 现有 supervisor/worker、DPAPI、SCM recovery、upgrademachine 可以复用。

代价是需要一条兼容构建线：

- 全仓 `log/slog`、`slices`、`maps`、`min`/`max` 等 Go 1.21+ 用法需要兼容层；
- `github.com/singchia/geminio` 当前 `go.mod` 声明 Go 1.24，需要 pin 旧版本或 vendor 后降低 `go` 指令；
- `golang.org/x/crypto`、`golang.org/x/sys` 需要 pin 到 Go 1.20 可编译的版本；
- 每次主代码引入新的 Go 1.21+ 特性，都要保证兼容构建仍然通过。

**回退方案**：如果 Phase 0 spike 证明兼容构建不可行，则退到独立最小 Legacy Agent，只保留 tunnel、注册/心跳、主机指标、host_files、restart_service 和受限插件；此时明确不接受插件完整对等。

### 3.2 安装器独立于主模块

新增 `tools/windows-installer/`，它自己的 `go.mod` 声明 `go 1.20`，不 import 主模块。原因：

- 安装器必须在 Server 2008 R2 上运行；
- 主模块是 Go 1.25，无法被 Go 1.20 引用；
- 安装器只需要 HTTP、SHA-256、注册表/服务控制、ACL，不需要项目依赖；
- 安装器可以用 Go 的 TLS 栈连接 Manager，绕开 Server 2008 R2 Schannel 的 TLS 1.2 限制。

安装器根据 OS build 选择 `modern-amd64` 或 `legacy-amd64` 制品。

### 3.3 2008 R2 的引导下载

Server 2008 R2 可能没有启用 TLS 1.2，也可能缺少 SHA-2 代码签名补丁。因此：

- 首次获取 `ongrid-edge-installer.exe` 允许通过 GPO / SCCM / 网络共享 / U 盘分发；
- 安装器自身用 Go TLS 1.2 下载后续制品；
- 文档给出启用 TLS 1.2 和 SHA-2 补丁的检查项；
- 不为了兼容旧系统开放 HTTP 制品下载。

### 3.4 服务与凭证

- 复用 `ongrid-edge-supervisor.exe` + `ongrid-edge-worker.exe`；
- 服务名 `ongrid-edge`，默认 LocalSystem；
- secret 使用 DPAPI `CRYPTPROTECT_LOCAL_MACHINE`；
- access key 存在服务注册表 `Environment`；
- 安装器不得把 secret 写进日志或临时明文文件超过必要时间。

## 4. 架构

```text
UI (Devices / Batch install)
  │  生成 Windows 安装命令
  ▼
ongrid-edge-installer.exe  (Go 1.20, standalone)
  │
  ├─ GET /edge/windows/manifest.json
  ├─ GET /edge/windows/<variant>/...        (HTTPS + SHA-256)
  ├─ POST /internal/edge/enroll             (可选，Bearer enrollment token)
  ├─ 创建目录 + ACL (SYSTEM/Administrators)
  ├─ 放置 supervisor/worker/plugins
  ├─ 调用 supervisor.exe --install           (Modern/Legacy 均复用)
  └─ 启动服务 + 轮询 health.json/tunnel 注册 + 自检
```

Manager 不需要新的业务 API；继续使用现有：

- `/internal/edge/enroll` [enrollment_http.go](../../internal/manager/server/edge/enrollment_http.go)
- `/edge/` 静态目录 [nginx.conf](../../deploy/install/nginx.conf)
- `get_plugin_configs` / `plugin_configs_changed`
- `restart_service.restart`
- `fetch_package` / `apply_package`

## 5. 制品布局

Manager 宿主目录：

```text
/opt/ongrid/edge/windows/
├── ongrid-edge-installer.exe
├── manifest.json
├── modern-amd64/
│   ├── ongrid-edge-supervisor.exe
│   ├── ongrid-edge-worker.exe
│   ├── plugins/
│   │   ├── windows_exporter.exe
│   │   ├── otelcol-contrib.exe
│   │   └── ...
│   └── apply-pending-upgrade.ps1
└── legacy-amd64/
    ├── ongrid-edge-supervisor.exe
    ├── ongrid-edge-worker.exe
    ├── plugins/
    └── apply-pending-upgrade.ps1
```

`manifest.json`：

```json
{
  "schema": 1,
  "version": "v0.20.0",
  "variants": [
    {
      "id": "modern-amd64",
      "min_os": { "major": 10, "build": 14393 },
      "files": [
        { "path": "ongrid-edge-supervisor.exe", "sha256": "...", "dest": "bin" },
        { "path": "ongrid-edge-worker.exe", "sha256": "...", "dest": "bin" },
        { "path": "plugins/windows_exporter.exe", "sha256": "...", "dest": "plugins" }
      ]
    },
    {
      "id": "legacy-amd64",
      "min_os": { "major": 6, "build": 7601 },
      "files": []
    }
  ]
}
```

要求：

- 每个文件必须有 SHA-256；
- `dest` 只允许 `bin` / `plugins` / `etc` 白名单；
- 安装器拒绝 `..`、绝对路径和未知字段；
- manifest 由发布脚本生成，不手工维护。

## 6. 安装器设计

### 6.1 CLI

```text
ongrid-edge-installer.exe [options]

  --manager-url URL          Manager HTTPS 根地址
  --enrollment-token TOKEN   批量 enrollment
  --access-key KEY           单设备
  --secret-key SECRET        单设备
  --server-edge-addr HOST:PORT
  --tls-ca-file PATH
  --tls-server-name NAME
  --tls-insecure             仅自签名测试
  --variant auto|modern|legacy
  --uninstall
  --dry-run
  --log-file PATH
```

规则：

- `--enrollment-token` 与 access/secret 互斥；
- `--manager-url` 必须是 https，除非 loopback；
- `--variant auto` 根据 OS build 选择；
- 非管理员运行时退出并提示。

### 6.2 安装流程

1. 检查 OS 版本/架构；不在矩阵内则拒绝，`--variant legacy` 除外。
2. 解析 manifest，选择 variant。
3. 下载所有文件到临时目录，逐个校验 SHA-256。
4. 如果使用 enrollment token，调用 `/internal/edge/enroll`，拿到独立凭证。
5. 创建 `C:\Program Files\ongrid-edge\bin`、`C:\ProgramData\ongrid-edge\...`。
6. 设置 ACL：SYSTEM + Administrators 完全控制，禁止继承。
7. 放置 supervisor/worker/plugins。
8. 写一个临时配置文件（ACL 受限），调用：
   ```text
   supervisor.exe --install --config-file <temp> 
   ```
   或在 supervisor 增加 `--token-file`，避免 secret 出现在命令行。
9. 启动服务，轮询：
   - 服务状态；
   - `health.json`；
   - 事件日志/日志文件中的 `tunnel: connected` / `registered with cloud`。
10. 输出自检结果；失败返回非 0。

### 6.3 卸载

```text
ongrid-edge-installer.exe --uninstall
```

- 停止并删除服务；
- 删除 `secrets.enc`；
- 保留数据/日志，除非 `--purge`；
- 删除安装器自己放置的二进制和插件（可选 `--purge`）。

## 7. Legacy 变体

### 7.1 Go 1.20 兼容构建

新增 `tools/build-legacy-windows.sh`：

1. 复制源码到临时目录（排除 `.git`、`web/node_modules`、`bin`、`dist`）；
2. 写入 Go 1.20 的 `go.mod`；
3. 替换 import：
   - `log/slog` → `github.com/ongridio/ongrid/internal/compat/slog`
   - `slices` → `github.com/ongridio/ongrid/internal/compat/slices`
   - `maps` → `github.com/ongridio/ongrid/internal/compat/maps`
4. 将 `min`/`max` 调用改为 `internal/compat/minmax`（主代码先完成这次可移植性重构）；
5. 用 `replace` 指向 `third_party/geminio`，该副本 `go.mod` 降为 1.20；
6. pin Go 1.20 兼容的 `golang.org/x/crypto` / `golang.org/x/sys`；
7. `go build` supervisor/worker。

兼容包：

```text
internal/compat/slog/     // go1.21: 转发 log/slog；!go1.21: golang.org/x/exp/slog
internal/compat/slices/   // go1.21: 转发 slices；!go1.21: golang.org/x/exp/slices
internal/compat/maps/     // go1.21: 转发 maps；!go1.21: golang.org/x/exp/maps
internal/compat/minmax/   // 泛型 Min/Max，替代内建 min/max
```

CI 增加 `GOOS=windows GOARCH=amd64 GOTOOLCHAIN=go1.20.x` 的构建 job，失败即阻断。

### 7.2 Legacy 能力

保留：

- tunnel、`register_edge`、`heartbeat`；
- `get_host_load`、`get_process_list`；
- `host_files.stat_file`、只读文件诊断；
- `restart_service.restart`（Windows 实现，见 7.3）；
- 插件：`metrics`、`custommetrics`、`hostmetrics`、`logs`、`traces`、`databasemetrics`；
- 升级：复用 supervisor/upgrademachine。

不保留：

- `bash.exec`；
- WebSSH；
- 抓包；
- K8s；
- OBI/autoapm/profiles（除非验证 Windows 可用）。

### 7.3 restart_service Windows 实现

新增 `internal/edgeagent/restart_service/handlers_windows.go`：

- 方法名保持 `restart_service.restart`；
- 使用 `sc.exe query/stop/start`，或 `net stop/start`；
- 服务名 allowlist 从 `C:\ProgramData\ongrid-edge\restart-policy.json` 读取，默认：
  - `W3SVC`、`MySQL`、`Redis`、`nginx`、`ongrid`；
- 请求中的服务名做大小写归一和长度限制；
- 禁止 `sc.exe` 之外的 shell 解释；
- 超时、输出上限与 Linux 版本一致；
- `Mocked` 默认 false（Windows 实现真实执行），但需要在测试环境验证。

### 7.4 插件

Windows 插件二进制命名：

| 插件 | 二进制 |
| --- | --- |
| `hostmetrics` | `windows_exporter.exe` |
| `logs` / `traces` | `otelcol-contrib.exe` |
| `databasemetrics` | `mysqld_exporter.exe`、`postgres_exporter.exe`、`redis_exporter.exe` |
| `metrics` / `custommetrics` | 进程内，无二进制 |
| `procmetrics` / `profiles` | Windows 不注册（无打包二进制） |

需要改动：

- `bootstrap_plugins.go` 增加 Windows 分支，只注册支持的插件；
- 插件二进制路径统一使用 `.exe`；
- `hostmetrics` 的默认监听地址和指标前缀按 Windows exporter 适配；
- 不支持的插件在 Manager 侧显示为不可用，不静默失败。

#### 7.4.1 插件二进制版本与打包

Windows 插件二进制随 `VERSION` 作为版本化 Release 附件发布，不进入不可变的 Linux 依赖归档。版本固定在 `Makefile`：

| 插件 | 二进制 | 版本变量 | 固定版本 | 上游资产 |
| --- | --- | --- | --- | --- |
| `hostmetrics` | `windows_exporter.exe` | `WINDOWS_EXPORTER_VERSION` | `0.29.0` | `windows_exporter-0.29.0-amd64.exe` |
| `logs` / `traces` | `otelcol-contrib.exe` | `OTELCOL_VERSION` | `0.157.0` | `otelcol-contrib_0.157.0_windows_amd64.tar.gz` |
| `databasemetrics`（mysql） | `mysqld_exporter.exe` | `MYSQLD_EXPORTER_VERSION` | `0.19.0` | `mysqld_exporter-0.19.0.windows-amd64.tar.gz` |
| `databasemetrics`（postgresql） | `postgres_exporter.exe` | `POSTGRES_EXPORTER_VERSION` | `0.19.1` | `postgres_exporter-0.19.1.windows-amd64.tar.gz` |
| `databasemetrics`（redis） | `redis_exporter.exe` | `REDIS_EXPORTER_VERSION` | `1.86.0` | `redis_exporter-v1.86.0.windows-amd64.zip` |

`WINDOWS_EXPORTER_VERSION=0.29.0` 是 0.30 配置重写前的最后一个版本，保留 pre-0.30 参数：

- `--web.listen-address`;
- `--collectors.enabled`（逗号分隔）；
- `--collector.textfile.directories`（textfile collector 默认关闭，仅在显式启用 `textfile` 时传入）。

0.29.0 不提供 `--collectors.disabled`；Windows `hostmetrics` 配置必须通过 `collectors_enabled` 或 `extra_args` 选择 collector，不能依赖 `collectors_disabled`。升级到 >= 0.30 前必须重新验证 `internal/edgeagent/plugins/hostmetrics` 的参数契约。

数据库 exporter 能力按上游资产决定：

- `percona/mongodb_exporter` 0.51.0 只发布 darwin/linux 资产，没有 Windows amd64 资产。因此 Windows 的 `databasemetrics` 能力只包含 mysql/postgresql/redis，不打包 `mongodb_exporter.exe`，Manager 不应向 Windows Edge 下发 mongodb source。若后续需要 mongodb，必须先确认上游 Windows 资产或换用其他 exporter，不能静默注册缺二进制的 source。
- `redis_exporter` 上游只发布 `.zip`，构建机需要 `unzip`；缺失时 fetch 目标明确报错。

获取与发布：

- `make fetch-edge-plugins-windows`（`fetch-windows-exporter` + `fetch-otelcol-windows` + `fetch-db-exporters-windows`）把插件下载并校验到 `bin/windows-amd64/<plugin>.exe`；目标已存在时跳过。校验来源分别为 windows_exporter 的 `sha256sums.txt`、otelcol 的 `opentelemetry-collector-releases_otelcol-contrib_windows_checksums.txt`、各 DB exporter 的 `sha256sums.txt`。
- `dist/build-edge-attachments.sh edge <version> <out> windows-amd64` 为每个插件生成 `ongrid-edge-windows-amd64-<version>-<plugin>.exe` 及 `.sha256` sidecar；任一必需插件缺失即构建失败。
- `fetch-edge-assets.sh` 下载这些版本化附件，并同时 stage 到 `windows/modern-amd64/plugins/` 与 `windows/legacy-amd64/plugins/`，供 manifest 生成器引用。
- `scripts/test-windows-plugin-assets.sh` 用 fixture 二进制校验附件、sidecar、缺失插件失败路径和版本固定。

## 8. Manager 与 UI

### 8.1 制品发布

- `dist/build-edge-attachments.sh` 增加 `windows` 模式；
- `Makefile` 增加 `build-edge-windows-amd64`、`build-edge-windows-legacy-amd64`；
- `fetch-edge-assets.sh` 支持 windows target；
- `edge-artifacts.env` 增加 `ONGRID_WINDOWS_EDGE_TARGETS`；
- Manager staging 到 `/opt/ongrid/edge/windows/`；
- nginx 暴露 `/edge/windows/`。

### 8.2 UI

- `web/src/pages/Edges.tsx` 的 `InstallCommandRow` 增加 OS 切换；
- `web/src/pages/Edges.tsx` 的 `BatchInstallCommand` 增加 Windows 命令；
- `web/src/pages/clusters/ClusterEnrollmentModal.tsx` 增加 Windows 命令；
- 文案使用 `tr()`，覆盖中英文；
- Windows 命令默认：
  ```powershell
  $u='https://<host>/edge/windows/ongrid-edge-installer.exe'
  $f="$env:TEMP\ongrid-edge-installer.exe"
  (New-Object Net.WebClient).DownloadFile($u,$f)
  & $f --manager-url https://<host> --enrollment-token <token> --server-edge-addr <host>:40012
  ```
  对 2008 R2，文档建议先通过共享/GPO 分发安装器，再执行本地命令。

## 9. 安全

- 所有下载校验 SHA-256；
- 生产环境要求 Authenticode 签名；2008 R2 需要 SHA-2 补丁；
- ACL 仅 SYSTEM + Administrators；
- DPAPI 机器级加密；
- restart_service 白名单 + 二次校验；
- Legacy 不提供 bash/Unrestricted；
- 安装器不记录 secret；
- 失败保留现场，不回滚已创建服务；
- 2008 R2 已 EOL，文档明确风险，建议网络隔离。

## 10. 测试

单元测试：

- manifest 解析、路径白名单、SHA-256；
- OS build 检测和 variant 选择；
- 安装器参数校验；
- restart_service 命令构造和 allowlist；
- 插件注册的 Windows 分支；
- 兼容包的 build tag 行为。

交叉编译：

- `GOOS=windows GOARCH=amd64` modern；
- `GOOS=windows GOARCH=amd64 GOTOOLCHAIN=go1.20.x` legacy；
- `go vet`。

手工矩阵：

| 系统 | 变体 | 验证 |
| --- | --- | --- |
| Server 2008 R2 SP1 x64 | Legacy | 安装、注册、心跳、restart_service、插件、升级、卸载 |
| Server 2012 R2 x64 | Legacy（best-effort） | 同上 |
| Server 2016 x64 | Modern | 同上 |
| Server 2019 / 2022 x64 | Modern | 同上 |

安全检查：

- 非管理员安装失败；
- 伪造 manifest / 路径穿越失败；
- 错误 SHA-256 失败；
- ACL 不允许普通用户写；
- secret 不出现在日志/命令行。

## 11. 回滚

- 安装器失败不删除已有服务/凭证；
- Legacy 上线前保留原 Linux/手动安装方式；
- 制品版本与 Manager 版本绑定；
- 服务升级失败由 updatemachine 回滚；
- 文档说明如何卸载和恢复。

## 12. 开放风险

| 风险 | 处理 |
| --- | --- |
| Go 1.20 兼容构建不可行 | Phase 0 go/no-go；回退到独立最小 Agent |
| geminio 旧版本 API 不兼容 | vendor 当前版本并降低 go.mod；必要时 fork |
| 2008 R2 TLS 1.2 缺失 | 安装器用 Go TLS；首次分发走 GPO/共享 |
| SHA-2 签名补丁缺失 | 安装 KB3033929 或提供未签名应急包 |
| 插件 Windows 兼容性 | 只注册验证过的插件；其余显示不可用 |
| restart_service 服务名差异 | 可配置 allowlist；默认保守 |
| 双构建线维护 | CI 强制 legacy 构建；限制新特性使用 |
