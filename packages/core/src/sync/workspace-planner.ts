import { basename, dirname } from 'node:path';
import {
  DEFAULT_WORKSPACE_OPTIONS,
  allSyncDocExtensions,
  createLogger,
  isSyncableDocPath,
  matchesAnyProjectPathGlob,
  pathEndsWithExtension,
  shouldForceUpdateForTrigger,
  syncDocTitleFromPath,
} from '@feishu-md/shared';
import { markdownReferencesChangedImages } from '@feishu-md/feishu';
import type { SyncPlan, SyncPlanContext, SyncPlanner } from './planner.js';
import { readSyncableDocumentContent, resolveSyncDocExtensions } from './sync-content.js';

const plannerLog = createLogger('sync-planner');

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
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
    const options = { ...DEFAULT_WORKSPACE_OPTIONS, ...context.workspaceOptions };
    const docExtensions = resolveSyncDocExtensions(options);
    const { mdExtensions, tabularExtensions } = docExtensions;
    const allExtensions = allSyncDocExtensions(mdExtensions, tabularExtensions);
    const forceUpdateGlobs = shouldForceUpdateForTrigger(options.forceUpdateMode, context.trigger)
      ? (options.forceUpdateGlobs ?? [])
      : [];
    const normalizedTree = context.treePaths.map(normalizePath);
    const changedSet = new Set(context.changedPaths.map(normalizePath));
    const fullRebuild = context.fullResync === true;
    const gapFillOnly = false;
    const incremental = !fullRebuild && context.fromSha != null && changedSet.size > 0;

    const docPaths = normalizedTree.filter((path) =>
      isSyncableDocPath(path, mdExtensions, tabularExtensions),
    );
    const forceUpdatePaths = docPaths.filter((path) =>
      matchesAnyProjectPathGlob(path, forceUpdateGlobs),
    );
    const pathsToSync = incremental
      ? mergePaths(
          await filterIncrementalDocPaths({
            docPaths,
            changedSet,
            mdExtensions,
            tabularExtensions,
            readMarkdown: context.readMarkdown,
          }),
          forceUpdatePaths,
        )
      : docPaths;

    const folderSeedPaths = [...pathsToSync];
    if (options.mirrorNonMdFiles) {
      folderSeedPaths.push(
        ...normalizedTree.filter((path) => !isSyncableDocPath(path, mdExtensions, tabularExtensions)),
      );
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
      const title = syncDocTitleFromPath(path, allExtensions);
      const parentGitPath = dirname(path) === '.' ? '' : dirname(path);

      if (gapFillOnly) {
        operations.push({
          type: 'ensure_doc' as const,
          gitPath: path,
          sourcePath: path,
          title,
          parentGitPath,
        });
        continue;
      }

      const content = await readSyncableDocumentContent(path, context.readMarkdown, docExtensions);
      if (content == null) continue;

      operations.push({
        type: 'update_doc' as const,
        gitPath: path,
        sourcePath: path,
        title,
        parentGitPath,
        contentMarkdown: content,
        forceWrite: fullRebuild || matchesAnyProjectPathGlob(path, forceUpdateGlobs),
      });
    }

    logPlanSummary('workspace', operations);

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

function logPlanSummary(syncMode: string, operations: SyncPlan['operations']): void {
  const counts = operations.reduce<Record<string, number>>((acc, op) => {
    acc[op.type] = (acc[op.type] ?? 0) + 1;
    return acc;
  }, {});
  plannerLog.debug('同步规划摘要', { syncMode, ...counts, total: operations.length });
}

function mergePaths(first: string[], second: string[]): string[] {
  const merged = new Set(first);
  for (const path of second) {
    merged.add(path);
  }
  return [...merged];
}

async function filterIncrementalDocPaths(options: {
  docPaths: string[];
  changedSet: Set<string>;
  mdExtensions: string[];
  tabularExtensions: string[];
  readMarkdown: SyncPlanContext['readMarkdown'];
}): Promise<string[]> {
  const { docPaths, changedSet, mdExtensions, tabularExtensions, readMarkdown } = options;
  const directChanges = docPaths.filter((path) => changedSet.has(path));
  if (directChanges.length === docPaths.length) {
    return directChanges;
  }

  const selected = new Set(directChanges);
  const hasNonDocChanges = [...changedSet].some(
    (path) => !isSyncableDocPath(path, mdExtensions, tabularExtensions),
  );

  if (!hasNonDocChanges) {
    return directChanges;
  }

  for (const path of docPaths) {
    if (selected.has(path)) continue;
    if (!pathEndsWithExtension(path, mdExtensions)) continue;
    const content = await readMarkdown(path);
    if (content == null) continue;
    if (markdownReferencesChangedImages(content, path, changedSet)) {
      selected.add(path);
    }
  }

  return docPaths.filter((path) => selected.has(path));
}
