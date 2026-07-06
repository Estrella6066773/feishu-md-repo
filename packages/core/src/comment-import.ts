import type { Binding, CommentImportTriggerType } from '@feishu-md/shared';
import { isReservedSyncGitPath } from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import { getFeishuCredentials, listNodeMappings, updateCommentImportLog } from '@feishu-md/db';
import {
  assertFeishuResponse,
  commentStorageFileName,
  countCommentReplies,
  createFeishuClient,
  deleteDocCommentExport,
  FEISHU_COMMENT_EXPORT_SCHEMA_VERSION,
  formatFeishuErrorMessage,
  formatSyncLog,
  isDocumentCommentExportUnchanged,
  listAllDocumentComments,
  readCommentImportManifest,
  readDocCommentExport,
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
  skippedUnchangedCount: number;
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

  const runStartedAt = new Date().toISOString();
  const existingManifest = await readCommentImportManifest(binding.repoPath);
  const manifestDocuments: FeishuCommentImportManifest['documents'] = [];
  let commentCount = 0;
  let replyCount = 0;
  let skippedNoCommentCount = 0;
  let skippedUnchangedCount = 0;
  let folderChanged = false;
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
        const removed = await deleteDocCommentExport(binding.repoPath, gitPath);
        if (removed) {
          folderChanged = true;
        }
        continue;
      }

      const docReplyCount = countCommentReplies(comments);
      const existing = await readDocCommentExport(binding.repoPath, gitPath);
      if (existing && isDocumentCommentExportUnchanged(existing, comments)) {
        skippedUnchangedCount += 1;
        const storageFile = commentStorageFileName(gitPath);
        manifestDocuments.push({
          gitPath,
          storageFile,
          feishuDocToken,
          feishuNodeToken: mapping.feishuNodeToken,
          documentTitle: existing.documentTitle,
          documentUrl: existing.documentUrl || documentUrl,
          commentCount: comments.length,
          replyCount: docReplyCount,
          updatedAt: existing.updatedAt ?? existing.importedAt,
        });
        commentCount += comments.length;
        replyCount += docReplyCount;
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

      const updatedAt = new Date().toISOString();
      const storageFile = await writeDocCommentExport(binding.repoPath, {
        schemaVersion: FEISHU_COMMENT_EXPORT_SCHEMA_VERSION,
        bindingId: binding.id,
        bindingName: binding.name,
        gitPath,
        feishuDocToken,
        feishuNodeToken: mapping.feishuNodeToken,
        documentTitle,
        documentUrl,
        updatedAt,
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
      folderChanged = true;

      manifestDocuments.push({
        gitPath,
        storageFile,
        feishuDocToken,
        feishuNodeToken: mapping.feishuNodeToken,
        documentTitle,
        documentUrl,
        commentCount: comments.length,
        replyCount: docReplyCount,
        updatedAt,
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
  if (removedStaleFileCount > 0) {
    folderChanged = true;
  }

  if (manifestDocuments.length > 0) {
    if (folderChanged) {
      const manifestUpdatedAt = new Date().toISOString();
      await writeCommentImportManifest(binding.repoPath, {
        schemaVersion: FEISHU_COMMENT_EXPORT_SCHEMA_VERSION,
        bindingId: binding.id,
        bindingName: binding.name,
        updatedAt: manifestUpdatedAt,
        trigger,
        documentCount: manifestDocuments.length,
        commentCount,
        replyCount,
        documents: manifestDocuments,
      });
    }
  } else if (existingManifest) {
    await removeCommentImportManifest(binding.repoPath);
    folderChanged = true;
  }

  const message = buildCommentImportMessage({
    documentCount: manifestDocuments.length,
    commentCount,
    replyCount,
    skippedNoCommentCount,
    skippedUnchangedCount,
    removedStaleFileCount,
    folderChanged,
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
    startedAt: runStartedAt,
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
    skippedUnchangedCount,
    removedStaleFileCount,
    failedDocuments,
  };
}

function buildCommentImportMessage(options: {
  documentCount: number;
  commentCount: number;
  replyCount: number;
  skippedNoCommentCount: number;
  skippedUnchangedCount: number;
  removedStaleFileCount: number;
  folderChanged: boolean;
  failedDocuments: Array<{ gitPath: string; error: string }>;
}): string {
  if (
    !options.folderChanged
    && options.failedDocuments.length === 0
    && options.documentCount > 0
  ) {
    return `评论无变化，未更新项目文件（${options.documentCount} 篇有评论）`;
  }

  const updatedDocCount = options.documentCount - options.skippedUnchangedCount;
  const parts = [
    updatedDocCount > 0
      ? `已更新 ${updatedDocCount} 篇有评论的文档`
      : `已导入 ${options.documentCount} 篇有评论的文档`,
    `${options.commentCount} 条评论`,
    `${options.replyCount} 条回复`,
  ];
  if (options.skippedUnchangedCount > 0) {
    parts.push(`${options.skippedUnchangedCount} 篇无变化已跳过`);
  }
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
