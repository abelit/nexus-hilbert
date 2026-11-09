# CMDB 关系边的来源与证据

关系边不只需要端点：AIOps 还要区分“采集器观察到的”“人手工录入的”“导入的”和“推理出来的”。没有来源，置信度、有效期和影响面权重都无从谈起。

## 两个字段

| 字段 | 用途 | 取值 |
|---|---|---|
| `c_ci_relations.source` | cantor 的一字符枚举，保持原样 | `"0"` 属性推导、`"1"` 自动发现，其余为 NULL |
| `c_ci_relations.evidence_source` | 语义来源，新写入和 AIOps 读取的字段 | 见下表 |

两个字段并存是兼容策略：旧库的 `source` 不动，迁移把已知代码映射为语义值；新代码只写 `evidence_source`，`source` 仅保留 cantor 发现路径的 `"1"`。

## 语义词汇

| `evidence_source` | 含义 | 写入方 |
|---|---|---|
| `manual` | 控制台或 API 手工创建；未指定来源时的默认值 | `AddRelation`、实例创建/更新、DCIM 操作 |
| `import` | Excel/CSV 导入创建 | `CommitImport` |
| `attribute-rule` | 由引用属性推导（旧 `source="0"`） | 迁移回填；后续属性推导写入 |
| `collector:autodiscovery` | 采集器候选被接受（旧 `source="1"`） | `WriteWithRelations(..., markAutoDiscovery=true)` |
| `system:ipam` | 内置 IPAM 操作创建（scope/subnet/address 放置、子网移动） | `CreateScope`、`CreateSubnet`、`AssignAddresses`、`MoveSubnet` |
| `legacy` | 来源未知的历史边；迁移不把它伪装成 manual | 迁移回填 |
| `inference` | 预留给推理引擎写入 | 暂无 |

`confidence`、`observed_at`、`valid_from`/`valid_to`、`evidence_type`/`evidence_id`/`evidence_uri` 已存在模型里。当前只有采集路径写 `observed_at`；其余保持 NULL，表示未知，不用默认值编造。

## 写入规则

1. `addRelationTx` 是唯一写入入口：`EvidenceSource` 为空时写 `manual`，所以新边不会再出现空来源。
2. `WriteSpec.EvidenceSource` 同时作用于容器边和同事务写入的关系边；发现路径额外写 `source="1"` 和 `observed_at`，导入路径写 `import`，IPAM 写 `system:ipam`。
3. 重复提交同一条旧边仍是幂等 no-op，不改变已有来源。
4. API 邻居响应（`GET /ci-relations/{id}/children|parents`）和 AIOps `cmdb_get_ci_relations` 返回 `evidence_source`、`confidence`、`observed_at`；为空时省略，避免制造“已知”的假象。

## 迁移回填

`cmdbdata.Migrate` 在 AutoMigrate 之后执行 `backfillRelationEvidence`：

1. `evidence_source = '' AND source = '0'` → `attribute-rule`；
2. `evidence_source = '' AND source = '1'` → `collector:autodiscovery`；
3. 其余 `evidence_source = ''` → `legacy`（包括软删除行，历史只保留一套词汇）。

已配置的 `evidence_source` 不会被覆盖；回填幂等，重复启动不改变结果。回填只写 `evidence_source`，不修改 `source`。

## 回滚

- 代码回滚即可：旧代码不读 `evidence_source`，新值留在表里不影响读写。
- 回填没有破坏 `source`；如果确实要回到“全空来源”，可按 `evidence_source` 值做一次显式反向更新，但通常没有必要。
- 本变更不涉及列宽或索引变更，不需要数据备份才能回滚；仍建议按常规发布流程备份。

## 验证

```sql
SELECT evidence_source, COUNT(*)
FROM c_ci_relations
WHERE delete_marker = 0 AND deleted_at IS NULL
GROUP BY evidence_source;
```

- 新写入的边不应出现空 `evidence_source`；
- 迁移后的旧库不应再有 `source='0'/'1'` 且 `evidence_source=''` 的行；
- 采集器边应有 `observed_at`。
