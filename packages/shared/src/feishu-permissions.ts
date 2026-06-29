import type { Binding, FeishuUserPermission, FeishuUserRole } from './types.js';

/** 未在名单中配置的用户 */
export type EffectiveFeishuRole = FeishuUserRole | 'default';

export type { FeishuUserPermission, FeishuUserRole };

export const FEISHU_USER_ROLE_LABELS: Record<FeishuUserRole, string> = {
  admin: '管理员',
  manager: '管理者',
  member: '成员',
  blacklist: '黑名单',
};

export const FEISHU_ROLE_DESCRIPTIONS: Record<FeishuUserRole | 'default', string> = {
  admin: '可访问管理后台逻辑下的全部绑定与指令（含全库重建）',
  manager: '仅可对已指定的绑定使用全部可用指令',
  member: '仅可对有云（云端）绑定发起普通同步，不可操作本地库、不可全库重建',
  blacklist: '禁止使用一切机器人功能',
  default: '未在名单中配置的用户；不写入数据库，无法使用指令',
};

export function resolveFeishuUserRole(
  openId: string | undefined,
  permissions: FeishuUserPermission[],
): EffectiveFeishuRole {
  if (!openId) return 'default';
  const entry = permissions.find((item) => item.openId === openId);
  return entry?.role ?? 'default';
}

export function getManagerBindingIds(
  openId: string | undefined,
  permissions: FeishuUserPermission[],
): string[] | undefined {
  if (!openId) return undefined;
  return permissions.find((item) => item.openId === openId)?.bindingIds;
}

export function filterBindingsForRole(
  bindings: Binding[],
  role: EffectiveFeishuRole,
  managerBindingIds?: string[],
): Binding[] {
  switch (role) {
    case 'admin':
      return bindings;
    case 'manager': {
      const ids = new Set(managerBindingIds ?? []);
      return bindings.filter((binding) => ids.has(binding.id));
    }
    case 'member':
      return bindings.filter((binding) => binding.sourceType === 'cloud');
    default:
      return [];
  }
}

export function canAccessBinding(
  binding: Binding,
  role: EffectiveFeishuRole,
  managerBindingIds?: string[],
): boolean {
  return filterBindingsForRole([binding], role, managerBindingIds).length > 0;
}

export type BotCommandKind = 'help' | 'status' | 'sync' | 'full_sync';

export function classifyBotCommand(command: {
  type: string;
  fullResync?: boolean;
}): BotCommandKind {
  if (command.type === 'help') return 'help';
  if (command.type === 'status') return 'status';
  if (command.fullResync) return 'full_sync';
  return 'sync';
}

export function authorizeBotCommand(options: {
  role: EffectiveFeishuRole;
  commandKind: BotCommandKind;
}): { allowed: boolean; message?: string } {
  const { role, commandKind } = options;

  if (role === 'blacklist') {
    return { allowed: false, message: '你已被列入黑名单，无法使用机器人功能。' };
  }
  if (role === 'default') {
    return {
      allowed: false,
      message: '你尚未被授权。请联系管理员在设置中添加你的飞书 open_id 并分配权限。',
    };
  }

  if (commandKind === 'full_sync' && role === 'member') {
    return { allowed: false, message: '成员权限不支持全库重建，请使用「同步」指令。' };
  }

  if (commandKind === 'help') {
    return { allowed: true };
  }

  if (role === 'admin' || role === 'manager' || role === 'member') {
    return { allowed: true };
  }

  return { allowed: false, message: '权限不足。' };
}
