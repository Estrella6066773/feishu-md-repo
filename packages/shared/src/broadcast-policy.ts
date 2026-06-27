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

export interface SyncBroadcastChangedFile {
  gitPath: string;
  url?: string;
}

export interface SyncBroadcastCommitDetail {
  sha: string;
  subject: string;
  body: string;
  changedFiles: SyncBroadcastChangedFile[];
}

export interface SyncBroadcastResultSummary {
  toSha: string;
  operationCount: number;
  commits?: SyncBroadcastCommitDetail[];
}

/** 飞书卡片 Markdown 单条内容建议上限（超出将按提交区块拆分多条消息） */
export const FEISHU_BROADCAST_MARKDOWN_LIMIT = 28_000;

export function formatSyncBroadcastMessage(options: {
  bindingName: string;
  trigger: SyncTriggerType;
  success: boolean;
  result?: SyncBroadcastResultSummary;
  errorMessage?: string;
}): string {
  const parts = buildSyncBroadcastMessageParts(options);
  return [parts.topicRoot, ...parts.threadMessages].join('\n\n---\n\n');
}

export interface SyncBroadcastMessageParts {
  /** 群聊主会话中的话题根消息（短摘要） */
  topicRoot: string;
  /** 话题内逐条回复的 Markdown 正文 */
  threadMessages: string[];
}

export function buildSyncBroadcastMessageParts(options: {
  bindingName: string;
  trigger: SyncTriggerType;
  success: boolean;
  result?: SyncBroadcastResultSummary;
  errorMessage?: string;
}): SyncBroadcastMessageParts {
  const triggerLabel = SYNC_TRIGGER_LABELS[options.trigger] ?? options.trigger;

  if (!options.success) {
    return {
      topicRoot: formatSyncBroadcastFailureDetail({
        bindingName: options.bindingName,
        trigger: options.trigger,
        errorMessage: options.errorMessage,
      }),
      threadMessages: [],
    };
  }

  const sha = options.result?.toSha.slice(0, 7) ?? '-';
  const commits = options.result?.commits ?? [];

  const topicRoot = [
    '✅ **同步成功**',
    '',
    `- **绑定**：${options.bindingName}`,
    `- **触发**：${triggerLabel}`,
    `- **Commit**：\`${sha}\``,
    `- **操作数**：${options.result?.operationCount ?? 0}`,
  ].join('\n');

  const threadMessages: string[] = [];
  for (const commit of commits) {
    threadMessages.push(
      ...splitSyncBroadcastMarkdown(formatCommitMessageReply(commit)),
    );
    const filesReply = formatCommitFilesReply(commit);
    if (filesReply) {
      threadMessages.push(...splitSyncBroadcastMarkdown(filesReply));
    }
  }

  return { topicRoot, threadMessages };
}

function formatSyncBroadcastFailureDetail(options: {
  bindingName: string;
  trigger: SyncTriggerType;
  errorMessage?: string;
}): string {
  const triggerLabel = SYNC_TRIGGER_LABELS[options.trigger] ?? options.trigger;
  return [
    '❌ **同步失败**',
    '',
    `- **绑定**：${options.bindingName}`,
    `- **触发**：${triggerLabel}`,
    `- **原因**：${options.errorMessage ?? '未知错误'}`,
  ].join('\n');
}

function formatCommitMessageReply(commit: SyncBroadcastCommitDetail): string {
  const lines = [`### \`${commit.sha.slice(0, 7)}\` ${commit.subject}`];
  if (commit.body.trim()) {
    lines.push('', commit.body.trim());
  }
  return lines.join('\n');
}

function formatCommitFilesReply(commit: SyncBroadcastCommitDetail): string | null {
  if (commit.changedFiles.length === 0) return null;
  const lines = ['**相关文件**'];
  for (const file of commit.changedFiles) {
    lines.push(formatChangedFileLine(file));
  }
  return lines.join('\n');
}

function formatChangedFileLine(file: SyncBroadcastChangedFile): string {
  if (file.url) {
    return `- [${file.gitPath}](${file.url})`;
  }
  return `- \`${file.gitPath}\``;
}

export function splitSyncBroadcastMarkdown(markdown: string, limit = FEISHU_BROADCAST_MARKDOWN_LIMIT): string[] {
  if (markdown.length <= limit) return [markdown];

  const sections = markdown.split('\n---\n');
  if (sections.length <= 1) {
    return chunkPlainMarkdown(markdown, limit);
  }

  const header = sections[0]!;
  const commitSections = sections.slice(1).map((section) => `---\n${section}`);
  const chunks: string[] = [];
  let current = header;

  for (const section of commitSections) {
    const candidate = current ? `${current}\n\n${section}` : section;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    if (section.length <= limit) {
      current = section;
      continue;
    }

    chunks.push(...chunkPlainMarkdown(section, limit));
    current = '';
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : chunkPlainMarkdown(markdown, limit);
}

function chunkPlainMarkdown(markdown: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = markdown;
  while (rest.length > limit) {
    let splitAt = rest.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trimStart();
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}
