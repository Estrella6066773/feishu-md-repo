import * as Lark from '@larksuiteoapi/node-sdk';
import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuCredentials } from '@feishu-md/db';
import type { BotCommandHandler } from './command-handler.js';

export class BotWsListener {
  private wsClient?: Lark.WSClient;
  private commandHandler?: BotCommandHandler;
  private connected = false;

  constructor(private db: DbClient) {}

  async start(commandHandler: BotCommandHandler): Promise<void> {
    await this.stop();

    const settings = await getBotSettings(this.db);
    const credentials = await getFeishuCredentials(this.db);
    if (!settings.enabled || !settings.commandListenEnabled || !credentials) {
      return;
    }

    this.commandHandler = commandHandler;

    this.wsClient = new Lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      onReady: () => {
        this.connected = true;
        console.log('[bot] Feishu WS long connection ready (im.message.receive_v1)');
      },
      onError: (error: Error) => {
        this.connected = false;
        console.error('[bot] Feishu WS error', error);
      },
      onReconnecting: () => {
        this.connected = false;
        console.log('[bot] Feishu WS reconnecting…');
      },
      onReconnected: () => {
        this.connected = true;
        console.log('[bot] Feishu WS reconnected');
      },
    });

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Parameters<NonNullable<Lark.EventHandles['im.message.receive_v1']>>[0]) => {
        if (!this.commandHandler) return;
        // 异步处理，避免阻塞 WS 回调超过 3 秒
        void this.commandHandler.handleIncomingMessage(data).catch((error) => {
          console.error('[bot] handle message failed', error);
        });
      },
    });

    await this.wsClient.start({ eventDispatcher });
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.wsClient) {
      try {
        await this.wsClient.close();
      } catch {
        // ignore close errors
      }
    }
    this.wsClient = undefined;
    this.commandHandler = undefined;
  }

  getStatus(): { connected: boolean; listening: boolean } {
    const state = this.wsClient?.getConnectionStatus?.();
    return {
      connected: this.connected || state?.state === 'connected',
      listening: Boolean(this.wsClient),
    };
  }
}
