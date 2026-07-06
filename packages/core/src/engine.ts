import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Binding, SyncTriggerType, WorkspaceOptions, RepositoryOptions } from '@feishu-md/shared';
import { isReservedSyncGitPath, filterPathsByProjectIgnoreGlobs, mergeProjectIgnoreGlobs } from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import {
  deleteNodeMapping,
  deleteNodeMappingsByBindingAndPrefix,
  getFeishuCredentials,
  getNodeMappingByGitPath,
  insertSyncLog,
  listNodeMappings,
  updateBinding,
  updateSyncLog,
  upsertNodeMapping,
} from '@feishu-md/db';
import { createGitProvider, fetchRemoteForSync, resolveSyncPaths } from '@feishu-md/git';
import {
  createFeishuClient,
  createTargetAdapter,
  extractMarkdownImageRefs,
  FeishuApiError,
  readGitImageBinary,
  resolveMarkdownImageGitPathCandidates,
  resolveRepositoryFeishuTarget,
  toFeishuDocumentUrl,
  formatFeishuErrorMessage,
  type MarkdownImageResolver,
  type NodeRef,
} from '@feishu-md/feishu';
import { createPlanner } from './sync/factory.js';
import {
  buildRepairOperationsForMissingRemote,
  sortSyncOperations,
} from './sync/repair-missing-nodes.js';
import { syncOverviewWhiteboard } from './sync/overview-whiteboard.js';
import { readSyncableDocumentContent, resolveSyncDocExtensions } from './sync/sync-content.js';
import type { SyncOperation, SyncPlan } from './sync/planner.js';

export interface RunSyncOptions {
  binding: Binding;
  db: DbClient;
  trigger: SyncTriggerType;
  fullResync?: boolean;
  /** 由队列预先创建的日志 ID */
  logId?: string;
}

export interface RunSyncResult {
  logId: string;
  toSha: string;
  fromSha?: string;
  operationCount: number;
  commits: Array<{ sha: string; subject: string; body: string; message: string }>;
  changedPaths: string[];
}

export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const { binding, db, trigger, fullResync } = options;
  const logId = options.logId ?? randomUUID();
  const startedAt = new Date().toISOString();

  if (options.logId) {
    await updateSyncLog(db, {
      id: logId,
      bindingId: binding.id,
      trigger,
      fromSha: fullResync ? undefined : binding.lastSyncedSha,
      status: 'running',
      startedAt,
    });
  } else {
    await insertSyncLog(db, {
      id: logId,
      bindingId: binding.id,
      trigger,
      fromSha: fullResync ? undefined : binding.lastSyncedSha,
      status: 'running',
      startedAt,
    });
  }

  try {
    const credentials = await getFeishuCredentials(db);
    if (!credentials) {
      throw new Error('Feishu credentials are not configured');
    }

    const git = createGitProvider(
      {
        repoPath: binding.repoPath,
        branch: binding.branch,
        remoteUrl: binding.remoteUrl,
      },
      binding.sourceType,
    );

    if (binding.sourceType === 'cloud') {
      await fetchRemoteForSync(git);
    }

    const toSha = await git.getHeadSha();
    const fromSha = fullResync ? undefined : binding.lastSyncedSha;

    const projectIgnoreGlobs =
      binding.syncMode === 'workspace'
        ? (binding.options as WorkspaceOptions).ignoreGlobs
        : (binding.options as RepositoryOptions).ignoreGlobs;

    const { allPaths: treePaths, changedPaths } = await resolveSyncPaths({
      git,
      sha: toSha,
      projectIgnoreGlobs,
      fromSha,
    });

    const commits = await git.getCommitsBetween(fromSha, toSha);
    const broadcastChangedPaths = fullResync
      ? changedPaths
      : fromSha
        ? changedPaths
        : filterPathsByProjectIgnoreGlobs(
            await git.getCommitFilePaths(toSha),
            mergeProjectIgnoreGlobs(projectIgnoreGlobs),
          );

    const readMarkdown = (path: string) => git.readFileAtSha(toSha, path);
    const readBinaryFile = (path: string) => git.readBinaryFileAtSha(toSha, path);
    const workspaceOptions =
      binding.syncMode === 'workspace' ? (binding.options as WorkspaceOptions) : undefined;
    const repositoryOptions =
      binding.syncMode === 'repository' ? (binding.options as RepositoryOptions) : undefined;
    const docExtensions = resolveSyncDocExtensions(workspaceOptions, repositoryOptions);
    const readSyncContent = (path: string) =>
      readSyncableDocumentContent(path, readMarkdown, docExtensions);

    const planner = createPlanner(binding.syncMode);
    const plan = await planner.buildPlan({
      bindingId: binding.id,
      bindingName: binding.name,
      trigger,
      fromSha,
      toSha,
      fullResync,
      treePaths,
      changedPaths,
      readMarkdown: readSyncContent,
      workspaceOptions,
      repositoryOptions,
    });

    const { operationCount, overviewUpdated } = await executePlan({
      plan,
      binding,
      db,
      credentials,
      syncMode: binding.syncMode,
      readMarkdown: readSyncContent,
      readBinaryFile,
      workspaceOptions,
      repositoryOptions,
    });

    const isIncrementalNoop =
      plan.operations.length === 0 && fromSha != null && !fullResync && treePaths.length > 0;

    const isGapFillNoop = plan.gapFillOnly === true && operationCount === 0 && treePaths.length > 0;

    if (plan.operations.length === 0 && !isIncrementalNoop && !isGapFillNoop && fullResync !== true) {
      if (treePaths.length === 0) {
        throw new Error('无可同步文件：请确认仓库路径、分支正确，且存在 Git 已跟踪的文件');
      }
      throw new Error(
        '未写入任何内容：仓库模式下各目录需含 README；独立的 Markdown 与 CSV 文件也会同步',
      );
    }

    const updatedBinding: Binding = {
      ...binding,
      lastSyncedSha: toSha,
      lastSyncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await updateBinding(db, updatedBinding);

    await updateSyncLog(db, {
      id: logId,
      bindingId: binding.id,
      trigger,
      fromSha,
      toSha,
      status: 'success',
      message: isGapFillNoop
        ? overviewUpdated
          ? '飞书结构完整，已更新同步文档总览'
          : '飞书结构完整，无需补缺'
        : isIncrementalNoop
          ? overviewUpdated
            ? '无正文变更，已更新同步文档总览'
            : '无内容变更，跳过写入'
          : fullResync
            ? overviewUpdated
              ? `已完全重新搭建 ${operationCount} 项，已更新同步文档总览`
              : `已完全重新搭建 ${operationCount} 项`
            : overviewUpdated
              ? `已同步 ${operationCount} 项，已更新同步文档总览`
              : `已同步 ${operationCount} 项`,
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    return {
      logId,
      toSha,
      fromSha,
      operationCount,
      commits,
      changedPaths: broadcastChangedPaths,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSyncLog(db, {
      id: logId,
      bindingId: binding.id,
      trigger,
      fromSha: binding.lastSyncedSha,
      status: 'failed',
      message,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function executePlan(options: {
  plan: SyncPlan;
  binding: Binding;
  db: DbClient;
  credentials: { appId: string; appSecret: string };
  syncMode: Binding['syncMode'];
  readMarkdown: (path: string) => Promise<string | null>;
  readBinaryFile: (path: string) => Promise<Uint8Array | null>;
  workspaceOptions?: WorkspaceOptions;
  repositoryOptions?: RepositoryOptions;
}): Promise<{ operationCount: number; overviewUpdated: boolean }> {
  const {
    plan,
    binding,
    db,
    credentials,
    syncMode,
    readMarkdown,
    readBinaryFile,
    workspaceOptions,
    repositoryOptions,
  } = options;
  const gapFillOnly = plan.gapFillOnly === true;
  const client = createFeishuClient(credentials);

  const resolved =
    syncMode === 'repository'
      ? await resolveRepositoryFeishuTarget(client, binding.feishuTarget)
      : { target: binding.feishuTarget, rootDocument: undefined };

  const adapter = createTargetAdapter(resolved.target, client);
  const rootDocumentRef: NodeRef | undefined = resolved.rootDocument
    ? {
        token: resolved.rootDocument.nodeToken,
        nodeToken: resolved.rootDocument.nodeToken,
        docToken: resolved.rootDocument.docToken,
        nodeType: 'docx',
        title: resolved.rootDocument.title,
      }
    : undefined;

  let count = 0;
  const pendingDocUpdates: Array<{
    gitPath: string;
    sourcePath: string;
    docToken: string;
    markdown: string;
    previousContentSha?: string;
    forceWrite?: boolean;
  }> = [];

  const existingMappings = await listNodeMappings(db, binding.id);

  let operations: SyncOperation[] = [...plan.operations];
  if (gapFillOnly) {
    const repairs = await buildRepairOperationsForMissingRemote({
      binding,
      db,
      adapter,
      plan,
      syncMode,
      bindingName: binding.name,
      readMarkdown,
      workspaceOptions,
      repositoryOptions,
      gapFillOnly: true,
    });
    const plannedPaths = new Set(operations.map((operation) => normalizePath(operation.gitPath)));
    for (const repair of repairs) {
      const gitPath = normalizePath(repair.gitPath);
      if (plannedPaths.has(gitPath)) continue;
      operations.push(repair);
      plannedPaths.add(gitPath);
    }
    operations = sortSyncOperations(operations);
  }

  for (const operation of operations) {
    const parentToken = await resolveParentToken(db, binding, adapter, operation.parentGitPath);

    try {
      switch (operation.type) {
        case 'ensure_folder': {
          const existing = await getNodeMappingByGitPath(db, binding.id, operation.gitPath);
          if (existing && (await adapter.nodeExists(mappingToNodeRef(existing)))) {
            break;
          }

          const folder = await adapter.ensureFolder(
            operation.gitPath,
            parentToken,
            operation.title ?? operation.gitPath,
          );

          await upsertNodeMapping(db, {
            id: existing?.id ?? randomUUID(),
            bindingId: binding.id,
            gitPath: operation.gitPath,
            feishuTargetType: resolved.target.type,
            feishuNodeToken: folder.nodeToken ?? folder.token,
            feishuDocToken: folder.docToken,
            feishuNodeType: 'folder',
            feishuParentToken: parentToken,
          });
          count += 1;
          break;
        }
        case 'update_doc':
        case 'ensure_doc': {
          const existing = await getNodeMappingByGitPath(db, binding.id, operation.gitPath);
          const existingRef = existing ? mappingToNodeRef(existing) : undefined;
          const remoteExists = existingRef ? await adapter.nodeExists(existingRef) : false;
          const contentNeverSynced = !existing?.contentSha;

          if (gapFillOnly && remoteExists && !contentNeverSynced) {
            break;
          }

          const useConfiguredRootDoc =
            operation.gitPath === '' && rootDocumentRef != null && existingRef == null;
          const doc = useConfiguredRootDoc
            ? rootDocumentRef
            : await adapter.ensureDocument(
                operation.gitPath,
                parentToken,
                operation.title ?? operation.gitPath,
                remoteExists ? existingRef : undefined,
              );

          const docToken = doc.docToken ?? doc.token;
          const sourcePath = operation.sourcePath ?? operation.gitPath;
          const shouldWriteContent = !gapFillOnly || !remoteExists || contentNeverSynced;
          let contentMarkdown = operation.contentMarkdown;

          if (shouldWriteContent && !contentMarkdown) {
            contentMarkdown = (await readMarkdown(sourcePath)) ?? undefined;
          }

          if (shouldWriteContent && contentMarkdown) {
            pendingDocUpdates.push({
              gitPath: operation.gitPath,
              sourcePath,
              docToken,
              markdown: contentMarkdown,
              previousContentSha: gapFillOnly ? undefined : existing?.contentSha,
              forceWrite: operation.forceWrite || (gapFillOnly && (!remoteExists || contentNeverSynced)),
            });
          }

          await upsertNodeMapping(db, {
            id: existing?.id ?? randomUUID(),
            bindingId: binding.id,
            gitPath: operation.gitPath,
            feishuTargetType: resolved.target.type,
            feishuNodeToken: doc.nodeToken ?? doc.token,
            feishuDocToken: docToken,
            feishuNodeType: 'docx',
            feishuParentToken: parentToken,
          });
          count += 1;
          break;
        }
        default:
          break;
      }
    } catch (error) {
      const detail = formatFeishuErrorMessage(error);
      const gitPath = operation.gitPath || '(根)';
      throw new Error(`同步失败 file=${gitPath} operation=${operation.type}: ${detail}`, { cause: error });
    }
  }

  const deletedCount = await deleteRemovedNodes({
    db,
    binding,
    adapter,
    treePaths: plan.allTrackedPaths,
    existingMappings,
  });
  count += deletedCount;

  if (pendingDocUpdates.length > 0) {
    const mappings = await listNodeMappings(db, binding.id);
    const mappingByGitPath = new Map(mappings.map((item) => [item.gitPath, item]));

    for (const pending of pendingDocUpdates) {
      const rewritten = rewriteInternalMarkdownLinks(
        pending.markdown,
        pending.sourcePath,
        mappingByGitPath,
      );
      const rewrittenSha = await hashDocumentSyncContent(
        rewritten,
        pending.sourcePath,
        readBinaryFile,
      );
      if (pending.forceWrite || pending.previousContentSha !== rewrittenSha) {
        try {
          await adapter.updateDocumentContent(pending.docToken, rewritten, {
            sourcePath: pending.sourcePath,
            resolveImage: createMarkdownImageResolver(pending.sourcePath, readBinaryFile),
          });
        } catch (error) {
          const detail = formatFeishuErrorMessage(error);
          throw new Error(`同步文档失败 file=${pending.gitPath}: ${detail}`, { cause: error });
        }

        const latest = await getNodeMappingByGitPath(db, binding.id, pending.gitPath);
        if (latest) {
          await upsertNodeMapping(db, {
            ...latest,
            contentSha: rewrittenSha,
          });
        }
      }
    }
  }

  let overviewUpdated = false;
  try {
    overviewUpdated = await syncOverviewWhiteboard({
      binding,
      db,
      client,
      adapter,
      targetType: resolved.target.type,
      syncMode,
    });
  } catch (error) {
    console.warn(`[sync] 同步文档总览更新失败: ${formatFeishuErrorMessage(error)}`);
  }

  return { operationCount: count, overviewUpdated };
}

async function deleteRemovedNodes(options: {
  db: DbClient;
  binding: Binding;
  adapter: ReturnType<typeof createTargetAdapter>;
  treePaths: string[];
  existingMappings: Awaited<ReturnType<typeof listNodeMappings>>;
}): Promise<number> {
  const { db, binding, adapter, treePaths, existingMappings } = options;
  const normalizedTree = treePaths.map((path) => path.replace(/\\/g, '/'));
  const treeSet = new Set(normalizedTree);

  const toDelete = existingMappings.filter((mapping) => {
    const gitPath = mapping.gitPath.replace(/\\/g, '/');
    if (isReservedSyncGitPath(gitPath)) return false;
    if (treeSet.has(gitPath)) return false;
    const hasDescendant = normalizedTree.some((path) => path.startsWith(`${gitPath}/`));
    return !hasDescendant;
  });

  toDelete.sort((a, b) => gitPathDepth(b.gitPath) - gitPathDepth(a.gitPath));

  let count = 0;
  for (const mapping of toDelete) {
    try {
      await adapter.deleteNode(mapping.feishuNodeToken, mapping.feishuNodeType);
      count += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sync] 删除节点失败，视为已删除并清理本地映射: ${message}`, {
        gitPath: mapping.gitPath,
        nodeType: mapping.feishuNodeType,
        nodeToken: mapping.feishuNodeToken,
      });
    }
    await deleteNodeMappingsByBindingAndPrefix(db, binding.id, mapping.gitPath);
    await deleteNodeMapping(db, mapping.id);
  }

  return count;
}

function gitPathDepth(gitPath: string): number {
  if (!gitPath) return 0;
  return gitPath.replace(/\\/g, '/').split('/').length;
}

async function resolveParentToken(
  db: DbClient,
  binding: Binding,
  adapter: ReturnType<typeof createTargetAdapter>,
  parentGitPath?: string,
): Promise<string | undefined> {
  if (parentGitPath == null) {
    return adapter.getRootParentToken();
  }

  const parentMapping = await getNodeMappingByGitPath(db, binding.id, parentGitPath);
  if (parentMapping) {
    return parentMapping.feishuNodeToken;
  }

  return adapter.getRootParentToken();
}

function mappingToNodeRef(mapping: Awaited<ReturnType<typeof getNodeMappingByGitPath>> & object): NodeRef {
  return {
    token: mapping.feishuNodeToken,
    nodeToken: mapping.feishuNodeToken,
    docToken: mapping.feishuDocToken ?? (mapping.feishuNodeType === 'docx' ? mapping.feishuNodeToken : undefined),
    nodeType: mapping.feishuNodeType,
  };
}

/** 正文哈希叠加本地图片 blob；含版本号以便图片上传逻辑变更后触发重同步 */
const DOCUMENT_SYNC_HASH_VERSION = 'image-sync-v13';

async function hashDocumentSyncContent(
  markdown: string,
  sourcePath: string,
  readBinaryFile: (path: string) => Promise<Uint8Array | null>,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(DOCUMENT_SYNC_HASH_VERSION);
  hash.update('\0');
  hash.update(markdown);

  const refs = extractMarkdownImageRefs(markdown);
  const sortedRefs = [...refs].sort((a, b) => a.src.localeCompare(b.src));

  for (const ref of sortedRefs) {
    const candidates = resolveMarkdownImageGitPathCandidates(sourcePath, ref.src);
    if (candidates.length === 0) continue;

    hash.update('\0img\0');
    hash.update(candidates[0]!);

    const resolved = await readGitImageBinary(readBinaryFile, sourcePath, ref.src);
    if (resolved) {
      hash.update(createHash('sha256').update(resolved.data).digest('hex'));
    }
  }

  return hash.digest('hex');
}

function createMarkdownImageResolver(
  sourcePath: string,
  readBinaryFile: (path: string) => Promise<Uint8Array | null>,
): MarkdownImageResolver {
  return async (src, _alt) => {
    const raw = src.trim();
    if (!raw || raw.startsWith('data:')) return null;

    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return fetchRemoteImage(raw);
    }

    const resolved = await readGitImageBinary(readBinaryFile, sourcePath, raw);
    if (!resolved) return null;

    return {
      data: resolved.data,
      fileName: fileNameFromPath(resolved.gitPath),
    };
  };
}

function fileNameFromPath(path: string): string {
  const name = posix.basename(path);
  return name || 'image.png';
}

async function fetchRemoteImage(
  url: string,
): Promise<{ data: Uint8Array; fileName: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0) return null;

    const fileName = fileNameFromUrl(url) ?? 'image.png';
    return { data, fileName };
  } catch {
    return null;
  }
}

function fileNameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const name = posix.basename(pathname);
    return name || null;
  } catch {
    return null;
  }
}

function rewriteInternalMarkdownLinks(
  markdown: string,
  sourcePath: string,
  mappingByGitPath: Map<string, Awaited<ReturnType<typeof listNodeMappings>>[number]>,
): string {
  return markdown.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, text: string, href: string) => {
    const resolved = resolveInternalLinkTarget(sourcePath, href, mappingByGitPath);
    if (!resolved) return full;
    return `[${text}](${resolved})`;
  });
}

function resolveInternalLinkTarget(
  sourcePath: string,
  href: string,
  mappingByGitPath: Map<string, Awaited<ReturnType<typeof listNodeMappings>>[number]>,
): string | null {
  const raw = href.trim();
  if (!raw) return null;
  if (
    raw.startsWith('#') ||
    raw.startsWith('http://') ||
    raw.startsWith('https://') ||
    raw.startsWith('mailto:') ||
    raw.startsWith('tel:')
  ) {
    return null;
  }

  const hashIndex = raw.indexOf('#');
  const pathPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const anchor = hashIndex >= 0 ? raw.slice(hashIndex) : '';
  if (!pathPart) return null;

  const normalizedSource = normalizePath(sourcePath);
  const baseDir = posix.dirname(normalizedSource) === '.' ? '' : posix.dirname(normalizedSource);
  const resolved = normalizePath(posix.normalize(posix.join(baseDir, pathPart)));
  const mapping = findLinkTargetMapping(resolved, mappingByGitPath);
  if (!mapping) return null;

  return `${toFeishuDocumentUrl(mapping)}${anchor}`;
}

function findLinkTargetMapping(
  resolvedPath: string,
  mappingByGitPath: Map<string, Awaited<ReturnType<typeof listNodeMappings>>[number]>,
) {
  const candidates = new Set<string>([resolvedPath.replace(/\/+$/, '')]);
  if (!candidates.has(resolvedPath)) candidates.add(resolvedPath);

  if (!posix.extname(resolvedPath)) {
    candidates.add(`${resolvedPath}.md`);
    candidates.add(`${resolvedPath}/README.md`);
    candidates.add(`${resolvedPath}/readme.md`);
    candidates.add(`${resolvedPath}/Readme.md`);
  }

  for (const candidate of [...candidates]) {
    if (candidate.toLowerCase().endsWith('/readme.md')) {
      const dir = posix.dirname(candidate);
      candidates.add(dir === '.' ? '' : dir);
    }
  }

  for (const candidate of candidates) {
    const mapping = mappingByGitPath.get(normalizePath(candidate));
    if (mapping) return mapping;
  }
  return null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export { createPlanner } from './sync/factory.js';
export type { SyncPlan, SyncOperation } from './sync/planner.js';
