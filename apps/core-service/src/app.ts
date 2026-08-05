import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import type { DbClient } from '@feishu-md/db';
import {
  deleteBinding,
  getAppSettings,
  getBinding,
  getBotSettings,
  getCommentImportLog,
  getFeishuBots,
  getFeishuUserPermissions,
  insertBinding,
  listBindings,
  listCommentImportLogs,
  listSyncLogs,
  getSyncLog,
  resolveFeishuCredentials,
  setBotSettings,
  setFeishuBots,
  setFeishuCredentials,
  setFeishuUserPermissions,
  updateBinding,
} from '@feishu-md/db';
import type {
  Binding,
  BotSettings,
  CommentImportRequest,
  FeishuCredentials,
  FeishuBotProfile,
  FeishuUserPermission,
  SyncRequest,
} from '@feishu-md/shared';
import {
  defaultOptionsForMode,
  defaultTriggersForSourceType,
  normalizeBindingTriggers,
  DEFAULT_BOT_SETTINGS,
  createLogger,
  isDebugEnabled,
  CORE_API_FEATURES,
  CORE_API_VERSION,
} from '@feishu-md/shared';
import { installLocalHook, readLocalOriginUrl, removeLocalHook, remoteUrlsEqual } from '@feishu-md/git';
import { createFeishuClient, exportDocumentToMarkdown, appendMermaidBoardToDocument, formatExportError } from '@feishu-md/feishu';
import type { Scheduler, SyncQueue } from './scheduler.js';
import type { CommentImportCoordinator } from './comment-import-coordinator.js';
import type { SyncCoordinator } from './sync-coordinator.js';
import type { BotManager } from './bot/manager.js';
import type { ServiceConfig } from './config.js';
import { getPublicBaseUrl } from './config.js';

function applyLocalGitHook(binding: Binding, coreServiceUrl: string, previous?: Binding): void {
  if (previous?.sourceType === 'local' && previous.repoPath !== binding.repoPath) {
    removeLocalHook(previous.repoPath);
  }

  if (binding.sourceType === 'local' && binding.triggers.onGitCommit) {
    installLocalHook({
      repoPath: binding.repoPath,
      bindingId: binding.id,
      coreServiceUrl,
    });
    return;
  }

  if (binding.repoPath) {
    removeLocalHook(binding.repoPath);
  }
}

export { CORE_API_VERSION, CORE_API_FEATURES } from '@feishu-md/shared';

/** UI 读取/轮询类 GET，非 debug 且成功时不打访问日志；写操作与错误仍记录 */
function shouldSkipHttpAccessLog(method: string, status: number): boolean {
  if (isDebugEnabled()) {
    return false;
  }
  if (method !== 'GET') {
    return false;
  }
  return status < 400;
}

/** 脱敏后的机器人档案（不返回 appSecret） */
function toPublicBot(bot: FeishuBotProfile): {
  id: string;
  name: string;
  appId: string;
  appSecretConfigured: boolean;
} {
  return {
    id: bot.id,
    name: bot.name,
    appId: bot.appId,
    appSecretConfigured: Boolean(bot.appSecret),
  };
}

export function createApp(options: {
  db: DbClient;
  config: ServiceConfig;
  queue: SyncQueue;
  scheduler: Scheduler;
  syncCoordinator: SyncCoordinator;
  commentImportCoordinator: CommentImportCoordinator;
  botManager: BotManager;
}) {
  const app = new Hono();
  const { db, config, queue, scheduler, syncCoordinator, commentImportCoordinator, botManager } = options;
  const httpLog = createLogger('http');

  app.use(
    '*',
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );

  app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    await next();
    const status = c.res.status;
    if (shouldSkipHttpAccessLog(method, status)) {
      return;
    }
    const durationMs = Date.now() - start;
    const message = `${method} ${path} ${status}`;
    if (status >= 500) {
      httpLog.error(message, { durationMs });
    } else if (status >= 400) {
      httpLog.warn(message, { durationMs });
    } else {
      httpLog.info(message, { durationMs });
    }
  });

  app.onError((err, c) => {
    httpLog.error('未处理请求异常', { path: c.req.path, method: c.req.method }, err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: 'feishu-md-core',
      version: '0.1.0',
      apiVersion: CORE_API_VERSION,
      features: [...CORE_API_FEATURES],
      queue: queue.getStatus(),
      botConnection: botManager.getStatus(),
    }),
  );

  app.get('/api/settings', async (c) => {
    const settings = await getAppSettings(db);
    const botStatus = botManager.getStatus();
    return c.json({
      ...settings,
      feishu: settings.feishu
        ? { appId: settings.feishu.appId, appSecretConfigured: Boolean(settings.feishu.appSecret) }
        : undefined,
      feishuBots: (settings.feishuBots ?? []).map(toPublicBot),
      bot: settings.bot ?? DEFAULT_BOT_SETTINGS,
      userPermissions: settings.userPermissions ?? [],
      botConnection: botStatus,
      dataDir: config.dataDir,
      coreServiceUrl: getPublicBaseUrl(config),
    });
  });

  app.put('/api/settings/feishu', async (c) => {
    const body = (await c.req.json()) as FeishuCredentials;
    if (!body.appId || !body.appSecret) {
      return c.json({ error: 'appId and appSecret are required' }, 400);
    }
    await setFeishuCredentials(db, body);
    await botManager.refresh();
    httpLog.info('飞书凭证已更新', { appId: body.appId });
    return c.json({ ok: true });
  });

  app.get('/api/settings/bot', async (c) => {
    const bot = await getBotSettings(db);
    return c.json({ ...bot, connection: botManager.getStatus() });
  });

  app.put('/api/settings/bot', async (c) => {
    const body = (await c.req.json()) as BotSettings;
    if (body.defaultBotId) {
      const bots = await getFeishuBots(db);
      if (!bots.some((bot) => bot.id === body.defaultBotId)) {
        return c.json({ error: '指定的默认机器人不存在，请先创建机器人档案' }, 400);
      }
    }
    await setBotSettings(db, { ...DEFAULT_BOT_SETTINGS, ...body });
    await botManager.refresh();
    httpLog.info('机器人设置已更新', { enabled: body.enabled });
    return c.json({ ok: true, connection: botManager.getStatus() });
  });

  app.get('/api/settings/bots', async (c) => {
    const bots = await getFeishuBots(db);
    return c.json(bots.map(toPublicBot));
  });

  app.post('/api/settings/bots', async (c) => {
    const body = (await c.req.json()) as Partial<FeishuBotProfile>;
    const name = body.name?.trim();
    const appId = body.appId?.trim();
    const appSecret = body.appSecret?.trim();
    if (!name || !appId || !appSecret) {
      return c.json({ error: 'name、appId 与 appSecret 均为必填' }, 400);
    }
    const bots = await getFeishuBots(db);
    if (bots.some((bot) => bot.appId === appId)) {
      return c.json({ error: '该 App ID 已存在，请勿重复添加' }, 400);
    }
    const bot: FeishuBotProfile = { id: randomUUID(), name, appId, appSecret };
    bots.push(bot);
    await setFeishuBots(db, bots);
    httpLog.info('机器人档案已创建', { botId: bot.id, botName: bot.name, appId });
    return c.json({ ok: true, bot: toPublicBot(bot) }, 201);
  });

  app.put('/api/settings/bots/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as Partial<FeishuBotProfile>;
    const bots = await getFeishuBots(db);
    const index = bots.findIndex((bot) => bot.id === id);
    if (index < 0) return c.json({ error: 'Not found' }, 404);
    const existing = bots[index];
    if (!existing) return c.json({ error: 'Not found' }, 404);
    const name = body.name?.trim();
    const appId = body.appId?.trim();
    if (!name || !appId) {
      return c.json({ error: 'name 与 appId 均为必填' }, 400);
    }
    if (bots.some((bot) => bot.id !== id && bot.appId === appId)) {
      return c.json({ error: '该 App ID 已被其他机器人使用' }, 400);
    }
    const next: FeishuBotProfile = {
      id,
      name,
      appId,
      // appSecret 缺省表示不修改（编辑时不回显）
      appSecret: body.appSecret?.trim() || existing.appSecret,
    };
    bots[index] = next;
    await setFeishuBots(db, bots);
    await botManager.refresh();
    httpLog.info('机器人档案已更新', { botId: id, botName: next.name });
    return c.json({ ok: true, bot: toPublicBot(next) });
  });

  app.delete('/api/settings/bots/:id', async (c) => {
    const id = c.req.param('id');
    const bots = await getFeishuBots(db);
    const bot = bots.find((item) => item.id === id);
    if (!bot) return c.json({ error: 'Not found' }, 404);

    const referencingBindings = (await listBindings(db)).filter(
      (binding) => binding.botId === id,
    );
    if (referencingBindings.length > 0) {
      return c.json(
        {
          error: `该机器人正被项目「${referencingBindings.map((binding) => binding.name).join('、')}」使用，请先在对应项目中更换机器人`,
          referencingBindingNames: referencingBindings.map((binding) => binding.name),
        },
        409,
      );
    }

    const settings = await getBotSettings(db);
    if (settings.defaultBotId === id) {
      await setBotSettings(db, { ...settings, defaultBotId: undefined });
    }
    await setFeishuBots(db, bots.filter((item) => item.id !== id));
    await botManager.refresh();
    httpLog.info('机器人档案已删除', { botId: id, botName: bot.name });
    return c.json({ ok: true });
  });

  app.get('/api/settings/user-permissions', async (c) => {
    const userPermissions = await getFeishuUserPermissions(db);
    return c.json(userPermissions);
  });

  app.put('/api/settings/user-permissions', async (c) => {
    const body = (await c.req.json()) as FeishuUserPermission[];
    if (!Array.isArray(body)) {
      return c.json({ error: 'Expected an array of user permissions' }, 400);
    }
    for (const item of body) {
      if (!item.openId?.trim() || !item.role) {
        return c.json({ error: 'Each entry requires openId and role' }, 400);
      }
      if (item.role === 'manager' && (!item.bindingIds || item.bindingIds.length === 0)) {
        return c.json({ error: 'Manager role requires at least one bindingId' }, 400);
      }
    }
    await setFeishuUserPermissions(db, body);
    return c.json({ ok: true });
  });

  app.get('/api/bindings', async (c) => {
    const bindings = await listBindings(db);
    return c.json(bindings);
  });

  app.get('/api/bindings/:id', async (c) => {
    const binding = await getBinding(db, c.req.param('id'));
    if (!binding) return c.json({ error: 'Not found' }, 404);
    return c.json(binding);
  });

  app.post('/api/bindings', async (c) => {
    const body = (await c.req.json()) as Partial<Binding>;
    const now = new Date().toISOString();
    const syncMode = body.syncMode ?? 'workspace';

    const binding: Binding = {
      id: randomUUID(),
      name: body.name ?? '未命名绑定',
      sourceType: body.sourceType ?? 'local',
      repoPath: body.repoPath ?? '',
      remoteUrl: body.remoteUrl?.trim() || undefined,
      branch: body.branch !== undefined ? body.branch.trim() : 'main',
      syncMode,
      feishuTarget: body.feishuTarget ?? { type: 'wiki', wikiSpaceId: '' },
      triggers: normalizeBindingTriggers(body.triggers, body.sourceType ?? 'local'),
      options: body.options ?? defaultOptionsForMode(syncMode),
      createdAt: now,
      updatedAt: now,
    };

    if (!binding.repoPath) {
      return c.json({ error: 'repoPath is required' }, 400);
    }

    await insertBinding(db, binding);
    applyLocalGitHook(binding, getPublicBaseUrl(config));

    await scheduler.refresh(db, syncCoordinator, commentImportCoordinator);
    const remoteUrlWarning = await checkCloudRemoteConsistency(binding);
    httpLog.info('绑定已创建', { bindingId: binding.id, bindingName: binding.name });
    return c.json({ ...binding, remoteUrlWarning }, 201);
  });

  app.put('/api/bindings/:id', async (c) => {
    const existing = await getBinding(db, c.req.param('id'));
    if (!existing) return c.json({ error: 'Not found' }, 404);

    const body = (await c.req.json()) as Partial<Binding>;
    const updated: Binding = {
      ...existing,
      ...body,
      id: existing.id,
      remoteUrl: body.remoteUrl !== undefined ? body.remoteUrl.trim() || undefined : existing.remoteUrl,
      branch: body.branch !== undefined ? body.branch.trim() : existing.branch,
      triggers: normalizeBindingTriggers(
        body.triggers ?? existing.triggers,
        (body.sourceType ?? existing.sourceType) as Binding['sourceType'],
      ),
      updatedAt: new Date().toISOString(),
    };

    await updateBinding(db, updated);
    applyLocalGitHook(updated, getPublicBaseUrl(config), existing);

    await scheduler.refresh(db, syncCoordinator, commentImportCoordinator);
    const remoteUrlWarning = await checkCloudRemoteConsistency(updated);
    return c.json({ ...updated, remoteUrlWarning });
  });

  app.delete('/api/bindings/:id', async (c) => {
    const existing = await getBinding(db, c.req.param('id'));
    if (existing?.sourceType === 'local') {
      removeLocalHook(existing.repoPath);
    }
    await deleteBinding(db, c.req.param('id'));
    await scheduler.refresh(db, syncCoordinator, commentImportCoordinator);
    return c.json({ ok: true });
  });

  app.post('/api/bindings/:id/sync', async (c) => {
    const binding = await getBinding(db, c.req.param('id'));
    if (!binding) return c.json({ error: 'Not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as SyncRequest;
    const forceRewriteAll = body.forceRewriteAll === true;
    const fullResync = (body.fullResync ?? false) || forceRewriteAll;
    const logId = syncCoordinator.enqueueBindingSync(
      binding.id,
      body.trigger ?? 'manual',
      fullResync,
      forceRewriteAll,
    );
    httpLog.info('同步已入队', {
      bindingId: binding.id,
      logId,
      trigger: body.trigger ?? 'manual',
      fullResync,
      forceRewriteAll,
    });
    return c.json({ ok: true, queued: true, logId });
  });

  app.post('/api/bindings/:id/import-comments', async (c) => {
    const binding = await getBinding(db, c.req.param('id'));
    if (!binding) return c.json({ error: 'Not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as CommentImportRequest;
    const logId = commentImportCoordinator.enqueueCommentImport(
      binding.id,
      body.trigger ?? 'manual',
    );
    return c.json({ ok: true, queued: true, logId });
  });

  app.get('/api/comment-import-logs/:id', async (c) => {
    const log = await getCommentImportLog(db, c.req.param('id'));
    if (!log) return c.json({ error: 'Not found' }, 404);
    return c.json(log);
  });

  app.get('/api/comment-import-logs', async (c) => {
    const bindingId = c.req.query('bindingId');
    const logs = await listCommentImportLogs(db, bindingId ?? undefined);
    return c.json(logs);
  });

  app.get('/api/sync-logs/:id', async (c) => {
    const log = await getSyncLog(db, c.req.param('id'));
    if (!log) return c.json({ error: 'Not found' }, 404);
    return c.json(log);
  });

  app.get('/api/sync-logs', async (c) => {
    const bindingId = c.req.query('bindingId');
    const logs = await listSyncLogs(db, bindingId ?? undefined);
    return c.json(logs);
  });

  app.post('/api/hooks/local', async (c) => {
    const body = (await c.req.json()) as { bindingId?: string };
    if (!body.bindingId) return c.json({ error: 'bindingId is required' }, 400);

    const binding = await getBinding(db, body.bindingId);
    if (!binding || binding.sourceType !== 'local') {
      return c.json({ ok: true, ignored: true });
    }

    syncCoordinator.enqueueBindingSync(body.bindingId, 'git');
    httpLog.info('本地 Git 钩子触发同步', { bindingId: body.bindingId });
    return c.json({ ok: true, queued: true });
  });

  app.post('/api/export/markdown', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { documentUrl?: string };
    if (!body.documentUrl?.trim()) {
      return c.json({ error: 'documentUrl is required' }, 400);
    }

    const credentials = await resolveFeishuCredentials(db);
    if (!credentials?.appId || !credentials?.appSecret) {
      return c.json({ error: '飞书凭证未配置' }, 400);
    }

    const client = createFeishuClient(credentials);
    try {
      const result = await exportDocumentToMarkdown(client, {
        documentUrl: body.documentUrl,
      });
      return c.json({ ok: true, title: result.title, markdown: result.markdown });
    } catch (error) {
      return c.json({ error: formatExportError(error) }, 400);
    }
  });

  app.post('/api/diagram/append-to-document', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      documentUrl?: string;
      mermaidCode?: string;
      legend?: unknown;
      /** @deprecated 兼容旧客户端；优先使用 mermaidCode */
      markdown?: string;
    };
    if (!body.documentUrl?.trim()) {
      return c.json({ error: '请填写飞书云文档链接' }, 400);
    }
    const mermaidCode = (body.mermaidCode ?? body.markdown ?? '').trim();
    if (!mermaidCode) {
      return c.json({ error: '请先完成图表转换，再导入云文档' }, 400);
    }

    const credentials = await resolveFeishuCredentials(db);
    if (!credentials?.appId || !credentials?.appSecret) {
      return c.json({ error: '飞书凭证未配置' }, 400);
    }

    const client = createFeishuClient(credentials);
    try {
      const result = await appendMermaidBoardToDocument(client, {
        documentUrl: body.documentUrl.trim(),
        mermaidCode,
        legend: Array.isArray(body.legend) ? (body.legend as never) : undefined,
      });
      httpLog.info('成品画板已追加到云文档', {
        documentId: result.documentId,
        whiteboardId: result.whiteboardId,
        usedStrippedStyles: result.usedStrippedStyles,
        coloredNodeCount: result.coloredNodeCount,
      });
      return c.json({
        ok: true,
        documentId: result.documentId,
        whiteboardId: result.whiteboardId,
        insertedBlockCount: result.insertedBlockCount,
        usedStrippedStyles: result.usedStrippedStyles,
        coloredNodeCount: result.coloredNodeCount,
      });
    } catch (error) {
      return c.json({ error: formatExportError(error) }, 400);
    }
  });

  return app;
}

/**
 * 云绑定保存后校验「填写的远程 URL」与「本地仓库 origin」的一致性。
 * 两种写法（带/不带 .git 等）视为同一仓库；仅在真正不一致或缺失时给出警告，不阻断保存。
 */
async function checkCloudRemoteConsistency(binding: Binding): Promise<string | undefined> {
  if (binding.sourceType !== 'cloud') return undefined;

  const originUrl = await readLocalOriginUrl(binding.repoPath);

  if (binding.remoteUrl) {
    if (!originUrl) {
      return '本地仓库未配置 origin，定时拉取将以填写的远程 URL 为准';
    }
    if (!remoteUrlsEqual(originUrl, binding.remoteUrl)) {
      return `填写的远程 URL 与本地仓库 origin（${originUrl}）不一致，定时拉取将以填写的远程 URL 为准`;
    }
    return undefined;
  }

  if (!originUrl) {
    return '未填写远程 URL 且本地仓库未配置 origin，定时拉取远程将失败，建议补填或配置 origin';
  }
  return undefined;
}

