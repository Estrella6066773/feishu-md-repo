import * as Lark from '@larksuiteoapi/node-sdk';
import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuCredentials } from '@feishu-md/db';
import { createLogger } from '@feishu-md/shared';
import type { BotCommandHandler } from './command-handler.js';

const botLog = createLogger('bot');

export interface BotWsListenerOptions {
  commandHandler?: BotCommandHandler;
}

export class BotWsListener {
  private wsClient?: Lark.WSClient;
  private options: BotWsListenerOptions = {};
  private connected = false;

  constructor(private db: DbClient) {}

  async start(options: BotWsListenerOptions): Promise<void> {
    await this.stop();

    const settings = await getBotSettings(this.db);
    const credentials = await getFeishuCredentials(this.db);
    if (!settings.enabled || !credentials) {
      botLog.info('机器人 WS 未启动：未启用或未配置凭证');
      return;
    }

    if (!options.commandHandler) {
      botLog.info('机器人 WS 未启动：指令监听未启用');
      return;
    }

    this.options = options;

    this.wsClient = new Lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      onReady: () => {
        this.connected = true;
        botLog.info('Feishu WS 长连接就绪');
      },
      onError: (error: Error) => {
        this.connected = false;
        botLog.error('Feishu WS 错误', undefined, error);
      },
      onReconnecting: () => {
        this.connected = false;
        botLog.info('Feishu WS 重连中…');
      },
      onReconnected: () => {
        this.connected = true;
        botLog.info('Feishu WS 已重连');
      },
    });

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        if (!this.options.commandHandler) return;
        void this.options.commandHandler.handleIncomingMessage(data).catch((error) => {
          botLog.error('处理消息失败', undefined, error);
        });
      },
    });

    await this.wsClient.start({ eventDispatcher });
    botLog.info('Feishu WS 监听已启动');
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      botLog.info('Feishu WS 监听停止中');
    }
    this.connected = false;
    if (this.wsClient) {
      try {
        await this.wsClient.close();
      } catch {
        // ignore close errors
      }
    }
    this.wsClient = undefined;
    this.options = {};
  }

  getStatus(): { connected: boolean; listening: boolean } {
    const state = this.wsClient?.getConnectionStatus?.();
    return {
      connected: this.connected || state?.state === 'connected',
      listening: Boolean(this.wsClient),
    };
  }
}
