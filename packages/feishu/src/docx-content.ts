import { randomUUID } from 'node:crypto';
import type { FeishuClient } from './client.js';
import { assertFeishuResponse, withRateLimit } from './api-error.js';

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
): Promise<void> {
  await clearDocumentBody(client, documentId);

  const convertResponse = await withRateLimit(() =>
    client.docx.v1.document.convert({
      data: {
        content_type: 'markdown',
        content: markdown,
      },
    }),
  );
  assertFeishuResponse(convertResponse, 'Convert markdown to docx blocks');

  const blocks = convertResponse.data?.blocks ?? [];
  const firstLevelBlockIds = convertResponse.data?.first_level_block_ids ?? [];

  if (blocks.length === 0 || firstLevelBlockIds.length === 0) {
    await insertPlainTextBlock(client, documentId, markdown.trim() || ' ');
    return;
  }

  const descendants = assignBlockIds(blocks);
  const childrenId = firstLevelBlockIds
    .map((id) => descendants.find((block) => block.sourceBlockId === id)?.block_id)
    .filter((id): id is string => Boolean(id));

  if (childrenId.length === 0) {
    await insertPlainTextBlock(client, documentId, markdown.trim() || ' ');
    return;
  }

  const createResponse = await withRateLimit(() =>
    client.docx.v1.documentBlockDescendant.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children_id: childrenId,
        index: 0,
        descendants: descendants.map(({ sourceBlockId: _source, ...block }) => block),
      },
    }),
  );
  assertFeishuResponse(createResponse, 'Insert converted docx blocks');
}

async function clearDocumentBody(client: FeishuClient, documentId: string): Promise<void> {
  const listResponse = await withRateLimit(() =>
    client.docx.v1.documentBlock.list({
      path: { document_id: documentId },
      params: { page_size: 500 },
    }),
  );
  assertFeishuResponse(listResponse, 'List docx blocks');

  const pageBlock = listResponse.data?.items?.find((item) => item.block_id === documentId);
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

async function insertPlainTextBlock(
  client: FeishuClient,
  documentId: string,
  text: string,
): Promise<void> {
  const response = await withRateLimit(() =>
    client.docx.v1.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children: [
          {
            block_type: 2,
            text: {
              elements: [{ text_run: { content: text.slice(0, 8000) } }],
            },
          },
        ],
      },
    }),
  );
  assertFeishuResponse(response, 'Insert plain text block');
}

function assignBlockIds(blocks: ConvertBlock[]): Array<ConvertBlock & { sourceBlockId: string }> {
  const idMap = new Map<string, string>();

  blocks.forEach((block, index) => {
    const sourceId = block.block_id ?? `generated-${index}`;
    idMap.set(sourceId, randomUUID());
  });

  return blocks.map((block, index) => {
    const sourceBlockId = block.block_id ?? `generated-${index}`;
    const block_id = idMap.get(sourceBlockId) ?? randomUUID();
    const children = block.children?.map((childId) => idMap.get(childId) ?? childId);
    return {
      ...block,
      sourceBlockId,
      block_id,
      children,
    };
  });
}
