import { basename, dirname } from 'node:path';
import type { Binding, NodeMapping, RepositoryOptions, SyncMode, WorkspaceOptions } from '@feishu-md/shared';
import {
  DEFAULT_REPOSITORY_OPTIONS,
  isReservedSyncGitPath,
  allSyncDocExtensions,
  syncDocTitleFromPath,
} from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import { deleteNodeMapping, listNodeMappings } from '@feishu-md/db';
import type { FeishuTargetAdapter } from '@feishu-md/feishu';
import type { SyncOperation, SyncPlan } from './planner.js';
import {
  discoverRepositoryContainers,
  discoverStandaloneMarkdownFiles,
  discoverStandaloneTabularFiles,
  repositoryContainerTitle,
  resolveParentForStandaloneFile,
  resolveRepositoryParentLogicalPath,
  standaloneMarkdownTitle,
  standaloneTabularTitle,
} from './repository-paths.js';
import { readSyncableDocumentContent, resolveSyncDocExtensions } from './sync-content.js';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function gitPathDepth(gitPath: string): number {
  if (!gitPath) return 0;
  return normalizePath(gitPath).split('/').length;
}

function mappingStillNeeded(gitPath: string, treePaths: string[]): boolean {
  const normalized = normalizePath(gitPath);
  const treeSet = new Set(treePaths.map(normalizePath));
  if (treeSet.has(normalized)) return true;

  const prefix = normalized ? `${normalized}/` : '';
  return treePaths.some((path) => {
    const item = normalizePath(path);
    return normalized === '' || item.startsWith(prefix);
  });
}

function mappingToNodeRef(mapping: NodeMapping) {
  return {
    token: mapping.feishuNodeToken,
    nodeToken: mapping.feishuNodeToken,
    docToken:
      mapping.feishuDocToken ??
      (mapping.feishuNodeType === 'docx' ? mapping.feishuNodeToken : undefined),
    nodeType: mapping.feishuNodeType,
  };
}

function sortSyncOperations(operations: SyncOperation[]): SyncOperation[] {
  return [...operations].sort((left, right) => {
    const leftIsFolder = left.type === 'ensure_folder' ? 0 : 1;
    const rightIsFolder = right.type === 'ensure_folder' ? 0 : 1;
    if (leftIsFolder !== rightIsFolder) return leftIsFolder - rightIsFolder;
    return gitPathDepth(left.gitPath) - gitPathDepth(right.gitPath);
  });
}

async function buildRepositoryDocRepair(
  mapping: NodeMapping,
  treePaths: string[],
  repositoryOptions: RepositoryOptions,
  bindingName: string,
  readMarkdown: (path: string) => Promise<string | null>,
  gapFillOnly: boolean,
): Promise<SyncOperation | null> {
  const gitPath = normalizePath(mapping.gitPath);
  const containers = discoverRepositoryContainers(treePaths, repositoryOptions.readmeNames);
  const containerPaths = new Set(containers.map((item) => item.logicalPath));
  const container = containers.find((item) => item.logicalPath === gitPath);
  const docExtensions = resolveSyncDocExtensions(undefined, repositoryOptions);

  if (container) {
    if (gapFillOnly) {
      return {
        type: 'ensure_doc',
        gitPath: container.logicalPath,
        sourcePath: container.sourcePath,
        title: repositoryContainerTitle(container.logicalPath, bindingName),
        parentGitPath: resolveRepositoryParentLogicalPath(container.logicalPath, containerPaths),
      };
    }

    const content = await readSyncableDocumentContent(
      container.sourcePath,
      readMarkdown,
      docExtensions,
    );
    if (content == null) return null;
    return {
      type: 'update_doc',
      gitPath: container.logicalPath,
      sourcePath: container.sourcePath,
      title: repositoryContainerTitle(container.logicalPath, bindingName),
      parentGitPath: resolveRepositoryParentLogicalPath(container.logicalPath, containerPaths),
      contentMarkdown: content,
    };
  }

  const containerSourcePaths = new Set(containers.map((item) => item.sourcePath));
  const standaloneMarkdownPaths = discoverStandaloneMarkdownFiles(
    treePaths,
    repositoryOptions.readmeNames,
    containerSourcePaths,
  );
  const standaloneTabularPaths = discoverStandaloneTabularFiles(
    treePaths,
    repositoryOptions.tabularExtensions,
    repositoryOptions.readmeNames,
    containerSourcePaths,
  );
  const standalonePaths = [...standaloneMarkdownPaths, ...standaloneTabularPaths];
  if (!standalonePaths.includes(gitPath)) return null;

  const title = standaloneMarkdownPaths.includes(gitPath)
    ? standaloneMarkdownTitle(gitPath)
    : standaloneTabularTitle(gitPath, docExtensions.tabularExtensions);

  if (gapFillOnly) {
    return {
      type: 'ensure_doc',
      gitPath,
      sourcePath: gitPath,
      title,
      parentGitPath: resolveParentForStandaloneFile(gitPath, containerPaths),
    };
  }

  const content = await readSyncableDocumentContent(gitPath, readMarkdown, docExtensions);
  if (content == null) return null;

  return {
    type: 'update_doc',
    gitPath,
    sourcePath: gitPath,
    title,
    parentGitPath: resolveParentForStandaloneFile(gitPath, containerPaths),
    contentMarkdown: content,
  };
}

async function buildWorkspaceDocRepair(
  mapping: NodeMapping,
  treePaths: string[],
  readMarkdown: (path: string) => Promise<string | null>,
  workspaceOptions: WorkspaceOptions | undefined,
  gapFillOnly: boolean,
): Promise<SyncOperation | null> {
  const gitPath = normalizePath(mapping.gitPath);
  const treeSet = new Set(treePaths.map(normalizePath));
  if (!treeSet.has(gitPath)) return null;

  const docExtensions = resolveSyncDocExtensions(workspaceOptions);
  const title = syncDocTitleFromPath(
    gitPath,
    allSyncDocExtensions(docExtensions.mdExtensions, docExtensions.tabularExtensions),
  );
  const parentDir = dirname(gitPath);
  const parentGitPath = parentDir === '.' ? '' : parentDir;

  if (gapFillOnly) {
    return {
      type: 'ensure_doc',
      gitPath,
      sourcePath: gitPath,
      title,
      parentGitPath,
    };
  }

  const content = await readSyncableDocumentContent(gitPath, readMarkdown, docExtensions);
  if (content == null) return null;

  return {
    type: 'update_doc',
    gitPath,
    sourcePath: gitPath,
    title,
    parentGitPath,
    contentMarkdown: content,
  };
}

function buildFolderRepair(
  mapping: NodeMapping,
  syncMode: SyncMode,
  bindingName: string,
): SyncOperation {
  const gitPath = normalizePath(mapping.gitPath);
  const parentDir = dirname(gitPath);
  const parentGitPath = parentDir === '.' ? '' : parentDir;
  const title =
    syncMode === 'workspace'
      ? basename(gitPath) || bindingName
      : gitPath
        ? basename(gitPath)
        : bindingName;

  return {
    type: 'ensure_folder',
    gitPath,
    title,
    parentGitPath,
  };
}

/**
 * 飞书侧节点已被手动删除、但本地仍有 node_mapping 时，补建同步操作并清理过期映射。
 */
export async function buildRepairOperationsForMissingRemote(options: {
  binding: Binding;
  db: DbClient;
  adapter: FeishuTargetAdapter;
  plan: SyncPlan;
  syncMode: SyncMode;
  bindingName: string;
  readMarkdown: (path: string) => Promise<string | null>;
  workspaceOptions?: WorkspaceOptions;
  repositoryOptions?: RepositoryOptions;
  gapFillOnly?: boolean;
}): Promise<SyncOperation[]> {
  const {
    binding,
    db,
    adapter,
    plan,
    syncMode,
    bindingName,
    readMarkdown,
    workspaceOptions,
    repositoryOptions,
    gapFillOnly = false,
  } = options;

  const mappings = await listNodeMappings(db, binding.id);
  const plannedPaths = new Set(plan.operations.map((operation) => normalizePath(operation.gitPath)));
  const repairs: SyncOperation[] = [];

  for (const mapping of mappings) {
    const gitPath = normalizePath(mapping.gitPath);
    if (isReservedSyncGitPath(gitPath)) continue;
    if (!mappingStillNeeded(gitPath, plan.allTrackedPaths)) continue;
    if (plannedPaths.has(gitPath)) continue;

    const ref = mappingToNodeRef(mapping);
    const exists = await adapter.nodeExists(ref);
    if (exists) continue;

    await deleteNodeMapping(db, mapping.id);
    console.warn(`[sync] 飞书节点已不存在，将重新创建: ${gitPath || '(根)'}`);

    if (mapping.feishuNodeType === 'folder') {
      repairs.push(buildFolderRepair(mapping, syncMode, bindingName));
      continue;
    }

    if (mapping.feishuNodeType !== 'docx') continue;

    const repair =
      syncMode === 'repository'
        ? await buildRepositoryDocRepair(
            mapping,
            plan.allTrackedPaths,
            repositoryOptions ?? DEFAULT_REPOSITORY_OPTIONS,
            bindingName,
            readMarkdown,
            gapFillOnly,
          )
        : await buildWorkspaceDocRepair(
            mapping,
            plan.allTrackedPaths,
            readMarkdown,
            workspaceOptions,
            gapFillOnly,
          );

    if (repair) {
      repairs.push(repair);
    }
  }

  return sortSyncOperations(repairs);
}

export { sortSyncOperations };
