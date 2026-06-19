import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { FeishuUserPermission, FeishuUserRole } from '@feishu-md/shared';
import { FEISHU_ROLE_DESCRIPTIONS, FEISHU_USER_ROLE_LABELS } from '@feishu-md/shared';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import type { Binding } from '@feishu-md/shared';
import { saveFeishuUserPermissions } from '@/lib/queries';

const ROLES: FeishuUserRole[] = ['admin', 'manager', 'member', 'blacklist'];

export function UserPermissionsCard(props: {
  initial: FeishuUserPermission[];
  bindings: Binding[];
}) {
  const queryClient = useQueryClient();
  const [permissions, setPermissions] = useState<FeishuUserPermission[]>(props.initial);
  const [draftOpenId, setDraftOpenId] = useState('');
  const [draftRole, setDraftRole] = useState<FeishuUserRole>('member');
  const [draftLabel, setDraftLabel] = useState('');
  const [draftBindingIds, setDraftBindingIds] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setPermissions(props.initial);
  }, [props.initial]);

  const saveMutation = useMutation({
    mutationFn: saveFeishuUserPermissions,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  function toggleDraftBinding(id: string) {
    setDraftBindingIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function toggleExistingBinding(index: number, id: string) {
    setPermissions((prev) =>
      prev.map((item, i) => {
        if (i !== index || item.role !== 'manager') return item;
        const ids = new Set(item.bindingIds ?? []);
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        return { ...item, bindingIds: [...ids] };
      }),
    );
  }

  function addUser() {
    setFormError(null);
    const openId = draftOpenId.trim();
    if (!openId) {
      setFormError('请填写 open_id');
      return;
    }
    if (permissions.some((item) => item.openId === openId)) {
      setFormError('该 open_id 已在名单中');
      return;
    }
    if (draftRole === 'manager' && draftBindingIds.length === 0) {
      setFormError('管理者至少选择一个绑定');
      return;
    }

    const entry: FeishuUserPermission = {
      openId,
      role: draftRole,
      label: draftLabel.trim() || undefined,
      bindingIds: draftRole === 'manager' ? [...draftBindingIds] : undefined,
    };
    setPermissions((prev) => [...prev, entry]);
    setDraftOpenId('');
    setDraftLabel('');
    setDraftBindingIds([]);
    setDraftRole('member');
  }

  function removeUser(index: number) {
    setPermissions((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <Card>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          for (const item of permissions) {
            if (item.role === 'manager' && (!item.bindingIds || item.bindingIds.length === 0)) {
              setFormError(`「${item.label ?? item.openId}」为管理者，须至少指定一个绑定`);
              return;
            }
          }
          setFormError(null);
          saveMutation.mutate(permissions);
        }}
      >
        <CardHeader
          title="飞书用户权限"
          description="群聊指令仅依据用户权限级别判定。未出现在名单中的用户属于默认组（不记录、不可使用指令）。"
        />

        <div className="help-box">
          <div className="page-stack-sm">
            {(Object.keys(FEISHU_ROLE_DESCRIPTIONS) as Array<keyof typeof FEISHU_ROLE_DESCRIPTIONS>).map(
              (key) => (
                <div key={key}>
                  <strong>{key === 'default' ? '默认组' : FEISHU_USER_ROLE_LABELS[key as FeishuUserRole]}：</strong>
                  {FEISHU_ROLE_DESCRIPTIONS[key]}
                </div>
              ),
            )}
          </div>
        </div>

        {permissions.length === 0 ? (
          <Alert tone="warning" title="尚未配置任何用户">
            请至少添加一名管理员（open_id），否则除旧版白名单外，普通用户无法使用机器人指令。
          </Alert>
        ) : (
          <div className="target-list">
            {permissions.map((item, index) => (
              <div key={item.openId} className="permission-row">
                <div className="permission-row-main">
                  <div className="binding-card-title-row">
                    <span className="font-medium">{item.label ?? item.openId}</span>
                    <Badge tone={roleBadgeTone(item.role)}>{FEISHU_USER_ROLE_LABELS[item.role]}</Badge>
                  </div>
                  <div className="text-xs text-muted font-mono mt-1">{item.openId}</div>
                  {item.role === 'manager' ? (
                    <div className="manager-binding-picks">
                      <span className="text-xs text-muted">可操作绑定：</span>
                      <div className="binding-checkbox-grid">
                        {props.bindings.map((binding) => (
                          <label key={binding.id} className="binding-checkbox">
                            <input
                              type="checkbox"
                              checked={(item.bindingIds ?? []).includes(binding.id)}
                              onChange={() => toggleExistingBinding(index, binding.id)}
                            />
                            {binding.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => removeUser(index)}>
                  移除
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="section-divider section-block">
          <h3 className="text-sm font-semibold">添加用户</h3>
          <Field label="open_id" hint="飞书用户 open_id，形如 ou_xxxxxxxx">
            <input
              className="field-input font-mono"
              value={draftOpenId}
              onChange={(e) => setDraftOpenId(e.target.value)}
              placeholder="ou_exampleUserOpenId01"
            />
          </Field>
          <Field label="备注名（可选）">
            <input
              className="field-input"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder="例如：运维负责人"
            />
          </Field>
          <Field label="权限级别">
            <select
              className="field-input"
              value={draftRole}
              onChange={(e) => setDraftRole(e.target.value as FeishuUserRole)}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {FEISHU_USER_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </Field>
          {draftRole === 'manager' ? (
            <Field label="指定绑定" hint="管理者只能操作以下绑定">
              <div className="binding-checkbox-grid">
                {props.bindings.map((binding) => (
                  <label key={binding.id} className="binding-checkbox">
                    <input
                      type="checkbox"
                      checked={draftBindingIds.includes(binding.id)}
                      onChange={() => toggleDraftBinding(binding.id)}
                    />
                    {binding.name}
                    <span className="text-muted text-xs">
                      （{binding.sourceType === 'cloud' ? '有云' : '本地'}）
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          ) : null}
          <Button type="button" variant="secondary" size="sm" onClick={addUser}>
            加入名单
          </Button>
        </div>

        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        {saveMutation.isError ? (
          <Alert tone="danger">
            {saveMutation.error instanceof Error ? saveMutation.error.message : '保存失败'}
          </Alert>
        ) : null}
        {saveMutation.isSuccess ? <Alert tone="success">用户权限已保存。</Alert> : null}

        <Button type="submit" variant="primary" disabled={saveMutation.isPending}>
          {saveMutation.isPending ? '保存中…' : '保存用户权限'}
        </Button>
      </form>
    </Card>
  );
}

function roleBadgeTone(role: FeishuUserRole): 'blue' | 'green' | 'amber' | 'red' | 'default' {
  switch (role) {
    case 'admin':
      return 'blue';
    case 'manager':
      return 'green';
    case 'member':
      return 'amber';
    case 'blacklist':
      return 'red';
    default:
      return 'default';
  }
}
