import type { Binding, BotSettings, CommentImportLogEntry, FeishuUserPermission, SyncLogEntry } from '@feishu-md/shared';
import { isCoreServiceCompatible, pollUntilTerminal } from '@feishu-md/shared';
import { apiFetch } from './api';

export { isCoreServiceCompatible } from '@feishu-md/shared';

export interface SettingsResponse {
  feishuBots?: PublicFeishuBot[];
  bot?: BotSettings;
  userPermissions?: FeishuUserPermission[];
  botConnection?: { connected: boolean; listening: boolean };
  dataDir: string;
  coreServiceUrl: string;
}

/** 脱敏后的机器人档案（不含 appSecret） */
export interface PublicFeishuBot {
  id: string;
  name: string;
  appId: string;
  appSecretConfigured: boolean;
}

export function fetchSettings() {
  return apiFetch<SettingsResponse>('/api/settings');
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

export function fetchBots() {
  return apiFetch<PublicFeishuBot[]>('/api/settings/bots');
}

export function createBot(input: { name: string; appId: string; appSecret: string }) {
  return apiFetch<{ ok: boolean; bot: PublicFeishuBot }>('/api/settings/bots', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateBot(id: string, input: { name: string; appId: string; appSecret?: string }) {
  return apiFetch<{ ok: boolean; bot: PublicFeishuBot }>(`/api/settings/bots/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteBot(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/settings/bots/${id}`, { method: 'DELETE' });
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
  return apiFetch<Binding & { remoteUrlWarning?: string }>('/api/bindings', {
    method: 'POST',
    body: JSON.stringify(binding),
  });
}

export function updateBinding(id: string, binding: Partial<Binding>) {
  return apiFetch<Binding & { remoteUrlWarning?: string }>(`/api/bindings/${id}`, {
    method: 'PUT',
    body: JSON.stringify(binding),
  });
}

export function deleteBinding(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/bindings/${id}`, { method: 'DELETE' });
}

export function triggerSync(id: string, fullResync = false, forceRewriteAll = false) {
  return apiFetch<{ ok: boolean; logId: string }>(`/api/bindings/${id}/sync`, {
    method: 'POST',
    body: JSON.stringify({ fullResync, forceRewriteAll, trigger: 'manual' }),
  });
}

export function fetchSyncLog(id: string) {
  return apiFetch<SyncLogEntry>(`/api/sync-logs/${id}`);
}

export async function waitForSyncLog(
  logId: string,
  timeoutMs = 300_000,
  timeoutMessage = '同步等待超时，请到「同步日志」查看详情',
): Promise<SyncLogEntry> {
  return pollUntilTerminal({
    fetch: () => fetchSyncLog(logId),
    isTerminal: (log) => log.status === 'success' || log.status === 'failed',
    timeoutMs,
    timeoutMessage,
    intervalMs: (log) => (log.status === 'running' ? 500 : 1_000),
  });
}

export async function triggerSyncAndWait(id: string, fullResync = false, forceRewriteAll = false) {
  const { logId } = await triggerSync(id, fullResync, forceRewriteAll);
  const timeoutMs = forceRewriteAll ? 3_600_000 : 300_000;
  const timeoutMessage = forceRewriteAll
    ? '强制重写等待超时，任务可能仍在后台运行，请到「同步日志」查看进度'
    : '同步等待超时，请到「同步日志」查看详情';
  return waitForSyncLog(logId, timeoutMs, timeoutMessage);
}

export function fetchSyncLogs(bindingId?: string) {
  const query = bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : '';
  return apiFetch<SyncLogEntry[]>(`/api/sync-logs${query}`);
}

export function triggerCommentImport(id: string) {
  return apiFetch<{ ok: boolean; logId: string }>(`/api/bindings/${id}/import-comments`, {
    method: 'POST',
    body: JSON.stringify({ trigger: 'manual' }),
  });
}

export function fetchCommentImportLog(id: string) {
  return apiFetch<CommentImportLogEntry>(`/api/comment-import-logs/${id}`);
}

export async function waitForCommentImportLog(
  logId: string,
  timeoutMs = 300_000,
): Promise<CommentImportLogEntry> {
  return pollUntilTerminal({
    fetch: () => fetchCommentImportLog(logId),
    isTerminal: (log) => log.status === 'success' || log.status === 'failed',
    timeoutMs,
    timeoutMessage: '评论导入等待超时，请到日志查看详情',
    intervalMs: 1_000,
  });
}

export async function triggerCommentImportAndWait(id: string) {
  const { logId } = await triggerCommentImport(id);
  return waitForCommentImportLog(logId);
}

export function fetchCommentImportLogs(bindingId?: string) {
  const query = bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : '';
  return apiFetch<CommentImportLogEntry[]>(`/api/comment-import-logs${query}`);
}

export function exportDocumentToMarkdown(documentUrl: string) {
  return apiFetch<{ ok: boolean; title?: string; markdown: string }>('/api/export/markdown', {
    method: 'POST',
    body: JSON.stringify({ documentUrl }),
  });
}

export function appendDiagramToDocument(
  documentUrl: string,
  mermaidCode: string,
  legend?: unknown,
) {
  return apiFetch<{
    ok: boolean;
    documentId: string;
    whiteboardId: string;
    insertedBlockCount: number;
    usedStrippedStyles?: boolean;
    coloredNodeCount?: number;
  }>('/api/diagram/append-to-document', {
    method: 'POST',
    body: JSON.stringify({ documentUrl, mermaidCode, legend }),
  });
}

export function extractBoardTerrain(boardUrl: string, colors: string[]) {
  return apiFetch<{
    ok: boolean;
    whiteboardId: string;
    shapes: Array<{
      id: string;
      kind: 'ellipse' | 'rect';
      color: string;
      x: number;
      y: number;
      width: number;
      height: number;
      angle: number;
    }>;
    totalNodeCount: number;
    matchedShapeCount: number;
  }>('/api/toolbox/board-terrain/extract', {
    method: 'POST',
    body: JSON.stringify({ boardUrl, colors }),
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
