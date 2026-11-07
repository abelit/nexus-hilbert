# ADR-037：把 CMDB 能力接入 AIOps 技能目录

Status: Proposed — 2026-11-08

## 背景

CMDB 已经是独立进程（ADR-035），对外提供 `/api/v1/cmdb/*`；AIOps 侧目前**没有任何 CMDB 工具**，排障 Agent 无法在根因分析、影响面判断和变更关联时读取配置项。

“技能”在本项目里有两个来源：`internal/skill` 的 Executor 注册表（自动生成 LLM tool、`/v1/skills` HTTP、UI 表单和审计），以及 AIOps BaseTool 经 `inventory_bridge` 反向注册出来的同名技能。后者已经覆盖了云侧工具，且写操作有成熟的确认/审批链。

约束：`.go-arch-lint.yml` 禁止 `manager_biz`、`shared_skill` 依赖 `cmdb_*`；manager 与 CMDB 是两个进程。因此 CMDB 能力不能以 import `internal/cmdb/biz` 的形式实现。

## 决策

1. **形态**：在 `internal/manager/biz/aiops/tools/cmdb/` 新增一组 manager 侧 BaseTool，经 `inventory_bridge` 自动进入技能目录。全部为 `ScopeManager` 语义（不经过 edge，不需要 `device_id`），执行时调用 CMDB REST，不 import `internal/cmdb`。
2. **传输**：新建一个只依赖 `shared_pkg` 的 HTTP client 子包，负责 base URL、超时、错误翻译和输出裁剪；不经过 nginx 公网入口，使用部署内地址。`ONGRID_CMDB_API_URL` 填**服务根地址**（如 `http://ongrid-cmdb:8082`），client 自己拼接 `/api/v1/cmdb/...`（CMDB 进程把 `/v1/cmdb/*` 挂在 `/api` 下）。
3. **身份**：每个请求携带**调用者本人**的短期 JWT。`cmd/ongrid` 用同一 `auth.Signer`、以 `tenantctx.From(ctx)` 的 `UserID/Role/IsSuperuser` 签发（TTL 约 1 分钟）；不使用服务账号或管理员凭据。CMDB 侧照常验签，操作审计记录真实用户。
   - **P0 仅覆盖交互式会话**：告警自动调查、flow 等用 `context.Background()` 启动的路径没有 `tenantctx`，工具返回明确的“需要调用者身份”错误并 fail-closed，不静默降级为系统身份。后台身份透传（归属人或专用只读系统身份）留到后续计划。
4. **可用性**：仅当配置了 `ONGRID_CMDB_API_URL` 且 client 非 nil 时注册工具；CMDB 未部署时能力整体缺席，而不是让模型调用后拿到 502。
5. **分级**：本次交付只做 **P0 只读**；P1 扩展只读、P2 写操作各自另立计划，不复用本次 PR。P0 工具 class 一律 `read`。删除 CI、批量删除、模型/属性/关系类型 CRUD、ACL 与用户管理不提供。
6. **Persona 范围**：P0 只读工具对全部排障 Agent 开放——coordinator（空 `Tools` 继承全量）、`incident-investigator`、`specialist-compute/disk/network/ops/sre`。这些 persona 的 `tools:` 白名单需要同步加入 `cmdb_*` 和 `ToolSearch`；`reporter` / `reviewer` 不加入。
7. **输出**：默认返回摘要（身份字段 + 最多 5 个属性），支持 `fields`/`fl` 显式取字段（最多放行 20 个，超出加 `note`）；列表带 `total`/`page` 和截断提示。关系图同时限制节点数和边数（`2 × max_nodes`），按 `(from,to,relation_id)` 去重且不返回悬空边。响应裁剪在 client/工具层完成，工具只做参数校验。
8. **命名**：统一 `cmdb_*` 前缀，与未来 MCP/其它来源不冲突。

### P0 工具集（只读）

| 工具 | 端点（client 已拼 `/api`） | 主要参数 |
| --- | --- | --- |
| `cmdb_search_ci` | `GET /v1/cmdb/ci/s` | `q`、`page`、`count`、`sort`、`fl` |
| `cmdb_get_ci` | `GET /v1/cmdb/instances/{id}` | `ci_id`、`fields` |
| `cmdb_list_ci_types` | `GET /v1/cmdb/ci-types` | `name`、`ids` |
| `cmdb_get_ci_type` | `GET /v1/cmdb/ci-types/{ref}` + `/attributes` | `ref` |
| `cmdb_get_ci_relations` | `GET /v1/cmdb/ci-relations/{id}/children` / `parents` | `ci_id`、`direction`、`page`、`count`、`relation_type_id` |
| `cmdb_query_relation_path` | `POST /v1/cmdb/ci-relations/path/s` | `source{type_id,q}`、`target{type_ids,q}`、`path`、`page`、`count`（模型级选择器，不是实例 ID 对） |
| `cmdb_find_ci_type_path` | `GET /v1/cmdb/ci-type-relations/path` | `source_type_id`、`target_type_ids` |
| `cmdb_get_ci_history` | `GET /v1/cmdb/history/ci/{id}` | `ci_id`、`page`、`page_size` |
| `cmdb_relation_graph` | 基于 children/parents 的受限 BFS | `ci_id`、`direction`、`depth`（≤3）、`max_nodes` |

### P1（只读扩展）

服务树（`/ci-relations/search`）、IPAM（`/ipam/*` 读接口）、DCIM（`/dcim/tree-view`）、发现状态（`/discovery/rules`、`/discovery/targets/{id}/health`）、关系类型字典。

### P2（写，审批）——不在本次范围

`cmdb_create_ci`、`cmdb_update_ci`、`cmdb_create_relation`、`cmdb_delete_relation`、导入 preview/commit、实例回滚。写工具必须走现有 `MutatingProposal` 审批，并且审批时使用审批人的凭据。

P2 开工前必须先解决一个已知缺口：`HumanApprovalGate` 的 execute 闭包捕获的是**发起调用者**的 ctx，而不是审批人的 ctx；ReviewGate 是 AI reviewer，没有审批人身份；flow 的 ToolInvoker 也没有审批 gate。因此“审批时使用审批人凭据”在当前实现下不成立，需要单独设计（修改通用 gate 会影响所有工具，或只给 CMDB 写工具加 option），并把 CMDB 写工具从 flow 面板排除。P0 不涉及写工具，不受此影响。

## 备选方案

- **Manager-scope skill（`internal/skill`）**：同样是合法路径，参数声明可直接生成 UI 表单；但复杂 schema、审批链和装饰器不如 BaseTool 成熟。P0 选 BaseTool 以获得技能目录可见性；若某工具需要人工填表执行，再以同名 skill 暴露（二者按 key 互斥）。
- **外部 MCP（cantor 的 `cmdb-mcp`）**：零 Go 代码，但该适配器的端点是 cantor 的 `/api/v0.1/*`，与本服务的 `/api/v1/cmdb/*` 不兼容；MCP 工具默认不 trusted 会全部走审批，且没有中文显示名，另增一个 Python 进程。仅作为后续可选方案。
- **直接 import `internal/cmdb/biz`**：违反 `.go-arch-lint.yml` 的 BC 边界，否决。

## 后果

- 新增 manager → CMDB 的 HTTP 调用路径，但不改变任何 BC 的 import 边界；CMDB 故障只影响这些工具，不影响 manager 其它能力。
- 新增一个环境变量和部署配置；未配置时技能目录不出现 CMDB 工具。
- 短期 JWT 依赖两个进程共享 `ONGRID_JWT_SECRET`（与 ADR-035 的认证前提一致），轮换时需同时更新。
- 需要伪 CMDB HTTP server 的单元测试、工具到端点的契约测试，以及输出裁剪/错误翻译测试。

## 验证

- 受影响包 `go test -race ./internal/manager/biz/aiops/tools/... ./internal/pkg/config/...`
- `make arch-lint` 证明没有新增跨 BC import。
- lint/build：`go vet ./...`、`go build ./cmd/ongrid`。
- 不加数据库迁移，不修改 CMDB schema。
