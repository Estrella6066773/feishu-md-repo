import type { Binding, BotSettings, FeishuCredentials, FeishuUserPermission, SyncLogEntry } from '@feishu-md/shared';
import { apiFetch } from './api';

export interface SettingsResponse {
  feishu?: { appId: string; appSecretConfigured: boolean };
  bot?: BotSettings;
  userPermissions?: FeishuUserPermission[];
  botConnection?: { connected: boolean; listening: boolean };
  dataDir: string;
  coreServiceUrl: string;
}

export function fetchSettings() {
  return apiFetch<SettingsResponse>('/api/settings');
}

export function saveFeishuCredentials(credentials: FeishuCredentials) {
  return apiFetch<{ ok: boolean }>('/api/settings/feishu', {
    method: 'PUT',
    body: JSON.stringify(credentials),
  });
}

export function saveBotSettings(settings: BotSettings) {
  return apiFetch<{ ok: boolean; connection: { connected: boolean; listening: boolean } }>(
    '/api/settings/bot',
    {
      method: 'PUT',
      body: JSON.stringify(settings),
    },
  );
}

export function saveFeishuUserPermissions(permissions: FeishuUserPermission[]) {
  return apiFetch<{ ok: boolean }>('/api/settings/user-permissions', {
    method: 'PUT',
    body: JSON.stringify(permissions),
  });
}

export function fetchBindings() {
  return apiFetch<Binding[]>('/api/bindings');
}

export function createBinding(binding: Partial<Binding>) {
  return apiFetch<Binding>('/api/bindings', {
    method: 'POST',
    body: JSON.stringify(binding),
  });
}

export function updateBinding(id: string, binding: Partial<Binding>) {
  return apiFetch<Binding>(`/api/bindings/${id}`, {
    method: 'PUT',
    body: JSON.stringify(binding),
  });
}

export function deleteBinding(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/bindings/${id}`, { method: 'DELETE' });
}

export function triggerSync(id: string, fullResync = false) {
  return apiFetch<{ ok: boolean; logId: string }>(`/api/bindings/${id}/sync`, {
    method: 'POST',
    body: JSON.stringify({ fullResync, trigger: 'manual' }),
  });
}

export function fetchSyncLog(id: string) {
  return apiFetch<SyncLogEntry>(`/api/sync-logs/${id}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到同步完成或超时 */
export async function waitForSyncLog(logId: string, timeoutMs = 300_000): Promise<SyncLogEntry> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const log = await fetchSyncLog(logId);
    if (log.status === 'success' || log.status === 'failed') {
      return log;
    }
    await sleep(1000);
  }
  throw new Error('同步等待超时，请到「同步日志」查看详情');
}

export async function triggerSyncAndWait(id: string, fullResync = false) {
  const { logId } = await triggerSync(id, fullResync);
  return waitForSyncLog(logId);
}

export function fetchSyncLogs(bindingId?: string) {
  const query = bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : '';
  return apiFetch<SyncLogEntry[]>(`/api/sync-logs${query}`);
}

export function exportDocumentToMarkdown(documentUrl: string) {
  return apiFetch<{ ok: boolean; title?: string; markdown: string }>('/api/export/markdown', {
    method: 'POST',
    body: JSON.stringify({ documentUrl }),
  });
}

export function fetchHealth() {
  return apiFetch<{
    ok: boolean;
    service: string;
    version: string;
    apiVersion?: number;
    features?: string[];
  }>('/api/health');
}

export const REQUIRED_CORE_API_FEATURES = ['settings-bot', 'settings-user-permissions'] as const;

export function isCoreServiceCompatible(health: {
  apiVersion?: number;
  features?: string[];
}): boolean {
  if (health.apiVersion != null && health.apiVersion >= 2) return true;
  return REQUIRED_CORE_API_FEATURES.every((feature) => health.features?.includes(feature));
}
