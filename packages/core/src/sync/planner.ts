import type { SyncTriggerType } from '@feishu-md/shared';

export type SyncOperationType = 'ensure_folder' | 'ensure_doc' | 'update_doc' | 'delete' | 'move';

export interface SyncOperation {
  type: SyncOperationType;
  gitPath: string;
  title?: string;
  parentGitPath?: string;
  contentMarkdown?: string;
}

export interface SyncPlan {
  bindingId: string;
  trigger: SyncTriggerType;
  fromSha?: string;
  toSha: string;
  operations: SyncOperation[];
}

export interface SyncPlanContext {
  bindingId: string;
  trigger: SyncTriggerType;
  fromSha?: string;
  toSha: string;
  treePaths: string[];
  changedPaths: string[];
  readMarkdown: (path: string) => Promise<string | null>;
}

export interface SyncPlanner {
  buildPlan(context: SyncPlanContext): Promise<SyncPlan>;
}

export { createPlanner } from './factory.js';
