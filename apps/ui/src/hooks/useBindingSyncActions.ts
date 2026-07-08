import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyncLogEntry } from '@feishu-md/shared';
import {
  triggerCommentImportAndWait,
  triggerSyncAndWait,
} from '@/lib/queries';
import { queryKeys } from './queryKeys';

export type TaskNoticeTone = 'success' | 'danger' | 'warning';

export interface TaskNotice {
  tone: TaskNoticeTone;
  title: string;
  message: string;
}

function deriveSyncNotice(
  log: SyncLogEntry,
  options: { fullResync?: boolean; forceRewriteAll?: boolean },
): TaskNotice {
  if (log.status === 'failed') {
    return {
      tone: 'danger',
      title: '同步失败',
      message: log.message ?? '未知错误，请查看同步日志',
    };
  }
  if (log.message?.includes('无内容变更')) {
    return {
      tone: 'warning',
      title: '同步完成',
      message: log.message,
    };
  }
  return {
    tone: 'success',
    title: options.forceRewriteAll
      ? '强制重写成功'
      : options.fullResync
        ? '修复同步成功'
        : '同步成功',
    message: log.message ?? '已完成',
  };
}

export function useBindingSyncActions() {
  const queryClient = useQueryClient();
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [importingCommentsId, setImportingCommentsId] = useState<string | null>(null);
  const [taskNotice, setTaskNotice] = useState<TaskNotice | null>(null);

  const invalidateAfterTask = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.syncLogs });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bindings });
  };

  const syncMutation = useMutation({
    mutationFn: ({
      id,
      fullResync,
      forceRewriteAll,
    }: {
      id: string;
      fullResync?: boolean;
      forceRewriteAll?: boolean;
    }) => triggerSyncAndWait(id, fullResync ?? false, forceRewriteAll ?? false),
    onMutate: ({ id }) => setSyncingId(id),
    onSettled: () => setSyncingId(null),
    onSuccess: (log, variables) => {
      setTaskNotice(deriveSyncNotice(log, variables));
      invalidateAfterTask();
    },
    onError: (error) => {
      setTaskNotice({
        tone: 'danger',
        title: '同步失败',
        message: error instanceof Error ? error.message : '触发同步失败',
      });
    },
  });

  const commentImportMutation = useMutation({
    mutationFn: (id: string) => triggerCommentImportAndWait(id),
    onMutate: (id) => setImportingCommentsId(id),
    onSettled: () => setImportingCommentsId(null),
    onSuccess: (log) => {
      if (log.status === 'failed') {
        setTaskNotice({
          tone: 'danger',
          title: '评论导入失败',
          message: log.message ?? '未知错误',
        });
      } else {
        setTaskNotice({
          tone: 'success',
          title: '评论导入成功',
          message: log.message ?? '已完成',
        });
      }
    },
    onError: (error) => {
      setTaskNotice({
        tone: 'danger',
        title: '评论导入失败',
        message: error instanceof Error ? error.message : '触发评论导入失败',
      });
    },
  });

  return {
    syncingId,
    importingCommentsId,
    taskNotice,
    clearTaskNotice: () => setTaskNotice(null),
    syncMutation,
    commentImportMutation,
  };
}
