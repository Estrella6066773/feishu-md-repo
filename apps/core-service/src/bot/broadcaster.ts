import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuCredentials } from '@feishu-md/db';
import type { Binding, BotBroadcastTarget, BotSettings, SyncTriggerType } from '@feishu-md/shared';
import {
  buildSyncBroadcastMessageParts,
  shouldBroadcastToTarget,
  splitSyncBroadcastMarkdown,
} from '@feishu-md/shared';
import {
  createFeishuClient,
  isFeishuTopicUnsupportedError,
  sendBroadcastAsTopicThread,
  sendMarkdownCardMessages,
  sendTextMessage,
} from '@feishu-md/feishu';
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
    const parts = buildSyncBroadcastMessageParts({
      bindingName: context.binding.name,
      trigger: context.trigger,
      success: context.success,
      result: context.result,
      errorMessage: context.errorMessage,
    });

    await Promise.all(
      targets.map(async (target) => {
        try {
          await this.deliverBroadcast(client, target, parts);
        } catch (error) {
          console.error('[bot] broadcast failed', target.receiveId, error);
        }
      }),
    );
  }

  private async deliverBroadcast(
    client: ReturnType<typeof createFeishuClient>,
    target: BotBroadcastTarget,
    parts: ReturnType<typeof buildSyncBroadcastMessageParts>,
  ): Promise<void> {
    if (target.type === 'chat') {
      try {
        await sendBroadcastAsTopicThread(
          client,
          target.receiveId,
          parts.topicRoot,
          parts.threadMessages,
        );
        return;
      } catch (error) {
        if (!isFeishuTopicUnsupportedError(error)) {
          throw error;
        }
        console.warn('[bot] chat topic unsupported, fallback to flat markdown cards', target.receiveId);
      }
    }

    const flatMarkdown = [parts.topicRoot, ...parts.threadMessages].join('\n\n---\n\n');
    const chunks = splitSyncBroadcastMarkdown(flatMarkdown);
    const receiveIdType = target.type === 'chat' ? 'chat_id' : 'open_id';
    await sendMarkdownCardMessages(client, receiveIdType, target.receiveId, chunks);
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
