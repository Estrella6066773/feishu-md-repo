import type { DbClient } from '@feishu-md/db';
import { updateCommentImportLog, updateSyncLog } from '@feishu-md/db';
import { BINDING_TASK_PREEMPTED_MESSAGE } from '@feishu-md/core';
import type { BindingRunningTask, BindingTaskRegistry } from './binding-task-registry.js';
import type { QueuedBindingTask, SyncQueue } from './scheduler.js';

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
  for (const task of cancelledPending) {
    await markQueuedTaskCancelled(db, task);
  }

  const running = registry.getRunning(bindingId);
  if (running && registry.isStale(bindingId, running.generation)) {
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
