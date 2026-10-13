import { formatSyncProgressText, syncProgressPercent, type SyncLogEntry } from '@feishu-md/shared';

interface SyncProgressBarProps {
  log: Pick<
    SyncLogEntry,
    'status' | 'progressPhase' | 'progressDone' | 'progressTotal' | 'currentGitPath' | 'currentDocumentUrl'
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

  const path = log.currentGitPath?.replace(/\\/g, '/');
  const url = log.currentDocumentUrl;
  // 文案以路径结尾时，只把路径换成链接。没有飞书地址的文档仍显示整句纯文本。
  const linkPath = Boolean(path && url && label.endsWith(path));
  const prefix = linkPath && path ? label.slice(0, label.length - path.length) : label;

  return (
    <div className={`sync-progress ${compact ? 'sync-progress-compact' : ''}`}>
      {percent != null ? (
        <div className="sync-progress-track" aria-hidden>
          <div className="sync-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <div className="sync-progress-label" title={label}>
        {linkPath && path && url ? (
          <>
            {prefix}
            <a className="sync-progress-link" href={url} target="_blank" rel="noopener noreferrer">
              {path}
            </a>
          </>
        ) : (
          label
        )}
      </div>
    </div>
  );
}
