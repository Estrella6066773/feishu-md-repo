import { serve } from '@hono/node-server';
import { createDb, failUnfinishedSyncLogs } from '@feishu-md/db';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { Scheduler, SyncQueue } from './scheduler.js';
import { SyncCoordinator } from './sync-coordinator.js';
import { BotBroadcaster } from './bot/broadcaster.js';
import { BotManager } from './bot/manager.js';

const config = loadConfig();
const { db } = createDb({ dbPath: config.dbPath });
const queue = new SyncQueue();
const scheduler = new Scheduler();
const broadcaster = new BotBroadcaster(db);
const syncCoordinator = new SyncCoordinator(db, queue, broadcaster);
const botManager = new BotManager(db, syncCoordinator);

const app = createApp({ db, config, queue, scheduler, syncCoordinator, botManager });
const abandoned = await failUnfinishedSyncLogs(db);
if (abandoned > 0) {
  console.log(`[core-service] 已将 ${abandoned} 条未完成同步标记为失败（服务重启放弃）`);
}
scheduler.start(db, syncCoordinator);
await botManager.refresh();

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`feishu-md core-service listening on http://${info.address}:${info.port}`);
    console.log(`data directory: ${config.dataDir}`);
  },
);

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[core-service] 端口 ${config.host}:${config.port} 已被占用（EADDRINUSE）。\n` +
        '  可能已有 core-service 在运行，可直接使用；或结束占用进程后再启动。\n' +
        `  Windows 查占用：netstat -ano | findstr :${config.port}\n` +
        `  换端口：在 apps/core-service/.env 中设置 FEISHU_MD_PORT=8788`,
    );
    process.exit(1);
  }
  throw error;
});

