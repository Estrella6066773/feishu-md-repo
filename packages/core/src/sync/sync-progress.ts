import type { SyncLogEntry, SyncProgressPhase } from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import { updateSyncLog } from '@feishu-md/db';

const PROGRESS_FLUSH_MS = 400;

const PHASE_MESSAGE: Record<SyncProgressPhase, string> = {
  planning: '正在规划同步…',
  structure: '正在准备目录与文档节点…',
  content: '正在同步文档正文…',
  cleanup: '正在清理已移除节点…',
  overview: '正在更新同步文档总览…',
  done: '同步完成',
};

/** 节流写入 sync_logs 的文档级进度 */
export class SyncProgressReporter {
  private phase: SyncProgressPhase = 'planning';
  private done = 0;
  private total: number | undefined;
  private currentGitPath: string | undefined;
  private lastFlushAt = 0;

  constructor(
    private db: DbClient,
    private base: Pick<SyncLogEntry, 'id' | 'bindingId' | 'trigger' | 'startedAt'>,
  ) {}

  async setPhase(phase: SyncProgressPhase, message?: string): Promise<void> {
    this.phase = phase;
    if (phase !== 'content') {
      this.currentGitPath = undefined;
    }
    await this.flush(true, message ?? PHASE_MESSAGE[phase]);
  }

  /** 结构阶段完成，进入按文档计数（含 CSV 原文件上传与正文写入） */
  async beginDocumentProgress(total: number, done: number): Promise<void> {
    this.phase = 'content';
    this.total = total;
    this.done = done;
    await this.flush(true, this.buildMessage());
  }

  async documentStarted(gitPath: string): Promise<void> {
    this.currentGitPath = gitPath.replace(/\\/g, '/');
    await this.flush(false, this.buildMessage());
  }

  async documentCompleted(gitPath: string): Promise<void> {
    this.done += 1;
    this.currentGitPath = gitPath.replace(/\\/g, '/');
    await this.flush(false, this.buildMessage());
  }

  async markAllDocumentsDone(): Promise<void> {
    if (this.total != null) {
      this.done = this.total;
    }
    this.phase = 'done';
    await this.flush(true);
  }

  private buildMessage(): string {
    if (this.phase === 'content' && this.total != null && this.total > 0) {
      return `文档 ${this.done}/${this.total}`;
    }
    return PHASE_MESSAGE[this.phase];
  }

  private async flush(force: boolean, message?: string): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastFlushAt < PROGRESS_FLUSH_MS) {
      return;
    }
    this.lastFlushAt = now;

    await updateSyncLog(this.db, {
      id: this.base.id,
      bindingId: this.base.bindingId,
      trigger: this.base.trigger,
      status: 'running',
      startedAt: this.base.startedAt,
      message: message ?? this.buildMessage(),
      progressPhase: this.phase,
      progressDone: this.total != null ? this.done : undefined,
      progressTotal: this.total,
      currentGitPath: this.currentGitPath,
    });
  }
}
