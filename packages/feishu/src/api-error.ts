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

export async function withRateLimit<T>(task: () => Promise<T>): Promise<T> {
  try {
    const result = await task();
    // Docx / Wiki write APIs are limited to ~3 QPS per app/document.
    await sleep(350);
    return result;
  } catch (error) {
    throw normalizeFeishuClientError(error);
  }
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
