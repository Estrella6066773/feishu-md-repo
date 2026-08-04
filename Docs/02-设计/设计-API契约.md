# 设计-API契约

- 状态：待校验
- 最后更新：2026-08-03
- 覆盖需求：[非功能需求](../01-需求/非功能需求.md)（NFR-obs-01 / NFR-obs-04）

## 1. 契约载体

UI 与 core-service 共享 `packages/shared/src/api-contract.ts` 中的类型与常量：

- `CORE_API_VERSION`：递增此版本号以提示 UI 重启 core-service（旧进程可能缺少新路由）；
- `CORE_API_FEATURES`：当前能力列表；
- `REQUIRED_CORE_API_FEATURES`：UI 可运行的最低能力要求；
- `isCoreServiceCompatible(health)`：健康检查兼容判定（版本 ≥ 2 或必需能力齐全）。

## 2. 健康检查

| 项 | 说明 |
|----|------|
| 接口 | 健康检查返回 `ok` / `apiVersion` / `features` |
| 用途 | UI 判断本机服务是否过旧，是否需要提示重启 |
| 判定 | `apiVersion >= 2` 或 `REQUIRED_CORE_API_FEATURES` 全部存在 |

## 3. 能力列表

当前 `CORE_API_FEATURES`（版本 8）：

`settings-feishu`、`settings-bot`、`settings-bots`、`settings-user-permissions`、`bindings-crud`、`sync-log-detail`、`export-markdown`、`import-comments`、`comment-import-log-detail`、`diagram-append-document`、`board-terrain-extract`

## 4. 约定

- 新增路由或改动请求/响应结构时：递增 `CORE_API_VERSION` 并在能力列表登记新能力；
- 若新增能力是 UI 运行必需，追加到 `REQUIRED_CORE_API_FEATURES`；
- 接口路径与请求类型定义见 `packages/shared`，UI 侧 `apps/ui/src/lib/api.ts` 消费。

---
← [返回本目录](./README.md)
