import type { FeishuCommentContentElement, FeishuCommentRecord } from '@feishu-md/feishu';

const DEFAULT_MAX_CHARS = 48_000;
const MAX_MAX_CHARS = 120_000;

export interface TextPage {
  text: string;
  totalChars: number;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
}

/**
 * 长文档按字符分页返回，避免一次塞满对话上下文。
 * offset 指向原文 UTF-16 下标，下一页把 nextOffset 原样传回即可。
 */
export function pageText(source: string, offset = 0, maxChars = DEFAULT_MAX_CHARS): TextPage {
  const start = Math.max(0, Math.floor(offset));
  const limit = Math.min(Math.max(1, Math.floor(maxChars)), MAX_MAX_CHARS);
  const end = Math.min(source.length, start + limit);
  return {
    text: source.slice(start, end),
    totalChars: source.length,
    offset: start,
    nextOffset: end < source.length ? end : null,
    truncated: end < source.length,
  };
}

export function commentToPlainText(elements: FeishuCommentContentElement[] | undefined): string {
  if (!elements?.length) return '';
  return elements
    .map((element) => {
      if (element.type === 'text_run') return element.text_run?.text ?? '';
      if (element.type === 'docs_link') return element.docs_link?.url ?? '';
      if (element.type === 'person') return element.person?.user_id ? `@${element.person.user_id}` : '';
      return '';
    })
    .join('');
}

/** 评论列表压成调用方可读的结构，去掉飞书原始嵌套。单次最多 50 条。 */
export function summarizeComments(records: FeishuCommentRecord[], limit = 50) {
  const capped = records.slice(0, limit);
  return {
    total: records.length,
    returned: capped.length,
    truncated: records.length > capped.length,
    comments: capped.map((record) => ({
      commentId: record.comment_id,
      quote: record.quote ?? '',
      solved: Boolean(record.is_solved),
      wholeDocument: Boolean(record.is_whole),
      replies: record.replies.map((reply) => commentToPlainText(reply.content.elements)),
    })),
  };
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
