# Edge 编译、打包与目录落盘指南

> 适用版本：`feat/windows-edge-installation`（v0.20.0 基线）。
> 本文覆盖 Linux / Windows 两端的编译、插件获取、发布附件生成，以及把产物放进 Manager `/opt/ongrid/edge`、开发 compose `bin/` 和节点离线 bundle 的具体命令。
> 产物来源与版本钉死以 `Makefile` 为准；组件来源与上游地址见第 9 节。

## 1. 软件包来源总览

| 软件包 | 来源 | 版本变量 |
| --- | --- | --- |
| `ongrid-edge`（Linux） | 本仓库源码构建 | `VERSION` |
| `ongrid-edge-supervisor/worker.exe`（Windows modern） | 本仓库源码构建 | `VERSION` |
| `ongrid-edge-supervisor/worker.exe`（Windows legacy） | 本仓库源码构建（Go 1.20.14 + 兼容层） | `VERSION` |
| `ongrid-edge-installer.exe` | 本仓库 `tools/windows-installer` 模块 | `VERSION` |
| `node_exporter` | 上游 GitHub Release | `NODE_EXPORTER_VERSION=1.8.2` |
| `process_exporter` | 上游 GitHub Release（仅 Linux） | `PROCESS_EXPORTER_VERSION=0.8.4` |
| `otelcol-contrib` | 上游 GitHub Release | `OTELCOL_VERSION=0.157.0` |
| `mysqld_exporter` | 上游 GitHub Release | `MYSQLD_EXPORTER_VERSION=0.19.0` |
| `postgres_exporter` | 上游 GitHub Release | `POSTGRES_EXPORTER_VERSION=0.19.1` |
| `redis_exporter` | 上游 GitHub Release | `REDIS_EXPORTER_VERSION=1.86.0` |
| `mongodb_exporter` | 上游 GitHub Release（仅 Linux） | `MONGODB_EXPORTER_VERSION=0.51.0` |
| `windows_exporter` | 上游 GitHub Release（仅 Windows） | `WINDOWS_EXPORTER_VERSION=0.29.2` |
| `obi` / `obi.NOTICES` | CNB 上的自建补丁版（`scripts/fetch-obi.sh`） | `OBI_VERSION=0.14.0-ongrid.5` |

插件全部是上游预编译二进制，本仓库只做下载与校验，不编译其源码。

## 2. 前置条件

| 工具 | 用途 |
| --- | --- |
| Go 1.25（go.mod 要求） | Linux、Windows modern、installer（legacy 会切换工具链） |
| Go 1.20.14（`GOTOOLCHAIN` 自动获取） | Windows legacy 产物、`tools/windows-installer` |
| `curl`、`tar`、`xz`、`sha256sum` | 下载、解包、压缩、校验 |
| `unzip` | `redis_exporter` 的 Windows zip |
| 网络 | 上游 GitHub；`obi` 与发布附件走 CNB |

版本来源：仓库根 `VERSION` 文件；Makefile 用 `-X main.version=$(VERSION)` 写入二进制。

## 3. Linux 编译

```bash
cd <repo>
make build-edge-linux-amd64    # bin/linux-amd64/ongrid-edge
make build-edge-linux-arm64    # bin/linux-arm64/ongrid-edge
```

等价命令（供自定义流水线参考）：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
  -o bin/linux-amd64/ongrid-edge ./cmd/ongrid-edge
```

Linux 是单进程 agent：没有 supervisor/worker 拆分，插件由 agent 作为子进程启动。

## 4. Windows 编译

```bash
# modern（Windows 10 / Server 2016+，PE 10.00）
make build-edge-windows-amd64
#   bin/windows-amd64/ongrid-edge-supervisor.exe
#   bin/windows-amd64/ongrid-edge-worker.exe

# legacy（Server 2008 R2 SP1，PE 6.01）
make build-edge-windows-legacy-amd64
#   bin/legacy-windows-amd64/ongrid-edge-supervisor.exe
#   bin/legacy-windows-amd64/ongrid-edge-worker.exe

# 安装器（独立 Go 1.20 模块）
make build-edge-windows-installer
#   bin/windows-amd64/ongrid-edge-installer.exe
```

legacy 构建不是普通交叉编译：`tools/build-legacy-windows.sh` 会复制源码树、挂载 `internal/compat/{slog,slices,maps,minmax,rand,clear}`、替换打过补丁的 `third_party/geminio`、裁剪依赖闭包，再用 `GOTOOLCHAIN=go1.20.14` 编译；Go 1.21+ 的产物无法在 2008 R2 加载。

## 5. 插件获取

### 5.1 Linux

```bash
# 一次拉取全部 Linux 插件（默认 EDGE_PLUGIN_ARCHES=linux-amd64）
make fetch-edge-plugins-linux

# 双架构
make fetch-edge-plugins-linux EDGE_PLUGIN_ARCHES="linux-amd64 linux-arm64"
```

等价于依次执行 `fetch-obi`、`fetch-otelcol`、`fetch-node-exporter`、`fetch-process-exporter`、`fetch-db-exporters`。

输出：`bin/<target>/<component>`（如 `bin/linux-amd64/node_exporter`）。目标已存在时跳过，可提前把内网镜像文件放进 `bin/` 实现离线获取。

### 5.2 Windows

```bash
make fetch-edge-plugins-windows
# 等价于 fetch-windows-exporter + fetch-otelcol-windows + fetch-db-exporters-windows
```

输出：`bin/windows-amd64/<plugin>.exe`。

### 5.3 平台差异

| 组件 | Linux | Windows | 原因 |
| --- | --- | --- | --- |
| `node_exporter` | ✅ | ❌ | Windows 使用 windows_exporter |
| `process_exporter` | ✅ | ❌ | `procmetrics` 在 Windows 未注册，进程指标由 windows_exporter process collector 提供 |
| `windows_exporter` | ❌ | ✅ | 仅 Windows |
| `mongodb_exporter` | ✅ | ❌ | 上游无 Windows amd64 资产 |
| `obi` | ✅ | ❌ | eBPF，仅 Linux |

## 6. 打包到指定目录

### 6.1 发布附件（CNB Release）

**发布到哪里：** CNB 仓库 `ongridio/ongrid-edge` 的 Release（不是 GitHub Release，也不是 Manager 本地目录）。

| 项 | 值 |
| --- | --- |
| 仓库 | `CNB_REPO_SLUG`，默认 `ongridio/ongrid-edge` |
| Release 页面 | `https://cnb.cool/ongridio/ongrid-edge/-/releases` |
| 下载基址 | `CNB_RELEASE_BASE_URL`，默认 `https://cnb.cool/ongridio/ongrid-edge/-/releases/download` |
| 版本化 Release tag | `VERSION`（如 `v0.20.0`） |
| 依赖 Release tag | `EDGE_DEPS_TAG`（不可变，由各上游版本拼成） |
| 资产 URL | `<下载基址>/<tag>/<asset>`，每个资产都有同名 `.sha256` |

发布所需环境变量：

- `CNB_TOKEN`：创建 Release 需要 repo-release 读/写权限；上传附件需要 repo-contents 读/写权限；
- 可选 `CNB_API_ENDPOINT`（默认 `https://api.cnb.cool`）、`CNB_WEB_ENDPOINT`（默认 `https://cnb.cool`）、`CNB_RELEASE_TARGET_COMMITISH`。

```bash
export CNB_TOKEN=...
make build-edge-version-attachments     # 版本化附件 + .sha256
make build-edge-deps-attachments        # Linux 依赖归档 edge-deps-<target>.tar.xz + .sha256
make build-edge-attachments             # 以上两类

make publish-edge-deps-attachments      # 幂等：依赖 Release 已完整则跳过，否则创建/复用并上传
make publish-edge-version-attachments   # 先校验依赖 Release，再创建 VERSION Release 并上传
# 或一次执行：make publish-edge-attachments
```

发布实现：

- `scripts/ensure-cnb-release.sh` 创建或复用目标 tag 的 Release；
- `scripts/publish-cnb-release-attachments.sh` 通过固定 sha256 digest 的 CNB attachments 镜像上传，已存在的资产先做校验再跳过；
- 不可变 Release 不支持“部分补齐后原地追加”；若某个 tag 在 Windows 制品加入前已发布且缺文件，必须重新切版本/tag。

Manager 端消费同一批文件：`fetch-edge-assets.sh` 的 `ONGRID_EDGE_ARTIFACT_BASE_URL` 默认就是上面的下载基址；内网镜像只要保持相同布局即可替换。

验证：

```bash
make verify-edge-deps-release
make verify-edge-version-release
curl -sSI https://cnb.cool/ongridio/ongrid-edge/-/releases/download/v0.20.0/ongrid-edge-linux-amd64-v0.20.0 | head -1
```

命名规则见 `EDGE_VERSION_ATTACHMENT_NAMES`：

- Linux 主程序：`ongrid-edge-linux-amd64-<VERSION>`
- Windows modern：`ongrid-edge-windows-amd64-<VERSION>-{supervisor,worker,installer}.exe` 及 `-<plugin>.exe`
- Windows legacy：`ongrid-edge-legacy-windows-amd64-<VERSION>-{supervisor,worker}.exe`
- Linux 依赖：`edge-deps-linux-<arch>.tar.xz`，挂在不可变 `EDGE_DEPS_TAG` 下（由各上游版本拼成）

#### 改用本地 / 自建发布源

可以。发布源是**数据**，不是编译期常量：只要保持 `<base>/<tag>/<asset>` + `<asset>.sha256` 的布局，Manager 就能从任意 HTTP(S) 服务器取件。

**1. 布局要求**

```
<base>/
├── <VERSION>/                      # 版本化附件
│   ├── ongrid-edge-linux-amd64-v0.20.0
│   ├── ongrid-edge-linux-amd64-v0.20.0.sha256
│   ├── ongrid-edge-windows-amd64-v0.20.0-supervisor.exe(+.sha256)
│   └── ...
└── <EDGE_DEPS_TAG>/                # 不可变依赖归档
    ├── edge-deps-linux-amd64.tar.xz
    └── edge-deps-linux-amd64.tar.xz.sha256
```

`.sha256` 必须是 `hash  filename` 格式（`sha256sum` 输出），缺一个文件校验就会失败。

**2. 把附件放到自建服务器**

```bash
VERSION=$(cat VERSION)
DEPS_TAG=$(make --no-print-directory edge-deps-tag)
OUT=dist/edge-attachments      # 即 Makefile 的 EDGE_ATTACHMENTS_OUT

# 版本化附件 → <base>/<VERSION>/
rsync -a --include='ongrid-edge-*' --exclude='*' \
  "$OUT/" "mirror:/srv/ongrid-edge-releases/$VERSION/"

# 依赖归档 → <base>/<EDGE_DEPS_TAG>/
rsync -a --include='edge-deps-*' --exclude='*' \
  "$OUT/" "mirror:/srv/ongrid-edge-releases/$DEPS_TAG/"
```

用 nginx 暴露（只读、目录可浏览或直接按文件名访问均可）：

```nginx
location /ongrid-edge-releases/ {
    alias /srv/ongrid-edge-releases/;
    autoindex off;
}
```

**3. Manager 取件改指向自建源**

```bash
ONGRID_EDGE_ARTIFACT_BASE_URL=https://mirror.example.com/ongrid-edge-releases \
ONGRID_EDGE_DEPS_TAG=$(make --no-print-directory edge-deps-tag) \
  deploy/install/edge/fetch-edge-assets.sh /opt/ongrid/edge "$(cat VERSION)" \
  linux-amd64 linux-arm64 windows-amd64
```

`fetch-edge-assets.sh` 不强制 https，内网可用 `http://`；但**节点侧 `install.sh` 仍然只拼 `https://`**，所以节点访问的 Manager `/edge/` 必须是 HTTPS。

**4. 校验也指向自建源**

```bash
make verify-edge-version-release \
  CNB_RELEASE_BASE_URL=https://mirror.example.com/ongrid-edge-releases
make verify-edge-deps-release \
  CNB_RELEASE_BASE_URL=https://mirror.example.com/ongrid-edge-releases
```

`verify-cnb-release-attachments.sh` 只依赖 base URL + tag + 文件名，不调用 CNB API。

**5. 不使用任何发布服务器**

把文件与 `.sha256` 直接预置到下载缓存，`fetch-edge-assets.sh` 会命中缓存、完全不联网：

```
/var/cache/ongrid/edge-artifacts/<tag>/<asset>(+ .sha256)
```

也可用 `ONGRID_EDGE_ARTIFACT_CACHE_DIR` 指向自定义缓存目录。

**注意**

- `make publish-*`、`ensure-cnb-release.sh`、`publish-cnb-release-attachments.sh` 是 CNB 专用，自建源不需要它们；不可变性和访问控制由自建服务器负责。
- 自建源同样要保证 tag 的不可变性：依赖归档 `EDGE_DEPS_TAG` 一旦发布不要覆盖，版本升级请换新 tag。
- Windows 安装器从 Manager 的 `/edge/windows/` 下载，与发布源无关；只要 Manager 的 `windows/` 目录完整即可。

### 6.2 Manager 目录 `/opt/ongrid/edge`（推荐走 install/upgrade）

`deploy/install/install.sh` 与 `deploy/install/upgrade.sh` 会调用 `fetch-edge-assets.sh` 下载校验、生成 bundle、保留 Windows 目录，并**原子替换** `/opt/ongrid/edge`。

手工分步（排障或自定义镜像）：

```bash
cd <repo>
VERSION=$(cat VERSION)
DEPS_TAG=$(make --no-print-directory edge-deps-tag)
STAGE=$(mktemp -d /opt/ongrid/.edge-stage.XXXXXX)

# 1) Linux 主程序 + 9 个插件 + ref（校验 sha256）
#    若 Windows 版本化附件已发布，在末尾追加 windows-amd64 即可一次拉取两端，
#    第 4 步的本地 Windows 载荷可省略：
#      ... fetch-edge-assets.sh "$STAGE" "$VERSION" linux-amd64 linux-arm64 windows-amd64
ONGRID_EDGE_DEPS_TAG=$DEPS_TAG \
  deploy/install/edge/fetch-edge-assets.sh "$STAGE" "$VERSION" linux-amd64 linux-arm64

# 2) 安装/升级脚本
cp deploy/install/edge/{install.sh,uninstall.sh,install-edge.sh,build-edge-bundle.sh,fetch-edge-assets.sh,edge-assets-lib.sh,verify-edge-deps-archive.sh,ongrid-edge.env.example,ongrid-edge.service,ongrid-edge-upgrade.service} "$STAGE"/
cp deploy/install/apply-pending-upgrade.sh "$STAGE"/
cp dist/build-windows-manifest.sh "$STAGE"/
chmod 755 "$STAGE"/*.sh

# 3) Linux 升级 bundle
for t in linux-amd64 linux-arm64; do
  bash deploy/install/edge/build-edge-bundle.sh "$STAGE" "$VERSION" "$t"
done

# 4) Windows 扁平载荷（本仓库构建；第 1 步已带 windows-amd64 时跳过）
mkdir -p "$STAGE/windows"
install -m0755 bin/windows-amd64/ongrid-edge-supervisor.exe "$STAGE/windows/ongrid-edge-supervisor-windows-amd64.exe"
install -m0755 bin/windows-amd64/ongrid-edge-worker.exe     "$STAGE/windows/ongrid-edge-worker-windows-amd64.exe"
install -m0755 bin/windows-amd64/ongrid-edge-installer.exe  "$STAGE/windows/ongrid-edge-installer.exe"
install -m0755 bin/legacy-windows-amd64/ongrid-edge-supervisor.exe "$STAGE/windows/ongrid-edge-supervisor-legacy-windows-amd64.exe"
install -m0755 bin/legacy-windows-amd64/ongrid-edge-worker.exe     "$STAGE/windows/ongrid-edge-worker-legacy-windows-amd64.exe"
for p in windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter; do
  [[ -f "bin/windows-amd64/$p.exe" ]] || continue
  install -m0755 "bin/windows-amd64/$p.exe" "$STAGE/windows/$p-windows-amd64.exe"
done
bash dist/build-windows-manifest.sh "$STAGE/windows" "$VERSION"

# 5) 元数据
cat > "$STAGE/edge-artifacts.env" <<EOF
ONGRID_EDGE_DEPS_TAG=$DEPS_TAG
ONGRID_EDGE_TARGETS=linux-amd64 linux-arm64
ONGRID_WINDOWS_EDGE_TARGETS=windows-amd64
EOF
chmod 0644 "$STAGE/edge-artifacts.env"

# 6) 原子替换
sudo mv /opt/ongrid/edge /opt/ongrid/edge.bak.$(date +%s)
sudo mv "$STAGE" /opt/ongrid/edge
```

注意：`fetch-edge-assets.sh` 下载缓存默认在 `/var/cache/ongrid/edge-artifacts`（root 所有）。普通用户运行会因写缓存失败而中止，可用 `ONGRID_EDGE_ARTIFACT_CACHE_DIR=/tmp/ongrid-edge-cache`。

### 6.3 开发 compose（仓库 `bin/` 即 `/edge`）

`deploy/docker-compose.yml` 把 `../bin` 只读挂载到 nginx 的 `/usr/share/nginx/html/edge`，所以放进 `bin/` 即对外生效。Linux 与 Windows 都支持“本地构建后拷贝”，也支持直接从 CNB 拉取，按环境选择。

#### 方式 A：从 CNB 拉取（附件已发布）

```bash
VERSION=$(cat VERSION)
DEPS_TAG=$(make --no-print-directory edge-deps-tag)

ONGRID_EDGE_DEPS_TAG=$DEPS_TAG \
  deploy/install/edge/fetch-edge-assets.sh bin "$VERSION" \
  linux-amd64 linux-arm64 windows-amd64
```

写入与 Manager 相同的布局：

```
bin/ongrid-edge-linux-<arch>
bin/<component>-linux-<arch>
bin/windows/ongrid-edge-*-windows-amd64.exe
bin/windows/manifest.json
```

#### 方式 B：全部本地构建 / 预置后拷贝

Linux：

```bash
VERSION=$(cat VERSION)

# 1) 主程序
make build-edge-linux-amd64 build-edge-linux-arm64

# 2) 插件（GitHub 可达时；否则把文件预置到 bin/linux-<arch>/）
make fetch-edge-plugins-linux EDGE_PLUGIN_ARCHES="linux-amd64 linux-arm64"

# 3) 按发布命名填入 bin/
for arch in amd64 arm64; do
  cp -f "bin/linux-$arch/ongrid-edge" "bin/ongrid-edge-linux-$arch"
  for c in node_exporter process_exporter otelcol-contrib mysqld_exporter \
           postgres_exporter redis_exporter mongodb_exporter obi obi.NOTICES; do
    if [[ -f "bin/linux-$arch/$c" ]]; then
      cp -f "bin/linux-$arch/$c" "bin/$c-linux-$arch"
    fi
  done
done

# 4) 节点安装脚本
cp -f deploy/install/edge/{install.sh,uninstall.sh,install-edge.sh,ongrid-edge.env.example,ongrid-edge.service,ongrid-edge-upgrade.service} bin/
cp -f deploy/install/apply-pending-upgrade.sh bin/
chmod 755 bin/*.sh

# 5) 可选：生成 Linux 升级 bundle
for arch in amd64 arm64; do
  bash deploy/install/edge/build-edge-bundle.sh bin "$VERSION" "linux-$arch"
done
```

Windows：

```bash
# 1) 构建
make build-edge-windows-amd64 build-edge-windows-legacy-amd64 build-edge-windows-installer
make fetch-edge-plugins-windows    # 插件不可得时跳过，先补齐 bin/windows-amd64/*.exe

# 2) 扁平命名
mkdir -p bin/windows
cp -f bin/windows-amd64/ongrid-edge-supervisor.exe bin/windows/ongrid-edge-supervisor-windows-amd64.exe
cp -f bin/windows-amd64/ongrid-edge-worker.exe     bin/windows/ongrid-edge-worker-windows-amd64.exe
cp -f bin/windows-amd64/ongrid-edge-installer.exe  bin/windows/ongrid-edge-installer.exe
cp -f bin/legacy-windows-amd64/ongrid-edge-supervisor.exe bin/windows/ongrid-edge-supervisor-legacy-windows-amd64.exe
cp -f bin/legacy-windows-amd64/ongrid-edge-worker.exe     bin/windows/ongrid-edge-worker-legacy-windows-amd64.exe
for p in windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter; do
  if [[ -f "bin/windows-amd64/$p.exe" ]]; then
    cp -f "bin/windows-amd64/$p.exe" "bin/windows/$p-windows-amd64.exe"
  fi
done

# 3) manifest
bash dist/build-windows-manifest.sh bin/windows "$VERSION"
```

`build-windows-manifest.sh` 要求 5 个插件齐全；插件未就绪时它会失败，需先补齐文件，或临时使用仅含 supervisor/worker 的最小 manifest。

#### 方式 C：混合（当前分支状态）

Windows v0.20.0 附件尚未发布（`windows-amd64` 会 404），Linux 仍可从 CNB 拉取，Windows 用本地构建的 staging 目录拷入：

```bash
VERSION=$(cat VERSION)
DEPS_TAG=$(make --no-print-directory edge-deps-tag)

ONGRID_EDGE_DEPS_TAG=$DEPS_TAG \
  deploy/install/edge/fetch-edge-assets.sh bin "$VERSION" linux-amd64 linux-arm64

# STAGE 是 6.2 第 1 步创建的暂存目录；本次实际使用
# /tmp/ongrid-edge-stage-v0.20.0
STAGE=/tmp/ongrid-edge-stage-v0.20.0
rsync -a --delete "$STAGE/windows/" bin/windows/
```

等 Windows 附件发布后，删除第二段，统一回到方式 A。

### 6.4 节点离线 bundle

```bash
bash deploy/install/edge/build-edge-bundle.sh <dir> "$VERSION" linux-amd64
# 生成 edge-bundle-linux-amd64-<VERSION>.tar.gz + .sha256
```

把 bundle 和 `install-edge.sh` 拷到目标机，解压后 `sudo ./install-edge.sh`；它会从同目录读取 `ongrid-edge-<os>-<arch>`、`<component>-<os>-<arch>`。

### 6.5 `install.sh` 一行命令解析

以这条命令为例：

```bash
curl -k -sSL https://localhost/install.sh | bash -s -- \
  --access-key=<ACCESS_KEY> \
  --secret-key=<SECRET_KEY> \
  --server-edge-addr=localhost:40012 \
  --server-http-addr=localhost
```

#### 命令结构

| 片段 | 含义 |
| --- | --- |
| `curl -k` | 跳过 TLS 证书校验（自签证书场景） |
| `-sS` | 静默进度，但保留错误输出 |
| `-L` | 跟随 30x 重定向 |
| `https://<manager>/install.sh` | 由 Manager nginx 的 `location = /install.sh` 直接别名到 `<edge 目录>/install.sh`，公开、无鉴权、`no-store` |
| `\| bash -s` | `bash` 从标准输入读取脚本；`-s` 表示脚本来自 stdin |
| `--` | 结束 bash 自身参数，后面的内容原样成为脚本的 `$1..$n` |
| `--access-key/--secret-key` | 单设备凭据，二者必须同时提供；不能与 `--enrollment-token` 混用 |
| `--server-edge-addr` | Frontier 隧道地址，写入 `ONGRID_EDGE_CLOUD_ADDR`，端口通常是 `40012` |
| `--server-http-addr` | Manager 前端地址，脚本用它拼 `https://<addr>/edge/...` 下载制品；协议固定为 https |

#### 脚本执行步骤

1. **提权**：非 root 时用 `sudo -E` 重新执行（保留环境变量）。
2. **参数校验**：必须有 access+secret 或 enrollment token；两个地址必填。
3. **识别平台**：`uname`，只支持 `linux/amd64`、`linux/arm64`。
4. **下载主程序**：`https://<server-http-addr>/edge/ongrid-edge-linux-<arch>` 到临时文件，校验非空；失败即退出。
5. **（token 模式才执行）enrollment**：用刚下载的二进制执行 `ongrid-edge enroll`，换取每台设备独立凭据并写入临时 env；随后卸载 token。
6. **停止旧服务**：如果 `ongrid-edge` 正在运行，先 `systemctl stop`，保证替换确定性。
7. **安装主程序**：`install -m 0755 -o root -g root` 到 `/usr/local/bin/ongrid-edge`。
8. **安装升级钩子**：下载 `/edge/apply-pending-upgrade.sh` 到 `/usr/local/lib/ongrid-edge/`；失败只告警（远程整包升级不可用）。
9. **下载插件**（逐个 best-effort）：`obi`、`obi.NOTICES`、`node_exporter`、`process_exporter`、`otelcol-contrib`、`mysqld_exporter`、`postgres_exporter`、`redis_exporter`、`mongodb_exporter`，落盘到 `/usr/local/lib/ongrid-edge/<name>`；某个失败只影响对应插件。
10. **建目录**：`/var/log/ongrid-edge`（0750）、`/etc/ongrid-edge`（0750）、`/var/lib/ongrid-edge`（0755），均为 root:root。
11. **写环境变量**：`/etc/ongrid-edge/ongrid-edge.env`（0640 root:root），内容为
    `ONGRID_EDGE_CLOUD_ADDR`、`ONGRID_EDGE_ACCESS_KEY`、`ONGRID_EDGE_SECRET_KEY`（以及可选的 metrics 地址）。
12. **写 systemd 单元**：
    - `ongrid-edge-upgrade.service`：oneshot，`Before=ongrid-edge.service`，负责启动前应用升级包；
    - `ongrid-edge.service`：`EnvironmentFile=`、`ExecStart=/usr/local/bin/ongrid-edge`、`Restart=always`、`StateDirectory=ongrid-edge`、日志进 journald。
13. **启动**：`daemon-reload` → `enable` → `restart`。
14. **后置验证**：轮询 journal 最多 20 秒（`ONGRID_INSTALL_WAIT` 可调），等待 `registered with cloud`；若服务未激活或出现 `unauthorized` 则报告失败。

#### 落盘结果

| 内容 | 路径 |
| --- | --- |
| 主程序 | `/usr/local/bin/ongrid-edge` |
| 插件与升级钩子 | `/usr/local/lib/ongrid-edge/` |
| 凭据/配置 | `/etc/ongrid-edge/ongrid-edge.env`（明文，0640） |
| 状态与升级暂存 | `/var/lib/ongrid-edge/` |
| 日志 | journald + `/var/log/ongrid-edge/` |
| 服务 | `/etc/systemd/system/ongrid-edge{,-upgrade}.service` |

#### 注意事项

- **`localhost` 只适用于在 Manager 主机本机安装**。装到其他机器时，`--server-http-addr` 必须是可以访问 Manager 的地址，否则第 4 步下载会失败；`--server-edge-addr` 同理应指向 Frontier 的可达地址。
- **凭据以 argv 传入**：运行期间会出现在 shell history 和进程列表中；批量场景优先用 `--enrollment-token`。
- **`-k` 关闭证书校验**：生产环境应换成受信任证书并去掉 `-k` 与 `--tls-insecure`。
- **幂等**：重复执行会覆盖 env、重启服务；已运行的主机会先停服务再替换二进制。
- **插件是 best-effort**：安装成功不代表所有插件可用，需检查 `/usr/local/lib/ongrid-edge/` 是否齐全，或看 install.sh 输出的 `plugin binary MISSING`。
- **HTML 404 的典型症状**：如果 `/install.sh` 路由失效（如 nginx bind mount 失效），`curl | bash` 会尝试执行 HTML，报 `html: No such file or directory` / `syntax error near '<'`。先 `curl -kI` 确认返回 200 再执行。

### 6.6 Windows 一行安装（PowerShell）解析

页面生成的就是下面这一形态（地址取自当前浏览器或“Edge 安装地址”设置）：

```powershell
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
try { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } } catch {}
$u='https://<manager>/edge/windows/ongrid-edge-installer.exe'
$f="$env:TEMP\ongrid-edge-installer.exe"
(New-Object Net.WebClient).DownloadFile($u,$f)
$a=@('--manager-url','https://<manager>','--access-key','<ACCESS_KEY>','--secret-key','<SECRET_KEY>','--server-edge-addr','<manager>:40012','--tls-insecure')
& $f @a
```

两行 `try/catch` 处理自签证书：PowerShell 5.1+ 会关闭校验；PowerShell 2.0（Server 2008 R2）没有该回调属性，`catch` 会吞掉错误，此时必须先把 Manager 证书导入受信任存储。

#### 逐行说明

| 语句 | 作用 |
| --- | --- |
| `$u='https://<manager>/edge/windows/ongrid-edge-installer.exe'` | 安装器地址；对应 Manager 的 `/edge/windows/` 只读路由，扁平目录，无鉴权 |
| `$f="$env:TEMP\ongrid-edge-installer.exe"` | 下载到当前用户临时目录 |
| `(New-Object Net.WebClient).DownloadFile($u,$f)` | 同步下载；**PowerShell 2.0 兼容**（Server 2008 R2 默认只有 PS 2.0，没有 `Invoke-WebRequest`） |
| `& $f @a` | 以调用运算符执行安装器；参数放在 `$a` 数组里，避免 `--` 被解析成运算符 |
| `--manager-url https://<manager>` | 安装器用它拉 `manifest.json`、各制品，以及 token 模式下的 enrollment |
| `--access-key/--secret-key` | 单设备凭据；必须成对，不能与 `--enrollment-token` 混用 |
| `--server-edge-addr <host>:40012` | Frontier 隧道地址，写入服务的 `ONGRID_EDGE_CLOUD_ADDR` |
| 未传 `--variant` | 默认 `auto`：`10.0 build >= 14393` → `windows-amd64`，`6.1 build >= 7601` → `legacy-windows-amd64` |

#### 安装器执行步骤

1. **解析并校验参数**：`--manager-url` 与 `--server-edge-addr` 必填；URL 只允许 http（仅回环）/https。
2. **拉取清单**：`GET <manager-url>/edge/windows/manifest.json`。
3. **选择变体**：按 `RtlGetVersion` 得到的 NT 版本，或显式 `--variant modern|legacy`。
4. **校验并下载**：按 manifest 的 `path` 逐个下载到 `C:\ProgramData\ongrid-edge\download-*`，逐个校验 SHA-256（失败即删除并中止）。
5. **加固目录**：安装根、插件目录、数据目录、升级暂存目录先收紧 ACL（SYSTEM + Administrators，禁止继承），再落文件。
6. **准备凭据**：无 token 时直接用 CLI 凭据；有 token 时先调 `/internal/edge/enroll` 换取每设备凭据。
7. **停止旧服务**：重装时先停 `ongrid-edge`，避免文件锁。
8. **落盘**：按 manifest 的 `dest` + `install_as` 写入 `bin\`、`plugins\`（例如 `ongrid-edge-supervisor-windows-amd64.exe` → `bin\ongrid-edge-supervisor.exe`）。
9. **调用 supervisor**：把凭据写入 ACL 受限的临时 JSON，执行 `supervisor.exe --install --config-file <json>`。
10. **服务安装**：supervisor 用 DPAPI 加密 secret 到 `secrets.enc`，`sc.exe create` 服务（LocalSystem、auto），写环境变量、配置恢复策略与 Defender 排除，启动服务。
11. **删除临时配置**：含明文 secret 的 JSON 在成功或失败后都会删除。
12. **等待就绪**：轮询 `C:\ProgramData\ongrid-edge\health.json`，超时或失败返回非零退出码。

#### 落盘结果

| 内容 | 路径 |
| --- | --- |
| 主程序 | `C:\Program Files\ongrid-edge\bin\` |
| 插件 | `C:\Program Files\ongrid-edge\plugins\` |
| 凭据 | `C:\ProgramData\ongrid-edge\secrets.enc`（DPAPI）+ 服务 `Environment` |
| 状态/日志 | `C:\ProgramData\ongrid-edge\{health.json,supervisor.log,worker-*.log,upgrade\}` |
| 服务 | `ongrid-edge`（LocalSystem，auto start） |

#### PowerShell 参数解析注意

`& $f --manager-url ...` 在部分 PowerShell / ISE 会话里会把 `--` 当成运算符，报 `Unexpected token '--manager-url' in expression or statement`。改用参数数组 splatting 可稳定传递：

```powershell
$installArgs = @(
  '--manager-url', 'https://<manager>',
  '--access-key', '<ACCESS_KEY>',
  '--secret-key', '<SECRET_KEY>',
  '--server-edge-addr', '<manager>:40012',
  '--tls-insecure'
)
& $f @installArgs
```

#### 注意事项

- **必须以管理员身份运行 PowerShell**：安装器要写 Program Files、操作 SCM；没有提权预检，权限不足会在落盘/`sc.exe` 阶段失败。
- **`localhost` 只适用于 Manager 本机安装**；装到其他 Windows 主机时改成 Manager 的可达地址。
- **自签证书是最大坑**：`WebClient` 下载发生在 `--tls-insecure` 生效之前，因此该参数**救不了下载阶段**。自签 Manager 需要把证书导入目标机受信任存储，或先设置 TLS 1.2 并信任证书；否则会报 `Could not create SSL/TLS secure channel`。
- **2008 R2 额外前置**：启用 TLS 1.2（`[Net.ServicePointManager]::SecurityProtocol` 或注册表/Schannel 配置），并安装 SHA-2 代码签名支持补丁（KB3033929）；PowerShell 2.0 下只能用 `Net.WebClient`。
- **重装前先停服务**：Windows 会锁住正在运行的 exe；脚本本身会停服务，但如果 worker 残留，需要先 `taskkill /IM ongrid-edge-worker.exe /F`。
- **凭据以命令行参数传入**：会进入 PowerShell 历史；批量场景优先 `--enrollment-token`。
- **常见错误**：`manifest.json` 404（Windows 附件未发布或目录为空）、`verify dir ... (unrestricted access)`（ACL 校验失败）、`CryptUnprotectData` 失败（DPAPI 加密作用域/身份问题）、`sc.exe create` 1073（服务已存在）。

## 7. 目录布局

### 7.1 Manager `/opt/ongrid/edge`

```
edge/
├── install.sh  uninstall.sh  install-edge.sh  apply-pending-upgrade.sh
├── build-edge-bundle.sh  fetch-edge-assets.sh  edge-assets-lib.sh
├── ongrid-edge.env.example  ongrid-edge.service  ongrid-edge-upgrade.service
├── edge-artifacts.env
├── edge-assets-linux-<arch>.ref
├── ongrid-edge-linux-<arch>
├── <component>-linux-<arch>        # node/process/otelcol/mysqld/postgres/redis/mongodb/obi
├── edge-bundle-linux-<arch>-<VERSION>.tar.gz(+.sha256)
└── windows/                        # 扁平命名，与 Linux 一致
    ├── ongrid-edge-installer.exe
    ├── manifest.json
    ├── ongrid-edge-supervisor-windows-amd64.exe
    ├── ongrid-edge-worker-windows-amd64.exe
    ├── ongrid-edge-supervisor-legacy-windows-amd64.exe
    ├── ongrid-edge-worker-legacy-windows-amd64.exe
    └── <plugin>-windows-amd64.exe
```

`manifest.json` 的每个条目用 `path` 下载、用 `install_as` 落盘（`bin/ongrid-edge-supervisor.exe`、`plugins/windows_exporter.exe` 等）；插件文件由 modern 与 legacy 两个变体共用。

### 7.2 节点安装位置

| 平台 | 主程序 | 插件 | 配置/凭据 | 状态/日志 |
| --- | --- | --- | --- | --- |
| Linux | `/usr/local/bin/ongrid-edge` | `/usr/local/lib/ongrid-edge/` | `/etc/ongrid-edge/` | `/var/lib/ongrid-edge/`、`/var/log/ongrid-edge/` |
| Windows | `C:\Program Files\ongrid-edge\bin\` | `C:\Program Files\ongrid-edge\plugins\` | `C:\ProgramData\ongrid-edge\secrets.enc` | `C:\ProgramData\ongrid-edge\` |

## 8. 校验清单

```bash
# 发布附件 sidecar（dist/build-edge-attachments.sh 生成 hash  file 格式）
sha256sum -c ongrid-edge-linux-amd64-v0.20.0.sha256

# bundle sidecar 是纯 hash，需要手动比对
want=$(cat edge-bundle-linux-amd64-v0.20.0.tar.gz.sha256)
got=$(sha256sum edge-bundle-linux-amd64-v0.20.0.tar.gz | awk '{print $1}')
[[ "$want" == "$got" ]] && echo OK

# manifest 哈希
python3 - <<'EOF'
import hashlib, json, os
base = "/opt/ongrid/edge/windows"
m = json.load(open(os.path.join(base, "manifest.json")))
for v in m["variants"]:
    for f in v["files"]:
        p = os.path.join(base, f["path"])
        assert hashlib.sha256(open(p, "rb").read()).hexdigest() == f["sha256"], p
print("manifest hashes OK")
EOF

# 对外 URL
curl -kI https://<manager>/edge/install.sh
curl -kI https://<manager>/edge/ongrid-edge-linux-amd64
curl -k  https://<manager>/edge/windows/manifest.json
```

## 9. 上游地址索引

固定版本变量见 `Makefile` 顶部；把 `<VERSION>` 替换为变量值。

### Linux 插件

| 组件 | 上游地址 |
| --- | --- |
| node_exporter | `https://github.com/prometheus/node_exporter/releases/download/v1.8.2/node_exporter-1.8.2.linux-<arch>.tar.gz` |
| process_exporter | `https://github.com/ncabatoff/process-exporter/releases/download/v0.8.4/process-exporter-0.8.4.linux-<arch>.tar.gz` |
| otelcol-contrib | `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.157.0/otelcol-contrib_0.157.0_linux_<arch>.tar.gz`<br>校验：`.../opentelemetry-collector-releases_otelcol-contrib_checksums.txt` |
| mysqld_exporter | `https://github.com/prometheus/mysqld_exporter/releases/download/v0.19.0/mysqld_exporter-0.19.0.linux-<arch>.tar.gz` |
| postgres_exporter | `https://github.com/prometheus-community/postgres_exporter/releases/download/v0.19.1/postgres_exporter-0.19.1.linux-<arch>.tar.gz` |
| redis_exporter | `https://github.com/oliver006/redis_exporter/releases/download/v1.86.0/redis_exporter-v1.86.0.linux-<arch>.tar.gz` |
| mongodb_exporter | `https://github.com/percona/mongodb_exporter/releases/download/v0.51.0/mongodb_exporter-0.51.0.linux-<arch>.tar.gz` |
| obi（未打补丁的上游） | `https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation/releases/download/v0.14.0/obi-v0.14.0-linux-<arch>.tar.gz` |

本项目实际使用 **CNB 上的 `-ongrid` 补丁版**：`scripts/fetch-obi.sh` 从 `CNB_RELEASE_BASE_URL` 下载 `edge-deps-linux-<arch>.tar.xz`，校验 `DEPENDENCIES` 中的 `obi=0.14.0-ongrid.5` 后取出 `obi` 与 `obi.NOTICES`。

### Windows 插件

| 组件 | 上游地址 |
| --- | --- |
| windows_exporter | `https://github.com/prometheus-community/windows_exporter/releases/download/v0.29.2/windows_exporter-0.29.2-amd64.exe`<br>校验：`.../sha256sums.txt` |
| otelcol-contrib | `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.157.0/otelcol-contrib_0.157.0_windows_amd64.tar.gz`<br>校验：`.../opentelemetry-collector-releases_otelcol-contrib_checksums.txt` |
| mysqld_exporter | `https://github.com/prometheus/mysqld_exporter/releases/download/v0.19.0/mysqld_exporter-0.19.0.windows-amd64.tar.gz` |
| postgres_exporter | `https://github.com/prometheus-community/postgres_exporter/releases/download/v0.19.1/postgres_exporter-0.19.1.windows-amd64.tar.gz` |
| redis_exporter | `https://github.com/oliver006/redis_exporter/releases/download/v1.86.0/redis_exporter-v1.86.0.windows-amd64.zip` |

上游 checksum 查找方式：下载同目录的 `sha256sums.txt` / `checksums.txt`，按资产名匹配；`redis_exporter` 需要 `unzip`。

### 本项目发布附件

`https://cnb.cool/ongridio/ongrid-edge/-/releases/download/<tag>/<asset>`：

- 版本化附件 tag = `VERSION`（如 `v0.20.0`）
- 依赖归档 tag = `EDGE_DEPS_TAG`（如 `edge-deps-layout2-obi0.14.0-ongrid.5-o0.157.0-...`）

## 10. 已知约束

1. **GitHub 不可达时**：`make fetch-*` 会失败。可在能联网的机器上预取后拷贝 `bin/`，或使用 `ONGRID_EDGE_ARTIFACT_BASE_URL` 指向内网镜像（镜像布局见 [Edge 构建、组件分发与安装布局](../design/edge-build-and-distribution.md)）。
2. **Windows 附件发布**：本分支的 Windows 版本化附件尚未发布（CNB 404），`fetch-edge-assets.sh ... windows-amd64` 会失败；需先 `make build-edge-version-attachments && make publish-edge-version-attachments`，或手工组装。
3. **legacy 插件共享**：legacy 变体复用 modern 插件二进制，2008 R2 兼容性仍未闭环（能力清单 E-01）。
4. **Windows 无 process_exporter / mongodb_exporter**：属于设计选择，不是缺包。
5. **权限**：`/var/cache/ongrid/edge-artifacts` 默认 root 所有；普通用户运行 fetch 时设置 `ONGRID_EDGE_ARTIFACT_CACHE_DIR`。
6. **脚本执行位**：`*.sh` 必须 0755；`dist/build-windows-manifest.sh` 写出的 `manifest.json` 为 0644。
7. **bundle sidecar 格式**：`edge-bundle-*.sha256` 只包含哈希，不能直接 `sha256sum -c`。

## 11. 相关文件

- 构建与版本：`Makefile`（`build-edge-*`、`fetch-*`、`EDGE_*` 变量）
- legacy 构建：`tools/build-legacy-windows.sh`、`internal/compat/`、`third_party/geminio`
- 安装器：`tools/windows-installer/`
- 打包：`dist/build-edge-attachments.sh`、`dist/build-windows-manifest.sh`
- 分发与安装：`deploy/install/edge/*.sh`、`deploy/install/nginx.conf`
- 运行期布局：`internal/edgeagent/edgedirs/edgedirs_{linux,windows}.go`
- 设计参考：[Edge 构建、组件分发与安装布局](../design/edge-build-and-distribution.md)、[Windows 支持设计](../design/windows-edge-installation.md)
