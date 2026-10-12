import { inspect } from 'node:util';

export type ConsoleLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ConsoleLine {
  id: number;
  time: string;
  level: ConsoleLevel;
  text: string;
}

const MAX_LINES = 800;
const lines: ConsoleLine[] = [];
const listeners = new Set<(line: ConsoleLine) => void>();
let nextId = 0;
let installed = false;

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

/**
 * 把本进程的 console 输出收进环形缓冲，供 /api/console/stream 推给界面。
 * 必须在其它模块打日志之前执行：index.ts 把本文件放在第一条 import。
 * 记录时只调用安装前保存的原始 console，避免监听器再写日志造成循环。
 * 密钥样式的片段会打码；界面看到的是脱敏后的文本。
 */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  console.log = wrap('info', originalConsole.log) as typeof console.log;
  console.info = wrap('info', originalConsole.info) as typeof console.info;
  console.warn = wrap('warn', originalConsole.warn) as typeof console.warn;
  console.error = wrap('error', originalConsole.error) as typeof console.error;
  console.debug = wrap('debug', originalConsole.debug) as typeof console.debug;
}

export function listConsoleLines(afterId = 0): ConsoleLine[] {
  if (afterId <= 0) return lines.slice();
  return lines.filter((line) => line.id > afterId);
}

export function subscribeConsole(listener: (line: ConsoleLine) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function wrap(level: ConsoleLevel, original: (...args: unknown[]) => void) {
  return (...args: unknown[]) => {
    original(...args);
    publish(level, args);
  };
}

function publish(level: ConsoleLevel, args: unknown[]): void {
  const text = redact(args.map(formatArg).join(' '));
  if (!text.trim()) return;
  const line: ConsoleLine = {
    id: ++nextId,
    time: new Date().toISOString(),
    level: refineLevel(level, text),
    text,
  };
  lines.push(line);
  if (lines.length > MAX_LINES) {
    lines.shift();
  }
  for (const listener of listeners) {
    listener(line);
  }
}

function refineLevel(level: ConsoleLevel, text: string): ConsoleLevel {
  if (level === 'warn' || level === 'error') return level;
  if (/^\s*\[error\]/i.test(text) || /\bERROR\b/.test(text)) return 'error';
  if (/^\s*\[warn(?:ing)?\]/i.test(text) || /\bWARN(?:ING)?\b/.test(text)) return 'warn';
  return level;
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return inspect(value, { depth: 4, breakLength: 140, colors: false });
  } catch {
    return String(value);
  }
}

function redact(text: string): string {
  return text
    .replace(/((?:app_secret|appSecret|access_token|tenant_access_token|refresh_token|authorization)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

installConsoleCapture();
