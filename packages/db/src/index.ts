import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, and, or, like, desc } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppSettings,
  Binding,
  FeishuCredentials,
  FeishuTarget,
  BindingTriggers,
  NodeMapping,
  SyncLogEntry,
  CommentImportLogEntry,
  WorkspaceOptions,
  RepositoryOptions,
  BotSettings,
  FeishuUserPermission,
  BotBroadcastTarget,
} from '@feishu-md/shared';
import { DEFAULT_BOT_SETTINGS, normalizeBindingTriggers } from '@feishu-md/shared';
import * as schema from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DbClient = BetterSQLite3Database<typeof schema>;

export interface CreateDbOptions {
  dbPath: string;
  runMigrations?: boolean;
}

export function createDb(options: CreateDbOptions): { db: DbClient } {
  mkdirSync(dirname(options.dbPath), { recursive: true });
  const sqlite = new Database(options.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  if (options.runMigrations !== false) {
    migrate(db, { migrationsFolder: join(__dirname, '../drizzle') });
  }

  return { db };
}

function parseBinding(row: typeof schema.bindings.$inferSelect): Binding {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType,
    repoPath: row.repoPath,
    remoteUrl: row.remoteUrl ?? undefined,
    branch: row.branch,
    syncMode: row.syncMode,
    feishuTarget: JSON.parse(row.feishuTargetJson) as FeishuTarget,
    triggers: normalizeBindingTriggers(
      JSON.parse(row.triggersJson) as Partial<BindingTriggers>,
      row.sourceType,
    ),
    options: JSON.parse(row.optionsJson) as WorkspaceOptions | RepositoryOptions,
    bindingSpecificBroadcastTargets: parseBindingBroadcastTargets(
      row.bindingBroadcastTargetsJson,
    ),
    lastSyncedSha: row.lastSyncedSha ?? undefined,
    lastSyncedAt: row.lastSyncedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listBindings(db: DbClient): Promise<Binding[]> {
  const rows = await db.select().from(schema.bindings).orderBy(schema.bindings.createdAt);
  return rows.map(parseBinding);
}

export async function getBinding(db: DbClient, id: string): Promise<Binding | null> {
  const rows = await db.select().from(schema.bindings).where(eq(schema.bindings.id, id)).limit(1);
  const row = rows[0];
  return row ? parseBinding(row) : null;
}

export async function insertBinding(db: DbClient, binding: Binding): Promise<void> {
  await db.insert(schema.bindings).values({
    id: binding.id,
    name: binding.name,
    sourceType: binding.sourceType,
    repoPath: binding.repoPath,
    remoteUrl: binding.remoteUrl,
    branch: binding.branch,
      syncMode: binding.syncMode,
      feishuTargetJson: JSON.stringify(binding.feishuTarget),
      triggersJson: JSON.stringify(binding.triggers),
      optionsJson: JSON.stringify(binding.options),
      bindingBroadcastTargetsJson: serializeBindingBroadcastTargets(
        binding.bindingSpecificBroadcastTargets,
      ),
      lastSyncedSha: binding.lastSyncedSha,
      lastSyncedAt: binding.lastSyncedAt,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
  });
}

function parseBindingBroadcastTargets(
  json: string | null | undefined,
): BotBroadcastTarget[] | undefined {
  if (!json || json === '[]') return undefined;
  const parsed = JSON.parse(json) as BotBroadcastTarget[];
  return parsed.length > 0 ? parsed : undefined;
}

function serializeBindingBroadcastTargets(
  targets: BotBroadcastTarget[] | undefined,
): string {
  if (targets === undefined || targets.length === 0) return '[]';
  return JSON.stringify(targets);
}

export async function updateBinding(db: DbClient, binding: Binding): Promise<void> {
  await db
    .update(schema.bindings)
    .set({
      name: binding.name,
      sourceType: binding.sourceType,
      repoPath: binding.repoPath,
      remoteUrl: binding.remoteUrl,
      branch: binding.branch,
      syncMode: binding.syncMode,
      feishuTargetJson: JSON.stringify(binding.feishuTarget),
      triggersJson: JSON.stringify(binding.triggers),
      optionsJson: JSON.stringify(binding.options),
      bindingBroadcastTargetsJson: serializeBindingBroadcastTargets(
        binding.bindingSpecificBroadcastTargets,
      ),
      lastSyncedSha: binding.lastSyncedSha,
      lastSyncedAt: binding.lastSyncedAt,
      updatedAt: binding.updatedAt,
    })
    .where(eq(schema.bindings.id, binding.id));
}

export async function deleteBinding(db: DbClient, id: string): Promise<void> {
  await db.delete(schema.bindings).where(eq(schema.bindings.id, id));
}

export async function listSyncLogs(db: DbClient, bindingId?: string): Promise<SyncLogEntry[]> {
  const query = db.select().from(schema.syncLogs).orderBy(desc(schema.syncLogs.startedAt));
  const rows = bindingId
    ? await query.where(eq(schema.syncLogs.bindingId, bindingId))
    : await query;

  return rows.map((row) => ({
    id: row.id,
    bindingId: row.bindingId,
    trigger: row.trigger,
    fromSha: row.fromSha ?? undefined,
    toSha: row.toSha ?? undefined,
    status: row.status,
    message: row.message ?? undefined,
    progressPhase: row.progressPhase ?? undefined,
    progressDone: row.progressDone ?? undefined,
    progressTotal: row.progressTotal ?? undefined,
    currentGitPath: row.currentGitPath ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
  }));
}

export async function getSyncLog(db: DbClient, id: string): Promise<SyncLogEntry | null> {
  const rows = await db.select().from(schema.syncLogs).where(eq(schema.syncLogs.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    bindingId: row.bindingId,
    trigger: row.trigger,
    fromSha: row.fromSha ?? undefined,
    toSha: row.toSha ?? undefined,
    status: row.status,
    message: row.message ?? undefined,
    progressPhase: row.progressPhase ?? undefined,
    progressDone: row.progressDone ?? undefined,
    progressTotal: row.progressTotal ?? undefined,
    currentGitPath: row.currentGitPath ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
  };
}

export async function insertSyncLog(db: DbClient, entry: SyncLogEntry): Promise<void> {
  await db.insert(schema.syncLogs).values({
    id: entry.id,
    bindingId: entry.bindingId,
    trigger: entry.trigger,
    fromSha: entry.fromSha,
    toSha: entry.toSha,
    status: entry.status,
    message: entry.message,
    progressPhase: entry.progressPhase,
    progressDone: entry.progressDone,
    progressTotal: entry.progressTotal,
    currentGitPath: entry.currentGitPath,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  });
}

export async function updateSyncLog(db: DbClient, entry: SyncLogEntry): Promise<void> {
  await db
    .update(schema.syncLogs)
    .set({
      status: entry.status,
      message: entry.message,
      toSha: entry.toSha,
      finishedAt: entry.finishedAt,
      progressPhase: entry.progressPhase,
      progressDone: entry.progressDone,
      progressTotal: entry.progressTotal,
      currentGitPath: entry.currentGitPath,
    })
    .where(eq(schema.syncLogs.id, entry.id));
}

/** 启动时兜底：将历史未完成日志统一标记失败 */
export async function failUnfinishedSyncLogs(db: DbClient, message = '服务重启，未完成任务已放弃'): Promise<number> {
  const runningRows = await db
    .select({ id: schema.syncLogs.id, bindingId: schema.syncLogs.bindingId, trigger: schema.syncLogs.trigger })
    .from(schema.syncLogs)
    .where(
      or(
        eq(schema.syncLogs.status, 'pending'),
        eq(schema.syncLogs.status, 'running'),
      ),
    );

  const finishedAt = new Date().toISOString();
  for (const row of runningRows) {
    await db
      .update(schema.syncLogs)
      .set({
        status: 'failed',
        message,
        finishedAt,
      })
      .where(eq(schema.syncLogs.id, row.id));
  }
  return runningRows.length;
}

export async function getNodeMappingByGitPath(
  db: DbClient,
  bindingId: string,
  gitPath: string,
): Promise<NodeMapping | null> {
  const rows = await db
    .select()
    .from(schema.nodeMappings)
    .where(and(eq(schema.nodeMappings.bindingId, bindingId), eq(schema.nodeMappings.gitPath, gitPath)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    bindingId: row.bindingId,
    gitPath: row.gitPath,
    feishuTargetType: row.feishuTargetType,
    feishuNodeToken: row.feishuNodeToken,
    feishuDocToken: row.feishuDocToken ?? undefined,
    feishuNodeType: row.feishuNodeType,
    feishuParentToken: row.feishuParentToken ?? undefined,
    contentSha: row.contentSha ?? undefined,
  };
}

export async function upsertNodeMapping(db: DbClient, mapping: NodeMapping): Promise<void> {
  const existing = await getNodeMappingByGitPath(db, mapping.bindingId, mapping.gitPath);
  if (existing) {
    await db
      .update(schema.nodeMappings)
      .set({
        feishuNodeToken: mapping.feishuNodeToken,
        feishuDocToken: mapping.feishuDocToken,
        feishuNodeType: mapping.feishuNodeType,
        feishuParentToken: mapping.feishuParentToken,
        contentSha: mapping.contentSha,
      })
      .where(eq(schema.nodeMappings.id, existing.id));
    return;
  }

  await db.insert(schema.nodeMappings).values({
    id: mapping.id,
    bindingId: mapping.bindingId,
    gitPath: mapping.gitPath,
    feishuTargetType: mapping.feishuTargetType,
    feishuNodeToken: mapping.feishuNodeToken,
    feishuDocToken: mapping.feishuDocToken,
    feishuNodeType: mapping.feishuNodeType,
    feishuParentToken: mapping.feishuParentToken,
    contentSha: mapping.contentSha,
  });
}

export async function deleteNodeMapping(db: DbClient, id: string): Promise<void> {
  await db.delete(schema.nodeMappings).where(eq(schema.nodeMappings.id, id));
}

export async function deleteNodeMappingsByBindingAndPrefix(
  db: DbClient,
  bindingId: string,
  gitPathPrefix: string,
): Promise<number> {
  if (!gitPathPrefix) return 0;
  const result = await db
    .delete(schema.nodeMappings)
    .where(
      and(
        eq(schema.nodeMappings.bindingId, bindingId),
        like(schema.nodeMappings.gitPath, `${gitPathPrefix}/%`),
      ),
    );
  return result.changes ?? 0;
}

export async function listNodeMappings(db: DbClient, bindingId: string): Promise<NodeMapping[]> {
  const rows = await db
    .select()
    .from(schema.nodeMappings)
    .where(eq(schema.nodeMappings.bindingId, bindingId));

  return rows.map((row) => ({
    id: row.id,
    bindingId: row.bindingId,
    gitPath: row.gitPath,
    feishuTargetType: row.feishuTargetType,
    feishuNodeToken: row.feishuNodeToken,
    feishuDocToken: row.feishuDocToken ?? undefined,
    feishuNodeType: row.feishuNodeType,
    feishuParentToken: row.feishuParentToken ?? undefined,
    contentSha: row.contentSha ?? undefined,
  }));
}

export async function getAppSetting<T>(db: DbClient, key: string): Promise<T | null> {
  const rows = await db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .limit(1);
  const row = rows[0];
  return row ? (JSON.parse(row.valueJson) as T) : null;
}

export async function setAppSetting<T>(db: DbClient, key: string, value: T): Promise<void> {
  await db
    .insert(schema.appSettings)
    .values({ key, valueJson: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { valueJson: JSON.stringify(value) },
    });
}

export async function getFeishuCredentials(db: DbClient): Promise<FeishuCredentials | null> {
  return getAppSetting<FeishuCredentials>(db, 'feishu_credentials');
}

export async function setFeishuCredentials(
  db: DbClient,
  credentials: FeishuCredentials,
): Promise<void> {
  await setAppSetting(db, 'feishu_credentials', credentials);
}

export async function getAppSettings(db: DbClient): Promise<AppSettings> {
  const feishu = await getFeishuCredentials(db);
  const bot = await getBotSettings(db);
  const userPermissions = await getFeishuUserPermissions(db);
  const dataDir = await getAppSetting<string>(db, 'data_dir');
  return {
    feishu: feishu ?? undefined,
    bot,
    userPermissions,
    dataDir: dataDir ?? undefined,
  };
}

export async function getBotSettings(db: DbClient): Promise<BotSettings> {
  const stored = await getAppSetting<BotSettings>(db, 'bot_settings');
  return stored ?? { ...DEFAULT_BOT_SETTINGS };
}

export async function setBotSettings(db: DbClient, settings: BotSettings): Promise<void> {
  await setAppSetting(db, 'bot_settings', settings);
}

export async function getFeishuUserPermissions(db: DbClient): Promise<FeishuUserPermission[]> {
  const stored = await getAppSetting<FeishuUserPermission[]>(db, 'feishu_user_permissions');
  return stored ?? [];
}

export async function setFeishuUserPermissions(
  db: DbClient,
  permissions: FeishuUserPermission[],
): Promise<void> {
  await setAppSetting(db, 'feishu_user_permissions', permissions);
}

export async function listCommentImportLogs(
  db: DbClient,
  bindingId?: string,
): Promise<CommentImportLogEntry[]> {
  const query = db.select().from(schema.commentImportLogs).orderBy(schema.commentImportLogs.startedAt);
  const rows = bindingId
    ? await query.where(eq(schema.commentImportLogs.bindingId, bindingId))
    : await query;

  return rows.map((row) => ({
    id: row.id,
    bindingId: row.bindingId,
    trigger: row.trigger,
    status: row.status,
    message: row.message ?? undefined,
    documentCount: row.documentCount ?? undefined,
    commentCount: row.commentCount ?? undefined,
    replyCount: row.replyCount ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
  }));
}

export async function getCommentImportLog(
  db: DbClient,
  id: string,
): Promise<CommentImportLogEntry | null> {
  const rows = await db
    .select()
    .from(schema.commentImportLogs)
    .where(eq(schema.commentImportLogs.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    bindingId: row.bindingId,
    trigger: row.trigger,
    status: row.status,
    message: row.message ?? undefined,
    documentCount: row.documentCount ?? undefined,
    commentCount: row.commentCount ?? undefined,
    replyCount: row.replyCount ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
  };
}

export async function insertCommentImportLog(
  db: DbClient,
  entry: CommentImportLogEntry,
): Promise<void> {
  await db.insert(schema.commentImportLogs).values({
    id: entry.id,
    bindingId: entry.bindingId,
    trigger: entry.trigger,
    status: entry.status,
    message: entry.message,
    documentCount: entry.documentCount,
    commentCount: entry.commentCount,
    replyCount: entry.replyCount,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  });
}

export async function updateCommentImportLog(
  db: DbClient,
  entry: CommentImportLogEntry,
): Promise<void> {
  await db
    .update(schema.commentImportLogs)
    .set({
      status: entry.status,
      message: entry.message,
      documentCount: entry.documentCount,
      commentCount: entry.commentCount,
      replyCount: entry.replyCount,
      finishedAt: entry.finishedAt,
    })
    .where(eq(schema.commentImportLogs.id, entry.id));
}

/** 启动时兜底：将历史未完成评论导入日志统一标记失败 */
export async function failUnfinishedCommentImportLogs(
  db: DbClient,
  message = '服务重启，未完成任务已放弃',
): Promise<number> {
  const runningRows = await db
    .select({
      id: schema.commentImportLogs.id,
      bindingId: schema.commentImportLogs.bindingId,
      trigger: schema.commentImportLogs.trigger,
      startedAt: schema.commentImportLogs.startedAt,
    })
    .from(schema.commentImportLogs)
    .where(
      or(
        eq(schema.commentImportLogs.status, 'pending'),
        eq(schema.commentImportLogs.status, 'running'),
      ),
    );

  const finishedAt = new Date().toISOString();
  for (const row of runningRows) {
    await db
      .update(schema.commentImportLogs)
      .set({
        status: 'failed',
        message,
        finishedAt,
      })
      .where(eq(schema.commentImportLogs.id, row.id));
  }
  return runningRows.length;
}

export { schema };
