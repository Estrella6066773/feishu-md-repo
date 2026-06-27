import type { FeishuClient } from './client.js';
import { assertFeishuResponse, FeishuApiError, formatFeishuErrorMessage, withRateLimit } from './api-error.js';
import { applyMermaidSubgraphSections } from './board-subgraph-sections.js';
import { importBoardMermaidDiagram, insertBoardBlock } from './board-service.js';
import {
  clearDocumentBody,
  deleteDocumentBlockAtIndex,
  insertPlainTextBlockAt,
} from './docx-block-service.js';
import { bindConvertedImageBlocks, insertDocxImageAt, resolveImageBlockIdsAfterConvertInsert } from './image-service.js';
import type { DocxImageResolver } from './image-service.js';
import { splitMarkdownByDiagrams } from './mermaid-markdown.js';
import { markdownContainsImages, splitMarkdownByImages, stripMarkdownImagesToFallback } from './markdown-images.js';

export type MarkdownImageResolver = DocxImageResolver;

export interface ReplaceDocumentMarkdownOptions {
  resolveImage?: MarkdownImageResolver;
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
  await clearDocumentBody(client, documentId);

  const trimmed = markdown.trim() || ' ';
  const segments = splitMarkdownByDiagrams(trimmed);
  let insertIndex = 0;

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
    try {
      await importBoardMermaidDiagram(client, whiteboardId, segment.code, segment.diagramType);
      await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        await applyMermaidSubgraphSections(client, whiteboardId, segment.code);
      } catch (sectionError) {
        console.warn(`[sync] 画板 subgraph 转分区失败，保留 Mermaid 导入结果: ${formatFeishuErrorMessage(sectionError)}`);
      }
    } catch (error) {
      console.warn(`[sync] 画板图表导入失败，保留 Markdown 代码块: ${formatFeishuErrorMessage(error)}`);
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

  if (insertIndex === 0) {
    await insertPlainTextBlockAt(client, documentId, trimmed, 0);
  }
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
    return insertMarkdownSegmentWithImages(client, documentId, trimmed, index, options);
  }

  const candidates = uniqueStrings([trimmed, flattenMarkdownTables(trimmed)]);
  for (const content of candidates) {
    try {
      return await insertConvertedMarkdownAt(client, documentId, content, index, options);
    } catch (error) {
      if (!isDocxInsertRecoverableError(error)) {
        throw error;
      }
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
      const count = await insertMarkdownSegment(client, documentId, segment.content, currentIndex);
      currentIndex += count;
      insertedCount += count;
      continue;
    }

    try {
      const resolved = await resolveImage(segment.src, segment.alt);
      if (!resolved) {
        console.warn(`[sync] 图片无法解析，插入文本占位: ${segment.src}`);
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

      await insertDocxImageAt(client, documentId, currentIndex, resolved);
      currentIndex += 1;
      insertedCount += 1;
    } catch (error) {
      console.warn(
        `[sync] 图片上传失败，插入文本占位: ${segment.src} (${formatFeishuErrorMessage(error)})`,
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

  // 含图片的 Markdown 走 insertMarkdownSegmentWithImages，此处仅处理 convert 结果里可能残留的 Image Block
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

/** 将 GFM 表格转为列表，避免飞书 block 插入接口对表格块报 invalid param */
function flattenMarkdownTables(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (
      line.trim().startsWith('|') &&
      index + 1 < lines.length &&
      /^\|[\s\-:|]+\|$/.test(lines[index + 1]!.trim())
    ) {
      const headerCells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean);
      index += 2;

      while (index < lines.length && lines[index]!.trim().startsWith('|')) {
        const row = lines[index]!;
        const cells = row
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean);
        const parts = headerCells.map((header, cellIndex) => `${header}: ${cells[cellIndex] ?? ''}`);
        if (parts.length > 0) {
          result.push(`- ${parts.join(' · ')}`);
        }
        index += 1;
      }
      result.push('');
      continue;
    }

    result.push(line);
    index += 1;
  }

  return result.join('\n');
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
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
