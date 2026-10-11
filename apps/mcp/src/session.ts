import { createFeishuClient, type FeishuClient } from '@feishu-md/feishu';
import type { FeishuCredentials } from '@feishu-md/shared';
import {
  appDatabaseExists,
  readCredentialsForBot,
  readDefaultBotId,
  readFeishuBots,
  withAppDatabase,
} from './app-db.js';
import { resolveDataPaths } from './config.js';

/**
 * 一次工具调用使用的飞书客户端。
 * appSecret 只留在进程内，任何工具返回值都不得带出。
 * 客户端按 appId 缓存；凭证每次从数据库重读，这样用户在设置页改完机器人后不用重启 MCP。
 */
export interface FeishuSession {
  client: FeishuClient;
  appId: string;
  botId?: string;
  botName?: string;
  /** env：环境变量；database：本机 SQLite 里的机器人档案或旧版全局凭证 */
  source: 'env' | 'database';
}

const clientCache = new Map<string, FeishuClient>();

function clientFor(credentials: FeishuCredentials): FeishuClient {
  const cached = clientCache.get(credentials.appId);
  if (cached) return cached;
  const client = createFeishuClient(credentials);
  clientCache.set(credentials.appId, client);
  return client;
}

/**
 * 凭证优先级：显式 botId / 机器人名称 → FEISHU_MD_BOT_ID →
 * 同时设置了 FEISHU_APP_ID 与 FEISHU_APP_SECRET → 应用里的默认机器人 → 旧版全局凭证。
 * 环境变量只在没有点名某个机器人时生效，避免盖掉调用方指定的档案。
 */
export async function openFeishuSession(botId?: string): Promise<FeishuSession> {
  const requested = botId?.trim() || process.env.FEISHU_MD_BOT_ID?.trim() || undefined;
  const envId = process.env.FEISHU_APP_ID?.trim();
  const envSecret = process.env.FEISHU_APP_SECRET?.trim();

  if (!requested && envId && envSecret) {
    return {
      client: clientFor({ appId: envId, appSecret: envSecret }),
      appId: envId,
      source: 'env',
    };
  }

  const resolved = withAppDatabase((db) => readCredentialsForBot(db, requested));
  if (!resolved) {
    if (requested) {
      const known = withAppDatabase((db) => readFeishuBots(db))
        .map((bot) => `${bot.name}（${bot.id}）`)
        .join('、');
      throw new Error(`未找到机器人档案「${requested}」。当前档案：${known || '（无）'}`);
    }
    throw new Error(
      '尚未配置飞书凭证。请在应用的设置页保存机器人，或设置环境变量 FEISHU_APP_ID 与 FEISHU_APP_SECRET。',
    );
  }

  return {
    client: clientFor(resolved.credentials),
    appId: resolved.credentials.appId,
    botId: resolved.bot?.id,
    botName: resolved.bot?.name,
    source: 'database',
  };
}

/** 给 feishu_status 用：只暴露档案名称和 appId，不读密钥到返回值。 */
export async function describeCredentialSetup(): Promise<{
  dataDir: string;
  dbPath: string;
  databaseExists: boolean;
  defaultBotId?: string;
  bots: Array<{ id: string; name: string; appId: string }>;
  envCredentials: boolean;
}> {
  const paths = resolveDataPaths();
  const envCredentials = Boolean(process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim());
  if (!appDatabaseExists()) {
    return {
      ...paths,
      databaseExists: false,
      bots: [],
      envCredentials,
    };
  }

  return withAppDatabase((db) => ({
    ...paths,
    databaseExists: true,
    defaultBotId: readDefaultBotId(db),
    bots: readFeishuBots(db).map((bot) => ({ id: bot.id, name: bot.name, appId: bot.appId })),
    envCredentials,
  }));
}
