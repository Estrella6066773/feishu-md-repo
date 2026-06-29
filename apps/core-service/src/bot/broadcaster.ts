import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuCredentials, listNodeMappings } from '@feishu-md/db';
import type { Binding, BotBroadcastTarget, BotSettings, SyncTriggerType } from '@feishu-md/shared';
import {
  buildQuietBroadcastMessages,
  buildSyncBroadcastThreadPlan,
  findNodeMappingForGitPath,
  formatSyncBroadcastSummary,
  hasSyncBroadcastThreadDetails,
  isBroadcastQuietMode,
  normalizeRepoPath,
  shouldBroadcastToTarget,
  type SyncBroadcastFileEntry,
} from '@feishu-md/shared';
import {
  createFeishuClient,
  isFeishuThreadReplyUnsupportedError,
  replyPostMarkdownMessage,
  replyTextMessage,
  sendPostMarkdownMessage,
  sendTextMessage,
  toFeishuDocumentUrl,
  type FeishuClient,
} from '@feishu-md/feishu';
import type { RunSyncResult } from '@feishu-md/core';
import {
  clearQuietBroadcastThread,
  ensureQuietBroadcastThread,
  isQuietThreadInvalidError,
  type QuietBroadcastThread,
} from './quiet-thread.js';

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
        try {
          if (isBroadcastQuietMode(target)) {
            await this.sendQuietBroadcast(client, context, target, fileEntries);
            return;
          }
          await this.sendNormalBroadcast(client, context, target, fileEntries);
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

  private async sendQuietBroadcast(
    client: FeishuClient,
    context: SyncBroadcastContext,
    target: BotBroadcastTarget,
    fileEntries: SyncBroadcastFileEntry[],
  ): Promise<void> {
    let thread = await ensureQuietBroadcastThread(client, this.db, context.binding, target);
    if (!thread) {
      console.warn('[bot] quiet mode unavailable, fallback to normal broadcast', target.receiveId);
      await this.sendNormalBroadcast(client, context, target, fileEntries);
      return;
    }

    try {
      await this.postQuietBroadcastMessages(client, thread, context, fileEntries);
    } catch (error) {
      if (!target.quietThreadId || !isQuietThreadInvalidError(error)) {
        throw error;
      }
      console.warn('[bot] quiet thread invalid, recreating', target.receiveId, error);
      await clearQuietBroadcastThread(this.db, context.binding, target);
      thread = await ensureQuietBroadcastThread(client, this.db, context.binding, target);
      if (!thread) {
        await this.sendNormalBroadcast(client, context, target, fileEntries);
        return;
      }
      await this.postQuietBroadcastMessages(client, thread, context, fileEntries);
    }
  }

  private async postQuietBroadcastMessages(
    client: FeishuClient,
    thread: QuietBroadcastThread,
    context: SyncBroadcastContext,
    fileEntries: SyncBroadcastFileEntry[],
  ): Promise<void> {
    if (!context.success) {
      const failureMessage = formatSyncBroadcastSummary({
        bindingName: context.binding.name,
        trigger: context.trigger,
        success: false,
        errorMessage: context.errorMessage,
      });
      await replyTextMessage(client, thread.rootMessageId, failureMessage, {
        replyInThread: true,
      });
      return;
    }

    const summary = formatSyncBroadcastSummary({
      bindingName: context.binding.name,
      trigger: context.trigger,
      success: true,
      result: context.result,
    });
    const threadPlan = buildSyncBroadcastThreadPlan(context.result, fileEntries);
    const messages = buildQuietBroadcastMessages(summary, threadPlan);
    for (const content of messages) {
      await replyPostMarkdownMessage(client, thread.rootMessageId, content, {
        replyInThread: true,
      });
    }
  }

  private async sendNormalBroadcast(
    client: FeishuClient,
    context: SyncBroadcastContext,
    target: BotBroadcastTarget,
    fileEntries: SyncBroadcastFileEntry[],
  ): Promise<void> {
    const receiveIdType = target.type === 'chat' ? 'chat_id' : 'open_id';

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
        try {
          await replyPostMarkdownMessage(client, messageId, reply, { replyInThread: true });
        } catch (error) {
          if (isFeishuThreadReplyUnsupportedError(error)) {
            throw error;
          }
          console.warn('[bot] commit thread reply failed', target.receiveId, error);
        }
      }
      for (const reply of threadPlan.fileReplies) {
        try {
          await replyPostMarkdownMessage(client, messageId, reply, { replyInThread: true });
        } catch (error) {
          if (isFeishuThreadReplyUnsupportedError(error)) {
            throw error;
          }
          console.warn('[bot] file thread reply failed', target.receiveId, error);
        }
      }
    } catch (error) {
      if (isFeishuThreadReplyUnsupportedError(error)) {
        console.warn('[bot] broadcast thread reply unsupported for target', target.receiveId);
        return;
      }
      throw error;
    }
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
  if (bindingTargets !== undefined && bindingTargets.length > 0) {
    return bindingTargets;
  }
  return settings.broadcastTargets;
}
