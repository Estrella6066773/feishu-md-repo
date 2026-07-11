import type { DbClient } from '@feishu-md/db';
import { listBindings } from '@feishu-md/db';
import { createLogger } from '@feishu-md/shared';
import type { SyncTriggerType } from '@feishu-md/shared';
import { normalizeBindingTriggers } from '@feishu-md/shared';
import type { SyncCoordinator } from './sync-coordinator.js';
import type { CommentImportCoordinator } from './comment-import-coordinator.js';

export class SyncQueue {
  private running = false;
  private pending: QueuedBindingTask[] = [];
  private activeTask: QueuedBindingTask | null = null;

  cancelPendingForBinding(bindingId: string): QueuedBindingTask[] {
    const removed: QueuedBindingTask[] = [];
    this.pending = this.pending.filter((task) => {
      if (task.bindingId === bindingId) {
        removed.push(task);
        return false;
      }
      return true;
    });
    return removed;
  }

  enqueue(task: QueuedBindingTask, options?: { front?: boolean }): void {
    if (options?.front) {
      this.pending.unshift(task);
    } else {
      this.pending.push(task);
    }
    const depth = this.getQueueDepth();
    queueLog.debug('任务入队', {
      bindingId: task.bindingId,
      logId: task.logId,
      kind: task.kind,
      trigger: task.trigger,
      queueDepth: depth,
      front: options?.front === true,
    });
    if (depth >= 10) {
      queueLog.warn('队列积压较深，后续任务将排队等待', { queueDepth: depth });
    }
    void this.drain();
  }

  getQueueDepth(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  getActiveTask(): QueuedBindingTask | null {
    return this.activeTask;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): {
    running: boolean;
    pendingCount: number;
    depth: number;
    activeTask: {
      bindingId: string;
      logId: string;
      kind: BindingQueueTaskKind;
      trigger: string;
      startedAt: string;
    } | null;
  } {
    const active = this.activeTask;
    return {
      running: this.running,
      pendingCount: this.pending.length,
      depth: this.getQueueDepth(),
      activeTask: active
        ? {
            bindingId: active.bindingId,
            logId: active.logId,
            kind: active.kind,
            trigger: active.trigger,
            startedAt: active.startedAt,
          }
        : null,
    };
  }

  private async drain(): Promise<void> {
    if (this.running) {
      queueLog.debug('队列已在 drain 中，跳过重复调用', { queueDepth: this.getQueueDepth() });
      return;
    }
    this.running = true;
    queueLog.debug('队列开始 drain', { pendingCount: this.pending.length });
    while (this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) continue;
      this.activeTask = task;
      const taskStartedMs = Date.now();
      queueLog.info('队列任务开始', {
        bindingId: task.bindingId,
        logId: task.logId,
        kind: task.kind,
        trigger: task.trigger,
        queueDepth: this.pending.length,
      });
      try {
        await task.run();
        queueLog.info('队列任务完成', {
          bindingId: task.bindingId,
          logId: task.logId,
          kind: task.kind,
          durationMs: Date.now() - taskStartedMs,
        });
      } catch (error) {
        queueLog.error(
          '队列任务失败',
          {
            bindingId: task.bindingId,
            logId: task.logId,
            kind: task.kind,
            durationMs: Date.now() - taskStartedMs,
          },
          error,
        );
      } finally {
        this.activeTask = null;
      }
    }
    this.running = false;
    queueLog.debug('队列 drain 结束');
  }
}

export type BindingQueueTaskKind = 'sync' | 'comment-import';

export interface QueuedBindingTask {
  bindingId: string;
  logId: string;
  kind: BindingQueueTaskKind;
  trigger: string;
  startedAt: string;
  generation: number;
  run: () => Promise<void>;
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

