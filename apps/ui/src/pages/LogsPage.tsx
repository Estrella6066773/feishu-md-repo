import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SyncJobStatus } from '@feishu-md/shared';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { SyncLogTable } from '@/components/SyncLogTable';
import { IconLogs } from '@/components/icons';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useBindingNameMap } from '@/hooks/useBindingMaps';
import { useBindingsQuery } from '@/hooks/useCoreQueries';
import { queryKeys } from '@/hooks/queryKeys';
import { fetchSyncLogs } from '@/lib/queries';

type StatusFilter = 'all' | SyncJobStatus;

export function LogsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [bindingFilter, setBindingFilter] = useState<string>('all');

  const bindings = useBindingsQuery();
  const logs = useQuery({
    queryKey: queryKeys.syncLogs,
    queryFn: () => fetchSyncLogs(),
    refetchInterval: (query) => {
      const hasActive = (query.state.data ?? []).some(
        (log) => log.status === 'running' || log.status === 'pending',
      );
      return hasActive ? 1_000 : 10_000;
    },
  });

  const bindingMap = useBindingNameMap(bindings.data);

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
        <SyncLogTable logs={filteredLogs} bindingMap={bindingMap} showProgress />
      )}
    </div>
  );
}
