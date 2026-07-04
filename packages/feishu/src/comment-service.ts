import type { FeishuClient } from './client.js';
import { assertFeishuResponse, withRateLimit } from './api-error.js';

export type FeishuCommentFileType = 'doc' | 'docx' | 'sheet' | 'file' | 'slides' | 'bitable';

export type FeishuCommentContentElement = {
  type: 'text_run' | 'docs_link' | 'person';
  text_run?: { text: string };
  docs_link?: { url: string };
  person?: { user_id: string };
};

export type FeishuCommentReplyRecord = {
  reply_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  content: { elements: FeishuCommentContentElement[] };
  extra?: { image_list?: string[] };
  reactions?: Array<{
    reaction_key: string;
    count: number;
    ahead_users?: string[];
  }>;
};

export type FeishuCommentRecord = {
  comment_id: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  is_solved?: boolean;
  solved_time?: number;
  solver_user_id?: string;
  is_whole?: boolean;
  quote?: string;
  replies: FeishuCommentReplyRecord[];
};

type CommentListItem = NonNullable<
  NonNullable<
    Awaited<ReturnType<FeishuClient['drive']['v1']['fileComment']['list']>>['data']
  >['items']
>[number];

const DEFAULT_PAGE_SIZE = 100;
const FILE_TYPE_DOCX = 'docx' as const;
const USER_ID_TYPE = 'open_id' as const;

/** 分页拉取文档全部评论，并补全每条评论的全部回复与表情 */
export async function listAllDocumentComments(
  client: FeishuClient,
  fileToken: string,
  fileType: FeishuCommentFileType = FILE_TYPE_DOCX,
): Promise<FeishuCommentRecord[]> {
  const summaries: CommentListItem[] = [];
  let pageToken: string | undefined;

  do {
    const response = await withRateLimit(() =>
      client.drive.v1.fileComment.list({
        path: { file_token: fileToken },
        params: {
          file_type: fileType,
          page_size: DEFAULT_PAGE_SIZE,
          need_reaction: true,
          user_id_type: USER_ID_TYPE,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
    );
    assertFeishuResponse(response, 'List docx comments');
    const items = response.data?.items ?? [];
    summaries.push(...items);
    pageToken = response.data?.has_more ? response.data?.page_token : undefined;
  } while (pageToken);

  const records: FeishuCommentRecord[] = [];
  for (const summary of summaries) {
    if (!summary.comment_id) continue;
    const replies = await loadAllCommentReplies(client, fileToken, fileType, summary);
    records.push({
      comment_id: summary.comment_id,
      user_id: summary.user_id,
      create_time: summary.create_time,
      update_time: summary.update_time,
      is_solved: summary.is_solved,
      solved_time: summary.solved_time,
      solver_user_id: summary.solver_user_id,
      is_whole: summary.is_whole,
      quote: summary.quote,
      replies,
    });
  }

  return records;
}

async function loadAllCommentReplies(
  client: FeishuClient,
  fileToken: string,
  fileType: FeishuCommentFileType,
  summary: CommentListItem,
): Promise<FeishuCommentReplyRecord[]> {
  const initial = summary.reply_list?.replies ?? [];
  if (!summary.has_more) {
    return initial.map(normalizeReply);
  }

  const replies: FeishuCommentReplyRecord[] = initial.map(normalizeReply);
  let pageToken = summary.page_token;

  while (true) {
    const response = await withRateLimit(() =>
      client.drive.v1.fileCommentReply.list({
        path: {
          file_token: fileToken,
          comment_id: summary.comment_id!,
        },
        params: {
          file_type: fileType,
          page_size: DEFAULT_PAGE_SIZE,
          need_reaction: true,
          user_id_type: USER_ID_TYPE,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
    );
    assertFeishuResponse(response, 'List comment replies');
    const items = response.data?.items ?? [];
    replies.push(...items.map(normalizeReply));
    if (!response.data?.has_more) break;
    pageToken = response.data?.page_token;
    if (!pageToken) break;
  }

  return replies;
}

function normalizeReply(reply: {
  reply_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  content?: { elements: FeishuCommentContentElement[] };
  extra?: { image_list?: string[] };
  reactions?: FeishuCommentReplyRecord['reactions'];
}): FeishuCommentReplyRecord {
  return {
    reply_id: reply.reply_id,
    user_id: reply.user_id,
    create_time: reply.create_time,
    update_time: reply.update_time,
    content: reply.content ?? { elements: [] },
    extra: reply.extra,
    reactions: reply.reactions,
  };
}
