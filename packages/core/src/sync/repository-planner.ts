import {
  DEFAULT_REPOSITORY_OPTIONS,
  matchesAnyProjectPathGlob,
  shouldForceUpdateForTrigger,
} from '@feishu-md/shared';
import type { SyncPlan, SyncPlanContext, SyncPlanner } from './planner.js';
import {
  discoverRepositoryContainers,
  discoverStandaloneMarkdownFiles,
  isRepositoryContainerDirty,
  isStandaloneFileDirty,
  repositoryContainerTitle,
  resolveParentForStandaloneFile,
  resolveRepositoryParentLogicalPath,
  standaloneMarkdownTitle,
} from './repository-paths.js';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export class RepositoryPlanner implements SyncPlanner {
  async buildPlan(context: SyncPlanContext): Promise<SyncPlan> {
    const options = context.repositoryOptions ?? DEFAULT_REPOSITORY_OPTIONS;
    const forceUpdateGlobs = shouldForceUpdateForTrigger(options.forceUpdateMode, context.trigger)
      ? (options.forceUpdateGlobs ?? [])
      : [];
    const normalizedTree = context.treePaths.map(normalizePath);
    const changedSet = new Set(context.changedPaths.map(normalizePath));
    const fullRebuild = context.fullResync === true;
    const gapFillOnly = false;
    const incremental = !fullRebuild && context.fromSha != null && changedSet.size > 0;
    const rootTitle = context.bindingName?.trim() || context.bindingId;

    const containers = discoverRepositoryContainers(normalizedTree, options.readmeNames);
    const containerPaths = new Set(containers.map((item) => item.logicalPath));
    const containerSourcePaths = new Set(containers.map((item) => item.sourcePath));
    const operations = [];

    for (const container of containers) {
      const forceWrite = fullRebuild || isForceUpdatedContainer(container, forceUpdateGlobs);
      if (!gapFillOnly && !forceWrite && !isRepositoryContainerDirty(container, changedSet, incremental)) continue;

      if (gapFillOnly) {
        operations.push({
          type: 'ensure_doc' as const,
          gitPath: container.logicalPath,
          sourcePath: container.sourcePath,
          title: repositoryContainerTitle(container.logicalPath, rootTitle),
          parentGitPath: resolveRepositoryParentLogicalPath(container.logicalPath, containerPaths),
        });
        continue;
      }

      const content = await context.readMarkdown(container.sourcePath);
      if (content == null) continue;

      operations.push({
        type: 'update_doc' as const,
        gitPath: container.logicalPath,
        sourcePath: container.sourcePath,
        title: repositoryContainerTitle(container.logicalPath, rootTitle),
        parentGitPath: resolveRepositoryParentLogicalPath(container.logicalPath, containerPaths),
        contentMarkdown: content,
        forceWrite,
      });
    }

    for (const filePath of discoverStandaloneMarkdownFiles(
      normalizedTree,
      options.readmeNames,
      containerSourcePaths,
    )) {
      if (gapFillOnly) {
        operations.push({
          type: 'ensure_doc' as const,
          gitPath: filePath,
          sourcePath: filePath,
          title: standaloneMarkdownTitle(filePath),
          parentGitPath: resolveParentForStandaloneFile(filePath, containerPaths),
        });
        continue;
      }

      const content = await context.readMarkdown(filePath);
      if (content == null) continue;

      const forceWrite = fullRebuild || matchesAnyProjectPathGlob(filePath, forceUpdateGlobs);
      if (!forceWrite && !isStandaloneFileDirty(filePath, changedSet, incremental, content)) continue;

      operations.push({
        type: 'update_doc' as const,
        gitPath: filePath,
        sourcePath: filePath,
        title: standaloneMarkdownTitle(filePath),
        parentGitPath: resolveParentForStandaloneFile(filePath, containerPaths),
        contentMarkdown: content,
        forceWrite,
      });
    }

    return {
      bindingId: context.bindingId,
      trigger: context.trigger,
      fromSha: context.fromSha,
      toSha: context.toSha,
      allTrackedPaths: normalizedTree,
      gapFillOnly,
      operations,
    };
  }
}

function isForceUpdatedContainer(
  container: { logicalPath: string; sourcePath: string },
  forceUpdateGlobs: string[],
): boolean {
  if (matchesAnyProjectPathGlob(container.sourcePath, forceUpdateGlobs)) return true;
  return Boolean(container.logicalPath) && matchesAnyProjectPathGlob(container.logicalPath, forceUpdateGlobs);
}
