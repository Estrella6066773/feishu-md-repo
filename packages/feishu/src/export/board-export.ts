import {
  formatClassDefLine,
  normalizeHexColor,
  semanticClassByFill,
  type DiagramNodeStyle,
} from '@feishu-md/shared';
import type { FeishuClient } from '../client.js';
import { assertFeishuResponse, withRateLimit } from '../api-error.js';

type UnknownRecord = Record<string, unknown>;

export async function listWhiteboardNodes(
  client: FeishuClient,
  whiteboardId: string,
): Promise<UnknownRecord[]> {
  const response = await withRateLimit(
    () =>
      client.board.v1.whiteboardNode.list({
        path: { whiteboard_id: whiteboardId },
      }),
    { read: true },
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

const DIAMOND_SHAPE_TYPES = new Set(['diamond', 'flow_chart_diamond', 'condition_shape']);
const CIRCLE_SHAPE_TYPES = new Set(['ellipse', 'circle']);

const SEMANTIC_CLASS_ORDER = [
  'root',
  'sys',
  'obj',
  'cls',
  'data',
  'enum',
  'state',
  'act',
  'asset',
  'cfg',
  'tbl',
  'evt',
  'ntf',
  'sub',
  'cond',
  'logic',
];

/**
 * 画板没有 class 名，只剩颜色。
 * 填充色命中语义配色时用原来的 class 名；其余显式上色（fill_color_type = 1）按出现顺序编 s1、s2。
 * 飞书默认主题色的 fill_color_type 不是 1，不会被收成 classDef，避免普通流程图被涂上一层假样式。
 */
function exportedClassForShape(
  shape: UnknownRecord,
  assigned: Map<string, { name: string; style: DiagramNodeStyle }>,
  generatedCount: { value: number },
): { name: string; style: DiagramNodeStyle } | null {
  const nodeStyle = (shape.style as UnknownRecord | undefined) ?? {};
  const text = (shape.text as UnknownRecord | undefined) ?? {};
  const fill = normalizeHexColor(String(nodeStyle.fill_color ?? ''));
  if (!fill) return null;

  const semantic = semanticClassByFill(fill);
  const explicit = Number(nodeStyle.fill_color_type) === 1 || Number(text.text_color_type) === 1;
  if (!semantic && !explicit) return null;

  const style: DiagramNodeStyle = semantic
    ? semantic.style
    : {
        fill,
        text: normalizeHexColor(String(text.text_color ?? '')) || '#1f2329',
        border: normalizeHexColor(String(nodeStyle.border_color ?? '')) || fill,
      };
  const key = semantic ? semantic.name : `${style.fill}|${style.text}|${style.border ?? ''}`;
  const existing = assigned.get(key);
  if (existing) return existing;

  const name = semantic?.name ?? `s${++generatedCount.value}`;
  const entry = { name, style };
  assigned.set(key, entry);
  return entry;
}

function isDiamondShape(shape: UnknownRecord): boolean {
  const composite = (shape.composite_shape as UnknownRecord | undefined) ?? {};
  return DIAMOND_SHAPE_TYPES.has(String(composite.type ?? ''));
}

function isCircleShape(shape: UnknownRecord): boolean {
  const composite = (shape.composite_shape as UnknownRecord | undefined) ?? {};
  return CIRCLE_SHAPE_TYPES.has(String(composite.type ?? ''));
}

function inferFlowDirection(shapes: UnknownRecord[]): 'LR' | 'TD' {
  const byParent = new Map<string, UnknownRecord[]>();
  for (const shape of shapes) {
    const parentId = String(shape.parent_id ?? '');
    const group = byParent.get(parentId) ?? [];
    group.push(shape);
    byParent.set(parentId, group);
  }

  let xSpan = 0;
  let ySpan = 0;
  for (const group of byParent.values()) {
    if (group.length < 2) continue;
    const minX = Math.min(...group.map((shape) => Number(shape.x ?? 0)));
    const maxX = Math.max(...group.map((shape) => Number(shape.x ?? 0) + Number(shape.width ?? 0)));
    const minY = Math.min(...group.map((shape) => Number(shape.y ?? 0)));
    const maxY = Math.max(...group.map((shape) => Number(shape.y ?? 0) + Number(shape.height ?? 0)));
    xSpan = Math.max(xSpan, maxX - minX);
    ySpan = Math.max(ySpan, maxY - minY);
  }

  return xSpan > ySpan ? 'LR' : 'TD';
}

function connectorCaption(connectorNode: UnknownRecord): string {
  const connector = (connectorNode.connector as UnknownRecord | undefined) ?? {};
  const captions = connector.captions;
  if (typeof captions === 'string') return captions.trim();
  const data = (captions as UnknownRecord | undefined)?.data;
  if (!Array.isArray(data)) return '';
  return data
    .map((item) => String((item as UnknownRecord).text ?? ''))
    .join('')
    .trim();
}

function escapeEdgeLabel(label: string): string {
  return label.replace(/\|/g, '／').replace(/\r?\n/g, ' ');
}

/**
 * 复合图形画板 → flowchart。
 * 圆框写回 `((文案))`，菱形写回 `{}`，分区写回 subgraph，连线文字写回 `-->|标签|`。
 * 显式颜色写回 classDef / class。节点 id 若是导入时留下的 Mermaid id，则原样使用。
 */
function exportCompositeFlowchart(rawNodes: UnknownRecord[]): string | null {
  const shapes = rawNodes.filter((node) => String(node.type ?? '') === 'composite_shape');
  if (shapes.length === 0) return null;

  const sections = rawNodes.filter((node) => String(node.type ?? '') === 'section');
  const sectionIdSet = new Set(sections.map((node) => String(node.id ?? '')));

  const mermaidIds = new Map<string, string>();
  const usedNames = new Set<string>();
  let counter = 0;
  const alias = (boardId: string): string => {
    const existing = mermaidIds.get(boardId);
    if (existing) return existing;
    let name = '';
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(boardId) && !usedNames.has(boardId)) {
      name = boardId;
    } else {
      while (usedNames.has(`n${counter}`)) counter += 1;
      name = `n${counter}`;
      counter += 1;
    }
    usedNames.add(name);
    mermaidIds.set(boardId, name);
    return name;
  };

  const classByKey = new Map<string, { name: string; style: DiagramNodeStyle }>();
  const generatedCount = { value: 0 };
  const idsByClass = new Map<string, string[]>();
  const shapeClassName = new Map<string, string>();

  for (const shape of shapes) {
    const boardId = String(shape.id ?? '');
    if (!boardId) continue;
    const exported = exportedClassForShape(shape, classByKey, generatedCount);
    if (!exported) continue;
    shapeClassName.set(boardId, exported.name);
  }

  const lines: string[] = [`flowchart ${inferFlowDirection(shapes)}`];

  sections.forEach((section, index) => {
    const sectionId = String(section.id ?? '');
    const title = String((section.section as UnknownRecord | undefined)?.title ?? '分区');
    const sectionName = `g${index + 1}`;
    usedNames.add(sectionName);
    lines.push(`  subgraph ${sectionName} ["${escapeMermaidQuoted(title)}"]`);

    for (const shape of shapes.filter((item) => String(item.parent_id ?? '') === sectionId)) {
      appendShapeNodeLine(shape, alias, lines, '    ');
    }

    lines.push('  end');
  });

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

    const label = connectorCaption(connector);
    const edgeKey = `${startId}->${endId}:${label}`;
    if (emittedEdges.has(edgeKey)) continue;
    emittedEdges.add(edgeKey);
    const arrow = label ? `-->|${escapeEdgeLabel(label)}|` : '-->';
    lines.push(`  ${alias(startId)} ${arrow} ${alias(endId)}`);
  }

  const presentNames = new Set([...classByKey.values()].map((entry) => entry.name));
  const classOrder = [
    ...SEMANTIC_CLASS_ORDER.filter((name) => presentNames.has(name)),
    ...[...presentNames].filter((name) => !SEMANTIC_CLASS_ORDER.includes(name)),
  ];

  for (const shape of shapes) {
    const boardId = String(shape.id ?? '');
    const className = shapeClassName.get(boardId);
    if (!className) continue;
    const ids = idsByClass.get(className) ?? [];
    ids.push(alias(boardId));
    idsByClass.set(className, ids);
  }

  for (const className of classOrder) {
    const entry = [...classByKey.values()].find((item) => item.name === className);
    if (!entry) continue;
    lines.push(`  ${formatClassDefLine(entry.name, entry.style)}`);
  }

  for (const className of classOrder) {
    const ids = idsByClass.get(className);
    if (!ids?.length) continue;
    lines.push(`  class ${ids.join(',')} ${className}`);
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
  const quoted = escapeMermaidQuoted(label);
  const body = isDiamondShape(shape)
    ? `{"${quoted}"}`
    : isCircleShape(shape)
      ? `(("${quoted}"))`
      : `["${quoted}"]`;
  lines.push(`${indent}${alias(id)}${body}`);
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
