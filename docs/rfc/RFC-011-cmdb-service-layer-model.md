# RFC-011: CMDB 三层服务模型与 CALLS 迁移

## 元信息

- 状态：草稿（待评审）
- 日期：2026-11-09
- 作者：Claude
- 范围：`internal/cmdb` 模型/关系/API、AIOps CMDB 工具、`web` 控制台、nexus-topocortex connector
- 关联：CMDB 关系审计计划 §6.8、CALLS 词表（PR #12）、ADR-037、[关系方向映射](../design/cmdb-relation-direction-mapping.md)

## 背景

CMDB 当前的 `service`、`application`、`app_instance`、`app_cluster` 是部署方自建的模型，同一个 `service` 同时承载业务服务和可部署服务两种语义：

- `depend service→application` 有 176 条边，无法判断是业务归属还是运行时依赖；
- `connect service→service` 的 3 条真实边被归为 `CONNECTS_TO`，没有 caller→callee 语义；
- AIOps 的爆炸半径无法区分“业务影响”和“技术调用”，也无法从应用服务下钻到实例；
- 业务服务之间没有独立节点，影响面无法自然上卷。

用户给出的典型链路是：FOC 运行控制服务调用气象接口服务、订单服务调用会员服务。这类问题需要 **ApplicationService --CALLS--> ApplicationService** 的主边，以及业务服务（BusinessService）和实例（ServiceInstance）两层用于汇总和下钻。

已经具备的基础：

- `CALLS` 词表（caller→callee、`dst_to_src`、传播、weight 0.9）和 `--ensure-relation-vocabulary`；
- 关系边 provenance（`evidence_source`/`confidence`/`observed_at`）和弃用写入闸门；
- 拆分/清理命令、关系方向 `inverse_of` 约定、AIOps 拓扑方向修正。

## 目标

- 建立三层服务类：`business_service`、`application_service`、`service_instance`。
- 定义四条主关系：`CONTAINS`（业务服务→应用服务）、`CALLS`（应用服务→应用服务）、`HAS_INSTANCE`（应用服务→实例）、`RUNS_ON`（实例→宿主），以及 `DEPLOYED_TO`（应用服务→集群/环境）。
- 让 AIOps 能在 ApplicationService 层做调用链影响面，在 BusinessService 层做业务影响上卷，在 ServiceInstance 层做实例下钻。
- 保留旧模型和旧边，直到新图完成对账并经过一个发布周期。
- 迁移全程可 dry-run、可对账、可回滚，不一次性切换。

## 非目标

- 不自动把所有现有 `service`/`application` 归类；无法判定的进入 review 队列。
- 不在本 RFC 内定义 topocortex 的类/关系语义；CMDB 只做镜像和 connector 映射。
- 不删除旧模型或旧关系类型，直到 M4 且满足下线门槛。
- 不引入图数据库；继续使用 `c_ci_relations`。
- 不把异步消息强行建模成 `CALLS`；`PUBLISHES_TO`/`SUBSCRIBES_TO` 另立词表。

## 类模型

模型名使用 snake_case，显示名单独配置；标识属性为 `code`（必填、唯一、可索引），`name` 为显示名。

| 类 | 用途 | 标识 | 关键属性 | 示例 |
|---|---|---|---|---|
| `business_service` | 业务服务/业务域，影响汇总的顶层 | `code` | name、owner、criticality、business_domain | FOC 运行控制、订单管理、会员管理 |
| `application_service` | 可部署的应用服务/微服务，调用链主图 | `code` | name、service_type（internal/external）、protocol、owner、criticality、repo、environment | FOC 运行控制服务、订单服务、会员服务、气象接口服务 |
| `service_instance` | 运行时实例（Pod/进程/容器） | `code` 或 `instance_id` | name、version、host、port、status、started_at | order-api-7d9f、foc-worker-2 |

标识属性在 CMDB 里按层加前缀（`business_service_code`、`application_service_code`、`service_instance_code`），因为 `c_attributes` 是共享字典，一个共享的 unique `code` 会让三个模型的唯一性互相影响；`name` 是共享的显示属性，只建索引。

`application_service` 的外部服务（如气象接口）用 `service_type=external` 标记，并配合合同/供应商关系；不单独建类，避免同一层出现两套编号。

### 类如何创建

三个类是固定模板，不是启动时隐式创建。两个入口共用同一份规格（`cibiz.AllBuiltinModels`/`AllBuiltinRelations`）：

- 管理员 HTTP 入口 `POST /v1/cmdb/ci-types/ensure-builtin`（现有 bootstrap）；
- 运维命令 `ongrid-cmdb --ensure-builtin-models`，适合没有交互会话的部署。

两者都只创建缺失的模型/属性和关系，已存在的模型不覆盖，可重复执行。

## 关系模型

| 关系 | CMDB 类型 | CMDB 存储方向 | topocortex 目标 | `inverse_of` | 传播 | weight | 基数 |
|---|---|---|---|---|---|---|---|
| 业务服务包含应用服务 | `CONTAINS`（已有） | business_service → application_service | `PART_OF` | `PART_OF` | false | 0 | one2many 或 m2m |
| 应用服务调用应用服务 | `CALLS`（已有） | caller → callee | `CALLS` | 无 | true | 0.9 | m2m |
| 应用服务有实例 | `HAS_INSTANCE`（新增） | application_service → service_instance | `INSTANCE_OF` | `INSTANCE_OF` | false | 0 | one2many |
| 实例运行于宿主 | `RUNS_ON`（已有） | service_instance → host/VM | `RUNS_ON` | 无 | true | 1.0 | m2m |
| 应用服务部署到集群/环境 | `DEPLOYED_TO`（新增） | application_service → cluster/environment | `DEPLOYED_TO` | 无 | true | 0.7 | m2m |
| 负责人/团队 | `manage`（已有） | 人员/团队 → 资源 | `OWNED_BY` | `OWNED_BY` | false | 0 | m2m |

要点：

- 结构类继续沿用 CMDB 的“整体→部分”存储方向，用反向名称声明 `inverse_of`；不翻转边，不引入 many2one。
- `CALLS` 的方向是 caller→callee；故障沿 `dst_to_src` 从 callee 传回 caller。不要用 `CONNECTS_TO` 冒充调用。
- `DEPLOYED_TO` 表示应用服务与部署环境的关系，失败影响应用但不是实例级宿主关系；weight 低于 `RUNS_ON`。
- `PART_OF` 不传播，只用于业务影响上卷；AIOps 的影响面遍历必须显式排除结构边。

### 边属性

`c_ci_relations` 目前没有通用边属性列，CALLS 需要的 protocol、endpoint、method、sync、qps、latency、error_rate 无处存放。

**M0 决策（2026-11-09）：延到 M1。** M0 不新增列；CALLS 的 APM 证据先使用现有的 `evidence_source`/`evidence_*`/`confidence`/`observed_at`。M1 与 APM 接入一起增加可空 `props_json`（text，限 8 KiB，写入时校验 JSON），并在邻居/关系图 API 与 AIOps 工具中按需返回；边唯一键仍为 `(first_ci_id, second_ci_id, relation_type_id)`，同一对 caller/callee 只保留一条 `CALLS`，不同 endpoint 合并到属性中，避免重复影响边。

## 迁移阶段

| 阶段 | 动作 | 数据变更 | 门槛 | 回滚 |
|---|---|---|---|---|
| **M0 建模** | 创建三个类及属性；新增 `HAS_INSTANCE`、`DEPLOYED_TO` 词表；`CALLS` 已存在；按需加 `props_json`；AIOps 工具识别新类 | 只加模型/词表，不写实例/边 | 迁移幂等；旧页面/旧 API 不受影响；新类为空 | 停用新类；删除新增词表行；旧图不变 |
| **M1 分类** | 把现有 `service` 按业务/应用语义拆分，`application` → application_service，`app_instance` → service_instance；建立新旧 ID 映射 | 新增 CI 记录和映射；旧 CI 保留 | 分类覆盖率 100%；未分类项进 review；同一对象不重复 | 保留映射表，删除新 CI 即回旧图 |
| **M2 边重分类** | 176 条 `depend service→application` 逐条判定 `CONTAINS`/`CALLS`/`DEPENDS_ON`；3 条真实 `connect service→service` 按 APM 证据转 `CALLS`；`deploy`/`run` 关系落到 `RUNS_ON`；`manage` 保持 `inverse_of` | 新边写入，旧边保留只读 | 逐批 dry-run；100 条抽样；0 自环/孤儿；差异有解释 | 按批次删除新边，旧边未动 |
| **M3 对账** | 新旧图并行计算影响面；业务上卷覆盖率；调用链与人工答案对比 | 只读 | 未解释差异 0；业务上卷 100%；抽样正确 | 影子结果不影响生产 |
| **M4 下线** | 旧 `service`/`application`/`app_instance` 标记 deprecated，保留 alias；一个发布周期后删除 | 只改字典/只读 | 旧类只读；页面无引用；回滚演练通过 | 保留 alias 和映射表 |

### M1 分类规则（初稿）

1. 模型名精确匹配 `application` → `application_service`；`app_instance` → `service_instance`；`service` 按实例属性/关系判定：
   - 有下游 `app_instance` 或部署在集群/主机上的 → `application_service`；
   - 只作为业务汇总、没有运行时属性的 → `business_service`；
   - 两者都不满足 → review 队列，不自动写。
2. 标识优先用现有唯一属性（`code`/`name`/`uuid`），没有则生成稳定 code 并记录来源。
3. 每个新 CI 记录 `source_ci_id`/映射（放在映射表或属性里），保证可回滚、可重跑。
4. 外部服务（气象接口）由 `service_type=external` 标记，不自动猜测。

### M2 调用边来源

- APM/Trace/eBPF/Service Mesh 写入 `CALLS`，带 `evidence_source=collector:<name>`、`observed_at`、`confidence`；
- 没有 APM 证据的 `connect service→service` 保留 `CONNECTS_TO`，不要凭名称或端口推断 `CALLS`；
- 同一对 caller/callee 只保留一条 `CALLS`，不同 endpoint 合并到边属性；
- 业务服务之间的依赖用 `DEPENDS_ON`，不参与技术 RCA。

## AIOps 行为

- **影响面**：从失败的 ApplicationService 出发，沿 `CALLS`、`RUNS_ON`、`DEPLOYED_TO` 的上游（原因侧）或下游（影响侧）遍历；`only_propagating` 排除 `CONTAINS`/`HAS_INSTANCE`/ownership。
- **业务上卷**：受影响 ApplicationService 通过 `CONTAINS`（inverse `PART_OF`）找到 BusinessService；这一步不传播，只汇总。
- **实例下钻**：ApplicationService 通过 `HAS_INSTANCE`（inverse `INSTANCE_OF`）找到 ServiceInstance，再用 `RUNS_ON` 定位宿主。
- **FOC→气象**：`FOC运行控制服务 --CALLS--> 气象接口服务`；气象接口故障时，影响面沿 callee→caller 回到 FOC；`FOC运行控制` 是 BusinessService，通过 `CONTAINS` 汇总业务影响。
- **订单→会员**：`订单服务 --CALLS--> 会员服务`；会员服务 fan-in 高，影响面按 weight/置信度排序，避免只给一个平铺列表。

## 验收

- M0：三个类、两条新词表、迁移幂等；新类不影响旧页面；`cmdb_list_relation_types` 能看到 `HAS_INSTANCE`/`DEPLOYED_TO`。
- M1：分类覆盖率 100%，review 队列为空或全部有结论；映射可回放。
- M2：176 条 depend 边逐条有结论；3 条真实调用边有 APM 证据或明确保留 `CONNECTS_TO`；0 新自环/孤儿；100 条抽样方向正确。
- M3：新旧图影响面差异全部有解释；业务上卷覆盖率 100%。
- M4：旧类只读、页面无引用、回滚演练通过。

## 回滚

- 全程 additive：旧模型和旧边不改；新 CI/边可按批次删除。
- 映射表保留；停用新类即可回到旧图。
- `props_json` 是可空列，回滚代码后旧代码忽略它。

## 决策与剩余问题

M0 前已按推荐默认值确定：

1. **外部服务**：用 `application_service.service_type=external`，不单独建类。
2. **边属性**：延到 M1，与 APM 接入一起加 `props_json`；M0 用现有 evidence 字段。
3. **手工 CALLS**：允许，`evidence_source=manual`、confidence 低并在报告中标注；没有 APM 时不要声称是观测到的调用。
4. **分类责任人**：M1 设 review 队列，未分类项不自动写；业务/运维 owner 和 SLA 在 M1 启动前确定。
5. **ID 映射**：M1 使用独立映射表，不塞进 CI 属性，供 connector 和回滚使用。
6. **旧 `service` 模型**：M4 保留别名，一个发布周期后再删除。
7. **topocortex Contract/SLA**：不在 M0；在 M2 业务归属边之前确认 `UNDER_CONTRACT`/Contract 类映射。

仍待确认：

- M1 分类 owner 和 review SLA 的具体人选；
- APM/Trace/eBPF 数据源的接入顺序和覆盖范围；
- 是否需要把 `PUBLISHES_TO`/`SUBSCRIBES_TO` 纳入同一批词表（当前只做同步 `CALLS`）。

## 实施顺序建议

1. **M0（已实现）**：三个类、`HAS_INSTANCE`/`DEPLOYED_TO` 词表、`--ensure-builtin-models`/管理员 bootstrap、CALLS/HAS_INSTANCE/CONTAINS 声明；
2. M1：分类命令 + review 队列 + 独立 ID 映射表 + `props_json`；
3. M2：边重分类 + APM 接入；
4. M3/M4：对账、影子、下线。
