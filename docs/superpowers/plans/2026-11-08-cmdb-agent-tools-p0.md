# CMDB P0 Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让交互式 AIOps 会话中的排障 Agent 通过 9 个只读工具查询 CMDB 配置项、模型、关系与变更历史，并自动出现在技能目录。

**Architecture:** 在 `internal/manager/biz/aiops/tools/cmdb/` 实现 manager 侧 BaseTool，通过 HTTP 调用独立的 CMDB 服务（`/api/v1/cmdb/*`），每次请求携带调用者短期 JWT；工具注册进 `Registry.BuildBaseTools`，由 `inventory_bridge` 自动投影为技能。全程不 import `internal/cmdb`。

**Tech Stack:** Go 1.24（仓库现有版本）、`net/http`、`httptest`、现有 `basetool.BaseTool`/`tenantctx`/`auth.Signer`。

**Spec:** `docs/adr/ADR-037-cmdb-agent-tools.md`

## Global Constraints

- 本次只做 P0 只读；不新增任何写工具。
- 不新增跨 BC import：`manager_biz` 不得 import `internal/cmdb/**`。
- 工具名统一 `cmdb_*`，`ToolInfo.Class` 一律 `"read"`，`Origin` 保持内置（空）。
- 必须有调用者身份：`tenantctx.From(ctx)` 缺失时返回 `ErrNoCaller`，fail-closed；不得降级为服务账号。
- `ONGRID_CMDB_API_URL` 是服务根（如 `http://ongrid-cmdb:8082`）；client 自己拼 `/api/v1/cmdb`。
- 单次列表最多返回 20 条；`cmdb_get_ci` 摘要最多 5 个非身份属性；截断必须带 `total` 和 `note`。
- 测试只用 `httptest`，不连真实 CMDB。
- 提交信息用英文、Conventional Commits。

## Review Focus

1. 后台路径（告警自动调查、flow）调用 CMDB 工具时必须得到可读的 `ErrNoCaller`，而不是 panic 或空结果。
2. 所有请求路径都必须包含 `/api/v1/cmdb` 前缀；少一层 `/api` 会在生产环境全部 404。
3. 大结果集/宽模型必须被裁剪；一次 `cmdb_search_ci` 不能把几十个属性塞进上下文。
4. `incident-investigator` 和 specialist 的 `tools:` 白名单必须真的包含 `cmdb_*`；只注册不改白名单等于没交付。
5. CMDB 未配置或不可达时，工具要么不注册，要么返回可纠正的错误；不能拖垮整个回合。

---

### Task 1: Config — `ONGRID_CMDB_API_URL`

**Files:**
- Modify: `internal/pkg/config/config.go`
- Test: `internal/pkg/config/config_test.go`

**Interfaces:**
- Produces: `config.Config.CMDB.APIURL string`，通过 `ONGRID_CMDB_API_URL` 读取，空字符串表示禁用。

- [ ] **Step 1: Write the failing test**

```go
func TestLoadCMDBAPIURL(t *testing.T) {
	t.Setenv("ONGRID_CMDB_API_URL", "http://ongrid-cmdb:8082")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CMDB.APIURL != "http://ongrid-cmdb:8082" {
		t.Fatalf("CMDB.APIURL = %q", cfg.CMDB.APIURL)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/pkg/config -run TestLoadCMDBAPIURL -v`
Expected: FAIL — `cfg.CMDB` undefined.

- [ ] **Step 3: Implement the config field**

在 `Config` 结构体加入 `CMDB CMDBConfig`，新增：

```go
type CMDBConfig struct {
	// APIURL is the CMDB service root (e.g. http://ongrid-cmdb:8082).
	// Empty disables the assistant's CMDB tools.
	// env: ONGRID_CMDB_API_URL.
	APIURL string
}
```

在 `Load()` 的 `Config{...}` 字面量中加入 `CMDB: CMDBConfig{APIURL: strings.TrimSpace(getEnv("ONGRID_CMDB_API_URL", ""))}`。

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/pkg/config -run TestLoadCMDBAPIURL -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/pkg/config/config.go internal/pkg/config/config_test.go
git commit -m "feat(config): add ONGRID_CMDB_API_URL"
```

---

### Task 2: CMDB HTTP client and caller-token minter

**Files:**
- Create: `internal/manager/biz/aiops/tools/cmdb/client.go`
- Test: `internal/manager/biz/aiops/tools/cmdb/client_test.go`

**Interfaces:**
- Produces:
  - `type TokenMinter func(tenantctx.Tenant) (string, error)`
  - `func NewSignerMinter(s *auth.Signer, ttl time.Duration) TokenMinter`
  - `func New(baseURL string, minter TokenMinter, hc *http.Client, log *slog.Logger) *Client`（baseURL 为空或 minter 为 nil 时返回 nil）
  - `func (c *Client) Get(ctx context.Context, path string, query url.Values) (json.RawMessage, error)`
  - `func (c *Client) Post(ctx context.Context, path string, body any) (json.RawMessage, error)`
  - `var ErrNoCaller = errors.New("cmdb: interactive caller identity required")`
  - `type APIError struct { Status int; Body string }`

- [ ] **Step 1: Write the failing tests**

`client_test.go` 覆盖：

```go
func TestClientRequiresCaller(t *testing.T)          // ctx 无 tenantctx → errors.Is(err, ErrNoCaller)，且 server 未被调用
func TestClientSendsBearerAndAPIPrefix(t *testing.T) // 断言 path == "/api/v1/cmdb/ci/s"，Authorization == "Bearer tok"，q 参数透传
func TestClientTranslatesForbidden(t *testing.T)     // 403 → APIError.Status == 403，消息含 "not allowed"
func TestClientTranslatesServerError(t *testing.T)   // 503 → 消息含 "unavailable"，不 panic
func TestSignerMinterCarriesCaller(t *testing.T)     // signer.Verify(token) → UserID/Role/IsSuperuser 一致，exp 约等于 now+ttl
```

`TestClientSendsBearerAndAPIPrefix` 用 `httptest.NewServer`，minter 返回 `"tok"`，用 `tenantctx.With(context.Background(), tenantctx.Tenant{UserID: 7, Role: "user"})` 调用。

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -v`
Expected: FAIL — package/identifiers 不存在。

- [ ] **Step 3: Implement the client**

- `New` trim 末尾 `/`；`http.Client` 为 nil 时用 `&http.Client{Timeout: 30 * time.Second}`。
- `Get`/`Post` 统一走 `do`：取 tenant → mint token → URL = `baseURL + "/api/v1/cmdb" + path` → 带 `Authorization: Bearer`、`Accept: application/json`、context。
- 读响应体上限 4 MiB；`status >= 400` 返回 `*APIError`，消息按状态给出可纠正提示（400 带 body 片段、401 提示会话过期、403 提示无权限、404 提示资源不存在、5xx 提示 CMDB 不可用）。
- `NewSignerMinter` 返回闭包，签发 `auth.Claims{UserID, Email, Role, IsSuperuser}` 且 TTL 为传入值。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/manager/biz/aiops/tools/cmdb/client.go internal/manager/biz/aiops/tools/cmdb/client_test.go
git commit -m "feat(cmdb-tools): add caller-authenticated HTTP client"
```

---

### Task 3: Output shaping

**Files:**
- Create: `internal/manager/biz/aiops/tools/cmdb/shaping.go`
- Test: `internal/manager/biz/aiops/tools/cmdb/shaping_test.go`

**Interfaces:**
- Produces:
  - `func CompactCI(ci map[string]any, maxAttrs int) map[string]any`
  - `func CompactCIType(t map[string]any) map[string]any`
  - `func Truncate(items []any, max, total int) map[string]any`

- [ ] **Step 1: Write the failing tests**

```go
func TestCompactCIKeepsIdentityAndCapsAttributes(t *testing.T) // 4 个身份键 + 5 个属性；嵌套 object 丢弃；list 保留
func TestCompactCITypeKeepsModelIdentity(t *testing.T)         // id/name/alias/unique_key/enabled/parent_ids 保留，icon/order 丢弃
func TestTruncateAddsNote(t *testing.T)                        // 21 条 max=20 → len(items)==20, total==21, note 非空
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -run Shaping -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement**

- CI 身份键：`_id`、`ci_id`、`_type`、`ci_type`、`ci_type_alias`、`unique`、`unique_alias`、`_updated_at`、`_updated_by`、`_created_at`、`_created_by`。
- 跳过空值；默认丢弃嵌套 `map`；slice 保留。
- `CompactCIType` 只保留 `id`、`name`、`alias`、`unique_key`、`enabled`、`deleted`、`parent_ids`。
- `Truncate` 返回 `{items, total, note?}`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/manager/biz/aiops/tools/cmdb/shaping.go internal/manager/biz/aiops/tools/cmdb/shaping_test.go
git commit -m "feat(cmdb-tools): keep tool output inside a context budget"
```

---

### Task 4: CI and model read tools

**Files:**
- Create: `internal/manager/biz/aiops/tools/cmdb/tools.go`
- Test: `internal/manager/biz/aiops/tools/cmdb/tools_test.go`

**Interfaces:**
- Consumes: `Client`, `CompactCI`, `CompactCIType`, `Truncate`.
- Produces:
  - `const ToolNameSearchCI = "cmdb_search_ci"`, `ToolNameGetCI`, `ToolNameListCITypes`, `ToolNameGetCIType`
  - `func Tools(c *Client) []basetool.BaseTool`（`c == nil` 返回 nil）
  - 内部 `type tool struct { name, description, whenToUse string; schema json.RawMessage; run func(context.Context, json.RawMessage) (any, error) }`

- [ ] **Step 1: Write the failing tests**

用 `httptest` 建 CMDB 假服务，路由并断言：

```go
func TestSearchCIShapesAndTruncates(t *testing.T) // GET /api/v1/cmdb/ci/s?q=...&page=1&count=20；返回 {items,total,page}
func TestGetCISummaryAndFields(t *testing.T)      // ci_id=5、fields="hostname,name"；摘要最多 5 属性
func TestListCITypes(t *testing.T)               // GET /api/v1/cmdb/ci-types；返回 {items,total}
func TestGetCITypeMergesAttributes(t *testing.T) // 两次 GET：/ci-types/3 与 /ci-types/3/attributes；返回 {type,attributes}
func TestToolInfoIsReadOnly(t *testing.T)        // 四个工具 Info().Class == "read"、Name 正确、Parameters 是合法 JSON
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -run 'CI|Type' -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement the four tools**

Schema 要点：
- `cmdb_search_ci`：`q`（required, string）、`page`（int, default 1）、`count`（int, default 20, max 50）、`sort`（string）、`fl`（string）。参数名映射到 CMDB 的 `q/page/count/sort/fl`。
- `cmdb_get_ci`：`ci_id`（required, int）、`fields`（string，逗号分隔）。返回 `{"ci": CompactCI(...)}`。
- `cmdb_list_ci_types`：`name`（string）、`ids`（string，逗号分隔）。返回 `{items,total}`。
- `cmdb_get_ci_type`：`ref`（required, string，数字 id 或模型名）。两次 GET 后返回 `{"type":..., "attributes":...}`。
- 所有错误原样返回（`%w`），`Info().WhenToUse` 说明何时优先用哪个工具。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/manager/biz/aiops/tools/cmdb/tools.go internal/manager/biz/aiops/tools/cmdb/tools_test.go
git commit -m "feat(cmdb-tools): add CI and model read tools"
```

---

### Task 5: Relation, history and graph tools

**Files:**
- Modify: `internal/manager/biz/aiops/tools/cmdb/tools.go`
- Modify: `internal/manager/biz/aiops/tools/cmdb/tools_test.go`

**Interfaces:**
- Produces: `ToolNameGetCIRelations`, `ToolNameQueryRelationPath`, `ToolNameFindCITypePath`, `ToolNameGetCIHistory`, `ToolNameRelationGraph`；全部由 `Tools` 返回。

- [ ] **Step 1: Write the failing tests**

```go
func TestGetCIRelationsDirection(t *testing.T)   // direction=down → /children；up → /parents；参数 page/count/relation_type_id 透传
func TestQueryRelationPathBody(t *testing.T)     // POST body 精确为 {source:{type_id,q},target:{type_ids,q},path,page,count}
func TestFindCITypePathQuery(t *testing.T)       // source_type_id + target_type_ids 逗号拼接
func TestGetCIHistoryPaging(t *testing.T)        // page/page_size 透传
func TestRelationGraphBounds(t *testing.T)       // depth>3 被夹到 3；max_nodes>50 被夹到 50；结果带 nodes/edges/truncated
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -run 'Relation|Path|History' -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `cmdb_get_ci_relations`：`ci_id`（required）、`direction`（enum down/up，default down）、`page`、`count`（≤50）、`relation_type_id`（int）。返回 CMDB 的 `items/numfound/page`，保留 `relation_id/ci_id/type_id/relation_type_id`。
- `cmdb_query_relation_path`：body 使用 CMDB 的原生模型级选择器：`source{type_id,q}`、`target{type_ids,q}`、`path`（二维 int 数组，必填）、`page`、`count`。返回 `numfound/total/page/counter/paths/id2ci`，`paths` 超过 20 条时截断并加 note。
- `cmdb_find_ci_type_path`：`source_type_id`（required）、`target_type_ids`（required，逗号分隔）；返回 `{paths}`。
- `cmdb_get_ci_history`：`ci_id`（required）、`page`（default 1）、`page_size`（default 20, max 50）。
- `cmdb_relation_graph`：`ci_id`（required）、`direction`（down/up/both，default down）、`depth`（default 1，clamp 1..3）、`max_nodes`（default 20，clamp 1..50）。BFS 调 children/parents；每个节点再调 `/instances/{id}` 取 `name/ci_type`；输出 `{nodes, edges, truncated}`，节点或边达到上限即停止并置 `truncated=true`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/manager/biz/aiops/tools/cmdb/tools.go internal/manager/biz/aiops/tools/cmdb/tools_test.go
git commit -m "feat(cmdb-tools): add relation, history and graph tools"
```

---

### Task 6: Register tools in the AIOps registry and skill catalog

**Files:**
- Modify: `internal/manager/biz/aiops/tools/registry.go`
- Modify: `internal/manager/biz/aiops/tools/inventory_bridge.go`
- Test: `internal/manager/biz/aiops/tools/registry_test.go`
- Test: `internal/manager/biz/aiops/tools/inventory_bridge_test.go`

**Interfaces:**
- Consumes: `cmdb.Client`, `cmdb.Tools`.
- Produces: `func (r *Registry) SetCMDB(c *cmdb.Client)`；`BuildBaseTools` 在 `r.cmdb != nil` 时追加 `cmdb.Tools(r.cmdb)...`；`classifyToolCategory` 对 `cmdb_*` 返回 `"cmdb"`。

- [ ] **Step 1: Write the failing tests**

```go
func TestBuildBaseToolsCMDBGatedOnClient(t *testing.T) // 未 SetCMDB → 不含；SetCMDB(cmdb.New(...)) → 含 9 个 cmdb_ 工具
func TestClassifyToolCategoryGroupsCMDBTools(t *testing.T) // classifyToolCategory("cmdb_search_ci") == "cmdb"
```

`TestBuildBaseToolsCMDBGatedOnClient` 用不可达的 `http://127.0.0.1:1` 构造 client（只构造，不调用），断言名称集合。

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manager/biz/aiops/tools -run 'CMDB' -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `Registry` 增加 `cmdb *cmdb.Client` 字段与 `SetCMDB`。
- `BuildBaseTools` 在末尾（ToolSearch 之前）追加 `cmdb.Tools(r.cmdb)...`。
- `classifyToolCategory` 开头增加 `if strings.HasPrefix(name, "cmdb_") { return "cmdb" }`。
- 确认 `RegisterBaseToolsAsSkills` 无需修改（它遍历 bag）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/manager/biz/aiops/tools -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/manager/biz/aiops/tools/registry.go internal/manager/biz/aiops/tools/inventory_bridge.go internal/manager/biz/aiops/tools/registry_test.go internal/manager/biz/aiops/tools/inventory_bridge_test.go
git commit -m "feat(cmdb-tools): register CMDB tools and catalog category"
```

---

### Task 7: Wire the client in `cmd/ongrid` and deploy config

**Files:**
- Modify: `cmd/ongrid/bootstrap_aiops.go`
- Modify: `cmd/ongrid/main.go`
- Modify: `.env.example`
- Modify: `deploy/docker-compose.yml`
- Modify: `deploy/install/docker-compose.yml`
- Modify: `deploy/install/.env.example`（若存在同名键列表）
- Test: `cmd/ongrid/skill_bootstrap_test.go`（Task 8 的 persona 断言也在该文件）

**Interfaces:**
- Consumes: `config.CMDB.APIURL`, `iamModule.signer`, `cmdb.NewSignerMinter`.
- Produces: `bootstrapAIOps(..., tunnel *tunnelModule, signer *auth.Signer)`；启动时若 URL 非空则 `toolsReg.SetCMDB(...)`。

- [ ] **Step 1: Write the failing test**

在 `cmd/ongrid` 增加以下辅助函数并单测（不要试图构造完整 `bootstrapAIOps`）：

```go
func newCMDBClient(cfg *config.Config, signer *auth.Signer, log *slog.Logger) *cmdb.Client

func TestNewCMDBClientGatedOnURL(t *testing.T) {
	if got := newCMDBClient(&config.Config{}, auth.NewSigner("s", time.Minute, time.Hour), slog.Default()); got != nil {
		t.Fatal("empty URL must disable CMDB tools")
	}
	cfg := &config.Config{CMDB: config.CMDBConfig{APIURL: "http://ongrid-cmdb:8082"}}
	if got := newCMDBClient(cfg, auth.NewSigner("s", time.Minute, time.Hour), slog.Default()); got == nil {
		t.Fatal("configured URL must build a client")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ongrid -run CMDB -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

- 新增 `newCMDBClient`，内部调用 `cmdb.New(cfg.CMDB.APIURL, cmdb.NewSignerMinter(signer, time.Minute), nil, log)`。
- `main.go` 调用 `bootstrapAIOps(..., tunnel, iam.signer)`；`bootstrapAIOps` 在 `NewRegistry` 后调用 `toolsReg.SetCMDB(newCMDBClient(cfg, signer, log))`。
- `.env.example` 增加：
  ```dotenv
  # CMDB service root for the assistant's read-only CMDB tools.
  # Empty keeps the tools out of the catalog. Compose sets this by default.
  ONGRID_CMDB_API_URL=
  ```
- `deploy/docker-compose.yml` 与 `deploy/install/docker-compose.yml` 的 ongrid 服务 environment 增加：
  ```yaml
  ONGRID_CMDB_API_URL: ${ONGRID_CMDB_API_URL:-http://ongrid-cmdb:8082}
  ```
- `deploy/install/.env.example` 增加同名键与注释（默认留空，compose 默认值生效；需要显式覆盖时填写）。

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/ongrid -run CMDB -v && go build ./cmd/ongrid`
Expected: PASS + build 成功.

- [ ] **Step 5: Commit**

```bash
git add cmd/ongrid/bootstrap_aiops.go cmd/ongrid/main.go cmd/ongrid/*_test.go .env.example deploy/docker-compose.yml deploy/install/docker-compose.yml deploy/install/.env.example
git commit -m "feat(cmdb-tools): wire CMDB client into the manager"
```

---

### Task 8: Open the read tools to diagnostic personas

**Files:**
- Modify: `agents/incident-investigator.md`
- Modify: `agents/specialist-compute.md`
- Modify: `agents/specialist-disk.md`
- Modify: `agents/specialist-network.md`
- Modify: `agents/specialist-ops.md`
- Modify: `agents/specialist-sre.md`
- Test: `cmd/ongrid/skill_bootstrap_test.go`

**Interfaces:**
- Consumes: parsed `Agent.Tools` from the builtin agents root.
- Produces: each diagnostic persona's whitelist contains all 9 `cmdb_*` names plus `ToolSearch`.

- [ ] **Step 1: Write the failing test**

在 `TestLoadBootstrapRegistriesSkillRoots` 同文件新增：

```go
func TestBuiltinDiagnosticAgentsCanUseCMDBTools(t *testing.T) {
	agents, _ := filepath.Abs("../../agents")
	t.Setenv("ONGRID_BUILTIN_AGENTS_ROOT", agents)
	_, personas := loadBootstrapRegistries(slog.Default())
	want := "cmdb_search_ci"
	for _, name := range []string{"incident-investigator", "specialist-compute", "specialist-disk", "specialist-network", "specialist-ops", "specialist-sre"} {
		def, ok := personas.ByName(name)
		if !ok {
			t.Fatalf("%s not loaded", name)
		}
		if !slices.Contains(def.Tools, want) {
			t.Fatalf("%s missing %s", name, want)
		}
	}
	if reviewer, ok := personas.ByName("reviewer"); ok && slices.Contains(reviewer.Tools, want) {
		t.Fatal("reviewer must not get CMDB tools")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ongrid -run DiagnosticAgents -v`
Expected: FAIL — missing `cmdb_search_ci`.

- [ ] **Step 3: Update the persona frontmatter**

在 6 个文件的 `tools:` 列表追加：

```yaml
  - cmdb_search_ci
  - cmdb_get_ci
  - cmdb_list_ci_types
  - cmdb_get_ci_type
  - cmdb_get_ci_relations
  - cmdb_query_relation_path
  - cmdb_find_ci_type_path
  - cmdb_get_ci_history
  - cmdb_relation_graph
  - ToolSearch
```

不要改 `reporter.md` / `reviewer.md`。

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/ongrid -run DiagnosticAgents -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/incident-investigator.md agents/specialist-*.md cmd/ongrid/skill_bootstrap_test.go
git commit -m "feat(agents): expose read-only CMDB tools to diagnostic personas"
```

---

### Task 9: Full verification

- [ ] **Step 1: Affected packages with race**

Run: `go test -race ./internal/manager/biz/aiops/tools/... ./internal/pkg/config/... ./cmd/ongrid/...`
Expected: PASS.

- [ ] **Step 2: Architecture boundaries**

Run: `make arch-lint`
Expected: PASS（或工具缺失时明确记录为未执行，不得记为通过）。

- [ ] **Step 3: Build and vet**

Run: `go build ./cmd/ongrid && go vet ./internal/manager/biz/aiops/tools/... ./internal/pkg/config/... ./cmd/ongrid/...`
Expected: PASS.

- [ ] **Step 4: Diff hygiene**

Run: `git diff --check && git status --short`
Expected: 无空白错误；只包含本计划涉及的文件。

- [ ] **Step 5: Commit any remaining test/doc adjustments**

```bash
git add -A
git commit -m "test(cmdb-tools): verify P0 CMDB tool integration"
```
