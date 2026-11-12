# Edge Agent 运行时、命令策略与安装

本文汇总 Ongrid Edge 侧的运行机制与安装方式，覆盖四个问题：

- Frontier 在 Edge 接入中承担什么角色；
- `ongrid-edge` 做什么、如何接收 Manager 指令；
- Edge 能执行哪些命令，白名单在哪里扩展；
- Linux、Kubernetes、Windows 的安装差异，以及 `ongrid-edge-supervisor.exe` 的来源。

内容以当前代码为准。安装步骤的规范入口仍是 [Edge Agent 安装指南](../install/edge.md)；Kubernetes 设计见 [RFC-001](../rfc/RFC-001-kubernetes-edge-adaptation.md)。

---

## 1. Frontier 的定位

### 1.1 为什么需要 Frontier

Edge 部署在用户主机或内网，通常只允许出站连接，不能开放入站端口；而 Manager 需要主动调用 Edge（查进程、磁盘扫描、WebSSH、升级、抓包等）。Frontier 是这中间的**反向隧道 broker**：

- Edge 主动拨出，建立长连接；
- Manager 通过 Frontier 向指定 Edge 发起 RPC 或字节流；
- 不需要在每台 Edge 上做 NAT 映射或开放端口。

Frontier 来自上游开源项目 `github.com/singchia/frontier`，以独立容器 `ongrid-frontier` 部署，不是本仓库实现的业务服务。

### 1.2 拓扑与端口

配置见 [deploy/install/frontier.yaml](../../deploy/install/frontier.yaml)：

```text
Edge (ongrid-edge)
   │  出站 TCP 40012（edgebound），Meta 携带 {access_key, secret_key}
   ▼
Frontier (ongrid-frontier)
   │  40011（servicebound，仅 Docker 内网）
   ▼
Manager (frontierbound SDK)
```

| 端口 | 用途 | 是否对外 |
| --- | --- | --- |
| `40012` edgebound | Edge 拨入 | 发布到宿主机，`ONGRID_TUNNEL_PORT` 可改 |
| `40011` servicebound | Manager 拨入 | 仅容器网络 |

`edgeid_alloc_when_no_idservice_on: false` 表示 Manager 的认证回调不可用时拒绝分配匿名 Edge ID。

### 1.3 Manager 侧封装与身份映射

Manager 侧封装在 [internal/manager/service/frontierbound](../../internal/manager/service/frontierbound/doc.go)：

- Edge 拨入时，Frontier 把 Meta 交给 Manager 注册的 `GetEdgeID` 回调；
- Manager 调用 `EdgeAuthenticator.Authenticate`，得到数据库里的 canonical `Edge.ID`；
- Frontier 同时分配一个连接级的 transport ID；
- `frontierbound` 维护 `transport ↔ canonical Edge.ID` 映射；
- Manager 重启后进程内映射丢失，但 Frontier 可能保留 TCP 连接，因此 `register_edge` 会从 `req.ClientID()` 重建绑定；
- 调用时没有 transport 绑定则返回 `ErrNoTransport`，不会拿 Edge ID 冒充 transport ID。

生命周期回调：

- `EdgeOnline`：重新鉴权、绑定 transport、记录地址；
- `EdgeOffline`：解绑并把 Edge 状态持久化为 offline；
- `register_edge`：落 HostInfo、状态改为 online；
- `heartbeat`：刷新最后心跳时间。

### 1.4 故障影响

Frontier 只负责传输，不承载业务。它故障时：

- Manager 的 HTTP、数据库和 UI 仍可用；
- 所有 Edge 交互能力失效（设备在线、指标、WebSSH、AIOps 工具、升级）；
- Edge 会按 1s→60s 退避持续重连，本地插件采集和日志缓冲可继续运行。

`ONGRID_FRONTIER_DISABLED=true` 用于 e2e：Manager 可以不带 broker 启动，相关调用在调用点返回 `ErrDisabled`。

---

## 2. ongrid-edge 的定位与运行形态

`ongrid-edge` 是部署在被管主机或 Kubernetes 节点上的 Edge Agent。它不是服务端，不开放入站端口，主要承担四类工作：

1. **上行**：注册、心跳、主机指标/日志/链路等遥测上报；
2. **下行**：接收 Manager 发起的受控 RPC；
3. **本地运行时**：管理 node_exporter、process-exporter、otelcol 等插件子进程；
4. **自运维**：配置拉取、插件健康上报、自升级和回滚。

### 2.1 部署形态

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| Linux 主机 | systemd `ongrid-edge.service` | 默认以 root 运行 |
| Windows 主机 | `ongrid-edge-supervisor.exe` | Windows Service，监控 worker 子进程 |
| Kubernetes Node | DaemonSet | 每节点独立 enroll/凭证 |
| Kubernetes Controller | Deployment | 额外拥有 K8s API 权限 |
| K8s 数据面 | `ONGRID_EDGE_MODE=k8s-telemetry-gateway/metrics-scraper` | 独立数据面进程 |

### 2.2 启动主循环

入口在 [cmd/ongrid-edge/main.go](../../cmd/ongrid-edge/main.go)，主循环在 [internal/edgeagent/biz/agent.go](../../internal/edgeagent/biz/agent.go)：

```text
加载配置 → 处理待应用的升级包 → 建立 outbound tunnel
        → register_edge → 注册反向 RPC handler
        → heartbeat 循环 + metrics 推送循环 + 网络发现循环
        → 插件 supervisor
        → 等待 ctx 取消或升级请求
```

关键点：

- 使用 `internal/pkg/tunnel` 的 geminio client 拨向 `ONGRID_EDGE_CLOUD_ADDR`（默认 `127.0.0.1:40012`）；
- Meta 携带 access/secret key；
- 断线由 geminio RetryEnd 自动重连，重连后再执行一次 `register_edge`；
- 心跳默认 30 秒，指标默认 10 秒。

### 2.3 采集、插件与 Kubernetes

指标采集模式见 [cmd/ongrid-edge/bootstrap_collector.go](../../cmd/ongrid-edge/bootstrap_collector.go)：

| 模式 | 行为 |
| --- | --- |
| `off`（默认） | 不周期推送，由 Manager 侧 Prometheus 抓取插件 exporter；按需 RPC 仍走 gopsutil |
| `embedded` | 进程内 gopsutil，输出 node_exporter 兼容指标名 |
| `scrape` | 按配置抓取多个本地 `/metrics` 端点 |
| `auto` | 兼容旧行为：embedded + scrape |

插件运行时见 [internal/edgeagent/plugins](../../internal/edgeagent/plugins/plugin.go)：

| 插件 | 作用 |
| --- | --- |
| `metrics` | 进程内抓取本地 `/metrics` 并通过隧道推送 |
| `custommetrics` | 抓取运维自定义 Prometheus 端点 |
| `databasemetrics` | 启动数据库 exporter 子进程 |
| `hostmetrics` | 子进程 node_exporter |
| `procmetrics` | 子进程 process-exporter |
| `logs` | 子进程 otelcol-contrib，采集 journald/文件日志 |
| `traces` | 子进程 otelcol-contrib，接收 OTLP trace |
| `profiles` | 持续性能剖析 |
| `autoapm` | 自动发现应用并做 OBI/APM 采集 |

Supervisor 负责 Configure → Start → 健康检查 → 崩溃重启 → Stop，并每 60 秒从 Manager 拉一次配置作为兜底。

Kubernetes 角色见 [RFC-001](../rfc/RFC-001-kubernetes-edge-adaptation.md)：

- Controller：集群清单采集、增量 watch、指标推送、K8s describe/日志/动作；
- Node：每节点独立身份，复用主机采集与插件能力；
- Controller 不运行主机侧 bash/restart_service 等 handler。

### 2.4 自升级

- Manager 下发升级 URL / 安装包；
- Edge 校验 SHA256，stage 到本地目录；
- Edge 正常退出，systemd 或 Windows supervisor 在下次启动前完成替换；
- 新版本成功 `register_edge` 后写健康标记；超时未确认则回滚。

Linux 使用 `ongrid-edge-upgrade.service` + `apply-pending-upgrade.sh`；Windows 使用 `upgrademachine` 状态机（详见第 8 节）。

---

## 3. Edge 如何接收 Manager 指令

Edge 不监听入站端口。启动时通过 Frontier 建立一条出站长连接，并预先注册「方法名 → handler」表；Manager 调用 `frontierbound.Client.Call`，Frontier 按 transport ID 路由，Edge 按方法名执行。

### 3.1 建链与 handler 注册

启动顺序：

```go
a.registerHandlers()   // 先把 cloud→edge handler 注册到本地 map
a.client.Dial(ctx)     // 拨出并建立 geminio End
a.registerEdge(ctx)    // 发 register_edge，拿到 canonical Edge ID
```

Handler 签名（[internal/pkg/tunnel/types.go](../../internal/pkg/tunnel/types.go)）：

```go
type Handler func(ctx context.Context, s Session, method string, body []byte) ([]byte, error)
```

- `body` 是 JSON 请求体；
- 返回值是 JSON 响应体；
- 返回 error 会被包装成 RPC 错误回传 Manager；
- Edge 侧 `Session` 永远是零值，身份由连接本身隐含。

[Dial](../../internal/pkg/tunnel/client.go) 使用 `geminio.NewRetryEndWithDialer`：

- 首次失败按 1s→60s 指数退避；
- 连接成功后把本地已注册的 handler 全部注册到 geminio End；
- 后续断线由 RetryEnd 重连并自动重新注册。

`register_edge` 本身也是 Edge→Manager 的 RPC。重连完成后，`OnReconnect` 回调会再次执行 `register_edge`，确保新 transport 绑定到同一个 Edge ID。

### 3.2 三种指令形态

#### A. 普通请求/响应 RPC

Manager 端：

```text
HTTP handler / AIOps Tool
  → service / biz
  → frontierbound.Client.Call(ctx, edgeID, method, jsonBody)
```

[frontierbound.Call](../../internal/manager/service/frontierbound/client.go) 做三件事：

1. `edgeID` → `transportID`（没有绑定则返回 `ErrNoTransport`）；
2. `svc.NewRequest(body)`；
3. `svc.Call(ctx, transportID, method, req)`，取 `rsp.Data()` 或 `rsp.Error()`。

Edge 侧 geminio 端按 `method` 找到 handler，执行后 `rsp.SetData(out)` 或 `rsp.SetError(err)`。

示例：Manager UI 查看某设备进程：

```text
GET /v1/edges/{id}/processes
  → server/edge/http.go
  → service/edge.GetProcessList
  → fbClient.Call(ctx, edgeID, "get_process_list", {"top_n":20})
  → Frontier
  → Edge handler: collector.GetProcessList(...)
  → JSON 响应
```

#### B. 双向字节流

流不经过 handler 表，而走 `AcceptStream`：

```text
Manager: frontierbound.OpenStream(ctx, edgeID)
Edge:    tunnel.Client.AcceptStream() → StreamConn
```

Edge 主进程只启动一个 accept 循环，由 [internal/edgeagent/streamrouter](../../internal/edgeagent/streamrouter) 按 `stream.Meta()` 的 `kind` 分发：

| kind | 处理 |
| --- | --- |
| `operator_exec` | operator PTY |
| 其他/无 kind | fallback 到 WebSSH 转发器 |

WebSSH 的做法很薄：Edge 解析 Manager 在 SSH identification line 里带的目标地址，校验只能是 `127.0.0.1:<port>`，然后 `net.Dial` 本地 sshd，双向 `io.Copy`。SSH 客户端、PTY、审计都在 Manager 侧。

> Frontier 当前不转发 stream Meta，所以 WebSSH 把目标信息放在字节流开头。

#### C. Edge 主动拉取 + 通知

插件配置不是 Manager 推全文，而是：

1. Manager 修改配置后调用 `NotifyPluginConfigsChanged`；
2. 实际是一次 RPC：`Call(edgeID, "plugin_configs_changed", {})`；
3. Edge 的 reload handler 只做 `TriggerReload()`，立即返回 `{}`；
4. Supervisor 随后反向调用 `get_plugin_configs` 拉完整快照。

Supervisor 每 60 秒也会主动拉一次作为兜底；隧道不可用时回退到本地 env 配置或上次缓存。

### 3.3 Edge 侧注册了哪些指令

| 注册位置 | 方法 |
| --- | --- |
| [agent.go](../../internal/edgeagent/biz/agent.go) | `probe_network_snmp`、`get_host_load`、`get_process_list`、`packet_capture.*`、`execute_skill`、`agent_upgrade`、`fetch_package`、`apply_package` |
| [host_files/handlers.go](../../internal/edgeagent/host_files/handlers.go) | `host_files.find_large_files`、`host_files.du_summary`、`host_files.stat_file` |
| [bash/handlers.go](../../internal/edgeagent/bash/handlers.go) | `bash.exec` |
| [restart_service/handlers.go](../../internal/edgeagent/restart_service/handlers.go) | `restart_service.restart` |
| [operator/handlers.go](../../internal/edgeagent/operator/handlers.go) | `operator.exec`、`operator.exec_start` |
| [k8s/readonly.go](../../internal/edgeagent/k8s/readonly.go) | `describe_k8s_resource`、`query_k8s_logs`、`execute_k8s_action` |
| [plugins/tunnel.go](../../internal/edgeagent/plugins/tunnel.go) | `plugin_configs_changed` |
| [plugins/databasemetrics/secrets.go](../../internal/edgeagent/plugins/databasemetrics/secrets.go) | `write_database_metrics_secret` |
| [plugins/traces/receiver_handler.go](../../internal/edgeagent/plugins/traces/receiver_handler.go) | `get_application_receiver` |

没有注册的方法，geminio 返回 `no such rpc`，Manager 侧以 remote error 形式看到。

部分 handler 是条件注册的：例如 `agent_upgrade` 只在配置了 `UpgradeStageDir` 时注册；非 K8s Node 才注册主机侧 bash/restart_service/operator/WebSSH。

### 3.4 投递语义与限制

- **没有应用层自动重试**：`Call` 失败就是失败，不会在 Edge 或 tunnel 层自动重放。只有 `register_edge` / `heartbeat` 的特定错误会触发 route recycle 和重连，重连本身不重放业务请求。
- **超时由调用方控制**：Manager 的 `ctx` deadline 随 RPC 传递。上游 Frontier v1.2.4 曾固定加 30 秒截断，仓库在 [deploy/frontier-patches](../../deploy/frontier-patches/README.md) 记录了保留调用方 deadline 的补丁（尚未验收）。
- **Edge 离线时指令不会排队**：`ErrNoTransport` 直接返回。
- **请求体是 JSON 且有限额**：超大指标请求会在 tunnel 层分批；`host_files` 最多 16 个路径；各 handler 自身还有超时和输出上限。

---

## 4. Edge 能执行哪些命令

`ongrid-edge` 没有一条“任意命令”通道，而是按用途分成多个执行面：

| 执行面 | 能执行什么 | 默认状态 |
| --- | --- | --- |
| `bash.exec`（`host_bash`） | 白名单内的只读命令；审批通过后可走不受限 shell | 只读、默认开启 |
| `operator.exec` | 5 个固定网络诊断命令 | 开启 |
| `execute_skill` | 固定技能 | 按技能 |
| `host_files.*` | `find` / `du` / `df` / `stat` / `ls` 的封装 | 开启 |
| `restart_service.restart` | 8 个固定 systemd unit | 有 handler，但当前是 mock |
| K8s actions | 资源 describe / 日志 / rollout 等 | 仅 controller |
| 插件子进程 | node_exporter、process-exporter、otelcol、DB exporter | 由 Manager 配置启停 |

### 4.1 bash.exec 的默认只读白名单

核心是 [cmdpolicy.DefaultReadOnly()](../../internal/edgeagent/cmdpolicy/policy.go)。

#### 文件系统只读（ClassReadFS）

`cat`、`head`、`tail`、`tac`、`less`、`ls`、`find`、`du`、`stat`、`readlink`、`file`、`tree`、`wc`、`grep`、`egrep`、`fgrep`、`awk`、`sed`

额外限制：

- `find` 禁止 `-delete`、`-exec`、`-execdir`、`-ok`、`-okdir`、`-fprint`、`-fprintf`、`-fls`
- `awk` 禁止 `system(`、`| sh`、`| bash`、`exec(`
- `sed` 禁止 `-i` / `--in-place`

#### 系统状态只读（ClassReadSystem）

`ps`、`top`、`uptime`、`free`、`df`、`iostat`、`vmstat`、`mpstat`、`pidstat`、`lsof`、`ss`、`netstat`、`dmesg`、`who`、`w`、`uname`、`id`、`groups`、`hostname`、`date`、`journalctl`

额外限制：

- `hostname` 禁止 `-b`、`-s`、`--set`
- `date` 禁止 `-s`、`--set`
- `journalctl` 禁止 rotate/vacuum/flush 等写入类参数

#### 读写混合（ClassMixed，只允许只读子命令）

只有匹配到只读形式才放行：

| 命令 | 允许的只读形式（示例） |
| --- | --- |
| `systemctl` | `status`、`show`、`cat`、`list-*`、`is-*`、`get-default` |
| `ip` | `addr/link/route/neigh/rule show`、`netns list/identify/pids`、`-s` |
| `iptables` / `ip6tables` | `-L`、`-S`、`-C`、`-n` |
| `tc` | `qdisc/class/filter show`、`-s` |
| `mount` | `-l`、`--list`、`-t`、无参数；`mount /a /b` 一律拒绝 |
| `crontab` | `-l` / `--list` |
| `nft` | `list`、`describe`、`monitor` |
| `conntrack` | `-L`、`-S`、`-G`、`-E`、`-C` |
| `ipset` | `list`、`save`、`test`、`version`、`help` |
| `ethtool` | 默认只读；`-A/-C/-G/-K/-L/-X/-s/--reset` 等写参数拒绝 |
| `bpftool` | `prog show/list/dump`、`map show/list/dump/lookup`、`btf show`、`net show`、`link show`、`version` 等；`load/attach/create/update` 拒绝 |
| `ovs-vsctl` | `show`、`list-*`、`get`、`find`、`list` |
| `ovs-ofctl` | `show`、`dump-*`、`queue-*`、`monitor`、`snoop` |
| `ovs-dpctl` | `show`、`dump-flows`、`dump-dp`、`dump-conntrack` |
| `ovs-appctl` | 默认只读，`vlog/set`、`fdb/flush` 等写操作拒绝 |

#### 网络类命令（ClassNetwork）

`nc`、`curl`、`wget`、`dig`、`host`、`nslookup`、`ping`、`traceroute`

默认 `NetworkHostAllowlist = nil`，[hostAllowed](../../internal/edgeagent/cmdpolicy/sandbox.go) 对空列表返回 false，所以**默认拒绝所有出站目标**。这些二进制在白名单里，但实际执行会因为没有目标白名单而被拒。需要运维配置 CIDR / 后缀才能用。

部分参数另行限制：

- `nc` 只允许 `-z`，禁止 `-e`、`-c`、`-l`
- `curl` 只允许 `-I` / `--head`，禁止 `-o`、`-O`、`-T` 等写文件/上传
- `wget` 只允许 `--spider`，禁止 `-O`、`-o`
- `ping` 禁止 `-f`

#### 明确拒绝（ClassDenied）

- Shell：`bash`、`sh`、`zsh`、`dash`、`ash`
- 脚本运行时：`python`、`python3`、`perl`、`ruby`、`node`、`lua`、`tcl`
- 破坏性文件操作：`rm`、`rmdir`、`mv`、`cp`、`dd`、`mkfs`、`truncate`、`shred`
- 权限变更：`chmod`、`chown`、`chgrp`、`setfacl`
- 系统电源/用户/口令：`shutdown`、`reboot`、`halt`、`poweroff`、`kexec`、`useradd`、`userdel`、`usermod`、`groupadd`、`groupdel`、`passwd`、`chpasswd`
- 规则表整体替换：`iptables-restore`、`ip6tables-restore`

**不在白名单里的命令一律拒绝**（例如 `docker`、`git`、`kubectl`、`tar`、`kill`），除非运维通过 YAML 扩展。

### 4.2 不只检查二进制，还检查语法和参数

[cmdpolicy 的解析器](../../internal/edgeagent/cmdpolicy/parse.go) 只接受：

- 简单命令
- 裸管道 `|`

明确拒绝：

- 重定向 `>`、`>>`、`<`、`<<`
- `;`、`&&`、`||`、`&`
- 命令替换 `$()`、反引号
- 参数展开 `${}`
- 子 shell、进程替换 `<( )`、`>( )`
- 换行拼接

每条命令最多 32 个参数；默认超时 300 秒；stdout 截断 64 KiB，stderr 16 KiB；子进程使用清理过的环境变量（仅 `PATH`、`LANG`、`LC_ALL`）。

### 4.3 路径限制

所有以 `/` 开头的参数都会经过 [host_files 的路径校验](../../internal/edgeagent/host_files/sandbox.go)：

- 默认是**拒绝名单**模式，允许绝大部分路径；
- 拒绝 `/proc`、`/sys`、`/dev`、`/run`；
- 拒绝 `/etc/shadow`、`/etc/gshadow`、`/etc/sudoers`、`/etc/sudoers.d`；
- 拒绝 `/root/.ssh`、`/root/.gnupg`，以及 `/home/<user>/.ssh`、`/home/<user>/.gnupg`；
- 符号链接会先做 `EvalSymlinks`，防止 `/tmp/escape -> /etc` 绕过；
- 运维可以通过 `AllowedReadPaths` 再加一层允许名单。

### 4.4 审批后的“不受限”写通道

`bash.exec` 请求里有一个 `Unrestricted` 标志。Manager 只有在以下条件全部满足时才设置它：

1. 运维打开了 “Agent write actions” 开关；
2. 命令被判定为写操作；
3. 审批通过。

之后 Edge 调用 [Sandbox.ExecRaw](../../internal/edgeagent/cmdpolicy/sandbox.go)：

```go
exec.CommandContext(cctx, "/bin/sh", "-c", cmd)
```

这会**完全绕过** cmdpolicy 白名单、拒绝类、路径/网络白名单和 shell 语法限制。仍然保留超时和输出上限。

> 信任边界：Edge 侧只检查 `Unrestricted` 标志，不自行验证审批是否真的发生。审批和写开关的判断都在 Manager（[bash.go](../../internal/manager/biz/aiops/tools/bash.go)），Edge 按“Manager 可信”处理。

常规只读调用永远走 `Unrestricted=false`，所以即使 Manager 的写命令分类器漏判，Edge 的 cmdpolicy 仍会 fail closed。

### 4.5 operator.exec：5 个固定命令

[buildCommand](../../internal/edgeagent/operator/handlers.go) 只认：

| 命令 | 实际执行 | 约束 |
| --- | --- | --- |
| `list_netns` | `ip netns list` | 无参数 |
| `ping` | `ping -c <n> -W <t> <host>` | count 1–20，host 校验 |
| `dig` | `dig +time=<t> <host> <type>` | type 仅 A/AAAA/CNAME/MX/TXT |
| `tcp` | `nc -vz -w <t> <host> <port>` | 端口 1–65535，host 校验 |
| `http` | `curl -I -X HEAD/GET --max-time <t> <url>` | 仅 HEAD/GET，可选 `-k` |

默认超时 5 秒，最大 300 秒，输出上限 64 KiB。支持可选 network namespace。

### 4.6 execute_skill 中可在 Edge 执行的技能

| Key | 作用 | 实际命令/能力 |
| --- | --- | --- |
| `host_probe_ping` | Ping 探测 | `ping` |
| `host_probe_tcp` | TCP 端口探测 | `nc` |
| `host_probe_dns` | DNS 查询 | `dig`/`nslookup` |
| `host_probe_http` | HTTP 探测 | `curl` |
| `host_read_journal` | 读 journald | `journalctl`，禁用写入类参数 |
| `host_tail_file` | 读文件尾部 | 绝对路径 + 禁止 `..` |
| `host_netns_inspect` | 查看 netns 地址/路由/链路 | `ip -j` 系列 |
| `capture_pcap` | 启动抓包 | 内置 packet capture |
| `get_packet_capture` | 查询抓包状态 | 内置 |
| `host_restart_service` | 重启服务 | 注册 shim；直接 Execute 被锁定，必须走 Manager 审批 |

`web_search` 是 Manager-scope，不会在 Edge 执行。

### 4.7 其他非 shell 能力

- **`host_files.find_large_files` / `du_summary` / `stat_file`**：只允许 `find`、`du`、`df`、`stat`、`ls`，路径走同一套拒绝名单。
- **`restart_service.restart`**：只允许 `nginx`、`redis`、`prometheus`、`loki`、`tempo`、`grafana`、`mysql`、`ongrid`。但 [DefaultSandboxConfig](../../internal/edgeagent/restart_service/handlers.go) 当前是 `Mocked: true`，**不会真的执行 `systemctl restart`**。
- **K8s controller**：`describe_k8s_resource`、`query_k8s_logs`、`execute_k8s_action` 通过 client-go 执行，不经过 shell。
- **升级**：`agent_upgrade` / `fetch_package` / `apply_package` 只做下载、校验、stage 和退出。
- **抓包**：通过 Edge 内置 packet capture 服务，有接口、时长、字节数、包数上限。
- **插件子进程**：node_exporter、process-exporter、otelcol-contrib、数据库 exporter 由插件 Supervisor 启动。

### 4.8 速查表

| 想做的事 | 是否默认允许 | 通道 |
| --- | --- | --- |
| `ls` / `cat` / `grep` / `find` / `du` / `ps` / `ss` / `df` | ✅ | `bash.exec` 只读 |
| `journalctl -u x` | ✅ | `bash.exec` 或 `host_read_journal` |
| `systemctl status/start` | 仅 `status`；`start` ❌ | `bash.exec`；重启走 `restart_service` |
| `ip addr show` / `nft list ruleset` | ✅ | `bash.exec` |
| `ip addr add` / `iptables -A` / `tc qdisc add` | ❌（需审批后 Unrestricted） | `bash.exec` 写通道 |
| `ping` / `dig` / `nc -z` / `curl -I` | 目标需在 allowlist；默认 ❌ | `operator.exec` 可绕过该限制 |
| `rm` / `mv` / `chmod` / `docker` | ❌（需审批） | 审批后 `Unrestricted` |
| `bash -c ...` / `python ...` | ❌ | 永远拒绝（Unrestricted 除外） |
| 端口探测、HTTP 探测 | ✅ | `operator.exec` 或 skill |
| 重启 nginx 等 | 有 handler，但当前 mock | `restart_service` |
| 抓包 | ✅（需权限） | `capture_pcap` |

---

## 5. 扩展命令白名单

| 要增加的白名单 | 位置 | 是否需改代码/重编译 |
| --- | --- | --- |
| `bash.exec` 可执行的命令 | Edge 主机上的 `/etc/ongrid-edge/bash-policy.yaml` | 否，改文件 + 重启 Edge |
| `bash.exec` 允许访问的网络目标 | 同一个 YAML 的 `network_host_allowlist` | 否 |
| `bash.exec` 的路径约束 | 目前没有配置入口，硬编码在 `host_files` 的默认校验器里 | 是 |
| `host_files` 的路径/二进制 | [host_files/sandbox.go](../../internal/edgeagent/host_files/sandbox.go) 的 `DefaultSandboxConfig()` | 是 |
| `restart_service` 的 unit | [restart_service/handlers.go](../../internal/edgeagent/restart_service/handlers.go) 的 `DefaultSandboxConfig()` | 是 |
| `operator.exec` 的命令 | [operator/handlers.go](../../internal/edgeagent/operator/handlers.go) 的 `buildCommand()` | 是 |
| Manager 判定“写命令”的列表 | [bash.go](../../internal/manager/biz/aiops/tools/bash.go) 的 `hostSegmentIsWrite()` | 是 |

最常用的场景——给 `host_bash` 增加一条只读命令——只需要改 Edge 本地 YAML。

### 5.1 加载机制

[bash.Register](../../internal/edgeagent/bash/handlers.go) 在 Edge 启动时：

1. 先加载内置基线 `cmdpolicy.DefaultReadOnly()`；
2. 如果 `/etc/ongrid-edge/bash-policy.yaml` 存在，调用 `LoadFromYAML(path, baseline)` 合并；
3. 解析失败时只打 warning，继续使用基线，不会阻止 Edge 启动；
4. 成功时日志会打印 `bash: policy override loaded` 和 `bash: sandbox ready allowed_bins=N`。

文件只在启动时读取一次，没有热加载。改完必须重启：

```bash
sudo systemctl restart ongrid-edge
```

示例文件：[deploy/edge/bash-policy.example.yaml](../../deploy/edge/bash-policy.example.yaml)。它只是示例，`install.sh` 不会自动安装到主机。

### 5.2 基本写法

```yaml
binaries:
  - name: htop
    class: read-system

  - name: sysctl
    class: mixed
    read_only_matchers:
      - any_flag: ["-a", "--all"]
    write_matchers:
      - any_flag: ["-w", "--write", "-p", "--load"]

  - name: smartctl
    class: read-system
    denied_args: ["-s", "--set"]
```

`class` 可选：

| class | 含义 |
| --- | --- |
| `read-fs` | 文件系统只读，直接放行 |
| `read-system` | 系统状态只读，直接放行 |
| `mixed` | 按参数区分读写，必须命中 `read_only_matchers` 才放行，否则拒绝 |
| `network` | 网络命令，还需通过 `network_host_allowlist` |
| `denied` | 明确拒绝 |

注意：

- 新增 `mixed` 命令时只写 `denied_args` 不够，必须提供 `read_only_matchers`，否则默认拒绝；
- 命令必须在该主机上真实存在，否则报 `binary "x" is not installed on this host`；
- 二进制路径在启动时解析，之后即使 PATH 变化也不会重新查找。

### 5.3 合并语义与坑

[LoadFromYAML](../../internal/edgeagent/cmdpolicy/policy.go) 的行为：

- **同名条目完整替换基线条目**，不是逐字段合并；
- 新名字追加；
- `network_host_allowlist` / `path_allowlist` 设置时替换，未设置时保留基线；
- `stdout_cap_bytes` / `stderr_cap_bytes` / `timeout_seconds` / `max_argv_length` 大于 0 时替换。

注意：

1. **同名覆盖也可以用来“禁用”基线命令**。例如 `- name: cat` + `class: denied`。按 `addBin` 的 map 覆盖逻辑，`cat` 会被替换成 denied。示例文件头部注释说“YAML 没有 remove 动词”，与当前实现不完全一致，建议实际验证。
2. **不要把 `bash` / `sh` / `python` / `rm` 等重新声明成 `read-*`**。YAML 确实可以覆盖 `class: denied` 的基线项，但这等于主动打开高风险通道，评审时应拒绝。

### 5.4 增加网络目标

网络类命令默认全部拒绝，因为基线 `network_host_allowlist` 为空。要放行目标：

```yaml
network_host_allowlist:
  - 10.0.0.0/8
  - 192.168.0.0/16
  - .internal.example.com
```

匹配规则：

- 含 `/` 按 CIDR 匹配；
- 以 `.` 开头按主机名后缀匹配；
- 否则精确匹配 IP 或主机名。

### 5.5 path_allowlist 的当前缺口

示例 YAML 里有 `path_allowlist`，但当前代码中：

- `LoadFromYAML` 会把 `path_allowlist` 写入 `Policy.PathAllowlist`；
- **`Sandbox.Decide` 的路径校验并不读取 `Policy.PathAllowlist`**，它只调用 `PathValidator`；
- `bash.Register` 传的 `PathValidator` 是 `host_files.DefaultSandboxConfig()`，其中 `AllowedReadPaths` 为空，实际生效的是拒绝名单。

因此，**目前改 YAML 的 `path_allowlist` 不会改变 bash 的路径行为**。如果需要更严格的路径白名单，只能改代码，例如在 `bash.Register` 里构造带 `AllowedReadPaths` 的 `SandboxConfig`，或者把它做成环境变量/Manager 下发配置。

### 5.6 验证与回滚

```bash
# 1. 放置文件
sudo install -m 0644 bash-policy.yaml /etc/ongrid-edge/bash-policy.yaml

# 2. 重启
sudo systemctl restart ongrid-edge

# 3. 看日志
journalctl -u ongrid-edge -n 50 | grep 'bash:'

# 4. 在 Manager 的 AIOps/设备详情里发一条 host_bash 验证
```

回滚就是删除该文件并重启，Edge 会回到内置只读基线。

建议流程：

1. 优先只加只读命令，不要给 shell、解释器、`rm`、`dd` 开口子；
2. 在测试 Edge 上放置 YAML，重启并看 `bash: sandbox ready allowed_bins=N`；
3. 用一条最小命令验证 `host_bash` 返回 `allowed=true`；
4. 通过配置管理分发到目标主机——目前 Manager 没有“下发 bash 策略”的配置项，这个文件是每台 Edge 本地管理的；
5. 文件纳入版本管理，并在变更说明里写明新增的二进制、参数限制和网络目标。

---

## 6. 安装

`ongrid-edge` 有四种安装方式，安装内容基本一致，区别在制品来源和编排方式：

| 方式 | 适用场景 | 入口 |
| --- | --- | --- |
| 在线 curl-pipe | 单机或批量 Linux 主机 | `curl https://<server>/install.sh \| bash` |
| 离线 tarball | 内网/无法访问 Manager 的机器 | 拷贝 `/opt/ongrid/edge`，运行 `install-edge.sh` |
| Kubernetes Helm | K8s 集群 | `helm upgrade --install ongrid-edge oci://helm.cnb.cool/ongridio/ongrid-edge` |
| Windows Service | Windows 主机 | `ongrid-edge-supervisor.exe --install` |

所有 Linux 安装最终都会落地为：

- `/usr/local/bin/ongrid-edge`
- `/usr/local/lib/ongrid-edge/`（插件二进制 + 升级 hook）
- `/etc/ongrid-edge/ongrid-edge.env`
- `/etc/systemd/system/ongrid-edge.service`
- `/etc/systemd/system/ongrid-edge-upgrade.service`
- `/var/lib/ongrid-edge/`、`/var/log/ongrid-edge/`

### 6.1 在线 curl-pipe 安装

#### 安装命令来源

两种入口：

**单设备安装**：Web UI → Devices → 创建设备，生成一次性 access-key / secret-key：

```bash
curl -k -sSL https://<server>/install.sh | bash -s -- \
  --access-key=<access-key> \
  --secret-key=<secret-key> \
  --server-edge-addr=<server>:40012 \
  --server-http-addr=<server>
```

**批量安装**：UI → Devices → Batch install 创建 profile，生成 enrollment token：

```bash
curl -k -sSL https://<server>/install.sh | bash -s -- \
  --enrollment-token=<token> \
  --server-edge-addr=<server>:40012 \
  --server-http-addr=<server> \
  --tls-insecure
```

区别：

- 单设备：所有主机共用同一组 key（不推荐多机）；
- 批量：每台主机用同一个短期 token 换取**独立**的 AccessKey/SecretKey。

#### Manager 侧准备

`install.sh` 和 Edge 二进制由 Manager 的 nginx 静态目录提供：

- `/install.sh` → `/usr/share/nginx/html/edge/install.sh`
- `/edge/*` → `/usr/share/nginx/html/edge/*`

对应 [deploy/install/nginx.conf](../../deploy/install/nginx.conf)。

这些文件来自云端安装/升级时的 [fetch-edge-assets.sh](../../deploy/install/edge/fetch-edge-assets.sh)：

1. 从 CNB Release 下载公共依赖包 `edge-deps-<target>.tar.xz`；
2. 下载当前版本 `ongrid-edge-<target>-<version>` 裸二进制；
3. 校验附件 SHA-256、压缩包内部 `MANIFEST.sha256` 和架构；
4. 在 staging 目录重建 `/opt/ongrid/edge/` 布局，再原子安装；
5. docker-compose 把 `./edge` 挂到 nginx 的 `/usr/share/nginx/html/edge`，以及 Manager 的 `/usr/share/ongrid/edge-bundles`。

> curl-pipe 脚本下载二进制时**不做 SHA-256 校验**，它信任 Manager 的 HTTPS 入口；制品完整性校验发生在 Manager 安装/升级阶段。

#### 脚本执行流程

入口脚本：[deploy/install/edge/install.sh](../../deploy/install/edge/install.sh)。

1. **参数与权限**：解析 access/secret 或 enrollment token；校验两个地址参数；非 root 时自动 `sudo -E bash "$0" "$@"`。
2. **平台检测**：只支持 Linux + amd64/arm64。
3. **下载二进制**：`https://<server-http-addr>/edge/ongrid-edge-linux-<arch>`，`curl -fLk --retry 3`。
4. **批量 enrollment（可选）**：在停止现有服务之前，用刚下载的二进制执行 `ongrid-edge enroll --manager-url=... --cloud-addr-fallback=... --output=<temp> [--tls-insecure]`；拿到独立凭证后写临时 env（0600，原子 rename）。已 enrollment 的主机重复执行会被 Manager 拒绝，脚本在动现有服务之前退出。
5. **停止旧服务并替换二进制**：`systemctl stop ongrid-edge`，`install -m 0755 -o root -g root` 到 `/usr/local/bin/ongrid-edge`。
6. **安装升级 hook**：从 `/edge/apply-pending-upgrade.sh` 下载到 `/usr/local/lib/ongrid-edge/apply-pending-upgrade.sh`。失败只告警，但整包远程升级不可用。
7. **安装插件二进制**：逐个从 `/edge/` 下载 `obi`、`obi.NOTICES`、`node_exporter`、`process_exporter`、`otelcol-contrib`、`mysqld_exporter`、`postgres_exporter`、`redis_exporter`、`mongodb_exporter` 到 `/usr/local/lib/ongrid-edge/`。best-effort，缺失只禁用对应插件。
8. **创建目录**：`/var/log/ongrid-edge`（0750）、`/etc/ongrid-edge`（0750）、`/var/lib/ongrid-edge`（0755）。
9. **写环境文件**：`/etc/ongrid-edge/ongrid-edge.env`，`0640 root:root`，包含 `ONGRID_EDGE_CLOUD_ADDR` / `ONGRID_EDGE_ACCESS_KEY` / `ONGRID_EDGE_SECRET_KEY`；批量模式还包含 `ONGRID_MANAGER_PUBLIC_URL`；保留已有的 `ONGRID_EDGE_METRICS_ADDR`。
10. **安装 systemd 单元**：`ongrid-edge.service` 和 `ongrid-edge-upgrade.service`，然后 `daemon-reload`、`enable`、`restart`。
11. **启动后验证与自检**：最多等待 20 秒，轮询 journal 中的 `agent: registered with cloud`；`unauthorized` 快速失败；自检插件二进制、state 目录可写、journald 可读。

systemd 单元关键配置见 [ongrid-edge.service](../../deploy/install/edge/ongrid-edge.service)：

- `EnvironmentFile=/etc/ongrid-edge/ongrid-edge.env`
- `ExecStart=/usr/local/bin/ongrid-edge`
- `Restart=always`、`RestartSec=5`
- 以 root 运行（没有 `User=`）
- `AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW`
- `NoNewPrivileges=true`
- `ProtectSystem=false`、`ProtectHome=false`、`PrivateTmp=false`
- `Wants=ongrid-edge-upgrade.service` / `After=...`

#### 重装与卸载

重装是幂等的：新 key 会覆盖 env 并重启服务；已 enrollment 的主机重复执行批量命令会被 Manager 拒绝。

卸载：

```bash
curl -k -sSL https://<server>/install.sh | bash -s -- --uninstall
```

它会停止并禁用服务、删除两个 service 文件、删除 `/usr/local/bin/ongrid-edge` 和 `/etc/ongrid-edge`，保留 `/var/log/ongrid-edge`。

### 6.2 离线 tarball 安装

在 Manager 上：

```bash
scp -r /opt/ongrid/edge user@target:~/ongrid-edge
```

在目标机：

```bash
cd ~/ongrid-edge
sudo ./install-edge.sh
```

或非交互：

```bash
sudo ONGRID_CLOUD_ADDR=ongrid.example.com:40012 \
     EDGE_ACCESS_KEY=xxx \
     EDGE_SECRET_KEY=yyy \
     ./install-edge.sh
```

[install-edge.sh](../../deploy/install/edge/install-edge.sh) 与在线安装器的主要区别：

- 不从网络下载 Edge 二进制和插件，直接使用同目录文件；
- 交互式或环境变量收集三个参数；
- 安装 `apply-pending-upgrade.sh`、systemd 单元、env 模板；
- 同样会做插件二进制、state 目录、journald 的自检。

它支持 `--uninstall`，但只建议用于 Linux；脚本对 Darwin 只安装二进制，不安装 systemd 单元。

### 6.3 批量 enrollment 的细节

批量安装的关键是**每台主机独立身份**：

1. UI 创建 profile，设置有效期、最大设备数、是否自动关联到集群；
2. 分发同一个 `--enrollment-token`；
3. 每台主机上的 `ongrid-edge enroll` 调用 `/internal/edge/enroll`；
4. Manager 校验 token 哈希、有效期、使用次数、撤销状态，创建新的 Edge 和独立 access/secret，记录 HostInfo 和来源 IP；
5. 返回的 `cloud_addr` 和 `manager_public_url` 写入该主机 env。

安全点：

- token 只是短期 bootstrap 能力，不是长期凭证；
- 已注册主机重复执行会被拒绝；
- profile 可撤销、可过期、可限制数量；
- token 不落日志。

相关代码：[enroll.go](../../internal/edgeagent/enrollment/enroll.go)、[enrollment_http.go](../../internal/manager/server/edge/enrollment_http.go)。

### 6.4 Kubernetes Helm 安装

Chart 位于 [deploy/kubernetes/ongrid-edge](../../deploy/kubernetes/ongrid-edge/values.yaml)：

```bash
helm upgrade --install ongrid-edge 'oci://helm.cnb.cool/ongridio/ongrid-edge' \
  --version '<chart_version>' \
  --namespace ongrid-system \
  --create-namespace \
  --set-string manager.publicURL='https://<manager>' \
  --set-string manager.tunnelAddr='<manager>:40012' \
  --set-string manager.tlsInsecure=true \
  --set-string enrollment.clusterID='<cluster_id>' \
  --set-string enrollment.controllerBootstrapToken='<controller_bootstrap_token>' \
  --set-string enrollment.nodeBootstrapToken='<node_bootstrap_token>' \
  --set-string mode='full-node'
```

会安装：

| 组件 | 作用 |
| --- | --- |
| Controller Deployment | 访问 K8s API，采集清单/Events，执行受控动作 |
| Node DaemonSet | 每个节点一个 Edge，复用主机采集和诊断能力 |
| kube-state-metrics | 集群对象指标（可选） |
| Telemetry Gateway / Metrics Scraper | 数据面，按 `mode` 和 values 启用 |
| ServiceAccount / RBAC / Secrets / ConfigMap | 身份与配置 |

节点安装细节：

- Node DaemonSet 用 bootstrap token 以 Node 身份 enroll；
- 每个节点把凭证保存到宿主机 `/var/lib/ongrid-edge/k8s-state/credentials`（0600），滚动重建时复用；
- 启动 launcher 进入宿主机根文件系统（`/host/root` chroot），随后降为 UID/GID 65532，只保留 `CAP_NET_ADMIN`、`CAP_DAC_READ_SEARCH`；
- controller 不创建 host Device，UI 中只展示节点设备。

卸载：

```bash
helm uninstall ongrid-edge --namespace ongrid-system
kubectl delete namespace ongrid-system --ignore-not-found
```

### 6.5 Windows 安装

Windows 不适用 Linux systemd，也不在 curl-pipe 安装器覆盖范围内。使用：

```powershell
ongrid-edge-supervisor.exe --install `
  --token <SECRET_KEY> `
  --cloud-addr <frontier-host>:40012 `
  --access-key <ACCESS_KEY> `
  [--collector-mode off] `
  [--tls-ca-file C:\ongrid-edge\ca.pem] `
  [--tls-server-name <name>]
```

[install_windows.go](../../cmd/ongrid-edge-supervisor/install_windows.go) 做：

1. `CryptProtectData` 加密 secret，写 `secrets.enc`；
2. 立即验证能解密；
3. 清零明文 token 内存；
4. `sc.exe create` 创建 Windows Service；
5. 写注册表 `Environment`（cloud addr、access key、collector mode、插件目录、secrets 路径等）；
6. 配置 Defender 排除和失败恢复策略；
7. `sc.exe start` 启动。

`access_key` 明文放在服务环境变量里，`secret_key` 走 DPAPI 加密文件。

---

## 7. ongrid-edge-supervisor.exe 的位置与构建

仓库里**没有提交 `ongrid-edge-supervisor.exe`**，它是一个 Windows 构建产物，而且目前 Makefile 和 release 流程都没有生成/发布它。

### 7.1 源码位置

```text
cmd/ongrid-edge-supervisor/
├── main.go
├── service.go
├── worker.go
├── install_windows.go
├── upgrade_windows.go
├── env_windows.go
└── *_test.go
```

所有实现文件都带 `//go:build windows`，Linux 下不参与编译。

### 7.2 当前工作区与 CI

- `bin/` 下只有 Linux/darwin 的 Edge 二进制，没有 Windows；
- `.gitignore` 忽略了 `bin/windows-*`；
- 唯一会自动编译它的地方是 [.github/workflows/ci-windows-cross.yml](../../.github/workflows/ci-windows-cross.yml)，只做 build + vet 验证，不上传产物，也不进入 Release 附件。

### 7.3 手动构建

```bash
cd /path/to/nexus-hilbert

# supervisor
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -X main.version=$(cat VERSION)" \
  -o bin/windows-amd64/ongrid-edge-supervisor.exe \
  ./cmd/ongrid-edge-supervisor

# worker（必须叫这个名字）
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -X main.version=$(cat VERSION)" \
  -o bin/windows-amd64/ongrid-edge-worker.exe \
  ./cmd/ongrid-edge
```

worker 的文件名必须是 `ongrid-edge-worker.exe`，因为 [edgedirs_windows.go](../../internal/edgeagent/edgedirs/edgedirs_windows.go) 里硬编码了：

```go
const WorkerBinary = "ongrid-edge-worker.exe"
```

### 7.4 部署路径

```text
C:\Program Files\ongrid-edge\bin\ongrid-edge-supervisor.exe
C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe

C:\ProgramData\ongrid-edge\                  # 数据目录
C:\ProgramData\ongrid-edge\plugins\          # 插件工作目录
C:\ProgramData\ongrid-edge\upgrade\          # 升级 stage 目录
C:\ProgramData\ongrid-edge\secrets.enc       # DPAPI 加密的 secret
C:\ProgramData\ongrid-edge\health.json       # worker ↔ supervisor 健康 IPC
```

`sc.exe create` 使用 `os.Executable()`，也就是运行 `--install` 时 supervisor.exe 的路径。安装后不要移动这个文件；移动后需要重新安装或手动修 `binPath`。

卸载：

```powershell
ongrid-edge-supervisor.exe --uninstall
```

---

## 8. Linux 与 Windows 的差异

Linux 和 Windows 跑的是同一套 Edge Agent 代码，但进程模型、安装方式、凭证存储、升级编排和能力集差别很大。

### 8.1 进程与服务模型

| 维度 | Linux | Windows |
| --- | --- | --- |
| 服务进程 | `ongrid-edge` 单进程 | `ongrid-edge-supervisor.exe` |
| 实际 Agent | 同一进程 | 子进程 `ongrid-edge-worker.exe` |
| 服务管理器 | systemd | Windows SCM（`sc.exe`） |
| 服务名 | `ongrid-edge` | `ongrid-edge` |
| 异常恢复 | `Restart=always` + `RestartSec=5` | supervisor 内部重启 worker；supervisor 自身异常由 SCM recovery action 重启 |
| 健康检测 | systemd 进程存活 + 应用心跳 | `health.json` 文件 IPC：worker 每 30s 写，supervisor 90s 超时判定并 kill/restart |
| 日志 | journald | `supervisor.log`、`worker-stdout.log`、`worker-stderr.log` |

### 8.2 安装入口与交付物

| 维度 | Linux | Windows |
| --- | --- | --- |
| 在线安装 | `curl https://<server>/install.sh \| bash` | 无 |
| 离线安装 | `install-edge.sh` | 无，手动放置二进制后 `--install` |
| 官方 Release 附件 | 有（linux-amd64/arm64、依赖包、bundle） | 没有，需要自行交叉编译 |
| 批量 enrollment token | 支持 | `--install` 只接受直接 token/access-key，未接 enrollment profile |
| 插件二进制 | 安装器自动下载/安装 | 安装器不安装，需手动放到 `C:\Program Files\ongrid-edge\bin` |
| 安装自检 | 检查插件、state 目录、journald | 检查 DPAPI round-trip、服务创建、恢复策略、启动结果 |

### 8.3 配置与凭证

| 维度 | Linux | Windows |
| --- | --- | --- |
| 配置载体 | `/etc/ongrid-edge/ongrid-edge.env` | 服务注册表 `Environment` MultiString |
| 配置注入 | systemd `EnvironmentFile=` | SCM Environment + supervisor 显式合并给 worker |
| 文件权限 | `0640 root:root` | 服务键 ACL 由 Windows 管理 |
| access key | env 明文 | 注册表明文 |
| secret key | env 明文 | DPAPI 加密到 `secrets.enc` |
| DPAPI scope | 不适用 | `CRYPTPROTECT_LOCAL_MACHINE` |
| TLS 配置 | `ONGRID_EDGE_TLS_CA_FILE` 等 env | `--tls-ca-file` / `--tls-server-name` 写入注册表 |

### 8.4 目录与权限

| 内容 | Linux | Windows |
| --- | --- | --- |
| 主二进制 | `/usr/local/bin/ongrid-edge` | `C:\Program Files\ongrid-edge\bin\ongrid-edge-supervisor.exe` |
| worker | 无 | `C:\Program Files\ongrid-edge\bin\ongrid-edge-worker.exe` |
| 插件二进制 | `/usr/local/lib/ongrid-edge/` | 默认同 `bin` 目录 |
| 数据目录 | `/var/lib/ongrid-edge` | `C:\ProgramData\ongrid-edge` |
| 插件工作目录 | `/var/lib/ongrid-edge/plugins` | `C:\ProgramData\ongrid-edge\plugins` |
| 升级 stage | `/var/lib/ongrid-edge/.upgrade` | `C:\ProgramData\ongrid-edge\upgrade` |
| 配置 | `/etc/ongrid-edge/` | 注册表 |
| 日志 | `/var/log/ongrid-edge` + journald | `C:\ProgramData\ongrid-edge\*.log` |

权限模型：

- **Linux**：服务以 root 运行，`AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW`，`NoNewPrivileges=true`，`ProtectSystem=false`；
- **Windows**：服务默认以 LocalSystem 运行；升级 stage 目录 ACL 只允许 SYSTEM 和 Administrators，消费 bundle 前还会做 `VerifyTreeACL` 逐项复验；安装时配置 Defender 排除；`taskkill.exe` 使用 `%SystemRoot%\System32` 绝对路径，避免 PATH 劫持。

### 8.5 能力差异

| 能力 | Linux | Windows |
| --- | --- | --- |
| `get_host_load` / `get_process_list` | ✅ | ✅（gopsutil） |
| `bash.exec` | ✅ 只读白名单 | ❌ 不注册（`//go:build linux`） |
| `restart_service` | ✅（当前 mock） | ❌ 不注册 |
| `host_files.find_large_files` | ✅ | ❌ `unsupported GOOS`（只实现了 linux/darwin） |
| `host_files.du_summary` | ✅ | ❌ 同上 |
| `host_files.stat_file` | ✅ | ⚠️ 纯 Go 实现，取决于沙箱校验 |
| `operator.exec` | ✅ 5 个网络诊断命令 | ⚠️ 代码会注册，但命令依赖 Linux 工具，Windows 上通常不可用 |
| WebSSH | ✅ | ⚠️ 需要本机有 SSH 服务并监听 127.0.0.1:22 |
| 抓包 `packet_capture.*` | ✅ | ❌ 非 Linux 返回 “supported on linux only” |
| 插件（logs/traces/metrics/exporter） | ✅ 安装器自带二进制 | ⚠️ 插件框架跨平台，但需手动提供 Windows 版插件二进制 |
| K8s Controller/Node | ✅ Helm Chart | ❌ |
| 批量 enrollment | ✅ | ❌ |

Windows 的平台能力注册明确只保证 `host_files`（[capabilities_windows.go](../../cmd/ongrid-edge/capabilities_windows.go)），并注明 bash/restart_service 尚未移植。

### 8.6 升级与回滚

Linux：

```text
Manager 下发 agent_upgrade / fetch_package
  → Edge 下载并 stage 到 /var/lib/ongrid-edge/.upgrade
  → apply_package ACK 后进程退出
  → systemd 重启
  → 启动前 ongrid-edge-upgrade.service 运行 apply-pending-upgrade.sh
  → 按 MANIFEST.txt 原子替换
  → 新版本 register_edge 成功 → 写 health marker
  → 下次启动若无 marker → 自动回滚
```

Windows：

```text
supervisor 的 upgrademachine 状态机
  → worker 下载/校验 bundle，写 pending
  → supervisor --upgrade 写 supervisor_upgrade.pending
  → 退出，SCM recovery action 重启
  → 新 supervisor BootCheck：maybeRollbackOnBoot → maybeApplyOnBoot
  → apply 完成，必要时 supervisor self-swap
  → 再 exit(1) 让 SCM 重启加载新 supervisor.exe
  → worker 启动，health.json 心跳
  → 180 秒内未确认健康 → rollback.done + 恢复 .old
```

Windows 额外处理：

- `taskkill /T /F` 释放 `.exe` 文件锁；
- 系统关键进程黑名单，防止误杀；
- stage 目录 ACL 校验；
- supervisor 自替换后通过非 0 退出码触发 SCM 快速重启。

### 8.7 日志与排障

Linux：

```bash
systemctl status ongrid-edge
journalctl -u ongrid-edge -f
```

Windows：

```powershell
Get-Service ongrid-edge
Get-Content 'C:\ProgramData\ongrid-edge\supervisor.log' -Tail 100 -Wait
Get-Content 'C:\ProgramData\ongrid-edge\worker-stdout.log' -Tail 100
Get-Content 'C:\ProgramData\ongrid-edge\worker-stderr.log' -Tail 100
```

Windows Service 没有 console，worker 的 stdout/stderr 被重定向到文件，否则会直接丢弃。

### 8.8 卸载

| 维度 | Linux | Windows |
| --- | --- | --- |
| 命令 | `install.sh --uninstall` 或 `install-edge.sh --uninstall` | `supervisor.exe --uninstall` |
| 停止服务 | `systemctl disable --now` | `sc.exe stop` |
| 删除服务 | 删除 unit 文件 + `daemon-reload` | `sc.exe delete` |
| 删除二进制 | 删除 `/usr/local/bin/ongrid-edge` | 不删除，需手动清理 |
| 删除配置 | 删除 `/etc/ongrid-edge` | 注册表 Environment 随服务键删除 |
| 删除凭证 | env 文件一起删除 | 删除 `secrets.enc` |
| 保留日志 | `/var/log/ongrid-edge` | `C:\ProgramData\ongrid-edge` 下的日志 |

---

## 9. 已知边界与注意事项

- **restart_service 仍是 mock**：默认 `Mocked: true`，不会真的执行 `systemctl restart`；上线前需要改代码并验证。
- **Windows 没有正式发布链路**：supervisor/worker 需要手动交叉编译；Makefile 和 release 目前只发布 Linux 制品。
- **Windows 能力有限**：bash、restart_service、抓包、K8s、批量 enrollment 未移植；host_files 的 find/du 只实现 linux/darwin。
- **bash-policy.yaml 的 `path_allowlist` 尚未接入实际校验**：当前生效的是 host_files 的拒绝名单；需要更严格的路径白名单时要改代码。
- **curl-pipe 安装器不校验 Edge 二进制 SHA-256**：完整性校验发生在 Manager 的制品 staging 阶段。
- **Frontier 30 秒 RPC 截断补丁尚未验收**：见 [deploy/frontier-patches/README.md](../../deploy/frontier-patches/README.md)；当前部署镜像为 1.2.6，补丁基线是 1.2.4，升级前需要重新核对。
- **`Unrestricted` 的信任边界在 Manager**：Edge 只检查标志，不验证审批；Manager 的写开关和审批链是唯一授权来源。

---

## 10. 参考

- [Edge Agent 安装指南](../install/edge.md)
- [Kubernetes Edge 适配 RFC](../rfc/RFC-001-kubernetes-edge-adaptation.md)
- [Host command policy approval](host-command-policy-approval.md)
- [Host 与 Edge 双向关联](host-edge-identity.md)
- [部署说明](../../deploy/install/README.md)
- [Frontier 配置](../../deploy/install/frontier.yaml)
- [bash 策略示例](../../deploy/edge/bash-policy.example.yaml)
- [Manager 侧 frontierbound](../../internal/manager/service/frontierbound/doc.go)
- [Edge 侧 tunnel](../../internal/pkg/tunnel/doc.go)
- [Edge Agent 主循环](../../internal/edgeagent/biz/agent.go)
- [命令策略](../../internal/edgeagent/cmdpolicy/policy.go)
- [Windows supervisor](../../cmd/ongrid-edge-supervisor/main.go)
