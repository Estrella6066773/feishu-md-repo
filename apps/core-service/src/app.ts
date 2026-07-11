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
  getFeishuUserPermissions,
  insertBinding,
  listBindings,
  listCommentImportLogs,
  listSyncLogs,
  getSyncLog,
  setBotSettings,
  setFeishuCredentials,
  setFeishuUserPermissions,
  updateBinding,
} from '@feishu-md/db';
import type {
  Binding,
  BotSettings,
  CommentImportRequest,
  FeishuCredentials,
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
import { installLocalHook, removeLocalHook } from '@feishu-md/git';
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
    await setBotSettings(db, { ...DEFAULT_BOT_SETTINGS, ...body });
    await botManager.refresh();
    httpLog.info('机器人设置已更新', { enabled: body.enabled });
    return c.json({ ok: true, connection: botManager.getStatus() });
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
      remoteUrl: body.remoteUrl,
      branch: body.branch ?? 'main',
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
    httpLog.info('绑定已创建', { bindingId: binding.id, bindingName: binding.name });
    return c.json(binding, 201);
  });

  app.put('/api/bindings/:id', async (c) => {
    const existing = await getBinding(db, c.req.param('id'));
    if (!existing) return c.json({ error: 'Not found' }, 404);

    const body = (await c.req.json()) as Partial<Binding>;
    const updated: Binding = {
      ...existing,
      ...body,
      id: existing.id,
      triggers: normalizeBindingTriggers(
        body.triggers ?? existing.triggers,
        (body.sourceType ?? existing.sourceType) as Binding['sourceType'],
      ),
      updatedAt: new Date().toISOString(),
    };

    await updateBinding(db, updated);
    applyLocalGitHook(updated, getPublicBaseUrl(config), existing);

    await scheduler.refresh(db, syncCoordinator, commentImportCoordinator);
    return c.json(updated);
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

    const credentials = await getAppSettings(db).then((settings) => settings.feishu);
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

    const credentials = await getAppSettings(db).then((settings) => settings.feishu);
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

