# Windows Edge 安装指南

本文说明如何在 Windows Server 上安装、验证、升级和卸载 Ongrid Edge。Windows 制品由 Manager 以只读静态目录 `/edge/windows/` 提供，安装器负责下载校验、enrollment、ACL、服务安装和自检。

## 1. 支持矩阵

| 变体 | 系统 | 架构 | 工具链 | 能力 |
| --- | --- | --- | --- | --- |
| Modern | Server 2016 / 2019 / 2022 / 2025 | amd64 | Go 1.25 | tunnel、注册/心跳、主机指标、host_files、restart_service、Windows 插件 |
| Legacy | Server 2008 R2 SP1 | amd64 | Go 1.20 | 同上，使用 Go 1.20 兼容构建 |
| 不承诺 | Server 2008 非 R2、x86、2012/2012 R2 | - | - | 除非在目标机单独验证 |

`--variant auto` 按系统版本选择：`10.0 build >= 14393` 使用 `modern-amd64`，`6.1 build >= 7601` 使用 `legacy-amd64`。显式传入 `--variant legacy` 可在受控环境中跳过版本检查。

## 2. 前置条件

### 2.1 通用

- 以本地管理员身份运行安装器；普通用户会直接失败。
- 目标主机可访问 Manager 的 HTTPS 端口和 `--server-edge-addr` 指定的 Frontier 地址（通常为 `443` 与 `40012`）。
- 生产制品应带 Authenticode 签名；安装器只校验每个下载文件的 SHA-256，不校验签名。
- 安装器不修改 Manager 与 Edge 之间的隧道协议，服务名固定为 `ongrid-edge`。

### 2.2 Windows Server 2008 R2 SP1

2008 R2 已结束支持，只应在隔离网络中按 Legacy 变体部署。安装前确认：

1. **TLS 1.2 已启用。** 安装器使用 Go 自带 TLS 栈下载制品，但首次获取安装器、PowerShell 下载和系统组件仍可能走 Schannel/WinHTTP。通过 GPO 或注册表启用客户端 TLS 1.2：

   ```text
   HKLM\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client
     Enabled            = 1 (DWORD)
     DisabledByDefault  = 0 (DWORD)
   ```

   如仍使用 WinHTTP 下载，可同时安装 KB3140245 并设置 `DefaultSecureProtocols`。

2. **SHA-2 代码签名补丁已安装。** 缺少 SHA-2 支持时，Windows 可能拒绝加载 SHA-2 签名的二进制，相关系统组件也可能失败：
   - KB3033929：Windows 7 / Server 2008 R2 SHA-2 代码签名支持；
   - KB4474419：SHA-2 签名支持更新。

   安装器本身只校验下载文件的 SHA-256，不做 Authenticode 签名校验；未安装补丁时，错误可能来自 Windows 加载器而不是安装器。无法安装补丁的实验环境只能使用未签名的应急包，并自行承担完整性风险。

3. **PowerShell 2.0 可用。** 2008 R2 自带 PowerShell 2.0；下文命令不使用 PowerShell 3.0+ 语法（例如用 `certutil` 代替 `Get-FileHash`，用 `Select-Object -Last` 代替 `-Tail`）。
4. **分发包来源可信。** 安装器文件从 Manager 主机或受控文件共享获取，并通过发布附件 `.sha256` 核对。

## 3. 获取安装器（GPO / SCCM / 文件共享）

2008 R2 可能无法在首次下载时完成 TLS 1.2 握手，因此推荐先分发安装器本身，再由安装器用 Go TLS 下载其余制品。

安装器固定地址：

```text
https://<manager-host>/edge/windows/ongrid-edge-installer.exe
```

也可以在 Manager 主机上直接取文件：

```text
/opt/ongrid/edge/windows/ongrid-edge-installer.exe
```

对应的版本化 Release 附件及校验文件：

```text
ongrid-edge-windows-amd64-<version>-installer.exe
ongrid-edge-windows-amd64-<version>-installer.exe.sha256
```

分发方式：

- **GPO**：把安装器放到 `\\<domain>\SYSVOL\<domain>\scripts\ongrid\`，用启动脚本或“计算机配置 → 首选项 → 控制面板设置 → 计划任务”以 SYSTEM/管理员运行安装命令。GPO 启动脚本适合批量 enrollment token 流程。
- **SCCM / MECM**：将安装器打包为 Application 或 Package，Program 使用完整命令行，检测规则检查 `ongrid-edge` 服务和 `C:\ProgramData\ongrid-edge\health.json`。
- **网络共享 / U 盘**：复制安装器到目标机 `%TEMP%` 后在本机以管理员身份运行。共享路径只承载安装器，不承载 secret。

在目标机核对文件：

```powershell
certutil -hashfile .\ongrid-edge-installer.exe SHA256
```

## 4. 安装命令

### 4.1 单设备（access key / secret key）

从 UI 的 Windows 安装命令复制，或在本机执行：

```powershell
$u='https://<host>/edge/windows/ongrid-edge-installer.exe'
$f="$env:TEMP\ongrid-edge-installer.exe"
(New-Object Net.WebClient).DownloadFile($u,$f)
& $f --manager-url https://<host> --access-key <key> --secret-key <secret> --server-edge-addr <host>:40012
```

### 4.2 批量（enrollment token）

```powershell
$u='https://<host>/edge/windows/ongrid-edge-installer.exe'
$f="$env:TEMP\ongrid-edge-installer.exe"
(New-Object Net.WebClient).DownloadFile($u,$f)
& $f --manager-url https://<host> --enrollment-token <token> --server-edge-addr <host>:40012
```

### 4.3 参数与安全注意事项

- `--enrollment-token` 与 `--access-key`/`--secret-key` 互斥；单设备模式必须同时提供 access key 和 secret key。
- `--manager-url` 必须是 `https://`；仅 loopback 地址允许 `http://`。
- `--tls-insecure` 只用于自签名测试；生产环境改用 `--tls-ca-file` 或 `--tls-server-name`。
- `--variant auto|modern|legacy` 控制制品选择；默认 `auto`。
- `--dry-run` 只校验参数，不修改主机。
- `--log-file <path>` 为预留参数；当前版本尚未写入安装器日志。
- 单设备命令会把 key 放在命令行上。批量部署优先使用 enrollment token，并限制 GPO/SCCM 任务和命令行的可见范围。
- 安装器把 secret 写入临时配置文件（受限 ACL），交给 `supervisor.exe --install --config-file` 后立即删除；明文不落长期文件。服务端 secret 使用 DPAPI 机器级加密保存为 `C:\ProgramData\ongrid-edge\secrets.enc`。

## 5. 服务验证

安装器在服务启动并写出 `health.json` 后才返回成功。手动复核：

```powershell
sc.exe query ongrid-edge
Get-Service ongrid-edge
Get-Content C:\ProgramData\ongrid-edge\health.json
Get-Content C:\ProgramData\ongrid-edge\supervisor.log | Select-Object -Last 50
Get-Content C:\ProgramData\ongrid-edge\worker-stderr.log | Select-Object -Last 50
```

预期：

- 服务状态为 `RUNNING`，启动类型为自动；
- `health.json` 每 30 秒更新一次；
- `supervisor.log` 和 `worker-*.log` 出现 `tunnel: connected` / `registered with cloud`；
- Manager UI 的设备列表出现该主机，心跳持续更新。

服务安装目录：

```text
C:\Program Files\ongrid-edge\
├── bin\              supervisor/worker
├── plugins\          插件 .exe
└── etc\
C:\ProgramData\ongrid-edge\
├── health.json
├── secrets.enc
├── supervisor.log
├── worker-stdout.log
├── worker-stderr.log
├── plugins\          插件工作目录
└── upgrade\          升级暂存目录
```

## 6. restart_service 策略

Windows 的 `restart_service.restart` 通过 `sc.exe stop/start` 重启 Windows 服务，服务名不是 systemd unit 名。服务端白名单文件：

```text
C:\ProgramData\ongrid-edge\restart-policy.json
```

格式：

```json
{
  "allowed_services": ["W3SVC", "MySQL", "Redis", "nginx", "ongrid"],
  "mocked": false
}
```

行为：

- 文件不存在时使用默认白名单：`W3SVC`、`MySQL`、`Redis`、`nginx`、`ongrid`；
- 匹配不区分大小写，允许带 `.exe` / `.service` 后缀；日志中保留配置里的原始拼写；
- `mocked=true` 只返回成功、不执行 `sc.exe`，仅用于测试；
- 文件存在但格式错误时直接报错，不会静默回退到默认值（避免重新放开被移除的服务）；
- 目录 ACL 只允许 SYSTEM 和 Administrators 写入，普通用户不能扩大白名单；
- Manager 侧还有第二道白名单校验，两边都不允许的服务不会到达 Edge。

自定义时先以管理员身份编辑该文件并重载服务：

```powershell
notepad C:\ProgramData\ongrid-edge\restart-policy.json
Restart-Service ongrid-edge
```

## 7. 插件可用性

Windows 注册以下插件，二进制位于 `C:\Program Files\ongrid-edge\plugins\`：

| 插件 | 二进制 | 版本 |
| --- | --- | --- |
| `metrics` | 进程内 | - |
| `custommetrics` | 进程内 | - |
| `hostmetrics` | `windows_exporter.exe` | 0.29.2 |
| `logs` / `traces` | `otelcol-contrib.exe` | 0.157.0 |
| `databasemetrics`（mysql） | `mysqld_exporter.exe` | 0.19.0 |
| `databasemetrics`（postgresql） | `postgres_exporter.exe` | 0.19.1 |
| `databasemetrics`（redis） | `redis_exporter.exe` | 1.86.0 |

限制：

- `autoapm`、`profiles`、`obi`、`procmetrics` 不在 Windows 注册；
- `databasemetrics` 不包含 **mongodb**：上游 `mongodb_exporter` 不发布 Windows amd64 资产。Manager 不应向 Windows Edge 下发 mongodb source；
- `windows_exporter` 固定 0.29.2，以保留 `--collectors.enabled` 约定；它不支持 `--collectors.disabled`，Windows `hostmetrics` 会拒绝 `collectors_disabled` 配置。升级到 0.30+ 前必须重新验证参数契约。

插件健康状态在 UI 的插件面板显示；如果某个插件二进制缺失或端口冲突，其余插件和 Agent 仍会运行。

## 8. 升级与回滚

### 8.1 升级

- Manager 的 Edge 升级流程把新版本暂存到 `C:\ProgramData\ongrid-edge\upgrade\`，由 supervisor 停止 worker、替换二进制并启动新 worker；应用前校验暂存目录 ACL 和文件完整性。
- 重新运行同版本或新版本的安装器是幂等的：安装器先停止现有 `ongrid-edge` 服务，替换 supervisor/worker/插件，保留已有凭证并重启服务；重复执行不会破坏服务或凭证。
- 升级前确认没有其他进程持有 `C:\Program Files\ongrid-edge\bin\*.exe`。安装器和 supervisor 会停止服务，但不会终止无关进程。
- 版本化附件名形如 `ongrid-edge-windows-amd64-<version>-*.exe`；Manager 的 `windows/manifest.json` 指向当前版本。

### 8.2 回滚

- supervisor 启动新 worker 后若 180 秒内未健康，会自动回滚到升级前的二进制；回滚失败时保留现场并记录日志。
- 手工回滚：重新运行上一版本的安装器，或从 Manager 取回上一版本附件，停止服务后替换 `bin\` 和 `plugins\`，再启动服务。
- 不要在服务运行期间直接覆盖 `.exe`；Windows 会锁定正在运行的进程。

## 9. 卸载

使用安装器：

```powershell
& .\ongrid-edge-installer.exe --uninstall
& .\ongrid-edge-installer.exe --uninstall --purge
```

- `--uninstall`：停止并删除 `ongrid-edge` 服务，删除 `secrets.enc`，保留数据、日志和已放置的二进制；
- `--uninstall --purge`：同时删除安装器放置的 `bin`、`plugins`、`etc` 和 `C:\ProgramData\ongrid-edge` 数据目录。

安装器不在本机时，可直接调用已安装的 supervisor：

```powershell
& 'C:\Program Files\ongrid-edge\bin\ongrid-edge-supervisor.exe' --uninstall
```

卸载后确认服务已移除：

```powershell
sc.exe query ongrid-edge
```

## 10. 安全声明

- **Windows Server 2008 R2 已 EOL。** 仅用于无法升级的隔离环境；限制入站访问、限制管理面来源，并尽快迁移。
- 所有制品下载都校验 SHA-256。安装器不做 Authenticode 签名校验；生产发布应使用 Authenticode 签名，并在 2008 R2 上先安装 SHA-2 补丁，否则 Windows 加载器可能拒绝运行已签名的二进制。
- 安装目录 ACL 为 SYSTEM + Administrators，禁止继承；`secrets.enc` 使用 DPAPI `CRYPTPROTECT_LOCAL_MACHINE`。
- 安装器不把 token/secret 写入日志；临时配置文件在 supervisor 返回后删除。批量部署仍应控制 enrollment token 的分发范围，并定期轮换。
- Legacy 不提供 bash、WebSSH、抓包、K8s、OBI/autoapm/profiles。不要把 Windows Edge 当作通用远程 shell 使用。
- `restart_service` 只允许白名单内的服务；Manager 和 Edge 双侧校验。不要为了排障把白名单扩大到业务关键服务集合之外。
- 防火墙只需允许出站到 Manager HTTPS 和 Frontier 地址；Edge 不要求入站监听（插件指标端口按插件配置单独评估）。
