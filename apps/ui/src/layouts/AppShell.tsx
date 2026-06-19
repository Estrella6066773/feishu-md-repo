import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  IconDashboard,
  IconFeishu,
  IconLink,
  IconLogs,
  IconSettings,
} from '@/components/icons';
import { fetchHealth, fetchSettings } from '@/lib/queries';

const navItems = [
  { to: '/', label: '仪表盘', end: true, icon: IconDashboard, desc: '服务状态与概览' },
  { to: '/bindings', label: '绑定管理', icon: IconLink, desc: 'Git 与飞书目标' },
  { to: '/logs', label: '同步日志', icon: IconLogs, desc: '历史同步记录' },
  { to: '/settings', label: '设置', icon: IconSettings, desc: '凭证与机器人' },
] as const;

const pageMeta: Record<string, { title: string; desc: string }> = {
  '/': { title: '仪表盘', desc: '查看核心服务、绑定与最近同步情况' },
  '/bindings': { title: '绑定管理', desc: '配置 Git 来源、同步模式与飞书 Wiki / Drive 目标' },
  '/logs': { title: '同步日志', desc: '最近 100 条同步任务记录' },
  '/settings': { title: '设置', desc: '飞书应用凭证、播报与指令监听' },
};

export function AppShell() {
  const location = useLocation();
  const meta = pageMeta[location.pathname] ?? { title: 'Feishu MD Repo', desc: '' };
  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: 1,
    refetchInterval: 30_000,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });

  const serviceOnline = !health.isError && health.data?.ok;
  const botConnected = settings.data?.botConnection?.connected;
  const botListening = settings.data?.botConnection?.listening;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <IconFeishu />
          <div className="sidebar-brand-text">
            <div className="sidebar-title">Feishu MD Repo</div>
            <div className="sidebar-subtitle">Git ↔ 飞书 本地同步</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={'end' in item ? item.end : undefined}
                className={({ isActive }) =>
                  ['nav-link', isActive ? 'nav-link-active' : ''].filter(Boolean).join(' ')
                }
              >
                <span className="nav-link-icon">
                  <Icon className="h-4 w-4" />
                </span>
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="status-pill">
            <span
              className={`status-dot ${serviceOnline ? 'status-dot-online' : 'status-dot-offline'}`}
            />
            核心服务 {serviceOnline ? '在线' : '离线'}
          </div>
          {settings.data?.bot?.enabled ? (
            <div className="status-pill">
              <span
                className={`status-dot ${
                  botConnected
                    ? 'status-dot-online'
                    : botListening
                      ? 'status-dot-warning'
                      : 'status-dot-offline'
                }`}
              />
              机器人 {botConnected ? '已连接' : botListening ? '连接中' : '未启动'}
            </div>
          ) : null}
        </div>
      </aside>

      <div className="main-panel">
        <header className="main-header">
          <div className="main-header-title">{meta.title}</div>
          <div className="main-header-desc">{meta.desc}</div>
        </header>
        <div className="main-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
