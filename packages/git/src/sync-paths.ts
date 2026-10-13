import {
  filterPathsByProjectIgnoreGlobs,
  matchesAnyProjectPathGlob,
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

export interface ResolveForceUpdateOnlyPathsOptions {
  git: GitProvider;
  sha: string;
  projectIgnoreGlobs?: string[];
  forceUpdateGlobs: string[];
}

/**
 * 立即同步确认 HEAD 未前进时使用。
 * 只列出命中强制更新规则的已跟踪路径，再对这一小撮做 export-ignore。
 * 不要改走 resolveSyncPaths：后者会对仓库里每一个已跟踪文件单独起一次 git check-attr。
 * 返回值不是完整树。调用方不能拿它判断哪些飞书节点该删除。
 */
export async function resolveForceUpdateOnlyPaths(
  options: ResolveForceUpdateOnlyPathsOptions,
): Promise<string[]> {
  const globs = options.forceUpdateGlobs.map((glob) => glob.trim()).filter((glob) => glob.length > 0);
  if (globs.length === 0) return [];

  const projectGlobs = mergeProjectIgnoreGlobs(options.projectIgnoreGlobs);
  const gitTracked = await options.git.listTrackedPathsAtSha(options.sha);
  const matched = gitTracked.filter((path) =>
    matchesAnyProjectPathGlob(normalizeRepoPath(path), globs),
  );
  const afterIgnore = filterPathsByProjectIgnoreGlobs(matched, projectGlobs);
  return options.git.filterPathsByGitExportIgnore(options.sha, afterIgnore);
}
