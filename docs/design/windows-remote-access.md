# Windows Edge 远程访问：PowerShell、VNC 与 RDP

> 状态：PowerShell 只读命令、VNC 与 RDP（IronRDP + RDCleanPath）均已实现。VNC 在 Windows Server 2016（`10.0.14393`）测试 VM 验证到 RFB 握手；RDP 已用真实的 IronRDP WASM 客户端连上同一台 Windows VM（HYBRID_EX/NLA），桌面渲染成功。OnGrid 页面内的点击验收仍需登录态。
>
> 关联文档：
> - [Windows Edge 安装指南](../install/windows.md)：安装、服务、升级与安全声明。
> - [Windows Edge 安装与 Legacy 验收清单](../test/windows-edge-acceptance.md)：验收步骤与证据格式。
> - [Edge 构建、组件分发与安装布局](edge-build-and-distribution.md)：制品与目录布局。

## 1. 能力边界

| 能力 | Linux Edge | Windows Edge | 说明 |
| --- | --- | --- | --- |
| WebSSH（交互式 PTY） | 支持 | 不支持 | Windows worker 不注册 operator exec；UI 用 `supportsWebSSH` 禁用终端入口。 |
| PowerShell 只读命令 | N/A | 支持 | `powershell.exec` RPC + 只读白名单，权限 `device:shell`。 |
| VNC（noVNC） | N/A | 支持 | 浏览器 ↔ Manager WS ↔ Edge 环回转发 ↔ `127.0.0.1:5900`。 |
| RDP | N/A | 支持 | IronRDP WASM 客户端 + Manager 的 RDCleanPath 代理，经 Edge 环回转发到 `127.0.0.1:3389`。 |

Windows 不使用 bash/PTY，因此不把 Linux 的 WebSSH 栈平移到 Windows；远程交互统一走 PowerShell（命令）与 RDP/VNC（桌面）。RDP 是内置能力、无需在主机安装软件，作为首选；VNC 保留给未启用 RDP 或需要跨平台桌面共享的主机。

## 2. 端到端链路

```text
浏览器 (noVNC / PowerShell 面板)
   │  HTTPS + RBAC(device:shell)
   ▼
Manager  internal/manager/server/webshell
   │  ① POST /api/v1/devices/{id}/vnc/tickets  → 一次性 ticket（30s）
   │  ② GET  /api/v1/devices/{id}/vnc?ticket=  → WebSocket
   │  OpenStream(edgeID) + 写 "ONGRID-TARGET 127.0.0.1:5900\n"
   ▼
Frontier 隧道（stream）
   ▼
Edge  internal/edgeagent/webshell
   │  读取并消费 ONGRID-TARGET 前导行
   │  validateTarget：只允许 127.0.0.1 + 平台端口白名单
   ▼
设备本机 127.0.0.1:5900（TightVNC 等）
```

### 2.1 为什么需要 `ONGRID-TARGET` 前导行

Frontier v1.2.x 在 service→edge 桥接时丢弃 stream Meta，Manager 无法把目标端口写进 Meta 交给 Edge。SSH 路径原本用 `SSH-2.0-ongrid-port-<port>` 识别串兼容；VNC/RDP 不是 SSH 协议，因此新增一条控制行：

```text
ONGRID-TARGET 127.0.0.1:5900\n
<原始 RFB 字节流>
```

Edge 消费该行（不会转发给目标），随后把剩余字节原样送入 TCP。缺失、空值或非法目标由 `validateTarget` 拒绝，不会回落到其他端口。

### 2.2 端口白名单

| 平台 | 允许的环回端口 | 实现 |
| --- | --- | --- |
| Windows | `5900`（VNC）、`3389`（RDP） | `internal/edgeagent/webshell/ports_windows.go` |
| 其他 | 任意 1–65535 | `ports_other.go`（SSH 自定义端口需要） |

主机固定为 `127.0.0.1`，Manager 无法通过该转发访问设备所在网络的其他主机。

## 2.3 RDP：IronRDP + RDCleanPath

RDP 走的是与 VNC 不同的链路：浏览器不能直接打开 TCP，也不能在 WebSocket 上自行完成 RDP 的 TLS 协商，因此使用 IronRDP 的 WebAssembly 客户端 + RDCleanPath 代理：

```text
浏览器 (ironrdp-web WASM)
   │ WS /api/v1/devices/{id}/rdp?ticket=
   ▼
Manager RDCleanPath 代理（internal/manager/server/webshell/rdp.go）
   │ ① 读取 RDCleanPath PDU（含 X.224 连接请求）
   │ ② OpenStream + "ONGRID-TARGET 127.0.0.1:3389"
   │ ③ 转发 PCB / X.224，读取 X.224 确认
   │ ④ 与 RDP 服务器完成 TLS 握手，取得证书链
   │ ⑤ 返回 X.224 确认 + 证书链，随后转发明文 RDP 字节
   ▼
Edge webshell 转发器 → 设备 127.0.0.1:3389
```

要点：

- **凭据不经过 Manager。** 用户名/密码/域由浏览器输入，在 RDP 通道内通过 CredSSP/NLA 发往设备；Manager 只转发字节，不解析 RDP PDU。
- **TLS 终止在 Manager。** 代理代替浏览器与服务器握手（自签名证书跳过校验），把证书链回传给客户端用于 SPKI 绑定和展示；WebSocket 本身走 WSS。CredSSP 的内层 TLS 仍是浏览器与设备端到端。
- **目标不可被浏览器指定。** 代理始终拨号设备环回 `127.0.0.1:3389`，`destination` 只用于 SNI/展示。
- **票据与 VNC/Shell 隔离。** `Kind="rdp"`，30 秒一次性；同一票据同时作为 RDCleanPath 的 `proxy_auth` 由 Manager 校验。
- **浏览器要求**：Chrome/Edge 90+、Firefox 88+、Safari 15+；WASM 包约 6 MB（gzip 约 2.3 MB），按路由懒加载。

设备侧前置条件：启用远程桌面（`fDenyTSConnections=0`），账号加入 `Remote Desktop Users`；Windows Server 默认允许 2 个管理会话。环回连接不受防火墙影响，不需要为 3389 开放入站。

## 2.4 设备文件通道

RDP 剪贴板（CLIPRDR）的文件传输在 Server 2016 实测未生效，因此文件上下行改用独立的隧道文件通道：

```text
浏览器 ── HTTP ──> Manager /v1/devices/{id}/files
                       │ OpenStream(edgeID)
                       │ "ONGRID-FILE {op,name,size}\n"
                       ▼
                 Edge streamrouter（按前导行分发）
                       ▼
                 filetransfer.HandleStream
                       ▼
                 设备沙箱目录
                 Windows: C:\ProgramData\ongrid-edge\transfer
                 Linux:   /var/lib/ongrid-edge/transfer
```

- 操作：`list`、`get`、`put`；响应行 `ONGRID-FILE-RESP {json}\n`，`get` 后紧跟文件字节。
- 文件名只接受 basename，拒绝路径穿越；单文件上限 2 GiB；写入使用临时文件 + rename。
- 权限沿用 `device:shell`；上传要求 `Content-Length`，下载带 `Content-Disposition`。
- 沙箱目录是设备上的普通目录，远端用户可在资源管理器中打开；当前不自动清理，需按运维策略清理。
- 剪贴板文本仍走 RDP CLIPRDR，与文件通道互不影响。

## 3. 票据与权限

- `POST /api/v1/devices/{id}/vnc/tickets`、`POST /api/v1/devices/{id}/rdp/tickets`：仅 Windows 设备；要求 `device:shell`；返回 `{ticket, expires_at}`（30 秒、一次性、绑定 user/device/client IP）。
- `GET /api/v1/devices/{id}/vnc?ticket=…`、`GET /api/v1/devices/{id}/rdp?ticket=…`：公开路由，但只接受对应 `Kind`（`vnc`/`rdp`）的票据；Shell、VNC、RDP 票据不能互相打开。
- WebSocket 升级前校验 `Origin`（`sameOrigin`），JWT 不出现在 URL 中。
- 会话开始/结束写入结构化日志（`device_id`、`edge_id`、`user_id`，不含密码）。
- VNC 密码由 RFB 协议直接送往设备，Manager 与 Edge 不保存、不记录。

## 4. 设备侧前置条件

Windows 主机需要自行安装 VNC Server，OnGrid 不分发 VNC 软件。以 TightVNC 2.8.84 为例（Server 2016+；2008 R2 请先在目标机验证）：

```powershell
Invoke-WebRequest -UseBasicParsing `
  'https://www.tightvnc.com/download/2.8.84/tightvnc-2.8.84-gpl-setup-64bit.msi' `
  -OutFile 'C:\Windows\Temp\tightvnc.msi'

Start-Process msiexec.exe -Wait -ArgumentList @(
  '/i', 'C:\Windows\Temp\tightvnc.msi', '/quiet', '/norestart',
  'ADDLOCAL=Server',
  'SET_USEVNCAUTHENTICATION=1', 'VALUE_OF_USEVNCAUTHENTICATION=1',
  'SET_PASSWORD=1', 'VALUE_OF_PASSWORD=<8位以内密码>',
  'SET_ALLOWLOOPBACK=1', 'VALUE_OF_ALLOWLOOPBACK=1'
)
```

检查：

```powershell
Get-Service tvnserver
Get-NetTCPConnection -LocalPort 5900 -State Listen
```

预期：服务 `Running`，5900 处于 `Listen`。VNC 认证密码最长 8 个字符。

其他可选实现：UltraVNC、TigerVNC；只要监听 `127.0.0.1:5900` 并支持标准 RFB 3.x 即可。

### 4.1 网络安全

- **不要把 5900 暴露到局域网或公网。** 访问应只来自 Edge 的环回转发。
- TightVNC 默认监听 `0.0.0.0`（实测 `bind=0.0.0.0`）。环回流量不受 Windows 防火墙影响，因此可以直接阻断入站 5900，既不影响 OnGrid，也避免局域网直连：

  ```powershell
  New-NetFirewallRule -DisplayName 'Block VNC 5900 (OnGrid tunnel only)' `
    -Direction Inbound -Protocol TCP -LocalPort 5900 -Action Block
  ```

  或者在 VNC 软件中启用“仅允许本机连接 / 限制为环回”。
- VNC 认证本身是 8 字符定长 DES 挑战，强度有限；把它当作 OnGrid 权限体系之后的一层附加认证，而不是替代品。

## 5. 用户操作路径

1. 设备列表（`/devices`）或设备详情“命令”标签页中，Windows 设备显示“远程桌面”入口；离线或只读账号时禁用并给出原因。
2. 新标签页打开 `/devices/{device_id}/vnc`，页面自动申请票据并连接。
3. VNC 服务要求密码时页面弹出输入框，密码只发给设备。
4. 工具栏提供 Ctrl+Alt+Del、剪贴板、文件传输、重连、全屏和关闭。

RDP 页面（`/devices/{device_id}/rdp`）：

1. 打开后弹出登录框，输入 Windows 用户名/密码/域（域可空）。
2. 连接成功后进入桌面；工具栏提供取回/发送剪贴板、文件传输、Ctrl+Alt+Del、重连、全屏。
3. 文件传输走 CLIPRDR 剪贴板文件通道：在本地上传或拖拽文件到桌面区域，在远端资源管理器复制后可从“文件”面板下载。

Linux 设备不显示 VNC 入口：它们保留 WebSSH 终端。

## 6. PowerShell 只读命令（回顾）

- 入口：设备详情“命令”标签页 → PowerShell 面板；接口 `POST /api/v1/devices/{id}/powershell`，权限 `device:shell`。
- Edge 侧 `internal/edgeagent/powershell/policy.go` 只允许 `get-`、`test-`、`resolve-`、`select-`、`measure-`、`where-`、`sort-`、`format-`、`convertto-`、`convertfrom-`、`out-string` 等只读命令，以及 `write-output` / `write-host` / `start-sleep` 的精确匹配。
- 拒绝管道以外的串联（`;`、`&`、反引号、`$(`、`@{`、重定向、换行）、`invoke-expression`/`iex`、`start-process`、`new-object`、`add-type`、`set-executionpolicy`。
- 超时：单条命令 15 秒，整体请求 120 秒；输出上限 64 KiB。

## 7. 验证记录

在 Windows Server 2016（`10.0.14393`，QEMU/Boxes VM，Edge ID 21）上：

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| TightVNC 2.8.84 静默安装 | PASS | `msiexec exit=0`，`service=Running`，`listen5900=True`，`procs=2` |
| RFB 协议可用 | PASS | 设备本机连接 5900 读到 `RFB 003.008` |
| VNC 监听地址 | 记录 | `bind=0.0.0.0`；VM 在用户态 NAT 后，主机不可入站访问；生产需按 §4.1 阻断 5900 |
| Worker 替换并重连 | PASS | `service=Running`，`worker procs=1`，Manager 持续收到该 Edge 的 FetchForEdge |
| VNC 票据接口 | PASS（未认证） | `POST /api/v1/devices/42/vnc/tickets` → `401`（路由存在且受保护） |
| VNC WS 路由 | PASS（未认证） | 无效票据 → `401`；未注册路径 → `404` |
| 浏览器内完整会话（VNC） | PENDING | 需要登录会话后在 UI 点击“远程桌面”并截图 |
| RDP RDCleanPath 协议 | PASS | Go 集成测试：伪造 RDP 服务器完成 X.224/TLS/证书链/双向字节回显 |
| RDP 票据与路由 | PASS | 未认证 `POST /rdp/tickets` → 401；无效票据 WS → 401 |
| RDP 主机准备（VM） | PASS | `fDenyTSConnections=0`、测试账号加入 Remote Desktop Users、3389 Listen |
| 设备文件通道（Manager ↔ Edge） | PASS | Go 集成测试：上传、列表、下载、路径穿越拒绝、Content-Length 校验；边缘前导行分发测试 |
| RDP 浏览器内完整会话（协议栈） | PASS | IronRDP WASM + 本代理 + 反向桥接连真实 Windows Server 2016：`Server confirmed connection selected_protocol=HYBRID_EX`、`Connected with success`，桌面（Server Manager）正常渲染并截图 |
| RDP OnGrid 页面点击验收 | PENDING | 需要登录会话后在 UI 点击“RDP 桌面”并截图 |

## 7.1 设备文件管理

跨平台的受控文件管理器（浏览任意路径、写入配置的根目录）见[设备文件管理](device-file-manager.md)。它与 RDP 页面的“文件”面板互补：后者是固定的传输沙箱，前者面向排障和运维取数。

## 8. 后续工作

- **RDP 增强**：驱动器重定向（RDPDR）在 IronRDP 的 Web 客户端未暴露；文件传输已改为独立文件通道；音频输出可通过 `audioPlayback` 扩展接入；会话录制需要额外实现。
- **VNC 服务分发**：当前要求管理员自行安装 VNC Server；如需批量交付，可评估随 Edge 一起分发便携版（体积、签名、许可证）。
- **审计增强**：为 VNC/RDP 增加会话录屏或按键审计需要网关侧实现，当前只有开始/结束日志。
