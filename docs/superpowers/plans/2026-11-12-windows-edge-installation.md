# Windows Edge 安装与 Legacy Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Windows 提供与 Linux 等价的一键安装链路，并在 Windows Server 2008 R2 SP1 x64 上提供带 `restart_service` 和插件运行时的 Legacy Agent。

**Architecture:** 用一个独立的 Go 1.20 安装器完成下载、校验、enrollment、ACL 和服务安装；Modern 变体使用当前 Go 1.25 Agent，Legacy 变体用 Go 1.20 兼容构建复用同一套 Agent 源码。Manager 只新增静态制品目录和 UI 命令生成，不改隧道协议。

**Tech Stack:** Go 1.25（主模块）、Go 1.20（安装器与 Legacy 构建）、PowerShell 2.0 兼容引导、Windows SCM/DPAPI/icacls、systemd 无关。

**Spec:** [docs/design/windows-edge-installation.md](../../design/windows-edge-installation.md)

## Global Constraints

- Legacy 目标固定为 **Windows Server 2008 R2 SP1 x64**；不承诺 2008 非 R2、x86、2012/2012 R2。
- Modern 目标为 **Windows Server 2016 及以上 x64**。
- Legacy 构建必须使用 **Go 1.20.x**；主模块保持 `go 1.25.0`。
- 安装器必须能在 2008 R2 上运行，因此放在 **独立 Go 1.20 module**，不得 import 主模块。
- 所有下载必须校验 **SHA-256**；生产制品必须 Authenticode 签名。
- 安装器不得把 secret 写入日志；临时文件必须使用受限 ACL。
- 服务名固定为 `ongrid-edge`；secret 使用 DPAPI `CRYPTPROTECT_LOCAL_MACHINE`。
- Manager 协议、方法名和 JSON 结构不变；复用现有 `/internal/edge/enroll`。
- Legacy 不提供 bash、WebSSH、抓包、K8s、OBI/autoapm/profiles。
- 所有新增用户文案使用 `tr('中文', 'English')`。
- 文档与注释延续所在文件语言；PR 标题和 commit 标题使用英文 Conventional Commits。

## Review Focus

- **2008 R2 上的 TLS 1.2**：安装器必须用 Go TLS 连接 Manager；如果首次下载走 Schannel 失败，文档必须给出 GPO/SCCM/共享分发路径。
- **SHA-2 签名补丁**：2008 R2 未安装 KB3033929 时 Authenticode 验证可能失败；安装器必须给出明确错误，而不是静默继续。
- **Legacy 兼容构建**：`log/slog`、`slices`、`maps`、`min`/`max` 和依赖 `go` 指令是最可能失败的点；Phase 0 必须先证明。
- **restart_service 的服务名**：Windows 服务名与 Linux systemd unit 不同；错误 allowlist 会导致误重启或无法重启。
- **插件二进制命名**：Windows 需要 `.exe`，`hostmetrics` 应使用 `windows_exporter`，不能沿用 Linux 的 `node_exporter`。
- **升级文件锁**：worker/插件进程未退出时替换 `.exe` 会失败；必须复用现有 `taskkill /T /F` 和 upgrademachine。
- **ACL 与 DPAPI**：安装器创建目录时必须禁止继承，只保留 SYSTEM + Administrators；否则普通用户可写二进制。
- **幂等安装**：重复执行安装器不能破坏现有凭证、服务和已运行 Agent。

---

## File Structure

新增：

- `tools/windows-installer/`：独立 Go 1.20 安装器 module
  - `go.mod`
  - `main.go`
  - `args.go` / `args_test.go`
  - `manifest.go` / `manifest_test.go`
  - `osversion_windows.go` / `osversion_other.go`
  - `download.go` / `download_test.go`
  - `enroll.go` / `enroll_test.go`
  - `secure_windows.go` / `secure_other.go`
  - `service_windows.go` / `service_other.go`
  - `install.go` / `install_test.go`
  - `selfcheck.go` / `selfcheck_test.go`
- `internal/compat/slog/`
- `internal/compat/slices/`
- `internal/compat/maps/`
- `internal/compat/minmax/`
- `internal/edgeagent/restart_service/handlers_windows.go`
- `internal/edgeagent/restart_service/policy_windows.go`
- `internal/edgeagent/restart_service/handlers_windows_test.go`
- `dist/build-windows-manifest.sh`
- `tools/build-legacy-windows.sh`
- `docs/install/windows.md`

修改：

- `Makefile`：增加 Windows 构建/发布目标
- `dist/build-edge-attachments.sh`：增加 windows 模式
- `deploy/install/edge/fetch-edge-assets.sh`：支持 windows 制品
- `deploy/install/nginx.conf`：暴露 `/edge/windows/`
- `deploy/install/docker-compose.yml`：挂载 windows 目录
- `web/src/pages/Edges.tsx`
- `web/src/pages/clusters/ClusterEnrollmentModal.tsx`
- `web/src/pages/Edges.test.tsx`
- `cmd/ongrid-edge/bootstrap_plugins.go` 或新增 `bootstrap_plugins_windows.go`
- `cmd/ongrid-edge/main.go`（Windows 插件/能力分支）
- `cmd/ongrid-edge/capabilities_windows.go`
- `cmd/ongrid-edge-supervisor/install_windows.go`（`--config-file` / `--token-file`）

---

## Task 0: Phase 0 compatibility spike (go/no-go)

**Files:**
- Create: `tools/legacy-spike/main.go`
- Create: `tools/legacy-spike/go.mod`
- Create: `tools/legacy-spike/README.md`
- Test: `tools/legacy-spike/main_test.go`（仅纯逻辑；Windows 运行验证手工）

**Interfaces:**
- Produces: 一份 `docs/superpowers/plans/2026-11-12-windows-edge-installation.md` 的决策记录（在 task 完成后追加到本文末尾的 Decision Log）。

- [ ] **Step 1: Create a Go 1.20 spike module**

`tools/legacy-spike/go.mod`:

```go
module example.com/legacy-spike

go 1.20

require github.com/singchia/geminio v0.0.0

replace github.com/singchia/geminio => ./third_party/geminio
```

`main.go` 做三件事：打印 `runtime.Version()`；用 `net/http` 请求 Manager 的 `/healthz`；用 geminio client 建立一个到 Frontier 的 dial（失败即可，记录错误）。

- [ ] **Step 2: Vendor/patch geminio for Go 1.20**

复制当前 module cache 中的 geminio 到 `tools/legacy-spike/third_party/geminio`，把 `go.mod` 的 `go 1.24.0` / `toolchain` 改为 `go 1.20`，pin `golang.org/x/crypto`、`golang.org/x/sys` 到 Go 1.20 可编译的版本。

- [ ] **Step 3: Cross-compile and run on the target VM**

Run on Linux:

```bash
cd tools/legacy-spike
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o legacy-spike.exe .
```

Copy to Windows Server 2008 R2 SP1 x64 and run:

```powershell
.\legacy-spike.exe
```

Expected: 进程启动，打印 Go 版本；HTTPS 请求成功或给出明确 TLS 错误；geminio dial 至少能发起连接。

- [ ] **Step 4: Record go/no-go**

在本文末尾 Decision Log 追加：

```markdown
- Phase 0 result: PASS / FAIL
- Go 1.20 runtime: ...
- Manager TLS 1.2: ...
- geminio version: ...
- Fallback needed: yes/no
```

- [ ] **Step 5: Commit**

```bash
git add tools/legacy-spike docs/superpowers/plans/2026-11-12-windows-edge-installation.md
git commit -m "chore(edge): add windows legacy compatibility spike"
```

---

## Task 1: Modern Windows build and release targets

**Files:**
- Modify: `Makefile`
- Modify: `dist/build-edge-attachments.sh`
- Test: `scripts/test-edge-attachments.sh`（或新增 `scripts/test-windows-attachments.sh`）

**Interfaces:**
- Produces: `make build-edge-windows-amd64`, `make build-edge-version-attachments` includes `ongrid-edge-windows-amd64`.

- [ ] **Step 1: Add a failing shell test**

Create `scripts/test-windows-attachments.sh` that asserts:

```bash
# after running the builder in a temp dir
test -f "$out/ongrid-edge-windows-amd64-$version"
test -f "$out/ongrid-edge-windows-amd64-$version.sha256"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/test-windows-attachments.sh`
Expected: FAIL because the builder does not support windows.

- [ ] **Step 3: Add Makefile target**

```make
.PHONY: build-edge-windows-amd64
build-edge-windows-amd64:
	@mkdir -p $(BIN_DIR)/windows-amd64
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
		go build -trimpath -ldflags "-s -w $(LDFLAGS)" \
		-o $(BIN_DIR)/windows-amd64/ongrid-edge-supervisor.exe ./cmd/ongrid-edge-supervisor
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
		go build -trimpath -ldflags "-s -w $(LDFLAGS)" \
		-o $(BIN_DIR)/windows-amd64/ongrid-edge-worker.exe ./cmd/ongrid-edge
```

- [ ] **Step 4: Extend `dist/build-edge-attachments.sh` with a `windows` mode**

Inputs: `bin/windows-amd64/ongrid-edge-supervisor.exe`, `bin/windows-amd64/ongrid-edge-worker.exe`; output: two attachment files plus `.sha256`.

- [ ] **Step 5: Run the shell test**

Run: `bash scripts/test-windows-attachments.sh`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Makefile dist/build-edge-attachments.sh scripts/test-windows-attachments.sh
git commit -m "build(edge): add windows amd64 release attachments"
```

---

## Task 2: Manager artifact staging and nginx route

**Files:**
- Modify: `deploy/install/edge/fetch-edge-assets.sh`
- Modify: `deploy/install/edge/edge-assets-lib.sh`
- Modify: `deploy/install/nginx.conf`
- Modify: `deploy/install/docker-compose.yml`
- Modify: `deploy/install/README.md`
- Test: `scripts/test-edge-assets.sh`

**Interfaces:**
- Produces: `/opt/ongrid/edge/windows/` and nginx route `/edge/windows/`.

- [ ] **Step 1: Add failing assertions to `scripts/test-edge-assets.sh`**

Assert that a windows target stages:

```bash
test -f "$dest/windows/manifest.json"
test -f "$dest/windows/modern-amd64/ongrid-edge-supervisor.exe"
```

- [ ] **Step 2: Extend `edge-assets-lib.sh`**

Add `ongrid_normalize_edge_targets` support for `windows-amd64`; keep existing Linux targets unchanged.

- [ ] **Step 3: Extend `fetch-edge-assets.sh`**

Download `ongrid-edge-windows-amd64-<version>-supervisor.exe` and `ongrid-edge-windows-amd64-<version>-worker.exe` plus their `.sha256` sidecars, verify SHA-256, and lay them out as `windows/modern-amd64/ongrid-edge-supervisor.exe` and `.../ongrid-edge-worker.exe`.

- [ ] **Step 4: Add nginx route**

```nginx
location /edge/windows/ {
    alias /usr/share/nginx/html/edge/windows/;
}
```

- [ ] **Step 5: Mount the directory**

Add `./edge/windows:/usr/share/nginx/html/edge/windows:ro` to the nginx service.

- [ ] **Step 6: Run tests**

Run: `bash scripts/test-edge-assets.sh`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy/install/edge/fetch-edge-assets.sh deploy/install/edge/edge-assets-lib.sh deploy/install/nginx.conf deploy/install/docker-compose.yml deploy/install/README.md scripts/test-edge-assets.sh
git commit -m "feat(edge): stage windows install artifacts on the manager"
```

---

## Task 2.5: Persist and validate Windows staging in install/upgrade

**Files:**
- Modify: `deploy/install/install.sh`
- Modify: `deploy/install/upgrade.sh`
- Modify: `deploy/install/edge/edge-assets-lib.sh`
- Modify: `deploy/install/.env.example`
- Modify: `scripts/test-edge-assets-lib.sh`
- Create: `scripts/test-windows-staging-upgrade.sh`

**Interfaces:**
- Produces: `ONGRID_WINDOWS_EDGE_TARGETS` persisted in `edge-artifacts.env`; `install.sh`/`upgrade.sh` validate it, stage `windows/`, and preserve it across upgrades without passing it to the Linux-only bundle builder.

- [ ] **Step 1: Write failing tests**

`scripts/test-windows-staging-upgrade.sh` asserts:

- a Windows target is accepted by `edge-assets-lib.sh`;
- `install.sh`/`upgrade.sh` pass `windows-amd64` to the fetch script but never to `deploy/install/edge/build-edge-bundle.sh`;
- a simulated upgrade with a Linux-only target set preserves an existing `edge/windows/` tree;
- the error strings list the supported Windows target.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash scripts/test-windows-staging-upgrade.sh`
Expected: FAIL because the wiring does not exist.

- [ ] **Step 3: Implement the wiring**

- Add `ONGRID_WINDOWS_EDGE_TARGETS` to `.env.example` and the artifact config.
- `edge-assets-lib.sh`: validate `windows-amd64` and include it in the resolved target list.
- `install.sh`/`upgrade.sh`: pass Windows targets to `fetch-edge-assets.sh`; exclude them from `build-edge-bundle.sh`; update error strings.
- Preserve `edge/windows/` across upgrade by staging it from the new package plus fetched artifacts, rather than deleting it with the rest of the edge tree.
- `ongrid_validate_embedded_edge_assets`: handle the Windows directory.

- [ ] **Step 4: Run the tests**

Run:

```bash
bash scripts/test-windows-staging-upgrade.sh
bash scripts/test-edge-assets-lib.sh
bash scripts/test-edge-assets.sh
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/install/install.sh deploy/install/upgrade.sh deploy/install/edge/edge-assets-lib.sh deploy/install/.env.example scripts/test-edge-assets-lib.sh scripts/test-windows-staging-upgrade.sh
git commit -m "feat(edge): persist windows artifacts across manager upgrades"
```

---

## Task 3: Installer module skeleton and manifest

**Files:**
- Create: `tools/windows-installer/go.mod`
- Create: `tools/windows-installer/main.go`
- Create: `tools/windows-installer/args.go`
- Create: `tools/windows-installer/args_test.go`
- Create: `tools/windows-installer/manifest.go`
- Create: `tools/windows-installer/manifest_test.go`
- Create: `tools/windows-installer/osversion_windows.go`
- Create: `tools/windows-installer/osversion_other.go`

**Interfaces:**
- Produces:
  - `type OSVersion struct { Major, Minor, Build uint32 }`
  - `func ParseManifest(data []byte) (*Manifest, error)`
  - `func (m *Manifest) SelectVariant(v OSVersion, requested string) (*Variant, error)`
  - `func ParseArgs(args []string) (Options, error)`

- [ ] **Step 1: Write failing tests**

```go
func TestParseManifestRejectsPathTraversal(t *testing.T) {
    _, err := ParseManifest([]byte(`{"schema":1,"variants":[{"id":"x","files":[{"path":"../evil.exe","sha256":"..."}]}]}`))
    if err == nil { t.Fatal("expected error") }
}

func TestSelectVariantModern(t *testing.T) {
    m := manifestFixture()
    v, err := m.SelectVariant(OSVersion{Major: 10, Build: 17763}, "auto")
    if err != nil || v.ID != "modern-amd64" { t.Fatalf("got %v, %v", v, err) }
}

func TestSelectVariantLegacy(t *testing.T) {
    m := manifestFixture()
    v, err := m.SelectVariant(OSVersion{Major: 6, Minor: 1, Build: 7601}, "auto")
    if err != nil || v.ID != "legacy-amd64" { t.Fatalf("got %v, %v", v, err) }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/windows-installer && go test ./...`
Expected: FAIL with undefined symbols.

- [ ] **Step 3: Implement manifest and args**

Manifest rules:

- `schema` must be `1`;
- each file path must be relative, no `..`, no leading `/` or `\`;
- `dest` must be `bin`, `plugins`, or `etc`;
- `sha256` must be 64 hex chars.

- [ ] **Step 4: Implement OS detection**

Windows:

```go
//go:build windows
func WindowsVersion() (OSVersion, error)
```

Use `RtlGetVersion` via `syscall.NewLazyDLL("ntdll.dll")` to avoid the version-lie manifest issue.

Non-Windows:

```go
//go:build !windows
func WindowsVersion() (OSVersion, error) { return OSVersion{}, errors.New("windows only") }
```

- [ ] **Step 5: Run tests**

Run: `cd tools/windows-installer && go test ./...`
Expected: PASS on Linux; cross-build with `GOOS=windows go build ./...` also passes.

- [ ] **Step 6: Commit**

```bash
git add tools/windows-installer
git commit -m "feat(installer): add windows installer skeleton and manifest parser"
```

---

## Task 4: Installer download, checksum, and enrollment

**Files:**
- Create: `tools/windows-installer/download.go`
- Create: `tools/windows-installer/download_test.go`
- Create: `tools/windows-installer/enroll.go`
- Create: `tools/windows-installer/enroll_test.go`

**Interfaces:**
- Produces:
  - `func DownloadFile(ctx context.Context, client *http.Client, url, dest string) error`
  - `func VerifySHA256(path, expected string) error`
  - `func Enroll(ctx context.Context, client *http.Client, managerURL, token string, host HostInfo) (*Credentials, error)`

- [ ] **Step 1: Write failing httptest tests**

Use `httptest.NewServer` to serve a manifest and a binary, then assert:

- correct SHA-256 succeeds;
- wrong SHA-256 fails and deletes the temp file;
- enrollment sends `Authorization: Bearer <token>` and parses `access_key`/`secret_key`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/windows-installer && go test ./...`
Expected: FAIL with undefined symbols.

- [ ] **Step 3: Implement download and enrollment**

Enrollment:

- `POST {managerURL}/internal/edge/enroll`
- body `{"host_info": {...}, "agent_version": "..."}`
- timeout 20s;
- reject non-201;
- reject malformed credentials;
- do not log token or secret.

- [ ] **Step 4: Run tests**

Run: `cd tools/windows-installer && go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/windows-installer/download.go tools/windows-installer/download_test.go tools/windows-installer/enroll.go tools/windows-installer/enroll_test.go
git commit -m "feat(installer): download artifacts and enroll edge credentials"
```

---

## Task 5: Installer file placement, ACL, service install, uninstall

**Files:**
- Create: `tools/windows-installer/secure_windows.go`
- Create: `tools/windows-installer/secure_other.go`
- Create: `tools/windows-installer/service_windows.go`
- Create: `tools/windows-installer/service_other.go`
- Create: `tools/windows-installer/install.go`
- Create: `tools/windows-installer/install_test.go`
- Modify: `cmd/ongrid-edge-supervisor/install_windows.go`
- Modify: `cmd/ongrid-edge-supervisor/install_windows_test.go`

**Interfaces:**
- Produces:
  - `func SecureDir(path string) error`（icacls `/inheritance:r` + SYSTEM/Administrators）
  - `func InstallService(supervisorPath, configPath string) error`
  - `func UninstallService() error`
  - `supervisor.exe --install --config-file <path>`（新增）

**Integration requirements carried from Task 4 review:**
- `SecureDir` must run on the download staging directory **before** any artifact is downloaded.
- On SHA-256 mismatch, the downloaded artifact must be deleted; `VerifySHA256` itself is pure.
- Use a fresh destination path per file (or remove a stale destination first), because Windows `os.Rename` does not overwrite.
- Require `EdgeID != 0` from enrollment.
- Validate/normalize the enrollment response `CloudAddr`; fall back to `--server-edge-addr` when empty or malformed.
- Bound download size (e.g. 512 MiB) and set a download client timeout.
- Validate the manager URL as loopback-only for plaintext `http://` at the `Enroll` call boundary, not solely in `ParseArgs`.
- Document that `DownloadFile` requires a caller-supplied deadline when using the default client.

- [ ] **Step 1: Write failing tests for command construction**

Use an injectable `Runner` interface:

```go
type Runner interface { Run(name string, args ...string) error }
```

Test that `SecureDir` calls `icacls` with the expected flags, and `InstallService` calls `sc.exe create` with `binPath=` equal to the supervisor path.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/windows-installer && go test ./...`
Expected: FAIL.

- [ ] **Step 3: Implement ACL and service commands**

ACL:

```text
icacls <dir> /inheritance:r /grant:r *S-1-5-18:(OI)(CI)(F) *S-1-5-32-544:(OI)(CI)(F)
```

Service:

```text
sc.exe create ongrid-edge binPath= <supervisor.exe> start= auto DisplayName= "Ongrid Edge Agent"
sc.exe failure ongrid-edge reset= 86400 actions= restart/60000/restart/60000/restart/60000
sc.exe start ongrid-edge
```

- [ ] **Step 4: Add `--config-file` to supervisor install**

`installOptions` adds `ConfigFile string`; when set, read JSON:

```json
{
  "cloud_addr": "...",
  "access_key": "...",
  "secret_key": "...",
  "collector_mode": "off",
  "plugin_bin_dir": "...",
  "plugin_work_dir": "...",
  "tls_ca_file": "...",
  "tls_server_name": "..."
}
```

The secret is read from the file, never from argv. After install, the installer deletes the temp file.

- [ ] **Step 5: Implement install orchestration**

Order:

1. `SecureDir` for `C:\Program Files\ongrid-edge\bin`, `C:\ProgramData\ongrid-edge`, `...\plugins`, `...\upgrade`;
2. copy files;
3. write config file with restricted ACL;
4. call `supervisor.exe --install --config-file`;
5. poll service + `health.json`;
6. delete config file.

- [ ] **Step 6: Run tests and cross-build**

Run:

```bash
cd tools/windows-installer && go test ./...
GOOS=windows GOARCH=amd64 go build ./...
```

Expected: PASS.

- [ ] **Step 7: Manual Windows VM test**

On a modern Windows VM, run the installer with a test token and verify the service starts and the device appears in the UI.

- [ ] **Step 8: Commit**

```bash
git add tools/windows-installer cmd/ongrid-edge-supervisor/install_windows.go cmd/ongrid-edge-supervisor/install_windows_test.go
git commit -m "feat(installer): install windows service with secure config handoff"
```

---

## Task 6: UI Windows install commands

**Files:**
- Modify: `web/src/pages/Edges.tsx`
- Modify: `web/src/pages/clusters/ClusterEnrollmentModal.tsx`
- Modify: `web/src/pages/Edges.test.tsx`
- Modify: `web/src/i18n/*`（按现有结构）

**Interfaces:**
- Produces: OS toggle in install dialogs; Windows command uses `ongrid-edge-installer.exe`.

- [ ] **Step 1: Write failing frontend tests**

Add assertions that switching to Windows renders:

```text
ongrid-edge-installer.exe
--manager-url
--enrollment-token
```

and does not render `curl`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- Edges.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the OS toggle and command builder**

Single-device Windows command:

```powershell
$u='https://<host>/edge/windows/ongrid-edge-installer.exe'
$f="$env:TEMP\ongrid-edge-installer.exe"
(New-Object Net.WebClient).DownloadFile($u,$f)
& $f --manager-url https://<host> --access-key <key> --secret-key <secret> --server-edge-addr <host>:40012
```

Batch command:

```powershell
$u='https://<host>/edge/windows/ongrid-edge-installer.exe'
$f="$env:TEMP\ongrid-edge-installer.exe"
(New-Object Net.WebClient).DownloadFile($u,$f)
& $f --manager-url https://<host> --enrollment-token <token> --server-edge-addr <host>:40012 --tls-insecure
```

- [ ] **Step 4: Add i18n strings**

Cover labels, hints, copy aria-labels, and errors with `tr()`.

- [ ] **Step 5: Run tests and build**

Run:

```bash
cd web && npm test -- Edges.test.tsx
cd web && npm run build && npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Edges.tsx web/src/pages/Edges.test.tsx web/src/pages/clusters/ClusterEnrollmentModal.tsx web/src/i18n
git commit -m "feat(web): generate windows edge install commands"
```

---

## Task 7: Windows restart_service

**Files:**
- Create: `internal/edgeagent/restart_service/handlers_windows.go`
- Create: `internal/edgeagent/restart_service/policy_windows.go`
- Create: `internal/edgeagent/restart_service/handlers_windows_test.go`
- Modify: `cmd/ongrid-edge/capabilities_windows.go`
- Modify: `cmd/ongrid-edge/main.go`
- Modify: `internal/edgeagent/biz/agent.go`

**Interfaces:**
- Produces:
  - `func Register(client tunnel.Client, log *slog.Logger) error`（Windows 版本）
  - `func DefaultSandboxConfig() *SandboxConfig`（Windows 服务名 allowlist）
  - `type SandboxConfig struct { AllowedServices []string; Mocked bool }`

- [ ] **Step 1: Write failing tests**

Test:

- allowed service runs `sc.exe stop` then `sc.exe start`;
- disallowed service returns `Allowed=false` without running;
- `Mocked=true` returns success without `sc.exe`;
- service name canonicalization (`W3SVC`, `w3svc`, `W3SVC `).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/edgeagent/restart_service/...`
Expected: FAIL on Linux due to Windows build tags; cross-compile test with `GOOS=windows go test -c` after implementation.

- [ ] **Step 3: Implement Windows handler**

Use `sc.exe` through an injectable runner:

```go
type runner interface { Run(ctx context.Context, name string, args ...string) ([]byte, error) }
```

Default allowlist:

```text
W3SVC, MySQL, Redis, nginx, ongrid
```

Policy file: `C:\ProgramData\ongrid-edge\restart-policy.json`; if missing, use defaults.

- [ ] **Step 4: Register in capabilities**

```go
func registerEdgeCapabilities(client tunnel.Client, log *slog.Logger) {
    edgehostfiles.Register(...)
    restartservice.Register(...)
}
```

- [ ] **Step 5: Gate unsupported handlers on Windows**

In `cmd/ongrid-edge/main.go`, skip `operator.Register`, `webshell` stream registration, and packet-capture handlers when `runtime.GOOS == "windows"` for the Legacy variant. Add a small helper:

```go
func unsupportedOnWindows() bool { return runtime.GOOS == "windows" && !supportsWindowsParityBuild() }
```

The Modern variant may keep WebSSH/operator if validated; the Legacy variant must not advertise them.

- [ ] **Step 6: Cross-compile and run tests**

Run:

```bash
GOOS=windows GOARCH=amd64 go build ./cmd/ongrid-edge
GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./internal/edgeagent/restart_service
```

Expected: PASS.

- [ ] **Step 7: Manual VM test**

On Windows, request `host_restart_service` for an allowlisted service and verify it restarts; request a disallowed service and verify denial.

- [ ] **Step 8: Commit**

```bash
git add internal/edgeagent/restart_service cmd/ongrid-edge/capabilities_windows.go cmd/ongrid-edge/main.go internal/edgeagent/biz/agent.go
git commit -m "feat(edge): support restart_service on windows"
```

---

## Task 7.5: Windows host_files implementations

**Files:**
- Create: `internal/edgeagent/host_files/find_windows.go`
- Create: `internal/edgeagent/host_files/du_windows.go`
- Create: `internal/edgeagent/host_files/find_windows_test.go`
- Create: `internal/edgeagent/host_files/du_windows_test.go`
- Modify: `internal/edgeagent/host_files/handlers.go`
- Modify: `internal/edgeagent/host_files/sandbox.go`

**Interfaces:**
- Produces: `find_large_files` / `du_summary` on Windows without `find.exe`/`du.exe`.

- [ ] **Step 1: Write failing tests**

Create a temp directory tree with known sizes and assert:

```go
func TestFindLargeFilesWindows(t *testing.T) { ... }
func TestDuSummaryWindows(t *testing.T) { ... }
```

- [ ] **Step 2: Implement Go-native traversal**

Use `filepath.WalkDir` + `os.Stat`:

- `find_large_files`: filter regular files, compare size, sort descending, apply `top_n`;
- `du_summary`: sum sizes per immediate child directory, include total;
- skip denied paths via the existing `SandboxConfig.ValidatePath`;
- honor the existing per-path and batch timeouts.

- [ ] **Step 3: Add Windows cases to the handler switch**

Replace `default: unsupported GOOS` for Windows with the Go-native implementation. Keep `linux`/`darwin` shell-out paths unchanged.

- [ ] **Step 4: Run tests**

Run:

```bash
GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./internal/edgeagent/host_files
go test ./internal/edgeagent/host_files
```

Expected: PASS on Linux; Windows test binary compiles.

- [ ] **Step 5: Commit**

```bash
git add internal/edgeagent/host_files
git commit -m "feat(edge): implement host file diagnostics on windows"
```

---

## Task 8: Windows plugin set

**Files:**
- Create: `cmd/ongrid-edge/bootstrap_plugins_windows.go`
- Create: `cmd/ongrid-edge/bootstrap_plugins_other.go`
- Modify: `cmd/ongrid-edge/main.go`
- Modify: `internal/edgeagent/plugins/*`（仅 Windows 二进制名/能力判断）
- Test: `cmd/ongrid-edge/bootstrap_plugins_windows_test.go`

**Interfaces:**
- Produces: `func startPlugins(...)` 的 Windows 分支，只注册支持的插件。

- [ ] **Step 1: Write failing tests**

Test that the Windows plugin list contains:

```text
metrics, custommetrics, hostmetrics, logs, traces, databasemetrics
```

and excludes `autoapm`, `profiles`, `obi`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `GOOS=windows go test -c -o /dev/null ./cmd/ongrid-edge`
Expected: FAIL until the Windows branch exists.

- [ ] **Step 3: Implement Windows plugin registration**

- `hostmetrics` uses `windows_exporter.exe`;
- `logs`/`traces` use `otelcol-contrib.exe`;
- `databasemetrics` uses the DB exporter `.exe` names;
- `metrics`/`custommetrics` are in-process;
- unsupported plugins are logged as disabled and not registered.

- [ ] **Step 4: Ensure plugin binary paths use `.exe`**

Add a `binaryName(plugin, goos)` helper in `internal/edgeagent/plugins` and use it at subprocess start.

- [ ] **Step 5: Run tests and cross-build**

Run:

```bash
GOOS=windows GOARCH=amd64 go build ./cmd/ongrid-edge
GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./cmd/ongrid-edge
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cmd/ongrid-edge internal/edgeagent/plugins
git commit -m "feat(edge): register the supported windows plugin set"
```

---

## Task 9: Go 1.20 compatibility packages and min/max refactor

**Files:**
- Create: `internal/compat/slog/slog_go121.go`
- Create: `internal/compat/slog/slog_go120.go`
- Create: `internal/compat/slices/slices_go121.go`
- Create: `internal/compat/slices/slices_go120.go`
- Create: `internal/compat/maps/maps_go121.go`
- Create: `internal/compat/maps/maps_go120.go`
- Create: `internal/compat/minmax/minmax.go`
- Modify: all files using `min(` / `max(` builtins
- Test: `internal/compat/minmax/minmax_test.go`

**Interfaces:**
- Produces:
  - `compat/slog` package with the same name `slog`;
  - `compat/slices` / `compat/maps`;
  - `minmax.Min[T]`, `minmax.Max[T]`.

- [ ] **Step 1: Write failing tests for minmax**

```go
func TestMinMax(t *testing.T) {
    if Min(3, 5) != 3 { t.Fatal("min") }
    if Max(3, 5) != 5 { t.Fatal("max") }
}
```

- [ ] **Step 2: Implement compat packages**

`go1.21` files forward to stdlib; `!go1.21` files forward to `golang.org/x/exp/*`. The package name stays identical so call sites do not change.

- [ ] **Step 3: Replace min/max builtins in the main source**

Use a scripted AST rewrite or a careful `grep` + manual replacement. Examples:

```go
min(a, b) -> minmax.Min(a, b)
max(a, b) -> minmax.Max(a, b)
```

Add the import where needed. Keep the main module building with Go 1.25 after the change.

- [ ] **Step 4: Run the full test suite**

Run:

```bash
go test ./internal/compat/...
go build ./...
go test ./...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/compat $(git diff --name-only)
git commit -m "refactor: add go 1.20 compatibility packages"
```

---

## Task 10: Legacy build harness and CI

**Files:**
- Create: `tools/build-legacy-windows.sh`
- Create: `third_party/geminio/go.mod`（patched copy）
- Modify: `.github/workflows/ci.yml` or create `.github/workflows/ci-windows-legacy.yml`
- Test: `scripts/test-legacy-build.sh`

**Interfaces:**
- Produces: `build-legacy-windows.sh <out-dir>` outputs `ongrid-edge-supervisor.exe` and `ongrid-edge-worker.exe` built with Go 1.20.

- [ ] **Step 1: Write a failing build test**

```bash
#!/usr/bin/env bash
set -euo pipefail
out=$(mktemp -d)
bash tools/build-legacy-windows.sh "$out"
test -f "$out/ongrid-edge-supervisor.exe"
test -f "$out/ongrid-edge-worker.exe"
```

- [ ] **Step 2: Implement the harness**

Steps:

1. copy source to a temp dir;
2. write `go.mod` with `go 1.20` and `replace github.com/singchia/geminio => ./third_party/geminio`;
3. rewrite imports with `sed`/AST:
   - `"log/slog"` → `"github.com/ongridio/ongrid/internal/compat/slog"`
   - `"slices"` → `"github.com/ongridio/ongrid/internal/compat/slices"`
   - `"maps"` → `"github.com/ongridio/ongrid/internal/compat/maps"`
4. `GOTOOLCHAIN=go1.20.x go mod tidy`;
5. build supervisor/worker.

- [ ] **Step 3: Run the build test**

Run: `bash scripts/test-legacy-build.sh`
Expected: PASS, or a precise error identifying the first unsupported dependency.

- [ ] **Step 4: Add CI**

CI job:

```yaml
- run: GOTOOLCHAIN=go1.20.x bash tools/build-legacy-windows.sh /tmp/legacy
```

Fail the job if the output is missing.

- [ ] **Step 5: Commit**

```bash
git add tools/build-legacy-windows.sh third_party/geminio scripts/test-legacy-build.sh .github/workflows
git commit -m "build(edge): add go 1.20 legacy windows build harness"
```

---

## Task 11: Legacy packaging, docs, and release

**Files:**
- Modify: `dist/build-edge-attachments.sh`
- Modify: `dist/build-windows-manifest.sh`
- Modify: `Makefile`
- Modify: `deploy/install/edge/fetch-edge-assets.sh`
- Create: `docs/install/windows.md`
- Modify: `deploy/install/README.md`
- Modify: `docs/design/windows-edge-installation.md`（决策记录）

**Interfaces:**
- Produces: `legacy-amd64` variant in the Windows manifest and release.

- [ ] **Step 1: Generate the manifest**

`dist/build-windows-manifest.sh` walks the `modern-amd64` and `legacy-amd64` directories, computes SHA-256, and writes `manifest.json`.

- [ ] **Step 2: Add legacy artifacts**

`build-edge-attachments.sh windows` accepts `legacy-amd64` and emits two files plus sidecars, matching the modern layout:

```text
ongrid-edge-legacy-windows-amd64-<version>-supervisor.exe
ongrid-edge-legacy-windows-amd64-<version>-supervisor.exe.sha256
ongrid-edge-legacy-windows-amd64-<version>-worker.exe
ongrid-edge-legacy-windows-amd64-<version>-worker.exe.sha256
```

Do not use a zip; the manifest and installer verify each file individually.

- [ ] **Step 2b: Extend release publish/verify to Windows**

Update `verify-edge-version-release` and both file lists in `publish-edge-version-attachments` (in `Makefile`) to include the four Windows files for each variant. Decide the ordering relative to already-published tags: `scripts/publish-cnb-release-attachments.sh` refuses to add files to a partially populated immutable release, so Windows must be included before the first tagged publish that is meant to carry it.

- [ ] **Step 2c: Build and stage the installer bootstrap**

Add `make build-edge-windows-installer` using `GOTOOLCHAIN=go1.20.14` and `tools/windows-installer`, output `bin/windows-amd64/ongrid-edge-installer.exe`. Publish it as `ongrid-edge-windows-amd64-<version>-installer.exe` plus `.sha256`, and stage it at the fixed UI URL `windows/ongrid-edge-installer.exe`. Extend `fetch-edge-assets.sh` and the publish/verify file lists to include it. The manifest does not need to reference the installer.

- [ ] **Step 3: Write `docs/install/windows.md`**

Cover:

- support matrix;
- 2008 R2 prerequisites (TLS 1.2, SHA-2 patch);
- GPO/SCCM/share bootstrap;
- single-device and batch commands;
- service verification;
- restart_service policy;
- plugin availability;
- upgrade/rollback;
- uninstall;
- security disclaimer.

- [ ] **Step 4: Update the design doc Decision Log**

Record the Phase 0 result and the final variant choice.

- [ ] **Step 5: Run docs checks**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add dist docs deploy/install/README.md
git commit -m "docs(edge): document windows installation and legacy support"
```

---

## Task 12: Windows acceptance checklist

**Files:**
- Create: `docs/test/windows-edge-acceptance.md`
- Test: manual on Windows VMs

**Interfaces:**
- Produces: a repeatable acceptance checklist for each supported OS.

- [ ] **Step 1: Write the checklist**

Cover:

- install as administrator;
- non-admin install fails;
- service starts after reboot;
- device appears in UI;
- heartbeat updates;
- `get_host_load` / `get_process_list` work;
- `host_files.stat_file` works;
- `host_files.find_large_files` / `du_summary` work;
- `restart_service` allowlisted service restarts;
- disallowed service is rejected;
- bash/WebSSH/packet capture are not advertised on Legacy;
- `metrics` / `hostmetrics` / `logs` plugins start;
- plugin health appears in UI;
- upgrade stages and applies;
- rollback works when the new worker is unhealthy;
- uninstall leaves no service;
- secret is not in logs/argv;
- ACL denies a standard user write.

- [ ] **Step 2: Execute on the matrix**

| System | Variant |
| --- | --- |
| Server 2008 R2 SP1 x64 | legacy |
| Server 2012 R2 x64 | legacy (best-effort) |
| Server 2016 x64 | modern |
| Server 2019 x64 | modern |
| Server 2022 x64 | modern |

- [ ] **Step 3: Record results**

Fill the checklist with pass/fail and attach logs to the PR.

- [ ] **Step 4: Commit**

```bash
git add docs/test/windows-edge-acceptance.md
git commit -m "test(edge): add windows installation acceptance checklist"
```

---

## Decision Log

- Phase 0 result: **PENDING VM**（本地构建/测试通过：Go 1.20.14 交叉编译、`go test`、`go vet`、`go test -race`、geminio 全包 `go build ./...`；真实 2008 R2 运行待验证）
- Chosen legacy strategy: compat build（Go 1.20 兼容构建；geminio client 已用 Go 1.20.14 本地编译通过，待 VM 运行时确认）
- Go 1.20 runtime on 2008 R2: PENDING VM。本地产物 `PE32+ executable for MS Windows 6.01 (console), x86-64`，`go version -m` 报告 `go1.20.14`。
- Manager TLS 1.2 from 2008 R2: PENDING VM。
- geminio version used: `v1.3.0-rc.2` 本地补丁副本（`tools/legacy-spike/third_party/geminio`，`go 1.20`）。
- Fallback needed: no（本地未发现 Go 1.21+ 特性；VM 运行确认后再定论）。

Linux 构建命令：

```bash
cd tools/legacy-spike
GOTOOLCHAIN=go1.20.14 GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -o legacy-spike.exe .
```

Windows Server 2008 R2 SP1 x64 验证命令（详见 `tools/legacy-spike/README.md`）：

```powershell
.\legacy-spike.exe -manager https://<manager-host> -frontier <frontier-host>:<port> -timeout 10s
```

将输出中的 `runtime`、`manager`、`frontier` 三行回填到上面对应条目，并把 Phase 0 result 改为 `PASS` 或 `FAIL`。
