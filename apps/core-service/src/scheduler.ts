import type { DbClient } from '@feishu-md/db';
import { listBindings } from '@feishu-md/db';
import { createLogger } from '@feishu-md/shared';
import type { SyncTriggerType } from '@feishu-md/shared';
import { normalizeBindingTriggers } from '@feishu-md/shared';
import type { SyncCoordinator } from './sync-coordinator.js';
import type { CommentImportCoordinator } from './comment-import-coordinator.js';

export class SyncQueue {
  private running = false;
  private pending: Array<() => Promise<void>> = [];

  enqueue(task: () => Promise<void>): void {
    this.pending.push(task);
    void this.drain();
  }

  getQueueDepth(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) continue;
      try {
        await task();
      } catch (error) {
        queueLog.error('队列任务失败', undefined, error);
      }
    }
    this.running = false;
  }
}

const queueLog = createLogger('sync-queue');
const schedulerLog = createLogger('scheduler');

export class Scheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  start(
    db: DbClient,
    syncCoordinator: SyncCoordinator,
    commentImportCoordinator: CommentImportCoordinator,
  ): void {
    void this.refresh(db, syncCoordinator, commentImportCoordinator);
  }

  async refresh(
    db: DbClient,
    syncCoordinator: SyncCoordinator,
    commentImportCoordinator: CommentImportCoordinator,
  ): Promise<void> {
    this.stopAll();
    const bindings = await listBindings(db);
    for (const binding of bindings) {
      const triggers = normalizeBindingTriggers(binding.triggers, binding.sourceType);
      if (!triggers.scheduleEnabled) continue;
      const timer = setInterval(
        () => {
          schedulerLog.debug('定时触发同步与评论导入', { bindingId: binding.id });
          syncCoordinator.enqueueBindingSync(binding.id, 'schedule');
          if (triggers.commentImportOnSchedule) {
            commentImportCoordinator.enqueueCommentImport(binding.id, 'schedule');
          }
        },
        triggers.scheduleMinutes * 60 * 1000,
      );
      this.timers.set(binding.id, timer);
    }
    schedulerLog.info('定时任务已刷新', { activeTimers: this.timers.size });
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}

export type { SyncTriggerType };

