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
  const result = await task();
  // Docx / Wiki write APIs are limited to ~3 QPS per app/document.
  await sleep(350);
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type DocxClient = FeishuClient['docx'];
export type WikiClient = FeishuClient['wiki'];
export type DriveClient = FeishuClient['drive'];
