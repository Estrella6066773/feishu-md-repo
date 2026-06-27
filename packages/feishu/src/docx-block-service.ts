import type { FeishuClient } from './client.js';
import { assertFeishuResponse, withRateLimit } from './api-error.js';

const DOCX_PAGE_BLOCK_LIST_SIZE = 500;
const TEXT_BLOCK_TYPE = 2;

export interface DocxBlockListItem {
  block_id?: string;
  block_type?: number;
  children?: string[];
  board?: { token?: string };
}

export interface ConvertBlockLike {
  block_id?: string;
  block_type?: number;
  children?: string[];
}

export interface BlockIdRelation {
  temporary_block_id?: string;
  block_id?: string;
}

type BlockChildPayload = Array<Record<string, unknown>>;

/** 列出文档内全部块（含 Page 与子块） */
export async function listDocumentBlocks(
  client: FeishuClient,
  documentId: string,
  action = 'List docx blocks',
): Promise<DocxBlockListItem[]> {
  const listResponse = await withRateLimit(() =>
    client.docx.v1.documentBlock.list({
      path: { document_id: documentId },
      params: { page_size: DOCX_PAGE_BLOCK_LIST_SIZE },
    }),
  );
  assertFeishuResponse(listResponse, action);
  return (listResponse.data?.items ?? []) as DocxBlockListItem[];
}

export function findDocumentPageBlock(
  items: DocxBlockListItem[],
  documentId: string,
): DocxBlockListItem | undefined {
  return items.find((item) => item.block_id === documentId);
}

/** 获取 Page 下指定序号的子块，可选按 block_type 过滤 */
export function findChildBlockAtIndex(
  items: DocxBlockListItem[],
  documentId: string,
  childIndex: number,
  blockType?: number,
): DocxBlockListItem | null {
  const pageBlock = findDocumentPageBlock(items, documentId);
  const childId = pageBlock?.children?.[childIndex];
  if (!childId) return null;

  const block = items.find((item) => item.block_id === childId);
  if (!block) return null;
  if (blockType != null && block.block_type !== blockType) return null;
  return block;
}

/** 在 Page 指定插入范围内，按文档顺序收集 Image Block 的真实 block_id */
export function collectImageBlockIdsInRange(
  items: DocxBlockListItem[],
  documentId: string,
  insertIndex: number,
  insertedTopLevelCount: number,
  imageBlockType: number,
): string[] {
  const pageBlock = findDocumentPageBlock(items, documentId);
  const rootIds =
    pageBlock?.children?.slice(insertIndex, insertIndex + insertedTopLevelCount) ?? [];
  if (rootIds.length === 0) return [];

  const blockMap = new Map(
    items.filter((item) => item.block_id).map((item) => [item.block_id!, item]),
  );
  const imageBlockIds: string[] = [];

  function walk(ids: string[]) {
    for (const id of ids) {
      const block = blockMap.get(id);
      if (!block) continue;
      if (block.block_type === imageBlockType && block.block_id) {
        imageBlockIds.push(block.block_id);
      }
      if (block.children?.length) {
        walk(block.children);
      }
    }
  }

  walk(rootIds);
  return imageBlockIds;
}

/** convert 结果中按文档顺序收集 Image Block 的临时 block_id */
export function collectImageBlockIdsFromConvertBlocks(
  blocks: ConvertBlockLike[],
  firstLevelBlockIds: string[],
  imageBlockType: number,
): string[] {
  const blockMap = new Map(
    blocks.filter((block) => block.block_id).map((block) => [block.block_id!, block]),
  );
  const imageBlockIds: string[] = [];

  function walk(ids: string[]) {
    for (const id of ids) {
      const block = blockMap.get(id);
      if (!block) continue;
      if (block.block_type === imageBlockType && block.block_id) {
        imageBlockIds.push(block.block_id);
      }
      if (block.children?.length) {
        walk(block.children);
      }
    }
  }

  walk(firstLevelBlockIds);
  return imageBlockIds;
}

/** 将 descendant.create 返回的临时 ID 映射为真实 block_id */
export function mapTemporaryBlockIdsToReal(
  temporaryIds: string[],
  relations: BlockIdRelation[],
): string[] {
  const relationMap = new Map(
    relations
      .filter((item) => item.temporary_block_id && item.block_id)
      .map((item) => [item.temporary_block_id!, item.block_id!]),
  );
  return temporaryIds
    .map((temporaryId) => relationMap.get(temporaryId))
    .filter((blockId): blockId is string => Boolean(blockId));
}

export async function getChildBlockAtIndex(
  client: FeishuClient,
  documentId: string,
  childIndex: number,
  options?: { blockType?: number; action?: string },
): Promise<DocxBlockListItem | null> {
  const items = await listDocumentBlocks(
    client,
    documentId,
    options?.action ?? 'List docx blocks',
  );
  return findChildBlockAtIndex(items, documentId, childIndex, options?.blockType);
}

export async function insertDocumentBlockChildrenAt(
  client: FeishuClient,
  documentId: string,
  index: number,
  children: BlockChildPayload,
  action: string,
) {
  const createResponse = await withRateLimit(() =>
    client.docx.v1.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children: children as never,
        index,
      },
    }),
  );
  assertFeishuResponse(createResponse, action);
  return createResponse;
}

export async function deleteDocumentBlockAtIndex(
  client: FeishuClient,
  documentId: string,
  index: number,
  action = 'Delete docx block at index',
): Promise<void> {
  const deleteResponse = await withRateLimit(() =>
    client.docx.v1.documentBlockChildren.batchDelete({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        start_index: index,
        end_index: index + 1,
      },
    }),
  );
  assertFeishuResponse(deleteResponse, action);
}

export async function deleteDocumentBlockById(
  client: FeishuClient,
  documentId: string,
  blockId: string,
  action = 'Delete docx block by id',
): Promise<void> {
  const items = await listDocumentBlocks(client, documentId, action);
  const pageBlock = findDocumentPageBlock(items, documentId);
  const childIndex = pageBlock?.children?.indexOf(blockId) ?? -1;
  if (childIndex < 0) return;

  await deleteDocumentBlockAtIndex(client, documentId, childIndex, action);
}

export async function insertPlainTextBlockAt(
  client: FeishuClient,
  documentId: string,
  text: string,
  index: number,
): Promise<void> {
  await insertDocumentBlockChildrenAt(
    client,
    documentId,
    index,
    [
      {
        block_type: TEXT_BLOCK_TYPE,
        text: {
          elements: [{ text_run: { content: text.slice(0, 8000) } }],
        },
      },
    ],
    'Insert plain text block',
  );
}

export async function clearDocumentBody(
  client: FeishuClient,
  documentId: string,
): Promise<void> {
  const items = await listDocumentBlocks(client, documentId, 'List docx blocks');
  const pageBlock = findDocumentPageBlock(items, documentId);
  const childCount = pageBlock?.children?.length ?? 0;
  if (childCount === 0) return;

  const deleteResponse = await withRateLimit(() =>
    client.docx.v1.documentBlockChildren.batchDelete({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        start_index: 0,
        end_index: childCount,
      },
    }),
  );
  assertFeishuResponse(deleteResponse, 'Clear docx document body');
}
