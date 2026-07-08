import { pathEndsWithExtension } from '@feishu-md/shared';
import type { FeishuClient } from './client.js';
import { findDocumentPageBlock, listDocumentBlocks } from './docx-block-service.js';
import { extractMarkdownImageRefs } from './markdown-images.js';
import { splitMarkdownByDiagrams } from './mermaid-markdown.js';
import { splitMarkdownByTables } from './markdown-tables.js';

/** 飞书 docx block_type（与 Open API 一致） */
const DOCX_BLOCK_TYPE = {
  CODE: 14,
  IMAGE: 27,
  TABLE: 31,
  BOARD: 43,
} as const;

const FENCED_CODE_RE = /```([^\n]*)\n([\s\S]*?)```/g;
const MERMAID_LANGS = new Set(['mermaid', 'flowchart', 'graph']);

export interface DocumentContentFingerprint {
  tableCount: number;
  boardCount: number;
  codeBlockCount: number;
  imageCount: number;
  hasContent: boolean;
  topLevelBlockCount: number;
}

export interface DocumentIntegrityResult {
  ok: boolean;
  reasons: string[];
}

export function computeExpectedDocumentFingerprint(
  markdown: string,
  sourcePath: string,
  tabularExtensions: string[] = ['.csv'],
): DocumentContentFingerprint {
  const trimmed = markdown.trim();
  const hasContent = trimmed.length > 0;

  if (pathEndsWithExtension(sourcePath, tabularExtensions)) {
    const rowLines = trimmed ? trimmed.split('\n').filter((line) => line.trim()) : [];
    return {
      tableCount: rowLines.length > 0 ? 1 : 0,
      boardCount: 0,
      codeBlockCount: 0,
      imageCount: 0,
      hasContent: rowLines.length > 0,
      topLevelBlockCount: rowLines.length > 0 ? 1 : 0,
    };
  }

  let tableCount = 0;
  let boardCount = 0;
  let codeBlockCount = 0;
  let imageCount = 0;

  for (const segment of splitMarkdownByDiagrams(trimmed)) {
    if (segment.kind === 'diagram') {
      boardCount += 1;
      continue;
    }

    tableCount += splitMarkdownByTables(segment.content).filter((item) => item.kind === 'table').length;
    codeBlockCount += countNonDiagramCodeFences(segment.content);
    imageCount += extractMarkdownImageRefs(segment.content).length;
  }

  return {
    tableCount,
    boardCount,
    codeBlockCount,
    imageCount,
    hasContent,
    topLevelBlockCount: 0,
  };
}

export function computeActualDocumentFingerprint(
  blocks: Array<{ block_id?: string; block_type?: number; children?: string[] }>,
  documentId: string,
): DocumentContentFingerprint {
  let tableCount = 0;
  let boardCount = 0;
  let codeBlockCount = 0;
  let imageCount = 0;

  for (const block of blocks) {
    switch (block.block_type) {
      case DOCX_BLOCK_TYPE.TABLE:
        tableCount += 1;
        break;
      case DOCX_BLOCK_TYPE.BOARD:
        boardCount += 1;
        break;
      case DOCX_BLOCK_TYPE.CODE:
        codeBlockCount += 1;
        break;
      case DOCX_BLOCK_TYPE.IMAGE:
        imageCount += 1;
        break;
      default:
        break;
    }
  }

  const pageBlock = findDocumentPageBlock(blocks, documentId);
  const topLevelBlockCount = pageBlock?.children?.length ?? 0;

  return {
    tableCount,
    boardCount,
    codeBlockCount,
    imageCount,
    hasContent: topLevelBlockCount > 0,
    topLevelBlockCount,
  };
}

export function compareDocumentFingerprints(
  expected: DocumentContentFingerprint,
  actual: DocumentContentFingerprint,
): DocumentIntegrityResult {
  const reasons: string[] = [];

  if (expected.hasContent && !actual.hasContent) {
    reasons.push('飞书正文为空');
  }
  if (expected.tableCount !== actual.tableCount) {
    reasons.push(`原生表格数量不符（期望 ${expected.tableCount}，实际 ${actual.tableCount}）`);
  }
  if (expected.boardCount !== actual.boardCount) {
    reasons.push(`画板数量不符（期望 ${expected.boardCount}，实际 ${actual.boardCount}）`);
  }
  if (expected.codeBlockCount !== actual.codeBlockCount) {
    reasons.push(`代码块数量不符（期望 ${expected.codeBlockCount}，实际 ${actual.codeBlockCount}）`);
  }
  if (expected.imageCount !== actual.imageCount) {
    reasons.push(`图片块数量不符（期望 ${expected.imageCount}，实际 ${actual.imageCount}）`);
  }

  return { ok: reasons.length === 0, reasons };
}

export async function verifyDocumentIntegrity(
  client: FeishuClient,
  documentId: string,
  markdown: string,
  sourcePath: string,
  tabularExtensions: string[] = ['.csv'],
): Promise<DocumentIntegrityResult> {
  const expected = computeExpectedDocumentFingerprint(markdown, sourcePath, tabularExtensions);
  const blocks = await listDocumentBlocks(client, documentId, 'Verify document integrity');
  const actual = computeActualDocumentFingerprint(blocks, documentId);
  return compareDocumentFingerprints(expected, actual);
}

function countNonDiagramCodeFences(markdown: string): number {
  let count = 0;

  for (const match of markdown.matchAll(FENCED_CODE_RE)) {
    const lang = (match[1] ?? '').trim().toLowerCase();
    const code = (match[2] ?? '').trim();
    if (MERMAID_LANGS.has(lang)) continue;
    if (!lang && looksLikeMermaidDiagram(code)) continue;
    count += 1;
  }

  return count;
}

function looksLikeMermaidDiagram(code: string): boolean {
  const firstLine = code.trim().split('\n')[0]?.trim().toLowerCase() ?? '';
  return /^(flowchart|graph|sequencediagram|classdiagram|statediagram|erdiagram|journey|gantt|pie|mindmap|timeline|gitgraph|block-beta)\b/.test(
    firstLine,
  );
}
