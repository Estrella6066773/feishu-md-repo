import type { SyncLogEntry } from '@feishu-md/shared';
import {
  formatLocaleDateTime,
  formatShortSha,
  resolveBindingDisplayName,
  SYNC_JOB_STATUS_LABELS,
  SYNC_JOB_STATUS_LABELS_SHORT,
  SYNC_JOB_STATUS_TONES,
  SYNC_LOG_TRIGGER_LABELS,
  formatSyncProgressText,
} from '@feishu-md/shared';
import { Badge } from '@/components/ui/Badge';
import { SyncProgressBar } from '@/components/SyncProgressBar';

export interface SyncLogTableProps {
  logs: SyncLogEntry[];
  bindingMap: ReadonlyMap<string, string>;
  showProgress?: boolean;
  compactTime?: boolean;
  wrapClassName?: string;
}

export function SyncLogTable({
  logs,
  bindingMap,
  showProgress = false,
  compactTime = false,
  wrapClassName = 'data-table-wrap',
}: SyncLogTableProps) {
  const statusLabels = compactTime ? SYNC_JOB_STATUS_LABELS_SHORT : SYNC_JOB_STATUS_LABELS;

  return (
    <div className={wrapClassName}>
      <table className="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>绑定</th>
            <th>触发</th>
            <th>状态</th>
            {showProgress ? <th>进度</th> : null}
            <th>Commit</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td className={compactTime ? undefined : 'whitespace-nowrap'}>
                {formatLocaleDateTime(log.startedAt, compactTime)}
              </td>
              <td>{resolveBindingDisplayName(bindingMap, log.bindingId)}</td>
              <td>{SYNC_LOG_TRIGGER_LABELS[log.trigger]}</td>
              <td>
                <Badge tone={SYNC_JOB_STATUS_TONES[log.status]}>{statusLabels[log.status]}</Badge>
              </td>
              {showProgress ? (
                <td className="min-w-[10rem] max-w-xs">
                  {log.status === 'running' || log.status === 'pending' ? (
                    <SyncProgressBar log={log} compact />
                  ) : (
                    <span className="text-muted text-xs">{formatSyncProgressText(log) ?? '—'}</span>
                  )}
                </td>
              ) : null}
              <td className="font-mono text-xs">{formatShortSha(log.toSha)}</td>
              <td className="max-w-xs truncate text-muted" title={log.message ?? undefined}>
                {log.message ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
