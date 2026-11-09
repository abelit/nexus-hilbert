# AIOps 拓扑入口：两个图与各自边界

AIOps 同时有 manager 拓扑和 CMDB 关系图。它们不是同一张图，节点编号也不同；在建立确定性 CI ↔ Node 映射之前，不合并成一个入口，但必须让两个工具的方向和语义可解释。

## 两套身份

| 图 | 工具 | 节点身份 | 数据来源 |
|---|---|---|---|
| manager 拓扑 | `expand_topology`、`find_topology_node`、`get_network_neighbors` | manager `nodes.id`（`node_id`），可由 `device_id` 解析 | manager 自身写入的节点/关系（设备、集群、APM、网络发现、Edge） |
| CMDB 关系图 | `cmdb_get_ci_relations`、`cmdb_relation_graph`、`cmdb_query_relation_path`、`cmdb_find_ci_type_path` | CMDB `ci_id` | `c_ci_relations` 与模型规则 |

**数值相同不代表同一实体。** `node_id` 和 `ci_id` 是独立自增空间；没有 CI ↔ Node 映射列。CMDB 身份先用 `cmdb_search_ci` 解析，manager 身份先用 `find_topology_node` 解析，不要把一方的 id 传给另一方。

## 方向语义

### manager `expand_topology`

`direction` 现在按关系类型的 `direction` 计算：

| 关系类型 direction | downstream（影响面） | upstream（原因侧） |
|---|---|---|
| `src_to_dst` | 沿存储 Src → Dst | Dst → Src |
| `dst_to_src` | 沿存储 Dst → Src（如 `depends_on`、`deployed_on`） | Src → Dst |
| `bidirectional` | 两个方向都可传播 | 两个方向都可作为原因 |

`only_propagating=true`（默认）仍按 `propagates_failure` 过滤；`reached_via` 标记本次遍历在传播方向的哪一侧。未声明 direction 的自定义类型按 `src_to_dst` 处理。

### CMDB `cmdb_relation_graph`

`direction=down|up|both` 是**结构方向**：down 沿存储 `First→Second`（children），up 沿 `Second→First`（parents），不是故障传播方向。边的输出现在带 `relation_type_id`、`label`、`direction`、`propagates`、`weight`，以及有值时带 `evidence_source`、`confidence`、`observed_at`；调用方据此判断是否传播。

- `only_propagating=true` 只保留 `propagates=true` 的边，并跳过不传播的邻居；`counts` 仍报告原始一跳 `numfound`。
- `truncated` 在任何一跳分页被截断时置真，`truncated_levels` 列出发生截断的跳数；不再只比较第一跳。

## 为什么还不合并

单入口需要先满足：

1. 确定性的 CI ↔ Node 映射（当前只有名称启发式，重名会取第一条）；
2. ADR-037 的后台身份透传：`cmdb_*` 在无 `tenantctx` 的告警调查和 flow 中 fail-closed，而 `expand_topology` 读本地库可用；
3. topocortex 的关系类型语义与推理边接入（CMDB 语义字段是其只读镜像）；
4. 计划中的 shadow read、未解释差异 0、抽样对账和回滚开关。

在此之前，按 ID 域选择工具，不按部署环境隐式切换事实源。聚合级对账可以作为影子指标；逐边对账依赖映射表，暂不提供。

## 后续

- Phase 3 建立 CI ↔ Node 映射和投影后，再决定保留哪个入口；
- `get_topology` 是部署概况（主机、Edge、规则、通道），不是关系图，保持独立；
- 关系类型方向变更时，两个工具的语义测试都要更新。
