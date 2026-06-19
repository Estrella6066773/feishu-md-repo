export type RepoSourceType = 'local' | 'cloud';
export type SyncMode = 'workspace' | 'repository';
export type FeishuTargetType = 'wiki' | 'drive';
export type SyncTriggerType = 'git' | 'schedule' | 'manual' | 'bot';
export type MissingReadmePolicy = 'skip' | 'placeholder' | 'empty_doc';
export type FeishuNodeType = 'folder' | 'docx' | 'file';
export type SyncJobStatus = 'pending' | 'running' | 'success' | 'failed';

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
  /** 允许下发指令的用户 open_id；为空表示不限制 */
  commandAllowedUserOpenIds: string[];
  /** 群聊中是否必须 @ 机器人 才响应 */
  commandRequireMentionInGroup: boolean;
  /** 「同步」指令默认绑定的 binding；为空则同步全部 */
  defaultBindingId?: string;
}

export interface AppSettings {
  feishu?: FeishuCredentials;
  bot?: BotSettings;
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

export const DEFAULT_TRIGGERS: BindingTriggers = {
  onGitCommit: true,
  scheduleEnabled: false,
  scheduleMinutes: 15,
};

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
