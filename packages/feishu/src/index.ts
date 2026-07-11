export * from './client.js';
export { FeishuApiError, formatFeishuErrorMessage, assertFeishuResponse, withRateLimit, isRetryableFeishuRequestError, isRateLimitError } from './api-error.js';
export { runWithFeishuApiRetryPolicy, getFeishuApiRetryPolicy, type FeishuApiRetryPolicy } from './api-retry-policy.js';
export { formatSyncLog, syncContextFromOptions, type SyncLogContext } from './sync-log.js';
export { resolveRepositoryFeishuTarget, type ResolvedRepositoryTarget } from './resolve-repository-target.js';
export { getWikiNodeByToken, type ResolvedWikiNode } from './wiki-service.js';
export { replaceDocumentMarkdown, appendDocumentMarkdown, type MarkdownImageResolver, type ReplaceDocumentMarkdownOptions } from './docx-content.js';
export { toFeishuDocumentUrl, type FeishuDocumentLinkTarget } from './document-url.js';
export {
  sendTextMessage,
  sendPostMarkdownMessage,
  replyTextMessage,
  replyPostMarkdownMessage,
  getImMessage,
  isFeishuThreadReplyUnsupportedError,
  parseMessageText,
  type ImReceiveIdType,
  type ImMessageSendResult,
  type ImMessageDetail,
} from './im-service.js';
export { parseBotCommand, BOT_HELP_TEXT, type BotCommandAction } from './command-parser.js';
export {
  ensureWhiteboardInDocument,
  insertBoardBlock,
  importBoardMermaidDiagram,
  replaceBoardMindMap,
  replaceBoardLinkMindMap,
  clearBoardNodes,
  listBoardNodeIds,
  type BoardMindMapLinkNode,
} from './board-service.js';
export {
  splitMarkdownByDiagrams,
  detectDiagramFenceLang,
  detectMermaidDiagramType,
  MERMAID_DIAGRAM_TYPE,
  type MarkdownDocumentSegment,
} from './mermaid-markdown.js';
export {
  splitMarkdownByTables,
  markdownContainsGfmTable,
  type MarkdownTableSegment,
} from './markdown-tables.js';
export {
  verifyDocumentIntegrity,
  computeExpectedDocumentFingerprint,
  computeActualDocumentFingerprint,
  compareDocumentFingerprints,
  type DocumentContentFingerprint,
  type DocumentIntegrityResult,
} from './document-integrity.js';
export { parseMermaidGraph, type ParsedMermaidGraph, type ParsedMermaidSubgraph } from './mermaid-subgraph.js';
export { applyMermaidSubgraphSections } from './board-subgraph-sections.js';
export {
  exportBoardNodesToMermaid,
  extractBoardNodeLabel,
  listWhiteboardNodes,
} from './export/board-export.js';
export {
  exportDocumentToMarkdown,
  formatExportError,
  type ExportDocumentOptions,
  type ExportDocumentResult,
} from './export/markdown-exporter.js';
export { parseFeishuDocumentUrl, type ParsedDocumentUrl, type FeishuDocumentUrlSource } from './export/document-url.js';
export {
  appendMarkdownToDocument,
  appendMermaidBoardToDocument,
  stripMermaidClassStyles,
  type AppendMarkdownToDocumentOptions,
  type AppendMarkdownToDocumentResult,
  type AppendMermaidBoardOptions,
  type AppendMermaidBoardResult,
} from './append-markdown.js';
export {
  splitMarkdownByImages,
  extractMarkdownImageRefs,
  markdownContainsImages,
  markdownReferencesChangedImages,
  resolveMarkdownImageGitPath,
  resolveMarkdownImageGitPathCandidates,
  readGitImageBinary,
  stripMarkdownImagesToFallback,
  type MarkdownImageSegment,
  type MarkdownImageRef,
} from './markdown-images.js';
export {
  bindConvertedImageBlocks,
  createEmptyImageBlockAt,
  insertDocxImageAt,
  insertImageBlock,
  resolveImageBlockIdsAfterConvertInsert,
  uploadAndBindDocxImageBlock,
  deleteImageBlockById,
  deleteDocumentBlockById,
  toDocxImageUploadFileName,
  type DocxImagePayload,
  type DocxImageResolver,
} from './image-service.js';
export {
  listAllDocumentComments,
  type FeishuCommentRecord,
  type FeishuCommentReplyRecord,
  type FeishuCommentContentElement,
} from './comment-service.js';
export {
  FEISHU_COMMENTS_ROOT_DIR,
  FEISHU_COMMENTS_DOCS_SUBDIR,
  FEISHU_COMMENT_EXPORT_SCHEMA_VERSION,
  commentStorageFileName,
  commentDocsDirectory,
  commentManifestPath,
  countCommentReplies,
  fingerprintDocumentComments,
  isDocumentCommentExportUnchanged,
  readCommentImportManifest,
  readDocCommentExport,
  writeDocCommentExport,
  writeCommentImportManifest,
  deleteDocCommentExport,
  removeStaleDocCommentExports,
  removeCommentImportManifest,
  docCommentExportPath,
  type FeishuDocCommentExport,
  type FeishuCommentImportManifest,
} from './comment-export.js';
