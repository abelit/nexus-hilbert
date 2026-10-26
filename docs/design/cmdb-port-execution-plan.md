# CMDB 移植与独立服务实施计划

- 状态：进行中
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
| PR3 偏好/关系/树视图/关系视图 | 进行中 | `7e854a2` `cf7509b` | API 客户端与偏好页完成；树视图/关系/菜单待做 |
| PR4 批量导入 | 待开始 | — | 纯前端，后端已就绪 |
| PR5 自动发现 UI | 待开始 | — | 前端 + 一个只读端点 |
| PR6 ADC 发现池 | 待开始 | — | 后端两张表 + API + 前端 |
| PR7 操作历史 | 待开始 | — | 后端只读 API + 前端 |
| PR8 拓扑视图 | 待开始 | — | 后端两张表 + 图装配 + 前端 |
| PR9 E2E/收尾 | 待开始 | — | DCIM move/rename、ModelDetail 自动发现 tab、响应式截图 |

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

## 已知限制（不要误判为已通过）

- `make arch-lint` 未运行：本机缺少 `go-arch-lint`，且 Makefile 的 skip 分支仍会执行下一行。PR 描述必须写“未运行”，不能写通过。
- `make test-release-workflow` 未运行：本机缺少 Ruby，Docker Hub 拉取 ruby 镜像超时；已用 Python 解析 `release.yml` 核对 job/needs/condition。
- `npm run lint` 有 9 个既有错误，位于未触及文件；本次改动未新增 lint 错误。
- 未做真实 MySQL 容器级 compose 启动；SQLite 端到端和 MySQL gated 锁测试已覆盖核心路径。PR9 前补一次 compose 启动验收。
- 发布前必须同时替换 `ongrid` 与 `ongrid-cmdb`；旧 manager 仍挂载 CMDB 路由。

## 下一步：PR3（偏好/关系/树视图/关系视图）

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
- [ ] 真实浏览器截图（PR3 收尾统一做）。

### PR3c TreeViews 页面

- [ ] `web/src/cmdb/pages/TreeViews.tsx`：
  - 读 `listTreeLevels()`；无视图时 `EmptyState` 链接到 `/cmdb/preferences`；
  - 左侧按选中视图的 `levels[]` 懒加载 facet 树：
    `searchInstances({ q: '_type:<id>[,<level>:<value>]', facet: [nextLevel], count: 1 })`；
  - 右侧 `DataTable` 显示当前路径的实例，复用 `Search` 页的行渲染/分页；
  - 切换视图重置路径；路由 `/cmdb/tree-views` 与 `/cmdb/tree-views/:typeId`。
- [ ] 组件 `web/src/cmdb/components/tree-views/FacetTree.tsx`。
- [ ] `TreeViews.test.tsx`：懒展开、路径变化触发查询、空态、非 admin 只读。
- 验收：`npm test -- src/cmdb/pages/TreeViews.test.tsx`。

### PR3d Relations 页面

- [ ] 增强 `web/src/cmdb/pages/ModelRelations.tsx`：
  - 工具栏“新建关系”打开 `RelationFormDrawer`；
  - 选择父模型、子模型、关系类型（`listRelationTypes`）、基数、父/子属性；
  - 保存 `saveRelation(parentRef, childRef, input)`；删除沿用现有确认；
  - 关系已存在时展示后端错误，不覆盖；非 admin 禁用写操作；
  - 增加路由别名 `/cmdb/relations` 指向同一页面。
- [ ] `RelationFormDrawer.tsx` + `ModelRelations.test.tsx` 增加创建/失败保留输入/非 admin 用例。
- 验收：`npm test -- src/cmdb/pages/ModelRelations.test.tsx`。

### PR3e 菜单/命令面板/分组

- [ ] `web/src/cmdb/routes.tsx`：
  - `/cmdb/preferences` → Preferences；
  - `/cmdb/tree-views`、`/cmdb/tree-views/:typeId` → TreeViews；
  - `/cmdb/relations` → ModelRelations（兼容 `/cmdb/model-relations`）；
  - “关系视图”入口复用 `/cmdb/service-tree`（现有 ServiceTree 页面）。
- [ ] `cmdbNavSection` 增加：偏好设置、资源层级、关系、关系视图；`CMDBNavItem` 增加 `group?: 'cockpit'|'resources'|'models'|'discovery'|'admin'|'perms'`。
- [ ] `Sidebar.tsx` 的 `SidebarSectionItem` 支持 `group`，在 CMDB section 内渲染分组标题；不改变其它 section 视觉；`Sidebar.test.tsx` 补断言。
- [ ] `cmdbPaletteRoutes` 增加新入口；`web/src/lib/routes.ts` 自动合并。
- [ ] 文案全部 `tr('中文','English')`。

### PR3 验证

- `make test-web-ci-cmdb`、`npm run build`、`npm run lint`（区分既有错误）。
- 真实浏览器：390/768/1280/1920，zh/en，light/dark；Preferences、TreeViews、Relations、ServiceTree；检查表格横向滚动、操作列、空态/错误态/加载态；截图附 PR。
- 提交建议：`feat(cmdb): add preference and tree view pages`、`feat(cmdb): add model relation creation` 可分两个 PR/提交。

## 后续阶段清单

### PR4 批量导入（前端）

- [ ] `web/src/cmdb/api/import.ts`：`previewImport`/`commitImport` → `/import/preview|commit`。
- [ ] `web/src/cmdb/lib/sheet.ts`：CSV 原生解析；XLSX 懒加载 `exceljs`；行/列上限 5000/200；模板生成。
- [ ] `web/src/cmdb/pages/BatchImport.tsx` + `components/import/{UploadStep,MappingStep,PreviewStep,ResultDialog}.tsx`。
- [ ] Instances 页入口；路由 `/cmdb/batch`；Vitest 覆盖解析/映射/坏行/失败保留。
- [ ] 唯一新增运行时依赖 `exceljs`，确认独立 chunk。

### PR5 自动发现 UI（前端 + 一个只读端点）

- [ ] 后端 `GET /v1/cmdb/discovery/target-types`（any authed）→ `{items:[{type_id,name,alias,icon,target_count}],total}`；store group-by + usecase + handler + 测试。
- [ ] `web/src/cmdb/api/discovery.ts`：rules/accounts/targets/catalog/templates 封装。
- [ ] `web/src/cmdb/pages/Discovery.tsx`：Rules/Targets/Catalog/Templates 四 tab；规则抽屉含账号与插件脚本 `Textarea`；目标抽屉含映射、agent/query/all、cron、auto_accept、脱敏凭据；target test 展示后端 501。
- [ ] 路由 `/cmdb/discovery`；Vitest。

### PR6 ADC 发现池（后端 + 前端）

- [ ] 模型：`c_ad_ci`、`c_ad_exec_histories`（字段对齐 cantor；`(type_id,unique_value)` 复合索引；exec history append-only）。
- [ ] store `internal/cmdb/data/discovery/store/adc.go`；`Migrate` 注册；计数用 `COUNT(*)`，不建 `c_ad_counter`。
- [ ] biz `internal/cmdb/biz/discovery/usecase_adc.go`：`PoolRepo`、`InstanceWriter`、list/get/upsert/accept/delete/counter/exec-history；accept 幂等；`auto_accept`；`MarkAutoDiscovery` 写 `c_cis.a`；CI+关系同事务 `WriteWithRelations`。
- [ ] server `http_adc.go`：`/v1/cmdb/discovery/adc*`；目标删除 409。
- [ ] 前端 `pages/DiscoveryPool.tsx` + `components/discovery/adc/*`；路由 `/cmdb/adc`。
- [ ] 测试：upsert/合并/重置/计数、accept 幂等、目标删除 409、路由契约。

### PR7 操作历史（后端 + 前端）

- [ ] `internal/cmdb/biz/history`、`data/history/store`、`server/history`；读 `c_records` + 四张历史表；补查询索引。
- [ ] API：`/v1/cmdb/history/attributes|relations|ci-types|ci-triggers`、`/history/ci/{id}`、`/history/ci/{id}/triggers`；`{items,total}`，page_size ≤ 200。
- [ ] 全局历史 admin-only；单 CI 历史 any authed；显示名用 `CINameResolver`/`AttributeResolver`；用户名由前端 `/api/v1/users` 映射。
- [ ] 前端 `pages/OperationHistory.tsx` 四 tab + 过滤/分页/抽屉；路由 `/cmdb/operation-history`。
- [ ] 测试：过滤/分页/时间范围/空结果/权限。

### PR8 拓扑视图（后端 + 前端）

- [ ] 模型 `c_topology_view_groups`、`c_topology_views`；store/migrate；`data.Migrate` 注册。
- [ ] biz：CRUD/排序/预览/图装配；`GraphQueries` 由 `biz/ci` 适配；自环去重、正/负层、根 200/节点 2000/深度 5 上限。
- [ ] server：`/v1/cmdb/topology-views*`；分组删除 409；无 grant。
- [ ] 前端 `api/topology.ts`、`pages/TopologyViews.tsx`、`components/topology/{TopoGraph,TopoSidebar,TopoViewDrawer,PathPicker,InstancePicker}.tsx`；复用 `@xyflow/react` + dagre；路由 `/cmdb/topology-views`。
- [ ] 测试：图去重/自环/上下层/上限、CRUD/排序/守卫；真实浏览器截图。

### PR9 E2E 收尾

- [ ] DCIM move/rename；ModelDetail 只读自动发现 tab 链接 Discovery。
- [ ] `web/e2e/cmdb-pages-responsive.spec.ts`：mock API，真实 Chromium 遍历新页面，390/768/1280/1920、light/dark 截图。
- [ ] 跑一次真实 compose（MySQL + ongrid + ongrid-cmdb + nginx）；验证 `/api/v1/cmdb/health`、`/cmdb-readyz`、停 CMDB 时 502 而 `/api/v1/version` 200。
- [ ] 更新本文件、ADR、安装文档；PR 描述写明未运行项。

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
