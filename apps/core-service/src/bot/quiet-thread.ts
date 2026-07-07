import { getBotSettings, setBotSettings, updateBinding } from '@feishu-md/db';
import type { DbClient } from '@feishu-md/db';
import type { Binding, BotBroadcastTarget } from '@feishu-md/shared';
import { createLogger } from '@feishu-md/shared';
import type { FeishuClient } from '@feishu-md/feishu';
import {
  formatFeishuErrorMessage,
  getImMessage,
  isFeishuThreadReplyUnsupportedError,
  replyPostMarkdownMessage,
  sendPostMarkdownMessage,
} from '@feishu-md/feishu';

const QUIET_THREAD_ANCHOR =
  '📋 **同步播报（安静模式）**\n后续同步更新将集中在此话题内，不在群会话刷屏。';

const QUIET_THREAD_SEED = '此话题由机器人维护，用于汇集全部同步播报。';

const botLog = createLogger('bot');

export interface QuietBroadcastThread {
  threadId: string;
  rootMessageId: string;
}

function targetMatches(a: BotBroadcastTarget, b: BotBroadcastTarget): boolean {
  return a.type === b.type && a.receiveId === b.receiveId;
}

function usesBindingSpecificTargets(binding: Binding): boolean {
  const targets = binding.bindingSpecificBroadcastTargets;
  return targets !== undefined && targets.length > 0;
}

function patchTargetQuietThread(
  target: BotBroadcastTarget,
  thread: QuietBroadcastThread,
): BotBroadcastTarget {
  return {
    ...target,
    quietThreadId: thread.threadId,
    quietRootMessageId: thread.rootMessageId,
  };
}

async function resolveThreadIdFromMessage(
  client: FeishuClient,
  messageId: string,
  hintedThreadId?: string,
): Promise<string | undefined> {
  if (hintedThreadId) return hintedThreadId;
  const detail = await getImMessage(client, messageId);
  return detail?.threadId;
}

export async function persistBroadcastTargetQuietThread(
  db: DbClient,
  binding: Binding,
  target: BotBroadcastTarget,
  thread: QuietBroadcastThread,
): Promise<void> {
  const patched = patchTargetQuietThread(target, thread);

  if (usesBindingSpecificTargets(binding)) {
    await updateBinding(db, {
      ...binding,
      bindingSpecificBroadcastTargets: binding.bindingSpecificBroadcastTargets!.map((item) =>
        targetMatches(item, target) ? patched : item,
      ),
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const settings = await getBotSettings(db);
  await setBotSettings(db, {
    ...settings,
    broadcastTargets: settings.broadcastTargets.map((item) =>
      targetMatches(item, target) ? patched : item,
    ),
  });
}

export async function createQuietBroadcastThread(
  client: FeishuClient,
  chatId: string,
): Promise<QuietBroadcastThread | null> {
  const anchor = await sendPostMarkdownMessage(client, 'chat_id', chatId, QUIET_THREAD_ANCHOR);

  let threadId = await resolveThreadIdFromMessage(client, anchor.messageId, anchor.threadId);
  if (threadId) {
    try {
      await replyPostMarkdownMessage(client, anchor.messageId, QUIET_THREAD_SEED, {
        replyInThread: true,
      });
    } catch (error) {
      if (!isFeishuThreadReplyUnsupportedError(error)) {
        botLog.warn('安静话题种子回复失败', { chatId }, error);
      }
    }
    return { threadId, rootMessageId: anchor.messageId };
  }

  try {
    const seeded = await replyPostMarkdownMessage(client, anchor.messageId, QUIET_THREAD_SEED, {
      replyInThread: true,
    });
    threadId = await resolveThreadIdFromMessage(client, seeded.messageId, seeded.threadId);
    if (!threadId) {
      threadId = await resolveThreadIdFromMessage(client, anchor.messageId);
    }
    if (!threadId) {
      botLog.warn('安静话题已创建但响应缺少 thread_id', { chatId });
      return null;
    }
    return { threadId, rootMessageId: anchor.messageId };
  } catch (error) {
    if (isFeishuThreadReplyUnsupportedError(error)) {
      botLog.warn('会话不支持安静模式话题', { chatId });
      return null;
    }
    throw error;
  }
}

export async function ensureQuietBroadcastThread(
  client: FeishuClient,
  db: DbClient,
  binding: Binding,
  target: BotBroadcastTarget,
): Promise<QuietBroadcastThread | null> {
  if (target.quietThreadId && target.quietRootMessageId) {
    return {
      threadId: target.quietThreadId,
      rootMessageId: target.quietRootMessageId,
    };
  }

  if (target.quietThreadId && !target.quietRootMessageId) {
    botLog.warn('安静话题缺少根消息 ID，重新创建', { receiveId: target.receiveId });
  }

  const created = await createQuietBroadcastThread(client, target.receiveId);
  if (!created) {
    return null;
  }

  await persistBroadcastTargetQuietThread(db, binding, target, created);
  botLog.info('安静播报话题就绪', { receiveId: target.receiveId, threadId: created.threadId });
  return created;
}

export async function clearQuietBroadcastThread(
  db: DbClient,
  binding: Binding,
  target: BotBroadcastTarget,
): Promise<void> {
  const cleared: BotBroadcastTarget = {
    ...target,
    quietThreadId: undefined,
    quietRootMessageId: undefined,
  };

  if (usesBindingSpecificTargets(binding)) {
    await updateBinding(db, {
      ...binding,
      bindingSpecificBroadcastTargets: binding.bindingSpecificBroadcastTargets!.map((item) =>
        targetMatches(item, target) ? cleared : item,
      ),
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const settings = await getBotSettings(db);
  await setBotSettings(db, {
    ...settings,
    broadcastTargets: settings.broadcastTargets.map((item) =>
      targetMatches(item, target) ? cleared : item,
    ),
  });
}

export function isQuietThreadInvalidError(error: unknown): boolean {
  const message = formatFeishuErrorMessage(error);
  return /thread|话题|230071|999916|message not found|消息不存在/i.test(message);
}
