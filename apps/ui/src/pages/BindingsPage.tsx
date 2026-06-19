import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Binding, FeishuTarget, RepoSourceType, SyncMode } from '@feishu-md/shared';
import { defaultOptionsForMode, DEFAULT_TRIGGERS } from '@feishu-md/shared';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { IconEdit, IconLink, IconPlus, IconSync, IconTrash } from '@/components/icons';
import { LoadingBlock } from '@/components/ui/Spinner';
import { createBinding, deleteBinding, fetchBindings, triggerSync, updateBinding } from '@/lib/queries';

export function BindingsPage() {
  const queryClient = useQueryClient();
  const bindings = useQuery({ queryKey: ['bindings'], queryFn: fetchBindings });
  const [formMode, setFormMode] = useState<'hidden' | 'create' | 'edit'>('hidden');
  const [editingBinding, setEditingBinding] = useState<Binding | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createBinding,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bindings'] });
      closeForm();
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : '创建失败'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<Binding> }) => updateBinding(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bindings'] });
      closeForm();
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : '保存失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteBinding,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['bindings'] }),
  });

  const syncMutation = useMutation({
    mutationFn: ({ id, fullResync }: { id: string; fullResync?: boolean }) => triggerSync(id, fullResync),
    onMutate: ({ id }) => setSyncingId(id),
    onSettled: () => setSyncingId(null),
    onSuccess: (_, { fullResync }) => {
      setSyncNotice(fullResync ? '全量重建任务已加入队列' : '同步任务已加入队列');
      void queryClient.invalidateQueries({ queryKey: ['sync-logs'] });
    },
    onError: (error) => {
      setSyncNotice(error instanceof Error ? error.message : '触发同步失败');
    },
  });

  function closeForm() {
    setFormMode('hidden');
    setEditingBinding(null);
    setFormError(null);
  }

  function openCreateForm() {
    setFormError(null);
    setEditingBinding(null);
    setFormMode((mode) => (mode === 'create' ? 'hidden' : 'create'));
  }

  function openEditForm(binding: Binding) {
    setFormError(null);
    setEditingBinding(binding);
    setFormMode('edit');
  }

  const formSubmitting = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="page-stack-lg">
      <PageHeader
        title="绑定管理"
        description="将 Git 仓库映射到飞书 Wiki 或 Drive，支持工作区模式与仓库模式。"
        action={
          <Button
            variant="primary"
            icon={<IconPlus className="h-4 w-4" />}
            onClick={openCreateForm}
          >
            {formMode === 'create' ? '取消' : '新建绑定'}
          </Button>
        }
      />

      {syncNotice ? (
        <Alert tone="success" title="已提交">
          {syncNotice}
          <button type="button" className="ml-3 text-xs underline opacity-80" onClick={() => setSyncNotice(null)}>
            关闭
          </button>
        </Alert>
      ) : null}

      {formMode !== 'hidden' ? (
        <BindingForm
          mode={formMode}
          initial={editingBinding ?? undefined}
          submitting={formSubmitting}
          error={formError}
          onSubmit={(payload) => {
            if (formMode === 'edit' && editingBinding) {
              updateMutation.mutate({ id: editingBinding.id, payload });
            } else {
              createMutation.mutate(payload);
            }
          }}
          onCancel={closeForm}
        />
      ) : null}

      {bindings.isLoading ? (
        <LoadingBlock label="加载绑定列表…" />
      ) : (bindings.data ?? []).length === 0 ? (
        <EmptyState
          icon={<IconLink className="h-10 w-10" />}
          title="还没有绑定"
          description="创建第一个绑定，将本地或远程 Git 仓库同步到飞书知识库或云空间。"
          action={
            <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setFormMode('create')}>
              新建绑定
            </Button>
          }
        />
      ) : (
        <div className="binding-list">
          {(bindings.data ?? []).map((binding) => (
            <article key={binding.id} className="binding-card">
              <div className="binding-card-layout">
                <div className="binding-card-main">
                  <div className="binding-card-title-row">
                    <h3 className="text-lg font-semibold">{binding.name}</h3>
                    <Badge tone="blue">{binding.sourceType === 'cloud' ? '有云仓库' : '本地仓库'}</Badge>
                    <Badge tone="green">
                      {binding.syncMode === 'workspace' ? '工作区模式' : '仓库模式'}
                    </Badge>
                    <Badge>{binding.feishuTarget.type === 'wiki' ? 'Wiki' : 'Drive'}</Badge>
                  </div>
                  <div className="binding-path">{binding.repoPath}</div>
                  <div className="binding-meta">
                    分支 {binding.branch}
                    {binding.feishuTarget.type === 'wiki'
                      ? ` · Wiki space_id ${binding.feishuTarget.wikiSpaceId || '（未填）'}`
                      : ` · Drive folder ${binding.feishuTarget.driveRootFolderToken?.slice(0, 12) || '（未填）'}…`}
                    {binding.lastSyncedSha
                      ? ` · 最近同步 ${binding.lastSyncedSha.slice(0, 7)}`
                      : ' · 尚未同步'}
                    {binding.lastSyncedAt ? ` · ${new Date(binding.lastSyncedAt).toLocaleString()}` : ''}
                  </div>
                </div>

                <div className="action-bar">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<IconEdit className="h-4 w-4" />}
                    onClick={() => openEditForm(binding)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<IconSync className="h-4 w-4" />}
                    disabled={syncMutation.isPending && syncingId === binding.id}
                    onClick={() => syncMutation.mutate({ id: binding.id })}
                  >
                    {syncingId === binding.id ? '提交中…' : '立即同步'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={syncMutation.isPending && syncingId === binding.id}
                    onClick={() => syncMutation.mutate({ id: binding.id, fullResync: true })}
                  >
                    全量重建
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<IconTrash className="h-4 w-4" />}
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`确定删除绑定「${binding.name}」？`)) {
                        if (editingBinding?.id === binding.id) closeForm();
                        deleteMutation.mutate(binding.id);
                      }
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function BindingForm(props: {
  mode: 'create' | 'edit';
  initial?: Binding;
  submitting: boolean;
  error?: string | null;
  onSubmit: (binding: Partial<Binding>) => void;
  onCancel: () => void;
}) {
  const isEdit = props.mode === 'edit';

  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<RepoSourceType>('local');
  const [repoPath, setRepoPath] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [syncMode, setSyncMode] = useState<SyncMode>('workspace');
  const [targetType, setTargetType] = useState<FeishuTarget['type']>('wiki');
  const [wikiSpaceId, setWikiSpaceId] = useState('');
  const [driveRootFolderToken, setDriveRootFolderToken] = useState('');

  useEffect(() => {
    const binding = props.initial;
    if (binding) {
      setName(binding.name);
      setSourceType(binding.sourceType);
      setRepoPath(binding.repoPath);
      setRemoteUrl(binding.remoteUrl ?? '');
      setBranch(binding.branch);
      setSyncMode(binding.syncMode);
      setTargetType(binding.feishuTarget.type);
      setWikiSpaceId(binding.feishuTarget.wikiSpaceId ?? '');
      setDriveRootFolderToken(binding.feishuTarget.driveRootFolderToken ?? '');
    } else {
      setName('');
      setSourceType('local');
      setRepoPath('');
      setRemoteUrl('');
      setBranch('main');
      setSyncMode('workspace');
      setTargetType('wiki');
      setWikiSpaceId('');
      setDriveRootFolderToken('');
    }
  }, [props.initial, props.mode]);

  function buildFeishuTarget(): FeishuTarget {
    if (targetType === 'wiki') {
      return { type: 'wiki', wikiSpaceId: wikiSpaceId.trim() };
    }
    return { type: 'drive', driveRootFolderToken: driveRootFolderToken.trim() };
  }

  return (
    <Card>
      <CardHeader
        title={isEdit ? `编辑绑定${props.initial ? `：${props.initial.name}` : ''}` : '新建绑定'}
        description={
          isEdit
            ? '修改配置后保存即可；变更 Git 路径或飞书目标后，建议执行一次全量重建。'
            : '填写 Git 来源与飞书同步目标，创建后可立即触发同步。'
        }
      />
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const feishuTarget = buildFeishuTarget();
          const syncModeChanged = isEdit && props.initial && props.initial.syncMode !== syncMode;

          props.onSubmit({
            name: name.trim(),
            sourceType,
            repoPath: repoPath.trim(),
            remoteUrl: sourceType === 'cloud' ? remoteUrl.trim() : undefined,
            branch: branch.trim() || 'main',
            syncMode,
            feishuTarget,
            triggers: isEdit && props.initial ? props.initial.triggers : { ...DEFAULT_TRIGGERS },
            options:
              isEdit && props.initial && !syncModeChanged
                ? props.initial.options
                : defaultOptionsForMode(syncMode),
          });
        }}
      >
        {props.error ? (
          <div className="form-grid-span-2">
            <Alert tone="danger">{props.error}</Alert>
          </div>
        ) : null}

        <Field label="名称" hint="用于在面板与飞书指令中识别">
          <input
            className="field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：产品文档仓"
            required
          />
        </Field>
        <Field label="Git 来源">
          <select
            className="field-input"
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as RepoSourceType)}
          >
            <option value="local">无云仓库（本地 + post-commit hook）</option>
            <option value="cloud">有云仓库（本机 clone + fetch）</option>
          </select>
        </Field>
        <Field label="本机仓库路径" className="form-grid-span-2" hint="本机 Git 仓库的绝对路径">
          <input
            className="field-input"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="D:\Projects\acme-handbook"
            required
          />
        </Field>
        {sourceType === 'cloud' ? (
          <Field label="远程 URL" className="form-grid-span-2" hint="HTTPS 或 SSH 地址均可">
            <input
              className="field-input"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/acme-corp/handbook.git"
            />
          </Field>
        ) : null}
        <Field label="分支">
          <input
            className="field-input"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
          />
        </Field>
        <Field label="同步模式">
          <select
            className="field-input"
            value={syncMode}
            onChange={(e) => setSyncMode(e.target.value as SyncMode)}
          >
            <option value="workspace">工作区模式（目录树 1:1）</option>
            <option value="repository">仓库模式（目录 = 文档，README 为正文）</option>
          </select>
        </Field>
        <Field label="飞书目标类型">
          <select
            className="field-input"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as FeishuTarget['type'])}
          >
            <option value="wiki">知识库 Wiki</option>
            <option value="drive">云空间 Drive</option>
          </select>
        </Field>
        {targetType === 'wiki' ? (
          <Field
            label="Wiki space_id"
            hint="知识库唯一 ID，通常为 19 位数字。打开知识库后，URL 中 /wiki/ 后面的那一段即为 space_id。"
          >
            <input
              className="field-input"
              value={wikiSpaceId}
              onChange={(e) => setWikiSpaceId(e.target.value)}
              placeholder="7123456789012345678"
              required
            />
          </Field>
        ) : (
          <Field
            label="Drive 根 folder_token"
            hint="云空间文件夹 token，一般以 fld 开头。在目标文件夹「复制链接」或调用 Drive API 获取。"
          >
            <input
              className="field-input"
              value={driveRootFolderToken}
              onChange={(e) => setDriveRootFolderToken(e.target.value)}
              placeholder="fldcnExampleRootFolder01"
              required
            />
          </Field>
        )}

        <div className="action-bar form-grid-span-2">
          <Button type="submit" variant="primary" disabled={props.submitting}>
            {props.submitting ? '保存中…' : isEdit ? '保存修改' : '创建绑定'}
          </Button>
          <Button type="button" variant="ghost" onClick={props.onCancel}>
            取消
          </Button>
        </div>
      </form>
    </Card>
  );
}
