import type { DbClient } from '@feishu-md/db';
import { getBinding, insertSyncLog, updateSyncLog } from '@feishu-md/db';
import {
  createLogger,
  shouldForceUpdateForTrigger,
  type RepositoryOptions,
  type SyncTriggerType,
  type WorkspaceOptions,
} from '@feishu-md/shared';
import { randomUUID } from 'node:crypto';
import {
  BindingTaskPreemptedError,
  BINDING_TASK_PREEMPTED_MESSAGE,
  runSync,
} from '@feishu-md/core';
import { createGitProvider, fetchRemoteForSync } from '@feishu-md/git';
import type { BindingTaskRegistry } from './binding-task-registry.js';
import { isManualPreemptTrigger, markQueuedTaskCancelled, preemptBindingTasks } from './binding-task-preempt.js';
import type { QueuedBindingTask, SyncQueue } from './scheduler.js';
import type { BotBroadcaster } from './bot/broadcaster.js';

const coordLog = createLogger('sync-coordinator');

export class SyncCoordinator {
  constructor(
    private db: DbClient,
    private queue: SyncQueue,
    private broadcaster: BotBroadcaster,
    private registry: BindingTaskRegistry,
  ) {}

  enqueueBindingSync(bindingId: string, trigger: SyncTriggerType, fullResync = false): string {
    const logId = randomUUID();
    const startedAt = new Date().toISOString();
    const preempt = isManualPreemptTrigger(trigger);

    void insertSyncLog(this.db, {
      id: logId,
      bindingId,
      trigger,
      status: 'pending',
      message: fullResync ? '完全重新搭建排队中' : preempt ? '同步准备中' : '同步排队中',
      startedAt,
    });

    coordLog.info('同步任务入队', {
      bindingId,
      logId,
      trigger,
      queueDepth: this.queue.getQueueDepth(),
      fullResync: fullResync === true,
      preempt,
    });

    void this.scheduleBindingSync({
      bindingId,
      logId,
      trigger,
      startedAt,
      fullResync,
      preempt,
    });

    return logId;
  }

  private async scheduleBindingSync(options: {
    bindingId: string;
    logId: string;
    trigger: SyncTriggerType;
    startedAt: string;
    fullResync: boolean;
    preempt: boolean;
  }): Promise<void> {
    const { bindingId, logId, trigger, startedAt, fullResync, preempt } = options;
    let generation = this.registry.getGeneration(bindingId);
    if (preempt) {
      generation = await preemptBindingTasks(this.db, this.registry, this.queue, bindingId);
    }

    const task: QueuedBindingTask = {
      bindingId,
      logId,
      kind: 'sync',
      trigger,
      startedAt,
      generation,
      run: async () => {
        await this.runBindingSyncTask({
          bindingId,
          logId,
          trigger,
          startedAt,
          generation,
          fullResync,
        });
      },
    };

    this.queue.enqueue(task, { front: preempt });
  }

  private async runBindingSyncTask(options: {
    bindingId: string;
    logId: string;
    trigger: SyncTriggerType;
    startedAt: string;
    generation: number;
    fullResync: boolean;
  }): Promise<void> {
    const { bindingId, logId, trigger, startedAt, generation, fullResync } = options;
    const log = coordLog.child({ bindingId, logId, trigger });
    const shouldAbort = () => this.registry.isStale(bindingId, generation);

    if (shouldAbort()) {
      await markQueuedTaskCancelled(this.db, {
        bindingId,
        logId,
        kind: 'sync',
        trigger,
        startedAt,
        generation,
        run: async () => {},
      });
      return;
    }

    this.registry.registerRunning(bindingId, {
      logId,
      kind: 'sync',
      generation,
      trigger,
      startedAt,
    });

    const binding = await getBinding(this.db, bindingId);
    if (!binding) {
      const message = `Binding not found: ${bindingId}`;
      await updateSyncLog(this.db, {
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

    try {
      if (trigger === 'schedule' && !fullResync) {
        const git = createGitProvider(
          {
            repoPath: binding.repoPath,
            branch: binding.branch,
            remoteUrl: binding.remoteUrl,
          },
          binding.sourceType,
        );

        if (binding.sourceType === 'cloud') {
          await fetchRemoteForSync(git);
        }

        const latestSha = await git.getHeadSha();
        if (
          binding.lastSyncedSha &&
          latestSha === binding.lastSyncedSha &&
          !hasForceUpdateGlobs(binding, trigger)
        ) {
          await updateSyncLog(this.db, {
            id: logId,
            bindingId,
            trigger,
            toSha: latestSha,
            status: 'success',
            message: '定时检查：无更新，已跳过同步',
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          log.info('定时检查无更新，跳过同步', { toSha: latestSha });
          return;
        }
      }

      const result = await runSync({
        binding,
        db: this.db,
        trigger,
        fullResync,
        repairMissingRemote: trigger === 'manual' || trigger === 'bot',
        logId,
        shouldAbort,
      });
      log.info('同步任务完成', {
        toSha: result.toSha,
        operationCount: result.operationCount,
      });
      await this.broadcaster.notifySyncFinished({
        binding,
        trigger,
        success: true,
        result,
      });
    } catch (error) {
      if (error instanceof BindingTaskPreemptedError || shouldAbort()) {
        log.info('同步任务已被新的手动指令打断', { logId });
        await updateSyncLog(this.db, {
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
      log.error('同步任务失败', undefined, error);
      await this.broadcaster.notifySyncFinished({
        binding,
        trigger,
        success: false,
        errorMessage,
      });
      throw error;
    } finally {
      this.registry.unregisterRunning(bindingId, logId);
    }
  }
}

function hasForceUpdateGlobs(
  binding: Awaited<ReturnType<typeof getBinding>>,
  trigger: SyncTriggerType,
): boolean {
  if (!binding) return false;
  const options =
    binding.syncMode === 'workspace'
      ? (binding.options as WorkspaceOptions)
      : (binding.options as RepositoryOptions);
  if (!shouldForceUpdateForTrigger(options.forceUpdateMode, trigger)) return false;
  return (options.forceUpdateGlobs ?? []).some((glob) => glob.trim());
}
