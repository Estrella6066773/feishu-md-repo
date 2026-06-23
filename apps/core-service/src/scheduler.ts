import type { DbClient } from '@feishu-md/db';
import { listBindings } from '@feishu-md/db';
import type { SyncTriggerType } from '@feishu-md/shared';
import { normalizeBindingTriggers } from '@feishu-md/shared';
import type { SyncCoordinator } from './sync-coordinator.js';

export class SyncQueue {
  private running = false;
  private pending: Array<() => Promise<void>> = [];

  enqueue(task: () => Promise<void>): void {
    this.pending.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) continue;
      try {
        await task();
      } catch (error) {
        console.error('[sync-queue] task failed:', error);
      }
    }
    this.running = false;
  }
}

export class Scheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  start(db: DbClient, syncCoordinator: SyncCoordinator): void {
    void this.refresh(db, syncCoordinator);
  }

  async refresh(db: DbClient, syncCoordinator: SyncCoordinator): Promise<void> {
    this.stopAll();
    const bindings = await listBindings(db);
    for (const binding of bindings) {
      const triggers = normalizeBindingTriggers(binding.triggers, binding.sourceType);
      if (!triggers.scheduleEnabled) continue;
      const timer = setInterval(
        () => {
          syncCoordinator.enqueueBindingSync(binding.id, 'schedule');
        },
        triggers.scheduleMinutes * 60 * 1000,
      );
      this.timers.set(binding.id, timer);
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}

export type { SyncTriggerType };

