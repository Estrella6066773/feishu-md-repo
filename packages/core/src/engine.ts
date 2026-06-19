import { randomUUID, createHash } from 'node:crypto';
import type { Binding, SyncTriggerType } from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import {
  getFeishuCredentials,
  getNodeMappingByGitPath,
  insertSyncLog,
  updateBinding,
  updateSyncLog,
  upsertNodeMapping,
} from '@feishu-md/db';
import { createGitProvider } from '@feishu-md/git';
import { createFeishuClient, createTargetAdapter, type NodeRef } from '@feishu-md/feishu';
import { createPlanner } from './sync/factory.js';
import type { SyncPlan } from './sync/planner.js';

export interface RunSyncOptions {
  binding: Binding;
  db: DbClient;
  trigger: SyncTriggerType;
  fullResync?: boolean;
}

export interface RunSyncResult {
  logId: string;
  toSha: string;
  operationCount: number;
}

export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  const { binding, db, trigger, fullResync } = options;
  const logId = randomUUID();
  const startedAt = new Date().toISOString();

  await insertSyncLog(db, {
    id: logId,
    bindingId: binding.id,
    trigger,
    fromSha: fullResync ? undefined : binding.lastSyncedSha,
    status: 'running',
    startedAt,
  });

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

    const tree = await git.getTreeAtSha(toSha);
    const treePaths = tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
    const changedPaths =
      fromSha != null ? (await git.getChangedPaths(fromSha, toSha)).map((item) => item.path) : treePaths;

    const planner = createPlanner(binding.syncMode);
    const plan = await planner.buildPlan({
      bindingId: binding.id,
      trigger,
      fromSha,
      toSha,
      treePaths,
      changedPaths,
      readMarkdown: (path) => git.readFileAtSha(toSha, path),
    });

    const operationCount = await executePlan({
      plan,
      binding,
      db,
      credentials,
    });

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
      message: `Synced ${operationCount} operations`,
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
}): Promise<number> {
  const { plan, binding, db, credentials } = options;
  const client = createFeishuClient(credentials);
  const adapter = createTargetAdapter(binding.feishuTarget, client);

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
          feishuTargetType: binding.feishuTarget.type,
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
        const doc = await adapter.ensureDocument(
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
          feishuTargetType: binding.feishuTarget.type,
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
  if (!parentGitPath) {
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
