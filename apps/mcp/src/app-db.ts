import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { FeishuBotProfile, FeishuCredentials, FeishuTarget } from '@feishu-md/shared';
import { resolveDataPaths } from './config.js';

/**
 * 只读打开桌面应用的 app.db。
 *
 * 不使用 @feishu-md/db：那个包依赖 better-sqlite3，原生模块必须和编译它的 Node ABI 一致。
 * Cursor 启动 MCP 时用的是 PATH 上的 node，经常和当初编译原生模块的版本不同，一打开就报 NODE_MODULE_VERSION。
 * node:sqlite 跟当前 Node 一起发布，没有这层原生插件。
 *
 * 这里只执行 SELECT。表结构以 packages/db/src/schema.ts 为准，列名变更时要同步改 SQL。
 * 不跑迁移，避免 MCP 改用户的库。
 */

export interface StoredBindingSummary {
  id: string;
  name: string;
  repoPath: string;
  branch: string;
  syncMode: string;
  feishuTarget: FeishuTarget;
  botId?: string;
}

export interface StoredNodeMapping {
  gitPath: string;
  feishuTargetType: 'wiki' | 'drive';
  feishuNodeToken: string;
  feishuDocToken?: string;
  feishuNodeType: 'folder' | 'docx' | 'file';
  feishuParentToken?: string;
  feishuUrl?: string;
}

interface BindingRow {
  id: string;
  name: string;
  repo_path: string;
  branch: string;
  sync_mode: string;
  feishu_target_json: string;
  bot_id: string | null;
}

interface MappingRow {
  git_path: string;
  feishu_target_type: 'wiki' | 'drive';
  feishu_node_token: string;
  feishu_doc_token: string | null;
  feishu_node_type: 'folder' | 'docx' | 'file';
  feishu_parent_token: string | null;
  feishu_url: string | null;
}

export function appDatabaseExists(): boolean {
  return existsSync(resolveDataPaths().dbPath);
}

export function withAppDatabase<T>(read: (db: DatabaseSync) => T): T {
  const { dbPath } = resolveDataPaths();
  if (!existsSync(dbPath)) {
    throw new Error(
      `找不到本机数据库 ${dbPath}。请先启动飞书文档同步应用并保存飞书应用凭证，或设置 FEISHU_MD_DATA_DIR 指向已有数据目录。`,
    );
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function readAppSetting<T>(db: DatabaseSync, key: string): T | null {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.value_json) as T;
}

export function readFeishuBots(db: DatabaseSync): FeishuBotProfile[] {
  return readAppSetting<FeishuBotProfile[]>(db, 'feishu_bots') ?? [];
}

export function readDefaultBotId(db: DatabaseSync): string | undefined {
  return readAppSetting<{ defaultBotId?: string }>(db, 'bot_settings')?.defaultBotId;
}

/**
 * 与 packages/db 的 resolveFeishuCredentials 同一优先级：
 * 点名的机器人 → 默认机器人 → 旧版全局 feishu_credentials。
 * 按名称匹配只在 MCP 里额外支持，数据库函数只认 id。
 */
export function readCredentialsForBot(
  db: DatabaseSync,
  requested?: string,
): { credentials: FeishuCredentials; bot?: FeishuBotProfile } | null {
  const bots = readFeishuBots(db);
  const targetId = requested || readDefaultBotId(db);
  if (targetId) {
    const profile = bots.find((bot) => bot.id === targetId || bot.name === targetId);
    if (profile) {
      return {
        bot: profile,
        credentials: { appId: profile.appId, appSecret: profile.appSecret },
      };
    }
    if (requested) return null;
  }

  const legacy = readAppSetting<FeishuCredentials>(db, 'feishu_credentials');
  if (legacy?.appId && legacy.appSecret) return { credentials: legacy };
  return null;
}

export function listStoredBindings(db: DatabaseSync): StoredBindingSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, repo_path, branch, sync_mode, feishu_target_json, bot_id
       FROM bindings
       ORDER BY created_at`,
    )
    .all() as unknown as BindingRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    branch: row.branch,
    syncMode: row.sync_mode,
    feishuTarget: JSON.parse(row.feishu_target_json) as FeishuTarget,
    botId: row.bot_id ?? undefined,
  }));
}

export function listStoredNodeMappings(db: DatabaseSync, bindingId: string): StoredNodeMapping[] {
  const rows = db
    .prepare(
      `SELECT git_path, feishu_target_type, feishu_node_token, feishu_doc_token,
              feishu_node_type, feishu_parent_token, feishu_url
       FROM node_mappings
       WHERE binding_id = ?`,
    )
    .all(bindingId) as unknown as MappingRow[];

  return rows.map((row) => ({
    gitPath: row.git_path,
    feishuTargetType: row.feishu_target_type,
    feishuNodeToken: row.feishu_node_token,
    feishuDocToken: row.feishu_doc_token ?? undefined,
    feishuNodeType: row.feishu_node_type,
    feishuParentToken: row.feishu_parent_token ?? undefined,
    feishuUrl: row.feishu_url ?? undefined,
  }));
}

export interface ManagedDocumentHit {
  bindingId: string;
  bindingName: string;
  gitPath: string;
}

/**
 * 用 document_id / node_token / URL 反查本机同步映射。
 * 写工具用来提示：这篇飞书文档下次 Git 同步会被仓库文件覆盖。
 */
export function findManagedDocuments(
  db: DatabaseSync,
  tokens: Array<string | undefined>,
): ManagedDocumentHit[] {
  const needles = tokens.map((token) => token?.trim()).filter((token): token is string => Boolean(token));
  if (needles.length === 0) return [];

  const hits: ManagedDocumentHit[] = [];
  for (const binding of listStoredBindings(db)) {
    for (const mapping of listStoredNodeMappings(db, binding.id)) {
      const haystack = [
        mapping.feishuDocToken,
        mapping.feishuNodeToken,
        mapping.feishuUrl,
      ]
        .filter(Boolean)
        .join('\n');
      if (!needles.some((needle) => haystack.includes(needle))) continue;
      hits.push({
        bindingId: binding.id,
        bindingName: binding.name,
        gitPath: mapping.gitPath,
      });
    }
  }
  return hits;
}
