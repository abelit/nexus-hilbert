# ADR-036：IPAM 模型、标识与计数语义

Status: Accepted — 2026-10-28

## 背景

CMDB 的 IPAM 页面在 `feat/cmdb-model-config-ux` 中按 nexus-cantor 的五个页签（总览、地址分配、IP 搜索、子网列表、历史）补齐。cantor 的 IPAM 不是独立服务：`ipam_scope`、`ipam_subnet`、`ipam_address` 是普通 CI 模型，父子关系走 `c_ci_relations`，扫描规则、扫描历史、操作历史各有一张专用表。hilbert 已有这套骨架，但内置模型、地址属性和写入路径存在偏差：

- 内置 spec 用 `scope_name`/`subnet_name`，控制台发送 `name`；用内置 spec 建出的部署无法创建节点。
- `ipam_address` 只声明了 `ip/assign_status/is_used`，cantor 的 `description/usage/use_obj/gateway/subnet_mask/mac_address` 没有落点。
- 子网更新按“唯一值”查找行，改名会新建一行并留下旧行。
- 地址写入的 HTTP handler 丢弃模型属性；同时传 `subnet_id` 与 `cidr` 时用调用方 CIDR 校验范围。
- 统计按 scope 查询恒为 0；scope 不能改名；扫码报告不写 `last_scan_time`、不按 `exec_id` 幂等。

## 决策

1. **名称契约统一为 `name`。** `ipam_scope`、`ipam_subnet` 的唯一键和展示属性都是 `name`；内置引导仍通过模型的唯一属性名写入，不硬编码 `scope_name`。
2. **地址标识保持 `ip`，不移植 `name = ip`。** cantor 的唯一键是自增 `ipam_address_id`，`ip` 和 `name` 都不唯一；hilbert 以模型内的 `ip` 为唯一键。地址表不显示 Name 列，IP 搜索的 Name 列只读；需要主机名时使用 `description` 或模型自定义属性。这是有意的收紧。
3. **地址模型补齐可编辑属性。** 内置 spec 增加 `name/description/usage/use_obj/gateway/subnet_mask/mac_address`；子网增加 cantor 的 `subnet_mask/gateway/operational_status/vlan_id/vrf/subnet_usage/comments/ip_range_start/ip_range_end`。`use_obj` 在新部署中是普通文本；已有部署若将其定义为 choice，前端按 `choice_value` 渲染下拉。写入层不新增通用 choice 校验（跨模块改造，超出 IPAM 范围）。
4. **更新按 id，rename 不创建新行。** `WriteSpec.ValidatingID` 在写入路径中直接定位该实例并应用值；新唯一值与另一行冲突时返回冲突。子网更新未传 `parent_id` 时，从实际包含边推导父节点再做范围校验。
5. **地址写入以存储的 CIDR 为准。** 传了 `subnet_id` 时，调用方 `cidr` 必须与存储值规范化后一致；范围、容量、历史都用存储值。网络地址和广播地址不作为可分配主机。
6. **地址属性透传。** `POST /v1/cmdb/ipam/addresses` 把 `ips/subnet_id/parent_id/cidr/assign_status/is_used` 之外的字段作为地址模型属性写入；模型未声明的键由 `normalizeValues` 丢弃。
7. **计数在写事务内重算。** 保留 hilbert 的 `claimed ∪ used` 语义，而不是 cantor 的 `used_count = len(reported ips)`。迁移数据的陈旧计数在首次写入时被修正；不提供自动回填任务。
8. **统计穿过 scope。** `IPAMSummary(parent_id)` 的遍历同时经过 scope→subnet、scope→scope 与 subnet→subnet 边，只汇总叶子子网；选择分组不再返回 0。
9. **扫码报告按 `exec_id` 幂等。** 保存 `start_at/end_at`、`ips`（对象或数组原样保存）、失败状态；回写规则的 `last_scan_time`；每个规则保留最近 100 条。扫描历史按 `cidr` 支持 `*term*` 通配。
10. **权限。** 前端按 `usePermissions().canMutate` 隐藏/禁用写操作；服务端 IPAM 路由保持“任意已认证用户”，与模块现状一致。新增 IPAM 细粒度权限属于单独的 authz 设计，不在本 ADR。
11. **不引入拖拽依赖。** 树内移动使用对话框；目标列表只列 scope 与非自身/非后代的 subnet，服务端继续按范围规则校验。
12. **地址列表分页读取。** 工作区以每页 500 读取已登记地址（上限 4096），与范围的主机窗口合并；超过窗口时页面明确提示，而不是把截断当作完整范围。

## 数据与兼容性

- 数据库仍由 GORM AutoMigrate 管理；本 ADR 不新增表，只增加属性绑定和列类型修正（`c_ipam_subnet_scan_histories.ips` 按原始 JSON 文本读取）。
- 已有 cantor 数据的 `ipam_address.name` 仍保留；hilbert 不写 `name = ip`，但读取不受影响。
- 新部署通过 `POST /v1/cmdb/ci-types/builtin-models` 创建 DCIM 与 IPAM 模型；该调用幂等、只增不改。已存在模型会补齐缺失的属性绑定，但不会修改唯一键或已有属性配置。
- 同一 `ip` 在 hilbert 中全局唯一（按模型）；cantor 允许跨子网重复。需要重叠地址空间时，应通过模型/命名空间设计解决，而不是恢复静默重复。

## 升级与回滚

- 升级：部署新的 `ongrid-cmdb` 与前端构建；调用内置引导补齐属性（可选，已有 cantor 模型通常已具备）。无需数据迁移。
- 回滚：恢复上一版 `ongrid-cmdb` 与前端。新增属性列/绑定对旧代码是附加项；旧代码忽略即可。`ips` 列的读取方式变更对旧代码无影响（旧代码仍按对象读取，数组行会失败——这是本次修复的缺陷，不是回滚目标）。
- 限制：不提供计数回填、扫描历史清理旧数据、或 cantor `ipam_address_id` 自增键的兼容路径。

## 后果

- 控制台、内置引导和 cantor 数据使用同一套名称与属性契约；改名、改范围、属性编辑和历史筛选可用。
- 地址唯一性和计数语义比 cantor 更严格；迁移数据中依赖重复 IP 或陈旧计数的流程需要单独处理。
- 服务端仍未校验 `use_obj` 的 choice 值；前端下拉把值约束在选项内，直接调用 API 的调用方可以写入任意字符串。
