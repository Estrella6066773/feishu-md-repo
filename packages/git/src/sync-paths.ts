import {
  filterPathsByProjectIgnoreGlobs,
  mergeProjectIgnoreGlobs,
  normalizeRepoPath,
} from '@feishu-md/shared';
import type { GitProvider } from './types.js';

export interface ResolveSyncPathsOptions {
  git: GitProvider;
  sha: string;
  projectIgnoreGlobs?: string[];
  fromSha?: string;
}

export interface ResolvedSyncPaths {
  /** 经 Git 规则 + 项目 ignore 后的完整可同步路径 */
  allPaths: string[];
  /** 相对上次同步有变更的路径（同样经过两重筛选） */
  changedPaths: string[];
}

/**
 * 两重路径筛选：
 * 1. Git 规则 — ls-files --with-tree（仅 Git 跟踪内容）+ export-ignore 属性
 * 2. 项目规则 — 绑定 options.ignoreGlobs
 */
export async function resolveSyncPaths(options: ResolveSyncPathsOptions): Promise<ResolvedSyncPaths> {
  const { git, sha, fromSha } = options;
  const projectGlobs = mergeProjectIgnoreGlobs(options.projectIgnoreGlobs);

  const gitTracked = await git.listTrackedPathsAtSha(sha);
  const afterGitAttrs = await git.filterPathsByGitExportIgnore(sha, gitTracked);
  const allPaths = filterPathsByProjectIgnoreGlobs(afterGitAttrs, projectGlobs);

  const allSet = new Set(allPaths);
  let changedPaths = allPaths;

  if (fromSha) {
    const rawChanges = await git.getChangedPaths(fromSha, sha);
    const changedSet = new Set<string>();
    for (const item of rawChanges) {
      const path = normalizeRepoPath(item.path);
      if (allSet.has(path)) {
        changedSet.add(path);
      }
      if (item.previousPath) {
        const prev = normalizeRepoPath(item.previousPath);
        if (allSet.has(prev)) {
          changedSet.add(prev);
        }
      }
    }
    changedPaths = [...changedSet];
  }

  return { allPaths, changedPaths };
}
