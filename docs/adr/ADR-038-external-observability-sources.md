# ADR-038：外部告警 / 工单源的只读联邦与 CI 监控链接

Status: Accepted — 2026-11-18

## 背景

Nexus-Cantor 有一套面向 CMDB 的观测能力：告警中心、事件中心（钉钉 ITSM 工单）、Grafana 设置、
Prometheus 设置，以及两套「历史设置」。迁移评估发现：

- Cantor 的告警/事件数据不在本地：告警实时查询 **nexus-morse**，事件查询
  **nexus-laplace-dingtalk**；Cantor 只保存连接、CI 映射、中心过滤器和展示列。
- Cantor 用 `incident` 指代 ITSM 工单，而 Ongrid 的 `incident` 是原生告警实例，两者同名不同义。
- Ongrid 已有成熟的原生告警子系统（规则、incident 生命周期、静默、通知、AI 根因分析），
  以及全局 Prometheus / Grafana 集成、原生 panel 渲染、dashboard JSON 代理和深链。
- Cantor 的 Grafana 反向代理会把 service-account token 注入浏览器可达路径；多连接设置与
  Ongrid 的全局集成重复。
- CMDB 是独立 BC / 进程（ADR-035），manager 不得 import `internal/cmdb`，只能通过调用方
  JWT 的 HTTP 客户端访问（ADR-037）；后台上下文没有调用者时 fail-closed。

## 决策

1. **只读联邦，不落库**。外部告警与工单始终由 upstream 拥有；Ongrid 不写入本地 incident 表、
   不做定时同步、不提供 ack/resolve 回写。列表/统计都是实时查询。
2. **一个通用 `federation` 模块**。`kind` 区分 `external_alert`（morse）与 `itsm_ticket`
   （钉钉 ITSM）；连接、CI 映射、过滤器、展示列共享。ITSM 在代码、表、路由中一律称 `ticket`，
   避免与原生 `incident` 冲突。
3. **页面落位**。外部告警是 `/alerts` 的「外部告警」tab；ITSM 事件中心在新增「工单管理」导航下
   的 `/tickets`。不新增第二套告警页。
4. **不迁移 Cantor 的 Grafana / Prometheus 设置**。继续使用 Settings → 集成 的全局连接；
   新增 `ci_monitoring_links` 仅保存「CI 类型 → Grafana 仪表盘 UID / Prometheus 标签」映射，
   连接地址与凭据在 `ci_monitoring_connections`（内部连接不落表）。不实现 Grafana 反向代理，
   也不在全局集成上做多连接。
   CI 监控连接支持 **内部**（平台全局集成，只读投影，不落表）与 **外部**（管理员命名的
   Grafana/Prometheus，独立地址与 secretbox 加密凭据，支持 test/health）；链接通过可空
   `connection_id` 选择，0 表示内部。外部连接同样不做反向代理。
5. **CI 解析走调用方 JWT**。`cmd/ongrid` 用现有 CMDB HTTP 客户端实现 `CMDBReader`；后台 RCA /
   工作流没有调用者时继续 fail-closed，不引入服务账号。CMDB 不可用时，全局中心仍工作，
   CI 页签/映射预览降级为 `cmdb_unavailable`。
6. **凭据**：`federation_connections.auth_cipher` 使用 `secretbox`；弱密钥时拒绝保存凭据；
   读取只暴露 `token_set/password_set`；`reveal` 仅 admin 且不进入审计 payload；上游错误统一
   scrub；`base_url` 拒绝 userinfo，`api_path` 拒绝 query/fragment/空白。
7. **「我的告警」是便利视图，不是授权边界**。`ViewerIdentityResolver` 从 IAM 读取
   email/phone/username；AND 组身份规则未解析时整条谓词作废，返回 `unbound`，绝不发送空谓词。
8. **缓存与统计有界**。Fleet 列表缓存 15s、fleet 统计缓存 60s；个人视角永不缓存。统计使用
   最多 4 路并发的 `page_size=1` 查询；单个分面超时返回 `null`，不伪造成 0。
9. **RBAC**：配置写操作要求 `IsSuperuser || Role=="admin"`；中心读接口任意登录用户可用。
   不引入 Cantor 的 `acl_admin`。
10. **external MCP 不暴露**。`/v1/federation/*` 与 `/v1/observability/ci-*` 全部列入
    `api_exclusions.json`，原因写在清单里；外部 MCP 使用原生 alert 工具。

## 后果

- 新增 `federation_*` 与 `ci_monitoring_links` 表，均由启动时的 AutoMigrate 管理；无独立 SQL
  迁移文件。配置表硬删除，变更有审计。
- 上游契约不在本仓库：客户端需要容忍缺字段、限制响应体、区分
  `not_configured / no_scope / unbound / no_ci_value / connection_unreachable / cmdb_unavailable`，
  不能把失败画成空态。
- ITSM 上游忽略 `instance_status` 参数，状态筛选走 `filter=form_data.instanceStatus:eq:...`
  语法；这是有意的行为修正，不追求与 Cantor 的坏行为兼容。
- 只读意味着没有外部 ack/关闭；如未来需要写回，必须单独设计权限、审计与上游幂等语义。
- `ci_monitoring_links` 只引用全局集成，因此改 Grafana/Prom 地址仍在 Settings → 集成 一处完成。
- 本决策不覆盖 Cantor 的工作流告警轮询、知识库同步或报告事实；这些属于 Cantor 自身自动化，
  需要时另立需求。

## 升级与回滚

- 表结构只做增量；回滚代码后新表被忽略，不影响 manager 启动。
- 关闭功能：删除对应连接/映射/监控链接，或回滚到不含本模块的镜像；中心页与 CI 页签随配置消失。
- `/v1/alerts/*` 原生接口未改动，原生告警行为不受本 ADR 影响。

## 关联

- [ADR-035 CMDB 独立服务](ADR-035-cmdb-standalone-service.md)
- [ADR-037 CMDB Agent 工具](ADR-037-cmdb-agent-tools.md)
- [前端设计语言](../design/frontend-design-language.md)
- [外部源部署说明](../install/federation-sources.md)
