# Windows Edge 安装与 Legacy 验收清单

> 状态：**模板，未执行**。本文件中的全部结果均为 `PENDING`；不得把“预期结果”当成已通过。Windows Server 2008 R2 SP1 x64 的 Phase 0 结果仍为 `PENDING VM`。
>
> 关联文档：
> - [Windows Edge 安装指南](../install/windows.md)：支持矩阵、2008 R2 前置条件、GPO/SCCM/共享分发、安装命令、服务验证、`restart_service` 策略、插件、升级与卸载。
> - [Windows Edge 安装与 Legacy Agent 设计](../design/windows-edge-installation.md)：变体策略、制品布局、安装器流程、Legacy 能力边界和决策记录。
> - [Phase 0 兼容性探针](../../tools/legacy-spike/README.md)：Go 1.20 运行时、Manager TLS 1.2、geminio dial 的判定方法。
>
> 本文只定义验收步骤、命令和证据格式，不重复安装指南正文。安装、分发和前置补丁以安装指南为准。

## 1. 结论记录规则

每个检查项只允许以下结果：

| 结果 | 含义 |
| --- | --- |
| `PENDING` | 尚未在目标 VM 执行。模板中的所有默认值。 |
| `PASS` | 实际输出与“预期”一致，证据已采集。 |
| `FAIL` | 实际输出与“预期”不一致；必须记录完整错误、日志和相关命令输出。 |
| `BLOCKED` | 因已知实现缺口、环境缺失或前置条件未满足而无法执行；写明依赖项，不得记为 `PASS`。 |
| `N/A` | 该检查不适用于此变体；写明原因。 |

补充规则：

- 每个 `PASS` / `FAIL` 都要有可复核的命令输出、日志片段或 UI 截图；只写“看起来正常”不算通过。
- 失败时保留现场：不要先卸载、重装或删除日志，除非该检查本身就是卸载/回滚。
- 不在仓库提交含 token、secret、cookie 或生产数据的原始日志；证据放 PR 附件或受控共享目录。
- 同一检查在多个系统上执行时，分别记录，不跨系统复用结果。

## 2. 验收范围与已知限制

### 2.1 测试矩阵

| 系统 | 变体 | 优先级 | 说明 |
| --- | --- | --- | --- |
| Windows Server 2008 R2 SP1 x64 | legacy | 必测 | Phase 0 与 Legacy 运行的唯一承诺目标。 |
| Windows Server 2012 R2 x64 | legacy | best-effort | 复用 Legacy 构建，只有在目标机实测通过后才可记录为支持。 |
| Windows Server 2016 x64 | modern | 必测 | Go 1.25 构建。 |
| Windows Server 2019 x64 | modern | 必测 | Go 1.25 构建。 |
| Windows Server 2022 x64 | modern | 必测 | Go 1.25 构建。 |

不在本轮矩阵内：Windows Server 2008 非 R2、x86、Windows 10/11 客户端、Server 2025。需要扩展支持时先补实测，不沿用本清单的结论。

### 2.2 已知实现限制

以下限制会影响本清单中的升级和回滚项。执行前先确认代码版本；如果仍未改变，对应检查只能记为 `BLOCKED` 或 `FAIL`，不能记为通过。

1. **Manager 触发的 Windows 升级包尚未接入。** 当前 Manager 的升级路径只解析 Linux bundle：
   - `internal/manager/server/edge/http.go` 的 `packageArchForEdge` 对非 `linux` 设备返回 `unsupported device OS`；
   - `internal/manager/server/edge/bundle.go` 的 `knownArch` 只接受 `linux-amd64` / `linux-arm64`；
   - `internal/manager/biz/edge/upgrade_job.go` 的 `normalizeUpgradeArch` 只接受 Linux 架构。

   因此 `POST /api/v1/edge-upgrade-jobs`、`POST /api/v1/edges/{id}/upgrade-package` 对 Windows Edge 会返回不支持，而不是执行 Windows bundle。W-15 的 Manager 路径必须如实记录这个结果；W-15b/W-15c 和 W-16 用安装器或 supervisor 本地升级机制验证 Windows 侧的实际能力。

2. **Phase 0 尚未在真实 2008 R2 上执行。** 本地已完成 Go 1.20.14 交叉编译、`go test`、`go vet`、`go test -race` 和 geminio 依赖构建，但这不能替代 VM 上的 TLS 1.2、geminio handshake 和 PE 加载验证。W-00 未通过前，2008 R2 的其他 `PASS` 不得用于宣称 Legacy 已验收。

3. **2012 R2 是 best-effort。** 即使复用 `legacy-amd64` 构建，也必须在该系统上单独执行本清单；不得用 2008 R2 或 2016 的结果替代。

4. **单设备安装命令会把 key 放在安装器命令行。** 这是安装指南 §4.2 记录的已知暴露面；W-04 的 secret 检查应使用批量 enrollment token 模式，并单独记录服务常驻进程的命令行和日志。

## 3. 通用准备

### 3.1 变量与证据目录

以下变量在目标机 elevated PowerShell 中设置。命令保持 PowerShell 2.0 兼容，避免 `Get-FileHash`、`Invoke-WebRequest`、`ConvertFrom-Json`、`Get-CimInstance`、`-Tail` 等 3.0+ 用法。

```powershell
$Mgr            = 'https://<manager-host>'
$HostEdgeAddr   = '<frontier-host>:40012'
$Token          = '<enrollment-token>'
$Installer      = "$env:TEMP\ongrid-edge-installer.exe"
$Evidence       = 'C:\edge-acceptance'
$DeviceHostname = '<target-hostname>'

New-Item -ItemType Directory -Path $Evidence -Force | Out-Null
icacls $Evidence /inheritance:r /grant:r *S-1-5-18:(OI)(CI)(F) *S-1-5-32-544:(OI)(CI)(F)
```

`$Token` 使用一次性测试 token；不要把真实生产 token 写进记录或截图。

管理工作站上的 API 检查使用以下变量（Linux/macOS 的 `curl` + `jq`，或新版 PowerShell）：

```bash
MGR='https://<manager-host>'
PAT='<personal-access-token>'
DEVICE_ID='<device-id>'
DEVICE_HOSTNAME='<target-hostname>'
EDGE_ID='<edge-id>'
VERSION='<manager/edge-version>'
```

`PAT` 需要设备读取、Edge 读取和插件读取权限；升级检查另需 `edge:*` 写权限。

### 3.2 管理员身份与系统信息

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Get-WmiObject Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture,ServicePackMajorVersion | Format-List
$PSVersionTable.PSVersion
```

预期：第一行为 `True`；系统为矩阵中的一个版本；记录 PowerShell 版本。非管理员执行 W-02 时第一行应为 `False`。

### 3.3 2008 R2 前置条件

按安装指南 §2.2 执行；本清单只保留可复核命令：

```powershell
reg query "HKLM\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client" /v Enabled
reg query "HKLM\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client" /v DisabledByDefault
Get-HotFix | Where-Object { $_.HotFixID -match 'KB3033929|KB4474419|KB3140245' } | Select-Object HotFixID,InstalledOn
```

预期记录：

- TLS 1.2 Client `Enabled=1`、`DisabledByDefault=0`；
- 至少记录 SHA-2 支持补丁和 TLS 1.2 相关补丁的实际状态；
- 缺少补丁时不要静默继续；按安装指南使用 GPO/SCCM/共享分发路径，或记录为 `BLOCKED`。

### 3.4 Phase 0 兼容性探针（W-00，仅 Legacy）

从 `tools/legacy-spike/README.md` 获取 `legacy-spike.exe`，在目标机执行：

```powershell
.\legacy-spike.exe -manager $Mgr -frontier $HostEdgeAddr -timeout 10s > "$Evidence\phase0.txt" 2>&1
Get-Content "$Evidence\phase0.txt"
```

判定：

- `runtime: go1.20.x (windows/amd64)` 为 PASS；更高版本说明构建工具链错误；
- `manager: OK ... tls=TLS 1.2` 为 Manager TLS 1.2 PASS；
- `frontier: OK` 为 geminio dial + handshake PASS；
- `FAIL` / `DIAL-ERROR` 原样记录，不得改写为通过。

Modern 系统不需要执行此项，记为 `N/A`。

### 3.5 验证安装器校验和

```powershell
certutil -hashfile $Installer SHA256
```

与 Manager 发布的 `.sha256` sidecar 或 Release 附件核对。预期一致；不一致时停止验收并记录 `FAIL`。

## 4. 检查项

### W-01 管理员安装成功

**目标**：以本地管理员运行安装器，服务启动、健康文件就绪、设备注册。

**步骤**

1. 在 elevated PowerShell 中设置 §3.1 变量。
2. 执行：

```powershell
& $Installer --manager-url $Mgr --enrollment-token $Token --server-edge-addr $HostEdgeAddr --variant auto
$LASTEXITCODE
```

3. 采集服务与健康状态：

```powershell
sc.exe query ongrid-edge
sc.exe qc ongrid-edge
Get-Content C:\ProgramData\ongrid-edge\health.json | Select-Object -Last 1
Get-Content C:\ProgramData\ongrid-edge\supervisor.log | Select-Object -Last 50
```

**预期**

- 安装器输出 `ongrid-edge-installer: installation completed`；
- `$LASTEXITCODE` 为 `0`；
- 服务 `STATE` 为 `RUNNING`，`START_TYPE` 为 `AUTO_START`；
- `health.json` 存在且 `last_heartbeat` 在最近 60 秒内；
- `supervisor.log` 出现 `tunnel: connected` 或 `registered with cloud`。

**证据**：`install-admin.txt`（安装器 stdout/stderr）、`sc-qc.txt`、`health.json`、`supervisor-tail.txt`、`certutil.txt`。

**结果**：`PENDING`

### W-02 非管理员安装被拒绝

**目标**：普通用户不能安装服务，且不会留下服务或半安装目录。

**步骤**

1. 先把安装器复制到标准用户可读的位置（elevated PowerShell）：

```powershell
Copy-Item $Installer 'C:\Users\Public\ongrid-edge-installer.exe' -Force
```

2. 使用标准用户（非 Administrators）打开一个未提升的 PowerShell：

```powershell
runas /user:<standard-user> powershell.exe
```

3. 在该窗口中设置同一组变量（使用 Public 路径）并执行安装：

```powershell
$Mgr          = 'https://<manager-host>'
$HostEdgeAddr = '<frontier-host>:40012'
$Token        = '<enrollment-token>'
$Installer    = 'C:\Users\Public\ongrid-edge-installer.exe'
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
& $Installer --manager-url $Mgr --enrollment-token $Token --server-edge-addr $HostEdgeAddr --variant auto
$LASTEXITCODE
```

4. 回到 elevated PowerShell 检查：

```powershell
sc.exe query ongrid-edge
Test-Path 'C:\Program Files\ongrid-edge\bin\ongrid-edge-supervisor.exe'
```

**预期**

- 第一行为 `False`；
- 安装器以非零退出码失败，错误包含拒绝访问或管理员权限相关文字；
- `sc.exe query ongrid-edge` 返回 `1060`（服务不存在）；
- 不存在已安装的 supervisor 二进制；
- Manager UI 不新增该主机的设备记录（如果新增，记录为 `FAIL`，说明失败发生在 enrollment 之后）。

**说明**：当前安装器没有独立的“请以管理员运行”预检，失败可能表现为 `mkdir C:\ProgramData\ongrid-edge: Access is denied.` 或 `icacls/sc.exe` 的访问拒绝。把实际错误原文记入证据；如果提示不清晰，记为 `FAIL` 并注明“失败但提示不明确”，不要自行改代码。

**证据**：`install-nonadmin.txt`、`nonadmin-whoami.txt`、`sc-query-after-nonadmin.txt`。

**结果**：`PENDING`

### W-03 ACL 拒绝普通用户写入

**目标**：安装目录、数据目录和升级暂存目录只允许 SYSTEM 与 Administrators 写入。

**步骤**

1. elevated PowerShell 查看 ACL：

```powershell
icacls 'C:\Program Files\ongrid-edge'
icacls 'C:\Program Files\ongrid-edge\bin'
icacls 'C:\ProgramData\ongrid-edge'
icacls 'C:\ProgramData\ongrid-edge\upgrade'
```

2. 以标准用户（未提升）尝试写入：

```powershell
'x' | Out-File 'C:\Program Files\ongrid-edge\bin\acl-test.txt'
'x' | Out-File 'C:\ProgramData\ongrid-edge\acl-test.txt'
Set-Content 'C:\ProgramData\ongrid-edge\restart-policy.json' '{}'
Set-Content 'C:\ProgramData\ongrid-edge\upgrade\acl-test.txt' 'x'
```

3. 回到 elevated PowerShell 确认没有测试文件：

```powershell
Get-ChildItem 'C:\Program Files\ongrid-edge\bin\acl-test.txt','C:\ProgramData\ongrid-edge\acl-test.txt','C:\ProgramData\ongrid-edge\upgrade\acl-test.txt' -ErrorAction SilentlyContinue
```

**预期**

- 访问控制项只包含 `NT AUTHORITY\SYSTEM` 和 `BUILTIN\Administrators` 的完全控制项（忽略 `Mandatory Label` 完整性标签行）；
- 不包含 `BUILTIN\Users`、`Everyone`、`Authenticated Users` 或继承项；
- 四个标准用户写入全部失败，错误为 `Access is denied` / `拒绝访问`；
- 第 3 步无输出。

**证据**：`icacls.txt`、`acl-standard-user.txt`。

**结果**：`PENDING`

### W-04 Secret 不出现在日志和常驻进程 argv

**目标**：批量安装 token 与派生 secret 不落入日志、临时配置文件或 worker/supervisor 命令行。

**步骤**

1. 使用 enrollment token 模式安装（W-01），不要使用 `--access-key`/`--secret-key`。
2. 搜索日志中的 token：

```powershell
$p = [regex]::Escape($Token)
Select-String -Path 'C:\ProgramData\ongrid-edge\*.log' -Pattern $p
```

3. 检查常驻进程命令行：

```powershell
Get-WmiObject Win32_Process | Where-Object { $_.Name -like 'ongrid-edge-*.exe' } | Select-Object ProcessId,Name,CommandLine | Format-List
```

4. 检查安装器临时配置和下载暂存是否清理：

```powershell
Get-ChildItem 'C:\ProgramData\ongrid-edge' -Filter 'install-*.json' -ErrorAction SilentlyContinue
Get-ChildItem 'C:\ProgramData\ongrid-edge' -Filter 'download-*' -ErrorAction SilentlyContinue
```

5. 用哨兵 token 做 dry-run，确认安装器不回显 token：

```powershell
$Sentinel = 'SENTINEL-TOKEN-DO-NOT-LOG'
& $Installer --manager-url $Mgr --enrollment-token $Sentinel --dry-run > "$Evidence\dryrun.out" 2> "$Evidence\dryrun.err"
Select-String -Path "$Evidence\dryrun.out","$Evidence\dryrun.err" -Pattern ([regex]::Escape($Sentinel))
```

6. 确认 secret 文件存在且不是明文 JSON：

```powershell
Get-Item 'C:\ProgramData\ongrid-edge\secrets.enc' | Select-Object Length,LastWriteTime
Select-String -Path 'C:\ProgramData\ongrid-edge\secrets.enc' -Pattern 'secret_key|access_key' -ErrorAction SilentlyContinue
```

**预期**

- 第 2 步无输出；
- 第 3 步中 worker/supervisor 的 `CommandLine` 只有可执行文件路径，没有 `--config-file`、token 或 secret；
- 第 4 步无输出；
- 第 5 步无输出，dry-run 只输出配置有效提示；
- 第 6 步 `secrets.enc` 存在且长度大于 0，文本搜索无 `secret_key` / `access_key` 明文。

**说明**：单设备模式按设计会把 key 放在安装器命令行（安装指南 §4.3），本项不把该模式作为 secret 的通过依据。服务运行期的 secret 应由 DPAPI 加密文件提供，不能出现在 argv。

**证据**：`secret-log-scan.txt`、`process-argv.txt`、`temp-leftovers.txt`、`dryrun.out`、`dryrun.err`。

**结果**：`PENDING`

### W-05 重启后服务自动启动

**目标**：服务启动类型为自动，重启后无需人工介入即可运行并恢复心跳。

**步骤**

1. 重启前记录：

```powershell
sc.exe qc ongrid-edge
Get-Content C:\ProgramData\ongrid-edge\health.json | Select-Object -Last 1
```

2. 重启：

```powershell
Restart-Computer -Force
```

3. 重新登录后执行：

```powershell
sc.exe query ongrid-edge
Get-Content C:\ProgramData\ongrid-edge\health.json | Select-Object -Last 1
Get-Content C:\ProgramData\ongrid-edge\supervisor.log | Select-Object -Last 50
Get-Content C:\ProgramData\ongrid-edge\worker-stderr.log | Select-Object -Last 50
```

**预期**

- `STATE` 为 `RUNNING`，`START_TYPE` 为 `AUTO_START`；
- `health.json` 的 `last_heartbeat` 在重启后 60 秒内；
- 日志出现 `worker started`、`tunnel: connected` / `registered with cloud`；
- 设备在 UI 恢复在线。

**证据**：`service-before-reboot.txt`、`service-after-reboot.txt`、`health-after-reboot.json`、`supervisor-after-reboot.txt`。

**结果**：`PENDING`

### W-06 设备出现在 UI 且心跳持续更新

**目标**：Manager 设备列表出现目标主机，`last_seen_at` 持续前进。

**步骤**

1. UI：打开 Manager 的“设备”页，按主机名找到目标设备；确认在线状态、Edge 版本和最近在线时间。
2. 管理工作站 API 采集两次，间隔至少 60 秒：

```bash
curl -fsS -H "Authorization: Bearer $PAT" \
  "$MGR/api/v1/devices?hostname=$DEVICE_HOSTNAME" > heartbeat-1.json
sleep 65
curl -fsS -H "Authorization: Bearer $PAT" \
  "$MGR/api/v1/devices?hostname=$DEVICE_HOSTNAME" > heartbeat-2.json
jq '.items[] | {id,hostname,online,current_edge_id,last_seen_at}' heartbeat-1.json heartbeat-2.json
```

**预期**

- `online` 为 `true`；
- `current_edge_id` 非空，且与 `GET /api/v1/edges` 中的 Edge 对应；
- 第二次的 `last_seen_at` 晚于第一次；
- UI 中刷新后最近在线时间更新。

**说明**：2008 R2 的 PowerShell 2.0 没有可靠的 JSON 解析，API 心跳检查统一在管理工作站执行。目标机侧用 `Get-Item health.json | Select-Object LastWriteTime` 作为本地心跳证据。

**证据**：`heartbeat-1.json`、`heartbeat-2.json`、`ui-device.png`、`health-mtime.txt`。

**结果**：`PENDING`

### W-07 `get_host_load` / `get_process_list` 工作

**目标**：Manager 的主机负载和进程查询能通过 tunnel 到达 Windows Edge 并返回真实数据。

**步骤**

1. 在 Manager AI 对话中对目标设备调用：

```text
对 device_id=<DEVICE_ID> 调用 get_host_load（device_ids=[<DEVICE_ID>]），返回 CPU、内存、磁盘和 load。
```

2. 再调用进程列表：

```text
对 device_id=<DEVICE_ID> 调用 get_host_processes（device_ids=[<DEVICE_ID>]，top_n=10，sort_by=mem）。
```

3. 管理工作站直接复核进程接口：

```bash
curl -fsS -H "Authorization: Bearer $PAT" \
  "$MGR/api/v1/edges/$EDGE_ID/processes?top_n=10&sort_by=mem" > processes.json
jq '{sampled_at, count:(.items|length), first:.items[0]}' processes.json
```

**预期**

- `get_host_load` 返回有效的 CPU/内存/磁盘字段（数值可以为 0，但字段必须存在且类型正确），并带采样时间；
- `get_host_processes` 返回至少一条进程，字段包含 PID、名称、CPU/内存百分比；
- `processes.json` 的 `sampled_at` 在最近 60 秒内，`items` 非空。

**说明**：Manager 工具名是 `get_host_load` / `get_host_processes`，Edge 侧对应 wire 方法是 `get_host_load` / `get_process_list`。安装器默认 `collector_mode=off`，按需 RPC 仍通过 gopsutil 采样，不依赖周期性 push。

**证据**：`host-load.json`、`processes.json`、`ui-host-load.png`。

**结果**：`PENDING`

### W-08 `host_files.stat_file` 工作

**目标**：只读文件元数据查询在 Windows 上返回大小、时间和所有者。

**步骤**

1. 在目标机创建一个已知大小的测试文件：

```powershell
$Root = 'C:\Users\Public\ongrid-acceptance'
New-Item -ItemType Directory -Path $Root -Force | Out-Null
fsutil file createnew "$Root\stat-target.bin" 4096
```

2. 在 Manager AI 对话中调用：

```text
对 device_id=<DEVICE_ID> 调用 host_stat_file，paths=["C:\Users\Public\ongrid-acceptance\stat-target.bin"]。
```

通过 MCP/JSON 直接调用时，反斜杠按 JSON 规则转义；自然语言对话不需要双重转义。

**预期**

- 返回该文件的 `size_bytes=4096`；
- 返回 `mtime`、类型（`file`）和权限/属性；
- `owner` / `group` 在当前 Windows 实现中按设计为空（ACL/SID 解析尚未接入），不能把空值判为失败；
- 不返回 denied 错误。

**证据**：`host-stat-file.json`、`fsutil-stat-target.txt`。

**结果**：`PENDING`

### W-09 `host_files.find_large_files` / `du_summary` 工作

**目标**：Windows 上不依赖 `find.exe` / `du.exe` 的 Go 原生遍历返回正确的文件和目录大小。

**步骤**

1. 在目标机构造固定大小的目录树：

```powershell
$Root = 'C:\Users\Public\ongrid-acceptance'
New-Item -ItemType Directory -Path "$Root\a" -Force | Out-Null
New-Item -ItemType Directory -Path "$Root\b" -Force | Out-Null
fsutil file createnew "$Root\a\small.bin" 1048576
fsutil file createnew "$Root\a\large.bin" 10485760
fsutil file createnew "$Root\b\medium.bin" 5242880
Get-ChildItem $Root -Recurse | Where-Object { -not $_.PSIsContainer } | Select-Object FullName,Length
```

2. 在 Manager AI 对话中调用大文件查询：

```text
对 device_id=<DEVICE_ID> 调用 host_find_large_files，paths=["C:\Users\Public\ongrid-acceptance"]，top_n=10，min_size_bytes=1048576。
```

3. 调用目录汇总：

```text
对 device_id=<DEVICE_ID> 调用 host_du_summary，paths=["C:\Users\Public\ongrid-acceptance"]，depth=1。
```

**预期**

- `find_large_files` 按大小降序返回：
  - `large.bin` 10485760 字节；
  - `medium.bin` 5242880 字节；
  - `small.bin` 1048576 字节；
- `du_summary` 中 `a` 约 11534336 字节（11 MiB），`b` 为 5242880 字节（5 MiB），总计约 16777216 字节（16 MiB）；
- 不出现 denied 路径错误，也不因缺少 `find.exe` / `du.exe` 失败。

**证据**：`find-large-files.json`、`du-summary.json`、`fsutil-tree.txt`。

**结果**：`PENDING`

### W-10 白名单内的 `restart_service` 能重启服务

**目标**：Windows Edge 通过 `sc.exe stop` / `start` 重启白名单内服务，并返回成功。

**前置条件**

- 目标机存在一个 Manager 和 Edge 两侧都允许的真实 Windows 服务。推荐安装 IIS 并使用 `W3SVC`；也可以在测试环境安装 `nginx`、`Redis` 或 `MySQL` 之一。
- 不要为了验收创建无法正常响应 SCM 的伪服务；如果矩阵环境没有任何双方白名单服务，将本项记为 `BLOCKED` 并注明缺少的服务。

**步骤**

1. 在同一个 elevated PowerShell 会话中确认服务存在且正在运行（后续步骤要复用 `$before`）：

```powershell
sc.exe query W3SVC
$before = (Get-WmiObject Win32_Service -Filter "Name='W3SVC'").ProcessId
$before
```

2. 在 Manager AI 对话中调用：

```text
对 device_id=<DEVICE_ID> 调用 host_restart_service，service="W3SVC"，reason="Windows acceptance restart test"。
```

3. 复核：

```powershell
Start-Sleep -Seconds 5
sc.exe query W3SVC
$after = (Get-WmiObject Win32_Service -Filter "Name='W3SVC'").ProcessId
"before=$before after=$after"
Get-Content C:\ProgramData\ongrid-edge\supervisor.log | Select-Object -Last 50
```

**预期**

- 工具返回 `restarted=true`、`mocked=false`；
- 服务状态恢复为 `RUNNING`；
- `before` 与 `after` 不同，或日志明确记录 stop/start 序列；
- 若 Manager reviewer 按策略要求确认，完成确认后执行；拒绝时记录 reviewer 原因，不重试。

**证据**：`restart-allowed.json`、`sc-w3svc-before.txt`、`sc-w3svc-after.txt`、`restart-supervisor-tail.txt`。

**结果**：`PENDING`

### W-11 白名单外的 `restart_service` 被拒绝

**目标**：非白名单服务不会被执行；同时验证 Manager 第一道限制和 Edge 第二道限制。

**步骤**

1. 记录一个会被 Edge 拒绝的服务的状态（`prometheus` 是 Manager 允许、Windows Edge 默认不允许的名字；即使本机没有该服务，也应先被 Edge 白名单拒绝）：

```powershell
sc.exe query prometheus
```

2. 在 Manager AI 对话中调用：

```text
对 device_id=<DEVICE_ID> 调用 host_restart_service，service="prometheus"，reason="negative acceptance test"。
```

3. 再验证 Manager schema 直接拒绝一个不在 Manager 白名单的名字：

```text
对 device_id=<DEVICE_ID> 调用 host_restart_service，service="Spooler"，reason="manager deny test"。
```

**预期**

- 第 2 步返回拒绝，错误提到 Windows Edge 的 allow-list，或明确 `service "prometheus"` 不允许；没有 `sc.exe stop/start` 日志；
- 第 3 步在 Manager 工具校验阶段被拒绝，不会下发到 Edge；
- 两个请求都不改变任何服务状态。

**证据**：`restart-denied-edge.json`、`restart-denied-manager.json`。

**结果**：`PENDING`

### W-12 Legacy 不提供 bash / WebSSH / 抓包

**目标**：Legacy（以及当前 Windows 构建）不注册 Linux 主机工具，Manager/UI 不把它们当作可用能力。

**步骤**

1. 在目标机检查日志：

```powershell
Select-String -Path 'C:\ProgramData\ongrid-edge\supervisor.log','C:\ProgramData\ongrid-edge\worker-stdout.log','C:\ProgramData\ongrid-edge\worker-stderr.log' -Pattern 'operator/WebSSH handlers disabled|bash: sandbox ready|capture_pcap' -ErrorAction SilentlyContinue
```

2. 在 Manager AI 对话中尝试 `host_bash`：

```text
对 device_id=<DEVICE_ID> 调用 host_bash，执行 "whoami"。
```

3. 在 UI 中确认目标设备没有可用的终端 / WebSSH 入口；如果有入口，尝试连接并记录结果。
4. 在 Manager 侧对目标设备发起抓包；如果 UI 没有入口，记录 Manager 返回的不支持错误。

**预期**

- 日志出现 `operator/WebSSH handlers disabled: host toolset unavailable on this platform`；
- 不出现 `bash: sandbox ready`；
- `host_bash` 返回 `no such rpc: bash.exec` 或同等的“未注册”错误，不返回命令输出；如果 Manager 要求审批，批准后仍应得到未注册错误，拒绝时记录 reviewer 原因；
- WebSSH 没有可用入口，或连接被明确拒绝；
- 抓包返回 unavailable / unsupported，不生成抓包文件。

**证据**：`capabilities.txt`、`bash-denied.json`、`ui-no-terminal.png`、`pcap-denied.json`。

**结果**：`PENDING`

### W-13 `metrics` / `hostmetrics` / `logs` 插件启动

**目标**：Windows 插件集中的三个关键插件能启动并进入运行状态。

**前置条件**

- `C:\Program Files\ongrid-edge\plugins\` 中存在 `windows_exporter.exe` 和 `otelcol-contrib.exe`；
- Manager 已下发或 UI 已启用 `metrics`、`hostmetrics`、`logs` 配置。

**步骤**

1. 确认插件二进制：

```powershell
Get-ChildItem 'C:\Program Files\ongrid-edge\plugins' | Select-Object Name,Length
```

2. 打开 Manager 设备详情 → 插件，启用 `metrics`、`hostmetrics`、`logs`，使用 UI 默认配置（如有提示）。
3. 等待至少 60 秒后采集插件健康：

```bash
curl -fsS -H "Authorization: Bearer $PAT" \
  "$MGR/api/v1/devices/$DEVICE_ID/plugins" > plugins.json
jq '.items[] | select(.plugin_name=="metrics" or .plugin_name=="hostmetrics" or .plugin_name=="logs") | {plugin_name,enabled,health}' plugins.json
```

4. 目标机侧确认子进程：

```powershell
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'windows_exporter.exe' -or $_.Name -eq 'otelcol-contrib.exe' } | Select-Object ProcessId,Name,CommandLine | Format-List
```

**预期**

- 二进制存在且大小非零；
- `metrics` 的 `health.state` 为 `running`（进程内插件，PID 可以为 0）；
- `hostmetrics` 的 `health.state` 为 `running`，PID 非 0，对应 `windows_exporter.exe`；
- `logs` 的 `health.state` 为 `running`，PID 非 0，对应 `otelcol-contrib.exe`；
- 没有 `crashed` 或持续增长的 `restart_count`。

**说明**：`hostmetrics` 使用 `windows_exporter`，不是 Linux 的 `node_exporter`。Windows 侧 `collectors_disabled` 会被拒绝，启用时使用 `collectors_enabled` 或 `extra_args`；详见安装指南 §7 和设计文档 §7.4.1。

**证据**：`plugins-binaries.txt`、`plugins.json`、`plugin-processes.txt`、`ui-plugins-running.png`。

**结果**：`PENDING`

### W-14 插件健康状态在 UI 显示

**目标**：UI 插件面板展示运行时状态，而不是只显示静态 enabled/disabled。

**步骤**

1. 打开 Manager 设备详情 → 插件。
2. 对照 W-13 的 `plugins.json`，检查 `metrics`、`hostmetrics`、`logs` 的状态、PID、启动时间和最后错误。
3. 人为制造一个可恢复的插件失败（例如临时停止 `windows_exporter.exe`），等待一个心跳周期，确认 UI 显示 `crashed` / 重启计数，而不是静默空白。

```powershell
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'windows_exporter.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 90
```

4. 再次采集 `plugins.json`，确认 supervisor 已重启插件或 UI 显示明确失败原因。

**预期**

- UI 的状态与 API `health.state` 一致；
- 插件失败时 UI 显示 `crashed`、`last_error` 或重启计数；
- 其他插件和 Agent 不受单个插件失败影响；
- 恢复后状态回到 `running`。

**证据**：`ui-plugins-running.png`、`plugins-before-crash.json`、`plugins-after-crash.json`、`ui-plugins-crashed.png`。

**结果**：`PENDING`

### W-15 升级暂存并应用

**目标**：Windows Edge 的升级产物能被暂存、应用并恢复健康。

当前有两条路径，必须分别记录：

#### W-15a Manager 升级任务（当前预期 BLOCKED）

```bash
curl -sS -X POST -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -d "{\"edge_ids\":[$EDGE_ID],\"target_version\":\"$VERSION\",\"force_reinstall\":true}" \
  "$MGR/api/v1/edge-upgrade-jobs" > upgrade-job.json
jq '.' upgrade-job.json
```

**预期（当前代码）**：任务被拒绝或 item 被标记为 skipped/failed，错误为 `only linux-amd64 and linux-arm64 are supported`、`unsupported device OS "windows"` 或同义文本。记录 `BLOCKED`，并在备注中引用 §2.2 的实现缺口；不要把它记为 `PASS`。

如果后续实现了 Windows bundle 解析，则预期改为：

- `job.status` 最终为 `succeeded`；
- item 的 `observed_version` 等于 target；
- 目标机 `C:\ProgramData\ongrid-edge\upgrade\last_upgrade_ver` 与 `healthy_marker` 一致；
- 服务仍为 `RUNNING`，设备重新在线。

#### W-15b 安装器重跑（需验证凭证复用行为）

**目标**：重复运行安装器能替换二进制、恢复服务，并记录 enrollment token 在重装时的实际行为。

**步骤**

1. 记录升级前版本、设备 ID、Edge ID 和二进制哈希：

```powershell
Get-Content C:\ProgramData\ongrid-edge\health.json | Select-Object -Last 1
certutil -hashfile 'C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe' SHA256
```

```bash
curl -fsS -H "Authorization: Bearer $PAT" "$MGR/api/v1/devices?hostname=$DEVICE_HOSTNAME" > before-upgrade-devices.json
jq '.items[] | {id,current_edge_id,last_seen_at}' before-upgrade-devices.json
```

2. 重新运行安装器（同版本或 Manager 已暂存的新版本）：

```powershell
& $Installer --manager-url $Mgr --enrollment-token $Token --server-edge-addr $HostEdgeAddr --variant auto
$LASTEXITCODE
```

3. 复核服务与设备：

```powershell
sc.exe query ongrid-edge
Get-Content C:\ProgramData\ongrid-edge\health.json | Select-Object -Last 1
Get-Content C:\ProgramData\ongrid-edge\supervisor.log | Select-Object -Last 50
```

```bash
curl -fsS -H "Authorization: Bearer $PAT" "$MGR/api/v1/devices?hostname=$DEVICE_HOSTNAME" > after-upgrade-devices.json
jq '.items[] | {id,current_edge_id,last_seen_at}' after-upgrade-devices.json
```

**预期与判定**

- 安装器退出码为 `0`，服务恢复 `RUNNING`，设备重新在线：安装器路径成立；
- 主机 Device ID 通常由硬件 fingerprint 保持；Edge ID 可能因新的 enrollment 而变化，按实际记录，不预设不变；
- 如果复用已经完成注册的 enrollment token 时 Manager 返回 `host already completed this enrollment` / `409`，或安装器无法取得新凭证，如实记为 `FAIL`（与安装指南 §8.1 “重跑幂等、保留凭证”的描述不一致），改用新的 enrollment profile 或在具备条件时用单设备 key 模式重试；
- 二进制哈希按版本预期变化（同版本重装可不变）；
- 日志显示服务停止、替换和重启。

**说明**：当前 install 流程总会重新解析凭证；Manager 的 enrollment `Claim` 对同一 profile + 同一 host fingerprint 在已完成后会返回冲突。因此重装是否能“保留凭证”取决于所用凭据模式和 Manager 状态，必须实测记录，不能仅凭文档假设。

**证据**：`upgrade-installer-before.txt`、`before-upgrade-devices.json`、`upgrade-installer.out`、`upgrade-installer-after.txt`、`after-upgrade-devices.json`、`health-after-upgrade.json`。

#### W-15c Supervisor 本地暂存/应用（可选，验证运行时升级机制）

> 仅在隔离测试 VM 上执行。该步骤手工构造 `upgrade/incoming`，用于验证 supervisor 的 manifest 校验、备份、原子替换和健康确认；它不能替代生产发布流程。

**步骤**

1. 取得当前 Edge 版本（`agent_version`）：

```bash
curl -fsS -H "Authorization: Bearer $PAT" "$MGR/api/v1/edges/$EDGE_ID" | jq -r '.agent_version'
```

2. 在目标机构造一个“同版本真实 worker”的暂存包。把 `$AgentVersion` 替换为第 1 步输出的实际版本号；如果 `agent_version` 为空，本项记为 `BLOCKED`（无法构造与 `healthy_marker` 匹配的 `VERSION`），不要用任意字符串代替。

```powershell
$Stage        = 'C:\ProgramData\ongrid-edge\upgrade'
$Incoming     = "$Stage\incoming"
$AgentVersion = '<agent_version>'
Remove-Item $Incoming -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Incoming -Force | Out-Null
Copy-Item 'C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe' "$Incoming\ongrid-edge-worker.exe"
$sha = (certutil -hashfile "$Incoming\ongrid-edge-worker.exe" SHA256)[1].Replace(' ','').ToLower()
$line = "$sha 0755 ongrid-edge-worker.exe C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe"
[System.IO.File]::WriteAllText("$Incoming\MANIFEST.txt", $line + "`r`n", [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText("$Incoming\VERSION", $AgentVersion + "`r`n", [System.Text.Encoding]::ASCII)
```

3. 停止并启动服务，让 BootCheck 消费 pending：

```powershell
sc.exe stop ongrid-edge
sc.exe start ongrid-edge
Start-Sleep -Seconds 10
Get-Content "$Stage\last_upgrade_ver" | Select-Object -Last 1
Get-Content "$Stage\healthy_marker" | Select-Object -Last 1
Select-String -Path 'C:\ProgramData\ongrid-edge\supervisor.log' -Pattern 'upgrade: (bundle applied|confirmed healthy|rolled back files)'
```

如果 10 秒后 `last_upgrade_ver` / `healthy_marker` 尚未出现，先等待到新 worker 完成注册，再重复读取；不要把启动时序当成失败。

**预期**

- 日志出现 `upgrade: bundle applied`；
- `last_upgrade_ver` 与 `healthy_marker` 内容一致（均为 `<agent_version>`）；
- 日志出现 `upgrade: confirmed healthy`；
- `C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe.previous` 在健康确认后被清理；
- 服务 `RUNNING`，设备在线。

**证据**：`upgrade-local-before.txt`、`upgrade-local.out`、`upgrade-local-after.txt`。

**结果**：`PENDING`（W-15a 预期 `BLOCKED`，W-15b/W-15c 按实际结果记录）

### W-16 新 worker 不健康时回滚

**目标**：新 worker 未在 180 秒窗口内完成健康确认时，supervisor 恢复升级前的二进制并继续运行。

> 破坏性测试，仅在一次性测试 VM 上执行。该步骤手工构造一个“坏 worker”暂存包，验证 supervisor 的回滚路径；执行前备份当前二进制和 secret。

**步骤**

1. 记录当前 worker 哈希并备份 secret：

```powershell
$Stage = 'C:\ProgramData\ongrid-edge\upgrade'
$Incoming = "$Stage\incoming"
certutil -hashfile 'C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe' SHA256 > "$Evidence\rollback-worker-before.txt"
Copy-Item 'C:\ProgramData\ongrid-edge\secrets.enc' 'C:\ProgramData\ongrid-edge\secrets.enc.acceptance-bak' -Force
```

2. 构造坏 worker：复制一个立即退出、不会注册的 Windows 程序作为 worker，例如 `timeout.exe`：

```powershell
Remove-Item $Incoming -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Incoming -Force | Out-Null
Copy-Item 'C:\Windows\System32\timeout.exe' "$Incoming\ongrid-edge-worker.exe"
$sha = (certutil -hashfile "$Incoming\ongrid-edge-worker.exe" SHA256)[1].Replace(' ','').ToLower()
$line = "$sha 0755 ongrid-edge-worker.exe C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe"
[System.IO.File]::WriteAllText("$Incoming\MANIFEST.txt", $line + "`r`n", [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText("$Incoming\VERSION", 'rollback-acceptance' + "`r`n", [System.Text.Encoding]::ASCII)
```

3. 重启服务触发应用，然后等待超过 180 秒：

```powershell
sc.exe stop ongrid-edge
sc.exe start ongrid-edge
Start-Sleep -Seconds 210
Get-Content "$Stage\last_upgrade_ver" | Select-Object -Last 1
Test-Path "$Stage\rollback.done"
Select-String -Path 'C:\ProgramData\ongrid-edge\supervisor.log' -Pattern 'upgrade: (bundle applied|rolled back files|rollback failed|confirmed healthy)'
```

4. 确认回滚恢复旧 worker 并继续服务：

```powershell
certutil -hashfile 'C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe' SHA256 > "$Evidence\rollback-worker-after.txt"
sc.exe query ongrid-edge
Get-Content C:\ProgramData\ongrid-edge\health.json | Select-Object -Last 1
```

**预期**

- 日志出现 `upgrade: bundle applied`，随后出现 `upgrade: rolled back files`；
- `rollback.done` 存在；
- `rollback-worker-after.txt` 的哈希与 `rollback-worker-before.txt` 一致；
- 没有 `upgrade: confirmed healthy`；
- 服务恢复 `RUNNING`，真实 worker 重新注册，设备在线；
- `secrets.enc` 未被破坏（需要时从备份恢复并重启服务）。

**清理**（在记录证据后执行）：

```powershell
sc.exe stop ongrid-edge
Remove-Item "$Stage\last_upgrade_ver","$Stage\last_upgrade_at","$Stage\healthy_marker","$Stage\rollback.done" -Force -ErrorAction SilentlyContinue
Remove-Item "$Stage\incoming" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\ProgramData\ongrid-edge\secrets.enc.acceptance-bak' -Force -ErrorAction SilentlyContinue
sc.exe start ongrid-edge
```

清理后确认服务 `RUNNING`、设备在线；建议再运行一次安装器恢复干净状态。

**证据**：`rollback-worker-before.txt`、`rollback-worker-after.txt`、`rollback-supervisor.txt`、`rollback-health.json`、`rollback-service.txt`。

**结果**：`PENDING`

### W-17 卸载后不残留服务

**目标**：`--uninstall` 删除服务，`--purge` 删除安装器放置的目录；普通卸载保留数据/日志。

**步骤**

1. 普通卸载：

```powershell
& $Installer --uninstall
$LASTEXITCODE
sc.exe query ongrid-edge
Get-Service ongrid-edge -ErrorAction SilentlyContinue
Test-Path 'C:\ProgramData\ongrid-edge\secrets.enc'
Test-Path 'C:\Program Files\ongrid-edge\bin\ongrid-edge-supervisor.exe'
```

   如果安装器文件已删除，可改用已安装的 supervisor：`& 'C:\Program Files\ongrid-edge\bin\ongrid-edge-supervisor.exe' --uninstall`。

2. 如果需要验证 `--purge`，重新安装后执行：

```powershell
& $Installer --uninstall --purge
$LASTEXITCODE
Test-Path 'C:\Program Files\ongrid-edge'
Test-Path 'C:\ProgramData\ongrid-edge'
```

**预期**

- 普通卸载退出码为 `0`；
- `sc.exe query ongrid-edge` 返回 `1060`；
- `Get-Service ongrid-edge` 报服务不存在；
- `secrets.enc` 删除；
- 普通卸载保留 `bin` / `plugins` / 数据目录和日志；
- `--purge` 后安装目录和数据目录均不存在。

**证据**：`uninstall.out`、`uninstall-sc-query.txt`、`uninstall-paths.txt`、`purge-paths.txt`。

**结果**：`PENDING`

## 5. 结果汇总

执行后填写。默认全部为 `PENDING`；`BLOCKED` 必须写依赖项，`FAIL` 必须附错误证据。

| 检查 | 2008 R2 SP1 (legacy) | 2012 R2 (legacy, best-effort) | 2016 (modern) | 2019 (modern) | 2022 (modern) | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| W-00 Phase 0 探针 | PENDING | PENDING | N/A | N/A | N/A | Go 1.20 / TLS 1.2 / geminio |
| W-01 管理员安装 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-02 非管理员安装失败 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-03 ACL 拒绝普通用户写入 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-04 secret 不在日志/argv | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-05 重启后服务启动 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-06 设备 UI + 心跳 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-07 get_host_load / processes | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-08 host_files.stat_file | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-09 find_large_files / du_summary | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-10 白名单 restart_service | PENDING | PENDING | PENDING | PENDING | PENDING | 需要 W3SVC 或等价服务 |
| W-11 白名单外拒绝 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-12 Legacy 无 bash/WebSSH/抓包 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-13 metrics/hostmetrics/logs 启动 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-14 插件健康显示 | PENDING | PENDING | PENDING | PENDING | PENDING | |
| W-15 升级暂存并应用 | PENDING | PENDING | PENDING | PENDING | PENDING | W-15a 预期 BLOCKED；W-15b 记录 enrollment 行为 |
| W-16 不健康 worker 回滚 | PENDING | PENDING | PENDING | PENDING | PENDING | 破坏性，仅一次性 VM |
| W-17 卸载无残留服务 | PENDING | PENDING | PENDING | PENDING | PENDING | |

## 6. 证据记录

证据命名建议放在 `windows-edge-acceptance-<date>/<os>-<variant>/`，作为 PR 附件或受控共享目录保存。不要把含 secret、token 或生产数据的原始日志提交到仓库。

### 6.1 Server 2008 R2 SP1 x64（legacy）

- 执行人 / 日期：`PENDING`
- 镜像 / Service Pack / 补丁：`PENDING`
- Phase 0 输出（`phase0.txt`）：`PENDING`
- 安装与权限证据：`PENDING`
- 服务重启 / 心跳证据：`PENDING`
- W-07 / W-08 / W-09 输出：`PENDING`
- W-10 / W-11 输出：`PENDING`
- W-12 能力边界证据：`PENDING`
- W-13 / W-14 插件状态：`PENDING`
- W-15 / W-16 升级与回滚：`PENDING`
- W-17 卸载：`PENDING`
- UI 截图（设备、插件、无终端入口）：`PENDING`
- 日志片段：

```text
<PENDING: supervisor.log / worker-stdout.log / worker-stderr.log 关键片段>
```

- 命令输出片段：

```text
<PENDING: sc.exe query / icacls / certutil / health.json 关键输出>
```

### 6.2 Server 2012 R2 x64（legacy, best-effort）

- 执行人 / 日期：`PENDING`
- 镜像 / 补丁：`PENDING`
- W-00 是否执行：`PENDING`（best-effort；未执行时记 N/A 并说明）
- 其余证据同 §6.1：`PENDING`
- 日志片段：

```text
<PENDING>
```

- 命令输出片段：

```text
<PENDING>
```

### 6.3 Server 2016 x64（modern）

- 执行人 / 日期：`PENDING`
- 镜像 / 补丁：`PENDING`
- 安装 / 服务 / 心跳：`PENDING`
- W-07 / W-08 / W-09：`PENDING`
- W-10 / W-11：`PENDING`
- W-13 / W-14：`PENDING`
- W-15 / W-16 / W-17：`PENDING`
- UI 截图：`PENDING`
- 日志片段：

```text
<PENDING>
```

- 命令输出片段：

```text
<PENDING>
```

### 6.4 Server 2019 x64（modern）

- 执行人 / 日期：`PENDING`
- 镜像 / 补丁：`PENDING`
- 证据与 §6.3 相同的项目：`PENDING`
- 日志片段：

```text
<PENDING>
```

- 命令输出片段：

```text
<PENDING>
```

### 6.5 Server 2022 x64（modern）

- 执行人 / 日期：`PENDING`
- 镜像 / 补丁：`PENDING`
- 证据与 §6.3 相同的项目：`PENDING`
- 日志片段：

```text
<PENDING>
```

- 命令输出片段：

```text
<PENDING>
```

## 7. 执行后的清理

- 删除测试目录 `C:\Users\Public\ongrid-acceptance`。
- 删除本次验收设置的 `restart-policy.json` 临时内容，恢复默认白名单或原有配置。
- 如果执行了 W-16，按该节的清理命令移除 `upgrade` 下的测试元数据，确认服务恢复并重新注册。
- 删除测试 token，撤销测试 PAT；确认 Manager 中没有遗留的测试设备或重复 Edge。
- 删除目标机和 PR 附件中的任何 secret 明文；只保留脱敏后的命令输出和截图。

## 8. 与安装指南的对应关系

| 本清单 | 安装指南章节 |
| --- | --- |
| W-00 Phase 0 探针 | 安装指南 §2.2；`tools/legacy-spike/README.md` |
| 前置条件 / TLS 1.2 / SHA-2 / PowerShell 2.0 | §2 前置条件 |
| 安装器分发与校验 | §3 获取安装器 |
| W-01 / W-02 | §4 安装命令 |
| W-05 / W-06 | §5 服务验证 |
| W-10 / W-11 | §6 restart_service 策略 |
| W-13 / W-14 | §7 插件可用性 |
| W-15 / W-16 | §8 升级与回滚 |
| W-17 | §9 卸载 |
| W-04 / W-03 | §10 安全声明 |

验收时如安装指南与本清单冲突，以安装指南的操作步骤为准，并在 PR 中记录冲突条款；不要用本清单的局部命令绕过安装指南的安全要求。
