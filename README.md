# Feishu MD Repo

本地桌面应用：把 **Git 仓库**（本机路径或有云远程）同步到 **飞书知识库（Wiki）** 或 **云空间（Drive）**，并在飞书侧提供文档树镜像、画板图表、群播报、指令触发与评论回流。

| 项 | 说明 |
|----|------|
| 版本 | `0.1.0` |
| 形态 | pnpm monorepo；Tauri 桌面壳 + React 面板 + 本机 Hono 服务 |
| 数据 | 凭证与映射存本机 SQLite，默认不联网托管 |
| 相关文档 | [SECURITY.md](./SECURITY.md) · [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## 1. 项目介绍

### 1.1 要解决什么问题

团队文档常同时存在两套入口：

- **Git**：版本清晰、可审查、适合 Markdown / 仓库型文档；
- **飞书**：阅读与协作方便，但与仓库内容容易脱节。

本项目在本机把二者接起来：**以 Git 中的跟踪文件为准**，按绑定规则推送到飞书；必要时再把飞书上的评论拉回仓库，并可用机器人在群里触发同步或接收结果播报。

### 1.2 适用场景

- 设计 / 程序文档写在 Git，希望知识库里始终有一份可读镜像；
- 有云仓库（如 GitHub）定时拉取后更新飞书，无需每人装客户端写回；
- 本地库提交后自动同步（`post-commit` hook）；
- 需要在飞书里看到 Mermaid 流程图、CSV/表格、文档总览思维导图；
- 希望群里用指令同步，并把成功 / 失败与 commit 详情播报到指定群或用户。

### 1.3 设计原则（简要）

| 原则 | 含义 |
|------|------|
| Git 为准 | 只同步 Git 已跟踪路径；不扫未跟踪工作区文件 |
| 本地优先 | 核心服务默认只监听 `127.0.0.1`；密钥不进仓库 |
| 映射复用 | Git 路径与飞书节点 token 持久对应，避免每次重建 |
| 可观测 | 同步分阶段进度、日志、队列状态、机器人连接状态 |
| 可中断 | 同绑定上新的手动任务可抢占进行中的旧任务 |

### 1.4 不在范围内

- 不把飞书文档当作可写回 Git 的双向权威编辑器（正文方向以 Git → 飞书为主；评论可反向导入）；
- 不托管多用户云端账号体系；每人在本机配置飞书自建应用；
- 不替代飞书权限体系本身——应用仍须被加为知识库成员或文件夹协作者。

---

## 2. 核心概念

### 2.1 绑定（Binding）

一次「仓库 ↔ 飞书位置」的配置，交叉三个维度：

| 维度 | 取值 | 说明 |
|------|------|------|
| 来源 | 本地库 / 有云库 | 本地读 `HEAD`；有云先 `fetch` 再读远程分支 |
| 模式 | 工作区 / 仓库 | 见下文「同步模式」 |
| 目标 | Wiki / Drive | Wiki 推荐（尤其仓库模式）；Drive 仅支持文件夹 token |

另可配置：触发方式、忽略规则、强制更新 glob、绑定级播报目标等。

### 2.2 同步模式

**工作区模式**

- 默认同步 `.md` / `.markdown` 与 `.csv`；
- CSV 可写入飞书原生表格；
- 其它非 Markdown 默认不同步（`mirrorNonMdFiles: false`），不会仅为非 MD 文件镜像整棵目录树。

**仓库模式**

- 每个含 README 的目录 → 飞书一篇文档（正文来自 README，标题为目录名；根目录可用绑定名称）；
- 独立的 Markdown / CSV 也会作为单独文档同步；
- 子文档通过 Wiki **父 `node_token`** 嵌套（文档可作容器，**不是**云空间 folder）。

### 2.3 目标类型

- **Wiki（推荐）**：填写 `space_id`，可选父 `node_token`，同步结果挂在其下；
- **Drive**：仅支持 `folder_token`（`fld` 开头），不支持用文档 token 作父节点。

### 2.4 路径筛选（两重）

同步时不会把仓库里所有 blob 无差别转译到飞书：

1. **Git 规则**：以目标 commit 为准，`git ls-files --with-tree` 取已跟踪路径，并排除 `.gitattributes` 中 `export-ignore` 的文件（本地库与有云库同一套语义）；
2. **项目规则**：再按绑定的 `ignoreGlobs` 过滤；系统默认额外排除 `node_modules` 与 `.git`。

### 2.5 本地库 vs 有云库（触发）

| 类型 | 默认触发 | 同步时 Git 行为 |
|------|----------|-----------------|
| **本地库** | `post-commit` hook；可选定时检查（默认约 10 分钟，可单独设置） | 读本地 `HEAD`，不 fetch 远程 |
| **有云库** | 默认每约 10 分钟定时检查（可在绑定里单独设置） | `git fetch origin <分支>` 后读 `origin/<分支>` |

有云库**不会**安装 post-commit hook；只有远程有新 commit，且在定时 / 手动 / 机器人触发 fetch 后才会更新飞书。另可随时在面板或机器人侧发起手动同步、完全重新搭建、强制重写正文等。旧绑定行为异常时，可在面板重新保存一次以应用默认触发配置。

---

## 3. 功能一览

### 3.1 同步主链路

- 绑定 CRUD（来源 × 模式 × 目标）；
- 手动同步 / 完全重新搭建（队列执行）；
- **立即同步**可按父节点子数量检测飞书侧缺失的已映射文件并自动补建（每父目录 list 一次；若同父目录下删一篇又新建无关文档导致子数量不变，则不会触发补建）；
- **Wiki**：创建 docx 子节点；**Drive**：`create_folder` + 创建文档；
- **正文**：官方 Markdown convert + 分段插入；本地/Git 图片读二进制写入 Image Block（不镜像到云空间、不在文档中保留 GitHub 链接）；
- 文内 Mermaid / flowchart 等代码块 → 插入画板块并用 API 绘制（可含图例着色）；
- GFM 表格与 CSV → 原生表格（Drive 下也可选择上传原文件）；
- 节点映射持久化；同步结束后更新根级「**同步文档总览**」画板思维导图。

### 3.2 协作与机器人

- **同步播报**：向配置的群 / 用户推送成功或失败（主消息摘要 + 话题内 commit 与文件详情；可开安静模式）；
- **飞书指令**：长连接监听如 `同步` / `status` / `导入评论`；
- **用户权限**：管理员 / 管理者 / 成员 / 黑名单（见下文）；
- **评论导入**：从已同步文档拉取评论（含回复、划词引用、表情），增量写入仓库 `.feishu/comments/`；可定时联动或面板手动触发。

### 3.3 工具箱

- 将飞书云文档导出为 Markdown（可含内嵌思维导图）；
- 图表格式化（Mermaid 着色等），并可追加到指定云文档。

### 3.4 Markdown 中的流程图 / 图表

同步正文时，下列 fenced 代码块会**自动插入飞书画板块**并绘制，而不是当作普通代码块：

````markdown
```mermaid
flowchart LR
    A[规划路线] --> B[移动城市]
    B --> C[停下交互]
```
````

也支持 ` ```flowchart `、` ```graph ` 语言标记，或首行以 `flowchart` / `graph` 开头的无语言标记块。支持的类型包括流程图、思维导图、时序图等（由飞书画板 Mermaid 导入接口解析）。

---

## 4. 架构

```text
┌─────────────────┐     HTTP (本机)      ┌──────────────────────┐
│  desktop (Tauri) │                     │   core-service       │
│  └─ ui (React)   │ ──────────────────► │   Hono API + Worker  │
└─────────────────┘                      │   队列 / 定时 / 机器人 │
                                         └──────────┬───────────┘
                                                    │
              ┌─────────────────────────────────────┼─────────────────────────┐
              ▼                     ▼               ▼                         ▼
        packages/core         packages/feishu   packages/git            packages/db
        同步引擎               开放平台适配       路径 / hook / fetch     Drizzle + SQLite
              │                     │               │
              └──────────┬──────────┴───────────────┘
                         ▼
                 packages/converter · packages/shared
```

| 路径 | 职责 |
|------|------|
| `apps/desktop` | Tauri 2 桌面壳 |
| `apps/ui` | 管理面板：仪表盘、绑定、日志、工具箱、设置（也可单独在浏览器开发） |
| `apps/core-service` | 本机 API、同步/评论队列、定时器、机器人长连接、任务抢占 |
| `packages/core` | `runSync` 等业务引擎（规划 → 结构 → 正文 → 清理 → 总览） |
| `packages/feishu` | Wiki / Drive / docx / 画板 / IM / 评论 / 导出 |
| `packages/git` | 同步路径、本地 hook、有云 fetch |
| `packages/converter` | Markdown / CSV 等转换 |
| `packages/db` | SQLite schema 与访问 |
| `packages/shared` | 类型契约、播报策略、图表工具、API 版本号 |

同步进度阶段：`planning` → `structure` → `content` → `cleanup` → `overview` → `done`。

核心服务健康检查含 `apiVersion` 与能力列表（见 `packages/shared` 中 `CORE_API_VERSION` / `CORE_API_FEATURES`），便于 UI 判断本机服务是否过旧。

---

## 5. 环境要求与开发

### 5.1 环境要求

- Node.js 20+
- pnpm 9+（见下方安装说明）
- Git
- Rust（仅打包桌面应用时需要）

### 5.2 安装 pnpm

本仓库使用 [pnpm](https://pnpm.io/) 管理 monorepo 依赖。若尚未安装，在已安装 Node.js 的前提下：

```bash
npm install -g pnpm@9
pnpm -v   # 应显示 9.x
```

**Windows**：若提示找不到 `pnpm`，可关闭并重开终端；或临时用：

```bash
npx pnpm@9 install
npx pnpm@9 dev:service
```

也可启用 Corepack（Node.js 16.13+）：

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
```

### 5.3 启动开发

```bash
pnpm install

# 终端 1：本地核心服务
pnpm dev:service

# 终端 2：UI（浏览器访问 http://localhost:5173）
pnpm dev:ui

# 或 Tauri 桌面开发（需先启动 core-service）
pnpm dev:desktop
```

### 5.4 常见问题：端口 8787 已被占用

若出现 `EADDRINUSE: address already in use 127.0.0.1:8787`，说明已有 core-service 在运行。可任选其一：

1. **直接使用现有服务**（推荐）：打开 UI 即可；
2. **结束占用进程**（Windows）：
   ```bash
   netstat -ano | findstr :8787
   taskkill /PID <上一步最后一列的 PID> /F
   ```
3. **改用其他端口**：复制 `apps/core-service/.env.example` 为 `.env`，设置 `FEISHU_MD_PORT=8788` 后重启。

---

## 6. 飞书应用权限（自建应用）

在 [飞书开放平台](https://open.feishu.cn/app) 为应用至少开通：

| 能力 | 权限 scope |
|------|------------|
| 知识库节点 | `wiki:wiki` 或 `wiki:node:create` |
| 云空间文件夹 / 文件 | `drive:drive` 或 `space:folder:create` |
| 新版文档读写 | `docx:document` |
| Markdown 转换（官方 convert 接口） | `docx:document` |
| 文档内图片上传 | `docs:document.media:upload` |
| 文档评论读取（导入到本地） | `docs:document.comment:read` 或 `docs:doc:readonly` |
| 画板节点（同步文档总览思维导图） | `board:whiteboard:node:read`、`board:whiteboard:node:create`、`board:whiteboard:node:delete` |
| 机器人消息 | `im:message` |
| 接收消息事件 | 订阅 `im.message.receive_v1`，订阅方式选 **长连接** |

并将应用添加为目标 **知识库成员** 或 **云空间文件夹协作者**，否则会出现 403 / 1770040 等权限错误。

---

## 7. 机器人配置（播报 + 指令）

1. 启动 `pnpm dev:service`，确保 WS 长连接可建立；
2. 飞书开放平台：开通 `im:message`，订阅 `im.message.receive_v1`，方式选 **长连接**；
3. 管理面板 → 设置 → **飞书用户权限**：添加管理员等用户（`open_id` + 权限级别）；
4. 配置播报目标（每个目标可单独设置播报范围，如某群仅接收自动更新）与群 `chat_id` 白名单（可选）；
5. 将机器人拉入目标群；群内需 `@机器人 同步`（可在设置中关闭 @ 要求）。

### 7.1 用户权限级别

| 级别 | 说明 |
|------|------|
| 管理员 | 全部绑定与全部指令（含完全重新搭建）；对应「管理后台」全部能力 |
| 管理者 | 仅对已指定的绑定使用全部可用指令 |
| 成员 | 仅可对 **有云仓库** 绑定发起普通同步，不可操作本地库、不可完全重新搭建 |
| 黑名单 | 禁止使用一切机器人功能 |
| 默认组 | 未出现在名单中的用户（不写入数据库），无法使用指令 |

群聊中响应指令时 **仅依据用户权限级别** 判定（不再使用 `open_id` 白名单；未配置权限名单时回退旧版白名单逻辑）。

### 7.2 同步播报格式

同步成功后，机器人向配置的群或用户发送消息：

**主消息**（出现在群会话时间线）：

```text
✅ 同步成功
- 绑定：我的文档库
- 触发：Git 提交
- Commit：`a1b2c3d`
- 文件：更新了 8 个
- 操作数：5
```

**话题回复 1**（每个 commit 一条，仅在群支持话题时发送）：

- 标题行：短哈希 + subject（Markdown 三级标题）
- 正文：Git 提交说明原文（Markdown，保留换行）

**话题回复 2**（排在 commit 回复之后，列出全部相关文件；已映射到飞书的文件带文档链接）

若群不支持话题（飞书错误码 230071），则**只发主消息**，不发送话题内详情。

### 7.3 安静模式

在播报目标的策略中开启**安静模式**（仅群聊）后：

- 机器人会在群内创建一条锚点消息，并维护一个**固定话题**；
- 此后每次同步的摘要、commit 详情与文件列表**全部写入该话题**，不在群主会话时间线重复刷屏；
- 首次创建话题时会在群会话出现锚点说明；之后同步仅更新话题内容。

若群不支持话题，安静模式无法创建话题，将**自动回退**为普通播报（主消息 + 单次话题回复）。关闭安静模式后，已保存的 `thread_id` 不再使用，下次开启会重新创建话题。

---

## 8. 数据目录与安全

### 8.1 数据目录

默认（Windows）：`%AppData%/Roaming/feishu-md-repo/app.db`

可通过环境变量 `FEISHU_MD_DATA_DIR` 覆盖。库内含飞书凭证、绑定与节点映射，**切勿**复制到仓库或公开分享。

主要表用途：绑定配置、节点映射、同步日志、评论导入日志、飞书删除事件、应用设置（凭证 / 机器人 / 用户权限等）。

### 8.2 保密要点

- 飞书 `app_secret` 通过管理面板写入**本地 SQLite**，不会写入仓库；
- 核心服务默认只监听 `127.0.0.1:8787`，请勿对公网直接暴露；
- 提交前运行 `pnpm check:secrets` 扫描误提交的密钥或 `.db` 文件。

详细说明见 [SECURITY.md](./SECURITY.md)。

---

## 9. 版本控制与提交

仓库不包含 `node_modules`、`.env`、本地 `*.db` 等（见 `.gitignore`）。

```bash
pnpm check:secrets
pnpm typecheck
git add .
git commit -m "chore: …"
```

提交信息格式与 PR 约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
