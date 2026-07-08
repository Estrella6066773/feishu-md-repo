import type { EffectiveFeishuRole } from './feishu-permissions.js';

/** 机器人「帮助」指令与设置页说明的单一文案来源 */
export function buildBotHelpText(role: EffectiveFeishuRole): string {
  const lines = [
    'Feishu MD Repo 指令：',
    '• 同步 / sync — 触发同步（未指定绑定时同步全部）',
    '• 同步 <绑定名> — 同步指定绑定',
    '• 导入评论 / import-comments — 从飞书拉取评论到本地',
    '• 导入评论 <绑定名> — 为指定绑定导入评论',
    '• 状态 / status — 查看绑定状态',
    '• 帮助 / help — 显示本说明',
  ];

  if (role === 'admin' || role === 'manager') {
    lines.splice(
      3,
      0,
      '• 修复同步 / 完全重新搭建 — 校验飞书正文并仅修复异常文档',
      '• 强制重写 / sync --full — 强制重写全库正文',
    );
  }

  if (role === 'member') {
    lines.push('', '当前权限：成员 — 仅可对「有云仓库」绑定发起普通同步。');
  } else if (role === 'manager') {
    lines.push('', '当前权限：管理者 — 仅可操作已授权的绑定。');
  } else if (role === 'admin') {
    lines.push('', '当前权限：管理员 — 可使用全部指令。');
  }

  lines.push('', '群聊中默认需 @ 机器人才会响应。');
  return lines.join('\n');
}

/** 设置页等场景的简短指令摘要 */
export const BOT_COMMAND_SUMMARY =
  '支持指令：同步 / sync、同步 <绑定名>、修复同步、强制重写、状态 / status、帮助 / help。';
