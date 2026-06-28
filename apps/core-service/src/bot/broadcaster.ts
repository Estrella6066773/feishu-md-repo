import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuCredentials, listNodeMappings } from '@feishu-md/db';
import type { Binding, BotBroadcastTarget, BotSettings, SyncTriggerType } from '@feishu-md/shared';
import {
  buildSyncBroadcastThreadPlan,
  findNodeMappingForGitPath,
  formatSyncBroadcastSummary,
  hasSyncBroadcastThreadDetails,
  normalizeRepoPath,
  shouldBroadcastToTarget,
  type SyncBroadcastFileEntry,
} from '@feishu-md/shared';
import {
  createFeishuClient,
  isFeishuThreadReplyUnsupportedError,
  replyPostMarkdownMessage,
  sendPostMarkdownMessage,
  sendTextMessage,
  toFeishuDocumentUrl,
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
    const fileEntries = context.success
      ? await this.resolveBroadcastFileEntries(context.binding.id, context.result?.changedPaths ?? [])
      : [];

    await Promise.all(
      targets.map(async (target) => {
        const receiveIdType = target.type === 'chat' ? 'chat_id' : 'open_id';
        try {
          if (!context.success) {
            const failureMessage = formatSyncBroadcastSummary({
              bindingName: context.binding.name,
              trigger: context.trigger,
              success: false,
              errorMessage: context.errorMessage,
            });
            await sendTextMessage(client, receiveIdType, target.receiveId, failureMessage);
            return;
          }

          const summary = formatSyncBroadcastSummary({
            bindingName: context.binding.name,
            trigger: context.trigger,
            success: true,
            result: context.result,
          });
          const { messageId } = await sendPostMarkdownMessage(
            client,
            receiveIdType,
            target.receiveId,
            summary,
          );

          const threadPlan = buildSyncBroadcastThreadPlan(context.result, fileEntries);
          if (!hasSyncBroadcastThreadDetails(context.result, fileEntries)) {
            return;
          }

          try {
            for (const reply of threadPlan.commitReplies) {
              await replyPostMarkdownMessage(client, messageId, reply, { replyInThread: true });
            }
            for (const reply of threadPlan.fileReplies) {
              await replyPostMarkdownMessage(client, messageId, reply, { replyInThread: true });
            }
          } catch (error) {
            if (isFeishuThreadReplyUnsupportedError(error)) {
              console.warn('[bot] broadcast thread reply unsupported for target', target.receiveId);
              return;
            }
            throw error;
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

  private async resolveBroadcastFileEntries(
    bindingId: string,
    changedPaths: string[],
  ): Promise<SyncBroadcastFileEntry[]> {
    if (changedPaths.length === 0) return [];

    const mappings = await listNodeMappings(this.db, bindingId);
    const mappingByGitPath = new Map(
      mappings.map((mapping) => [normalizeRepoPath(mapping.gitPath), mapping]),
    );

    return changedPaths.map((path) => {
      const mapping = findNodeMappingForGitPath(path, mappingByGitPath);
      return {
        path,
        url: mapping ? toFeishuDocumentUrl(mapping) : undefined,
      };
    });
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
