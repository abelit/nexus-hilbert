# CMDB Assistant Personas and Interactive Relation Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `model-steward`、`change-auditor`、`ci-investigator` 三个只读 CMDB 助理，并让 `cmdb_relation_graph` 在会话里渲染成可展开、可打开 CI 详情的交互式卡片。

**Architecture:** Persona 是 `agents/*.md`（frontmatter + 中文正文），`capabilities` 进入 v3 coordinator 目录。关系图由后端工具输出 `{root,nodes,edges,counts,truncated}`，host 的 `MessageBubble` 通过 `@/cmdb` 的导出解析并渲染 React Flow 卡片；节点展开走 `/ci-relations/search`，详情复用 CMDB 的 `InstanceDetailDrawer`（新增真只读模式）。

**Tech Stack:** Go 1.24、React 18 + TypeScript、`@xyflow/react`、Vitest + Testing Library（JSDOM）、Tailwind 3。

**Spec:** `docs/superpowers/specs/2026-11-08-cmdb-assistants-and-graph-design.md`

## Global Constraints

- 三个 persona：`permission_mode: read-only`，显式 `tools`，必须写 `capabilities`（v3 catalog 只读它），并保留 `when_to_use`。
- 工具白名单只允许只读工具；禁止 `host_bash`、`cloud_bash`、`*_skill`、写入工具。
- `cmdb_relation_graph` 默认 `direction: both`；`counts` 用第一跳 `numfound`；边按 `(source,target)` 去重、无悬空边、边数 ≤ `2 × max_nodes`。
- 前端 host 只能从 `web/src/cmdb/index.ts` 导入 CMDB 内容。
- 所有文案走 `tr('中文', 'English')`；不新增第三方依赖。
- 前端测试用 JSDOM + Testing Library；React Flow 用 `vi.mock` 或 `vi.stubGlobal('ResizeObserver')`。
- 视觉变更按 AGENTS.md 做真实浏览器 light/dark 截图（390/768/1280/1920）。
- 不改数据库 schema；不新增写接口。

## Review Focus

1. Persona 只写 `when_to_use` 不写 `capabilities` 时，v3 coordinator 看不到它——测试必须断言 capability id。
2. “只读”如果只靠不传 `onEdit`，内联编辑/文件上传/添加关联仍然可用——测试必须断言这些入口不存在。
3. 畸形或旧版本的 `cmdb_relation_graph` 结果不能破坏聊天——必须回退到通用工具块。
4. 展开合并不能产生重复节点、重复边或跨分支方向错误——纯函数测试覆盖。
5. 历史回放与实时 SSE 都走 `call.result`；错误/超时结果不能渲染空图。

---

### Task 1: Three CMDB assistant personas

**Files:**
- Create: `agents/model-steward.md`
- Create: `agents/change-auditor.md`
- Create: `agents/ci-investigator.md`
- Test: `cmd/ongrid/skill_bootstrap_test.go`

**Interfaces:**
- Produces: 三个 `Agent`，`Name` 分别为 `model-steward`、`change-auditor`、`ci-investigator`；每个有 `Capabilities[0].ID`、`Tools`、`PermissionMode: "read-only"`。
- Consumes: 已注册工具名（`cmdb_*`、`query_change_events`、`query_incidents`、`get_incident_detail`、`query_devices`、`get_host_summary`、`expand_topology`、`find_topology_node`、`query_promql`、`query_logql`、`query_knowledge`、`ToolSearch`）。

- [ ] **Step 1: Write the failing test**

在 `cmd/ongrid/skill_bootstrap_test.go` 增加：

```go
func TestBuiltinCMDBAssistantsAreDispatchable(t *testing.T) {
	agents, err := filepath.Abs("../../agents")
	if err != nil { t.Fatal(err) }
	t.Setenv("ONGRID_BUILTIN_AGENTS_ROOT", agents)
	t.Setenv("ONGRID_BUILTIN_SKILLS_ROOT", "")
	t.Setenv("ONGRID_SKILLS_ROOT", filepath.Join(t.TempDir(), "missing"))
	_, personas := loadBootstrapRegistries(slog.Default())

	cases := map[string]struct {
		capability string
		tools      []string
	}{
		"model-steward":   {"cmdb_model_explanation", []string{"cmdb_list_ci_types", "cmdb_get_ci_type", "cmdb_search_ci", "cmdb_get_ci", "cmdb_find_ci_type_path"}},
		"change-auditor":  {"cmdb_change_audit", []string{"cmdb_get_ci_history", "cmdb_get_ci", "cmdb_search_ci", "query_change_events"}},
		"ci-investigator": {"cmdb_dependency_triage", []string{"cmdb_search_ci", "cmdb_get_ci_relations", "cmdb_relation_graph", "expand_topology"}},
	}
	for name, want := range cases {
		def, ok := personas.ByName(name)
		if !ok { t.Fatalf("%s not loaded", name) }
		if def.PermissionMode != "read-only" { t.Fatalf("%s permission_mode = %q", name, def.PermissionMode) }
		if len(def.Capabilities) == 0 || def.Capabilities[0].ID != want.capability {
			t.Fatalf("%s capabilities = %+v", name, def.Capabilities)
		}
		for _, tool := range want.tools {
			if !slices.Contains(def.Tools, tool) { t.Fatalf("%s missing %s", name, tool) }
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ongrid -run TestBuiltinCMDBAssistantsAreDispatchable -v`
Expected: FAIL — `model-steward not loaded`.

- [ ] **Step 3: Create the three persona files**

每个文件 frontmatter 结构（正文用中文，遵循现有 `agents/specialist-*.md` 的风格）：

```yaml
---
name: model-steward
description: 模型专家——CMDB 模型定义、属性、关系类型与查询语法
when_to_use: |
  ...（与 incident-investigator / specialist-* 的边界）
capabilities:
  - id: cmdb_model_explanation
    description: Explain CMDB models, attributes, relation types, and query syntax.
    tools: [cmdb_list_ci_types, cmdb_get_ci_type, cmdb_search_ci, cmdb_get_ci, cmdb_find_ci_type_path]
    max_tool_calls: 10
can_delegate: false
tools:
  - cmdb_list_ci_types
  - cmdb_get_ci_type
  - cmdb_search_ci
  - cmdb_get_ci
  - cmdb_find_ci_type_path
  - query_knowledge
  - ToolSearch
permission_mode: read-only
max_turns: 12
---
```

按 spec 写三份：

- `model-steward`：只讲定义；先列模型，再读属性；引用属性名/类型/是否必填；用户问实例值时明确切换实例工具。
- `change-auditor`：`cmdb_get_ci_history` 为主，`query_change_events` 补充平台变更；每条形如“时间 / 操作人 / 字段 / 旧值→新值”；记录里没有就写“记录中没有”，不得推断。
- `ci-investigator`：从用户点名的 CI 出发；一次一跳，`cmdb_relation_graph` 在用户要求“看/画依赖、影响面、拓扑”时调用；空结果先换方向再下结论；只报实际看到的 CI；不负责告警根因。

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/ongrid -run TestBuiltinCMDBAssistantsAreDispatchable -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/model-steward.md agents/change-auditor.md agents/ci-investigator.md cmd/ongrid/skill_bootstrap_test.go
git commit -m "feat(agents): add CMDB model, change-audit and resource assistants"
```

---

### Task 2: Graph payload for the interactive card

**Files:**
- Modify: `internal/manager/biz/aiops/tools/cmdb/tools.go`
- Test: `internal/manager/biz/aiops/tools/cmdb/tools_test.go`

**Interfaces:**
- Consumes: `Client.Get`, `number`, `displayName`.
- Produces: `ToolNameRelationGraph` payload:
  `{root:{id,name,type_id,type_name}, nodes:[{id,name,type_id,type_name}], edges:[{source,target,label}], counts:{upstream,downstream}, truncated, direction, note?}`.
  Schema gains `q?: string`; `direction` default `both`.

- [ ] **Step 1: Write the failing tests**

```go
func TestRelationGraphRenderPayload(t *testing.T) // root/type_name/label/counts; direction default both
func TestRelationGraphCountsUseFirstHopNumfound(t *testing.T) // numfound > returned → counts 真实值 + truncated
func TestRelationGraphResolvesRootByQuery(t *testing.T) // 只传 q，先 GET /ci/s?count=1，再按 id 建图
func TestRelationGraphDefaultDirectionBoth(t *testing.T) // 不传 direction 时 children 和 parents 都被请求
```

假服务需同时处理 `/ci/s`、`/ci-types`、`/ci-type-relations`、`/ci-relations/{id}/children|parents`、`/instances/{id}`；断言 `nodes[0].type_name`、`edges[].label`、`counts`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -run 'RelationGraph' -v`
Expected: FAIL — payload 仍是旧字段，或 `q`/默认方向未实现。

- [ ] **Step 3: Implement**

- 参数结构加 `Q string \`json:"q"\``；`ci_id` 与 `q` 二选一（`ci_id` 优先）。
- root 解析：`q` 非空时 `GET /ci/s?q=<q>&count=1`，取 `result[0]._id`；没有命中返回可纠正错误。
- `walkRelationGraph` 返回 `(order []int, edges []rawEdge, counts graphCounts, truncated bool, err)`；第一跳每侧记录 `page.NumFound`，`counts.upstream/downstream` 取对应侧；`truncated ||= counts > 实际取回条数`。
- 图元数据：一次 `GET /ci-types` 建 `type_id → alias||name`；一次 `GET /ci-type-relations` 建 `relation_type_id → name`。
- 节点详情仍按 `/instances/{id}`；`nodes[0]` 是 root；`type_name` 取元数据映射；`name` 取 `displayName`。
- 边映射为 `{source,target,label}`，`label` 取关系类型名（缺失时 `""`）。
- `direction` 默认 `both`；schema 描述同步。
- 保留现有节点/边上限、去重、无悬空边。
- 更新旧测试中的字段名（`ci_id/from/to` → `id/source/target`）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/manager/biz/aiops/tools/cmdb -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/manager/biz/aiops/tools/cmdb/tools.go internal/manager/biz/aiops/tools/cmdb/tools_test.go
git commit -m "feat(cmdb-tools): emit interactive relation graph payload"
```

---

### Task 3: Frontend graph parser and layout

**Files:**
- Create: `web/src/cmdb/lib/relation-graph.ts`
- Test: `web/src/cmdb/lib/relation-graph.test.ts`

**Interfaces:**
- Produces:
  - `RelationNode = { id: number; name: string; type_id: number | null; type_name: string }`
  - `RelationEdge = { source: number; target: number; label: string }`
  - `RelationGraph = { root: RelationNode; nodes: RelationNode[]; edges: RelationEdge[]; counts: { upstream: number; downstream: number }; truncated: boolean }`
  - `parseRelationGraph(value: unknown): RelationGraph | null`（接受对象或 JSON 字符串；字符串解析失败返回 null）
  - `layoutRelationGraph(graph): { nodes: PlacedNode[]; edges: RelationEdge[] }`
  - `aggregateColumns(nodes: PlacedNode[], max: number): { nodes: PlacedNode[]; overflow: ColumnOverflow[] }`
  - `expansionFromRows(node: RelationNode, rows: { children: RawRelationCI[]; parents: RawRelationCI[] }, labelFor: (parentTypeID: number | null, childTypeID: number | null) => string): { nodes: RelationNode[]; edges: RelationEdge[] }`
  - `mergeExpansion(graph, addition): RelationGraph`
  - `COLUMN_WIDTH = 260`、`ROW_HEIGHT = 86`

- [ ] **Step 1: Write the failing tests**

从 cantor 的 `lib/relation-graph.test.ts` 移植并改成 hilbert 的 payload：

```go
// TypeScript
it('accepts the tool payload')                    // root/nodes/edges 数量
it('accepts a JSON string result')                // history-replay / *_raw 形状
it('rejects a non-graph result')                  // null / {items:[]} / root:null / 坏字符串
it('drops edges whose endpoints are missing')     // 悬空边
it('puts parents left and children right')        // side/depth/x
it('stacks a column without overlap')             // y 间距
it('aggregates a wide column')                    // kept + overflow count
it('expands a node and inherits branch side')     // parent/child 方向
it('merges without duplicates or dangling edges') // mergeExpansion
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- src/cmdb/lib/relation-graph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

按 cantor 的 `relation-graph.ts` 移植；`expansionFromRows` 的标签改由调用方传入 `labelFor`（因为 hilbert 用 `/ci-type-relations` 的模型对映射）。`parseRelationGraph` 必须丢弃重复节点、重复边和悬空边。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- src/cmdb/lib/relation-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/lib/relation-graph.ts web/src/cmdb/lib/relation-graph.test.ts
git commit -m "feat(cmdb): add relation graph parser and layout"
```

---

### Task 4: True read-only CI drawer and peek wrapper

**Files:**
- Modify: `web/src/cmdb/components/instance-detail/InstanceDetailDrawer.tsx`
- Modify: `web/src/cmdb/components/instance-detail/InstanceOverview.tsx`
- Modify: `web/src/cmdb/components/instance-detail/InstanceRelations.tsx`
- Create: `web/src/cmdb/components/InstanceDetailPeek.tsx`
- Modify: `web/src/cmdb/index.ts`
- Test: `web/src/cmdb/components/instance-detail/InstanceDetailDrawer.test.tsx`
- Test: `web/src/cmdb/components/InstanceDetailPeek.test.tsx`

**Interfaces:**
- `InstanceDetailDrawer` 新增 `readOnly?: boolean`（默认 `false`）。
- `InstanceDetailPeek({ instanceID, typeID, onClose }: { instanceID: number; typeID?: number; onClose(): void })`；内部 `ToastProvider`，一次 `listCITypes()`，按 `typeID` 取 `listTypeAttributes` / `listAttributeGroups`。
- `web/src/cmdb/index.ts` 导出 `InstanceDetailPeek`。

- [ ] **Step 1: Write the failing tests**

```tsx
it('hides inline edit, upload and add-relation in readOnly') // drawer readOnly=true
it('keeps the console drawer editable by default')           // readOnly omitted
it('loads the model and renders the overview in the peek')    // mock APIs
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- src/cmdb/components/instance-detail/InstanceDetailDrawer.test.tsx src/cmdb/components/InstanceDetailPeek.test.tsx`
Expected: FAIL — `readOnly`/module 不存在。

- [ ] **Step 3: Implement**

- `InstanceDetailDrawer`：`readOnly` 时不给 `InstanceOverview` 传 `onSaveValue`；给 `InstanceRelations` 传 `readOnly` 隐藏“添加”和 `RelationAddDialog`；footer 不显示 Edit；history 不显示 rollback。
- `InstanceOverview`：`onSaveValue` 缺失时不显示字段铅笔与 `FileField` 上传。
- `InstanceRelations`：新增 `readOnly?: boolean`，为 true 时不渲染添加按钮/对话框。
- `InstanceDetailPeek`：`ToastProvider` + 元数据加载 + `InstanceDetailDrawer readOnly`；加载失败显示可读错误，不抛异常。
- `web/src/cmdb/index.ts` 增加导出。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- src/cmdb/components/instance-detail/InstanceDetailDrawer.test.tsx src/cmdb/components/InstanceDetailPeek.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/components/instance-detail/InstanceDetailDrawer.tsx web/src/cmdb/components/instance-detail/InstanceOverview.tsx web/src/cmdb/components/instance-detail/InstanceRelations.tsx web/src/cmdb/components/InstanceDetailPeek.tsx web/src/cmdb/index.ts web/src/cmdb/components/instance-detail/InstanceDetailDrawer.test.tsx web/src/cmdb/components/InstanceDetailPeek.test.tsx
git commit -m "feat(cmdb): support read-only CI peek from the assistant"
```

---

### Task 5: RelationGraphCard

**Files:**
- Create: `web/src/cmdb/components/RelationGraphCard.tsx`
- Modify: `web/src/cmdb/index.ts`
- Test: `web/src/cmdb/components/RelationGraphCard.test.tsx`

**Interfaces:**
- Consumes: `RelationGraph`, `layoutRelationGraph`, `aggregateColumns`, `expansionFromRows`, `mergeExpansion`, `InstanceDetailPeek`, `searchHierarchy`, `listTypeRelations`/`getTypeRelations`.
- Produces: `RelationGraphCard({ graph }: { graph: RelationGraph })`；`web/src/cmdb/index.ts` 导出。

- [ ] **Step 1: Write the failing tests**

Mock `@xyflow/react`（只保留 `ReactFlow` 捕获 nodes）和 `InstanceDetailPeek`：

```tsx
it('names the root and counts both directions')
it('lists relations with labels')
it('expands a node and merges the new hop')
it('opens the read-only CI peek from a node')
it('aggregates a wide column')
it('collapses without losing the summary')
it('shows a readable error when expansion fails')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- src/cmdb/components/RelationGraphCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

- 头部：标题、`{upstream} 上游 / {downstream} 下游`、truncated note、折叠按钮。
- 画布：`layoutRelationGraph` + `aggregateColumns`；`ReactFlow` 节点类型 `ci` / `more`。
- 节点 `+`：并行 `searchHierarchy({rootIDs:[id], levels:[1], reverse:false/true, count:200})`；用 `/ci-type-relations` 映射给新边打标签；`expansionFromRows` + `mergeExpansion`；失败显示卡片内错误并允许重试。
- 点节点：`InstanceDetailPeek`（`instanceID`、`typeID`、`onClose`）。
- 文案全部 `tr()`；加载中 `aria-busy`；`+` 按钮有可访问名称。
- 导出。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- src/cmdb/components/RelationGraphCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/components/RelationGraphCard.tsx web/src/cmdb/components/RelationGraphCard.test.tsx web/src/cmdb/index.ts
git commit -m "feat(cmdb): render interactive relation graph cards"
```

---

### Task 6: Chat integration

**Files:**
- Modify: `web/src/components/MessageBubble.tsx`
- Test: `web/src/components/MessageBubble.test.tsx`

**Interfaces:**
- Consumes: `parseRelationGraph`, `RelationGraphCard` from `@/cmdb`.
- Produces: `ToolCallSummaryBlock` 在 `call.name === 'cmdb_relation_graph'` 且结果可解析时渲染卡片。

- [ ] **Step 1: Write the failing test**

```tsx
it('renders the relation graph card for a graph result')
it('falls back to the generic tool block for a malformed result')
it('does not render the card for an error result')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- src/components/MessageBubble.test.tsx`
Expected: FAIL — 仍渲染通用 JSON 块。

- [ ] **Step 3: Implement**

- 从 `@/cmdb` 导入；在 `ToolCallSummaryBlock` 里，错误/审批/operation/configDraft 判断之后、通用块之前：

```tsx
if (call.name === 'cmdb_relation_graph' && !isError) {
  const graph = parseRelationGraph(call.result);
  if (graph) return <RelationGraphCard graph={graph} />;
}
```

- 保持参数/结果折叠块作为回退。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- src/components/MessageBubble.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MessageBubble.tsx web/src/components/MessageBubble.test.tsx
git commit -m "feat(chat): render CMDB relation graph cards inline"
```

---

### Task 7: Verification and visual acceptance

**Files:** none (unless a fix is needed).

- [ ] **Step 1: Go tests with race**

Run: `go test -race ./internal/manager/biz/aiops/tools/... ./cmd/ongrid/...`
Expected: PASS.

- [ ] **Step 2: Web tests, build, lint**

Run: `cd web && npm test -- src/cmdb/lib/relation-graph.test.ts src/cmdb/components/RelationGraphCard.test.tsx src/cmdb/components/InstanceDetailPeek.test.tsx src/cmdb/components/instance-detail/InstanceDetailDrawer.test.tsx src/components/MessageBubble.test.tsx && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 3: Real-browser screenshots**

启动应用，分别截取 light/dark，390/768/1280/1920 宽度：关系图卡片默认、展开后、点节点打开的只读详情、截断提示、错误提示。检查长名称、首尾节点、横向滚动。

- [ ] **Step 4: Diff hygiene**

Run: `git diff --check && git status --short`
Expected: 无空白错误；只包含本计划涉及的文件。

- [ ] **Step 5: Commit remaining fixes**

```bash
git add -A
git commit -m "test(cmdb): verify assistant graph integration"
```
