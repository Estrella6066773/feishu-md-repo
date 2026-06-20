import type { SyncTriggerType, WorkspaceOptions, RepositoryOptions } from '@feishu-md/shared';

export type SyncOperationType = 'ensure_folder' | 'ensure_doc' | 'update_doc' | 'delete' | 'move';

export interface SyncOperation {
  type: SyncOperationType;
  gitPath: string;
  /** 原始 Markdown 源路径（用于相对链接解析） */
  sourcePath?: string;
  title?: string;
  parentGitPath?: string;
  contentMarkdown?: string;
}

export interface SyncPlan {
  bindingId: string;
  trigger: SyncTriggerType;
  fromSha?: string;
  toSha: string;
  /** 当前 Git 追踪的所有路径（归一化后），用于判断哪些历史节点已被移除 */
  allTrackedPaths: string[];
  operations: SyncOperation[];
}

export interface SyncPlanContext {
  bindingId: string;
  /** 绑定名称，仓库模式根文档标题使用此字段 */
  bindingName?: string;
  trigger: SyncTriggerType;
  fromSha?: string;
  toSha: string;
  treePaths: string[];
  changedPaths: string[];
  readMarkdown: (path: string) => Promise<string | null>;
  workspaceOptions?: WorkspaceOptions;
  repositoryOptions?: RepositoryOptions;
}

export interface SyncPlanner {
  buildPlan(context: SyncPlanContext): Promise<SyncPlan>;
}

export { createPlanner } from './factory.js';
