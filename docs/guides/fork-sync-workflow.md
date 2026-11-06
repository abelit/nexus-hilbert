# Fork 维护与上游同步流程

本文记录 `abelit/nexus-hilbert` 这个二次开发 fork 的分支模型，以及从上游
`ongridio/ongrid` 同步代码、验证并合回本地主干的流程。向上游提交变更仍按
[贡献指南](../../CONTRIBUTING.md) 执行；本文只覆盖 fork 自身的维护方式。

## 仓库与远端

| 远端 | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `git@github.com:abelit/nexus-hilbert.git` | 个人 fork，存放二开分支 |
| `upstream` | `git@github.com:ongridio/ongrid.git` | 上游开源仓库，只 fetch |

`upstream` 的 push URL 已设为 `DISABLED`，防止误推上游。需要保留拉取能力时不要删除该远端；
如需恢复推送（一般不需要），执行 `git remote set-url --push upstream git@github.com:ongridio/ongrid.git`。

本地 `upstream-main` 跟踪 `upstream/main`（`branch.upstream-main.remote=upstream`，
`merge=refs/heads/main`），同时设置 `branch.upstream-main.pushRemote=no-push`，避免在该分支
误执行 `git push`。该远端配置生效后，`git pull --ff-only` 即可让镜像与上游 `main` 保持一致。

## 分支模型

```text
upstream/main ──► upstream-main      本地镜像，只做快进
                       │ merge（每个上游 release 一次）
                       ▼
main ◄── merge --no-ff ── hilbert-dev  日常开发与验证
```

| 分支 | 生命周期 | 职责 | 规则 |
| --- | --- | --- | --- |
| `upstream-main` | 长期 | 上游 `main` 的本地镜像 | 跟踪 `upstream/main`，只允许 `--ff-only` 快进，禁止提交和开发 |
| `hilbert-dev` | 长期 | 二开开发、上游同步、验证 | 已推送到 `origin/hilbert-dev`，禁止 rebase 和 force push |
| `main` | 长期 | 本地集成主干，只接收已验证的 `hilbert-dev` | 通过本地 `merge --no-ff` 更新 |
| `feat/*`、`fix/*`、`chore/*` | 临时 | 单个变更或向上游提交的 PR 分支 | 一个分支一个逻辑变更，命名遵循 [AGENTS.md](../../AGENTS.md) |

`hilbert-dev` 从 `main` 创建，因此天然包含已有的 CMDB 等二开提交；`upstream-main` 只用于
同步上游和构建纯净上游基线，不在其上开发。

## 日常流程

### 1. 同步上游镜像

每个上游 release 后执行一次：

```bash
git switch upstream-main
git pull --ff-only
```

`upstream-main` 已跟踪 `upstream/main`，`git pull` 默认会 fetch 上游并做快进合并。必须保留
`--ff-only`：如果上游改写了历史导致无法快进，`pull` 会报错而不是产生多余的合并提交。

不使用 `pull` 时，等价的显式步骤如下：

```bash
git fetch upstream --prune
git switch upstream-main
git merge --ff-only upstream/main
```

如果 `upstream-main` 未被检出，也可以直接移动引用：

```bash
git fetch upstream --prune
git branch -f upstream-main upstream/main
```

`git fetch` 会同时更新上游标签。上游删除的分支由 `--prune` 清理对应的远程跟踪引用。

### 2. 合并到 hilbert-dev

```bash
git switch hilbert-dev
git merge upstream-main
```

合并提交使用英文 Conventional Commits，沿用既有风格：

```text
chore: merge upstream ongrid v0.20.0 into hilbert-dev
```

冲突处理：

- `.gitignore`：双方通常在文件末尾追加规则，保留双方条目。
- `VERSION`：默认跟随上游；如果本次要发 fork 自己的版本，在合并提交中显式调整。
- `go.mod`、`go.sum`、`Makefile`：一般可自动合并，合并后必须重新构建验证。
- `web/src/App.tsx`：路由注册是二开与上游的高频交叠点，需人工确认双方路由都保留。
- `internal/cmdb/`：当前为 fork 独有，上游没有对应目录；若上游开始引入 CMDB，停止合并并按
  [ADR 目录](../adr/) 评估集成方案，不要直接采用某一侧。

合并后先构建再继续开发：

```bash
go build ./...
cd web && npm run build
```

完整验证要求见 [AGENTS.md](../../AGENTS.md#验证与交付)：Go 变更跑 `go test -race`，前端变更跑
`npm test`、`npm run build`、`npm run lint`；视觉变更还需按要求检查真实浏览器截图。

### 3. 在 hilbert-dev 上开发

```bash
git switch hilbert-dev
# 开发、提交、验证……
git push origin hilbert-dev
```

`hilbert-dev` 已跟踪 `origin/hilbert-dev`。日常 `git pull` 只同步自己的 fork，不会拉取上游；
上游更新一律通过 `upstream-main` 合并，避免两个来源混在一起难以排查。

### 4. 验证后合回 main

```bash
git switch hilbert-dev
git merge main            # main 若有新提交，先在这里解决分叉

git switch main
git merge --no-ff hilbert-dev
git push origin main
```

合回前必须完成受影响范围的验证并保留测试证据。合并后 `main` 与 `hilbert-dev` 内容一致，
下一次上游同步再从 `hilbert-dev` 开始。

## 护栏

- 不在 `upstream-main` 上提交；只允许 `git pull --ff-only` 或 `git merge --ff-only upstream/main`。
- 不对 `hilbert-dev` 执行 rebase 或 force push，它已经推送到 `origin` 并被其他工作引用。
- 不使用 `git push upstream`；该远端推送已被禁用。
- 不把 `hilbert-dev` 直接作为上游 PR 的 head。向上游贡献时从 `upstream-main` 切
  `feat/*`、`fix/*` 主题分支，按 [贡献指南](../../CONTRIBUTING.md) 提交英文 PR。
- 上游标签随 fetch 进入本地；fork 自己的发布标签不要复用上游标签名，避免推送时歧义。
- 根目录 `node_modules/` 已被忽略，不要再次提交依赖或构建缓存。

## 建立记录

该模型建立于 2026-11-06，初始基线：

| 项 | 提交 |
| --- | --- |
| 上游同步点 | `cb35c32d`（`v0.20.0` 及之后 7 个提交） |
| `main` | `33485bf9`（含 `node_modules` 清理） |
| `hilbert-dev` 初始合并 | `2c6fb0c5`（`chore: merge upstream ongrid v0.20.0 into hilbert-dev`） |

分支模型或远端配置变化时更新本节，不要只改命令示例。`upstream-main` 的跟踪配置
（`remote=upstream`、`merge=refs/heads/main`、`pushRemote=no-push`）于同日设置。
