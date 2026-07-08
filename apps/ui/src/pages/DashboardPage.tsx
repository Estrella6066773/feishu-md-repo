import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatBindingLastSyncLine } from '@feishu-md/shared';
import { BotConnectionBadge } from '@/components/ConnectionStatusBadge';
import { ServiceHealthAlert } from '@/components/ServiceHealthAlert';
import { SyncLogTable } from '@/components/SyncLogTable';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { IconLink, IconLogs, IconSettings, IconSync } from '@/components/icons';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useBindingNameMap } from '@/hooks/useBindingMaps';
import { useBindingsQuery, useHealthQuery, useServiceOnline, useSettingsQuery } from '@/hooks/useCoreQueries';
import { queryKeys } from '@/hooks/queryKeys';
import { fetchSyncLogs } from '@/lib/queries';

export function DashboardPage() {
  const health = useHealthQuery(15_000);
  const settings = useSettingsQuery();
  const bindings = useBindingsQuery();
  const logs = useQuery({
    queryKey: queryKeys.syncLogs,
    queryFn: () => fetchSyncLogs(),
    refetchInterval: 15_000,
  });

  const bindingMap = useBindingNameMap(bindings.data);
  const recentLogs = (logs.data ?? []).slice(0, 8);
  const recentFailures = (logs.data ?? []).filter((log) => log.status === 'failed').length;
  const recentSuccess = (logs.data ?? []).filter((log) => log.status === 'success').length;
  const serviceOnline = useServiceOnline(health);

  return (
    <div className="page-stack-lg">
      <ServiceHealthAlert
        variant="dashboard"
        healthError={health.isError}
        healthLoading={health.isLoading}
        health={health.data}
      />

      <section className="stat-grid">
        <StatCard
          label="核心服务"
          value={health.isLoading ? '…' : serviceOnline ? '运行中' : '未连接'}
          tone={serviceOnline ? 'success' : 'danger'}
          hint={health.data?.version ? `v${health.data.version}` : undefined}
        />
        <StatCard
          label="同步绑定"
          value={bindings.isLoading ? '…' : String(bindings.data?.length ?? 0)}
          hint="已配置的 Git ↔ 飞书映射"
        />
        <StatCard
          label="最近成功"
          value={logs.isLoading ? '…' : String(recentSuccess)}
          tone="success"
          hint="最近 100 条记录内"
        />
        <StatCard
          label="最近失败"
          value={logs.isLoading ? '…' : String(recentFailures)}
          tone={recentFailures > 0 ? 'danger' : 'default'}
          hint={recentFailures > 0 ? '可在同步日志中查看详情' : '暂无失败记录'}
        />
      </section>

      <div className="layout-split">
        <Card>
          <CardHeader
            title="最近同步"
            description="最新 8 条任务记录"
            action={
              <Link to="/logs" className="link-accent">
                查看全部
              </Link>
            }
          />
          {logs.isLoading ? (
            <LoadingBlock />
          ) : recentLogs.length === 0 ? (
            <div className="card-empty">暂无同步记录，可在绑定管理中触发首次同步。</div>
          ) : (
            <div className="card-embedded-table">
              <SyncLogTable
                logs={recentLogs}
                bindingMap={bindingMap}
                compactTime
                wrapClassName=""
              />
            </div>
          )}
        </Card>

        <div className="layout-split-side">
          <Card>
            <CardHeader title="快捷入口" description="常用操作" />
            <div className="page-stack-sm">
              <Link to="/bindings" className="quick-link">
                <span className="quick-link-main">
                  <IconLink className="quick-link-icon" />
                  管理绑定
                </span>
                <span className="quick-link-label">新建 / 同步</span>
              </Link>
              <Link to="/logs" className="quick-link">
                <span className="quick-link-main">
                  <IconLogs className="quick-link-icon" />
                  同步日志
                </span>
                <span className="quick-link-label">排查失败</span>
              </Link>
              <Link to="/settings" className="quick-link">
                <span className="quick-link-main">
                  <IconSettings className="quick-link-icon" />
                  飞书设置
                </span>
                <span className="quick-link-label">
                  {settings.data?.feishu?.appSecretConfigured ? '已配置' : '待配置'}
                </span>
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader title="机器人" description="播报与指令监听" />
            <div className="page-stack-sm">
              <div className="kv-row">
                <span className="text-muted">功能开关</span>
                <Badge tone={settings.data?.bot?.enabled ? 'green' : 'default'}>
                  {settings.data?.bot?.enabled ? '已启用' : '未启用'}
                </Badge>
              </div>
              <div className="kv-row">
                <span className="text-muted">长连接</span>
                <BotConnectionBadge
                  connected={settings.data?.botConnection?.connected}
                  listening={settings.data?.botConnection?.listening}
                />
              </div>
              {!settings.data?.bot?.enabled ? (
                <p className="help-box !p-2">
                  在设置中启用机器人后，可接收「同步」指令并向群推送结果。
                </p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>

      {(bindings.data ?? []).length > 0 ? (
        <Card>
          <CardHeader
            title="绑定概览"
            description="各绑定最近同步状态"
            action={
              <Link to="/bindings">
                <span className="link-accent link-accent-with-icon">
                  <IconSync className="quick-link-icon" />
                  前往管理
                </span>
              </Link>
            }
          />
          <div className="mini-grid">
            {(bindings.data ?? []).slice(0, 4).map((binding) => (
              <div key={binding.id} className="mini-card">
                <div className="font-medium">{binding.name}</div>
                <div className="mini-card-badges">
                  <Badge tone="blue">{binding.syncMode === 'workspace' ? '工作区' : '仓库'}</Badge>
                  <Badge>{binding.feishuTarget.type === 'wiki' ? 'Wiki' : 'Drive'}</Badge>
                </div>
                <div className="binding-meta">{formatBindingLastSyncLine(binding)}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
