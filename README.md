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
| 机器人消息 | `im:message` |
| 接收消息事件 | 订阅 `im.message.receive_v1`，订阅方式选 **长连接** |

并将应用添加为目标 **知识库成员** 或 **云空间文件夹协作者**，否则会出现 403 / 1770040 等权限错误。

## 功能概览

- 绑定 CRUD（本地/有云 Git、工作区/仓库模式、Wiki/Drive 目标）
- 手动同步 / 全量重建（队列执行）
- **Wiki**：`POST /wiki/v2/spaces/:space_id/nodes` 创建 docx 子节点
- **Drive**：`create_folder` + `docx/documents` 创建目录与文档
- **正文写入**：`docx/document/convert`（Markdown）+ `documentBlockDescendant/create`
- 本地 Git post-commit hook + 定时检测
- 节点映射持久化（避免重复创建）
- **同步播报**：向配置的群/用户推送成功/失败消息
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
3. 管理面板 → 设置：配置播报目标（群 `chat_id` / 用户 `open_id`）与指令白名单
4. 将机器人拉入目标群；群内需 `@机器人 同步`（可在设置中关闭 @ 要求）

