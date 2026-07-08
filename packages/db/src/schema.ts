import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const bindings = sqliteTable('bindings', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sourceType: text('source_type', { enum: ['local', 'cloud'] }).notNull(),
  repoPath: text('repo_path').notNull(),
  remoteUrl: text('remote_url'),
  branch: text('branch').notNull().default('main'),
  syncMode: text('sync_mode', { enum: ['workspace', 'repository'] }).notNull(),
  feishuTargetJson: text('feishu_target_json').notNull(),
  triggersJson: text('triggers_json').notNull(),
  optionsJson: text('options_json').notNull(),
  bindingBroadcastTargetsJson: text('binding_broadcast_targets_json').notNull().default('[]'),
  lastSyncedSha: text('last_synced_sha'),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const nodeMappings = sqliteTable('node_mappings', {
  id: text('id').primaryKey(),
  bindingId: text('binding_id')
    .notNull()
    .references(() => bindings.id, { onDelete: 'cascade' }),
  gitPath: text('git_path').notNull(),
  feishuTargetType: text('feishu_target_type', { enum: ['wiki', 'drive'] }).notNull(),
  feishuNodeToken: text('feishu_node_token').notNull(),
  feishuDocToken: text('feishu_doc_token'),
  feishuNodeType: text('feishu_node_type', { enum: ['folder', 'docx', 'file'] }).notNull(),
  feishuParentToken: text('feishu_parent_token'),
  contentSha: text('content_sha'),
});

export const syncLogs = sqliteTable('sync_logs', {
  id: text('id').primaryKey(),
  bindingId: text('binding_id')
    .notNull()
    .references(() => bindings.id, { onDelete: 'cascade' }),
  trigger: text('trigger', { enum: ['git', 'schedule', 'manual', 'bot'] }).notNull(),
  fromSha: text('from_sha'),
  toSha: text('to_sha'),
  status: text('status', { enum: ['pending', 'running', 'success', 'failed'] }).notNull(),
  message: text('message'),
  progressPhase: text('progress_phase', {
    enum: ['planning', 'structure', 'content', 'cleanup', 'overview', 'done'],
  }),
  progressDone: integer('progress_done'),
  progressTotal: integer('progress_total'),
  currentGitPath: text('current_git_path'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
});

export const commentImportLogs = sqliteTable('comment_import_logs', {
  id: text('id').primaryKey(),
  bindingId: text('binding_id')
    .notNull()
    .references(() => bindings.id, { onDelete: 'cascade' }),
  trigger: text('trigger', { enum: ['schedule', 'manual', 'bot'] }).notNull(),
  status: text('status', { enum: ['pending', 'running', 'success', 'failed'] }).notNull(),
  message: text('message'),
  documentCount: integer('document_count'),
  commentCount: integer('comment_count'),
  replyCount: integer('reply_count'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
});

export const feishuDeletionEvents = sqliteTable('feishu_deletion_events', {
  id: text('id').primaryKey(),
  fileToken: text('file_token').notNull(),
  fileType: text('file_type').notNull(),
  eventType: text('event_type').notNull(),
  bindingId: text('binding_id').references(() => bindings.id, { onDelete: 'cascade' }),
  gitPath: text('git_path'),
  mappingId: text('mapping_id'),
  receivedAt: text('received_at').notNull(),
  processedAt: text('processed_at'),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});
