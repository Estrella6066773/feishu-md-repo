import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { BotBroadcastTarget, BotSettings } from '@feishu-md/shared';
import { DEFAULT_BOT_SETTINGS } from '@feishu-md/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Toggle } from '@/components/ui/Toggle';
import { fetchBindings, fetchSettings, saveBotSettings, saveFeishuCredentials } from '@/lib/queries';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const bindings = useQuery({ queryKey: ['bindings'], queryFn: fetchBindings });

  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [botSettings, setBotSettings] = useState<BotSettings>(DEFAULT_BOT_SETTINGS);
  const [newTargetType, setNewTargetType] = useState<'chat' | 'user'>('chat');
  const [newTargetId, setNewTargetId] = useState('');
  const [newTargetLabel, setNewTargetLabel] = useState('');

  useEffect(() => {
    if (settings.data?.bot) {
      setBotSettings(settings.data.bot);
    }
  }, [settings.data?.bot]);

  const saveCredentialsMutation = useMutation({
    mutationFn: saveFeishuCredentials,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      setAppSecret('');
    },
  });

  const saveBotMutation = useMutation({
    mutationFn: saveBotSettings,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  function addBroadcastTarget() {
    if (!newTargetId.trim()) return;
    const target: BotBroadcastTarget = {
      type: newTargetType,
      receiveId: newTargetId.trim(),
      label: newTargetLabel.trim() || undefined,
    };
    setBotSettings((prev) => ({
      ...prev,
      broadcastTargets: [...prev.broadcastTargets, target],
    }));
    setNewTargetId('');
    setNewTargetLabel('');
  }

  function removeBroadcastTarget(index: number) {
    setBotSettings((prev) => ({
      ...prev,
      broadcastTargets: prev.broadcastTargets.filter((_, i) => i !== index),
    }));
  }

  const connection = settings.data?.botConnection;
  const connectionClass = connection?.connected
    ? 'connection-badge connection-badge-online'
    : connection?.listening
      ? 'connection-badge connection-badge-pending'
      : 'connection-badge connection-badge-offline';

  return (
    <div className="page-stack-lg max-w-3xl">
      <PageHeader title="设置" description="配置飞书应用凭证、同步播报与指令监听。" />

      <Card>
        <CardHeader title="运行环境" description="本地数据与 API 地址" />
        <div className="settings-grid">
          <div className="info-row">
            <span className="info-row-label">数据目录</span>
            <div className="info-row-value">{settings.data?.dataDir ?? '加载中…'}</div>
          </div>
          <div className="info-row">
            <span className="info-row-label">核心服务</span>
            <div className="info-row-value">{settings.data?.coreServiceUrl ?? '加载中…'}</div>
          </div>
        </div>
      </Card>

      <Card>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            saveCredentialsMutation.mutate({ appId, appSecret });
          }}
        >
          <CardHeader title="飞书应用凭证" description="App Secret 仅存于本机数据库，不会在界面明文回显。" />

          {settings.data?.feishu?.appSecretConfigured ? (
            <Alert tone="success">已配置 app_secret，更新时重新填写 App ID 与 Secret 即可覆盖。</Alert>
          ) : (
            <Alert tone="warning" title="尚未配置">
              请先在飞书开放平台创建自建应用，并开通 Wiki / Drive / 机器人相关权限。
            </Alert>
          )}

          <Field label="App ID">
            <input
              className="field-input"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder={settings.data?.feishu?.appId ?? 'cli_xxx'}
              required
            />
          </Field>
          <Field label="App Secret">
            <input
              className="field-input"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="保存后不会再次显示"
              required
            />
          </Field>

          {saveCredentialsMutation.isError ? (
            <Alert tone="danger">
              {saveCredentialsMutation.error instanceof Error
                ? saveCredentialsMutation.error.message
                : '保存失败'}
            </Alert>
          ) : null}

          <div>
            <Button type="submit" variant="primary" disabled={saveCredentialsMutation.isPending}>
              {saveCredentialsMutation.isPending ? '保存中…' : '保存凭证'}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            saveBotMutation.mutate(botSettings);
          }}
        >
          <CardHeader
            title="机器人播报与指令"
            description="同步完成后推送消息；通过长连接接收「同步」等指令。"
            action={
              <span className={connectionClass}>
                <span
                  className={`status-dot ${
                    connection?.connected
                      ? 'status-dot-online'
                      : connection?.listening
                        ? 'status-dot-warning'
                        : 'status-dot-offline'
                  }`}
                  style={{ width: '0.375rem', height: '0.375rem' }}
                />
                {connection?.connected ? '长连接已就绪' : connection?.listening ? '连接中' : '未启动'}
              </span>
            }
          />

          <Toggle
            label="启用机器人能力"
            description="总开关：关闭后既不播报也不监听指令"
            checked={botSettings.enabled}
            onChange={(checked) => setBotSettings((prev) => ({ ...prev, enabled: checked }))}
          />

          <div className="section-divider section-block">
            <h3 className="text-sm font-semibold">同步播报</h3>
            <div className="toggle-stack">
            <Toggle
              label="启用同步结果播报"
              checked={botSettings.broadcastEnabled}
              onChange={(checked) => setBotSettings((prev) => ({ ...prev, broadcastEnabled: checked }))}
              disabled={!botSettings.enabled}
            />
            <Toggle
              label="成功时播报"
              checked={botSettings.broadcastOnSuccess}
              onChange={(checked) => setBotSettings((prev) => ({ ...prev, broadcastOnSuccess: checked }))}
              disabled={!botSettings.enabled || !botSettings.broadcastEnabled}
            />
            <Toggle
              label="失败时播报"
              checked={botSettings.broadcastOnFailure}
              onChange={(checked) => setBotSettings((prev) => ({ ...prev, broadcastOnFailure: checked }))}
              disabled={!botSettings.enabled || !botSettings.broadcastEnabled}
            />
            </div>

            <Field label="播报目标" hint="群 chat_id（oc_xxx）或用户 open_id（ou_xxx）">
              <div className="target-list">
                {botSettings.broadcastTargets.map((target, index) => (
                  <div key={`${target.type}-${target.receiveId}-${index}`} className="target-row">
                    <span>
                      {target.label ? `${target.label} · ` : ''}
                      {target.type === 'chat' ? '群' : '用户'} {target.receiveId}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeBroadcastTarget(index)}>
                      移除
                    </Button>
                  </div>
                ))}
                <div className="input-grid input-grid-4">
                  <select
                    className="field-input"
                    value={newTargetType}
                    onChange={(e) => setNewTargetType(e.target.value as 'chat' | 'user')}
                  >
                    <option value="chat">群聊</option>
                    <option value="user">用户</option>
                  </select>
                  <input
                    className="field-input"
                    placeholder="oc_xxx 或 ou_xxx"
                    value={newTargetId}
                    onChange={(e) => setNewTargetId(e.target.value)}
                  />
                  <input
                    className="field-input"
                    placeholder="备注名（可选）"
                    value={newTargetLabel}
                    onChange={(e) => setNewTargetLabel(e.target.value)}
                  />
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={addBroadcastTarget}>
                  添加播报目标
                </Button>
              </div>
            </Field>
          </div>

          <div className="section-divider section-block">
            <h3 className="text-sm font-semibold">指令监听</h3>
            <div className="toggle-stack">
              <Toggle
                label="启用飞书消息指令"
                checked={botSettings.commandListenEnabled}
                onChange={(checked) => setBotSettings((prev) => ({ ...prev, commandListenEnabled: checked }))}
                disabled={!botSettings.enabled}
              />
              <Toggle
                label="群聊中需 @ 机器人才响应"
                checked={botSettings.commandRequireMentionInGroup}
                onChange={(checked) =>
                  setBotSettings((prev) => ({ ...prev, commandRequireMentionInGroup: checked }))
                }
                disabled={!botSettings.enabled || !botSettings.commandListenEnabled}
              />
            </div>

            <Field label="允许的群 chat_id" hint="每行一个，留空表示不限制（机器人须在群内）">
              <textarea
                className="field-input min-h-20"
                value={botSettings.commandAllowedChatIds.join('\n')}
                onChange={(e) =>
                  setBotSettings((prev) => ({
                    ...prev,
                    commandAllowedChatIds: e.target.value
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean),
                  }))
                }
              />
            </Field>

            <Field label="允许的用户 open_id" hint="每行一个，留空表示不限制">
              <textarea
                className="field-input min-h-20"
                value={botSettings.commandAllowedUserOpenIds.join('\n')}
                onChange={(e) =>
                  setBotSettings((prev) => ({
                    ...prev,
                    commandAllowedUserOpenIds: e.target.value
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean),
                  }))
                }
              />
            </Field>

            <Field label="「同步」指令默认绑定" hint="留空则同步全部绑定">
              <select
                className="field-input"
                value={botSettings.defaultBindingId ?? ''}
                onChange={(e) =>
                  setBotSettings((prev) => ({
                    ...prev,
                    defaultBindingId: e.target.value || undefined,
                  }))
                }
              >
                <option value="">全部绑定</option>
                {(bindings.data ?? []).map((binding) => (
                  <option key={binding.id} value={binding.id}>
                    {binding.name}
                  </option>
                ))}
              </select>
            </Field>

            <div className="help-box">
              支持指令：同步 / sync、同步 &lt;绑定名&gt;、全量同步、状态 / status、帮助 / help。
              需在飞书开发者后台订阅「接收消息 im.message.receive_v1」，并选择「使用长连接接收事件」；保存订阅前请确保本机 core-service 已运行。
            </div>
          </div>

          {saveBotMutation.isError ? (
            <Alert tone="danger">
              {saveBotMutation.error instanceof Error ? saveBotMutation.error.message : '保存失败'}
            </Alert>
          ) : null}
          {saveBotMutation.isSuccess ? (
            <Alert tone="success">机器人设置已保存，长连接状态已刷新。</Alert>
          ) : null}

          <Button type="submit" variant="primary" disabled={saveBotMutation.isPending}>
            {saveBotMutation.isPending ? '保存中…' : '保存机器人设置'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
