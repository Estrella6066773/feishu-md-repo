import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeishuCommentRecord } from './comment-service.js';

export const FEISHU_COMMENTS_ROOT_DIR = '.feishu/comments';
export const FEISHU_COMMENTS_DOCS_SUBDIR = 'docs';
export const FEISHU_COMMENT_EXPORT_SCHEMA_VERSION = 1;

export interface FeishuDocCommentExport {
  schemaVersion: typeof FEISHU_COMMENT_EXPORT_SCHEMA_VERSION;
  bindingId: string;
  bindingName: string;
  gitPath: string;
  feishuDocToken: string;
  feishuNodeToken: string;
  documentTitle?: string;
  documentUrl: string;
  /** 本文件评论内容最近写入仓库的时间 */
  updatedAt: string;
  /** @deprecated 旧版字段，读取时兼容 */
  importedAt?: string;
  trigger: string;
  source: {
    listApi: 'drive.v1.fileComment.list';
    replyApi: 'drive.v1.fileCommentReply.list';
    fileType: 'docx';
    needReaction: true;
    userIdType: 'open_id';
  };
  commentCount: number;
  replyCount: number;
  comments: FeishuCommentRecord[];
}

export interface FeishuCommentImportManifest {
  schemaVersion: typeof FEISHU_COMMENT_EXPORT_SCHEMA_VERSION;
  bindingId: string;
  bindingName: string;
  /** 评论导出目录最近发生写入的时间 */
  updatedAt: string;
  /** @deprecated 旧版字段，读取时兼容 */
  importedAt?: string;
  trigger: string;
  documentCount: number;
  commentCount: number;
  replyCount: number;
  documents: Array<{
    gitPath: string;
    storageFile: string;
    feishuDocToken: string;
    feishuNodeToken: string;
    documentTitle?: string;
    documentUrl: string;
    commentCount: number;
    replyCount: number;
    updatedAt?: string;
  }>;
}

export function commentStorageFileName(gitPath: string): string {
  const normalized = gitPath.replace(/\\/g, '/').trim();
  if (!normalized) return '_root.comments.json';
  return `${normalized.replace(/\//g, '__')}.comments.json`;
}

export function commentDocsDirectory(repoPath: string): string {
  return join(repoPath, FEISHU_COMMENTS_ROOT_DIR, FEISHU_COMMENTS_DOCS_SUBDIR);
}

export function commentManifestPath(repoPath: string): string {
  return join(repoPath, FEISHU_COMMENTS_ROOT_DIR, 'manifest.json');
}

export function countCommentReplies(comments: FeishuCommentRecord[]): number {
  return comments.reduce((sum, comment) => sum + comment.replies.length, 0);
}

/** 评论正文指纹，用于判断飞书侧评论是否与本地导出一致（不含 update_time、表情等元数据） */
export function fingerprintDocumentComments(comments: FeishuCommentRecord[]): string {
  const normalized = normalizeCommentsForFingerprint(comments);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function normalizeCommentsForFingerprint(comments: FeishuCommentRecord[]): unknown[] {
  return [...comments]
    .sort((a, b) => a.comment_id.localeCompare(b.comment_id))
    .map((comment) => ({
      comment_id: comment.comment_id,
      is_whole: comment.is_whole ?? false,
      quote: comment.quote ?? '',
      replies: [...comment.replies]
        .sort((a, b) => (a.reply_id ?? '').localeCompare(b.reply_id ?? ''))
        .map((reply) => ({
          reply_id: reply.reply_id ?? '',
          content: reply.content ?? { elements: [] },
          extra: reply.extra,
        })),
    }));
}

export function isDocumentCommentExportUnchanged(
  existing: FeishuDocCommentExport,
  comments: FeishuCommentRecord[],
): boolean {
  return fingerprintDocumentComments(existing.comments) === fingerprintDocumentComments(comments);
}

export async function readDocCommentExport(
  repoPath: string,
  gitPath: string,
): Promise<FeishuDocCommentExport | null> {
  try {
    const raw = await readFile(docCommentExportPath(repoPath, gitPath), 'utf-8');
    return JSON.parse(raw) as FeishuDocCommentExport;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readCommentImportManifest(
  repoPath: string,
): Promise<FeishuCommentImportManifest | null> {
  try {
    const raw = await readFile(commentManifestPath(repoPath), 'utf-8');
    return JSON.parse(raw) as FeishuCommentImportManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeDocCommentExport(
  repoPath: string,
  payload: FeishuDocCommentExport,
): Promise<{ storageFile: string; written: boolean }> {
  const storageFile = commentStorageFileName(payload.gitPath);
  const existing = await readDocCommentExport(repoPath, payload.gitPath);
  if (existing && isDocumentCommentExportUnchanged(existing, payload.comments)) {
    return { storageFile, written: false };
  }

  const docsDir = commentDocsDirectory(repoPath);
  await mkdir(docsDir, { recursive: true });
  const absolutePath = join(docsDir, storageFile);
  await writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  return { storageFile, written: true };
}

export async function writeCommentImportManifest(
  repoPath: string,
  manifest: FeishuCommentImportManifest,
): Promise<void> {
  const rootDir = join(repoPath, FEISHU_COMMENTS_ROOT_DIR);
  await mkdir(rootDir, { recursive: true });
  await writeFile(commentManifestPath(repoPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export function docCommentExportPath(repoPath: string, gitPath: string): string {
  return join(commentDocsDirectory(repoPath), commentStorageFileName(gitPath));
}

/** 删除单篇文档的评论导出文件（无评论或评论已清空时） */
export async function deleteDocCommentExport(repoPath: string, gitPath: string): Promise<boolean> {
  try {
    await unlink(docCommentExportPath(repoPath, gitPath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 移除不在本次导入清单中的旧评论文件 */
export async function removeStaleDocCommentExports(
  repoPath: string,
  activeStorageFiles: ReadonlySet<string>,
): Promise<number> {
  const docsDir = commentDocsDirectory(repoPath);
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(docsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  for (const file of entries) {
    if (!file.endsWith('.comments.json')) continue;
    if (activeStorageFiles.has(file)) continue;
    await unlink(join(docsDir, file));
    removed += 1;
  }
  return removed;
}

/** 全部文档均无评论时移除 manifest */
export async function removeCommentImportManifest(repoPath: string): Promise<boolean> {
  try {
    await unlink(commentManifestPath(repoPath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
