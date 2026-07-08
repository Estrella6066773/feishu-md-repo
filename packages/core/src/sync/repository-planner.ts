import {
  DEFAULT_REPOSITORY_OPTIONS,
  createLogger,
  matchesAnyProjectPathGlob,
  shouldForceUpdateForTrigger,
} from '@feishu-md/shared';
import type { SyncPlan, SyncPlanContext, SyncPlanner } from './planner.js';
import {
  discoverRepositoryContainers,
  discoverStandaloneMarkdownFiles,
  discoverStandaloneTabularFiles,
  isRepositoryContainerDirty,
  isStandaloneFileDirty,
  repositoryContainerTitle,
  resolveParentForStandaloneFile,
  resolveRepositoryParentLogicalPath,
  standaloneMarkdownTitle,
  standaloneTabularTitle,
} from './repository-paths.js';
import { readSyncableDocumentContent, resolveSyncDocExtensions } from './sync-content.js';

const plannerLog = createLogger('sync-planner');

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

export class RepositoryPlanner implements SyncPlanner {
  async buildPlan(context: SyncPlanContext): Promise<SyncPlan> {
    const options = { ...DEFAULT_REPOSITORY_OPTIONS, ...context.repositoryOptions };
    const docExtensions = resolveSyncDocExtensions(undefined, options);
    const forceUpdateGlobs = shouldForceUpdateForTrigger(options.forceUpdateMode, context.trigger)
      ? (options.forceUpdateGlobs ?? [])
      : [];
    const normalizedTree = context.treePaths.map(normalizePath);
    const changedSet = new Set(context.changedPaths.map(normalizePath));
    const fullRebuild = context.fullResync === true;
    const forceRewriteAll = context.forceRewriteAll === true;
    const gapFillOnly = false;
    const incremental = !fullRebuild && context.fromSha != null && changedSet.size > 0;
    const rootTitle = context.bindingName?.trim() || context.bindingId;

    const containers = discoverRepositoryContainers(normalizedTree, options.readmeNames);
    const containerPaths = new Set(containers.map((item) => item.logicalPath));
    const containerSourcePaths = new Set(containers.map((item) => item.sourcePath));
    const operations = [];

    for (const container of containers) {
      const forceWrite = forceRewriteAll || isForceUpdatedContainer(container, forceUpdateGlobs);
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

      const content = await readSyncableDocumentContent(
        container.sourcePath,
        context.readMarkdown,
        docExtensions,
      );
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

      const content = await readSyncableDocumentContent(filePath, context.readMarkdown, docExtensions);
      if (content == null) continue;

      const forceWrite = forceRewriteAll || matchesAnyProjectPathGlob(filePath, forceUpdateGlobs);
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

    for (const filePath of discoverStandaloneTabularFiles(
      normalizedTree,
      options.tabularExtensions,
      options.readmeNames,
      containerSourcePaths,
    )) {
      if (gapFillOnly) {
        operations.push({
          type: 'ensure_doc' as const,
          gitPath: filePath,
          sourcePath: filePath,
          title: standaloneTabularTitle(filePath, options.tabularExtensions),
          parentGitPath: resolveParentForStandaloneFile(filePath, containerPaths),
        });
        continue;
      }

      const content = await readSyncableDocumentContent(filePath, context.readMarkdown, docExtensions);
      if (content == null) continue;

      const forceWrite = forceRewriteAll || matchesAnyProjectPathGlob(filePath, forceUpdateGlobs);
      if (!forceWrite && !isStandaloneFileDirty(filePath, changedSet, incremental)) continue;

      operations.push({
        type: 'update_doc' as const,
        gitPath: filePath,
        sourcePath: filePath,
        title: standaloneTabularTitle(filePath, options.tabularExtensions),
        parentGitPath: resolveParentForStandaloneFile(filePath, containerPaths),
        contentMarkdown: content,
        forceWrite,
      });
    }

    const counts = operations.reduce<Record<string, number>>((acc, op) => {
      acc[op.type] = (acc[op.type] ?? 0) + 1;
      return acc;
    }, {});
    plannerLog.debug('同步规划摘要', { syncMode: 'repository', ...counts, total: operations.length });

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
