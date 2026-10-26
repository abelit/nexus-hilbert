# CMDB 移植与独立服务实施计划

- 状态：代码与最终评审修复完成，待推送/PR
- 分支：`feat/cmdb-standalone-service`
- 基线：`main` @ `fe0a108`
- 关联：[ADR-035](../../docs/adr/ADR-035-cmdb-standalone-service.md)、[CMDB 服务部署说明](../install/cmdb-service.md)
- 最后更新：2026-10-26

本文件是 CMDB 移植的**可恢复执行清单**。上下文被压缩或换人接手时，按下面的顺序恢复：

1. 读本文件的“当前状态”和“下一步”；
2. `git log --oneline main..HEAD` 核对已存在的提交；
3. 只做第一个未勾选的步骤，完成一个 PR/子步骤就更新本文件并提交；
4. 不要重做已勾选的步骤；不要用 `git reset` 回退已提交内容。

设计范围与不移植项以批准的计划为准：
`/home/abelit/.claude/plans/home-abelit-documents-code-github-nexus-stateless-sundae.md`。

## 当前状态

| 阶段 | 状态 | 提交 | 说明 |
| --- | --- | --- | --- |
| PR1 独立运行时 | 已完成 | `9cef6aa` `ac24647` `2caebf4` `a2b3754` `ed626fc` | 迁移锁、路由 golden、`cmd/ongrid-cmdb`、manager 解耦、开发部署、评审修复 |
| PR2 生产安装/发布 | 已完成 | `1fe51c2` | install compose/nginx/Prometheus、install/upgrade 健康检查、Makefile、release workflow、ADR/运维文档 |
| PR3 偏好/关系/树视图/关系视图 | 已完成 | `7e854a2` `cf7509b` `b20f4a9` `1af1f4b` `49f65c9` | API、偏好页、资源层级、关系创建、菜单分组；真实浏览器截图由 PR9 覆盖 |
| PR4 批量导入 | 已完成 | `192eac2` | CSV/XLSX 解析、预览、提交、模板、Instances 入口；截图由 PR9 覆盖 |
| PR5 自动发现 UI | 已完成 | `5239783` `a583d52` | `target-types` 端点，规则/账号/目标/目录/模板页面；截图由 PR9 覆盖 |
| PR6 ADC 发现池 | 已完成 | `4a0d95d` | 池表/执行日志、API、接受事务、`/cmdb/adc` 页面；截图由 PR9 覆盖 |
| PR7 操作历史 | 已完成 | `04b49aa` | 只读 API、6 条路由、`/cmdb/operation-history` 页面；截图由 PR9 覆盖 |
| PR8 拓扑视图 | 已完成 | `abaf2bc` | 两张表、CRUD/排序/预览、图装配、`/cmdb/topology-views` 页面；截图由 PR9 覆盖 |
| PR9 E2E/收尾 | 已完成 | `38d34eb` `c12fa0e` | DCIM move/rename、ModelDetail 自动发现 tab、144 张响应式截图、MySQL/CMDB/nginx 实测 |
| 最终全分支评审 | 已完成 | `f94d283`…`88a7713` | 1 critical + 8 important 修复；7 minor 与 1 条残余风险记录 |

PR1–PR9 的代码与验证已完成，最终全分支评审的 1 个 critical、8 个 important 已全部修复（`f94d283`…`cdd051d`），7 个 minor 与 1 条残余风险记录在下文。分支可进入 PR/评审。未推送、未创建 PR；推送前按 AGENTS.md 运行 `gh pr checks`。

## 已完成阶段的验收证据

### PR1

- `internal/pkg/dbx`：`RunMigrationsLocked`；MySQL `GET_LOCK` 固定连接、数据库名作用域、独立 release context；SQLite `<db>.migrate.lock`；`:memory:` 跳过。
- `internal/cmdb/server`：`RegisterAll` + `Handlers`；`testdata/routes.golden` 锁定 145 条路由；不完整 handler 直接 panic。
- `cmd/ongrid-cmdb`：`/healthz`、`/readyz`、`/metrics`、`/api/v1/cmdb/*`、JWT、OTel HTTP span、`--version`、`--healthcheck`、优雅退出；默认 `:8082`/`:9102`。
- `cmd/ongrid`：CMDB import/迁移/装配/路由全部移除；`cmd/ongrid/cmdb_split_test.go` 防止重新 import。
- 验证：`go test ./...`、`go vet ./...`、受影响包 `-race`、MySQL gated 锁测试、真实二进制 SQLite 端到端、`make test-web-ci-cmdb`（117 tests）、`npm run build`、compose config、package/release 脚本测试。

### PR2

- `deploy/install/docker-compose.yml`：`ongrid-cmdb` 镜像、DB/JWT/secret、连接池 20/5、`--healthcheck`、metrics 端口。
- `deploy/install/nginx.conf`：`/api/v1/cmdb/` 与 `/cmdb-readyz`。
- `deploy/install/prometheus.yml`：`ongrid-cmdb:9102`。
- `install.sh`/`upgrade.sh`：同时等待 `/healthz` 与 `/cmdb-readyz`；旧镜像清理包含 CMDB。
- `Makefile`/`release.yml`：`docker-push-cloud-cmdb`、`cmdb-image` job、manifest 校验。
- `docs/adr/ADR-035-cmdb-standalone-service.md`、`docs/install/cmdb-service.md`。

## 最终全分支评审（2026-10-26）

范围：`fe0a108...c12fa0e` 的全部 141 个文件。方法：5 个独立维度（发现/ADC、历史/拓扑、安全与 API 契约、前端、运行时/部署），每个维度先由独立评审员检查，再由独立验证员逐条尝试反驳；只接受能构造出具体失败场景的结论。共 17 条 CONFIRMED（1 critical、8 important、8 minor），2 条 REFUTED（历史 RFC 3339 小数秒、升级后 Prometheus 不重载）。

### 已修复（critical / important）

| 严重度 | 位置 | 问题 | 提交 |
| --- | --- | --- | --- |
| critical | `biz/history`、`biz/ci`、`biz/citype` | 操作历史按原值返回 password/link/file 属性，任何登录用户可通过 `GET /v1/cmdb/history/ci/{id}` 读到密码；历史实例名也可能取到 password 的 show/unique 属性 | `f94d283` |
| important | `biz/topology/graph.go` | 正层走完后负层从最深层子节点向上，混合方向视图画的是子节点的祖父而不是根节点的父节点 | `715d88e` |
| important | `biz/discovery/usecase_adc.go` | 已接受行的实例被删除后，未变化的后续上报仍被当作“已接受”直接返回，auto-accept 目标永远不会重建实例 | `dcf6a45` |
| important | `biz/history` + `web/.../history` | 服务端按 `time.Local` 解析无时区时间、容器为 UTC，前端发送浏览器本地墙钟；UTC+8 运维筛选和看到的时间整体偏移 8 小时 | `f94d283` `52f74dc` |
| important | `web/.../ModelRelations.tsx` | 新建关系发送 `1-N`/`1-1`/`N-N` 显示标签，后端只接受 `0`/`1`/`2`，新增关系主操作必然 400 | `c92e165` |
| important | `web/.../Subscriptions.tsx` | `Preferences` 内嵌订阅页隐藏了含“自动订阅”按钮的页头，侧栏又已改指偏好页，自动订阅在 UI 不可达 | `1359521` |
| important | `web/.../sheet.ts` | Excel 日期单元格输出 `toISOString()`，date 属性校验拒绝该格式，含真实日期列的 XLSX 无法导入 | `cdd051d` |
| important | `web/.../TopologyViews.tsx` | 切换视图失败时保留上一张图；快速切换时晚到响应覆盖当前视图，图会挂在另一个视图标题下 | `458e823` |
| important | `web/.../DiscoveryPool.tsx` | 切换模型时旧请求晚到会覆盖新模型的行/列/计数，接受/删除可能作用在另一个模型的发现记录上 | `b462299` |

另外修复一条 minor：`data/history/store` 未把 `ctx` 传给 GORM，违反 AGENTS.md 对新增 IO 路径的要求，随 `f94d283` 提交。

### 记录但本阶段不修（7 条 minor）

- 发现目标删除与上报并发：`DeleteTarget` 的计数与删除不在同一把目标行锁下，可能留下指向已删除目标的池行；窗口窄、可手动删除，见 `data/discovery/store/target.go`。
- 拓扑图把根节点预置为 visited，自引用中心模型的根→子边会被丢弃；触发面窄，修图遍历时可一并处理。
- `HistoryCINames` 逐实例 `LoadCI`，拓扑最多 2000 节点时为 N+1；后续可改用批量读取。
- `TopologyView.Path` 为 `map[string][]int32`，接管 cantor 的字符串 id 行会导致 500；本轮计划不接管 cantor 数据。
- 拓扑分组/视图名称/category 未按 varchar(64)/(32) 校验，超长在 MySQL strict 下返回 500 而不是 400；接口 admin-only。
- `FacetTree` 把层级值直接拼进搜索表达式，值含逗号时查询被拆错；可复用 `dsl.ts` 的 `escapeValue`。
- `uninstall.sh --purge` 未删除新增的 `ongrid-cmdb` 镜像，升级/卸载后会残留磁盘。

### 仍未覆盖的风险

- 历史密码脱敏依赖当前模型的有效属性集。属性被软删除后，历史行仍保留原值，而 resolver 已看不到它的 password 标记；任何登录用户仍可通过单 CI 历史读到这些旧值。后续应让历史解析包含软删除属性元数据，或在属性删除时清理/脱敏历史。

### 本轮验证

- Go：`go test ./...` 通过（168 个 ok 包，exit 0）；`go vet ./...` 通过。
- 前端：`make test-web-ci-cmdb` 30 文件 / **168 tests**；`npm run typecheck`、`npm run build` 通过；改动文件 `eslint` 0 错误。
- 真实浏览器：`npx playwright test e2e/cmdb-pages-responsive.spec.ts --no-deps`（`E2E_BASE_URL=http://127.0.0.1:5173`，Vite dev server）**144 passed**；历史页子集 16 passed。
- 全量 `npm run lint`：53 problems（9 errors / 44 warnings），与基线一致，改动文件不在错误列表。
- `git diff --check` 通过；人工 import 边界核对通过（`cmdb/biz`→`cmdb/data`/其它 BC、`cmdb/server`→`cmdb/data`、`pkg`→BC、`cmd/ongrid`→`cmdb` 均为空）。
- `make arch-lint` 仍未运行：本机无工具，且 `scripts/agent-observability/README.md:107` 已记录该配置在 go-arch-lint 1.12.0 下校验失败，属既有问题；不能记为通过。

## 已知限制（不要误判为已通过）

- `make arch-lint` 未运行：本机缺少 `go-arch-lint`，且 Makefile 的 skip 分支仍会执行下一行。`scripts/agent-observability/README.md:107` 记录该配置在 go-arch-lint 1.12.0 下本身校验失败（缺 `internal/edgeagent/data/**`、空依赖项），属既有问题。PR 描述必须写“未运行”，不能写通过。
- 历史密码脱敏只覆盖当前有效属性集；软删除属性的历史值仍可能泄露，见“最终全分支评审 / 仍未覆盖的风险”。
- `make test-release-workflow` 未运行：本机缺少 Ruby，Docker Hub 拉取 ruby 镜像超时；已用 Python 解析 `release.yml` 核对 job/needs/condition。
- `npm run lint` 有 9 个既有错误，位于未触及文件；本次改动未新增 lint 错误。
- 未做真实 MySQL 容器级 compose 启动；SQLite 端到端和 MySQL gated 锁测试已覆盖核心路径。PR9 前补一次 compose 启动验收。
- 发布前必须同时替换 `ongrid` 与 `ongrid-cmdb`；旧 manager 仍挂载 CMDB 路由。
- ADC 关系装配的 peer 查找受 CMDB 最大分页限制（`MaxInstancePageSize`，当前 500）：一个字段匹配超过 500 个实例时，尾部的关系边不会写入；实例本身仍会接受。
- 清空某个模型的执行日志当前仅要求登录，没有 admin gate；cantor 也没有更细的权限，ACL Epic 再补。
- 发现池按 `(type_id, unique_value)` 合并，但该索引不是唯一索引（兼容 adoption 重复）；同一对的并发上报仍可能各插一行，下一次上报会合并到先查到的一行。
- PR9 的 compose 实测用的是本机缓存的 MySQL 8.0.46、`ongrid:dev`、frontier 1.2.6、nginx，以及临时 bookworm 变体构建的 CMDB 镜像；`deploy/docker-compose.yml` 没有原样启动（基础镜像仓库 403）。停 CMDB 时网关错误在本机为 504（Docker 停止容器的 IP 仍被 nginx 缓存），不是计划里写的 502。
- 响应式截图在 `output/playwright/results/`（git-ignored），共 144 张；没有提交到仓库。
- Playwright 默认 `baseURL` 是 `https://localhost:8443`（nginx 栈）。栈未运行时用本地 Vite dev server 加 `E2E_BASE_URL=http://127.0.0.1:5173`，并用 `--no-deps` 跳过依赖真实后端的 auth setup；用例本身 mock `/api/v1/**`。

## PR3 明细（已完成）

目标：补齐 CMDB 菜单中的偏好、模型关系、资源层级、关系视图入口，全部复用现有后端；不新增后端接口。

### PR3a API 客户端

- [x] `web/src/cmdb/api/preferences.ts` 增加：
  - `listModelGroups()` → `GET /preferences/model-groups`（`{items,total}`）；
  - `createModelGroup(name)` → `POST /model-groups`；
  - `updateModelGroup(id, {name?, type_ids?})` → `PUT /model-groups/{id}`；
  - `deleteModelGroup(id, typeIDs?)` → `DELETE /model-groups/{id}`；
  - `reorderModelGroups(groupIDs)` → `PUT /model-groups/order`；
  - `TreeLevel`/`listTreeLevels()` → `GET /preferences/tree-levels`（bare array）；
  - `setTreeLevels(ref, levels: string[])` → `PUT /preferences/ci-types/{ref}/tree-levels`；
  - `SavedSearch`/`listSavedSearches(params?)`/`createSavedSearch`/`updateSavedSearch`/`deleteSavedSearch`。
- [x] 新增 `web/src/cmdb/api/preferences.test.ts`，覆盖查询串、列表解包、写 body。
- 验收：`npx vitest run src/cmdb/api/preferences.test.ts`（4 tests 通过）。提交 `7e854a2`。

### PR3b Preferences 页面

- [x] `web/src/cmdb/pages/Preferences.tsx`，Tabs：
  - **模型与列**：复用现有 `Subscriptions` 内容（给 `Subscriptions.tsx` 增加 `embedded?: boolean`，嵌入时隐藏 `PageHeader`）。
  - **模型分组**：列表、创建/重命名、删除、上下移动、给分组分配模型（`listCITypes` 多选）。仅 admin 可写。
  - **树层级**：选择模型 + 有序属性列表（`listTypeAttributes`），保存 `setTreeLevels`；空列表表示清除。
  - **自动订阅**：复用 `Subscriptions` 的自动订阅入口（模型与列 tab 内）。
  - **保存搜索**：列表、创建/编辑（名称 + option JSON + 可选 type_id）、删除。
- [x] 组件放 `web/src/cmdb/components/preferences/`：`ModelGroupsPanel.tsx`、`TreeLevelsPanel.tsx`、`SavedSearchesPanel.tsx`。
- [x] `Preferences.test.tsx`：分组列表/创建/分配/非 admin 禁用、树层级保存、保存搜索创建/非法 JSON。
- 验收：`npx vitest run src/cmdb/pages/Preferences.test.tsx`（6 tests 通过）、`npm run typecheck` 通过。提交 `cf7509b`。
- [x] 真实浏览器截图：`web/e2e/cmdb-pages-responsive.spec.ts` 覆盖 Preferences、TreeViews、Relations、ServiceTree（390/768/1280/1920、zh/en、light/dark）。

### PR3c TreeViews 页面

- [x] `web/src/cmdb/pages/TreeViews.tsx`：
  - 读 `listTreeLevels()`；无视图时 `EmptyState` 链接到 `/cmdb/preferences`；
  - 左侧按选中视图的 `levels[]` 懒加载 facet 树：
    `searchInstances({ q: '_type:<id>[,<level>:<value>]', facet: [nextLevel], count: 1 })`；
  - 右侧 `DataTable` 显示当前路径的实例，复用 `Search` 页的行渲染/分页；
  - 切换视图重置路径；路由 `/cmdb/tree-views` 与 `/cmdb/tree-views/:typeId`。
- [x] 组件 `web/src/cmdb/components/tree-views/FacetTree.tsx`。
- [x] `TreeViews.test.tsx`：懒展开、路径变化触发查询、空态。
- 验收：`npx vitest run src/cmdb/pages/TreeViews.test.tsx`（2 tests 通过）。提交 `b20f4a9`。

### PR3d Relations 页面

- [x] 增强 `web/src/cmdb/pages/ModelRelations.tsx`：
  - 工具栏“新建关系”打开关系表单；
  - 选择父模型、子模型、关系类型（`listRelationTypes`）、基数；属性对编辑未做（后续增量）；
  - 保存 `saveRelation(parentRef, childRef, input)`；删除沿用现有确认；
  - 关系已存在时展示后端错误，不覆盖；非 admin 禁用写操作；
  - 增加路由别名 `/cmdb/relations` 指向同一页面。
- [x] `ModelRelations.test.tsx` 增加创建/非 admin 用例。
- 验收：`npx vitest run src/cmdb/pages/ModelRelations.test.tsx`（5 tests 通过）。提交 `1af1f4b`。

### PR3e 菜单/命令面板/分组

- [x] `web/src/cmdb/routes.tsx`：
  - `/cmdb/preferences` → Preferences；
  - `/cmdb/tree-views`、`/cmdb/tree-views/:typeId` → TreeViews；
  - `/cmdb/relations` → ModelRelations（兼容 `/cmdb/model-relations`）；
  - “关系视图”入口复用 `/cmdb/service-tree`（现有 ServiceTree 页面）。
- [x] `cmdbNavSection` 增加：偏好设置、资源层级、关系、关系视图；`CMDBNavItem` 增加 `group?: string`。
- [x] `Sidebar.tsx` 的 `SidebarSectionItem` 支持 `group`，在 CMDB section 内渲染分组标题；`Sidebar.test.tsx` 补断言。
- [x] `cmdbPaletteRoutes` 更新新入口；`web/src/lib/routes.ts` 自动合并。
- [x] 文案全部 `tr('中文','English')`。
- 验收：23 个 CMDB 测试文件 / 130 tests 通过；`npm run typecheck`、`npm run build` 通过。提交 `49f65c9`。

### PR3 验证

- [x] `make test-web-ci-cmdb`（130 tests）、`npm run typecheck`、`npm run build`。
- [x] `npm run lint`：全量 53 problems（9 errors / 44 warnings），均为既有问题；改动文件 0 错误。
- [x] 真实浏览器：390/768/1280/1920，zh/en，light/dark；Preferences、TreeViews、Relations、ServiceTree 均由 PR9 的响应式 spec 覆盖（144 passed）。

## 后续阶段清单

### PR4 批量导入（前端）

- [x] `web/src/cmdb/api/import.ts`：`previewImport`/`commitImport` → `/import/preview|commit`。
- [x] `web/src/cmdb/lib/sheet.ts`：CSV 原生解析；XLSX 懒加载 `exceljs`；行/列上限 5000/200；模板生成。
- [x] `web/src/cmdb/pages/BatchImport.tsx`：模型/存在策略/上传/预览/列映射/坏行/提交/结果；模板下载。
- [x] Instances 页入口；路由 `/cmdb/batch`；Vitest 覆盖解析、预览、提交、坏 JSON/超限。
- [x] 唯一新增运行时依赖 `exceljs`，构建产物为独立懒加载 chunk（~938KB）。
- 验收：`npx vitest run src/cmdb/pages/BatchImport.test.tsx src/cmdb/lib/sheet.test.ts`（4 tests 通过）；CMDB 全量 25 文件/134 tests；`npm run typecheck`、`npm run build` 通过。提交 `192eac2`。

### PR5 自动发现 UI（前端 + 一个只读端点）

- [x] 后端 `GET /v1/cmdb/discovery/target-types`（any authed）→ `{items:[{type_id,name,alias,icon,target_count}],total}`；usecase 从 target 行计数，handler + 测试 + golden 已更新。提交 `5239783`。
  裁定：计数在 usecase 内完成而不是新增 store group-by；一次部署的 target 只有几十条，避免为单次查询增加 store 方法。
- [x] `web/src/cmdb/api/discovery.ts`：rules/accounts/targets/catalog/templates 封装。
- [x] `web/src/cmdb/pages/Discovery.tsx` + `components/discovery/{RulesPanel,TargetDrawer,TargetsPanel,CatalogPanel,TemplatesPanel}.tsx`：四 tab；规则抽屉含账号与插件脚本 `Textarea`；目标抽屉含映射、agent/query/all、cron、auto_accept、脱敏凭据；target test 展示后端 501。
- [x] 路由 `/cmdb/discovery`、侧栏「资源管理」、命令面板；Vitest 10 tests。
- [x] 目标树的模型列表合并 `target-types` 与全部已挂载模型：只列“已有目标”的模型会让模型的首个目标无法从页面创建。
- [x] 账号只在读取成功后回写，读取失败不覆盖已有账号。
- 验收：`npx vitest run src/cmdb/pages/Discovery.test.tsx`（10 tests）、CMDB 全量 26 文件/144 tests、`npm run typecheck`、`npm run build`、改动文件 `eslint` 通过。提交 `a583d52`。
- [x] 真实浏览器截图（PR9 统一完成：144 passed）。
- 已知限制：HTTP 规则首次创建目标时，映射字段需要先在抽屉里选择资源类型（规则自带 `categories`，如 `ecs`）；插件/SNMP/组件规则从规则字段表或内置目录取字段。

### PR6 ADC 发现池（后端 + 前端）

- [x] 模型：`internal/cmdb/model/discovery/pool.go` 的 `c_ad_ci`、`c_ad_exec_histories`；`(type_id,unique_value)` 复合索引；exec history 用 `AppendOnlyBase`。
- [x] store `internal/cmdb/data/discovery/store/adc.go`；`Migrate` 注册；计数用 `COUNT(*)`，未建 `c_ad_counter`。
- [x] biz `internal/cmdb/biz/discovery/usecase_adc.go`：`PoolRepo`、`InstanceWriter`、`AttributeResolver`；list/get/upsert/accept/delete/counter/exec-history；accept 幂等；`auto_accept`；`MarkAutoDiscovery` 写 `c_cis.a`；CI+关系同事务 `WriteWithRelations`。
- [x] server `internal/cmdb/server/discovery/http_adc.go`：11 条 `/v1/cmdb/discovery/adc*` 路由；目标删除 409（`ErrTargetReferenced`）。
- [x] 前端 `pages/DiscoveryPool.tsx` + `components/discovery/adc/{PoolTree,CounterStrip,PoolTable,RawDataDrawer,ExecHistoryDialog}.tsx`；路由 `/cmdb/adc`、侧栏、命令面板。
- [x] 测试：upsert/合并/重置/计数/执行日志、accept 幂等与映射、目标删除 409、路由契约、`cmd/ongrid-cmdb` 装配。
- 验收：受影响包 `go test -race` 通过；全量 `go test ./...`、`go vet ./...` 通过；CMDB 前端 27 文件/149 tests；`npm run typecheck`、`npm run build`、改动文件 `eslint` 通过。提交 `4a0d95d`。
- [x] 真实浏览器截图：包含在 PR9 的响应式 spec 中。
- parity 缺口：cantor 的预定义 value mapping 文件不在两个仓库中，接受时写原始值；`aggregation_count` 仅存储不使用（cantor 后端同样未使用）。

### PR7 操作历史（后端 + 前端）

- [x] `internal/cmdb/biz/history`、`data/history/store`、`server/history`；读 `c_records` + 四张历史表。
- [x] API：`/v1/cmdb/history/attributes|relations|ci-types|ci-triggers`、`/history/ci/{id}`、`/history/ci/{id}/triggers`；`{items,total}`，page_size ≤ 200，按历史 id 倒序。
- [x] 全局历史 admin-only；单 CI 历史 any authed；显示名用 `CINameResolver`/`AttributeResolver`/`TypeNameResolver`；用户名由前端 `/api/v1/users` 映射，失败显示 `#uid`。
- [x] 前端 `pages/OperationHistory.tsx` + `components/history/{HistoryFilters,HistoryRecordDrawer}.tsx` 四 tab + 过滤/分页/抽屉；路由 `/cmdb/operation-history`。
- [x] 测试：过滤/分页/时间范围/空结果/权限、路由契约、`cmd/ongrid-cmdb` 装配。
- 验收：受影响包 `go test -race` 通过；全量 `go test ./...`、`go vet ./...` 通过；CMDB 前端 28 文件/154 tests；`npm run typecheck`、`npm run build`、改动文件 `eslint` 通过。提交 `04b49aa`。
- [x] 真实浏览器截图（PR9 统一完成：144 passed）。
- 已知限制：`c_records.created_at`、`uid`、`type_id`、`ci_id`、`attr_id`、`record_id`、`trigger_id` 已有索引；`c_ci_type_histories.created_at` 与 `c_ci_trigger_histories.created_at` 没有新增索引，按时间过滤这两张表在大数据量下会扫描。
- 已知限制：模型变更表没有 `record_id`（cantor 自己的 `uid/change`），所以“用户”列取该表的 `uid`，不能关联到一次写入的来源/工单。

### PR8 拓扑视图（后端 + 前端）

- [x] 模型 `internal/cmdb/model/topology/topology.go` 的 `c_topology_view_groups`、`c_topology_views`；store/migrate；`data.Migrate` 注册。
- [x] biz：CRUD/排序/预览/图装配；`GraphQueries` 由 `biz/ci` 适配；自环去重、正/负层、根 200/节点 2000/深度 5 上限（超限 400）。
- [x] server `internal/cmdb/server/topology/http.go`：14 条 `/v1/cmdb/topology-views*` 路由；分组删除 409；无 grant。
- [x] 前端 `api/topology.ts`、`pages/TopologyViews.tsx`、`components/topology/{TopoGraph,TopologySidebar,TopologyViewDrawer}.tsx`；复用共享 `TopologyGraph`（`@xyflow/react` + dagre）；路由 `/cmdb/topology-views`。
- [x] 测试：图去重/自环/上下层/上限、store CRUD/排序/分组守卫、路由契约、`cmd/ongrid-cmdb` 装配、前端列表/创建/预览/权限。
- 验收：受影响包 `go test -race` 通过；全量 `go test ./...`、`go vet ./...` 通过；CMDB 前端 29 文件/158 tests；`npm run typecheck`、`npm run build`、改动文件 `eslint` 通过。提交 `abaf2bc`。
- [x] 真实浏览器截图（PR9 统一完成：144 passed）。
- 已知限制：路径用带校验的 JSON 文本编辑，未做图形化 `PathPicker`；`type-relations` 端点已提供但抽屉暂未用它推荐下一层。
- 已知限制：分组/视图的排序接口已完成，侧栏暂未提供上移/下移或拖拽入口；ACL grant/revoke 随 ACL Epic 一起延后。
- 已知限制：图沿用共享 React Flow 组件的默认边样式（CMDB 关系没有 semantic tag），节点颜色按模型 id 落到中性色。

### PR9 E2E 收尾

- [x] DCIM move/rename：房间/机柜重命名走 `updateDCIMNode`；设备在机柜抽屉里移动（同柜换 U 位或换柜），走 `moveDevice`。
- [x] ModelDetail 只读“自动发现”tab，链接 `/cmdb/discovery` 与 `/cmdb/adc`。
- [x] `web/e2e/cmdb-pages-responsive.spec.ts`：mock API，真实 Chromium 遍历 9 个页面；390/768/1280/1920 × zh/en × light/dark；断言 `documentElement` 无横向溢出并留截图。`npx playwright test e2e/cmdb-pages-responsive.spec.ts --project=chromium --no-deps`（E2E_BASE_URL 指向本地 Vite）共 **144 passed**，截图在 `output/playwright/results/`。
- [x] MySQL + 独立 CMDB + manager + frontier + nginx 实测：
  - CMDB 直接：`/healthz` 200、`/readyz` 200、`/metrics` 200、未认证 `/api/v1/cmdb/health` 401、带 JWT 200、`/api/v1/cmdb/ci-types` 200。
  - 经 nginx：`/cmdb-readyz` 200、`/api/v1/cmdb/health` 200、`/api/v1/version` 200。
  - 停 CMDB：`/api/v1/cmdb/health` 返回网关错误（本机为 **504**，不是 502；Docker 停止的容器 IP 仍被 nginx 缓存，表现为 connect timeout）、`/api/v1/version` 仍 200；重启 CMDB 后 `/cmdb-readyz` 恢复 200。
- [x] 更新本文件；ADR/安装文档已在 PR1/PR2 覆盖，本轮无需改动。
- 验收：全量 `go test ./...`、`go vet ./...`；CMDB 前端 29 文件/161 tests；`npm run typecheck`、`npm run build`、改动文件 `eslint`；Playwright 144 tests。
- [ ] 未运行 `deploy/docker-compose.yml` 原样启动：本机镜像仓库镜像不可达，`golang:1.25-alpine`/distroless 基础镜像拉取 403；改用本地缓存的 bookworm 变体构建 e2e 镜像，提交的 `deploy/Dockerfile.ongrid-cmdb` 未改动。PR 描述必须写明。
- [ ] 未创建/推送 PR；`gh pr checks` 未运行。

## 每个 PR 的完成定义

- 行为有测试；测试先失败再通过（纯配置/文档变更除外，需在 PR 说明）。
- `go test -race` 受影响包；全量 `go test ./...`；`go vet ./...`。
- 前端 `make test-web-ci-cmdb`、`npm run build`、`npm run lint`（记录基线）。
- 视觉变更附真实浏览器截图；检查 390/768/1280/1920、zh/en、light/dark。
- 英文 Conventional Commit；`feat/...` 分支；PR 后 `gh pr checks <number> --repo ongridio/ongrid`。
- 更新本文件的勾选与提交号；不要在一个 PR 里混入多个逻辑变更。

## 上下文恢复提示

- 本文件在仓库内，随分支提交，不依赖 `.superpowers` 临时目录。
- 临时 ledger（若存在）：`.superpowers/sdd/home-abelit-documents-code-github-nexus-stateless-sundae/progress.md`，仅供当前会话参考。
- 先看 `git log --oneline main..HEAD`，再看本文件“当前状态”，不要凭记忆重做。
- 若测试环境缺失（go-arch-lint、Ruby、MySQL），在 PR 描述与本文件“已知限制”中如实记录，不记为通过。
