export type RepoSourceType = 'local' | 'cloud';
export type SyncMode = 'workspace' | 'repository';
export type FeishuTargetType = 'wiki' | 'drive';
export type SyncTriggerType = 'git' | 'schedule' | 'manual' | 'bot';
export type MissingReadmePolicy = 'skip' | 'placeholder' | 'empty_doc';
export type FeishuNodeType = 'folder' | 'docx' | 'file';

/** 同步时在飞书根级创建的「同步文档总览」节点映射路径（非 Git 路径） */
export const SYNC_OVERVIEW_GIT_PATH = '__sync_overview__';

/** 同步文档总览在飞书侧的标题 */
export const SYNC_OVERVIEW_TITLE = '同步文档总览';

export function isReservedSyncGitPath(gitPath: string): boolean {
  return gitPath.replace(/\\/g, '/') === SYNC_OVERVIEW_GIT_PATH;
}
export type SyncJobStatus = 'pending' | 'running' | 'success' | 'failed';

export type FeishuUserRole = 'admin' | 'manager' | 'member' | 'blacklist';

/** 显式配置的飞书用户权限（default 组用户不写入库） */
export interface FeishuUserPermission {
  openId: string;
  role: FeishuUserRole;
  bindingIds?: string[];
  label?: string;
}

export interface FeishuTarget {
  type: FeishuTargetType;
  wikiSpaceId?: string;
  wikiRootNodeToken?: string;
  driveRootFolderToken?: string;
}

export interface WorkspaceOptions {
  mdExtensions: string[];
  mirrorNonMdFiles: boolean;
  ignoreGlobs: string[];
}

export interface RepositoryOptions {
  readmeNames: string[];
  missingReadmePolicy: MissingReadmePolicy;
  ignoreGlobs: string[];
}

export interface BindingTriggers {
  onGitCommit: boolean;
  scheduleEnabled: boolean;
  scheduleMinutes: number;
}

export interface Binding {
  id: string;
  name: string;
  sourceType: RepoSourceType;
  repoPath: string;
  remoteUrl?: string;
  branch: string;
  syncMode: SyncMode;
  feishuTarget: FeishuTarget;
  triggers: BindingTriggers;
  options: WorkspaceOptions | RepositoryOptions;
  /** 机器人播报：绑定级目标群聊/用户。空数组仍表示“不使用全局目标”。未配置(undefined) 回退到全局 broadcastTargets。 */
  bindingSpecificBroadcastTargets?: BotBroadcastTarget[];
  lastSyncedSha?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeMapping {
  id: string;
  bindingId: string;
  gitPath: string;
  feishuTargetType: FeishuTargetType;
  feishuNodeToken: string;
  feishuDocToken?: string;
  feishuNodeType: FeishuNodeType;
  feishuParentToken?: string;
  contentSha?: string;
}

export interface SyncLogEntry {
  id: string;
  bindingId: string;
  trigger: SyncTriggerType;
  fromSha?: string;
  toSha?: string;
  status: SyncJobStatus;
  message?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface SyncRequest {
  fullResync?: boolean;
  trigger?: SyncTriggerType;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export type BotTargetType = 'chat' | 'user';

export interface BotBroadcastTarget {
  type: BotTargetType;
  receiveId: string;
  label?: string;
}

export interface BotSettings {
  /** 总开关：播报 + 指令监听 */
  enabled: boolean;
  broadcastEnabled: boolean;
  broadcastTargets: BotBroadcastTarget[];
  broadcastOnSuccess: boolean;
  broadcastOnFailure: boolean;
  commandListenEnabled: boolean;
  /** 允许下发指令的群 chat_id；为空表示不限制（机器人须在群内） */
  commandAllowedChatIds: string[];
  /** @deprecated 请改用 userPermissions 权限级别；保留仅为兼容旧数据 */
  commandAllowedUserOpenIds: string[];
  /** 群聊中是否必须 @ 机器人 才响应 */
  commandRequireMentionInGroup: boolean;
  /** 「同步」指令默认绑定的 binding；为空则同步全部 */
  defaultBindingId?: string;
}

export interface AppSettings {
  feishu?: FeishuCredentials;
  bot?: BotSettings;
  /** 飞书用户权限名单（不含 default 组） */
  userPermissions?: FeishuUserPermission[];
  dataDir?: string;
}

export const DEFAULT_WORKSPACE_OPTIONS: WorkspaceOptions = {
  mdExtensions: ['.md', '.markdown'],
  mirrorNonMdFiles: false,
  ignoreGlobs: ['**/node_modules/**', '**/.git/**'],
};

export const DEFAULT_REPOSITORY_OPTIONS: RepositoryOptions = {
  readmeNames: ['README.md', 'readme.md', 'Readme.md'],
  missingReadmePolicy: 'skip',
  ignoreGlobs: ['**/node_modules/**', '**/.git/**'],
};

/** 默认定时检查间隔（分钟） */
export const DEFAULT_SCHEDULE_MINUTES = 10;

export const DEFAULT_TRIGGERS: BindingTriggers = {
  onGitCommit: true,
  scheduleEnabled: false,
  scheduleMinutes: DEFAULT_SCHEDULE_MINUTES,
};

/** 本地库：提交 hook；有云库：默认定时 fetch 远程 */
export function defaultTriggersForSourceType(sourceType: RepoSourceType): BindingTriggers {
  if (sourceType === 'cloud') {
    return {
      onGitCommit: false,
      scheduleEnabled: true,
      scheduleMinutes: DEFAULT_SCHEDULE_MINUTES,
    };
  }
  return {
    onGitCommit: true,
    scheduleEnabled: false,
    scheduleMinutes: DEFAULT_SCHEDULE_MINUTES,
  };
}

export const MIN_SCHEDULE_MINUTES = 1;
export const MAX_SCHEDULE_MINUTES = 1440;

export function normalizeBindingTriggers(
  triggers: Partial<BindingTriggers> | undefined,
  sourceType: RepoSourceType = 'local',
): BindingTriggers {
  const defaults = defaultTriggersForSourceType(sourceType);
  const merged = { ...defaults, ...triggers };
  const minutes = Number(merged.scheduleMinutes);
  return {
    onGitCommit: Boolean(merged.onGitCommit),
    scheduleEnabled: Boolean(merged.scheduleEnabled),
    scheduleMinutes: Number.isFinite(minutes)
      ? Math.min(MAX_SCHEDULE_MINUTES, Math.max(MIN_SCHEDULE_MINUTES, Math.round(minutes)))
      : DEFAULT_SCHEDULE_MINUTES,
  };
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  enabled: false,
  broadcastEnabled: false,
  broadcastTargets: [],
  broadcastOnSuccess: true,
  broadcastOnFailure: true,
  commandListenEnabled: false,
  commandAllowedChatIds: [],
  commandAllowedUserOpenIds: [],
  commandRequireMentionInGroup: true,
};

export const DEFAULT_BINDING_BROADCAST_TARGETS: BotBroadcastTarget[] = [];

export function defaultOptionsForMode(mode: SyncMode): WorkspaceOptions | RepositoryOptions {
  return mode === 'workspace'
    ? { ...DEFAULT_WORKSPACE_OPTIONS }
    : { ...DEFAULT_REPOSITORY_OPTIONS };
}

export function isWorkspaceOptions(
  mode: SyncMode,
  options: WorkspaceOptions | RepositoryOptions,
): options is WorkspaceOptions {
  return mode === 'workspace';
}
