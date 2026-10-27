# CMDB 移植与独立服务实施计划

- 状态：PR #553 已推送并等待评审；模型配置增量已推送（`487395e`…`5dd3bca`），PR 尚未创建（`api.github.com` 连接被拒绝）
- 分支：`feat/cmdb-standalone-service`；增量分支 `feat/cmdb-model-config-ux`（基于 `193dad3`）
- 基线：`main` @ `fe0a108`
- 关联：[ADR-035](../../docs/adr/ADR-035-cmdb-standalone-service.md)、[CMDB 服务部署说明](../install/cmdb-service.md)
- 最后更新：2026-10-27

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
| 最终全分支评审 | 已完成 | `f94d283`…`88a7713` | 1 critical + 8 important 修复 |
| 评审 minor / 既有缺陷 | 已完成 | `97aa478`…`9063f79` | 7 minor、残余安全风险、3 个既有缺陷；镜像构建支持镜像源覆盖 |
| 交付 | 已推送 + PR | `2c4e539` | [#553](https://github.com/ongridio/ongrid/pull/553)；合并 main，commit-policy 通过 |

PR1–PR9 的代码与验证已完成。最终评审的 17 条 CONFIRMED（1 critical、8 important、8 minor）已全部修复（`f94d283`…`ace7538`），另修复 3 个评审中发现的既有缺陷，残余安全风险已关闭。分支已合并 `origin/main`（`5eb7ab1`）并推送，PR：[#553](https://github.com/ongridio/ongrid/pull/553)。`commit-policy` 与 `validate commit messages` 通过；`mergeStateStatus=BLOCKED` 等待评审/分支保护要求。

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

### 评审 minor 修复（2026-10-27）

- 发现目标删除与上报并发：`DeleteTarget` 与 `UpsertPool` 现在都先锁目标行，MySQL 上串行化删除与上报；SQLite 依靠写事务。提交 `8207614`。
- 拓扑图根节点不再预置 visited，自引用中心模型的根→子边保留。提交 `34a7bc2`。
- `HistoryCINames` 改为一次 `LoadCIs` 批量读取，拓扑 2000 节点不再 N+1。提交 `0444a2b`。
- `TopologyView.Path` 支持 cantor 的字符串 id，接管库不会因一行导致全部读取 500。提交 `34a7bc2`。
- 拓扑名称/category 在 biz 边界按 varchar(64)/(32) 校验，超长返回 400。提交 `34a7bc2`。
- `FacetTree` 复用 `dsl.ts` 的 `escapeValue`，含逗号的层级值不再拆错查询。提交 `f688c61`。
- `uninstall.sh --purge` 同时删除 `ongrid-cmdb` 镜像，并在 release-package 测试中断言。提交 `ace7538`。

### 残余风险已关闭

- 历史密码脱敏现在从 `c_attributes` 读取属性标记（LEFT JOIN 不过滤 `delete_marker`），软删除的密码属性其 old/new 也会被掩码；store 测试覆盖软删除场景。提交 `97aa478`。

### 既有缺陷修复（2026-10-27）

- 模型详情的关系抽屉仍发送 `1-N`/`1-1`/`N-N`：与 `/cmdb/relations` 共用 `web/src/cmdb/lib/relation.ts` 的映射，发送 `0/1/2`。提交 `6d209a7`。
- 发现模板导入缺少 admin gate：biz `ImportTemplates` 拒绝非 admin，前端导入按钮禁用；导出保持 any authed。提交 `f0b0a6d`。
- ServiceTree 读取 `pairs` 而 API 返回 `cr_ids`：API 客户端统一映射为 `pairs`，测试改用真实 wire shape。提交 `d31b62b`。

### 本轮验证

- Go：`go test ./...` 通过；`make test-race`（`go test -race ./...`）在合并 main 后通过（193 个 ok 包，exit 0，无 DATA RACE）；`go vet ./...` 通过。
- `make test-integration`：通过（exit 0）。
- `make test-e2e`：全量套件在本机仍不通过（首次是 Docker Hub 拉取 `mysql:8.0` 超时；重跑后 assistant-chat 用例在套件中失败、O32 挂起 10m）。但同一 `TestAssistantChat_UserVisibleLoop` 在 `origin/main` 临时 worktree 和本分支上单独运行均通过（20.6s / 15.4s），说明是全量 e2e 的测试间状态干扰/挂起，不是 CMDB 回归；该目录本分支未改动、无 CMDB 引用，仍不能记为通过。
- 前端：`make test-web-ci-cmdb` 31 文件 / **170 tests**；`npm run typecheck`、`npm run build` 通过；改动文件 `eslint` 0 错误（`FacetTree` 有 1 条既有的 exhaustive-deps warning）。
- 真实浏览器：`npx playwright test e2e/cmdb-pages-responsive.spec.ts --no-deps`（`E2E_BASE_URL=http://127.0.0.1:5173`，Vite dev server）**144 passed**；历史页子集 16 passed。
- 全量 `npm run lint`：53 problems（9 errors / 44 warnings），与基线一致，改动文件不在错误列表。
- `bash scripts/test-compose-release-package.sh` 通过（含新增的 uninstall 镜像断言）；`docker compose -f deploy/docker-compose.yml config` 通过。
- `make test-release-workflow` 通过（临时 Ruby 3.4.10）；`make test-release-package` 通过（含 `test-upgrade-data-permissions.sh`、`test-compose-release-package.sh`）；`test-release-manifest-filter`、`test-release-image-publish`、`verify-compose-images` 通过。`test-upgrade-data-permissions.sh` 的断言已与新 CMDB 健康消息对齐。
- 组合栈：`deploy/docker-compose.yml`（project `deploy`）运行中；`/cmdb-readyz` 200、认证后 `/api/v1/cmdb/health` 200、`/api/v1/cmdb/ci-types` 200，容器 `--healthcheck` exit 0。
- 合并 `origin/main` 后重新验证：`go test ./...`、`go vet ./...`、`make test-race`（193 包）、`make test-integration`、前端 170 tests、`typecheck`、`build`、Playwright 144、release-package 脚本、`docker compose config` 全部通过。
- `git diff --check` 通过；人工 import 边界核对通过（`cmdb/biz`→`cmdb/data`/其它 BC、`cmdb/server`→`cmdb/data`、`pkg`→BC、`cmd/ongrid`→`cmdb` 均为空）。
- `make arch-lint`：已用 `go-arch-lint` v1.19.0（临时安装在 `/tmp/cmdb-tools`）运行通过（`OK - No warnings found`）。配置为 main 的 v1.19 + CMDB 组件，并排除本机 `web/node_modules` 中的第三方 Go 文件。

## 已知限制（不要误判为已通过）

- `make arch-lint` 需要 PATH 中有 `go-arch-lint`（CI 应安装 v1.19.0）。本机已临时安装 v1.19.0 并运行通过；`scripts/agent-observability/README.md:107` 的旧 1.12.0 校验失败记录不再适用于当前配置。
- `make test-e2e` 在当前环境无法全绿：全量套件中的 assistant-chat 用例失败、O32 超时；但该用例在 `origin/main` 和本分支单独运行均通过，属于测试间状态干扰/挂起，验收时按“未通过”记录。
- `make test-release-workflow` 已用临时解包的 Ruby 3.4.10（`/tmp/ruby-root`，未安装到系统）运行通过：release workflow 断言、`test-fetch-obi.sh`、`test-fetch-embedding-model.sh` 全过；本机默认 PATH 仍无 Ruby，CI 需自带 Ruby。
- `npm run lint` 有 9 个既有错误，位于未触及文件；本次改动未新增 lint 错误。
- `deploy/docker-compose.yml` 的原样栈已在本机运行（project `deploy`），认证后 CMDB 健康与实例接口 200；停止 CMDB 的网关隔离早前实测为 504（不是 502；Docker 停止容器的 IP 仍被 nginx 缓存），本轮未重复停服。
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
- [x] `deploy/docker-compose.yml` 原样栈已在本机运行（project `deploy`：`ongrid`、`ongrid-cmdb`、`ongrid-nginx`、`ongrid-frontier`）。验收：`/cmdb-readyz` 200、`/healthz` 200、未认证 `/api/v1/version` 401、认证后 `/api/v1/cmdb/health` 200（`{"generation":"fresh","origin":"mysql","fresh":true}`）、`/api/v1/cmdb/ci-types` 200、`docker exec ongrid-cmdb /ongrid-cmdb --healthcheck` exit 0。CMDB 镜像通过 `RUNTIME_IMAGE` 覆盖构建（提交 `9063f79`）。停止 CMDB 的网关隔离早前实测为 504，本轮未重复停服。
- [ ] 未创建/推送 PR；`gh pr checks` 未运行。

## 增量：模型配置体验（`feat/cmdb-model-config-ux`）

范围：核对 cantor 模型配置的移植完整度，补齐 P0 配置能力，并把模型列表/详情改成“左侧模型树 + 右侧工作区”。分支基于 PR #553 的 `193dad3`，应在 #553 合并后合并/变基。

- [x] 布局：新增 `ModelConfigShell`、`ModelTree`、`model-tree-context`；桌面 264px 模型树 + 右侧工作区，窄屏收进“选择模型”弹窗；搜索跨分组、选中项自动展开并滚入视野；列表 `?new=1` 打开新建表单；详情/偏好使用 `?tab=` 保持当前页签；新建模型后跳转详情并刷新树。
- [x] 显示属性：`CreateTypeInput.ShowKey`/`UpdateTypeInput.ShowKey`（id 或 name），store 写 `show_id`；表单支持选择和清空；列表增加“展示属性”列并移除无意义的 `is_attached` 列/过滤，实例页和发现目标改用有效属性集判断模型是否可挂载。
- [x] 继承编辑：更新模型时可传 `parent_ids`（`ParentsSet`），store 在同一更新中替换 `c_ci_type_inheritance`；拒绝自引用；未传字段保持原值。表单提供父模型搜索和多选。
- [x] 属性字典：`AttributeDictionary` 使用服务端搜索/分页（50 行），显示总数；新建/编辑/删除复用 `AttributeForm`；`listAllAttributes` 按 200 行服务端分页循环，供模型表单使用。
- [x] 属性编辑：`AttributeForm` 覆盖名称/别名/值类型、索引/唯一/列表/密码/引用/文件/计算等标志、引用模型、默认值、静态选项（值/标签/颜色）、`choice_web_hook`/`choice_other`/`compute_script`、正则 `re_check`、展示 `option` JSON；已有属性的值类型和列表标志不可改；JSON 非法时不发请求；底部操作固定。
- [x] 关系属性映射：模型详情关系抽屉和全局关系页都可为父/子属性按位置配对，提交 `parent_attr_ids`/`child_attr_ids`，空映射不发送；切换父/对端模型时先清空旧映射，避免新属性加载期间提交上一组属性 id；新增 `RelationAttributePairs`。
- [x] 关系页空白修复：`relation-children`/`relation-parents` 返回的是单端 `RelatedType`，不是全局关系列表的 `{parent, child}`。详情页按对端模型渲染，删除改用 `ctr_id`；`ModelDetail` 测试改用真实响应并覆盖 `?tab=relations` 深链、空态、子/父关系与按边 id 删除，避免 mock 形状掩盖真实契约。
- [x] 导入实例读取：cantor 导入的 `c_cis.props_json` 为空；`ListByType` 在没有字段投影时也要对空快照回退到值表，否则资源数据页所有列都显示为空。新增 `TestListByTypeFallsBackWhenSnapshotsAreEmpty`，并用本地导入的 `product` 模型验证 80 条实例返回 `values`。
- [x] 运行时修复：自定义图标加载失败回退到中性图标并固定尺寸；`Chip` 改为 `forwardRef` 以配合 Tooltip/Base UI；属性视图返回 `re_check`/`option`；`is_attached` 注释纠正为 cantor 的陈旧标志。
- [x] 属性展示：参考 [model_attribute_management_apple_liquid_glass.html](./cmdb/model_attribute_management_apple_liquid_glass.html)，模型详情属性页使用 scoped `.cmdb-liquid` 玻璃面板：分区玻璃卡、表格/网格切换、属性/类型/索引/配置策略/来源信息、搜索、只看必填/只看继承、分组折叠、统计摘要和空态；操作保留编辑/解绑及行内必填/默认显示开关。桌面默认表格，1280 以下默认网格；只采用参考的视觉方向，不引入 CDN、Font Awesome、全局 Tailwind 配置或新主题。属性类型按生效类型展示：8 个存储类型叠加密码/链接/文件/引用标志后形成 13 个显示类型，密码/链接/文件优先，未索引文本归为长文本；列表数据类型列、网格卡片和顶部多选类型筛选共用同一套 Lucide 图标与名称，网格卡片保留必填星标、唯一标记、策略开关、标志图标和操作。新增 `attribute-type` 单元测试与列表/网格 Playwright 回归。
- [x] 属性工作区紧凑化：按选定方案 A 重排模型属性页。头部把“属性 + 属性数 + 必填/继承统计 + 说明”放在左侧，属性字典和绑定属性放在右侧；类型筛选主行最多展示 5 个已使用类型及计数，其余类型（含未使用类型）进入“更多类型”弹层，弹层保留全部 13 个生效类型的多选和计数；搜索/列表网格、只看必填/只看继承、分组数量和展开/收起集中在同一块玻璃面板。属性表格的表头改为句首大写、表头与行高压缩（真实验证首行约 42px），操作按钮改为次要色。新增“仅展示已使用类型 + 更多类型”和 `?ci=` 深链打开实例抽屉的回归测试；保留列表/网格、分组、筛选、行内策略和全部原有操作。
- [x] 资源数据布局：参考 [cmdb_instance_data_apple_liquid_glass.html](./cmdb/cmdb_instance_data_apple_liquid_glass.html) 的玻璃正文，并对齐模型配置页的紧凑结构。共享 `PageHeader` 在玻璃容器外，标题固定为“资源数据 / Resources”，模型别名、标识、实例总数、本页行数及本页 Active/PROD/SLA 放在说明行；原先的玻璃 Hero 和四张 KPI 卡删除。`lg` 及以上左侧模型导航在玻璃容器外、独立滚动，低于 `lg` 使用工具栏模型 Select；模型导航按 `c_ci_type_groups` 分组，分组标题带折叠箭头、文件夹图标、名称和模型数量，可点击折叠/展开（`aria-expanded`）且当前模型所在分组自动展开；组内按模型 order/名称排序，未分组模型进入末尾“其他”，搜索只保留有匹配的分组，分组读取失败时保持平铺并显示可重试提示。工具栏增加“字段”入口，打开“属性说明”对话框：表格按名称、别名、类型、可检索、默认展示、唯一、枚举、多值、可排序、计算属性列出全部属性，支持按名称/别名搜索；首列勾选决定列表/卡片列，标识列固定并带锁标记，保存写入列订阅并立即更新表头；窄屏下表格只在对话框内横向滚动。玻璃正文只有一个纵向滚动容器，首项为环境/等级筛选和列表/网格工具栏，随后是表格/网格与分页；保留订阅列、编辑/删除和实例抽屉。切换模型会清空上一模型的行、计数、属性和列并回到内容顶部；模型列表加载失败有独立提示和重试，不阻塞实例表格。640–1279px 页头操作换到标题下方。1280 以下默认网格，桌面默认表格。
- [x] 引用字段显示：资源数据的表格、网格卡片和详情不再直接打印引用属性的 CI id。页面按 `reference_type_id` 分组，使用 `/ci/s` 的 `_type:<id>,_id:(…)` 批量查询被引用实例（每批 100 个），按目标模型的 `show_name`、`unique_key`、`name`/`alias` 依次选择显示名；查询失败或目标实例已删除时回退原始 id。表格标题保留 `名称 (原始 id)` 便于核对，客户端页内筛选也匹配解析后的名称。详情抽屉通过父页面的模型快照解析引用，不新增后端接口。新增 `reference-labels` 纯函数测试，以及资源表格和详情展示名称的回归测试。
- [x] 枚举标签显示：资源数据的表格、网格卡片、详情和抽屉状态标签不再直接打印枚举代码，而是读取属性的 `choice_value[].option.label`（如 `prod` → 生产、`critical` → 关键、`active` → 使用中）；未知代码仍显示原值，原始代码保留在 `title`。环境/等级筛选按钮同步显示标签，但过滤状态仍保存原始代码；页内关键词筛选也匹配标签。多值枚举按标签逐项展示。新增 `choice-labels` 纯函数测试，并扩展资源数据测试覆盖表格、筛选、卡片、详情和状态标签。
- [x] 引用搜索选择：新建/编辑实例时，引用属性改用 `ReferencePicker`，不再要求手工填写 CI id。打开下拉加载目标模型前 20 项，输入时以 250ms 防抖调用 `/ci/s`（`_type:<id>,*关键词*`）；选项按目标模型 `show_name`/`unique_key`/`name`/`alias` 显示，选中写回数字 id。单值与多值引用共用同一组件，多值支持连续选择；当前值名称沿用页面的批量解析结果，清除按钮写回 `null` 或空数组。搜索失败保留已选值和错误提示，不阻塞表单。新增 `ReferencePicker` 组件测试，覆盖远程搜索、编辑态名称/清除和多选，并在实例表单中验证保存 payload。
- [x] 资源详情抽屉：资源数据表格与卡片把详情/拓扑/编辑/删除改为带 `aria-label`/`title` 的图标按钮，其中“详情”打开只读 `xl` Drawer，“拓扑”直接打开抽屉的拓扑视图，头部左侧为模型图标，右侧第一行为资源名称、模型标签和状态胶囊，第二行为 ID、更新时间、更新人和唯一标识（与名称不同时）；实例读取接口返回 `updated_by`，创建/更新时写入调用者 JWT 邮箱，管理员在头部把邮箱解析为用户显示名；视图切换使用共享的下划线 Tab（详情、拓扑、变更历史、触发记录），每个 Tab 前带对应图标；390px 英文下压缩间距并保持四项全部可见；Tab 栏使用不透明 sticky 容器覆盖抽屉正文上内边距，避免滚动内容从上方穿出，并在 Playwright 中校验 Tab 与滚动容器顶部对齐。详情属性区使用与关联关系一致的卡片头部（图标、标题、属性数量、刷新），下面按模型表单分组以两列字段网格展示有效属性（密码只显示占位符），字段行尾的铅笔按值类型就地编辑（引用复用可搜索选择、单选枚举按配置标签下拉、布尔开关、日期时间/JSON/多值复用表单控件），文本/JSON 在失焦或回车时保存、布尔/枚举/引用选择即保存、Esc 放弃且不显示保存/取消按钮，保存通过 `PUT /instances/{id}` 只提交该属性，成功后就地更新抽屉头部与值、通知列表/关系表刷新并静默拉取计算属性，失败保留草稿并显示后端信息；密码、计算和文件字段不提供行内编辑；底部增加关联关系区：按模型关系图列出上游/下游类型与数量，侧栏可按类型过滤；关联表压缩为“资源、关键属性、操作”三列，优先显示名称、唯一标识和两个环境/状态类字段，并按完整属性元数据解析枚举与引用名称；每行提供详情、拓扑和“在资源数据中打开”的图标操作，后者通过 `?type=<模型>&ci=<实例>` 新开页面并自动打开该实例抽屉；分组标题提供“添加”入口，打开可搜索的目标实例对话框，选择后按上/下游顺序调用 `POST /ci-relations/{first}/{second}` 并刷新；窄屏将关键属性收进资源行内。删除关系仍不放入此查看区；拓扑按 `ci-relations/search` 的正向/反向关系装配父级、当前资源、子级，并提供 cantor 风格的思维导图/紧凑布局、关系样式开关、节点详情卡和叶节点向外逐层展开；双击节点把抽屉切换到该资源并保持拓扑 Tab（与 cantor 一致），节点详情卡另提供“切换到此资源”按钮供键盘/触屏使用，同模型复用已加载元数据，跨模型按目标模型加载属性与分组并隐藏原页面的编辑入口；变更历史与触发记录分别读取 `/history/ci/{id}`、`/history/ci/{id}/triggers`，保留分页、用户映射、空态和失败重试；编辑仍打开原有实例表单。监控与 Prometheus 告警不放入抽屉：CMDB 独立服务没有移植 cantor common-setting 的资源映射，现有监控能力在 `/monitor`、`/alerts`，不显示无法兑现的空标签。
- [x] 模型配置列表布局：`/cmdb/models` 页头沿用与模型详情一致的统一 `PageHeader`，标题行右侧放刷新/内建模型/新建模型，说明行显示模型总数、启用、停用和含继承数量；正文使用同一套 scoped `.cmdb-liquid` 工作区。保留名称/别名搜索、只看启用、列表/网格切换、列隐藏、排序和移动端操作菜单。玻璃卡片展示模型标识、展示属性、继承来源和状态；桌面默认表格，1280 以下默认网格，窄屏隐藏无意义的“选择模型”栏。表格默认显示模型、标识属性、继承来源和操作，展示属性默认收入“列”菜单，避免 1440 宽度下被固定操作列遮挡；`is_attached` 是 cantor 的历史存储字段，不代表“能否存实例”，页面不据此显示不可用提示。
- [x] 列表滚动修复：`.cmdb-liquid` 外层必须是 `flex flex-col`，否则 `.cmdb-liquid-content` 的 `flex-1` 不生效，内容会按全量高度撑开并被外层 `overflow-hidden` 裁掉，表格/网格只能看到首屏。修复后内容区限制在可用高度内滚动，89 个模型可一直滚到最后一条；新增 1440px 真实 Chromium 滚动断言覆盖表格和网格。
- [x] 模型分组显示：`/cmdb/models` 增加可选“按分组显示”，默认平铺；使用共享模型分组（不请求服务端 `include_ungrouped` 桶），按接口组顺序与页面最新模型快照 join，首组优先去重，未分组模型追加到末尾“其他”。分组表格仍是一个 `DataTable`，用跨列 `th scope="rowgroup"` 标题行插入组标题，保持一个列选择器、一个横向滚动容器和固定操作列；网格使用扁平分节标题与卡片网格，不嵌套玻璃面板。分组加载失败保留平铺列表并显示可重试提示；分组为空时隐藏开关。新增纯函数 `groupModels`、DataTable `groups` 渲染支持、Vitest 和真实 Chromium 覆盖。
- [x] 模型定义 JSON：模型详情页头在刷新与“编辑模型”之间新增只读“模型定义”入口，使用 `xl` Drawer 展示 `ongrid.cmdb.model` v1 快照。打开时独立从现有读接口取模型、有效属性、表单分组和关系，管理员额外取唯一约束与触发器；非管理员这两段为 `null` 并写入 `sections_omitted` 的 `admin_required` 原因。属性把 `is_required`/`order`/`default_show`/`inherited` 收进 `binding`，分组只保留 `attribute_ids`，关系合并父子方向、基数、属性映射和未配对 id，约束保留原始 ids 与 `missing_attribute_ids`，触发器 `option` 递归剔除 `authorization`/`password`/`compute_script`/`choice_web_hook`。展示、复制、下载共用同一个格式化 JSON；下载使用共享的 `downloadJSON` 与清洗后的 `cmdb-model-<name>.json` 文件名。无后端接口、proto 或 SQL 变更；当前文档是只读描述性快照，不承诺导入。
- [x] 表格响应式：`DataTable` 的操作列表头与操作单元格一起 `sticky right-0`，避免横向滚动时被覆盖列的表头从按钮上方透出；模型列表在 `sm` 以下把编辑/启停/删除收进“更多操作”菜单，避免固定操作列遮挡模型名。
- [x] 测试：后端 citype 的 show_key 创建/更新/清空、继承替换/保留/清空、自引用 400、HTTP DTO；前端 `Models`/`ModelDetail`/`Instances`/`ModelTree`/`AttributeForm`/`AttributeDictionary`、`ModelDefinitionDrawer` 及 `model-definition` 构建器和关系映射；新增逐行类型筛选、有效类型图标、唯一/必填卡片标记、资源详情抽屉的四个视图、关联表资源/关键属性/动作、搜索式添加关系、Tab 栏 sticky 覆盖、拓扑树构建/展开/布局纯函数、拓扑双击切换与抽屉换主体（含跨模型元数据加载及同目标忽略）、详情行内编辑（回车/失焦自动保存、单选枚举选择即保存、Esc 放弃、未修改离开不写入、JSON 客户端校验、失败保留草稿、密码/计算不可编辑、单属性写入）、详情头部（模型标签、状态、ID/更新时间/更新人/UUID）、属性卡片头部（数量、刷新）、资源数据模型导航分组（分组标题/数量、折叠/展开、其他分组、搜索过滤、分组失败回退）、字段弹层（全部属性表、类型/可检索/默认展示/唯一/枚举/多值/可排序/计算属性列、搜索、标识列固定、保存列订阅）及 390/768/1280/1920 × zh/en × light/dark 截图矩阵；模型配置与资源详情相关 Playwright 断言共 **49 条**（原有 27 条 + 资源详情 20 条 + 资源数据模型导航/字段 2 条）。
- 验收：`go test -race ./internal/cmdb/biz/citype ./internal/cmdb/data/citype/store ./internal/cmdb/server/citype`；`go test ./...`；`go vet ./...`；`make arch-lint`（`go-arch-lint` v1.19.0，`OK - No warnings found`）；CMDB Vitest **46 文件 / 274 tests**；`npm run build`；`npm run lint`（0 errors / 44 既有 warnings）；模型配置与资源详情相关 Playwright **49 tests 通过**。
- 真实浏览器：模型列表 390/768/1280/1440/1920（zh/en、light/dark；桌面表格、1280 以下默认网格，列表/网格双向切换），模型详情 390/768/1280/1920，liquid-glass 属性视图与资源数据页 390/768/1280/1440/1920，属性字典和属性表单 390。模型列表平铺与分组各 20 个视口组合均无控制台错误和 `documentElement` 横向溢出；分组模式在 390/768 显示 14 个网格分区，在 1280/1440/1920 显示 1 个表格、14 个分组标题行和 1 个列选择器；1440 以上表格完整显示，1280 及以下在表格自身容器滚动；移动端操作收进菜单。另用本地 89 个模型验证内容区可滚动到最后一行的“虚拟机”和网格的最后一个卡片。资源数据页按 390/768/1024/1280/1440/1920 × zh/en × light/dark 共 24 组验证：模型导航在 1024 及以上可见、以下只显示模型 Select；页头和模型导航都在 `.cmdb-liquid-content` 之外；单一纵向滚动容器可到最后一行/卡片；页面无横向溢出、无控制台错误。1440 另验证模型导航分组：模拟分组显示“服务器 1”“其他 1”，点击“服务器”折叠后主机按钮消失、再次点击展开，搜索“交换”后“服务器”消失且“其他”保留；真实环境 13 个分组下显示“资源层-数据中心 10”“资源层-计算资源 5”等标题与数量，并自动滚动到选中的“虚拟机”。工具栏“字段”在 1440 打开“属性说明”对话框：列头包含名称/别名/类型/可检索/默认展示/唯一/枚举/多值/可排序/计算属性，仅订阅两列时仍可勾选“操作系统”，保存后新增该列并校验 `PUT` 列订阅；真实虚拟机模型显示 59 个字段及 49 个已选列，深色下核对表格与标志列，390 下对话框落在视口内、表格在弹层内横向滚动且页面无横向溢出。模型定义抽屉按 390/768/1280/1440/1920 × zh/en × light/dark 共 20 组验证：JSON 只在 `<pre>` 内滚动，390 下抽屉占满视口宽度，页面无横向溢出、无控制台错误。属性工作区按 390/768/1280/1920 × zh/en × light/dark 共 16 组截图，全部无 `documentElement` 横向溢出；1440 验证“整数”筛选只保留匹配行并显示清除筛选，列表/网格切换后类型图标、密码类型、唯一标记和必填星标均可见；1920 网格为四列。资源详情抽屉同样按 390/768/1280/1920 × zh/en × light/dark 共 16 组验证，下划线 Tab 在 390px 的英文标签下仍全部可见且无页面横向溢出；每组先打开“说明”的行内编辑器并截图，确认输入框与自动保存提示在视口内、页面无横向溢出，再用 Tab 离开未修改字段并确认行关闭且没有写入，随后打开拓扑、点开节点详情卡并确认“Switch to this resource/切换到此资源”在视口内；1440 在详情行内把“说明”改为 rack Z 后按 Enter，校验 `PUT` 请求体只含 `{values:{note:"rack Z"}}`、出现“已保存”Toast 且值立即更新；再改为 rack Y 后点击别处触发失焦保存并确认第二次 `PUT`，最后输入草稿按 Esc，确认行关闭、抽屉仍在且值保持 rack Y；1440 实际切换详情、拓扑、变更历史、触发记录并截图，详情截图覆盖两列属性区和底部关联关系表；拓扑在 1440 验证初始父/子节点、展开一个叶节点、出现新节点及节点详情卡，在 390 验证同一展开流程且页面无横向溢出。1440 另用真实 Chromium 双击“机柜”节点，验证抽屉头部切换到 `#41` / `rack-01`、拓扑 Tab 保持选中、跨模型时编辑入口不再出现。真实数据（产品 #3845）验证关联表：业务服务行显示名称、标识、环境/状态标签，详情/拓扑/资源数据三种操作可用，点击资源数据后通过 `?type=service&ci=3846` 刷新并自动打开目标实例；新增对话框可搜索目标实例；并验证嵌套详情与拓扑抽屉正常；编辑表单中“运维负责人”搜索“何”返回“何忠贵”并写回 374；枚举标签按 390/768/1280/1920 × zh/en × light/dark 共 16 组验证，筛选标签、卡片/表格和 390px 详情均正常且无横向溢出；引用选择浮层按 390/768/1280/1920 × zh/en × light/dark 共 16 组验证，均位于视口内、无横向溢出、无页面异常；SLA“白银”、资源分类“业务系统”、负责人“何忠贵/夏梅娇/任光前”，悬停保留原始 id（2353/3785/374 等）；真实数据（产品 #3937）验证详情、属性变更历史和空拓扑/空触发记录；真实数据（虚拟机 #3855）验证两列属性区、关联关系侧栏与空关联表：均无页面横向溢出、无页面异常；同一实例验证新头部：模型图标、名称 + 虚拟机标签 + 使用中状态，以及 ID: 3855、更新时间 2026-07-15 18:31:17、更新人 admin 和 UUID；接口返回 `updated_by: "admin"`；详情属性区与关联关系使用同一卡片头部（图标、属性数量、刷新），1440 下属性 14 与刷新按钮正常显示。
- 已知限制：前端没有全局 ErrorBoundary；渲染期异常会卸载整个 SPA（本次关系契约错误因此表现为空白页）。本次已修复触发错误，路由级错误边界建议作为独立改进。
- 已知限制：模型定义 JSON 是只读描述性快照，当前没有导入端点，不承诺可回灌。非管理员导出时唯一约束与触发器为 `null`，并在 `sections_omitted` 标记 `admin_required`；属性和触发器的自由字段（`default`、`option`、`choice_value[].option`）按现有读契约保留，若管理员在里面写入敏感值会随下载带出，是否进一步裁剪需产品确认。
- 已知限制：资源详情行内编辑不包含文件上传、密码回显，密码/计算/文件属性仍通过完整表单处理；行内编辑没有乐观锁，并发修改以最后一次写入为准，变更历史保留双方记录；`c_cis.updated_by` 由 Go 端口写入调用者 JWT 邮箱，cantor 迁移的旧数据仍是昵称，非管理员或邮箱无法解析时头部按存储值原样显示；资源详情拓扑首屏展示直接父级/子级，可继续向外展开，但不会把内向节点自动加为新卡片；节点很多时首屏聚焦当前资源，需拖动画布查看其余节点；详情里的变更历史是 `/history/ci/{id}` 的实例属性变更，关系变更仍在管理员的操作历史页；监控和 Prometheus 告警没有对应的独立 CMDB 资源映射，未放入抽屉，现有入口仍是 `/monitor` 与 `/alerts`。
- 已知限制：完整前端套件以 2 个 worker 运行（118 文件/685 tests）时仅 `src/api/skills.test.ts` 1 项失败，原因是实现已改用 `device_id` 而测试仍断言 `edge_id`，属于分支基线既有问题；其余 117 文件/684 tests 通过。默认并发下另有 7 个测试文件因超时失败，单独运行均通过，是资源争用而非本次回归。P1 的模型组拖拽、触发器日期/过滤/通知投递、模型级自动发现、快捷启停开关和更完整的 choice webhook/脚本编辑器不在本次范围。cantor 数据迁移在独立的 `feat/cmdb-cantor-data-migration` 分支处理，不在本分支混入。

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
