import type { Binding, BotSettings, FeishuCredentials, SyncLogEntry } from '@feishu-md/shared';
import { apiFetch } from './api';

export interface SettingsResponse {
  feishu?: { appId: string; appSecretConfigured: boolean };
  bot?: BotSettings;
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
  return apiFetch<{ ok: boolean }>(`/api/bindings/${id}/sync`, {
    method: 'POST',
    body: JSON.stringify({ fullResync, trigger: 'manual' }),
  });
}

export function fetchSyncLogs(bindingId?: string) {
  const query = bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : '';
  return apiFetch<SyncLogEntry[]>(`/api/sync-logs${query}`);
}

export function fetchHealth() {
  return apiFetch<{ ok: boolean; service: string; version: string }>('/api/health');
}
