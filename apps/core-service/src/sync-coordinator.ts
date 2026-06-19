import type { DbClient } from '@feishu-md/db';
import { getBinding } from '@feishu-md/db';
import type { SyncTriggerType } from '@feishu-md/shared';
import { runSync } from '@feishu-md/core';
import type { SyncQueue } from './scheduler.js';
import type { BotBroadcaster } from './bot/broadcaster.js';

export class SyncCoordinator {
  constructor(
    private db: DbClient,
    private queue: SyncQueue,
    private broadcaster: BotBroadcaster,
  ) {}

  enqueueBindingSync(bindingId: string, trigger: SyncTriggerType, fullResync = false): void {
    this.queue.enqueue(async () => {
      const binding = await getBinding(this.db, bindingId);
      if (!binding) {
        throw new Error(`Binding not found: ${bindingId}`);
      }

      try {
        const result = await runSync({ binding, db: this.db, trigger, fullResync });
        await this.broadcaster.notifySyncFinished({
          binding,
          trigger,
          success: true,
          result,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.broadcaster.notifySyncFinished({
          binding,
          trigger,
          success: false,
          errorMessage,
        });
        throw error;
      }
    });
  }
}
