# Windows Legacy Compatibility Spike（Phase 0）

本目录是 Windows Edge 安装计划的 Phase 0 go/no-go 探针，目标平台为 **Windows Server 2008 R2 SP1 x64**。它独立于主模块（`go 1.20`，不 import `github.com/ongridio/ongrid`），用于在真实目标机上确认三件事：

1. 二进制确实由 Go 1.20.x 构建（Go 1.21+ 的 Windows 二进制不再支持 2008 R2）。
2. `net/http` 能通过目标机的 TLS 栈访问 Manager 的 `/healthz`，并输出协商到的 TLS 版本与 cipher suite。
3. geminio client 能向 Frontier 发起 TCP dial 并完成握手。

探测失败不会被当作进程错误：本工具的用途是**观察并记录**。输出中的 `FAIL` / `DIAL-ERROR` 即为需要回填到计划 Decision Log 的证据。

## 目录说明

- `main.go`：探针主逻辑，仅使用 Go 1.20 标准库和 geminio client。
- `main_test.go`：纯逻辑测试（参数解析、`/healthz` URL 归一化、TLS 版本名、本地 httptest TLS 1.2 检查）。不伪造 Windows 运行结果。
- `third_party/geminio/`：从 module cache 复制的 geminio `v1.3.0-rc.2`，为 Go 1.20 做了最小补丁（见下）。

## geminio 补丁说明

上游 `v1.3.0-rc.2` 的 `go.mod` 声明 `go 1.24.0` 和 `toolchain go1.24.13`。本目录的副本只做了以下改动：

- `go` 指令改为 `1.20`，删除 `toolchain` 行。
- 删除仅测试/工具使用的依赖：`github.com/golang/mock`、`github.com/singchia/go-xtables`。
- 删除 `third_party/geminio` 内的 `*_test.go`、`application/mock`、`examples/`、`test/`、`tools/`、`docs/`，以及 `conn/example`、`conn/bench`、`conn/batch`、`multiplexer/example`、`multiplexer/bench` 等示例/压测目录，避免非生产依赖进入构建图。
- `github.com/jumboframes/armorigo` 从上游的 `v0.2.5` 固定到本地缓存可用的 `v0.4.1`（`go 1.18`，`log`/`synchub` API 兼容）。
- 显式 pin `golang.org/x/crypto v0.31.0`（`go 1.20`）和 `golang.org/x/sys v0.28.0`（`go 1.18`）。当前 client-only 路径没有 import 它们，但 pin 可防止后续扩展时 MVS 选到要求 Go 1.21+ 的版本。

非测试源码已扫描 `log/slog`、`slices`、`maps`、`min`/`max`、`errors.Join`、泛型等 Go 1.21+ 特性，未发现使用。`go build ./...` 在 Go 1.20.14 下通过（含 geminio 全部保留包）。

## 构建（必须使用真实 Go 1.20 工具链）

仓库默认工具链较新，构建本目录时必须显式选择 Go 1.20：

```bash
cd tools/legacy-spike
GOTOOLCHAIN=go1.20.14 go mod download
GOTOOLCHAIN=go1.20.14 go test ./...
GOTOOLCHAIN=go1.20.14 go vet ./...
GOTOOLCHAIN=go1.20.14 GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -o legacy-spike.exe .
```

确认产物：

```bash
file legacy-spike.exe
# 期望包含：PE32+ executable for MS Windows 6.01 (console), x86-64
GOTOOLCHAIN=go1.20.14 go version -m legacy-spike.exe
# 期望第一行：legacy-spike.exe: go1.20.14
```

`file` 中的 **MS Windows 6.01** 是 Windows 7 / Server 2008 R2 的 PE 子系统版本；Go 1.21+ 会生成 6.02+，无法在 2008 R2 启动。

如果本机没有 Go 1.20.14，`GOTOOLCHAIN=go1.20.14` 会让 Go 从模块代理下载 `golang.org/toolchain`。完全离线时需预先安装 Go 1.20.14（例如放在 `~/sdk/go1.20.14`），然后再构建。

## Windows Server 2008 R2 SP1 手工验证步骤

前置条件：

1. 系统为 Windows Server 2008 R2 **SP1 x64**（不覆盖 2008 非 R2 / x86）。
2. Manager 与 Frontier 网络可达（出站 TCP 443 / Frontier edgebound 40012）。
3. 启用 TLS 1.2。2008 R2 默认未启用；需要 KB3140245 + 注册表 `SchUseStrongCrypto`，或等效 GPO。Go 的 `crypto/tls` 在用户态实现 TLS 1.2，但 Windows 证书存储和部分系统组件仍依赖该设置。
4. 将 Manager 证书的签发 CA 导入 `Cert:\LocalMachine\Root`。若证书使用 SHA-256，安装 **KB3033929**（SHA-2 代码签名/证书支持），否则 Authenticode 校验可能失败；TLS 信任链本身仍取决于 CA 是否受信。
5. 系统时间正确（TLS 证书有效期校验）。

Frontier 必须使用 **edgebound 端口 40012**（见 `deploy/install/frontier.yaml`）。`40011` 是 manager 的 servicebound 端口，不属于 edge 连接路径。探针使用专用环境变量 `ONGRID_EDGE_FRONTIER_ADDR`；不要与仓库中表示 manager servicebound 地址的 `ONGRID_FRONTIER_ADDR` 混用。

执行：

```powershell
# 复制 legacy-spike.exe 到目标机后
.\legacy-spike.exe `
  -manager https://manager.example.com `
  -frontier frontier.example.com:40012 `
  -timeout 10s
```

也可用环境变量：

```powershell
$env:ONGRID_MANAGER_URL = "https://manager.example.com"
$env:ONGRID_EDGE_FRONTIER_ADDR = "frontier.example.com:40012"
.\legacy-spike.exe
```

输出示例：

```text
runtime: go1.20.14 (windows/amd64)
manager: OK https://manager.example.com/healthz status=200 tls=TLS 1.2 cipher=TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
frontier: OK frontier.example.com:40012 geminio handshake completed in 12ms
legacy-spike: finished; copy these lines into the plan Decision Log
```

判定：

| 观察 | 结论 |
| --- | --- |
| `runtime: go1.20.x` | Go 1.20 运行时 PASS。若显示更高版本，构建工具链错误，必须重新构建。 |
| `manager: OK ... tls=TLS 1.2` | Manager TLS 1.2 PASS。 |
| `manager: FAIL ... x509` / `tls:*` | 记录完整错误；检查 CA 链、KB3033929、TLS 1.2 注册表/GPO。若首次下载必须走 Schannel，文档需给出 GPO/SCCM/共享分发路径。 |
| `frontier: OK` | geminio dial + 握手 PASS。 |
| `frontier: DIAL-ERROR ... connection refused/timeout` | 仅证明网络路径/监听问题；记录目标地址和错误。 |
| `frontier: DIAL-ERROR ... i/o timeout` | 目标可达但未完成 geminio 握手；记录耗时，确认 Frontier 端口与协议版本。 |

回填到计划末尾的 Decision Log：

```markdown
- Phase 0 result: PASS / FAIL / PENDING VM
- Go 1.20 runtime: <runtime 行>
- Manager TLS 1.2: <manager 行或错误>
- geminio version: v1.3.0-rc.2（本地 patch 副本）
- Fallback needed: yes/no
```

清理：直接删除 `legacy-spike.exe` 即可；本探针不安装服务、不写注册表、不持久化任何 secret。

## 已完成的本地验证（Linux，非 VM）

- `GOTOOLCHAIN=go1.20.14 go test ./...`：通过。
- `GOTOOLCHAIN=go1.20.14 go test -race ./...`：通过。
- `GOTOOLCHAIN=go1.20.14 go vet ./...`：通过。
- `GOOS=windows GOARCH=amd64 CGO_ENABLED=0` 交叉编译：通过；产物为 `PE32+ ... MS Windows 6.01 ... x86-64`，`go version -m` 报告 `go1.20.14`。
- 尚未在真实 Windows Server 2008 R2 SP1 上运行；该项保持 `PENDING VM`，按上文步骤手工验证。
