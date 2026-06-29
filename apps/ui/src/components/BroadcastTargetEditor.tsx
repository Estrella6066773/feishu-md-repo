import { useState } from 'react';
import type { BotBroadcastTarget, BotSettings } from '@feishu-md/shared';
import {
  ALL_SYNC_TRIGGERS,
  detectTriggerPreset,
  formatBroadcastPolicySummary,
  hasCustomOutcomePolicy,
  SYNC_TRIGGER_LABELS,
  triggersFromPreset,
  type BroadcastTriggerPreset,
} from '@feishu-md/shared';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Toggle } from '@/components/ui/Toggle';

const TRIGGER_PRESET_OPTIONS: { value: BroadcastTriggerPreset; label: string; hint?: string }[] = [
  { value: 'all', label: '全部触发', hint: 'Git、定时、面板手动、飞书指令均播报' },
  { value: 'automatic', label: '仅自动更新', hint: 'Git 提交与定时检查' },
  { value: 'manual', label: '仅手动操作', hint: '面板手动与飞书指令' },
  { value: 'custom', label: '自定义…', hint: '自行勾选触发来源' },
];

export interface BroadcastTargetEditorProps {
  targets: BotBroadcastTarget[];
  onChange: (targets: BotBroadcastTarget[]) => void;
  globalDefaults: Pick<BotSettings, 'broadcastOnSuccess' | 'broadcastOnFailure'>;
  disabled?: boolean;
}

export function BroadcastTargetEditor({
  targets,
  onChange,
  globalDefaults,
  disabled = false,
}: BroadcastTargetEditorProps) {
  const [newTargetType, setNewTargetType] = useState<'chat' | 'user'>('chat');
  const [newTargetId, setNewTargetId] = useState('');
  const [newTargetLabel, setNewTargetLabel] = useState('');

  function updateTarget(index: number, patch: Partial<BotBroadcastTarget>) {
    onChange(targets.map((target, i) => (i === index ? { ...target, ...patch } : target)));
  }

  function updateTargetPolicy(index: number, policy: BotBroadcastTarget['policy']) {
    updateTarget(index, { policy });
  }

  function removeTarget(index: number) {
    onChange(targets.filter((_, i) => i !== index));
  }

  function addTarget() {
    if (!newTargetId.trim()) return;
    onChange([
      ...targets,
      {
        type: newTargetType,
        receiveId: newTargetId.trim(),
        label: newTargetLabel.trim() || undefined,
      },
    ]);
    setNewTargetId('');
    setNewTargetLabel('');
  }

  return (
    <div className="target-list">
      {targets.map((target, index) => (
        <BroadcastTargetCard
          key={`${target.type}-${target.receiveId}-${index}`}
          target={target}
          globalDefaults={globalDefaults}
          disabled={disabled}
          onPolicyChange={(policy) => updateTargetPolicy(index, policy)}
          onRemove={() => removeTarget(index)}
        />
      ))}

      <div className="input-grid input-grid-4">
        <select
          className="field-input"
          value={newTargetType}
          disabled={disabled}
          onChange={(e) => setNewTargetType(e.target.value as 'chat' | 'user')}
        >
          <option value="chat">群聊</option>
          <option value="user">用户</option>
        </select>
        <input
          className="field-input"
          placeholder="oc_xxx 或 ou_xxx"
          value={newTargetId}
          disabled={disabled}
          onChange={(e) => setNewTargetId(e.target.value)}
        />
        <input
          className="field-input"
          placeholder="备注名（可选）"
          value={newTargetLabel}
          disabled={disabled}
          onChange={(e) => setNewTargetLabel(e.target.value)}
        />
      </div>
      <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={addTarget}>
        添加播报目标
      </Button>
    </div>
  );
}

function BroadcastTargetCard(props: {
  target: BotBroadcastTarget;
  globalDefaults: Pick<BotSettings, 'broadcastOnSuccess' | 'broadcastOnFailure'>;
  disabled?: boolean;
  onPolicyChange: (policy: BotBroadcastTarget['policy']) => void;
  onRemove: () => void;
}) {
  const { target, globalDefaults, disabled, onPolicyChange, onRemove } = props;
  const policy = target.policy;
  const preset = detectTriggerPreset(policy?.triggers);
  const customOutcome = hasCustomOutcomePolicy(policy);

  function setPreset(nextPreset: BroadcastTriggerPreset) {
    const nextTriggers = triggersFromPreset(nextPreset);
    const nextPolicy =
      nextTriggers === undefined
        ? stripTriggersFromPolicy(policy)
        : { ...policy, triggers: nextTriggers };
    onPolicyChange(hasPolicyFields(nextPolicy) ? nextPolicy : undefined);
  }

  function toggleCustomTrigger(trigger: (typeof ALL_SYNC_TRIGGERS)[number], checked: boolean) {
    const current = policy?.triggers ?? [];
    const next = checked ? [...current, trigger] : current.filter((item) => item !== trigger);
    onPolicyChange({
      ...policy,
      triggers: next,
    });
  }

  function setCustomOutcome(enabled: boolean) {
    if (!enabled) {
      const nextPolicy = stripOutcomeFromPolicy(policy);
      onPolicyChange(hasPolicyFields(nextPolicy) ? nextPolicy : undefined);
      return;
    }
    onPolicyChange({
      ...policy,
      onSuccess: policy?.onSuccess ?? globalDefaults.broadcastOnSuccess,
      onFailure: policy?.onFailure ?? globalDefaults.broadcastOnFailure,
    });
  }

  return (
    <div className="broadcast-target-card">
      <div className="target-row">
        <div className="broadcast-target-head">
          <span>
            {target.label ? `${target.label} · ` : ''}
            {target.type === 'chat' ? '群' : '用户'} {target.receiveId}
          </span>
          <span className="broadcast-target-summary">
            {formatBroadcastPolicySummary(target, globalDefaults)}
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRemove}>
          移除
        </Button>
      </div>

      <div className="broadcast-target-policy">
        <Field label="播报范围" hint="按同步触发来源过滤；全局默认仍适用于未单独覆盖的成功/失败规则">
          <select
            className="field-input"
            value={preset}
            disabled={disabled}
            onChange={(e) => setPreset(e.target.value as BroadcastTriggerPreset)}
          >
            {TRIGGER_PRESET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        {TRIGGER_PRESET_OPTIONS.find((option) => option.value === preset)?.hint ? (
          <p className="broadcast-target-hint">
            {TRIGGER_PRESET_OPTIONS.find((option) => option.value === preset)?.hint}
          </p>
        ) : null}

        {preset === 'custom' ? (
          <div className="broadcast-trigger-grid">
            {ALL_SYNC_TRIGGERS.map((trigger) => (
              <label key={trigger} className="broadcast-trigger-option">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={policy?.triggers?.includes(trigger) ?? false}
                  onChange={(e) => toggleCustomTrigger(trigger, e.target.checked)}
                />
                {SYNC_TRIGGER_LABELS[trigger]}
              </label>
            ))}
          </div>
        ) : null}

        <label className="broadcast-custom-outcome">
          <input
            type="checkbox"
            disabled={disabled}
            checked={customOutcome}
            onChange={(e) => setCustomOutcome(e.target.checked)}
          />
          单独设置成功/失败规则（不勾选则继承上方全局开关）
        </label>

        {customOutcome ? (
          <div className="toggle-stack">
            <Toggle
              label="成功时播报"
              checked={policy?.onSuccess ?? globalDefaults.broadcastOnSuccess}
              disabled={disabled}
              onChange={(checked) =>
                onPolicyChange({
                  ...policy,
                  onSuccess: checked,
                })
              }
            />
            <Toggle
              label="失败时播报"
              checked={policy?.onFailure ?? globalDefaults.broadcastOnFailure}
              disabled={disabled}
              onChange={(checked) =>
                onPolicyChange({
                  ...policy,
                  onFailure: checked,
                })
              }
            />
          </div>
        ) : null}

        <Toggle
          label="安静模式"
          description={
            target.type === 'chat'
              ? '全部播报写入 bot 创建的固定话题，不在群会话刷屏（群内需支持话题）'
              : '安静模式仅适用于群聊目标'
          }
          checked={policy?.quietMode ?? false}
          disabled={disabled || target.type !== 'chat'}
          onChange={(checked) =>
            onPolicyChange({
              ...policy,
              quietMode: checked,
            })
          }
        />
      </div>
    </div>
  );
}

function stripTriggersFromPolicy(
  policy: BotBroadcastTarget['policy'],
): BotBroadcastTarget['policy'] {
  if (!policy) return undefined;
  const { triggers: _t, ...rest } = policy;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function stripOutcomeFromPolicy(
  policy: BotBroadcastTarget['policy'],
): BotBroadcastTarget['policy'] {
  if (!policy) return undefined;
  const { onSuccess: _s, onFailure: _f, ...rest } = policy;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function hasPolicyFields(policy: BotBroadcastTarget['policy']): policy is NonNullable<BotBroadcastTarget['policy']> {
  return policy !== undefined && Object.keys(policy).length > 0;
}
