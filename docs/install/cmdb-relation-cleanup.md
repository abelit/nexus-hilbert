# CMDB 关系数据清理

`ongrid-cmdb` 提供一个显式的关系清理命令，用于移除审计发现的语义噪声。它不是启动副作用，必须先 dry-run，再在 staging 或经过备份的生产环境执行。

## 命令

```bash
# 只统计关系清理，不软删关系边
ongrid-cmdb --cleanup-relations --dry-run

# 真实执行（软删除关系边）
ongrid-cmdb --cleanup-relations
```

命令会先执行 `cmdbdata.Migrate`（AutoMigrate、语义回填、复合索引），然后输出 JSON 报告并退出，不启动 HTTP 服务。

> `--dry-run` 只跳过关系边的软删除。**它不是“完全不写库”**：命令启动时仍会跑幂等迁移，首次运行可能加列、建索引并回填 8 个关系类型的语义字段。关系边本身不会被修改。已有迁移完成后再跑才是纯只读。

## 清理的三类数据

| 类别 | 定义 | 本地 dev 基线（2026-11-08） |
|---|---|---:|
| 自环边 | `first_ci_id = second_ci_id` | 271 |
| 孤儿边 | 没有活跃正向模型规则的边；**不含已计入自环的行** | 15 |
| 重复边 | 同一 `(first_ci_id, second_ci_id, relation_type_id, ancestor_ids)` 保留最小 id，其余删除 | 1 |
| 合计 | 非重叠并集 | **287** |

> 审计报告中的“135 条孤儿边”包含 120 条自环。清理报告把自环先排除，因此孤儿边显示为 15；两者合计仍是 287，不重复计数。

## 输出

```json
{
  "dry_run": true,
  "self_loops": 271,
  "orphan_edges": 15,
  "duplicate_edges": 1,
  "total": 287,
  "ids": {
    "self_loops": [1, 2],
    "orphan_edges": [3],
    "duplicate_edges": [4]
  },
  "ids_truncated": false
}
```

- `total` 是本次会软删的行数；
- `ids` 每类最多返回 1000 个，超出时 `ids_truncated=true`，计数仍完整；
- 第二次真实执行应返回 `total: 0`。

## 执行前

1. 全量备份 MySQL（`mysqldump`）并记录 binlog 位点；
2. 在 staging 用生产快照跑一次 `--dry-run`，核对 `total` 和抽样 ID；
3. 确认没有业务依赖这些自环/孤儿边（尤其是 `service→service`、`application→application`）；
4. 生产执行放在低峰窗口；命令是一个事务，失败会整体回滚。

## 回滚

清理是软删除：`delete_marker` 置 1、`deleted_at` 置当前时间。用报告里的 ID 恢复：

```sql
UPDATE c_ci_relations
SET deleted_at = NULL, delete_marker = 0
WHERE id IN (/* 报告中的 ids */);
```

如果报告被截断，按类别重新查询被软删的行（`delete_marker <> 0`）或从备份恢复。

## 不在本命令范围内

- 关系类型重命名/拆分、`manage`/`contain` 方向迁移；
- 模型规则修正；
- 关系历史（只追加，不重写）；
- demo/test CI 与关系类型的清理。

这些是独立的迁移步骤，不能和本命令混在一次执行里。
