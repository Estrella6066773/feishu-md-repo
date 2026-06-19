import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuCredentials } from '@feishu-md/db';
import type { Binding, BotSettings, SyncTriggerType } from '@feishu-md/shared';
import { createFeishuClient, sendTextMessage } from '@feishu-md/feishu';
import type { RunSyncResult } from '@feishu-md/core';

export interface SyncBroadcastContext {
  binding: Binding;
  trigger: SyncTriggerType;
  success: boolean;
  result?: RunSyncResult;
  errorMessage?: string;
}

export class BotBroadcaster {
  constructor(private db: DbClient) {}

  async notifySyncFinished(context: SyncBroadcastContext): Promise<void> {
    const settings = await getBotSettings(this.db);
    if (!settings.enabled || !settings.broadcastEnabled) return;

    const shouldSend =
      (context.success && settings.broadcastOnSuccess) ||
      (!context.success && settings.broadcastOnFailure);
    if (!shouldSend || settings.broadcastTargets.length === 0) return;

    const credentials = await getFeishuCredentials(this.db);
    if (!credentials) return;

    const client = createFeishuClient(credentials);
    const triggerLabel = triggerName(context.trigger);
    const text = context.success
      ? `✅ 同步成功\n绑定：${context.binding.name}\n触发：${triggerLabel}\nCommit：${context.result?.toSha.slice(0, 7) ?? '-'}\n操作数：${context.result?.operationCount ?? 0}`
      : `❌ 同步失败\n绑定：${context.binding.name}\n触发：${triggerLabel}\n原因：${context.errorMessage ?? '未知错误'}`;

    await Promise.all(
      settings.broadcastTargets.map(async (target) => {
        const receiveIdType = target.type === 'chat' ? 'chat_id' : 'open_id';
        try {
          await sendTextMessage(client, receiveIdType, target.receiveId, text);
        } catch (error) {
          console.error('[bot] broadcast failed', target.receiveId, error);
        }
      }),
    );
  }

  async sendCustomMessage(text: string, settings?: BotSettings): Promise<void> {
    const botSettings = settings ?? (await getBotSettings(this.db));
    if (!botSettings.enabled || !botSettings.broadcastEnabled) return;
    if (botSettings.broadcastTargets.length === 0) return;

    const credentials = await getFeishuCredentials(this.db);
    if (!credentials) return;

    const client = createFeishuClient(credentials);
    await Promise.all(
      botSettings.broadcastTargets.map(async (target) => {
        const receiveIdType = target.type === 'chat' ? 'chat_id' : 'open_id';
        await sendTextMessage(client, receiveIdType, target.receiveId, text);
      }),
    );
  }
}

function triggerName(trigger: SyncTriggerType): string {
  switch (trigger) {
    case 'git':
      return 'Git 提交';
    case 'schedule':
      return '定时';
    case 'manual':
      return '面板手动';
    case 'bot':
      return '飞书指令';
    default:
      return trigger;
  }
}
