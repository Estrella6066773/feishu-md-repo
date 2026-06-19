import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuCredentials } from '@feishu-md/db';
import { createFeishuClient } from '@feishu-md/feishu';
import { BotBroadcaster } from './broadcaster.js';
import { BotCommandHandler } from './command-handler.js';
import { BotWsListener } from './ws-listener.js';
import type { SyncCoordinator } from '../sync-coordinator.js';

export class BotManager {
  private broadcaster: BotBroadcaster;
  private wsListener: BotWsListener;

  constructor(
    private db: DbClient,
    private syncCoordinator: SyncCoordinator,
  ) {
    this.broadcaster = new BotBroadcaster(db);
    this.wsListener = new BotWsListener(db);
  }

  getBroadcaster(): BotBroadcaster {
    return this.broadcaster;
  }

  getStatus(): { connected: boolean; listening: boolean } {
    return this.wsListener.getStatus();
  }

  async refresh(): Promise<void> {
    await this.wsListener.stop();

    const settings = await getBotSettings(this.db);
    const credentials = await getFeishuCredentials(this.db);
    if (!settings.enabled || !settings.commandListenEnabled || !credentials) {
      return;
    }

    const client = createFeishuClient(credentials);
    const handler = new BotCommandHandler(this.db, client, this.syncCoordinator);
    await this.wsListener.start(handler);
  }

  async stop(): Promise<void> {
    await this.wsListener.stop();
  }
}
