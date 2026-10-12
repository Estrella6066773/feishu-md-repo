import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import {
  IconConsole,
  IconDashboard,
  IconFeishu,
  IconLink,
  IconLogs,
  IconSettings,
  IconSidebar,
  IconToolbox,
} from '@/components/icons';
import { BotConnectionBadge, CoreServiceConnectionBadge } from '@/components/ConnectionStatusBadge';
import { useHealthQuery, useServiceOnline, useSettingsQuery } from '@/hooks/useCoreQueries';

const navItems = [
  { to: '/', label: '仪表盘', end: true, icon: IconDashboard, desc: '服务状态与概览' },
  { to: '/bindings', label: '绑定管理', icon: IconLink, desc: 'Git 与飞书目标' },
  { to: '/logs', label: '同步日志', icon: IconLogs, desc: '历史同步记录' },
  { to: '/console', label: '控制台', icon: IconConsole, desc: '后台实时输出' },
  { to: '/toolbox', label: '飞书工具箱', icon: IconToolbox, desc: '文档导出与图表格式化' },
  { to: '/settings', label: '设置', icon: IconSettings, desc: '机器人凭证与播报' },
] as const;

/** 刷新后仍保持折叠。读失败（隐私模式等）时按展开处理，不阻断页面。 */
const SIDEBAR_COLLAPSED_KEY = 'feishu-md-sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

const pageMeta: Record<string, { title: string; desc: string }> = {
  '/': { title: '仪表盘', desc: '查看核心服务、绑定与最近同步情况' },
  '/bindings': { title: '绑定管理', desc: '配置 Git 来源、同步模式与飞书 Wiki / Drive 目标' },
  '/logs': { title: '同步日志', desc: '最近 100 条同步任务记录' },
  '/console': { title: '控制台', desc: '实时查看本机服务输出' },
  '/toolbox': { title: '飞书工具箱', desc: '文档导出与 Mermaid 图表格式化' },
  '/settings': { title: '设置', desc: '机器人凭证、播报与指令监听' },
};

export function AppShell() {
  const location = useLocation();
  const meta = pageMeta[location.pathname] ?? { title: 'Feishu MD Repo', desc: '' };
  const health = useHealthQuery();
  const settings = useSettingsQuery();
  const serviceOnline = useServiceOnline(health);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);

  /**
   * 折叠只改侧栏宽度和文案显隐，NavLink 的 to 不变，图标仍走同一套路由。
   * 按钮放在标题文字外侧：收起后标题被藏掉，按钮还在，才能再展开。
   */
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // 写不进去时本次会话仍切换，只是刷新后回到展开。
      }
      return next;
    });
  };

  return (
    <div className="app-shell">
      <aside className={collapsed ? 'sidebar sidebar-collapsed' : 'sidebar'}>
        <div className="sidebar-brand">
          <IconFeishu />
          <div className="sidebar-brand-text">
            <div className="sidebar-title">Feishu MD Repo</div>
            <div className="sidebar-subtitle">Git ↔ 飞书 本地同步</div>
          </div>
          <button
            type="button"
            className="sidebar-collapse"
            aria-pressed={collapsed}
            aria-label={collapsed ? '展开左侧目录' : '折叠左侧目录'}
            title={collapsed ? '展开左侧目录' : '折叠左侧目录'}
            onClick={toggleCollapsed}
          >
            <IconSidebar className={collapsed ? 'h-4 w-4 sidebar-collapse-icon-open' : 'h-4 w-4'} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={'end' in item ? item.end : undefined}
                title={collapsed ? item.label : undefined}
                aria-label={item.label}
                className={({ isActive }) =>
                  ['nav-link', isActive ? 'nav-link-active' : ''].filter(Boolean).join(' ')
                }
              >
                <span className="nav-link-icon">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="nav-link-label">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <CoreServiceConnectionBadge online={serviceOnline} visual="dot" />
          {settings.data?.bot?.enabled ? (
            <BotConnectionBadge
              connected={settings.data?.botConnection?.connected}
              listening={settings.data?.botConnection?.listening}
              visual="dot"
            />
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
