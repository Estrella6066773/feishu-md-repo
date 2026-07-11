import type { LegendEntry } from '@feishu-md/shared';
import { createLogger } from '@feishu-md/shared';
import type { FeishuClient } from './client.js';
import { formatFeishuErrorMessage } from './api-error.js';
import { applyLegendColorsToBoard } from './board-legend-colors.js';
import { applyMermaidSubgraphSections } from './board-subgraph-sections.js';
import { importBoardMermaidDiagram, insertBoardBlock } from './board-service.js';
import { findDocumentPageBlock, listDocumentBlocks } from './docx-block-service.js';
import { appendDocumentMarkdown } from './docx-content.js';
import { parseFeishuDocumentUrl } from './export/document-url.js';
import {
  detectMermaidDiagramType,
  MERMAID_DIAGRAM_TYPE,
  prepareFeishuMermaidCode,
  splitMarkdownByDiagrams,
  stripMermaidClassStyles,
} from './mermaid-markdown.js';
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
  /** 成品 Mermaid 源码（可不带 fence）；导入前会去掉 classDef */
  mermaidCode: string;
  /** 图例：导入成功后按标签给画板块配置 fill_color */
  legend?: LegendEntry[];
}

export interface AppendMermaidBoardResult {
  documentId: string;
  whiteboardId: string;
  insertedBlockCount: number;
  usedStrippedStyles: boolean;
  coloredNodeCount: number;
}

/** @deprecated 请使用 mermaid-markdown 中的同名导出；此处保留兼容 */
export { stripMermaidClassStyles, prepareFeishuMermaidCode };

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
 * 颜色：先无样式导入，再按 legend 给画板块配置 fill_color。
 */
export async function appendMermaidBoardToDocument(
  client: FeishuClient,
  options: AppendMermaidBoardOptions,
): Promise<AppendMermaidBoardResult> {
  const mermaidCode = extractMermaidCode(options.mermaidCode);
  const prepared = prepareFeishuMermaidCode(mermaidCode);
  const usedStrippedStyles = prepared !== mermaidCode.trim();
  const legend = options.legend ?? [];
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
    codeLineCount: prepared.split('\n').length,
    usedStrippedStyles,
    legendCount: legend.length,
  });

  try {
    await importBoardMermaidDiagram(client, whiteboardId, prepared);
  } catch (error) {
    const detail = formatFeishuErrorMessage(error);
    throw new Error(
      `飞书画板导入失败：${detail}。已去掉 Mermaid 样式并清洗标签；颜色会在导入成功后写入画板块。若仍失败，请缩小图表或检查节点文案中的特殊符号。`,
    );
  }

  // 仅流程图做 subgraph→分区；思维导图跳过，避免破坏 mind_map 节点
  if (diagramType === MERMAID_DIAGRAM_TYPE.flowchart || diagramType === MERMAID_DIAGRAM_TYPE.auto) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      await applyMermaidSubgraphSections(client, whiteboardId, prepared);
    } catch (sectionError) {
      appendLog.warn(
        `画板 subgraph 转分区失败，保留 Mermaid 导入结果: ${formatFeishuErrorMessage(sectionError)}`,
        { documentId, whiteboardId },
      );
    }
  }

  // 上色必须在 subgraph 重建之后，否则分区重建会丢掉 fill_color
  let coloredNodeCount = 0;
  if (legend.length > 0) {
    try {
      const colored = await applyLegendColorsToBoard(client, whiteboardId, prepared, legend);
      coloredNodeCount = colored.coloredCount;
      appendLog.info('画板块上色完成', {
        documentId,
        whiteboardId,
        coloredNodeCount,
        totalShapeCount: colored.totalShapeCount,
      });
    } catch (colorError) {
      appendLog.warn(
        `画板块上色失败，保留未着色导入结果: ${formatFeishuErrorMessage(colorError)}`,
        { documentId, whiteboardId },
      );
    }
  }

  return {
    documentId,
    whiteboardId,
    insertedBlockCount: 1,
    usedStrippedStyles,
    coloredNodeCount,
  };
}
