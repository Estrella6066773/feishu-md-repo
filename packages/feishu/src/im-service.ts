import type { FeishuClient } from './client.js';
import { FeishuApiError, assertFeishuResponse, withRateLimit } from './api-error.js';

export type ImReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';

export interface ImMessageSendResult {
  messageId: string;
  threadId?: string;
}

const FEISHU_IM_THREAD_UNSUPPORTED_CODE = 230071;
const FEISHU_POST_MD_MAX_LENGTH = 4000;

export function isFeishuThreadReplyUnsupportedError(error: unknown): boolean {
  return error instanceof FeishuApiError && error.code === FEISHU_IM_THREAD_UNSUPPORTED_CODE;
}

function extractMessageSendResult(response: {
  data?: { message_id?: string; thread_id?: string };
}): ImMessageSendResult {
  const messageId = response.data?.message_id;
  if (!messageId) {
    throw new FeishuApiError('Send IM message failed: missing message_id');
  }
  return {
    messageId,
    threadId: response.data?.thread_id,
  };
}

function expandMarkdownParagraphs(markdown: string): string[] {
  const parts = markdown
    .split(/\n\n(?=(?:## |### |\*\*相关文件))/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [markdown];
}

function buildPostMarkdownContent(markdown: string | string[], title = '') {
  const paragraphs = (Array.isArray(markdown) ? markdown : expandMarkdownParagraphs(markdown))
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => [{ tag: 'md' as const, text: part.slice(0, FEISHU_POST_MD_MAX_LENGTH) }]);

  return JSON.stringify({
    zh_cn: {
      title,
      content: paragraphs.length > 0 ? paragraphs : [[{ tag: 'md', text: '' }]],
    },
  });
}

export async function sendPostMarkdownMessage(
  client: FeishuClient,
  receiveIdType: ImReceiveIdType,
  receiveId: string,
  markdown: string | string[],
  title = '',
): Promise<ImMessageSendResult> {
  const response = await withRateLimit(() =>
    client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'post',
        content: buildPostMarkdownContent(markdown, title),
      },
    }),
  );
  assertFeishuResponse(response, 'Send IM post message');
  return extractMessageSendResult(response);
}

export async function sendTextMessage(
  client: FeishuClient,
  receiveIdType: ImReceiveIdType,
  receiveId: string,
  text: string,
): Promise<ImMessageSendResult> {
  const response = await withRateLimit(() =>
    client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: text.slice(0, FEISHU_POST_MD_MAX_LENGTH) }),
      },
    }),
  );
  assertFeishuResponse(response, 'Send IM message');
  return extractMessageSendResult(response);
}

export async function replyPostMarkdownMessage(
  client: FeishuClient,
  messageId: string,
  markdown: string | string[],
  options?: { replyInThread?: boolean; title?: string },
): Promise<ImMessageSendResult> {
  const response = await withRateLimit(() =>
    client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'post',
        content: buildPostMarkdownContent(markdown, options?.title ?? ''),
        reply_in_thread: options?.replyInThread === true,
      },
    }),
  );
  assertFeishuResponse(response, 'Reply IM post message');
  return extractMessageSendResult(response);
}

export async function replyTextMessage(
  client: FeishuClient,
  messageId: string,
  text: string,
  options?: { replyInThread?: boolean },
): Promise<ImMessageSendResult> {
  const response = await withRateLimit(() =>
    client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: text.slice(0, FEISHU_POST_MD_MAX_LENGTH) }),
        reply_in_thread: options?.replyInThread === true,
      },
    }),
  );
  assertFeishuResponse(response, 'Reply IM message');
  return extractMessageSendResult(response);
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
