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

  if (error && typeof error === 'object' && 'response' in error) {
    const axiosLike = error as {
      message?: string;
      response?: { status?: number; data?: { code?: number; msg?: string } };
    };
    const data = axiosLike.response?.data;
    if (data?.msg) {
      return new FeishuApiError(
        data.msg,
        data.code,
      );
    }
    if (axiosLike.message) {
      return new FeishuApiError(axiosLike.message);
    }
  }

  if (error instanceof Error) return error;
  return new Error(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type DocxClient = FeishuClient['docx'];
export type WikiClient = FeishuClient['wiki'];
export type DriveClient = FeishuClient['drive'];
