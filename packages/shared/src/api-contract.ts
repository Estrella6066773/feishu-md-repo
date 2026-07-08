/** 递增此版本号以提示 UI 重启 core-service（旧进程可能缺少新路由） */
export const CORE_API_VERSION = 3;

export const CORE_API_FEATURES = [
  'settings-feishu',
  'settings-bot',
  'settings-user-permissions',
  'bindings-crud',
  'sync-log-detail',
  'export-markdown',
  'import-comments',
  'comment-import-log-detail',
] as const;

export type CoreApiFeature = (typeof CORE_API_FEATURES)[number];

/** UI 与 core-service 健康检查共用的最低能力要求 */
export const REQUIRED_CORE_API_FEATURES: readonly CoreApiFeature[] = [
  'settings-bot',
  'settings-user-permissions',
];

export interface CoreHealthPayload {
  ok?: boolean;
  apiVersion?: number;
  features?: string[];
}

export function isCoreServiceCompatible(health: CoreHealthPayload): boolean {
  if (health.apiVersion != null && health.apiVersion >= 2) return true;
  return REQUIRED_CORE_API_FEATURES.every((feature) => health.features?.includes(feature));
}
