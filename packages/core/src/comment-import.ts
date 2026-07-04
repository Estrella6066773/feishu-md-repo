import type { Binding, CommentImportTriggerType } from '@feishu-md/shared';
import { isReservedSyncGitPath } from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import { getFeishuCredentials, listNodeMappings, updateCommentImportLog } from '@feishu-md/db';
import {
  assertFeishuResponse,
  countCommentReplies,
  createFeishuClient,
  deleteDocCommentExport,
  FEISHU_COMMENT_EXPORT_SCHEMA_VERSION,
  formatFeishuErrorMessage,
  formatSyncLog,
  listAllDocumentComments,
  removeCommentImportManifest,
  removeStaleDocCommentExports,
  toFeishuDocumentUrl,
  withRateLimit,
  writeCommentImportManifest,
  writeDocCommentExport,
  type FeishuCommentImportManifest,
} from '@feishu-md/feishu';

export interface RunCommentImportOptions {
  binding: Binding;
  db: DbClient;
  trigger: CommentImportTriggerType;
  logId: string;
}

export interface CommentImportResult {
  documentCount: number;
  commentCount: number;
  replyCount: number;
  skippedNoCommentCount: number;
  removedStaleFileCount: number;
  failedDocuments: Array<{ gitPath: string; error: string }>;
}

export async function runCommentImport(options: RunCommentImportOptions): Promise<CommentImportResult> {
  const { binding, db, trigger, logId } = options;
  const credentials = await getFeishuCredentials(db);
  if (!credentials) {
    throw new Error('飞书凭证未配置');
  }

  const client = createFeishuClient(credentials);
  const mappings = await listNodeMappings(db, binding.id);
  const docMappings = mappings.filter(
    (mapping) =>
      mapping.feishuNodeType === 'docx'
      && !isReservedSyncGitPath(mapping.gitPath)
      && Boolean(mapping.feishuDocToken ?? mapping.feishuNodeToken),
  );

  const importedAt = new Date().toISOString();
  const manifestDocuments: FeishuCommentImportManifest['documents'] = [];
  let commentCount = 0;
  let replyCount = 0;
  let skippedNoCommentCount = 0;
  const failedDocuments: Array<{ gitPath: string; error: string }> = [];

  for (const mapping of docMappings) {
    const gitPath = mapping.gitPath.replace(/\\/g, '/');
    const feishuDocToken = mapping.feishuDocToken ?? mapping.feishuNodeToken;
    const documentUrl = toFeishuDocumentUrl({
      feishuTargetType: mapping.feishuTargetType,
      feishuNodeToken: mapping.feishuNodeToken,
      feishuDocToken: mapping.feishuDocToken,
      feishuNodeType: mapping.feishuNodeType,
    });

    try {
      const comments = await listAllDocumentComments(client, feishuDocToken, 'docx');
      if (comments.length === 0) {
        skippedNoCommentCount += 1;
        await deleteDocCommentExport(binding.repoPath, gitPath);
        continue;
      }

      let documentTitle: string | undefined;
      try {
        const metaResponse = await withRateLimit(() =>
          client.docx.v1.document.get({
            path: { document_id: feishuDocToken },
          }),
        );
        assertFeishuResponse(metaResponse, 'Get docx document metadata');
        documentTitle = metaResponse.data?.document?.title;
      } catch (metaError) {
        console.warn(formatSyncLog(
          `读取文档标题失败，继续导入评论: ${formatFeishuErrorMessage(metaError)}`,
          { sourcePath: gitPath, documentId: feishuDocToken },
        ));
      }

      const docReplyCount = countCommentReplies(comments);
      const storageFile = await writeDocCommentExport(binding.repoPath, {
        schemaVersion: FEISHU_COMMENT_EXPORT_SCHEMA_VERSION,
        bindingId: binding.id,
        bindingName: binding.name,
        gitPath,
        feishuDocToken,
        feishuNodeToken: mapping.feishuNodeToken,
        documentTitle,
        documentUrl,
        importedAt,
        trigger,
        source: {
          listApi: 'drive.v1.fileComment.list',
          replyApi: 'drive.v1.fileCommentReply.list',
          fileType: 'docx',
          needReaction: true,
          userIdType: 'open_id',
        },
        commentCount: comments.length,
        replyCount: docReplyCount,
        comments,
      });

      manifestDocuments.push({
        gitPath,
        storageFile,
        feishuDocToken,
        feishuNodeToken: mapping.feishuNodeToken,
        documentTitle,
        documentUrl,
        commentCount: comments.length,
        replyCount: docReplyCount,
      });
      commentCount += comments.length;
      replyCount += docReplyCount;
    } catch (error) {
      const message = formatFeishuErrorMessage(error);
      failedDocuments.push({ gitPath, error: message });
      console.warn(formatSyncLog(`评论导入失败: ${message}`, {
        sourcePath: gitPath,
        documentId: feishuDocToken,
      }));
    }
  }

  const activeStorageFiles = new Set(manifestDocuments.map((doc) => doc.storageFile));
  const removedStaleFileCount = await removeStaleDocCommentExports(
    binding.repoPath,
    activeStorageFiles,
  );

  if (manifestDocuments.length > 0) {
    await writeCommentImportManifest(binding.repoPath, {
      schemaVersion: FEISHU_COMMENT_EXPORT_SCHEMA_VERSION,
      bindingId: binding.id,
      bindingName: binding.name,
      importedAt,
      trigger,
      documentCount: manifestDocuments.length,
      commentCount,
      replyCount,
      documents: manifestDocuments,
    });
  } else {
    await removeCommentImportManifest(binding.repoPath);
  }

  const message = buildCommentImportMessage({
    documentCount: manifestDocuments.length,
    commentCount,
    replyCount,
    skippedNoCommentCount,
    removedStaleFileCount,
    failedDocuments,
  });

  await updateCommentImportLog(db, {
    id: logId,
    bindingId: binding.id,
    trigger,
    status: failedDocuments.length > 0 && manifestDocuments.length === 0 ? 'failed' : 'success',
    message,
    documentCount: manifestDocuments.length,
    commentCount,
    replyCount,
    startedAt: importedAt,
    finishedAt: new Date().toISOString(),
  });

  if (failedDocuments.length > 0 && manifestDocuments.length === 0) {
    throw new Error(message);
  }

  return {
    documentCount: manifestDocuments.length,
    commentCount,
    replyCount,
    skippedNoCommentCount,
    removedStaleFileCount,
    failedDocuments,
  };
}

function buildCommentImportMessage(options: {
  documentCount: number;
  commentCount: number;
  replyCount: number;
  skippedNoCommentCount: number;
  removedStaleFileCount: number;
  failedDocuments: Array<{ gitPath: string; error: string }>;
}): string {
  const parts = [
    `已导入 ${options.documentCount} 篇有评论的文档`,
    `${options.commentCount} 条评论`,
    `${options.replyCount} 条回复`,
  ];
  if (options.skippedNoCommentCount > 0) {
    parts.push(`${options.skippedNoCommentCount} 篇无评论已跳过`);
  }
  if (options.removedStaleFileCount > 0) {
    parts.push(`清理 ${options.removedStaleFileCount} 个旧评论文件`);
  }
  if (options.failedDocuments.length > 0) {
    const preview = options.failedDocuments
      .slice(0, 3)
      .map((item) => `${item.gitPath}: ${item.error}`)
      .join('；');
    const suffix = options.failedDocuments.length > 3 ? '…' : '';
    parts.push(`${options.failedDocuments.length} 篇失败（${preview}${suffix}）`);
  }
  return parts.join('，');
}
