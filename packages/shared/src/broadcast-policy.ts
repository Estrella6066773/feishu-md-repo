import type { BotBroadcastTarget, BotBroadcastTargetPolicy, BotSettings, SyncTriggerType } from './types.js';

export const SYNC_TRIGGER_LABELS: Record<SyncTriggerType, string> = {
  git: 'Git 提交',
  schedule: '定时',
  manual: '面板手动',
  bot: '飞书指令',
};

export const ALL_SYNC_TRIGGERS: SyncTriggerType[] = ['git', 'schedule', 'manual', 'bot'];

export const AUTOMATIC_SYNC_TRIGGERS: SyncTriggerType[] = ['git', 'schedule'];

export const MANUAL_SYNC_TRIGGERS: SyncTriggerType[] = ['manual', 'bot'];

export type BroadcastTriggerPreset = 'all' | 'automatic' | 'manual' | 'custom';

export function triggersEqual(a: SyncTriggerType[] | undefined, b: SyncTriggerType[]): boolean {
  if (!a || a.length === 0) return b.length === 0;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export function detectTriggerPreset(triggers: SyncTriggerType[] | undefined): BroadcastTriggerPreset {
  if (triggers === undefined) return 'all';
  if (triggers.length === 0) return 'custom';
  if (triggersEqual(triggers, AUTOMATIC_SYNC_TRIGGERS)) return 'automatic';
  if (triggersEqual(triggers, MANUAL_SYNC_TRIGGERS)) return 'manual';
  return 'custom';
}

export function triggersFromPreset(preset: BroadcastTriggerPreset): SyncTriggerType[] | undefined {
  switch (preset) {
    case 'automatic':
      return [...AUTOMATIC_SYNC_TRIGGERS];
    case 'manual':
      return [...MANUAL_SYNC_TRIGGERS];
    case 'all':
      return undefined;
    case 'custom':
      return [];
    default:
      return undefined;
  }
}

export function formatBroadcastPolicySummary(
  target: BotBroadcastTarget,
  globalSettings: Pick<BotSettings, 'broadcastOnSuccess' | 'broadcastOnFailure'>,
): string {
  const parts: string[] = [];
  const policy = target.policy;

  const preset = detectTriggerPreset(policy?.triggers);
  switch (preset) {
    case 'automatic':
      parts.push('仅自动更新');
      break;
    case 'manual':
      parts.push('仅手动操作');
      break;
    case 'custom':
      parts.push(
        policy?.triggers && policy.triggers.length > 0
          ? policy.triggers.map((trigger) => SYNC_TRIGGER_LABELS[trigger]).join('、')
          : '未选触发来源',
      );
      break;
    default:
      parts.push('全部触发');
  }

  const onSuccess = policy?.onSuccess ?? globalSettings.broadcastOnSuccess;
  const onFailure = policy?.onFailure ?? globalSettings.broadcastOnFailure;
  const outcomes: string[] = [];
  if (onSuccess) outcomes.push('成功');
  if (onFailure) outcomes.push('失败');
  parts.push(outcomes.length > 0 ? outcomes.join('/') : '不播报');

  return parts.join(' · ');
}

export function shouldBroadcastToTarget(
  globalSettings: Pick<BotSettings, 'broadcastOnSuccess' | 'broadcastOnFailure'>,
  target: BotBroadcastTarget,
  context: { success: boolean; trigger: SyncTriggerType },
): boolean {
  const policy: BotBroadcastTargetPolicy | undefined = target.policy;
  const onSuccess = policy?.onSuccess ?? globalSettings.broadcastOnSuccess;
  const onFailure = policy?.onFailure ?? globalSettings.broadcastOnFailure;
  const allowOutcome = context.success ? onSuccess : onFailure;
  if (!allowOutcome) return false;

  const triggers = policy?.triggers;
  if (triggers !== undefined) {
    if (triggers.length === 0) return false;
    if (!triggers.includes(context.trigger)) return false;
  }

  return true;
}

export function hasCustomOutcomePolicy(policy: BotBroadcastTargetPolicy | undefined): boolean {
  return policy?.onSuccess !== undefined || policy?.onFailure !== undefined;
}

export const MAX_BROADCAST_CHANGED_FILES = 5;

export const MAX_BROADCAST_MESSAGE_LENGTH = 4000;

export interface SyncBroadcastCommitSummary {
  sha: string;
  subject: string;
  message: string;
}

export interface SyncBroadcastResultSummary {
  toSha: string;
  operationCount: number;
  commits?: SyncBroadcastCommitSummary[];
  changedPaths?: string[];
}

function formatCommitBlocks(commits: SyncBroadcastCommitSummary[]): string {
  return commits
    .map((commit) => {
      const message = commit.message.trim() || commit.subject.trim();
      return `**${commit.sha.slice(0, 7)}**\n${message}`;
    })
    .join('\n\n');
}

export function formatSyncBroadcastMessage(options: {
  bindingName: string;
  trigger: SyncTriggerType;
  success: boolean;
  result?: SyncBroadcastResultSummary;
  errorMessage?: string;
}): string {
  const triggerLabel = SYNC_TRIGGER_LABELS[options.trigger] ?? options.trigger;

  if (!options.success) {
    return `❌ 同步失败\n绑定：${options.bindingName}\n触发：${triggerLabel}\n原因：${options.errorMessage ?? '未知错误'}`;
  }

  const lines = [
    '✅ **同步成功**',
    `**绑定：** ${options.bindingName}`,
    `**触发：** ${triggerLabel}`,
  ];

  const commits = options.result?.commits ?? [];
  if (commits.length > 0) {
    lines.push('');
    lines.push(commits.length > 1 ? `**更新提交（${commits.length}）：**` : '**更新提交：**');
    lines.push('');
    lines.push(formatCommitBlocks(commits));
  } else {
    lines.push(`**Commit：** \`${options.result?.toSha.slice(0, 7) ?? '-'}\``);
  }

  const paths = options.result?.changedPaths ?? [];
  if (paths.length > 0) {
    lines.push('');
    lines.push(paths.length > 1 ? `**相关文件（${paths.length}）：**` : '**相关文件：**');
    const shown = paths.slice(0, MAX_BROADCAST_CHANGED_FILES);
    for (const path of shown) {
      lines.push(`- \`${path}\``);
    }
    if (paths.length > MAX_BROADCAST_CHANGED_FILES) {
      lines.push(`- … 共 ${paths.length} 个文件`);
    }
  }

  lines.push('');
  lines.push(`**操作数：** ${options.result?.operationCount ?? 0}`);
  const markdown = lines.join('\n');
  if (markdown.length <= MAX_BROADCAST_MESSAGE_LENGTH) {
    return markdown;
  }
  return `${markdown.slice(0, MAX_BROADCAST_MESSAGE_LENGTH - 20).trimEnd()}\n\n…（内容过长已截断）`;
}
