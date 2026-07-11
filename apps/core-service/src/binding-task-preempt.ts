import type { DbClient } from '@feishu-md/db';
import { updateCommentImportLog, updateSyncLog } from '@feishu-md/db';
import { BINDING_TASK_PREEMPTED_MESSAGE } from '@feishu-md/core';
import { createLogger } from '@feishu-md/shared';
import type { BindingRunningTask, BindingTaskRegistry } from './binding-task-registry.js';
import type { QueuedBindingTask, SyncQueue } from './scheduler.js';

const preemptLog = createLogger('binding-preempt');

export function isManualPreemptTrigger(trigger: string): boolean {
  return trigger === 'manual' || trigger === 'bot';
}

export async function preemptBindingTasks(
  db: DbClient,
  registry: BindingTaskRegistry,
  queue: SyncQueue,
  bindingId: string,
): Promise<number> {
  const generation = registry.preemptBinding(bindingId);

  const cancelledPending = queue.cancelPendingForBinding(bindingId);
  preemptLog.debug('抢占绑定任务', {
    bindingId,
    generation,
    cancelledPendingCount: cancelledPending.length,
    cancelledPendingLogIds: cancelledPending.map((task) => task.logId).join(','),
  });
  for (const task of cancelledPending) {
    await markQueuedTaskCancelled(db, task);
  }

  const running = registry.getRunning(bindingId);
  if (running && registry.isStale(bindingId, running.generation)) {
    preemptLog.debug('正在运行的任务已被标记为过期', {
      bindingId,
      logId: running.logId,
      kind: running.kind,
      runningGeneration: running.generation,
      currentGeneration: generation,
    });
    await markRunningTaskCancelled(db, bindingId, running);
  }

  return generation;
}

export async function markQueuedTaskCancelled(db: DbClient, task: QueuedBindingTask): Promise<void> {
  const finishedAt = new Date().toISOString();
  if (task.kind === 'sync') {
    await updateSyncLog(db, {
      id: task.logId,
      bindingId: task.bindingId,
      trigger: task.trigger as 'git' | 'schedule' | 'manual' | 'bot',
      status: 'failed',
      message: BINDING_TASK_PREEMPTED_MESSAGE,
      startedAt: task.startedAt,
      finishedAt,
    });
    return;
  }

  await updateCommentImportLog(db, {
    id: task.logId,
    bindingId: task.bindingId,
    trigger: task.trigger as 'schedule' | 'manual' | 'bot',
    status: 'failed',
    message: BINDING_TASK_PREEMPTED_MESSAGE,
    startedAt: task.startedAt,
    finishedAt,
  });
}

async function markRunningTaskCancelled(
  db: DbClient,
  bindingId: string,
  running: BindingRunningTask,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  if (running.kind === 'sync') {
    await updateSyncLog(db, {
      id: running.logId,
      bindingId,
      trigger: running.trigger as 'git' | 'schedule' | 'manual' | 'bot',
      status: 'failed',
      message: BINDING_TASK_PREEMPTED_MESSAGE,
      startedAt: running.startedAt,
      finishedAt,
    });
    return;
  }

  await updateCommentImportLog(db, {
    id: running.logId,
    bindingId,
    trigger: running.trigger as 'schedule' | 'manual' | 'bot',
    status: 'failed',
    message: BINDING_TASK_PREEMPTED_MESSAGE,
    startedAt: running.startedAt,
    finishedAt,
  });
}
