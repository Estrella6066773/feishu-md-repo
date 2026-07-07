import type { DbClient } from '@feishu-md/db';
import { getBinding, insertCommentImportLog, updateCommentImportLog } from '@feishu-md/db';
import { createLogger, type CommentImportTriggerType } from '@feishu-md/shared';
import { randomUUID } from 'node:crypto';
import { runCommentImport } from '@feishu-md/core';
import type { SyncQueue } from './scheduler.js';

const commentCoordLog = createLogger('comment-import-coordinator');

export class CommentImportCoordinator {
  constructor(
    private db: DbClient,
    private queue: SyncQueue,
  ) {}

  enqueueCommentImport(bindingId: string, trigger: CommentImportTriggerType): string {
    const logId = randomUUID();
    const startedAt = new Date().toISOString();

    void insertCommentImportLog(this.db, {
      id: logId,
      bindingId,
      trigger,
      status: 'pending',
      message: '评论导入排队中',
      startedAt,
    });

    commentCoordLog.info('评论导入任务入队', {
      bindingId,
      logId,
      trigger,
      queueDepth: this.queue.getQueueDepth(),
    });

    this.queue.enqueue(async () => {
      const log = commentCoordLog.child({ bindingId, logId, trigger });
      const binding = await getBinding(this.db, bindingId);
      if (!binding) {
        const message = `Binding not found: ${bindingId}`;
        await updateCommentImportLog(this.db, {
          id: logId,
          bindingId,
          trigger,
          status: 'failed',
          message,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        log.error('绑定不存在', undefined, new Error(message));
        throw new Error(message);
      }

      await updateCommentImportLog(this.db, {
        id: logId,
        bindingId,
        trigger,
        status: 'running',
        message: '正在从飞书导入评论…',
        startedAt,
      });

      log.info('评论导入开始');

      try {
        const result = await runCommentImport({
          binding,
          db: this.db,
          trigger,
          logId,
        });
        log.info('评论导入完成', {
          documentCount: result.documentCount,
          commentCount: result.commentCount,
          failedCount: result.failedDocuments.length,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error('评论导入失败', undefined, error);
        await updateCommentImportLog(this.db, {
          id: logId,
          bindingId,
          trigger,
          status: 'failed',
          message: errorMessage,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        throw error;
      }
    });

    return logId;
  }
}
