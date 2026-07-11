import type { FeishuClient } from './client.js';
import { formatFeishuErrorMessage } from './api-error.js';
import { applyMermaidSubgraphSections } from './board-subgraph-sections.js';
import { importBoardMermaidDiagram, insertBoardBlock } from './board-service.js';
import { findDocumentPageBlock, listDocumentBlocks } from './docx-block-service.js';
import { appendDocumentMarkdown } from './docx-content.js';
import { parseFeishuDocumentUrl } from './export/document-url.js';
import {
  detectMermaidDiagramType,
  MERMAID_DIAGRAM_TYPE,
  splitMarkdownByDiagrams,
} from './mermaid-markdown.js';
import { createLogger } from '@feishu-md/shared';
import { getWikiNodeByToken } from './wiki-service.js';

const appendLog = createLogger('diagram-append');

export interface AppendMarkdownToDocumentOptions {
  documentUrl: string;
  markdown: string;
}

export interface AppendMarkdownToDocumentResult {
  documentId: string;
  insertedBlockCount: number;
}

export interface AppendMermaidBoardOptions {
  documentUrl: string;
  /** 成品 Mermaid 源码（可不带 fence） */
  mermaidCode: string;
}

export interface AppendMermaidBoardResult {
  documentId: string;
  whiteboardId: string;
  insertedBlockCount: number;
  usedStrippedStyles: boolean;
}

async function resolveDocumentIdFromUrl(
  client: FeishuClient,
  documentUrl: string,
): Promise<string> {
  const parsed = parseFeishuDocumentUrl(documentUrl);
  if (!parsed) {
    throw new Error('无法解析飞书文档链接，请确认链接包含 /docx/ 或 /wiki/ 路径');
  }

  if (parsed.source === 'docx') {
    return parsed.token;
  }

  const node = await getWikiNodeByToken(client, parsed.token);
  if (!node?.docToken) {
    throw new Error('无法解析 wiki 链接：请确认文档存在，且应用对该知识库节点有读取权限。');
  }
  return node.docToken;
}

/** 去掉 classDef / :::class，提高飞书画板 PlantUML 导入成功率 */
export function stripMermaidClassStyles(code: string): string {
  return code
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !/^classDef\b/i.test(trimmed) && !/^class\b/i.test(trimmed);
    })
    .map((line) => line.replace(/\s*:::\s*[A-Za-z][A-Za-z0-9_]*\s*$/, ''))
    .join('\n')
    .trim();
}

function extractMermaidCode(input: string): string {
  const trimmed = input.trim();
  const segments = splitMarkdownByDiagrams(trimmed);
  const diagram = segments.find((segment) => segment.kind === 'diagram');
  if (diagram && diagram.kind === 'diagram') {
    return diagram.code.trim();
  }

  if (/^(flowchart|graph|mindmap|sequencediagram)\b/i.test(trimmed.split('\n')[0]?.trim() ?? '')) {
    return trimmed;
  }

  throw new Error('未找到可导入的 Mermaid 图表源码');
}

async function importMermaidWithFallback(
  client: FeishuClient,
  whiteboardId: string,
  mermaidCode: string,
  diagramType: number,
): Promise<{ code: string; usedStrippedStyles: boolean }> {
  try {
    await importBoardMermaidDiagram(client, whiteboardId, mermaidCode, diagramType);
    return { code: mermaidCode, usedStrippedStyles: false };
  } catch (error) {
    const stripped = stripMermaidClassStyles(mermaidCode);
    if (!stripped || stripped === mermaidCode.trim()) {
      throw error;
    }
    appendLog.warn(
      `画板导入含样式失败，去样式重试: ${formatFeishuErrorMessage(error)}`,
      { whiteboardId },
    );
    await importBoardMermaidDiagram(client, whiteboardId, stripped, diagramType);
    return { code: stripped, usedStrippedStyles: true };
  }
}

/** 将 Markdown（含 Mermaid）追加到指定飞书云文档末尾 */
export async function appendMarkdownToDocument(
  client: FeishuClient,
  options: AppendMarkdownToDocumentOptions,
): Promise<AppendMarkdownToDocumentResult> {
  const documentId = await resolveDocumentIdFromUrl(client, options.documentUrl);
  const { insertedBlockCount } = await appendDocumentMarkdown(
    client,
    documentId,
    options.markdown,
  );
  return { documentId, insertedBlockCount };
}

/**
 * 仅在文档末尾追加一块成品画板并导入 Mermaid。
 * 不写入标题、图例表等正文。
 */
export async function appendMermaidBoardToDocument(
  client: FeishuClient,
  options: AppendMermaidBoardOptions,
): Promise<AppendMermaidBoardResult> {
  const mermaidCode = extractMermaidCode(options.mermaidCode);
  const documentId = await resolveDocumentIdFromUrl(client, options.documentUrl);

  const items = await listDocumentBlocks(client, documentId, 'List docx blocks for diagram board');
  const pageBlock = findDocumentPageBlock(items, documentId);
  const insertIndex = pageBlock?.children?.length ?? 0;

  const diagramType = detectMermaidDiagramType(mermaidCode, '');
  const whiteboardId = await insertBoardBlock(client, documentId, insertIndex);

  appendLog.info('追加成品画板', {
    documentId,
    whiteboardId,
    insertIndex,
    diagramType,
    codeLineCount: mermaidCode.split('\n').length,
  });

  const imported = await importMermaidWithFallback(
    client,
    whiteboardId,
    mermaidCode,
    diagramType,
  );

  // 仅流程图做 subgraph→分区；思维导图跳过，避免破坏 mind_map 节点
  if (diagramType === MERMAID_DIAGRAM_TYPE.flowchart || diagramType === MERMAID_DIAGRAM_TYPE.auto) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      await applyMermaidSubgraphSections(client, whiteboardId, imported.code);
    } catch (sectionError) {
      appendLog.warn(
        `画板 subgraph 转分区失败，保留 Mermaid 导入结果: ${formatFeishuErrorMessage(sectionError)}`,
        { documentId, whiteboardId },
      );
    }
  }

  return {
    documentId,
    whiteboardId,
    insertedBlockCount: 1,
    usedStrippedStyles: imported.usedStrippedStyles,
  };
}
