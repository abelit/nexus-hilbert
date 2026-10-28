# CMDB 移植与独立服务实施计划

- 状态：PR #553 已推送并等待评审；模型配置增量已推送（`487395e`…`5dd3bca`），PR 尚未创建（`api.github.com` 连接被拒绝）
- 分支：`feat/cmdb-standalone-service`；增量分支 `feat/cmdb-model-config-ux`（基于 `193dad3`）
- 基线：`main` @ `fe0a108`
- 关联：[ADR-035](../../docs/adr/ADR-035-cmdb-standalone-service.md)、[CMDB 服务部署说明](../install/cmdb-service.md)
- 最后更新：2026-10-28

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

#### PR4 增量：cantor 批量导入完整对齐（2026-10-28）

- [x] 前端改为 cantor 的三步流程：选择模型与模板 → 上传 → 预览并导入；步骤条、表头提示、拖拽/点击上传、模板选择、结果弹层、问题行下载、重新开始；`canMutate` 之外的只读角色显示无权限空态。
- [x] `components/import/TemplateDialog.tsx`：模型属性多选、唯一标识强制、父模型关系与匹配属性选择；模板表头使用属性显示名，关系列为 `$父模型名.属性` 且表头标红；选择型属性写入 Excel 下拉，超过 255 字符时回退为自由文本。
- [x] `lib/import-template.ts`：模板列构造、父关系过滤（排除计算/密码/文件/列表属性）、别名冲突回退到属性名。
- [x] `lib/sheet.ts`：模板支持下拉与列宽；新增问题行 XLSX 导出；保留 Excel 日期墙钟格式。
- [x] 后端 `biz/ci`：`ImportRelationColumn` 与 `$父模型.属性` 解析；父模型支持名称、数字 id 与显示别名（别名歧义拒绝）；按父属性值批量查找实例；关系边与实例在同一次 `WriteCIBatch` 事务写入；未找到父实例作为行问题阻止提交；无声明关系、无关系类型、畸形表头均返回 400。
- [x] 后端 `biz/citype`：`GetByAlias`（歧义返回 `ErrInvalid`）与 `CIResolver.ResolveForCIAlias`，供导入的父模型解析复用。
- [x] 数据层 `FindCIsByAttributeValues`：一次查询返回每个值匹配的全部父实例，键按存储值与文本大小写折叠。
- 验收：`go test -race ./internal/cmdb/biz/ci ./internal/cmdb/biz/citype ./internal/cmdb/data/ci/store ./internal/cmdb/server/ci` 通过；`go test ./internal/cmdb/...`、`go vet ./internal/cmdb/...` 通过；CMDB Vitest 52 文件/339 tests；`npm run typecheck`、`npm run build`、`npm run lint`（0 errors/45 既有 warnings）通过；Playwright 批量导入 6 tests（light/dark、390/768/1280/1920、真实浏览器上传与提交）通过，另有 auth setup。
- parity 说明：关系列的基数值冲突在提交时由关系写入路径校验；预览只校验父实例存在，不能提前发现 1-1/1-N 冲突，提交失败会整体回滚并保留表格。

#### 模型配置列表布局增量（2026-10-28）

- [x] `pages/Models.tsx`：页头改为“资源模型 > 模型配置”同一行面包屑与标题 + 总数/已启用/已停用/含继承四个统计胶囊；刷新、内建模型、新建模型保留在页头。低于 1440px 时统计与操作移到标题下方并左对齐（`styles.css` 的 `.cmdb-model-config-header`）。
- [x] 工具栏改为三段带计数的状态筛选（全部模型/已启用/已停用）；搜索框、按分组显示、刷新和列表/网格图标按钮同排，低于 1440px 时筛选与控件分两行；平铺视图每页 20 条，分页摘要“显示 x 至 y 条，共 n 条模型”，带页码；分组视图不分页。
- [x] 表格首列改为“模型名称/标识符”，启用状态紧邻别名，内部名在下；继承列表头改为“继承关系”；表格操作改为文字链接，手机端仍收进菜单。
- [x] `ModelTree` 增加 `compact`：模型列表页和详情页的左侧导航都只保留搜索、分组树和管理分组入口；搜索占位符改为“搜索模型分组或模型…”。详情页仍高亮当前模型。
- [x] `ModelDetail.tsx` 复用同一页头：面包屑“资源模型 > 模型配置”与模型别名标题同一行，说明行改为内部名/标识/展示/属性数/分组数胶囊；刷新改为图标按钮，低于 1440px 时操作换到标题下方；页签在窄内容宽度下允许换行。
- [x] `PaginationFooter` 增加可选 `summary` 与 `showPageNumbers`，默认右对齐行为不变；分页颜色改用主题 token，light/dark 均使用页面底色。
- 验收：Models/PaginationFooter/ModelTree/PageHeader Vitest 26 tests、ModelDetail 18 tests 通过；CMDB 全量 54 文件/346 tests；`npm run typecheck`、`npm run build`、`npm run lint`（0 errors/45 既有 warnings）通过；真实浏览器 390/768/1024/1280/1440/1920、light/dark 实看；Playwright 全量 239 tests 通过。

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
- [x] 关系属性映射：模型详情关系抽屉和全局关系页都可为源/目标属性按位置配对，提交 `parent_attr_ids`/`child_attr_ids`，空映射不发送，半填映射阻止提交并就地提示；新增 `RelationAttributePairs`。关系表源/目标列增加模型图标、别名和模型标识，新增“属性关联”列显示“源属性 → 目标属性”（无映射为“—”，属性缺失退化为组数），源/目标按内容宽度排列、属性关联列吸收剩余宽度，删除改为图标按钮。全局“新增关系”对齐 cantor：源 CI 类型 / 目标 CI 类型 / 关联类型 / 关系约束 / 属性关联，关系约束显示一对多/一对一/多对多；属性关联默认一行“源属性 → 目标属性”，行尾删除（仅剩一行禁用）与新增；候选属性按对端值类型和约束过滤（排除密码/JSON/布尔/引用/未索引文本，一对多禁目标侧多值，一对一禁两侧多值，多对多按对端多值判断）；切换源/目标只清空对应一侧，切换约束清空全部映射。
- [x] 关系页空白修复：`relation-children`/`relation-parents` 返回的是单端 `RelatedType`，不是全局关系列表的 `{parent, child}`。详情页按对端模型渲染，删除改用 `ctr_id`；`ModelDetail` 测试改用真实响应并覆盖 `?tab=relations` 深链、空态、子/父关系与按边 id 删除，避免 mock 形状掩盖真实契约。
- [x] 导入实例读取：cantor 导入的 `c_cis.props_json` 为空；`ListByType` 在没有字段投影时也要对空快照回退到值表，否则资源数据页所有列都显示为空。新增 `TestListByTypeFallsBackWhenSnapshotsAreEmpty`，并用本地导入的 `product` 模型验证 80 条实例返回 `values`。
- [x] 运行时修复：自定义图标加载失败回退到中性图标并固定尺寸；`Chip` 改为 `forwardRef` 以配合 Tooltip/Base UI；属性视图返回 `re_check`/`option`；`is_attached` 注释纠正为 cantor 的陈旧标志。
- [x] 属性展示：参考 [model_attribute_management_apple_liquid_glass.html](./cmdb/model_attribute_management_apple_liquid_glass.html)，模型详情属性页使用 scoped `.cmdb-liquid` 玻璃面板：分区玻璃卡、表格/网格切换、属性/类型/索引/配置策略/来源信息、搜索、只看必填/只看继承、分组折叠、统计摘要和空态；操作保留编辑/解绑及行内必填/默认显示开关。桌面默认表格，1280 以下默认网格；只采用参考的视觉方向，不引入 CDN、Font Awesome、全局 Tailwind 配置或新主题。属性类型按生效类型展示：8 个存储类型叠加密码/链接/文件/引用标志后形成 13 个显示类型，密码/链接/文件优先，未索引文本归为长文本；列表数据类型列、网格卡片和顶部多选类型筛选共用同一套 Lucide 图标与名称，网格卡片保留必填星标、唯一标记、策略开关、标志图标和操作。新增 `attribute-type` 单元测试与列表/网格 Playwright 回归。
- [x] 属性工作区紧凑化：按选定方案 A 重排模型属性页。头部把“属性 + 属性数 + 必填/继承统计 + 说明”放在左侧，属性字典和绑定属性放在右侧；类型筛选主行最多展示 5 个已使用类型及计数，其余类型（含未使用类型）进入“更多类型”弹层，弹层保留全部 13 个生效类型的多选和计数；搜索/列表网格、只看必填/只看继承、分组数量和展开/收起集中在同一块玻璃面板。属性表格的表头改为句首大写、表头与行高压缩（真实验证首行约 42px），操作按钮改为次要色。新增“仅展示已使用类型 + 更多类型”和 `?ci=` 深链打开实例抽屉的回归测试；保留列表/网格、分组、筛选、行内策略和全部原有操作。
- [x] 资源数据布局：参考 [cmdb_instance_data_apple_liquid_glass.html](./cmdb/cmdb_instance_data_apple_liquid_glass.html) 的玻璃正文，并对齐模型配置页的紧凑结构。共享 `PageHeader` 在玻璃容器外，标题固定为“资源数据 / Resources”，模型别名、标识、实例总数、本页行数及本页 Active/PROD/SLA 放在说明行；原先的玻璃 Hero 和四张 KPI 卡删除。`lg` 及以上左侧模型导航在玻璃容器外、独立滚动，低于 `lg` 使用工具栏模型 Select；模型导航按 `c_ci_type_groups` 分组，分组标题带折叠箭头、文件夹图标、名称和模型数量，可点击折叠/展开（`aria-expanded`）且当前模型所在分组自动展开；组内按模型 order/名称排序，未分组模型进入末尾“其他”，搜索只保留有匹配的分组，分组读取失败时保持平铺并显示可重试提示。工具栏增加“字段”入口，打开“属性说明”对话框：表格按名称、别名、类型、可检索、默认展示、唯一、枚举、多值、可排序、计算属性列出全部属性，支持按名称/别名搜索；首列勾选决定列表/卡片列，标识列固定并带锁标记，保存写入列订阅并立即更新表头；窄屏下表格只在对话框内横向滚动。关键词输入框对齐 cantor：回车把 `_type:<模型>,*关键词*` 提交到 `/ci/s`，匹配已索引属性值并跨分页搜索，扁平结果映射回实例结构，分页使用服务端 `numfound`；清除或空值回车恢复普通列表，环境/等级筛选仍只作用于当前页。玻璃正文只有一个纵向滚动容器，首项为环境/等级筛选和列表/网格工具栏，随后是表格/网格与分页；保留订阅列、编辑/删除和实例抽屉。切换模型会清空上一模型的行、计数、属性和列并回到内容顶部；模型列表加载失败有独立提示和重试，不阻塞实例表格。640–1279px 页头操作换到标题下方。1280 以下默认网格，桌面默认表格。
- [x] 引用字段显示：资源数据的表格、网格卡片和详情不再直接打印引用属性的 CI id。页面按 `reference_type_id` 分组，使用 `/ci/s` 的 `_type:<id>,_id:(…)` 批量查询被引用实例（每批 100 个），按目标模型的 `show_name`、`unique_key`、`name`/`alias` 依次选择显示名；查询失败或目标实例已删除时回退原始 id。表格标题保留 `名称 (原始 id)` 便于核对，客户端页内筛选也匹配解析后的名称。详情抽屉通过父页面的模型快照解析引用，不新增后端接口。新增 `reference-labels` 纯函数测试，以及资源表格和详情展示名称的回归测试。
- [x] 枚举标签显示：资源数据的表格、网格卡片、详情和抽屉状态标签不再直接打印枚举代码，而是读取属性的 `choice_value[].option.label`（如 `prod` → 生产、`critical` → 关键、`active` → 使用中）；未知代码仍显示原值，原始代码保留在 `title`。环境/等级筛选按钮同步显示标签，但过滤状态仍保存原始代码；页内关键词筛选也匹配标签。多值枚举按标签逐项展示。新增 `choice-labels` 纯函数测试，并扩展资源数据测试覆盖表格、筛选、卡片、详情和状态标签。
- [x] 引用搜索选择：新建/编辑实例时，引用属性改用 `ReferencePicker`，不再要求手工填写 CI id。打开下拉加载目标模型前 20 项，输入时以 250ms 防抖调用 `/ci/s`（`_type:<id>,*关键词*`）；选项按目标模型 `show_name`/`unique_key`/`name`/`alias` 显示，选中写回数字 id。单值与多值引用共用同一组件，多值支持连续选择；当前值名称沿用页面的批量解析结果，清除按钮写回 `null` 或空数组。搜索失败保留已选值和错误提示，不阻塞表单。新增 `ReferencePicker` 组件测试，覆盖远程搜索、编辑态名称/清除和多选，并在实例表单中验证保存 payload。
- [x] 资源详情抽屉：资源数据表格与卡片把详情/拓扑/编辑/删除改为带 `aria-label`/`title` 的图标按钮，其中“详情”打开只读 `xl` Drawer，“拓扑”直接打开抽屉的拓扑视图，头部左侧为模型图标，右侧第一行为资源名称、模型标签和状态胶囊，第二行为 ID、更新时间、更新人和唯一标识（与名称不同时）；实例读取接口返回 `updated_by`，创建/更新时写入调用者 JWT 邮箱，管理员在头部把邮箱解析为用户显示名；视图切换使用共享的下划线 Tab（详情、拓扑、变更历史、触发记录），每个 Tab 前带对应图标；390px 英文下压缩间距并保持四项全部可见；Tab 栏使用不透明 sticky 容器覆盖抽屉正文上内边距，避免滚动内容从上方穿出，并在 Playwright 中校验 Tab 与滚动容器顶部对齐。详情属性区使用与关联关系一致的卡片头部（图标、标题、属性数量、刷新），下面按模型表单分组以两列字段网格展示有效属性（密码只显示占位符），字段行尾的铅笔按值类型就地编辑（引用复用可搜索选择、单选枚举按配置标签下拉、布尔开关、日期时间/JSON/多值复用表单控件），文本/JSON 在失焦或回车时保存、布尔/枚举/引用选择即保存、Esc 放弃且不显示保存/取消按钮，保存通过 `PUT /instances/{id}` 只提交该属性，成功后就地更新抽屉头部与值、通知列表/关系表刷新并静默拉取计算属性，失败保留草稿并显示后端信息；密码、计算和文件字段不提供行内编辑；底部增加关联关系区：按模型关系图列出上游/下游类型与数量，侧栏可按类型过滤；关联表压缩为“资源、关键属性、操作”三列，优先显示名称、唯一标识和两个环境/状态类字段，并按完整属性元数据解析枚举与引用名称；每行提供详情、拓扑和“在资源数据中打开”的图标操作，后者通过 `?type=<模型>&ci=<实例>` 新开页面并自动打开该实例抽屉；分组标题提供“添加”入口，打开可搜索的目标实例对话框，选择后按上/下游顺序调用 `POST /ci-relations/{first}/{second}` 并刷新；窄屏将关键属性收进资源行内。删除关系仍不放入此查看区；拓扑按 `ci-relations/search` 的正向/反向关系装配父级、当前资源、子级，并提供 cantor 风格的思维导图/紧凑布局、关系样式开关、节点详情卡和叶节点向外逐层展开；双击节点把抽屉切换到该资源并保持拓扑 Tab（与 cantor 一致），节点详情卡另提供“切换到此资源”按钮供键盘/触屏使用，同模型复用已加载元数据，跨模型按目标模型加载属性与分组并隐藏原页面的编辑入口；变更历史与触发记录分别读取 `/history/ci/{id}`、`/history/ci/{id}/triggers`，保留分页、用户映射、空态和失败重试；编辑仍打开原有实例表单。监控与 Prometheus 告警不放入抽屉：CMDB 独立服务没有移植 cantor common-setting 的资源映射，现有监控能力在 `/monitor`、`/alerts`，不显示无法兑现的空标签。
- [x] 模型配置列表布局：`/cmdb/models` 页头沿用与模型详情一致的统一 `PageHeader`，标题行右侧放刷新/内建模型/新建模型，说明行显示模型总数、启用、停用和含继承数量；正文使用同一套 scoped `.cmdb-liquid` 工作区。保留名称/别名搜索、只看启用、列表/网格切换、列隐藏、排序和移动端操作菜单。玻璃卡片展示模型标识、展示属性、继承来源和状态；桌面默认表格，1280 以下默认网格，窄屏隐藏无意义的“选择模型”栏。表格默认显示模型、标识属性、继承来源和操作，展示属性默认收入“列”菜单，避免 1440 宽度下被固定操作列遮挡；`is_attached` 是 cantor 的历史存储字段，不代表“能否存实例”，页面不据此显示不可用提示。
- [x] 列表滚动修复：`.cmdb-liquid` 外层必须是 `flex flex-col`，否则 `.cmdb-liquid-content` 的 `flex-1` 不生效，内容会按全量高度撑开并被外层 `overflow-hidden` 裁掉，表格/网格只能看到首屏。修复后内容区限制在可用高度内滚动，89 个模型可一直滚到最后一条；新增 1440px 真实 Chromium 滚动断言覆盖表格和网格。
- [x] 模型分组显示：`/cmdb/models` 增加可选“按分组显示”，默认平铺；使用共享模型分组（不请求服务端 `include_ungrouped` 桶），按接口组顺序与页面最新模型快照 join，首组优先去重，未分组模型追加到末尾“其他”。分组表格仍是一个 `DataTable`，用跨列 `th scope="rowgroup"` 标题行插入组标题，保持一个列选择器、一个横向滚动容器和固定操作列；网格使用扁平分节标题与卡片网格，不嵌套玻璃面板。分组加载失败保留平铺列表并显示可重试提示；分组为空时隐藏开关。新增纯函数 `groupModels`、DataTable `groups` 渲染支持、Vitest 和真实 Chromium 覆盖。
- [x] 模型定义 JSON：模型详情页头在刷新与“编辑模型”之间新增只读“模型定义”入口，使用 `xl` Drawer 展示 `ongrid.cmdb.model` v1 快照。打开时独立从现有读接口取模型、有效属性、表单分组和关系，管理员额外取唯一约束与触发器；非管理员这两段为 `null` 并写入 `sections_omitted` 的 `admin_required` 原因。属性把 `is_required`/`order`/`default_show`/`inherited` 收进 `binding`，分组只保留 `attribute_ids`，关系合并父子方向、基数、属性映射和未配对 id，约束保留原始 ids 与 `missing_attribute_ids`，触发器 `option` 递归剔除 `authorization`/`password`/`compute_script`/`choice_web_hook`。展示、复制、下载共用同一个格式化 JSON；下载使用共享的 `downloadJSON` 与清洗后的 `cmdb-model-<name>.json` 文件名。无后端接口、proto 或 SQL 变更；当前文档是只读描述性快照，不承诺导入。
- [x] 表格响应式：`DataTable` 的操作列表头与操作单元格一起 `sticky right-0`，避免横向滚动时被覆盖列的表头从按钮上方透出；模型列表在 `sm` 以下把编辑/启停/删除收进“更多操作”菜单，避免固定操作列遮挡模型名。
- [x] 工作区顶栏：`/cmdb/models` 与 `/cmdb/models/{id}` 的页头从内容列移到横跨模型树和正文的工作区顶栏。`ModelConfigShell` 新增 `header.leading`/`header.actions`：左侧是 CMDB 标识（logo + “CMDB 资源管理平台”）、分隔线和面包屑，右侧是统计胶囊组与操作组；面包屑末项作为页面 `h1`（列表页“模型配置”，详情页模型别名，模型图标与停用/无属性标记随标题）。统计胶囊合并为一组，内部用细分隔线；手机宽度隐藏品牌名并允许操作组换行；工具栏在 1440px 以下把搜索、分组、刷新和视图控件移到筛选下方。`PageHeader` 的 `inlineLeading` 在不再使用后删除，避免保留只服务一次调用的公共参数。
- [x] 工具栏色带：模型列表的筛选/搜索工具栏由浮动圆角卡片改为工作区色带，紧贴工作区顶栏下沿和模型树右边，横向铺满正文；表格滚动时色带保持不动，表格与分页仍在带内边距的玻璃卡片区域内。实现上把 `cmdb-liquid-content` 改为纵向容器，色带固定，余下内容放进唯一的纵向滚动区（`space-y-4` 分栏），避免 flex 子项被压缩后裁掉表格行。
- [x] 详情页签固定：模型详情的页签栏（属性 / 表单分组 / 模型关系 / 唯一约束 / 触发器 / 自动发现）移出滚动区，作为工作区顶栏下方的一条固定 chrome（沿用 `.app-header` 的底色与分隔线），页签内容在下方独立滚动；手机上页签换行时固定条同步增高，页面不横向溢出。
- [x] 详情内容区统一背景：页签下方整块内容区改由页面提供一层 `.cmdb-liquid` 工作区表面（渐变 + 光斑 + 固定光斑位置），内边距从 `p-6` 收到与列表一致的 `p-4`；`ModelAttributesPanel` 不再自带 `.cmdb-liquid` 和光斑，只保留玻璃面板，其他页签的 `Card` 也直接铺在同一背景上，切换页签时背景不再从渐变面板跳回灰色页面。错误提示同时改为浅色 `text-red-600`、深色 `dark:text-red-300`，与列表一致。
- [x] 资源数据对齐模型配置：把工作区顶栏抽成共享 `WorkspaceBar`（品牌 + 面包屑 + 右侧统计/操作，模型详情与资源数据共用），资源数据页改为“顶栏横跨模型导航与正文 → 模型导航 → 固定筛选色带 → 满高工作台卡片”。导航收成模型配置的紧凑样式（仅搜索、分组树、高级查询，lg 16rem / xl 18rem），筛选工具栏（环境/等级、服务端搜索、字段、列表/网格）移入 `.cmdb-workspace-band` 色带并固定；正文用与模型列表相同的 `DataTable fill`（表内滚动 + 吸顶表头）和 `PaginationFooter embedded`（分页嵌入卡片底部，显示“显示 x 至 y 条，共 n 条实例”和页码）。`MetaPill` 抽成共享组件供详情页和资源数据复用；`cmdb-model-config-toolbar-band` 更名为通用 `cmdb-workspace-band`。吸顶表头改用不透明的 `--card` 背景，修复 97% 透明时行文字从表头下方透出的重影。单测与 Playwright 的滚动断言改为指向工作台卡片内的滚动区。
- [x] 模型操作图标：模型配置列表行和网格卡片的“编辑 / 停用（启用）/ 删除”由文字链接改为 28px 图标按钮（铅笔 / 电源 / 垃圾桶），保留 `aria-label` 和 `title`（`编辑 host`、`停用 host`、`删除 host`），颜色沿用 `cmdb-liquid-action-edit` 蓝、`cmdb-liquid-plain-action` 中性、`cmdb-liquid-action-danger` 红；`ActionLinks` 同时服务表格和卡片，窄屏表格继续收进“更多操作”菜单。操作列因此变窄，表格与卡片获得更多信息宽度。
- [x] 工作台卡片：模型列表正文改为一张满高玻璃卡（参考 `docs/design/cmdb/model_list_layout_a_workbench.html`），表格直接从卡片顶部开始，不再有“模型列表 + 数量 + 列”的卡片头行。`DataTable` 新增 `fill`（卡片内纵向滚动），并把列可见性拆成可复用的 `useColumnVisibility` + `ColumnVisibilityMenu`：页面可以受控传入 `hiddenColumns`/`onToggleColumn` 并在工具栏渲染列设置，同时用 `hideColumnPicker` 关闭表内那行；存储键仍为 `cmdb.table.models.hidden`。`PaginationFooter` 新增 `embedded` 模式嵌在卡片底部，不再作为下面的独立浮层。分组视图无分页；列/网格/分组三种状态共用同一张卡片。低于 `2xl` 时操作列仍为静态，纵向吸顶通过 `right:auto` 避免把表头重新固定到右侧遮挡数据列；滚动断言改为针对卡片内滚动区，并用更长的标识属性构造横向溢出以覆盖固定列表头行为。
- [x] 测试：后端 citype 的 show_key 创建/更新/清空、继承替换/保留/清空、自引用 400、HTTP DTO；前端 `Models`/`ModelDetail`/`Instances`/`ModelTree`/`AttributeForm`/`AttributeDictionary`、`ModelDefinitionDrawer` 及 `model-definition` 构建器和关系映射；新增逐行类型筛选、有效类型图标、唯一/必填卡片标记、资源详情抽屉的四个视图、关联表资源/关键属性/动作、搜索式添加关系、Tab 栏 sticky 覆盖、拓扑树构建/展开/布局纯函数、拓扑双击切换与抽屉换主体（含跨模型元数据加载及同目标忽略）、详情行内编辑（回车/失焦自动保存、单选枚举选择即保存、Esc 放弃、未修改离开不写入、JSON 客户端校验、失败保留草稿、密码/计算不可编辑、单属性写入）、详情头部（模型标签、状态、ID/更新时间/更新人/UUID）、属性卡片头部（数量、刷新）、资源数据模型导航分组（分组标题/数量、折叠/展开、其他分组、搜索过滤、分组失败回退）、字段弹层（全部属性表、类型/可检索/默认展示/唯一/枚举/多值/可排序/计算属性列、搜索、标识列固定、保存列订阅）、服务端全模型搜索（回车提交 DSL、扁平结果映射、清除回列表）、新增关系表单（源/目标/关联类型/关系约束、默认属性关联行、候选过滤、增删行、保存 payload）、关系表（模型图标、属性关联列、图标操作）及 390/768/1280/1920 × zh/en × light/dark 截图矩阵；模型配置与资源详情相关 Playwright 断言共 **52 条**（原有 27 条 + 资源详情 20 条 + 资源数据模型导航/字段 2 条 + 服务端搜索 1 条 + 新增关系表单 1 条 + 关系表 1 条）。
- 验收：`go test -race ./internal/cmdb/biz/citype ./internal/cmdb/data/citype/store ./internal/cmdb/server/citype`；`go test ./...`；`go vet ./...`；`make arch-lint`（`go-arch-lint` v1.19.0，`OK - No warnings found`）；CMDB Vitest **48 文件 / 284 tests**；`npm run build`；`npm run lint`（0 errors / 44 既有 warnings）；模型配置与资源详情相关 Playwright **51 tests 通过**。
- 真实浏览器：模型列表 390/768/1280/1440/1920（zh/en、light/dark；桌面表格、1280 以下默认网格，列表/网格双向切换），模型详情 390/768/1280/1920，liquid-glass 属性视图与资源数据页 390/768/1280/1440/1920，属性字典和属性表单 390。模型列表平铺与分组各 20 个视口组合均无控制台错误和 `documentElement` 横向溢出；分组模式在 390/768 显示 14 个网格分区，在 1280/1440/1920 显示 1 个表格、14 个分组标题行和 1 个列选择器；1440 以上表格完整显示，1280 及以下在表格自身容器滚动；移动端操作收进菜单。另用本地 89 个模型验证内容区可滚动到最后一行的“虚拟机”和网格的最后一个卡片。资源数据页按 390/768/1024/1280/1440/1920 × zh/en × light/dark 共 24 组验证：模型导航在 1024 及以上可见、以下只显示模型 Select；页头和模型导航都在 `.cmdb-liquid-content` 之外；单一纵向滚动容器可到最后一行/卡片；页面无横向溢出、无控制台错误。1440 另验证模型导航分组：模拟分组显示“服务器 1”“其他 1”，点击“服务器”折叠后主机按钮消失、再次点击展开，搜索“交换”后“服务器”消失且“其他”保留；真实环境 13 个分组下显示“资源层-数据中心 10”“资源层-计算资源 5”等标题与数量，并自动滚动到选中的“虚拟机”。工具栏“字段”在 1440 打开“属性说明”对话框：列头包含名称/别名/类型/可检索/默认展示/唯一/枚举/多值/可排序/计算属性，仅订阅两列时仍可勾选“操作系统”，保存后新增该列并校验 `PUT` 列订阅；真实虚拟机模型显示 59 个字段及 49 个已选列，深色下核对表格与标志列，390 下对话框落在视口内、表格在弹层内横向滚动且页面无横向溢出；资源数据搜索在 1440 输入 web-77 回车，断言请求为 `_type:1,*web-77*`、结果行显示 web-77/server match、统计行“匹配实例 1”与“命中 1 条”，点击清除后恢复普通列表；真实 vserver 模型输入 dbs 命中 77 条，结果行、统计与提示一致。模型关系页在 1440 打开“新增关系”：源 CI 类型/目标 CI 类型/关联类型/关系约束/属性关联按参考布局显示，关系约束为“一对多”；默认属性关联行选择“主机名 → 序列号”后新增并删除第二行，保存校验 `parent_attr_ids:[10]`、`child_attr_ids:[20]`；关系表在 1440 浅色下显示源/目标图标与名称、关系类型、约束、属性关联“主机名 → 序列号”和图标删除按钮，真实数据深色下同样核对。模型定义抽屉按 390/768/1280/1440/1920 × zh/en × light/dark 共 20 组验证：JSON 只在 `<pre>` 内滚动，390 下抽屉占满视口宽度，页面无横向溢出、无控制台错误。属性工作区按 390/768/1280/1920 × zh/en × light/dark 共 16 组截图，全部无 `documentElement` 横向溢出；1440 验证“整数”筛选只保留匹配行并显示清除筛选，列表/网格切换后类型图标、密码类型、唯一标记和必填星标均可见；1920 网格为四列。资源详情抽屉同样按 390/768/1280/1920 × zh/en × light/dark 共 16 组验证，下划线 Tab 在 390px 的英文标签下仍全部可见且无页面横向溢出；每组先打开“说明”的行内编辑器并截图，确认输入框与自动保存提示在视口内、页面无横向溢出，再用 Tab 离开未修改字段并确认行关闭且没有写入，随后打开拓扑、点开节点详情卡并确认“Switch to this resource/切换到此资源”在视口内；1440 在详情行内把“说明”改为 rack Z 后按 Enter，校验 `PUT` 请求体只含 `{values:{note:"rack Z"}}`、出现“已保存”Toast 且值立即更新；再改为 rack Y 后点击别处触发失焦保存并确认第二次 `PUT`，最后输入草稿按 Esc，确认行关闭、抽屉仍在且值保持 rack Y；1440 实际切换详情、拓扑、变更历史、触发记录并截图，详情截图覆盖两列属性区和底部关联关系表；拓扑在 1440 验证初始父/子节点、展开一个叶节点、出现新节点及节点详情卡，在 390 验证同一展开流程且页面无横向溢出。1440 另用真实 Chromium 双击“机柜”节点，验证抽屉头部切换到 `#41` / `rack-01`、拓扑 Tab 保持选中、跨模型时编辑入口不再出现。真实数据（产品 #3845）验证关联表：业务服务行显示名称、标识、环境/状态标签，详情/拓扑/资源数据三种操作可用，点击资源数据后通过 `?type=service&ci=3846` 刷新并自动打开目标实例；新增对话框可搜索目标实例；并验证嵌套详情与拓扑抽屉正常；编辑表单中“运维负责人”搜索“何”返回“何忠贵”并写回 374；枚举标签按 390/768/1280/1920 × zh/en × light/dark 共 16 组验证，筛选标签、卡片/表格和 390px 详情均正常且无横向溢出；引用选择浮层按 390/768/1280/1920 × zh/en × light/dark 共 16 组验证，均位于视口内、无横向溢出、无页面异常；SLA“白银”、资源分类“业务系统”、负责人“何忠贵/夏梅娇/任光前”，悬停保留原始 id（2353/3785/374 等）；真实数据（产品 #3937）验证详情、属性变更历史和空拓扑/空触发记录；真实数据（虚拟机 #3855）验证两列属性区、关联关系侧栏与空关联表：均无页面横向溢出、无页面异常；同一实例验证新头部：模型图标、名称 + 虚拟机标签 + 使用中状态，以及 ID: 3855、更新时间 2026-07-15 18:31:17、更新人 admin 和 UUID；接口返回 `updated_by: "admin"`；详情属性区与关联关系使用同一卡片头部（图标、属性数量、刷新），1440 下属性 14 与刷新按钮正常显示。
- 已知限制：前端没有全局 ErrorBoundary；渲染期异常会卸载整个 SPA（本次关系契约错误因此表现为空白页）。本次已修复触发错误，路由级错误边界建议作为独立改进。
- 已知限制：模型定义 JSON 是只读描述性快照，当前没有导入端点，不承诺可回灌。非管理员导出时唯一约束与触发器为 `null`，并在 `sections_omitted` 标记 `admin_required`；属性和触发器的自由字段（`default`、`option`、`choice_value[].option`）按现有读契约保留，若管理员在里面写入敏感值会随下载带出，是否进一步裁剪需产品确认。
- 已知限制：资源详情行内编辑不包含文件上传、密码回显，密码/计算/文件属性仍通过完整表单处理；行内编辑没有乐观锁，并发修改以最后一次写入为准，变更历史保留双方记录；`c_cis.updated_by` 由 Go 端口写入调用者 JWT 邮箱，cantor 迁移的旧数据仍是昵称，非管理员或邮箱无法解析时头部按存储值原样显示；资源详情拓扑首屏展示直接父级/子级，可继续向外展开，但不会把内向节点自动加为新卡片；节点很多时首屏聚焦当前资源，需拖动画布查看其余节点；详情里的变更历史是 `/history/ci/{id}` 的实例属性变更，关系变更仍在管理员的操作历史页；监控和 Prometheus 告警没有对应的独立 CMDB 资源映射，未放入抽屉，现有入口仍是 `/monitor` 与 `/alerts`。资源数据搜索沿用 cantor 的语义：只匹配后端已索引的属性值，枚举匹配存储代码、引用匹配存储 id，不匹配配置标签或引用名称；未索引文本与 JSON 不参与搜索。
- 已知限制：完整前端套件以 2 个 worker 运行（118 文件/685 tests）时仅 `src/api/skills.test.ts` 1 项失败，原因是实现已改用 `device_id` 而测试仍断言 `edge_id`，属于分支基线既有问题；其余 117 文件/684 tests 通过。默认并发下另有 7 个测试文件因超时失败，单独运行均通过，是资源争用而非本次回归。P1 的模型组拖拽、触发器日期/过滤/通知投递、模型级自动发现、快捷启停开关和更完整的 choice webhook/脚本编辑器不在本次范围。cantor 数据迁移在独立的 `feat/cmdb-cantor-data-migration` 分支处理，不在本分支混入。

## 增量：IPAM 完整移植（`feat/cmdb-model-config-ux`）

范围：按 nexus-cantor 的 IPAM 工作台补齐总览、地址分配、IP 搜索、子网列表、历史五个页签，并修复后端在模型/标识/统计/扫码路径上的缺口。决策见 [ADR-036](../adr/ADR-036-ipam-model-and-identity.md)。

- [x] 内置模型：`ipam_scope`/`ipam_subnet` 的唯一/展示属性统一为 `name`；地址模型补齐 `name/description/usage/use_obj/gateway/subnet_mask/mac_address`，子网补齐 cantor 的掩码、网关、VLAN、VRF、用途、备注与地址段；`ensureBuiltinModels` 同时引导 DCIM 与 IPAM，幂等且只增不改。`EnsureBuiltinModels` 测试覆盖 IPAM 模型解析和属性绑定。
- [x] 写入正确性：`writeCITx` 在 `ValidatingID` 存在时按 id 更新并对新唯一值做冲突检查，改名不再新建子网；子网更新未传父节点时从实际包含边推导父级；`CreateIPScope` 写模型自己的唯一属性名，嵌套分组也写操作历史；新增 `PUT /v1/cmdb/ipam/scopes/{id}` 与 `UpdateIPScope`，返回 `{ci_id}` 并写 `UPDATE_SCOPE`。
- [x] 地址写入：`POST /v1/cmdb/ipam/addresses` 把模型属性透传给写入路径；`subnet_id` 已给时以存储 CIDR 为准并拒绝不一致的调用方 CIDR；网络/广播地址不可分配；`ips` 接受数组或逗号/空格分隔的字符串。
- [x] 统计与历史：`subnetLeaves` 穿过 scope→subnet、scope→scope 与 subnet→subnet 边，选择分组与嵌套分组都能汇总叶子子网；`cidr` 历史过滤支持 `*term*`（`!` 转义，兼容 MySQL/SQLite）；删除子网/分组写调用者 uid 与名称。
- [x] 扫码：报告保存 `start_at/end_at`，`ips` 接受对象或数组并按原始 JSON 存储；按 `exec_id` 幂等更新；回写规则的 `last_scan_time`；每个规则保留最近 100 条。`subnets/hosts` 的 `limit` 封顶 4096，`truncated` 按范围实际容量判断。
- [x] 前端外壳：五个页签与 `?tab=&node=` 深链、删除节点回落 `all`；树包含“全部”根、搜索、分组/网段图标、主机计数、节点菜单（新建分组/网段、编辑/重命名、移动、删除）、键盘与 ARIA；“全部”与节点菜单的点击不会误选节点。共享 `Tree` 增加可选 `icon`/`actions` 槽。
- [x] 总览：四张比率卡（子网、地址空闲/使用、分配、在线）使用圆环和数值图例，1400px 以上四列、以下两列；子网表包含名称/CIDR/主机/在线率条/已分配/空闲/扫描，操作图标带名称；最近扫描默认隐藏；支持导出、错误重试与分页。
- [x] 地址分配：合并范围主机与已登记地址，未登记主机显示“未使用”；统计条、四种派生状态胶囊及计数、IP/用途/使用对象搜索、跨多个 /24 的范围筛选、表格/网格切换、状态色图例、普通/Ctrl/Shift 选择与筛选后选择收敛；编辑对话框支持状态、使用对象（choice 时下拉）、用途、描述、MAC、网关、掩码，单行预填、批量留空不改、混合状态必须选择、回收走状态 1；`is_used` 不由控制台发送。
- [x] IP 搜索 / 子网列表：IP 搜索用 `/ci/s` 的 `_type:<id>,*term*`，状态筛选、列显隐、客户端排序、行内编辑/回收与所属网段解析；子网列表全量搜索、排序、编辑/删除与导出。两个页签都用服务端 `numfound` 分页。
- [x] 历史：操作日志/扫描日志子页签；CIDR 通配搜索、操作类型过滤、操作人（管理员显示名，失败 `#uid`）、扫描开始/结束/耗时/结果与 stdout/ips Popover；导出与错误重试。
- [x] 导出：共享菜单提供 CSV/Excel/JSON/YAML/文本，复用 `exceljs`/`js-yaml`；各页签导出当前筛选后的行。
- [x] 权限与响应式：写操作按 `canMutate` 门禁；宽度不足 1536px 时操作列改为静态，表格在卡片内横向滚动、页面不横向溢出；树在手机上限制 45vh 并内部滚动；页签窄屏换行。IPAM 分页条改为内容流内布局，不再 `sticky` 覆盖表格行；总览/IP 搜索的次要列在窄内容宽度自动隐藏并在宽屏恢复（总览主机数/扫描 <1400px、已分配 <900px），避免固定列遮住名称和操作。修复浅色/深色、390/768/1280/1440/1920 下的卡片图例截断、表格列被操作列遮挡、分页条压住行和手机树与内容重叠。
- [x] 扫码历史读取：`c_ipam_subnet_scan_histories.ips` 在 cantor 迁移数据中同时出现对象和数组；模型改为保存原始 JSON 文本，接口解码后原样返回，避免数组行导致 500。
- [x] 验证：后端 `go test ./internal/cmdb/...` 通过；新增改名/父级校验/重复名/scope 创建与改名/地址属性/存储 CIDR/统计 scope 与嵌套 scope/扫码幂等与 last_scan_time/内置引导测试。前端 CMDB Vitest **50 文件 / 310 tests**；`npm run build`、`npm run lint`（0 errors / 45 既有 warnings）。Playwright 新增 IPAM 覆盖（4 宽度 × 2 主题 × 2 语言 + 两个交互用例 + 1280 列自适应用例）**20 条通过**。
- [x] 真实浏览器：登录本地 cantor 对照五个页签；hilbert 本地以真实数据验证总览分组统计（CGZAir 4 个叶子、857 空闲）、地址管道的 254 个主机与 19 个“未分配&在线”、网格配色、扫描历史 900 条与耗时、历史通配筛选（67→38）、`subnets/hosts` 的 limit/truncated；用临时分组完成新建→重命名→删除，并确认树中只有一行新名称、历史记录类型 0/1/2 和 uid，随后清理。390/768/1280/1920、zh/en、light/dark 截图核对通过，未发现页面横向溢出。
- 已知限制：不引入拖拽库，移动仍用对话框；地址唯一键保持 `ip`（不恢复 cantor 的自增键与重复 IP）；`use_obj` 的服务端 choice 校验未实现，直接调用 API 可写任意字符串；权限只在前端门禁，服务端仍为任意已认证用户；地址工作区对超过 4096 个主机的范围只展示前 4096 个主机和全部已登记地址，并明确提示；不提供计数回填任务；导出不包含“本页/已选”独立范围，导出的是当前筛选结果。

## 增量：数据中心完整移植（`feat/cmdb-model-config-ux`）

范围：按 nexus-cantor 的 DCIM 工作台补齐“区域 → 数据中心 → 机房 → 机柜 → 设备”的完整操作面。后端 11 条 DCIM 路由、机柜 U 位事务、迁移/下架、历史与重算在之前的移植中已经存在；本轮核对后不新增后端契约，只修正前端 API 类型和展示，并把页面补齐到 cantor 的可用范围。

- [x] 树与导航：区域/数据中心/机房三级树、机房机柜数向上累加、搜索保留祖先、节点菜单（新建子级、编辑、删除、重算）、`?node=` 深链与删除/失效回落；只有机房会切换右侧工作区。
- [x] 机房工作区：统计条（机柜数、设备数、容量使用率圆环）；名称/机柜类型/U 位异常筛选；网格/表格切换；网格在 1400/1800px 分三/四列；表格使用订阅字段，名称、使用率和操作始终在前，次要列在 1400/1536px 以下收敛。
- [x] 机柜抽屉：前视图/后视图 U 位（24px/U，按 `u_numbering_direction` 排列，使用 cantor 的机柜与设备正反面图）、空 U 上架、设备跨行块、桌面拖拽换位、移动/迁移/下架、重叠与超出柜高的异常合并、未绘制设备提示；属性（按模型分组）、设备列表（按模型分组、订阅列、导出）、操作日志（分页、类型筛选、操作人显示名、导出）四个页签。
- [x] 动态表单：节点与机柜新建/编辑按模型属性生成，支持必填、枚举、布尔、引用、日期时间、多值、密码不回显；新建机柜可填写高度和可用 U 数；保存失败保留输入并展示后端原因。
- [x] 写入与权限：节点/机柜 CRUD、上架/移动/迁移/下架、机柜删除均接现有 DCIM 端点；写操作按 `canMutate` 门禁，查看者的抽屉和 U 位视图不出现写按钮；删除机柜提示会下架设备，删除分组提示子节点失去归属。
- [x] 契约修正：`operate_type` 统一按 `0/1/2` 渲染“上架/下架/移动”；`recalc`/`unmount` 的返回类型与后端一致；移动请求带 `u_count` 类型；机柜表不再读取不存在的 `is_overlap`/`device_count`。
- [x] 验证：CMDB 前端 Vitest **51 文件 / 330 tests**；`npm run build`、`npm run lint`（0 errors / 45 既有 warnings）；Playwright 新增 DCIM 专用交互 1 条 + 响应式矩阵 16 条（390/768/1280/1920 × zh/en × light/dark），另在 1440 核对网格/表格/抽屉/日志截图；全量 `cmdb-pages-responsive.spec.ts` **233 passed**，最终构建后 DCIM 18 条复跑通过。真实浏览器用本地 DCIM 数据核对 17 个机柜、78 台设备、容量 24%、前/后视图 U 位、属性分组、设备列表和 11 条操作日志。
- 已知限制：机柜的设备数只有机房级汇总，没有逐柜 `device_count` 列；前端不提供节点换父级；触屏没有拖拽（用移动对话框替代）；设备图按模型映射 server/switch/router/firewall/raid，未知模型回退服务器图；操作日志固定服务端倒序，没有列排序。

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
