import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Binding, SyncTriggerType, WorkspaceOptions, RepositoryOptions } from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import {
  getFeishuCredentials,
  getNodeMappingByGitPath,
  insertSyncLog,
  listNodeMappings,
  updateBinding,
  updateSyncLog,
  upsertNodeMapping,
} from '@feishu-md/db';
import { createGitProvider, resolveSyncPaths } from '@feishu-md/git';
import {
  createFeishuClient,
  createTargetAdapter,
  resolveRepositoryFeishuTarget,
  type NodeRef,
} from '@feishu-md/feishu';
import { createPlanner } from './sync/factory.js';
import type { SyncPlan } from './sync/planner.js';

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
  operationCount: number;
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

    if (binding.sourceType === 'cloud' && git.fetchLatest) {
      await git.fetchLatest();
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

    const planner = createPlanner(binding.syncMode);
    const plan = await planner.buildPlan({
      bindingId: binding.id,
      bindingName: binding.name,
      trigger,
      fromSha,
      toSha,
      treePaths,
      changedPaths,
      readMarkdown: (path) => git.readFileAtSha(toSha, path),
      workspaceOptions:
        binding.syncMode === 'workspace' ? (binding.options as WorkspaceOptions) : undefined,
      repositoryOptions:
        binding.syncMode === 'repository' ? (binding.options as RepositoryOptions) : undefined,
    });

    const operationCount = await executePlan({
      plan,
      binding,
      db,
      credentials,
      syncMode: binding.syncMode,
    });

    const isIncrementalNoop =
      plan.operations.length === 0 && fromSha != null && !fullResync && treePaths.length > 0;

    if (plan.operations.length === 0 && !isIncrementalNoop) {
      if (treePaths.length === 0) {
        throw new Error('无可同步文件：请确认仓库路径、分支正确，且存在 Git 已跟踪的文件');
      }
      throw new Error(
        '未写入任何内容：仓库模式下各目录需含 README；独立的非 README Markdown 文件也会同步',
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
      message: isIncrementalNoop
        ? '无内容变更，跳过写入'
        : `已同步 ${operationCount} 项`,
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    return { logId, toSha, operationCount };
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
}): Promise<number> {
  const { plan, binding, db, credentials, syncMode } = options;
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
  }> = [];

  for (const operation of plan.operations) {
    const parentToken = await resolveParentToken(db, binding, adapter, operation.parentGitPath);

    switch (operation.type) {
      case 'ensure_folder': {
        const existing = await getNodeMappingByGitPath(db, binding.id, operation.gitPath);
        const folder = existing
          ? mappingToNodeRef(existing)
          : await adapter.ensureFolder(operation.gitPath, parentToken, operation.title ?? operation.gitPath);

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
        const useConfiguredRootDoc =
          operation.gitPath === '' && rootDocumentRef != null && existingRef == null;
        const doc = useConfiguredRootDoc
          ? rootDocumentRef
          : await adapter.ensureDocument(
              operation.gitPath,
              parentToken,
              operation.title ?? operation.gitPath,
              existingRef,
            );

        const docToken = doc.docToken ?? doc.token;
        const contentMarkdown = operation.contentMarkdown ?? '';
        if (contentMarkdown) {
          pendingDocUpdates.push({
            gitPath: operation.gitPath,
            sourcePath: operation.sourcePath ?? operation.gitPath,
            docToken,
            markdown: contentMarkdown,
            previousContentSha: existing?.contentSha,
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
  }

  if (pendingDocUpdates.length > 0) {
    const mappings = await listNodeMappings(db, binding.id);
    const mappingByGitPath = new Map(mappings.map((item) => [item.gitPath, item]));

    for (const pending of pendingDocUpdates) {
      const rewritten = rewriteInternalMarkdownLinks(
        pending.markdown,
        pending.sourcePath,
        mappingByGitPath,
      );
      const rewrittenSha = hashContent(rewritten);
      if (pending.previousContentSha !== rewrittenSha) {
        await adapter.updateDocumentContent(pending.docToken, rewritten);
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

  return count;
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

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function rewriteInternalMarkdownLinks(
  markdown: string,
  sourcePath: string,
  mappingByGitPath: Map<string, Awaited<ReturnType<typeof listNodeMappings>>[number]>,
): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, text: string, href: string) => {
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

function toFeishuDocumentUrl(mapping: Awaited<ReturnType<typeof listNodeMappings>>[number]): string {
  if (mapping.feishuTargetType === 'wiki') {
    return `https://feishu.cn/wiki/${mapping.feishuNodeToken}`;
  }
  const token = mapping.feishuDocToken ?? mapping.feishuNodeToken;
  return `https://feishu.cn/docx/${token}`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export { createPlanner } from './sync/factory.js';
export type { SyncPlan, SyncOperation } from './sync/planner.js';

