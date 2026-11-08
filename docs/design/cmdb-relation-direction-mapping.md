# CMDB ↔ nexus-topocortex 关系方向映射

CMDB 里有两类关系的存储方向与 topocortex 的目标词汇相反。**不要翻转 CMDB 的实例边或模型规则**；由 connector 根据 `c_relation_types.inverse_of` 反向读取。

## 映射

| CMDB 类型 | CMDB 存储方向 | topocortex 目标 | topocortex 方向 | `inverse_of` |
|---|---|---|---|---|
| `contain` | 整体 → 部分 | `PART_OF` | 部分 → 整体 | `PART_OF` |
| `manage` | 人员/团队 → 资源 | `OWNED_BY` | 资源 → 负责人/团队 | `OWNED_BY` |

其余类型（`deploy`、`run`、`depend`、`connect`、`bind`）的存储方向与当前 topocortex 映射一致或为双向，不声明 inverse。

## 为什么不能直接翻转

翻转 `first_ci_id`/`second_ci_id` 和模型规则的 `parent_id`/`child_id` 会把基数一并反转：

| 类型 | one2many 规则 | many2many 规则 |
|---|---:|---:|
| `contain` | 36 | 6 |
| `manage` | 6 | 4 |

CMDB 的 `constraint` 只有 `0` 一对多、`1` 一对一、`2` 多对多（`internal/cmdb/model/const.go`），没有 many2one。翻转后 42 条一对多规则会变成 CMDB 无法表达的 many2one，写入校验和层级查询都会失真。

## Connector 行为

1. 读取 `c_relation_types.inverse_of`；
2. 对命中的类型，在写入 topocortex 前交换 `source` / `target`；
3. 在读取 topocortex 的关系时再交换回来；
4. 边上的属性（协议、置信度、时间）随端点一起保留，不重命名；
5. 模型规则的基数不反转，只在 connector 的目标声明中按 topocortex 的 source/target 语义重新表达。

如果未来要让 CMDB 原生采用 topocortex 方向，需要先增加 many2one 基数编码并做双写/对账；这是独立迁移，不属于本次 `inverse_of` 适配。

## 回填规则

`cmdbdata.Migrate` 在语义回填之后执行一次 `backfillInverseRelationTypes`：

- 只处理 `inverse_of = '' AND revision >= 1` 的 `contain` / `manage`；
- 写入 `PART_OF` / `OWNED_BY`；
- 只在 `revision < 2` 时把 revision 提到 2；
- 已有 `inverse_of`（例如 topocortex 同步写入）不会被覆盖。

验证：

```sql
SELECT name, inverse_of, revision
FROM c_relation_types
WHERE name IN ('contain', 'manage');
-- contain | PART_OF  | 2
-- manage  | OWNED_BY | 2
```

API `GET /v1/cmdb/relation-types` 与 AIOps 工具 `cmdb_list_relation_types` 都会返回 `inverse_of`。
