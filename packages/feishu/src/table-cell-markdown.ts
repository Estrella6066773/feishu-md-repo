import type { FeishuClient } from './client.js';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';
import { insertBlockChildrenUnder } from './docx-block-service.js';

const DOCX_TEXT_BLOCK_TYPE = 2;
const DOCX_TABLE_BLOCK_TYPE = 31;
const DOCX_CELL_TEXT_MAX_LENGTH = 8000;

type ConvertBlock = Record<string, unknown> & {
  block_id?: string;
  block_type?: number;
  text?: { elements?: unknown[] };
  children?: string[];
};

const convertCache = new Map<string, ConvertBlock[]>();
const firstLevelCache = new Map<string, string[]>();

function cacheKey(markdown: string): string {
  return markdown.trim();
}

function findConvertBlock(blocks: ConvertBlock[], blockId: string): ConvertBlock | undefined {
  return blocks.find((block) => block.block_id === blockId);
}

/** 飞书 FAQ：插入前去除表格 merge_info，避免 invalid param */
function sanitizeConvertBlocksForInsert(blocks: ConvertBlock[]): ConvertBlock[] {
  return blocks.map((block) => {
    if (block.block_type !== DOCX_TABLE_BLOCK_TYPE || !block.table) {
      return block;
    }

    return {
      ...block,
      table: stripMergeInfo(block.table as Record<string, unknown>),
    };
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

async function convertMarkdownToBlocks(
  client: FeishuClient,
  markdown: string,
): Promise<{ blocks: ConvertBlock[]; firstLevelBlockIds: string[] }> {
  const key = cacheKey(markdown);
  const cachedBlocks = convertCache.get(key);
  const cachedFirstLevel = firstLevelCache.get(key);
  if (cachedBlocks && cachedFirstLevel) {
    return { blocks: cachedBlocks, firstLevelBlockIds: cachedFirstLevel };
  }

  const convertResponse = await withRateLimit(() =>
    client.docx.v1.document.convert({
      data: {
        content_type: 'markdown',
        content: markdown,
      },
    }),
  );
  assertFeishuResponse(convertResponse, 'Convert table cell markdown');

  const rawBlocks = (convertResponse.data?.blocks ?? []) as ConvertBlock[];
  const firstLevelBlockIds = convertResponse.data?.first_level_block_ids ?? [];
  const blocks = sanitizeConvertBlocksForInsert(rawBlocks);

  if (blocks.length === 0 || firstLevelBlockIds.length === 0) {
    throw new FeishuApiError('Convert table cell markdown returned no blocks');
  }

  convertCache.set(key, blocks);
  firstLevelCache.set(key, firstLevelBlockIds);
  return { blocks, firstLevelBlockIds };
}

function canUseSimpleTextInsert(blocks: ConvertBlock[], firstLevelBlockIds: string[]): boolean {
  if (firstLevelBlockIds.length !== 1) {
    return false;
  }

  const block = findConvertBlock(blocks, firstLevelBlockIds[0]!);
  return block?.block_type === DOCX_TEXT_BLOCK_TYPE && !(block.children?.length);
}

function extractTextElements(blocks: ConvertBlock[], firstLevelBlockIds: string[]): unknown[] {
  const block = findConvertBlock(blocks, firstLevelBlockIds[0]!);
  const elements = block?.text?.elements;
  if (Array.isArray(elements) && elements.length > 0) {
    return elements;
  }
  return [{ text_run: { content: '' } }];
}

async function insertPlainTextCell(
  client: FeishuClient,
  documentId: string,
  cellBlockId: string,
  content: string,
): Promise<void> {
  await insertBlockChildrenUnder(
    client,
    documentId,
    cellBlockId,
    0,
    [
      {
        block_type: DOCX_TEXT_BLOCK_TYPE,
        text: {
          elements: [{ text_run: { content: content.slice(0, DOCX_CELL_TEXT_MAX_LENGTH) } }],
        },
      },
    ],
    'Insert table cell plain text',
  );
}

/** 将 Markdown 文段写入表格单元格，保留行内与块级格式（加粗、链接、列表等） */
export async function insertMarkdownIntoTableCell(
  client: FeishuClient,
  documentId: string,
  cellBlockId: string,
  markdown: string,
): Promise<void> {
  const content = markdown.trim();
  if (!content) {
    await insertPlainTextCell(client, documentId, cellBlockId, '');
    return;
  }

  try {
    const { blocks, firstLevelBlockIds } = await convertMarkdownToBlocks(client, content);

    if (canUseSimpleTextInsert(blocks, firstLevelBlockIds)) {
      await insertBlockChildrenUnder(
        client,
        documentId,
        cellBlockId,
        0,
        [
          {
            block_type: DOCX_TEXT_BLOCK_TYPE,
            text: { elements: extractTextElements(blocks, firstLevelBlockIds) },
          },
        ],
        'Insert table cell markdown text',
      );
      return;
    }

    const createResponse = await withRateLimit(() =>
      client.docx.v1.documentBlockDescendant.create({
        path: {
          document_id: documentId,
          block_id: cellBlockId,
        },
        data: {
          children_id: firstLevelBlockIds,
          index: 0,
          descendants: blocks as never,
        },
      }),
    );
    assertFeishuResponse(createResponse, 'Insert table cell markdown blocks');
  } catch {
    await insertPlainTextCell(client, documentId, cellBlockId, content);
  }
}

/** 测试或长文档同步前释放 convert 缓存 */
export function clearTableCellMarkdownCache(): void {
  convertCache.clear();
  firstLevelCache.clear();
}
