import { randomUUID, createHash } from 'node:crypto';
import type { Binding, SyncTriggerType, WorkspaceOptions, RepositoryOptions } from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import {
  getFeishuCredentials,
  getNodeMappingByGitPath,
  insertSyncLog,
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
        const contentSha = hashContent(contentMarkdown);

        if (existing?.contentSha !== contentSha && contentMarkdown) {
          await adapter.updateDocumentContent(docToken, contentMarkdown);
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
          contentSha,
        });
        count += 1;
        break;
      }
      default:
        break;
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

export { createPlanner } from './sync/factory.js';
export type { SyncPlan, SyncOperation } from './sync/planner.js';

