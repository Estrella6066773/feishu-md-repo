/// <reference types="node" />

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 同步日志上下文，便于在控制台定位出错文件与资源 */
export interface LogContext {
  bindingId?: string;
  logId?: string;
  trigger?: string;
  gitPath?: string;
  /** Git 仓库内源 Markdown 路径（与 gitPath 同义，兼容旧 SyncLogContext） */
  sourcePath?: string;
  /** 飞书文档 document_id */
  documentId?: string;
  /** Markdown 中引用的图片 src */
  imageSrc?: string;
  operation?: string;
  durationMs?: number;
  /** 扩展字段，序列化时会脱敏 */
  [key: string]: string | number | boolean | undefined;
}

export interface Logger {
  debug(message: string, ctx?: LogContext): void;
  info(message: string, ctx?: LogContext): void;
  warn(message: string, ctx?: LogContext, err?: unknown): void;
  error(message: string, ctx?: LogContext, err?: unknown): void;
  child(ctx: LogContext): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const CONTEXT_KEY_ORDER = [
  'bindingId',
  'logId',
  'trigger',
  'gitPath',
  'file',
  'sourcePath',
  'documentId',
  'imageSrc',
  'operation',
  'durationMs',
] as const;

const SENSITIVE_KEY_PATTERN =
  /secret|token|password|authorization|credential|app_secret|tenant_access/i;

let configuredLevel: LogLevel | undefined;

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return 'info';
}

export function getLogLevel(): LogLevel {
  if (configuredLevel) {
    return configuredLevel;
  }
  return parseLogLevel(process.env.FEISHU_MD_LOG_LEVEL);
}

export function configureLogger(options: { level?: LogLevel }): void {
  if (options.level) {
    configuredLevel = options.level;
  }
}

export function isDebugEnabled(): boolean {
  return getLogLevel() === 'debug';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[getLogLevel()];
}

function redactValue(key: string, value: unknown): string {
  if (value === undefined || value === null) {
    return String(value);
  }
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  const text = String(value);
  if (/tenant_access_token|app_secret/i.test(text)) {
    return '[REDACTED]';
  }
  return text;
}

function formatContextTags(ctx?: LogContext): string {
  if (!ctx) {
    return '';
  }

  const tags: string[] = [];
  const seen = new Set<string>();

  const pushTag = (key: string, rawValue: unknown) => {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return;
    }
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    tags.push(`${key}=${redactValue(key, rawValue)}`);
  };

  for (const key of CONTEXT_KEY_ORDER) {
    if (key === 'file') {
      pushTag('file', ctx.gitPath ?? ctx.sourcePath);
      continue;
    }
    pushTag(key, (ctx as Record<string, unknown>)[key]);
  }

  const orderedKeys = new Set<string>(CONTEXT_KEY_ORDER);
  for (const [key, value] of Object.entries(ctx)) {
    if (orderedKeys.has(key)) {
      continue;
    }
    pushTag(key, value);
  }

  return tags.length > 0 ? ` ${tags.join(' ')}` : '';
}

function formatMessage(component: string, message: string, ctx?: LogContext): string {
  const tags = formatContextTags(ctx);
  if (tags.length === 0) {
    return `[${component}] ${message}`;
  }
  return `[${component}]${tags} — ${message}`;
}

function writeLog(
  component: string,
  level: LogLevel,
  message: string,
  ctx?: LogContext,
  err?: unknown,
): void {
  if (!shouldLog(level)) {
    return;
  }

  const formatted = formatMessage(component, message, ctx);
  switch (level) {
    case 'debug':
      console.debug(formatted);
      break;
    case 'info':
      console.info(formatted);
      break;
    case 'warn':
      if (err !== undefined) {
        console.warn(formatted, err);
      } else {
        console.warn(formatted);
      }
      break;
    case 'error':
      if (err !== undefined) {
        console.error(formatted, err);
      } else {
        console.error(formatted);
      }
      break;
  }
}

function mergeContext(base?: LogContext, extra?: LogContext): LogContext | undefined {
  if (!base && !extra) {
    return undefined;
  }
  return { ...base, ...extra };
}

export function createLogger(component: string, baseContext?: LogContext): Logger {
  const logAt =
    (level: LogLevel) =>
    (message: string, ctx?: LogContext, err?: unknown) => {
      writeLog(component, level, message, mergeContext(baseContext, ctx), err);
    };

  return {
    debug: (message, ctx) => logAt('debug')(message, ctx),
    info: (message, ctx) => logAt('info')(message, ctx),
    warn: (message, ctx, err) => logAt('warn')(message, ctx, err),
    error: (message, ctx, err) => logAt('error')(message, ctx, err),
    child: (ctx) => createLogger(component, mergeContext(baseContext, ctx)),
  };
}

/** @deprecated 请改用 createLogger('sync').warn/info 等 */
export function formatSyncLog(message: string, context?: LogContext): string {
  return formatMessage('sync', message, context);
}
