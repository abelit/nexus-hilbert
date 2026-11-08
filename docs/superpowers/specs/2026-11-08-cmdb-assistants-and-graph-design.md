# CMDB 三个助理与交互式关系图设计

Status: Proposed — 2026-11-08

## 意图

在 nexus-hilbert 的 AIOps 助手里补齐三类 CMDB 专业角色，并让“关系/依赖图”像 nexus-cantor 一样直接出现在会话里，而不是只给模型一段 JSON。

- **模型专家 `model-steward`**：回答“这个模型有哪些属性、哪个字段必填、哪个模型存 IP、两个模型怎么关联”这类**定义**问题。
- **变更审计 `change-auditor`**：回答“谁改了什么、什么时候改的、事故前有没有变更”这类**记录**问题；只报记录，不推断。
- **资源排查 `ci-investigator`**：回答“这台机器/这个服务挂了会影响谁、它依赖什么”这类**从 CI 出发的依赖与影响面**问题。
- **交互式关系图**：模型调用 `cmdb_relation_graph` 后，会话内渲染可交互卡片；节点可再展开一跳，可点开 CI 详情。

## 目标

1. 三个 persona 进入 `agents/`，成为 coordinator 可派发的 worker；各自有显式工具白名单与中文提示词。
2. `cmdb_relation_graph` 的输出升级为前端可渲染的图数据（root/nodes/edges/counts/truncated），同时仍然对模型有用。
3. 会话中的关系图卡片：React Flow 渲染、按上游/下游分层、节点 `+` 再展开一跳、点节点打开只读 CI 详情、超限聚合提示。
4. 复用现有依赖与组件：`@xyflow/react`、CMDB 的 `InstanceDetailDrawer`、`/ci-relations/search`、`/ci-type-relations`。不新增第三方图库。
5. 前后端都有回归测试；前端按 AGENTS.md 做真实浏览器 light/dark 截图验收。

## 非目标

- 不做 Mermaid / HTML 页面 / 图片导出；不做图的持久化或分享链接。
- 不新增写工具，不改变 CMDB schema 或 ACL。
- 不改变 coordinator 的派发机制；只提供 persona 的 `when_to_use`。
- 不把关系图做成单独页面；它只在会话工具结果里出现。
- 不在本次合并/推送分支（仍在 `feat/cmdb-agent-tools` 上叠加，PR 可拆）。

## 现状与约束

- 三个助理在 cantor 已有原型：`model-steward`、`change-auditor`、`ci-investigator`，均为显式工具白名单 + system prompt（`nexus-cantor/cmdb-api/api/lib/assistant/agents.py`）。
- cantor 的关系图是工具 payload + React Flow 卡片：`{root, nodes, edges, counts, truncated}`，节点 `+` 调 `/ci_relations/s` 再展开一跳，点节点打开 CI 详情（`cmdb-ui/src/features/assistant/`）。
- hilbert 的 persona 是 `agents/*.md`（YAML frontmatter + 中文正文），由 `chatruntime` 加载；工具白名单是显式的，内置工具不会自动放行。
- hilbert 的 AIOps P0 已有 9 个只读 `cmdb_*` 工具；`cmdb_relation_graph` 目前返回 `{nodes, edges, direction, truncated}`，节点字段是 `{ci_id, ci_type, name}`，边是 `{from, to, relation_id, relation_type_id}`。
- CMDB 前端是隔离模块：host 只能从 `web/src/cmdb/index.ts` 导入。`InstanceDetailDrawer` **目前没有真正的只读模式**：不传 `onEdit` 只隐藏 footer 的 Edit/rollback，内联编辑、文件上传和“添加关联”仍在；本次需要新增 `readOnly` 并贯穿 `InstanceOverview` / `InstanceRelations`。
- 关系扩展所需的接口已存在：`GET /api/v1/cmdb/ci-relations/search?root_id=&level=1&reverse=`、`GET /api/v1/cmdb/ci-type-relations`、`GET /api/v1/cmdb/instances/{id}`。
- `.go-arch-lint.yml` 仍禁止 manager import `internal/cmdb`；本次后端只改 `tools/cmdb` 的 HTTP client 层。

## 设计

### 1. 三个 persona

| 文件 | name | 定位 | 工具白名单 |
| --- | --- | --- | --- |
| `agents/model-steward.md` | `model-steward` | 模型/属性/关系定义与查询语法 | `cmdb_list_ci_types`、`cmdb_get_ci_type`、`cmdb_search_ci`、`cmdb_get_ci`、`cmdb_find_ci_type_path`、`query_knowledge`、`ToolSearch` |
| `agents/change-auditor.md` | `change-auditor` | CMDB 变更历史 + 平台变更事件 | `cmdb_get_ci_history`、`cmdb_get_ci`、`cmdb_search_ci`、`query_change_events`、`query_incidents`、`get_incident_detail`、`query_knowledge`、`ToolSearch` |
| `agents/ci-investigator.md` | `ci-investigator` | 从 CI 出发的依赖/影响面排查 | `cmdb_search_ci`、`cmdb_get_ci`、`cmdb_get_ci_relations`、`cmdb_query_relation_path`、`cmdb_find_ci_type_path`、`cmdb_relation_graph`、`query_devices`、`get_host_summary`、`expand_topology`、`find_topology_node`、`query_promql`、`query_logql`、`query_knowledge`、`ToolSearch` |

共同约束：

- **v3 coordinator 的 catalog 只渲染 `capabilities[].id/description`，不读 `when_to_use`**（`CapabilityCards()` + `system_prompt.go`）。因此每个 persona 必须写 `capabilities`，且 `description` 要能单独承担与其它 worker 的边界；`when_to_use` 仍需保留（人看、v1 兼容）。
  - `model-steward`：`cmdb_model_explanation` — “Explain CMDB models, attributes, relation types, and query syntax.”
  - `change-auditor`：`cmdb_change_audit` — “Report who changed which CI field and when, from the audit trail.”
  - `ci-investigator`：`cmdb_dependency_triage` — “Trace a CI's upstream/downstream dependencies and blast radius from the relation graph.”
- `permission_mode: read-only`；不授予 `host_bash`、`cloud_bash`、`*_skill` 等执行类工具。
- `when_to_use` 明确与现有 `incident-investigator` / `specialist-*` 的边界：
  - `incident-investigator` 从**告警/incident**出发做根因；
  - `ci-investigator` 从**某个资源**出发做依赖与影响面，不负责告警根因。
- `change-auditor` 的提示词要求“记录里没有就是没有”，不得把推断写成事实。
- `model-steward` 只讲定义；用户问实例值时明确切换到实例工具。

### 2. `cmdb_relation_graph` 输出升级

保留现有参数（`ci_id`、`direction`、`depth`、`max_nodes`），新增可选 `q`（按 CMDB 查询表达式解析 root，`ci_id` 优先）。**`direction` 默认改为 `both`**（与 cantor 一致）：模型不传方向时，卡片同时有上游和下游；“只查下游”仍需显式传 `down`。P0 的默认 `down` 与相关测试同步更新。

返回：

```json
{
  "root": {"id": 1, "name": "web-01", "type_id": 3, "type_name": "host"},
  "nodes": [{"id": 1, "name": "web-01", "type_id": 3, "type_name": "host"}],
  "edges": [{"source": 1, "target": 2, "label": "runs_on"}],
  "counts": {"upstream": 2, "downstream": 5},
  "truncated": false,
  "direction": "both",
  "note": "…"
}
```

- `source → target` 始终是 parent → child，与 CMDB 方向一致。
- `counts` 是**第一跳的真实邻居数**（root 的直接上游/下游），用每侧响应的 `numfound`，不是本次 payload 里可见的节点数；后续跳数不累加。某方向未查询时该计数为 0。
- `truncated` 除了节点/边达到上限，还包括第一跳 `numfound > 实际取回条数`，这样卡片能诚实地显示“还有更多”。
- `label` 取关系类型名：一次 `GET /ci-type-relations` 建 `relation_type_id → name` 映射；取不到时回退为空字符串。
- `type_name` 取模型别名或名称：一次 `GET /ci-types` 建 `type_id → alias/name` 映射。
- 保持现有的节点/边上限与去重规则（边 ≤ `2 × max_nodes`，无悬空边）。
- 为兼容模型，保留 `direction`；前端解析器忽略未知字段。

### 3. 会话内关系图卡片

**模块边界**：卡片、解析器、布局函数都放在 `web/src/cmdb/`，由 `web/src/cmdb/index.ts` 导出；host 的 `MessageBubble.tsx` 只从 `@/cmdb` 导入。

新增：

- `web/src/cmdb/lib/relation-graph.ts`
  - `RelationGraph` / `RelationNode` / `RelationEdge` 类型；
  - `parseRelationGraph(value: unknown): RelationGraph | null`：校验 root/nodes/edges，丢弃重复节点、重复边和悬空边；
  - `layoutRelationGraph(graph)`：root 居中，上游向左、下游向右，每 hop 一列；纯函数，便于测试。
- `web/src/cmdb/components/RelationGraphCard.tsx`
  - React Flow 画布；`COLUMN_WIDTH` / `ROW_HEIGHT` 与 cantor 对齐；
  - 头部：标题、上游/下游计数、`truncated` 提示；
  - 节点：名称 + 模型名；非 root 节点右上角 `+`；
  - `+`：并行请求 `/ci-relations/search?root_id=<id>&level=1&reverse=0/1`（`count=200`），合并节点与边，重新布局；同一跳不重复请求；
  - 展开的新边没有 `relation_type_id`，所以卡片挂载时取一次 `GET /ci-type-relations`，建 `(parentTypeID, childTypeID) → relation name` 映射，用于给展开边打标签；初始快照的边标签由工具 payload 提供；
  - 列溢出：用“还有 N 个”聚合节点，不无限铺开；
  - 点节点：打开只读 `InstanceDetailDrawer`；
  - 失败：展开失败在卡片内提示，不阻断会话；加载中显示 spinner 且禁用重复点击。
- `web/src/cmdb/components/InstanceDetailPeek.tsx`
  - 包装 `InstanceDetailDrawer`，并自带 `ToastProvider`（chat 路由没有 CMDB 的 provider，drawer/file 会调用 `useToast()`）。
  - 一次 `listCITypes()` 取全部模型（引用属性显示名与跨模型跳转需要），再按被点节点的 `type_id` 懒加载 `listTypeAttributes` / `listAttributeGroups`。
  - **真正的只读**：`InstanceDetailDrawer` 新增 `readOnly?: boolean`，默认 false 保持现有行为；为 true 时：
    - `InstanceOverview` 不接收 `onSaveValue`（隐藏字段铅笔与文件上传）；
    - `InstanceRelations` 隐藏“添加关联”和 `RelationAddDialog`；
    - footer 不显示 Edit，history 不显示 rollback。
  - 从 `web/src/cmdb/index.ts` 导出 `RelationGraphCard`、`parseRelationGraph`、`InstanceDetailPeek`。

**host 集成**：`web/src/components/MessageBubble.tsx` 的 `ToolCallSummaryBlock` 在通用块之前判断：

```tsx
if (call.name === 'cmdb_relation_graph' && !isError) {
  const graph = parseRelationGraph(call.result);
  if (graph) return <RelationGraphCard graph={graph} />;
}
```

历史回放与实时 SSE 都走同一条 `call.result`，因此旧会话也能渲染。

### 4. 交互细节

- **展开方向**：与 cantor 一致——从节点向下查 children、向上查 parents；方向继承父级分支，避免把兄弟节点误画成下游。
- **去重**：节点按 id、边按 `(source,target)` 去重；展开返回的已存在节点只补边。
- **上限**：前端单次展开最多合并 200 条邻接行；卡片最多渲染 `maxPerColumn` 个节点，其余聚合。
- **只读**：会话里的详情 drawer 使用 `readOnly`，隐藏内联编辑、文件上传、添加关联、Edit 和 rollback；控制台原来的抽屉行为不变（默认 false）。
- **可访问性**：节点是按钮，`aria-label` 用 `tr()`；`+` 是独立按钮，键盘可达；加载中有 `aria-busy`。
- **i18n**：所有文案走 `tr('中文','English')`；图例、计数、截断提示、错误提示都要覆盖。
- **窄屏**：画布横向滚动，不压缩节点；卡片在 390px 下仍可用。

### 5. 测试

后端：

- `cmdb_relation_graph`：root 字段、`counts` 只算第一跳、`label` 映射、`type_name` 映射、`q` 解析 root、截断/去重/无悬空边（扩展现有 `TestRelationGraphBounds*`）。

前端：

- `relation-graph.test.ts`：解析合法/畸形 payload、丢弃重复/悬空边、布局列数与方向。
- `RelationGraphCard.test.tsx`：渲染 root/nodes、`+` 展开合并、展开失败提示、点节点打开详情。
- `MessageBubble.test.tsx`：`cmdb_relation_graph` 结果走卡片而不是通用 JSON 块；非法结果回退通用块。
- `InstanceDetailPeek.test.tsx` / `InstanceDetailDrawer.test.tsx`：`readOnly` 时没有字段编辑、文件上传、添加关联、Edit/rollback；默认行为不变。
- 真实浏览器：light/dark，390/768/1280/1920；长名称、首尾节点、展开后节点、截断提示。

persona：

- `cmd/ongrid/skill_bootstrap_test.go` 增加三个 agent 的加载与白名单断言。

## 取舍

- **升级现有工具而不是新增 `cmdb_relation_diagram`**：避免模型为了画图多调一次工具，也避免“同一事实两种 payload”。前端忽略不认识的字段，模型仍能读图。
- **React Flow 而不是 Mermaid**：`@xyflow/react` 已是依赖；Mermaid 需要新依赖，且交互式展开要重写。cantor 的实现可直接借鉴。
- **详情用只读 drawer**：复用 `InstanceDetailDrawer`，不新建页面；新增 `readOnly` 贯穿子组件，保证会话里的图不会被误操作。这会触及共享组件，但默认值 false，控制台行为不变。
- **图表放 CMDB 模块、host 只从 `@/cmdb` 导入**：维持模块隔离边界，CMDB 可继续 rebase。

## 风险

- `cmdb_relation_graph` payload 变化会影响现有 P0 测试与任何按旧字段消费的调用方；本次同步更新测试，旧字段（`ci_id`/`from`/`to`）不再保留。若担心兼容，可同时保留旧字段一版——**默认不保留**，因为工具尚未发布。
- 大图渲染与展开请求可能拖慢会话；用节点/边上限、列聚合和单次展开 200 行兜底。
- 详情 drawer 依赖模型元数据，首次打开可能多 3 个请求；懒加载 + 失败提示。
- 窄屏下 React Flow 的平移/缩放与聊天滚动冲突；需要实际浏览器验证，必要时限制画布高度并禁用滚轮缩放。

## 验证

- Go：`go test -race ./internal/manager/biz/aiops/tools/... ./cmd/ongrid/...`；`make arch-lint`（工具缺失时如实记录）。
- Web：`npm test -- <相关测试>`、`npm run build`、`npm run lint`。
- 截图：按 AGENTS.md 在真实浏览器验证 light/dark 与 390/768/1280/1920。
- 不改数据库 schema；不需要迁移。
