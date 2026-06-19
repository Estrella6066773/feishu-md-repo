export type GitChangeType = 'add' | 'modify' | 'delete' | 'rename';

export interface ChangedPath {
  path: string;
  previousPath?: string;
  changeType: GitChangeType;
}

export interface GitTreeEntry {
  path: string;
  type: 'tree' | 'blob';
  mode: string;
  sha: string;
}

export interface GitProvider {
  getHeadSha(): Promise<string>;
  getRemoteHeadSha?(): Promise<string | null>;
  fetchLatest?(): Promise<void>;
  getChangedPaths(sinceSha: string, untilSha: string): Promise<ChangedPath[]>;
  getTreeAtSha(sha: string): Promise<GitTreeEntry[]>;
  /** Git 规则：指定 commit 下 Git 跟踪的文件路径（非工作区全量扫描） */
  listTrackedPathsAtSha(sha: string): Promise<string[]>;
  /** Git 规则：排除 .gitattributes 中 export-ignore 的路径 */
  filterPathsByGitExportIgnore(sha: string, paths: string[]): Promise<string[]>;
  readFileAtSha(sha: string, path: string): Promise<string | null>;
}

export interface GitProviderOptions {
  repoPath: string;
  branch: string;
  remoteUrl?: string;
}

export { createGitProvider } from './factory.js';
export { installLocalHook, removeLocalHook } from './hooks.js';
