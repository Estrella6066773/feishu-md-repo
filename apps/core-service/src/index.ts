import { serve } from '@hono/node-server';
import { createDb, failUnfinishedCommentImportLogs, failUnfinishedSyncLogs } from '@feishu-md/db';
import { createLogger, getLogLevel, isDebugEnabled } from '@feishu-md/shared';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { BindingTaskRegistry } from './binding-task-registry.js';
import { Scheduler, SyncQueue } from './scheduler.js';
import { SyncCoordinator } from './sync-coordinator.js';
import { CommentImportCoordinator } from './comment-import-coordinator.js';
import { BotBroadcaster } from './bot/broadcaster.js';
import { BotManager } from './bot/manager.js';

const serviceLog = createLogger('core-service');

const config = loadConfig();
const { db } = createDb({ dbPath: config.dbPath });
const queue = new SyncQueue();
const bindingTaskRegistry = new BindingTaskRegistry();
const scheduler = new Scheduler();
const broadcaster = new BotBroadcaster(db);
const syncCoordinator = new SyncCoordinator(db, queue, broadcaster, bindingTaskRegistry);
const commentImportCoordinator = new CommentImportCoordinator(db, queue, bindingTaskRegistry);
const botManager = new BotManager(db, syncCoordinator, commentImportCoordinator);

const app = createApp({
  db,
  config,
  queue,
  scheduler,
  syncCoordinator,
  commentImportCoordinator,
  botManager,
});
const abandoned = await failUnfinishedSyncLogs(db);
if (abandoned > 0) {
  serviceLog.info(`已将 ${abandoned} 条未完成同步标记为失败（服务重启放弃）`);
}
const abandonedComments = await failUnfinishedCommentImportLogs(db);
if (abandonedComments > 0) {
  serviceLog.info(`已将 ${abandonedComments} 条未完成评论导入标记为失败（服务重启放弃）`);
}
scheduler.start(db, syncCoordinator, commentImportCoordinator);
await botManager.refresh();

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    serviceLog.info(`feishu-md core-service listening on http://${info.address}:${info.port}`);
    serviceLog.info(`data directory: ${config.dataDir}`);
    serviceLog.info(`log level: ${getLogLevel()}${isDebugEnabled() ? '（debug 已开启）' : ''}`);
  },
);

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    serviceLog.error(
      `端口 ${config.host}:${config.port} 已被占用（EADDRINUSE）。\n` +
        '  可能已有 core-service 在运行，可直接使用；或结束占用进程后再启动。\n' +
        `  Windows 查占用：netstat -ano | findstr :${config.port}\n` +
        `  换端口：在 apps/core-service/.env 中设置 FEISHU_MD_PORT=8788`,
    );
    process.exit(1);
  }
  throw error;
});
