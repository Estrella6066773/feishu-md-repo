/// <reference types="node" />

const DEFAULT_SYNC_DOC_WRITE_CONCURRENCY = 2;
const MAX_SYNC_DOC_WRITE_CONCURRENCY = 16;

/** 跨文档正文写入并发数（不同 document_id 可并行；单文档内仍串行） */
export function resolveSyncDocWriteConcurrency(): number {
  const raw = process.env.FEISHU_MD_SYNC_DOC_CONCURRENCY;
  if (!raw?.trim()) {
    return DEFAULT_SYNC_DOC_WRITE_CONCURRENCY;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_SYNC_DOC_WRITE_CONCURRENCY;
  }

  return Math.min(parsed, MAX_SYNC_DOC_WRITE_CONCURRENCY);
}

/** 有界并发执行任务；首个失败时其余 worker 停止调度新项，并最终抛出该错误 */
export async function runTasksWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  let firstError: unknown;

  async function runWorker(): Promise<void> {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      try {
        await worker(items[index]!, index);
      } catch (error) {
        firstError = error;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));

  if (firstError) {
    throw firstError;
  }
}
