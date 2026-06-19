import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import type { DbClient } from '@feishu-md/db';
import {
  deleteBinding,
  getAppSettings,
  getBinding,
  getBotSettings,
  insertBinding,
  listBindings,
  listSyncLogs,
  setBotSettings,
  setFeishuCredentials,
  updateBinding,
} from '@feishu-md/db';
import type { Binding, BotSettings, FeishuCredentials, SyncRequest } from '@feishu-md/shared';
import { defaultOptionsForMode, DEFAULT_BOT_SETTINGS, DEFAULT_TRIGGERS } from '@feishu-md/shared';
import { installLocalHook } from '@feishu-md/git';
import type { Scheduler, SyncQueue } from './scheduler.js';
import type { SyncCoordinator } from './sync-coordinator.js';
import type { BotManager } from './bot/manager.js';
import type { ServiceConfig } from './config.js';
import { getPublicBaseUrl } from './config.js';

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
      triggers: body.triggers ?? { ...DEFAULT_TRIGGERS },
      options: body.options ?? defaultOptionsForMode(syncMode),
      createdAt: now,
      updatedAt: now,
    };

    if (!binding.repoPath) {
      return c.json({ error: 'repoPath is required' }, 400);
    }

    await insertBinding(db, binding);

    if (binding.sourceType === 'local' && binding.triggers.onGitCommit) {
      installLocalHook({
        repoPath: binding.repoPath,
        bindingId: binding.id,
        coreServiceUrl: getPublicBaseUrl(config),
      });
    }

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
      updatedAt: new Date().toISOString(),
    };

    await updateBinding(db, updated);

    if (updated.sourceType === 'local' && updated.triggers.onGitCommit) {
      installLocalHook({
        repoPath: updated.repoPath,
        bindingId: updated.id,
        coreServiceUrl: getPublicBaseUrl(config),
      });
    }

    await scheduler.refresh(db, syncCoordinator);
    return c.json(updated);
  });

  app.delete('/api/bindings/:id', async (c) => {
    await deleteBinding(db, c.req.param('id'));
    await scheduler.refresh(db, syncCoordinator);
    return c.json({ ok: true });
  });

  app.post('/api/bindings/:id/sync', async (c) => {
    const binding = await getBinding(db, c.req.param('id'));
    if (!binding) return c.json({ error: 'Not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as SyncRequest;
    syncCoordinator.enqueueBindingSync(binding.id, body.trigger ?? 'manual', body.fullResync ?? false);
    return c.json({ ok: true, queued: true });
  });

  app.get('/api/sync-logs', async (c) => {
    const bindingId = c.req.query('bindingId');
    const logs = await listSyncLogs(db, bindingId ?? undefined);
    return c.json(logs.slice(-100).reverse());
  });

  app.post('/api/hooks/local', async (c) => {
    const body = (await c.req.json()) as { bindingId?: string };
    if (!body.bindingId) return c.json({ error: 'bindingId is required' }, 400);
    syncCoordinator.enqueueBindingSync(body.bindingId, 'git');
    return c.json({ ok: true, queued: true });
  });

  return app;
}
