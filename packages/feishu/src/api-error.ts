import type { FeishuClient } from './client.js';

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
const FEISHU_API_RATE_LIMIT_DELAY_MS = 350;

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

export async function withRateLimit<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= FEISHU_API_MAX_RETRIES; attempt += 1) {
    try {
      const result = await task();
      // Docx / Wiki write APIs are limited to ~3 QPS per app/document.
      await sleep(FEISHU_API_RATE_LIMIT_DELAY_MS);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= FEISHU_API_MAX_RETRIES || !isRetryableFeishuRequestError(error)) {
        throw normalizeFeishuClientError(error);
      }

      const delayMs = FEISHU_API_RETRY_BASE_MS * 2 ** attempt;
      console.warn(
        `[sync] 飞书 API 请求失败，${delayMs}ms 后重试 (${attempt + 1}/${FEISHU_API_MAX_RETRIES}): ${describeRetryableError(error)}`,
      );
      await sleep(delayMs);
    }
  }

  throw normalizeFeishuClientError(lastError);
}

function isRetryableFeishuRequestError(error: unknown): boolean {
  if (error instanceof FeishuApiError) {
    // 频控 / 素材并发 / 服务端临时错误
    return error.code === 1061045 || error.code === 99991400 || error.code === 99991672;
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
