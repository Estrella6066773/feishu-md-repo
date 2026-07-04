import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  Binding,
  BotBroadcastTarget,
  FeishuTarget,
  ForceUpdateMode,
  RepoSourceType,
  SyncLogEntry,
  SyncMode,
} from '@feishu-md/shared';
import { BroadcastTargetEditor } from '@/components/BroadcastTargetEditor';
import { defaultOptionsForMode, defaultTriggersForSourceType, DEFAULT_BOT_SETTINGS, DEFAULT_SCHEDULE_MINUTES } from '@feishu-md/shared';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { IconEdit, IconLink, IconPlus, IconSync, IconTrash } from '@/components/icons';
import { LoadingBlock } from '@/components/ui/Spinner';
import {
  createBinding,
  deleteBinding,
  fetchBindings,
  fetchSettings,
  fetchSyncLogs,
  triggerSyncAndWait,
  triggerCommentImportAndWait,
  updateBinding,
} from '@/lib/queries';

export function BindingsPage() {
  const queryClient = useQueryClient();
  const bindings = useQuery({ queryKey: ['bindings'], queryFn: fetchBindings });
  const syncLogs = useQuery({
    queryKey: ['sync-logs'],
    queryFn: () => fetchSyncLogs(),
    refetchInterval: 10_000,
  });
  const latestLogByBinding = new Map<string, SyncLogEntry>();
  for (const log of syncLogs.data ?? []) {
    if (!latestLogByBinding.has(log.bindingId)) {
      latestLogByBinding.set(log.bindingId, log);
    }
  }
  const [formMode, setFormMode] = useState<'hidden' | 'create' | 'edit'>('hidden');
  const [editingBinding, setEditingBinding] = useState<Binding | null>(null);
  const [syncNotice, setSyncNotice] = useState<{
    tone: 'success' | 'danger' | 'warning';
    title: string;
    message: string;
  } | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [importingCommentsId, setImportingCommentsId] = useState<string | null>(null);
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
    mutationFn: ({ id, fullResync }: { id: string; fullResync?: boolean }) =>
      triggerSyncAndWait(id, fullResync ?? false),
    onMutate: ({ id }) => setSyncingId(id),
    onSettled: () => setSyncingId(null),
    onSuccess: (log, { fullResync }) => {
      if (log.status === 'failed') {
        setSyncNotice({
          tone: 'danger',
          title: '同步失败',
          message: log.message ?? '未知错误，请查看同步日志',
        });
      } else if (log.message?.includes('无内容变更')) {
        setSyncNotice({
          tone: 'warning',
          title: '同步完成',
          message: log.message,
        });
      } else {
        setSyncNotice({
          tone: 'success',
          title: fullResync ? '全库重建成功' : '同步成功',
          message: log.message ?? '已完成',
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['sync-logs'] });
      void queryClient.invalidateQueries({ queryKey: ['bindings'] });
    },
    onError: (error) => {
      setSyncNotice({
        tone: 'danger',
        title: '同步失败',
        message: error instanceof Error ? error.message : '触发同步失败',
      });
    },
  });

  const commentImportMutation = useMutation({
    mutationFn: (id: string) => triggerCommentImportAndWait(id),
    onMutate: (id) => setImportingCommentsId(id),
    onSettled: () => setImportingCommentsId(null),
    onSuccess: (log) => {
      if (log.status === 'failed') {
        setSyncNotice({
          tone: 'danger',
          title: '评论导入失败',
          message: log.message ?? '未知错误',
        });
      } else {
        setSyncNotice({
          tone: 'success',
          title: '评论导入成功',
          message: log.message ?? '已完成',
        });
      }
    },
    onError: (error) => {
      setSyncNotice({
        tone: 'danger',
        title: '评论导入失败',
        message: error instanceof Error ? error.message : '触发评论导入失败',
      });
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
        <Alert tone={syncNotice.tone} title={syncNotice.title}>
          {syncNotice.message}
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
          {(bindings.data ?? []).map((binding) => {
            const latestLog = latestLogByBinding.get(binding.id);
            const syncStatusTone =
              latestLog?.status === 'failed'
                ? 'red'
                : latestLog?.status === 'success'
                  ? 'green'
                  : latestLog?.status === 'running' || latestLog?.status === 'pending'
                    ? 'amber'
                    : undefined;

            return (
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
                    {latestLog && syncStatusTone ? (
                      <Badge tone={syncStatusTone}>
                        {latestLog.status === 'failed'
                          ? '最近失败'
                          : latestLog.status === 'success'
                            ? '最近成功'
                            : '同步中'}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="binding-path">{binding.repoPath}</div>
                  <div className="binding-meta">
                    分支 {binding.branch}
                    {binding.triggers.scheduleEnabled
                      ? ` · 每 ${binding.triggers.scheduleMinutes} 分钟检查${binding.triggers.commentImportOnSchedule ? '（含评论导入）' : ''}`
                      : binding.sourceType === 'local'
                        ? ' · 提交时同步'
                        : ' · 未启用定时检查'}
                    {binding.feishuTarget.type === 'wiki'
                      ? ` · Wiki ${binding.feishuTarget.wikiSpaceId?.slice(0, 8) || '（自动解析）'}…${binding.feishuTarget.wikiRootNodeToken ? ` · 父 ${binding.feishuTarget.wikiRootNodeToken.slice(0, 8)}…` : ''}`
                      : ` · 云空间 ${binding.feishuTarget.driveRootFolderToken?.slice(0, 12) || '（未填）'}…`}
                    {binding.lastSyncedSha
                      ? ` · 最近同步 ${binding.lastSyncedSha.slice(0, 7)}`
                      : ' · 尚未同步'}
                    {binding.lastSyncedAt ? ` · ${new Date(binding.lastSyncedAt).toLocaleString()}` : ''}
                  </div>
                  {latestLog?.status === 'failed' && latestLog.message ? (
                    <div className="mt-2 text-sm text-[var(--color-danger)]">{latestLog.message}</div>
                  ) : null}
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
                    {syncingId === binding.id ? '同步中…' : '立即同步'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      (commentImportMutation.isPending && importingCommentsId === binding.id)
                      || (syncMutation.isPending && syncingId === binding.id)
                    }
                    onClick={() => commentImportMutation.mutate(binding.id)}
                  >
                    {importingCommentsId === binding.id ? '导入中…' : '导入评论'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={syncMutation.isPending && syncingId === binding.id}
                    onClick={() => syncMutation.mutate({ id: binding.id, fullResync: true })}
                  >
                    {syncingId === binding.id ? '重建中…' : '全库重建'}
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
            );
          })}
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
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const globalBroadcastDefaults = settings.data?.bot ?? DEFAULT_BOT_SETTINGS;

  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<RepoSourceType>('local');
  const [repoPath, setRepoPath] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [syncMode, setSyncMode] = useState<SyncMode>('workspace');
  const [targetType, setTargetType] = useState<FeishuTarget['type']>('wiki');
  const [wikiSpaceId, setWikiSpaceId] = useState('');
  const [wikiRootNodeToken, setWikiRootNodeToken] = useState('');
  const [driveRootFolderToken, setDriveRootFolderToken] = useState('');
  const [ignoreGlobsText, setIgnoreGlobsText] = useState('');
  const [forceUpdateGlobsText, setForceUpdateGlobsText] = useState('');
  const [forceUpdateMode, setForceUpdateMode] = useState<ForceUpdateMode>('all');
  const [bindingTargets, setBindingTargets] = useState<BotBroadcastTarget[]>([]);
  const [hasExplicitBindingTargets, setHasExplicitBindingTargets] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleMinutes, setScheduleMinutes] = useState(DEFAULT_SCHEDULE_MINUTES);
  const [commentImportOnSchedule, setCommentImportOnSchedule] = useState(false);

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
      setWikiRootNodeToken(binding.feishuTarget.wikiRootNodeToken ?? '');
      setDriveRootFolderToken(binding.feishuTarget.driveRootFolderToken ?? '');
      setIgnoreGlobsText(binding.options.ignoreGlobs.join('\n'));
      setForceUpdateGlobsText((binding.options.forceUpdateGlobs ?? []).join('\n'));
      setForceUpdateMode(binding.options.forceUpdateMode ?? 'all');
      const explicitTargets = binding.bindingSpecificBroadcastTargets;
      setHasExplicitBindingTargets(explicitTargets !== undefined);
      setBindingTargets(explicitTargets ?? []);
      setScheduleEnabled(binding.triggers.scheduleEnabled);
      setScheduleMinutes(binding.triggers.scheduleMinutes);
      setCommentImportOnSchedule(binding.triggers.commentImportOnSchedule ?? binding.triggers.scheduleEnabled);
    } else {
      setName('');
      setSourceType('local');
      setRepoPath('');
      setRemoteUrl('');
      setBranch('main');
      setSyncMode('workspace');
      setTargetType('wiki');
      setWikiSpaceId('');
      setWikiRootNodeToken('');
      setDriveRootFolderToken('');
      setIgnoreGlobsText(defaultOptionsForMode('workspace').ignoreGlobs.join('\n'));
      setForceUpdateGlobsText((defaultOptionsForMode('workspace').forceUpdateGlobs ?? []).join('\n'));
      setForceUpdateMode(defaultOptionsForMode('workspace').forceUpdateMode ?? 'all');
      setHasExplicitBindingTargets(false);
      setBindingTargets([]);
      const defaults = defaultTriggersForSourceType('local');
      setScheduleEnabled(defaults.scheduleEnabled);
      setScheduleMinutes(defaults.scheduleMinutes);
      setCommentImportOnSchedule(defaults.scheduleEnabled);
    }
  }, [props.initial, props.mode]);

  useEffect(() => {
    if (props.initial && props.initial.syncMode !== syncMode) {
      setIgnoreGlobsText(defaultOptionsForMode(syncMode).ignoreGlobs.join('\n'));
      setForceUpdateGlobsText((defaultOptionsForMode(syncMode).forceUpdateGlobs ?? []).join('\n'));
      setForceUpdateMode(defaultOptionsForMode(syncMode).forceUpdateMode ?? 'all');
    }
  }, [syncMode, props.initial]);

  function buildBindingTriggers() {
    const defaults = defaultTriggersForSourceType(sourceType);
    const keepExistingCommitHook =
      isEdit && props.initial && props.initial.sourceType === sourceType;
    return {
      onGitCommit: keepExistingCommitHook ? props.initial!.triggers.onGitCommit : defaults.onGitCommit,
      scheduleEnabled,
      scheduleMinutes: Math.max(1, Math.round(Number(scheduleMinutes) || DEFAULT_SCHEDULE_MINUTES)),
      commentImportOnSchedule: scheduleEnabled ? commentImportOnSchedule : false,
    };
  }

  function buildBindingOptions() {
    const customGlobs = ignoreGlobsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const forceUpdateGlobs = forceUpdateGlobsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const base =
      isEdit && props.initial && props.initial.syncMode === syncMode
        ? props.initial.options
        : defaultOptionsForMode(syncMode);
    return { ...base, ignoreGlobs: customGlobs, forceUpdateGlobs, forceUpdateMode };
  }

  useEffect(() => {
    if (syncMode === 'repository' && targetType === 'drive') {
      setTargetType('wiki');
    }
  }, [syncMode]);

  function buildFeishuTarget(): FeishuTarget {
    if (targetType === 'wiki') {
      const root = wikiRootNodeToken.trim();
      return {
        type: 'wiki',
        wikiSpaceId: wikiSpaceId.trim(),
        wikiRootNodeToken: root || undefined,
      };
    }
    return { type: 'drive', driveRootFolderToken: driveRootFolderToken.trim() };
  }

  return (
    <Card>
      <CardHeader
        title={isEdit ? `编辑绑定${props.initial ? `：${props.initial.name}` : ''}` : '新建绑定'}
        description={
          isEdit
            ? '修改配置后保存即可；变更 Git 路径或飞书目标后，建议执行一次全库重建。'
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
            triggers: buildBindingTriggers(),
            options: syncModeChanged ? defaultOptionsForMode(syncMode) : buildBindingOptions(),
            bindingSpecificBroadcastTargets: hasExplicitBindingTargets ? bindingTargets : undefined,
          });
        }}
      >
        {props.error ? (
          <div className="form-grid-span-2">
            <Alert tone="danger">{props.error}</Alert>
          </div>
        ) : null}

        <Field
          label="名称"
          hint={
            syncMode === 'repository'
              ? '用于面板识别；仓库模式下亦作为根目录 README 对应飞书文档的标题（如「项目 A」）'
              : '用于在面板与飞书指令中识别'
          }
        >
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
            onChange={(e) => {
              const next = e.target.value as RepoSourceType;
              if (next !== sourceType) {
                const defaults = defaultTriggersForSourceType(next);
                setScheduleEnabled(defaults.scheduleEnabled);
                setCommentImportOnSchedule(defaults.scheduleEnabled);
                if (!isEdit) {
                  setScheduleMinutes(defaults.scheduleMinutes);
                }
              }
              setSourceType(next);
            }}
          >
            <option value="local">无云仓库（本地提交 hook 触发）</option>
            <option value="cloud">有云仓库（定时 fetch 远程）</option>
          </select>
        </Field>

        <Field
          label="定时检查"
          hint={
            sourceType === 'cloud'
              ? '有云仓库默认开启；按设定间隔 fetch 远程并检查是否有更新。'
              : '可选。本地仓库除提交 hook 外，也可按间隔主动检查并同步。'
          }
        >
          <label className="flex items-center gap-2 text-sm text-fg-primary mb-2">
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled(e.target.checked)}
            />
            启用定时检查
          </label>
          <div className="flex items-center gap-2">
            <input
              className="field-input w-24"
              type="number"
              min={1}
              max={1440}
              step={1}
              value={scheduleMinutes}
              disabled={!scheduleEnabled}
              onChange={(e) => setScheduleMinutes(Number(e.target.value))}
            />
            <span className="text-sm text-fg-secondary">分钟（默认 {DEFAULT_SCHEDULE_MINUTES} 分钟）</span>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-primary">
            <input
              type="checkbox"
              checked={commentImportOnSchedule}
              disabled={!scheduleEnabled}
              onChange={(e) => setCommentImportOnSchedule(e.target.checked)}
            />
            定时检查时同时从飞书导入文档评论到 `.feishu/comments/`
          </label>
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
            <option value="repository">仓库模式（每目录 README → 文档，标题为目录名）</option>
          </select>
        </Field>
        <Field label="飞书目标类型">
          <select
            className="field-input"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as FeishuTarget['type'])}
          >
            <option value="wiki">知识库 Wiki（文档可作父节点）</option>
            <option value="drive" disabled={syncMode === 'repository'}>
              云空间 Drive（仅工作区，须 folder_token）
            </option>
          </select>
        </Field>
        {syncMode === 'repository' ? (
          <div className="form-grid-span-2">
            <Alert tone="info">
              仓库模式将各目录 README 同步为飞书文档，子文档挂在父文档下。父文档可填知识库 node_token，也可填云文档
              docx 链接中的 document_id（如 Dunxd…）；后者须该文档已加入知识库，系统会自动解析 space_id。
            </Alert>
          </div>
        ) : null}
        {targetType === 'wiki' ? (
          <>
            <Field
              label="Wiki space_id"
              hint="知识库 ID。若只填下方父文档 token（含云文档 docx 链接），可留空由同步时自动解析。"
            >
              <input
                className="field-input"
                value={wikiSpaceId}
                onChange={(e) => setWikiSpaceId(e.target.value)}
                placeholder="7123456789012345678"
                required={syncMode !== 'repository' || !wikiRootNodeToken.trim()}
              />
            </Field>
            <Field
              label="父文档 token（可选）"
              hint={
                syncMode === 'repository'
                  ? '根 README 写入此文档；子目录文档挂在其下。支持 wiki node_token 或云空间 docx 的 document_id。'
                  : '可选。留空则挂在知识库根层级。'
              }
            >
              <input
                className="field-input"
                value={wikiRootNodeToken}
                onChange={(e) => setWikiRootNodeToken(e.target.value)}
                placeholder="DunxdXC8Io8g0VxrE5JczBdXn7d"
              />
            </Field>
          </>
        ) : (
          <Field
            label="Drive 根 folder_token"
            className="form-grid-span-2"
            hint="须为云空间文件夹 token（一般以 fld 开头）。文档 token 不能用于 Drive 目标。"
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

        <Field
          label="项目忽略规则"
          className="form-grid-span-2"
          hint="Git 规则筛选后的二重屏蔽，每行一条 glob（如 **/dist/**）。默认始终额外排除 node_modules 与 .git。"
        >
          <textarea
            className="field-input"
            rows={4}
            value={ignoreGlobsText}
            onChange={(e) => setIgnoreGlobsText(e.target.value)}
            placeholder={'**/dist/**\n**/.env*'}
          />
        </Field>

        <Field
          label="强追踪文件"
          className="form-grid-span-2"
          hint="每行一条 glob。匹配到的 Markdown 文档会按下方更新方式强制重写，即使内容哈希未变化。"
        >
          <textarea
            className="field-input"
            rows={3}
            value={forceUpdateGlobsText}
            onChange={(e) => setForceUpdateGlobsText(e.target.value)}
            placeholder={'docs/always-sync.md\n**/status.md'}
          />
        </Field>

        <Field
          label="强追踪更新方式"
          className="form-grid-span-2"
          hint="手动更新指页面手动同步；自动更新包含 Git 提交、定时检查与机器人指令。"
        >
          <select
            className="field-input"
            value={forceUpdateMode}
            onChange={(e) => setForceUpdateMode(e.target.value as ForceUpdateMode)}
          >
            <option value="manual">手动更新</option>
            <option value="automatic">自动更新</option>
            <option value="all">都有效</option>
          </select>
        </Field>

        <div className="form-grid-span-2">
          <label className="flex items-center gap-2 text-sm font-medium text-fg-primary">
            <input
              type="checkbox"
              checked={hasExplicitBindingTargets}
              onChange={(e) => setHasExplicitBindingTargets(e.target.checked)}
            />
            为该绑定单独指定机器人播报目标
          </label>
          <p className="text-xs text-fg-tertiary mt-1">
            勾选后仅发送到下方目标；不勾选则使用设置页里的全局播报目标。空数组表示“本绑定不播报”。
          </p>
        </div>

        {hasExplicitBindingTargets ? (
          <div className="form-grid-span-2">
            <BroadcastTargetEditor
              targets={bindingTargets}
              globalDefaults={{
                broadcastOnSuccess: globalBroadcastDefaults.broadcastOnSuccess,
                broadcastOnFailure: globalBroadcastDefaults.broadcastOnFailure,
              }}
              onChange={setBindingTargets}
            />
            {bindingTargets.length === 0 ? (
              <p className="text-sm text-fg-tertiary mt-2">当前未配置目标，该绑定不会收到机器人播报。</p>
            ) : null}
          </div>
        ) : null}

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
