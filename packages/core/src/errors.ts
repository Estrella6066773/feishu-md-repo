export const BINDING_TASK_PREEMPTED_MESSAGE = '已被新的手动指令打断';

export class BindingTaskPreemptedError extends Error {
  constructor(message = BINDING_TASK_PREEMPTED_MESSAGE) {
    super(message);
    this.name = 'BindingTaskPreemptedError';
  }
}

export function throwIfAborted(shouldAbort?: () => boolean): void {
  if (shouldAbort?.()) {
    throw new BindingTaskPreemptedError();
  }
}
