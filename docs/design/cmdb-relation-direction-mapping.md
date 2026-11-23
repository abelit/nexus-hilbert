# CMDB ↔ nexus-topocortex 关系方向映射

CMDB 里有几类关系的存储方向与 topocortex 的目标词汇相反。**不要翻转 CMDB 的实例边或模型规则**；由 connector 根据 `c_relation_types.inverse_of` 反向读取。

## 映射

| CMDB 类型 | CMDB 存储方向 | topocortex 目标 | topocortex 方向 | `inverse_of` |
|---|---|---|---|---|
| `contain` | 整体 → 部分 | `PART_OF` | 部分 → 整体 | `PART_OF` |
| `MANAGES`（legacy `manage`） | 人员/团队 → 资源 | `OWNED_BY` | 资源 → 负责人/团队 | `OWNED_BY` |
| `bind` / `COVERS` | 合同/SLA → 资源 | `UNDER_CONTRACT` | 资源 → 合同 | `UNDER_CONTRACT` |
| `HAS_INSTANCE` | 应用服务 → 实例 | `REPLICA_OF` | 实例 → 应用服务 | `REPLICA_OF` |

`HAS_INSTANCE` 的 inverse 目标是 `REPLICA_OF`，不是 `INSTANCE_OF`：topocortex 的运行时常量已经是 `REPLICA_OF`，`INSTANCE_OF` 不再是运行时 seed 的类型。

`manage` 是旧 CMDB 主动式词；迁移会把唯一的 `manage` 行原地改名为 `MANAGES`，保留 `inverse_of=OWNED_BY`。模型规则和实例边引用的是 `relation_type_id`，所以改名不移动数据；但按**名称**查询的外部脚本需要改用 `MANAGES` 或 relation type id。如果部署里已经同时存在 `MANAGES`，`manage` 保留为 `deprecated` 别名并指向 `MANAGES`，不删除，避免已有规则/边悬空；这些旧规则在投影计划里会列为需要迁移到 `MANAGES` 的 unresolved 项。

其余类型（`deploy`、`run`、`depend`、`connect`）的存储方向与当前 topocortex 映射一致或为双向，不声明 inverse。`bind` 已由拆分命令迁移为 `COVERS`；拆分前它同样是合同→资源，方向映射不变。

## 语义镜像

CMDB 关系类型行同时保存两套字段：

- `category` / `direction`：CMDB 本地字段，分别服务控制台分组和 manager AIOps 的 `downstream`/`upstream` 计算；
- `topocortex_category` / `traits`：topocortex 的闭集类别与 AIOps trait；对 `inverse_of` 类型，`traits` 描述的是 `inverse_of` 命名的目标类型（例如 `CONTAINS` 的 `traits=structural_rollup` 来自 `PART_OF`）。

connector 必须读 `topocortex_category`/`traits`，不能从本地 `category` 推断；`direction` 也不能直接当作 topocortex 的方向使用。

### 别名

`c_relation_types.aliases` 是 CMDB 本地的查找/展示别名，不是关系类型的身份，也不投影到 topocortex：

- `name` 仍是唯一身份和 connector 映射键；
- 别名不能等于自身 `name`，不能重复，不能与其他 live 类型的 `name` 或别名冲突；
- `POST`/`PUT /v1/cmdb/relation-types` 接受 `aliases`；`PUT` 是整表替换，省略/空数组即清空；
- 控制台关系类型页显示别名，并用逗号分隔的输入编辑；
- 外部按名称查找时可以同时匹配 `name` 与 `aliases`（是否启用取决于调用方）；内部 connector 不使用别名。

### 展示名、描述与颜色

`display_name_zh`、`display_name_en`、`description`、`color` 是 CMDB 行数据，不是代码里的词表常量：

- 词表命令、拆分和启动回填只写身份与语义字段；新建行可以让展示字段为空，控制台回退到 `name`；
- `POST`/`PUT /v1/cmdb/relation-types` 接受 `display_name_zh`、`display_name_en`、`description`，`color` 和 `aliases` 的既有写入语义不变；
- 控制台按当前语言显示对应展示名，缺失时回退另一语言，最后回退 `name`；
- 这些字段不投影到 topocortex，connector 仍只读 `name` 与语义镜像。

模型规则写入还有一道语义门禁：关系类型的 `revision >= 1`（由词表命令、拆分或 topocortex 同步管理）时，必须带 `topocortex_category` 或 `traits`，否则 `SaveTypeRelation` 返回 `ErrRelationTypeSemanticsMissing`。`revision = 0` 的遗留或管理员手工创建类型视为 local-only：可用于 CMDB 模型规则，但不投影到 topocortex/AIOps。`GET /v1/cmdb/relation-types` 返回 `ontology_ready`，connector 只投影 `ontology_ready=true` 的行。

## 为什么不能直接翻转

翻转 `first_ci_id`/`second_ci_id` 和模型规则的 `parent_id`/`child_id` 会把基数一并反转：

| 类型 | one2many 规则 | many2many 规则 |
|---|---:|---:|
| `contain` | 36 | 6 |
| `MANAGES`（legacy `manage`） | 6 | 4 |
| `bind` | 1 | 0 |

CMDB 的 `constraint` 只有 `0` 一对多、`1` 一对一、`2` 多对多（`internal/cmdb/model/const.go`），没有 many2one。翻转后 43 条一对多规则会变成 CMDB 无法表达的 many2one，写入校验和层级查询都会失真。

## Connector 行为

1. 读取 `c_relation_types.inverse_of`；
2. 对命中的类型，在写入 topocortex 前交换 `source` / `target`；
3. 在读取 topocortex 的关系时再交换回来；
4. 边上的属性（协议、置信度、时间）随端点一起保留，不重命名；
5. 模型规则的基数不反转，只在 connector 的目标声明中按 topocortex 的 source/target 语义重新表达。

如果未来要让 CMDB 原生采用 topocortex 方向，需要先增加 many2one 基数编码并做双写/对账；这是独立迁移，不属于本次 `inverse_of` 适配。

## 回填规则

`cmdbdata.Migrate` 在语义回填之后执行一次 `backfillInverseRelationTypes`：

- 只处理 `inverse_of = '' AND revision >= 1` 的 `contain` / `MANAGES`（以及尚未改名的 legacy `manage`）；
- 写入 `PART_OF` / `OWNED_BY`；
- 只在 `revision < 2` 时把 revision 提到 2；
- 已有 `inverse_of`（例如 topocortex 同步写入）不会被覆盖。

`COVERS` 是由 `--split-relations` 创建的新类型，创建时直接写入 `inverse_of=UNDER_CONTRACT`，不经过启动回填。回填列表不需要加入 `bind`，因为迁移后它只剩 deprecated 别名。

验证：

```sql
SELECT name, inverse_of, revision, deprecated, replacement
FROM c_relation_types
WHERE name IN ('contain', 'MANAGES', 'manage', 'COVERS');
-- contain | PART_OF  | 2 | 0 | ''
-- MANAGES | OWNED_BY | 2 | 0 | ''
-- manage  | OWNED_BY | 2 | 1 | MANAGES   (only when both rows pre-existed)
-- COVERS  | UNDER_CONTRACT | 1 | 0 | ''
```

### topocortex 前置条件

`COVERS.inverse_of=UNDER_CONTRACT` 是 CMDB 侧的目标映射记录。topocortex 目前只在 `docs/examples/enterprise-aiops` 示例中声明 `UNDER_CONTRACT`，运行时 seed 尚未包含该类型，也没有 `Service→Contract` 的反向端点对。connector 在导出 OWL `inverseOf` 或做反向推理前，需要 topocortex 先声明该类型和端点对；否则 CMDB 的 `inverse_of` 只能在本地读取，不能完成 topocortex 侧的 `NX-INVERSE-01` 校验。

同样的前置条件适用于其余 inverse 目标：`CONTAINS -> PART_OF`、`HAS_MEMBER -> MEMBER_OF`、`HAS_INSTANCE -> REPLICA_OF`、`HAS_BELONGING -> BELONGS_TO`、`HAS_LOCATION -> LOCATED_IN`、`ALLOCATES -> ALLOCATED_TO`。`PART_OF`、`MEMBER_OF`、`REPLICA_OF` 已在 topocortex 运行时 seed；`BELONGS_TO`、`LOCATED_IN`、`ALLOCATED_TO`、`UNDER_CONTRACT` 目前只在示例或尚未声明，connector 必须在同步前确认或补齐。

方向安全的 `DEPLOYED_TO`、`POWERED_BY`、`CONNECTS_TO` 也没有全部出现在 topocortex 运行时 seed（部分只在 enterprise 示例）。它们保留为 CMDB 目标词，但 connector 在投影前必须先声明对应的 topocortex 类型，或映射到已有类型；不能因为 CMDB 行存在就假定 topocortex 能接收。

API `GET /v1/cmdb/relation-types` 与 AIOps 工具 `cmdb_list_relation_types` 都会返回 `inverse_of`。
