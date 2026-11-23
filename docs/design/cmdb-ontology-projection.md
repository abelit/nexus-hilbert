# CMDB → topocortex 关系投影计划

日期：2026-11-23

## 目的

`--plan-ontology-projection` 是 connector 的**只读 dry-run**：把 CMDB 的模型关系规则投影成 topocortex 关系声明，先报告能映射什么、需要翻转什么、哪些行必须人工处理。它不写数据库，也不调用 topocortex API。

```bash
ongrid-cmdb --plan-ontology-projection
```

命令会先执行幂等迁移，再输出 JSON 并退出。`blocked=true`（存在 unresolved 或 review）时进程返回 1，apply 步骤必须拒绝执行。

## 映射单位

映射键是 **`(source relation type, parent model, child model)`**，不是单独的关系类型名。同一类型在不同模型对可以有不同方向、基数和语义。

实例边写入与投影使用同一份模型规则：`POST /v1/cmdb/ci-relations/{first}/{second}` 的 `relation_type_id` 必须等于该模型对规则声明的类型，省略时由规则补齐；传一个不同的类型返回 400。这样投影计划不会漏掉“实例边带着模型规则未声明的类型”的情况。

| 项 | 规则 |
|---|---|
| 目标类型 | 类型有 `inverse_of` 时取该值并翻转端点；否则取类型名 |
| 方向 | `inverse_of` 非空 → `invert=true`；connector 交换 source/target，不翻转 CMDB 数据 |
| 基数 | CMDB `0`/空 → `1:N`；`1` → `1:1`；`2` → `N:M`；`invert=true` 时 `1:N ↔ N:1`，`1:1`/`N:M` 不变 |
| 传播 | 默认取 `propagates_default`；`propagates=true` 且 `weight<=0` 时使用 1.0 并标记 review |
| 类别/traits | 取 `topocortex_category` / `traits`，不从本地 `category` 推断 |
| 语义门禁 | `ontology_ready=false`、类型缺失、已弃用 → unresolved |
| 人工确认 | 未知基数、缺失权重、显式 override → review |

## 输出

```json
{
  "rules": 1,
  "edges": 2,
  "resolved_rules": 1,
  "resolved_edges": 2,
  "unresolved_rules": 0,
  "unresolved_edges": 0,
  "review_rules": 0,
  "review_edges": 0,
  "inverted_rules": 1,
  "inverted_edges": 2,
  "blocked": false,
  "samples": ["rack -PART_OF-> room"],
  "mappings": [
    {
      "source_type": "CONTAINS",
      "parent_model": "room",
      "child_model": "rack",
      "target_type": "PART_OF",
      "invert": true,
      "cardinality": "N:1",
      "propagates": false,
      "weight": 0,
      "category": "association",
      "traits": ["structural_rollup"],
      "sample": "rack -PART_OF-> room"
    }
  ]
}
```

- `blocked=true` 当且仅当 `unresolved_rules > 0` 或 `review_rules > 0`。
- `samples` 最多 50 条；超出时 `samples_truncated=true`，不静默截断。
- `mappings` 保留全部规则，供逐条 review。

## 人工确认与 override

纯规划器支持 per-pair override：

```go
relationmap.Override{
    SourceType: "CONTAINS", ParentModel: "room", ChildModel: "rack",
    TargetType: "LOCATED_IN", Invert: &falseValue, Cardinality: "1:N",
    Review: true, Note: "this deployment stores location child->parent",
}
```

override 可改目标类型、方向、基数、传播、权重和 review 标记。CLI 目前不读取 override 文件；这是下一步 P1 的输入。

## 类目/属性投影

关系声明之外，connector 也投影 TBox：

```bash
# 只读计划
ongrid-cmdb --plan-class-projection \
  --class-map=classes.json \
  --class-profile=profiles.json

# 写入 topocortex
ongrid-cmdb --apply-class-projection \
  --topocortex-api-url=http://nexus-topocortex:8080 \
  --class-map=classes.json \
  --class-profile=profiles.json
```

`classes.json` 复用关系投影的 CMDB 模型名 → topocortex 类名映射：

```json
{"dcim_idc": "DataCenter", "dcim_server_room": "Room", "dcim_rack": "Rack"}
```

不传时 identity；传了就是严格映射，缺任何一个被引用模型都会 unresolved。

`profiles.json` 是显式 enrichment，按 CMDB 模型名索引：

```json
{
  "dcim_rack": {
    "display_name": "Rack",
    "domain": "infrastructure",
    "layer": "hardware",
    "roles": ["infrastructure"],
    "semantic_bindings": {"target_id": "rack_name"},
    "parent_override": "Room",
    "attribute_names": {"机柜名": "rack_name"}
  }
}
```

### 属性映射

| CMDB value_type | topocortex |
|---|---|
| `0` int | `int` / `int_list` |
| `1` float | `float` / `float_list` |
| `2` text | `string` / `string_list` |
| `3` datetime | `datetime` / `datetime_list` |
| `4` date | `string`，note 说明无原生类型 |
| `5` time | `string`，note |
| `6` json | `string`，note |
| `7` bool | `bool` / `bool_list` |

- `is_password` → `string` + `sensitivity=secret`；`is_file`/`is_link` → `string` + `sensitivity=confidential`。
- `is_reference` → `int`，note 说明不创建引用关系。
- `is_choice`/`is_computed` 只保留属性类型，note 说明枚举/计算值未投影。
- `is_required` → `constraints.required`。
- `is_index` → `indexed_keys`。
- `CIType.UniqueID` → `identity_keys`（一个 key）。
- `CIType.ShowID` → `display_keys`（一个 key）。
- 子类只投影**自己的属性**；继承属性由 `parent_class` 承担。多继承必须用 `parent_override` 指定主父类，否则 unresolved。
- 类名/属性名必须是 `^[A-Za-z][A-Za-z0-9_]{0,63}$`；中文或不合法标识符通过 `class-map`/`attribute_names` 映射，否则 unresolved。
- `enabled=false` 的模型标记 review，默认阻止 apply。

### TBox apply 语义

- 不存在 → `POST /api/v1/ontology/classes` 一次创建类目和属性。
- 已存在：
  - `parent_class`/`abstract` 不同 → 冲突失败（topocortex 不通过 PATCH 改这两个字段）。
  - 缺失属性 → `POST /classes/{class}/attributes` 补齐。
  - 已有属性类型不同 → 冲突失败，不自动改类型。
  - 其余投影字段通过 `PATCH /classes/{class}` 更新（display/domain/layer/constraints/indexed/display/identity/roles/semantic bindings）；不发送 `parent_class`/`abstract`。
- 不删除 topocortex 已有但 CMDB 没有的属性。
- 类按继承深度排序，父类先于子类；循环继承直接失败。

## Apply

`--plan-ontology-projection` 只读；确认 `blocked=false` 后，用 `--apply-ontology-projection` 写入 topocortex：

```bash
ONGRID_TOPOCORTEX_API_URL=http://nexus-topocortex:8080 \
ongrid-cmdb --apply-ontology-projection

# 或显式传 URL
ongrid-cmdb --apply-ontology-projection \
  --topocortex-api-url=http://nexus-topocortex:8080 \
  --class-map=classes.json
```

`--class-map` 是 CMDB 模型名 → topocortex 类名的 JSON 对象：

```json
{
  "dcim_idc": "DataCenter",
  "dcim_server_room": "Room",
  "dcim_rack": "Rack"
}
```

不传时使用 identity 映射并输出 warning；传了就是**严格映射**，缺任何一个被引用的模型都会在写入前失败。

### 写入顺序

1. 先跑投影计划；`blocked=true` 直接退出，不写 topocortex。
2. `biz/connector.Apply` 全量预检：class mapping、基数、传播/权重、同一目标类型的 metadata 冲突。
3. 逐条 ensure 关系声明：
   - `GET /api/v1/ontology/relations/{type}/{src}/{dst}`
   - 已存在 → `PATCH` cardinality/propagates/weight；非传播边不发送 weight，避免 0→1 churn
   - 不存在 → `POST /api/v1/ontology/relations`，带 `allow_new_type=true`
4. 声明存在后按目标类型名排序，逐类型 `PATCH /api/v1/ontology/relation-types/{name}`，写入 `category`/`traits`/`transitive`/`sub_property_of`。
5. 输出 apply report：`declarations`、`declarations_created`、`declarations_updated`、`relation_types`。

### 约束

- 不设置目标类型的 `inverse_of`：投影只创建声明方向的一侧，避免 topocortex 的 inverse 覆盖门禁因反向声明缺失而拒绝。需要 OWL inverse 时由后续显式的双向投影处理。
- 显示名/描述仍由 topocortex 拥有，connector 只写 AIOps 契约（category/traits/transitive/sub_property_of）。
- **不是跨声明事务**。中途失败会返回已写入的 report 和非 nil error；重跑是幂等的，已存在的声明走 PATCH。
- 目标返回 409（基数/存量边违规）会直接失败，不自动带 `allow_existing_violations`；operator 需先处理存量边。
- 该命令需要能访问 topocortex API；CMDB 只读自己的库。

## 前置条件

- CMDB 侧：关系类型必须 `ontology_ready=true`（`topocortex_category` 或 `traits` 非空）；`revision=0` 的 local-only 类型会被列为 unresolved。
- topocortex 侧：`inverse_of` 目标必须在运行时种子或 connector 声明中存在；`BELONGS_TO`、`LOCATED_IN`、`ALLOCATED_TO`、`UNDER_CONTRACT` 等当前仍只在示例或尚未声明，connector 必须先补齐。
- 不翻转 CMDB 的 `first_ci_id/second_ci_id` 或 `parent_id/child_id`；方向适配只发生在投影层。

## 验证

```bash
go test ./internal/cmdb/biz/relationmap/
go test ./internal/cmdb/biz/classmap/
go test ./internal/cmdb/biz/connector/
go test ./internal/cmdb/data/ci/store/ -run TestPlanOntologyProjection
go test ./internal/cmdb/data/citype/store/ -run TestPlanClassProjection
go test ./internal/cmdb/data/connector/
go test ./cmd/ongrid-cmdb/...
```

真实环境执行前用 staging 快照跑 `--plan-ontology-projection`，确认 `blocked=false`、unresolved/review 均为 0，再进入 apply 阶段。apply 后立即用 topocortex 的 `GET /api/v1/ontology/schema` 和一次 blast-radius/RCA 回归确认声明方向、traits 和传播语义。
