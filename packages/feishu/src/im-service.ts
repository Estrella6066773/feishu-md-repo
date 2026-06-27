import type { FeishuClient } from './client.js';
import { assertFeishuResponse, withRateLimit } from './api-error.js';

export type ImReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';

export async function sendPostMarkdownMessage(
  client: FeishuClient,
  receiveIdType: ImReceiveIdType,
  receiveId: string,
  markdown: string,
  title = '',
): Promise<void> {
  const text = markdown.slice(0, 4000);
  const response = await withRateLimit(() =>
    client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            title,
            content: [[{ tag: 'md', text }]],
          },
        }),
      },
    }),
  );
  assertFeishuResponse(response, 'Send IM post message');
}

export async function sendTextMessage(
  client: FeishuClient,
  receiveIdType: ImReceiveIdType,
  receiveId: string,
  text: string,
): Promise<void> {
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
}

export async function replyTextMessage(
  client: FeishuClient,
  messageId: string,
  text: string,
): Promise<void> {
  const response = await withRateLimit(() =>
    client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: text.slice(0, 4000) }),
      },
    }),
  );
  assertFeishuResponse(response, 'Reply IM message');
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
