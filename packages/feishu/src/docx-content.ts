import type { FeishuClient } from './client.js';
import { assertFeishuResponse, FeishuApiError, formatFeishuErrorMessage, withRateLimit } from './api-error.js';
import { applyMermaidSubgraphSections } from './board-subgraph-sections.js';
import { importBoardMermaidDiagram, insertBoardBlock } from './board-service.js';
import {
  clearDocumentBody,
  deleteDocumentBlockAtIndex,
  findDocumentPageBlock,
  insertPlainTextBlockAt,
  listDocumentBlocks,
} from './docx-block-service.js';
import { bindConvertedImageBlocks, insertDocxImageAt, resolveImageBlockIdsAfterConvertInsert } from './image-service.js';
import type { DocxImageResolver } from './image-service.js';
import { MERMAID_DIAGRAM_TYPE, splitMarkdownByDiagrams } from './mermaid-markdown.js';
import { markdownContainsImages, splitMarkdownByImages, stripMarkdownImagesToFallback } from './markdown-images.js';
import { pathEndsWithExtension, parseCsv, createLogger } from '@feishu-md/shared';
import { insertNativeTableAt } from './docx-table-service.js';
import { splitMarkdownByTables, markdownContainsGfmTable } from './markdown-tables.js';
import { syncContextFromOptions, type SyncLogContext } from './sync-log.js';

const syncLog = createLogger('sync');

export type MarkdownImageResolver = DocxImageResolver;

export interface ReplaceDocumentMarkdownOptions {
  /** Git 仓库内源 Markdown 路径，写入日志便于排查 */
  sourcePath?: string;
  resolveImage?: MarkdownImageResolver;
  /** 表格类扩展名，用于识别 CSV 等并插入飞书原生表格 */
  tabularExtensions?: string[];
}

function syncCtx(
  documentId: string,
  options?: ReplaceDocumentMarkdownOptions,
  extra?: Pick<SyncLogContext, 'imageSrc'>,
): SyncLogContext {
  return {
    sourcePath: options?.sourcePath,
    documentId,
    ...extra,
  };
}

type ConvertBlock = NonNullable<
  NonNullable<
    Awaited<ReturnType<FeishuClient['docx']['v1']['document']['convert']>>['data']
  >['blocks']
>[number];

export async function createEmptyDocument(
  client: FeishuClient,
  options: { folderToken?: string; title: string },
): Promise<string> {
  const response = await withRateLimit(() =>
    client.docx.v1.document.create({
      data: {
        folder_token: options.folderToken || undefined,
        title: options.title.slice(0, 800) || 'Untitled',
      },
    }),
  );

  assertFeishuResponse(response, 'Create docx document');
  const documentId = response.data?.document?.document_id;
  if (!documentId) {
    throw new Error('Create docx document returned empty document_id');
  }
  return documentId;
}

export async function replaceDocumentMarkdown(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  options?: ReplaceDocumentMarkdownOptions,
): Promise<void> {
  syncLog.info('写入文档正文', {
    documentId,
    sourcePath: options?.sourcePath,
  });
  await clearDocumentBody(client, documentId);

  const tabularExtensions = options?.tabularExtensions ?? ['.csv'];
  if (options?.sourcePath && pathEndsWithExtension(options.sourcePath, tabularExtensions)) {
    const rows = parseCsv(markdown);
    await insertNativeTableAt(client, documentId, rows, 0);
    return;
  }

  const trimmed = markdown.trim() || ' ';
  const inserted = await insertMarkdownDocumentAt(client, documentId, trimmed, 0, options);
  if (inserted === 0) {
    await insertPlainTextBlockAt(client, documentId, trimmed, 0);
  }
}

/** 在文档末尾追加 Markdown（含 Mermaid 画板块），不清空已有正文 */
export async function appendDocumentMarkdown(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  options?: ReplaceDocumentMarkdownOptions,
): Promise<{ insertedBlockCount: number }> {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return { insertedBlockCount: 0 };
  }

  const items = await listDocumentBlocks(client, documentId, 'List docx blocks for append');
  const pageBlock = findDocumentPageBlock(items, documentId);
  const insertIndex = pageBlock?.children?.length ?? 0;

  syncLog.info('追加文档正文', {
    documentId,
    insertIndex,
    sourcePath: options?.sourcePath,
  });

  const inserted = await insertMarkdownDocumentAt(
    client,
    documentId,
    trimmed,
    insertIndex,
    options,
  );
  return { insertedBlockCount: inserted };
}

async function insertMarkdownDocumentAt(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  startIndex: number,
  options?: ReplaceDocumentMarkdownOptions,
): Promise<number> {
  const segments = splitMarkdownByDiagrams(markdown);
  let insertIndex = startIndex;
  const initialIndex = startIndex;

  for (const segment of segments) {
    if (segment.kind === 'markdown') {
      insertIndex += await insertMarkdownSegment(
        client,
        documentId,
        segment.content,
        insertIndex,
        options,
      );
      continue;
    }

    const whiteboardId = await insertBoardBlock(client, documentId, insertIndex);
    syncLog.debug('开始导入画板图表', {
      documentId,
      whiteboardId,
      diagramType: segment.diagramType,
      codeLineCount: segment.code.split('\n').length,
      sourcePath: options?.sourcePath,
    });
    try {
      await importBoardMermaidDiagram(client, whiteboardId, segment.code, segment.diagramType);
      // 思维导图不做 subgraph 分区后处理，避免破坏 mind_map 节点
      if (
        segment.diagramType === MERMAID_DIAGRAM_TYPE.flowchart ||
        segment.diagramType === MERMAID_DIAGRAM_TYPE.auto
      ) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        try {
          await applyMermaidSubgraphSections(client, whiteboardId, segment.code);
          syncLog.debug('画板 subgraph 转分区完成', { documentId, whiteboardId });
        } catch (sectionError) {
          syncLog.warn(
            `画板 subgraph 转分区失败，保留 Mermaid 导入结果: ${formatFeishuErrorMessage(sectionError)}`,
            syncCtx(documentId, options),
          );
        }
      }
    } catch (error) {
      syncLog.warn(
        `画板图表导入失败，保留 Markdown 代码块: ${formatFeishuErrorMessage(error)}`,
        syncCtx(documentId, options),
      );
      await deleteDocumentBlockAtIndex(client, documentId, insertIndex);
      insertIndex += await insertMarkdownSegment(
        client,
        documentId,
        wrapAsMermaidFence(segment.code),
        insertIndex,
        options,
      );
      continue;
    }
    insertIndex += 1;
  }

  return insertIndex - initialIndex;
}

async function insertMarkdownSegment(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  index: number,
  options?: ReplaceDocumentMarkdownOptions,
): Promise<number> {
  const trimmed = markdown.trim();
  if (!trimmed) return 0;

  if (options?.resolveImage && markdownContainsImages(trimmed)) {
    try {
      return await insertConvertedMarkdownAt(client, documentId, trimmed, index, options);
    } catch (error) {
      if (!isDocxInsertRecoverableError(error)) {
        throw error;
      }
      syncLog.warn(
        `含图片 Markdown convert 插入失败，回退逐张插入: ${formatFeishuErrorMessage(error)}`,
        syncCtx(documentId, options),
      );
      return insertMarkdownSegmentWithImages(client, documentId, trimmed, index, options);
    }
  }

  if (markdownContainsGfmTable(trimmed)) {
    return insertMarkdownWithNativeTables(client, documentId, trimmed, index, options);
  }

  return insertPlainMarkdownSegment(client, documentId, trimmed, index, options);
}

async function insertMarkdownWithNativeTables(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  index: number,
  options?: ReplaceDocumentMarkdownOptions,
): Promise<number> {
  const segments = splitMarkdownByTables(markdown);
  let currentIndex = index;
  let insertedCount = 0;

  for (const segment of segments) {
    if (segment.kind === 'table') {
      const added = await insertNativeTableAt(client, documentId, segment.rows, currentIndex);
      currentIndex += added;
      insertedCount += added;
      continue;
    }

    if (!segment.content.trim()) {
      continue;
    }

    const added = await insertPlainMarkdownSegment(
      client,
      documentId,
      segment.content,
      currentIndex,
      options,
    );
    currentIndex += added;
    insertedCount += added;
  }

  return insertedCount;
}

async function insertPlainMarkdownSegment(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  index: number,
  options?: ReplaceDocumentMarkdownOptions,
): Promise<number> {
  const trimmed = markdown.trim();
  if (!trimmed) return 0;

  try {
    return await insertConvertedMarkdownAt(client, documentId, trimmed, index, options);
  } catch (error) {
    if (!isDocxInsertRecoverableError(error)) {
      throw error;
    }
  }

  const fallback = stripMarkdownImagesToFallback(trimmed).trim() || trimmed;
  await insertPlainTextBlockAt(client, documentId, fallback, index);
  return 1;
}

/** 含图片的 Markdown：正文 convert 插入，图片单独 create + upload + replace_image */
async function insertMarkdownSegmentWithImages(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  index: number,
  options: ReplaceDocumentMarkdownOptions,
): Promise<number> {
  const resolveImage = options.resolveImage;
  if (!resolveImage) return 0;

  const segments = splitMarkdownByImages(markdown);
  let currentIndex = index;
  let insertedCount = 0;

  for (const segment of segments) {
    if (segment.kind === 'markdown') {
      if (!segment.content.trim()) continue;
      const count = await insertMarkdownSegment(client, documentId, segment.content, currentIndex, options);
      currentIndex += count;
      insertedCount += count;
      continue;
    }

    try {
      const resolved = await resolveImage(segment.src, segment.alt);
      if (!resolved) {
        syncLog.warn(
          '图片无法解析，插入文本占位',
          syncCtx(documentId, options, { imageSrc: segment.src }),
        );
        await insertPlainTextBlockAt(
          client,
          documentId,
          segment.alt.trim() || `[图片: ${segment.src}]`,
          currentIndex,
        );
        currentIndex += 1;
        insertedCount += 1;
        continue;
      }

      await insertDocxImageAt(
        client,
        documentId,
        currentIndex,
        resolved,
        syncCtx(documentId, options, { imageSrc: segment.src }),
      );
      currentIndex += 1;
      insertedCount += 1;
    } catch (error) {
      syncLog.warn(
        `图片上传失败，插入文本占位: ${formatFeishuErrorMessage(error)}`,
        syncCtx(documentId, options, { imageSrc: segment.src }),
      );
      await insertPlainTextBlockAt(
        client,
        documentId,
        segment.alt.trim() || `[图片: ${segment.src}]`,
        currentIndex,
      );
      currentIndex += 1;
      insertedCount += 1;
    }
  }

  return insertedCount;
}

async function insertConvertedMarkdownAt(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  index: number,
  options?: ReplaceDocumentMarkdownOptions,
): Promise<number> {
  const convertResponse = await withRateLimit(() =>
    client.docx.v1.document.convert({
      data: {
        content_type: 'markdown',
        content: markdown,
      },
    }),
  );
  assertFeishuResponse(convertResponse, 'Convert markdown to docx blocks');

  const rawBlocks = convertResponse.data?.blocks ?? [];
  const firstLevelBlockIds = convertResponse.data?.first_level_block_ids ?? [];
  const blocks = sanitizeConvertBlocksForInsert(rawBlocks as ConvertBlock[]);

  if (blocks.length === 0 || firstLevelBlockIds.length === 0) {
    throw new FeishuApiError('Convert markdown returned no blocks');
  }

  const createResponse = await withRateLimit(() =>
    client.docx.v1.documentBlockDescendant.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children_id: firstLevelBlockIds,
        index,
        descendants: blocks,
      },
    }),
  );
  assertFeishuResponse(createResponse, 'Insert converted docx blocks');

  // FAQ §10：convert 插入 Image Block 后，用真实 block_id 逐张 upload_all + replace_image
  if (options?.resolveImage && markdownContainsImages(markdown)) {
    const imageBlockIds = await resolveImageBlockIdsAfterConvertInsert(client, documentId, {
      convertBlocks: blocks,
      firstLevelBlockIds,
      blockIdRelations: (createResponse.data?.block_id_relations ?? []) as Array<{
        temporary_block_id?: string;
        block_id?: string;
      }>,
      insertIndex: index,
      insertedTopLevelCount: firstLevelBlockIds.length,
    });
    if (imageBlockIds.length > 0) {
      await bindConvertedImageBlocks(
        client,
        documentId,
        imageBlockIds,
        markdown,
        options.resolveImage,
        syncContextFromOptions({ sourcePath: options.sourcePath, documentId }),
      );
    }
  }

  return firstLevelBlockIds.length;
}

const DOCX_TABLE_BLOCK_TYPE = 31;

/** 飞书 FAQ：插入前去除表格 merge_info，避免 invalid param */
function sanitizeConvertBlocksForInsert(blocks: ConvertBlock[]): ConvertBlock[] {
  return blocks.map((block) => {
    const record = block as ConvertBlock & Record<string, unknown>;
    if (record.block_type !== DOCX_TABLE_BLOCK_TYPE || !record.table) {
      return block;
    }

    return {
      ...record,
      table: stripMergeInfo(record.table as Record<string, unknown>),
    } as ConvertBlock;
  });
}

function stripMergeInfo(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  delete result.merge_info;

  if (result.property && typeof result.property === 'object') {
    const property = { ...(result.property as Record<string, unknown>) };
    delete property.merge_info;
    result.property = property;
  }

  return result;
}

function wrapAsMermaidFence(code: string): string {
  return `\`\`\`mermaid\n${code.trim()}\n\`\`\``;
}

function isDocxInsertRecoverableError(error: unknown): boolean {
  if (!(error instanceof FeishuApiError)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('invalid param') ||
    message.includes('field validation failed') ||
    message.includes('convert markdown returned no blocks') ||
    error.code === 1770001 ||
    error.code === 99992402
  );
}
