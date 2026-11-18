# 外部告警 / 工单源与 CI 监控链接

本说明对应 [ADR-038](../adr/ADR-038-external-observability-sources.md)。Ongrid 只读查询外部
告警库（nexus-morse）与钉钉 ITSM，不落库、不做写回；CI 监控链接复用全局 Grafana / Prometheus。

## 前置条件

- manager 能访问上游地址（morse / ITSM）；至少配置一个可用连接。
- 需要 CMDB 页签时，`ongrid-cmdb` 已部署，且 manager 配置了 `ONGRID_CMDB_API_URL`。
  没有 CMDB 时，外部告警/工单中心仍可用，只有 CI 关联视图降级。
- Grafana / Prometheus 的地址、认证仍在 **设置 → 集成** 配置；CI 监控页面不重复保存这些凭据。
- **凭据加密**：连接中的 token/username/password 由 `secretbox` 加密。生产环境应设置
  `ONGRID_SECRET_KEY`（未设置时回退到已持久化的 `ONGRID_JWT_SECRET`）。使用开发默认密钥时，
  保存凭据会被拒绝（`secret-key-weak`），这是有意的保护。

## 配置步骤

1. **设置 → 外部数据源**
   - 选择「告警源」或「工单源」，新建连接：`base_url`、`api_path`、方法、认证、超时。
   - 「测试连接」验证未保存草稿；保存后健康状态在列表中定期查看。
   - 新建 **CI 映射**：选择 CI 类型与连接；`field` 行把上游字段映射到 CI 属性（用于识别该 CI），
     `fixed` 行用于限定查询范围。可先「扫描字段」再「预览命中」。
   - 配置 **中心过滤器**：AND/OR 规则、用途（筛选/徽标）、按当前用户身份。同一类型只能有一个
     启用徽标的过滤器。
   - 配置 **展示列**：顺序、可见性、自定义字段与渲染方式；至少保留一列可见。
2. **设置 → CI 监控**
   - Grafana：CI 类型 → Dashboard UID / slug / 变量映射；深链由浏览器用全局 Grafana 根地址组合。
   - Prometheus：CI 类型 → 标签映射 + 额外 matcher；只展示匹配的活动告警。
   - 「预览」需要一个真实 CI ID；CMDB 不可达时允许直接填写数字 CI 类型 ID。
3. **使用**
   - `/alerts` →「外部告警」tab：范围、时间窗、状态/级别/关键字、统计、CSV/JSON 导出。
   - `/tickets`：工单管理 → 事件中心；ITSM 状态按 `form_data.instanceStatus` 过滤。
   - CMDB 实例详情：有映射时出现「告警 / 事件」页签；有监控链接时出现「监控」页签。

## 只读与降级语义

- 上游错误返回可读错误（502 `upstream`），不会伪装成空列表。
- `cmdb_unavailable` / `not_configured` / `no_mapping` / `no_ci_value` /
  `connection_unreachable` / `unbound` 在界面分别渲染；统计中单个分面超时显示 `—`，不是 0。
- 「我的告警/工单」会把当前账号的 IAM 身份值发给上游作为过滤条件；它是便利视图，不是访问控制。

## 验证

- `GET /healthz`、`/readyz`、`/metrics` 由 manager/CMDB 现有端点提供；新增指标
  `federation_upstream_requests_total{kind,outcome}` 与
  `federation_upstream_query_duration_seconds{kind}`。
- 连接健康：设置页的健康列，或 `GET /v1/federation/connections/health?kind=...`。
- 上游不可达时，删除/停用连接可立即让中心返回 `not_configured`。

## 不包含

- 不导入 Cantor 的 `common_data` 配置；需要重新录入。
- 不提供 Grafana 反向代理或多连接；不做 Grafana 内嵌渲染（`open_mode=embed` 已存储，待运维启用
  Grafana 嵌入后再接入）。
- 不回写上游（无 ack/关闭），不做本地告警/工单同步；这些需要单独的 ADR。
