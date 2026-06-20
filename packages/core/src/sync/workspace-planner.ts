import { basename, dirname } from 'node:path';
import { DEFAULT_WORKSPACE_OPTIONS } from '@feishu-md/shared';
import type { SyncPlan, SyncPlanContext, SyncPlanner } from './planner.js';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isMarkdown(path: string, extensions: string[]): boolean {
  return extensions.some((ext) => path.toLowerCase().endsWith(ext.toLowerCase()));
}

function collectAncestorDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const rawPath of paths) {
    let current = dirname(normalizePath(rawPath));
    while (current !== '.' && current !== '') {
      dirs.add(current);
      current = dirname(current);
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

export class WorkspacePlanner implements SyncPlanner {
  async buildPlan(context: SyncPlanContext): Promise<SyncPlan> {
    const options = context.workspaceOptions ?? DEFAULT_WORKSPACE_OPTIONS;
    const mdExtensions = options.mdExtensions;
    const normalizedTree = context.treePaths.map(normalizePath);
    const changedSet = new Set(context.changedPaths.map(normalizePath));
    const incremental = context.fromSha != null && changedSet.size > 0;

    const mdPaths = normalizedTree.filter((path) => isMarkdown(path, mdExtensions));
    const pathsToSync = incremental
      ? mdPaths.filter((path) => changedSet.has(path))
      : mdPaths;

    const folderSeedPaths = [...pathsToSync];
    if (options.mirrorNonMdFiles) {
      folderSeedPaths.push(...normalizedTree.filter((path) => !isMarkdown(path, mdExtensions)));
    }

    const operations = [];

    for (const dir of collectAncestorDirs(folderSeedPaths)) {
      operations.push({
        type: 'ensure_folder' as const,
        gitPath: dir,
        title: basename(dir),
        parentGitPath: dirname(dir) === '.' ? '' : dirname(dir),
      });
    }

    for (const path of pathsToSync) {
      const content = await context.readMarkdown(path);
      if (content == null) continue;

      operations.push({
        type: 'update_doc' as const,
        gitPath: path,
        sourcePath: path,
        title: basename(path, '.md'),
        parentGitPath: dirname(path) === '.' ? '' : dirname(path),
        contentMarkdown: content,
      });
    }

    return {
      bindingId: context.bindingId,
      trigger: context.trigger,
      fromSha: context.fromSha,
      toSha: context.toSha,
      allTrackedPaths: normalizedTree,
      operations,
    };
  }
}
