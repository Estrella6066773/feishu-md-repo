import type { DbClient } from '@feishu-md/db';
import { getBotSettings, getFeishuUserPermissions, listBindings } from '@feishu-md/db';
import type { BotSettings } from '@feishu-md/shared';
import {
  authorizeBotCommand,
  canAccessBinding,
  classifyBotCommand,
  createLogger,
  filterBindingsForRole,
  getManagerBindingIds,
  resolveFeishuUserRole,
  type EffectiveFeishuRole,
} from '@feishu-md/shared';
import {
  parseBotCommand,
  parseMessageText,
  replyTextMessage,
  type BotCommandAction,
  type FeishuClient,
} from '@feishu-md/feishu';
import type { SyncCoordinator } from '../sync-coordinator.js';
import type { CommentImportCoordinator } from '../comment-import-coordinator.js';

const botCmdLog = createLogger('bot-command');

export class BotCommandHandler {
  constructor(
    private db: DbClient,
    private client: FeishuClient,
    private syncCoordinator: SyncCoordinator,
    private commentImportCoordinator: CommentImportCoordinator,
  ) {}

  async handleIncomingMessage(data: {
    message: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string; name: string }>;
    };
    sender: {
      sender_id?: { open_id?: string; user_id?: string };
      sender_type: string;
    };
  }): Promise<void> {
    const settings = await getBotSettings(this.db);
    if (!settings.enabled || !settings.commandListenEnabled) return;
    if (data.sender.sender_type === 'app') return;

    const text = parseMessageText(data.message.content, data.message.message_type);
    const command = parseBotCommand(text);
    if (!command) return;
    botCmdLog.info('收到机器人指令', { commandType: command.type, chatId: data.message.chat_id });
    if (!this.isChatAllowed(settings, data)) return;
    if (!this.isMentionAllowed(settings, data, text)) return;

    const permissions = await getFeishuUserPermissions(this.db);
    const openId = data.sender.sender_id?.open_id;
    const role = this.resolveRole(openId, permissions, settings);
    const managerBindingIds = getManagerBindingIds(openId, permissions);

    const auth = authorizeBotCommand({ role, commandKind: classifyBotCommand(command) });
    if (!auth.allowed) {
      botCmdLog.warn('指令鉴权拒绝', { commandType: command.type, role });
      await replyTextMessage(this.client, data.message.message_id, auth.message ?? '权限不足。');
      return;
    }

    if (command.type === 'help') {
      await replyTextMessage(this.client, data.message.message_id, buildHelpText(role));
      return;
    }

    if (command.type === 'status') {
      await replyTextMessage(
        this.client,
        data.message.message_id,
        await formatBindingStatus(this.db, role, managerBindingIds),
      );
      return;
    }

    await replyTextMessage(this.client, data.message.message_id, this.buildAckText(command));

    void this.executeCommand(command, settings, role, managerBindingIds).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      await replyTextMessage(this.client, data.message.message_id, `指令执行失败：${message}`);
    });
  }

  /**
   * 群聊指令仅依据用户权限级别；未配置权限名单时回退旧版 open_id 白名单逻辑。
   */
  private resolveRole(
    openId: string | undefined,
    permissions: Awaited<ReturnType<typeof getFeishuUserPermissions>>,
    settings: BotSettings,
  ): EffectiveFeishuRole {
    if (permissions.length > 0) {
      return resolveFeishuUserRole(openId, permissions);
    }

    const legacyIds = settings.commandAllowedUserOpenIds;
    if (legacyIds.length === 0) {
      return 'admin';
    }
    if (openId && legacyIds.includes(openId)) {
      return 'admin';
    }
    return 'default';
  }

  private isChatAllowed(
    settings: BotSettings,
    data: { message: { chat_id: string } },
  ): boolean {
    if (settings.commandAllowedChatIds.length === 0) return true;
    return settings.commandAllowedChatIds.includes(data.message.chat_id);
  }

  private isMentionAllowed(
    settings: BotSettings,
    data: {
      message: { chat_type: string; mentions?: Array<{ key: string }> };
    },
    text: string,
  ): boolean {
    if (data.message.chat_type !== 'group') return true;
    if (!settings.commandRequireMentionInGroup) return true;
    if ((data.message.mentions?.length ?? 0) > 0) return true;
    return text.includes('@');
  }

  private buildAckText(command: BotCommandAction): string {
    switch (command.type) {
      case 'sync_all':
        return command.fullResync ? '已收到：开始完全重新搭建…' : '已收到：开始同步…';
      case 'sync_binding':
        return command.fullResync
          ? `已收到：开始完全重新搭建「${command.bindingName}」…`
          : `已收到：开始同步「${command.bindingName}」…`;
      case 'import_comments_all':
        return '已收到：开始导入全部绑定评论…';
      case 'import_comments_binding':
        return `已收到：开始导入「${command.bindingName}」评论…`;
      default:
        return '已收到指令';
    }
  }

  private async executeCommand(
    command: BotCommandAction,
    settings: BotSettings,
    role: EffectiveFeishuRole,
    managerBindingIds?: string[],
  ): Promise<void> {
    switch (command.type) {
      case 'help':
      case 'status':
        return;
      case 'sync_all':
        await this.syncAll(command.fullResync ?? false, settings, role, managerBindingIds);
        return;
      case 'sync_binding':
        await this.syncByName(command.bindingName, command.fullResync ?? false, role, managerBindingIds);
        return;
      case 'import_comments_all':
        await this.importCommentsAll(settings, role, managerBindingIds);
        return;
      case 'import_comments_binding':
        await this.importCommentsByName(command.bindingName, role, managerBindingIds);
        return;
    }
  }

  private async syncAll(
    fullResync: boolean,
    settings: BotSettings,
    role: EffectiveFeishuRole,
    managerBindingIds?: string[],
  ): Promise<void> {
    const bindings = await listBindings(this.db);
    let targets = filterBindingsForRole(bindings, role, managerBindingIds);

    if (role === 'admin' && settings.defaultBindingId) {
      targets = targets.filter((item) => item.id === settings.defaultBindingId);
    }

    if (targets.length === 0) {
      throw new Error(
        role === 'member'
          ? '没有你可同步的有云绑定（成员不可操作本地仓库）'
          : '没有你可同步的绑定',
      );
    }

    for (const binding of targets) {
      botCmdLog.info('机器人指令入队同步', { bindingId: binding.id, bindingName: binding.name });
      this.syncCoordinator.enqueueBindingSync(binding.id, 'bot', fullResync);
    }
  }

  private async syncByName(
    name: string,
    fullResync: boolean,
    role: EffectiveFeishuRole,
    managerBindingIds?: string[],
  ): Promise<void> {
    const bindings = await listBindings(this.db);
    const binding = bindings.find((item) => item.name === name);
    if (!binding) {
      throw new Error(`未找到绑定「${name}」`);
    }
    if (!canAccessBinding(binding, role, managerBindingIds)) {
      if (role === 'member' && binding.sourceType === 'local') {
        throw new Error(`成员权限不可同步本地仓库「${name}」，仅有云绑定可申请同步`);
      }
      throw new Error(`你没有权限同步绑定「${name}」`);
    }
    if (fullResync && role === 'member') {
      throw new Error('成员权限不支持完全重新搭建');
    }
    this.syncCoordinator.enqueueBindingSync(binding.id, 'bot', fullResync);
    botCmdLog.info('机器人指令入队同步', { bindingId: binding.id, bindingName: binding.name });
  }

  private async importCommentsAll(
    settings: BotSettings,
    role: EffectiveFeishuRole,
    managerBindingIds?: string[],
  ): Promise<void> {
    const bindings = await listBindings(this.db);
    let targets = filterBindingsForRole(bindings, role, managerBindingIds);

    if (role === 'admin' && settings.defaultBindingId) {
      targets = targets.filter((item) => item.id === settings.defaultBindingId);
    }

    if (targets.length === 0) {
      throw new Error('没有你可导入评论的绑定');
    }

    for (const binding of targets) {
      botCmdLog.info('机器人指令入队评论导入', { bindingId: binding.id, bindingName: binding.name });
      this.commentImportCoordinator.enqueueCommentImport(binding.id, 'bot');
    }
  }

  private async importCommentsByName(
    name: string,
    role: EffectiveFeishuRole,
    managerBindingIds?: string[],
  ): Promise<void> {
    const bindings = await listBindings(this.db);
    const binding = bindings.find((item) => item.name === name);
    if (!binding) {
      throw new Error(`未找到绑定「${name}」`);
    }
    if (!canAccessBinding(binding, role, managerBindingIds)) {
      throw new Error(`你没有权限为绑定「${name}」导入评论`);
    }
    this.commentImportCoordinator.enqueueCommentImport(binding.id, 'bot');
    botCmdLog.info('机器人指令入队评论导入', { bindingId: binding.id, bindingName: binding.name });
  }
}

function buildHelpText(role: EffectiveFeishuRole): string {
  const lines = [
    'Feishu MD Repo 指令：',
    '• 同步 / sync — 触发同步',
    '• 同步 <绑定名> — 同步指定绑定',
    '• 导入评论 / import-comments — 从飞书拉取评论到本地',
    '• 导入评论 <绑定名> — 为指定绑定导入评论',
    '• 状态 / status — 查看绑定状态',
    '• 帮助 / help — 显示本说明',
  ];

  if (role === 'admin' || role === 'manager') {
    lines.splice(3, 0, '• 完全重新搭建 / sync --full — 强制重写全库文档');
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

export async function formatBindingStatus(
  db: DbClient,
  role: EffectiveFeishuRole,
  managerBindingIds?: string[],
): Promise<string> {
  const bindings = filterBindingsForRole(await listBindings(db), role, managerBindingIds);
  if (bindings.length === 0) {
    return role === 'member'
      ? '当前没有你可查看的有云绑定。'
      : '当前没有你可查看的绑定。';
  }

  const lines = bindings.map((binding) => {
    const sha = binding.lastSyncedSha?.slice(0, 7) ?? '未同步';
    const at = binding.lastSyncedAt ? new Date(binding.lastSyncedAt).toLocaleString() : '-';
    const source = binding.sourceType === 'cloud' ? '有云' : '本地';
    return `• ${binding.name}（${source} / ${binding.syncMode}）最近：${sha} @ ${at}`;
  });
  return `绑定状态：\n${lines.join('\n')}`;
}
