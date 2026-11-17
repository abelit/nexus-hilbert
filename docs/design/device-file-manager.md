# 设备文件管理

> 状态：已实现并部署；后端通道有集成测试，页面有前端用例。适用于 Windows 与 Linux Edge（需本分支版本的 worker）。

## 1. 能力范围

- **浏览**：任意绝对路径（Windows 盘符、Linux 挂载点），目录列表显示名称、类型、大小、修改时间、权限和符号链接标记。
- **下载**：单文件按原样流式返回；目录打包为 `tar.gz` 流式返回。
- **写入**：上传文件、上传文件夹（保留相对目录结构）、新建文件夹、重命名。
- **不包含**：删除、移动、复制、断点续传、批量权限修改（第一阶段）。
- 覆盖已存在文件需要二次确认；文件夹上传时确认一次后对该批次生效。

## 2. 权限与根目录

| 项目 | 规则 |
| --- | --- |
| 权限 | 新增 `device:files`，`exec` 授予 admin / user；viewer 只能读其他资源，不能进入文件管理 |
| 读取 | 任意绝对路径，便于排障与取日志 |
| 写入 | 仅限 Edge 传输沙箱 + Manager 配置的可写根 |
| 路径限制 | 必须是绝对路径；Windows 拒绝 UNC/设备路径；名称不能包含分隔符（新建/重命名） |
| 符号链接 | 写入前解析父目录的 symlink/junction，解析后必须仍在可写根内 |
| 审计 | 每次 list/upload/download/mkdir/rename 记录用户、设备、路径、大小、结果 |

### 2.1 可写根配置

可写根是 Manager 全局配置，所有设备共用。读取优先级：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 设置 → 全局配置 → 设备文件管理 | 持久化到 `system_settings` 的 `platform/device_file_write_roots`；保存空值表示只允许传输沙箱 |
| 2 | 环境变量 `ONGRID_DEVICE_FILE_ROOTS` | 仅在设置从未保存过时作为部署默认值 |

格式为逗号或换行分隔的设备端绝对路径，例如：

```yaml
ONGRID_DEVICE_FILE_ROOTS: "D:\\data,/srv/app"
```

Manager 不区分目标操作系统，会把整组路径下发给每个设备；Edge 按 `filepath.IsAbs` 过滤掉不属于本平台的条目，并在写入前解析 symlink/junction，最终校验必须落在可写根内。

未配置额外根时，只有 Edge 沙箱可写：

- Windows：`C:\ProgramData\ongrid-edge\transfer`
- Linux：`/var/lib/ongrid-edge/transfer`

### 2.2 上传大小限制

文件管理的单文件上传上限是 Manager 全局配置：

| 项目 | 规则 |
| --- | --- |
| 设置 | 设置 → 全局配置 → 上传大小限制，持久化到 `system_settings` 的 `platform/device_file_max_upload_mb` |
| 单位与范围 | MiB，1–8192；默认 8192（8 GiB） |
| 默认值 | 没有设置行时使用 8192 MiB；「恢复默认」删除该行 |
| 执行 | Manager 在打开流之前校验 `Content-Length`，超限返回 400；Edge 的 8 GiB `MaxUploadSize` 保持为硬上限 |
| 范围 | 只影响设备文件管理的单文件上传；RDP 文件面板（`/files`）不受影响 |

## 3. 链路

```text
浏览器 /devices/{id}/files
   │ HTTP（JWT + device:files）
   ▼
Manager  /v1/devices/{id}/fm/{roots,list,download,upload,mkdir,rename}
   │ OpenStream(edgeID)
   │ "ONGRID-FM {op,path,target,size,roots}\n"
   ▼
Edge streamrouter（按前导行分发）
   ▼
filemanager.HandleStream
   ▼
绝对路径读取 / 可写根内写入
```

- 响应行：`ONGRID-FM-RESP {ok,error,path,entries,roots,size,archive}\n`，`download`/`upload` 后紧跟原始字节。
- 目录下载由 Edge 边遍历边写入 `tar.gz`，Manager 直接转发，不在内存中缓冲整个目录。
- 单次上传上限默认 8 GiB，可在 Manager 设置中调整为 1 MiB–8 GiB；文件名和路径由 Manager 与 Edge 双侧校验。

## 4. 页面

入口：

- 设备列表 → 操作 → 文件管理
- 设备详情 → 命令/远程桌面区域 → 文件管理
- RDP 页面 → 文件面板 → 打开文件管理器

页面结构：

- 顶部：设备名、根目录选择、面包屑、上一级、上传文件、上传文件夹、新建文件夹、刷新
- 列表：文件夹优先排序；双击文件夹进入；行操作提供下载与重命名
- 当前目录不在可写根内时显示“只读目录”，写操作按钮置灰并给出原因
- 空目录、加载中、错误分别展示，不把失败渲染成空数据

## 5. 限制与后续

- 浏览器下载目录时会先落成 Blob，超大目录受浏览器内存限制；后续可改为一次性下载 URL + 短期票据。
- 尚无删除、移动、复制、断点续传和审批流；删除需要单独评审。
- 文件管理依赖本分支的 worker；旧版本 Edge 打开页面会看到通道错误，需要先升级整包。
- 大文件并发会占用隧道带宽，后续增加并发/速率限制。

## 6. 验证

- Edge `filemanager` 单测：列表/下载/目录归档、可写根限制、相对路径拒绝、根目录返回。
- Manager 集成测试：`/fm/*` 与真实 Edge 处理器的上传、列表、下载、目录归档、越权写入拒绝、mkdir/rename。
- 前端用例：列表与下载、新建文件夹、重命名、只读目录禁用写操作。
