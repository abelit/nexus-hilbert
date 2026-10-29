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
| `ONGRID_CMDB_FILE_DIR` | 本地附件目录，容器内默认 `/var/lib/ongrid/cmdb-files`；compose 会把它 bind-mount 到 `${ONGRID_DATA_DIR}/cmdb-files`。 |
| `ONGRID_CMDB_FILE_BACKEND` | 首次启动的 backend：`local`（默认）或 `s3`。 |
| `ONGRID_CMDB_S3_ENDPOINT_URL` / `_ACCESS_KEY` / `_SECRET_KEY` / `_BUCKET_NAME` / `_REGION` / `_USE_SSL` | S3 首次启动默认值，用于预填管理页；compose 默认指向内置 RustFS。 |
| `ONGRID_CMDB_FILE_PREVIEW_URL` | kkFileView 的浏览器地址；留空时由 `ONGRID_PUBLIC_URL + /file-preview/onlinePreview` 派生。 |
| `ONGRID_CMDB_FILE_FETCH_BASE_URL` | kkFileView 拉取签名附件的 CMDB 地址，默认 `http://ongrid-cmdb:8082`；可在「设置 → 文件预览 → 文件访问地址」运行时修改。 |
| `ONGRID_CMDB_FILE_PREVIEW_INTERNAL_URL` | CMDB 侧探测 kkFileView 的内部地址，默认 `http://kkfileview:8012`。 |
| `ONGRID_CMDB_FILE_MAX_MB` | 管理员保存存储设置前的单文件上限，默认 `50`。 |
| `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` | 内置 RustFS 凭据；`install.sh` 会生成 blank 的 secret。 |
| `RUSTFS_REGION` / `ONGRID_RUSTFS_IMAGE` | RustFS 区域（默认 `us-east-1`）与镜像覆盖。 |
| `ONGRID_OTEL_ENDPOINT` / `ONGRID_OTEL_SAMPLING_RATIO` | 可选；默认 `tempo:4318`，采样 `1`。 |

## 文件存储与预览

CMDB 文件属性的附件由 `ongrid-cmdb` 自己管理；compose 同时提供内置 RustFS（S3 兼容对象存储）和 kkFileView：

- 默认本地存储写在 `${ONGRID_DATA_DIR}/cmdb-files`，容器内 `/var/lib/ongrid/cmdb-files`，运行用户 uid `65532`。该目录已加入 `install.sh` / `upgrade.sh` 的目录权限初始化，需要纳入备份。
- `rustfs` 使用 `${ONGRID_DATA_DIR}/rustfs`（uid `10001`），S3 API 只在 `127.0.0.1:9000` 暴露，控制台在 `127.0.0.1:9001`；默认镜像沿用 cantor 的 `harbor.it.cgzair.com/rustfs/rustfs:latest`，无法拉取时用 `ONGRID_RUSTFS_IMAGE` 指向可访问的 RustFS 镜像。CMDB 通过 compose 网络使用 `http://rustfs:9000`；首次上传/测试会自动创建 `cmdb-files` bucket。
- 在「设置 → 文件存储」切到 S3/MinIO 即可使用 RustFS；S3 字段已由 compose 预填。切换不会迁移旧文件，旧附件仍按上传时记录的 backend 读取。多副本部署应使用共享 S3，而不要依赖单机 RustFS 卷。
- 本地单文件默认上限 50 MB；nginx 对 `/api/v1/cmdb/` 使用 60 MB 的请求上限以容纳 multipart 开销。调大单文件上限时同步调整 nginx 和 `ONGRID_CMDB_FILE_MAX_MB`。
- 预览由内置 kkFileView 提供，nginx 将其挂在同源的 `/file-preview/`；`ONGRID_CMDB_FILE_PREVIEW_URL` 留空时自动使用 `${ONGRID_PUBLIC_URL}/file-preview/onlinePreview`。kkFileView 必须能访问 CMDB 的签名预览 URL：「设置 → 文件预览 → 文件访问地址」控制该地址，内置 compose 默认 `http://ongrid-cmdb:8082`，留空则回退到前端构建时的 `VITE_FILE_API_BASE_URL` 或浏览器 origin。若前后端分离或 kkFileView 不在 compose 网络内，在这里填写 kkFileView 能访问的 CMDB 地址（如 `http://host.docker.internal:5000`），无需重新构建前端。未配置预览服务时附件仍可下载。

管理接口（`/api/v1/cmdb`，JWT）：

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET/PUT/POST | `/file-storage`, `/file-storage/test` | admin |
| GET | `/file-preview` | 任意已认证用户（预览组件需要） |
| PUT/POST | `/file-preview`, `/file-preview/test` | admin |
| POST/GET/DELETE | `/ci/files` | 任意已认证用户 |
| POST | `/ci/files/preview-url` | 任意已认证用户 |
| GET | `/ci/files/public/{capability}` | 无 Bearer；短期 HMAC capability |

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
