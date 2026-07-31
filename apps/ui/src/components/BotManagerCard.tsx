import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { createBot, deleteBot, updateBot, type PublicFeishuBot } from '@/lib/queries';

export interface BotManagerCardProps {
  bots: PublicFeishuBot[];
  defaultBotId?: string;
  onSetDefault: (botId: string | undefined) => void;
  setDefaultPending?: boolean;
}

interface BotDraft {
  name: string;
  appId: string;
  appSecret: string;
}

const EMPTY_DRAFT: BotDraft = { name: '', appId: '', appSecret: '' };

export function BotManagerCard({
  bots,
  defaultBotId,
  onSetDefault,
  setDefaultPending = false,
}: BotManagerCardProps) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BotDraft>(EMPTY_DRAFT);
  const [editingDraft, setEditingDraft] = useState<BotDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);

  const refreshSettings = () => void queryClient.invalidateQueries({ queryKey: ['settings'] });

  const createMutation = useMutation({
    mutationFn: createBot,
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      setFormError(null);
      refreshSettings();
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : '创建失败'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { name: string; appId: string; appSecret?: string } }) =>
      updateBot(id, input),
    onSuccess: () => {
      setEditingId(null);
      setEditingDraft(EMPTY_DRAFT);
      setFormError(null);
      refreshSettings();
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : '保存失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteBot,
    onSuccess: () => {
      setEditingId(null);
      setFormError(null);
      refreshSettings();
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : '删除失败'),
  });

  function startEdit(bot: PublicFeishuBot) {
    setEditingId(bot.id);
    setEditingDraft({ name: bot.name, appId: bot.appId, appSecret: '' });
    setFormError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingDraft(EMPTY_DRAFT);
    setFormError(null);
  }

  function submitCreate() {
    setFormError(null);
    const name = draft.name.trim();
    const appId = draft.appId.trim();
    const appSecret = draft.appSecret.trim();
    if (!name || !appId || !appSecret) {
      setFormError('名称、App ID 与 App Secret 均为必填');
      return;
    }
    createMutation.mutate({ name, appId, appSecret });
  }

  function submitUpdate() {
    setFormError(null);
    if (!editingId) return;
    const name = editingDraft.name.trim();
    const appId = editingDraft.appId.trim();
    if (!name || !appId) {
      setFormError('名称与 App ID 均为必填');
      return;
    }
    const appSecret = editingDraft.appSecret.trim();
    updateMutation.mutate({
      id: editingId,
      input: { name, appId, ...(appSecret ? { appSecret } : {}) },
    });
  }

  function confirmDelete(bot: PublicFeishuBot) {
    setFormError(null);
    if (window.confirm(`确定删除机器人「${bot.name}」？若该机器人正被项目引用，将无法删除。`)) {
      deleteMutation.mutate(bot.id);
    }
  }

  const busy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  return (
    <Card>
      <CardHeader
        title="机器人管理"
        description="维护多个飞书应用作为机器人身份。选中一个作为默认，项目绑定可单独指定使用某个机器人。"
      />

      {bots.length === 0 ? (
        <Alert tone="warning" title="尚未配置机器人">
          请先添加机器人档案，并选中一个作为默认。未配置机器人时，系统使用下方「飞书应用凭证」。
        </Alert>
      ) : (
        <div className="target-list">
          {bots.map((bot) => {
            const isDefault = bot.id === defaultBotId;
            const isEditing = editingId === bot.id;
            return (
              <div key={bot.id} className="permission-row">
                {isEditing ? (
                  <div className="page-stack-sm w-full">
                    <Field label="显示名称">
                      <input
                        className="field-input"
                        value={editingDraft.name}
                        onChange={(e) =>
                          setEditingDraft((prev) => ({ ...prev, name: e.target.value }))
                        }
                        placeholder="例如：运营机器人"
                      />
                    </Field>
                    <Field label="App ID">
                      <input
                        className="field-input font-mono"
                        value={editingDraft.appId}
                        onChange={(e) =>
                          setEditingDraft((prev) => ({ ...prev, appId: e.target.value }))
                        }
                        placeholder="cli_xxx"
                      />
                    </Field>
                    <Field label="App Secret" hint="留空表示不修改（保存后不再显示明文）">
                      <input
                        className="field-input"
                        type="password"
                        value={editingDraft.appSecret}
                        onChange={(e) =>
                          setEditingDraft((prev) => ({ ...prev, appSecret: e.target.value }))
                        }
                        placeholder={bot.appSecretConfigured ? '已配置，留空保持不变' : '必填'}
                      />
                    </Field>
                    <div className="action-bar">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={submitUpdate}
                      >
                        {updateMutation.isPending ? '保存中…' : '保存'}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={cancelEdit}>
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="permission-row-main">
                      <div className="binding-card-title-row">
                        <span className="font-medium">{bot.name}</span>
                        {isDefault ? <Badge tone="blue">默认</Badge> : null}
                        {bot.appSecretConfigured ? (
                          <Badge>已配置密钥</Badge>
                        ) : (
                          <Badge tone="red">缺少密钥</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted font-mono mt-1">{bot.appId}</div>
                      <p className="text-xs text-fg-tertiary mt-1">
                        {isDefault
                          ? '作为系统默认机器人：项目未指定时使用，指令监听（WS）始终使用该机器人。'
                          : '可被项目绑定指定为该项目使用的机器人。'}
                      </p>
                    </div>
                    <div className="action-bar">
                      {!isDefault ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={setDefaultPending}
                          onClick={() => onSetDefault(bot.id)}
                        >
                          设为默认
                        </Button>
                      ) : null}
                      <Button type="button" variant="secondary" size="sm" onClick={() => startEdit(bot)}>
                        编辑
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => confirmDelete(bot)}
                      >
                        删除
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingId === null ? (
        <div className="section-divider section-block">
          <h3 className="text-sm font-semibold">添加机器人</h3>
          <Field label="显示名称" hint="便于在项目绑定中选择与识别">
            <input
              className="field-input"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="例如：运营机器人"
            />
          </Field>
          <Field label="App ID">
            <input
              className="field-input font-mono"
              value={draft.appId}
              onChange={(e) => setDraft((prev) => ({ ...prev, appId: e.target.value }))}
              placeholder="cli_xxx"
            />
          </Field>
          <Field label="App Secret" hint="仅存于本机数据库，保存后不会明文回显">
            <input
              className="field-input"
              type="password"
              value={draft.appSecret}
              onChange={(e) => setDraft((prev) => ({ ...prev, appSecret: e.target.value }))}
              placeholder="保存后不会再次显示"
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={submitCreate}
          >
            {createMutation.isPending ? '添加中…' : '添加机器人'}
          </Button>
        </div>
      ) : null}

      {formError ? <Alert tone="danger">{formError}</Alert> : null}
    </Card>
  );
}
