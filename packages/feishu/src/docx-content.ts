import type { FeishuClient } from './client.js';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from './api-error.js';

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

  const trimmed = markdown.trim() || ' ';
  const candidates = uniqueStrings([trimmed, flattenMarkdownTables(trimmed)]);

  for (const content of candidates) {
    try {
      await insertConvertedMarkdown(client, documentId, content);
      return;
    } catch (error) {
      if (!isDocxInsertRecoverableError(error)) {
        throw error;
      }
    }
  }

  await insertPlainTextBlock(client, documentId, trimmed);
}

async function insertConvertedMarkdown(
  client: FeishuClient,
  documentId: string,
  markdown: string,
): Promise<void> {
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
        index: 0,
        descendants: blocks as ConvertBlock[],
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
