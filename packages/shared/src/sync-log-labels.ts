import type { SyncJobStatus, SyncTriggerType } from './types.js';
import { SYNC_TRIGGER_LABELS } from './broadcast-policy.js';

/** 同步日志表格：触发来源展示（与播报策略文案一致） */
export { SYNC_TRIGGER_LABELS as SYNC_LOG_TRIGGER_LABELS };

export const SYNC_JOB_STATUS_LABELS: Record<SyncJobStatus, string> = {
  pending: '排队中',
  running: '进行中',
  success: '成功',
  failed: '失败',
};

/** 仪表盘等紧凑场景下的状态文案 */
export const SYNC_JOB_STATUS_LABELS_SHORT: Record<SyncJobStatus, string> = {
  pending: '排队',
  running: '进行中',
  success: '成功',
  failed: '失败',
};

export type SyncJobStatusBadgeTone = 'default' | 'blue' | 'green' | 'amber' | 'red';

export const SYNC_JOB_STATUS_TONES: Record<SyncJobStatus, SyncJobStatusBadgeTone> = {
  pending: 'amber',
  running: 'blue',
  success: 'green',
  failed: 'red',
};

export function resolveBindingDisplayName(
  bindingMap: ReadonlyMap<string, string>,
  bindingId: string,
): string {
  return bindingMap.get(bindingId) ?? bindingId.slice(0, 8);
}

export function formatShortSha(sha?: string): string {
  return sha?.slice(0, 7) ?? '—';
}

export function formatLocaleDateTime(value: string, compact = false): string {
  if (compact) {
    return new Date(value).toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return new Date(value).toLocaleString();
}

export function syncTriggerLabel(trigger: SyncTriggerType): string {
  return SYNC_TRIGGER_LABELS[trigger];
}
