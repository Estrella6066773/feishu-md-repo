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

/** 将飞书 API 或一般 Error 格式化为日志可读字符串 */
export function formatFeishuErrorMessage(error: unknown): string {
  if (error instanceof FeishuApiError) {
    return `${error.message}${error.code != null ? ` [code ${error.code}]` : ''}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

const FEISHU_API_MAX_RETRIES = 4;
const FEISHU_API_RETRY_BASE_MS = 800;
const FEISHU_API_RATE_LIMIT_DELAY_MS = 600;
const FEISHU_API_PERSISTENT_RETRY_MAX_DELAY_MS = 60_000;
/** 全局同时在飞的飞书 Open API 请求数（多文档并行时避免叠加触发 99991400） */
const FEISHU_API_MAX_IN_FLIGHT = 2;

const syncApiLog = createLogger('sync');

let apiInFlight = 0;
const apiFlightWaiters: Array<() => void> = [];

async function acquireApiFlightSlot(): Promise<void> {
  if (apiInFlight < FEISHU_API_MAX_IN_FLIGHT) {
    apiInFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    apiFlightWaiters.push(() => {
      apiInFlight += 1;
      resolve();
    });
  });
}

function releaseApiFlightSlot(): void {
  apiInFlight -= 1;
  const next = apiFlightWaiters.shift();
  if (next) next();
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

export async function withRateLimit<T>(task: () => Promise<T>): Promise<T> {
  const persistOnRateLimit = getFeishuApiRetryPolicy().persistOnRateLimit === true;
  let attempt = 0;

  while (true) {
    await acquireApiFlightSlot();
    try {
      const result = await task();
      // Docx / Wiki write APIs are limited to ~3 QPS per app/document.
      await sleep(FEISHU_API_RATE_LIMIT_DELAY_MS);
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

      const delayMs = Math.min(
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
      releaseApiFlightSlot();
    }
  }
}

export function isRetryableFeishuRequestError(error: unknown): boolean {
  if (error instanceof FeishuApiError) {
    // 频控 / 素材并发 / 服务端临时错误 / 租户校验瞬时失败（2200）
    return (
      error.code === 1061045
      || error.code === 11232
      || error.code === 2200
      || error.code === 99991400
      || error.code === 99991672
    );
  }

  const payload = extractFeishuApiErrorPayload(error);
  if (
    payload?.code === 1061045
    || payload?.code === 11232
    || payload?.code === 2200
    || payload?.code === 99991400
    || payload?.code === 99991672
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
      || error.code === 99991672
    );
  }

  const payload = extractFeishuApiErrorPayload(error);
  if (
    payload?.code === 1061045
    || payload?.code === 99991400
    || payload?.code === 99991672
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
