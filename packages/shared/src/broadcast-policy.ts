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

export const MAX_BROADCAST_MESSAGE_LENGTH = 4000;

export interface SyncBroadcastCommitSummary {
  sha: string;
  subject: string;
  message: string;
}

export interface SyncBroadcastFileEntry {
  path: string;
  url?: string;
}

export interface SyncBroadcastResultSummary {
  toSha: string;
  operationCount: number;
  commits?: SyncBroadcastCommitSummary[];
  changedPaths?: string[];
}

export interface SyncBroadcastThreadPlan {
  commitReplies: string[];
  fileReplies: string[];
}

function formatCommitHashLine(result?: SyncBroadcastResultSummary): string {
  const commits = result?.commits ?? [];
  if (commits.length > 0) {
    const hashes = commits.map((commit) => `\`${commit.sha.slice(0, 7)}\``);
    return `- **Commit**：${hashes.join('、')}`;
  }
  return `- **Commit**：\`${result?.toSha.slice(0, 7) ?? '-'}\``;
}

function extractCommitBody(commit: SyncBroadcastCommitSummary): string {
  const subject = commit.subject.trim();
  const fullMessage = commit.message.trim() || subject;
  if (!subject) return fullMessage;
  if (fullMessage === subject) return '';
  if (fullMessage.startsWith(subject)) {
    return fullMessage.slice(subject.length).replace(/^\n+/, '');
  }
  return fullMessage;
}

export function formatSyncBroadcastCommitReply(commit: SyncBroadcastCommitSummary): string {
  const subject = commit.subject.trim();
  const heading = subject
    ? `### \`${commit.sha.slice(0, 7)}\` ${subject}`
    : `### \`${commit.sha.slice(0, 7)}\``;
  const body = extractCommitBody(commit);
  return body ? `${heading}\n${body}` : heading;
}

function packCommitReplyMessages(commit: SyncBroadcastCommitSummary): string[] {
  const first = formatSyncBroadcastCommitReply(commit);
  if (first.length <= MAX_BROADCAST_MESSAGE_LENGTH) {
    return [first];
  }

  const subject = commit.subject.trim();
  const heading = subject
    ? `### \`${commit.sha.slice(0, 7)}\` ${subject}`
    : `### \`${commit.sha.slice(0, 7)}\``;
  const body = extractCommitBody(commit);
  if (!body) {
    return [heading];
  }

  const firstBodyLimit = MAX_BROADCAST_MESSAGE_LENGTH - heading.length - 1;
  const messages = [`${heading}\n${body.slice(0, firstBodyLimit)}`];
  let offset = firstBodyLimit;
  while (offset < body.length) {
    messages.push(body.slice(offset, offset + MAX_BROADCAST_MESSAGE_LENGTH));
    offset += MAX_BROADCAST_MESSAGE_LENGTH;
  }
  return messages;
}

function formatFileLine(file: SyncBroadcastFileEntry): string {
  if (file.url) {
    return `- [${file.path}](${file.url})`;
  }
  return `- \`${file.path}\``;
}

function packFileReplyMessages(files: SyncBroadcastFileEntry[]): string[] {
  if (files.length === 0) return [];

  const lines = files.map(formatFileLine);
  const messages: string[] = [];
  let current = '**相关文件**';

  for (const line of lines) {
    const candidate = `${current}\n${line}`;
    if (candidate.length <= MAX_BROADCAST_MESSAGE_LENGTH) {
      current = candidate;
      continue;
    }

    if (current !== '**相关文件**') {
      messages.push(current);
    }
    current = `**相关文件**\n${line}`;
    if (current.length > MAX_BROADCAST_MESSAGE_LENGTH) {
      messages.push(line.slice(0, MAX_BROADCAST_MESSAGE_LENGTH));
      current = '**相关文件**';
    }
  }

  if (current !== '**相关文件**') {
    messages.push(current);
  }

  return messages;
}

export function buildSyncBroadcastThreadPlan(
  result?: SyncBroadcastResultSummary,
  files: SyncBroadcastFileEntry[] = [],
): SyncBroadcastThreadPlan {
  const commitReplies: string[] = [];
  for (const commit of result?.commits ?? []) {
    commitReplies.push(...packCommitReplyMessages(commit));
  }

  const fileReplies = packFileReplyMessages(files);
  return { commitReplies, fileReplies };
}

export function hasSyncBroadcastThreadDetails(
  result?: SyncBroadcastResultSummary,
  files: SyncBroadcastFileEntry[] = [],
): boolean {
  return (result?.commits?.length ?? 0) > 0 || files.length > 0;
}

export function formatSyncBroadcastSummary(options: {
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

  return [
    '✅ **同步成功**',
    `- **绑定**：${options.bindingName}`,
    `- **触发**：${triggerLabel}`,
    formatCommitHashLine(options.result),
    `- **操作数**：${options.result?.operationCount ?? 0}`,
  ].join('\n');
}
