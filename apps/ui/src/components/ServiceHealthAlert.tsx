import type { CoreHealthPayload } from '@feishu-md/shared';
import { isCoreServiceCompatible } from '@feishu-md/shared';
import { Alert } from '@/components/ui/Alert';

export interface ServiceHealthAlertProps {
  healthError?: boolean;
  healthLoading?: boolean;
  health?: CoreHealthPayload | null;
  /** 仪表盘：未连接时提示无法同步；设置页：仅版本过旧 */
  variant?: 'dashboard' | 'settings';
}

export function ServiceHealthAlert({
  healthError,
  healthLoading,
  health,
  variant = 'dashboard',
}: ServiceHealthAlertProps) {
  if (healthLoading) {
    return null;
  }

  if (variant === 'dashboard' && healthError) {
    return (
      <Alert tone="danger" title="核心服务未连接">
        请先运行 <code>pnpm dev:service</code>，或通过 Tauri 桌面应用启动 Sidecar。UI 无法在未连接时执行同步。
      </Alert>
    );
  }

  if (variant === 'settings' && healthError) {
    return (
      <Alert tone="danger" title="无法连接核心服务">
        请先运行 <code>pnpm dev:service</code>（默认 http://127.0.0.1:8787）。
      </Alert>
    );
  }

  if (health && !isCoreServiceCompatible(health)) {
    return (
      <Alert tone="danger" title="核心服务版本过旧">
        {variant === 'settings' ? (
          <>
            当前 8787 端口上的 core-service 缺少新版 API（保存机器人/用户权限会 404）。请结束旧进程后重新运行{' '}
            <code>pnpm dev:service</code>，并刷新本页。Windows 查占用：<code>netstat -ano | findstr :8787</code>
          </>
        ) : (
          <>
            8787 端口上的进程缺少新版 API。请结束旧进程后重新运行 <code>pnpm dev:service</code> 并刷新页面。
          </>
        )}
      </Alert>
    );
  }

  return null;
}
