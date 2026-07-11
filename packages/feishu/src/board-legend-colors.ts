import {
  classifyNode,
  createLogger,
  parseMermaidFlowchart,
  type DiagramNodeStyle,
  type LegendEntry,
} from '@feishu-md/shared';
import type { FeishuClient } from './client.js';
import { assertFeishuResponse, formatFeishuErrorMessage, withRateLimit } from './api-error.js';

const colorLog = createLogger('board-legend-colors');

type UnknownRecord = Record<string, unknown>;

type RequestableClient = FeishuClient & {
  request: (payload: {
    method: string;
    url: string;
    data?: unknown;
    params?: Record<string, unknown>;
  }) => Promise<{ code?: number; msg?: string; data?: unknown }>;
};

interface BoardNodeRecord {
  id?: string;
  type?: string;
  parent_id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  z_index?: number;
  text?: { text?: string; rich_text?: unknown };
  style?: UnknownRecord;
  composite_shape?: UnknownRecord;
  mind_map?: UnknownRecord;
  mind_map_node?: UnknownRecord;
  mind_map_root?: UnknownRecord;
}

const COLORABLE_TYPES = new Set(['composite_shape', 'mind_map']);

function normalizeLabel(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[＜＞]/g, (ch) => (ch === '＜' ? '<' : '>'))
    .replace(/\s+/g, ' ')
    .trim();
}

function nodeText(node: BoardNodeRecord): string {
  const plain = node.text?.text;
  if (typeof plain === 'string' && plain.trim()) {
    return plain.trim();
  }

  const rich = node.text?.rich_text as UnknownRecord | undefined;
  const paragraphs = rich?.paragraphs as UnknownRecord[] | undefined;
  if (!paragraphs?.length) return '';

  const parts: string[] = [];
  for (const paragraph of paragraphs) {
    const elements = paragraph.elements as UnknownRecord[] | undefined;
    for (const element of elements ?? []) {
      const content = (element.text_run as UnknownRecord | undefined)?.content;
      if (typeof content === 'string' && content.trim()) {
        parts.push(content.trim());
      }
    }
  }

  return parts.join('\n').trim();
}

/** 从 Mermaid 源码建立「规范化标签 → 样式」映射 */
export function buildLabelStyleMap(
  mermaidCode: string,
  legend: LegendEntry[],
): Map<string, DiagramNodeStyle> {
  const map = new Map<string, DiagramNodeStyle>();
  if (legend.length === 0) return map;

  const trimmed = mermaidCode.trim();
  const firstLine = trimmed.split('\n')[0]?.trim().toLowerCase() ?? '';

  if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph ')) {
    try {
      const parsed = parseMermaidFlowchart(trimmed);
      for (const node of parsed.nodes) {
        const entry = classifyNode(node.id, node.label, legend);
        if (!entry) continue;
        map.set(normalizeLabel(node.label), entry.style);
      }
      return map;
    } catch (error) {
      colorLog.warn(`解析 flowchart 失败，改按标签前缀匹配: ${formatFeishuErrorMessage(error)}`);
    }
  }

  // mindmap 或解析失败：仅按标签前缀（主题等无前缀的类型需靠 ID，此处无法覆盖）
  return map;
}

function resolveStyleForBoardNode(
  node: BoardNodeRecord,
  labelStyleMap: Map<string, DiagramNodeStyle>,
  legend: LegendEntry[],
): DiagramNodeStyle | null {
  const label = nodeText(node);
  if (!label) return null;

  const fromMap = labelStyleMap.get(normalizeLabel(label));
  if (fromMap) return fromMap;

  const entry = classifyNode('', label, legend);
  return entry?.style ?? null;
}

function buildColoredShapePayload(node: BoardNodeRecord, style: DiagramNodeStyle): UnknownRecord {
  const label = nodeText(node).slice(0, 1024) || ' ';
  const payload: UnknownRecord = {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    angle: node.angle ?? 0,
    z_index: node.z_index ?? 0,
    text: {
      text: label,
      text_color: style.text,
      text_color_type: 1,
    },
    style: {
      fill_color: style.fill,
      fill_color_type: 1,
      fill_opacity: 100,
      border_width: 'narrow',
      border_opacity: 100,
      border_style: 'solid',
      border_color: style.border ?? style.fill,
      border_color_type: 1,
      theme_fill_color_code: -1,
      theme_border_color_code: -1,
    },
  };

  if (node.parent_id) {
    payload.parent_id = node.parent_id;
  }

  if (node.type === 'composite_shape') {
    payload.composite_shape = {
      type:
        typeof node.composite_shape?.type === 'string'
          ? String(node.composite_shape.type)
          : 'round_rect',
    };
  }

  if (node.type === 'mind_map') {
    if (node.mind_map_root) {
      payload.mind_map_root = node.mind_map_root;
    }
    if (node.mind_map_node) {
      payload.mind_map_node = node.mind_map_node;
    }
    if (node.mind_map) {
      payload.mind_map = node.mind_map;
    }
  }

  return payload;
}

async function listBoardNodes(client: FeishuClient, whiteboardId: string): Promise<BoardNodeRecord[]> {
  const response = await withRateLimit(() =>
    client.board.v1.whiteboardNode.list({
      path: { whiteboard_id: whiteboardId },
    }),
  );
  assertFeishuResponse(response, 'List board nodes for legend colors');
  return (response.data as { nodes?: BoardNodeRecord[] } | undefined)?.nodes ?? [];
}

async function batchDeleteNodes(
  client: FeishuClient,
  whiteboardId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const response = await withRateLimit(() =>
      (client as RequestableClient).request({
        method: 'DELETE',
        url: `/open-apis/board/v1/whiteboards/${encodeURIComponent(whiteboardId)}/nodes/batch_delete`,
        data: { ids: chunk },
      }),
    );
    assertFeishuResponse(response, 'Delete board nodes for legend colors');
  }
}

async function createBoardNodes(
  client: FeishuClient,
  whiteboardId: string,
  nodes: UnknownRecord[],
): Promise<void> {
  if (nodes.length === 0) return;

  // 尽量整批创建，保留 mind_map / parent_id 同批引用；过大时再分批
  const chunkSize = nodes.length > 80 ? 40 : nodes.length;
  for (let index = 0; index < nodes.length; index += chunkSize) {
    const chunk = nodes.slice(index, index + chunkSize);
    const response = await withRateLimit(() =>
      client.board.v1.whiteboardNode.create({
        path: { whiteboard_id: whiteboardId },
        data: { nodes: chunk as never },
      }),
    );
    assertFeishuResponse(response, 'Create colored board nodes');
  }
}

export interface ApplyLegendColorsResult {
  coloredCount: number;
  totalShapeCount: number;
}

/**
 * Mermaid 导入后，按图例给画板块（composite_shape / mind_map）写入 fill_color。
 * 飞书 createPlantuml 不吃 classDef，颜色必须在导入后用节点 API 配置。
 */
export async function applyLegendColorsToBoard(
  client: FeishuClient,
  whiteboardId: string,
  mermaidCode: string,
  legend: LegendEntry[],
): Promise<ApplyLegendColorsResult> {
  if (legend.length === 0) {
    return { coloredCount: 0, totalShapeCount: 0 };
  }

  // 导入后节点可能尚未完全落盘
  await new Promise((resolve) => setTimeout(resolve, 800));

  const labelStyleMap = buildLabelStyleMap(mermaidCode, legend);
  const boardNodes = await listBoardNodes(client, whiteboardId);
  const shapes = boardNodes.filter(
    (node) => node.id && node.type && COLORABLE_TYPES.has(node.type),
  );

  const payloads: UnknownRecord[] = [];
  const deleteIds: string[] = [];

  for (const shape of shapes) {
    const style = resolveStyleForBoardNode(shape, labelStyleMap, legend);
    if (!style || !shape.id) continue;
    deleteIds.push(shape.id);
    payloads.push(buildColoredShapePayload(shape, style));
  }

  if (payloads.length === 0) {
    colorLog.info('无可上色画板块', {
      whiteboardId,
      totalShapeCount: shapes.length,
      labelMapSize: labelStyleMap.size,
    });
    return { coloredCount: 0, totalShapeCount: shapes.length };
  }

  colorLog.info('开始按图例上色画板块', {
    whiteboardId,
    coloredCount: payloads.length,
    totalShapeCount: shapes.length,
  });

  await batchDeleteNodes(client, whiteboardId, deleteIds);
  await createBoardNodes(client, whiteboardId, payloads);

  return { coloredCount: payloads.length, totalShapeCount: shapes.length };
}
