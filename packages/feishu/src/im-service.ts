import type { FeishuClient } from './client.js';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';

export type ImReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';

export interface ImMessageRef {
  messageId: string;
}

function readMessageId(response: { data?: { message_id?: string } }, action: string): string {
  const messageId = response.data?.message_id;
  if (!messageId) {
    throw new FeishuApiError(`${action} failed: missing message_id in response`);
  }
  return messageId;
}

function buildInteractiveMarkdownCard(markdown: string, title?: string): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [{ tag: 'markdown', content: markdown }],
    },
  };

  if (title) {
    card.header = {
      template: 'blue',
      title: { tag: 'plain_text', content: title.slice(0, 100) },
    };
  }

  return card;
}

export async function sendTextMessage(
  client: FeishuClient,
  receiveIdType: ImReceiveIdType,
  receiveId: string,
  text: string,
): Promise<ImMessageRef> {
  const response = await withRateLimit(() =>
    client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: text.slice(0, 4000) }),
      },
    }),
  );
  assertFeishuResponse(response, 'Send IM message');
  return { messageId: readMessageId(response, 'Send IM message') };
}

export async function sendInteractiveMarkdownMessage(
  client: FeishuClient,
  receiveIdType: ImReceiveIdType,
  receiveId: string,
  markdown: string,
  title?: string,
): Promise<ImMessageRef> {
  const response = await withRateLimit(() =>
    client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(buildInteractiveMarkdownCard(markdown, title)),
      },
    }),
  );
  assertFeishuResponse(response, 'Send IM markdown card');
  return { messageId: readMessageId(response, 'Send IM markdown card') };
}

export async function replyInteractiveMarkdownMessage(
  client: FeishuClient,
  messageId: string,
  markdown: string,
  options?: { title?: string; replyInThread?: boolean },
): Promise<ImMessageRef> {
  const response = await withRateLimit(() =>
    client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(buildInteractiveMarkdownCard(markdown, options?.title)),
        reply_in_thread: options?.replyInThread ?? false,
      },
    }),
  );
  assertFeishuResponse(response, 'Reply IM markdown card');
  return { messageId: readMessageId(response, 'Reply IM markdown card') };
}

export async function sendMarkdownCardMessages(
  client: FeishuClient,
  receiveIdType: ImReceiveIdType,
  receiveId: string,
  markdownChunks: string[],
  title?: string,
): Promise<void> {
  for (let index = 0; index < markdownChunks.length; index += 1) {
    const chunkTitle =
      markdownChunks.length > 1 && title
        ? `${title} (${index + 1}/${markdownChunks.length})`
        : title;
    await sendInteractiveMarkdownMessage(
      client,
      receiveIdType,
      receiveId,
      markdownChunks[index]!,
      chunkTitle,
    );
  }
}

/** 群聊：先发 Markdown 根消息，再以话题形式逐条回复 */
export async function sendBroadcastAsTopicThread(
  client: FeishuClient,
  chatId: string,
  topicRoot: string,
  threadMessages: string[],
): Promise<void> {
  const root = await sendInteractiveMarkdownMessage(client, 'chat_id', chatId, topicRoot);
  for (const message of threadMessages) {
    await replyInteractiveMarkdownMessage(client, root.messageId, message, {
      replyInThread: true,
    });
  }
}

export async function replyTextMessage(
  client: FeishuClient,
  messageId: string,
  text: string,
  options?: { replyInThread?: boolean },
): Promise<ImMessageRef> {
  const response = await withRateLimit(() =>
    client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: text.slice(0, 4000) }),
        reply_in_thread: options?.replyInThread ?? false,
      },
    }),
  );
  assertFeishuResponse(response, 'Reply IM message');
  return { messageId: readMessageId(response, 'Reply IM message') };
}

export function parseMessageText(content: string, messageType: string): string {
  if (messageType !== 'text') return '';
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return (parsed.text ?? '').trim();
  } catch {
    return content.trim();
  }
}

/** 群未开启话题能力时飞书返回 230071 */
export function isFeishuTopicUnsupportedError(error: unknown): boolean {
  return error instanceof FeishuApiError && error.code === 230071;
}
