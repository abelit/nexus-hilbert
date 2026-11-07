# 自动发现 Agent API（v2）

> 面向 nexus-riemann 的机器接口。控制台 API（`/api/v1/cmdb/discovery/**`）
> 保持不变；本接口只服务采集链路，使用独立的认证域。

## 认证

- riemann 持有一个 CMDB 签发的 bearer token：`cmdbagent_<public_id>.<secret>`。
- CMDB 只存 secret 的 SHA-256 摘要；token 有作用域、过期时间和吊销时间。
- Token 由控制台管理接口签发/吊销，secret 只显示一次。
- 所有请求走 TLS；agent 路由**不**经过用户 JWT 中间件。

作用域：

| Scope | 用途 |
| --- | --- |
| `discovery.agent.tasks.read` | 拉取任务差异 |
| `discovery.agent.reports.write` | 上报发现实例 |
| `discovery.agent.logs.write` | 上报执行日志 |
| `discovery.agent.eulers.write` | 注册/心跳 |
| `discovery.agent.enroll` | 注册 token（预留） |

## 端点

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/v1/cmdb/discovery/agent/register` | 注册 euler（euler_id、riemann_id、hostname、capabilities） |
| POST | `/api/v1/cmdb/discovery/agent/heartbeat` | 心跳、能力、最后错误 |
| POST | `/api/v1/cmdb/discovery/agent/tasks/sync` | 根据 known revisions 返回任务差异 |
| POST | `/api/v1/cmdb/discovery/agent/reports` | 批量上报，`report_id` 幂等 |
| POST | `/api/v1/cmdb/discovery/agent/exec-logs` | 批量执行日志 |

控制台端点（用户 JWT）：

| Method | Path | 说明 |
| --- | --- | --- |
| POST | `/api/v1/cmdb/discovery/agent-principals` | 签发 token，返回一次 secret（管理员） |
| GET | `/api/v1/cmdb/discovery/agent-principals` | 列出 principal（管理员，不含 secret） |
| DELETE | `/api/v1/cmdb/discovery/agent-principals/{id}` | 吊销（管理员） |
| GET | `/api/v1/cmdb/discovery/eulers` | 已注册采集器（管理员） |
| GET | `/api/v1/cmdb/discovery/targets/{id}/health` | 目标的采集器范围、在线状态和最近任务下发（任意登录用户，只读，不触发采集） |

## 任务

`tasks/sync` 的请求携带 `euler_id`、`state_lost`、`known[]`（task_id/revision）
和 `capabilities`。CMDB 返回：

- `changed[]`：新增或 revision 变化的 `AgentTask`；
- `removed_task_ids[]`：不再适用于该 euler 的任务；
- `reset`：euler 丢失本地状态时先清空；
- `warnings[]`：逐目标配置问题（未实现的云采集器、缺失 region/凭据、采集器未声明该
  `collect_key`、SNMP 缺节点或 community 等）。警告按字符串排序去重，不影响同一快照里的
  其他任务。riemann 和 euler 都会记录警告。

`AgentTask` 的关键字段：

- `task_id`：`t:<target_id>`；
- `kind`：agent / components / plugin / cloud / snmp / ipam_scan；
- `collect_key`、`unique_key`、`mapping`（provider 字段 → 模型属性）；
- `schedule.cron`（5 段或 cantor 的 6 段写法）、时区/超时等；
- `params`（非秘密参数）、`secret_envelope`（P2 起使用）；
- `artifact`（插件脚本、sha256、签名；P1 已下发脚本，签名为 P2）；
- `revision`：内容哈希，euler 用它判断是否需要重新应用。

云目标的 `collect_key` 以 TARGET 的 `extra_option.collect_key` 为准（保存时由
`applyProviderOptions` 从资源和 provider 推导）；只有旧数据才回退到规则 option 或
`category` 现场推导。账号配置可以覆盖 region、credentials 和 endpoint，但不能参与
采集器选择或 endpoint——编译器会在解封账号前固定 collect key，并删除账号注入的
`collect_key`/`provider`/`endpoint`/`insecure`；目标自己的 endpoint 和 TLS 设置优先，账号只提供
  region、project_id 和凭据。

## 上报

`reports[]` 每项包含 `report_id`、`task_id`、`instance_json`（base64 的 JSON 字节）、
可选 `unique_value`、`deleted`、`observed_at`。CMDB：

- 以 `report_id` 去重，重复返回 `duplicate`；
- 从任务反查 `type_id`/mapping/unique key，忽略调用方自报的模型信息；
- 以 `(type_id, unique_value)` upsert 发现池；
- `deleted=true` 只标记 `stale_at`，不删除已接纳的 CI。

`exec-logs[]` 的 `task_id` 用于反查模型 id，日志按模型归档；单条上限 64 KiB。

CMDB 单批最多 1000 条 report。euler 按 `EnrollResponse.max_batch_items`（上限 1000）
分块上报，聚合每块的 rejected 状态；失败块按块进入本地 spool，不会因为一个大账号
超过单批上限而整任务失败。

## 凭据、引用与写权限

- 目标与规则账号的 `secret`、`password`、`key`、`community`、`session_token` 以及 SNMP
  `nodes[].community` 在写入时密封存储；读取只返回
  `has_secret`/`has_password`/`has_key`/`has_community` 标志，不返回明文。节点级
  community 在读取时删除，并以 `has_community` 标记。`session_token` 当前没有独立读取
  标志，读取时直接剥离。
- 凭据的“出现”与“非空”具有不同含义：字段缺省表示保持原值，显式空值表示清除。
  清除与替换都要求目标/账号的 owner 或管理员；ownerless 目标/账号按管理员对象处理。
- `_reference` 只能指向目标同一规则下的账号；跨规则引用、指向不存在的账号或空字符串
  都会在保存时被拒绝。写入引用会删除目标自身的凭据，避免以后移除引用时旧凭据复活。
  读取目标时 `has_reference`/`reference_account_id` 描述引用，引用 id 本身不是秘密。
- SNMP 目标会编译为 `kind=snmp`、`collect_key=snmp` 的任务，并且必须显式绑定采集器；
  不会进入 host 采集器的 catch-all。`nodes[].community` 从 `params` 移除，以
  `{ip: community}` JSON 放入信封的 `node_communities`；顶层 `community` 同样只进入信封。
  当前 euler 采集器只遍历节点列表，CIDR 递归发现和 SNMPv3 尚未实现。
- 云（HTTP）目标编译为 `kind=cloud`，并且必须显式绑定采集器。当前 euler 实现：
  `ali.ecs`（阿里云 ECS）、`aws.ec2`（AWS EC2）、`tencent.cvm`（腾讯云 CVM）、
  `huawei.ecs`（华为云 ECS），以及 vCenter 的 `vsphere.vm/host/cluster/network/
  datastore/datacenter/folder/pool`；其他 `collect_key` 返回 warning，不会下发。
- 公有云需要 `region`、access key 和 secret；华为云还需要 `project_id`。vCenter 使用
  `host`、`account`、`password`，只接受 `https://`；可用 `insecure=true` 跳过自签名证书
  校验（会降低 MITM 防护，仅限自签名 vCenter）。当前只提供有 vSphere Automation REST
  端点的 8 类资源，分布式交换机/标准交换机/数据存储集群不在目录中。`endpoint` 可选（私有端点/测试，必须无
  userinfo/query/fragment）；`session_token` 通过账户配置或 API 提供时会进入信封，
  并用于各 provider 的临时凭证签名。控制台暂未单独提供 session token 输入框。
- 云任务的唯一键优先使用模型中已映射的 unique 属性；没有映射时回退
  `ali.ecs -> InstanceId`、`aws.ec2 -> instanceId`、`tencent.cvm -> InstanceId`、
  `huawei.ecs -> id`，以及 vCenter 各资源的原生 ID 字段。采集器声明的 `collect_keys`
  不包含该 key 时，CMDB 返回 warning 而不是把任务交给一个没有适配器的 collector。
- 目标更新/删除要求目标 owner 或管理员；关系自动发现整组替换仅管理员。

### `extra_option` 键

| 规则类型 | 键 |
| --- | --- |
| 通用 | `alias`、`_reference` |
| HTTP / 私有云 | `category`、`region`、`project_id`、`endpoint`、`insecure`、`key`、`secret`、`session_token`、`host`、`account`、`password` |
| SNMP | `nodes[]`（`ip`、`community`、`version`）、`version`、`community`、`timeout`、`retries`、`initial_node`、`recursive_scan`、`max_depth`、`cidr[]` |
| components | `cidr`、`ports`、`enable_cidr` |

HTTP 的资源类型变更会在保存时重新推导 `collect_key`/`provider`；清空或未知资源类型会删除旧值。
保存后如果 `provider`/`category` 与 `collect_key` 不一致，任务编译只产生 warning，不会下发；
这能抓住规则编辑后未重新保存的旧目标。

SNMP 的节点级 community 不进入 `extra_option` 之外的任何明文位置；任务信封中的
`node_communities` 是 `{ip: community}` JSON 字符串，euler 解封后按 IP 合并回节点。

## 任务与制品签名

- CMDB 用 ed25519 对任务和插件制品签名：
  - 任务签名覆盖任务 id、revision、kind、type/rule、collect_key、unique_key、
    mapping、params、schedule、artifact SHA、secret envelope 摘要和凭据字段 id；
  - 制品签名覆盖 task/revision/collect_key/language/script SHA。
- euler 在 `Enroll` 响应中取得 `task_signing_public_key` 与 `task_signing_key_id`；
  收到 snapshot 时先验签，插件制品还要求 `sha256(script)` 与制品摘要一致。
  已取得信任锚后，未签名或签名不匹配的任务/制品不会进入调度器。
- CMDB 签名私钥优先取 `ONGRID_CMDB_DISCOVERY_SIGNING_KEY`（base64 32 字节 seed），
  否则从 `ONGRID_SECRET_KEY`/`ONGRID_JWT_SECRET` 派生；同一部署重启保持同一公钥。
- 当前只下发一个活动信任锚；轮换密钥后 euler 在重连的 `Enroll` 响应中取得新锚。
  多锚并存和证书签发/吊销在 P2 的 PKI 工作中继续。

## 旧同步端点

`/api/v1/cmdb/discovery/sync` 保留 cantor 的拉取形态，仍会对显式绑定的 HTTP 目标返回
解密后的 key/secret（旧 agent 依赖它认证）。它不属于本 Agent API，计划随旧 agent 下线；
新采集链路只能使用 `/agent/**` 和秘密信封。

## 健康与交接

- `c_ad_rule_sync_histories` 只在任务真正下发（新增或 revision 变化）时写入，不在每次
  `tasks/sync` 轮询时按目标 × 采集器放大写入；否则 30 秒一轮会把交接表放大数个数量级。
- 采集器在线状态来自 `c_ad_eulers.last_seen_at` 心跳（默认 10 分钟窗口）；任务是否
  已经下发过来自交接记录。`targets/{id}/health` 把两者关联起来，并标出显式绑定但尚未
  注册的采集器、已经不再匹配的历史采集器，以及云/SNMP 目标未绑定具体采集器的配置问题。
- 健康检查是派生只读视图：不探测设备、不调用采集器，也不改变任务或调度状态。

## 数据表

| 表 | 用途 |
| --- | --- |
| `c_ad_agent_principals` | riemann 服务 token（摘要、scope、过期/吊销） |
| `c_ad_eulers` | 注册的采集器、公钥、能力、最后心跳 |
| `c_ad_enrollment_tokens` | 一次性注册 token（P1 预留） |
| `c_ad_euler_task_states` | ACK/最后应用 revision（审计） |
| `c_ad_report_receipts` | 上报幂等记录 |
| `c_ad_rule_sync_histories` | 任务交接日志（目标 × 采集器，最后下发时间） |

`c_ad_ci.oneagent_id/oneagent_name` 保留为控制台契约，Agent API 在边界把
`euler_id/euler_name` 映射到这两列；新代码不把 `oneagent` 扩散到机器契约。
