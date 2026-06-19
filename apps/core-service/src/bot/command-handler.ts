import type { DbClient } from '@feishu-md/db';
import { getBotSettings, listBindings } from '@feishu-md/db';
import type { BotSettings } from '@feishu-md/shared';
import {
  BOT_HELP_TEXT,
  parseBotCommand,
  parseMessageText,
  replyTextMessage,
  type BotCommandAction,
  type FeishuClient,
} from '@feishu-md/feishu';
import type { SyncCoordinator } from '../sync-coordinator.js';

export class BotCommandHandler {
  constructor(
    private db: DbClient,
    private client: FeishuClient,
    private syncCoordinator: SyncCoordinator,
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
    if (!this.isSenderAllowed(settings, data)) return;
    if (!this.isMentionAllowed(settings, data, text)) return;

    if (command.type === 'help') {
      await replyTextMessage(this.client, data.message.message_id, BOT_HELP_TEXT);
      return;
    }

    if (command.type === 'status') {
      await replyTextMessage(this.client, data.message.message_id, await formatBindingStatus(this.db));
      return;
    }

    await replyTextMessage(this.client, data.message.message_id, this.buildAckText(command));

    void this.executeCommand(command, settings).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      await replyTextMessage(this.client, data.message.message_id, `指令执行失败：${message}`);
    });
  }

  private isSenderAllowed(
    settings: BotSettings,
    data: {
      message: { chat_id: string };
      sender: { sender_id?: { open_id?: string } };
    },
  ): boolean {
    if (
      settings.commandAllowedChatIds.length > 0 &&
      !settings.commandAllowedChatIds.includes(data.message.chat_id)
    ) {
      return false;
    }

    const openId = data.sender.sender_id?.open_id;
    if (
      settings.commandAllowedUserOpenIds.length > 0 &&
      (!openId || !settings.commandAllowedUserOpenIds.includes(openId))
    ) {
      return false;
    }

    return true;
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
        return command.fullResync ? '已收到：开始全量同步全部绑定…' : '已收到：开始同步全部绑定…';
      case 'sync_binding':
        return command.fullResync
          ? `已收到：开始全量同步「${command.bindingName}」…`
          : `已收到：开始同步「${command.bindingName}」…`;
      default:
        return '已收到指令';
    }
  }

  private async executeCommand(command: BotCommandAction, settings: BotSettings): Promise<void> {
    switch (command.type) {
      case 'help':
      case 'status':
        return;
      case 'sync_all':
        await this.syncAll(command.fullResync ?? false, settings);
        return;
      case 'sync_binding':
        await this.syncByName(command.bindingName, command.fullResync ?? false);
        return;
    }
  }

  private async syncAll(fullResync: boolean, settings: BotSettings): Promise<void> {
    const bindings = await listBindings(this.db);
    if (bindings.length === 0) {
      throw new Error('没有可同步的绑定');
    }

    const targets =
      settings.defaultBindingId != null
        ? bindings.filter((item) => item.id === settings.defaultBindingId)
        : bindings;

    if (targets.length === 0) {
      throw new Error('默认绑定不存在');
    }

    for (const binding of targets) {
      this.syncCoordinator.enqueueBindingSync(binding.id, 'bot', fullResync);
    }
  }

  private async syncByName(name: string, fullResync: boolean): Promise<void> {
    const bindings = await listBindings(this.db);
    const binding = bindings.find((item) => item.name === name);
    if (!binding) {
      throw new Error(`未找到绑定「${name}」`);
    }
    this.syncCoordinator.enqueueBindingSync(binding.id, 'bot', fullResync);
  }
}

export async function formatBindingStatus(db: DbClient): Promise<string> {
  const bindings = await listBindings(db);
  if (bindings.length === 0) return '当前没有配置任何绑定。';

  const lines = bindings.map((binding) => {
    const sha = binding.lastSyncedSha?.slice(0, 7) ?? '未同步';
    const at = binding.lastSyncedAt ? new Date(binding.lastSyncedAt).toLocaleString() : '-';
    return `• ${binding.name}（${binding.syncMode}）最近：${sha} @ ${at}`;
  });
  return `绑定状态：\n${lines.join('\n')}`;
}
