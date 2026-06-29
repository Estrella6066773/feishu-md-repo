import { basename, dirname } from 'node:path';
import {
  DEFAULT_WORKSPACE_OPTIONS,
  matchesAnyProjectPathGlob,
  shouldForceUpdateForTrigger,
} from '@feishu-md/shared';
import { markdownReferencesChangedImages } from '@feishu-md/feishu';
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
    const forceUpdateGlobs = shouldForceUpdateForTrigger(options.forceUpdateMode, context.trigger)
      ? (options.forceUpdateGlobs ?? [])
      : [];
    const normalizedTree = context.treePaths.map(normalizePath);
    const changedSet = new Set(context.changedPaths.map(normalizePath));
    const fullRebuild = context.fullResync === true;
    const gapFillOnly = false;
    const incremental = !fullRebuild && context.fromSha != null && changedSet.size > 0;

    const mdPaths = normalizedTree.filter((path) => isMarkdown(path, mdExtensions));
    const forceUpdatePaths = mdPaths.filter((path) =>
      matchesAnyProjectPathGlob(path, forceUpdateGlobs),
    );
    const pathsToSync = incremental
      ? mergePaths(
          await filterIncrementalMarkdownPaths({
            mdPaths,
            changedSet,
            readMarkdown: context.readMarkdown,
          }),
          forceUpdatePaths,
        )
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
      if (gapFillOnly) {
        operations.push({
          type: 'ensure_doc' as const,
          gitPath: path,
          sourcePath: path,
          title: basename(path, '.md'),
          parentGitPath: dirname(path) === '.' ? '' : dirname(path),
        });
        continue;
      }

      const content = await context.readMarkdown(path);
      if (content == null) continue;

      operations.push({
        type: 'update_doc' as const,
        gitPath: path,
        sourcePath: path,
        title: basename(path, '.md'),
        parentGitPath: dirname(path) === '.' ? '' : dirname(path),
        contentMarkdown: content,
        forceWrite: fullRebuild || matchesAnyProjectPathGlob(path, forceUpdateGlobs),
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

function mergePaths(first: string[], second: string[]): string[] {
  const merged = new Set(first);
  for (const path of second) {
    merged.add(path);
  }
  return [...merged];
}

async function filterIncrementalMarkdownPaths(options: {
  mdPaths: string[];
  changedSet: Set<string>;
  readMarkdown: SyncPlanContext['readMarkdown'];
}): Promise<string[]> {
  const { mdPaths, changedSet, readMarkdown } = options;
  const directChanges = mdPaths.filter((path) => changedSet.has(path));
  if (directChanges.length === mdPaths.length) {
    return directChanges;
  }

  const selected = new Set(directChanges);
  const hasNonMarkdownChanges = [...changedSet].some((path) => !isMarkdown(path, ['.md', '.markdown']));

  if (!hasNonMarkdownChanges) {
    return directChanges;
  }

  for (const path of mdPaths) {
    if (selected.has(path)) continue;
    const content = await readMarkdown(path);
    if (content == null) continue;
    if (markdownReferencesChangedImages(content, path, changedSet)) {
      selected.add(path);
    }
  }

  return mdPaths.filter((path) => selected.has(path));
}
