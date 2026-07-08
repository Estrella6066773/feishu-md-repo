import { AsyncLocalStorage } from 'node:async_hooks';

export interface FeishuApiRetryPolicy {
  /** 遇飞书频控时持续重试直至成功（用于强制重写等长任务） */
  persistOnRateLimit?: boolean;
}

const retryPolicyStorage = new AsyncLocalStorage<FeishuApiRetryPolicy>();

export function runWithFeishuApiRetryPolicy<T>(
  policy: FeishuApiRetryPolicy,
  task: () => Promise<T>,
): Promise<T> {
  return retryPolicyStorage.run(policy, task);
}

export function getFeishuApiRetryPolicy(): FeishuApiRetryPolicy {
  return retryPolicyStorage.getStore() ?? {};
}
