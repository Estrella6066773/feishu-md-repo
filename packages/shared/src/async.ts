export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollUntilTerminalOptions<T> {
  fetch: () => Promise<T>;
  isTerminal: (item: T) => boolean;
  timeoutMs?: number;
  timeoutMessage?: string;
  intervalMs?: number | ((item: T) => number);
}

/** 轮询直到任务进入终态（success / failed 等） */
export async function pollUntilTerminal<T>(options: PollUntilTerminalOptions<T>): Promise<T> {
  const {
    fetch,
    isTerminal,
    timeoutMs = 300_000,
    timeoutMessage = '等待超时',
    intervalMs = 1_000,
  } = options;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const item = await fetch();
    if (isTerminal(item)) {
      return item;
    }
    const delay = typeof intervalMs === 'function' ? intervalMs(item) : intervalMs;
    await sleep(delay);
  }

  throw new Error(timeoutMessage);
}
