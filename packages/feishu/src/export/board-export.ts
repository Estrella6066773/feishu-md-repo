import type { FeishuClient } from '../client.js';
import { assertFeishuResponse, withRateLimit } from '../api-error.js';

type UnknownRecord = Record<string, unknown>;

export async function listWhiteboardNodes(
  client: FeishuClient,
  whiteboardId: string,
): Promise<UnknownRecord[]> {
  const response = await withRateLimit(() =>
    client.board.v1.whiteboardNode.list({
      path: { whiteboard_id: whiteboardId },
    }),
  );
  assertFeishuResponse(response, 'List board nodes');
  return ((response.data as UnknownRecord | undefined)?.nodes as UnknownRecord[] | undefined) ?? [];
}

/** 将画板节点逆向导出为 Mermaid 代码（思维导图或流程图） */
export function exportBoardNodesToMermaid(rawNodes: UnknownRecord[]): string | null {
  if (rawNodes.length === 0) return null;

  const mindMap = exportNativeMindMap(rawNodes);
  if (mindMap) return mindMap;

  const flowchart = exportCompositeFlowchart(rawNodes);
  if (flowchart) return flowchart;

  return null;
}

function exportNativeMindMap(rawNodes: UnknownRecord[]): string | null {
  interface MindMapNode {
    id: string;
    text: string;
    parentId?: string;
    isRoot: boolean;
    layoutPosition?: string;
    zIndex: number;
  }

  const nodes = rawNodes
    .map((raw): MindMapNode | null => {
      if (String(raw.type ?? '') !== 'mind_map') return null;
      const id = String(raw.id ?? '');
      if (!id) return null;

      const mindMapNode = (raw.mind_map_node as UnknownRecord) ?? {};
      return {
        id,
        text: extractBoardNodeLabel(raw.text as UnknownRecord | undefined),
        parentId: mindMapNode.parent_id ? String(mindMapNode.parent_id) : undefined,
        isRoot: Boolean(raw.mind_map_root),
        layoutPosition: mindMapNode.layout_position ? String(mindMapNode.layout_position) : undefined,
        zIndex: Number(mindMapNode.z_index ?? 0),
      };
    })
    .filter((node): node is MindMapNode => node != null);

  if (nodes.length === 0) return null;

  const childrenByParent = new Map<string, MindMapNode[]>();
  for (const node of nodes) {
    const parentId = node.parentId ?? '__unparented__';
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(parentId, siblings);
  }

  const root = nodes.find((node) => node.isRoot);
  if (!root) return null;

  const lines: string[] = ['mindmap'];
  lines.push(`  ${escapeMermaidLabel(root.text)}`);

  const rootChildren = childrenByParent.get(root.id) ?? [];
  rootChildren.sort((a, b) => a.zIndex - b.zIndex);
  for (const child of rootChildren) {
    appendMindMapBranch(child, 2, childrenByParent, lines);
  }

  return lines.join('\n');
}

function appendMindMapBranch(
  node: { id: string; text: string; layoutPosition?: string; zIndex: number },
  depth: number,
  childrenByParent: Map<string, Array<{ id: string; text: string; layoutPosition?: string; zIndex: number }>>,
  lines: string[],
): void {
  const indent = '  '.repeat(depth);
  const positionPrefix = node.layoutPosition ? `${node.layoutPosition} ` : '';
  lines.push(`${indent}${positionPrefix}${escapeMermaidLabel(node.text)}`);

  const children = childrenByParent.get(node.id) ?? [];
  children.sort((a, b) => a.zIndex - b.zIndex);
  for (const child of children) {
    appendMindMapBranch(child, depth + 1, childrenByParent, lines);
  }
}

function exportCompositeFlowchart(rawNodes: UnknownRecord[]): string | null {
  const shapes = rawNodes.filter((node) => String(node.type ?? '') === 'composite_shape');
  if (shapes.length === 0) return null;

  const sections = rawNodes.filter((node) => String(node.type ?? '') === 'section');
  const sectionIdSet = new Set(sections.map((node) => String(node.id ?? '')));

  const mermaidIds = new Map<string, string>();
  let counter = 0;
  const alias = (boardId: string): string => {
    if (!mermaidIds.has(boardId)) {
      mermaidIds.set(boardId, `n${counter++}`);
    }
    return mermaidIds.get(boardId)!;
  };

  const lines: string[] = ['flowchart TD'];

  for (const section of sections) {
    const sectionId = String(section.id ?? '');
    const title = String((section.section as UnknownRecord | undefined)?.title ?? '分区');
    lines.push(`  subgraph ${alias(sectionId)} ["${escapeMermaidQuoted(title)}"]`);

    for (const shape of shapes.filter((item) => String(item.parent_id ?? '') === sectionId)) {
      appendShapeNodeLine(shape, alias, lines, '    ');
    }

    lines.push('  end');
  }

  for (const shape of shapes) {
    const parentId = String(shape.parent_id ?? '');
    if (parentId && sectionIdSet.has(parentId)) continue;
    appendShapeNodeLine(shape, alias, lines, '  ');
  }

  const shapeIds = new Set(shapes.map((shape) => String(shape.id ?? '')));
  const emittedEdges = new Set<string>();

  for (const connector of rawNodes) {
    if (String(connector.type ?? '') !== 'connector') continue;
    const { startId, endId } = getConnectorEndpointIds(connector);
    if (!shapeIds.has(startId) || !shapeIds.has(endId)) continue;

    const edgeKey = `${startId}->${endId}`;
    if (emittedEdges.has(edgeKey)) continue;
    emittedEdges.add(edgeKey);
    lines.push(`  ${alias(startId)} --> ${alias(endId)}`);
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

function appendShapeNodeLine(
  shape: UnknownRecord,
  alias: (id: string) => string,
  lines: string[],
  indent: string,
): void {
  const id = String(shape.id ?? '');
  if (!id) return;
  const label = shapeLabel(shape);
  lines.push(`${indent}${alias(id)}["${escapeMermaidQuoted(label)}"]`);
}

function shapeLabel(shape: UnknownRecord): string {
  return extractBoardNodeLabel(shape.text as UnknownRecord | undefined) || '节点';
}

function getConnectorEndpointIds(conn: UnknownRecord): { startId: string; endId: string } {
  const connector = (conn.connector as UnknownRecord) ?? {};
  const startId = String(
    (connector.start_object as UnknownRecord | undefined)?.id ??
      ((connector.start as UnknownRecord | undefined)?.attached_object as UnknownRecord | undefined)?.id ??
      '',
  );
  const endId = String(
    (connector.end_object as UnknownRecord | undefined)?.id ??
      ((connector.end as UnknownRecord | undefined)?.attached_object as UnknownRecord | undefined)?.id ??
      '',
  );
  return { startId, endId };
}

export function extractBoardNodeLabel(textContainer: UnknownRecord | undefined): string {
  if (!textContainer) return '';

  const richText = textContainer.rich_text as UnknownRecord | undefined;
  if (richText) {
    const fromRich = formatRichParagraphs(richText);
    if (fromRich) return fromRich;
  }

  const plainText = textContainer.text;
  if (typeof plainText === 'string' && plainText.trim()) {
    return plainText.trim();
  }

  return '';
}

function formatRichParagraphs(richText: UnknownRecord): string {
  const paragraphs = (richText.paragraphs as UnknownRecord[] | undefined) ?? [];
  return paragraphs
    .map((paragraph) => {
      const elements = (paragraph.elements as UnknownRecord[] | undefined) ?? [];
      return elements.map((element) => formatRichElement(element)).join('');
    })
    .join('')
    .trim();
}

function formatRichElement(element: UnknownRecord): string {
  const link = element.link_element as UnknownRecord | undefined;
  if (link?.text) {
    const url = String(link.herf ?? link.href ?? '');
    const text = String(link.text);
    return url ? `[${text}](${url})` : text;
  }

  const mentionDoc = element.mention_doc_element as UnknownRecord | undefined;
  if (mentionDoc?.doc_url) {
    return String(mentionDoc.doc_url);
  }

  const textElement = element.text_element as UnknownRecord | undefined;
  if (textElement?.text) {
    return String(textElement.text);
  }

  const textRun = element.text_run as UnknownRecord | undefined;
  if (textRun?.content) {
    return String(textRun.content);
  }

  return '';
}

function escapeMermaidLabel(text: string): string {
  const trimmed = text.trim() || '节点';
  if (/[\[\](){}"#;]/.test(trimmed)) {
    return `"${escapeMermaidQuoted(trimmed)}"`;
  }
  return trimmed;
}

function escapeMermaidQuoted(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}
