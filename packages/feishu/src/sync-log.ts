/** 同步日志上下文，便于在控制台定位出错文件与资源 */
export interface SyncLogContext {
  /** Git 仓库内源 Markdown 路径 */
  sourcePath?: string;
  /** Markdown 中引用的图片 src */
  imageSrc?: string;
  /** 飞书文档 document_id */
  documentId?: string;
}

export function formatSyncLog(message: string, context?: SyncLogContext): string {
  const tags: string[] = [];
  if (context?.sourcePath) {
    tags.push(`file=${context.sourcePath}`);
  }
  if (context?.imageSrc) {
    tags.push(`image=${context.imageSrc}`);
  }
  if (context?.documentId) {
    tags.push(`doc=${context.documentId}`);
  }

  if (tags.length === 0) {
    return `[sync] ${message}`;
  }
  return `[sync] ${tags.join(' ')} — ${message}`;
}

export function syncContextFromOptions(options?: {
  sourcePath?: string;
  documentId?: string;
}): SyncLogContext | undefined {
  if (!options?.sourcePath && !options?.documentId) {
    return undefined;
  }
  return {
    sourcePath: options.sourcePath,
    documentId: options.documentId,
  };
}
