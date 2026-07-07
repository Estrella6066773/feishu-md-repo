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
import { runSync } from '@feishu-md/core';
import { createGitProvider, fetchRemoteForSync } from '@feishu-md/git';
import type { SyncQueue } from './scheduler.js';
import type { BotBroadcaster } from './bot/broadcaster.js';

const coordLog = createLogger('sync-coordinator');

export class SyncCoordinator {
  constructor(
    private db: DbClient,
    private queue: SyncQueue,
    private broadcaster: BotBroadcaster,
  ) {}

  enqueueBindingSync(bindingId: string, trigger: SyncTriggerType, fullResync = false): string {
    const logId = randomUUID();
    const startedAt = new Date().toISOString();

    void insertSyncLog(this.db, {
      id: logId,
      bindingId,
      trigger,
      status: 'pending',
      message: fullResync ? '完全重新搭建排队中' : '同步排队中',
      startedAt,
    });

    coordLog.info('同步任务入队', {
      bindingId,
      logId,
      trigger,
      queueDepth: this.queue.getQueueDepth(),
      fullResync: fullResync === true,
    });

    this.queue.enqueue(async () => {
      const log = coordLog.child({ bindingId, logId, trigger });
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error('同步任务失败', undefined, error);
        await this.broadcaster.notifySyncFinished({
          binding,
          trigger,
          success: false,
          errorMessage,
        });
        throw error;
      }
    });

    return logId;
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
