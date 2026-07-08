import type { SyncLogEntry } from './types.js';

const PHASE_MESSAGE: Record<NonNullable<SyncLogEntry['progressPhase']>, string> = {
  planning: '正在规划同步…',
  structure: '正在准备目录与文档节点…',
  content: '正在同步文档正文…',
  cleanup: '正在清理已移除节点…',
  overview: '正在更新同步文档总览…',
  done: '同步完成',
};

/** 将同步日志进度格式化为可读文案 */
export function formatSyncProgressText(
  entry: Pick<SyncLogEntry, 'progressPhase' | 'progressDone' | 'progressTotal' | 'currentGitPath'>,
): string | null {
  const phase = entry.progressPhase;
  if (!phase) {
    return null;
  }

  if (phase === 'content' && entry.progressTotal != null && entry.progressTotal > 0) {
    const done = entry.progressDone ?? 0;
    const path = entry.currentGitPath?.replace(/\\/g, '/');
    const fraction = `文档 ${done}/${entry.progressTotal}`;
    return path ? `${fraction} · ${path}` : fraction;
  }

  return PHASE_MESSAGE[phase] ?? null;
}

export function syncProgressPercent(
  entry: Pick<SyncLogEntry, 'progressPhase' | 'progressDone' | 'progressTotal'>,
): number | null {
  if (entry.progressPhase !== 'content') {
    return null;
  }
  if (entry.progressTotal == null || entry.progressTotal <= 0) {
    return null;
  }
  const done = entry.progressDone ?? 0;
  return Math.min(100, Math.round((done / entry.progressTotal) * 100));
}
