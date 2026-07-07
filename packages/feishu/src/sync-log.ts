export {
  createLogger,
  formatSyncLog,
  type LogContext,
  type LogContext as SyncLogContext,
} from '@feishu-md/shared';

export function syncContextFromOptions(options?: {
  sourcePath?: string;
  documentId?: string;
}): import('@feishu-md/shared').LogContext | undefined {
  if (!options?.sourcePath && !options?.documentId) {
    return undefined;
  }
  return {
    sourcePath: options.sourcePath,
    documentId: options.documentId,
  };
}
