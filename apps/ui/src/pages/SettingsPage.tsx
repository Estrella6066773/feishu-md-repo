import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BroadcastTargetEditor } from '@/components/BroadcastTargetEditor';
import { BotManagerCard } from '@/components/BotManagerCard';
import { DEFAULT_BOT_SETTINGS, BOT_COMMAND_SUMMARY, type BotSettings } from '@feishu-md/shared';
import { ServiceHealthAlert } from '@/components/ServiceHealthAlert';
import { BotConnectionBadge } from '@/components/ConnectionStatusBadge';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Toggle } from '@/components/ui/Toggle';
import { UserPermissionsCard } from '@/components/UserPermissionsCard';
import { fetchBindings, saveBotSettings } from '@/lib/queries';
import { useBindingsQuery, useHealthQuery, useSettingsQuery } from '@/hooks/useCoreQueries';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useSettingsQuery();
  const health = useHealthQuery();
  const bindings = useBindingsQuery();

  const [botSettings, setBotSettings] = useState<BotSettings>(DEFAULT_BOT_SETTINGS);
  const [botFormDirty, setBotFormDirty] = useState(false);

  useEffect(() => {
    if (!botFormDirty && settings.data?.bot) {
      setBotSettings(settings.data.bot);
    }
  }, [settings.data?.bot, botFormDirty]);

  const saveBotMutation = useMutation({
    mutationFn: saveBotSettings,
    onSuccess: () => {
      setBotFormDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  function updateBotSettings(updater: (prev: BotSettings) => BotSettings) {
    setBotFormDirty(true);
    setBotSettings(updater);
  }

  const connection = settings.data?.botConnection;

  return (
    <div className="page-stack-lg max-w-3xl">
      <PageHeader title="设置" description="配置机器人凭证、同步播报与指令监听。" />

      <ServiceHealthAlert
        variant="settings"
        healthError={health.isError}
        healthLoading={health.isLoading}
        health={health.data}
      />

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

      <BotManagerCard
        bots={settings.data?.feishuBots ?? []}
        defaultBotId={botSettings.defaultBotId}
        onSetDefault={(botId) => saveBotMutation.mutate({ ...botSettings, defaultBotId: botId })}
        setDefaultPending={saveBotMutation.isPending}
      />

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
            description="同步完成后推送消息；通过长连接接收「同步」等指令。默认机器人负责指令长连接。"
            action={
              <BotConnectionBadge
                connected={connection?.connected}
                listening={connection?.listening}
              />
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
            onChange={(checked) => updateBotSettings((prev) => ({ ...prev, enabled: checked }))}
          />

          <div className="section-divider section-block">
            <h3 className="text-sm font-semibold">同步播报</h3>
            <div className="toggle-stack">
            <Toggle
              label="启用同步结果播报"
              checked={botSettings.broadcastEnabled}
              onChange={(checked) => updateBotSettings((prev) => ({ ...prev, broadcastEnabled: checked }))}
              disabled={!botSettings.enabled}
            />
            <Toggle
              label="成功时播报"
              checked={botSettings.broadcastOnSuccess}
              onChange={(checked) => updateBotSettings((prev) => ({ ...prev, broadcastOnSuccess: checked }))}
              disabled={!botSettings.enabled || !botSettings.broadcastEnabled}
            />
            <Toggle
              label="失败时播报"
              checked={botSettings.broadcastOnFailure}
              onChange={(checked) => updateBotSettings((prev) => ({ ...prev, broadcastOnFailure: checked }))}
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
                  updateBotSettings((prev) => ({
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
                onChange={(checked) => updateBotSettings((prev) => ({ ...prev, commandListenEnabled: checked }))}
                disabled={!botSettings.enabled}
              />
              <Toggle
                label="群聊中需 @ 机器人才响应"
                checked={botSettings.commandRequireMentionInGroup}
                onChange={(checked) =>
                  updateBotSettings((prev) => ({ ...prev, commandRequireMentionInGroup: checked }))
                }
                disabled={!botSettings.enabled || !botSettings.commandListenEnabled}
              />
            </div>

            <Field label="允许的群 chat_id" hint="每行一个，留空表示不限制（机器人须在群内）。指令权限由上方「飞书用户权限」控制。">
              <textarea
                className="field-input min-h-20"
                value={botSettings.commandAllowedChatIds.join('\n')}
                onChange={(e) =>
                  updateBotSettings((prev) => ({
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
                  updateBotSettings((prev) => ({
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
              {BOT_COMMAND_SUMMARY}
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
