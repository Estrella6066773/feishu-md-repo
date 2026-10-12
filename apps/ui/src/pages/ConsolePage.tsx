import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { getApiBaseUrl } from '@/lib/api';

type ConsoleLevel = 'debug' | 'info' | 'warn' | 'error';
type LevelFilter = 'all' | 'warn' | 'error';

interface ConsoleLine {
  id: number;
  time: string;
  level: ConsoleLevel;
  text: string;
}

const LEVEL_LABEL: Record<ConsoleLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};

/**
 * 订阅 core-service 的 /api/console/stream。
 * 服务端先推缓冲里已有的行，再推新行；EventSource 断线会带上 Last-Event-ID 自动续上。
 * 用户把滚动条拉离底部时暂停跟随，避免新日志把正在看的警告顶走。
 */
export function ConsolePage() {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [stickToBottom, setStickToBottom] = useState(true);
  const viewRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    stickRef.current = stickToBottom;
  }, [stickToBottom]);

  useEffect(() => {
    const source = new EventSource(`${getApiBaseUrl()}/api/console/stream`);
    const onOpen = () => setConnected(true);
    const onError = () => setConnected(false);
    const onLine = (event: MessageEvent<string>) => {
      const line = parseLine(event.data);
      if (!line) return;
      setLines((current) => {
        if (current.some((item) => item.id === line.id)) return current;
        const next = [...current, line];
        return next.length > 800 ? next.slice(next.length - 800) : next;
      });
    };
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    source.addEventListener('line', onLine);
    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.removeEventListener('line', onLine);
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!stickRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    view.scrollTop = view.scrollHeight;
  }, [lines, filter]);

  const visible = useMemo(
    () => lines.filter((line) => filter === 'all' || line.level === filter),
    [lines, filter],
  );
  const warnCount = lines.filter((line) => line.level === 'warn').length;
  const errorCount = lines.filter((line) => line.level === 'error').length;

  return (
    <div className="console-page">
      <PageHeader
        title="控制台"
        description="实时显示本机服务打出的日志。警告为琥珀色，错误为红色。"
        action={
          <div className="console-toolbar">
            <span className={`console-status ${connected ? 'console-status-live' : 'console-status-off'}`}>
              {connected ? '实时连接' : '正在连接'}
            </span>
            <button type="button" className="filter-chip" onClick={() => setLines([])}>
              清屏
            </button>
            <button
              type="button"
              className={`filter-chip ${stickToBottom ? 'filter-chip-active' : ''}`}
              onClick={() => {
                setStickToBottom(true);
                const view = viewRef.current;
                if (view) view.scrollTop = view.scrollHeight;
              }}
            >
              跟随底部
            </button>
          </div>
        }
      />

      <div className="filter-bar">
        <button
          type="button"
          className={`filter-chip ${filter === 'all' ? 'filter-chip-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          全部 {lines.length}
        </button>
        <button
          type="button"
          className={`filter-chip ${filter === 'warn' ? 'filter-chip-active' : ''}`}
          onClick={() => setFilter('warn')}
        >
          警告 {warnCount}
        </button>
        <button
          type="button"
          className={`filter-chip ${filter === 'error' ? 'filter-chip-active' : ''}`}
          onClick={() => setFilter('error')}
        >
          错误 {errorCount}
        </button>
      </div>

      <div
        ref={viewRef}
        className="console-view"
        onScroll={(event) => {
          const view = event.currentTarget;
          const distance = view.scrollHeight - view.scrollTop - view.clientHeight;
          setStickToBottom(distance < 48);
        }}
      >
        {visible.length === 0 ? (
          <div className="console-empty">{connected ? '还没有新的后台输出' : '正在连接本机服务…'}</div>
        ) : (
          visible.map((line) => (
            <div key={line.id} className={`console-line console-line-${line.level}`}>
              <time className="console-time">{formatTime(line.time)}</time>
              <span className="console-level">{LEVEL_LABEL[line.level]}</span>
              <pre className="console-text">{line.text}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function parseLine(raw: string): ConsoleLine | null {
  try {
    const value = JSON.parse(raw) as Partial<ConsoleLine>;
    if (typeof value.id !== 'number' || typeof value.text !== 'string' || typeof value.time !== 'string') {
      return null;
    }
    const level = value.level;
    if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') return null;
    return { id: value.id, time: value.time, level, text: value.text };
  } catch {
    return null;
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
