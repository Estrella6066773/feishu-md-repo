import { Badge } from '@/components/ui/Badge';

export type ConnectionVisual = 'dot' | 'badge';

export interface ConnectionStatusBadgeProps {
  connected?: boolean;
  listening?: boolean;
  label: string;
  visual?: ConnectionVisual;
}

function resolveTone(connected?: boolean, listening?: boolean): 'green' | 'amber' | 'default' {
  if (connected) return 'green';
  if (listening) return 'amber';
  return 'default';
}

function resolveText(connected?: boolean, listening?: boolean, label?: string): string {
  if (connected) return label ? `${label}已连接` : '已连接';
  if (listening) return label ? `${label}连接中` : '连接中';
  return label ? `${label}未启动` : '未启动';
}

export function ConnectionStatusBadge({
  connected,
  listening,
  label,
  visual = 'badge',
}: ConnectionStatusBadgeProps) {
  if (visual === 'dot') {
    const dotClass = connected
      ? 'status-dot-online'
      : listening
        ? 'status-dot-warning'
        : 'status-dot-offline';
    return (
      <div className="status-pill">
        <span className={`status-dot ${dotClass}`} />
        {label} {connected ? '在线' : listening ? '连接中' : '离线'}
      </div>
    );
  }

  return <Badge tone={resolveTone(connected, listening)}>{resolveText(connected, listening, label)}</Badge>;
}

export function BotConnectionBadge(props: {
  connected?: boolean;
  listening?: boolean;
  visual?: ConnectionVisual;
}) {
  return (
    <ConnectionStatusBadge
      connected={props.connected}
      listening={props.listening}
      label="机器人"
      visual={props.visual}
    />
  );
}

export function CoreServiceConnectionBadge(props: {
  online: boolean;
  visual?: ConnectionVisual;
}) {
  if (props.visual === 'dot') {
    return (
      <div className="status-pill">
        <span className={`status-dot ${props.online ? 'status-dot-online' : 'status-dot-offline'}`} />
        核心服务 {props.online ? '在线' : '离线'}
      </div>
    );
  }
  return <Badge tone={props.online ? 'green' : 'default'}>{props.online ? '运行中' : '未连接'}</Badge>;
}
