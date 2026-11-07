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
- `warnings[]`：当前阶段无法下发的原因（如云/SNMP 需要 P2）。

`AgentTask` 的关键字段：

- `task_id`：`t:<target_id>`；
- `kind`：agent / components / plugin / cloud / snmp / ipam_scan；
- `collect_key`、`unique_key`、`mapping`（provider 字段 → 模型属性）；
- `schedule.cron`（5 段或 cantor 的 6 段写法）、时区/超时等；
- `params`（非秘密参数）、`secret_envelope`（P2 起使用）；
- `artifact`（插件脚本、sha256、签名；P1 已下发脚本，签名为 P2）；
- `revision`：内容哈希，euler 用它判断是否需要重新应用。

## 上报

`reports[]` 每项包含 `report_id`、`task_id`、`instance_json`（base64 的 JSON 字节）、
可选 `unique_value`、`deleted`、`observed_at`。CMDB：

- 以 `report_id` 去重，重复返回 `duplicate`；
- 从任务反查 `type_id`/mapping/unique key，忽略调用方自报的模型信息；
- 以 `(type_id, unique_value)` upsert 发现池；
- `deleted=true` 只标记 `stale_at`，不删除已接纳的 CI。

`exec-logs[]` 的 `task_id` 用于反查模型 id，日志按模型归档；单条上限 64 KiB。

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
