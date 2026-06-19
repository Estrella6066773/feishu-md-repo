import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { IconLogs } from '@/components/icons';
import { LoadingBlock } from '@/components/ui/Spinner';
import type { SyncJobStatus } from '@feishu-md/shared';
import { fetchBindings, fetchSyncLogs } from '@/lib/queries';

const triggerLabel = {
  git: 'Git 事件',
  schedule: '定时',
  manual: '手动',
  bot: '飞书指令',
} as const;

const statusLabel = {
  pending: '排队中',
  running: '进行中',
  success: '成功',
  failed: '失败',
} as const;

const statusTone = {
  pending: 'amber',
  running: 'blue',
  success: 'green',
  failed: 'red',
} as const;

type StatusFilter = 'all' | SyncJobStatus;

export function LogsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [bindingFilter, setBindingFilter] = useState<string>('all');

  const bindings = useQuery({ queryKey: ['bindings'], queryFn: fetchBindings });
  const logs = useQuery({ queryKey: ['sync-logs'], queryFn: () => fetchSyncLogs(), refetchInterval: 10_000 });

  const bindingMap = useMemo(
    () => new Map((bindings.data ?? []).map((b) => [b.id, b.name])),
    [bindings.data],
  );

  const filteredLogs = useMemo(() => {
    return (logs.data ?? []).filter((log) => {
      if (statusFilter !== 'all' && log.status !== statusFilter) return false;
      if (bindingFilter !== 'all' && log.bindingId !== bindingFilter) return false;
      return true;
    });
  }, [logs.data, statusFilter, bindingFilter]);

  const filters: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'success', label: '成功' },
    { id: 'failed', label: '失败' },
    { id: 'running', label: '进行中' },
    { id: 'pending', label: '排队' },
  ];

  return (
    <div className="page-stack-lg">
      <PageHeader title="同步日志" description="查看最近 100 条同步任务，可按状态与绑定筛选。" />

      <div className="filter-toolbar">
        <div className="filter-bar">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={`filter-chip ${statusFilter === filter.id ? 'filter-chip-active' : ''}`}
              onClick={() => setStatusFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <select
          className="field-input max-w-xs"
          value={bindingFilter}
          onChange={(e) => setBindingFilter(e.target.value)}
        >
          <option value="all">全部绑定</option>
          {(bindings.data ?? []).map((binding) => (
            <option key={binding.id} value={binding.id}>
              {binding.name}
            </option>
          ))}
        </select>
      </div>

      {logs.isLoading ? (
        <LoadingBlock label="加载日志…" />
      ) : filteredLogs.length === 0 ? (
        <EmptyState
          icon={<IconLogs className="h-10 w-10" />}
          title="暂无匹配记录"
          description={
            (logs.data ?? []).length === 0
              ? '触发首次同步后，记录将显示在这里。'
              : '尝试切换筛选条件查看其他记录。'
          }
        />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>绑定</th>
                <th>触发</th>
                <th>状态</th>
                <th>Commit</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => (
                <tr key={log.id}>
                  <td className="whitespace-nowrap">{new Date(log.startedAt).toLocaleString()}</td>
                  <td>{bindingMap.get(log.bindingId) ?? log.bindingId.slice(0, 8)}</td>
                  <td>{triggerLabel[log.trigger]}</td>
                  <td>
                    <Badge tone={statusTone[log.status]}>{statusLabel[log.status]}</Badge>
                  </td>
                  <td className="font-mono text-xs">{log.toSha?.slice(0, 7) ?? '—'}</td>
                  <td className="max-w-xs truncate text-muted" title={log.message ?? undefined}>
                    {log.message ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
