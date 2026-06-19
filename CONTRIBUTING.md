# 贡献与提交规范

## 初始化 Git 仓库

若目录尚未初始化：

```bash
git init
git add .
pnpm check:secrets   # 提交前建议运行
git commit -m "chore: 初始化 monorepo 脚手架"
```

远程仓库示例：

```bash
git remote add origin <你的仓库 URL>
git branch -M main
git push -u origin main
```

## 提交前自检

```bash
pnpm check:secrets
pnpm typecheck
```

`check:secrets` 会在暂存区与工作区中扫描常见密钥模式（如 `app_secret`、`cli_` 误粘贴等）。若误报，请确认文件确无敏感内容后再提交。

## 提交信息格式

采用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，**使用简体中文描述**：

```
<类型>(<可选范围>): <简短说明>

[可选正文]
```

常用类型：

| 类型 | 含义 |
|------|------|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 文档 |
| `refactor` | 重构（无行为变化） |
| `chore` | 构建、依赖、脚手架 |
| `test` | 测试 |

示例：

```
feat(feishu): 增加同步完成后的群播报
fix(bot): 修复 WS 长连接回调类型错误
docs: 补充 SECURITY 与提交规范
chore: 升级 @larksuiteoapi/node-sdk
```

## 不应出现在提交中的文件

详见 [SECURITY.md](./SECURITY.md)。简要列表：

- `node_modules/`、`.turbo/`、`dist/`
- `.env`、本地 `*.db`
- 飞书凭证、Token、含密钥的日志

`.gitignore` 已覆盖常见路径；仍建议每次 `git add` 前执行 `git status` 与 `pnpm check:secrets`。

## 分支与 Pull Request

- 功能开发：`feat/<简述>` 或 `fix/<简述>`
- PR 说明需包含：变更摘要、如何验证、是否涉及飞书权限或数据库迁移
- 涉及 `packages/db/drizzle/*.sql` 迁移时，请在 PR 中说明升级步骤（`pnpm db:migrate`）
