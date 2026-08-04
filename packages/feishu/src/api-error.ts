import type { FeishuClient } from './client.js';
import { createLogger } from '@feishu-md/shared';
import { getFeishuApiRetryPolicy } from './api-retry-policy.js';

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'FeishuApiError';
  }
}

export function assertFeishuResponse<T extends { code?: number; msg?: string }>(
  response: T,
  action: string,
): T {
  if (response.code !== 0) {
    throw new FeishuApiError(`${action} failed: ${response.msg ?? 'unknown error'}`, response.code);
  }
  return response;
}

/** 常见飞书错误码的中文说明，用于给用户可读的排查提示 */
const FEISHU_ERROR_CODE_HINTS: Record<number, string> = {
  1061004: '权限不足（forbidden）：应用对该文件夹/文档没有操作权限，请确认应用已被添加为云空间文件夹协作者或知识库管理员',
  99991672: '权限不足：应用缺少所需权限或被拒绝访问，请在飞书开放平台确认已申请并发布对应权限',
};

/** 将飞书 API 或一般 Error 格式化为日志可读字符串 */
export function formatFeishuErrorMessage(error: unknown): string {
  if (error instanceof FeishuApiError) {
    const hint = error.code != null ? FEISHU_ERROR_CODE_HINTS[error.code] : undefined;
    return `${error.message}${error.code != null ? ` [code ${error.code}]` : ''}${hint ? `：${hint}` : ''}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 飞书 docx 写接口官方约 3 QPS/应用（及单篇文档并发编辑约 3 次/秒），超限返回 99991400。
 * 成功后间隔取 350ms（约 2.8 QPS），略低于上限，减少空等；撞限仍走指数退避持续重试。
 * @see https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create
 *
 * 读写分级：写接口（create/patch/delete/upload 等）保守限流（2 并发 + 350ms 间隔）；
 * 读接口（list/get 等）频控等级通常更高（5~50 QPS），放宽为独立信号量且成功后不等待，
 * 避免大型仓库同步时读吞吐被写节奏拖慢。
 */
const FEISHU_API_MAX_RETRIES = 6;
const FEISHU_API_RETRY_BASE_MS = 400;
const FEISHU_API_RATE_LIMIT_DELAY_MS = 350;
const FEISHU_API_PERSISTENT_RETRY_MAX_DELAY_MS = 30_000;
/** 全局同时在飞的飞书 Open API 写请求数（多文档并行时避免叠加触发 99991400） */
const FEISHU_API_MAX_WRITE_IN_FLIGHT = 2;
/** 全局同时在飞的飞书 Open API 读请求数（读接口频控等级通常更高） */
const FEISHU_API_MAX_READ_IN_FLIGHT = 8;
/** 服务端建议等待秒数的上限，防止异常响应头导致过长等待 */
const FEISHU_API_RATE_LIMIT_RESET_MAX_SECONDS = 120;

const syncApiLog = createLogger('sync');

export interface FeishuRateLimitOptions {
  /** 标记该请求为读接口（list/get），放宽并发且成功后不 sleep */
  read?: boolean;
}

const READ_IN_FLIGHT = { value: 0 };
const WRITE_IN_FLIGHT = { value: 0 };
const readFlightWaiters: Array<() => void> = [];
const writeFlightWaiters: Array<() => void> = [];

async function acquireFlightSlot(kind: 'read' | 'write'): Promise<void> {
  const counter = kind === 'read' ? READ_IN_FLIGHT : WRITE_IN_FLIGHT;
  const limit = kind === 'read' ? FEISHU_API_MAX_READ_IN_FLIGHT : FEISHU_API_MAX_WRITE_IN_FLIGHT;
  const waiters = kind === 'read' ? readFlightWaiters : writeFlightWaiters;

  if (counter.value < limit) {
    counter.value += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waiters.push(() => {
      counter.value += 1;
      resolve();
    });
  });
}

function releaseFlightSlot(kind: 'read' | 'write'): void {
  const counter = kind === 'read' ? READ_IN_FLIGHT : WRITE_IN_FLIGHT;
  const waiters = kind === 'read' ? readFlightWaiters : writeFlightWaiters;
  counter.value -= 1;
  const next = waiters.shift();
  if (next) next();
}

/** 从 axios 风格错误中读取服务端建议的限流等待秒数（x-ogw-ratelimit-reset） */
function extractRatelimitResetSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: { headers?: Record<string, unknown> } }).response;
  const raw = response?.headers?.['x-ogw-ratelimit-reset'];
  if (raw == null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, FEISHU_API_RATE_LIMIT_RESET_MAX_SECONDS);
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

export async function withRateLimit<T>(
  task: () => Promise<T>,
  options?: FeishuRateLimitOptions,
): Promise<T> {
  const persistOnRateLimit = getFeishuApiRetryPolicy().persistOnRateLimit === true;
  const kind = options?.read === true ? 'read' : 'write';
  let attempt = 0;

  while (true) {
    await acquireFlightSlot(kind);
    try {
      const result = await task();
      // Docx / Wiki 写接口约 3 QPS；间隔与 FEISHU_API_RATE_LIMIT_DELAY_MS 对齐。
      // 读接口频控等级更高，成功后不等待，避免拖慢批量读取。
      if (kind === 'write') {
        await sleep(FEISHU_API_RATE_LIMIT_DELAY_MS);
      }
      return result;
    } catch (error) {
      const normalized = normalizeFeishuClientError(error);
      const retryable = isRetryableFeishuRequestError(normalized) || isRetryableFeishuRequestError(error);
      if (!retryable) {
        syncApiLog.warn(
          `飞书 API 请求最终失败: ${describeRetryableError(normalized)}`,
          undefined,
          normalized,
        );
        throw normalized;
      }

      const rateLimit = isRateLimitError(normalized) || isRateLimitError(error);
      const shouldPersist = persistOnRateLimit && rateLimit;
      if (!shouldPersist && attempt >= FEISHU_API_MAX_RETRIES) {
        syncApiLog.warn(
          `飞书 API 请求最终失败: ${describeRetryableError(normalized)}`,
          undefined,
          normalized,
        );
        throw normalized;
      }

      // 限流时优先按服务端建议（x-ogw-ratelimit-reset）等待（已受 120s 上限约束），
      // 其次指数退避
      const resetSeconds = rateLimit ? extractRatelimitResetSeconds(error) : undefined;
      const delayMs =
        resetSeconds != null
          ? resetSeconds * 1000
          : Math.min(
              FEISHU_API_RETRY_BASE_MS * 2 ** Math.min(attempt, 8),
              shouldPersist ? FEISHU_API_PERSISTENT_RETRY_MAX_DELAY_MS : 30_000,
            );
      attempt += 1;
      const retryLabel = shouldPersist
        ? `持续重试 (${attempt})`
        : `重试 (${attempt}/${FEISHU_API_MAX_RETRIES})`;
      syncApiLog.warn(
        `飞书 API 请求失败，${delayMs}ms 后${retryLabel}: ${describeRetryableError(normalized)}`,
      );
      await sleep(delayMs);
    } finally {
      releaseFlightSlot(kind);
    }
  }
}

export function isRetryableFeishuRequestError(error: unknown): boolean {
  if (error instanceof FeishuApiError) {
    // 频控 / 素材并发 / 服务端临时错误 / 租户校验瞬时失败（2200）。
    // 注意：99991672（权限不足）不在此列，重试无法解决，直接抛错暴露问题。
    return (
      error.code === 1061045
      || error.code === 11232
      || error.code === 2200
      || error.code === 99991400
    );
  }

  const payload = extractFeishuApiErrorPayload(error);
  if (
    payload?.code === 1061045
    || payload?.code === 11232
    || payload?.code === 2200
    || payload?.code === 99991400
  ) {
    return true;
  }

  const networkCode = extractNetworkErrorCode(error);
  if (networkCode && TRANSIENT_NETWORK_CODES.has(networkCode)) {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    message.includes('econnreset')
    || message.includes('socket hang up')
    || message.includes('network error')
    || message.includes('timeout')
  ) {
    return true;
  }

  if (error && typeof error === 'object' && 'response' in error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      return true;
    }
  }

  return false;
}

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof FeishuApiError) {
    return (
      error.code === 1061045
      || error.code === 99991400
    );
  }

  const payload = extractFeishuApiErrorPayload(error);
  if (
    payload?.code === 1061045
    || payload?.code === 99991400
  ) {
    return true;
  }

  if (error && typeof error === 'object' && 'response' in error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 429) return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('frequency limit') || message.includes('rate limit');
}

function extractNetworkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const directCode = (error as { code?: unknown }).code;
  if (typeof directCode === 'string') return directCode;

  const cause = (error as { cause?: { code?: unknown } }).cause;
  if (typeof cause?.code === 'string') return cause.code;

  return undefined;
}

function describeRetryableError(error: unknown): string {
  const networkCode = extractNetworkErrorCode(error);
  if (networkCode) return networkCode;
  if (error instanceof FeishuApiError) {
    return `${error.message}${error.code != null ? ` [code ${error.code}]` : ''}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeFeishuClientError(error: unknown): Error {
  if (error instanceof FeishuApiError) return error;

  const apiPayload = extractFeishuApiErrorPayload(error);
  if (apiPayload?.msg) {
    const violations = (apiPayload.field_violations ?? [])
      .map((v) => `${v.field ?? '?'}: ${v.description ?? JSON.stringify(v.value)}`)
      .join('; ');
    const detail = violations ? ` (${violations})` : '';
    return new FeishuApiError(`${apiPayload.msg}${detail}`, apiPayload.code);
  }

  if (error instanceof Error) return error;
  return new Error(String(error));
}

function extractFeishuApiErrorPayload(error: unknown): {
  code?: number;
  msg?: string;
  field_violations?: Array<{ field?: string; description?: string; value?: unknown }>;
} | null {
  if (Array.isArray(error)) {
    for (const item of error) {
      const nested = extractFeishuApiErrorPayload(item);
      if (nested?.msg) return nested;
    }
    return null;
  }

  if (error && typeof error === 'object' && 'response' in error) {
    const axiosLike = error as {
      message?: string;
      response?: {
        data?: unknown;
      };
    };
    const rawData = axiosLike.response?.data;
    if (Array.isArray(rawData)) {
      for (const item of rawData) {
        if (item && typeof item === 'object' && 'msg' in item) {
          return item as {
            code?: number;
            msg?: string;
            field_violations?: Array<{ field?: string; description?: string; value?: unknown }>;
          };
        }
      }
    }
    if (rawData && typeof rawData === 'object' && 'msg' in rawData) {
      return rawData as {
        code?: number;
        msg?: string;
        field_violations?: Array<{ field?: string; description?: string; value?: unknown }>;
      };
    }
    if (axiosLike.message) {
      return { msg: axiosLike.message };
    }
  }

  if (error && typeof error === 'object' && 'msg' in error) {
    return error as {
      code?: number;
      msg?: string;
      field_violations?: Array<{ field?: string; description?: string; value?: unknown }>;
    };
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type DocxClient = FeishuClient['docx'];
export type WikiClient = FeishuClient['wiki'];
export type DriveClient = FeishuClient['drive'];
