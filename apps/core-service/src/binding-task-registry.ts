export type BindingQueueTaskKind = 'sync' | 'comment-import';

export interface BindingRunningTask {
  logId: string;
  kind: BindingQueueTaskKind;
  generation: number;
  trigger: string;
  startedAt: string;
}

/** 按绑定跟踪任务代次，用于手动指令抢占同项目先前的同步/评论导入 */
export class BindingTaskRegistry {
  private generation = new Map<string, number>();
  private running = new Map<string, BindingRunningTask>();

  preemptBinding(bindingId: string): number {
    const next = (this.generation.get(bindingId) ?? 0) + 1;
    this.generation.set(bindingId, next);
    return next;
  }

  getGeneration(bindingId: string): number {
    return this.generation.get(bindingId) ?? 0;
  }

  isStale(bindingId: string, generation: number): boolean {
    return generation < this.getGeneration(bindingId);
  }

  registerRunning(bindingId: string, task: BindingRunningTask): void {
    this.running.set(bindingId, task);
  }

  unregisterRunning(bindingId: string, logId: string): void {
    const current = this.running.get(bindingId);
    if (current?.logId === logId) {
      this.running.delete(bindingId);
    }
  }

  getRunning(bindingId: string): BindingRunningTask | undefined {
    return this.running.get(bindingId);
  }
}
