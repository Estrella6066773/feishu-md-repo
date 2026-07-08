import { formatSyncProgressText, syncProgressPercent, type SyncLogEntry } from '@feishu-md/shared';

interface SyncProgressBarProps {
  log: Pick<
    SyncLogEntry,
    'status' | 'progressPhase' | 'progressDone' | 'progressTotal' | 'currentGitPath'
  >;
  compact?: boolean;
}

export function SyncProgressBar({ log, compact = false }: SyncProgressBarProps) {
  if (log.status !== 'running' && log.status !== 'pending') {
    return null;
  }

  const label = formatSyncProgressText(log);
  const percent = syncProgressPercent(log);

  if (!label) {
    return null;
  }

  return (
    <div className={`sync-progress ${compact ? 'sync-progress-compact' : ''}`}>
      {percent != null ? (
        <div className="sync-progress-track" aria-hidden>
          <div className="sync-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <div className="sync-progress-label" title={label}>
        {label}
      </div>
    </div>
  );
}
