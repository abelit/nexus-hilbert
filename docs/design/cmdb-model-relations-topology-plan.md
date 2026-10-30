# CMDB 模型关系拓扑重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型详情页「模型关系」标签的拓扑视图重做成可下钻的左右分层树：分组语义色、玻璃节点、贝塞尔标注连线、悬停聚焦、折叠/展开、全屏与 PNG 导出。

**Architecture:** 在 CMDB 模块内新增独立拓扑组件（React Flow + dagre），纯图状态与布局放在 `model-topology.ts`，节点卡片与连线各自成文件。展开按远离中心的方向懒加载；悬停预取下一层用于显示真实 `+N`；可见图由「完整图 + expanded 集合」推导。共享 `TopologyGraph` 不再参与本页，上一版为其加的边标签开关一并撤销。

**Tech Stack:** React 18、TypeScript、@xyflow/react 12、@dagrejs/dagre 3、Tailwind 3、Vitest + Testing Library + MSW；新增 `html-to-image@1.11.13`。

**Spec:** `docs/design/cmdb-model-relations-topology.md`

## Global Constraints

- 只改前端；不新增/修改后端 API、数据库或模型关系数据。
- 不改变其他页面使用的 `src/components/topology/*` 行为；撤销 `Graph.tsx` 中 `showEdgeLabels` 与 `AvoidableEdge` 的标签渲染，并删除 `Graph.edge.test.tsx`。
- 新增运行时依赖只允许 `html-to-image@^1.11.13`。
- 用户可见文案全部走 `tr('中文', 'English')`，包括占位符、错误、Tooltip、徽标 `aria-label`。
- 复用 `.cmdb-liquid` 变量、`Button`、`Chip`、`EmptyStateCard`、`Toast`、`generateId` 等现有实现；不引入第二套主题或组件库。
- 颜色：中心 `#6366f1`；分组色板 `#3b82f6 / #0ea5e9 / #f59e0b / #8b5cf6 / #10b981 / #f43f5e`；未分组 `#64748b`。
- 节点尺寸：中心 190×64，普通 170×56；`nodesep 44`、`ranksep 120`、边距 40；可见节点上限 300。
- 触摸设备首次点击节点只聚焦，再次点击才跳转；鼠标单击直接跳转；点徽标只展开/折叠。
- 提交信息使用英文 Conventional Commits；**不推送、不 force push**。
- 每个任务结束运行对应测试；最后按 AGENTS.md 跑 `npm test`、`npm run build`、`npm run lint`、`npx tsc -b --noEmit`。

## Review Focus

1. **双向/循环关系**：A→中心 且 中心→A、或 A→B→A 时，不得重复建节点、无限展开或计数重复。—— Task 1 测试覆盖。
2. **探测竞态**：探测请求返回前切换模型、折叠或卸载时，过期结果不得写入当前图。—— Task 4 测试覆盖。
3. **触摸交互**：粗指针设备首次点击节点不得导航，且必须能显示关联路径的标签。—— Task 5 测试覆盖。
4. **并行多重边**：同一对模型多条关系时边与标签不得完全重叠。—— Task 3 测试覆盖。
5. **分组数据缺失**：`listModelGroups()` 失败或模型未分组时回退中性色，不得崩溃或整图空白。—— Task 7 测试覆盖。

---

### Task 1: 纯图状态与布局

**Files:**
- Create: `web/src/cmdb/components/model-relations/model-topology.ts`
- Test: `web/src/cmdb/components/model-relations/model-topology.test.ts`

**Interfaces:**
- Consumes: `CIType`, `RelatedType`, `ModelGroup` from `../../api/citype`、`../../api/preferences`.
- Produces:
  - `type Side = 'center' | 'left' | 'right'`
  - `type ModelNode = { id: number; alias: string; name: string; icon?: string; groupColor: string; side: Side; depth: number }`
  - `type ModelEdge = { key: string; source: number; target: number; relationId: number; relationName: string; relationColor: string; direction: 'in' | 'out' }`
  - `type ModelGraph = { nodes: Map<number, ModelNode>; edges: ModelEdge[] }`
  - `type ProbeEntry = { status: 'loading' | 'ready' | 'error'; items: RelatedType[] }`
  - `type BadgeState = { kind: 'none' } | { kind: 'expanded' } | { kind: 'loading' } | { kind: 'count'; count: number } | { kind: 'retry' }`
  - `const CENTER_COLOR = '#6366f1'`, `const NEUTRAL_COLOR = '#64748b'`, `const GROUP_PALETTE: string[]`, `const MAX_VISIBLE_NODES = 300`
  - `groupColorMap(groups: ModelGroup[]): Map<number, string>`
  - `createInitialGraph(center: CIType, parents: RelatedType[], children: RelatedType[], colors: Map<number, string>): ModelGraph`
  - `mergeExpansion(graph: ModelGraph, nodeId: number, items: RelatedType[], colors: Map<number, string>): ModelGraph`
  - `visibleGraph(graph: ModelGraph, expanded: Set<number>, centerId: number): ModelGraph`
  - `hiddenDescendantCount(graph: ModelGraph, nodeId: number, visibleIds: Set<number>): number`
  - `hasLoadedChildren(graph: ModelGraph, node: ModelNode): boolean`
  - `badgeForNode(node: ModelNode, expanded: Set<number>, probe: ProbeEntry | undefined, graph: ModelGraph, visibleIds: Set<number>): BadgeState`
  - `layoutModelGraph(nodes: ModelNode[], edges: ModelEdge[], centerId: number): Map<number, { x: number; y: number; width: number; height: number }>`

- [ ] **Step 1: Write the failing tests**

Cover, in `model-topology.test.ts`:
- `createInitialGraph`：中心 `side='center'`、`groupColor='#6366f1'`；父节点 `left/depth1`，边 `parent→center`；子节点 `right/depth1`，边 `center→child`；未分组节点用 `#64748b`。
- `groupColorMap`：按分组顺序分配色板；`is_other` 与未出现在分组里的模型不返回颜色；同一模型重复出现时以第一个分组为准。
- `mergeExpansion`（左侧）：传入 `relationParents` 的 items，新增 `parent→node` 边与新节点，`side='left'`、`depth+1`；已存在节点不改变原有 side/depth，只补边。
- `mergeExpansion`（右侧）：传入 `relationChildren` 的 items，新增 `node→child` 边。
- 循环：对已有节点再次合并只产生一条 `key` 边，不产生重复节点。
- `visibleGraph`：未 expanded 的节点其后代不可见；expanded 后可见；两端不同时可见的边被丢弃；中心两侧都可见。
- `hiddenDescendantCount`：三节点链 A→B→C，折叠 A 后计数为 2；B 已被其他可见路径带入时只计 1；唯一计数。
- `badgeForNode`：中心 `none`；expanded `expanded`；探测中 `loading`；无探测 `none`；探测 0 条 `none`；探测 N 条 `count N`；探测失败 `retry`；已加载过下级并折叠时 `count` 等于 `hiddenDescendantCount`。
- `layoutModelGraph`：中心坐标 `(0,0)`；左右节点 `x<0` / `x>0`；相同输入两次布局结果一致。

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/model-topology.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `model-topology.ts`**

纯函数，不引入 React；图遍历使用 `for` + `Set`，返回新对象不修改入参。`layoutModelGraph` 使用 `dagre.graphlib.Graph`、`rankdir:'LR'`、`nodesep:44`、`ranksep:120`、`marginx:40`、`marginy:40`，布局后整体平移使中心节点位于 `(0,0)`。

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/model-topology.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b --noEmit
git add web/src/cmdb/components/model-relations/model-topology.ts web/src/cmdb/components/model-relations/model-topology.test.ts
git commit -m "feat(cmdb): add pure model topology graph helpers"
```

---

### Task 2: 节点卡片

**Files:**
- Create: `web/src/cmdb/components/model-relations/ModelTopologyNode.tsx`
- Test: `web/src/cmdb/components/model-relations/ModelTopologyNode.test.tsx`

**Interfaces:**
- Consumes: `CMDBIcon` from `../CMDBIcon`; `BadgeState`、`ModelNode` from `./model-topology`.
- Produces:
  - `type ModelNodeCardData = { node: ModelNode; isCenter: boolean; badge: BadgeState; dimmed: boolean; focused: boolean }`
  - `function ModelNodeCard({ data, onOpen, onToggle }: { data: ModelNodeCardData; onOpen(): void; onToggle(): void }): JSX.Element`
  - `function ModelTopologyNodeView(props: NodeProps<Node<ModelNodeCardData & { onOpen(id:number): void; onToggle(id:number): void }>>): JSX.Element`（React Flow 适配层）

- [ ] **Step 1: Write the failing tests**

- 渲染别名、技术名、`CMDBIcon` 的 `aria-label`；长文本有 `title`。
- 中心节点带 `data-center="true"`；普通节点无。
- 徽标：`count 5` 显示 `+5` 且 `aria-label="展开 5 个下级"`；`expanded` 显示 `−` 且 `aria-label="收起下级"`；`loading` 显示加载指示且按钮禁用；`retry` 显示 `+`；`none` 不渲染徽标。
- 点击徽标只调用 `onToggle`，不调用 `onOpen`；点击卡片调用 `onOpen`。
- 键盘 Enter / Space 调用 `onOpen`；焦点时卡片有可见 outline 类。
- `dimmed` 时根节点 `style.opacity === '0.18'`，否则 `'1'`。

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/ModelTopologyNode.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ModelTopologyNode.tsx`**

根节点用 `div role="button" tabIndex={0}`，`onKeyDown` 处理 Enter/Space；徽标是独立 `<button type="button">` 并 `stopPropagation`。颜色全部通过 `style` 使用 `data.node.groupColor`；中心用 `CENTER_COLOR`。类名使用 `cmdb-model-topology-node` / `is-center` / `is-dimmed` / `is-focused`，具体外观放到 Task 8 的 CSS。

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/ModelTopologyNode.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/components/model-relations/ModelTopologyNode.tsx web/src/cmdb/components/model-relations/ModelTopologyNode.test.tsx
git commit -m "feat(cmdb): add model topology node card"
```

---

### Task 3: 贝塞尔连线与标签

**Files:**
- Create: `web/src/cmdb/components/model-relations/ModelTopologyEdge.tsx`
- Test: `web/src/cmdb/components/model-relations/ModelTopologyEdge.test.tsx`

**Interfaces:**
- Produces:
  - `type ModelEdgePaintData = { label: string; color: string; dimmed: boolean; showLabel: boolean; offset: number }`
  - `function ModelTopologyEdge(props: EdgeProps): JSX.Element`

- [ ] **Step 1: Write the failing tests**（mock `@xyflow/react`：`BaseEdge` 返回 `null`，`EdgeLabelRenderer` 原样渲染 children，`getBezierPath` 返回 `['M 0 0 C 50 0 50 40 100 40', 50, 20]`）

- `showLabel` 且 `label='contain'` 时渲染标签文本与 `data-edge-label` 容器。
- `showLabel=false` 时不渲染标签。
- `dimmed=true` 时线 `style.opacity === '0.18'`；`false` 时为 `'1'`。
- `offset=2` 时标签容器 `transform` 包含 `translate(0px, 20px)`（按 `offset * 10` 计算）。
- 标签 `color`/`borderColor` 等于 `data.color`，`background` 使用 `var(--bg-primary)`。

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/ModelTopologyEdge.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ModelTopologyEdge.tsx`**

`getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 })`；`BaseEdge` 不渲染标签，标签用 `EdgeLabelRenderer` 绝对定位；整体偏移 `offset * 10` 同时作用于路径和标签（路径包一层 `<g transform>` 或把 offset 加到 y）。标签 `pointerEvents:'none'`、`whiteSpace:'nowrap'`、圆角 8、内边距 `1px 5px`、字号 9–10px mono。

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/ModelTopologyEdge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/components/model-relations/ModelTopologyEdge.tsx web/src/cmdb/components/model-relations/ModelTopologyEdge.test.tsx
git commit -m "feat(cmdb): add labelled bezier edge for model topology"
```

---

### Task 4: 画布、探测、展开与折叠

**Files:**
- Create: `web/src/cmdb/components/model-relations/ModelRelationsTopology.tsx`
- Test: `web/src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`

**Interfaces:**
- Consumes: Task 1 的全部导出；Task 2 的 `ModelTopologyNodeView`；Task 3 的 `ModelTopologyEdge`；`relationParents`、`relationChildren`；`useToast`、`useI18n`。
- Produces:
  - `type ModelRelationsTopologyProps = { center: CIType; parents: RelatedType[]; children: RelatedType[]; groups: ModelGroup[] }`
  - `function ModelRelationsTopology(props: ModelRelationsTopologyProps): JSX.Element`

- [ ] **Step 1: Write the failing tests**（mock `@xyflow/react`：`ReactFlow` 渲染节点为 `button`、边为 `data-testid="edge-<id>"`，透传 `onNodeClick` / `onNodeMouseEnter` / `onNodeMouseLeave` / `onPaneClick`；`MiniMap`/`Controls`/`Panel` 渲染 children；`Background`/`Handle` 为 null；`useReactFlow` 返回 `fitView/zoomIn/zoomOut/setCenter` 的 `vi.fn()`）

- 初始渲染：中心、父、子节点的别名都在；边标签包含关系类型名。
- 悬停非中心节点：调用一次 `relationParents`（左侧）或 `relationChildren`（右侧）；结果为 5 条时出现 `aria-label="展开 5 个下级"`；0 条时不出现徽标。
- 点击 `+5` 徽标：不再发第二次请求（复用探测缓存），出现下级节点。
- 再次点击 `−`：下级节点消失，徽标变 `+N`（N 为隐藏后代数）。
- 切换 `center.id`：图重置为新的中心与一跳关系，旧节点消失。
- 探测返回前切换模型：旧响应不得出现在新图中（用 deferred promise 控制）。
- 展开后可见节点超过 300：不展开，并调用 `toast.error` 一次。
- 探测失败：徽标为 `retry`，再次点击重试。

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ModelRelationsTopology.tsx`（本任务只做到探测/展开/折叠）**

要点：
- 用 `useState<ModelGraph>`、`useState<Set<number>>`、`useState<Map<string, ProbeEntry>>`；`useEffect` deps `[center.id, parents, children, groups]` 重建图并重置 expanded/probe。
- `probe(node)`：`key = `${node.id}:${node.side}``；已有缓存或 in-flight 则跳过；左侧请求 `relationParents(String(node.id))`，右侧请求 `relationChildren`；写入 cache。
- 悬停/聚焦 200ms 防抖后调用 `probe`；组件卸载或 `center.id` 变化时用递增 `generation` ref 丢弃过期响应。
- `expand(node)`：等待探测 ready（没有则先探测），把结果合并到一份候选 `ModelGraph`，对候选图计算 `visibleGraph`；若 `nodes.size > MAX_VISIBLE_NODES` 则放弃这次展开并 `toast.error`，否则提交候选图并 `expanded.add`；`requestAnimationFrame` 后 `fitView({ padding: 0.18, duration: 300 })`。
- `collapse(node)`：`expanded.delete`；同样 fitView。
- 节点 data 由 `badgeForNode` 计算；边 data 由关系色、是否需要标签填充。
- React Flow：`nodesDraggable={false}`、`elementsSelectable={false}`、`minZoom={0.25}`、`maxZoom={2}`、`fitView`、`onPaneClick` 清空 focus。

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/components/model-relations/ModelRelationsTopology.tsx web/src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx
git commit -m "feat(cmdb): render expandable model topology canvas"
```

---

### Task 5: 悬停聚焦、触摸选择与节点跳转

**Files:**
- Modify: `web/src/cmdb/components/model-relations/ModelRelationsTopology.tsx`
- Modify: `web/src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`

**Interfaces:**
- Consumes: Task 4 的组件与状态。
- Produces: 无新导出；行为变化如下。

- [ ] **Step 1: Write the failing tests**

- 鼠标悬停节点 A：与 A 直接相连的节点 `data-dimmed="false"`，其余 `data-dimmed="true"`；相连边不透明，其余边 `opacity 0.18`。
- 移出节点：所有节点/边恢复不透明。
- 鼠标点击节点：`window.location` 变为 `/cmdb/models/<id>?tab=relations`（用 `MemoryRouter` + 路由探针断言，或 mock `useNavigate`）。
- `matchMedia('(pointer: coarse)')` 返回 true 时：第一次点击不调用 `navigate`，节点获得 `data-focused`；第二次点击同一节点调用 `navigate`。
- 点击画布空白：清除聚焦与 dim。
- 键盘聚焦节点：触发与悬停相同的 dim 与探测。

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`
Expected: FAIL — 新断言不满足。

- [ ] **Step 3: Implement**

- `focusedId` 状态；`connected` 用 `useMemo` 计算：`nodes = {focused} ∪ 直接邻居`，`edges = 任一端点为 focused 的边`。
- 节点 `onMouseEnter` / `onFocus` 设置 focused 并触发 probe；`onMouseLeave` / `onBlur` 清空（移动端点击不依赖 hover）。
- 触摸判定：`window.matchMedia?.('(pointer: coarse)')?.matches`；为 true 时 `onNodeClick` 第一次只 `setFocusedId`，同一节点再次点击才 `navigate`。
- 鼠标点击直接 `navigate('/cmdb/models/{id}?tab=relations')`；点徽标不冒泡到节点点击。
- 聚焦状态下边标签只保留相连边（`showLabel = !focused || connected`）；窄屏规则在 Task 8 用 CSS 处理。

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/components/model-relations/ModelRelationsTopology.tsx web/src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx
git commit -m "feat(cmdb): focus and touch interactions for model topology"
```

---

### Task 6: 工具栏、全屏与 PNG 导出

**Files:**
- Create: `web/src/cmdb/components/model-relations/model-topology-export.ts`
- Test: `web/src/cmdb/components/model-relations/model-topology-export.test.ts`
- Modify: `web/src/cmdb/components/model-relations/ModelRelationsTopology.tsx`
- Modify: `web/src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`
- Modify: `web/package.json`, `web/package-lock.json`

**Interfaces:**
- Produces:
  - `async function downloadTopologyPng(element: HTMLElement, filename: string): Promise<void>`（内部调用 `toPng(element, { backgroundColor: '#...', pixelRatio: 2 })`，创建 `<a download>` 并点击）
  - 工具栏按钮的 `aria-label`：`居中`、`放大`、`缩小`、`全屏`、`导出图片`、`迷你地图`、`关闭全屏`
- Consumes: `useReactFlow()` 的 `fitView` / `zoomIn` / `zoomOut`。

- [ ] **Step 1: Install the dependency**

```bash
cd web && npm install html-to-image@1.11.13
```

- [ ] **Step 2: Write the failing tests**

`model-topology-export.test.ts`（mock `html-to-image`）：
- 调用 `downloadTopologyPng(el, 'cmdb-host-relations.png')` 时 `toPng` 收到同一元素、`pixelRatio: 2`；
- 创建 download 链接，`download` 为文件名，点击一次；
- `toPng` reject 时 promise reject（由调用方 toast）。

`ModelRelationsTopology.test.tsx`：
- 「居中」调用 `fitView({ padding: 0.18, duration: 300 })`；「放大/缩小」调用 `zoomIn/zoomOut`。
- 点击「全屏」后容器带 `data-fullscreen="true"`、出现「关闭全屏」；按 Esc 关闭并把焦点还给全屏按钮。
- 点击「导出图片」：`toPng` 被调用一次，容器临时带 `is-exporting`；失败时 `toast.error` 一次。
- 「迷你地图」切换 `MiniMap` 的渲染。

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/model-topology-export.test.ts src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`
Expected: FAIL — module/behavior missing.

- [ ] **Step 4: Implement**

- 工具栏用 React Flow `Panel position="top-right"`，玻璃胶囊；图标用 `lucide-react` 的 `Maximize2`、`Crosshair`、`ZoomIn`、`ZoomOut`、`Download`、`Map`、`X`。
- 全屏不 portal、不重建画布：给外层容器加 `data-fullscreen="true"`，CSS 固定 `inset:0`；`useEffect` 监听 Esc；记录触发按钮并用 ref 在关闭时 `focus()`。
- 导出：进入 `is-exporting`（CSS 隐藏工具栏、迷你地图、标签与 dim），`fitView` 后 `requestAnimationFrame` 再截图，`finally` 恢复；失败 `toast.error(describeError(...))`。
- 迷你地图：`showMinimap` 状态，节点颜色用 `groupColor`；默认开启。
- 文件名为 `cmdb-${center.name}-relations.png`。

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/cmdb/components/model-relations/model-topology-export.test.ts src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/cmdb/components/model-relations/model-topology-export.ts web/src/cmdb/components/model-relations/model-topology-export.test.ts web/src/cmdb/components/model-relations/ModelRelationsTopology.tsx web/src/cmdb/components/model-relations/ModelRelationsTopology.test.tsx
git commit -m "feat(cmdb): add toolbar fullscreen and png export to model topology"
```

---

### Task 7: 接入模型关系标签，撤销共享组件改动

**Files:**
- Modify: `web/src/cmdb/components/ModelRuleTabs.tsx`
- Modify: `web/src/cmdb/pages/ModelDetail.test.tsx`
- Modify: `web/src/components/topology/Graph.tsx`（撤销上一版改动）
- Delete: `web/src/components/topology/Graph.edge.test.tsx`

**Interfaces:**
- Consumes: `ModelRelationsTopology`（Task 4–6）。
- Produces: `RelationsTab` 的拓扑视图改用新组件；`listModelGroups()` 加入 `load()`。

- [ ] **Step 1: Write the failing tests**

`ModelDetail.test.tsx`：
- 把原有对 `@/components/topology/Graph` 的 mock 换成对 `../components/model-relations/ModelRelationsTopology` 的 mock，渲染 `center` 别名、父/子别名与 `groups.length`。
- 视图切换测试仍覆盖列表/网格/拓扑；拓扑空状态时不渲染 mock。
- 分组接口失败（MSW 500）时页面仍渲染拓扑 mock，`groups` 为空数组。
- 删除原先依赖共享 Graph 节点的跳转断言（由 Task 5 组件测试覆盖）。

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/cmdb/pages/ModelDetail.test.tsx`
Expected: FAIL — 仍渲染旧组件/未请求分组。

- [ ] **Step 3: Implement**

- `RelationsTab`：新增 `groups` 状态；`load()` 用 `Promise.all([... , listModelGroups().catch(() => [])])`；删掉 `TopologyGraph`、`TopologyNode/Relation`、`showEdgeLabels` 与 topology 的 `useMemo`；拓扑分支渲染 `<ModelRelationsTopology center={center} parents={parents} children={children} groups={groups} />`。
- 若 `center` 为空（模型列表缺失），保持现有空/错误提示，不渲染画布。
- `Graph.tsx`：删除 `EdgeLabelRenderer` 导入、`AvoidingEdge` 导出与标签渲染、`showEdgeLabels` 属性与参数；恢复为只渲染 `BaseEdge`。删除 `Graph.edge.test.tsx`。

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/cmdb/pages/ModelDetail.test.tsx src/components/topology/layout.test.ts src/components/topology/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/components/ModelRuleTabs.tsx web/src/cmdb/pages/ModelDetail.test.tsx web/src/components/topology/Graph.tsx
git rm web/src/components/topology/Graph.edge.test.tsx
git commit -m "refactor(cmdb): use the model topology canvas in the relations tab"
```

---

### Task 8: 样式、响应式、文档与真实浏览器验收

**Files:**
- Modify: `web/src/cmdb/styles.css`
- Modify: `docs/design/frontend-design-language.md`
- Modify: `docs/design/cmdb-model-relations-topology.md`（状态改为「已实现」）

**Interfaces:**
- Produces: `.cmdb-model-topology` 作用域样式。

- [ ] **Step 1: Add the styles**

- `.cmdb-model-topology-node`：固定 170×56（中心 190×64）的玻璃卡片（`--liquid-panel` / `--liquid-border` / `--liquid-shadow`）、圆角 12px、`backdrop-filter: blur(16px) saturate(160%)`、`box-shadow` 轻阴影；长文本在卡片内截断；`is-center` 使用 2px `#6366f1` 边框与 `0 0 0 4px rgba(99,102,241,.12)`；`is-dimmed` 透明度 0.18，过渡 120ms；`is-focused` 可见 outline。
- 左侧 3px 色条用内联 `style` 的 `groupColor`。
- 徽标：18px 圆形、分组色底、白字、`hover` 提亮；加载中 `animate-spin`（仅 spinner 图标）。
- `.cmdb-model-topology`：画布容器使用不透明 `background: var(--bg-primary)`，保证 PNG 导出不是透明底；`position: relative`。
- 工具栏：玻璃胶囊、按钮 28px、`focus-visible` outline。
- 全屏：`[data-fullscreen="true"]` 固定 `inset:0`、`z-index` 高于工作区顶栏、背景 `var(--bg-primary)`；`is-exporting` 隐藏工具栏、迷你地图、标签。
- `@media (max-width:1023.98px)`：隐藏 `.react-flow__minimap`。
- `@media (max-width:639.98px)`：`.cmdb-model-topology-edge-label` 默认隐藏，`.is-connected` 显示；节点仍保持 170px 宽，文字截断，不做会导致热区错位的尺寸覆盖。
- 深浅主题均使用语义变量；检查对比度。

- [ ] **Step 2: Update the design language doc**

把 `docs/design/frontend-design-language.md` 中模型关系页签的那句话改为本次设计：左右分层树、分组语义色、悬停聚焦、悬停预取 `+N`、折叠、全屏、导出、触摸首次聚焦、窄屏规则。

- [ ] **Step 3: Run the full checks**

```bash
cd web && npx tsc -b --noEmit
cd web && npm run build
cd web && npm run lint
cd web && npm test
```

Expected: tsc/build/lint 通过；`npm test` 通过。若只剩已知的既有失败（`src/api/skills.test.ts` 期望 `edge_id`、实现发送 `device_id`，与 upstream 一致），如实记录，不修其他模块。

- [ ] **Step 4: Real-browser verification**

启动 `cd web && npm run dev`，用 Playwright（localhost:5173，拦截 `/api/v1/**` 提供模型数据）截图：

- 390 / 768 / 1280 / 1920，浅色与深色；
- 默认图、悬停聚焦、折叠 +N、全屏、空状态；
- 检查：标签不压线、无横向页面溢出、窄屏工具栏可达、触摸首次点击不跳转。

截图保存到 `/tmp/nexus-relations-v2/`，无法完成时在交付说明中写明未验证项。

- [ ] **Step 5: Commit**

```bash
git add web/src/cmdb/styles.css docs/design/frontend-design-language.md docs/design/cmdb-model-relations-topology.md
git commit -m "docs(design): document the model relations topology"
```

---

## Self-Review

- **Spec coverage**：布局、分组色、节点、连线、悬停、探测、折叠、全屏、导出、迷你地图、触摸、窄屏、300 上限、多路径/双向边、撤销共享组件改动、文档与截图，均有对应任务。
- **Type consistency**：`ModelGraph`、`ModelNode`、`ModelEdge`、`ProbeEntry`、`BadgeState` 在 Task 1 定义，后续任务只消费；`ModelRelationsTopologyProps` 在 Task 4 定义，Task 7 使用。
- **Review Focus**：循环/双向（Task 1）、探测竞态（Task 4）、触摸（Task 5）、并行边（Task 3）、分组失败（Task 7）均已在对应任务写入测试。
- **Proportion**：计划只固定接口、精确值与测试断言，不转录组件实现体。
