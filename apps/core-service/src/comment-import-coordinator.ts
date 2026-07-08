import type { DbClient } from '@feishu-md/db';
import { getBinding, insertCommentImportLog, updateCommentImportLog } from '@feishu-md/db';
import { createLogger, type CommentImportTriggerType } from '@feishu-md/shared';
import { randomUUID } from 'node:crypto';
import {
  BindingTaskPreemptedError,
  BINDING_TASK_PREEMPTED_MESSAGE,
  runCommentImport,
} from '@feishu-md/core';
import type { BindingTaskRegistry } from './binding-task-registry.js';
import { isManualPreemptTrigger, markQueuedTaskCancelled, preemptBindingTasks } from './binding-task-preempt.js';
import type { QueuedBindingTask, SyncQueue } from './scheduler.js';

const commentCoordLog = createLogger('comment-import-coordinator');

export class CommentImportCoordinator {
  constructor(
    private db: DbClient,
    private queue: SyncQueue,
    private registry: BindingTaskRegistry,
  ) {}

  enqueueCommentImport(bindingId: string, trigger: CommentImportTriggerType): string {
    const logId = randomUUID();
    const startedAt = new Date().toISOString();
    const preempt = isManualPreemptTrigger(trigger);

    void insertCommentImportLog(this.db, {
      id: logId,
      bindingId,
      trigger,
      status: 'pending',
      message: preempt ? '评论导入准备中' : '评论导入排队中',
      startedAt,
    });

    commentCoordLog.info('评论导入任务入队', {
      bindingId,
      logId,
      trigger,
      queueDepth: this.queue.getQueueDepth(),
      preempt,
    });

    void this.scheduleCommentImport({
      bindingId,
      logId,
      trigger,
      startedAt,
      preempt,
    });

    return logId;
  }

  private async scheduleCommentImport(options: {
    bindingId: string;
    logId: string;
    trigger: CommentImportTriggerType;
    startedAt: string;
    preempt: boolean;
  }): Promise<void> {
    const { bindingId, logId, trigger, startedAt, preempt } = options;
    let generation = this.registry.getGeneration(bindingId);
    if (preempt) {
      generation = await preemptBindingTasks(this.db, this.registry, this.queue, bindingId);
    }

    const task: QueuedBindingTask = {
      bindingId,
      logId,
      kind: 'comment-import',
      trigger,
      startedAt,
      generation,
      run: async () => {
        await this.runCommentImportTask({
          bindingId,
          logId,
          trigger,
          startedAt,
          generation,
        });
      },
    };

    this.queue.enqueue(task, { front: preempt });
  }

  private async runCommentImportTask(options: {
    bindingId: string;
    logId: string;
    trigger: CommentImportTriggerType;
    startedAt: string;
    generation: number;
  }): Promise<void> {
    const { bindingId, logId, trigger, startedAt, generation } = options;
    const log = commentCoordLog.child({ bindingId, logId, trigger });
    const shouldAbort = () => this.registry.isStale(bindingId, generation);

    if (shouldAbort()) {
      await markQueuedTaskCancelled(this.db, {
        bindingId,
        logId,
        kind: 'comment-import',
        trigger,
        startedAt,
        generation,
        run: async () => {},
      });
      return;
    }

    this.registry.registerRunning(bindingId, {
      logId,
      kind: 'comment-import',
      generation,
      trigger,
      startedAt,
    });

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
      this.registry.unregisterRunning(bindingId, logId);
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
        shouldAbort,
      });
      log.info('评论导入完成', {
        documentCount: result.documentCount,
        commentCount: result.commentCount,
        failedCount: result.failedDocuments.length,
      });
    } catch (error) {
      if (error instanceof BindingTaskPreemptedError || shouldAbort()) {
        log.info('评论导入已被新的手动指令打断', { logId });
        await updateCommentImportLog(this.db, {
          id: logId,
          bindingId,
          trigger,
          status: 'failed',
          message: BINDING_TASK_PREEMPTED_MESSAGE,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        return;
      }

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
    } finally {
      this.registry.unregisterRunning(bindingId, logId);
    }
  }
}
