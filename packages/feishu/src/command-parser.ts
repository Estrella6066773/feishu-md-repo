import { buildBotHelpText } from '@feishu-md/shared';

export type BotCommandAction =
  | { type: 'help' }
  | { type: 'status' }
  | { type: 'sync_all'; fullResync?: boolean; forceRewriteAll?: boolean }
  | { type: 'sync_binding'; bindingName: string; fullResync?: boolean; forceRewriteAll?: boolean }
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

  const forceRewriteMatch = normalized.match(
    /^(强制重写|sync\s+--(?:full|force)|同步\s+--(?:full|force))(?:\s+(.+))?$/i,
  );
  if (forceRewriteMatch) {
    const name = forceRewriteMatch[2]?.trim();
    if (name) {
      return { type: 'sync_binding', bindingName: name, fullResync: true, forceRewriteAll: true };
    }
    return { type: 'sync_all', fullResync: true, forceRewriteAll: true };
  }

  const repairSyncMatch = normalized.match(
    /^(完全重新搭建|全库重建|全量同步|全量重建|修复同步|sync\s+--repair)(?:\s+(.+))?$/i,
  );
  if (repairSyncMatch) {
    const name = repairSyncMatch[2]?.trim();
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

/** @deprecated 请使用 buildBotHelpText(role)；保留供外部只读引用 */
export const BOT_HELP_TEXT = buildBotHelpText('admin');