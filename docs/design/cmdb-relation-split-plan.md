# CMDB 关系类型拆分规划

`contain`、`connect`、`depend`、`deploy`、`run` 承载了多种语义。拆分前先运行只读规划器，确认每个模型对的目标类型、边数和需人工确认项；**规划器不写任何数据**。

## 命令

```bash
ongrid-cmdb --plan-relation-split
```

命令会先执行幂等迁移，再输出 JSON 并退出，不启动 HTTP 服务。

## 输出

```json
{
  "rows": [
    {
      "relation_type": "contain",
      "parent_model": "ipam_subnet",
      "child_model": "ipam_address",
      "constraint": "0",
      "edges": 471,
      "target": "ALLOCATED_TO",
      "cmdb_name": "ALLOCATES",
      "inverse_of": "ALLOCATED_TO",
      "review": false,
      "direction_inverted": true
    }
  ],
  "totals": {"ALLOCATED_TO": 471},
  "target_rules": {"ALLOCATED_TO": 1},
  "total_edges": 3574,
  "unresolved_rules": 0,
  "unresolved_edges": 0
}
```

- `edges` 只统计活跃的、两端 CI 也活跃的实例边；
- `review=true` 表示该模型对的语义需要业务确认，不能直接迁移；
- `direction_inverted=true` 表示目标类型的方向与当前存储方向相反，需要 inverse 适配；
- `cmdb_name` / `inverse_of` 对 `contain` 和目标方向相反的 `bind` 出现：CMDB 保留现有存储方向，创建反向命名的类型并声明 `inverse_of`，由 connector 反转端点；
- `UNRESOLVED` 表示没有映射，必须补规则后才能迁移。

## 目标词汇原则

| 当前类型 | 目标 | CMDB 类型（`inverse_of`） | 判定 |
|---|---|---|---|
| `contain` | `PART_OF` | `CONTAINS`（`PART_OF`） | 技术组成：子件属于整体 |
| `contain` | `MEMBER_OF` | `HAS_MEMBER`（`MEMBER_OF`） | 成员属于聚合：集群→实例、团队→成员 |
| `contain` | `BELONGS_TO` | `HAS_BELONGING`（`BELONGS_TO`） | 业务/组织归属：产品线→产品、部门→团队 |
| `contain` | `LOCATED_IN` | `HAS_LOCATION`（`LOCATED_IN`） | 物理位置：机房→机柜→设备 |
| `contain` | `ALLOCATED_TO` | `ALLOCATES`（`ALLOCATED_TO`） | IPAM 分配：子网→地址 |
| `deploy` / `run` | `RUNS_ON` | `RUNS_ON` | 工作负载→宿主 |
| `depend` | `DEPENDS_ON` | `DEPENDS_ON` | 运行时依赖 |
| `connect` | `POWERED_BY` | `POWERED_BY` | 供电链；当前方向是 provider→consumer，目标方向相反 |
| `connect` | `CONNECTS_TO` | `CONNECTS_TO` | 逻辑连接；有 APM 证据后再细化为 `CALLS` |
| （新增） | `CALLS` | `CALLS` | 同步服务调用：调用方→被调用方，故障沿反方向传播 |
| `bind` | `UNDER_CONTRACT` | `COVERS`（`UNDER_CONTRACT`） | SLA/合同覆盖资源；CMDB 存合同→资源，目标读资源→合同 |

结构类目标（`PART_OF` / `MEMBER_OF` / `BELONGS_TO` / `LOCATED_IN` / `ALLOCATED_TO`）读作 `部分→整体`，与 CMDB 现有 `contain` 的存储方向相反。直接改名会反转 1634 条边，并且 36 条 one2many 规则会变成 CMDB 不支持的 many2one；因此拆分保留存储方向，用反向命名的 CMDB 类型 + `inverse_of` 适配。

`bind` 同理：CMDB 存 `sla→service`（合同→资源），topocortex `UNDER_CONTRACT` 读资源→合同；1 条 `sla→service` 规则是 one2many，不能翻转，因此改为 `COVERS` 并声明 `inverse_of=UNDER_CONTRACT`。只迁移 `sla→service` 这一确定模型对；其他 `bind` 模型对进入未解析/人工确认，不会被全局改写。

## 需要人工确认的行

规划器会把这些行标为 `review`：

- `connect` 供电链：`power_source/ups/breaker/pdu/dcim_rack`，方向需要反转；
- `connect service→service`：可能是 `CALLS`，但当前没有 APM 证据；
- `depend service→application`：业务归属 `BELONGS_TO` 还是运行时依赖 `DEPENDS_ON`；
- `application` 下的 `circuit/env_monitor/accounts/apple_profiles/certificate`：归属还是其他关联；
- `db_cluster→database`：组成还是成员；
- `dcim_server_room` 下的供电设备：位置还是供电依赖；
- `demo111` / `hello1111`：测试数据，应优先清理而不是迁移；
- `bind` 的其他模型对：只自动迁移 `sla→service`；其他对可能是用户自定义关联，保持未解析并留在原类型。

### topocortex 前置依赖

`COVERS.inverse_of=UNDER_CONTRACT` 记录的是目标映射，但当前 topocortex 只在 `docs/examples/enterprise-aiops` 示例中声明 `UNDER_CONTRACT`，运行时 seed 没有该类型，也没有 `Service→Contract` 的反向声明。connector 在导出 OWL `inverseOf` 前必须先让 topocortex：

1. 在运行时本体声明 `UNDER_CONTRACT`；
2. 声明 CMDB `sla` 对应的 Contract/ServiceOffering 类及资源→合同的端点对；
3. 通过同步把确认后的语义写回 CMDB 镜像（CMDB 的语义字段只读）。

在此之前，CMDB 的 `COVERS` 类型可正常读写和展示，`inverse_of` 仅作为迁移意图保留。

## 执行拆分

确认规划后，用同一个二进制执行：

```bash
# 只报告，不写
ongrid-cmdb --split-relations --dry-run

# 真实执行（单事务）
ongrid-cmdb --split-relations
```

执行内容：

1. 创建 `RUNS_ON`、`DEPENDS_ON`、`POWERED_BY`、`CONNECTS_TO`、`COVERS`（已存在则保留）；
2. `deploy`/`run` 的模型规则和实例边改为 `RUNS_ON`；
3. `depend` 改为 `DEPENDS_ON`；
4. 供电链改为 `POWERED_BY`，模型规则端点与实例边端点同时交换（供电链是 many2many / one2one，翻转安全）；
5. `connect service→service` 改为 `CONNECTS_TO`；
6. `contain` 按模型对改为 `CONTAINS` / `HAS_MEMBER` / `HAS_BELONGING` / `HAS_LOCATION` / `ALLOCATES`，只改关系类型、不交换端点；新类型声明对应的 `inverse_of`，`CONTAINS` 同时标记 `transitive`；
7. `bind` 的 `sla→service` 规则和边改为 `COVERS`，只改关系类型、不交换端点，声明 `inverse_of=UNDER_CONTRACT`；
8. `demo111` / `hello1111` 的规则和边软删除，CI 类型与实例保留；
9. 旧类型 `bind`/`deploy`/`run`/`depend`/`connect`/`contain` 在没有活跃规则和边后标记 deprecated，并写 `replacement`。

命令是幂等的：第二次执行应返回 0 重分类、0 删除。
只在有对应规则时才创建目标类型，因此不含 `contain` 或 `bind` 规则的库不会产生对应的空类型。

### 弃用后的写入约束

拆分后旧类型仍保留在字典里（`deprecated=true` + `replacement`），但不再可用于新数据：

- 新建模型规则：拒绝已弃用类型；已有规则可以继续用原类型修改基数或属性映射，避免历史配置无法编辑；
- 新建实例边或把边改成已弃用类型：拒绝；重复提交已存在的旧边是幂等 no-op，不会被拒绝；
- 内置模型 bootstrap 直接使用迁移后的目标词汇（DCIM 用 `HAS_LOCATION`，IPAM 用 `CONTAINS`/`ALLOCATES`），类型缺失时按共享语义创建，不依赖旧类型；
- `GET /v1/cmdb/relation-types?include_deprecated=false` 只返回可用类型；控制台的模型关系下拉使用该参数，关系类型管理页仍显示全部并标注 deprecated；
- AIOps `cmdb_list_relation_types` 仍返回完整字典（含 deprecated/replacement），由调用方判断。

保留旧边是为了可回滚；回滚到旧类型需要按备份恢复或单独的数据迁移。

### 目标词表的显式初始化

拆分命令只为有存量规则的来源类型创建目标词。`CALLS` 这类没有旧规则可拆的词，以及新库上只由内置 bootstrap 创建的三类结构词，需要显式初始化：

```bash
# 只报告缺少哪些类型
ongrid-cmdb --ensure-relation-vocabulary --dry-run

# 创建缺失的类型（单事务）
ongrid-cmdb --ensure-relation-vocabulary
```

命令按 `internal/cmdb/biz/ci.TargetRelationTypes()` 创建缺失类型，写入 category、direction、propagates、weight、inverse_of、transitive、显示名和 revision；已存在的行（topocortex 同步、运营编辑或早先拆分创建）不覆盖，可重复执行。

`CALLS` 的方向是调用方→被调用方，`category=dependency`、`direction=dst_to_src`、`propagates=true`、`weight=0.9`，用于同步 API/RPC 调用。异步消息不应使用 `CALLS`；`PUBLISHES_TO`/`SUBSCRIBES_TO` 尚未加入词表。`connect service→service` 的存量边仍保留为 `CONNECTS_TO`，等 APM/Trace 证据出现后再逐条细化为 `CALLS`。

### 执行前

1. 全量备份 MySQL 并记录 binlog 位点；
2. 在 staging 用生产快照执行 `--split-relations --dry-run`，核对行数和边数；
3. 确认 `manage` 不在本次范围内（它同样依赖 `inverse_of` 适配，尚未拆分）；
4. 生产执行放在低峰窗口；命令是一个事务，失败整体回滚。

### 回滚

- 规则和实例边是原地更新，没有保留旧值；回滚依赖执行前的备份；
- demo/test 的边和规则是软删除，可用 `deleted_at = NULL, delete_marker = 0` 按 ID 恢复；
- 新类型可以保留（未被引用的类型不参与图），旧类型的 deprecated 标记可清除。

## 不在本规划内

- `install`：启动时的语义回填已标记 `deprecated=true`、`replacement=RUNS_ON`，且无规则/边引用；只剩可选的字典删除，需要逐部署确认后再做；
- `manage` 的数据方向：由 `inverse_of` 适配，不翻转；
- 实例边迁移本身：需要备份、dry-run、双写/对账和回滚，不能在规划器里执行。
