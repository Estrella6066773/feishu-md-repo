import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import type { DbClient } from '@feishu-md/db';
import {
  deleteBinding,
  getAppSettings,
  getBinding,
  getBotSettings,
  getFeishuUserPermissions,
  insertBinding,
  listBindings,
  listSyncLogs,
  getSyncLog,
  setBotSettings,
  setFeishuCredentials,
  setFeishuUserPermissions,
  updateBinding,
} from '@feishu-md/db';
import type { Binding, BotSettings, FeishuCredentials, FeishuUserPermission, SyncRequest } from '@feishu-md/shared';
import {
  defaultOptionsForMode,
  defaultTriggersForSourceType,
  normalizeBindingTriggers,
  DEFAULT_BOT_SETTINGS,
} from '@feishu-md/shared';
import { installLocalHook, removeLocalHook } from '@feishu-md/git';
import { createFeishuClient, exportDocumentToMarkdown, formatExportError } from '@feishu-md/feishu';
import type { Scheduler, SyncQueue } from './scheduler.js';
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

/** 递增此版本号以提示 UI 重启 core-service（旧进程可能缺少新路由） */
export const CORE_API_VERSION = 2;

export const CORE_API_FEATURES = [
  'settings-feishu',
  'settings-bot',
  'settings-user-permissions',
  'bindings-crud',
  'sync-log-detail',
  'export-markdown',
] as const;

export function createApp(options: {
  db: DbClient;
  config: ServiceConfig;
  queue: SyncQueue;
  scheduler: Scheduler;
  syncCoordinator: SyncCoordinator;
  botManager: BotManager;
}) {
  const app = new Hono();
  const { db, config, scheduler, syncCoordinator, botManager } = options;

  app.use(
    '*',
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: 'feishu-md-core',
      version: '0.1.0',
      apiVersion: CORE_API_VERSION,
      features: [...CORE_API_FEATURES],
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

    await scheduler.refresh(db, syncCoordinator);
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

    await scheduler.refresh(db, syncCoordinator);
    return c.json(updated);
  });

  app.delete('/api/bindings/:id', async (c) => {
    const existing = await getBinding(db, c.req.param('id'));
    if (existing?.sourceType === 'local') {
      removeLocalHook(existing.repoPath);
    }
    await deleteBinding(db, c.req.param('id'));
    await scheduler.refresh(db, syncCoordinator);
    return c.json({ ok: true });
  });

  app.post('/api/bindings/:id/sync', async (c) => {
    const binding = await getBinding(db, c.req.param('id'));
    if (!binding) return c.json({ error: 'Not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as SyncRequest;
    const logId = syncCoordinator.enqueueBindingSync(
      binding.id,
      body.trigger ?? 'manual',
      body.fullResync ?? false,
    );
    return c.json({ ok: true, queued: true, logId });
  });

  app.get('/api/sync-logs/:id', async (c) => {
    const log = await getSyncLog(db, c.req.param('id'));
    if (!log) return c.json({ error: 'Not found' }, 404);
    return c.json(log);
  });

  app.get('/api/sync-logs', async (c) => {
    const bindingId = c.req.query('bindingId');
    const logs = await listSyncLogs(db, bindingId ?? undefined);
    return c.json(logs.slice(-100).reverse());
  });

  app.post('/api/hooks/local', async (c) => {
    const body = (await c.req.json()) as { bindingId?: string };
    if (!body.bindingId) return c.json({ error: 'bindingId is required' }, 400);

    const binding = await getBinding(db, body.bindingId);
    if (!binding || binding.sourceType !== 'local') {
      return c.json({ ok: true, ignored: true });
    }

    syncCoordinator.enqueueBindingSync(body.bindingId, 'git');
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

  return app;
}

