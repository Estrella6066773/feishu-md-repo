import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuCredentials } from '@feishu-md/db';
import type { Binding, BotBroadcastTarget, BotSettings, SyncTriggerType } from '@feishu-md/shared';
import { formatSyncBroadcastMessage, shouldBroadcastToTarget } from '@feishu-md/shared';
import { createFeishuClient, sendPostMarkdownMessage, sendTextMessage } from '@feishu-md/feishu';
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

    const targets = resolveBroadcastTargets(settings, context.binding).filter((target) =>
      shouldBroadcastToTarget(settings, target, {
        success: context.success,
        trigger: context.trigger,
      }),
    );
    if (targets.length === 0) return;

    const credentials = await getFeishuCredentials(this.db);
    if (!credentials) return;

    const client = createFeishuClient(credentials);
    const message = formatSyncBroadcastMessage({
      bindingName: context.binding.name,
      trigger: context.trigger,
      success: context.success,
      result: context.result,
      errorMessage: context.errorMessage,
    });

    await Promise.all(
      targets.map(async (target) => {
        const receiveIdType = target.type === 'chat' ? 'chat_id' : 'open_id';
        try {
          if (context.success) {
            await sendPostMarkdownMessage(client, receiveIdType, target.receiveId, message);
          } else {
            await sendTextMessage(client, receiveIdType, target.receiveId, message);
          }
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

function resolveBroadcastTargets(
  settings: BotSettings,
  binding: Binding,
): BotBroadcastTarget[] {
  const bindingTargets = binding.bindingSpecificBroadcastTargets;
  if (bindingTargets === undefined) {
    return settings.broadcastTargets;
  }
  return bindingTargets;
}
