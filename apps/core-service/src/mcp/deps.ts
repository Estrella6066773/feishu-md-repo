import type { DbClient } from '@feishu-md/db';
import type { BotManager } from '../bot/manager.js';
import type { ServiceConfig } from '../config.js';
import type { CommentImportCoordinator } from '../comment-import-coordinator.js';
import type { SyncQueue } from '../scheduler.js';
import type { SyncCoordinator } from '../sync-coordinator.js';

/**
 * 内置 MCP 与 HTTP API 共用这一组对象。
 * 工具入队、读日志、导出都走这里，这样助手触发的同步和面板点的同步进同一条队列。
 */
export interface McpControlDeps {
  db: DbClient;
  config: ServiceConfig;
  queue: SyncQueue;
  syncCoordinator: SyncCoordinator;
  commentImportCoordinator: CommentImportCoordinator;
  botManager: BotManager;
}

/** MCP 挂在核心服务上。只在回环地址开放，避免 FEISHU_MD_HOST 绑到所有网卡时把控制面暴露出去。 */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
