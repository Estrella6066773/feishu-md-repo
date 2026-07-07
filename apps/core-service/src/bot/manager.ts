import type { DbClient } from '@feishu-md/db';

import { getBotSettings, getFeishuCredentials } from '@feishu-md/db';

import { createLogger } from '@feishu-md/shared';
import { createFeishuClient } from '@feishu-md/feishu';

import { BotBroadcaster } from './broadcaster.js';

import { BotCommandHandler } from './command-handler.js';

import { BotWsListener } from './ws-listener.js';

import type { SyncCoordinator } from '../sync-coordinator.js';

import type { CommentImportCoordinator } from '../comment-import-coordinator.js';

const botManagerLog = createLogger('bot-manager');



export class BotManager {

  private broadcaster: BotBroadcaster;

  private wsListener: BotWsListener;



  constructor(

    private db: DbClient,

    private syncCoordinator: SyncCoordinator,

    private commentImportCoordinator: CommentImportCoordinator,

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

    botManagerLog.info('刷新机器人配置');

    await this.wsListener.stop();



    const settings = await getBotSettings(this.db);

    const credentials = await getFeishuCredentials(this.db);

    if (!settings.enabled || !credentials) {

      botManagerLog.info('机器人未启用或未配置凭证，跳过 WS 启动');

      return;

    }



    const client = createFeishuClient(credentials);



    const commandHandler = settings.commandListenEnabled

      ? new BotCommandHandler(this.db, client, this.syncCoordinator, this.commentImportCoordinator)

      : undefined;



    await this.wsListener.start({ commandHandler });

    const status = this.wsListener.getStatus();

    botManagerLog.info('机器人 WS 状态', {

      listening: status.listening,

      connected: status.connected,

      commandListenEnabled: settings.commandListenEnabled,

    });

  }



  async stop(): Promise<void> {

    botManagerLog.info('停止机器人 WS');

    await this.wsListener.stop();

  }

}

