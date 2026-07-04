import type { DbClient } from '@feishu-md/db';
import { getBinding, insertCommentImportLog, updateCommentImportLog } from '@feishu-md/db';
import type { CommentImportTriggerType } from '@feishu-md/shared';
import { randomUUID } from 'node:crypto';
import { runCommentImport } from '@feishu-md/core';
import type { SyncQueue } from './scheduler.js';

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

    this.queue.enqueue(async () => {
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

      try {
        await runCommentImport({
          binding,
          db: this.db,
          trigger,
          logId,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
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
