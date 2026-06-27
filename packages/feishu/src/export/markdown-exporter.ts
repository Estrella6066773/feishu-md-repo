import type { FeishuClient } from '../client.js';
import { assertFeishuResponse, FeishuApiError, withRateLimit } from '../api-error.js';
import { parseFeishuDocumentUrl } from './document-url.js';
import { getWikiNodeByToken } from '../wiki-service.js';
import {
  exportBoardNodesToMermaid,
  listWhiteboardNodes,
} from './board-export.js';
import { detectDiagramFenceLang } from '../mermaid-markdown.js';

export interface ExportDocumentOptions {
  documentUrl: string;
  includeTitle?: boolean;
}

export interface ExportDocumentResult {
  title?: string;
  markdown: string;
}

interface DocxBlock {
  block_id?: string;
  block_type?: number;
  parent_id?: string;
  children?: string[];
  text?: UnknownRecord;
  heading1?: UnknownRecord;
  heading2?: UnknownRecord;
  heading3?: UnknownRecord;
  heading4?: UnknownRecord;
  heading5?: UnknownRecord;
  heading6?: UnknownRecord;
  heading7?: UnknownRecord;
  heading8?: UnknownRecord;
  heading9?: UnknownRecord;
  bullet?: UnknownRecord;
  ordered?: UnknownRecord;
  code?: UnknownRecord;
  quote?: UnknownRecord;
  todo?: UnknownRecord;
  divider?: UnknownRecord;
  table?: UnknownRecord;
  table_cell?: UnknownRecord;
  board?: UnknownRecord;
}

type UnknownRecord = Record<string, unknown>;

/** 飞书 docx block_type 枚举（与 Open API 一致） */
const DOCX_BLOCK_TYPE = {
  PAGE: 1,
  TEXT: 2,
  HEADING1: 3,
  HEADING2: 4,
  HEADING3: 5,
  HEADING4: 6,
  HEADING5: 7,
  HEADING6: 8,
  HEADING7: 9,
  HEADING8: 10,
  HEADING9: 11,
  BULLET: 12,
  ORDERED: 13,
  CODE: 14,
  QUOTE: 15,
  TODO: 17,
  DIVIDER: 22,
  BOARD: 43,
} as const;

export async function exportDocumentToMarkdown(
  client: FeishuClient,
  options: ExportDocumentOptions,
): Promise<ExportDocumentResult> {
  const { documentUrl } = options;
  const parsed = parseFeishuDocumentUrl(documentUrl);
  if (!parsed) {
    throw new Error('无法解析飞书文档链接，请确认链接包含 /docx/ 或 /wiki/ 路径');
  }

  const documentId = await resolveDocumentId(client, parsed);
  const metadata = await fetchDocumentMetadata(client, documentId);
  const blocks = await fetchAllBlocks(client, documentId);

  const context: ExportContext = {
    client,
    documentId,
    blockMap: new Map(blocks.map((block) => [String(block.block_id), block])),
  };

  const rootBlock = blocks.find((block) => block.block_id === documentId);
  const rootChildren = rootBlock?.children ?? [];
  const body = await renderBlocks(context, rootChildren, 0);

  const title = metadata.title || '未命名文档';
  let markdown = body;
  if (options.includeTitle !== false && title) {
    markdown = `# ${title}\n\n${body}`;
  }

  return { title, markdown: markdown.trim() };
}

interface ExportContext {
  client: FeishuClient;
  documentId: string;
  blockMap: Map<string, DocxBlock>;
}

async function resolveDocumentId(
  client: FeishuClient,
  parsed: NonNullable<ReturnType<typeof parseFeishuDocumentUrl>>,
): Promise<string> {
  if (parsed.source === 'docx') {
    return parsed.token;
  }

  const node = await getWikiNodeByToken(client, parsed.token);
  if (!node?.docToken) {
    throw new Error(
      '无法解析 wiki 链接：请确认文档存在，且应用对该知识库节点有读取权限。',
    );
  }
  return node.docToken;
}

async function fetchDocumentMetadata(
  client: FeishuClient,
  documentId: string,
): Promise<{ title?: string }> {
  const response = await withRateLimit(() =>
    client.docx.v1.document.get({
      path: { document_id: documentId },
    }),
  );
  assertFeishuResponse(response, 'Get document metadata');
  return { title: response.data?.document?.title };
}

async function fetchAllBlocks(client: FeishuClient, documentId: string): Promise<DocxBlock[]> {
  const response = await withRateLimit(() =>
    client.docx.v1.documentBlock.list({
      path: { document_id: documentId },
      params: { page_size: 500 },
    }),
  );
  assertFeishuResponse(response, 'List document blocks');
  return (response.data?.items ?? []) as DocxBlock[];
}

async function renderBlocks(
  context: ExportContext,
  blockIds: string[],
  indentLevel: number,
): Promise<string> {
  const parts: string[] = [];

  for (const blockId of blockIds) {
    const block = context.blockMap.get(blockId);
    if (!block) continue;

    const rendered = await renderBlock(context, block, indentLevel);
    if (rendered) {
      parts.push(rendered);
    }
  }

  return parts.join('\n\n');
}

async function renderBlock(
  context: ExportContext,
  block: DocxBlock,
  indentLevel: number,
): Promise<string> {
  const type = block.block_type;

  switch (type) {
    case DOCX_BLOCK_TYPE.PAGE:
      return block.children?.length
        ? await renderBlocks(context, block.children, indentLevel)
        : '';
    case DOCX_BLOCK_TYPE.TEXT:
      return renderTextBlock(block);
    case DOCX_BLOCK_TYPE.HEADING1:
      return renderHeading(block, 1);
    case DOCX_BLOCK_TYPE.HEADING2:
      return renderHeading(block, 2);
    case DOCX_BLOCK_TYPE.HEADING3:
      return renderHeading(block, 3);
    case DOCX_BLOCK_TYPE.HEADING4:
      return renderHeading(block, 4);
    case DOCX_BLOCK_TYPE.HEADING5:
      return renderHeading(block, 5);
    case DOCX_BLOCK_TYPE.HEADING6:
      return renderHeading(block, 6);
    case DOCX_BLOCK_TYPE.HEADING7:
      return renderHeading(block, 7);
    case DOCX_BLOCK_TYPE.HEADING8:
      return renderHeading(block, 8);
    case DOCX_BLOCK_TYPE.HEADING9:
      return renderHeading(block, 9);
    case DOCX_BLOCK_TYPE.BULLET:
      return renderListBlock(block, 'bullet', indentLevel, context);
    case DOCX_BLOCK_TYPE.ORDERED:
      return renderListBlock(block, 'ordered', indentLevel, context);
    case DOCX_BLOCK_TYPE.CODE:
      return renderCodeBlock(block);
    case DOCX_BLOCK_TYPE.QUOTE:
      return renderQuoteBlock(block);
    case DOCX_BLOCK_TYPE.TODO:
      return renderTodoBlock(block, indentLevel);
    case DOCX_BLOCK_TYPE.DIVIDER:
      return '---';
    case DOCX_BLOCK_TYPE.BOARD:
      return await renderBoardBlock(context, block);
    default:
      if (block.children && block.children.length > 0) {
        return await renderBlocks(context, block.children, indentLevel);
      }
      return '';
  }
}

async function renderListBlock(
  block: DocxBlock,
  kind: 'bullet' | 'ordered',
  indentLevel: number,
  context: ExportContext,
): Promise<string> {
  const container = kind === 'bullet' ? block.bullet : block.ordered;
  const elements = extractTextElements(container);
  const indent = '  '.repeat(indentLevel);
  const marker = kind === 'bullet' ? '-' : '1.';
  const head = `${indent}${marker} ${elementsToMarkdown(elements)}`;

  if (!block.children?.length) {
    return head;
  }

  const nested = await renderBlocks(context, block.children, indentLevel + 1);
  return nested ? `${head}\n\n${nested}` : head;
}

function renderHeading(block: DocxBlock, level: number): string {
  const elements = extractTextElements(block[`heading${level}` as keyof DocxBlock] as UnknownRecord | undefined);
  return `${'#'.repeat(level)} ${elementsToMarkdown(elements)}`;
}

function renderTextBlock(block: DocxBlock): string {
  const elements = extractTextElements(block.text);
  return elementsToMarkdown(elements);
}

function renderQuoteBlock(block: DocxBlock): string {
  const elements = extractTextElements(block.quote);
  return `> ${elementsToMarkdown(elements)}`;
}

function renderCodeBlock(block: DocxBlock): string {
  const code = block.code as UnknownRecord | undefined;
  const language = String(code?.language || '').trim();
  const elements = extractTextElements(code);
  const content = elements.map((element) => element.text).join('');
  return `\`\`\`${language}\n${content}\n\`\`\``;
}

function renderTodoBlock(block: DocxBlock, indentLevel: number): string {
  const todo = block.todo as UnknownRecord | undefined;
  const elements = extractTextElements(todo);
  const checked = todo?.done === true ? 'x' : ' ';
  const indent = '  '.repeat(indentLevel);
  return `${indent}- [${checked}] ${elementsToMarkdown(elements)}`;
}

async function renderBoardBlock(context: ExportContext, block: DocxBlock): Promise<string> {
  const board = block.board as UnknownRecord | undefined;
  const whiteboardId = String(board?.token ?? '');
  if (!whiteboardId) return '';

  try {
    const rawNodes = await listWhiteboardNodes(context.client, whiteboardId);
    const diagramCode = exportBoardNodesToMermaid(rawNodes);
    if (diagramCode) {
      const fenceLang = detectDiagramFenceLang(diagramCode);
      return `\`\`\`${fenceLang}\n${diagramCode}\n\`\`\``;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<!-- 画板导出失败: ${message} -->`;
  }

  return '<!-- 空画板 -->';
}

interface TextElement {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  inlineCode?: boolean;
  link?: string;
}

function extractTextElements(container: UnknownRecord | undefined): TextElement[] {
  if (!container) return [];

  const containerRecord = container as UnknownRecord;
  const elements = (containerRecord['elements'] ?? containerRecord['content'] ?? (containerRecord['text_run'] as UnknownRecord | undefined)?.['content'] ?? []) as unknown[];

  if (typeof elements === 'string') {
    return [{ text: elements }];
  }

  if (!Array.isArray(elements)) {
    const directText = (containerRecord['text_run'] as UnknownRecord | undefined)?.['content'] ?? containerRecord['text'];
    if (typeof directText === 'string') {
      return [{ text: directText }];
    }
    return [];
  }

  return elements.flatMap((element): TextElement[] => {
    if (!element || typeof element !== 'object') return [];
    const record = element as UnknownRecord;

    const textRun = record.text_run as UnknownRecord | undefined;
    if (textRun) {
      return [buildTextElement(textRun)];
    }

    const mentionDoc = record.mention_doc as UnknownRecord | undefined;
    if (mentionDoc) {
      const url = String(mentionDoc.url ?? mentionDoc.doc_url ?? '');
      const title = String(mentionDoc.title ?? (url || '文档链接'));
      return [{ text: title, link: url || undefined }];
    }

    const mentionUser = record.mention_user as UnknownRecord | undefined;
    if (mentionUser) {
      const name = String(mentionUser.name ?? mentionUser.user_id ?? '@用户');
      return [{ text: name }];
    }

    if (typeof record.content === 'string') {
      return [buildTextElement(record)];
    }

    return [];
  });
}

function buildTextElement(textRun: UnknownRecord): TextElement {
  const style = (textRun.style as UnknownRecord) ?? {};
  const content = String(textRun.content ?? '');

  return {
    text: content,
    bold: Boolean(style.bold),
    italic: Boolean(style.italic),
    strikethrough: Boolean(style.strikethrough),
    underline: Boolean(style.underline),
    inlineCode: Boolean(style.inline_code),
    link: (textRun.link as UnknownRecord | undefined)?.url ? String((textRun.link as UnknownRecord).url) : undefined,
  };
}

function elementsToMarkdown(elements: TextElement[]): string {
  return elements
    .map((element) => {
      let text = element.text;
      if (element.inlineCode) text = `\`${text}\``;
      if (element.bold) text = `**${text}**`;
      if (element.italic) text = `*${text}*`;
      if (element.strikethrough) text = `~~${text}~~`;
      if (element.link) text = `[${text}](${element.link})`;
      return text;
    })
    .join('');
}

export function formatExportError(error: unknown): string {
  if (error instanceof FeishuApiError) {
    const codeSuffix = error.code != null ? ` [code ${error.code}]` : '';
    if (error.code === 131005 || error.code === 404 || /not found/i.test(error.message)) {
      return `文档不存在或应用无读取权限${codeSuffix}。请确认链接正确，并将应用添加为文档/知识库协作者。`;
    }
    return `${error.message}${codeSuffix}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
