# Feishu MD Repo

本地桌面应用：将 Git 仓库（GitHub 远程或本机）与飞书知识库（Wiki）/ 云空间（Drive）同步。

## 架构

- `apps/desktop` — Tauri 2 桌面壳
- `apps/ui` — React 管理面板（嵌入桌面，也可单独在浏览器中开发）
- `apps/core-service` — 本地 Hono API + 同步 Worker
- `packages/*` — 共享业务逻辑（Git、飞书、转换、数据库）

## 环境要求

- Node.js 20+
- pnpm 9+（见下方安装说明）
- Git
- Rust（仅打包桌面应用时需要）

### 安装 pnpm（通过 npm）

本仓库使用 [pnpm](https://pnpm.io/) 管理 monorepo 依赖。若尚未安装 pnpm，在已安装 Node.js 的前提下，可用 npm 全局安装：

```bash
npm install -g pnpm@9
```

安装完成后验证：

```bash
pnpm -v
```

应显示 `9.x`。之后在本项目根目录执行 `pnpm install` 即可。

**Windows 提示**：若终端提示找不到 `pnpm` 命令，可关闭并重新打开终端；仍无效时，可临时用 npx 代替（无需全局安装）：

```bash
npx pnpm@9 install
npx pnpm@9 dev:service
```

也可启用 Node 自带的 Corepack（Node.js 16.13+）：

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
```

## 开发

```bash
pnpm install

# 终端 1：本地核心服务
pnpm dev:service

# 终端 2：UI（浏览器访问 http://localhost:5173）
pnpm dev:ui

# 或 Tauri 桌面开发（需先启动 core-service）
pnpm dev:desktop
```

### 常见问题：端口 8787 已被占用

若启动 `pnpm dev:service` 出现 `EADDRINUSE: address already in use 127.0.0.1:8787`，说明**已有 core-service 在运行**（常见于上次未关闭的终端）。可任选其一：

1. **直接使用现有服务**（推荐）：浏览器打开 UI 即可，无需再启一份。
2. **结束占用进程**（Windows）：
   ```bash
   netstat -ano | findstr :8787
   taskkill /PID <上一步最后一列的 PID> /F
   ```
3. **改用其他端口**：复制 `apps/core-service/.env.example` 为 `.env`，设置 `FEISHU_MD_PORT=8788` 后重启。

## 飞书应用权限（自建应用）

在 [飞书开放平台](https://open.feishu.cn/app) 为应用至少开通：

| 能力 | 权限 scope |
|------|------------|
| 知识库节点 | `wiki:wiki` 或 `wiki:node:create` |
| 云空间文件夹 / 文件 | `drive:drive` 或 `space:folder:create` |
| 新版文档读写 | `docx:document` |
| Markdown 转换（官方 convert 接口） | `docx:document` |
| 文档内图片上传 | `docs:document.media:upload` |
| 画板节点（同步文档总览思维导图） | `board:whiteboard:node:read`、`board:whiteboard:node:create`、`board:whiteboard:node:delete` |
| 机器人消息 | `im:message` |
| 接收消息事件 | 订阅 `im.message.receive_v1`，订阅方式选 **长连接** |

并将应用添加为目标 **知识库成员** 或 **云空间文件夹协作者**，否则会出现 403 / 1770040 等权限错误。

## 功能概览

- 绑定 CRUD（本地/有云 Git、工作区/仓库模式、Wiki/Drive 目标）
- 手动同步 / 全量重建（队列执行）
- **Wiki**：`POST /wiki/v2/spaces/:space_id/nodes` 创建 docx 子节点
- **Drive**：`create_folder` + `docx/documents` 创建目录与文档
- **正文写入**：`docx/document/convert`（Markdown）+ 分段插入；本地/Git 图片读取二进制后直接写入 Image Block（`docx_image` + `replace_image`），不镜像到云空间、不在文档中保留 GitHub 链接；文内 Mermaid 流程图/图表代码块会插入画板块并用 API 绘制
- 本地 Git post-commit hook（仅本地库）/ 有云库定时 fetch 远程
- 节点映射持久化（避免重复创建）
- **同步文档总览**：每次同步在飞书根级创建/更新「同步文档总览」文档，内含画板思维导图，展示当前已同步的文档树结构
- **同步播报**：向配置的群/用户推送成功/失败消息（主消息摘要 + 话题内 commit 与文件详情，见下文）
- **飞书指令**：长连接监听 `同步` / `status` 等指令并触发同步

## 数据目录

默认：`%AppData%/Roaming/feishu-md-repo/app.db`（Windows）

可通过环境变量 `FEISHU_MD_DATA_DIR` 覆盖。数据库内含飞书凭证、绑定与节点映射，**切勿**复制到仓库或公开分享。

## 保密与安全

- 飞书 `app_secret` 通过管理面板写入**本地 SQLite**，不会写入仓库
- 核心服务默认只监听 `127.0.0.1:8787`，请勿对公网直接暴露
- 提交前运行 `pnpm check:secrets` 扫描误提交的密钥或 `.db` 文件

详细说明见 [SECURITY.md](./SECURITY.md)。

## 版本控制与提交

仓库尚未包含 `node_modules`、`.env`、本地 `*.db` 等（见 `.gitignore`）。

```bash
git init
pnpm check:secrets
pnpm typecheck
git add .
git commit -m "chore: 初始化项目"
```

提交信息格式与 PR 约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 机器人配置（播报 + 指令）

1. 启动 `pnpm dev:service`，确保 WS 长连接可建立
2. 飞书开放平台：开通 `im:message`，订阅 `im.message.receive_v1`，方式选 **长连接**
3. 管理面板 → 设置 → **飞书用户权限**：添加管理员等用户（open_id + 权限级别）
4. 配置播报目标（每个目标可单独设置播报范围，如某群仅接收自动更新）与群 `chat_id` 白名单（可选）
5. 将机器人拉入目标群；群内需 `@机器人 同步`（可在设置中关闭 @ 要求）

### 用户权限级别

| 级别 | 说明 |
|------|------|
| 管理员 | 全部绑定与全部指令（含全量同步）；对应「管理后台」全部能力 |
| 管理者 | 仅对已指定的绑定使用全部可用指令 |
| 成员 | 仅可对 **有云仓库** 绑定发起普通同步，不可操作本地库、不可全量同步 |
| 黑名单 | 禁止使用一切机器人功能 |
| 默认组 | 未出现在名单中的用户（不写入数据库），无法使用指令 |

群聊中响应指令时 **仅依据用户权限级别** 判定（不再使用 open_id 白名单；未配置权限名单时回退旧版白名单逻辑）。

### 同步播报格式

同步成功后，机器人向配置的群或用户发送消息，结构如下：

**主消息**（出现在群会话时间线）：

```text
✅ 同步成功
- 绑定：我的文档库
- 触发：Git 提交
- Commit：`a1b2c3d`
- 文件：更新了 8 个
- 操作数：5
```

**话题回复 1**（每个 commit 一条，仅在群支持话题时发送；详情不在主会话刷屏）：

- 标题行：短哈希 + subject（Markdown 三级标题）
- 正文：Git 提交说明原文（Markdown，保留换行）

**话题回复 2**（排在 commit 回复之后，列出全部相关文件；已映射到飞书的文件带文档链接）

若群不支持话题（飞书错误码 230071），则**只发主消息**，不发送话题内详情。

### 安静模式

在播报目标的策略中开启**安静模式**（仅群聊）后：

- 机器人会在群内创建一条锚点消息，并维护一个**固定话题**；
- 此后每次同步的摘要、commit 详情与文件列表**全部写入该话题**，不在群主会话时间线重复刷屏；
- 首次创建话题时会在群会话出现锚点说明；之后同步仅更新话题内容。

若群不支持话题，安静模式无法创建话题，将**自动回退**为普通播报（主消息 + 单次话题回复）。关闭安静模式后，已保存的 `thread_id` 不再使用，下次开启会重新创建话题。

## 同步路径筛选（两重屏蔽）

同步时**不会**扫描工作区未跟踪文件，也不会把仓库里所有 blob 无差别转译到飞书：

1. **Git 规则（一重）**：以目标 commit 为准，用 `git ls-files --with-tree` 取 Git 已跟踪路径，并排除 `.gitattributes` 中标记了 `export-ignore` 的文件。本地库与有云库均走同一套 Git 语义。
2. **项目规则（二重）**：在转移步骤再按绑定配置的 `ignoreGlobs` 过滤（管理面板「项目忽略规则」，每行一条 glob）。系统默认还会额外排除 `node_modules` 与 `.git`。

**工作区模式**默认只同步 Markdown 及其目录层级（`mirrorNonMdFiles: false`），不会因非 Markdown 文件而镜像整棵目录树。

**仓库模式**：每个含 README 的目录对应飞书里的一篇**文档**；正文来自 README，标题为目录名（根目录取绑定名称）。子文档通过 Wiki **父 node_token** 嵌套（文档可作容器，**不是**云空间 folder）。

**目标类型**：
- **Wiki（推荐，尤其仓库模式）**：填写 `space_id`，可选 **父 node_token**（某篇文档或节点的 token，如 `Dunxd…`），同步结果挂在其下。
- **Drive**：仅支持 **folder_token**（`fld` 开头）的云空间文件夹，不支持文档 token 作父节点。

## 本地库 vs 有云库（触发方式）

| 类型 | 默认触发 | 同步时 Git 行为 |
|------|----------|-----------------|
| **本地库** | `post-commit` hook；可选定时检查（默认 10 分钟，可单独设置） | 读取本地 `HEAD`，不 fetch 远程 |
| **有云库** | 默认每 10 分钟定时检查（可在绑定里单独设置） | `git fetch origin <分支>` 后读 `origin/<分支>` |

有云库**不会**安装 post-commit hook；只有远程有新 commit，且在定时/手动/机器人触发 fetch 后才会更新飞书。已有旧绑定若行为不对，请在面板重新保存一次以应用默认触发配置。

### Markdown 中的流程图 / 图表

同步正文时，下列 fenced 代码块会**自动插入飞书画板块**并绘制，而不是当作普通代码块：

````markdown
```mermaid
flowchart LR
    A[规划路线] --> B[移动城市]
    B --> C[停下交互]
```
````

也支持 ` ```flowchart `、` ```graph ` 语言标记，或首行以 `flowchart` / `graph` 开头的无语言标记块。支持的类型包括流程图、思维导图、时序图等（由飞书画板 Mermaid 导入接口解析）。

