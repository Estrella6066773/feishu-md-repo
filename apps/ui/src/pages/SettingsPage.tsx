import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BroadcastTargetEditor } from '@/components/BroadcastTargetEditor';
import { DEFAULT_BOT_SETTINGS, type BotSettings } from '@feishu-md/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Toggle } from '@/components/ui/Toggle';
import { UserPermissionsCard } from '@/components/UserPermissionsCard';
import { fetchBindings, fetchHealth, fetchSettings, isCoreServiceCompatible, saveBotSettings, saveFeishuCredentials } from '@/lib/queries';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: 1, refetchInterval: 15_000 });
  const bindings = useQuery({ queryKey: ['bindings'], queryFn: fetchBindings });
  const serviceStale = health.data != null && !isCoreServiceCompatible(health.data);

  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [botSettings, setBotSettings] = useState<BotSettings>(DEFAULT_BOT_SETTINGS);

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

  const connection = settings.data?.botConnection;
  const connectionClass = connection?.connected
    ? 'connection-badge connection-badge-online'
    : connection?.listening
      ? 'connection-badge connection-badge-pending'
      : 'connection-badge connection-badge-offline';

  return (
    <div className="page-stack-lg max-w-3xl">
      <PageHeader title="设置" description="配置飞书应用凭证、同步播报与指令监听。" />

      {serviceStale ? (
        <Alert tone="danger" title="核心服务版本过旧">
          当前 8787 端口上的 core-service 缺少新版 API（保存机器人/用户权限会 404）。请结束旧进程后重新运行{' '}
          <code>pnpm dev:service</code>，并刷新本页。Windows 查占用：<code>netstat -ano | findstr :8787</code>
        </Alert>
      ) : null}

      {!health.isLoading && health.isError ? (
        <Alert tone="danger" title="无法连接核心服务">
          请先运行 <code>pnpm dev:service</code>（默认 http://127.0.0.1:8787）。
        </Alert>
      ) : null}

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

      <UserPermissionsCard
        initial={settings.data?.userPermissions ?? []}
        bindings={bindings.data ?? []}
      />

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

          {botSettings.enabled && !botSettings.commandListenEnabled ? (
            <Alert tone="warning" title="长连接未建立">
              已启用机器人能力，但「启用飞书消息指令」处于关闭状态，core-service 不会连接飞书 WS。
              若要在群里用「同步」等指令，请打开该开关并保存；仅同步播报可不开启。
            </Alert>
          ) : null}

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

            <Field label="播报目标" hint="群 chat_id（oc_xxx）或用户 open_id（ou_xxx）；每个目标可单独配置播报范围">
              <BroadcastTargetEditor
                targets={botSettings.broadcastTargets}
                globalDefaults={{
                  broadcastOnSuccess: botSettings.broadcastOnSuccess,
                  broadcastOnFailure: botSettings.broadcastOnFailure,
                }}
                disabled={!botSettings.enabled || !botSettings.broadcastEnabled}
                onChange={(broadcastTargets) =>
                  setBotSettings((prev) => ({
                    ...prev,
                    broadcastTargets,
                  }))
                }
              />
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

            <Field label="允许的群 chat_id" hint="每行一个，留空表示不限制（机器人须在群内）。指令权限由上方「飞书用户权限」控制。">
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

            <Field label="「同步」指令默认绑定" hint="仅管理员生效；留空则同步全部绑定">
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
              支持指令：同步 / sync、同步 &lt;绑定名&gt;、完全重新搭建、状态 / status、帮助 / help。
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
