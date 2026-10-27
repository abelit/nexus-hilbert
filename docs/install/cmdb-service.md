# CMDB 独立服务部署说明

CMDB 从 manager 进程拆出后由 `ongrid-cmdb` 独立提供服务。manager 继续提供登录、设备、监控、告警等 API；nginx 按路径把 `/api/v1/cmdb/*` 转给 CMDB。

## 服务与端口

| 服务 | 容器端口 | 宿主机端口 | 用途 |
| --- | --- | --- | --- |
| `ongrid` | 8080 / 9100 | 仅 9100 | manager API 与 metrics |
| `ongrid-cmdb` | 8082 / 9102 | 仅 `${ONGRID_CMDB_METRICS_PORT:-9102}` | CMDB API 与 metrics |
| `ongrid-nginx` | 443 / 80 | `${ONGRID_HTTP_PORT:-443}` 等 | TLS、SPA、反代 |

CMDB API 不直接发布到宿主机；外部访问走 `https://<host>/api/v1/cmdb/*`。

## 必需环境变量

| 变量 | 说明 |
| --- | --- |
| `ONGRID_JWT_SECRET` | 与 manager 必须一致；CMDB 只验签。轮换时同时更新两个容器。 |
| `ONGRID_SECRET_KEY` | `secretbox` 的 at-rest key；发现账号与触发器凭据依赖它。未设置时回退到 JWT 派生 key，但仍建议显式设置。 |
| `ONGRID_DB_DSN` | 默认由 install compose 用 `MYSQL_PASSWORD` 拼出，指向同一个 `ongrid` 库。 |
| `ONGRID_CMDB_HTTP_ADDR` / `ONGRID_CMDB_METRICS_ADDR` | 默认 `:8082` / `:9102`，一般不需要改。 |
| `ONGRID_CMDB_DB_MAX_OPEN_CONNS` / `ONGRID_CMDB_DB_MAX_IDLE_CONNS` | 默认 `20` / `5`；与 manager 的 `50` / `10` 一起计入 MySQL 连接预算。 |
| `ONGRID_CMDB_METRICS_PORT` | 宿主机 metrics 端口，默认 `9102`。 |
| `ONGRID_OTEL_ENDPOINT` / `ONGRID_OTEL_SAMPLING_RATIO` | 可选；默认 `tempo:4318`，采样 `1`。 |

## 健康检查

```bash
# 容器内 liveness
docker exec ongrid-cmdb /ongrid-cmdb --healthcheck

# compose healthcheck 状态
docker inspect --format '{{.State.Health.Status}}' ongrid-cmdb

# 通过 nginx 的 readiness（安装/升级也用它）
curl -fsSk https://localhost/cmdb-readyz

# 业务健康（需要 bearer token）
curl -fsSk -H "Authorization: Bearer $TOKEN" https://localhost/api/v1/cmdb/health
```

`/healthz` 只表示进程存活；`/readyz` 还要求数据库可达且 `c_schema_meta` 存在。首次启动或升级时 CMDB 需要先跑完 AutoMigrate，ready 之前 nginx 会返回 502。

## 升级顺序

1. 拉取新镜像（install/upgrade 脚本用 `docker compose config --images` 自动包含 `ongrid-cmdb`）。
2. 同时 recreate `ongrid` 与 `ongrid-cmdb`。**不要**只升级 CMDB 而保留旧 manager：旧 manager 仍挂载 CMDB 路由，两个进程会竞争同一批表。
3. 等待 `/healthz` 与 `/cmdb-readyz` 同时通过。`upgrade.sh` 在任一失败时退出 1，并保留上一版 Edge 资产以便诊断。

CMDB 的迁移锁是 MySQL advisory lock `ongrid_cmdb_schema`。多副本启动时只有一个实例执行 AutoMigrate，其余等待；SQLite 本地模式使用数据库文件旁的 `.migrate.lock`。

## 回滚

- 恢复上一版 `deploy/install/docker-compose.yml`、`nginx.conf` 和 `ONGRID_VERSION`，重新 `up -d`。上一版 manager 会重新挂载 `/v1/cmdb`。
- CMDB 表只做增量变更，旧版本可忽略新增表；若新版本已写入旧代码不认识的数据，回滚前先备份数据库。
- 只回滚 `ongrid-cmdb` 服务时，`/api/v1/cmdb/*` 返回 502，manager 其它 API 不受影响；这适合先隔离 CMDB 故障。

## 从 nexus-cantor 迁移 CMDB 数据

`ongrid-cmdb migrate-cantor` 把 cantor 的 CMDB 行复制到当前 `ongrid` 库。它是**一次性数据导入**，不是原地接管：源库只读，目标保留自己的 `c_schema_meta`、迁移锁和 hilbert 原生表结构。导入完成后，源 cantor 库可以继续保留作为回滚副本。

### 前置条件

- 源是 cantor 使用的 MySQL 库（cantor 只有 MySQL 后端）；建议使用只读账号。
- 目标是 CMDB 使用的同一个 `ongrid` 库；先备份目标库。
- 迁移期间停止 manager 与 CMDB 的写入，避免用户在导入过程中看到半页数据：

  ```bash
  docker compose -f deploy/docker-compose.yml stop ongrid ongrid-cmdb nginx
  ```

  只读演练可以在服务运行时执行；正式导入建议停写。
- 非 `--dry-run` 会先通过 CMDB 的迁移锁执行目标 schema 迁移；目标首次使用也可以先启动一次 CMDB。

### 演练

```bash
export ONGRID_CANTOR_DSN='cantor_ro:REPLACE_ME@tcp(cantor-db-host:3306)/cmdb?parseTime=true&charset=utf8mb4'
export ONGRID_DB_DSN='ongrid:REPLACE_ME@tcp(127.0.0.1:3306)/ongrid?parseTime=true&charset=utf8mb4'

go run ./cmd/ongrid-cmdb migrate-cantor \
  --source-dsn "$ONGRID_CANTOR_DSN" \
  --target-dsn "$ONGRID_DB_DSN" \
  --dry-run
```

`--dry-run` 会逐表读取、变换并校验必填列，但不写数据、不创建用户、也不改 schema。输出的 `source=<行数>` 应与源库一致。

### 正式导入

```bash
go run ./cmd/ongrid-cmdb migrate-cantor \
  --source-dsn "$ONGRID_CANTOR_DSN" \
  --target-dsn "$ONGRID_DB_DSN" \
  --users=create \
  --batch-size=500
```

在安装目录中也可以直接使用镜像内的同一个二进制：

```bash
docker compose run --rm --entrypoint /ongrid-cmdb ongrid-cmdb migrate-cantor \
  --source-dsn "$ONGRID_CANTOR_DSN" \
  --target-dsn "$ONGRID_DB_DSN"
```

导入完成后启动服务：

```bash
docker compose -f deploy/docker-compose.yml up -d ongrid ongrid-cmdb nginx
curl -fsSk https://localhost/cmdb-readyz
```

### 用户归属

- `--users=create`（默认）按 email 复用目标 IAM 用户；被 CMDB 数据引用、但目标不存在的 cantor 用户会创建为 **disabled、空密码** 的身份，历史页因此能显示姓名而不是 `#uid`。没有任何 CMDB 行引用的 cantor 用户不会导入。cantor 的内置管理员（uid 1）复用目标超级管理员。
- 源库已删除、但历史仍引用的 uid 会创建 `cantor-uid-<uid>@invalid.local` 占位身份。
- `--users=preserve` 保留 cantor 数字 uid，历史页对未知用户显示 `#uid`。
- `--users=admin` 把所有数字引用归到目标管理员；只建议在源用户表不可用时使用。
- 导入不会复制 cantor 密码，也不会让新建身份可登录。

### 密文与文件

- cantor `c_attributes.choice_web_hook`、`c_c_t_t.notify` 和 auto-discovery 账号 `c_ad_accounts.config` 里的凭据是用 cantor 的 `SECRET_KEY`/InnerCrypt 加密的。导入按**不透明密文**原样保存，不解密、不落日志；CMDB 的读写路径本来就把这类值视为不可解密。需要在 hilbert 中继续使用的凭据，请在对应属性/触发器/发现账号里重新录入。
- `is_file` 属性的数据库行会保留，但 cantor 的上传文件本体不在 MySQL 中，未复制；CMDB 当前也没有文件下载端点。

### 跳过与限制

导入报告会列出跳过的源表及行数。以下内容不会进入目标：

- `c_c_d`、`c_dashboard`、`c_data_source`：看板/BI，另立 Epic；
- ACL/权限表（`c_ci_filter_perms`、`c_cfp` 等）：权限由 hilbert IAM 承担；
- `c_kv`、`c_sc`：cantor 原始配置；
- `c_ad_counter`：目标从 `c_ad_ci` 实时计数；
- 三个 deprecated 的 `c_value_integers/floats/datetime`：cantor 不再写入。

`c_cis.props_json` 导入时为空文档。列表/详情读取会回退到 EAV 值表（本分支同时修复了无 `fields` 参数时不回退的问题）；下一次编辑实例时会重新生成快照。导入不会把 `c_schema_meta` 改成 `adopted-cantor`：目标是新建 schema，`fresh` 描述的是 schema 血缘，不是数据来源。

### 验收

1. 导入报告逐表 `source == imported`，`live` 与源 `deleted=0` 一致。
2. 带管理员 token 验证：

   ```bash
   curl -fsSk -H "Authorization: Bearer $TOKEN" https://localhost/api/v1/cmdb/ci-types
   curl -fsSk -H "Authorization: Bearer $TOKEN" 'https://localhost/api/v1/cmdb/ci-types/server/instances?page=1&count=2'
   curl -fsSk -H "Authorization: Bearer $TOKEN" 'https://localhost/api/v1/cmdb/history/attributes?page=1&count=2'
   curl -fsSk -H "Authorization: Bearer $TOKEN" https://localhost/api/v1/cmdb/topology-views
   ```

   实例列表即使不带 `fields` 也应返回值；历史里的 password/link/file 字段应为 `******`。
3. 拓扑视图若来自 cantor，`path` 里的 `"0"` 是中心模型层，服务会忽略该层、从正/负层开始遍历。

### 回滚

- 导入前备份目标库；回滚时恢复该备份即可。
- 工具默认拒绝任何非空的 CMDB 目标表；只有确认是上次中断的部分导入时才用 `--resume`（按主键 upsert）。
- 工具不删除源数据，也不 DROP/CREATE 目标表；删除目标数据需要人工按备份恢复。
- 新建的 disabled IAM 用户会留在 `users` 表；回滚目标库会一并恢复。若只回滚 CMDB 数据，手工禁用/删除这些身份。

### 已知限制

- 源字段与目标字段同名时才复制；目标新增列由目标 schema 的默认值补齐。目标 `NOT NULL` 且无默认值的列遇到源 NULL 会中止并报告表/列，不会静默填值。
- cantor 的 `deleted` 布尔转为 `delete_marker`；`deleted_at` 为空时用 `updated_at`/`created_at` 补。`NULL` 的 `deleted` 按未删除处理。
- 目标表没有数据库级外键；导入按固定表顺序执行，报告与验证按行数/存活数校验，不依赖级联。
- 源 `c_topology_views.path` 的字符串 ID、`c_ci_type_relations` 的 JSON 数组、ADC 的 JSON 文档都按原 JSON 复制；转换只在行级标量（用户 ID、软删除、必填默认值）发生。

## 排障

```bash
docker compose -f /opt/ongrid/docker-compose.yml logs --tail=200 ongrid-cmdb
docker compose -f /opt/ongrid/docker-compose.yml logs --tail=200 nginx
curl -fsSk https://localhost/api/v1/cmdb/health -H "Authorization: Bearer $TOKEN"
```

- `readyz` 503 且日志有 `cmdb schema missing`：迁移未完成或数据库连错。
- 502 且 `ongrid-cmdb` 容器在重启：看日志中的 `run cmdb migrations` 或 DSN 错误。
- 401：确认两个容器的 `ONGRID_JWT_SECRET` 一致，且浏览器 token 未过期。
- 403：CMDB 的写接口按 admin gate 拒绝；用管理员账号或检查 JWT 的 `role`/`is_superuser`。
