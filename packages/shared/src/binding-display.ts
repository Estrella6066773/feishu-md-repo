import type { Binding, SyncLogEntry } from './types.js';
import { formatLocaleDateTime, formatShortSha } from './sync-log-labels.js';
import { SYNC_JOB_STATUS_TONES } from './sync-log-labels.js';

export function formatBindingLastSyncLine(binding: Binding): string {
  if (!binding.lastSyncedSha) {
    return '尚未同步';
  }
  const at = binding.lastSyncedAt ? formatLocaleDateTime(binding.lastSyncedAt) : '';
  return `最近 ${formatShortSha(binding.lastSyncedSha)}${at ? ` · ${at}` : ''}`;
}

export function formatBindingStatusLine(binding: Binding): string {
  const sha = binding.lastSyncedSha ? formatShortSha(binding.lastSyncedSha) : '未同步';
  const at = binding.lastSyncedAt ? formatLocaleDateTime(binding.lastSyncedAt) : '-';
  const source = binding.sourceType === 'cloud' ? '有云' : '本地';
  return `• ${binding.name}（${source} / ${binding.syncMode}）最近：${sha} @ ${at}`;
}

export function latestSyncStatusBadgeTone(
  log: SyncLogEntry | undefined,
): 'red' | 'green' | 'amber' | 'blue' | undefined {
  if (!log) return undefined;
  if (log.status === 'failed') return 'red';
  if (log.status === 'success') return 'green';
  if (log.status === 'running' || log.status === 'pending') return 'amber';
  return SYNC_JOB_STATUS_TONES[log.status] === 'default'
    ? undefined
    : SYNC_JOB_STATUS_TONES[log.status];
}

export function latestSyncStatusBadgeLabel(log: SyncLogEntry | undefined): string | null {
  if (!log) return null;
  if (log.status === 'failed') return '最近失败';
  if (log.status === 'success') return '最近成功';
  if (log.status === 'running' || log.status === 'pending') return '同步中';
  return null;
}
