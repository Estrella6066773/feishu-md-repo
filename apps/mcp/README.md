# 飞书文档 MCP

本目录是一个 stdio MCP 服务，把仓库里已有的飞书读写能力暴露给 Cursor。文档转换、画板和知识库节点仍由 `packages/feishu` 完成，这里只负责工具参数、凭证和返回文本。

## 凭证

与桌面应用共用本机 SQLite（默认 `%AppData%/Roaming/feishu-md-repo/app.db`）。优先级：

1. 工具参数 `botId`（档案 ID 或名称），或环境变量 `FEISHU_MD_BOT_ID`
2. 同时设置了 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 时用环境变量（未点名机器人时）
3. 设置页里的默认机器人
4. 旧版全局凭证

本地查询用 Node 自带的 `node:sqlite`，只执行 SELECT，不跑数据库迁移。这样不依赖 `better-sqlite3` 的原生模块版本。

## 在 Cursor 中启用

项目根 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "feishu-md": {
      "command": "node",
      "args": ["apps/mcp/start.mjs"],
      "env": {
        "FEISHU_MD_LOG_LEVEL": "warn"
      }
    }
  }
}
```

工作目录是仓库根目录。标准输出只留给 MCP 协议；日志在标准错误。

## 工具

| 工具 | 作用 |
|------|------|
| `feishu_status` | 当前会用哪套凭证（不含密钥） |
| `feishu_list_bindings` | 本机 Git 与飞书的同步绑定 |
| `feishu_find_synced_document` | 按 Git 路径查找已经同步的文档链接 |
| `feishu_list_wiki_spaces` | 当前应用可见的知识库 |
| `feishu_list_wiki_nodes` | 某个知识库节点下的子节点 |
| `feishu_read_document` | 把云文档导出成 Markdown，长文用 `offset` 分页 |
| `feishu_write_document` | 清空正文后整篇重写。只在明确要求覆盖时使用 |
| `feishu_append_document` | 把 Markdown 追加到文末 |
| `feishu_create_document` | 在知识库或云空间新建文档，可带初始正文 |
| `feishu_update_title` | 只改标题。知识库文档会同时改节点标题 |
| `feishu_list_comments` | 读取评论和回复 |

链接可以是完整 URL、含 `/docx/` 或 `/wiki/` 的路径，或单独的 token。

Markdown 里的 Mermaid 代码块会画成飞书画板，GFM 表格会变成原生表格。正文中的本地图片不会从磁盘上传。

应用权限与同步功能相同，见仓库 README 的「飞书应用权限」。读取评论还需要评论读取权限。

## 与 Git 同步的关系

正文方向仍是 **Git → 飞书**。MCP 可以直接改飞书文档，但若该文档已在某个绑定的节点映射里，下次同步会用仓库文件覆盖飞书正文。`feishu_write_document` / `feishu_append_document` 在这种情况下会返回 `syncOverwriteWarning`。需要长期保留的改动应写进 Git，而不是只改飞书。

需要 Node.js 22.13+（使用内置 `node:sqlite` 只读打开本机库）。
