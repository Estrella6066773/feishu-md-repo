export type GitChangeType = 'add' | 'modify' | 'delete' | 'rename';

export interface ChangedPath {
  path: string;
  previousPath?: string;
  changeType: GitChangeType;
}

export interface GitCommitSummary {
  sha: string;
  subject: string;
  message: string;
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
  /** sinceSha 为空时仅返回 untilSha 对应的一条提交 */
  getCommitsBetween(sinceSha: string | undefined, untilSha: string): Promise<GitCommitSummary[]>;
  getCommitFilePaths(sha: string): Promise<string[]>;
  getTreeAtSha(sha: string): Promise<GitTreeEntry[]>;
  /** Git 规则：指定 commit 下 Git 跟踪的文件路径（非工作区全量扫描） */
  listTrackedPathsAtSha(sha: string): Promise<string[]>;
  /** Git 规则：排除 .gitattributes 中 export-ignore 的路径 */
  filterPathsByGitExportIgnore(sha: string, paths: string[]): Promise<string[]>;
  readFileAtSha(sha: string, path: string): Promise<string | null>;
  readBinaryFileAtSha(sha: string, path: string): Promise<Uint8Array | null>;
}

export interface GitProviderOptions {
  repoPath: string;
  branch: string;
  remoteUrl?: string;
}

export { createGitProvider } from './factory.js';
export { installLocalHook, removeLocalHook } from './hooks.js';
