import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { IconLink, IconLogs, IconSettings, IconSync } from '@/components/icons';
import { LoadingBlock } from '@/components/ui/Spinner';
import { fetchBindings, fetchHealth, fetchSettings, fetchSyncLogs } from '@/lib/queries';

const triggerLabel = {
  git: 'Git',
  schedule: '定时',
  manual: '手动',
  bot: '指令',
} as const;

const statusTone = {
  pending: 'amber',
  running: 'blue',
  success: 'green',
  failed: 'red',
} as const;

const statusText = {
  pending: '排队',
  running: '进行中',
  success: '成功',
  failed: '失败',
} as const;

export function DashboardPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: 1, refetchInterval: 15_000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const bindings = useQuery({ queryKey: ['bindings'], queryFn: fetchBindings });
  const logs = useQuery({ queryKey: ['sync-logs'], queryFn: () => fetchSyncLogs(), refetchInterval: 15_000 });

  const bindingMap = new Map((bindings.data ?? []).map((b) => [b.id, b.name]));
  const recentLogs = (logs.data ?? []).slice(0, 8);
  const recentFailures = (logs.data ?? []).filter((log) => log.status === 'failed').length;
  const recentSuccess = (logs.data ?? []).filter((log) => log.status === 'success').length;
  const serviceOnline = !health.isError && health.data?.ok;

  return (
    <div className="page-stack-lg">
      {!serviceOnline ? (
        <Alert tone="danger" title="核心服务未连接">
          请先运行 <code>pnpm dev:service</code>，或通过 Tauri 桌面应用启动 Sidecar。UI 无法在未连接时执行同步。
        </Alert>
      ) : null}

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
              <table className="data-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>绑定</th>
                    <th>触发</th>
                    <th>状态</th>
                    <th>Commit</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{formatTime(log.startedAt)}</td>
                      <td>{bindingMap.get(log.bindingId) ?? log.bindingId.slice(0, 8)}</td>
                      <td>{triggerLabel[log.trigger]}</td>
                      <td>
                        <Badge tone={statusTone[log.status]}>{statusText[log.status]}</Badge>
                      </td>
                      <td className="font-mono text-xs">{log.toSha?.slice(0, 7) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                <Badge
                  tone={
                    settings.data?.botConnection?.connected
                      ? 'green'
                      : settings.data?.botConnection?.listening
                        ? 'amber'
                        : 'default'
                  }
                >
                  {settings.data?.botConnection?.connected
                    ? '已连接'
                    : settings.data?.botConnection?.listening
                      ? '连接中'
                      : '未启动'}
                </Badge>
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
                <div className="binding-meta">
                  {binding.lastSyncedSha
                    ? `最近 ${binding.lastSyncedSha.slice(0, 7)} · ${binding.lastSyncedAt ? formatTime(binding.lastSyncedAt) : ''}`
                    : '尚未同步'}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
