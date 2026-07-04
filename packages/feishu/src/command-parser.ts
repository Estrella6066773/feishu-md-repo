export type BotCommandAction =
  | { type: 'help' }
  | { type: 'status' }
  | { type: 'sync_all'; fullResync?: boolean }
  | { type: 'sync_binding'; bindingName: string; fullResync?: boolean }
  | { type: 'import_comments_all' }
  | { type: 'import_comments_binding'; bindingName: string };

export function parseBotCommand(rawText: string): BotCommandAction | null {
  const text = rawText.trim();
  if (!text) return null;

  const normalized = text.replace(/^[@/!]+/, '').trim();

  if (/^(help|帮助|\?)$/i.test(normalized)) {
    return { type: 'help' };
  }

  if (/^(status|状态)$/i.test(normalized)) {
    return { type: 'status' };
  }

  const fullSyncMatch = normalized.match(/^(全库重建|全量同步|sync\s+--full|同步\s+--full)(?:\s+(.+))?$/i);
  if (fullSyncMatch) {
    const name = fullSyncMatch[2]?.trim();
    if (name) return { type: 'sync_binding', bindingName: name, fullResync: true };
    return { type: 'sync_all', fullResync: true };
  }

  const syncMatch = normalized.match(/^(sync|同步)(?:\s+(.+))?$/i);
  if (syncMatch) {
    const name = syncMatch[2]?.trim();
    if (name) return { type: 'sync_binding', bindingName: name };
    return { type: 'sync_all' };
  }

  const importCommentsMatch = normalized.match(/^(导入评论|import-comments?)(?:\s+(.+))?$/i);
  if (importCommentsMatch) {
    const name = importCommentsMatch[2]?.trim();
    if (name) return { type: 'import_comments_binding', bindingName: name };
    return { type: 'import_comments_all' };
  }

  return null;
}

export const BOT_HELP_TEXT = `Feishu MD Repo 指令：
• 同步 / sync — 触发同步（未指定绑定时同步全部）
• 同步 <绑定名> — 同步指定绑定
• 导入评论 / import-comments — 从飞书拉取评论到本地 .feishu/comments/
• 导入评论 <绑定名> — 为指定绑定导入评论
• 全库重建 / sync --full — 强制重写全库文档
• 状态 / status — 查看绑定与最近同步
• 帮助 / help — 显示本说明

群聊中默认需 @ 机器人才会响应（可在设置中关闭）。`;
